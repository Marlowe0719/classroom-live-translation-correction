'use strict';

const $ = id => document.getElementById(id);
const ui = Object.fromEntries(['asr-select','translation-select','start-button','stop-button','end-button','clear-button','source-help','finance-course','max-minutes','glossary','context','settings-summary','finance-hint','refresh-profiles','notice','caption-panel','status-text','status-detail','status-dot','timer','display-language','autoscroll','font-down','font-up','export-button','export-status','transcript','empty-state','preview-button','caption-list','sentence-count','mode-note','scroll-bottom'].map(id => [id, $(id)]));
const state = { profiles: [], financePack: null, loading: true, previewing: false, clearing: false, run: null, pausedRun: null, sessions: [], rows: new Map(), fontSize: 29, sequence: 0 };
const draftState = { initializing: true, loaded: false, restoring: false, dirty: false, blocked: false, saving: false, revision: 0, change: 0, timer: null, settingsSignature: '' };
let exportSequence = 0;
const el = (tag, className, text) => { const item = document.createElement(tag); if (className) item.className = className; if (text !== undefined) item.textContent = text; return item; };
const option = (value, text, selected) => { const item = el('option', '', text); item.value = value; item.selected = Boolean(selected); return item; };
function formatTime(seconds) { const n = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
function profile(id) { return state.profiles.find(item => item.id === id); }
function showNotice(message = '', error = false) { ui.notice.textContent = message; ui.notice.className = `notice${error ? ' error' : ''}`; ui.notice.hidden = !message; }
function status(title, detail, variant = '') { ui['status-text'].textContent = title; ui['status-detail'].textContent = detail; ui['status-dot'].className = `status-dot${variant ? ` ${variant}` : ''}`; }
function explain(error) {
  if (error?.name === 'NotAllowedError') return '声音权限未开启，或共享已取消。重新点击开始后，允许麦克风或共享音频即可。';
  if (error?.name === 'NotFoundError') return '没有找到可用音频设备，请检查麦克风或选择电脑声音。';
  if (error?.name === 'NotReadableError') return '无法读取声音，请检查设备是否被其他程序占用。';
  return error?.message || '连接发生错误，请检查本机服务和网络后重试。';
}
async function request(url) {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.message || `请求失败（${response.status}）`);
  return data;
}
function configurationIssue() {
  const asr = profile(ui['asr-select'].value);
  if (!asr?.configured) return '当前语音 API 尚未配置，请打开“API 配置”填写密钥。';
  if (ui['translation-select'].value === 'builtin') return asr.protocol === 'tencent-translation' ? '' : '当前语音 API 不支持腾讯内置译文。';
  const translation = profile(ui['translation-select'].value);
  if (!translation?.configured) return '当前翻译 API 尚未配置，请打开“API 配置”填写密钥。';
  return '';
}
function refreshControls() {
  const active = Boolean(state.run);
  const locked = active || state.loading || state.previewing || state.clearing || draftState.initializing;
  for (const id of ['asr-select','translation-select','finance-course','max-minutes','glossary','context','refresh-profiles']) ui[id].disabled = locked;
  document.querySelectorAll('input[name="source"]').forEach(item => { item.disabled = locked; });
  ui['start-button'].hidden = active;
  ui['start-button'].disabled = locked || Boolean(configurationIssue());
  ui['start-button'].textContent = state.pausedRun ? '▶ 继续翻译' : '▶ 开始实时翻译';
  ui['stop-button'].hidden = !active;
  ui['stop-button'].disabled = Boolean(state.run?.stopping);
  ui['end-button'].hidden = !active && !state.pausedRun;
  ui['end-button'].disabled = state.loading || state.previewing || state.clearing || draftState.initializing || Boolean(state.run?.stopping && state.run.stopMode !== 'pause');
  ui['clear-button'].disabled = locked || draftState.saving || !(state.sessions.length || state.rows.size);
  ui['clear-button'].textContent = state.clearing ? '正在清除…' : '清除本页';
  ui['clear-button'].title = active ? '先暂停或结束翻译，再清除本页' : '清空本页字幕与上下文，保留 API 和课程设置';
  for (const id of ['display-language','autoscroll','font-down','font-up']) ui[id].disabled = state.clearing;
  ui['preview-button'].disabled = locked;
  ui['export-button'].disabled = state.clearing || state.rows.size === 0;
}
function renderTranslations(preferred) {
  const old = preferred || ui['translation-select'].value;
  const useBuiltin = old === 'builtin' && profile(ui['asr-select'].value)?.protocol === 'tencent-translation';
  ui['translation-select'].replaceChildren();
  if (profile(ui['asr-select'].value)?.protocol === 'tencent-translation') ui['translation-select'].append(option('builtin', '腾讯内置译文', old === 'builtin'));
  const available = state.profiles.filter(item => item.capabilities?.includes('translation'));
  const defaultId = available.find(item => item.id === 'qwen-flash-translate' && item.configured)?.id || available.find(item => item.id === 'deepseek-translate')?.id || available.find(item => item.configured)?.id || available[0]?.id;
  const selected = available.some(item => item.id === old) ? old : defaultId;
  for (const item of available) ui['translation-select'].append(option(item.id, `${item.label}${item.configured ? '' : ' · 未配置'}`, !useBuiltin && item.id === selected));
  if (!ui['translation-select'].options.length) ui['translation-select'].append(option('', '请先添加翻译 API', true));
}
async function loadProfiles() {
  if (state.run || state.clearing) return;
  state.loading = true; refreshControls();
  try {
    const data = await request('/api/profiles');
    const oldAsr = ui['asr-select'].value; const oldTranslation = ui['translation-select'].value;
    state.profiles = data.profiles || [];
    const asrs = state.profiles.filter(item => item.capabilities?.includes('asr'));
    const chosen = asrs.some(item => item.id === oldAsr) ? oldAsr : asrs.find(item => item.id === 'qwen-asr-streaming' && item.configured)?.id || asrs.find(item => item.id === 'qwen-realtime' && item.configured)?.id || asrs.find(item => item.configured)?.id || asrs[0]?.id;
    ui['asr-select'].replaceChildren();
    for (const item of asrs) ui['asr-select'].append(option(item.id, `${item.label}${item.configured ? '' : ' · 未配置'}`, item.id === chosen));
    if (!asrs.length) ui['asr-select'].append(option('', '请先添加语音 API', true));
    renderTranslations(oldTranslation); updateSettings();
    const issue = configurationIssue();
    status(issue ? '需要配置 API' : state.rows.size ? '可以继续上课' : '准备就绪', issue || '点击开始后才采集声音，暂停后可切换模型。');
  } catch (error) { status('本机服务未连接', '请确认课堂平台已经启动。', 'error'); showNotice(explain(error), true); }
  finally { state.loading = false; refreshControls(); }
}
function modeDescription(asr, mode) {
  if (asr?.protocol === 'qwen-asr-chat') return '完整短句模式，每5–8秒处理；识别完成后显示。';
  if (mode === 'streaming' || ['qwen-asr-realtime', 'qwen-asr-native-live'].includes(asr?.protocol)) return '英文持续更新，中文逐句跟上。';
  return asr ? '当前语音 API 自动分句处理，字幕会稍晚出现。' : '暂停后切换 API，可以继续这堂课。';
}
function updateSettings() {
  const asr = profile(ui['asr-select'].value);
  ui['mode-note'].textContent = modeDescription(asr);
  const selected = ui['finance-course'].selectedOptions[0];
  ui['settings-summary'].textContent = `${selected?.textContent || '金融通用'} · 最长 ${ui['max-minutes'].value} 分钟`;
  const courseId = ui['finance-course'].value;
  if (courseId === 'none') { ui['finance-hint'].textContent = '金融词库已关闭。补充术语与课堂背景仍用于支持它们的接口。'; return; }
  const courses = state.financePack?.courses || [];
  const general = courses.find(item => item.id === 'general');
  const course = courses.find(item => item.id === courseId);
  const terms = new Set([...(general?.terms || []), ...(course?.terms || [])].map(item => String(item.en).toLowerCase()));
  const count = terms.size ? `${terms.size} 个金融术语` : '金融词库';
  if (ui['translation-select'].value === 'builtin') ui['finance-hint'].textContent = `已选择${count}。腾讯内置译文不应用本平台词库；选择其他翻译 API 后可使用。`;
  else if (asr?.id === 'qwen-asr3' || ['qwen-asr-native', 'qwen-asr-native-live'].includes(asr?.protocol)) ui['finance-hint'].textContent = `已启用${count}，用于热词识别与后续翻译。词库不能修复不清晰的声音。`;
  else if (asr?.protocol === 'qwen-asr-chat') ui['finance-hint'].textContent = `已启用${count}，用于识别背景与后续翻译。词库不能修复不清晰的声音。`;
  else ui['finance-hint'].textContent = `已启用${count}，主要帮助后续文字翻译；当前语音识别不接收这些热词。`;
}
async function loadFinance() { try { state.financePack = await request('/api/finance-pack'); } catch { /* Keep the selected backend course without blocking audio setup. */ } updateSettings(); }
function scrollToLatest(force = false) {
  if (force || ui.autoscroll.checked) ui.transcript.scrollTop = ui.transcript.scrollHeight;
  updateScrollButton();
}
function updateScrollButton() { ui['scroll-bottom'].hidden = ui.transcript.scrollHeight - ui.transcript.scrollTop - ui.transcript.clientHeight < 100; }
function draftSettings() {
  return {
    ...(ui['asr-select'].value ? { asrId: ui['asr-select'].value } : {}),
    ...(ui['translation-select'].value ? { translationId: ui['translation-select'].value } : {}),
    financeCourse: ui['finance-course'].value, maxMinutes: Number(ui['max-minutes'].value),
    source: document.querySelector('input[name="source"]:checked')?.value || 'mic',
    displayLanguage: ui['display-language'].value, autoscroll: ui.autoscroll.checked,
    fontSize: state.fontSize, glossary: ui.glossary.value, context: ui.context.value,
  };
}
function captionDraft() {
  return { version: 1, settings: draftSettings(), sessions: state.sessions.map(session => ({
    id: String(session.id), createdAt: session.createdAt.toISOString(), asrLabel: session.asrLabel,
    translationLabel: session.translationLabel, historical: Boolean(session.historical),
    rows: session.rows.map(row => ({ id: String(row.id), source: row.source, target: row.target,
      final: row.final, translationStatus: row.translationStatus, seconds: row.seconds })),
  })) };
}
function draftChanged() {
  if (!draftState.loaded || draftState.restoring || draftState.blocked) return;
  draftState.dirty = true; draftState.change++;
  if (!draftState.timer && !draftState.saving) draftState.timer = setTimeout(() => { draftState.timer = null; void saveDraft(); }, 5000);
}
function draftSettingsChanged() {
  const signature = JSON.stringify(draftSettings());
  if (signature === draftState.settingsSignature) return;
  draftState.settingsSignature = signature; draftChanged();
}
async function saveDraft(exiting = false) {
  clearTimeout(draftState.timer); draftState.timer = null;
  if (state.clearing || !draftState.loaded || draftState.restoring || draftState.blocked || draftState.saving || !draftState.dirty) return;
  const change = draftState.change;
  let body;
  try { body = JSON.stringify({ expectedRevision: draftState.revision, draft: captionDraft() }); }
  catch { showNotice('字幕草稿暂时无法保存，请导出 TXT 保留当前字幕。', true); return; }
  const size = new TextEncoder().encode(body).byteLength;
  if (size > 2 * 1024 * 1024) {
    draftState.blocked = true; showNotice('当前字幕超过自动草稿大小上限，请导出 TXT 保留全部字幕。', true); return;
  }
  draftState.saving = true; refreshControls();
  try {
    const response = await fetch('/api/live-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body, ...(exiting && size < 64000 ? { keepalive: true } : {}) });
    if (response.status === 409) {
      draftState.blocked = true;
      showNotice('另一页面已更新字幕草稿，本页没有覆盖它。请先导出本页 TXT，再刷新读取草稿。', true);
      return;
    }
    const result = await response.json();
    if (!response.ok || result.saved !== true || !Number.isSafeInteger(result.revision)) throw new Error();
    draftState.revision = result.revision;
    if (change === draftState.change) draftState.dirty = false;
  } catch { if (!exiting) showNotice('本机字幕草稿暂未保存，已有字幕仍在本页。请保留页面或导出 TXT。', true); }
  finally {
    draftState.saving = false; refreshControls();
    if (draftState.dirty && !draftState.blocked && !exiting && !draftState.timer) {
      draftState.timer = setTimeout(() => { draftState.timer = null; void saveDraft(); }, 5000);
    }
  }
}
function restoreSettings(settings = {}) {
  const select = (name, value) => { if ([...ui[name].options].some(item => item.value === String(value))) ui[name].value = String(value); };
  select('asr-select', settings.asrId); renderTranslations(settings.translationId);
  select('finance-course', settings.financeCourse); select('max-minutes', settings.maxMinutes);
  select('display-language', settings.displayLanguage);
  if (typeof settings.autoscroll === 'boolean') ui.autoscroll.checked = settings.autoscroll;
  if (Number.isInteger(settings.fontSize) && settings.fontSize >= 20 && settings.fontSize <= 46) state.fontSize = settings.fontSize;
  for (const key of ['glossary', 'context']) if (typeof settings[key] === 'string') ui[key].value = settings[key];
  if (['mic', 'system'].includes(settings.source)) document.querySelectorAll('input[name="source"]').forEach(item => { item.checked = item.value === settings.source; });
  ui['source-help'].textContent = settings.source === 'system' ? '选择课程标签页或整个屏幕，并勾选共享音频。画面保留在本机。' : '开始后才会请求麦克风权限。暂停后可切换模型，已有字幕保留。';
  ui['caption-panel'].classList.toggle('chinese-only', ui['display-language'].value === 'chinese');
  ui['caption-panel'].style.setProperty('--caption-size', `${state.fontSize}px`); updateSettings();
}
async function restoreDraft() {
  draftState.restoring = true;
  try {
    const saved = await request('/api/live-draft');
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 0 || (saved.draft && saved.draft.version !== 1)) throw new Error();
    draftState.revision = saved.revision;
    if (saved.draft) {
      restoreSettings(saved.draft.settings);
      for (const session of saved.draft.sessions) {
        const run = { id: session.id, session: null, startedAt: null };
        createSession(run, session, session.historical);
        for (const entry of session.rows) {
          const row = getCaption(run, entry.id);
          row.seconds = entry.seconds; row.meta.firstChild.nodeValue = formatTime(row.seconds);
          row.target = entry.target; row.translationStatus = entry.translationStatus;
          renderCaption(run, { type: entry.final ? 'final' : 'partial', id: entry.id,
            source: entry.source, target: entry.target, translationStatus: entry.translationStatus });
        }
        markSessionPaused(run.session);
        if (!session.historical && run.session.rows.some(row => row.source?.trim() || row.target?.trim())) {
          run.finished = true; run.stopping = true; run.stopMode = 'pause'; state.pausedRun = run;
        }
      }
      if (state.rows.size) status(`已恢复 ${state.rows.size} 句字幕`, '已暂停。恢复草稿不会采集声音；点击开始后才连接 API。');
    }
    draftState.loaded = true; draftState.settingsSignature = JSON.stringify(draftSettings());
    scrollToLatest();
  } catch { showNotice('未能读取本机字幕草稿。为保护原草稿，本页暂不自动覆盖；请保留旧页面或导出 TXT。', true); }
  finally { draftState.restoring = false; draftState.initializing = false; refreshControls(); }
}
function createSession(run, labels, historical = false) {
  if (run.session) return run.session;
  const session = { id: run.id, createdAt: new Date(labels.createdAt || Date.now()), asrLabel: labels.asrLabel || '', translationLabel: labels.translationLabel || '', historical, rows: [] };
  state.sessions.push(session); run.session = session;
  const divider = el('div', 'session-divider');
  divider.append(el('span', '', session.createdAt.toLocaleTimeString('zh-CN', { hour12: false })), el('strong', '', `${session.asrLabel}${session.translationLabel ? ` → ${session.translationLabel}` : ''}`));
  if (historical) divider.append(el('span', 'history-badge', '历史真实记录 · 非实时'));
  ui['caption-list'].append(divider); ui['empty-state'].hidden = true;
  scrollToLatest(); draftChanged(); return session;
}
function getCaption(run, id) {
  const key = `${run.id}:${String(id)}`;
  if (state.rows.has(key)) return state.rows.get(key);
  if (!run.session) createSession(run, { asrLabel: profile(run.config?.asrId)?.label || '语音识别', translationLabel: profile(run.config?.translationId)?.label || '中文翻译' });
  const row = { key, id, source: '', target: '', final: false, translationStatus: 'pending', seconds: run.startedAt ? (performance.now() - run.startedAt) / 1000 : 0 };
  const card = el('article', 'caption-row partial'); const meta = el('div', 'caption-meta', formatTime(row.seconds));
  const stateText = el('span', 'caption-state', '识别中'); meta.append(stateText);
  const copy = el('div', 'caption-copy'); const english = el('p', 'english-text'); english.lang = 'en';
  const chinese = el('p', 'chinese-text placeholder', '正在听…'); chinese.lang = 'zh-CN'; copy.append(english, chinese); card.append(meta, copy);
  Object.assign(row, { card, meta, english, chinese, stateText }); run.session.rows.push(row); state.rows.set(key, row); ui['caption-list'].append(card);
  ui['sentence-count'].textContent = `${state.rows.size} 句字幕`; refreshControls(); draftChanged(); return row;
}
function renderCaption(run, message) {
  if (message.id == null) return;
  const row = getCaption(run, message.id);
  const before = [row.source, row.target, row.final, row.translationStatus];
  if (message.type === 'partial') {
    if (row.final) return;
    if (typeof message.source === 'string') row.source = message.source;
  } else if (message.type === 'final') {
    row.final = true;
    if (typeof message.source === 'string') row.source = message.source;
    if (typeof message.target === 'string' && message.target) row.target = message.target;
    row.translationStatus = message.translationStatus || (row.target ? 'done' : 'pending');
  } else if (message.type === 'translation') {
    if (typeof message.target === 'string') row.target = message.target;
    row.final = true; row.translationStatus = message.done === false ? 'pending' : 'done';
  }
  row.english.textContent = row.source;
  row.card.classList.toggle('partial', !row.final);
  row.stateText.textContent = !row.final ? '识别中' : row.translationStatus === 'error' ? '翻译失败' : row.translationStatus === 'pending' ? '翻译中…' : row.target ? '已完成' : '未返回译文';
  row.chinese.textContent = row.target || (!row.final ? '正在听…' : row.translationStatus === 'error' ? '本句翻译失败，可参考英文原文。' : row.translationStatus === 'done' ? '本句未返回中文译文。' : '正在翻译…');
  row.chinese.classList.toggle('placeholder', !row.target); row.chinese.classList.toggle('translation-error', row.translationStatus === 'error'); scrollToLatest();
  if ([row.source, row.target, row.final, row.translationStatus].some((value, index) => value !== before[index])) draftChanged();
}
function markSessionPaused(session) {
  for (const row of session?.rows || []) {
    if (!row.final) { row.stateText.textContent = '未定稿'; row.card.classList.remove('partial'); }
    else if (row.translationStatus === 'pending') row.stateText.textContent = '未完成';
    if (!row.target && row.translationStatus !== 'error') { row.chinese.textContent = '本句尚未收到中文译文。'; row.chinese.classList.add('placeholder'); }
  }
}
function releaseCapture(run) {
  clearInterval(run.timer); clearTimeout(run.readyTimer);
  if (run.worklet) run.worklet.port.onmessage = null;
  for (const item of [run.sourceNode, run.worklet, run.sink]) { try { item?.disconnect(); } catch { /* Already disconnected. */ } }
  for (const track of run.stream?.getTracks() || []) track.stop();
  if (run.context && run.context.state !== 'closed') void run.context.close().catch(() => {});
}
function finishRun(run, message) {
  if (run.finished) return;
  run.finished = true; run.stopping = true; run.queue.length = 0;
  clearTimeout(run.finishTimer); releaseCapture(run);
  if (run.socket && run.socket.readyState < WebSocket.CLOSING) run.socket.close();
  markSessionPaused(run.session); void saveDraft();
  if (state.run !== run) return;
  const paused = run.stopMode === 'pause';
  state.run = null; state.pausedRun = paused ? run : null; refreshControls();
  status(paused ? '已暂停，可以继续' : run.error ? '字幕已停止' : '本次翻译已结束', run.error || (paused ? '采集已暂停，字幕保留；可以继续翻译，或点击结束并导出。' : '采集与连接已结束，字幕保留在本页。'), run.error ? 'error' : '');
  if (run.error) showNotice(run.error, true);
  else showNotice(paused ? '已暂停采集，没有导出。点击“继续翻译”接着上课，或点击“结束并导出”保存全文。' : message || run.stopMessage || '本次翻译已结束，正在自动保存字幕。');
  if (paused) exportFeedback(++exportSequence, '已暂停，点击“结束并导出”保存 TXT');
  else void autoExportCaptions(run);
}
async function endSession() {
  if (state.clearing) return;
  const run = state.run || state.pausedRun;
  if (!run) return;
  run.explicitEnd = true;
  if (state.run === run) {
    if (run.stopping) {
      // A user can end while the pause is still draining its final translation.
      run.stopMode = 'end'; refreshControls();
      status('正在结束本次翻译', '采集已停止，最后一句收尾后自动导出 TXT。', 'loading');
      return;
    }
    return stopRun(run, { mode: 'end' });
  }
  run.stopMode = 'end'; state.pausedRun = null; refreshControls();
  status('本次翻译已结束', '字幕保留在本页，正在自动保存 TXT。');
  showNotice('本次翻译已结束，字幕保留在本页。');
  void autoExportCaptions(run);
}
function flushCapture(run) {
  if (!run.worklet || !run.startedAt || run.context?.state !== 'running') return Promise.resolve(null);
  clearInterval(run.timer);
  try { run.sourceNode.disconnect(); } catch { /* Already disconnected. */ }
  for (const track of run.stream?.getTracks() || []) track.stop();
  return new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 300);
    run.worklet.port.onmessage = event => {
      if (event.data?.type !== 'flushed') return;
      clearTimeout(timeout); const buffer = event.data.buffer;
      resolve(buffer instanceof ArrayBuffer && buffer.byteLength > 0 && buffer.byteLength <= 6400 && buffer.byteLength % 2 === 0 ? buffer : null);
    };
    run.worklet.port.postMessage({ type: 'flush' });
  });
}
function pumpAudio(run) {
  if (run.draining) return run.sendTask;
  run.draining = true;
  run.sendTask = (async () => {
    while (run.queue.length && !run.finished && (!run.stopping || run.allowTail)) {
      if (run.socket?.readyState !== WebSocket.OPEN) return;
      if (run.socket.bufferedAmount > 160000) {
        run.queue.length = 0;
        if (run.stopping) run.error = '网络积压超过 5 秒，已停止后续音频发送。';
        else void stopRun(run, { error: '网络积压超过 5 秒，已自动停止。请检查网络后继续。' });
        return;
      }
      const chunk = run.queue[0];
      const now = performance.now();
      run.tokens = Math.min(9600, run.tokens + Math.max(0, now - run.tokenTime) * 32); run.tokenTime = now;
      const missing = chunk.buffer.byteLength - run.tokens;
      if (missing > 0) { await new Promise(resolve => setTimeout(resolve, Math.min(200, Math.max(1, Math.ceil(missing / 32))))); continue; }
      if (run.finished || (!run.allowTail && run.stopping)) return;
      run.tokens -= chunk.buffer.byteLength; run.queue.shift();
      try { run.socket.send(chunk.buffer); } catch (error) { run.queue.length = 0; if (!run.stopping) void stopRun(run, { error: explain(error) }); else run.error = explain(error); return; }
    }
  })().finally(() => { run.draining = false; });
  return run.sendTask;
}
async function stopRun(run, { error = '', message = '', flush = true, mode = 'end' } = {}) {
  if (!run || run.stopping || run.finished) return;
  run.stopping = true; run.stopMode = mode; run.error = error; run.stopMessage = message; run.allowTail = !error && flush && Boolean(run.startedAt);
  void saveDraft();
  clearInterval(run.timer); clearTimeout(run.readyTimer); refreshControls();
  if (state.run === run) status(mode === 'pause' ? '正在暂停' : '正在结束本次翻译', mode === 'pause' ? '采集已停止，最后一句收尾后可继续；暂停不会导出。' : '采集已停止，最后一句收尾后自动导出 TXT。', 'loading');
  if (run.allowTail) {
    try { const tail = await flushCapture(run); if (tail && !run.finished) run.queue.push({ buffer: tail, queuedAt: performance.now() }); }
    catch { /* Release and stop even if a worklet tail cannot be recovered. */ }
  } else run.queue.length = 0;
  releaseCapture(run);
  if (run.finished) return;
  if (run.socket?.readyState !== WebSocket.OPEN) { finishRun(run); return; }
  run.finishTimer = setTimeout(() => finishRun(run, '本次连接已关闭，已显示的字幕保留在本页。'), 12000);
  if (run.allowTail) await pumpAudio(run);
  if (run.finished) return;
  try { if (run.socket.readyState === WebSocket.OPEN) run.socket.send(JSON.stringify({ type: 'stop' })); else finishRun(run); }
  catch { finishRun(run); }
}
function receiveAudio(run, buffer) {
  if (run.finished || run.stopping || state.run !== run) return;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 6400) { void stopRun(run, { error: '音频格式异常，已停止采集。请刷新后重试。', flush: false }); return; }
  const now = performance.now();
  if ((now - run.startedAt) / 1000 >= run.maxSeconds) { void stopRun(run, { message: '已达到本次时长上限，采集与连接已自动停止。', flush: false }); return; }
  if (run.queue.length >= 25 || (run.queue[0] && now - run.queue[0].queuedAt > 5000)) { void stopRun(run, { error: '音频等待超过 5 秒，已自动停止。请检查网络后继续。', flush: false }); return; }
  run.queue.push({ buffer, queuedAt: now }); void pumpAudio(run);
}
async function beginCapture(run, message) {
  if (run.startedAt || run.startingAudio || run.stopping || run.finished || state.run !== run) return;
  run.startingAudio = true; clearTimeout(run.readyTimer);
  try {
    await run.context.resume();
    if (run.stopping || run.finished) return;
    if (run.context.state !== 'running') throw new Error('浏览器暂停了音频处理，请重新点击开始，或使用 Chrome / Edge。');
    run.startedAt = performance.now(); run.tokenTime = run.startedAt;
    createSession(run, message);
    run.worklet.port.onmessage = event => receiveAudio(run, event.data);
    run.sourceNode.connect(run.worklet); run.worklet.connect(run.sink); run.sink.connect(run.context.destination);
    ui.timer.textContent = '00:00';
    status('正在实时翻译', `${message.asrLabel || '语音识别'} → ${message.translationLabel || '中文翻译'}`, 'active');
    ui['mode-note'].textContent = modeDescription(profile(run.config.asrId), message.mode);
    run.timer = setInterval(() => {
      if (run.finished || run.stopping) return;
      const seconds = (performance.now() - run.startedAt) / 1000; ui.timer.textContent = formatTime(Math.min(seconds, run.maxSeconds));
      if (seconds >= run.maxSeconds) void stopRun(run, { message: '已达到本次时长上限，采集与连接已自动停止。', flush: false });
      else if (run.context.state !== 'running') void stopRun(run, { error: '浏览器暂停了音频处理，已停止本次连接。请保持电脑唤醒后继续。' });
    }, 250);
  } catch (error) { void stopRun(run, { error: explain(error) }); }
}
async function startRun() {
  if (state.run || state.loading || state.previewing || state.clearing) return;
  const issue = configurationIssue(); if (issue) { showNotice(issue, true); return; }
  const source = document.querySelector('input[name="source"]:checked').value;
  const config = { type: 'start', asrId: ui['asr-select'].value, translationId: ui['translation-select'].value, financeCourse: ui['finance-course'].value, glossary: ui.glossary.value, context: ui.context.value, maxMinutes: Number(ui['max-minutes'].value) };
  const run = { id: `live-${Date.now()}-${++state.sequence}`, config, queue: [], tokens: 9600, tokenTime: performance.now(), maxSeconds: config.maxMinutes * 60, stopping: false, finished: false, draining: false, allowTail: false, session: null };
  state.run = run; refreshControls(); showNotice(''); status('等待声音授权', source === 'system' ? '选择课程所在标签页或整个屏幕，并勾选共享音频。' : '请允许浏览器使用麦克风。', 'loading');
  try {
    if (!window.isSecureContext || !navigator.mediaDevices || !window.AudioWorkletNode) throw new Error('浏览器不支持音频采集。请使用新版 Chrome / Edge，通过本机地址打开平台。');
    run.stream = source === 'system' ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' }) : await navigator.mediaDevices.getUserMedia({ video: false, audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (run.stopping || run.finished) { releaseCapture(run); return; }
    if (!run.stream.getAudioTracks().length) throw new Error('此次共享没有声音。请重新开始，选择标签页或整个屏幕，并勾选“共享音频 / 系统音频”。');
    for (const track of run.stream.getTracks()) track.addEventListener('ended', () => { if (state.run === run) void stopRun(run, { message: '声音来源已关闭，本次采集与连接已结束。' }); }, { once: true });
    run.context = new AudioContext({ latencyHint: 'interactive' }); await run.context.audioWorklet.addModule('/pcm-worklet.js');
    if (run.stopping || run.finished) { releaseCapture(run); return; }
    // Only audio tracks enter this graph. A display-sharing video track stays local.
    run.sourceNode = run.context.createMediaStreamSource(new MediaStream(run.stream.getAudioTracks()));
    run.worklet = new AudioWorkletNode(run.context, 'classroom-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    run.sink = run.context.createGain(); run.sink.gain.value = 0;
    await run.context.resume();
    if (run.stopping || run.finished) { releaseCapture(run); return; }
    if (run.context.state !== 'running') throw new Error('浏览器未开启音频处理，请重新点击开始。');
    status('正在连接所选 API', '连接就绪后开始发送声音。', 'loading');
    const socketUrl = new URL('/api/live', window.location.href); socketUrl.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    run.socket = new WebSocket(socketUrl.href); run.socket.binaryType = 'arraybuffer';
    run.readyTimer = setTimeout(() => { void stopRun(run, { error: 'API 连接未及时就绪，采集已停止。请检查配置、网络或余额。' }); }, 15000);
    run.socket.onopen = () => {
      if (run.stopping || run.finished) { run.socket.close(); return; }
      run.socket.send(JSON.stringify(config));
    };
    run.socket.onmessage = event => {
      if (run.finished || typeof event.data !== 'string') return;
      let message; try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === 'ready') { void beginCapture(run, message); return; }
      if (['partial','final','translation'].includes(message.type)) { renderCaption(run, message); return; }
      if (message.type === 'status') { if (message.message && !run.stopping && state.run === run) ui['status-detail'].textContent = message.message; return; }
      if (message.type === 'error') { const text = message.message || '接口返回错误，已停止本次连接。'; if (run.stopping) { run.error = text; } else void stopRun(run, { error: text }); return; }
      if (message.type === 'stopped') finishRun(run);
    };
    run.socket.onerror = () => { if (!run.finished) { run.error ||= '实时连接发生错误，采集已停止。请检查网络和本机服务。'; void stopRun(run, { error: run.error, flush: false }); } };
    run.socket.onclose = () => {
      if (run.finished) return;
      if (!run.stopping) run.error ||= '实时连接已断开，声音采集已自动停止。已有字幕保留，可重新开始。';
      finishRun(run);
    };
  } catch (error) { if (!run.finished) await stopRun(run, { error: explain(error), flush: false }); else releaseCapture(run); }
}
async function previewHistory() {
  if (state.run || state.previewing || state.clearing) return;
  state.previewing = true; refreshControls();
  try {
    let report;
    try {
      const history = await request('/api/history');
      const chosen = history.items?.find(item => item.id === '5fa872fa-7843-4513-9f28-1a91d6762040') || history.items?.[0];
      if (chosen) report = await request(`/api/history/${encodeURIComponent(chosen.id)}`);
    } catch { /* The already-saved demo remains a free fallback. */ }
    if (!report) report = await request('/api/demo');
    const result = report.results?.find(item => item.status === 'ok' && item.translationId === 'deepseek-translate') || report.results?.find(item => item.status === 'ok');
    if (!result || (!result.source && !result.target)) throw new Error('这条历史记录没有成功的字幕结果，可前往对比实验室查看其他记录。');
    const run = { id: `history-${Date.now()}-${++state.sequence}`, session: null, startedAt: null };
    createSession(run, { asrLabel: profile(result.asrId)?.label || result.label || '历史录音测试', translationLabel: profile(result.translationId)?.label || '已有译文', createdAt: report.createdAt }, true);
    renderCaption(run, { type: 'final', id: result.id || 'history-preview', source: result.source || '', target: result.target || '', translationStatus: 'done' });
    status('正在查看历史字幕', '这是真实测试的已存记录，不是实时采集。'); showNotice('历史预览没有采集声音，也没有新的 API 调用。点击开始后，会在下面继续添加实时课堂字幕。');
  } catch (error) { showNotice(explain(error), true); }
  finally { state.previewing = false; refreshControls(); }
}
function captionText({ endedAt = new Date(), includeContext = false } = {}) {
  const lines = ['课堂实时字幕 · 英语 → 中文', `导出时间：${endedAt.toLocaleString('zh-CN')}`, ''];
  for (const session of state.sessions) {
    lines.push(`=== ${session.createdAt.toLocaleString('zh-CN')} · ${session.asrLabel} → ${session.translationLabel}${session.historical ? ' · 历史预览（非实时）' : ''} ===`, '');
    for (const row of session.rows) lines.push(`[${formatTime(row.seconds)}]${row.final ? '' : '（英文未定稿）'}`, row.source, row.target || '（未收到中文译文）', '');
  }
  if (includeContext) {
    try {
      const snapshot = window.ClassroomContextExport?.snapshot();
      if (snapshot?.hasCorrections && snapshot.text) lines.push('=== 上下文（含已完成 AI 校正） ===', '以下保留上下文整合版本；逐句原文与原译文见上方。', '', snapshot.text, '');
    } catch { /* A sidebar failure must not prevent the original captions from being saved. */ }
  }
  return lines.join('\r\n');
}
function downloadCaptionText(text, endedAt = new Date()) {
  const url = URL.createObjectURL(new Blob(['\uFEFF', text], { type: 'text/plain;charset=utf-8' }));
  const link = el('a'); link.href = url; link.download = `课堂字幕-${endedAt.toLocaleDateString('sv-SE')}-${endedAt.getTime()}.txt`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function exportFeedback(sequence, text, detail = '', error = false) {
  if (sequence !== exportSequence) return;
  ui['export-status'].textContent = text; ui['export-status'].title = detail;
  ui['export-status'].classList.toggle('export-error', error);
}
function exportCaptions() {
  if (state.clearing || !state.rows.size) return;
  const sequence = ++exportSequence;
  downloadCaptionText(captionText());
  exportFeedback(sequence, '已发起 TXT 下载，请查看下载列表');
}
async function autoExportCaptions(run) {
  if (run.stopMode === 'pause' || run.exportStarted) return;
  const rows = run.explicitEnd ? [...state.rows.values()] : run.session?.rows || [];
  if (!rows.some(row => row.source?.trim() || row.target?.trim())) return;
  run.exportStarted = true;
  const sequence = ++exportSequence, endedAt = new Date();
  const text = captionText({ endedAt, includeContext: true });
  exportFeedback(sequence, '正在自动保存 TXT…');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch('/api/live-export', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ runId: run.id, text, endedAt: endedAt.toISOString() })
    });
    const data = await response.json();
    if (!response.ok || data.saved !== true) throw new Error('Export failed');
    exportFeedback(sequence, 'TXT 已保存到 下载/课堂字幕', typeof data.path === 'string' ? data.path : '');
  } catch {
    try {
      downloadCaptionText(text, endedAt);
      exportFeedback(sequence, '自动保存未确认，已发起 TXT 下载，请查看下载列表', '若浏览器阻止下载，请点击“导出 TXT”。', true);
    } catch {
      exportFeedback(sequence, '自动导出失败，请点击“导出 TXT”备份', '', true);
    }
  } finally { clearTimeout(timeout); }
}

async function clearCaptions() {
  if (state.run || state.loading || state.previewing || state.clearing || draftState.initializing || !draftState.loaded || draftState.saving || !(state.sessions.length || state.rows.size)) return;
  state.clearing = true;
  clearTimeout(draftState.timer); draftState.timer = null;
  refreshControls();
  const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const draft = { version: 1, settings: draftSettings(), sessions: [] };
    const response = await fetch('/api/live-draft', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ expectedRevision: draftState.revision, draft })
    });
    if (response.status === 409) {
      draftState.blocked = true;
      showNotice('另一页面已更新字幕草稿，本页尚未清除。请先导出本页文本，再刷新查看最新草稿。', true);
      return;
    }
    const result = await response.json();
    if (!response.ok || result.saved !== true || !Number.isSafeInteger(result.revision) || result.revision <= draftState.revision) throw new Error('Clear failed');
    // Commit the empty draft before removing the visible text, so reload stays empty.
    draftState.revision = result.revision; draftState.dirty = false; draftState.blocked = false;
    draftState.change++; draftState.settingsSignature = JSON.stringify(draft.settings);
    state.sessions = []; state.rows.clear(); state.pausedRun = null;
    ui['caption-list'].replaceChildren(); ui['empty-state'].hidden = false;
    ui['sentence-count'].textContent = '0 句字幕'; ui.timer.textContent = '00:00';
    ui.transcript.scrollTop = 0; ui['scroll-bottom'].hidden = true;
    exportFeedback(++exportSequence, '点击结束后自动导出 TXT');
    window.dispatchEvent(new Event('classroom-captions-cleared'));
    status('准备开始下一节课', '本页字幕与上下文已清空，点击开始即可重新上课。');
    showNotice('本页字幕与上下文已清除，API 和课程设置已保留。');
  } catch {
    showNotice('清除尚未完成，本页文本仍然保留。请确认本机服务正常后重试。', true);
  } finally {
    clearTimeout(timeout); state.clearing = false; refreshControls();
    if (draftState.dirty && !draftState.blocked && !draftState.timer) {
      draftState.timer = setTimeout(() => { draftState.timer = null; void saveDraft(); }, 5000);
    }
  }
}

ui['start-button'].addEventListener('click', () => { void startRun(); });
ui['stop-button'].addEventListener('click', () => { void stopRun(state.run, { mode: 'pause' }); });
ui['end-button'].addEventListener('click', () => { void endSession(); });
ui['clear-button'].addEventListener('click', () => { void clearCaptions(); });
ui['refresh-profiles'].addEventListener('click', () => { void loadProfiles(); });
ui['asr-select'].addEventListener('change', () => { renderTranslations(); updateSettings(); refreshControls(); const issue = configurationIssue(); status(issue ? '需要配置 API' : '可以开始', issue || '已选择新的语音 API，点击开始后使用。'); });
ui['translation-select'].addEventListener('change', () => { updateSettings(); refreshControls(); const issue = configurationIssue(); status(issue ? '需要配置 API' : '可以开始', issue || '已选择新的翻译 API，点击开始后使用。'); });
ui['finance-course'].addEventListener('change', updateSettings); ui['max-minutes'].addEventListener('change', updateSettings);
ui['preview-button'].addEventListener('click', () => { void previewHistory(); }); ui['export-button'].addEventListener('click', exportCaptions);
ui['display-language'].addEventListener('change', () => { ui['caption-panel'].classList.toggle('chinese-only', ui['display-language'].value === 'chinese'); scrollToLatest(); });
ui.autoscroll.addEventListener('change', () => scrollToLatest());
ui.transcript.addEventListener('scroll', updateScrollButton, { passive: true });
ui.transcript.addEventListener('wheel', event => { if (event.deltaY < 0) ui.autoscroll.checked = false; }, { passive: true });
ui['scroll-bottom'].addEventListener('click', () => { ui.autoscroll.checked = true; scrollToLatest(true); });
ui['font-down'].addEventListener('click', () => { state.fontSize = Math.max(20, state.fontSize - 2); ui['caption-panel'].style.setProperty('--caption-size', `${state.fontSize}px`); });
ui['font-up'].addEventListener('click', () => { state.fontSize = Math.min(46, state.fontSize + 2); ui['caption-panel'].style.setProperty('--caption-size', `${state.fontSize}px`); });
document.querySelectorAll('input[name="source"]').forEach(item => item.addEventListener('change', () => { ui['source-help'].textContent = item.value === 'system' ? '选择课程标签页或整个屏幕，并勾选共享音频。画面保留在本机。' : '开始后才会请求麦克风权限。暂停后可切换模型，已有字幕保留。'; }));
window.addEventListener('offline', () => { if (state.run) void stopRun(state.run, { error: '网络已断开，声音采集与本次连接已停止。', flush: false }); });
window.addEventListener('pagehide', () => {
  void saveDraft(true);
  const run = state.run; if (!run) return; run.stopping = true; run.finished = true; run.queue.length = 0; releaseCapture(run); clearTimeout(run.finishTimer);
  if (run.socket?.readyState === WebSocket.OPEN) { try { run.socket.send(JSON.stringify({ type: 'stop' })); } catch { /* Closing the socket also cancels the server session. */ } }
  if (run.socket?.readyState < WebSocket.CLOSING) run.socket.close();
});
for (const id of ['asr-select','translation-select','finance-course','max-minutes','glossary','context','display-language','autoscroll']) {
  ui[id].addEventListener(id === 'glossary' || id === 'context' ? 'input' : 'change', draftSettingsChanged);
}
for (const id of ['font-down','font-up','scroll-bottom']) ui[id].addEventListener('click', draftSettingsChanged);
ui.transcript.addEventListener('wheel', draftSettingsChanged, { passive: true });
document.querySelectorAll('input[name="source"]').forEach(item => item.addEventListener('change', draftSettingsChanged));
updateSettings(); refreshControls();
void Promise.allSettled([loadProfiles(), loadFinance()]).then(restoreDraft);
