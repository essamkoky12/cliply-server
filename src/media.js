const { spawn } = require('node:child_process');
const config = require('./config');
const { AppError } = require('./security');
const { validateQuality, qualityBounds, isWithinQuality } = require('./quality');
const {
  validateResize, effectiveResizeDimensions, expectedOriginalDimensions, resizeFilter
} = require('./resizing');

const ffmpegPath = config.ffmpegPath;
const ffprobePath = config.ffprobePath;
const AUDIO_BITRATES = Object.freeze([128, 192, 256, 320]);

function validateAudioBitrate(value) {
  const bitrate = value === undefined ? 192 : value;
  if (!AUDIO_BITRATES.includes(bitrate)) {
    throw new AppError('INVALID_AUDIO_QUALITY', 'Choose an MP3 bitrate of 128, 192, 256, or 320 kbps.');
  }
  return bitrate;
}

function runProcess(command, args, { timeoutMs = config.jobTimeoutMs, signal, onProgress, progressDuration } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      reject(new AppError('MEDIA_TOOL_UNAVAILABLE', 'FFmpeg or ffprobe could not be started.', 503));
      return;
    }
    let stderr = '';
    let stdout = '';
    let settled = false;
    let terminationError = null;
    function terminate(error) {
      if (settled || terminationError) return;
      terminationError = error;
      child.kill('SIGKILL');
      if (child.exitCode !== null) finish(error);
    }
    const timer = setTimeout(() => {
      terminate(new AppError('PROCESS_TIMEOUT', 'Media processing exceeded its time limit.', 504));
    }, timeoutMs);
    timer.unref();
    const onAbort = () => {
      terminate(new AppError('JOB_CANCELLED', 'The job was cancelled.', 409));
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    function finish(error, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(result);
    }

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (onProgress) {
        const lines = `${stdout}${text}`.split(/\r?\n/);
        stdout = lines.pop() || '';
        for (const line of lines) {
          const [key, value] = line.split('=');
          if (key === 'out_time_ms' && progressDuration > 0) {
            const seconds = Number(value) / 1000000;
            onProgress(Math.max(0, Math.min(99, Math.floor((seconds / progressDuration) * 100))));
          }
        }
      } else {
        stdout += text;
        if (stdout.length > 2 * 1024 * 1024) child.kill('SIGKILL');
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-12000);
    });
    child.on('error', () => finish(terminationError || new AppError('MEDIA_TOOL_UNAVAILABLE', 'FFmpeg or ffprobe could not be started.', 503)));
    child.on('close', (code) => {
      if (terminationError) {
        finish(terminationError);
        return;
      }
      if (code !== 0) {
        const error = new AppError(
          'PROCESSING_FAILED',
          'Media processing failed. Check the source file and selected range.',
          422
        );
        error.diagnostic = stderr;
        finish(error);
        return;
      }
      finish(null, { stdout, stderr });
    });
  });
}

async function inspect(filePath, options = {}) {
  let stdout;
  try {
    ({ stdout } = await runProcess(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration:format_tags=title:stream=index,codec_type,codec_name,duration,width,height,bit_rate:stream_side_data=rotation',
      '-of', 'json',
      filePath
    ], options));
  } catch (error) {
    if (error instanceof AppError && error.code === 'PROCESSING_FAILED') {
      throw new AppError('INVALID_SOURCE', 'The source is corrupt or is not a supported media file.', 422);
    }
    throw error;
  }
  let probe;
  try {
    probe = JSON.parse(stdout);
  } catch {
    throw new AppError('INVALID_SOURCE', 'The source is corrupt or is not a supported media file.', 422);
  }
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStream = streams.find((stream) => stream.codec_type === 'video');
  const audioStream = streams.find((stream) => stream.codec_type === 'audio');
  const rawRotation = Number(videoStream?.side_data_list?.find((entry) => entry.rotation !== undefined)?.rotation);
  const rotation = Number.isFinite(rawRotation) ? ((rawRotation % 360) + 360) % 360 : 0;
  const swapsDimensions = rotation === 90 || rotation === 270;
  const durationValues = [
    Number(probe.format?.duration),
    ...streams.map((stream) => Number(stream.duration))
  ].filter((value) => Number.isFinite(value) && value > 0);
  const duration = durationValues.length ? Math.max(...durationValues) : 0;
  if (!duration || !streams.length) {
    throw new AppError('INVALID_SOURCE', 'The source has no readable media streams or duration.', 422);
  }
  return {
    duration,
    title: typeof probe.format?.tags?.title === 'string' ? probe.format.tags.title : null,
    hasVideo: streams.some((stream) => stream.codec_type === 'video'),
    hasAudio: streams.some((stream) => stream.codec_type === 'audio'),
    width: Number.isSafeInteger(videoStream?.width)
      ? swapsDimensions ? videoStream.height : videoStream.width
      : null,
    height: Number.isSafeInteger(videoStream?.height)
      ? swapsDimensions ? videoStream.width : videoStream.height
      : null,
    audioBitrate: Number.isFinite(Number(audioStream?.bit_rate)) && Number(audioStream.bit_rate) > 0
      ? Math.round(Number(audioStream.bit_rate) / 1000)
      : null,
    streams: streams.map(({ codec_type, codec_name }) => ({ type: codec_type, codec: codec_name }))
  };
}

function validateRange(startTime, endTime, mediaDuration, minimum = config.minSegmentSeconds) {
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 || endTime <= startTime) {
    throw new AppError('INVALID_RANGE', 'Start and end times must be finite, nonnegative, and in order.');
  }
  if (endTime > mediaDuration) {
    throw new AppError('INVALID_RANGE', 'The selected end time exceeds the verified media duration.');
  }
  if (endTime - startTime < minimum) {
    throw new AppError('INVALID_RANGE', `Select a segment of at least ${minimum} seconds.`);
  }
  return endTime - startTime;
}

async function trim({
  input, output, startTime, endTime, format, sourceInfo, signal, onProgress,
  quality = '720p', resizePreset = 'original', resizeMode = 'fit', audioQuality = 192
}) {
  const duration = validateRange(startTime, endTime, sourceInfo.duration);
  if (format === 'mp3' && !sourceInfo.hasAudio) {
    throw new AppError('NO_AUDIO', 'This source has no audio stream to extract.', 422);
  }
  if (format === 'mp4' && !sourceInfo.hasVideo) {
    throw new AppError('NO_VIDEO', 'This source has no video stream to create an MP4.', 422);
  }
  if (!['mp4', 'mp3'].includes(format)) throw new AppError('INVALID_FORMAT', 'Choose MP4 or MP3.');

  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(startTime), '-i', input, '-t', String(duration)];
  if (format === 'mp4') {
    const resizing = validateResize(resizePreset, resizeMode);
    const selectedQuality = validateQuality(quality);
    const qualityDimensions = qualityBounds(selectedQuality, sourceInfo.height > sourceInfo.width);
    const targetDimensions = effectiveResizeDimensions(resizing.preset, selectedQuality);
    const filters = resizeFilter(
      resizing.preset,
      resizing.mode,
      sourceInfo,
      resizing.preset === 'original' ? qualityDimensions : null,
      targetDimensions
    );
    if (filters.length) args.push('-vf', filters.join(','));
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    if (sourceInfo.hasAudio) args.push('-c:a', 'aac');
    args.push('-movflags', '+faststart', '-fs', String(config.maxOutputBytes), '-progress', 'pipe:1', '-nostats', output);
  } else {
    const bitrate = validateAudioBitrate(audioQuality);
    args.push('-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', `${bitrate}k`, '-fs', String(config.maxOutputBytes), '-progress', 'pipe:1', '-nostats', output);
  }
  await runProcess(ffmpegPath, args, { signal, onProgress, progressDuration: duration });
}

async function validateOutput(filePath, format, expectedDuration, signal, expectedSourceInfo, quality, resizing, audioQuality) {
  const result = await inspect(filePath, { signal });
  if (format === 'mp4' && !result.hasVideo) throw new AppError('OUTPUT_INVALID', 'The generated MP4 contains no video stream.', 500);
  if (format === 'mp4' && (!Number.isSafeInteger(result.width) || result.width <= 0 || !Number.isSafeInteger(result.height) || result.height <= 0)) {
    throw new AppError('OUTPUT_INVALID', 'The generated MP4 dimensions could not be verified.', 500);
  }
  if (format === 'mp4' && expectedSourceInfo?.hasAudio && !result.hasAudio) {
    throw new AppError('OUTPUT_INVALID', 'The generated MP4 is missing the source audio stream.', 500);
  }
  if (format === 'mp3' && !result.hasAudio) throw new AppError('OUTPUT_INVALID', 'The generated MP3 contains no audio stream.', 500);
  if (format === 'mp3' && audioQuality !== undefined) {
    const bitrate = validateAudioBitrate(audioQuality);
    if (result.audioBitrate !== bitrate) {
      throw new AppError('OUTPUT_INVALID', 'The generated MP3 bitrate does not match the selected audio quality.', 500);
    }
  }
  if (format === 'mp4' && quality !== undefined) {
    if (!isWithinQuality(quality, result.width, result.height)) {
      throw new AppError('OUTPUT_INVALID', 'The generated MP4 exceeds the selected maximum resolution.', 500);
    }
  }
  if (format === 'mp4' && resizing) {
    const { preset } = validateResize(resizing.preset, resizing.mode);
    const dimensions = preset === 'original'
      ? expectedOriginalDimensions(expectedSourceInfo, quality || '720p')
      : effectiveResizeDimensions(preset, quality || '720p');
    const matchesPreset = result.width === dimensions.width && result.height === dimensions.height;
    if (!matchesPreset) {
      throw new AppError('OUTPUT_INVALID', 'The generated MP4 dimensions do not match the selected resize preset.', 500);
    }
  }
  if (Math.abs(result.duration - expectedDuration) > Math.max(1.25, expectedDuration * 0.04)) {
    throw new AppError('OUTPUT_INVALID', 'The generated file duration does not match the selected range.', 500);
  }
  return result;
}

module.exports = { inspect, validateRange, trim, validateOutput, validateAudioBitrate };
