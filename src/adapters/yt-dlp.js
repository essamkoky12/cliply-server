const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('../config');
const { createEgressProxy } = require('../egress-proxy');
const { AppError, validateHttpUrl } = require('../security');
const { validateQuality, ytDlpFormatSelector } = require('../quality');

const platforms = {
  youtube: require('./youtube'),
  instagram: require('./instagram'),
  tiktok: require('./tiktok'),
  facebook: require('./facebook'),
  x: require('./x'),
  vimeo: require('./vimeo')
};

const PROGRESS_TEMPLATE = 'download:CLIPDOWN_PROGRESS:%(progress.downloaded_bytes)s:%(progress.total_bytes)s:%(progress.total_bytes_estimate)s';
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 12000;
const MAX_LOG_EXCERPT_CHARS = 1200;
const MAX_METADATA_CAPTURE_BYTES = config.maxRequestBytes * 64;
const PROXY_FAILURE_TYPES = new Set([
  'proxy_authentication_rejected',
  'proxy_destination_rejected',
  'proxy_destination_unresolved',
  'proxy_protocol_rejected',
  'proxy_upstream_failed',
  'proxy_upstream_timeout'
]);

const dependencyStatus = {
  initialized: false,
  ytDlp: { available: false, version: null },
  jsRuntime: { available: false, name: config.ytDlpJsRuntime, version: null },
  ffmpeg: { available: false, version: null, encoders: { libx264: false, libmp3lame: false, matroska: false } },
  ffprobe: { available: false, version: null }
};

function runtimeCommand() {
  if (config.ytDlpJsRuntime === 'node') return { command: process.execPath, versionArgs: ['--version'] };
  if (config.ytDlpJsRuntime === 'deno') return { command: 'deno', versionArgs: ['--version'] };
  throw new AppError('INVALID_CONFIGURATION', 'YT_DLP_JS_RUNTIME must be node or deno.', 500);
}

function runtimeOption() {
  if (config.ytDlpJsRuntime === 'node') return `node:${process.execPath}`;
  return 'deno';
}

function restrictedProcessEnvironment() {
  const env = { ...process.env };
  for (const key of [
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'
  ]) {
    delete env[key];
  }
  return env;
}

function sanitizeDiagnosticExcerpt(stderr) {
  const excerpt = String(stderr || '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\b(?:https?|socks5h?):\/\/[^\s"'<>]+/gi, '[redacted-url]')
    .replace(/\b(authorization|proxy-authorization|cookie|set-cookie)\s*[:=]\s*[^\r\n]*/gi, '$1=[REDACTED]')
    .replace(/\b(?:bearer|basic)\s+[a-z0-9._~+/=-]+/gi, '[REDACTED-CREDENTIAL]')
    .replace(/\b(access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|signature|sig|token|password|passwd|secret|session(?:id)?|credential)\b(\s*[:=]\s*)[^\s,;]+/gi, '$1$2[REDACTED]');
  return excerpt.slice(-MAX_LOG_EXCERPT_CHARS).trim() || null;
}

function hostsInDiagnostic(stderr) {
  const hosts = new Set();
  for (const match of String(stderr || '').matchAll(/\bhttps?:\/\/[^\s"'<>]+/gi)) {
    try {
      hosts.add(new URL(match[0]).hostname.toLowerCase());
    } catch {
      continue;
    }
  }
  return hosts;
}

function proxyFailureFor(stderr, proxyDiagnostics, sourceHost) {
  const failures = proxyDiagnostics.filter((entry) => PROXY_FAILURE_TYPES.has(entry.type));
  const diagnosticHosts = hostsInDiagnostic(stderr);
  const matchedFailure = failures.find((entry) => (
    !entry.destination
    || diagnosticHosts.has(entry.destination.toLowerCase())
    || entry.destination.toLowerCase() === sourceHost
  ));
  if (matchedFailure) return matchedFailure;
  if (/proxy|tunnel|connection failed/i.test(stderr)) return failures.length === 1 ? failures[0] : null;

  const blockedDestination = failures.filter((entry) => [
    'proxy_destination_rejected',
    'proxy_destination_unresolved',
    'proxy_protocol_rejected',
    'proxy_authentication_rejected'
  ].includes(entry.type)).at(-1);
  return httpStatusFromDiagnostic(stderr) === 403 ? blockedDestination || null : null;
}

function httpStatusFromDiagnostic(stderr) {
  const match = String(stderr || '').match(/\bHTTP Error\s+(\d{3})\b|\bTunnel connection failed:\s*(\d{3})\b/i);
  return match ? Number(match[1] || match[2]) : null;
}

function runCommand(command, args, options = {}) {
  const {
    timeoutMs = config.jobTimeoutMs,
    signal,
    onProgress,
    maxBytes,
    captureLimit = MAX_CAPTURE_BYTES,
    collectOutput = true,
    env = restrictedProcessEnvironment(),
    platform = 'unknown',
    stage = 'yt-dlp',
    sourceHost = null,
    proxyDiagnostics = []
  } = options;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, env });
    } catch {
      reject(new AppError('TOOL_UNAVAILABLE', 'The configured media downloader could not be started.', 503));
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let pendingLine = '';
    let terminationError = null;
    let settled = false;

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(result);
    }

    function terminate(error) {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill('SIGKILL');
      if (child.exitCode !== null) finish(error);
    }

    function abort() {
      terminate(new AppError('JOB_CANCELLED', 'The job was cancelled.', 409));
    }

    const timer = setTimeout(() => {
      terminate(new AppError('TOOL_TIMEOUT', 'The source operation exceeded its time limit.', 504));
    }, timeoutMs);
    timer.unref();
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > captureLimit) {
        terminate(new AppError('TOOL_OUTPUT_TOO_LARGE', 'The source returned too much metadata or progress output.', 413));
        return;
      }
      const text = chunk.toString('utf8');
      if (collectOutput) stdout += text;
      if (!onProgress) return;

      const lines = `${pendingLine}${text}`.split(/\r?\n/);
      pendingLine = lines.pop() || '';
      for (const line of lines) {
        if (!line.startsWith('CLIPDOWN_PROGRESS:')) continue;
        const [, downloadedRaw, totalRaw, estimateRaw] = line.split(':');
        const downloaded = Number(downloadedRaw);
        const total = Number(totalRaw) || Number(estimateRaw);
        if (Number.isFinite(downloaded) && downloaded > maxBytes) {
          terminate(new AppError('SOURCE_TOO_LARGE', 'The acquired media exceeds the configured source size limit.', 413));
          return;
        }
        onProgress({
          downloaded: Number.isFinite(downloaded) ? downloaded : null,
          total: Number.isFinite(total) && total > 0 ? total : null
        });
      }
    });

    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-MAX_DIAGNOSTIC_BYTES);
    });
    child.on('error', (error) => {
      finish(terminationError || new AppError(
        'TOOL_UNAVAILABLE',
        error.code === 'ENOENT'
          ? 'yt-dlp is not installed or YT_DLP_PATH is not configured.'
          : 'The configured media downloader could not be started.',
        503
      ));
    });
    child.on('close', (code) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code !== 0) {
        const proxyFailure = proxyFailureFor(stderr, proxyDiagnostics, sourceHost);
        const httpStatus = httpStatusFromDiagnostic(stderr);
        let error;
        if (proxyFailure) {
          const blocked = [
            'proxy_authentication_rejected',
            'proxy_destination_rejected',
            'proxy_destination_unresolved',
            'proxy_protocol_rejected'
          ].includes(proxyFailure.type);
          error = new AppError(
            blocked ? 'EGRESS_PROXY_BLOCKED' : 'EGRESS_PROXY_FAILED',
            blocked
              ? 'The outbound safety proxy rejected a media destination.'
              : 'The outbound safety proxy could not connect to a media destination.',
            blocked ? 403 : 502
          );
        } else {
          error = classifyYtDlpError(stderr);
        }
        const upstreamResponseObserved = proxyDiagnostics.some((entry) => (
          ['upstream_http_403', 'https_tunnel_established'].includes(entry.type)
        ));
        const failureSource = proxyFailure
          ? 'egress_proxy'
          : httpStatus && upstreamResponseObserved
            ? 'upstream_http'
            : 'yt-dlp';
        error.diagnostic = {
          platform,
          stage: failureSource === 'egress_proxy'
            ? 'egress_proxy'
            : failureSource === 'upstream_http'
              ? 'upstream_http'
              : stage,
          failureSource,
          httpStatus,
          exitCode: code,
          stderrExcerpt: sanitizeDiagnosticExcerpt(stderr),
          proxyEvents: proxyDiagnostics.slice(-8)
        };
        finish(error);
        return;
      }
      if (pendingLine && onProgress && pendingLine.startsWith('CLIPDOWN_PROGRESS:')) {
        const [, downloadedRaw, totalRaw, estimateRaw] = pendingLine.split(':');
        const downloaded = Number(downloadedRaw);
        const total = Number(totalRaw) || Number(estimateRaw);
        onProgress({
          downloaded: Number.isFinite(downloaded) ? downloaded : null,
          total: Number.isFinite(total) && total > 0 ? total : null
        });
      }
      finish(null, { stdout, stderr });
    });
  });
}

function classifyYtDlpError(diagnostic) {
  if (/unsupported url/i.test(diagnostic)) {
    return new AppError('UNSUPPORTED_URL', 'yt-dlp does not support this URL.', 415);
  }
  if (/drm|digital rights management|protected content/i.test(diagnostic)) {
    return new AppError('PROTECTED_MEDIA', 'This source uses protected media and cannot be processed.', 403);
  }
  if (/private video|video is private|sign in to confirm|login required|members.only|authentication required/i.test(diagnostic)) {
    return new AppError('AUTH_REQUIRED', 'The source requires authorization. Cliply does not use account cookies or session credentials.', 403);
  }
  if (/http error 429|too many requests/i.test(diagnostic)) {
    return new AppError('SOURCE_RATE_LIMITED', 'The provider is temporarily rate-limiting requests. Try again later.', 429);
  }
  if (/http error 404|404 not found|no longer available/i.test(diagnostic)) {
    return new AppError('MEDIA_UNAVAILABLE', 'The source is unavailable or has been removed.', 404);
  }
  if (/requested format is not available|no suitable formats|no formats found/i.test(diagnostic)) {
    return new AppError('UNSUPPORTED_FORMAT', 'The provider did not offer a processable format for this source.', 415);
  }
  if (/http error 401|http error 403|forbidden|geo.?restrict|not available in your country/i.test(diagnostic)) {
    return new AppError('SOURCE_FORBIDDEN', 'The provider denied access to this source.', 403);
  }
  if (/video unavailable|is unavailable|has been removed|no longer available/i.test(diagnostic)) {
    return new AppError('MEDIA_UNAVAILABLE', 'The source is unavailable, removed, or not accessible.', 404);
  }
  return new AppError('ACQUISITION_FAILED', 'yt-dlp could not retrieve this source. It may be unsupported or restricted.', 422);
}

async function checkExecutable(command, args, timeoutMs = 15000) {
  try {
    const { stdout } = await runCommand(command, args, { timeoutMs, captureLimit: 32768 });
    return { available: true, version: stdout.trim().split(/\r?\n/, 1)[0] || 'available' };
  } catch {
    return { available: false, version: null };
  }
}

async function initialize() {
  const runtime = runtimeCommand();
  const ytDlpArgs = ['--no-config', '--js-runtimes', runtimeOption(), '--version'];
  const [ytDlp, jsRuntime, ffmpegVersion, libx264, libmp3lame, matroska, ffprobe] = await Promise.all([
    checkExecutable(config.ytDlpPath, ytDlpArgs),
    checkExecutable(runtime.command, runtime.versionArgs),
    checkExecutable(config.ffmpegPath, ['-version']),
    checkExecutable(config.ffmpegPath, ['-hide_banner', '-h', 'encoder=libx264']),
    checkExecutable(config.ffmpegPath, ['-hide_banner', '-h', 'encoder=libmp3lame']),
    checkExecutable(config.ffmpegPath, ['-hide_banner', '-h', 'muxer=matroska']),
    checkExecutable(config.ffprobePath, ['-version'])
  ]);
  Object.assign(dependencyStatus, {
    initialized: true,
    ytDlp: { available: ytDlp.available, version: ytDlp.version },
    jsRuntime: { available: jsRuntime.available, name: config.ytDlpJsRuntime, version: jsRuntime.version },
    ffmpeg: {
      available: ffmpegVersion.available && libx264.available && libmp3lame.available && matroska.available,
      version: ffmpegVersion.version,
      encoders: {
        libx264: libx264.available,
        libmp3lame: libmp3lame.available,
        matroska: matroska.available
      }
    },
    ffprobe: { available: ffprobe.available, version: ffprobe.version }
  });
  return getDependencyStatus();
}

function getDependencyStatus() {
  return JSON.parse(JSON.stringify(dependencyStatus));
}

function toolingReady() {
  return dependencyStatus.ytDlp.available
    && dependencyStatus.jsRuntime.available
    && dependencyStatus.ffmpeg.available
    && dependencyStatus.ffprobe.available;
}

function supportedPlatform(raw, platformOverride) {
  const url = validateHttpUrl(raw);
  if (platformOverride?.matches(url.href)) return platformOverride;
  for (const platform of Object.values(platforms)) {
    if (platform.matches(url.href)) return platform;
  }
  return null;
}

function normalizeFormats(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const hasVideo = formats.some((format) => format.vcodec && format.vcodec !== 'none');
  const hasAudio = formats.some((format) => format.acodec && format.acodec !== 'none');
  const availableFormats = [];
  if (hasVideo) availableFormats.push('mp4');
  if (hasAudio) availableFormats.push('mp3');
  return {
    hasVideo,
    hasAudio,
    availableFormats,
    formats: formats.slice(0, 40).map((format) => ({
      id: typeof format.format_id === 'string' ? format.format_id.slice(0, 40) : null,
      extension: typeof format.ext === 'string' ? format.ext.slice(0, 12) : null,
      resolution: typeof format.resolution === 'string' ? format.resolution.slice(0, 40) : null,
      width: Number.isSafeInteger(format.width) ? format.width : null,
      height: Number.isSafeInteger(format.height) ? format.height : null,
      video: Boolean(format.vcodec && format.vcodec !== 'none'),
      audio: Boolean(format.acodec && format.acodec !== 'none'),
      filesize: Number.isSafeInteger(format.filesize) && format.filesize >= 0 ? format.filesize : null
    }))
  };
}

async function safeThumbnail(raw) {
  if (typeof raw !== 'string') return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    const allowed = [
      'i.ytimg.com', 'img.youtube.com', 'pbs.twimg.com',
      'cdninstagram.com', 'fbcdn.net', 'tiktokcdn.com',
      'ibytedtos.com', 'vimeocdn.com'
    ].some((domain) => host === domain || host.endsWith(`.${domain}`));
    if (!allowed) return null;
    const { validateExternalUrl } = require('../security');
    await validateExternalUrl(url.href);
    return url.href;
  } catch {
    return null;
  }
}

function baseArgs(proxyUrl) {
  return [
    '--no-config',
    '--no-cache-dir',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout', '30',
    '--retries', '2',
    '--fragment-retries', '2',
    '--downloader', 'native',
    '--js-runtimes', runtimeOption(),
    '--remote-components', 'ejs:github',
    '--proxy', proxyUrl
  ];
}

async function withProxy(operation, options = {}) {
  const proxy = await createEgressProxy({
    resolver: options.resolver,
    allowedPorts: options.allowedPorts
  });
  try {
    return await operation(proxy.url, proxy.diagnostics);
  } finally {
    await proxy.close();
  }
}

async function runMetadata(raw, { playlist = false, ...options } = {}) {
  const platform = supportedPlatform(raw, options.platformOverride);
  if (!platform) throw new AppError('UNSUPPORTED_PROVIDER', 'Only recognized video-provider URLs can use yt-dlp.', 415);
  if (!options.execute && (!dependencyStatus.ytDlp.available || !dependencyStatus.jsRuntime.available)) {
    throw new AppError('TOOL_UNAVAILABLE', 'Install yt-dlp and the configured JavaScript runtime before requesting metadata.', 503);
  }
  return withProxy((proxyUrl, proxyDiagnostics) => {
    const args = [...baseArgs(proxyUrl)];
    if (playlist) {
      args.splice(args.indexOf('--no-playlist'), 1);
      args.push('--flat-playlist', '--playlist-end', '50');
    }
    args.push('--dump-single-json', '--skip-download', raw);
    return (options.execute || runCommand)(config.ytDlpPath, args, {
      timeoutMs: options.timeoutMs || 120000,
      signal: options.signal,
      captureLimit: MAX_METADATA_CAPTURE_BYTES,
      platform: platform.name,
      stage: playlist ? 'yt-dlp playlist metadata' : 'yt-dlp metadata',
      proxyDiagnostics
    });
  }, options);
}

function parseMetadata(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    throw new AppError('METADATA_UNAVAILABLE', 'yt-dlp returned invalid metadata for this source.', 502);
  }
}

function logMetadataDiagnostic(error, platform) {
  const diagnostic = error?.diagnostic;
  if (!diagnostic || typeof diagnostic !== 'object') return;

  const allowedProxyEvents = new Set([
    'proxy_authentication_rejected',
    'proxy_destination_rejected',
    'proxy_destination_unresolved',
    'proxy_protocol_rejected',
    'proxy_request_invalid',
    'proxy_upstream_failed',
    'proxy_upstream_timeout',
    'upstream_http_403',
    'https_tunnel_established'
  ]);
  const proxyEvents = Array.isArray(diagnostic.proxyEvents)
    ? diagnostic.proxyEvents.slice(-8).flatMap((event) => {
        if (!event || !allowedProxyEvents.has(event.type)) return [];
        const destination = typeof event.destination === 'string'
          && /^[a-z\d._:-]{1,253}$/i.test(event.destination)
          ? event.destination
          : null;
        return [{ type: event.type, destination }];
      })
    : [];
  const safeLabel = (value, fallback) => (
    typeof value === 'string' && /^[a-z\d _-]{1,64}$/i.test(value) ? value : fallback
  );

  console.error('Metadata request diagnostic:', JSON.stringify({
    platform,
    stage: safeLabel(diagnostic.stage, 'unknown'),
    failureSource: safeLabel(diagnostic.failureSource, 'unknown'),
    httpStatus: Number.isInteger(diagnostic.httpStatus) ? diagnostic.httpStatus : null,
    exitCode: Number.isInteger(diagnostic.exitCode) ? diagnostic.exitCode : null,
    errorCode: safeLabel(error.code, 'UNKNOWN'),
    stderrExcerpt: sanitizeDiagnosticExcerpt(diagnostic.stderrExcerpt),
    proxyEvents
  }));
}

async function getInfo(raw, options = {}) {
  const platform = supportedPlatform(raw, options.platformOverride);
  if (!platform) throw new AppError('UNSUPPORTED_PROVIDER', 'Only recognized video-provider URLs can use yt-dlp.', 415);
  if (platform.name === 'youtube' && require('./youtube').matches(raw)?.type === 'playlist') {
    throw new AppError('PLAYLIST_URL', 'Submit one YouTube video at a time; use the playlist information endpoint.', 400);
  }
  let stdout;
  try {
    ({ stdout } = await runMetadata(raw, options));
  } catch (error) {
    logMetadataDiagnostic(error, platform.name);
    if (error instanceof AppError && error.code === 'ACQUISITION_FAILED') {
      const metadataError = new AppError('METADATA_UNAVAILABLE', 'yt-dlp could not retrieve metadata for this source.', error.status);
      metadataError.diagnostic = error.diagnostic;
      throw metadataError;
    }
    throw error;
  }
  const info = parseMetadata(stdout);
  if (Array.isArray(info.entries)) {
    throw new AppError('PLAYLIST_URL', 'Submit one video at a time; playlist downloads are not enabled.', 400);
  }
  const normalized = normalizeFormats(info);
  const duration = Number.isFinite(info.duration) && info.duration > 0 ? info.duration : null;
  const live = Boolean(info.is_live);
  const supported = normalized.availableFormats.length > 0 && !live;
  const ready = toolingReady() || Boolean(options.execute);
  let reason = null;
  if (!normalized.availableFormats.length) reason = 'yt-dlp found no processable audio or video formats.';
  else if (live) reason = 'Live streams cannot be trimmed by this workflow.';
  else if (!ready) reason = 'yt-dlp, its JavaScript runtime, FFmpeg, and ffprobe must all be available.';

  return {
    title: typeof info.title === 'string' && info.title.trim() ? info.title.trim().slice(0, 500) : 'Untitled media',
    thumbnail: await safeThumbnail(info.thumbnail),
    provider: platform.name,
    duration,
    availableFormats: supported && ready ? normalized.availableFormats : [],
    formats: normalized.formats,
    hasVideo: normalized.hasVideo,
    hasAudio: normalized.hasAudio,
    capabilities: {
      metadata: true,
      acquire: supported && ready,
      formats: supported && ready ? normalized.availableFormats : [],
      reason
    }
  };
}

async function getPlaylistInfo(raw, options = {}) {
  const platform = supportedPlatform(raw);
  if (platform?.name !== 'youtube' || !require('./youtube').matches(raw)?.playlistId) {
    throw new AppError('UNSUPPORTED_CAPABILITY', 'Only YouTube playlist metadata is supported.', 415);
  }
  const { stdout } = await runMetadata(raw, { ...options, playlist: true });
  const info = parseMetadata(stdout);
  const entries = Array.isArray(info.entries) ? info.entries : [];
  return {
    title: typeof info.title === 'string' ? info.title.slice(0, 500) : 'YouTube playlist',
    itemCount: Number.isSafeInteger(info.playlist_count) ? info.playlist_count : entries.length,
    items: await Promise.all(entries
      .filter((entry) => typeof entry.id === 'string' && /^[\w-]{11}$/.test(entry.id))
      .map(async (entry) => ({
        id: entry.id,
        title: typeof entry.title === 'string' ? entry.title.slice(0, 500) : 'Untitled video',
        thumbnail: entry.thumbnails?.length
          ? await safeThumbnail(entry.thumbnails[entry.thumbnails.length - 1].url)
          : await safeThumbnail(entry.thumbnail)
      }))),
    nextPageToken: null,
    provider: 'youtube',
    capabilities: { metadata: true, acquire: false, reason: 'Playlist downloads are not enabled.' }
  };
}

function classifyAcquisitionError(error) {
  if (error instanceof AppError) return error;
  return new AppError('ACQUISITION_FAILED', 'yt-dlp could not retrieve this source.', 422);
}

async function acquire(raw, destination, options = {}) {
  const platform = supportedPlatform(raw, options.platformOverride);
  if (!platform) throw new AppError('UNSUPPORTED_PROVIDER', 'Only recognized video-provider URLs can use yt-dlp.', 415);
  if (!options.execute && !toolingReady()) {
    throw new AppError('TOOL_UNAVAILABLE', 'Install yt-dlp, Node.js, FFmpeg, and ffprobe before downloading.', 503);
  }
  if (!['mp4', 'mp3'].includes(options.format)) throw new AppError('INVALID_FORMAT', 'Choose MP4 or MP3.');

  const directory = path.dirname(destination);
  const outputTemplate = path.join(directory, 'source.%(ext)s');
  const formatSelector = options.format === 'mp3'
    ? 'ba/b'
    : ytDlpFormatSelector(validateQuality(options.quality));
  let stage = 'egress_proxy_initialization';

  try {
    return await withProxy(async (proxyUrl, proxyDiagnostics) => {
      stage = 'yt-dlp acquisition';
      const args = [
        ...baseArgs(proxyUrl),
        '--newline',
        '--progress-template', PROGRESS_TEMPLATE,
        '--max-filesize', String(options.maxBytes || config.maxSourceBytes),
        '--format', formatSelector,
        '--merge-output-format', 'mkv',
        '--output', outputTemplate,
        '--print', 'after_move:filepath',
        raw
      ];
      const result = await (options.execute || runCommand)(config.ytDlpPath, args, {
        timeoutMs: options.timeoutMs || config.jobTimeoutMs,
        signal: options.signal,
        maxBytes: options.maxBytes || config.maxSourceBytes,
        onProgress: options.onProgress,
        captureLimit: 2 * 1024 * 1024,
        platform: platform.name,
        stage,
        sourceHost: new URL(raw).hostname.toLowerCase(),
        proxyDiagnostics
      });
      stage = 'acquired_file_validation';

      const candidates = result.stdout.split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && path.basename(line).startsWith('source.'));
      const candidate = candidates.pop();
      if (!candidate) throw new AppError('ACQUISITION_FAILED', 'yt-dlp completed without reporting an output file.', 422);
      const resolvedDirectory = await fs.realpath(directory);
      const resolvedCandidate = path.resolve(candidate);
      if (path.dirname(resolvedCandidate) !== resolvedDirectory || !path.basename(resolvedCandidate).startsWith('source.')) {
        throw new AppError('ACQUISITION_FAILED', 'yt-dlp returned an invalid output location.', 500);
      }
      const stat = await fs.lstat(resolvedCandidate);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
        throw new AppError('ACQUISITION_FAILED', 'yt-dlp did not produce a valid media file.', 422);
      }
      if (stat.size > (options.maxBytes || config.maxSourceBytes)) {
        throw new AppError('SOURCE_TOO_LARGE', 'The acquired media exceeds the configured source size limit.', 413);
      }
      await fs.rename(resolvedCandidate, destination);
      const entries = await fs.readdir(directory, { withFileTypes: true });
      await Promise.all(entries
        .filter((entry) => entry.name.startsWith('source.') && path.join(directory, entry.name) !== destination)
        .map((entry) => fs.rm(path.join(directory, entry.name), { recursive: entry.isDirectory(), force: true })));
      return { path: destination, bytes: stat.size, provider: platform.name };
    }, options);
  } catch (error) {
    if (!error.diagnostic) {
      error.diagnostic = {
        platform: platform.name,
        stage: error.code === 'INVALID_URL' || error.code === 'URL_BLOCKED' ? 'url_validation' : stage,
        exitCode: null,
        stderrExcerpt: null,
        proxyEvents: []
      };
    }
    const classified = classifyAcquisitionError(error);
    classified.diagnostic = error.diagnostic;
    throw classified;
  }
}

function capabilitiesFor(platformName) {
  const available = toolingReady();
  return {
    metadata: dependencyStatus.ytDlp.available && dependencyStatus.jsRuntime.available,
    playlist: platformName === 'youtube' && dependencyStatus.ytDlp.available && dependencyStatus.jsRuntime.available,
    acquire: available,
    formats: available ? ['mp4', 'mp3'] : [],
    reason: available
      ? 'Supported public sources are available through yt-dlp; individual URLs may be unavailable or restricted.'
      : 'yt-dlp, its JavaScript runtime, FFmpeg, and ffprobe must be installed.'
  };
}

function createProvider(platform) {
  const provider = {
    name: platform.name,
    matches: platform.matches,
    getInfo: (raw, options = {}) => getInfo(raw, { ...options, platformOverride: platform }),
    acquire: (raw, destination, options = {}) => acquire(raw, destination, { ...options, platformOverride: platform }),
    capabilities: null
  };
  if (platform.name === 'youtube') provider.getPlaylistInfo = getPlaylistInfo;
  Object.defineProperty(provider, 'capabilities', {
    enumerable: true,
    get: () => capabilitiesFor(platform.name)
  });
  return provider;
}

module.exports = {
  name: 'yt-dlp',
  initialize,
  getDependencyStatus,
  capabilitiesFor,
  supportedPlatform,
  normalizeFormats,
  parseMetadata,
  classifyYtDlpError,
  sanitizeDiagnosticExcerpt,
  httpStatusFromDiagnostic,
  createProvider,
  getInfo,
  getPlaylistInfo,
  acquire,
  runCommand,
  baseArgs,
  runtimeOption,
  restrictedProcessEnvironment,
  _dependencies: dependencyStatus
};
