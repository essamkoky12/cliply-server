const path = require('node:path');
require('dotenv').config();

function integer(name, fallback, minimum, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = process.env[name];
  const value = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return value;
}

const config = Object.freeze({
  port: integer('PORT', 4000, 1, 65535),
  allowedOrigin: process.env.ALLOWED_ORIGIN || 'http://localhost:3000',
  jobTimeoutMs: integer('JOB_TIMEOUT_MS', 900000, 1000),
  maxSourceBytes: integer('MAX_SOURCE_BYTES', 536870912, 1024),
  maxMetadataProbeBytes: integer('MAX_METADATA_PROBE_BYTES', 8388608, 1024),
  maxOutputBytes: integer('MAX_OUTPUT_BYTES', 536870912, 1024),
  maxConcurrentJobs: integer('MAX_CONCURRENT_JOBS', 2, 1, 50),
  maxQueuedJobs: integer('MAX_QUEUED_JOBS', 20, 1, 500),
  fileRetentionMs: integer('FILE_RETENTION_MS', 3600000, 60000),
  minSegmentSeconds: Number(process.env.MIN_SEGMENT_SECONDS || 1),
  maxRequestBytes: integer('MAX_REQUEST_BYTES', 16384, 1024),
  storageDir: path.resolve(process.env.STORAGE_DIR || path.join(__dirname, '..', 'storage')),
  youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
  ytDlpPath: process.env.YT_DLP_PATH || 'yt-dlp',
  ytDlpJsRuntime: process.env.YT_DLP_JS_RUNTIME || 'node',
  ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobePath: process.env.FFPROBE_PATH || 'ffprobe'
});

if (!Number.isFinite(config.minSegmentSeconds) || config.minSegmentSeconds <= 0) {
  throw new Error('MIN_SEGMENT_SECONDS must be a positive number');
}

module.exports = config;
