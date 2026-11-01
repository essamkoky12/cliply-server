const { randomUUID } = require('node:crypto');
const config = require('./config');
const providers = require('./providers');
const { acquireMedia } = require('./acquisition');
const media = require('./media');
const storage = require('./storage');
const { AppError } = require('./security');
const { validateQuality } = require('./quality');
const { validateResize } = require('./resizing');

const jobs = new Map();
const queue = [];
const OUTPUT_FORMATS = ['mp4', 'mp3'];
let activeCount = 0;

function outputUrl(jobId, format) {
  return `/api/video/jobs/${jobId}/files/${format}`;
}

function publicOutput(job, output) {
  const available = output.status === 'completed' && output.expiresAt > Date.now();
  return {
    status: available ? 'completed' : output.status === 'completed' ? 'expired' : output.status,
    stage: output.stage,
    progress: output.progress,
    error: output.error,
    resolution: output.resolution || null,
    audioBitrate: output.audioBitrate || null,
    fileName: available ? storage.safeDownloadName(job.title, output.format) : null,
    fileAvailable: available,
    downloadUrl: available ? outputUrl(job.id, output.format) : null,
    expiresAt: output.expiresAt
  };
}

function publicJob(job) {
  const outputs = Object.fromEntries(OUTPUT_FORMATS
    .filter((format) => job.outputs?.[format])
    .map((format) => [format, publicOutput(job, job.outputs[format])]));
  const selectedOutput = job.outputs?.[job.format];
  const selectedPublicOutput = selectedOutput && publicOutput(job, selectedOutput);
  return {
    id: job.id,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    error: job.error,
    format: job.format,
    quality: job.quality,
    audioQuality: job.audioQuality,
    resizePreset: job.resizePreset,
    resizeMode: job.resizeMode,
    duration: job.duration,
    outputs,
    fileAvailable: Boolean(selectedPublicOutput?.fileAvailable),
    downloadUrl: selectedPublicOutput?.downloadUrl || null,
    expiresAt: job.expiresAt
  };
}

async function create(input, dependencies = {}) {
  if (!input || typeof input.url !== 'string' || input.url.length > 4096) {
    throw new AppError('INVALID_REQUEST', 'A video URL is required.');
  }
  const selectedFormat = input.format || 'mp4';
  if (!OUTPUT_FORMATS.includes(selectedFormat)) throw new AppError('INVALID_FORMAT', 'Choose MP4 or MP3.');
  const quality = validateQuality(input.quality);
  const audioQuality = media.validateAudioBitrate(input.audioQuality);
  const { preset: resizePreset, mode: resizeMode } = validateResize(input.resizePreset, input.resizeMode);
  const startTime = Number(input.startTime);
  const endTime = Number(input.endTime);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) {
    throw new AppError('INVALID_RANGE', 'Enter a valid start and end time.');
  }
  if (queue.length >= config.maxQueuedJobs) {
    throw new AppError('JOB_QUEUE_FULL', 'The processing queue is full. Try again shortly.', 429);
  }
  const provider = await (dependencies.resolveProvider || providers.resolve)(input.url);
  if (!provider.capabilities.acquire) {
    throw new AppError('ACQUISITION_UNAVAILABLE', provider.capabilities.reason || `${provider.name} media acquisition is unavailable.`, 501);
  }
  const supportedFormats = new Set(provider.capabilities.formats || []);
  if (!OUTPUT_FORMATS.some((format) => supportedFormats.has(format))) {
    throw new AppError('UNSUPPORTED_FORMAT', `${provider.name} does not support MP4 or MP3 output.`, 415);
  }
  const id = randomUUID();
  const directory = await storage.createJobDirectory(id);
  const outputs = Object.fromEntries(OUTPUT_FORMATS.map((format) => {
    const supported = supportedFormats.has(format);
    return [format, {
      format,
      status: supported ? 'queued' : 'failed',
      stage: supported ? 'queued' : 'failed',
      progress: 0,
      error: supported ? null : {
        code: 'UNSUPPORTED_FORMAT',
        message: `${provider.name} does not support ${format.toUpperCase()} output.`
      },
      expiresAt: null
    }];
  }));
  const job = {
    id,
    url: input.url,
    title: typeof input.title === 'string' ? input.title.slice(0, 120) : 'clip',
    startTime,
    endTime,
    format: selectedFormat,
    quality,
    audioQuality,
    resizePreset,
    resizeMode,
    acquisitionFormat: supportedFormats.has('mp4') ? 'mp4' : 'mp3',
    outputs,
    provider,
    directory,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    error: null,
    duration: endTime - startTime,
    createdAt: Date.now(),
    expiresAt: null,
    expired: false,
    controller: null,
    timedOut: false
  };
  if (dependencies.processingDependencies) job.processingDependencies = dependencies.processingDependencies;
  jobs.set(id, job);
  queue.push(job);
  pump();
  return publicJob(job);
}

function pump() {
  while (activeCount < config.maxConcurrentJobs && queue.length) {
    const job = queue.shift();
    if (job.status !== 'queued') continue;
    activeCount += 1;
    processJob(job, job.processingDependencies).finally(() => {
      activeCount -= 1;
      pump();
    });
  }
}

async function processJob(job, dependencies = {}) {
  const acquire = dependencies.acquireMedia || acquireMedia;
  const mediaTools = dependencies.media || media;
  const fileStorage = dependencies.storage || storage;
  job.quality ||= '720p';
  job.audioQuality ??= 192;
  job.resizePreset ||= 'original';
  job.resizeMode ||= 'fit';
  job.outputs ||= Object.fromEntries(OUTPUT_FORMATS.map((format) => [format, {
    format,
    status: format === job.format ? 'queued' : 'failed',
    stage: format === job.format ? 'queued' : 'failed',
    progress: 0,
    error: format === job.format ? null : { code: 'UNSUPPORTED_FORMAT', message: `${format.toUpperCase()} output was not requested.` },
    expiresAt: null
  }]));
  job.status = 'processing';
  job.stage = 'acquiring';
  job.controller = new AbortController();
  const timeout = setTimeout(() => {
    job.timedOut = true;
    job.controller.abort();
  }, config.jobTimeoutMs);
  timeout.unref();
  let acquiredPath;
  let sourceInfo;
  try {
    for (const output of Object.values(job.outputs)) {
      if (output.status === 'queued') {
        output.status = 'processing';
        output.stage = 'acquiring';
      }
    }
    const acquired = await acquire(job.provider, job.url, job.directory, {
      signal: job.controller.signal,
      maxBytes: config.maxSourceBytes,
      format: job.acquisitionFormat || 'mp4',
      quality: job.resizePreset === 'original' ? 'best' : job.quality,
      onProgress: (progress) => {
        if (progress?.downloaded && progress.total) {
          const percentage = Math.min(99, Math.floor((progress.downloaded / progress.total) * 100));
          job.progress = Math.floor(percentage * 0.6);
          for (const output of Object.values(job.outputs)) {
            if (output.status === 'processing' && output.stage === 'acquiring') output.progress = percentage;
          }
        }
      }
    });
    acquiredPath = acquired.path;
    job.stage = 'validating_source';
    for (const output of Object.values(job.outputs)) {
      if (output.status === 'processing') output.stage = 'validating_source';
    }
    sourceInfo = await mediaTools.inspect(acquired.path, { signal: job.controller.signal });
    const duration = mediaTools.validateRange(job.startTime, job.endTime, sourceInfo.duration);
    job.duration = duration;
    job.stage = 'processing';
    const outputTasks = OUTPUT_FORMATS
      .filter((format) => job.outputs[format].status === 'processing')
      .map((format) => processOutput(job, format, acquired.path, duration, sourceInfo, mediaTools, fileStorage));
    await Promise.allSettled(outputTasks);
    finalizeJob(job);
  } catch (error) {
    if (job.status !== 'cancelled') {
      const failure = job.timedOut
        ? new AppError('JOB_TIMEOUT', 'The job exceeded its time limit.', 504)
        : error instanceof AppError
          ? error
          : new AppError('PROCESSING_FAILED', 'The media job could not be completed.', 422);
      if (error instanceof AppError && error.diagnostic && typeof error.diagnostic === 'object') {
        console.error('Media job diagnostic:', JSON.stringify({
          platform: error.diagnostic.platform || job.provider.name,
          stage: error.diagnostic.stage || job.stage,
          failureSource: error.diagnostic.failureSource || 'unknown',
          httpStatus: Number.isInteger(error.diagnostic.httpStatus) ? error.diagnostic.httpStatus : null,
          exitCode: Number.isInteger(error.diagnostic.exitCode) ? error.diagnostic.exitCode : null,
          errorCode: error.code,
          stderrExcerpt: error.diagnostic.stderrExcerpt || null,
          proxyEvents: Array.isArray(error.diagnostic.proxyEvents) ? error.diagnostic.proxyEvents : []
        }));
      } else if (error instanceof AppError && error.diagnostic) {
        console.error(`Media process failed (${error.code}):`, error.diagnostic);
      } else if (!(error instanceof AppError)) {
        console.error('Job failed:', error);
      }
      for (const output of Object.values(job.outputs)) {
        if (['queued', 'processing'].includes(output.status)) failOutput(output, failure);
      }
      finalizeJob(job);
    }
  } finally {
    clearTimeout(timeout);
    if (acquiredPath) {
      await require('node:fs/promises').rm(acquiredPath, { force: true }).catch((error) => {
        console.error('Failed to clean up acquired source:', error.message);
      });
    }
    if (job.status === 'cancelled' || job.status === 'failed') {
      await fileStorage.removeJobDirectory(job.directory).catch((cleanupError) => {
        console.error('Failed to clean up job directory:', cleanupError.message);
      });
    }
    job.controller = null;
    job.processingDependencies = null;
  }
}

async function processOutput(job, format, input, duration, sourceInfo, mediaTools, fileStorage) {
  const outputState = job.outputs[format];
  if (format === 'mp3' && !sourceInfo.hasAudio) {
    failOutput(outputState, new AppError('NO_AUDIO', 'This source has no audio stream to extract.', 422));
    return;
  }
  if (format === 'mp4' && !sourceInfo.hasVideo) {
    failOutput(outputState, new AppError('NO_VIDEO', 'This source has no video stream to create an MP4.', 422));
    return;
  }
  const output = fileStorage.outputPath(job.directory, format);
  outputState.status = 'processing';
  outputState.stage = 'processing';
  outputState.progress = 0;
  try {
    await mediaTools.trim({
      input,
      output,
      startTime: job.startTime,
      endTime: job.endTime,
      format,
      sourceInfo,
      signal: job.controller.signal,
      quality: format === 'mp4' ? job.quality : undefined,
      audioQuality: format === 'mp3' ? job.audioQuality : undefined,
      resizePreset: format === 'mp4' ? job.resizePreset : undefined,
      resizeMode: format === 'mp4' ? job.resizeMode : undefined,
      onProgress: (progress) => {
        if (job.status === 'cancelled') return;
        outputState.progress = Math.max(0, Math.min(99, Math.floor(progress)));
        const processingProgress = OUTPUT_FORMATS.reduce((total, outputFormat) => (
          total + (job.outputs[outputFormat].status === 'completed' ? 100 : job.outputs[outputFormat].progress)
        ), 0) / OUTPUT_FORMATS.length;
        job.progress = 60 + Math.floor(processingProgress * 0.39);
      }
    });
    if (job.controller.signal.aborted) {
      throw new AppError('JOB_CANCELLED', 'The job was cancelled.', 409);
    }
    outputState.stage = 'validating_output';
    await fileStorage.ensureFile(output, config.maxOutputBytes);
    const actualInfo = await mediaTools.validateOutput(
      output,
      format,
      duration,
      job.controller.signal,
      sourceInfo,
      format === 'mp4' ? job.quality : undefined,
      format === 'mp4' ? { preset: job.resizePreset, mode: job.resizeMode } : undefined,
      format === 'mp3' ? job.audioQuality : undefined
    );
    if (job.status === 'cancelled') return;
    outputState.status = 'completed';
    outputState.stage = 'completed';
    outputState.progress = 100;
    outputState.error = null;
    outputState.resolution = format === 'mp4' && actualInfo.width && actualInfo.height
      ? { width: actualInfo.width, height: actualInfo.height }
      : null;
    outputState.audioBitrate = format === 'mp3' ? actualInfo.audioBitrate : null;
    outputState.expiresAt = Date.now() + config.fileRetentionMs;
  } catch (error) {
    if (job.status === 'cancelled') {
      outputState.status = 'cancelled';
      outputState.stage = 'cancelled';
      return;
    }
    const failure = job.timedOut
      ? new AppError('JOB_TIMEOUT', 'The job exceeded its time limit.', 504)
      : error instanceof AppError
        ? error
        : new AppError('PROCESSING_FAILED', 'This output could not be generated.', 422);
    failOutput(outputState, failure);
    await require('node:fs/promises').rm(output, { force: true }).catch((cleanupError) => {
      console.error(`Failed to clean up ${format.toUpperCase()} output:`, cleanupError.message);
    });
  }
}

function failOutput(output, error) {
  output.status = 'failed';
  output.stage = 'failed';
  output.error = { code: error.code || 'PROCESSING_FAILED', message: error.message };
}

function finalizeJob(job) {
  if (job.status === 'cancelled') return;
  const outputs = Object.values(job.outputs);
  const active = outputs.some((output) => ['queued', 'processing'].includes(output.status));
  if (active) {
    job.status = 'processing';
    return;
  }
  const completed = outputs.filter((output) => output.status === 'completed');
  if (completed.length) {
    job.status = 'completed';
    job.stage = 'completed';
    job.progress = 100;
    job.error = null;
    job.expiresAt = Math.max(...completed.map((output) => output.expiresAt));
    return;
  }
  const expired = outputs.some((output) => output.status === 'expired');
  job.status = expired ? 'expired' : 'failed';
  job.stage = job.status;
  job.error = job.status === 'failed'
    ? { code: 'OUTPUTS_FAILED', message: 'Neither output could be generated.' }
    : null;
  job.expiresAt = job.expiresAt || Date.now();
}

function get(id) {
  const job = jobs.get(id);
  if (!job) throw new AppError('JOB_NOT_FOUND', 'This job does not exist or has expired.', 404);
  refreshExpiration(job);
  return job;
}

function refreshExpiration(job, now = Date.now()) {
  for (const output of Object.values(job.outputs || {})) {
    if (output.status === 'completed' && output.expiresAt <= now) {
      output.status = 'expired';
      output.stage = 'expired';
    }
  }
  const outputs = Object.values(job.outputs || {});
  const hasAvailableOutput = outputs.some((output) => output.status === 'completed');
  const hasActiveOutput = outputs.some((output) => ['queued', 'processing'].includes(output.status));
  if (!hasAvailableOutput && !hasActiveOutput && outputs.some((output) => output.status === 'expired')) {
    job.expired = true;
    job.status = 'expired';
    job.stage = 'expired';
    if (!job.cleanupPromise) {
      job.cleanupPromise = storage.removeJobDirectory(job.directory).catch((error) => {
        console.error('Failed to expire job files:', error.message);
      });
    }
  }
}

function getStatus(id) {
  return publicJob(get(id));
}

async function cancel(id) {
  const job = get(id);
  if (['completed', 'failed', 'expired', 'cancelled'].includes(job.status)) {
    throw new AppError('JOB_NOT_CANCELLABLE', `A ${job.status} job cannot be cancelled.`, 409);
  }
  const wasQueued = job.status === 'queued';
  job.status = 'cancelled';
  job.stage = 'cancelled';
  job.error = { code: 'JOB_CANCELLED', message: 'The job was cancelled.' };
  for (const output of Object.values(job.outputs || {})) {
    if (!['failed', 'expired'].includes(output.status)) {
      output.status = 'cancelled';
      output.stage = 'cancelled';
      output.error = { code: 'JOB_CANCELLED', message: 'The job was cancelled.' };
    }
  }
  job.controller?.abort();
  if (wasQueued) {
    const queuedIndex = queue.indexOf(job);
    if (queuedIndex !== -1) queue.splice(queuedIndex, 1);
    await storage.removeJobDirectory(job.directory);
  }
  return publicJob(job);
}

async function getFile(id, format) {
  const job = get(id);
  const outputFormat = format || job.format;
  if (!OUTPUT_FORMATS.includes(outputFormat)) throw new AppError('INVALID_FORMAT', 'Choose MP4 or MP3.');
  const output = job.outputs?.[outputFormat];
  if (!output || output.status === 'expired' || job.status === 'expired') {
    throw new AppError('OUTPUT_EXPIRED', 'This download has expired.', 410);
  }
  if (output.status !== 'completed' || output.expiresAt <= Date.now()) {
    if (output.expiresAt && output.expiresAt <= Date.now()) {
      refreshExpiration(job);
      throw new AppError('OUTPUT_EXPIRED', 'This download has expired.', 410);
    }
    throw new AppError('JOB_NOT_READY', 'This output is not ready yet.', 409);
  }
  const path = storage.outputPath(job.directory, outputFormat);
  await storage.ensureFile(path, config.maxOutputBytes);
  return { path, name: storage.safeDownloadName(job.title, outputFormat), format: outputFormat };
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    refreshExpiration(job, now);
    if (job.status === 'expired' && job.expiresAt + config.fileRetentionMs <= now) {
      jobs.delete(id);
      continue;
    }
    if (['failed', 'cancelled'].includes(job.status) && job.createdAt + config.fileRetentionMs * 2 <= now) {
      jobs.delete(id);
    }
  }
}, Math.min(config.fileRetentionMs, 60000)).unref();

module.exports = { create, getStatus, getFile, cancel, processJob };
