const youtube = require('./youtube');
const instagram = require('./instagram');
const tiktok = require('./tiktok');
const facebook = require('./facebook');
const x = require('./x');
const vimeo = require('./vimeo');
const direct = require('./direct');
const ytDlp = require('./yt-dlp');
const { AppError, validateHttpUrl } = require('../security');

const platforms = [youtube, instagram, tiktok, facebook, x, vimeo];

function resolvePlatform(raw) {
  return platforms.find((provider) => provider.matches(raw)) || null;
}

function directCapabilities() {
  const dependencies = ytDlp.getDependencyStatus();
  const available = dependencies.ffmpeg.available
    && dependencies.ffprobe.available
    && dependencies.ffmpeg.encoders.libx264
    && dependencies.ffmpeg.encoders.libmp3lame;
  return {
    ...direct.capabilities,
    acquire: available,
    formats: available ? direct.capabilities.formats : [],
    reason: available ? null : 'FFmpeg with H.264/MP3 encoders and ffprobe must be available.'
  };
}

function createDirectProvider() {
  return {
    ...direct,
    capabilities: directCapabilities(),
    async getInfo(raw) {
      const info = await direct.getInfo(raw);
      const capabilities = directCapabilities();
      const formats = info.capabilities.formats.filter((format) => capabilities.formats.includes(format));
      return {
        ...info,
        capabilities: {
          ...info.capabilities,
          acquire: capabilities.acquire && formats.length > 0,
          formats,
          reason: formats.length ? null : capabilities.reason || info.capabilities.reason
        }
      };
    }
  };
}

async function resolve(raw) {
  validateHttpUrl(raw);
  const platform = resolvePlatform(raw);
  if (platform) return ytDlp.createProvider(platform);
  await direct.probe(raw);
  return createDirectProvider();
}

async function getInfo(raw) {
  const provider = await resolve(raw);
  return provider.getInfo(raw);
}

async function getPlaylistInfo(raw) {
  validateHttpUrl(raw);
  const platform = resolvePlatform(raw);
  if (!platform) {
    throw new AppError('UNSUPPORTED_PROVIDER', 'Playlist metadata is available only for supported providers.', 415);
  }
  if (platform.name !== 'youtube') {
    throw new AppError('UNSUPPORTED_CAPABILITY', `${platform.name} playlist lookup is not available.`, 501);
  }
  return ytDlp.getPlaylistInfo(raw);
}

function capabilities() {
  return [...platforms.map(({ name }) => ({
    provider: name,
    ...ytDlp.capabilitiesFor(name)
  })), {
    provider: direct.name,
    ...directCapabilities()
  }];
}

module.exports = {
  initialize: ytDlp.initialize,
  getDependencyStatus: ytDlp.getDependencyStatus,
  resolve,
  resolvePlatform,
  getInfo,
  getPlaylistInfo,
  capabilities
};
