import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, analyze } from './server.mjs';
import { Store } from './store.mjs';
import { parseWav, wordErrorRate } from './audio.mjs';

// All provider adapters are injected. The only HTTP connections in this file
// target an ephemeral loopback server; all credentials below are fake fixtures.
const offlineTest = (name, fn) => test(name, { timeout: 8000 }, fn);
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function wav(seconds = 0.2) {
  const size = Math.round(seconds * 16000) * 2;
  const bytes = Buffer.alloc(44 + size);
  bytes.write('RIFF'); bytes.writeUInt32LE(36 + size, 4); bytes.write('WAVE', 8);
  bytes.write('fmt ', 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36); bytes.writeUInt32LE(size, 40);
  return bytes;
}
function fixtures() {
  const profiles = [
    ...['asr-a', 'asr-b', 'asr-c'].map(id => ({ id, label: id, protocol: 'qwen-asr-chat', configured: true, capabilities: ['asr'] })),
    ...['translate-a', 'translate-b', 'translate-c'].map(id => ({ id, label: id, protocol: 'openai-chat', configured: true, capabilities: ['translation'] })),
    { id: 'tencent-test', label: '腾讯测试', protocol: 'tencent-translation', configured: true, capabilities: ['asr'] },
    { id: 'unconfigured-asr', label: '未配置转录', protocol: 'qwen-asr-chat', configured: false, capabilities: ['asr'] },
    { id: 'unconfigured-translation', label: '未配置翻译', protocol: 'openai-chat', configured: false, capabilities: ['translation'] }
  ];
  const reports = [];
  const resolved = [];
  return { profiles, reports, resolved,
    list: () => profiles.map(p => ({ ...p })),
    resolve: id => { resolved.push(id); return { ...profiles.find(p => p.id === id), apiKey: 'fake-unit-test-key-never-real' }; },
    saveReport: report => reports.push(structuredClone(report)),
    history: () => [],
  };
}
const pipeline = (id = 'p1', asrId = 'asr-a', translationId = 'translate-a') => ({ id, label: id, asrId, translationId });
const input = overrides => ({ audio: wav().toString('base64'), pipelines: [pipeline()], glossary: '', context: '', reference: '', financeCourse: 'none', save: true, ...overrides });
const okSpeech = async () => ({ source: 'The bond price rose.', target: '债券价格上涨。' });
const okTranslation = async () => ({ target: '债券价格上涨。' });

offlineTest('all selected profiles are prevalidated before any speech or translation call', async () => {
  for (const invalid of [pipeline('bad', 'unconfigured-asr'), pipeline('bad', 'asr-b', 'unconfigured-translation')]) {
    const store = fixtures(); let calls = 0;
    const called = async () => { calls++; return { source: 'Unexpected', target: '不应调用' }; };
    await assert.rejects(analyze(input({ pipelines: [pipeline('valid'), invalid] }), { store, speech: called, translation: called }), /请先配置/);
    assert.equal(calls, 0); assert.equal(store.resolved.length, 0); assert.equal(store.reports.length, 0);
  }
});

offlineTest('identical ASR is called once and supplies identical source to two translators', async () => {
  const store = fixtures(); let speechCalls = 0; const sources = [];
  const report = await analyze(input({ pipelines: [pipeline('qwen', 'asr-a', 'translate-a'), pipeline('deepseek', 'asr-a', 'translate-b')], reference: 'The bond price rose.' }), {
    store,
    speech: async () => { speechCalls++; return okSpeech(); },
    translation: async (p, options) => { sources.push({ id: p.id, source: options.source }); return { target: p.id }; }
  });
  assert.equal(speechCalls, 1); assert.equal(sources.length, 2);
  assert(sources.every(item => item.source === 'The bond price rose.'));
  assert.deepEqual(report.results.map(r => r.source), ['The bond price rose.', 'The bond price rose.']);
  assert(report.results.every(r => r.status === 'ok' && r.usage.sharedAsr && r.wer.rate === 0));
  assert.equal(store.reports.length, 1); assert.equal(report.saved, true);
  assert(!JSON.stringify(report).includes('fake-unit-test-key-never-real'));
  assert(!Object.hasOwn(report, 'audio'));
});

offlineTest('identical ASR/translation pair is also deduplicated across labels', async () => {
  const store = fixtures(); let speechCalls = 0, translationCalls = 0;
  const report = await analyze(input({ pipelines: [pipeline('first'), pipeline('second')] }), {
    store, speech: async () => { speechCalls++; return okSpeech(); }, translation: async () => { translationCalls++; return okTranslation(); }
  });
  assert.equal(speechCalls, 1); assert.equal(translationCalls, 1); assert.equal(report.results.length, 2);
});

offlineTest('at most three independent pipelines run concurrently and a fourth is rejected before calling', async () => {
  const store = fixtures(); const release = deferred(); const entered = deferred();
  let active = 0, peak = 0, calls = 0;
  const speech = async () => { calls++; active++; peak = Math.max(peak, active); if (calls === 3) entered.resolve(); await release.promise; active--; return okSpeech(); };
  const pipelines = ['a', 'b', 'c'].map(letter => pipeline(letter, `asr-${letter}`, 'none'));
  const resultPromise = analyze(input({ pipelines }), { store, speech, translation: okTranslation });
  await entered.promise; assert.equal(active, 3); assert.equal(peak, 3); release.resolve();
  assert((await resultPromise).results.every(r => r.status === 'ok'));
  await assert.rejects(analyze(input({ pipelines: [...pipelines, pipeline('fourth')] }), { store, speech, translation: okTranslation }), /1–3/);
  assert.equal(calls, 3);
});

offlineTest('partial provider failure keeps real successful results and no fabricated WER', async () => {
  const store = fixtures();
  const report = await analyze(input({ pipelines: [pipeline('good', 'asr-a'), pipeline('speech-fails', 'asr-b'), pipeline('translation-fails', 'asr-c', 'translate-b')], reference: 'The bond price rose.' }), {
    store,
    speech: async p => { if (p.id === 'asr-b') throw new Error('fake-private-key-provider-diagnostic'); return okSpeech(); },
    translation: async p => { if (p.id === 'translate-b') throw new Error('fake-private-key-provider-diagnostic'); return okTranslation(); }
  });
  assert.equal(report.results[0].status, 'ok'); assert.equal(report.results[0].wer.rate, 0);
  for (const failed of report.results.slice(1)) { assert.equal(failed.status, 'error'); assert.equal(failed.wer, null); assert.equal(failed.target, ''); }
  assert.equal(report.results[1].source, ''); assert.equal(report.results[2].source, 'The bond price rose.');
  assert(!JSON.stringify(report).includes('fake-private-key-provider-diagnostic'));
});

offlineTest('no manual reference produces null WER, even for a successful transcription', async () => {
  const report = await analyze(input(), { store: fixtures(), speech: okSpeech, translation: okTranslation });
  assert.equal(report.referenceProvided, false); assert.equal(report.results[0].wer, null);
});

offlineTest('already aborted analysis calls no providers and saves no report', async () => {
  const store = fixtures(); const controller = new AbortController(); controller.abort(); let calls = 0;
  await assert.rejects(analyze(input(), { store, signal: controller.signal, speech: async () => { calls++; return okSpeech(); }, translation: okTranslation }), { name: 'AbortError' });
  assert.equal(calls, 0); assert.equal(store.reports.length, 0);
});

offlineTest('abort after speech starts prevents translation and saving', async () => {
  const store = fixtures(), controller = new AbortController(), entered = deferred(), release = deferred(); let translations = 0;
  const pending = analyze(input(), { store, signal: controller.signal,
    speech: async () => { entered.resolve(); await release.promise; return okSpeech(); },
    translation: async () => { translations++; return okTranslation(); }
  });
  await entered.promise; controller.abort(); release.resolve(); const report = await pending;
  assert.equal(translations, 0); assert.equal(store.reports.length, 0); assert.equal(report.saved, false);
  assert.equal(report.results[0].status, 'error'); assert.equal(report.results[0].wer, null);
});

offlineTest('abort also prevents builtin/English-only pipelines from reporting a cancelled success', async () => {
  for (const p of [pipeline('builtin', 'tencent-test', 'builtin'), pipeline('english', 'asr-a', 'none')]) {
    const store = fixtures(), controller = new AbortController();
    const report = await analyze(input({ pipelines: [p] }), { store, signal: controller.signal,
      speech: async () => { controller.abort(); return okSpeech(); }, translation: okTranslation
    });
    assert.equal(report.results[0].status, 'error'); assert.equal(report.results[0].wer, null); assert.equal(store.reports.length, 0);
  }
});

offlineTest('abort inside the first translator prevents later translation calls and any saving', async () => {
  const store = fixtures(), controller = new AbortController(); let calls = 0;
  const report = await analyze(input({ pipelines: ['a', 'b', 'c'].map(letter => pipeline(letter, 'asr-a', `translate-${letter}`)) }), {
    store, signal: controller.signal, speech: okSpeech,
    translation: async () => { calls++; controller.abort(); return okTranslation(); }
  });
  assert.equal(calls, 1); assert.equal(store.reports.length, 0);
  assert(report.results.every(r => r.status === 'error' && r.wer === null));
});

offlineTest('saving errors are visible while successful provider results are preserved', async () => {
  const store = fixtures(); store.saveReport = () => { throw new Error('Temporary storage failure'); };
  const report = await analyze(input(), { store, speech: okSpeech, translation: okTranslation });
  assert.equal(report.saved, false); assert.equal(report.results[0].status, 'ok');
});

async function localApp(t, overrides = {}) {
  const store = overrides.store || fixtures();
  const server = createApp({ store, speech: okSpeech, translation: okTranslation, ...overrides });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { server.stopAnalysis(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { server, store, port: server.address().port };
}
function localRequest(port, { method = 'GET', url = '/api/profiles', host, origin, body, onRequest } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host || `127.0.0.1:${port}` };
    if (origin !== null) headers.Origin = origin || `http://127.0.0.1:${port}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request({ hostname: '127.0.0.1', port, method, path: url, headers }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8'); resolve({ status: res.statusCode, body: JSON.parse(text) });
      });
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body)); onRequest?.(req);
  });
}

offlineTest('HTTP Host and Origin checks reject attempts before model invocation', async t => {
  let calls = 0;
  const { port } = await localApp(t, { speech: async () => { calls++; return okSpeech(); } });
  const attackCases = [
    { host: `evil.example:${port}` },
    { origin: 'https://evil.example' },
    { origin: null },
    { origin: `http://127.0.0.1:${port + 1}` }
  ];
  for (const headers of attackCases) {
    const response = await localRequest(port, { method: 'POST', url: '/api/analyze', body: input(), ...headers });
    assert.equal(response.status, 403);
  }
  assert.equal(calls, 0);
  assert.equal((await localRequest(port)).status, 200);
});

offlineTest('HTTP permits only one active analysis and stopAnalysis cancels it without translating or saving', async t => {
  const entered = deferred(); let translations = 0;
  const { server, store, port } = await localApp(t, {
    speech: async (_p, { signal }) => { entered.resolve(); await new Promise((resolve, reject) => { if (signal.aborted) reject(signal.reason); else signal.addEventListener('abort', () => reject(signal.reason), { once: true }); }); return okSpeech(); },
    translation: async () => { translations++; return okTranslation(); }
  });
  const first = localRequest(port, { method: 'POST', url: '/api/analyze', body: input() });
  await entered.promise;
  const second = await localRequest(port, { method: 'POST', url: '/api/analyze', body: input() });
  assert.equal(second.status, 409);
  server.stopAnalysis(); const response = await first;
  assert.equal(response.status, 200); assert.equal(response.body.results[0].status, 'error');
  assert.equal(translations, 0); assert.equal(store.reports.length, 0);
});

offlineTest('closing the browser HTTP request aborts upstream work and prevents saving', async t => {
  const entered = deferred(), aborted = deferred(); let outgoing;
  const { store, port } = await localApp(t, {
    speech: async (_p, { signal }) => { entered.resolve(); await new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted.resolve(); reject(signal.reason); }, { once: true })); return okSpeech(); }
  });
  const pending = localRequest(port, { method: 'POST', url: '/api/analyze', body: input(), onRequest: req => { outgoing = req; } }).catch(error => error);
  await entered.promise; outgoing.destroy(); await aborted.promise; await pending;
  assert.equal(store.reports.length, 0);
});

offlineTest('WER reports substitution, deletion and insertion counts correctly', () => {
  const reference = 'the bond price rose';
  assert.deepEqual(wordErrorRate(reference, 'the stock price rose'), { rate: 0.25, substitutions: 1, deletions: 0, insertions: 0, referenceWords: 4 });
  assert.deepEqual(wordErrorRate(reference, 'the price rose'), { rate: 0.25, substitutions: 0, deletions: 1, insertions: 0, referenceWords: 4 });
  assert.deepEqual(wordErrorRate(reference, 'the bond market price rose'), { rate: 0.25, substitutions: 0, deletions: 0, insertions: 1, referenceWords: 4 });
  assert.equal(wordErrorRate('THE bond’s price!', "the bond's price").rate, 0);
  assert.equal(wordErrorRate('...', 'words'), null);
  assert.deepEqual(wordErrorRate('one two', ''), { rate: 1, substitutions: 0, deletions: 2, insertions: 0, referenceWords: 2 });
});

offlineTest('WAV accepts exact 0.1 and 60 second limits and rejects over/under duration', () => {
  assert.equal(parseWav(wav(0.1)).duration, 0.1);
  assert.equal(parseWav(wav(60)).duration, 60);
  assert.throws(() => parseWav(wav(60 + 1 / 16000)), /0.1–60/);
  assert.throws(() => parseWav(wav(0.099)), /0.1–60/);
});

offlineTest('WAV rejects stereo, incorrect rate/bit depth, non-PCM and truncation', () => {
  for (const [offset, width, value] of [[22, 2, 2], [24, 4, 48000], [34, 2, 8], [20, 2, 3]]) {
    const bytes = wav(); if (width === 2) bytes.writeUInt16LE(value, offset); else bytes.writeUInt32LE(value, offset);
    assert.throws(() => parseWav(bytes), /PCM16/);
  }
  assert.throws(() => parseWav(wav().subarray(0, 100)), /不完整/);
  assert.throws(() => parseWav(Buffer.from('not audio')), /WAV/);
});

class TestStore extends Store { protect() {} }
function temporaryStore(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'classroom-api-lab-test-'));
  t.after(() => {
    // Verify the exact generated path remains under the intended temp root
    // before deleting it; never access the user's real configuration tree.
    const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
    assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    assert(path.basename(root).startsWith('classroom-api-lab-test-'));
    fs.rmSync(root, { recursive: true, force: true });
  });
  return new TestStore(root, () => ({ appId: 'fake-app', secretId: 'fake-id', secretKey: 'fake-tencent-test-key' }));
}
const customProfile = overrides => ({ label: 'Offline fixture', protocol: 'openai-chat', model: 'fixture-model', baseUrl: 'https://first.example/v1', apiKey: 'fake-unit-test-key-12345', thinkingOff: '', ...overrides });

offlineTest('Store uses real JSON format but list/save responses never reveal fake keys', t => {
  const store = temporaryStore(t); const created = store.save(customProfile());
  assert.equal(created.configured, true); assert.equal(created.hasApiKey, true);
  assert(!Object.hasOwn(created, 'apiKey'));
  assert(!JSON.stringify(store.list()).includes('fake-unit-test-key-12345'));
  assert(!JSON.stringify(store.list()).includes('fake-tencent-test-key'));
  const persisted = JSON.parse(fs.readFileSync(store.configFile, 'utf8'));
  assert(Array.isArray(persisted)); assert.equal(persisted.find(p => p.id === created.id).apiKey, 'fake-unit-test-key-12345');
  assert.equal(store.resolve(created.id).apiKey, 'fake-unit-test-key-12345');
});

offlineTest('Store preserves same-origin key edits but never carries an old key to a new host', t => {
  const store = temporaryStore(t); const created = store.save(customProfile());
  const sameHost = store.save(customProfile({ id: created.id, baseUrl: 'https://first.example/v2', apiKey: '' }));
  assert.equal(sameHost.hasApiKey, true); assert.equal(store.resolve(created.id).apiKey, 'fake-unit-test-key-12345');
  const changedHost = store.save(customProfile({ id: created.id, baseUrl: 'https://second.example/v1', apiKey: '' }));
  assert.equal(changedHost.hasApiKey, false); assert.equal(changedHost.configured, false); assert.equal(store.resolve(created.id).apiKey, '');
});

offlineTest('Store handles browser boolean thinking flags for Qwen and DeepSeek', t => {
  const store = temporaryStore(t);
  assert.equal(store.save(customProfile({ baseUrl: 'https://api.deepseek.com', thinkingOff: true })).thinkingOff, 'deepseek');
  assert.equal(store.save(customProfile({ baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', thinkingOff: true })).thinkingOff, 'qwen');
  assert.equal(store.save(customProfile({ thinkingOff: false })).thinkingOff, '');
});

offlineTest('Store refuses builtin mutation and unsafe key destinations', t => {
  const store = temporaryStore(t);
  assert.throws(() => store.remove('tencent-lite'), /不能删除/);
  assert.throws(() => store.save(customProfile({ id: 'tencent-lite' })), /内置/);
  for (const baseUrl of ['http://public.example', 'https://localhost', 'https://127.0.0.1', 'https://user:pass@public.example', 'https://public.example?key=fake']) assert.throws(() => store.save(customProfile({ baseUrl })));
});
