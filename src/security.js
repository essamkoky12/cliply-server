const dns = require('node:dns').promises;
const ipaddr = require('ipaddr.js');

class AppError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.status = status;
  }
}

function validateHttpUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('INVALID_URL', 'Enter a valid HTTP or HTTPS URL.');
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new AppError('INVALID_URL', 'Only credential-free HTTP and HTTPS URLs are supported.');
  }
  if (!url.hostname || url.hostname.endsWith('.')) {
    throw new AppError('INVALID_URL', 'The URL host is invalid.');
  }
  return url;
}

function isPublicAddress(address) {
  try {
    const parsed = ipaddr.parse(address);
    return parsed.range() === 'unicast';
  } catch {
    return false;
  }
}

async function resolvePublicAddresses(hostname) {
  const normalized = hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(normalized)) {
    if (!isPublicAddress(normalized)) {
      throw new AppError('URL_BLOCKED', 'Private or reserved network addresses are not allowed.', 403);
    }
    return [{ address: normalized, family: ipaddr.parse(normalized).kind() === 'ipv4' ? 4 : 6 }];
  }

  let records;
  try {
    records = await dns.lookup(normalized, { all: true, verbatim: true });
  } catch {
    throw new AppError('URL_UNREACHABLE', 'The URL host could not be resolved.', 422);
  }
  if (records.length === 0 || records.some(({ address }) => !isPublicAddress(address))) {
    throw new AppError('URL_BLOCKED', 'The URL resolves to a private or reserved network address.', 403);
  }
  return records;
}

async function validateExternalUrl(raw, resolver = resolvePublicAddresses) {
  const url = validateHttpUrl(raw);
  await resolver(url.hostname);
  return url;
}

module.exports = {
  AppError,
  isPublicAddress,
  resolvePublicAddresses,
  validateExternalUrl,
  validateHttpUrl
};
