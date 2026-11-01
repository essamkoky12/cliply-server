const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { after, before, test } = require('node:test');
const execFileAsync = promisify(execFile);

const direct = require('../src/adapters/direct');
const youtube = require('../src/adapters/youtube');
const instagram = require('../src/adapters/instagram');
const tiktok = require('../src/adapters/tiktok');
const facebook = require('../src/adapters/facebook');
const x = require('../src/adapters/x');
const vimeo = require('../src/adapters/vimeo');
const providers = require('../src/providers');
const media = require('../src/media');
const storage = require('../src/storage');
const jobs = require('../src/jobs');
const ytDlp = require('../src/adapters/yt-dlp');
const { createEgressProxy, parseTarget } = require('../src/egress-proxy');
const { app } = require('../src/index');
const { isPublicAddress } = require('../src/security');

const temp = path.join(os.tmpdir(), `clipdown-test-${process.pid}-${Date.now()}`);
let sourcePath;
let silentPath;
let server;
let serverUrl;
let sourceBytes;
let trackMetadataRanges = false;
let metadataRangeRequests = 0;
let unboundedMetadataRequests = 0;

before(async () => {
  await fs.mkdir(temp, { recursive: true });
  sourcePath = path.join(temp, 'known-media.mp4');
  silentPath = path.join(temp, 'silent.mp4');
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=24:d=10',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100:duration=10',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', sourcePath
  ], { timeout: 60000 });
  await execFileAsync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=24:d=4',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', silentPath
  ], { timeout: 60000 });
  sourceBytes = await fs.readFile(sourcePath);
  server = http.createServer((request, response) => {
    if (request.url === '/missing.mp4') {
      response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    if (request.url === '/forbidden.mp4') {
      response.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden');
      return;
    }
    if (request.url === '/redirect.mp4') {
      response.writeHead(302, { Location: '/known.mp4' }).end();
      return;
    }
    if (request.url === '/broken.mp4') {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': '4096' });
      response.write(sourceBytes.subarray(0, 100));
      setTimeout(() => response.destroy(), 5);
      return;
    }
    if (request.method === 'HEAD') {
      response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': sourceBytes.length });
      response.end();
      return;
    }
    if (trackMetadataRanges) {
      if (request.headers.range) metadataRangeRequests += 1;
      else unboundedMetadataRequests += 1;
    }
    if (request.url === '/chunked.mp4') {
      response.writeHead(200, { 'Content-Type': 'video/mp4' });
      response.end(sourceBytes);
      return;
    }
    if (request.headers.range) {
      const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
      if (!range) {
        response.writeHead(416).end();
        return;
      }
      const start = Number(range[1]);
      const end = Math.min(range[2] ? Number(range[2]) : sourceBytes.length - 1, sourceBytes.length - 1);
      if (start >= sourceBytes.length) {
        response.writeHead(416).end();
        return;
      }
      const chunk = sourceBytes.subarray(start, end + 1);
      response.writeHead(206, {
        'Content-Type': 'video/mp4',
        'Content-Length': chunk.length,
        'Content-Range': `bytes ${start}-${end}/${sourceBytes.length}`
      });
      response.end(chunk);
      return;
    }
    response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': sourceBytes.length });
    response.end(sourceBytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  serverUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await fs.rm(temp, { recursive: true, force: true });
});

test('provider matching and YouTube metadata normalization', async (t) => {
  assert.ok(youtube.matches('https://www.youtube.com/watch?v=abcdefghijk'));
  assert.ok(youtube.matches('https://youtu.be/abcdefghijk'));
  assert.ok(youtube.matches('https://www.youtube.com/shorts/abcdefghijk'));
  assert.equal(youtube.matches('https://www.youtube.com/playlist?list=PLabcdefghij')?.type, 'playlist');
  assert.ok(instagram.matches('https://www.instagram.com/reel/C0ffee123/'));
  assert.ok(tiktok.matches('https://www.tiktok.com/@user/video/123456789'));
  assert.ok(facebook.matches('https://www.facebook.com/watch/?v=123'));
  assert.ok(x.matches('https://x.com/user/status/123'));
  assert.ok(vimeo.matches('https://vimeo.com/123456'));
  assert.equal(direct.matches('https://example.com/media.mp4'), true);
  assert.equal(direct.matches('https://youtube.com/watch?v=abcdefghijk'), false);
  assert.equal(providers.resolvePlatform('https://www.youtube.com/shorts/abcdefghijk').name, 'youtube');
  assert.equal(youtube.parseDuration('PT1H2M3.5S'), 3723.5);
  const normalized = youtube.normalizeVideo({
    id: 'abcdefghijk',
    snippet: { title: 'Sample', description: 'Description', thumbnails: { high: { url: 'https://img.youtube.com/sample.jpg' } } },
    contentDetails: { duration: 'PT2M' }
  });
  assert.equal(normalized.duration, 120);
  assert.equal(normalized.title, 'Sample');
  assert.equal(normalized.capabilities.acquire, false);
  assert.equal(instagram.capabilities.acquire, false);
  assert.match(instagram.capabilities.reason, /authorized Instagram integration/);
  assert.deepEqual(ytDlp.normalizeFormats({
    formats: [
      { format_id: 'video', ext: 'webm', vcodec: 'vp9', acodec: 'none', height: 1080 },
      { format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'aac', filesize: 5000 }
    ]
  }).availableFormats, ['mp4', 'mp3']);
  assert.equal(ytDlp.classifyYtDlpError('ERROR: This video is private').code, 'AUTH_REQUIRED');
  assert.equal(ytDlp.classifyYtDlpError('ERROR: Unsupported URL').code, 'UNSUPPORTED_URL');
  assert.equal(ytDlp.classifyYtDlpError('DRM protected content').code, 'PROTECTED_MEDIA');
  assert.equal(ytDlp.httpStatusFromDiagnostic('ERROR: unable to download video data: HTTP Error 403: Forbidden'), 403);
  assert.equal(ytDlp.httpStatusFromDiagnostic('ERROR: unsupported format'), null);
  const sanitized = ytDlp.sanitizeDiagnosticExcerpt(
    'ERROR: https://media.example/watch?token=signed-value Authorization: Bearer private-token'
  );
  assert.ok(!sanitized.includes('signed-value'));
  assert.ok(!sanitized.includes('private-token'));
  assert.ok(sanitized.includes('[redacted-url]'));
  assert.equal(parseTarget('localhost:8080', 80), null);
  assert.equal(parseTarget('public.example:8080', 80), null);
  await t.test('rejects private and loopback addresses', () => {
    assert.equal(isPublicAddress('127.0.0.1'), false);
    assert.equal(isPublicAddress('10.0.0.1'), false);
    assert.equal(isPublicAddress('169.254.169.254'), false);
    assert.equal(isPublicAddress('::1'), false);
    assert.equal(isPublicAddress('8.8.8.8'), true);
  });
});

test('yt-dlp subprocess timeout and authenticated SSRF proxy checks', async () => {
  await assert.rejects(
    () => ytDlp.runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeoutMs: 100 }),
    { code: 'TOOL_TIMEOUT' }
  );
  const progress = [];
  await ytDlp.runCommand(process.execPath, [
    '-e',
    'process.stdout.write("CLIPDOWN_PROGRESS:50:100:100\\n")'
  ], {
    maxBytes: 100,
    onProgress: (entry) => progress.push(entry)
  });
  assert.deepEqual(progress, [{ downloaded: 50, total: 100 }]);
  await assert.rejects(
    () => ytDlp.runCommand(process.execPath, [
      '-e',
      'process.stdout.write("CLIPDOWN_PROGRESS:101:100:100\\n")'
    ], { maxBytes: 100, onProgress: () => {} }),
    { code: 'SOURCE_TOO_LARGE' }
  );
  const http403Diagnostic = 'ERROR: unable to download video data: HTTP Error 403: Forbidden';
  await assert.rejects(
    () => ytDlp.runCommand(process.execPath, [
      '-e',
      `console.error(${JSON.stringify(http403Diagnostic)});process.exitCode=1`
    ], {
      platform: 'youtube',
      stage: 'yt-dlp acquisition',
      sourceHost: 'youtube.com',
      proxyDiagnostics: [{ type: 'proxy_destination_rejected', destination: 'media-cdn.example' }]
    }),
    (error) => {
      assert.equal(error.code, 'EGRESS_PROXY_BLOCKED');
      assert.equal(error.diagnostic.failureSource, 'egress_proxy');
      assert.equal(error.diagnostic.httpStatus, 403);
      return true;
    }
  );
  await assert.rejects(
    () => ytDlp.runCommand(process.execPath, [
      '-e',
      `console.error(${JSON.stringify(http403Diagnostic)});process.exitCode=1`
    ], {
      platform: 'youtube',
      stage: 'yt-dlp acquisition',
      sourceHost: 'youtube.com',
      proxyDiagnostics: [{ type: 'https_tunnel_established', destination: 'media-cdn.example' }]
    }),
    (error) => {
      assert.equal(error.code, 'SOURCE_FORBIDDEN');
      assert.equal(error.diagnostic.failureSource, 'upstream_http');
      assert.equal(error.diagnostic.httpStatus, 403);
      return true;
    }
  );
  assert.equal(ytDlp.restrictedProcessEnvironment().HTTP_PROXY, undefined);
  assert.equal(ytDlp.restrictedProcessEnvironment().NO_PROXY, undefined);
  assert.equal(parseTarget('public.example:443', 443).port, 443);

  const proxy = await createEgressProxy();
  try {
    const proxyAddress = new URL(proxy.url);
    const requestProxy = (authenticated) => new Promise((resolve, reject) => {
      const request = http.request({
        host: proxyAddress.hostname,
        port: Number(proxyAddress.port),
        method: 'GET',
        path: 'http://127.0.0.1/known.mp4',
        headers: authenticated
          ? { 'Proxy-Authorization': `Basic ${Buffer.from(`clipdown:${proxyAddress.password}`).toString('base64')}` }
          : {}
      }, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end();
    });
    assert.equal(await requestProxy(false), 407);
    assert.equal(await requestProxy(true), 403);
    assert.ok(proxy.diagnostics.some((entry) => entry.type === 'proxy_authentication_rejected'));
    assert.ok(proxy.diagnostics.some((entry) => entry.type === 'proxy_destination_rejected'));
  } finally {
    await proxy.close();
  }
});

test('egress proxy carries authenticated HTTPS CONNECT tunnels', async (t) => {
  const keyPath = path.join(temp, 'proxy-test-key.pem');
  const certPath = path.join(temp, 'proxy-test-cert.pem');
  try {
    await execFileAsync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-subj', '/CN=media.example', '-days', '1'
    ], { timeout: 10000 });
  } catch {
    t.skip('OpenSSL is needed to generate a temporary local TLS certificate.');
    return;
  }

  const secureServer = https.createServer({
    key: await fs.readFile(keyPath),
    cert: await fs.readFile(certPath)
  }, (_request, response) => {
    response.writeHead(403);
    response.end('upstream-forbidden');
  });
  await new Promise((resolve) => secureServer.listen(0, '127.0.0.1', resolve));
  const destinationPort = secureServer.address().port;
  const proxy = await createEgressProxy({
    resolver: async (hostname) => (
      hostname === 'media.example' ? [{ address: '127.0.0.1', family: 4 }] : []
    ),
    allowedPorts: [destinationPort]
  });
  const proxyAddress = new URL(proxy.url);
  let secureSocket;
  try {
    const socket = net.connect(Number(proxyAddress.port), proxyAddress.hostname);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const credentials = Buffer.from(`clipdown:${proxyAddress.password}`).toString('base64');
    const responseHeaders = await new Promise((resolve, reject) => {
      let response = '';
      socket.on('data', function readHeaders(chunk) {
        response += chunk.toString('utf8');
        const boundary = response.indexOf('\r\n\r\n');
        if (boundary < 0) return;
        socket.off('data', readHeaders);
        resolve(response.slice(0, boundary));
      });
      socket.once('error', reject);
      socket.write(
        `CONNECT media.example:${destinationPort} HTTP/1.1\r\n`
        + `Host: media.example:${destinationPort}\r\n`
        + `Proxy-Authorization: Basic ${credentials}\r\n\r\n`
      );
    });
    assert.match(responseHeaders, /^HTTP\/1\.1 200 Connection Established/);

    secureSocket = tls.connect({ socket, servername: 'media.example', rejectUnauthorized: false });
    await new Promise((resolve, reject) => {
      secureSocket.once('secureConnect', resolve);
      secureSocket.once('error', reject);
    });
    const responseBody = await new Promise((resolve, reject) => {
      let response = '';
      secureSocket.on('data', (chunk) => { response += chunk.toString('utf8'); });
      secureSocket.once('end', () => resolve(response));
      secureSocket.once('error', reject);
      secureSocket.write(
        `GET / HTTP/1.1\r\nHost: media.example:${destinationPort}\r\nConnection: close\r\n\r\n`
      );
    });
    assert.match(responseBody, /HTTP\/1\.1 403 Forbidden/);
    assert.match(responseBody, /upstream-forbidden/);
    assert.ok(proxy.diagnostics.some((entry) => entry.type === 'https_tunnel_established'));
    assert.ok(!proxy.diagnostics.some((entry) => entry.type === 'upstream_http_403'));
  } finally {
    secureSocket?.destroy();
    await proxy.close();
    await new Promise((resolve) => secureServer.close(resolve));
  }
});

test('direct acquisition, MP4 trimming, MP3 extraction, and output validation', async () => {
  const acquiredPath = path.join(temp, 'acquired.mp4');
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  const acquisition = await direct.acquire(`${serverUrl}/known.mp4`, acquiredPath, { resolver });
  assert.equal(acquisition.bytes, sourceBytes.length);
  assert.deepEqual(await fs.readFile(acquiredPath), sourceBytes);
  const redirectedPath = path.join(temp, 'redirected.mp4');
  await direct.acquire(`${serverUrl}/redirect.mp4`, redirectedPath, { resolver });
  assert.deepEqual(await fs.readFile(redirectedPath), sourceBytes);
  const chunkedPath = path.join(temp, 'chunked.mp4');
  await direct.acquire(`${serverUrl}/chunked.mp4`, chunkedPath, { resolver });
  assert.deepEqual(await fs.readFile(chunkedPath), sourceBytes);

  const sourceInfo = await media.inspect(acquiredPath);
  assert.equal(sourceInfo.duration, 10);
  assert.equal(sourceInfo.hasVideo, true);
  assert.equal(sourceInfo.hasAudio, true);
  assert.equal(media.validateRange(2, 5, sourceInfo.duration), 3);

  const mp4Path = path.join(temp, 'clip.mp4');
  await media.trim({
    input: acquiredPath, output: mp4Path, startTime: 2, endTime: 5, format: 'mp4', sourceInfo
  });
  const mp4Info = await media.validateOutput(mp4Path, 'mp4', 3);
  assert.equal(mp4Info.hasVideo, true);
  assert.equal(mp4Info.hasAudio, true);
  assert.ok(Math.abs(mp4Info.duration - 3) < 0.2);

  const mp3Path = path.join(temp, 'clip.mp3');
  await media.trim({
    input: acquiredPath, output: mp3Path, startTime: 2, endTime: 5, format: 'mp3', sourceInfo, audioQuality: 256
  });
  const mp3Info = await media.validateOutput(mp3Path, 'mp3', 3, undefined, undefined, undefined, undefined, 256);
  assert.equal(mp3Info.hasAudio, true);
  assert.equal(mp3Info.hasVideo, false);
  assert.equal(mp3Info.audioBitrate, 256);
  assert.ok(Math.abs(mp3Info.duration - 3) < 0.3);
  assert.equal(media.validateAudioBitrate(), 192);
  for (const bitrate of [128, 192, 256, 320]) {
    assert.equal(media.validateAudioBitrate(bitrate), bitrate);
  }
  assert.throws(() => media.validateAudioBitrate(160), { code: 'INVALID_AUDIO_QUALITY' });
});

test('MP4 resize presets produce portrait canvas and preserve original source dimensions', async () => {
  const sourceInfo = await media.inspect(sourcePath);
  const portraitPath = path.join(temp, 'portrait-fit.mp4');
  await media.trim({
    input: sourcePath,
    output: portraitPath,
    startTime: 0,
    endTime: 2,
    format: 'mp4',
    sourceInfo,
    quality: 'best',
    resizePreset: 'portrait',
    resizeMode: 'fit'
  });
  const portraitInfo = await media.validateOutput(
    portraitPath, 'mp4', 2, undefined, sourceInfo, 'best', { preset: 'portrait', mode: 'fit' }
  );
  assert.deepEqual([portraitInfo.width, portraitInfo.height], [1080, 1920]);
  assert.ok(Math.abs(portraitInfo.duration - 2) < 0.2);

  const originalPath = path.join(temp, 'original-dimensions.mp4');
  await media.trim({
    input: sourcePath,
    output: originalPath,
    startTime: 0,
    endTime: 2,
    format: 'mp4',
    sourceInfo,
    resizePreset: 'original',
    resizeMode: 'fit'
  });
  const originalInfo = await media.validateOutput(
    originalPath, 'mp4', 2, undefined, sourceInfo, undefined, { preset: 'original', mode: 'fit' }
  );
  assert.deepEqual([originalInfo.width, originalInfo.height], [sourceInfo.width, sourceInfo.height]);
});

test('720p quality cap validates landscape and portrait MP4 dimensions', async () => {
  const fixtures = [
    { name: 'quality-landscape', size: '1920x1080', preset: 'landscape', expected: [1280, 720] },
    { name: 'quality-portrait', size: '1080x1920', preset: 'original', expected: [720, 1280] }
  ];
  for (const fixture of fixtures) {
    const input = path.join(temp, `${fixture.name}-source.mp4`);
    const output = path.join(temp, `${fixture.name}-output.mp4`);
    await execFileAsync('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y',
      '-f', 'lavfi', '-i', `color=c=blue:s=${fixture.size}:r=12:d=1`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
      input
    ], { timeout: 60000 });
    const sourceInfo = await media.inspect(input);
    await media.trim({
      input,
      output,
      startTime: 0,
      endTime: 1,
      format: 'mp4',
      sourceInfo,
      quality: '720p',
      resizePreset: fixture.preset,
      resizeMode: 'fit'
    });
    const result = await media.validateOutput(
      output,
      'mp4',
      1,
      undefined,
      sourceInfo,
      '720p',
      { preset: fixture.preset, mode: 'fit' }
    );
    assert.deepEqual([result.width, result.height], fixture.expected);
  }
});

test('direct metadata probes use byte ranges and report actual duration', async () => {
  const metadata = await direct.probe(`${serverUrl}/known.mp4`, {
    resolver: async () => [{ address: '127.0.0.1', family: 4 }]
  });
  assert.equal(metadata.contentType, 'video/mp4');
  assert.equal(metadata.contentLength, sourceBytes.length);
  trackMetadataRanges = true;
  let info;
  try {
    info = await direct.getInfo(`${serverUrl}/known.mp4`, {
      resolver: async () => [{ address: '127.0.0.1', family: 4 }]
    });
  } finally {
    trackMetadataRanges = false;
  }
  assert.equal(info.duration, 10);
  assert.equal(info.provider, 'direct');
  assert.ok(metadataRangeRequests > 0);
  assert.equal(unboundedMetadataRequests, 0);
});

test('range, missing audio, corrupt media, and output checks reject invalid files', async () => {
  assert.throws(() => media.validateRange(-1, 2, 10), { code: 'INVALID_RANGE' });
  assert.throws(() => media.validateRange(2, 2, 10), { code: 'INVALID_RANGE' });
  assert.throws(() => media.validateRange(0, 11, 10), { code: 'INVALID_RANGE' });
  assert.throws(() => media.validateRange(0, 0.5, 10), { code: 'INVALID_RANGE' });

  const silentInfo = await media.inspect(silentPath);
  assert.equal(silentInfo.hasAudio, false);
  await assert.rejects(() => media.trim({
    input: silentPath,
    output: path.join(temp, 'no-audio.mp3'),
    startTime: 0,
    endTime: 2,
    format: 'mp3',
    sourceInfo: silentInfo
  }), { code: 'NO_AUDIO' });

  const corrupt = path.join(temp, 'corrupt.mp4');
  await fs.writeFile(corrupt, Buffer.from('not a media file'));
  await assert.rejects(() => media.inspect(corrupt), { code: 'INVALID_SOURCE' });
  await assert.rejects(() => media.validateOutput(corrupt, 'mp4', 2), { code: 'INVALID_SOURCE' });
});

test('incomplete direct transfer is rejected and failed-job files are cleaned up', async () => {
  const incompletePath = path.join(temp, 'incomplete.mp4');
  const resolver = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(
    () => direct.acquire(`${serverUrl}/broken.mp4`, incompletePath, { resolver, timeoutMs: 2000 }),
    (error) => ['SOURCE_UNREACHABLE', 'INCOMPLETE_SOURCE'].includes(error.code)
  );
  await assert.rejects(() => fs.access(incompletePath));

  const id = require('node:crypto').randomUUID();
  const directory = await storage.createJobDirectory(id);
  const job = {
    id,
    url: 'https://media.example/video.mp4',
    title: 'broken',
    startTime: 0,
    endTime: 2,
    format: 'mp4',
    provider: direct,
    directory,
    status: 'processing',
    stage: 'acquiring',
    progress: 0,
    duration: 2,
    expiresAt: null,
    expired: false,
    controller: null,
    timedOut: false
  };
  await jobs.processJob(job, {
    acquireMedia: async (_provider, _url, jobDirectory) => {
      const badSource = path.join(jobDirectory, 'source.media');
      await fs.writeFile(badSource, Buffer.from('bad input'));
      return { path: badSource };
    }
  });
  assert.equal(job.status, 'failed');
  await assert.rejects(() => fs.access(directory));
});

test('job processor acquires a complete local asset and publishes a validated output', async () => {
  const id = require('node:crypto').randomUUID();
  const directory = await storage.createJobDirectory(id);
  const job = {
    id,
    url: 'https://media.example/video.mp4',
    title: 'known segment',
    startTime: 2,
    endTime: 5,
    format: 'mp4',
    provider: direct,
    directory,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    duration: 3,
    createdAt: Date.now(),
    expiresAt: null,
    expired: false,
    controller: null,
    timedOut: false
  };
  await jobs.processJob(job, {
    acquireMedia: async (_provider, _url, jobDirectory) => {
      const source = path.join(jobDirectory, 'source.media');
      await fs.copyFile(sourcePath, source);
      return { path: source };
    }
  });
  assert.equal(job.status, 'completed');
  assert.equal(job.stage, 'completed');
  assert.equal(job.progress, 100);
  const output = storage.outputPath(directory, 'mp4');
  const info = await media.inspect(output);
  assert.ok(Math.abs(info.duration - 3) < 0.2);
  await storage.removeJobDirectory(directory);
});

test('yt-dlp retrieves a local authorized fixture through the guarded proxy and serves validated MP4/MP3 jobs', async (t) => {
  const dependencies = await ytDlp.initialize();
  if (!dependencies.ytDlp.available || !dependencies.jsRuntime.available || !dependencies.ffmpeg.available || !dependencies.ffprobe.available) {
    t.skip('yt-dlp, Node.js, FFmpeg, and ffprobe must be installed for this integration test.');
    return;
  }
  assert.equal(providers.capabilities().find((entry) => entry.provider === 'direct').acquire, true);
  assert.deepEqual(dependencies.ffmpeg.encoders, { libx264: true, libmp3lame: true, matroska: true });

  const resolver = async (hostname) => {
    if (hostname === '127.0.0.1') return [{ address: '127.0.0.1', family: 4 }];
    throw new Error('The local-fixture resolver rejects non-test hosts.');
  };
  const allowedPorts = [80, 443, server.address().port];
  const platform = {
    name: 'youtube',
    matches: (raw) => new URL(raw).hostname === '127.0.0.1'
  };
  const provider = ytDlp.createProvider(platform);
  const providerGetInfo = provider.getInfo;
  let metadataFetches = 0;
  provider.getInfo = (...args) => {
    metadataFetches += 1;
    return providerGetInfo(...args);
  };
  const fixtureUrl = `${serverUrl}/known.mp4`;
  const metadata = await provider.getInfo(fixtureUrl, { resolver, allowedPorts });
  assert.equal(metadataFetches, 1);
  assert.equal(metadata.provider, 'youtube');
  assert.ok(metadata.title);
  assert.ok(Array.isArray(metadata.formats));
  assert.ok(metadata.formats.every((format) => !Object.hasOwn(format, 'url')));
  const selectorSource = path.join(temp, 'source.mp4');
  const selectorDestination = path.join(temp, 'selector-result.media');
  const capturedArgs = [];
  await fs.copyFile(sourcePath, selectorSource);
  await provider.acquire(fixtureUrl, selectorDestination, {
    resolver,
    allowedPorts,
    format: 'mp4',
    execute: async (_command, args) => {
      capturedArgs.push(...args);
      return { stdout: `${selectorSource}\n`, stderr: '' };
    }
  });
  assert.equal(
    capturedArgs[capturedArgs.indexOf('--format') + 1],
    'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/bestvideo[height<=720]+bestaudio/best[height<=720]'
  );
  assert.equal(capturedArgs[capturedArgs.indexOf('--js-runtimes') + 1], `node:${process.execPath}`);
  await fs.rm(selectorDestination, { force: true });

  let forbiddenAcquisitionError;
  await assert.rejects(
    () => provider.acquire(`${serverUrl}/forbidden.mp4`, path.join(temp, 'forbidden-source.media'), {
      resolver,
      allowedPorts,
      format: 'mp4'
    }),
    (error) => {
      forbiddenAcquisitionError = error;
      return true;
    }
  );
  assert.equal(forbiddenAcquisitionError.code, 'SOURCE_FORBIDDEN');
  assert.equal(forbiddenAcquisitionError.diagnostic.failureSource, 'upstream_http');
  assert.equal(forbiddenAcquisitionError.diagnostic.httpStatus, 403);
  assert.equal(forbiddenAcquisitionError.diagnostic.platform, 'youtube');
  assert.equal(forbiddenAcquisitionError.diagnostic.stage, 'upstream_http');
  assert.equal(forbiddenAcquisitionError.diagnostic.exitCode, 1);
  assert.ok(forbiddenAcquisitionError.diagnostic.proxyEvents.some((entry) => entry.type === 'upstream_http_403'));
  await assert.rejects(
    () => provider.acquire(
      fixtureUrl,
      path.join(temp, 'blocked-source.media'),
      {
        resolver: async () => [],
        allowedPorts,
        format: 'mp4'
      }
    ),
    (error) => {
      assert.equal(error.code, 'EGRESS_PROXY_BLOCKED', JSON.stringify(error.diagnostic));
      assert.equal(error.diagnostic.platform, 'youtube');
      assert.equal(error.diagnostic.stage, 'egress_proxy');
      assert.equal(error.diagnostic.exitCode, 1);
      assert.ok(error.diagnostic.stderrExcerpt);
      assert.ok(error.diagnostic.proxyEvents.some((entry) => entry.type === 'proxy_destination_rejected'));
      return true;
    }
  );

  const apiServer = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => apiServer.once('listening', resolve));
  const apiUrl = `http://127.0.0.1:${apiServer.address().port}`;
  const createdJobs = [];
  let acquisitionCount = 0;
  try {
    const created = await jobs.create({
      url: fixtureUrl,
      startTime: 2,
      endTime: 5,
      format: 'mp4',
      title: 'local parallel fixture'
    }, {
      resolveProvider: async () => provider,
      processingDependencies: {
        acquireMedia: async (resolvedProvider, url, directory, options) => {
          acquisitionCount += 1;
          return resolvedProvider.acquire(url, path.join(directory, 'source.media'), {
            ...options,
            resolver,
            allowedPorts
          });
        }
      }
    });
    createdJobs.push(created.id);
    let status = created;
    const deadline = Date.now() + 30000;
    while (['queued', 'processing'].includes(status.status) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const response = await fetch(`${apiUrl}/api/video/jobs/${created.id}`);
      assert.equal(response.status, 200);
      status = (await response.json()).job;
    }
    assert.equal(status.status, 'completed', status.error?.message);
    assert.equal(status.outputs.mp4.status, 'completed');
    assert.equal(status.outputs.mp3.status, 'completed');
    assert.equal(acquisitionCount, 1);
    assert.equal(metadataFetches, 1);

    for (const format of ['mp4', 'mp3']) {
      const output = status.outputs[format];
      assert.equal(output.downloadUrl, `/api/video/jobs/${created.id}/files/${format}`);
      const download = await fetch(`${apiUrl}${output.downloadUrl}`);
      assert.equal(download.status, 200);
      const bytes = Buffer.from(await download.arrayBuffer());
      assert.ok(bytes.length > 0);
      const downloadedPath = path.join(temp, `downloaded-${format}.${format}`);
      await fs.writeFile(downloadedPath, bytes);
      const validated = await media.validateOutput(downloadedPath, format, 3);
      assert.ok(Math.abs(validated.duration - 3) < 0.3);
      assert.equal(validated.hasVideo, format === 'mp4');
      assert.equal(validated.hasAudio, true);
    }

    const failed = await jobs.create({
      url: `${serverUrl}/missing.mp4`,
      startTime: 0,
      endTime: 2,
      format: 'mp4',
      title: 'failed local fixture'
    }, {
      resolveProvider: async () => provider,
      processingDependencies: {
        acquireMedia: async (resolvedProvider, url, directory, options) => (
          resolvedProvider.acquire(url, path.join(directory, 'source.media'), {
            ...options,
            resolver,
            allowedPorts
          })
        )
      }
    });
    createdJobs.push(failed.id);
    let failedStatus = failed;
    const failureDeadline = Date.now() + 30000;
    while (['queued', 'processing'].includes(failedStatus.status) && Date.now() < failureDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const response = await fetch(`${apiUrl}/api/video/jobs/${failed.id}`);
      failedStatus = (await response.json()).job;
    }
    assert.equal(failedStatus.status, 'failed');
    assert.equal(failedStatus.outputs.mp4.status, 'failed');
    assert.equal(failedStatus.outputs.mp3.status, 'failed');
    assert.equal(failedStatus.error.code, 'OUTPUTS_FAILED');
    await assert.rejects(() => fs.access(path.join(require('../src/config').storageDir, failed.id)));

    const forbidden = await jobs.create({
      url: `${serverUrl}/forbidden.mp4`,
      startTime: 0,
      endTime: 2,
      format: 'mp4',
      title: 'forbidden local fixture'
    }, {
      resolveProvider: async () => provider,
      processingDependencies: {
        acquireMedia: async (resolvedProvider, url, directory, options) => (
          resolvedProvider.acquire(url, path.join(directory, 'source.media'), {
            ...options,
            resolver,
            allowedPorts
          })
        )
      }
    });
    createdJobs.push(forbidden.id);
    let forbiddenStatus = forbidden;
    const forbiddenDeadline = Date.now() + 30000;
    while (['queued', 'processing'].includes(forbiddenStatus.status) && Date.now() < forbiddenDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const response = await fetch(`${apiUrl}/api/video/jobs/${forbidden.id}`);
      forbiddenStatus = (await response.json()).job;
    }
    assert.equal(forbiddenStatus.status, 'failed');
    assert.equal(forbiddenStatus.outputs.mp4.error.code, 'SOURCE_FORBIDDEN');
    assert.equal(forbiddenStatus.outputs.mp3.error.code, 'SOURCE_FORBIDDEN');
  } finally {
    apiServer.closeAllConnections();
    await new Promise((resolve) => apiServer.close(resolve));
    for (const id of createdJobs) {
      await storage.removeJobDirectory(path.join(require('../src/config').storageDir, id)).catch(() => {});
    }
  }
});
