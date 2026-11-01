const unavailable = require('./unavailable');

module.exports = unavailable(
  'X',
  (raw) => {
    try {
      const url = new URL(raw);
      return ['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com'].includes(url.hostname.toLowerCase())
        && /\/status\/\d+/.test(url.pathname);
    } catch { return false; }
  },
  'an authorized X integration and appropriate permissions are required.'
);
