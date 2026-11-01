const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const config = require('./config');
const providers = require('./providers');
const jobs = require('./jobs');
const storage = require('./storage');
const { AppError, validateHttpUrl } = require('./security');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors({
  origin: config.allowedOrigin,
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: config.maxRequestBytes }));
app.use('/api', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: (req) => req.method === 'GET' && /^\/video\/jobs\/[^/]+$/.test(req.path),
  handler: (_req, res) => res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again shortly.' }
  })
}));

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requestUrl(body) {
  if (!body || typeof body.url !== 'string' || body.url.length > 4096) {
    throw new AppError('INVALID_REQUEST', 'A video URL is required.');
  }
  validateHttpUrl(body.url);
  return body.url;
}

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.get('/api/providers', (_req, res) => res.json({
  providers: providers.capabilities(),
  dependencies: providers.getDependencyStatus()
}));

app.get('/api/providers/dependencies', (_req, res) => {
  res.json({ dependencies: providers.getDependencyStatus() });
});

app.post('/api/video/info', asyncRoute(async (req, res) => {
  const info = await providers.getInfo(requestUrl(req.body));
  res.json({ video: info });
}));

app.post('/api/playlists/info', asyncRoute(async (req, res) => {
  const playlist = await providers.getPlaylistInfo(requestUrl(req.body));
  res.json({ playlist });
}));

app.post('/api/video/download', asyncRoute(async (req, res) => {
  const url = requestUrl(req.body);
  const job = await jobs.create({
    url,
    startTime: req.body.startTime,
    endTime: req.body.endTime,
    format: req.body.format,
    quality: req.body.quality,
    audioQuality: req.body.audioQuality,
    resizePreset: req.body.resizePreset,
    resizeMode: req.body.resizeMode,
    title: req.body.title
  });
  res.status(202).json({ job });
}));

app.get('/api/video/jobs/:id', rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (_req, res) => res.status(429).json({
    error: { code: 'RATE_LIMITED', message: 'Job status is being polled too frequently.' }
  })
}), asyncRoute(async (req, res) => {
  res.json({ job: jobs.getStatus(req.params.id) });
}));

app.get('/api/video/jobs/:id/file', asyncRoute(async (req, res, next) => {
  const file = await jobs.getFile(req.params.id);
  res.download(file.path, file.name, (error) => {
    if (error && !res.headersSent) next(error);
    else if (error) console.error('Download stream failed:', error.message);
  });
}));

app.get('/api/video/jobs/:id/files/:format', asyncRoute(async (req, res, next) => {
  const file = await jobs.getFile(req.params.id, req.params.format);
  res.download(file.path, file.name, (error) => {
    if (error && !res.headersSent) next(error);
    else if (error) console.error('Download stream failed:', error.message);
  });
}));

app.delete('/api/video/jobs/:id', asyncRoute(async (req, res) => {
  res.json({ job: await jobs.cancel(req.params.id) });
}));

app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'The requested API endpoint was not found.', 404)));

app.use((error, _req, res, _next) => {
  if (error instanceof AppError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error?.type === 'entity.too.large') {
    res.status(413).json({ error: { code: 'REQUEST_TOO_LARGE', message: 'The request body is too large.' } });
    return;
  }
  if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body must be valid JSON.' } });
    return;
  }
  console.error('Unhandled API error:', error);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' } });
});

async function start() {
  await storage.initialize();
  const dependencies = await providers.initialize();
  if (Object.values(dependencies).some((entry) => entry && typeof entry === 'object' && entry.available === false)) {
    console.warn('One or more media integrations are unavailable; inspect GET /api/providers for details.');
  }
  return app.listen(config.port, () => {
    console.log(`ClipDown API listening on port ${config.port}`);
  });
}

if (require.main === module) {
  start().catch((error) => {
    console.error('ClipDown API failed to start:', error);
    process.exitCode = 1;
  });
}

module.exports = { app, start };
