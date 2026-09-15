import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const clientSource = readFileSync(new URL('./public/context-correction.js', import.meta.url), 'utf8');

async function flushPromises() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function createHarness(t) {
  let time = 0, nextTimerId = 0;
  const timers = new Map(), requests = [];
  const window = { dispatchEvent() {} };
  runInNewContext(clientSource, {
    window,
    AbortController,
    Event: class { constructor(type) { this.type = type; } },
  });
  const scheduler = window.ClassroomContextCorrection.create({
    now: () => time,
    setTimer(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { at: time + delay, callback });
      return id;
    },
    clearTimer: id => timers.delete(id),
    request: (payload, signal) => new Promise((resolve, reject) => {
      // Aborting deliberately does not settle this mock, as a transport may respond late.
      requests.push({ payload, signal, startedAt: time, resolve, reject });
    }),
  });
  t.after(() => scheduler.destroy());

  async function advance(milliseconds) {
    const end = time + milliseconds;
    while (true) {
      let next;
      for (const entry of timers) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      timers.delete(next[0]);
      time = next[1].at;
      next[1].callback();
      await flushPromises();
    }
    time = end;
    await flushPromises();
  }

  async function succeed(request, corrected = 'Corrected translation.') {
    request.resolve({ corrected, profileId: request.payload.profileId, model: 'mock-text-model', cached: false });
    await flushPromises();
  }

  return { scheduler, requests, advance, succeed, get pendingTimerCount() { return timers.size; } };
}

function candidate(source = 'A complete English paragraph.', options = {}) {
  return { key: {}, source, target: 'Original translation.', complete: true, expandable: false, ...options };
}

function enable(harness, candidates) {
  harness.scheduler.update(candidates);
  harness.scheduler.configure({ enabled: true, visible: true, profileId: 'model-a' });
}

test('disabled correction does not inspect 220 candidates or schedule work', async t => {
  const harness = createHarness(t);
  const candidates = Array.from({ length: 220 }, () => new Proxy({}, {
    get() { assert.fail('Disabled correction inspected a candidate.'); },
  }));
  harness.scheduler.update(candidates);
  harness.scheduler.configure({ enabled: false, visible: true, profileId: 'model-a' });
  harness.scheduler.update(candidates);
  await harness.advance(60000);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.pendingTimerCount, 0);
});

test('waits for stable text and keeps the 15-second request interval across toggles and model changes', async t => {
  const harness = createHarness(t), row = candidate();
  enable(harness, [row]);
  for (let index = 0; index < 4; index++) {
    await harness.advance(900);
    harness.scheduler.update([row]);
  }
  await harness.advance(399);
  assert.equal(harness.requests.length, 0);
  await harness.advance(1);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].startedAt, 4000);
  await harness.succeed(harness.requests[0]);

  await harness.advance(1000);
  harness.scheduler.configure({ enabled: false, profileId: 'model-b' });
  harness.scheduler.configure({ enabled: true });
  await harness.advance(13999);
  assert.equal(harness.requests.length, 1);
  await harness.advance(1);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.requests[1].startedAt - harness.requests[0].startedAt, 15000);
  assert.equal(harness.requests[1].payload.profileId, 'model-b');

  const growing = createHarness(t);
  enable(growing, [candidate('A paragraph still receiving complete sentences.', { expandable: true })]);
  await growing.advance(7999);
  assert.equal(growing.requests.length, 0);
  await growing.advance(1);
  assert.equal(growing.requests.length, 1);
  assert.equal(growing.requests[0].startedAt, 8000);
});

test('an aborted request keeps the concurrency slot until it settles and its late response stays hidden', async t => {
  const harness = createHarness(t), row = candidate();
  enable(harness, [row]);
  await harness.advance(4000);
  const aborted = harness.requests[0];
  harness.scheduler.configure({ enabled: false });
  assert.equal(aborted.signal.aborted, true);
  harness.scheduler.configure({ enabled: true });
  await harness.advance(30000);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.scheduler.getResult(row.key), null);

  await harness.succeed(aborted, 'Late response from an aborted request.');
  assert.equal(harness.scheduler.getResult(row.key), null);
  assert.equal(harness.requests.length, 2);
  await harness.succeed(harness.requests[1], 'Current response.');
  assert.equal(harness.scheduler.getResult(row.key).corrected, 'Current response.');
});

test('text and model changes invalidate completed results and discard responses for old inputs', async t => {
  const harness = createHarness(t), row = candidate();
  enable(harness, [row]);
  await harness.advance(4000);
  const oldTextRequest = harness.requests[0];
  row.target = 'Updated original translation.';
  harness.scheduler.update([row]);
  assert.equal(oldTextRequest.signal.aborted, true);
  await harness.succeed(oldTextRequest, 'Correction for old text.');
  assert.equal(harness.scheduler.getResult(row.key), null);

  await harness.advance(15000);
  assert.equal(harness.requests[1].payload.target, row.target);
  await harness.succeed(harness.requests[1], 'Correction for updated text.');
  assert.equal(harness.scheduler.getResult(row.key).corrected, 'Correction for updated text.');
  harness.scheduler.configure({ profileId: 'model-b' });
  assert.equal(harness.scheduler.getResult(row.key), null);
  await harness.advance(15000);
  const oldModelRequest = harness.requests[2];
  assert.equal(oldModelRequest.payload.profileId, 'model-b');
  harness.scheduler.configure({ profileId: 'model-c' });
  assert.equal(oldModelRequest.signal.aborted, true);
  await harness.succeed(oldModelRequest, 'Correction from the previous model.');
  assert.equal(harness.scheduler.getResult(row.key), null);

  await harness.advance(15000);
  assert.equal(harness.requests[3].payload.profileId, 'model-c');
  await harness.succeed(harness.requests[3], 'Correction from the selected model.');
  assert.equal(harness.scheduler.getResult(row.key).corrected, 'Correction from the selected model.');
});

test('reuses successful corrections and does not retry failed or incomplete text without a change', async t => {
  const harness = createHarness(t);
  const good = candidate('Successful paragraph.', { priority: 1 });
  const bad = candidate('Failed paragraph.');
  const pending = candidate('Incomplete paragraph.', { complete: false, priority: 10 });
  enable(harness, [good, bad, pending]);
  await harness.advance(4000);
  assert.equal(harness.requests[0].payload.source, good.source);
  await harness.succeed(harness.requests[0]);
  await harness.advance(15000);
  assert.equal(harness.requests[1].payload.source, bad.source);
  harness.requests[1].reject(new Error('Expected mock failure.'));
  await flushPromises();
  assert.equal(harness.scheduler.getState(bad.key).status, 'error');
  assert.equal(harness.scheduler.getState(pending.key).status, 'idle');

  harness.scheduler.configure({ enabled: false });
  assert.equal(harness.scheduler.getResult(good.key), null);
  harness.scheduler.configure({ enabled: true, profileId: 'model-b' });
  harness.scheduler.configure({ profileId: 'model-a' });
  const cached = harness.scheduler.getResult(good.key);
  assert.equal(cached.corrected, 'Corrected translation.');
  assert.equal(cached.profileId, 'model-a');
  assert.equal(cached.model, 'mock-text-model');
  harness.scheduler.update([{ ...good }, { ...bad }, { ...pending }]);
  await harness.advance(60000);
  assert.equal(harness.requests.length, 2);
  assert.equal(harness.scheduler.getState(bad.key).status, 'error');

  bad.source = 'Revised paragraph after the failure.';
  harness.scheduler.update([good, bad, pending]);
  await harness.advance(4000);
  assert.equal(harness.requests.length, 3);
  assert.equal(harness.requests[2].payload.source, bad.source);
});
