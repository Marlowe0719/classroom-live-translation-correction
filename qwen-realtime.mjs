import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export const QWEN_REALTIME_MODEL = 'qwen3-asr-flash-realtime';
const MODELS = new Set([QWEN_REALTIME_MODEL,
  'qwen3-asr-flash-realtime-2025-10-27', 'qwen3-asr-flash-realtime-2026-02-10']);
const BYTES_PER_SECOND = 32000; // PCM16, 16 kHz, mono.
const CHUNK_BYTES = 3200; // Official example: 100 ms of audio per append.
const REQUEST_TIMEOUT_MS = 95000;

function failure(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function aborted() {
  const error = failure('ABORTED', 'Request cancelled.');
  error.name = 'AbortError';
  return error;
}

function connectionURL(profile, model) {
  let url;
  try { url = new URL(profile.baseUrl || 'https://dashscope.aliyuncs.com'); }
  catch { throw failure('INVALID_ENDPOINT', 'Qwen requires a valid Beijing HTTPS API origin.'); }
  const approved = url.hostname === 'dashscope.aliyuncs.com'
    || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname);
  if (!approved || url.protocol !== 'https:' || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash) {
    throw failure('INVALID_ENDPOINT', 'Qwen requires an approved Beijing HTTPS API origin.');
  }
  url.protocol = 'wss:';
  url.pathname = '/api-ws/v1/realtime';
  url.searchParams.set('model', model);
  return url.toString();
}

/**
 * Transcribe a finite PCM sample with Qwen's real-time protocol. No cloud retry.
 * Only completed transcripts are returned, after session.finished; partial text
 * never leaves this adapter. The caller owns subsequent text translation.
 *
 * Sources:
 * https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process
 * https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events
 * https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events
 * https://github.com/websockets/ws/blob/master/doc/ws.md
 */
export async function transcribeQwenRealtime(profile = {},
  { pcm, duration, signal, glossary, context } = {}, { WebSocketImpl = WebSocket } = {}) {
  if (signal?.aborted) throw aborted();
  const model = profile.model || QWEN_REALTIME_MODEL;
  if (!MODELS.has(model)) throw failure('INVALID_MODEL', 'Unsupported Qwen real-time ASR model.');
  const url = connectionURL(profile, model);
  if (typeof profile.apiKey !== 'string' || !profile.apiKey.trim()
    || profile.apiKey.length > 4096 || /[\r\n]/.test(profile.apiKey)) {
    throw failure('MISSING_KEY', 'This Qwen API profile needs a valid API key.');
  }
  if (!Buffer.isBuffer(pcm) || !pcm.length || pcm.length % 2 || pcm.length > BYTES_PER_SECOND * 60) {
    throw failure('INVALID_AUDIO', 'Qwen requires mono PCM16 at 16 kHz, up to 60 seconds.');
  }
  const seconds = pcm.length / BYTES_PER_SECOND;
  if (duration !== undefined && (!Number.isFinite(duration) || duration <= 0 || duration > 60
    || Math.abs(duration - seconds) > 0.05)) {
    throw failure('INVALID_AUDIO', 'PCM length does not match the supplied 16 kHz audio duration.');
  }

  // The Beijing Chinese API reference does not document glossary/context fields
  // for this model. Do not silently send text-model instructions to this ASR API.
  // Both arguments remain available to the caller's text translation stage.
  const hasReference = Boolean(glossary || context);
  return new Promise((resolve, reject) => {
    let socket;
    let done = false;
    let state = 'connecting';
    let offset = 0;
    let sendTimer;
    let timeoutTimer;
    const finals = new Map();
    const itemOrder = new Map();
    const unnamedCreatedEvents = new Set();
    const manualItemId = `manual_${randomUUID()}`;
    let usedImplicitAssociation = false;

    const closeSocket = force => {
      if (!socket || socket.readyState >= 2) return;
      try {
        if (force || socket.readyState === 0) socket.terminate();
        else socket.close(1000, 'ASR finished');
      } catch {
        // A late open event will also close the socket, without sending data.
        try { socket.close(); } catch { /* Do not expose transport errors. */ }
      }
    };
    const finish = error => {
      if (done) return;
      done = true;
      clearTimeout(sendTimer);
      clearTimeout(timeoutTimer);
      signal?.removeEventListener('abort', onAbort);
      closeSocket(Boolean(error));
      if (error) { reject(error); return; }
      const ordered = [...finals.values()].sort((a, b) => a.order - b.order || a.index - b.index);
      resolve({
        source: ordered.map(item => item.text).filter(Boolean).join(' '),
        usage: { seconds },
        meta: { model, mode: 'manual', sampleRate: 16000, completedSentences: ordered.length,
          ...(hasReference ? { asrReferenceApplied: false } : {}) },
      });
    };
    const onAbort = () => finish(aborted());
    const sendEvent = (type, body = {}) => {
      if (done) return false;
      if (socket.readyState !== 1) {
        finish(failure('PROVIDER_CLOSED', 'Qwen disconnected before the sample completed.'));
        return false;
      }
      try {
        socket.send(JSON.stringify({ event_id: `event_${randomUUID()}`, type, ...body }), error => {
          if (error) finish(failure('PROVIDER_CONNECTION', 'Qwen audio transmission failed.'));
        });
        return !done;
      } catch {
        finish(failure('PROVIDER_CONNECTION', 'Qwen audio transmission failed.'));
        return false;
      }
    };
    const sendChunk = () => {
      if (done || state !== 'sending') return;
      if (offset >= pcm.length) {
        state = 'finishing';
        if (sendEvent('input_audio_buffer.commit')) sendEvent('session.finish');
        return;
      }
      const chunk = pcm.subarray(offset, Math.min(offset + CHUNK_BYTES, pcm.length));
      offset += chunk.length;
      if (!sendEvent('input_audio_buffer.append', { audio: chunk.toString('base64') })) return;
      // Pacing reflects the actual PCM duration. Session readiness and final
      // completion are event-driven, with no guessed sleep before/after them.
      sendTimer = setTimeout(sendChunk, chunk.length / BYTES_PER_SECOND * 1000);
    };
    const rememberItem = id => {
      if (typeof id !== 'string' || !id || id.length > 256) return false;
      if (!itemOrder.has(id)) itemOrder.set(id, itemOrder.size);
      return true;
    };

    try {
      socket = new WebSocketImpl(url, {
        headers: { Authorization: `Bearer ${profile.apiKey}`, 'OpenAI-Beta': 'realtime=v1' },
        followRedirects: false, maxRedirects: 0, handshakeTimeout: 15000,
        closeTimeout: 1000, maxPayload: 512 * 1024, perMessageDeflate: false,
      });
    } catch {
      reject(failure('PROVIDER_CONNECTION', 'Qwen connection could not be started.'));
      return;
    }
    // Keep an error listener attached even after cancellation: ws can emit an
    // asynchronous handshake error when terminate() closes CONNECTING sockets.
    socket.on('error', () => finish(failure('PROVIDER_CONNECTION', 'Qwen audio connection failed.')));
    socket.on('close', () => {
      if (!done) finish(failure('PROVIDER_CLOSED', 'Qwen disconnected before its final result.'));
    });
    socket.on('open', () => {
      if (done) { closeSocket(true); return; }
      if (state !== 'connecting') return;
      state = 'configuring';
      sendEvent('session.update', { session: {
        modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000,
        input_audio_transcription: { language: 'en' }, turn_detection: null,
      } });
    });
    socket.on('message', (data, isBinary) => {
      if (done) return;
      let event;
      try {
        if (isBinary || (!Buffer.isBuffer(data) && typeof data !== 'string')) throw new Error();
        event = JSON.parse(data.toString());
        if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error();
      } catch {
        finish(failure('INVALID_RESPONSE', 'Qwen returned invalid event data.'));
        return;
      }
      if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
        finish(failure('PROVIDER_ERROR', 'Qwen rejected the audio request. Check model access and API permissions.'));
      } else if (event.type === 'session.updated' && state === 'configuring') {
        state = 'sending';
        sendChunk();
      } else if (event.type === 'input_audio_buffer.committed') {
        rememberItem(event.item_id);
      } else if (event.type === 'conversation.item.created') {
        rememberItem(event.item?.id);
        if (event.item && typeof event.item === 'object' && !Object.hasOwn(event.item, 'id')) {
          unnamedCreatedEvents.add(event.event_id ?? Symbol());
        }
      } else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const index = event.content_index ?? 0;
        let itemId = event.item_id;
        if (!Object.hasOwn(event, 'item_id')) {
          // The maas gateway can omit item_id from committed/completed events.
          // This adapter sends exactly one manual commit per connection. Prefer
          // its sole previously-created item; otherwise associate the final with
          // that single local input. Never guess between multiple known items.
          if (state !== 'finishing' || itemOrder.size > 1 || unnamedCreatedEvents.size > 1) {
            finish(failure('INVALID_RESPONSE', 'Qwen returned an ambiguous completed transcript.'));
            return;
          }
          itemId = itemOrder.keys().next().value ?? manualItemId;
          usedImplicitAssociation = true;
        }
        if (!rememberItem(itemId) || !Number.isSafeInteger(index) || index < 0
          || typeof event.transcript !== 'string' || event.transcript.length > 65536) {
          finish(failure('INVALID_RESPONSE', 'Qwen returned an invalid completed transcript.'));
          return;
        }
        finals.set(`${itemId}:${index}`, { order: itemOrder.get(itemId), index,
          text: event.transcript.trim() });
      } else if (event.type === 'session.finished') {
        if (state !== 'finishing') {
          finish(failure('INVALID_RESPONSE', 'Qwen finished before the complete audio sample was sent.'));
        } else if (usedImplicitAssociation && (itemOrder.size > 1 || unnamedCreatedEvents.size > 1)) {
          finish(failure('INVALID_RESPONSE', 'Qwen returned an ambiguous completed transcript.'));
        } else {
          finish(); // Empty source is valid for a sample with no detected speech.
        }
      }
      // All partial transcript events are intentionally ignored.
    });
    timeoutTimer = setTimeout(() => finish(failure('PROVIDER_TIMEOUT', 'Qwen did not finish within 95 seconds.')), REQUEST_TIMEOUT_MS);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
