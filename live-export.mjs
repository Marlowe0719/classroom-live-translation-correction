import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

export const LIVE_EXPORT_TEXT_BYTES = 2 * 1024 * 1024;
export const LIVE_EXPORT_BODY_BYTES = LIVE_EXPORT_TEXT_BYTES + 1024;
const bom = Buffer.from([0xef, 0xbb, 0xbf]);
// Shared between app instances in this process; released after each completed write.
const pending = new Map();
export class LiveExportError extends Error {
  constructor(code = 'EXPORT_FAILED') {
    super(code === 'INVALID_EXPORT' ? '导出内容无效，请保留课堂编号、完整字幕和有效结束时间。'
      : '自动保存字幕未成功，请使用页面的下载功能保存 TXT。');
    this.code = code; this.status = code === 'INVALID_EXPORT' ? 400 : 500;
  }
}
const invalid = () => new LiveExportError('INVALID_EXPORT');
export function validateLiveExport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !['runId', 'text', 'endedAt'].includes(key))
    || typeof value.runId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.runId)
    || typeof value.text !== 'string' || !value.text.trim()
    || Buffer.byteLength(value.text, 'utf8') > LIVE_EXPORT_TEXT_BYTES
    || typeof value.endedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.endedAt)) throw invalid();
  const date = new Date(value.endedAt);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== (value.endedAt.length === 20 ? value.endedAt.replace('Z', '.000Z') : value.endedAt)) throw invalid();
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > LIVE_EXPORT_BODY_BYTES) throw invalid();
  return { runId: value.runId, text: value.text, endedAt: date.toISOString() };
}

/** All disk work is async and local; this service never touches API profiles or audio. */
export function createLiveExportService({ exportRoot = path.join(os.homedir(), 'Downloads', '课堂字幕'), fsImpl = fs } = {}) {
  if (typeof exportRoot !== 'string' || !exportRoot.trim()) throw invalid();
  const root = path.resolve(exportRoot);
  function located(fileName) {
    const target = path.resolve(root, fileName);
    if (path.dirname(target) !== root) throw new LiveExportError();
    return { saved: true, fileName, path: target };
  }
  async function checked(fileName) {
    const result = located(fileName), info = await fsImpl.lstat(result.path);
    if (!info.isFile() || info.isSymbolicLink() || info.size <= bom.length || info.size > LIVE_EXPORT_TEXT_BYTES + bom.length) throw new LiveExportError();
    const handle = await fsImpl.open(result.path, 'r');
    try {
      const prefix = Buffer.alloc(3), read = await handle.read(prefix, 0, 3, 0);
      if (read.bytesRead !== 3 || !prefix.equals(bom)) throw new LiveExportError();
    } finally { await handle.close(); }
    return result;
  }
  async function existing(hash) {
    const entries = await fsImpl.readdir(root, { withFileTypes: true });
    const name = new RegExp(`^课堂字幕-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-${hash}\\.txt$`);
    const found = entries.filter(entry => name.test(entry.name));
    if (found.length > 1 || found.some(entry => !entry.isFile())) throw new LiveExportError();
    return found.length ? checked(found[0].name) : null;
  }
  async function save(input, hash) {
    let handle, temporary;
    try {
      await fsImpl.mkdir(root, { recursive: true, mode: 0o700 });
      const prior = await existing(hash);
      if (prior) return prior;
      // UTC timestamp is deterministic; the hash avoids filename length and path injection.
      const stamp = input.endedAt.slice(0, 19).replace(/[T:]/g, '-');
      const fileName = `课堂字幕-${stamp}-${hash}.txt`, result = located(fileName);
      temporary = located(`.${fileName}.${randomUUID()}.tmp`).path;
      handle = await fsImpl.open(temporary, 'wx', 0o600);
      await handle.writeFile(Buffer.concat([bom, Buffer.from(input.text, 'utf8')]));
      await handle.sync(); await handle.close(); handle = null;
      // Publish a fully written file atomically. link() is exclusive: never replace an existing TXT.
      try { await fsImpl.link(temporary, result.path); }
      catch (failure) { if (failure.code !== 'EEXIST') throw failure; return await checked(fileName); }
      return result;
    } catch (failure) {
      if (failure instanceof LiveExportError) throw failure;
      throw new LiveExportError();
    } finally {
      if (handle) { try { await handle.close(); } catch { /* static error already returned */ } }
      if (temporary) { try { await fsImpl.unlink(temporary); } catch { /* a failed temporary is never a published TXT */ } }
    }
  }
  async function exportText(raw) {
    const input = validateLiveExport(raw);
    const hash = createHash('sha256').update(input.runId, 'utf8').digest('hex');
    const key = `${process.platform === 'win32' ? root.toLowerCase() : root}\0${hash}`;
    if (pending.has(key)) return pending.get(key);
    const operation = save(input, hash);
    pending.set(key, operation);
    try { return await operation; }
    finally { if (pending.get(key) === operation) pending.delete(key); }
  }
  return { exportText };
}
