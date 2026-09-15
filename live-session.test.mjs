import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import http from 'node:http';
import WebSocket from 'ws';
import { attachLiveServer } from './live-session.mjs';
import { parseWav } from './audio.mjs';

// Pure offline tests: synthetic credentials and mocked cloud transports only.
const KEY = 'synthetic-live-key-never-a-real-secret';
const profiles = [
  { id: 'qwen', label: 'Qwen Realtime', protocol: 'qwen-asr-realtime', model: 'qwen3-asr-flash-realtime', baseUrl: 'https://test-space.cn-beijing.maas.aliyuncs.com', apiKey: KEY },
  { id: 'native', label: 'Qwen native', protocol: 'qwen-asr-native', model: 'qwen-audio-3.0-asr-flash', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: KEY },
  { id: 'native-stream', label: 'Qwen Native Live', protocol: 'qwen-asr-native-live', model: 'qwen-audio-3.0-asr-flash-streaming', baseUrl: 'https://dashscope.aliyuncs.com', apiKey: KEY },
  { id: 'chat-asr', label: 'Qwen chat ASR', protocol: 'qwen-asr-chat', model: 'qwen3-asr-flash', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: KEY },
  { id: 'tencent', label: 'Tencent', protocol: 'tencent-translation', model: 'hunyuan-translation-lite', baseUrl: 'https://asr.cloud.tencent.com', secretId: 'synthetic-id', secretKey: KEY, appId: '123' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai-chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: KEY },
  { id: 'qwen-text', label: 'Qwen Plus', protocol: 'openai-chat', model: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: KEY },
];
const textType = 'conversation.item.input_audio_transcription.text';
const finalType = 'conversation.item.input_audio_transcription.completed';
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
class Socket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.bufferedAmount = 0; this.sent = []; this.terminated = 0; this.closed = 0; }
  send(data, callback) { this.sent.push(JSON.parse(data)); callback?.(this.sendError); }
  event(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
  pcm(bytes) { this.emit('message', bytes, true); }
  close() { this.closed++; this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated++; this.readyState = 3; this.emit('error', new Error(`transport error ${KEY}`)); this.emit('close'); }
}
function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const sockets = [], calls = [], resolves = [];
  class Upstream extends Socket {
    constructor(url, settings) { super(); this.readyState = 0; this.url = url; this.settings = settings; sockets.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
  }
  class ServerSocket {
    constructor(settings) { this.settings = settings; }
    handleUpgrade(req, raw, head, callback) { callback(raw.client); }
    close() {}
  }
  const server = new EventEmitter(); server.address = () => ({ port: 8766 });
  const store = {
    list: () => profiles.map(p => ({ id: p.id, label: p.label, protocol: p.protocol, configured: true })),
    resolve: id => { resolves.push(id); return profiles.find(p => p.id === id); },
  };
  const service = attachLiveServer(server, { store, WebSocketImpl: Upstream, WebSocketServerImpl: ServerSocket,
    pacingNow: () => Date.now(),
    financeReference: () => ({ glossary: 'bond = 债券', context: 'Finance lecture', rules: ['Preserve financial qualifiers.'] }),
    translateImpl: async (profile, sample) => { calls.push({ kind: 'translation', profile, sample }); return { target: '中文译文' }; },
    transcribeImpl: async (profile, sample) => { calls.push({ kind: 'asr', profile, sample }); return { source: 'English sentence.', target: '腾讯译文' }; },
    ...options });
  function connect(overrides = {}) {
    const client = new Socket();
    const raw = { client, written: '', destroyed: false, write(value) { this.written += value; }, destroy() { this.destroyed = true; } };
    const req = { method: 'GET', url: '/api/live', headers: { host: '127.0.0.1:8766', origin: 'http://127.0.0.1:8766' },
      socket: { remoteAddress: '127.0.0.1' }, ...overrides };
    server.emit('upgrade', req, raw, Buffer.alloc(0)); return { client, raw };
  }
  const { client } = connect();
  const start = (input = {}) => client.event({ type: 'start', asrId: 'qwen', translationId: 'deepseek', maxMinutes: 45, ...input });
  const ready = (input = {}) => {
    start(input);
    const socket = sockets.at(-1);
    if (input.asrId === undefined || input.asrId === 'qwen') { socket.open(); socket.event({ type: 'session.updated' }); }
    return socket;
  };
  t.after(() => service.close());
  return { server, service, sockets, calls, resolves, connect, client, start, ready };
}
function speech(bytes = 3200) {
  const pcm = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += 2) pcm.writeInt16LE(i % 4 ? 1000 : -1000, i);
  return pcm;
}
function finishItem(socket, number, text = `English ${number}.`) {
  socket.event({ type: 'conversation.item.created', item: { id: `remote-${number}` } });
  socket.event({ type: finalType, item_id: `remote-${number}`, content_index: 0, transcript: text });
}

function nativeFixture(t, options = {}) {
  const streams = [];
  const f = fixture(t, {
    nativeLiveFactory(profile, callbacks) {
      const handle = { profile, callbacks, pcm: [], finishCalls: 0, closeCalls: 0,
        sendPCM(bytes) { this.pcm.push(Buffer.from(bytes)); return this.sendResult !== false; },
        finish() { this.finishCalls++; return this.finishResult !== false; },
        close() { this.closeCalls++; },
      };
      streams.push(handle); return handle;
    },
    ...options,
  });
  const startNative = (input = {}) => { f.start({ asrId: 'native-stream', ...input }); return streams.at(-1); };
  const readyNative = (input = {}) => { const stream = startNative(input); stream.callbacks.onReady(); return stream; };
  return { ...f, streams, startNative, readyNative };
}

test('native live waits for ready, forwards paced PCM, and receives financial hints only on the server', t => {
  const f = nativeFixture(t); const native = f.startNative({ glossary: 'yield = 收益率', context: 'Duration lecture' });
  assert.equal(native.profile.id, 'native-stream'); assert.equal(native.profile.apiKey, KEY);
  assert.match(native.callbacks.glossary, /yield = 收益率\nbond = 债券/);
  assert.match(native.callbacks.context, /Finance lecture\nDuration lecture/);
  assert.equal(f.client.sent.length, 0); assert.equal(native.pcm.length, 0); assert.equal(f.sockets.length, 0);
  native.callbacks.onReady();
  assert.deepEqual(f.client.sent[0], { type: 'ready', mode: 'streaming', asrLabel: 'Qwen Native Live', translationLabel: 'DeepSeek' });
  const pcm = speech(6400); f.client.pcm(pcm);
  assert.equal(native.pcm.length, 1); assert.deepEqual(native.pcm[0], pcm.subarray(0, 3200));
  t.mock.timers.tick(100); assert.equal(native.pcm.length, 2); assert.deepEqual(Buffer.concat(native.pcm), pcm);
  assert.equal(native.finishCalls, 0); assert.equal(f.calls.length, 0);
  assert(!JSON.stringify(f.client.sent).includes(KEY));
});

test('native live rejects early PCM and ignores a late ready after cancellation', t => {
  const f = nativeFixture(t); const native = f.startNative();
  f.client.pcm(speech());
  assert.equal(native.pcm.length, 0); assert.equal(native.closeCalls, 1); assert.equal(native.callbacks.signal.aborted, true);
  assert.equal(f.client.sent.some(e => e.type === 'error'), true);
  const count = f.client.sent.length; native.callbacks.onReady(); assert.equal(f.client.sent.length, count);
});

test('native live keeps stable sentence IDs across partials, finals and cumulative Chinese updates', async t => {
  const pending = [];
  const f = nativeFixture(t, { translateImpl: (profile, sample) => new Promise(resolve => pending.push({ profile, sample, resolve })) });
  const native = f.readyNative();
  native.callbacks.onPartial({ id: 'provider-a', source: 'The y' });
  native.callbacks.onPartial({ id: 'provider-a', source: 'The yield rises.' });
  native.callbacks.onFinal({ id: 'provider-a', source: 'The yield rises.' });
  native.callbacks.onFinal({ id: 'provider-a', source: 'The yield rises.' });
  native.callbacks.onPartial({ id: 'provider-b', source: 'The price' });
  native.callbacks.onFinal({ id: 'provider-b', source: 'The price falls.' });
  await flush(); assert.equal(pending.length, 2);
  const partials = f.client.sent.filter(e => e.type === 'partial'); const finals = f.client.sent.filter(e => e.type === 'final');
  assert.deepEqual(partials.map(e => e.source), ['The y', 'The yield rises.', 'The price']);
  assert.equal(partials[0].id, partials[1].id); assert.equal(partials[0].id, finals[0].id);
  assert.equal(partials[2].id, finals[1].id); assert.notEqual(finals[0].id, finals[1].id);
  assert.equal(finals.length, 2);
  pending[1].sample.onText('价格'); pending[0].sample.onText('收益率');
  pending[1].resolve({ target: '价格下跌。' }); pending[0].resolve({ target: '收益率上升。' }); await flush();
  const translations = f.client.sent.filter(e => e.type === 'translation');
  assert.deepEqual(translations.slice(0, 2), [
    { type: 'translation', id: finals[1].id, target: '价格', done: false },
    { type: 'translation', id: finals[0].id, target: '收益率', done: false },
  ]);
  assert.equal(translations.filter(e => e.done === true).length, 2);
  assert.equal(native.closeCalls, 0);
});

test('native live stop drains accepted PCM once and waits for provider finished plus translation', async t => {
  let release;
  const f = nativeFixture(t, { translateImpl: () => new Promise(resolve => { release = resolve; }) });
  const native = f.readyNative(); f.client.pcm(speech(6400)); f.client.event({ type: 'stop' });
  f.client.pcm(speech(3200));
  assert.equal(native.finishCalls, 0);
  t.mock.timers.tick(100); t.mock.timers.tick(100);
  assert.equal(native.finishCalls, 1); assert.equal(Buffer.concat(native.pcm).length, 6400);
  assert.equal(f.client.sent.some(e => e.type === 'stopped'), false);
  native.callbacks.onFinal({ id: 'tail', source: 'Final accepted sentence.' }); await flush();
  native.callbacks.onFinished();
  assert.equal(f.client.sent.some(e => e.type === 'stopped'), false);
  release({ target: '最后一句。' }); await flush();
  assert.equal(f.client.sent.filter(e => e.type === 'stopped').length, 1);
  assert.equal(native.closeCalls, 1); assert.equal(native.callbacks.signal.aborted, true);
});

test('native live disconnect closes pending/ready handles and aborts translations without late output', async t => {
  for (const ready of [false, true]) await t.test(String(ready), async t => {
    let pending;
    const f = nativeFixture(t, { translateImpl: (_profile, sample) => new Promise(resolve => { pending = { sample, resolve }; }) });
    const native = ready ? f.readyNative() : f.startNative();
    if (ready) { native.callbacks.onFinal({ id: 'speech', source: 'Still translating.' }); await flush(); }
    f.client.close(); const count = f.client.sent.length;
    assert.equal(native.closeCalls, 1); assert.equal(native.callbacks.signal.aborted, true);
    native.callbacks.onReady(); native.callbacks.onPartial({ id: 'late', source: 'Must not display.' }); native.callbacks.onFinal({ id: 'late', source: 'Must not translate.' }); native.callbacks.onFinished();
    if (pending) { assert.equal(pending.sample.signal.aborted, true); pending.sample.onText('不能显示'); pending.resolve({ target: '不能显示' }); }
    await flush(); assert.equal(f.client.sent.length, count);
  });
});

test('native live initialization failure and setup timeout release handles and expose no diagnostics', async t => {
  for (const kind of ['error', 'timeout', 'throw']) await t.test(kind, t => {
    if (kind === 'throw') {
      const f = fixture(t, { nativeLiveFactory() { throw new Error(`provider ${KEY}`); } });
      f.start({ asrId: 'native-stream' });
      assert.equal(f.client.sent.some(e => e.type === 'error'), true); assert(!JSON.stringify(f.client.sent).includes(KEY));
      return;
    }
    const f = nativeFixture(t); const native = f.startNative();
    if (kind === 'error') native.callbacks.onError(new Error(`provider ${KEY}`));
    else t.mock.timers.tick(15000);
    assert.equal(native.closeCalls, 1); assert.equal(native.callbacks.signal.aborted, true);
    assert.equal(f.client.sent.some(e => e.type === 'error'), true); assert(!JSON.stringify(f.client.sent).includes(KEY));
  });
});

test('native live synchronous ready is not subsequently killed by an initialization timer', t => {
  const f = fixture(t, { nativeLiveFactory(_profile, callbacks) {
    callbacks.onReady();
    return { sendPCM: () => true, finish: () => true, close() {} };
  } });
  f.start({ asrId: 'native-stream' });
  assert.equal(f.client.sent.filter(e => e.type === 'ready').length, 1);
  t.mock.timers.tick(15000);
  assert.equal(f.client.sent.some(e => e.type === 'error'), false);
});

test('native live synchronous initialization error still closes the returned handle', t => {
  let closed = 0;
  const f = fixture(t, { nativeLiveFactory(_profile, callbacks) {
    callbacks.onError(new Error(`provider ${KEY}`));
    return { sendPCM: () => true, finish: () => true, close() { closed++; } };
  } });
  f.start({ asrId: 'native-stream' });
  assert.equal(closed, 1); assert.equal(f.client.sent.some(e => e.type === 'error'), true);
  assert(!JSON.stringify(f.client.sent).includes(KEY));
});

test('native live failed send/finish and premature provider finish terminate safely', async t => {
  for (const kind of ['send', 'finish', 'premature']) await t.test(kind, t => {
    const f = nativeFixture(t); const native = f.readyNative();
    if (kind === 'send') { native.sendResult = false; f.client.pcm(speech()); }
    else if (kind === 'finish') { native.finishResult = false; f.client.event({ type: 'stop' }); }
    else native.callbacks.onFinished();
    assert.equal(f.client.sent.some(e => e.type === 'error'), true); assert.equal(native.closeCalls, 1);
    assert.equal(native.callbacks.signal.aborted, true);
  });
});

test('Qwen streams PCM only after session.updated and uses continuous VAD', t => {
  const f = fixture(t); f.start();
  const up = f.sockets[0];
  assert.equal(up.url, 'wss://test-space.cn-beijing.maas.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime');
  assert.equal(up.settings.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(up.settings.followRedirects, false);
  up.open();
  assert.equal(f.client.sent.length, 0);
  assert.deepEqual(up.sent[0].session, { modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000,
    input_audio_transcription: { language: 'en' }, turn_detection: { type: 'server_vad', threshold: 0.0, silence_duration_ms: 600 } });
  up.event({ type: 'session.updated' });
  assert.deepEqual(f.client.sent[0], { type: 'ready', mode: 'streaming', asrLabel: 'Qwen Realtime', translationLabel: 'DeepSeek' });
  f.client.pcm(speech(6400));
  assert.equal(up.sent.filter(e => e.audio).length, 1);
  t.mock.timers.tick(100);
  assert.equal(up.sent.filter(e => e.audio).length, 2);
  assert.equal(up.sent.some(e => e.type === 'input_audio_buffer.commit'), false);
  assert.equal(up.sent.some(e => e.type === 'session.finish'), false);
});

test('partials replace text+stash; only completed sentences call the chosen translator once', async t => {
  const f = fixture(t); const up = f.ready({ translationId: 'qwen-text', glossary: 'yield = 收益率', context: 'Bond pricing' });
  up.event({ type: textType, item_id: 'a', text: 'The y', stash: 'ield' });
  up.event({ type: textType, item_id: 'a', text: 'The yield', stash: ' rises.' });
  assert.deepEqual(f.client.sent.filter(e => e.type === 'partial').map(e => e.source), ['The yield', 'The yield rises.']);
  assert.equal(f.calls.length, 0);
  const event = { type: finalType, item_id: 'a', transcript: 'The yield rises.' };
  up.event(event); up.event(event); await flush();
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.profile.id, 'qwen-text');
  assert.equal(call.sample.source, 'The yield rises.');
  assert.match(call.sample.glossary, /yield = 收益率\nbond = 债券/);
  assert.match(call.sample.context, /Finance lecture\nBond pricing/);
  assert.deepEqual(call.sample.domainRules, ['Preserve financial qualifiers.']);
  const final = f.client.sent.find(e => e.type === 'final');
  assert.equal(final.translationStatus, 'pending');
  assert.equal(f.client.sent.find(e => e.type === 'translation').id, final.id);
  assert.equal(up.terminated, 0, 'continuous upstream remains open after each sentence');
});

test('Chinese streams by sentence ID before completion and ignores callbacks after disconnect', async t => {
  const pending = [];
  const f = fixture(t, { translateImpl: (profile, sample) => new Promise(resolve => pending.push({ sample, resolve })) });
  const up = f.ready();
  finishItem(up, 1, 'The yield rises.'); finishItem(up, 2, 'The price falls.'); await flush();
  pending[1].sample.onText('价格'); pending[0].sample.onText('收益率');
  assert.deepEqual(f.client.sent.filter(e => e.type === 'translation'), [
    { type: 'translation', id: 'sentence-2', target: '价格', done: false },
    { type: 'translation', id: 'sentence-1', target: '收益率', done: false },
  ]);
  pending[1].resolve({ target: '价格下跌。' }); await flush();
  assert.deepEqual(f.client.sent.filter(e => e.type === 'translation').at(-1),
    { type: 'translation', id: 'sentence-2', target: '价格下跌。', done: true });
  f.client.close(); const count = f.client.sent.length;
  pending[0].sample.onText('收益率上升。'); pending[0].resolve({ target: '收益率上升。' }); await flush();
  assert.equal(f.client.sent.length, count);
});

test('maas missing item IDs keep partial and final on one row and create distinct later rows', async t => {
  const f = fixture(t); const up = f.ready();
  for (let i = 1; i <= 2; i++) {
    up.event({ type: textType, text: `Sentence ${i}`, stash: '.' });
    up.event({ type: 'input_audio_buffer.committed', event_id: `commit-${i}` });
    up.event({ type: 'conversation.item.created', item: { id: `r-${i}`, status: 'completed', content: [{ transcript: null }] } });
    const completed = { event_id: `final-${i}`, type: finalType, content_index: 0, transcript: `Sentence ${i}.`, language: 'en', emotion: 'neutral', usage: { seconds: 1 } };
    up.event(completed); up.event(completed);
  }
  await flush();
  const partials = f.client.sent.filter(e => e.type === 'partial'), finals = f.client.sent.filter(e => e.type === 'final');
  assert.equal(finals.length, 2);
  assert.equal(partials[0].id, finals[0].id); assert.equal(partials[1].id, finals[1].id);
  assert.notEqual(finals[0].id, finals[1].id);
  assert.equal(f.calls.length, 2);
});

test('fully anonymous created events bind existing partials and submitted sentence wins over new recording', t => {
  const f = fixture(t); const up = f.ready({ translationId: 'none' });
  up.event({ type: 'input_audio_buffer.speech_started' });
  up.event({ type: textType, text: 'First', stash: '.' });
  up.event({ type: 'input_audio_buffer.speech_stopped' });
  up.event({ type: 'conversation.item.created', item: { status: 'completed' } });
  assert.equal(f.client.sent.filter(e => e.type === 'final').length, 0);
  up.event({ type: 'input_audio_buffer.speech_started' });
  up.event({ type: finalType, transcript: 'First.' });
  up.event({ type: textType, text: 'Second', stash: '.' });
  up.event({ type: 'input_audio_buffer.speech_stopped' });
  up.event({ type: 'conversation.item.created', item: {} });
  up.event({ type: finalType, transcript: 'Second.' });
  assert.deepEqual(f.client.sent.filter(e => e.type === 'final').map(e => e.source), ['First.', 'Second.']);
  assert.equal(f.client.sent.some(e => e.type === 'error'), false);
});

test('ambiguous missing IDs and explicitly invalid IDs fail closed', async t => {
  for (const bad of ['ambiguous', '', null, 42]) await t.test(String(bad), t => {
    const f = fixture(t); const up = f.ready();
    up.event({ type: 'conversation.item.created', item: { id: 'a' } });
    if (bad === 'ambiguous') {
      up.event({ type: 'conversation.item.created', item: { id: 'b' } });
      up.event({ type: finalType, transcript: 'Unknown sentence.' });
    } else up.event({ type: finalType, item_id: bad, transcript: 'Invalid identifier.' });
    assert.equal(f.client.sent.some(e => e.type === 'error'), true);
    assert.equal(up.terminated, 1);
    assert.equal(f.calls.length, 0);
  });
});

test('normal stop flushes only accepted PCM, sends session.finish, waits for final and translation', async t => {
  let release;
  const f = fixture(t, { translateImpl: () => new Promise(resolve => { release = resolve; }) });
  const up = f.ready(); f.client.pcm(speech(6400)); f.client.event({ type: 'stop' });
  f.client.pcm(speech(3200));
  assert.equal(up.sent.some(e => e.type === 'session.finish'), false);
  t.mock.timers.tick(100); t.mock.timers.tick(100);
  assert.equal(up.sent.filter(e => e.audio).length, 2);
  assert.equal(up.sent.at(-1).type, 'session.finish');
  finishItem(up, 1); up.event({ type: 'session.finished' }); await flush();
  assert.equal(up.terminated, 1, 'upstream ends promptly without waiting on translator');
  assert.equal(f.client.sent.some(e => e.type === 'stopped'), false);
  release({ target: '收尾译文' }); await flush();
  assert.equal(f.client.sent.at(-1).type, 'stopped');
  assert.equal(f.client.sent.at(-2).target, '收尾译文');
  assert.equal(f.client.closed, 1);
});

test('stop closes a CONNECTING upstream immediately without waiting for paid setup', t => {
  const f = fixture(t); f.start(); const up = f.sockets[0];
  f.client.event({ type: 'stop' });
  assert.equal(up.terminated, 1);
  up.open(); assert.equal(up.sent.length, 0);
  assert.equal(f.client.sent.at(-1).type, 'stopped');
});

test('stop has a hard ten-second budget and aborts uncompleted translations', async t => {
  let signal;
  const f = fixture(t, { translateImpl: (profile, sample) => { signal = sample.signal; return new Promise(() => {}); } });
  const up = f.ready(); finishItem(up, 1); await flush();
  f.client.event({ type: 'stop' });
  t.mock.timers.tick(9999); assert.equal(up.terminated, 0);
  t.mock.timers.tick(1); await flush();
  assert.equal(up.terminated, 1); assert.equal(signal.aborted, true);
  assert.equal(f.client.sent.at(-1).type, 'stopped');
});

test('disconnect aborts translation and both OPEN and CONNECTING upstreams', async t => {
  for (const connecting of [false, true]) await t.test(String(connecting), async t => {
    let signal;
    const f = fixture(t, { translateImpl: (p, s) => { signal = s.signal; return new Promise(() => {}); } });
    if (connecting) f.start(); else { const up = f.ready(); finishItem(up, 1); await flush(); }
    const up = f.sockets[0]; f.client.close(); await flush();
    assert.equal(up.terminated, 1);
    if (signal) assert.equal(signal.aborted, true);
    const before = f.client.sent.length;
    up.event({ type: finalType, transcript: 'Late result.' });
    assert.equal(f.client.sent.length, before);
  });
});

test('non-realtime ASR receives the same PCM and segments on a pause with valid WAV', async t => {
  const f = fixture(t); f.ready({ asrId: 'native', translationId: 'deepseek' });
  assert.equal(f.client.sent[0].mode, 'segmented');
  for (let i = 0; i < 4; i++) { f.client.pcm(speech()); t.mock.timers.tick(100); }
  for (let i = 0; i < 7; i++) { f.client.pcm(Buffer.alloc(3200)); t.mock.timers.tick(100); }
  await flush();
  const call = f.calls.find(c => c.kind === 'asr');
  assert.ok(call); assert.equal(call.profile.id, 'native');
  assert.ok(call.sample.duration >= 1 && call.sample.duration <= 1.1);
  assert.deepEqual(parseWav(call.sample.wav).pcm, call.sample.pcm);
  assert.equal(f.calls.filter(c => c.kind === 'translation').length, 1);
  assert.equal(f.sockets.length, 0);
});

test('Qwen chat keeps audio below five seconds even through a long pause', async t => {
  const f = fixture(t); f.ready({ asrId: 'chat-asr', translationId: 'none' });
  assert.equal(f.client.sent[0].mode, 'segmented');
  for (let i = 0; i < 4; i++) { f.client.pcm(speech()); t.mock.timers.tick(100); }
  for (let i = 0; i < 45; i++) { f.client.pcm(Buffer.alloc(3200)); t.mock.timers.tick(100); }
  f.client.pcm(Buffer.alloc(2560)); t.mock.timers.tick(80);
  await flush();
  assert.equal(f.calls.length, 0, '4.98 seconds of audio must remain buffered despite 4.58 seconds of silence');
  assert.equal(f.client.sent.some(e => e.type === 'final' || e.type === 'error'), false);
  assert.equal(f.sockets.length, 0);
});

test('Qwen chat submits after five seconds and 660 ms silence with intact WAV and finance hints', async t => {
  const f = fixture(t); f.ready({ asrId: 'chat-asr', translationId: 'deepseek', glossary: 'yield = 收益率', context: 'Bond pricing' });
  const chunks = [];
  for (let i = 0; i < 44; i++) {
    const pcm = speech(); chunks.push(pcm); f.client.pcm(pcm); t.mock.timers.tick(100);
  }
  const quiet = Buffer.alloc(20480); chunks.push(quiet); f.client.pcm(quiet); t.mock.timers.tick(640);
  await flush();
  assert.equal(f.calls.length, 0, '5.04 seconds of audio with only 640 ms silence must remain buffered');
  const boundary = Buffer.alloc(640); chunks.push(boundary); f.client.pcm(boundary); t.mock.timers.tick(20);
  await flush();
  const asrCalls = f.calls.filter(c => c.kind === 'asr');
  assert.equal(asrCalls.length, 1);
  const call = asrCalls[0];
  assert.equal(call.profile.id, 'chat-asr'); assert.equal(call.sample.duration, 5.06);
  assert.deepEqual(call.sample.pcm, Buffer.concat(chunks));
  assert.deepEqual(parseWav(call.sample.wav).pcm, call.sample.pcm);
  assert.match(call.sample.glossary, /yield = 收益率\nbond = 债券/);
  assert.match(call.sample.context, /Finance lecture\nBond pricing/);
  assert.equal(f.calls.filter(c => c.kind === 'translation').length, 1);
  assert.equal(f.sockets.length, 0);
});

test('Qwen chat caps continuous speech at eight seconds', async t => {
  const f = fixture(t); f.ready({ asrId: 'chat-asr', translationId: 'none' });
  const pcm = speech();
  for (let i = 0; i < 79; i++) { f.client.pcm(pcm); t.mock.timers.tick(100); }
  await flush(); assert.equal(f.calls.length, 0);
  f.client.pcm(pcm); t.mock.timers.tick(100); await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].profile.id, 'chat-asr');
  assert.equal(f.calls[0].sample.duration, 8);
  assert.deepEqual(f.calls[0].sample.pcm, Buffer.concat(Array(80).fill(pcm)));
  assert.equal(f.client.sent.filter(e => e.type === 'final').length, 1);
});

test('Qwen chat stop submits a short voiced tail exactly once', async t => {
  const f = fixture(t); f.ready({ asrId: 'chat-asr', translationId: 'none' });
  const pcm = speech(16000); f.client.pcm(pcm); t.mock.timers.tick(500);
  await flush(); assert.equal(f.calls.length, 0);
  f.client.event({ type: 'stop' }); f.client.event({ type: 'stop' }); f.client.pcm(speech());
  await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].profile.id, 'chat-asr');
  assert.equal(f.calls[0].sample.duration, 0.5); assert.deepEqual(f.calls[0].sample.pcm, pcm);
  assert.deepEqual(parseWav(f.calls[0].sample.wav).pcm, pcm);
  assert.equal(f.client.sent.filter(e => e.type === 'final').length, 1);
  assert.equal(f.client.sent.filter(e => e.type === 'stopped').length, 1);
});

test('continuous speech segments at eight seconds and Tencent built-in translation bypasses text API', async t => {
  const f = fixture(t); f.ready({ asrId: 'tencent', translationId: 'builtin' });
  for (let i = 0; i < 80; i++) { f.client.pcm(speech()); t.mock.timers.tick(100); }
  await flush();
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].sample.duration, 8);
  const final = f.client.sent.find(e => e.type === 'final');
  assert.equal(final.target, '腾讯译文'); assert.equal(final.translationStatus, 'done');
});

test('silence makes no segmented API requests and stop preserves a short voiced tail', async t => {
  const f = fixture(t); f.ready({ asrId: 'native', translationId: 'none' });
  for (let i = 0; i < 20; i++) { f.client.pcm(Buffer.alloc(3200)); t.mock.timers.tick(100); }
  await flush(); assert.equal(f.calls.length, 0);
  f.client.pcm(speech(1600)); f.client.event({ type: 'stop' }); await flush();
  assert.equal(f.calls.length, 1); assert.ok(f.calls[0].sample.duration >= 0.1);
  assert.equal(f.client.sent.at(-1).type, 'stopped');
});

test('segmented stop/disconnect propagates abort to an in-flight ASR request', async t => {
  let signal;
  const f = fixture(t, { transcribeImpl: (p, s) => { signal = s.signal; return new Promise(() => {}); } });
  f.ready({ asrId: 'native' }); f.client.pcm(speech()); f.client.event({ type: 'stop' }); await flush();
  assert.ok(signal); f.client.close(); await flush(); assert.equal(signal.aborted, true);
});

test('translation errors preserve the English final without exposing provider bodies', async t => {
  const f = fixture(t, { translateImpl: async () => { throw new Error(`provider body with ${KEY}`); } });
  const up = f.ready(); finishItem(up, 1); await flush();
  assert.equal(f.client.sent.some(e => e.type === 'final' && e.translationStatus === 'error' && e.source === 'English 1.'), true);
  assert.equal(up.terminated, 0); assert.equal(JSON.stringify(f.client.sent).includes(KEY), false);
});

test('session wall-clock and PCM-duration caps terminate upstream', async t => {
  for (const byAudio of [false, true]) await t.test(String(byAudio), t => {
    const f = fixture(t, { limits: { maxSessionMs: 1000 } }); const up = f.ready();
    if (byAudio) { f.client.pcm(speech(32000)); f.client.pcm(speech(2)); }
    else t.mock.timers.tick(1000);
    assert.equal(up.terminated, 1); assert.equal(f.client.sent.at(-1).type, 'stopped');
  });
});

test('rejects audio before readiness, invalid frame shapes, and faster-than-realtime bursts', async t => {
  for (const scenario of ['early', 'odd', 'large', 'burst']) await t.test(scenario, t => {
    const f = fixture(t);
    if (scenario === 'early') f.start(); else f.ready();
    if (scenario === 'early') f.client.pcm(speech());
    if (scenario === 'odd') f.client.pcm(Buffer.alloc(3));
    if (scenario === 'large') f.client.pcm(Buffer.alloc(32770));
    if (scenario === 'burst') { f.client.pcm(speech(32000)); f.client.pcm(speech(32000)); f.client.pcm(speech()); }
    assert.equal(f.sockets[0].terminated, 1);
  });
});

test('bounded audio buffer and transport backpressure shut down without dropping speech silently', async t => {
  for (const scenario of ['queue', 'upstream', 'client']) await t.test(scenario, t => {
    const f = fixture(t, { limits: { audioQueueBytes: 3200, bufferedBytes: 1024 } }); const up = f.ready();
    if (scenario === 'queue') f.client.pcm(speech(6400));
    if (scenario === 'upstream') { up.bufferedAmount = 1025; f.client.pcm(speech()); }
    if (scenario === 'client') { f.client.bufferedAmount = 1025; up.event({ type: textType, text: 'Hello' }); }
    assert.equal(up.terminated, 1);
  });
});

test('translation queue and parallelism are bounded, aborting all work on overflow', async t => {
  const signals = [];
  const f = fixture(t, { limits: { translationQueue: 3 }, translateImpl: (p, s) => { signals.push(s.signal); return new Promise(() => {}); } });
  const up = f.ready(); for (let i = 1; i <= 3; i++) finishItem(up, i); await flush();
  assert.equal(signals.length, 2);
  finishItem(up, 4); await flush();
  assert.equal(up.terminated, 1); assert.equal(signals.every(s => s.aborted), true);
});

test('segmented ASR queue is bounded and overflow aborts the active request', async t => {
  let signal;
  const f = fixture(t, { limits: { segmentSeconds: 0.2, segmentQueue: 2 }, transcribeImpl: (p, s) => { signal = s.signal; return new Promise(() => {}); } });
  f.ready({ asrId: 'native' });
  for (let i = 0; i < 4; i++) { f.client.pcm(speech()); t.mock.timers.tick(100); }
  await flush();
  for (let i = 0; i < 2; i++) { f.client.pcm(speech()); t.mock.timers.tick(100); }
  await flush(); assert.equal(signal.aborted, true); assert.equal(f.client.sent.at(-1).type, 'stopped');
});

test('idle and setup deadlines prevent orphan paid sockets', async t => {
  for (const scenario of ['setup', 'idle', 'no-start']) await t.test(scenario, t => {
    const f = fixture(t, { limits: { setupMs: 100, idleMs: 100, startMs: 100 } });
    if (scenario === 'setup') f.start(); else if (scenario === 'idle') f.ready();
    t.mock.timers.tick(100);
    if (f.sockets[0]) assert.equal(f.sockets[0].terminated, 1);
    assert.equal(f.client.sent.at(-1).type, 'stopped');
  });
});

test('bad controls, unknown profiles, invalid translator choices and excessive duration never call providers', async t => {
  for (const input of [{ asrId: 'missing' }, { translationId: 'native' }, { translationId: 'builtin' }, { maxMinutes: 121 }, { glossary: 'x'.repeat(3001) }]) await t.test(JSON.stringify(input).slice(0, 50), t => {
    const f = fixture(t); f.start(input);
    assert.equal(f.sockets.length, 0); assert.equal(f.calls.length, 0);
    assert.equal(f.client.sent.at(-1).type, 'stopped');
  });
});

test('client cannot supply keys or endpoints, and no outgoing event contains credentials', t => {
  const f = fixture(t); const up = f.ready({ apiKey: 'injected-key', baseUrl: 'https://evil.example', model: 'evil-model' });
  assert.equal(up.settings.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(new URL(up.url).hostname, 'test-space.cn-beijing.maas.aliyuncs.com');
  up.event({ type: 'error', error: { message: `${KEY} private response` } });
  assert.equal(JSON.stringify(f.client.sent).includes(KEY), false);
  assert.deepEqual(f.resolves, ['qwen', 'deepseek']);
});

test('Qwen credentials cannot be sent to arbitrary hosts or redirected origins', async t => {
  for (const baseUrl of ['https://evil.example', 'https://dashscope.aliyuncs.com.evil.example', 'https://x.cn-beijing.maas.aliyuncs.com@evil.example', 'https://dashscope.aliyuncs.com/path']) await t.test(baseUrl, t => {
    const store = { list: () => [{ ...profiles[0], configured: true }], resolve: () => ({ ...profiles[0], baseUrl }) };
    const f = fixture(t, { store }); f.start({ translationId: 'none' });
    assert.equal(f.sockets.length, 0); assert.equal(f.client.sent.at(-1).type, 'stopped');
  });
});

test('upgrade requires a loopback peer and exact Host-matching local Origin', async t => {
  for (const req of [
    { headers: { host: '127.0.0.1:8766' } },
    { headers: { host: '127.0.0.1:8766', origin: 'https://evil.example' } },
    { headers: { host: '127.0.0.1:8766', origin: 'http://localhost:8766' } },
    { headers: { host: 'evil.example:8766', origin: 'http://evil.example:8766' } },
    { socket: { remoteAddress: '10.0.0.2' } }, { url: '/api/live?apiKey=bad' }, { url: '/other' },
  ]) await t.test(JSON.stringify(req), t => {
    const f = fixture(t); const { raw } = f.connect(req);
    assert.equal(raw.destroyed, true); assert.match(raw.written, /403 Forbidden/);
  });
});

test('single active classroom prevents duplicate upstream sessions; close removes listeners and aborts', t => {
  const f = fixture(t); const up = f.ready();
  const { client: second } = f.connect(); second.event({ type: 'start', asrId: 'qwen', translationId: 'none' });
  assert.equal(f.sockets.length, 1); assert.equal(second.sent.at(-1).type, 'stopped');
  f.service.close(); assert.equal(up.terminated, 1); assert.equal(f.server.listenerCount('upgrade'), 0);
});

test('real ws local upgrade rejects missing Origin and accepts same-origin PCM session', async t => {
  const server = http.createServer();
  const store = { list: () => [{ ...profiles[1], configured: true }], resolve: () => profiles[1] };
  const service = attachLiveServer(server, { store, transcribeImpl: async () => ({ source: 'Offline mock.' }) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { service.close(); server.close(); });
  const denied = new WebSocket(origin.replace('http:', 'ws:') + '/api/live');
  denied.on('error', () => {});
  const [, response] = await once(denied, 'unexpected-response');
  assert.equal(response.statusCode, 403); response.resume(); denied.terminate();
  const client = new WebSocket(origin.replace('http:', 'ws:') + '/api/live', { origin });
  client.on('error', () => {}); await once(client, 'open');
  client.send(JSON.stringify({ type: 'start', asrId: 'native', translationId: 'none' }));
  const [data] = await once(client, 'message');
  assert.equal(JSON.parse(data).mode, 'segmented');
  client.send(JSON.stringify({ type: 'stop' })); await once(client, 'close');
});
