const { AppError } = require('../security');

function createUnavailableProvider(name, match, requirement) {
  const reason = `${name} media access is not integrated; ${requirement}`;
  return {
    name,
    matches: match,
    capabilities: {
      metadata: false,
      playlist: false,
      acquire: false,
      formats: [],
      authorizationRequired: true,
      reason
    },
    async getInfo() {
      throw new AppError('INTEGRATION_REQUIRED', reason, 503);
    },
    async acquire() {
      throw new AppError('INTEGRATION_REQUIRED', reason, 503);
    }
  };
}

module.exports = createUnavailableProvider;
