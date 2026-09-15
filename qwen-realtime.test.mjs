import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { QWEN_REALTIME_MODEL, transcribeQwenRealtime } from './qwen-realtime.mjs';

// All samples/credentials are synthetic. Every transport is mocked: no API calls.
const profile = { apiKey: 'synthetic-only-key', baseUrl: 'https://dashscope.aliyuncs.com' };
const sample = { pcm: Buffer.alloc(6400, 7), duration: 0.2 };
const finalType = 'conversation.item.input_audio_transcription.completed';
function mockTransport() {
  const sockets = [];
  class MockWebSocket extends EventEmitter {
    constructor(url, options) {
      super(); this.url = url; this.options = options; this.readyState = 0;
      this.sent = []; this.terminated = 0; this.closed = 0; sockets.push(this);
    }
    open() { this.readyState = 1; this.emit('open'); }
    server(event) { this.emit('message', Buffer.from(JSON.stringify(event)), false); }
    send(raw, callback) { this.sent.push(JSON.parse(raw)); callback?.(this.sendError); }
    close() { this.closed++; this.readyState = 3; this.emit('close', 1000, Buffer.alloc(0)); }
    terminate() {
      this.terminated++; this.readyState = 3;
      this.emit('error', new Error('Synthetic cancelled handshake error'));
      this.emit('close', 1006, Buffer.alloc(0));
    }
  }
  return { sockets, MockWebSocket };
}
function start(t, input = sample, settings = profile) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const transport = mockTransport();
  const promise = transcribeQwenRealtime(settings, input, { WebSocketImpl: transport.MockWebSocket });
  return { ...transport, promise, socket: transport.sockets[0] };
}
function ready(socket) { socket.open(); socket.server({ type: 'session.updated' }); }
function sendWholeSample(t, socket, seconds = 0.2) {
  ready(socket);
  for (let ms = 0; ms < seconds * 1000; ms += 100) t.mock.timers.tick(Math.min(100, seconds * 1000 - ms));
}
const code = expected => error => error.code === expected && !error.message.includes(profile.apiKey);

test('Qwen waits for configuration acknowledgement and paces PCM before commit/finish', async t => {
  const { socket, promise } = start(t);
  assert.equal(socket.url, `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${QWEN_REALTIME_MODEL}`);
  assert.equal(socket.options.headers.Authorization, `Bearer ${profile.apiKey}`);
  assert.equal(socket.options.followRedirects, false);
  assert.equal(socket.options.perMessageDeflate, false);
  socket.open();
  assert.deepEqual(socket.sent.map(event => event.type), ['session.update']);
  assert.deepEqual(socket.sent[0].session, { modalities: ['text'], input_audio_format: 'pcm',
    sample_rate: 16000, input_audio_transcription: { language: 'en' }, turn_detection: null });
  t.mock.timers.tick(5000);
  assert.equal(socket.sent.length, 1, 'no guessed setup sleep may start streaming');
  socket.server({ type: 'session.updated' });
  assert.equal(socket.sent.length, 2);
  t.mock.timers.tick(99);
  assert.equal(socket.sent.length, 2);
  t.mock.timers.tick(1);
  assert.equal(socket.sent.length, 3);
  t.mock.timers.tick(100);
  assert.deepEqual(socket.sent.map(event => event.type), ['session.update', 'input_audio_buffer.append',
    'input_audio_buffer.append', 'input_audio_buffer.commit', 'session.finish']);
  assert.deepEqual(Buffer.concat(socket.sent.filter(event => event.audio).map(event => Buffer.from(event.audio, 'base64'))), sample.pcm);
  assert.equal(new Set(socket.sent.map(event => event.event_id)).size, socket.sent.length);
  socket.server({ type: finalType, item_id: 'item-1', content_index: 0, transcript: ' Complete English. ' });
  socket.server({ type: 'session.finished' });
  const result = await promise;
  assert.equal(result.source, 'Complete English.');
  assert.equal(result.usage.seconds, 0.2);
  assert.equal(socket.closed, 1);
});

test('Qwen ignores partials, waits for session.finished, and deduplicates finals in item order', async t => {
  const { socket, promise } = start(t);
  sendWholeSample(t, socket);
  let settled = false;
  promise.then(() => { settled = true; });
  socket.server({ type: 'input_audio_buffer.committed', item_id: 'a' });
  socket.server({ type: 'conversation.item.created', item: { id: 'b' } });
  socket.server({ type: 'conversation.item.input_audio_transcription.text', item_id: 'a', text: 'Wrong', stash: 'partial' });
  socket.server({ type: finalType, item_id: 'b', transcript: 'Second sentence.' });
  socket.server({ type: finalType, item_id: 'a', transcript: 'First sentence.' });
  socket.server({ type: finalType, item_id: 'a', transcript: 'First sentence.' });
  await Promise.resolve();
  assert.equal(settled, false);
  socket.server({ type: 'session.finished' });
  assert.equal((await promise).source, 'First sentence. Second sentence.');
});

test('Qwen supports silence without substituting provisional text', async t => {
  const { socket, promise } = start(t);
  sendWholeSample(t, socket);
  socket.server({ type: 'conversation.item.input_audio_transcription.text', text: '', stash: 'unconfirmed' });
  socket.server({ type: 'session.finished' });
  assert.equal((await promise).source, '');
});

test('Qwen maas completed without item_id associates with the sole created item', async t => {
  const { socket, promise } = start(t);
  sendWholeSample(t, socket);
  socket.server({ event_id: 'commit-1', type: 'input_audio_buffer.committed' });
  socket.server({ event_id: 'create-1', type: 'conversation.item.created', item: { id: 'manual-input-1' } });
  const transcript = 'A'.repeat(215);
  const completed = { event_id: 'final-1', type: finalType, content_index: 0,
    transcript, language: 'en', emotion: 'neutral', usage: { seconds: 0.2 } };
  socket.server(completed);
  socket.server(completed);
  socket.server({ type: 'session.finished' });
  const result = await promise;
  assert.equal(result.source, transcript);
  assert.equal(result.meta.completedSentences, 1);
});

test('Qwen maas completed without any remote item id associates only with its unique manual input', async t => {
  for (const withCreated of [true, false]) await t.test(String(withCreated), async t => {
    const { socket, promise } = start(t);
    sendWholeSample(t, socket);
    socket.server({ event_id: 'commit-1', type: 'input_audio_buffer.committed' });
    if (withCreated) socket.server({ event_id: 'create-1', type: 'conversation.item.created', item: { type: 'message' } });
    socket.server({ event_id: 'final-1', type: finalType, content_index: 0, transcript: 'Final English.' });
    socket.server({ type: 'session.finished' });
    assert.equal((await promise).source, 'Final English.');
  });
});

test('Qwen missing item_id does not permit explicitly invalid final identifiers', async t => {
  for (const item_id of [null, '', 7, {}, 'a'.repeat(257)]) await t.test(typeof item_id, async t => {
    const { socket, promise } = start(t);
    sendWholeSample(t, socket);
    socket.server({ type: 'conversation.item.created', item: { id: 'valid-previous-id' } });
    const rejected = assert.rejects(promise, code('INVALID_RESPONSE'));
    socket.server({ type: finalType, item_id, content_index: 0, transcript: 'Must reject.' });
    await rejected;
  });
});

test('Qwen rejects missing-id finals when multiple known or unnamed items make association ambiguous', async t => {
  for (const named of [true, false]) await t.test(String(named), async t => {
    const { socket, promise } = start(t);
    sendWholeSample(t, socket);
    socket.server({ event_id: 'created-a', type: 'conversation.item.created', item: named ? { id: 'a' } : {} });
    socket.server({ event_id: 'created-b', type: 'conversation.item.created', item: named ? { id: 'b' } : {} });
    const rejected = assert.rejects(promise, code('INVALID_RESPONSE'));
    socket.server({ type: finalType, content_index: 0, transcript: 'Ambiguous.' });
    await rejected;
  });
});

test('Qwen rejects a later second item after it used missing-id fallback', async t => {
  const { socket, promise } = start(t);
  sendWholeSample(t, socket);
  socket.server({ type: 'conversation.item.created', item: { id: 'a' } });
  socket.server({ type: finalType, content_index: 0, transcript: 'First input.' });
  socket.server({ type: 'conversation.item.created', item: { id: 'b' } });
  const rejected = assert.rejects(promise, code('INVALID_RESPONSE'));
  socket.server({ type: 'session.finished' });
  await rejected;
});

test('Qwen repeated session.updated events do not send audio twice', async t => {
  const { socket, promise } = start(t);
  ready(socket);
  socket.server({ type: 'session.updated' });
  t.mock.timers.tick(100); t.mock.timers.tick(100);
  assert.equal(socket.sent.filter(event => event.type === 'input_audio_buffer.append').length, 2);
  socket.server({ type: 'session.finished' });
  await promise;
});

test('Qwen partial last chunk is paced for its actual duration', async t => {
  const { socket, promise } = start(t, { pcm: Buffer.alloc(4000), duration: 0.125 });
  ready(socket);
  t.mock.timers.tick(100);
  assert.equal(Buffer.from(socket.sent.at(-1).audio, 'base64').length, 800);
  t.mock.timers.tick(24);
  assert.equal(socket.sent.at(-1).type, 'input_audio_buffer.append');
  t.mock.timers.tick(1);
  assert.equal(socket.sent.at(-1).type, 'session.finish');
  socket.server({ type: 'session.finished' });
  assert.equal((await promise).usage.seconds, 0.125);
});

test('Qwen 6/10/15-second samples all send exact PCM bytes at real-time pacing', async t => {
  for (const duration of [6, 10, 15]) await t.test(`${duration}s`, async t => {
    const { socket, promise } = start(t, { pcm: Buffer.alloc(duration * 32000), duration });
    sendWholeSample(t, socket, duration);
    assert.equal(socket.sent.filter(event => event.audio).length, duration * 10);
    assert.equal(socket.sent.at(-1).type, 'session.finish');
    socket.server({ type: 'session.finished' });
    assert.equal((await promise).usage.seconds, duration);
  });
});

test('Qwen cancellation during CONNECTING terminates the socket and guards late open/error', async t => {
  const controller = new AbortController();
  const { socket, promise } = start(t, { ...sample, signal: controller.signal });
  const rejected = assert.rejects(promise, error => error.name === 'AbortError' && code('ABORTED')(error));
  controller.abort();
  await rejected;
  assert.equal(socket.terminated, 1);
  socket.open();
  socket.emit('error', new Error(profile.apiKey));
  assert.equal(socket.terminated, 2);
  assert.equal(socket.sent.length, 0);
});

test('Qwen cancellation while streaming stops every subsequent audio frame and timer', async t => {
  const controller = new AbortController();
  const { socket, promise } = start(t, { ...sample, signal: controller.signal });
  ready(socket);
  const rejected = assert.rejects(promise, code('ABORTED'));
  controller.abort();
  t.mock.timers.tick(100000);
  await rejected;
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.terminated, 1);
});

test('Qwen an already-aborted signal never constructs a connection', async () => {
  const controller = new AbortController(); controller.abort();
  const transport = mockTransport();
  await assert.rejects(transcribeQwenRealtime(profile, { ...sample, signal: controller.signal },
    { WebSocketImpl: transport.MockWebSocket }), code('ABORTED'));
  assert.equal(transport.sockets.length, 0);
});

test('Qwen sanitizes provider and transport failures and never retries', async t => {
  for (const eventType of ['error', 'conversation.item.input_audio_transcription.failed', 'transport']) {
    await t.test(eventType, async t => {
      const { socket, promise, sockets } = start(t);
      const rejected = assert.rejects(promise, error => !error.message.includes(profile.apiKey)
        && !error.stack.includes(profile.apiKey) && error.code.startsWith('PROVIDER_'));
      if (eventType === 'transport') socket.emit('error', new Error(`Bearer ${profile.apiKey}`));
      else socket.server({ type: eventType, error: { message: profile.apiKey, code: profile.apiKey } });
      await rejected;
      assert.equal(sockets.length, 1);
      assert.equal(socket.terminated, 1);
    });
  }
});

test('Qwen sanitizes synchronous and callback send failures', async t => {
  for (const failureMode of ['throw', 'callback']) await t.test(failureMode, async t => {
    const { socket, promise } = start(t);
    if (failureMode === 'throw') socket.send = () => { throw new Error(profile.apiKey); };
    else socket.sendError = new Error(profile.apiKey);
    const rejected = assert.rejects(promise, code('PROVIDER_CONNECTION'));
    socket.open();
    await rejected;
  });
});

test('Qwen close before session.finished is an error even when a final already arrived', async t => {
  const { socket, promise } = start(t);
  sendWholeSample(t, socket);
  socket.server({ type: finalType, item_id: 'a', transcript: 'Incomplete session' });
  const rejected = assert.rejects(promise, code('PROVIDER_CLOSED'));
  socket.close();
  await rejected;
});

test('Qwen enforces 95-second fallback deadline without waiting forever for session.updated', async t => {
  const { socket, promise } = start(t);
  socket.open();
  const rejected = assert.rejects(promise, code('PROVIDER_TIMEOUT'));
  t.mock.timers.tick(95000);
  await rejected;
  assert.equal(socket.terminated, 1);
  assert.equal(socket.sent.length, 1);
});

test('Qwen rejects malformed events, malformed finals, and a premature finish', async t => {
  const cases = [
    socket => socket.emit('message', Buffer.from('invalid json'), false),
    socket => socket.emit('message', Buffer.from('{}'), true),
    socket => socket.server({ type: finalType, item_id: 'a' }),
    socket => socket.server({ type: finalType, transcript: 'missing item id' }),
    socket => socket.server({ type: 'session.finished' }),
  ];
  for (const [index, deliver] of cases.entries()) await t.test(String(index), async t => {
    const { socket, promise } = start(t);
    const rejected = assert.rejects(promise, code('INVALID_RESPONSE'));
    deliver(socket);
    await rejected;
  });
});

test('Qwen rejects unsafe origins and unsupported model before exposing credentials to a socket', async () => {
  const transport = mockTransport();
  for (const baseUrl of [
    'http://dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com.evil.invalid',
    'https://evil.invalid', 'https://dashscope.aliyuncs.com:8443',
    'https://user:pass@dashscope.aliyuncs.com', 'https://dashscope.aliyuncs.com?redirect=evil',
    'https://dashscope.aliyuncs.com#secret', 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    'https://work.cn-beijing.maas.aliyuncs.com.evil.invalid',
    'https://work.ap-southeast-1.maas.aliyuncs.com',
  ]) await assert.rejects(transcribeQwenRealtime({ ...profile, baseUrl }, sample,
    { WebSocketImpl: transport.MockWebSocket }), code('INVALID_ENDPOINT'));
  await assert.rejects(transcribeQwenRealtime({ ...profile, model: 'qwen-plus' }, sample,
    { WebSocketImpl: transport.MockWebSocket }), code('INVALID_MODEL'));
  assert.equal(transport.sockets.length, 0);
});

test('Qwen rejects invalid PCM, duration and missing key before connecting', async () => {
  const transport = mockTransport();
  for (const input of [{ pcm: Buffer.alloc(0) }, { pcm: Buffer.alloc(3) }, { pcm: 'not PCM' },
    { pcm: Buffer.alloc(60 * 32000 + 2) }, { ...sample, duration: 61 }, { ...sample, duration: 0.4 },
    { ...sample, duration: NaN }]) {
    await assert.rejects(transcribeQwenRealtime(profile, input, { WebSocketImpl: transport.MockWebSocket }), code('INVALID_AUDIO'));
  }
  for (const apiKey of ['', undefined, 'key\r\nAuthorization: other']) {
    await assert.rejects(transcribeQwenRealtime({ ...profile, apiKey }, sample,
      { WebSocketImpl: transport.MockWebSocket }), code('MISSING_KEY'));
  }
  assert.equal(transport.sockets.length, 0);
});

test('Qwen accepts Beijing workspace origin and reports references not applied to ASR', async t => {
  const { socket, promise } = start(t, { ...sample, glossary: 'ATP', context: 'Biology' },
    { ...profile, baseUrl: 'https://workspace-123.cn-beijing.maas.aliyuncs.com' });
  sendWholeSample(t, socket);
  assert.equal(new URL(socket.url).hostname, 'workspace-123.cn-beijing.maas.aliyuncs.com');
  assert.equal(JSON.stringify(socket.sent).includes('Biology'), false);
  socket.server({ type: 'session.finished' });
  assert.equal((await promise).meta.asrReferenceApplied, false);
});
