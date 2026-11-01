const unavailable = require('./unavailable');

module.exports = unavailable(
  'Instagram',
  (raw) => {
    try {
      const url = new URL(raw);
      return ['instagram.com', 'www.instagram.com'].includes(url.hostname.toLowerCase())
        && /^\/(?:reel|reels|p|tv)\/[^/]+/.test(url.pathname);
    } catch { return false; }
  },
  'an authorized Instagram integration and account access are required.'
);
