const unavailable = require('./unavailable');

module.exports = unavailable(
  'TikTok',
  (raw) => {
    try {
      const url = new URL(raw);
      const host = url.hostname.toLowerCase();
      return ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'].includes(host)
        && (/\/video\/\d+/.test(url.pathname) || ['vm.tiktok.com', 'vt.tiktok.com'].includes(host));
    } catch { return false; }
  },
  'a supported, authorized TikTok integration is required.'
);
