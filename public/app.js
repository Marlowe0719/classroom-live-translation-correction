'use strict';

const $ = (id) => document.getElementById(id);
const state = { profiles: [], protocols: [], pipelines: [], financePack: null, mode: 'clip', capture: null, analysis: null, audio: null, reports: [], importing: false, savingProfile: false, historyLoading: false };
const ui = Object.fromEntries(['notice','pipeline-list','add-pipeline','glossary','context','reference','status-text','status-detail','status-dot','capture-timer','demo-button','record-button','record-stop','audio-file','audio-preview','audio-name','audio-duration','preview-player','clear-audio','analyze-button','cancel-analysis','live-button','live-stop','mode-clip','mode-live','clip-controls','live-controls','reference-panel','live-explanation','segment-seconds','live-minutes','results-list','results-empty','result-summary','export-txt','export-json','profiles-list','profile-count','profile-form','profile-id','profile-label','profile-protocol','profile-url','profile-model','profile-key','thinking-off','editor-title','save-profile','history-list'].map(id => [id, $(id)]));

function node(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function option(value, text, selected = false) { const el = node('option', '', text); el.value = value; el.selected = selected; return el; }
function formatTime(seconds) { const n = Math.max(0, Math.floor(seconds || 0)); return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`; }
function durationText(seconds) { return `${Number(seconds || 0).toFixed(1)} 秒`; }
function timestamp(value) { const date = new Date(value); return Number.isNaN(date.valueOf()) ? '时间未知' : date.toLocaleString('zh-CN', { hour12: false }); }
function profile(id) { return state.profiles.find(item => item.id === id); }
function busy() { return Boolean(state.capture || state.analysis || state.importing); }
function readyProfile(item) { return Boolean(item && item.configured); }
function status(title, detail, type = '') { ui['status-text'].textContent = title; ui['status-detail'].textContent = detail; ui['status-dot'].className = type; }
function notice(text, error = false) { ui.notice.textContent = text || ''; ui.notice.className = `notice${error ? ' error' : ''}`; ui.notice.hidden = !text; }
function errorMessage(error) {
  if (error?.name === 'NotAllowedError') return '未获得声音权限或共享已取消。请重新开始，并允许麦克风或共享音频。';
  if (error?.name === 'NotFoundError') return '没有找到音频设备，请检查麦克风或选择电脑声音。';
  if (error?.name === 'NotReadableError') return '无法读取音频设备，请检查设备连接与占用情况。';
  if (error?.name === 'AbortError') return '本次请求已取消。';
  if (error instanceof TypeError && /fetch|network/i.test(error.message)) return '无法连接本机服务，请检查启动窗口和网络。';
  return error?.message || '操作失败，请稍后重试。';
}
async function request(url, options = {}) {
  const response = await fetch(url, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || data.message || `请求失败（${response.status}）`);
  return data;
}
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(el => { el.classList.toggle('active', el.dataset.tab === name); el.setAttribute('aria-selected', String(el.dataset.tab === name)); });
  document.querySelectorAll('.tab-panel').forEach(el => { el.hidden = el.id !== `tab-${name}`; });
  if (name === 'history') void loadHistory();
  history.replaceState(null, '', `#${name}`);
}
function pipelineErrors(item) {
  const asr = profile(item.asrId);
  const issues = [];
  if (!asr || !asr.capabilities?.includes('asr')) issues.push('请选择英语转录 API');
  else if (!readyProfile(asr)) issues.push(`${asr.label} 尚未配置，请填写密钥与接口信息`);
  if (item.translationId === 'builtin') {
    if (asr?.protocol !== 'tencent-translation') issues.push('该转录接口没有腾讯内置译文，请选择翻译 API 或仅英文');
  } else if (item.translationId !== 'none') {
    const translation = profile(item.translationId);
    if (!translation?.capabilities?.includes('translation')) issues.push('请选择中文翻译 API');
    else if (!readyProfile(translation)) issues.push(`${translation.label} 尚未配置，请到 API 配置填写密钥`);
  }
  return issues;
}
function allValid() { return state.pipelines.length > 0 && state.pipelines.length <= 3 && state.pipelines.every(item => pipelineErrors(item).length === 0); }
function selectedPipelines() {
  if (!allValid()) throw new Error('选中方案有尚未配置的 API。请先到“API 配置”填写密钥，或移除该方案后运行。');
  return state.pipelines.map(item => ({ id: item.id, label: item.label.trim() || '未命名方案', asrId: item.asrId, translationId: item.translationId }));
}
function updateControls() {
  const locked = busy();
  const capture = state.capture;
  ui['record-button'].hidden = capture?.mode === 'clip';
  ui['record-stop'].hidden = capture?.mode !== 'clip';
  ui['record-stop'].disabled = Boolean(capture?.stopping);
  ui['record-button'].disabled = locked;
  ui['audio-file'].disabled = locked;
  ui['clear-audio'].disabled = locked;
  ui['demo-button'].disabled = locked;
  ui['analyze-button'].hidden = state.mode !== 'clip' || Boolean(state.analysis);
  ui['analyze-button'].disabled = locked || !state.audio || !allValid();
  ui['cancel-analysis'].hidden = !state.analysis;
  ui['live-button'].hidden = state.mode !== 'live' || capture?.mode === 'live';
  ui['live-button'].disabled = locked || !allValid();
  ui['live-stop'].hidden = capture?.mode !== 'live';
  ui['live-stop'].disabled = Boolean(capture?.stopping);
  ui['add-pipeline'].disabled = locked || state.pipelines.length >= 3;
  ui['mode-clip'].disabled = locked;
  ui['mode-live'].disabled = locked;
  document.querySelectorAll('#pipeline-list input, #pipeline-list select, #pipeline-list button, input[name="source"], #glossary, #context, #reference, #finance-course, #segment-seconds, #live-minutes').forEach(el => { el.disabled = locked; });
  document.querySelectorAll('#profile-form input, #profile-form select, #profile-form button, #new-profile, #reset-profile, .profile-mutation').forEach(el => { el.disabled = locked || state.savingProfile; });
  ui['export-txt'].disabled = !state.reports.length;
  ui['export-json'].disabled = !state.reports.length;
  ui['preview-player'].controls = !capture;
  if (capture) ui['preview-player'].pause();
}
function defaultPipelines() {
  const qwenAsr = profile('qwen-asr3') ? 'qwen-asr3' : profile('qwen-realtime') ? 'qwen-realtime' : 'qwen-asr';
  const preferred = [
    { id: 'plan-tencent', label: '腾讯 Lite · 内置翻译', asrId: 'tencent-lite', translationId: 'builtin' },
    { id: 'plan-qwen', label: 'Qwen 热词识别 + Qwen 翻译', asrId: qwenAsr, translationId: 'qwen-translate' },
    { id: 'plan-deepseek', label: 'Qwen 热词识别 + DeepSeek 翻译', asrId: qwenAsr, translationId: 'deepseek-translate' }
  ];
  return preferred.filter(item => profile(item.asrId) && (item.translationId === 'builtin' || profile(item.translationId)));
}
function renderPipelines() {
  ui['pipeline-list'].replaceChildren();
  const asrs = state.profiles.filter(item => item.capabilities?.includes('asr'));
  const translators = state.profiles.filter(item => item.capabilities?.includes('translation'));
  state.pipelines.forEach((item, index) => {
    const row = node('div', 'pipeline-row');
    const title = node('div', 'pipeline-title');
    title.append(node('span', 'pipeline-index', String(index + 1).padStart(2, '0')));
    const label = node('input', 'pipeline-label'); label.value = item.label; label.maxLength = 80; label.setAttribute('aria-label', `方案 ${index + 1} 名称`);
    label.addEventListener('input', () => { item.label = label.value; });
    const remove = node('button', 'pipeline-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', `移除方案 ${index + 1}`);
    remove.addEventListener('click', () => { state.pipelines.splice(index, 1); renderPipelines(); });
    title.append(label, remove);
    const fields = node('div', 'pipeline-fields');
    const asrField = node('div'); const asrLabel = node('label', '', '英语转录'); const asrSelect = node('select'); asrLabel.htmlFor = `asr-${item.id}`; asrSelect.id = asrLabel.htmlFor;
    if (!profile(item.asrId)) asrSelect.append(option('', '请选择 API', true));
    for (const p of asrs) asrSelect.append(option(p.id, `${p.label}${p.configured ? '' : ' · 未配置'}`, p.id === item.asrId));
    const translationField = node('div'); const translationLabel = node('label', '', '中文翻译'); const translationSelect = node('select'); translationLabel.htmlFor = `translation-${item.id}`; translationSelect.id = translationLabel.htmlFor;
    if (profile(item.asrId)?.protocol === 'tencent-translation') translationSelect.append(option('builtin', '腾讯内置译文', item.translationId === 'builtin'));
    translationSelect.append(option('none', '仅英文，不翻译', item.translationId === 'none'));
    for (const p of translators) translationSelect.append(option(p.id, `${p.label}${p.configured ? '' : ' · 未配置'}`, p.id === item.translationId));
    if (item.translationId !== 'none' && item.translationId !== 'builtin' && !profile(item.translationId)) translationSelect.prepend(option('', '请选择翻译 API', true));
    asrSelect.addEventListener('change', () => { item.asrId = asrSelect.value; if (item.translationId === 'builtin' && profile(item.asrId)?.protocol !== 'tencent-translation') item.translationId = 'none'; renderPipelines(); });
    translationSelect.addEventListener('change', () => { item.translationId = translationSelect.value; renderPipelines(); });
    asrField.append(asrLabel, asrSelect); translationField.append(translationLabel, translationSelect);
    fields.append(asrField, node('span', 'pipeline-arrow', '→'), translationField);
    row.append(title, fields, node('p', 'pipeline-warning', pipelineErrors(item).join('；')));
    ui['pipeline-list'].append(row);
  });
  if (!state.pipelines.length) ui['pipeline-list'].append(node('p', 'help', '点击“添加方案”，先选择一条转录与翻译组合。'));
  updateControls();
  if (!busy()) status(allValid() ? '准备就绪' : '需要配置所选 API', allValid() ? '录制或上传同一段音频，即可比较。' : '填写 Qwen / DeepSeek 密钥，或移除未配置方案后运行。');
}
function renderProfiles() {
  ui['profile-count'].textContent = String(state.profiles.length);
  ui['profiles-list'].replaceChildren();
  for (const p of state.profiles) {
    const card = node('article', 'profile-card'); const top = node('div', 'profile-top');
    top.append(node('h2', '', p.label), node('span', `badge${p.configured ? '' : ' warning'}`, p.configured ? '已配置' : '待配置密钥 / 接口'));
    const description = node('p', 'profile-description');
    description.textContent = `${p.capabilities?.map(cap => cap === 'asr' ? '英语转录' : '中文翻译').join(' · ') || '自定义接口'}\n${p.model || '尚未填写模型'}\n${p.baseUrl || (p.builtin ? '内置腾讯云接入' : '尚未填写地址')}`;
    description.style.whiteSpace = 'pre-line';
    const actions = node('div', 'profile-actions');
    if (p.builtin) actions.append(node('span', 'badge', '内置配置'));
    else {
      const edit = node('button', 'text-button profile-mutation', '编辑配置'); edit.type = 'button'; edit.addEventListener('click', () => editProfile(p));
      const remove = node('button', 'text-button profile-mutation', '删除'); remove.type = 'button';
      remove.addEventListener('click', async () => {
        if (busy()) return;
        if (remove.dataset.confirm !== 'yes') { remove.dataset.confirm = 'yes'; remove.textContent = '确认删除'; return; }
        try { await request(`/api/profiles/${encodeURIComponent(p.id)}`, { method: 'DELETE' }); await loadProfiles(false); notice('已删除本机 API 配置。'); } catch (error) { notice(errorMessage(error), true); }
      });
      actions.append(edit, remove, node('span', 'optional', p.hasApiKey ? '密钥已保存' : '未保存密钥'));
    }
    if (p.docsUrl) { try { const url = new URL(p.docsUrl); if (['https:', 'http:'].includes(url.protocol)) { const link = node('a', '', '官方文档 ↗'); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; actions.append(link); } } catch { /* Ignore invalid documentation links. */ } }
    card.append(top, description, actions); ui['profiles-list'].append(card);
  }
  const currentProtocol = ui['profile-protocol'].value;
  ui['profile-protocol'].replaceChildren();
  for (const protocol of state.protocols.filter(item => item.id !== 'tencent-translation')) ui['profile-protocol'].append(option(protocol.id, protocol.label, protocol.id === currentProtocol));
  updateProtocolHelp(); updateControls();
}
async function loadProfiles(initialize = true) {
  const data = await request('/api/profiles');
  state.profiles = data.profiles || []; state.protocols = data.protocols || [];
  if (initialize) state.pipelines = defaultPipelines();
  renderProfiles(); renderPipelines();
}
function updateProtocolHelp() {
  const protocol = state.protocols.find(item => item.id === ui['profile-protocol'].value);
  $('protocol-help').textContent = protocol?.capabilities?.includes('asr') ? '用于英语语音转录；准确地址、模型名称以服务商文档为准。' : '用于英文文本 → 中文翻译。OpenAI 兼容协议可接入 Qwen、DeepSeek 等文本模型。';
}
function resetProfileForm() { ui['profile-form'].reset(); ui['profile-id'].value = ''; ui['profile-key'].value = ''; ui['editor-title'].textContent = '添加 API 配置'; ui['thinking-off'].checked = true; updateProtocolHelp(); }
function editProfile(p) {
  if (busy() || p.builtin) return;
  ui['profile-id'].value = p.id; ui['profile-label'].value = p.label || ''; ui['profile-protocol'].value = p.protocol; ui['profile-url'].value = p.baseUrl || ''; ui['profile-model'].value = p.model || ''; ui['profile-key'].value = ''; ui['thinking-off'].checked = p.thinkingOff !== false; ui['editor-title'].textContent = `编辑：${p.label}`; updateProtocolHelp();
  $('profile-editor').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); ui['profile-key'].focus();
}
async function saveProfile(event) {
  event.preventDefault(); if (busy() || state.savingProfile) return;
  const data = { label: ui['profile-label'].value.trim(), protocol: ui['profile-protocol'].value, baseUrl: ui['profile-url'].value.trim(), model: ui['profile-model'].value.trim(), thinkingOff: ui['thinking-off'].checked };
  if (ui['profile-id'].value) data.id = ui['profile-id'].value;
  if (ui['profile-key'].value.trim()) data.apiKey = ui['profile-key'].value.trim();
  state.savingProfile = true; updateControls();
  try {
    await request('/api/profiles', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    ui['profile-key'].value = ''; await loadProfiles(false); resetProfileForm(); notice('配置已保存到本机。可以返回“方案对比”选择使用；保存没有调用模型。');
  } catch (error) { notice(errorMessage(error), true); }
  finally { state.savingProfile = false; updateControls(); }
}

function resetResults() { state.reports = []; ui['results-list'].replaceChildren(); ui['results-empty'].hidden = false; ui['result-summary'].textContent = '等待同一段音频的结果'; updateControls(); }
function addReport(report, segmentNumber = null, replace = false) {
  if (replace) resetResults();
  state.reports.push({ report, segmentNumber });
  ui['results-empty'].hidden = true;
  const container = node('article', 'report'); const header = node('div', 'report-header'); const heading = node('strong', '', segmentNumber ? `片段 ${String(segmentNumber).padStart(2, '0')} · ${durationText(report.duration)}` : `同音频对比 · ${durationText(report.duration)}`);
  const badges = node('div', 'report-badges'); badges.append(node('span', '', timestamp(report.createdAt)));
  if (report.isHistorical) badges.append(node('span', 'badge', '历史真实测试 · 查看免费'));
  if (report.saved === false && !report.isHistorical) badges.append(node('span', 'badge warning', '本机保存失败，请导出'));
  else if (report.saved) badges.append(node('span', 'badge', '已保存本机'));
  header.append(heading, badges); container.append(header);
  const results = Array.isArray(report.results) ? report.results : [];
  const grid = node('div', 'result-grid'); grid.style.setProperty('--columns', String(Math.max(1, Math.min(3, results.length))));
  for (const result of results) {
    const card = node('section', 'result-card'); const top = node('div', 'result-heading');
    top.append(node('h3', '', result.label || result.id || '未命名方案'), node('span', `badge${result.status === 'ok' ? '' : ' danger'}`, result.status === 'ok' ? '完成' : '失败'));
    card.append(top);
    if (result.status !== 'ok') card.append(node('p', 'result-error', typeof result.error === 'string' ? result.error : result.error?.message || '此方案没有返回有效结果。'));
    else {
      card.append(node('p', 'result-copy-label', 'ENGLISH · 原文'), node('p', 'source-text', result.source || '未识别到英文'), node('p', 'result-copy-label', '中文 · 翻译'));
      const target = node('p', `target-text${result.target ? '' : ' result-placeholder'}`, result.target || '该方案未返回中文译文'); card.append(target);
    }
    const metrics = node('div', 'result-metrics');
    const latency = (n) => Number.isFinite(n) ? `${(n / 1000).toFixed(2)}s` : '—';
    metrics.append(node('span', '', `转录 ${latency(result.asrMs)}`), node('span', '', `翻译 ${latency(result.translationMs)}`), node('span', '', `总耗时 ${latency(result.totalMs)}`));
    if (report.referenceProvided && result.wer && Number.isFinite(result.wer.rate)) {
      metrics.append(node('strong', '', `WER ${(result.wer.rate * 100).toFixed(1)}%`));
      card.append(metrics, node('p', 'wer-detail', `替换 ${result.wer.substitutions} · 遗漏 ${result.wer.deletions} · 插入 ${result.wer.insertions} · 参考词数 ${result.wer.referenceWords}。越低越接近人工英文参考。`));
    } else { metrics.append(node('span', '', 'WER 未评测')); card.append(metrics); }
    grid.append(card);
  }
  container.append(grid); ui['results-list'].append(container);
  ui['result-summary'].textContent = `${state.reports.length} ${segmentNumber ? '个片段' : '次对比'} · 不自动评判译文排名`;
  if (report.saved === false && !report.isHistorical) notice('对比已完成，但自动保存失败。请使用“导出 JSON / TXT”保存本次结果。', true);
  updateControls();
}
async function loadDemo() {
  if (busy()) return; ui['demo-button'].disabled = true;
  try { const report = await request('/api/demo'); addReport({ ...report, isHistorical: true }, null, true); status('正在查看历史示例', '已保存的真实测试，不采集音频、不调用模型。'); notice('仅查看本机保存的历史腾讯测试。示例不能代表当前其他模型的准确率。'); }
  catch (error) { notice(errorMessage(error), true); }
  finally { updateControls(); }
}
async function loadHistory() {
  if (state.historyLoading) return; state.historyLoading = true; $('refresh-history').disabled = true;
  try {
    const data = await request('/api/history'); ui['history-list'].replaceChildren();
    if (!data.items?.length) ui['history-list'].append(node('div', 'history-empty', '还没有保存的对比记录。完成一次对比后，结果会出现在这里。'));
    for (const item of data.items || []) {
      const row = node('article', 'history-item'); const copy = node('div');
      const summary = typeof item.summary === 'string' ? item.summary : Array.isArray(item.summary) ? item.summary.join(' / ') : '课堂音频对比';
      copy.append(node('h2', '', summary || '课堂音频对比'), node('p', '', `${timestamp(item.createdAt)} · ${durationText(item.duration)}`));
      const open = node('button', 'button small outlined', '查看结果'); open.type = 'button'; open.disabled = busy();
      open.addEventListener('click', async () => {
        if (busy()) { notice('请先停止当前录音或分析，再回看历史记录。'); return; }
        open.disabled = true;
        try { const report = await request(`/api/history/${encodeURIComponent(item.id)}`); addReport(report, null, true); switchTab('compare'); status('正在回看历史记录', '加载本机结果，没有新的模型调用。'); notice('已加载历史记录，不产生新的 API 费用。'); }
        catch (error) { notice(errorMessage(error), true); }
        finally { open.disabled = busy(); }
      }); row.append(copy, open); ui['history-list'].append(row);
    }
  } catch (error) { ui['history-list'].replaceChildren(node('div', 'history-empty', errorMessage(error))); }
  finally { state.historyLoading = false; $('refresh-history').disabled = false; }
}

function wavFromPCM(chunks) {
  const bytes = chunks.reduce((sum, buffer) => sum + buffer.byteLength, 0);
  if (!bytes || bytes % 2 || bytes > 60 * 32000) throw new Error('音频必须为大于 0 且不超过 60 秒的单声道 PCM16。');
  const wav = new ArrayBuffer(44 + bytes); const view = new DataView(wav);
  const text = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, 'RIFF'); view.setUint32(4, 36 + bytes, true); text(8, 'WAVE'); text(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, bytes, true);
  let offset = 44; const target = new Uint8Array(wav);
  for (const chunk of chunks) { target.set(new Uint8Array(chunk), offset); offset += chunk.byteLength; }
  return wav;
}
function floatToPCM(input) {
  const buffer = new ArrayBuffer(input.length * 2); const view = new DataView(buffer);
  for (let i = 0; i < input.length; i++) { const value = Math.max(-1, Math.min(1, input[i])); view.setInt16(i * 2, Math.round(value * (value < 0 ? 32768 : 32767)), true); }
  return buffer;
}
function wavBase64(wav) {
  const bytes = new Uint8Array(wav); const pieces = [];
  for (let i = 0; i < bytes.length; i += 32768) pieces.push(String.fromCharCode(...bytes.subarray(i, i + 32768)));
  return btoa(pieces.join(''));
}
function setAudio(wav, name) {
  ui['preview-player'].pause();
  if (state.audio?.url) URL.revokeObjectURL(state.audio.url);
  const url = URL.createObjectURL(new Blob([wav], { type: 'audio/wav' }));
  state.audio = { wav, duration: (wav.byteLength - 44) / 32000, name, url };
  ui['audio-preview'].hidden = false; ui['audio-name'].textContent = name; ui['audio-duration'].textContent = durationText(state.audio.duration); ui['preview-player'].src = url; updateControls();
}
function clearAudio() {
  if (busy()) return; ui['preview-player'].pause();
  if (state.audio?.url) URL.revokeObjectURL(state.audio.url);
  state.audio = null; ui['preview-player'].removeAttribute('src'); ui['preview-player'].load(); ui['audio-preview'].hidden = true; ui['audio-file'].value = ''; updateControls();
}
async function importAudio(file) {
  if (!file || busy()) return;
  state.importing = true; updateControls(); notice(''); status('正在读取本地音频', '仅在浏览器中解码，不调用云服务。');
  let context;
  try {
    if (file.size > 80 * 1024 * 1024) throw new Error('文件超过 80 MB。请先导出一段不超过 60 秒的音频再上传。');
    context = new AudioContext();
    const decoded = await context.decodeAudioData(await file.arrayBuffer());
    if (!decoded.length || decoded.duration > 60) throw new Error(`音频长 ${durationText(decoded.duration)}，超过 60 秒。没有截取或上传，请先自行裁剪到 60 秒以内。`);
    const samples = Math.ceil(decoded.duration * 16000);
    if (samples > 60 * 16000) throw new Error('音频超过 60 秒，请先自行裁剪后重新上传。');
    const offline = new OfflineAudioContext(1, samples, 16000);
    const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
    const rendered = await offline.startRendering();
    const pcm = floatToPCM(rendered.getChannelData(0));
    setAudio(wavFromPCM([pcm]), file.name);
    status('音频已准备', `${durationText(state.audio.duration)} · 可先试听，再点击对比。`);
    notice('音频已在本机转换为 16 kHz 单声道 WAV，尚未发送至任何平台。');
  } catch (error) { notice(errorMessage(error), true); status('未导入新音频', '原有音频保持可用；没有发生模型调用。', 'error'); }
  finally { if (context && context.state !== 'closed') await context.close().catch(() => {}); state.importing = false; ui['audio-file'].value = ''; updateControls(); }
}
function analysisBody(wav, pipelines, hints, reference) {
  return { audio: wavBase64(wav), pipelines, glossary: hints.glossary, context: hints.context, financeCourse: hints.financeCourse || 'none', reference: reference || '', save: true };
}
async function analyzeClip() {
  if (busy() || !state.audio) return;
  let pipelines; try { pipelines = selectedPipelines(); } catch (error) { notice(errorMessage(error), true); return; }
  const operation = { controller: new AbortController() }; state.analysis = operation; updateControls(); notice('');
  status('正在对比同一段音频', `${pipelines.length} 个方案正在处理；各自计费，可随时停止。`, 'active');
  try {
    const body = analysisBody(state.audio.wav, pipelines, { glossary: ui.glossary.value, context: ui.context.value, financeCourse: $('finance-course').value }, ui.reference.value);
    const report = await request('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: operation.controller.signal });
    if (state.analysis !== operation || operation.controller.signal.aborted) return;
    addReport(report, null, true); status('本次对比已完成', '请结合英文参考与课堂语义判断，页面不会生成模型排名。');
    if (report.saved !== false) notice('对比已完成。WER 仅衡量英文转录与人工参考的差异，中文译文需要人工核对。');
  } catch (error) {
    if (state.analysis === operation) { status(operation.controller.signal.aborted ? '对比已停止' : '对比失败', '采集未开启；停止请求前已提交的调用可能已经产生费用。', operation.controller.signal.aborted ? '' : 'error'); notice(operation.controller.signal.aborted ? '已取消本次在途请求。各平台已经处理的部分可能计费。' : errorMessage(error), !operation.controller.signal.aborted); }
  } finally { if (state.analysis === operation) state.analysis = null; updateControls(); }
}
function cancelAnalysis() { state.analysis?.controller.abort(); }
function releaseCapture(run) {
  clearInterval(run.timer);
  if (run.worklet) run.worklet.port.onmessage = null;
  for (const item of [run.sourceNode, run.worklet, run.sink]) { try { item?.disconnect(); } catch { /* Already disconnected. */ } }
  for (const track of run.stream?.getTracks() || []) track.stop();
  if (run.context && run.context.state !== 'closed') void run.context.close().catch(() => {});
}
function flushCapture(run) {
  if (!run.worklet || !run.startedAt || run.context?.state !== 'running') return Promise.resolve(null);
  clearInterval(run.timer);
  try { run.sourceNode.disconnect(); } catch { /* Already disconnected. */ }
  for (const track of run.stream?.getTracks() || []) track.stop();
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), 300);
    run.worklet.port.onmessage = event => {
      if (event.data?.type !== 'flushed') return;
      clearTimeout(timer);
      const buffer = event.data.buffer;
      resolve(buffer instanceof ArrayBuffer && buffer.byteLength > 0 && buffer.byteLength <= 6400 && buffer.byteLength % 2 === 0 ? buffer : null);
    };
    run.worklet.port.postMessage({ type: 'flush' });
  });
}
async function stopCapture(message = '', error = false, flush = true) {
  const run = state.capture; if (!run || run.stopping) return;
  run.stopping = true; run.requestAbort?.abort(); run.queue.length = 0; clearInterval(run.timer); updateControls();
  status('正在停止', '声音采集已停止，正在释放本机音频资源。');
  let tail = null;
  try { if (flush) tail = await flushCapture(run); } finally { releaseCapture(run); }
  if (tail && run.bytes + tail.byteLength <= 60 * 32000) { run.chunks.push(tail); run.bytes += tail.byteLength; }
  if (run.bytes > 0) {
    try { setAudio(wavFromPCM(run.chunks), run.mode === 'live' ? '分段字幕 · 未提交尾段（仅本机）' : '本机录音'); }
    catch (conversionError) { message = `${message} ${errorMessage(conversionError)}`; error = true; }
  }
  if (state.capture === run) state.capture = null;
  if (run.mode === 'live' && run.bytes > 0) { state.mode = 'clip'; setModeUI(); }
  status(error ? '已自动停止' : run.mode === 'live' ? '分段字幕已停止' : '录音已完成', run.mode === 'live' ? '在途对比已取消；未提交尾段仅保存在本页。' : `${run.bytes ? durationText(run.bytes / 32000) : '没有录到音频'} · 试听后可手动提交对比。`, error ? 'error' : '');
  notice(message || (run.mode === 'live' ? '已停止声音采集并取消在途请求。保留已完成结果；未提交的尾段可在本地试听后手动对比。' : '录音保存在本页，尚未调用模型。可先试听，再点击“对比这段音频”。'), error);
  updateControls();
}
async function processLiveQueue(run) {
  if (run.processing || run.stopping) return;
  run.processing = true;
  try {
    while (run.queue.length && !run.stopping && state.capture === run) {
      const segment = run.queue.shift();
      run.requestAbort = new AbortController();
      status('正在生成分段字幕', `片段 ${segment.number} 正在对比 · 等待 ${run.queue.length} 段`, 'active');
      try {
        const body = analysisBody(segment.wav, run.pipelines, run.hints, '');
        const report = await request('/api/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: run.requestAbort.signal });
        if (run.stopping || state.capture !== run) break;
        addReport(report, segment.number);
        if (report.results?.length && report.results.every(result => result.status === 'error')) {
          void stopCapture('当前片段所有方案都返回错误，已自动停止，避免继续提交。请检查结果卡片与 API 配置。', true);
          break;
        }
      } catch (error) {
        if (!run.stopping && state.capture === run) void stopCapture(`分段分析中断：${errorMessage(error)} 已停止后续提交。`, true);
        break;
      } finally { run.requestAbort = null; }
    }
  } finally { run.processing = false; }
}
function acceptAudio(run, buffer) {
  if (run.stopping || state.capture !== run) return;
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength !== 6400) { void stopCapture('收到异常音频块，已停止采集。', true, false); return; }
  if (run.mode === 'clip' && run.bytes + buffer.byteLength > 60 * 32000) { void stopCapture('已达到 60 秒录音上限。音频仅保留本机，尚未调用模型。', false, false); return; }
  run.chunks.push(buffer); run.bytes += buffer.byteLength; run.totalBytes += buffer.byteLength;
  ui['capture-timer'].textContent = formatTime(run.totalBytes / 32000);
  if (run.mode === 'clip') {
    if (run.bytes >= 60 * 32000) void stopCapture('已达到 60 秒录音上限。音频仅保留本机，尚未调用模型。', false, false);
    return;
  }
  if (run.bytes >= run.segmentSeconds * 32000) {
    if (run.queue.length >= 3) { void stopCapture('分析速度落后于录音，等待队列超过 3 个片段。已停止采集并取消在途请求；请减少方案数量或使用较长分段。', true); return; }
    const wav = wavFromPCM(run.chunks); run.chunks = []; run.bytes = 0; run.segmentNumber++;
    run.queue.push({ number: run.segmentNumber, wav });
    void processLiveQueue(run);
  }
  if (run.totalBytes / 32000 >= run.maxSeconds) void stopCapture('已达到本次时长上限，采集与在途请求已自动停止。');
}
async function startCapture(mode) {
  if (busy()) return;
  let pipelines = []; if (mode === 'live') { try { pipelines = selectedPipelines(); } catch (error) { notice(errorMessage(error), true); return; } }
  const source = document.querySelector('input[name="source"]:checked').value;
  const run = { mode, pipelines, hints: { glossary: ui.glossary.value, context: ui.context.value, financeCourse: $('finance-course').value }, chunks: [], bytes: 0, totalBytes: 0, queue: [], segmentNumber: 0, segmentSeconds: Number(ui['segment-seconds'].value), maxSeconds: mode === 'clip' ? 60 : Number(ui['live-minutes'].value) * 60, stopping: false, processing: false, startedAt: null };
  state.capture = run; updateControls(); notice(''); status('等待声音授权', source === 'screen' ? '选择课程标签页或屏幕，并勾选共享音频。' : '请允许浏览器使用麦克风。');
  try {
    if (!window.isSecureContext || !navigator.mediaDevices || !window.AudioWorkletNode) throw new Error('浏览器不支持音频采集。请使用新版 Chrome / Edge，通过 localhost 地址打开此工作台。');
    run.stream = source === 'screen' ? await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' }) : await navigator.mediaDevices.getUserMedia({ video: false, audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    if (run.stopping || state.capture !== run) { releaseCapture(run); return; }
    if (!run.stream.getAudioTracks().length) throw new Error('此次共享没有音轨。请重新开始，选择课程标签页或整个屏幕，并勾选“共享音频 / 系统音频”。');
    for (const track of run.stream.getTracks()) track.addEventListener('ended', () => { if (state.capture === run) void stopCapture('声音来源已经结束，采集与在途请求已停止。'); }, { once: true });
    run.context = new AudioContext({ latencyHint: 'interactive' }); await run.context.audioWorklet.addModule('/pcm-worklet.js');
    if (run.stopping || state.capture !== run) { releaseCapture(run); return; }
    run.sourceNode = run.context.createMediaStreamSource(new MediaStream(run.stream.getAudioTracks()));
    run.worklet = new AudioWorkletNode(run.context, 'classroom-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    run.sink = run.context.createGain(); run.sink.gain.value = 0;
    await run.context.resume();
    if (run.stopping || state.capture !== run) { releaseCapture(run); return; }
    if (run.context.state !== 'running') throw new Error('浏览器没有启动音频处理，请重新点击开始，或在 Chrome / Edge 中打开。');
    if (mode === 'live') resetResults();
    run.startedAt = performance.now(); ui['capture-timer'].textContent = '00:00';
    run.worklet.port.onmessage = event => acceptAudio(run, event.data);
    run.sourceNode.connect(run.worklet); run.worklet.connect(run.sink); run.sink.connect(run.context.destination);
    status(mode === 'live' ? '正在采集分段字幕' : '正在本机录音', mode === 'live' ? `每 ${run.segmentSeconds} 秒同音频对比 · ${pipelines.length} 个方案各自计费` : '最多 60 秒 · 不发送至云端', 'active');
    run.timer = setInterval(() => {
      if (run.stopping || state.capture !== run) return;
      if (run.context.state !== 'running') { void stopCapture('浏览器暂停了音频处理，已停止采集与在途请求。请保持电脑唤醒后重试。', true); return; }
      if ((performance.now() - run.startedAt) / 1000 >= run.maxSeconds) void stopCapture(mode === 'clip' ? '已达到 60 秒录音上限，音频仅保留本机。' : '已达到本次时长上限，采集与在途请求已自动停止。');
    }, 250);
  } catch (error) {
    if (state.capture === run && !run.stopping) await stopCapture(errorMessage(error), true);
    else releaseCapture(run);
  }
}
function setModeUI() {
  const live = state.mode === 'live';
  ui['mode-live'].classList.toggle('active', live); ui['mode-clip'].classList.toggle('active', !live);
  ui['clip-controls'].hidden = live; ui['live-controls'].hidden = !live; ui['reference-panel'].hidden = live; ui['live-explanation'].hidden = !live; updateControls();
}
function renderFinancePack() {
  const selected = $('finance-course').value; const content = $('finance-content'); content.replaceChildren();
  if (selected === 'none') { $('finance-summary').textContent = '已关闭内置词库，仅使用你补充的课堂背景与术语。'; $('finance-details').hidden = true; return; }
  $('finance-details').hidden = false;
  if (!state.financePack) { $('finance-summary').textContent = '金融词库暂未加载，可刷新页面重试。'; return; }
  const pack = state.financePack; const course = pack.courses?.find(item => item.id === selected); const general = pack.courses?.find(item => item.id === 'general');
  const terms = new Map();
  for (const term of [...(general?.terms || []), ...(selected === 'general' ? [] : course?.terms || [])]) terms.set(String(term.en).toLowerCase(), term);
  $('finance-summary').textContent = `${course?.label || '金融课程'} · 已选 ${terms.size} 个内置术语`;
  if (course?.context) content.append(node('p', 'help', course.context));
  if (pack.rules?.length) { content.append(node('h3', '', '翻译规则')); const rules = node('ul', 'finance-rules'); for (const rule of pack.rules) rules.append(node('li', '', rule)); content.append(rules); }
  content.append(node('h3', '', '英中术语'));
  const table = node('div', 'finance-terms');
  for (const term of terms.values()) { const row = node('div', 'finance-term'); row.append(node('strong', '', term.en), node('span', '', term.zh)); if (term.note) row.append(node('small', '', term.note)); table.append(row); }
  content.append(table);
  if (pack.sources?.length) {
    content.append(node('h3', '', '词库参考来源')); const sources = node('div', 'finance-sources');
    for (const source of pack.sources) { try { const url = new URL(source.url); if (['https:', 'http:'].includes(url.protocol)) { const link = node('a', '', source.title); link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; sources.append(link); } } catch { /* Invalid source URLs are not linked. */ } }
    content.append(sources);
  }
}
async function loadFinancePack() {
  try { state.financePack = await request('/api/finance-pack'); renderFinancePack(); }
  catch { $('finance-summary').textContent = '金融词库暂未加载，请确认本机服务已更新后刷新页面。'; }
}
function exportReports(type) {
  if (!state.reports.length) return;
  let text;
  if (type === 'json') text = JSON.stringify(state.reports.length === 1 ? state.reports[0].report : { exportedAt: new Date().toISOString(), segments: state.reports.map(item => ({ segmentNumber: item.segmentNumber, ...item.report })) }, null, 2);
  else {
    const lines = ['课堂 API 实验室 · 对比结果', `导出时间：${new Date().toLocaleString('zh-CN')}`, 'WER 仅评估英文转录；中文翻译需要人工判断。', ''];
    for (const { report, segmentNumber } of state.reports) {
      lines.push(`=== ${segmentNumber ? `片段 ${segmentNumber}` : '单段对比'} · ${durationText(report.duration)} · ${timestamp(report.createdAt)} ===`);
      if (report.isHistorical) lines.push('历史真实测试示例');
      for (const result of report.results || []) {
        lines.push('', `【${result.label || result.id}】`, result.status === 'ok' ? `EN: ${result.source || ''}` : `错误：${typeof result.error === 'string' ? result.error : result.error?.message || '接口失败'}`);
        if (result.status === 'ok') lines.push(`中文：${result.target || '未返回中文译文'}`);
        lines.push(`WER：${report.referenceProvided && Number.isFinite(result.wer?.rate) ? `${(result.wer.rate * 100).toFixed(1)}%` : '未评测'}`);
      }
      lines.push('', '');
    }
    text = '\uFEFF' + lines.join('\r\n');
  }
  const url = URL.createObjectURL(new Blob([text], { type: type === 'json' ? 'application/json;charset=utf-8' : 'text/plain;charset=utf-8' }));
  const link = node('a'); link.href = url; link.download = `课堂API对比-${new Date().toLocaleDateString('sv-SE')}-${Date.now()}.${type}`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

document.querySelectorAll('.tab').forEach(el => el.addEventListener('click', () => switchTab(el.dataset.tab)));
document.querySelectorAll('[data-open-profiles]').forEach(el => el.addEventListener('click', () => switchTab('profiles')));
ui['add-pipeline'].addEventListener('click', () => {
  if (busy() || state.pipelines.length >= 3) return;
  const asr = state.profiles.find(item => item.capabilities?.includes('asr') && !state.pipelines.some(p => p.asrId === item.id)) || state.profiles.find(item => item.capabilities?.includes('asr'));
  state.pipelines.push({ id: `plan-${Date.now()}`, label: `方案 ${state.pipelines.length + 1}`, asrId: asr?.id || '', translationId: asr?.protocol === 'tencent-translation' ? 'builtin' : 'none' }); renderPipelines();
});
ui['profile-form'].addEventListener('submit', event => { void saveProfile(event); });
ui['profile-protocol'].addEventListener('change', updateProtocolHelp);
$('finance-course').addEventListener('change', renderFinancePack);
$('new-profile').addEventListener('click', () => { resetProfileForm(); ui['profile-label'].focus(); });
$('reset-profile').addEventListener('click', resetProfileForm);
$('refresh-history').addEventListener('click', () => { void loadHistory(); });
ui['demo-button'].addEventListener('click', () => { void loadDemo(); });
ui['audio-file'].addEventListener('change', event => { void importAudio(event.target.files?.[0]); });
ui['clear-audio'].addEventListener('click', clearAudio);
ui['record-button'].addEventListener('click', () => { void startCapture('clip'); });
ui['record-stop'].addEventListener('click', () => { void stopCapture(); });
ui['live-button'].addEventListener('click', () => { void startCapture('live'); });
ui['live-stop'].addEventListener('click', () => { void stopCapture(); });
ui['analyze-button'].addEventListener('click', () => { void analyzeClip(); });
ui['cancel-analysis'].addEventListener('click', cancelAnalysis);
ui['mode-clip'].addEventListener('click', () => { if (!busy()) { state.mode = 'clip'; setModeUI(); } });
ui['mode-live'].addEventListener('click', () => { if (!busy()) { state.mode = 'live'; setModeUI(); } });
ui['export-txt'].addEventListener('click', () => exportReports('txt'));
ui['export-json'].addEventListener('click', () => exportReports('json'));
document.querySelectorAll('input[name="source"]').forEach(el => el.addEventListener('change', () => { $('source-help').textContent = el.value === 'screen' ? '选择课程标签页或整个屏幕，并勾选共享音频。画面留在本机，只处理音轨。' : '开始录音后才会请求麦克风权限。'; }));
window.addEventListener('offline', () => { cancelAnalysis(); if (state.capture) void stopCapture('网络已断开，采集与在途请求已停止。', true); });
window.addEventListener('pagehide', () => {
  cancelAnalysis(); const run = state.capture;
  if (run) { run.stopping = true; run.requestAbort?.abort(); run.queue.length = 0; releaseCapture(run); }
  ui['profile-key'].value = '';
  if (state.audio?.url) URL.revokeObjectURL(state.audio.url);
});
setModeUI();
const requestedTab = location.hash.slice(1);
if (['compare', 'profiles', 'history'].includes(requestedTab)) switchTab(requestedTab);
void loadProfiles().catch(error => { notice(`无法读取 API 配置：${errorMessage(error)}`, true); status('本机服务未连接', '请确认 8766 服务已经启动。', 'error'); });
void loadFinancePack();
