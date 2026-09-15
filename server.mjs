import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Store, protocols } from './store.mjs';
import { parseWav, wordErrorRate } from './audio.mjs';
import { transcribe, translate } from './adapters.mjs';
import { attachLiveServer } from './live-session.mjs';
import { LIVE_DRAFT_BYTES, readLiveDraft, writeLiveDraft } from './live-draft.mjs';
import { CORRECTION_BODY_BYTES, CorrectionError, correctContext, createContextCorrectionService } from './context-correction.mjs';
import { LIVE_EXPORT_BODY_BYTES, LiveExportError, createLiveExportService } from './live-export.mjs';

const dir = path.dirname(fileURLToPath(import.meta.url));
const pages = new Map([
  ['/', 'live.html'], ['/index.html', 'live.html'], ['/compare', 'index.html'], ['/compare/', 'index.html'],
  ...['live.html', 'live.js', 'live.css', 'fullscreen.js', 'context-correction.js', 'context-panel.js', 'app.js', 'styles.css', 'pcm-worklet.js'].map(x => [`/${x}`, x]),
]);
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const capabilities = new Map(protocols.map(p => [p.id, p.capabilities]));
function financePack() { return JSON.parse(fs.readFileSync(path.join(dir, 'finance-pack.json'), 'utf8')); }

export function financeReference(courseId = 'general') {
  if (courseId === 'none') return { id: 'none', label: '不启用金融词库', glossary: '', context: '', rules: [], count: 0 };
  const pack = financePack();
  const chosen = pack.courses.find(c => c.id === courseId);
  if (!chosen) throw new Error('请选择有效的金融课程。');
  const general = pack.courses.find(c => c.id === 'general');
  const terms = new Map([...(general?.terms || []), ...chosen.terms].map(t => [t.en.toLowerCase(), t]));
  return { id: courseId, label: chosen.label, glossary: [...terms.values()].map(t => `${t.en} = ${t.zh}${t.note ? ` (${t.note})` : ''}`).join('\n'),
    context: `Master-level finance lecture. ${chosen.context}`, rules: pack.rules, count: terms.size };
}

function json(res, status, value) {
  if (res.destroyed) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function readJson(req, limit = 3_000_000) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求过大，单次音频最多 60 秒。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('请求 JSON 无效。'); }
}
function limited(value, length, name) {
  const result = String(value || '').trim();
  if (result.length > length) throw new Error(`${name}过长。`);
  return result;
}

export async function analyze(input, { store, signal, speech = transcribe, translation = translate }) {
  if (!Array.isArray(input.pipelines) || input.pipelines.length < 1 || input.pipelines.length > 3) throw new Error('请选择 1–3 条对比方案。');
  if (typeof input.audio !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.audio)) throw new Error('音频编码无效。');
  const audio = parseWav(Buffer.from(input.audio, 'base64'));
  const userGlossary = limited(input.glossary, 3000, '术语表');
  const userContext = limited(input.context, 3000, '课程背景');
  const finance = financeReference(input.financeCourse || 'general');
  const glossary = [userGlossary, finance.glossary].filter(Boolean).join('\n');
  const context = [finance.context, userContext].filter(Boolean).join('\n');
  const reference = limited(input.reference, 6000, '人工参考');
  const publicProfiles = store.list();
  const seen = new Set();
  const pipelines = input.pipelines.map((p, index) => {
    if (!p || typeof p !== 'object') throw new Error('方案格式无效。');
    const id = limited(p.id || `pipeline-${index}`, 100, '方案 ID');
    if (seen.has(id)) throw new Error('方案 ID 不能重复。');
    seen.add(id);
    const asr = publicProfiles.find(x => x.id === p.asrId);
    if (!asr || !asr.configured || !asr.capabilities.includes('asr')) throw new Error(`请先配置语音 API：${asr?.label || '未选择'}。`);
    const translationId = p.translationId || 'none';
    const translator = publicProfiles.find(x => x.id === translationId);
    if (translationId === 'builtin' && asr.protocol !== 'tencent-translation') throw new Error('内置译文只适用于腾讯语音翻译。');
    if (!['builtin', 'none'].includes(translationId) && (!translator?.configured || !translator.capabilities.includes('translation'))) throw new Error(`请先配置翻译 API：${translator?.label || '未选择'}。`);
    return { id, label: limited(p.label || `方案 ${index + 1}`, 100, '方案名称'), asrId: p.asrId, translationId };
  });
  signal?.throwIfAborted();
  const sharedSpeech = new Map();
  const sharedTranslation = new Map();
  const getSpeech = id => {
    if (!sharedSpeech.has(id)) sharedSpeech.set(id, (async () => {
      const start = performance.now();
      const output = await speech(store.resolve(id), { ...audio, glossary, context, signal });
      if (typeof output.source !== 'string') throw new Error('语音 API 未返回有效文字。');
      if (output.source.length > 30000) throw new Error('识别结果超出长度限制。');
      return { ...output, elapsed: Math.round(performance.now() - start) };
    })());
    return sharedSpeech.get(id);
  };
  const results = await Promise.all(pipelines.map(async p => {
    const start = performance.now();
    const result = { id: p.id, label: p.label, asrId: p.asrId, translationId: p.translationId,
      status: 'error', source: '', target: '', asrMs: 0, translationMs: 0, totalMs: 0, wer: null };
    try {
      const asr = await getSpeech(p.asrId);
      signal?.throwIfAborted();
      result.source = asr.source; result.asrMs = asr.elapsed;
      result.usage = { asr: asr.usage || null, translation: null, sharedAsr: pipelines.filter(x => x.asrId === p.asrId).length > 1 };
      if (p.translationId === 'builtin') result.target = asr.target || '';
      else if (p.translationId !== 'none' && asr.source.trim()) {
        signal?.throwIfAborted();
        const key = `${p.asrId}:${p.translationId}`;
        if (!sharedTranslation.has(key)) sharedTranslation.set(key, (async () => {
          const begun = performance.now();
          const output = await translation(store.resolve(p.translationId), { source: asr.source, glossary, context, domainRules: finance.rules, signal });
          return { ...output, elapsed: Math.round(performance.now() - begun) };
        })());
        const translated = await sharedTranslation.get(key);
        result.target = translated.target;
        result.translationMs = translated.elapsed;
        result.usage.translation = translated.usage || null;
      }
      signal?.throwIfAborted();
      result.wer = reference ? wordErrorRate(reference, result.source) : null;
      result.status = 'ok';
    } catch (error) {
      // Adapters expose sanitized errors only. Never include arbitrary upstream diagnostics.
      result.error = signal?.aborted ? '本次分析已取消或超时。' : error.code ? `API 调用失败（${String(error.code).slice(0, 40)}），请检查模型、余额与权限。` : 'API 调用失败，请检查配置、音频与服务状态。';
    }
    result.totalMs = Math.round(performance.now() - start);
    return result;
  }));
  const report = { id: crypto.randomUUID(), createdAt: new Date().toISOString(), duration: audio.duration,
    results, referenceProvided: Boolean(reference), reference, glossary: userGlossary, context: userContext,
    financeCourse: finance.id, financeLabel: finance.label, builtinTermCount: finance.count, saved: false,
    note: 'WER 仅比较英文识别结果；翻译质量需要人工核对。同一语音配置在本次比较中只调用一次。' };
  if (input.save !== false && !signal?.aborted) {
    try { report.saved = true; store.saveReport(report); } catch { report.saved = false; }
  }
  return report;
}

export function createApp({ store = new Store(), speech = transcribe, translation = translate,
  correction = correctContext, correctionTimeoutMs = 15000, exportRoot } = {}) {
  let active = null;
  const corrections = createContextCorrectionService({ store, financeReference, correction, timeoutMs: correctionTimeoutMs });
  const exports = createLiveExportService({ exportRoot });
  const server = http.createServer(async (req, res) => {
    const port = server.address()?.port;
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`)) ||
        (req.method !== 'GET' && !req.headers.origin)) return json(res, 403, { error: '仅允许本机页面访问。' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}; img-src 'self' data:; media-src 'self' blob:; frame-ancestors 'none'`);
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (req.method === 'GET' && pages.has(url.pathname)) {
        const file = pages.get(url.pathname);
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-store' });
        return res.end(fs.readFileSync(path.join(dir, 'public', file)));
      }
      if (req.method === 'GET' && url.pathname === '/api/profiles') return json(res, 200, { profiles: store.list(), protocols });
      if (req.method === 'GET' && url.pathname === '/api/finance-pack') return json(res, 200, financePack());
      if (req.method === 'POST' && url.pathname === '/api/live-export') {
        if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
          || req.headers.origin !== `http://${req.headers.host}`) return json(res, 403, { error: '字幕导出仅允许同源本机页面访问。' });
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 格式。' });
        if (Number(req.headers['content-length']) > LIVE_EXPORT_BODY_BYTES) return json(res, 413, { error: '字幕导出正文过大，请使用页面的下载功能。' });
        let input;
        try { input = await readJson(req, LIVE_EXPORT_BODY_BYTES); }
        catch { return json(res, 400, { error: '字幕导出格式无效或正文过大，请使用页面的下载功能。' }); }
        try { return json(res, 200, await exports.exportText(input)); }
        catch (error) { return json(res, error instanceof LiveExportError ? error.status : 500, {
          error: error instanceof LiveExportError ? error.message : '自动保存字幕未成功，请使用页面的下载功能保存 TXT。' }); }
      }
      if (url.pathname === '/api/context-correction/profiles' || url.pathname === '/api/context-correction') {
        if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
          || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return json(res, 403, { error: '上下文校正仅允许同源本机页面访问。' });
        if (req.method === 'GET' && url.pathname.endsWith('/profiles')) return json(res, 200, corrections.profiles());
        if (req.method === 'POST' && url.pathname === '/api/context-correction') {
          if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 格式。' });
          if (Number(req.headers['content-length']) > CORRECTION_BODY_BYTES) return json(res, 413, { error: '校正正文最多 48 KiB，请缩短当前段或前后文。' });
          if (corrections.busy) return json(res, 409, { error: '另一个上下文校正正在进行，请稍后重试。' });
          const controller = new AbortController();
          const onDisconnect = () => controller.abort();
          res.once('close', onDisconnect);
          try {
            let input;
            try { input = await readJson(req, CORRECTION_BODY_BYTES); }
            catch { return json(res, 400, { error: '校正输入格式无效或超过 48 KiB。' }); }
            const result = await corrections.correct(input, { signal: controller.signal });
            return json(res, 200, result);
          } catch (error) {
            return json(res, error instanceof CorrectionError ? error.status : 502, {
              error: error instanceof CorrectionError ? error.message : '上下文校正未成功。原字幕未改变。' });
          } finally { res.off('close', onDisconnect); controller.abort(); }
        }
      }
      if (url.pathname === '/api/live-draft' && ['GET', 'POST'].includes(req.method)) {
        if (!['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
          || (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)) return json(res, 403, { error: '字幕草稿仅允许同源本机页面访问。' });
        if (req.method === 'GET') return json(res, 200, readLiveDraft(store));
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 格式。' });
        if (Number(req.headers['content-length']) > LIVE_DRAFT_BYTES) return json(res, 413, { error: '字幕草稿最多 2 MiB，请先导出 TXT 保留全部字幕。' });
        try { return json(res, 200, writeLiveDraft(store, await readJson(req, LIVE_DRAFT_BYTES))); }
        catch (error) {
          if (error.code === 'DRAFT_CONFLICT') return json(res, 409, { error: error.message });
          throw error;
        }
      }
      if (req.method === 'POST' && url.pathname === '/api/profiles') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 格式。' });
        return json(res, 200, { profile: store.save(await readJson(req, 16000)) });
      }
      const profilePath = url.pathname.match(/^\/api\/profiles\/([a-zA-Z0-9-]+)$/);
      if (req.method === 'DELETE' && profilePath) { store.remove(profilePath[1]); return json(res, 200, { deleted: true }); }
      if (req.method === 'GET' && url.pathname === '/api/history') return json(res, 200, { items: store.history() });
      const historyPath = url.pathname.match(/^\/api\/history\/([a-f0-9-]{36})$/);
      if (req.method === 'GET' && historyPath) return json(res, 200, store.report(historyPath[1]));
      if (req.method === 'GET' && url.pathname === '/api/demo') {
        const demo = JSON.parse(fs.readFileSync(path.join(dir, '..', 'classroom-translator', 'test-result.json'), 'utf8'));
        const final = new Map();
        for (const message of demo.received) if (message.result?.sentence_end) final.set(message.sentence_id, message.result);
        return json(res, 200, { id: 'historical-tencent-test', createdAt: demo.testedAt, duration: demo.sampleSeconds, isHistorical: true, referenceProvided: false, saved: false,
          results: [{ id: 'demo', label: '腾讯 Lite · 历史真实测试', status: 'ok', source: [...final.values()].map(x => x.source_text).join(' '), target: [...final.values()].map(x => x.target_text).join('\n'), asrMs: null, translationMs: null, totalMs: null, wer: null }],
          note: '此处只展示已有腾讯测试记录。没有调用 Qwen / DeepSeek，也不代表跨模型准确率排名。' });
      }
      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(res, 415, { error: '需要 JSON 格式。' });
        if (active) return json(res, 409, { error: '上一片段正在分析，请稍候。' });
        const controller = new AbortController();
        active = controller;
        const timeout = setTimeout(() => controller.abort(), 95000);
        res.on('close', () => controller.abort());
        try {
          const input = await readJson(req);
          controller.signal.throwIfAborted();
          const report = await analyze(input, { store, signal: controller.signal, speech, translation });
          return json(res, 200, report);
        } finally {
          clearTimeout(timeout); controller.abort();
          if (active === controller) active = null;
        }
      }
      json(res, 404, { error: '未找到此页面或接口。' });
    } catch (error) {
      const message = /[\u3400-\u9fff]/.test(error.message || '') && !error.code ? error.message.slice(0, 200) : '请求失败，请检查输入和本机配置。';
      if (!res.headersSent) json(res, 400, { error: message });
      else res.end();
    }
  });
  server.headersTimeout = 10000;
  server.requestTimeout = 15000;
  const live = attachLiveServer(server, { store, financeReference, transcribeImpl: speech, translateImpl: translation });
  server.stopAnalysis = () => { active?.abort(); live.close(); corrections.close(); };
  server.once('close', () => corrections.close());
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const server = createApp();
  server.listen(8766, '127.0.0.1', () => console.log('实时课堂翻译：http://127.0.0.1:8766'));
  server.on('error', error => { console.error(error.code === 'EADDRINUSE' ? '8766 端口已被使用。' : '平台启动失败。'); process.exitCode = 1; });
  for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => { server.stopAnalysis(); server.close(); });
}
