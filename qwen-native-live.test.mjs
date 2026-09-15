import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createQwenNativeLive, transcribeNativeLive, qwenNativeLiveEndpoint,
  QWEN_NATIVE_REALTIME_MODEL } from './qwen-native-live.mjs';

const profile = { model: QWEN_NATIVE_REALTIME_MODEL, apiKey: 'mock-secret',
  baseUrl: 'https://workspace-123.cn-beijing.maas.aliyuncs.com/api/v1' };
class FakeSocket extends EventEmitter {
  static instances = [];
  constructor(url, options) {
    super(); this.url = url; this.options = options; this.readyState = 0;
    this.bufferedAmount = 0; this.sent = []; this.terminated = 0;
    FakeSocket.instances.push(this);
  }
  open() { this.readyState = 1; this.emit('open'); }
  send(data, options, callback) { this.sent.push({ data, options, at: performance.now() }); callback?.(); }
  close() { this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated++; this.readyState = 3; this.emit('close'); }
  command() { return JSON.parse(this.sent.find(row => typeof row.data === 'string').data); }
  event(type, payload = {}, extra = {}) {
    this.emit('message', Buffer.from(JSON.stringify({ header: {
      task_id: this.command().header.task_id, event: type, ...extra }, payload })), false);
  }
  sentence(value) { this.event('result-generated', { output: { sentence: value } }); }
}
function setup(options = {}, selected = profile) {
  const events = { partial: [], final: [], error: [], ready: 0, finished: [] };
  const handle = createQwenNativeLive(selected, { WebSocketImpl: FakeSocket,
    onReady: () => events.ready++, onPartial: x => events.partial.push(x),
    onFinal: x => events.final.push(x), onError: x => events.error.push(x),
    onFinished: x => events.finished.push(x), ...options });
  const socket = FakeSocket.instances.at(-1);
  return { handle, socket, events };
}
function ready(item) { item.socket.open(); item.socket.event('task-started'); }
const sentence = (text, final = false, id = 1, begin = 0) => ({
  text, sentence_end: final, sentence_id: id, begin_time: begin,
});

test('native handshake uses approved path, correct audio schema and inline vocabulary', t => {
  const x = setup({ glossary: 'basis point = 基点\nduration: 久期', context: 'Finance lecture.' });
  t.after(() => x.handle.close());
  assert.equal(x.handle.sendPCM(Buffer.alloc(3200)), false);
  x.socket.open();
  assert.equal(x.socket.url, 'wss://workspace-123.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference');
  assert.equal(x.socket.options.headers.Authorization, 'Bearer mock-secret');
  assert.equal(x.socket.options.followRedirects, false);
  assert.equal(x.socket.options.maxRedirects, 0);
  const cmd = x.socket.command();
  assert.equal(cmd.header.action, 'run-task');
  assert.equal(cmd.header.streaming, 'duplex');
  assert.deepEqual(cmd.payload.parameters, { format: 'pcm', sample_rate: 16000,
    language_hints: ['en'], semantic_punctuation_enabled: false,
    max_sentence_silence: 400, heartbeat: true, vocabulary: { 'basis point': 3, duration: 3 } });
  assert.equal(cmd.payload.input.context[0].content[0].text, 'Finance lecture.');
  assert.equal(x.handle.ready, false);
  x.socket.event('task-started');
  assert.equal(x.events.ready, 1); assert.equal(x.handle.ready, true);
  assert.equal(x.handle.readyState, 1);
  assert.equal(x.handle.sendPCM(Buffer.alloc(3200)), true);
  assert.equal(x.socket.sent.at(-1).options.binary, true);
});

test('partial is a replacement, sentence id is stable despite revised time, finals emit once', t => {
  const x = setup(); t.after(() => x.handle.close()); ready(x);
  x.socket.sentence(sentence('', false));
  x.socket.sentence(sentence('The yield'));
  x.socket.sentence(sentence('The yield increased'));
  x.socket.sentence(sentence('The yield increased'));
  x.socket.sentence(sentence('The yield increased.', true, 1, 170));
  x.socket.sentence(sentence('The yield increased.', true, 1, 170));
  x.socket.sentence(sentence('Late partial', false, 1, 170));
  x.socket.sentence(sentence('The yield increased.', true, 2, 2000));
  assert.equal(x.events.partial.length, 2);
  assert.deepEqual(x.events.partial.map(x => x.source), ['The yield', 'The yield increased']);
  assert.equal(x.events.final.length, 2);
  assert.equal(x.events.partial[0].id, x.events.final[0].id);
  assert.notEqual(x.events.final[0].id, x.events.final[1].id);
  assert.equal(x.events.error.length, 0);
});

test('missing sentence id uses begin_time; later official id binds to same row', t => {
  const x = setup(); t.after(() => x.handle.close()); ready(x);
  x.socket.sentence({ text: 'Duration', sentence_end: false, begin_time: 800 });
  x.socket.sentence(sentence('Duration measures sensitivity.', true, 7, 800));
  assert.equal(x.events.partial[0].id, x.events.final[0].id);
  assert.equal(x.events.error.length, 0);
});

test('heartbeat is ignored and finish waits for final event then task-finished', t => {
  const x = setup(); t.after(() => x.handle.close()); ready(x);
  x.socket.sentence({ heartbeat: true, sentence_id: 0 });
  assert.equal(x.events.partial.length + x.events.final.length, 0);
  assert.equal(x.handle.finish(), true); assert.equal(x.handle.finish(), false);
  assert.equal(x.handle.sendPCM(Buffer.alloc(3200)), false);
  assert.equal(JSON.parse(x.socket.sent.at(-1).data).header.action, 'finish-task');
  assert.equal(x.events.finished.length, 0);
  x.socket.event('result-generated', { output: { sentence: sentence('Final.', true) }, usage: { duration: 2 } });
  x.socket.event('task-finished');
  assert.deepEqual(x.events.finished, [{ usage: { seconds: 2 } }]);
  assert.equal(x.events.final.length, 1); assert.equal(x.handle.readyState, 3);
  assert.equal(x.events.error.length, 0);
});

test('same timestamp shared by distinct ids cannot misattribute a later anonymous result', t => {
  const x = setup(); t.after(() => x.handle.close()); ready(x);
  x.socket.sentence(sentence('One.', true, 1, 0));
  x.socket.sentence(sentence('Two.', true, 2, 0));
  x.socket.sentence({ text: 'Ambiguous.', sentence_end: true, begin_time: 0 });
  assert.equal(x.events.final.length, 2);
  assert.equal(x.events.error[0].code, 'INVALID_RESPONSE');
});

test('finish requested during handshake is sent only after task-started', t => {
  const x = setup(); t.after(() => x.handle.close());
  assert.equal(x.handle.finish(), true); x.socket.open();
  assert.equal(x.socket.sent.length, 1);
  x.socket.event('task-started');
  assert.equal(x.socket.sent.length, 2);
  assert.equal(JSON.parse(x.socket.sent.at(-1).data).header.action, 'finish-task');
});

test('provider failure, transport failure, and malformed JSON stay secret-free', () => {
  for (const mode of ['provider', 'transport', 'json', 'wrong-task', 'sentence']) {
    const x = setup(); ready(x);
    if (mode === 'provider') x.socket.event('task-failed', {}, { error_code: 'mock-secret', error_message: 'mock-secret https://private/' });
    if (mode === 'transport') x.socket.emit('error', new Error('mock-secret'));
    if (mode === 'json') x.socket.emit('message', Buffer.from('mock-secret'), false);
    if (mode === 'wrong-task') x.socket.event('task-started', {}, { task_id: 'wrong' });
    if (mode === 'sentence') x.socket.sentence({ text: 'bad', sentence_end: true });
    assert.equal(x.events.error.length, 1, mode);
    assert.doesNotMatch(x.events.error[0].message, /mock-secret|private/);
    assert.doesNotMatch(x.events.error[0].code, /mock-secret/);
    assert.ok(x.socket.terminated > 0);
    x.socket.emit('error', new Error('late mock-secret'));
    assert.equal(x.events.error.length, 1);
    x.handle.close();
  }
});

test('abort while CONNECTING terminates immediately; late open sends no credentials or audio', () => {
  const controller = new AbortController(); const x = setup({ signal: controller.signal });
  controller.abort();
  assert.ok(x.socket.terminated > 0);
  assert.equal(x.events.error[0].name, 'AbortError');
  x.socket.open(); assert.equal(x.socket.sent.length, 0);
  assert.equal(x.handle.readyState, 3); x.handle.close(); x.handle.close();
});

test('explicit close during CONNECTING is silent and idempotent', () => {
  const x = setup(); x.handle.close(); x.handle.close(); x.socket.open();
  assert.equal(x.events.error.length, 0); assert.equal(x.socket.sent.length, 0);
});

test('pre-aborted factory creates no socket and asynchronously reports AbortError', async () => {
  const controller = new AbortController(); controller.abort();
  const before = FakeSocket.instances.length; const failures = [];
  const handle = createQwenNativeLive(profile, { WebSocketImpl: FakeSocket, signal: controller.signal,
    onError: x => failures.push(x) });
  await Promise.resolve(); assert.equal(FakeSocket.instances.length, before);
  assert.equal(failures[0].name, 'AbortError'); handle.close();
});

test('native endpoint rejects unapproved hosts, credential URLs, unsafe paths and redirects', () => {
  for (const baseUrl of ['http://dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com.evil.test',
    'https://user:pass@dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com:8443',
    'https://dashscope.aliyuncs.com/?key=mock-secret', 'https://dashscope.aliyuncs.com/evil',
    'https://workspace.ap-southeast-1.maas.aliyuncs.com', 'https://127.0.0.1']) {
    assert.throws(() => qwenNativeLiveEndpoint({ baseUrl }), { code: 'INVALID_ENDPOINT' });
  }
  assert.equal(qwenNativeLiveEndpoint({ baseUrl: 'https://dashscope.aliyuncs.com' }),
    'wss://dashscope.aliyuncs.com/api-ws/v1/inference');
  assert.throws(() => createQwenNativeLive({ ...profile, model: 'qwen-audio-3.0-asr-flash' }), { code: 'INVALID_MODEL' });
});

test('buffer pressure and invalid audio stop instead of growing an audio queue', () => {
  for (const mode of ['buffer', 'audio']) {
    const x = setup(); ready(x);
    if (mode === 'buffer') x.socket.bufferedAmount = 300000;
    assert.equal(x.handle.sendPCM(Buffer.alloc(mode === 'audio' ? 3 : 3200)), false);
    assert.equal(x.events.error[0].code, mode === 'audio' ? 'INVALID_AUDIO' : 'BACKPRESSURE');
    x.handle.close();
  }
});

test('setup and finish timeout reject once and terminate socket', async () => {
  const first = setup({ setupMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(first.events.error[0].code, 'PROVIDER_TIMEOUT'); first.handle.close();
  const last = setup({ finishMs: 5 }); ready(last); last.handle.finish();
  await new Promise(resolve => setTimeout(resolve, 15));
  assert.equal(last.events.error[0].code, 'PROVIDER_TIMEOUT'); last.handle.close();
});

test('Fun-ASR uses the same protocol and does not send unsupported instant vocabulary', t => {
  const x = setup({ glossary: 'duration = 久期', context: 'Finance' }, { ...profile, model: 'fun-asr-realtime-2026-02-28' });
  t.after(() => x.handle.close()); x.socket.open();
  assert.equal(x.socket.command().payload.parameters.vocabulary, undefined);
  assert.deepEqual(x.socket.command().payload.input, {});
});

class AutoSocket extends FakeSocket {
  constructor(...args) { super(...args); queueMicrotask(() => this.open()); }
  send(data, options, callback) {
    super.send(data, options, callback);
    if (typeof data !== 'string') return;
    const action = JSON.parse(data).header.action;
    if (action === 'run-task') queueMicrotask(() => this.event('task-started'));
    if (action === 'finish-task') queueMicrotask(() => {
      this.sentence(sentence('First sentence.', true));
      this.sentence(sentence('Second sentence.', true, 2, 100));
      this.event('task-finished');
    });
  }
}

test('finite wrapper paces audio at recording speed and joins only final sentences', async () => {
  const result = await transcribeNativeLive(profile, { pcm: Buffer.alloc(3840), duration: 0.12 }, { WebSocketImpl: AutoSocket });
  const socket = FakeSocket.instances.at(-1);
  const audio = socket.sent.filter(x => Buffer.isBuffer(x.data));
  assert.deepEqual(audio.map(x => x.data.length), [3200, 640]);
  assert.ok(audio[1].at - audio[0].at >= 90);
  const stop = socket.sent.find(x => typeof x.data === 'string' && JSON.parse(x.data).header.action === 'finish-task');
  assert.ok(stop.at - audio[1].at >= 15);
  assert.equal(result.source, 'First sentence. Second sentence.');
  assert.equal(result.usage.seconds, 0.12);
});

test('finite wrapper abort during audio streaming stops later chunks', async () => {
  const controller = new AbortController();
  const request = transcribeNativeLive(profile, { pcm: Buffer.alloc(32000), signal: controller.signal }, { WebSocketImpl: AutoSocket });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(request, { name: 'AbortError' });
  const socket = FakeSocket.instances.at(-1), count = socket.sent.length;
  await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(socket.sent.length, count); assert.ok(socket.terminated > 0);
});

test('finite wrapper validates audio duration and pre-abort before network', async () => {
  const before = FakeSocket.instances.length;
  await assert.rejects(transcribeNativeLive(profile, { pcm: Buffer.alloc(3200), duration: 5 }, { WebSocketImpl: AutoSocket }), { code: 'INVALID_AUDIO' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(transcribeNativeLive(profile, { pcm: Buffer.alloc(3200), signal: controller.signal }, { WebSocketImpl: AutoSocket }), { name: 'AbortError' });
  assert.equal(FakeSocket.instances.length, before);
});
