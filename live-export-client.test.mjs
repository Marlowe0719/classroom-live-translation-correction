import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('./public/live.js', import.meta.url), 'utf8');
const registrationStart = source.indexOf("ui['start-button'].addEventListener");
assert.ok(registrationStart > 0, 'The live client event-registration boundary must exist.');
const clientFunctions = source.slice(0, registrationStart);
const contextHeading = '=== 上下文（含已完成 AI 校正） ===';

async function flushPromises() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

function createHarness(t, snapshot = () => ({ text: '', hasCorrections: false })) {
  let time = 0, nextTimerId = 0, nextBlobId = 0, snapshotCalls = 0;
  const timers = new Map(), elements = new Map(), blobs = new Map();
  const requests = [], downloads = [], socketMessages = [];
  const createElement = tag => ({
    tagName: tag, textContent: '', title: '', hidden: false,
    classList: { add() {}, remove() {}, toggle() {} },
    append() {}, remove() {},
    click() { downloads.push({ filename: this.download, blob: blobs.get(this.href) }); },
  });
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement('div'));
      return elements.get(id);
    },
    createElement,
    querySelector: () => ({ value: 'mic' }),
    body: { append() {} },
  };
  const context = {
    document, Blob, AbortController,
    window: { isSecureContext: true, AudioWorkletNode: function MockWorklet() {},
      ClassroomContextExport: { snapshot() { snapshotCalls++; return snapshot(); } } },
    navigator: { mediaDevices: { getUserMedia: () => new Promise(() => {}) } },
    performance: { now: () => time },
    WebSocket: { OPEN: 1, CLOSING: 2, CLOSED: 3 },
    URL: {
      createObjectURL(blob) { const url = `blob:mock-${++nextBlobId}`; blobs.set(url, blob); return url; },
      revokeObjectURL(url) { blobs.delete(url); },
    },
    setTimeout(callback, delay) {
      const id = ++nextTimerId;
      timers.set(id, { at: time + delay, callback });
      return id;
    },
    clearTimeout: id => timers.delete(id),
    clearInterval: id => timers.delete(id),
    fetch(url, options) {
      assert.equal(url, '/api/live-export', 'Finishing a run must not call a correction or other API.');
      return new Promise((resolve, reject) => {
        const request = { url, options, body: JSON.parse(options.body), resolve, reject };
        requests.push(request);
        // Match fetch's abort behavior without using a real connection or timer.
        options.signal.addEventListener('abort', () => {
          const error = new Error('Mock fetch aborted.'); error.name = 'AbortError'; reject(error);
        }, { once: true });
      });
    },
  };
  runInNewContext(`${clientFunctions}\n
    refreshControls = () => {};
    status = () => {};
    showNotice = () => {};
    saveDraft = () => Promise.resolve();
    releaseCapture = () => {};
    markSessionPaused = () => {};
    configurationIssue = () => '';
    globalThis.testApi = { finishRun, stopRun, endSession, startRun, autoExportCaptions, captionText, exportCaptions, state,
      setFlushCapture: callback => { flushCapture = callback; } };
  `, context);
  const api = context.testApi;
  t.after(() => timers.clear());

  function runFixture({ id = 'current-run', source = 'Current English sentence.', target = '当前原译文。', history = false,
    append = false, seedRun = null } = {}) {
    const row = { source, target, seconds: 4, final: true, translationStatus: target ? 'done' : 'pending' };
    const session = { id, createdAt: new Date('2026-09-15T08:00:00Z'), asrLabel: 'Mock ASR', translationLabel: 'Mock translation', rows: [row] };
    const run = Object.assign(seedRun || {}, {
      id, session, queue: [], startedAt: 1,
      socket: {
        readyState: 1,
        send(message) { socketMessages.push(message); },
        close() { this.readyState = 3; },
      },
    });
    if (!append) api.state.sessions = [];
    if (history) api.state.sessions.push({
      id: 'old-history', createdAt: new Date('2026-09-14T08:00:00Z'), asrLabel: 'Previous ASR',
      translationLabel: 'Previous translation', historical: true,
      rows: [{ source: 'Earlier English sentence.', target: '此前原译文。', seconds: 0, final: true }],
    });
    api.state.sessions.push(session);
    api.state.rows = new Map(api.state.sessions.flatMap(item => item.rows.map((entry, index) => [`${item.id}:${index}`, entry])));
    api.state.run = run;
    return { run, row };
  }

  function resumeFixture(options = {}) {
    api.state.loading = false;
    // Run the real startRun transition, pausing only at a synthetic microphone permission promise.
    void api.startRun();
    assert.ok(api.state.run, 'Resuming must create a new run before microphone permission completes.');
    const run = api.state.run;
    return runFixture({ ...options, id: run.id, append: true, seedRun: run });
  }

  async function advance(milliseconds) {
    const end = time + milliseconds;
    while (true) {
      let next;
      for (const entry of timers) {
        if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      timers.delete(next[0]); time = next[1].at; next[1].callback();
      await flushPromises();
    }
    time = end; await flushPromises();
  }

  async function saveSuccessfully(request) {
    request.resolve({ ok: true, json: async () => ({ saved: true, path: 'mock-downloads/classroom.txt' }) });
    await flushPromises();
  }

  return { api, requests, downloads, socketMessages, runFixture, resumeFixture, advance, saveSuccessfully,
    get snapshotCalls() { return snapshotCalls; } };
}

test('finishing exports the last translation, page history and completed corrections exactly once', async t => {
  const harness = createHarness(t, () => ({ text: 'Context session\nContext English.\n已完成的校正译文。', hasCorrections: true }));
  const { run, row } = harness.runFixture({ target: '', history: true });
  await harness.api.stopRun(run, { flush: false });
  assert.equal(harness.requests.length, 0, 'Stopping must wait for final translations before exporting.');
  assert.equal(JSON.parse(harness.socketMessages[0]).type, 'stop');
  row.target = '最后到达的原译文。'; row.translationStatus = 'done';
  harness.api.finishRun(run);
  harness.api.finishRun(run);
  await harness.api.autoExportCaptions(run);
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  assert.equal(request.options.method, 'POST');
  assert.equal(request.body.runId, run.id);
  assert.ok(Number.isFinite(Date.parse(request.body.endedAt)));
  assert.ok(request.body.text.includes('Earlier English sentence.'));
  assert.ok(request.body.text.includes('此前原译文。'));
  assert.ok(request.body.text.includes(row.source));
  assert.ok(request.body.text.includes(row.target));
  assert.ok(request.body.text.includes(contextHeading));
  assert.ok(request.body.text.includes('已完成的校正译文。'));
  assert.equal(harness.snapshotCalls, 1);
  await harness.saveSuccessfully(request);
  assert.equal(harness.downloads.length, 0);

  harness.api.exportCaptions();
  const manualText = await harness.downloads[0].blob.text();
  assert.ok(manualText.includes(row.target));
  assert.equal(manualText.includes(contextHeading), false, 'Manual export keeps the original bilingual captions.');
  assert.equal(harness.snapshotCalls, 1);
});

test('an empty current run does not export old history', async t => {
  const harness = createHarness(t);
  const { run } = harness.runFixture({ source: '  ', target: '\n', history: true });
  harness.api.finishRun(run);
  await harness.api.autoExportCaptions(run);
  await harness.advance(20000);
  assert.equal(harness.api.state.run, null);
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.downloads.length, 0);
  assert.equal(harness.snapshotCalls, 0);
});

test('a pending save releases the run immediately and a disabled correction snapshot adds no work or appendix', async t => {
  const harness = createHarness(t, () => ({ text: '', hasCorrections: false }));
  const { run } = harness.runFixture();
  harness.api.finishRun(run);
  assert.equal(harness.api.state.run, null);
  assert.equal(harness.requests.length, 1, 'Saving starts synchronously without waiting for correction work.');
  assert.equal(harness.snapshotCalls, 1);
  assert.equal(harness.requests[0].body.text.includes(contextHeading), false);
  const nextRun = { id: 'next-run', queue: [] };
  harness.api.state.run = nextRun;
  await harness.advance(7000);
  assert.equal(harness.api.state.run, nextRun);
  await harness.saveSuccessfully(harness.requests[0]);
  assert.equal(harness.api.state.run, nextRun, 'The previous save must not finish or reset a new run.');
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.downloads.length, 0);
});

test('snapshot errors retain original captions and a failed local save falls back to one TXT download', async t => {
  const harness = createHarness(t, () => { throw new Error('Mock sidebar failure.'); });
  const { run, row } = harness.runFixture();
  harness.api.finishRun(run);
  assert.equal(harness.requests.length, 1);
  const request = harness.requests[0];
  assert.ok(request.body.text.includes(row.source));
  assert.ok(request.body.text.includes(row.target));
  assert.equal(request.body.text.includes(contextHeading), false);
  request.resolve({ ok: false, json: async () => ({ saved: false }) });
  await flushPromises();
  assert.equal(harness.downloads.length, 1);
  assert.match(harness.downloads[0].filename, /\.txt$/);
  assert.ok((await harness.downloads[0].blob.text()).includes(request.body.text));
  await harness.advance(20000);
  harness.api.finishRun(run);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.downloads.length, 1);
});

test('an eight-second save timeout aborts fetch and downloads the same captured text once', async t => {
  const harness = createHarness(t);
  const { run } = harness.runFixture();
  harness.api.finishRun(run);
  const request = harness.requests[0];
  await harness.advance(7999);
  assert.equal(request.options.signal.aborted, false);
  assert.equal(harness.downloads.length, 0);
  await harness.advance(1);
  assert.equal(request.options.signal.aborted, true);
  assert.equal(harness.downloads.length, 1);
  assert.ok((await harness.downloads[0].blob.text()).includes(request.body.text));
  await harness.saveSuccessfully(request);
  await harness.api.autoExportCaptions(run);
  await harness.advance(20000);
  assert.equal(harness.requests.length, 1);
  assert.equal(harness.downloads.length, 1);
});

test('manual pause drains the last translation and retains the run without automatically exporting', async t => {
  const harness = createHarness(t), { run, row } = harness.runFixture({ target: '' });
  await harness.api.stopRun(run, { mode: 'pause', flush: false });
  assert.equal(run.stopMode, 'pause'); assert.equal(harness.requests.length, 0);
  row.target = '暂停时最后到达的译文。'; row.translationStatus = 'done';
  harness.api.finishRun(run); harness.api.finishRun(run);
  await flushPromises(); await harness.advance(20000);
  assert.equal(harness.api.state.run, null); assert.equal(harness.api.state.pausedRun, run);
  assert.equal(harness.requests.length, 0); assert.equal(harness.downloads.length, 0); assert.equal(harness.snapshotCalls, 0);
  assert.equal(run.session.rows[0].target, row.target);
});

test('ending a paused session exports exactly once and clears the paused run', async t => {
  const harness = createHarness(t), { run } = harness.runFixture();
  await harness.api.stopRun(run, { mode: 'pause', flush: false }); harness.api.finishRun(run);
  assert.equal(harness.requests.length, 0);
  const ending = harness.api.endSession(); await flushPromises();
  assert.equal(harness.requests.length, 1); assert.equal(harness.api.state.pausedRun, null);
  const repeated = harness.api.endSession(); await flushPromises(); assert.equal(harness.requests.length, 1);
  assert.equal(harness.requests[0].body.runId, run.id);
  await harness.saveSuccessfully(harness.requests[0]); await ending; await repeated;
  await harness.api.endSession(); harness.api.finishRun(run);
  assert.equal(harness.requests.length, 1); assert.equal(harness.downloads.length, 0);
});

test('pause, real startRun resume and pause again create no automatic exports', async t => {
  const harness = createHarness(t), first = harness.runFixture({ source: 'First part.', target: '第一段。' });
  await harness.api.stopRun(first.run, { mode: 'pause', flush: false }); harness.api.finishRun(first.run);
  assert.equal(harness.api.state.pausedRun, first.run);
  const second = harness.resumeFixture({ source: 'Second part.', target: '第二段。' });
  assert.notEqual(second.run, first.run); assert.notEqual(second.run.id, first.run.id);
  await harness.api.stopRun(second.run, { mode: 'pause', flush: false }); harness.api.finishRun(second.run);
  assert.equal(harness.api.state.run, null); assert.equal(harness.api.state.pausedRun, second.run);
  assert.equal(harness.requests.length, 0); assert.equal(harness.snapshotCalls, 0);
  assert.equal(harness.api.state.sessions.length, 2);
  const ending = harness.api.endSession(); await flushPromises();
  assert.equal(harness.requests.length, 1);
  for (const text of ['First part.', '第一段。', 'Second part.', '第二段。']) assert.ok(harness.requests[0].body.text.includes(text));
  await harness.saveSuccessfully(harness.requests[0]); await ending;
});

test('ending a running session waits for finish and includes its final translation', async t => {
  const harness = createHarness(t), { run, row } = harness.runFixture({ target: '' });
  const ending = harness.api.endSession(); await flushPromises();
  assert.equal(run.stopMode, 'end'); assert.equal(run.stopping, true);
  assert.equal(harness.requests.length, 0); assert.equal(harness.api.state.run, run);
  assert.equal(JSON.parse(harness.socketMessages[0]).type, 'stop');
  row.target = '结束时最后一句译文。'; row.translationStatus = 'done';
  harness.api.finishRun(run); await flushPromises();
  assert.equal(harness.requests.length, 1); assert.ok(harness.requests[0].body.text.includes(row.target));
  assert.equal(harness.api.state.run, null); assert.equal(harness.api.state.pausedRun, null);
  await harness.saveSuccessfully(harness.requests[0]); await ending;
  await harness.api.endSession(); assert.equal(harness.requests.length, 1);
});

test('end clicked during pause tail drain upgrades once and still waits for the final translation', async t => {
  const harness = createHarness(t), { run, row } = harness.runFixture({ target: '' });
  let release; harness.api.setFlushCapture(() => new Promise(resolve => { release = resolve; }));
  const pausing = harness.api.stopRun(run, { mode: 'pause' });
  assert.equal(run.stopMode, 'pause'); assert.equal(typeof release, 'function');
  const ending = harness.api.endSession(), repeated = harness.api.endSession();
  await flushPromises(); assert.equal(run.stopMode, 'end'); assert.equal(harness.requests.length, 0);
  release(null); await pausing; await flushPromises();
  assert.equal(harness.requests.length, 0);
  assert.equal(harness.socketMessages.filter(message => JSON.parse(message).type === 'stop').length, 1);
  row.target = '暂停切换结束后的最后译文。'; row.translationStatus = 'done';
  harness.api.finishRun(run); harness.api.finishRun(run); await flushPromises();
  assert.equal(harness.requests.length, 1); assert.ok(harness.requests[0].body.text.includes(row.target));
  await harness.saveSuccessfully(harness.requests[0]); await ending; await repeated;
  assert.equal(harness.api.state.pausedRun, null); assert.equal(harness.requests.length, 1);
});

test('socket errors and forced finish during a manual pause never change it into automatic end', async t => {
  const harness = createHarness(t), { run } = harness.runFixture();
  await harness.api.stopRun(run, { mode: 'pause', flush: false });
  run.error = 'Mock connection closed during pause.';
  await harness.api.stopRun(run, { error: run.error, flush: false });
  assert.equal(run.stopMode, 'pause');
  harness.api.finishRun(run, 'Mock forced close.'); await harness.advance(20000);
  assert.equal(harness.api.state.pausedRun, run); assert.equal(harness.requests.length, 0);
  assert.equal(harness.downloads.length, 0); assert.equal(harness.snapshotCalls, 0);
});

test('automatic export entry point itself ignores paused runs without consuming their eventual export', async t => {
  const harness = createHarness(t), { run } = harness.runFixture();
  await harness.api.stopRun(run, { mode: 'pause', flush: false }); harness.api.finishRun(run);
  await harness.api.autoExportCaptions(run); await harness.api.autoExportCaptions(run);
  assert.equal(harness.requests.length, 0); assert.equal(harness.snapshotCalls, 0); assert.notEqual(run.exportStarted, true);
  await harness.api.endSession(); assert.equal(harness.requests.length, 1);
  await harness.saveSuccessfully(harness.requests[0]);
});

test('explicitly ending an empty paused connection still exports all earlier page captions', async t => {
  const harness = createHarness(t), { run } = harness.runFixture({ source: ' ', target: '\n', history: true });
  await harness.api.stopRun(run, { mode: 'pause', flush: false }); harness.api.finishRun(run);
  assert.equal(harness.requests.length, 0);
  await harness.api.endSession(); assert.equal(harness.requests.length, 1);
  const request = harness.requests[0]; assert.equal(request.body.runId, run.id);
  assert.ok(request.body.text.includes('Earlier English sentence.')); assert.ok(request.body.text.includes('此前原译文。'));
  await harness.saveSuccessfully(request); await harness.api.endSession(); assert.equal(harness.requests.length, 1);
});
