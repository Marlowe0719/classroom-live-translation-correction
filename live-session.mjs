import { randomUUID } from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { transcribe, translate } from './adapters.mjs';
import { validateBase } from './store.mjs';
import { QWEN_REALTIME_MODEL } from './qwen-realtime.mjs';
import { createQwenNativeLive } from './qwen-native-live.mjs';

const RATE = 32000; // mono PCM16, 16 kHz
const FRAME = 640; // 20 ms, for local silence detection
const ASR_PROTOCOLS = new Set(['qwen-asr-realtime', 'qwen-asr-native-live', 'qwen-asr-chat', 'qwen-asr-native', 'openai-asr', 'tencent-translation']);
const REALTIME_MODELS = new Set([QWEN_REALTIME_MODEL, `${QWEN_REALTIME_MODEL}-2025-10-27`, `${QWEN_REALTIME_MODEL}-2026-02-10`]);
const defaults = Object.freeze({ startMs: 10000, setupMs: 15000, idleMs: 20000, finishMs: 10000,
  requestMs: 30000, maxSessionMs: 120 * 60000, audioQueueBytes: RATE * 3,
  bufferedBytes: 256 * 1024, segmentSeconds: 8, silenceMs: 660, segmentQueue: 3,
  translationQueue: 16, translationConcurrency: 2, maxClients: 4, maxSentences: 10000 });

// Deadlines follow audio duration, rather than adding a fresh full-frame delay
// after each callback. Otherwise timer/serialization overhead accumulates over
// a long lecture even while the connection is healthy.
export function createAudioPacer({ now = () => performance.now(), bytesPerSecond = RATE, maxCatchUpMs = 200 } = {}) {
  let deadline = null;
  return {
    delayMs() { return deadline === null ? 0 : Math.max(0, deadline - now()); },
    advance(bytes) {
      const current = now();
      // Bound recovery after a long event-loop stall. At 100 ms per frame this
      // permits at most 300 ms immediately, then returns to paced transmission.
      deadline = Math.max(deadline ?? current, current - maxCatchUpMs) + bytes / bytesPerSecond * 1000;
    },
    reset() { deadline = null; },
  };
}

function qwenEndpoint(profile) {
  const url = new URL(profile.baseUrl || 'https://dashscope.aliyuncs.com');
  const approved = url.hostname === 'dashscope.aliyuncs.com'
    || /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cn-beijing\.maas\.aliyuncs\.com$/.test(url.hostname);
  if (!approved || url.protocol !== 'https:' || url.username || url.password || url.port
    || url.pathname !== '/' || url.search || url.hash || !REALTIME_MODELS.has(profile.model || QWEN_REALTIME_MODEL)) throw new Error();
  if (typeof profile.apiKey !== 'string' || !profile.apiKey.trim() || profile.apiKey.length > 4096 || /[\r\n]/.test(profile.apiKey)) throw new Error();
  url.protocol = 'wss:'; url.pathname = '/api-ws/v1/realtime';
  url.searchParams.set('model', profile.model || QWEN_REALTIME_MODEL);
  return url.toString();
}

function wave(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF'); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24); header.writeUInt32LE(RATE, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function validText(value, max) { return typeof value === 'string' && value.length <= max; }
function kill(socket) {
  // terminate() also cancels a CONNECTING handshake. Keep its error listener.
  if (!socket || socket.readyState >= 3) return;
  try { socket.terminate(); } catch { try { socket.close(); } catch { /* sanitized */ } }
}

/**
 * Attach one local classroom session at a time. Credentials come exclusively
 * from store.resolve(selectedId), never from browser messages or returned events.
 * financeReference is injected by server.mjs to avoid an import cycle.
 * Optional transport/adapters/limits are dependency injection for offline tests.
 *
 * Qwen protocol sources:
 * https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events
 * https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-server-events
 * https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process
 */
export function attachLiveServer(server, { store, financeReference = () => ({}),
  WebSocketImpl = WebSocket, WebSocketServerImpl = WebSocketServer,
  transcribeImpl = transcribe, translateImpl = translate, nativeLiveFactory = createQwenNativeLive,
  pacingNow = () => performance.now(), limits = {} } = {}) {
  if (!store || typeof store.resolve !== 'function' || typeof store.list !== 'function') throw new Error('Live service requires a profile store.');
  const cap = { ...defaults, ...limits };
  const wss = new WebSocketServerImpl({ noServer: true, maxPayload: 32768, perMessageDeflate: false, closeTimeout: 1000 });
  const sessions = new Set();
  let active = null, disposed = false;

  const upgrade = (req, socket, head) => {
    const port = server.address()?.port;
    const host = req.headers.host;
    const local = ['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
    const allowedHost = [`127.0.0.1:${port}`, `localhost:${port}`].includes(host);
    if (disposed || req.url !== '/api/live' || req.method !== 'GET' || !local || !allowedHost
      || req.headers.origin !== `http://${host}` || sessions.size >= cap.maxClients) {
      try { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); } finally { socket.destroy(); }
      return;
    }
    wss.handleUpgrade(req, socket, head, client => createSession(client));
  };

  function createSession(client) {
    let phase = 'waiting', mode, asr, translator, translationId;
    let glossary = '', context = '', domainRules = [];
    let upstream, nativeLive, upstreamFinished = false, upstreamReady = false, finishSent = false;
    let startAt = 0, receivedBytes = 0, sequence = 0;
    let setupTimer, idleTimer, lifeTimer, finishTimer, paceTimer;
    let audioQueue = [], audioQueueBytes = 0, pacing = false;
    const audioPacer = createAudioPacer({ now: pacingNow });
    let frameTail = Buffer.alloc(0), preRoll = [], segmentFrames = [], segmentBytes = 0, silentMs = 0;
    const segmentQueue = [], translations = [], requestControllers = new Set();
    let asrBusy = false, translationsBusy = 0;
    const items = new Set(), byRemoteId = new Map(), seenEvents = new Set();
    let recording = null;
    const sessionAbort = new AbortController();
    const handle = { close: () => end(false) };
    sessions.add(handle);

    const emit = value => {
      if (phase === 'ended' || client.readyState !== 1) return false;
      if ((client.bufferedAmount || 0) > cap.bufferedBytes) { end(false); return false; }
      try {
        client.send(JSON.stringify(value), error => { if (error) end(false); });
        return phase !== 'ended';
      } catch { end(false); return false; }
    };
    function end(notify = true) {
      if (phase === 'ended') return;
      if (notify) emit({ type: 'stopped' });
      phase = 'ended';
      for (const timer of [setupTimer, idleTimer, lifeTimer, finishTimer, paceTimer, startTimer]) clearTimeout(timer);
      sessionAbort.abort();
      for (const controller of requestControllers) controller.abort();
      kill(upstream);
      nativeLive?.close();
      audioQueue = []; audioQueueBytes = 0; segmentQueue.length = 0; translations.length = 0;
      preRoll = []; segmentFrames = []; frameTail = Buffer.alloc(0);
      sessions.delete(handle); if (active === handle) active = null;
      if (notify && client.readyState === 1) {
        try { client.close(1000, 'Session stopped'); } catch { kill(client); }
      } else kill(client);
    }
    const fail = message => {
      if (phase === 'ended') return;
      emit({ type: 'error', message }); end();
    };
    const startTimer = setTimeout(() => fail('连接等待超时，请重新开始。'), cap.startMs);
    function refreshIdle() {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail('长时间未收到麦克风音频，已断开语音 API。'), cap.idleMs);
    }
    function maybeDone() {
      if (phase === 'stopping' && upstreamFinished && !asrBusy && !segmentQueue.length
        && !translationsBusy && !translations.length) end();
    }
    async function request(fn) {
      const controller = new AbortController();
      requestControllers.add(controller);
      const onAbort = () => controller.abort();
      sessionAbort.signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => controller.abort(), cap.requestMs);
      let abortListener;
      try {
        if (sessionAbort.signal.aborted) controller.abort();
        return await Promise.race([
          Promise.resolve().then(() => {
            if (controller.signal.aborted) throw new Error('cancelled');
            return fn(controller.signal);
          }),
          new Promise((_, reject) => {
            abortListener = () => reject(new Error('cancelled'));
            controller.signal.addEventListener('abort', abortListener, { once: true });
            if (controller.signal.aborted) abortListener();
          }),
        ]);
      } finally {
        clearTimeout(timer); controller.signal.removeEventListener('abort', abortListener);
        sessionAbort.signal.removeEventListener('abort', onAbort); requestControllers.delete(controller);
      }
    }
    function translateNext() {
      if (phase === 'ended') return;
      while (translationsBusy < cap.translationConcurrency && translations.length) {
        const sentence = translations.shift(); translationsBusy++;
        request(signal => translateImpl(translator, { source: sentence.source, glossary, context, domainRules, signal,
          onText: target => {
            if (signal.aborted || phase === 'ended') return;
            if (!validText(target, 65536)) throw new Error('Invalid translation chunk.');
            if (target) emit({ type: 'translation', id: sentence.id, target, done: false });
          },
        }))
          .then(result => {
            if (phase === 'ended') return;
            if (!validText(result?.target, 65536)) throw new Error();
            emit({ type: 'translation', id: sentence.id, target: result.target.trim(), done: true });
          }).catch(() => {
            if (phase === 'ended') return;
            emit({ type: 'final', id: sentence.id, source: sentence.source, translationStatus: 'error' });
            emit({ type: 'status', message: '一句译文未完成；英文字幕已保留。请检查翻译 API。' });
          }).finally(() => { translationsBusy--; translateNext(); maybeDone(); });
      }
    }
    function final(sentence, source, builtinTarget) {
      if (!validText(source, 65536)) { fail('语音 API 返回了无效字幕。'); return; }
      source = source.trim();
      if (sentence.final) {
        if (sentence.source !== source) fail('语音 API 返回了冲突的定稿字幕，已停止以避免串句。');
        return;
      }
      sentence.final = true; sentence.source = source;
      if (recording === sentence) recording = null;
      if (!source) { emit({ type: 'final', id: sentence.id, source: '', target: '', translationStatus: 'done' }); return; }
      if (translationId === 'none' || translationId === 'builtin') {
        emit({ type: 'final', id: sentence.id, source, target: translationId === 'builtin' && validText(builtinTarget, 65536) ? builtinTarget.trim() : '', translationStatus: 'done' });
      } else {
        if (translations.length + translationsBusy >= cap.translationQueue) { fail('翻译 API 跟不上讲话速度，已停止以避免积压。'); return; }
        emit({ type: 'final', id: sentence.id, source, translationStatus: 'pending' });
        if (phase === 'ended') return;
        translations.push(sentence); translateNext();
      }
    }

    function newItem(remoteId) {
      if (items.size >= cap.maxSentences) throw new Error();
      const sentence = { id: `sentence-${++sequence}`, remoteId, submitted: false, created: false, final: false };
      items.add(sentence); if (remoteId) byRemoteId.set(remoteId, sentence);
      return sentence;
    }
    function readId(event, key = 'item_id') {
      if (!Object.hasOwn(event, key)) return undefined;
      const value = event[key];
      if (typeof value !== 'string' || !value || value.length > 256) throw new Error();
      return value;
    }
    function choose(candidates) { if (candidates.length > 1) throw new Error(); return candidates[0]; }
    function resolveItem(id, kind) {
      if (id && byRemoteId.has(id)) return byRemoteId.get(id);
      const pending = [...items].filter(item => !item.final);
      let sentence;
      if (kind === 'start') sentence = null; // A new recording may overlap an earlier result.
      else if (kind === 'created' || kind === 'final') {
        const submitted = pending.filter(item => item.submitted && (kind !== 'created' || !item.created));
        sentence = choose(submitted) || choose(pending.filter(item => kind !== 'created' || !item.created));
      } else sentence = choose(pending);
      if (sentence && id && sentence.remoteId && sentence.remoteId !== id) {
        // Explicit IDs distinguish concurrent utterances; do not alias two IDs.
        sentence = null;
      }
      if (!sentence) {
        if (!id && kind === 'final' && items.size) throw new Error();
        sentence = newItem(id);
      } else if (id) { sentence.remoteId = id; byRemoteId.set(id, sentence); }
      return sentence;
    }
    function sendUpstream(type, body = {}) {
      if (phase === 'ended') return false;
      if (!upstream || upstream.readyState !== 1 || (upstream.bufferedAmount || 0) > cap.bufferedBytes) {
        fail('语音 API 连接中断或发送积压，已停止。'); return false;
      }
      try {
        upstream.send(JSON.stringify({ event_id: `event_${randomUUID()}`, type, ...body }), error => {
          if (error) fail('向语音 API 发送音频失败，已停止。');
        });
        return phase !== 'ended';
      } catch { fail('向语音 API 发送音频失败，已停止。'); return false; }
    }
    function drainAudio() {
      if (phase === 'ended' || !upstreamReady || pacing) return;
      if (!audioQueue.length) {
        audioPacer.reset();
        if (phase === 'stopping' && !finishSent) {
          finishSent = true;
          if (nativeLive) { if (!nativeLive.finish()) fail('语音 API 无法完成当前识别。'); }
          else sendUpstream('session.finish');
        }
        return;
      }
      const wait = audioPacer.delayMs();
      if (wait > 0) {
        pacing = true;
        paceTimer = setTimeout(() => { pacing = false; drainAudio(); }, wait);
        return;
      }
      const chunk = audioQueue.shift(); audioQueueBytes -= chunk.length;
      pacing = true;
      audioPacer.advance(chunk.length);
      if (nativeLive) {
        if (!nativeLive.sendPCM(chunk)) { fail('语音 API 连接中断或发送积压，已停止。'); return; }
      } else if (!sendUpstream('input_audio_buffer.append', { audio: chunk.toString('base64') })) return;
      paceTimer = setTimeout(() => { pacing = false; drainAudio(); }, audioPacer.delayMs());
    }
    function markReady() {
      if (phase !== 'starting') return;
      clearTimeout(setupTimer); phase = 'running'; startAt = Date.now();
      refreshIdle();
      emit({ type: 'ready', mode, asrLabel: asr.label || '语音 API',
        translationLabel: translationId === 'none' ? '仅英文' : translationId === 'builtin' ? '腾讯内置翻译' : translator.label || '翻译 API' });
    }
    function openNativeQwen() {
      const receive = (event, complete) => {
        if (phase === 'ended' || upstreamFinished) return;
        if (!validText(event?.id, 256) || !event.id || !validText(event?.source, 65536)) {
          fail('语音 API 返回了无效字幕。'); return;
        }
        const sentence = byRemoteId.get(event.id) || newItem(event.id);
        if (complete) final(sentence, event.source);
        else if (!sentence.final) emit({ type: 'partial', id: sentence.id, source: event.source });
      };
      setupTimer = setTimeout(() => fail('Qwen 持续流式识别初始化超时。'), cap.setupMs);
      nativeLive = nativeLiveFactory(asr, {
        glossary, context, signal: sessionAbort.signal, WebSocketImpl,
        onReady: () => { if (phase === 'starting') { upstreamReady = true; markReady(); drainAudio(); } },
        onPartial: event => receive(event, false), onFinal: event => receive(event, true),
        onFinished: () => {
          if (phase === 'ended') return;
          upstreamFinished = true;
          if (phase !== 'stopping') fail('语音 API 提前结束了本次课堂。');
          else maybeDone();
        },
        onError: () => fail('Qwen 持续流式识别连接失败，请检查语音 API 配置和网络。'),
      });
      if (phase === 'ended') nativeLive?.close();
    }
    function openQwen() {
      let url;
      try { url = qwenEndpoint(asr); } catch { fail('请检查 Qwen 实时模型、北京业务空间地址和 API Key 配置。'); return; }
      try {
        upstream = new WebSocketImpl(url, { headers: { Authorization: `Bearer ${asr.apiKey}`, 'OpenAI-Beta': 'realtime=v1' },
          followRedirects: false, maxRedirects: 0, handshakeTimeout: cap.setupMs, closeTimeout: 1000,
          maxPayload: 512 * 1024, perMessageDeflate: false });
      } catch { fail('无法连接 Qwen 实时语音 API。'); return; }
      setupTimer = setTimeout(() => fail('Qwen 实时语音 API 初始化超时。'), cap.setupMs);
      upstream.on('error', () => { if (!upstreamFinished) fail('Qwen 实时语音连接出错，请检查配置和网络。'); });
      upstream.on('close', () => { if (!upstreamFinished && phase !== 'ended') fail('Qwen 提前关闭了实时语音连接。'); });
      upstream.on('open', () => {
        if (phase === 'ended') { kill(upstream); return; }
        sendUpstream('session.update', { session: { modalities: ['text'], input_audio_format: 'pcm', sample_rate: 16000,
          input_audio_transcription: { language: 'en' }, turn_detection: { type: 'server_vad', threshold: 0.0, silence_duration_ms: 600 } } });
      });
      upstream.on('message', (data, isBinary) => {
        if (phase === 'ended' || upstreamFinished) return;
        try {
          if (isBinary || (!Buffer.isBuffer(data) && typeof data !== 'string')) throw new Error();
          const event = JSON.parse(data.toString());
          if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') throw new Error();
          if (event.event_id !== undefined) {
            if (!validText(event.event_id, 256) || !event.event_id) throw new Error();
            if (seenEvents.has(event.event_id)) return;
            seenEvents.add(event.event_id);
            if (seenEvents.size > 4096) seenEvents.delete(seenEvents.values().next().value);
          }
          if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
            fail('Qwen 拒绝了语音请求，请检查模型权限、余额和配置。'); return;
          }
          if (event.type === 'session.updated') {
            if (phase === 'starting') { upstreamReady = true; markReady(); }
            return;
          }
          if (event.type === 'session.finished') {
            if (!finishSent || phase !== 'stopping') throw new Error();
            upstreamFinished = true; kill(upstream); maybeDone(); return;
          }
          if (event.type === 'input_audio_buffer.speech_started') {
            recording = resolveItem(readId(event), 'start'); return;
          }
          if (event.type === 'input_audio_buffer.speech_stopped' || event.type === 'input_audio_buffer.committed') {
            const id = readId(event);
            if (!id && event.type === 'input_audio_buffer.committed') return;
            const sentence = id && byRemoteId.get(id) || recording || resolveItem(id, 'stop');
            if (id && sentence.remoteId && sentence.remoteId !== id) throw new Error();
            if (id && !sentence.remoteId) { sentence.remoteId = id; byRemoteId.set(id, sentence); }
            sentence.submitted = true; if (recording === sentence) recording = null; return;
          }
          if (event.type === 'conversation.item.created') {
            if (!event.item || typeof event.item !== 'object' || Array.isArray(event.item)) throw new Error();
            const sentence = resolveItem(readId(event.item, 'id'), 'created');
            sentence.created = true; sentence.submitted = true;
            if (recording === sentence) recording = null;
            return; // item.status='completed' is not a transcript final.
          }
          if (event.type === 'conversation.item.input_audio_transcription.text'
            || event.type === 'conversation.item.input_audio_transcription.completed') {
            if ((event.content_index ?? 0) !== 0) throw new Error();
            const complete = event.type.endsWith('.completed');
            const sentence = resolveItem(readId(event), complete ? 'final' : 'partial');
            if (complete) final(sentence, event.transcript);
            else {
              if (!validText(event.text ?? '', 65536) || !validText(event.stash ?? '', 65536)
                || (event.text ?? '').length + (event.stash ?? '').length > 65536) throw new Error();
              if (!sentence.final) emit({ type: 'partial', id: sentence.id, source: (event.text ?? '') + (event.stash ?? '') });
            }
          }
        } catch { fail('语音 API 返回的句子无法安全对应，已停止以避免字幕串句。'); }
      });
    }

    function segmentNext() {
      if (phase === 'ended' || asrBusy || !segmentQueue.length) { maybeDone(); return; }
      asrBusy = true;
      const pcm = segmentQueue.shift(), sentence = { id: `sentence-${++sequence}`, final: false };
      request(signal => transcribeImpl(asr, { pcm, wav: wave(pcm), duration: pcm.length / RATE, glossary, context, signal }))
        .then(result => { if (phase !== 'ended') final(sentence, result?.source, result?.target); })
        .catch(() => { if (phase !== 'ended') fail('语音 API 分句识别失败，请检查配置和网络。'); })
        .finally(() => { asrBusy = false; segmentNext(); maybeDone(); });
    }
    function flushSegment() {
      if (!segmentBytes || phase === 'ended') return;
      let pcm = Buffer.concat(segmentFrames, segmentBytes);
      segmentFrames = []; segmentBytes = 0; silentMs = 0;
      if (pcm.length < RATE / 10) pcm = Buffer.concat([pcm, Buffer.alloc(RATE / 10 - pcm.length)]);
      if (segmentQueue.length + Number(asrBusy) >= cap.segmentQueue) { fail('语音 API 跟不上讲话速度，已停止以避免音频积压。'); return; }
      segmentQueue.push(pcm); segmentNext();
    }
    function acceptSegmented(chunk) {
      // Qwen chat receives a complete clip; retain more phrase context before
      // ending at a pause. The hard cap and explicit-stop tail stay unchanged.
      const minimumPauseBytes = (asr.protocol === 'qwen-asr-chat' ? 5 : 1) * RATE;
      const data = Buffer.concat([frameTail, chunk]); let offset = 0;
      for (; offset + FRAME <= data.length && phase !== 'ended'; offset += FRAME) {
        const frame = Buffer.from(data.subarray(offset, offset + FRAME));
        let power = 0;
        for (let i = 0; i < frame.length; i += 2) power += frame.readInt16LE(i) ** 2;
        const voiced = Math.sqrt(power / (frame.length / 2)) >= 260;
        if (!segmentBytes && !voiced) { preRoll.push(frame); if (preRoll.length > 10) preRoll.shift(); continue; }
        if (!segmentBytes) { segmentFrames.push(...preRoll); segmentBytes += preRoll.length * FRAME; preRoll = []; }
        segmentFrames.push(frame); segmentBytes += FRAME; silentMs = voiced ? 0 : silentMs + 20;
        if (segmentBytes >= cap.segmentSeconds * RATE || (silentMs >= cap.silenceMs && segmentBytes >= minimumPauseBytes)) flushSegment();
      }
      frameTail = phase === 'ended' ? Buffer.alloc(0) : Buffer.from(data.subarray(offset));
    }
    function stop() {
      if (phase === 'ended' || phase === 'stopping') return;
      if (phase !== 'running') { end(); return; }
      phase = 'stopping'; clearTimeout(idleTimer); clearTimeout(lifeTimer);
      emit({ type: 'status', message: '正在收尾已收到的语音和译文…' });
      finishTimer = setTimeout(() => {
        if (phase !== 'ended') emit({ type: 'status', message: '收尾时间已到，已关闭全部 API 连接。' });
        end();
      }, cap.finishMs);
      if (mode === 'streaming') drainAudio();
      else {
        if (segmentBytes && frameTail.length) { segmentFrames.push(frameTail); segmentBytes += frameTail.length; }
        frameTail = Buffer.alloc(0); flushSegment(); upstreamFinished = true; maybeDone();
      }
    }
    function start(input) {
      if (phase !== 'waiting') { fail('当前连接已启动；切换 API 前请先停止。'); return; }
      if (active) { fail('已有一个课堂正在运行，请先停止另一个窗口。'); return; }
      try {
        if (!validText(input.asrId, 100) || !validText(input.translationId || 'none', 100)
          || !validText(input.glossary ?? '', 3000) || !validText(input.context ?? '', 3000)
          || !validText(input.financeCourse || 'general', 100)) throw new Error();
        const maxMinutes = input.maxMinutes ?? 45;
        if (!Number.isFinite(maxMinutes) || maxMinutes <= 0 || maxMinutes > 120) throw new Error();
        const profiles = store.list();
        const publicAsr = profiles.find(p => p.id === input.asrId);
        translationId = input.translationId || 'none';
        const publicTranslator = profiles.find(p => p.id === translationId);
        if (!publicAsr?.configured || !ASR_PROTOCOLS.has(publicAsr.protocol)) throw new Error();
        if (translationId === 'builtin' && publicAsr.protocol !== 'tencent-translation') throw new Error();
        if (!['none', 'builtin'].includes(translationId) && (!publicTranslator?.configured || publicTranslator.protocol !== 'openai-chat')) throw new Error();
        asr = { ...store.resolve(input.asrId) }; validateBase(asr.baseUrl);
        if (!ASR_PROTOCOLS.has(asr.protocol)) throw new Error();
        if (publicTranslator) { translator = { ...store.resolve(translationId) }; validateBase(translator.baseUrl); if (translator.protocol !== 'openai-chat') throw new Error(); }
        const finance = financeReference(input.financeCourse || 'general') || {};
        glossary = [input.glossary, finance.glossary].filter(Boolean).join('\n');
        context = [finance.context, input.context].filter(Boolean).join('\n');
        domainRules = Array.isArray(finance.rules) ? finance.rules : [];
        mode = ['qwen-asr-realtime', 'qwen-asr-native-live'].includes(asr.protocol) ? 'streaming' : 'segmented';
        phase = 'starting'; active = handle; clearTimeout(startTimer);
        const maxMs = Math.min(maxMinutes * 60000, cap.maxSessionMs);
        handle.maxBytes = maxMs / 1000 * RATE;
        lifeTimer = setTimeout(() => fail('已到本次课堂的时长上限，API 连接已关闭。'), maxMs);
        if (asr.protocol === 'qwen-asr-native-live') openNativeQwen();
        else if (mode === 'streaming') openQwen(); else { upstreamFinished = true; markReady(); }
      } catch { fail('请选择已配置的语音和翻译 API，并检查课程选项。'); }
    }
    client.on('message', (data, isBinary) => {
      if (phase === 'ended') return;
      if (isBinary) {
        if (phase === 'stopping') return; // Never forward audio received after stop.
        if (phase !== 'running' || !Buffer.isBuffer(data) || !data.length || data.length > 32768 || data.length % 2) {
          fail('请等待就绪后发送 16kHz 单声道 PCM16 音频。'); return;
        }
        receivedBytes += data.length;
        if (receivedBytes > handle.maxBytes) { fail('音频已达到课堂时长上限，API 连接已关闭。'); return; }
        if (receivedBytes > (Date.now() - startAt) / 1000 * RATE + RATE * 2) { fail('音频发送速度超过实时速率，API 连接已关闭。'); return; }
        refreshIdle();
        if (mode === 'streaming') {
          if (audioQueueBytes + data.length > cap.audioQueueBytes) { fail('实时音频发送积压，API 连接已关闭。'); return; }
          for (let offset = 0; offset < data.length; offset += 3200) {
            const chunk = Buffer.from(data.subarray(offset, Math.min(offset + 3200, data.length)));
            audioQueue.push(chunk); audioQueueBytes += chunk.length;
          }
          drainAudio();
        } else acceptSegmented(data);
        return;
      }
      try {
        if ((!Buffer.isBuffer(data) && typeof data !== 'string') || Buffer.byteLength(data) > 16384) throw new Error();
        const input = JSON.parse(data.toString());
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error();
        if (input.type === 'start') start(input);
        else if (input.type === 'stop') stop();
        else throw new Error();
      } catch { fail('课堂控制消息格式无效。'); }
    });
    client.on('error', () => end(false));
    client.on('close', () => end(false));
  }
  server.on('upgrade', upgrade);
  const close = () => {
    if (disposed) return;
    disposed = true; server.off('upgrade', upgrade); server.off('close', close);
    for (const session of [...sessions]) session.close();
    wss.close();
  };
  server.once('close', close);
  return { close };
}
