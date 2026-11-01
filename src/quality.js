const { AppError } = require('./security');

const QUALITY_PRESETS = Object.freeze({
  '360p': Object.freeze({ width: 640, height: 360 }),
  '480p': Object.freeze({ width: 854, height: 480 }),
  '720p': Object.freeze({ width: 1280, height: 720 }),
  '1080p': Object.freeze({ width: 1920, height: 1080 }),
  best: null
});

function validateQuality(value) {
  const quality = value === undefined ? '720p' : value;
  if (!Object.hasOwn(QUALITY_PRESETS, quality)) {
    throw new AppError('INVALID_QUALITY', 'Choose 360p, 480p, 720p, 1080p, or Best Available.');
  }
  return quality;
}

function qualityBounds(quality, portrait = false) {
  const dimensions = QUALITY_PRESETS[validateQuality(quality)];
  if (!dimensions || !portrait) return dimensions;
  return { width: dimensions.height, height: dimensions.width };
}

function isWithinQuality(quality, width, height) {
  const dimensions = QUALITY_PRESETS[validateQuality(quality)];
  if (!dimensions) return true;
  return (width <= dimensions.width && height <= dimensions.height)
    || (width <= dimensions.height && height <= dimensions.width);
}

function ytDlpFormatSelector(quality) {
  if (quality === 'best') {
    return 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best';
  }
  const height = QUALITY_PRESETS[quality].height;
  return `bestvideo[height<=${height}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${height}][ext=mp4]/bestvideo[height<=${height}]+bestaudio/best[height<=${height}]`;
}

module.exports = {
  QUALITY_PRESETS,
  validateQuality,
  qualityBounds,
  isWithinQuality,
  ytDlpFormatSelector
};
