const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { after, test } = require('node:test');
const jobs = require('../src/jobs');
const storage = require('../src/storage');

const createdJobIds = new Set();

after(async () => {
  await Promise.all([...createdJobIds].map((id) => (
    storage.removeJobDirectory(path.join(require('../src/config').storageDir, id))
      .catch(() => {})
  )));
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function createTestJob({
  trim, formats = ['mp4', 'mp3'], quality, resizePreset, resizeMode
} = {}) {
  const stats = { acquisitions: 0, acquisitionQuality: null, trims: [] };
  const provider = {
    name: 'authorized-fixture',
    capabilities: { acquire: true, formats }
  };
  const job = await jobs.create({
    url: 'https://media.example/authorized-fixture.mp4',
    startTime: 1.25,
    endTime: 4.75,
    format: 'mp4',
    quality,
    resizePreset,
    resizeMode,
    title: 'authorized fixture'
  }, {
    resolveProvider: async () => provider,
    processingDependencies: {
      acquireMedia: async (_provider, _url, directory, options) => {
        stats.acquisitions += 1;
        stats.acquisitionQuality = options.quality;
        const source = path.join(directory, 'source.media');
        await fs.writeFile(source, 'authorized source');
        return { path: source };
      },
      media: {
        inspect: async () => ({ duration: 10, hasVideo: true, hasAudio: true, width: 160, height: 120 }),
        validateRange: (_start, _end, duration) => 3.5,
        trim: async (options) => {
          stats.trims.push(options);
          if (trim) await trim(options);
          await fs.writeFile(options.output, `${options.format} output`);
          options.onProgress(50);
        },
        validateOutput: async (_file, format, _duration, _signal, sourceInfo, _selectedQuality, resizing) => {
          const targets = {
            original: [sourceInfo.width, sourceInfo.height],
            portrait: [1080, 1920],
            landscape: [1920, 1080],
            square: [1080, 1080],
            feed: [1080, 1350]
          }[resizing?.preset || 'original'];
          const qualityLimits = {
            '360p': [640, 360],
            '480p': [854, 480],
            '720p': [1280, 720],
            '1080p': [1920, 1080],
            best: [Infinity, Infinity]
          }[_selectedQuality || '720p'];
          const portrait = targets[1] > targets[0];
          const bounds = portrait ? [qualityLimits[1], qualityLimits[0]] : qualityLimits;
          const scale = Math.min(1, bounds[0] / targets[0], bounds[1] / targets[1]);
          const dimensions = targets.map((dimension) => Math.round(dimension * scale / 2) * 2);
          return {
            hasVideo: format === 'mp4',
            hasAudio: true,
            width: format === 'mp4' ? dimensions[0] : null,
            height: format === 'mp4' ? dimensions[1] : null
          };
        }
      }
    }
  });
  createdJobIds.add(job.id);
  return { job, stats };
}

async function waitForJob(id, predicate, timeoutMs = 5000) {
  for (let attempt = 0; attempt < timeoutMs / 10; attempt += 1) {
    const job = jobs.getStatus(id);
    if (predicate(job)) return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Job ${id} did not reach the expected state.`);
}

async function waitForRemoval(directory) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      await fs.access(directory);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Expected ${directory} to be removed.`);
}

test('selected MP4 quality reaches the backend acquisition pipeline', async () => {
  const { job, stats } = await createTestJob({
    quality: '480p',
    resizePreset: 'portrait',
    resizeMode: 'fit'
  });
  const completed = await waitForJob(job.id, (current) => current.status === 'completed');
  assert.equal(completed.quality, '480p');
  assert.equal(completed.resizePreset, 'portrait');
  assert.equal(completed.resizeMode, 'fit');
  assert.equal(stats.acquisitionQuality, '480p');
  const mp4Trim = stats.trims.find(({ format }) => format === 'mp4');
  assert.equal(mp4Trim.quality, '480p');
  assert.equal(mp4Trim.resizePreset, 'portrait');
  assert.equal(mp4Trim.resizeMode, 'fit');
  assert.deepEqual(completed.outputs.mp4.resolution, { width: 480, height: 854 });
});

test('one parent job acquires once and runs both trims concurrently with identical timestamps', async () => {
  const bothStarted = deferred();
  const release = deferred();
  let activeTrims = 0;
  let maximumActiveTrims = 0;
  const { job, stats } = await createTestJob({
    trim: async () => {
      activeTrims += 1;
      maximumActiveTrims = Math.max(maximumActiveTrims, activeTrims);
      if (activeTrims === 2) bothStarted.resolve();
      await release.promise;
      activeTrims -= 1;
    }
  });

  assert.deepEqual(Object.keys(job.outputs), ['mp4', 'mp3']);
  await bothStarted.promise;
  const processing = jobs.getStatus(job.id);
  assert.equal(processing.status, 'processing');
  assert.equal(stats.acquisitions, 1);
  assert.equal(stats.trims.length, 2);
  assert.deepEqual(
    stats.trims.map(({ startTime, endTime }) => [startTime, endTime]),
    [[1.25, 4.75], [1.25, 4.75]]
  );
  assert.equal(maximumActiveTrims, 2);

  release.resolve();
  const completed = await waitForJob(job.id, (current) => current.status === 'completed');
  assert.equal(completed.outputs.mp4.status, 'completed');
  assert.equal(completed.outputs.mp3.status, 'completed');
  assert.equal(completed.outputs.mp4.downloadUrl, `/api/video/jobs/${job.id}/files/mp4`);
  assert.equal(completed.outputs.mp3.downloadUrl, `/api/video/jobs/${job.id}/files/mp3`);
  assert.equal((await jobs.getFile(job.id, 'mp4')).format, 'mp4');
  assert.equal((await jobs.getFile(job.id, 'mp3')).format, 'mp3');
});

test('MP4 is downloadable while MP3 is still processing', async () => {
  const mp3Started = deferred();
  const finishMp3 = deferred();
  const { job } = await createTestJob({
    trim: async ({ format }) => {
      if (format === 'mp3') {
        mp3Started.resolve();
        await finishMp3.promise;
      }
    }
  });

  await mp3Started.promise;
  const partial = await waitForJob(job.id, (current) => current.outputs.mp4.status === 'completed');
  assert.equal(partial.status, 'processing');
  assert.equal(partial.outputs.mp3.status, 'processing');
  assert.equal((await jobs.getFile(job.id, 'mp4')).format, 'mp4');

  finishMp3.resolve();
  await waitForJob(job.id, (current) => current.status === 'completed');
});

test('MP3 is downloadable while MP4 is still processing', async () => {
  const mp4Started = deferred();
  const finishMp4 = deferred();
  const { job } = await createTestJob({
    trim: async ({ format }) => {
      if (format === 'mp4') {
        mp4Started.resolve();
        await finishMp4.promise;
      }
    }
  });

  await mp4Started.promise;
  const partial = await waitForJob(job.id, (current) => current.outputs.mp3.status === 'completed');
  assert.equal(partial.status, 'processing');
  assert.equal(partial.outputs.mp4.status, 'processing');
  assert.equal((await jobs.getFile(job.id, 'mp3')).format, 'mp3');

  finishMp4.resolve();
  await waitForJob(job.id, (current) => current.status === 'completed');
});

test('failure in one output preserves the successful output and its download URL', async () => {
  const { job } = await createTestJob({
    trim: async ({ format }) => {
      if (format === 'mp3') throw new Error('test MP3 failure');
    }
  });

  const completed = await waitForJob(job.id, (current) => current.status === 'completed');
  assert.equal(completed.outputs.mp4.status, 'completed');
  assert.equal(completed.outputs.mp3.status, 'failed');
  assert.match(completed.outputs.mp3.error.message, /could not be generated/i);
  assert.ok(completed.outputs.mp4.downloadUrl);
  assert.equal((await jobs.getFile(job.id, 'mp4')).format, 'mp4');
  await assert.rejects(() => jobs.getFile(job.id, 'mp3'), { code: 'JOB_NOT_READY' });
});

test('parent cancellation aborts both output tasks and removes the job directory', async () => {
  const bothStarted = deferred();
  let activeTrims = 0;
  let observedAborts = 0;
  const { job } = await createTestJob({
    trim: ({ signal }) => new Promise((_resolve, reject) => {
      activeTrims += 1;
      if (activeTrims === 2) bothStarted.resolve();
      signal.addEventListener('abort', () => {
        observedAborts += 1;
        reject(new Error('aborted'));
      }, { once: true });
    })
  });

  await bothStarted.promise;
  const cancelled = await jobs.cancel(job.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.outputs.mp4.status, 'cancelled');
  assert.equal(cancelled.outputs.mp3.status, 'cancelled');
  assert.equal(observedAborts, 2);
  await waitForJob(job.id, (current) => current.status === 'cancelled');
  await waitForRemoval(path.join(require('../src/config').storageDir, job.id));
});

test('completed output URLs expire and their temporary files are removed', async () => {
  const originalNow = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const { job } = await createTestJob();
    await waitForJob(job.id, (current) => current.status === 'completed');
    now = jobs.getStatus(job.id).outputs.mp4.expiresAt + 1;
    const expired = jobs.getStatus(job.id);
    assert.equal(expired.status, 'expired');
    assert.equal(expired.outputs.mp4.status, 'expired');
    assert.equal(expired.outputs.mp4.downloadUrl, null);
    await assert.rejects(() => jobs.getFile(job.id, 'mp4'), { code: 'OUTPUT_EXPIRED' });
    await assert.rejects(() => jobs.getFile(job.id, 'mp3'), { code: 'OUTPUT_EXPIRED' });
    await waitForRemoval(path.join(require('../src/config').storageDir, job.id));
  } finally {
    Date.now = originalNow;
  }
});
