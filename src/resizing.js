const { AppError } = require('./security');
const { validateQuality, qualityBounds } = require('./quality');

const RESIZE_PRESETS = Object.freeze({
  original: null,
  portrait: Object.freeze({ width: 1080, height: 1920 }),
  landscape: Object.freeze({ width: 1920, height: 1080 }),
  square: Object.freeze({ width: 1080, height: 1080 }),
  feed: Object.freeze({ width: 1080, height: 1350 })
});

const RESIZE_MODES = Object.freeze(['fit', 'fill', 'stretch']);

function validateResize(presetValue, modeValue) {
  const preset = presetValue === undefined ? 'original' : presetValue;
  const mode = modeValue === undefined ? 'fit' : modeValue;
  if (!Object.hasOwn(RESIZE_PRESETS, preset)) {
    throw new AppError('INVALID_RESIZE_PRESET', 'Choose Original, Portrait, Landscape, Square, or Portrait Feed.');
  }
  if (!RESIZE_MODES.includes(mode)) {
    throw new AppError('INVALID_RESIZE_MODE', 'Choose Fit, Fill, or Stretch resizing.');
  }
  return { preset, mode };
}

function effectiveResizeDimensions(preset, quality) {
  const target = RESIZE_PRESETS[preset];
  if (!target) return null;
  const bounds = qualityBounds(quality, target.height > target.width);
  if (!bounds) return target;
  const scale = Math.min(1, bounds.width / target.width, bounds.height / target.height);
  return {
    width: Math.max(2, Math.round((target.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((target.height * scale) / 2) * 2)
  };
}

function expectedOriginalDimensions(sourceInfo, quality) {
  const bounds = qualityBounds(quality, sourceInfo.height > sourceInfo.width);
  if (!bounds) {
    return {
      width: sourceInfo.width + (sourceInfo.width % 2),
      height: sourceInfo.height + (sourceInfo.height % 2)
    };
  }
  const scale = Math.min(1, bounds.width / sourceInfo.width, bounds.height / sourceInfo.height);
  return {
    width: Math.max(2, Math.round((sourceInfo.width * scale) / 2) * 2),
    height: Math.max(2, Math.round((sourceInfo.height * scale) / 2) * 2)
  };
}

function resizeFilter(preset, mode, sourceInfo, qualityDimensions, targetDimensions) {
  const target = targetDimensions || RESIZE_PRESETS[preset];
  const filters = [];
  if (preset === 'original') {
    if (qualityDimensions) {
      filters.push(
        `scale=w='min(iw,${qualityDimensions.width})':h='min(ih,${qualityDimensions.height})':force_original_aspect_ratio=decrease:force_divisible_by=2`
      );
    } else if (sourceInfo.width % 2 !== 0 || sourceInfo.height % 2 !== 0) {
      filters.push('pad=ceil(iw/2)*2:ceil(ih/2)*2:0:0:color=black');
    }
    return filters;
  }
  if (mode === 'fit') {
    filters.push(
      `scale=w='min(iw,${target.width})':h='min(ih,${target.height})':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2:color=black`
    );
  } else if (mode === 'fill') {
    filters.push(
      `scale=${target.width}:${target.height}:force_original_aspect_ratio=increase:force_divisible_by=2`,
      `crop=${target.width}:${target.height}`
    );
  } else {
    filters.push(`scale=${target.width}:${target.height}`);
  }
  return filters;
}

module.exports = {
  RESIZE_PRESETS,
  RESIZE_MODES,
  validateResize,
  effectiveResizeDimensions,
  expectedOriginalDimensions,
  resizeFilter
};
