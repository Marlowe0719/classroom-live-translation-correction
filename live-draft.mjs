import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const LIVE_DRAFT_BYTES = 2 * 1024 * 1024;
const invalid = () => Object.assign(new Error('字幕草稿格式无效或超过大小限制。'), { code: 'INVALID_DRAFT' });
const storageError = () => Object.assign(new Error('无法安全读写本机字幕草稿；已有草稿未被覆盖。'), { code: 'DRAFT_STORAGE' });
function record(value, keys, required = keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !keys.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw invalid();
}
function text(value, max) { if (typeof value !== 'string' || value.length > max) throw invalid(); return value; }
function id(value, max = 160) { if (typeof value !== 'string' || value.length > max || !/^[a-zA-Z0-9_-]+$/.test(value)) throw invalid(); return value; }
function bool(value) { if (typeof value !== 'boolean') throw invalid(); return value; }
function oneOf(value, values) { if (!values.includes(value)) throw invalid(); return value; }
function number(value, min, max) { if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw invalid(); return value; }

/** Return only caption data and explicitly allowed display/settings fields. */
export function validateLiveDraft(input) {
  record(input, ['version', 'sessions', 'settings'], ['version', 'sessions']);
  if (input.version !== 1 || !Array.isArray(input.sessions) || input.sessions.length > 200) throw invalid();
  let rowCount = 0;
  const sessionIds = new Set();
  const sessions = input.sessions.map(session => {
    record(session, ['id', 'createdAt', 'asrLabel', 'translationLabel', 'historical', 'rows']);
    const sessionId = id(session.id, 128);
    if (sessionIds.has(sessionId)) throw invalid(); sessionIds.add(sessionId);
    const createdAt = text(session.createdAt, 40);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(createdAt) || !Number.isFinite(Date.parse(createdAt))) throw invalid();
    if (!Array.isArray(session.rows) || (rowCount += session.rows.length) > 10000) throw invalid();
    const rowIds = new Set();
    return { id: sessionId, createdAt, asrLabel: text(session.asrLabel, 200),
      translationLabel: text(session.translationLabel, 200), historical: bool(session.historical),
      rows: session.rows.map(row => {
        record(row, ['id', 'source', 'target', 'final', 'translationStatus', 'seconds']);
        const rowId = id(row.id);
        if (rowIds.has(rowId)) throw invalid(); rowIds.add(rowId);
        return { id: rowId, source: text(row.source, 65536), target: text(row.target, 65536),
          final: bool(row.final), translationStatus: oneOf(row.translationStatus, ['pending', 'done', 'error']),
          seconds: number(row.seconds, 0, 604800) };
      }) };
  });
  const result = { version: 1, sessions };
  if (Object.hasOwn(input, 'settings')) {
    const allowed = ['asrId', 'translationId', 'financeCourse', 'maxMinutes', 'source', 'displayLanguage', 'autoscroll', 'fontSize', 'glossary', 'context'];
    record(input.settings, allowed, []);
    const settings = {};
    for (const [key, value] of Object.entries(input.settings)) {
      if (['asrId', 'translationId'].includes(key)) settings[key] = id(value, 100);
      else if (key === 'financeCourse') settings[key] = oneOf(value, ['general', 'corporate', 'asset-pricing', 'fixed-income', 'derivatives', 'portfolio', 'econometrics', 'fx', 'none']);
      else if (key === 'maxMinutes') settings[key] = oneOf(value, [10, 45, 60, 90, 120]);
      else if (key === 'source') settings[key] = oneOf(value, ['mic', 'system']);
      else if (key === 'displayLanguage') settings[key] = oneOf(value, ['bilingual', 'chinese']);
      else if (key === 'autoscroll') settings[key] = bool(value);
      else if (key === 'fontSize') { if (!Number.isInteger(value)) throw invalid(); settings[key] = number(value, 20, 46); }
      else settings[key] = text(value, 3000);
    }
    result.settings = settings;
  }
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > LIVE_DRAFT_BYTES) throw invalid();
  return result;
}

function draftFile(store) {
  if (typeof store?.root !== 'string' || !path.isAbsolute(store.root)) throw storageError();
  return path.join(store.root, 'live-draft.json');
}
export function readLiveDraft(store) {
  const file = draftFile(store);
  try {
    const info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > LIVE_DRAFT_BYTES + 1024) throw storageError();
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    record(saved, ['revision', 'draft']);
    if (!Number.isSafeInteger(saved.revision) || saved.revision < 1) throw storageError();
    return { revision: saved.revision, draft: validateLiveDraft(saved.draft) };
  } catch (error) {
    if (error.code === 'ENOENT') return { revision: 0, draft: null };
    throw storageError();
  }
}
export function writeLiveDraft(store, input) {
  record(input, ['expectedRevision', 'draft']);
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) throw invalid();
  const draft = validateLiveDraft(input.draft);
  const current = readLiveDraft(store);
  if (input.expectedRevision !== current.revision) {
    throw Object.assign(new Error('字幕草稿已被另一页面更新；当前页面没有覆盖它。请先导出当前字幕再刷新。'), { code: 'DRAFT_CONFLICT' });
  }
  if (current.revision >= Number.MAX_SAFE_INTEGER || typeof store.protect !== 'function') throw storageError();
  const revision = current.revision + 1;
  const file = draftFile(store), temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.mkdirSync(store.root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temporary, JSON.stringify({ revision, draft }), { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    store.protect(temporary);
    fs.renameSync(temporary, file);
  } catch { throw storageError(); }
  finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
  return { saved: true, revision, sessions: draft.sessions.length,
    rows: draft.sessions.reduce((total, session) => total + session.rows.length, 0) };
}
