import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { asrVocabulary } from './asr-hints.mjs';

export const QWEN_NATIVE_REALTIME_MODEL = 'qwen-audio-3.0-asr-flash-streaming';
const MODELS = new Set([QWEN_NATIVE_REALTIME_MODEL, 'fun-asr-realtime',
  'fun-asr-realtime-2025-11-07', 'fun-asr-realtime-2026-02-28', 'fun-asr-realtime-2025-09-15']);
const CONTEXT_MODELS = new Set([QWEN_NATIVE_REALTIME_MODEL, 'fun-asr-realtime', 'fun-asr-realtime-2025-11-07']);
const RATE = 32000;

function error(code, message) { return Object.assign(new Error(message), { code }); }
function aborted() { return Object.assign(error('ABORTED', 'Request cancelled.'), { name: 'AbortError' }); }

export function qwenNativeLiveEndpoint(profile = {}) {
  let url;
  try { url = new URL(profile.baseUrl || 'https://dashscope.aliyuncs.com'); }
  catch { throw error('INVALID_ENDPOINT', 'Qwen requires an approved Beijing HTTPS API address.'); }
  const approved = url.hostname === 'dashscope.aliyuncs.com'
    || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname);
  const paths = new Set(['/', '/api/v1', '/api/v1/', '/compatible-mode/v1', '/compatible-mode/v1/', '/api-ws/v1/inference']);
  if (!approved || url.protocol !== 'https:' || url.username || url.password || url.port
    || !paths.has(url.pathname) || url.search || url.hash) {
    throw error('INVALID_ENDPOINT', 'Qwen requires an approved Beijing HTTPS API address.');
  }
  url.protocol = 'wss:'; url.pathname = '/api-ws/v1/inference';
  return url.toString();
}

function hotwords(glossary) {
  return asrVocabulary(String(glossary || '').slice(0, 12000), 3);
}

/**
 * Continuous PCM16/16 kHz/mono input. The caller paces audio in real time and
 * sends only after onReady (task-started). No audio is buffered before readiness.
 * sendPCM/finish return boolean; explicit close is silent and idempotent.
 * onPartial/onFinal receive {id: string, source: string}: each source replaces
 * the current sentence, it is not a token delta. Final is emitted once per id.
 * All async failures reach onError with a static, credential-free Error.
 *
 * https://help.aliyun.com/zh/model-studio/fun-asr-realtime-websocket-api
 * https://help.aliyun.com/zh/model-studio/fun-asr-client-events
 * https://help.aliyun.com/zh/model-studio/fun-asr-server-events
 */
export function createQwenNativeLive(profile = {}, { onReady = () => {}, onPartial = () => {},
  onFinal = () => {}, onFinished = () => {}, onError = () => {}, WebSocketImpl = WebSocket,
  glossary = '', context = '', signal, silenceMs = 400, setupMs = 15000, finishMs = 15000,
  bufferedBytes = 256 * 1024 } = {}) {
  const model = profile.model || QWEN_NATIVE_REALTIME_MODEL;
  const url = qwenNativeLiveEndpoint(profile);
  if (!MODELS.has(model)) throw error('INVALID_MODEL', 'Unsupported native real-time ASR model.');
  if (typeof profile.apiKey !== 'string' || !profile.apiKey.trim() || profile.apiKey.length > 4096
    || /[\r\n]/.test(profile.apiKey)) throw error('MISSING_KEY', 'This Qwen profile needs a valid API key.');
  if (!Number.isInteger(silenceMs) || silenceMs < 200 || silenceMs > 6000
    || !Number.isFinite(setupMs) || setupMs <= 0 || !Number.isFinite(finishMs) || finishMs <= 0
    || !Number.isSafeInteger(bufferedBytes) || bufferedBytes < 3200) {
    throw error('INVALID_OPTIONS', 'Invalid native real-time ASR options.');
  }
  const taskId = randomUUID();
  let socket, state = 'connecting', done = false, finishRequested = false, finishSent = false;
  let setupTimer, finishTimer, closeTimer, sequence = 0, usageSeconds;
  const byRemote = new Map(), byTime = new Map(), all = new Set();
  const terminate = () => {
    if (!socket || socket.readyState === 3) return;
    try { socket.terminate(); } catch { try { socket.close(); } catch { /* sanitized */ } }
  };
  const clear = () => {
    clearTimeout(setupTimer); clearTimeout(finishTimer);
    signal?.removeEventListener('abort', onAbort);
  };
  const fail = problem => {
    if (done) return false;
    done = true; state = 'closed'; clear(); terminate();
    try { onError(problem); } catch { /* Caller callback cannot expose transport internals. */ }
    return false;
  };
  const call = (callback, payload) => {
    if (done) return false;
    try { callback(payload); return !done; }
    catch { return fail(error('CALLBACK_ERROR', 'ASR result handling failed.')); }
  };
  const onAbort = () => fail(aborted());
  const send = (data, binary = false) => {
    if (done || socket?.readyState !== 1) return false;
    if ((socket.bufferedAmount || 0) > bufferedBytes) return fail(error('BACKPRESSURE', 'ASR audio connection cannot keep up.'));
    try {
      socket.send(data, { binary }, problem => {
        if (problem) fail(error('PROVIDER_CONNECTION', 'Qwen audio transmission failed.'));
      });
      return !done;
    } catch { return fail(error('PROVIDER_CONNECTION', 'Qwen audio transmission failed.')); }
  };
  const command = (action, payload) => send(JSON.stringify({
    header: { action, task_id: taskId, streaming: 'duplex' }, payload,
  }));
  const sendFinish = () => {
    if (done || finishSent || state !== 'ready') return false;
    finishSent = true; state = 'finishing';
    finishTimer = setTimeout(() => fail(error('PROVIDER_TIMEOUT', 'Qwen did not finish the audio request in time.')), finishMs);
    return command('finish-task', { input: {} });
  };
  const handle = {
    get readyState() { return done ? 3 : (socket?.readyState ?? 0); },
    get ready() { return !done && state === 'ready' && !finishRequested; },
    get bufferedAmount() { return socket?.bufferedAmount || 0; },
    sendPCM(pcm) {
      if (done || state !== 'ready' || finishRequested) return false;
      if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > RATE) {
        return fail(error('INVALID_AUDIO', 'Send mono PCM16 at 16 kHz in chunks no longer than one second.'));
      }
      return send(pcm, true);
    },
    finish() {
      if (done || finishRequested) return false;
      finishRequested = true;
      return state === 'ready' ? sendFinish() : true;
    },
    close() {
      if (done) { clearTimeout(closeTimer); terminate(); return; }
      done = true; state = 'closed'; clear(); terminate();
    },
  };
  // Defer pre-abort notification so the caller can store the returned handle.
  if (signal?.aborted) { queueMicrotask(onAbort); return handle; }
  try {
    socket = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${profile.apiKey}` },
      followRedirects: false, maxRedirects: 0, handshakeTimeout: setupMs, closeTimeout: 1000,
      maxPayload: 512 * 1024, perMessageDeflate: false });
  } catch {
    queueMicrotask(() => fail(error('PROVIDER_CONNECTION', 'Qwen connection could not be started.')));
    return handle;
  }
  // Keep the error listener after cancellation: ws emits a handshake error when
  // terminate() interrupts CONNECTING. A late open never sends run-task/audio.
  socket.on('error', () => fail(error('PROVIDER_CONNECTION', 'Qwen audio connection failed.')));
  socket.on('close', () => {
    clearTimeout(closeTimer);
    if (!done) fail(error('PROVIDER_CLOSED', 'Qwen disconnected before completing the audio request.'));
  });
  socket.on('open', () => {
    if (done) { terminate(); return; }
    if (state !== 'connecting') return;
    state = 'starting';
    const vocabulary = hotwords(glossary);
    const input = {};
    if (context && CONTEXT_MODELS.has(model)) input.context = [{ role: 'user',
      content: [{ type: 'input_text', text: String(context).slice(0, 400) }] }];
    command('run-task', { task_group: 'audio', task: 'asr', function: 'recognition', model,
      parameters: { format: 'pcm', sample_rate: 16000, language_hints: ['en'],
        semantic_punctuation_enabled: false, max_sentence_silence: silenceMs, heartbeat: true,
        ...(model === QWEN_NATIVE_REALTIME_MODEL && Object.keys(vocabulary).length ? { vocabulary } : {}) }, input });
  });
  socket.on('message', (data, isBinary) => {
    if (done) return;
    let event;
    try {
      if (isBinary || (!Buffer.isBuffer(data) && typeof data !== 'string') || data.length > 512 * 1024) throw new Error();
      event = JSON.parse(data.toString());
      if (!event || typeof event !== 'object' || typeof event.header?.event !== 'string'
        || event.header.task_id !== taskId) throw new Error();
    } catch { fail(error('INVALID_RESPONSE', 'Qwen returned invalid ASR event data.')); return; }
    const type = event.header.event;
    if (type === 'task-failed') { fail(error('PROVIDER_ERROR', 'Qwen rejected the audio request. Check model access and API permissions.')); return; }
    if (type === 'task-started') {
      if (state !== 'starting') return;
      clearTimeout(setupTimer); state = 'ready';
      if (!call(onReady)) return;
      if (finishRequested && !finishSent) sendFinish();
      return;
    }
    if (type === 'result-generated') {
      if (state !== 'ready' && state !== 'finishing') { fail(error('INVALID_RESPONSE', 'Qwen sent ASR output before task readiness.')); return; }
      const sentence = event.payload?.output?.sentence;
      if (sentence?.heartbeat === true) return;
      const remote = Number.isSafeInteger(sentence?.sentence_id) && sentence.sentence_id > 0 ? sentence.sentence_id : null;
      const begin = Number.isSafeInteger(sentence?.begin_time) && sentence.begin_time >= 0 ? sentence.begin_time : null;
      if (!sentence || (remote === null && begin === null) || typeof sentence.text !== 'string'
        || sentence.text.length > 65536 || typeof sentence.sentence_end !== 'boolean') {
        fail(error('INVALID_RESPONSE', 'Qwen returned an invalid ASR sentence.')); return;
      }
      let item = remote !== null ? byRemote.get(remote) : undefined;
      // begin_time is only an alias/fallback; sentence_id is authoritative when
      // present, because providers can refine the onset timestamp in later text.
      const timed = begin !== null ? byTime.get(begin) : undefined;
      if (remote === null && begin !== null && byTime.has(begin) && timed === null) {
        fail(error('INVALID_RESPONSE', 'Qwen returned an ambiguous ASR sentence.')); return;
      }
      if (!item && timed && (remote === null || timed.remote === null || timed.remote === remote)) item = timed;
      if (!item) {
        if (all.size >= 10000) { fail(error('RESULT_LIMIT', 'The ASR session reached its sentence limit.')); return; }
        item = { id: `native-${++sequence}`, remote, text: null, final: false };
        all.add(item);
      }
      if (remote !== null) { item.remote = remote; byRemote.set(remote, item); }
      if (begin !== null) {
        if (!byTime.has(begin) || timed === item) byTime.set(begin, item);
        else if (timed !== item) byTime.set(begin, null);
      }
      if (item.final) return;
      const source = sentence.text.trim();
      if (sentence.sentence_end) {
        item.final = true; item.text = source;
        const duration = event.payload?.usage?.duration ?? event.payload?.output?.usage?.duration;
        if (Number.isFinite(duration) && duration >= 0) usageSeconds = duration;
        call(onFinal, { id: item.id, source });
      } else if (source && source !== item.text) {
        item.text = source; call(onPartial, { id: item.id, source });
      }
      return;
    }
    if (type === 'task-finished') {
      if (!finishSent) { fail(error('INVALID_RESPONSE', 'Qwen finished before all audio was submitted.')); return; }
      done = true; state = 'closed'; clear();
      try { socket.close(1000, 'ASR finished'); } catch { terminate(); }
      if (socket.readyState !== 3) { closeTimer = setTimeout(terminate, 1000); closeTimer.unref?.(); }
      try { onFinished(usageSeconds === undefined ? {} : { usage: { seconds: usageSeconds } }); }
      catch { /* Successful transport has already closed. */ }
    }
  });
  setupTimer = setTimeout(() => fail(error('PROVIDER_TIMEOUT', 'Qwen did not start the audio request in time.')), setupMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  if (signal?.aborted) onAbort();
  return handle;
}

/** Finite comparison adapter; 100 ms PCM frames at the real recording rate. */
export async function transcribeNativeLive(profile = {}, { pcm, duration, glossary, context, signal } = {},
  { WebSocketImpl = WebSocket } = {}) {
  if (signal?.aborted) throw aborted();
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > RATE * 60) {
    throw error('INVALID_AUDIO', 'Qwen requires mono PCM16 at 16 kHz, up to 60 seconds.');
  }
  const seconds = pcm.length / RATE;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 60
    || Math.abs(duration - seconds) > 0.05)) {
    throw error('INVALID_AUDIO', 'PCM length does not match the supplied 16 kHz audio duration.');
  }
  return new Promise((resolve, reject) => {
    let handle, timer, timeout, done = false, offset = 0;
    const finals = new Map();
    const end = (problem, usage) => {
      if (done) return;
      done = true; clearTimeout(timer); clearTimeout(timeout); handle?.close();
      if (problem) reject(problem);
      else resolve({ source: [...finals.values()].filter(Boolean).join(' '), usage: usage || { seconds } });
    };
    const sendChunk = () => {
      if (done) return;
      if (offset >= pcm.length) {
        if (!handle.finish()) end(error('PROVIDER_CONNECTION', 'Qwen could not finish the audio request.'));
        return;
      }
      const chunk = pcm.subarray(offset, Math.min(offset + 3200, pcm.length));
      offset += chunk.length;
      if (!handle.sendPCM(chunk)) { end(error('PROVIDER_CONNECTION', 'Qwen could not accept the audio data.')); return; }
      timer = setTimeout(sendChunk, chunk.length / RATE * 1000);
    };
    try {
      handle = createQwenNativeLive(profile, { WebSocketImpl, glossary, context, signal,
        onReady: () => queueMicrotask(sendChunk), onFinal: ({ id, source }) => finals.set(id, source),
        onFinished: ({ usage }) => end(null, usage), onError: problem => end(problem) });
      timeout = setTimeout(() => end(error('PROVIDER_TIMEOUT', 'Qwen did not complete within 95 seconds.')), 95000);
    } catch (problem) { end(problem); }
  });
}
