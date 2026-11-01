const unavailable = require('./unavailable');

module.exports = unavailable(
  'Vimeo',
  (raw) => {
    try {
      const url = new URL(raw);
      return ['vimeo.com', 'www.vimeo.com', 'player.vimeo.com'].includes(url.hostname.toLowerCase())
        && /\/(?:video\/)?\d+/.test(url.pathname);
    } catch { return false; }
  },
  'an authorized Vimeo integration and appropriate permissions are required.'
);
