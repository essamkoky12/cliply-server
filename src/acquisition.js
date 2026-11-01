const path = require('node:path');
const { AppError } = require('./security');

async function acquireMedia(provider, url, jobDirectory, options = {}) {
  if (!provider.capabilities.acquire || typeof provider.acquire !== 'function') {
    throw new AppError(
      'ACQUISITION_UNAVAILABLE',
      provider.capabilities.reason || `${provider.name} does not provide permitted media acquisition.`,
      501
    );
  }
  const destination = path.join(jobDirectory, 'source.media');
  const result = await provider.acquire(url, destination, options);
  return { path: destination, ...result };
}

module.exports = { acquireMedia };
