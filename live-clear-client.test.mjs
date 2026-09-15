import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Synthetic DOM, captions and local HTTP responses only. No browser, files, keys or cloud calls.
const source = readFileSync(new URL('./public/live.js', import.meta.url), 'utf8');
const boundary = source.indexOf("ui['start-button'].addEventListener");
assert.ok(boundary > 0);
const functions = source.slice(0, boundary);
const copy = value => JSON.parse(JSON.stringify(value));
async function flush() { for (let index = 0; index < 12; index++) await Promise.resolve(); }

function harness(t, { populated = true } = {}) {
  const elements = new Map(), timers = new Map(), requests = [], events = [], notices = [], restoredSettings = [];
  let nextTimer = 0, now = 0, mediaCalls = 0, socketCalls = 0;
  const element = tag => {
    const classes = new Set();
    return { tagName: tag, textContent: '', value: '', title: '', hidden: false, disabled: false, checked: false,
      children: [], options: [], style: { setProperty() {} },
      classList: { add: name => classes.add(name), remove: name => classes.delete(name),
        toggle(name, force) { if (force === undefined ? !classes.has(name) : force) classes.add(name); else classes.delete(name); } },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      remove() {}, click() { throw new Error('Clearing must not download a file.'); },
    };
  };
  const radio = { value: 'mic', checked: true, disabled: false };
  const dispatchEvent = event => { events.push(event.type); return true; };
  const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element('div')); return elements.get(id); },
    createElement: element, querySelector: () => radio, querySelectorAll: () => [radio], dispatchEvent,
    body: { append() { throw new Error('Clearing must not create downloads.'); } } };
  const context = {
    document, Event, Blob, TextEncoder, AbortController,
    window: { dispatchEvent, isSecureContext: true, AudioWorkletNode: function MockWorklet() {} },
    navigator: { mediaDevices: { getUserMedia() { mediaCalls++; return new Promise(() => {}); } } },
    performance: { now: () => now },
    WebSocket: class MockSocket { constructor() { socketCalls++; throw new Error('Clearing must not open a socket.'); } },
    URL: { createObjectURL() { throw new Error('Clearing must not export a file.'); } },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { at: now + delay, callback }); return id; },
    clearTimeout: id => timers.delete(id), clearInterval: id => timers.delete(id),
    fetch(url, options = {}) {
      assert.equal(url, '/api/live-draft', 'Clear may only use the local draft API.');
      return new Promise((resolve, reject) => {
        requests.push({ url, options, body: options.body ? JSON.parse(options.body) : undefined, resolve, reject });
        options.signal?.addEventListener('abort', () => { const error = new Error('Synthetic request aborted.'); error.name = 'AbortError'; reject(error); }, { once: true });
      });
    },
    recordNotice: (text, error) => notices.push({ text, error }),
    recordSettings: settings => restoredSettings.push(copy(settings)),
  };
  runInNewContext(`${functions}\n
    configurationIssue = () => '';
    scrollToLatest = () => {};
    const originalNotice = showNotice;
    showNotice = (text, error) => { recordNotice(text, error); originalNotice(text, error); };
    restoreSettings = settings => recordSettings(settings);
    globalThis.testApi = { clearCaptions, captionDraft, draftSettings, saveDraft, draftChanged, restoreDraft,
      startRun, previewHistory, endSession, refreshControls, exportFeedback, state, draftState, ui,
      getExportSequence: () => exportSequence };
  `, context);
  const api = context.testApi;
  api.state.loading = false; api.state.previewing = false; api.state.clearing = false;
  Object.assign(api.draftState, { initializing: false, loaded: true, restoring: false, dirty: true,
    blocked: false, saving: false, revision: 12, change: 3 });
  for (const [id, value] of Object.entries({ 'asr-select': 'qwen-asr-streaming', 'translation-select': 'deepseek-translate',
    'finance-course': 'fixed-income', 'max-minutes': '45', 'display-language': 'bilingual',
    glossary: 'duration = 久期', context: 'Synthetic finance lecture.' })) api.ui[id].value = value;
  api.ui.autoscroll.checked = true; api.state.fontSize = 31;
  if (populated) {
    const rows = [{ id: 'one', source: 'Yield may fall.', target: '收益率可能下跌。', final: true, translationStatus: 'done', seconds: 3 },
      { id: 'two', source: 'The price is rising.', target: '价格正在上涨。', final: true, translationStatus: 'done', seconds: 8 }];
    const session = { id: 'synthetic-session', createdAt: new Date('2026-09-15T08:00:00.000Z'),
      asrLabel: 'Synthetic ASR', translationLabel: 'Synthetic translation', historical: false, rows };
    api.state.sessions = [session]; api.state.rows = new Map(rows.map(row => [`${session.id}:${row.id}`, row]));
    api.state.pausedRun = { id: session.id, session, finished: true, stopMode: 'pause' };
    api.ui['caption-list'].append(element('article'), element('article'));
    api.ui['empty-state'].hidden = true; api.ui['sentence-count'].textContent = '2'; api.ui.timer.textContent = '01:22';
  }
  api.ui['export-status'].textContent = 'Previous TXT export status';
  api.draftState.settingsSignature = JSON.stringify(api.draftSettings());
  api.refreshControls();
  t.after(() => timers.clear());
  async function respond(request, { status = 200, result = { saved: true, revision: 13 } } = {}) {
    request.resolve({ ok: status >= 200 && status < 300, status, json: async () => result }); await flush();
  }
  async function advance(milliseconds) {
    const end = now + milliseconds;
    while (true) {
      let next;
      for (const timer of timers) if (timer[1].at <= end && (!next || timer[1].at < next[1].at)) next = timer;
      if (!next) break;
      timers.delete(next[0]); now = next[1].at; next[1].callback(); await flush();
    }
    now = end; await flush();
  }
  return { api, elements, requests, events, notices, restoredSettings, respond, advance,
    get mediaCalls() { return mediaCalls; }, get socketCalls() { return socketCalls; } };
}

test('clear persists empty sessions before deleting visible captions and preserves every setting', async t => {
  const h = harness(t), originalSessions = h.api.state.sessions, originalRows = h.api.state.rows;
  const settings = copy(h.api.draftSettings()), paused = h.api.state.pausedRun;
  const pending = h.api.clearCaptions(); await flush();
  assert.equal(h.requests.length, 1); assert.equal(h.api.state.clearing, true);
  assert.equal(h.api.state.sessions, originalSessions); assert.equal(h.api.state.rows, originalRows);
  assert.equal(h.api.state.pausedRun, paused); assert.equal(h.api.ui['caption-list'].children.length, 2);
  assert.equal(h.events.length, 0);
  assert.deepEqual(h.requests[0].body, { expectedRevision: 12, draft: { version: 1, settings, sessions: [] } });
  assert.equal(h.requests[0].options.method, 'POST'); assert.equal(h.requests[0].options.headers['Content-Type'], 'application/json');
  await h.respond(h.requests[0]); await pending;
  assert.equal(h.api.state.clearing, false); assert.equal(h.api.state.sessions.length, 0); assert.equal(h.api.state.rows.size, 0);
  assert.equal(h.api.state.pausedRun, null); assert.equal(h.api.state.run, null);
  assert.equal(h.api.ui['caption-list'].children.length, 0); assert.equal(h.api.ui['empty-state'].hidden, false);
  assert.match(h.api.ui['sentence-count'].textContent, /^0(?:\s*句字幕)?$/); assert.equal(h.api.ui.timer.textContent, '00:00');
  assert.deepEqual(copy(h.api.draftSettings()), settings); assert.equal(h.api.draftState.revision, 13);
  assert.equal(h.api.draftState.dirty, false); assert.deepEqual(h.events, ['classroom-captions-cleared']);
  await h.advance(20000); assert.equal(h.requests.length, 1, 'Old autosave timers must not resurrect captions.');
});

test('a fresh page restores the persisted empty draft without reviving old sessions', async t => {
  const h = harness(t), pending = h.api.clearCaptions();
  await h.respond(h.requests[0]); await pending;
  const persisted = { revision: 13, draft: h.requests[0].body.draft };
  const refreshed = harness(t, { populated: false });
  Object.assign(refreshed.api.draftState, { initializing: true, loaded: false, dirty: false, revision: 0 });
  const restoring = refreshed.api.restoreDraft(); assert.equal(refreshed.requests.length, 1);
  assert.equal(refreshed.requests[0].options.method, undefined);
  await refreshed.respond(refreshed.requests[0], { result: persisted }); await restoring;
  assert.equal(refreshed.api.state.sessions.length, 0); assert.equal(refreshed.api.state.rows.size, 0);
  assert.equal(refreshed.api.state.pausedRun, null); assert.equal(refreshed.api.draftState.loaded, true);
  assert.equal(refreshed.api.draftState.revision, 13);
  assert.deepEqual(refreshed.restoredSettings, [persisted.draft.settings]);
  assert.equal(refreshed.mediaCalls, 0); assert.equal(refreshed.socketCalls, 0);
});

test('duplicate clear clicks share one request and dispatch one successful clear event', async t => {
  const h = harness(t), first = h.api.clearCaptions(), second = h.api.clearCaptions();
  await flush(); assert.equal(h.requests.length, 1);
  await h.respond(h.requests[0]); await first; await second;
  await h.api.clearCaptions(); assert.equal(h.requests.length, 1); assert.deepEqual(h.events, ['classroom-captions-cleared']);
});

test('network failure retains captions, paused session, settings and rendered content', async t => {
  const h = harness(t), sessions = h.api.state.sessions, rows = h.api.state.rows, paused = h.api.state.pausedRun;
  const draft = copy(h.api.captionDraft()), pending = h.api.clearCaptions();
  h.requests[0].reject(new Error('Synthetic offline failure.')); await pending;
  assert.equal(h.api.state.sessions, sessions); assert.equal(h.api.state.rows, rows); assert.equal(h.api.state.pausedRun, paused);
  assert.deepEqual(copy(h.api.captionDraft()), draft); assert.equal(h.api.ui['caption-list'].children.length, 2);
  assert.equal(h.api.state.clearing, false); assert.equal(h.api.draftState.revision, 12); assert.equal(h.events.length, 0);
  assert.ok(h.notices.some(notice => notice.error));
});

test('409 conflict preserves local captions and blocks autosave from overwriting a newer draft', async t => {
  const h = harness(t), draft = copy(h.api.captionDraft()), pending = h.api.clearCaptions();
  await h.respond(h.requests[0], { status: 409, result: { error: 'Synthetic conflict.' } }); await pending;
  assert.deepEqual(copy(h.api.captionDraft()), draft); assert.equal(h.api.draftState.blocked, true);
  assert.equal(h.api.state.clearing, false); assert.equal(h.api.draftState.revision, 12); assert.equal(h.events.length, 0);
  await h.api.saveDraft(); await h.advance(20000); assert.equal(h.requests.length, 1);
  assert.ok(h.notices.some(notice => notice.error));
});

test('HTTP errors, missing save acknowledgement and invalid revisions never clear captions', async t => {
  const replies = [{ status: 500, result: { saved: true, revision: 13 } },
    { result: { saved: false, revision: 13 } }, { result: null }, { result: { saved: true } },
    ...['13', -1, 0, 12, 13.5, Number.MAX_SAFE_INTEGER + 1].map(revision => ({ result: { saved: true, revision } }))];
  for (const reply of replies) {
    const h = harness(t), before = copy(h.api.captionDraft()), pending = h.api.clearCaptions();
    await h.respond(h.requests[0], reply); await pending;
    assert.deepEqual(copy(h.api.captionDraft()), before); assert.equal(h.api.state.rows.size, 2);
    assert.equal(h.api.state.clearing, false); assert.equal(h.api.draftState.revision, 12); assert.equal(h.events.length, 0);
    assert.ok(h.notices.some(notice => notice.error));
  }
});

test('active capture cannot be cleared, stopped or exported by the clear action', async t => {
  const h = harness(t), run = { id: 'active-run', stopping: false, finished: false, queue: [],
    socket: { send() { throw new Error('Clear must not stop a live socket.'); }, close() { throw new Error('Clear must not close a live socket.'); } } };
  h.api.state.run = run; h.api.refreshControls();
  assert.equal(h.api.ui['clear-button'].disabled, true);
  await h.api.clearCaptions(); assert.equal(h.requests.length, 0); assert.equal(h.api.state.run, run);
  assert.equal(run.stopping, false); assert.equal(run.finished, false); assert.equal(h.api.state.rows.size, 2);
});

test('loading, preview, initialization and an existing draft save all guard the clear action', async t => {
  for (const [scope, flag] of [['state', 'loading'], ['state', 'previewing'], ['state', 'clearing'],
    ['draftState', 'initializing'], ['draftState', 'saving']]) {
    const h = harness(t); h.api[scope][flag] = true; h.api.refreshControls();
    assert.equal(h.api.ui['clear-button'].disabled, true, `${scope}.${flag}`);
    await h.api.clearCaptions(); assert.equal(h.requests.length, 0, `${scope}.${flag}`); assert.equal(h.api.state.rows.size, 2);
  }
});

test('clear is deferred while a real autosave request is in flight, then uses its new revision', async t => {
  const h = harness(t), saving = h.api.saveDraft();
  assert.equal(h.requests.length, 1); assert.equal(h.api.draftState.saving, true);
  assert.equal(h.requests[0].body.draft.sessions.length, 1);
  await h.api.clearCaptions(); assert.equal(h.requests.length, 1); assert.equal(h.api.state.rows.size, 2);
  await h.respond(h.requests[0]); await saving;
  const clearing = h.api.clearCaptions(); assert.equal(h.requests.length, 2);
  assert.equal(h.requests[1].body.expectedRevision, 13); assert.deepEqual(h.requests[1].body.draft.sessions, []);
  await h.respond(h.requests[1], { result: { saved: true, revision: 14 } }); await clearing;
  assert.equal(h.api.state.rows.size, 0); assert.equal(h.api.draftState.revision, 14);
});

test('clear locks start and preview and prevents a stale autosave from submitting captions', async t => {
  const h = harness(t); h.api.draftChanged();
  const clearing = h.api.clearCaptions(); await flush();
  for (const id of ['start-button', 'preview-button', 'clear-button', 'asr-select', 'translation-select']) assert.equal(h.api.ui[id].disabled, true, id);
  await h.api.startRun(); await h.api.previewHistory(); await h.api.saveDraft(); await h.api.saveDraft(true);
  await h.advance(5000);
  assert.equal(h.requests.length, 1); assert.equal(h.mediaCalls, 0); assert.equal(h.socketCalls, 0);
  assert.equal(h.api.state.run, null); assert.equal(h.api.state.previewing, false);
  await h.respond(h.requests[0]); await clearing;
  assert.equal(h.api.ui['start-button'].disabled, false); assert.equal(h.api.ui['preview-button'].disabled, false);
  await h.advance(20000); assert.equal(h.requests.length, 1);
});

test('empty pages never write a clear draft or dispatch the clear event', async t => {
  const h = harness(t, { populated: false });
  await h.api.clearCaptions(); assert.equal(h.requests.length, 0); assert.equal(h.events.length, 0);
});

test('successful clear invalidates the previous export status callback', async t => {
  const h = harness(t), oldSequence = h.api.getExportSequence(), pending = h.api.clearCaptions();
  await h.respond(h.requests[0]); await pending;
  const current = h.api.ui['export-status'].textContent;
  h.api.exportFeedback(oldSequence, 'Stale export completion must not return.');
  assert.equal(h.api.ui['export-status'].textContent, current);
});

test('clear timeout aborts the local request and retains captions while unlocking interaction', async t => {
  const h = harness(t), before = copy(h.api.captionDraft()), pending = h.api.clearCaptions();
  const request = h.requests[0]; await h.advance(9999);
  assert.equal(request.options.signal.aborted, false); assert.equal(h.api.state.clearing, true);
  await h.advance(1); await pending;
  assert.equal(request.options.signal.aborted, true); assert.equal(h.api.state.clearing, false);
  assert.deepEqual(copy(h.api.captionDraft()), before); assert.equal(h.api.draftState.revision, 12);
  assert.equal(h.events.length, 0); assert.ok(h.notices.some(notice => notice.error));
});
