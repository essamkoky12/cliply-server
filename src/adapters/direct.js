const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const { pipeline } = require('node:stream/promises');
const config = require('../config');
const { AppError, resolvePublicAddresses, validateExternalUrl, validateHttpUrl } = require('../security');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const MEDIA_TYPES = /^(video\/|audio\/|application\/(mp4|ogg))/i;
const MEDIA_EXTENSIONS = /\.(mp4|m4v|mov|webm|mkv|mp3|m4a|aac|ogg|wav|flac)(?:$|[?#])/i;

function matches(raw) {
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && MEDIA_EXTENSIONS.test(url.pathname);
  } catch {
    return false;
  }
}

function requestOnce(url, method, addresses, timeoutMs, options = {}) {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const selected = addresses[0];
    const request = transport.request(url, {
      method,
      timeout: timeoutMs,
      headers: {
        'User-Agent': 'Cliply/1.0',
        ...(method === 'GET' ? { 'Accept-Encoding': 'identity' } : {}),
        ...(options.headers || {})
      },
      lookup: (_hostname, _options, callback) => callback(null, selected.address, selected.family)
    }, (response) => resolve({ response, request }));
    const signal = options.signal;
    if (signal) {
      if (signal.aborted) request.destroy(new Error('Request aborted.'));
      else signal.addEventListener('abort', () => request.destroy(new Error('Request aborted.')), { once: true });
    }
    request.on('timeout', () => request.destroy(new Error('Request timed out.')));
    request.on('error', reject);
    request.end();
  });
}

async function safeRequest(raw, method = 'HEAD', options = {}) {
  const resolver = options.resolver || resolvePublicAddresses;
  let url = await validateExternalUrl(raw, resolver);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const addresses = await resolver(url.hostname);
    let result;
    try {
      result = await requestOnce(url, method, addresses, options.timeoutMs || 15000, options);
    } catch (error) {
      throw new AppError('SOURCE_UNREACHABLE', 'The media source could not be reached.', 422);
    }
    const { response } = result;
    if (REDIRECT_CODES.has(response.statusCode)) {
      const location = response.headers.location;
      response.destroy();
      if (!location || redirects === 5) throw new AppError('SOURCE_REDIRECT', 'The source redirected too many times.', 422);
      let destination;
      try {
        destination = new URL(location, url).href;
      } catch {
        throw new AppError('SOURCE_REDIRECT', 'The source returned an invalid redirect.', 422);
      }
      url = await validateExternalUrl(destination, resolver);
      continue;
    }
    return { ...result, url };
  }
  throw new AppError('SOURCE_REDIRECT', 'The source redirected too many times.', 422);
}

function parseLength(value) {
  if (value === undefined) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

async function probe(raw, options = {}) {
  let result = await safeRequest(raw, 'HEAD', options);
  let usedRangeRequest = false;
  if ([405, 501].includes(result.response.statusCode)) {
    result.response.destroy();
    usedRangeRequest = true;
    result = await safeRequest(raw, 'GET', { ...options, headers: { Range: 'bytes=0-0' } });
  }
  const { response, url } = result;
  const partialRange = /^bytes\s+\d+-\d+\/(\d+|\*)$/i.exec(response.headers['content-range'] || '');
  if (usedRangeRequest) response.destroy();
  else response.resume();
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new AppError('SOURCE_UNAVAILABLE', 'The media URL did not return a usable response.', 422);
  }
  if (response.statusCode === 206 && !partialRange) {
    throw new AppError('SOURCE_UNAVAILABLE', 'The media source returned an invalid partial response.', 422);
  }
  const contentType = String(response.headers['content-type'] || '').split(';')[0].trim();
  if (!MEDIA_TYPES.test(contentType) && !MEDIA_EXTENSIONS.test(url.pathname)) {
    throw new AppError('UNSUPPORTED_URL', 'The URL does not appear to point to a supported audio or video file.', 415);
  }
  const contentLength = parseLength(partialRange?.[1] || response.headers['content-length']);
  if (contentLength !== null && contentLength > config.maxSourceBytes) {
    throw new AppError('SOURCE_TOO_LARGE', 'The source exceeds the configured size limit.', 413);
  }
  let fileName = url.pathname.split('/').filter(Boolean).pop() || 'media-file';
  try { fileName = decodeURIComponent(fileName); } catch { /* Keep the encoded path component. */ }
  return {
    url: url.href,
    contentType,
    contentLength,
    fileName: fileName.slice(0, 160)
  };
}

async function acquire(raw, destination, options = {}) {
  const maximumBytes = options.maxBytes || config.maxSourceBytes;
  const resolver = options.resolver || resolvePublicAddresses;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let output;
    try {
      const { response, url } = await safeRequest(raw, 'GET', { ...options, resolver });
      if (response.statusCode === 206) {
        response.resume();
        throw new AppError('INCOMPLETE_SOURCE', 'The source returned only a partial file.', 422);
      }
      if (response.statusCode < 200 || response.statusCode >= 300) {
        response.resume();
        throw new AppError('ACQUISITION_FAILED', `The media source returned HTTP ${response.statusCode}.`, 422);
      }
      const contentType = String(response.headers['content-type'] || '').split(';')[0].trim();
      if (!MEDIA_TYPES.test(contentType) && !MEDIA_EXTENSIONS.test(url.pathname)) {
        response.resume();
        throw new AppError('UNSUPPORTED_URL', 'The URL did not return a supported media resource.', 415);
      }
      const declaredLength = parseLength(response.headers['content-length']);
      if (declaredLength !== null && declaredLength > maximumBytes) {
        response.resume();
        throw new AppError('SOURCE_TOO_LARGE', 'The source exceeds the configured size limit.', 413);
      }
      if (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity') {
        response.resume();
        throw new AppError('ACQUISITION_FAILED', 'Encoded media transfers are not supported.', 422);
      }
      let received = 0;
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > maximumBytes) response.destroy(new AppError('SOURCE_TOO_LARGE', 'The source exceeds the configured size limit.', 413));
      });
      output = fs.createWriteStream(destination, { flags: 'w' });
      await pipeline(response, output);
      if (!received || (declaredLength !== null && received !== declaredLength)) {
        throw new AppError('INCOMPLETE_SOURCE', 'The source transfer was incomplete.', 422);
      }
      return { bytes: received, contentType, sourceUrl: url.href };
    } catch (error) {
      lastError = ['ECONNRESET', 'ERR_STREAM_PREMATURE_CLOSE', 'EPIPE', 'ETIMEDOUT'].includes(error.code)
        ? new AppError('INCOMPLETE_SOURCE', 'The source transfer was interrupted.', 422)
        : error;
      if (output && !output.closed) output.destroy();
      await fs.promises.rm(destination, { force: true });
      if (options.signal?.aborted) throw new AppError('JOB_CANCELLED', 'The job was cancelled.', 409);
      if (lastError instanceof AppError && lastError.code !== 'SOURCE_UNREACHABLE' && lastError.code !== 'INCOMPLETE_SOURCE') throw lastError;
    }
  }
  throw lastError instanceof AppError ? lastError : new AppError('ACQUISITION_FAILED', 'The media source could not be downloaded completely.', 422);
}

async function getInfo(raw, options = {}) {
  const resource = await probe(raw, options);
  const sourceInfo = await inspectRemote(raw, options);
  const basename = resource.fileName.replace(/\.[^.]+$/, '') || resource.fileName;
  const formats = [];
  if (sourceInfo.hasVideo) formats.push('mp4');
  if (sourceInfo.hasAudio) formats.push('mp3');
  return {
    title: sourceInfo.title || basename,
    thumbnail: null,
    provider: 'direct',
    duration: sourceInfo.duration,
    hasVideo: sourceInfo.hasVideo,
    hasAudio: sourceInfo.hasAudio,
    sourceSize: resource.contentLength,
    mediaType: resource.contentType,
    capabilities: {
      metadata: true,
      acquire: true,
      formats,
      reason: formats.length ? null : 'The source does not contain processable audio or video streams.'
    }
  };
}

async function inspectRemote(raw, options = {}) {
  const url = validateHttpUrl(raw);
  const token = require('node:crypto').randomBytes(24).toString('hex');
  let transferred = 0;
  let proxyError = null;
  const server = http.createServer(async (request, response) => {
    if (request.url !== `/${token}`) {
      response.writeHead(404).end();
      return;
    }
    if (request.method === 'HEAD') {
      try {
        const { response: upstream } = await safeRequest(url.href, 'HEAD', { resolver: options.resolver, timeoutMs: 10000 });
        response.writeHead(upstream.statusCode >= 200 && upstream.statusCode < 300 ? 200 : upstream.statusCode, {
          'Accept-Ranges': 'bytes',
          'Content-Type': upstream.headers['content-type'] || 'application/octet-stream',
          ...(upstream.headers['content-length'] ? { 'Content-Length': upstream.headers['content-length'] } : {})
        }).end();
        upstream.resume();
      } catch {
        response.writeHead(502).end();
      }
      return;
    }
    if (request.method !== 'GET' || !/^bytes=(?:\d+-\d*|-\d+)$/.test(request.headers.range || '')) {
      response.writeHead(416, { 'Accept-Ranges': 'bytes' }).end();
      return;
    }
    try {
      const { response: upstream } = await safeRequest(url.href, 'GET', {
        headers: { Range: request.headers.range },
        timeoutMs: 10000,
        resolver: options.resolver
      });
      if (upstream.statusCode !== 206 || !/^bytes\s+\d+-\d+\/(?:\d+|\*)$/i.test(upstream.headers['content-range'] || '')) {
        upstream.destroy();
        response.writeHead(416, { 'Accept-Ranges': 'bytes' }).end();
        return;
      }
      const responseHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Range': upstream.headers['content-range'],
        'Content-Type': upstream.headers['content-type'] || 'application/octet-stream'
      };
      if (upstream.headers['content-length']) responseHeaders['Content-Length'] = upstream.headers['content-length'];
      response.writeHead(206, responseHeaders);
      upstream.on('data', (chunk) => {
        transferred += chunk.length;
        if (transferred > config.maxMetadataProbeBytes) {
          proxyError = new AppError('METADATA_PROBE_LIMIT', 'The source required too much data to inspect.', 413);
          upstream.destroy(proxyError);
          response.destroy(proxyError);
        }
      });
      await pipeline(upstream, response);
    } catch (error) {
      if (!proxyError) proxyError = error;
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    }
  });
  server.requestTimeout = 12000;
  server.headersTimeout = 5000;
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const localUrl = `http://127.0.0.1:${address.port}/${token}`;
    const { inspect } = require('../media');
    const result = await inspect(localUrl, { timeoutMs: 15000 });
    if (proxyError) throw proxyError;
    return result;
  } catch (error) {
    if (error instanceof AppError && error.code === 'METADATA_PROBE_LIMIT') throw error;
    if (proxyError instanceof AppError && proxyError.code === 'METADATA_PROBE_LIMIT') throw proxyError;
    console.error('Bounded media metadata probe failed:', error.message);
    throw new AppError('METADATA_UNAVAILABLE', 'The direct media duration could not be inspected with bounded byte-range requests.', 422);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(() => resolve()));
  }
}

module.exports = {
  name: 'direct',
  matches,
  probe,
  acquire,
  getInfo,
  inspectRemote,
  capabilities: { metadata: true, acquire: true, formats: ['mp4', 'mp3'] }
};
