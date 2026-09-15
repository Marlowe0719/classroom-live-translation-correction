import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const protocols = [
  { id: 'tencent-translation', label: '腾讯云实时语音翻译', capabilities: ['asr'] },
  { id: 'qwen-asr-chat', label: 'Qwen3-ASR（Chat 格式）', capabilities: ['asr'] },
  { id: 'qwen-asr-realtime', label: 'Qwen3-ASR Flash Realtime', capabilities: ['asr'] },
  { id: 'qwen-asr-native-live', label: 'Qwen Audio 3 持续流式识别', capabilities: ['asr'] },
  { id: 'qwen-asr-native', label: 'Qwen Audio 3 ASR（DashScope 格式）', capabilities: ['asr'] },
  { id: 'openai-asr', label: '通用 audio/transcriptions', capabilities: ['asr'] },
  { id: 'openai-chat', label: '通用 Chat 翻译', capabilities: ['translation'] },
];
const catalog = new Map(protocols.map(p => [p.id, p]));
const qwenBase = 'https://dashscope.aliyuncs.com/compatible-mode/v1';
export const presets = [
  { id: 'tencent-lite', label: '腾讯 · Translation Lite', protocol: 'tencent-translation', model: 'hunyuan-translation-lite', baseUrl: 'https://asr.cloud.tencent.com', builtin: true, docsUrl: 'https://cloud.tencent.com/document/api/1093/127565' },
  { id: 'tencent-full', label: '腾讯 · Translation', protocol: 'tencent-translation', model: 'hunyuan-translation', baseUrl: 'https://asr.cloud.tencent.com', builtin: true, docsUrl: 'https://cloud.tencent.com/document/api/1093/127565' },
  { id: 'qwen-asr', label: 'Qwen3-ASR · 完整短句（准确优先试用）', protocol: 'qwen-asr-chat', model: 'qwen3-asr-flash-2026-02-10', baseUrl: qwenBase, docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference' },
  { id: 'qwen-realtime', label: 'Qwen3-ASR Flash Realtime · 实时榜型号', protocol: 'qwen-asr-realtime', model: 'qwen3-asr-flash-realtime', baseUrl: 'https://dashscope.aliyuncs.com', docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-interaction-process' },
  { id: 'qwen-realtime-20260210', label: 'Qwen3-ASR 实时 · 2026-02-10', protocol: 'qwen-asr-realtime', model: 'qwen3-asr-flash-realtime-2026-02-10', baseUrl: 'https://dashscope.aliyuncs.com', docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen3-asr-flash-realtime' },
  { id: 'qwen-asr3', label: 'Qwen Audio 3 ASR · 热词', protocol: 'qwen-asr-native', model: 'qwen-audio-3.0-asr-flash', baseUrl: 'https://dashscope.aliyuncs.com/api/v1', docsUrl: 'https://help.aliyun.com/zh/model-studio/fun-asr-flash-recorded-speech-recognition-http-api' },
  { id: 'qwen-translate', label: 'Qwen Plus · 翻译', protocol: 'openai-chat', model: 'qwen-plus', baseUrl: qwenBase, thinkingOff: 'qwen', docsUrl: 'https://help.aliyun.com/zh/model-studio/use-qwen-by-calling-api' },
  { id: 'qwen-flash-translate', label: 'Qwen Flash · 快速翻译', protocol: 'openai-chat', model: 'qwen-flash', baseUrl: qwenBase, thinkingOff: 'qwen', docsUrl: 'https://help.aliyun.com/zh/model-studio/qwen-flash' },
  { id: 'qwen-mt-lite', label: 'Qwen MT Lite · 专用快速翻译', protocol: 'openai-chat', model: 'qwen-mt-lite', baseUrl: qwenBase, docsUrl: 'https://help.aliyun.com/zh/model-studio/machine-translation' },
  { id: 'qwen-asr-streaming', label: 'Qwen Audio 3 · 持续流式 + 热词', protocol: 'qwen-asr-native-live', model: 'qwen-audio-3.0-asr-flash-streaming', baseUrl: 'https://dashscope.aliyuncs.com', docsUrl: 'https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide' },
  { id: 'deepseek-translate', label: 'DeepSeek · 翻译', protocol: 'openai-chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', thinkingOff: 'deepseek', docsUrl: 'https://api-docs.deepseek.com/api/create-chat-completion/' },
  { id: 'custom-asr', label: '自定义语音识别 API', protocol: 'openai-asr', model: '', baseUrl: '' },
  { id: 'custom-translate', label: '自定义翻译 API', protocol: 'openai-chat', model: '', baseUrl: '' },
];

export function validateBase(value, allowEmpty = false) {
  if (!value && allowEmpty) return '';
  let url;
  try { url = new URL(value); } catch { throw new Error('请输入有效的 API 基础地址。'); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      /^\d+(?:\.\d+){3}$/.test(host) || host.includes(':') || host.includes('[')) {
    throw new Error('API 地址须为 HTTPS 公网域名，不得包含密码或查询参数。');
  }
  return url.toString().replace(/\/+$/, '');
}

export class Store {
  constructor(root = path.join(os.homedir(), '.config', 'classroom-api-lab'), getTencent) {
    this.root = root;
    this.configFile = path.join(root, 'profiles.json');
    this.historyDir = path.join(root, 'history');
    this.getTencent = getTencent || (() => JSON.parse(fs.readFileSync(path.join(os.homedir(), '.config', 'classroom-translator', 'tencent-credentials.json'), 'utf8')));
    fs.mkdirSync(this.historyDir, { recursive: true });
    if (!fs.existsSync(this.configFile)) this.writeProfiles(presets);
  }
  protect(file) {
    if (process.platform !== 'win32') { fs.chmodSync(file, 0o600); return; }
    this.sid ||= execFileSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' }).match(/S-1-\d+(?:-\d+)+/)?.[0];
    if (!this.sid) throw new Error('无法确定本机凭证文件权限。');
    execFileSync('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${this.sid}:(F)`], { windowsHide: true, stdio: 'ignore' });
  }
  writeProfiles(list) {
    const temporary = `${this.configFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(list, null, 2), { encoding: 'utf8', mode: 0o600 });
    try { this.protect(temporary); fs.renameSync(temporary, this.configFile); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  }
  read() { return JSON.parse(fs.readFileSync(this.configFile, 'utf8')); }
  resolve(id) {
    const profile = this.read().find(p => p.id === id);
    if (!profile) throw new Error('未找到 API 配置。');
    if (profile.protocol === 'tencent-translation') return { ...profile, ...this.getTencent() };
    return profile;
  }
  publicProfile(profile) {
    let configured = Boolean(profile.apiKey && profile.model && profile.baseUrl);
    if (profile.builtin) {
      try { const c = this.getTencent(); configured = Boolean(c.appId && c.secretId && c.secretKey); } catch { configured = false; }
    }
    return { id: profile.id, label: profile.label, protocol: profile.protocol, model: profile.model,
      baseUrl: profile.baseUrl, builtin: Boolean(profile.builtin), configured, hasApiKey: Boolean(profile.apiKey),
      thinkingOff: profile.thinkingOff || '', docsUrl: profile.docsUrl || '', capabilities: catalog.get(profile.protocol)?.capabilities || [] };
  }
  list() { return this.read().map(p => this.publicProfile(p)); }
  save(input) {
    const list = this.read();
    const existing = input.id && list.find(p => p.id === input.id);
    if (input.id && !existing) throw new Error('未找到要编辑的配置。');
    if (existing?.builtin || input.protocol === 'tencent-translation') throw new Error('腾讯内置配置沿用原工具凭证，无需在此修改。');
    if (list.length >= 30 && !existing) throw new Error('最多保存 30 个 API 配置。');
    if (!catalog.has(input.protocol)) throw new Error('不支持此 API 协议。');
    const label = String(input.label || '').trim();
    const model = String(input.model || '').trim();
    if (!label || label.length > 80 || !model || model.length > 150) throw new Error('请填写配置名称和模型名称。');
    const baseUrl = validateBase(input.baseUrl);
    const hostname = new URL(baseUrl).hostname;
    const thinkingOff = input.thinkingOff === true
      ? (hostname === 'api.deepseek.com' ? 'deepseek' : hostname.endsWith('.aliyuncs.com') ? 'qwen' : '')
      : input.thinkingOff === false ? '' : input.thinkingOff || '';
    if (!['', 'qwen', 'deepseek'].includes(thinkingOff)) throw new Error('不支持此思考参数。');
    let apiKey = String(input.apiKey || '').trim();
    if (apiKey.length > 4096 || /[\r\n]/.test(apiKey)) throw new Error('API Key 格式无效。');
    // Reusing a key across a changed destination requires entering it again.
    if (!apiKey && existing?.apiKey && new URL(existing.baseUrl).origin === new URL(baseUrl).origin) apiKey = existing.apiKey;
    const next = { id: existing?.id || crypto.randomUUID(), label, model, protocol: input.protocol,
      baseUrl, apiKey, thinkingOff, docsUrl: existing?.docsUrl || '' };
    const nextList = existing ? list.map(p => p.id === existing.id ? next : p) : [...list, next];
    this.writeProfiles(nextList);
    return this.publicProfile(next);
  }
  remove(id) {
    const list = this.read();
    const p = list.find(p => p.id === id);
    if (!p || p.builtin) throw new Error('不能删除此配置。');
    this.writeProfiles(list.filter(p => p.id !== id));
  }
  saveReport(report) {
    fs.writeFileSync(path.join(this.historyDir, `${report.id}.json`), JSON.stringify(report, null, 2), { mode: 0o600 });
  }
  history() {
    return fs.readdirSync(this.historyDir).filter(name => /^[a-f0-9-]+\.json$/.test(name)).map(name => {
      try {
        const r = JSON.parse(fs.readFileSync(path.join(this.historyDir, name), 'utf8'));
        return { id: r.id, createdAt: r.createdAt, duration: r.duration, summary: r.results.map(x => `${x.label}：${x.status === 'ok' ? '已完成' : '失败'}`).join(' / ') };
      } catch { return null; }
    }).filter(Boolean).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 200);
  }
  report(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('记录不存在。');
    return JSON.parse(fs.readFileSync(path.join(this.historyDir, `${id}.json`), 'utf8'));
  }
}
