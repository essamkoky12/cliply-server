const config = require('../config');
const { AppError } = require('../security');

const VIDEO_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be', 'www.youtube-nocookie.com']);
const API_BASE = 'https://www.googleapis.com/youtube/v3';

function match(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (!VIDEO_HOSTS.has(host)) return null;
  const id = host === 'youtu.be'
    ? url.pathname.split('/').filter(Boolean)[0]
    : url.pathname.match(/^\/(?:watch|shorts|embed|live)\/?$/)
      ? url.searchParams.get('v')
      : url.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/)?.[1];
  const playlistId = url.searchParams.get('list');
  if (id && /^[\w-]{11}$/.test(id)) return { type: 'video', id, playlistId };
  if (playlistId && /^[\w-]{10,100}$/.test(playlistId)) return { type: 'playlist', playlistId };
  return null;
}

function parseDuration(value) {
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(value || '');
  if (!match) return null;
  return Number(match[1] || 0) * 3600 + Number(match[2] || 0) * 60 + Number(match[3] || 0);
}

function requireApiKey() {
  if (!config.youtubeApiKey) {
    throw new AppError('AUTH_REQUIRED', 'YouTube metadata requires a configured YouTube Data API key.', 503);
  }
}

async function apiRequest(resource, params) {
  requireApiKey();
  const url = new URL(`${API_BASE}/${resource}`);
  for (const [key, value] of Object.entries({ ...params, key: config.youtubeApiKey })) {
    url.searchParams.set(key, value);
  }
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  } catch {
    throw new AppError('METADATA_UNAVAILABLE', 'YouTube metadata could not be reached.', 502);
  }
  if (!response.ok) {
    if ([401, 403].includes(response.status)) {
      throw new AppError('AUTH_REQUIRED', 'YouTube Data API access is unavailable or the API key is invalid.', 503);
    }
    if (response.status === 404) throw new AppError('METADATA_UNAVAILABLE', 'YouTube metadata was not found.', 404);
    throw new AppError('METADATA_UNAVAILABLE', 'YouTube metadata could not be retrieved.', 502);
  }
  try {
    return await response.json();
  } catch {
    throw new AppError('METADATA_UNAVAILABLE', 'YouTube returned an invalid metadata response.', 502);
  }
}

function normalizeVideo(video) {
  if (!video?.id || !video.snippet || !video.contentDetails) {
    throw new AppError('METADATA_UNAVAILABLE', 'YouTube did not return complete video metadata.', 404);
  }
  const thumbnails = video.snippet.thumbnails || {};
  const thumbnail = thumbnails.maxres || thumbnails.standard || thumbnails.high || thumbnails.medium || thumbnails.default;
  return {
    id: video.id,
    title: video.snippet.title,
    description: video.snippet.description || '',
    thumbnail: thumbnail?.url || null,
    provider: 'youtube',
    duration: parseDuration(video.contentDetails.duration),
    sourceUrl: `https://www.youtube.com/watch?v=${video.id}`,
    capabilities: {
      metadata: true,
      playlist: true,
      acquire: false,
      formats: [],
      reason: 'The official YouTube Data API provides metadata but does not permit downloading arbitrary video files.'
    }
  };
}

async function getInfo(raw) {
  const matched = match(raw);
  if (!matched) throw new AppError('INVALID_URL', 'This is not a supported YouTube video URL.');
  if (matched.type !== 'video') {
    throw new AppError('PLAYLIST_URL', 'This URL identifies a playlist. Use the playlist information endpoint.', 400);
  }
  const payload = await apiRequest('videos', { part: 'snippet,contentDetails', id: matched.id });
  if (!payload.items?.length) throw new AppError('METADATA_UNAVAILABLE', 'The video is unavailable or its metadata is private.', 404);
  return normalizeVideo(payload.items[0]);
}

async function getPlaylistInfo(raw) {
  const matched = match(raw);
  if (!matched?.playlistId) throw new AppError('INVALID_URL', 'This URL does not contain a supported YouTube playlist.');
  const [playlist, items] = await Promise.all([
    apiRequest('playlists', { part: 'snippet,contentDetails', id: matched.playlistId }),
    apiRequest('playlistItems', { part: 'snippet,contentDetails', playlistId: matched.playlistId, maxResults: '50' })
  ]);
  if (!playlist.items?.length) throw new AppError('METADATA_UNAVAILABLE', 'The playlist is unavailable or private.', 404);
  const record = playlist.items[0];
  return {
    id: record.id,
    title: record.snippet.title,
    itemCount: record.contentDetails.itemCount,
    items: (items.items || [])
      .map((item) => ({
        id: item.contentDetails.videoId || item.snippet.resourceId?.videoId,
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails?.medium?.url || item.snippet.thumbnails?.default?.url || null
      }))
      .filter((item) => item.id),
    nextPageToken: items.nextPageToken || null,
    provider: 'youtube',
    capabilities: { metadata: true, acquire: false }
  };
}

module.exports = {
  name: 'youtube',
  matches: match,
  getInfo,
  getPlaylistInfo,
  normalizeVideo,
  parseDuration,
  capabilities: {
    metadata: Boolean(config.youtubeApiKey),
    playlist: Boolean(config.youtubeApiKey),
    acquire: false,
    formats: [],
    authorizationRequired: true,
    reason: 'Set YOUTUBE_API_KEY for official metadata lookups. The official API does not provide arbitrary video downloads.'
  }
};
