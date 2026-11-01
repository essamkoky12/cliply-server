const assert = require('node:assert/strict');
const { after, before, test } = require('node:test');
const { app } = require('../src/index');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

async function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

test('health and provider capability endpoints return actual capabilities', async () => {
  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const response = await fetch(`${baseUrl}/api/providers`);
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.providers.find((provider) => provider.provider === 'youtube').acquire, false);
  assert.equal(result.providers.find((provider) => provider.provider === 'direct').acquire, false);
});

test('API distinguishes invalid URLs, blocked destinations, and missing integrations', async () => {
  const invalid = await post('/api/video/info', { url: 'ftp://example.com/video.mp4' });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, 'INVALID_URL');

  const blocked = await post('/api/video/info', { url: 'http://127.0.0.1/video.mp4' });
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json()).error.code, 'URL_BLOCKED');

  const unsupported = await post('/api/video/info', { url: 'https://www.instagram.com/reel/C0ffee123/' });
  assert.equal(unsupported.status, 503);
  assert.equal((await unsupported.json()).error.code, 'TOOL_UNAVAILABLE');

  const youtube = await post('/api/video/info', { url: 'https://www.youtube.com/watch?v=abcdefghijk' });
  assert.equal(youtube.status, 503);
  assert.equal((await youtube.json()).error.code, 'TOOL_UNAVAILABLE');
});

test('download requests do not create fake platform jobs', async () => {
  const response = await post('/api/video/download', {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    startTime: 0,
    endTime: 5,
    format: 'mp4'
  });
  assert.equal(response.status, 501);
  assert.equal((await response.json()).error.code, 'ACQUISITION_UNAVAILABLE');

  const invalidRange = await post('/api/video/download', {
    url: 'https://www.youtube.com/watch?v=abcdefghijk',
    startTime: 5,
    endTime: 5,
    format: 'mp4'
  });
  assert.equal(invalidRange.status, 400);
  assert.equal((await invalidRange.json()).error.code, 'INVALID_RANGE');
});
