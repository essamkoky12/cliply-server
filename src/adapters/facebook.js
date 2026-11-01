const unavailable = require('./unavailable');

module.exports = unavailable(
  'Facebook',
  (raw) => {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      return ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.watch'].includes(host)
        && (host === 'fb.watch' || /\/(?:watch|reel|videos)\/?/.test(url.pathname));
    } catch { return false; }
  },
  'an authorized Meta integration and appropriate permissions are required.'
);
