const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const config = require('./config');
const { AppError } = require('./security');

async function initialize() {
  await fs.mkdir(config.storageDir, { recursive: true });
  const entries = await fs.readdir(config.storageDir, { withFileTypes: true });
  const staleBefore = Date.now() - config.fileRetentionMs;
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^[\da-f-]{36}$/i.test(entry.name)) continue;
    const directory = path.join(config.storageDir, entry.name);
    const stat = await fs.stat(directory);
    if (stat.mtimeMs < staleBefore) await removeJobDirectory(directory);
  }
}

async function createJobDirectory(id = randomUUID()) {
  if (!/^[\da-f-]{36}$/i.test(id)) throw new AppError('INVALID_JOB', 'Invalid job identifier.');
  await fs.mkdir(config.storageDir, { recursive: true });
  const directory = path.join(config.storageDir, id);
  await fs.mkdir(directory, { recursive: false });
  return directory;
}

function outputPath(directory, format) {
  if (!['mp4', 'mp3'].includes(format)) throw new AppError('INVALID_FORMAT', 'Choose MP4 or MP3.');
  return path.join(directory, `clip.${format}`);
}

function safeDownloadName(title, format) {
  const base = String(title || 'clip')
    .normalize('NFKC')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 100) || 'clip';
  return `${base}.${format}`;
}

async function ensureFile(pathname, maximumBytes) {
  let stat;
  try {
    stat = await fs.stat(pathname);
  } catch {
    throw new AppError('OUTPUT_INVALID', 'The generated media file is unavailable.', 500);
  }
  if (!stat.isFile() || stat.size === 0) throw new AppError('OUTPUT_INVALID', 'The generated media file is empty.', 500);
  if (stat.size > maximumBytes) throw new AppError('OUTPUT_TOO_LARGE', 'The generated file exceeds the configured size limit.', 413);
  return stat;
}

async function removeJobDirectory(directory) {
  const resolved = path.resolve(directory);
  const root = path.resolve(config.storageDir);
  if (path.dirname(resolved) !== root) throw new Error('Refusing to remove a path outside the job storage root.');
  await fs.rm(resolved, { recursive: true, force: true });
}

module.exports = { initialize, createJobDirectory, outputPath, safeDownloadName, ensureFile, removeJobDirectory };
