import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createApp } from './server.mjs';
import { LIVE_EXPORT_TEXT_BYTES, LIVE_EXPORT_BODY_BYTES, validateLiveExport, createLiveExportService } from './live-export.mjs';

// Synthetic captions only. Every output is confined to a new test temp directory.
const check = (name, fn) => test(name, { timeout: 8000 }, fn);
const deferred = () => { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; };
const input = (changes = {}) => ({ runId: 'offline-run_123', text: 'Classroom test\nYield may fall.\n收益率可能下跌。\n',
  endedAt: '2026-09-15T10:20:30.123Z', ...changes });
async function fixture(t) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'live-export-test-'));
  const exportRoot = path.join(temporaryRoot, '课堂字幕');
  t.after(async () => { const target = path.resolve(temporaryRoot);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep + 'live-export-test-'));
    await fs.rm(target, { recursive: true, force: true }); });
  return { temporaryRoot, exportRoot, service: createLiveExportService({ exportRoot }) };
}

check('export input preserves original whitespace and normalizes valid UTC timestamps', () => {
  assert.deepEqual(validateLiveExport(input()), input());
  assert.equal(validateLiveExport(input({ endedAt: '2026-09-15T10:20:30Z' })).endedAt, '2026-09-15T10:20:30.000Z');
  assert.equal(validateLiveExport(input({ text: '  原始字幕\n' })).text, '  原始字幕\n');
});

check('strict schema rejects paths, credentials, prototype keys, wrong types and impossible dates', () => {
  const values = [null, [], input({ runId: '' }), input({ runId: '../outside' }), input({ runId: 'a\\b' }), input({ runId: 'run.txt' }),
    input({ runId: 'a'.repeat(129) }), input({ runId: 42 }), input({ text: '' }), input({ text: '\n\t ' }), input({ text: {} }),
    input({ endedAt: '2026-09-15T10:20:30+08:00' }), input({ endedAt: '2026-02-30T10:20:30.000Z' }),
    input({ endedAt: '2026-09-15T25:20:30.000Z' }), input({ endedAt: 42 }), input({ path: 'C:\\outside.txt' }),
    input({ apiKey: 'synthetic-secret' }), JSON.parse('{"runId":"x","text":"text","endedAt":"2026-09-15T10:20:30Z","__proto__":{}}')];
  for (const value of values) assert.throws(() => validateLiveExport(value), { code: 'INVALID_EXPORT' });
});

check('UTF-8 text and serialized JSON bounds are enforced independently', () => {
  assert.equal(validateLiveExport(input({ text: 'a'.repeat(LIVE_EXPORT_TEXT_BYTES) })).text.length, LIVE_EXPORT_TEXT_BYTES);
  assert.throws(() => validateLiveExport(input({ text: 'a'.repeat(LIVE_EXPORT_TEXT_BYTES + 1) })), { code: 'INVALID_EXPORT' });
  assert.throws(() => validateLiveExport(input({ text: '中'.repeat(Math.floor(LIVE_EXPORT_TEXT_BYTES / 3) + 1) })), { code: 'INVALID_EXPORT' });
  const escaped = input({ text: 'x\n'.repeat(LIVE_EXPORT_TEXT_BYTES / 2) });
  assert.ok(Buffer.byteLength(JSON.stringify(escaped)) > LIVE_EXPORT_BODY_BYTES);
  assert.throws(() => validateLiveExport(escaped), { code: 'INVALID_EXPORT' });
});

check('service creation has no side effects; first export writes exact BOM-prefixed UTF-8 text', async t => {
  const { service, exportRoot } = await fixture(t);
  await assert.rejects(fs.stat(exportRoot), { code: 'ENOENT' });
  const result = await service.exportText(input());
  assert.equal(result.saved, true); assert.equal(path.dirname(result.path), exportRoot);
  assert.match(result.fileName, /^课堂字幕-2026-09-15-10-20-30-[a-f0-9]{64}\.txt$/);
  assert.equal(result.path, path.join(exportRoot, result.fileName));
  assert.deepEqual(await fs.readFile(result.path), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(input().text)]));
  assert.deepEqual(await fs.readdir(exportRoot), [result.fileName]);
});

check('twenty concurrent retries across service instances publish exactly one file', async t => {
  const { service, exportRoot } = await fixture(t), second = createLiveExportService({ exportRoot });
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? service : second).exportText(input({
    endedAt: index % 2 ? '2026-09-16T02:00:00Z' : input().endedAt,
  }))));
  assert.equal(new Set(results.map(value => value.path)).size, 1);
  assert.equal((await fs.readdir(exportRoot)).length, 1);
});

check('same run after service reconstruction reuses the first file even if text or end time changes', async t => {
  const { service, exportRoot } = await fixture(t);
  const initial = await service.exportText(input());
  const before = await fs.readFile(initial.path);
  const rebuilt = createLiveExportService({ exportRoot });
  assert.deepEqual(await rebuilt.exportText(input({ endedAt: '2026-09-16T01:02:03Z', text: 'Retry must not overwrite the first export.' })), initial);
  assert.deepEqual(await fs.readFile(initial.path), before);
  assert.equal((await fs.readdir(exportRoot)).length, 1);
});

check('separate Node processes also locate the same persisted run after restart', async t => {
  const { exportRoot } = await fixture(t);
  const moduleUrl = new URL('./live-export.mjs', import.meta.url).href;
  const script = `import {createLiveExportService} from ${JSON.stringify(moduleUrl)}; const r=await createLiveExportService({exportRoot:process.argv[1]}).exportText(JSON.parse(process.argv[2])); process.stdout.write(JSON.stringify(r));`;
  const child = promisify(execFile);
  const first = JSON.parse((await child(process.execPath, ['--input-type=module', '-e', script, exportRoot, JSON.stringify(input())])).stdout);
  const second = JSON.parse((await child(process.execPath, ['--input-type=module', '-e', script, exportRoot,
    JSON.stringify(input({ text: 'Changed retry.', endedAt: '2026-09-17T00:00:00Z' }))])).stdout);
  assert.deepEqual(second, first); assert.equal((await fs.readdir(exportRoot)).length, 1);
});

check('different run IDs including case and long names never overwrite each other', async t => {
  const { service, exportRoot } = await fixture(t);
  const ids = ['Run', 'run', 'constructor', '__proto__', 'a'.repeat(128)];
  const results = await Promise.all(ids.map((runId, index) => service.exportText(input({ runId, text: `Transcript ${index}` }))));
  assert.equal(new Set(results.map(value => value.fileName)).size, ids.length);
  for (let i = 0; i < results.length; i++) {
    assert.equal(path.dirname(results[i].path), exportRoot); assert.ok(results[i].fileName.length < 128);
    assert.equal((await fs.readFile(results[i].path, 'utf8')).slice(1), `Transcript ${i}`);
  }
});

check('the public TXT appears only after the entire async temporary write finishes', async t => {
  const { exportRoot } = await fixture(t), started = deferred(), release = deferred();
  const service = createLiveExportService({ exportRoot, fsImpl: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[1] === 'wx') { const write = handle.writeFile.bind(handle); handle.writeFile = async data => {
      await write(data.subarray(0, 3)); started.resolve(); await release.promise; await write(data.subarray(3));
    }; }
    return handle;
  } } });
  const pending = service.exportText(input()); await started.promise;
  const intermediate = await fs.readdir(exportRoot); assert.equal(intermediate.filter(name => name.endsWith('.txt')).length, 0);
  release.resolve(); const result = await pending;
  assert.deepEqual(await fs.readdir(exportRoot), [result.fileName]);
  assert.equal((await fs.readFile(result.path, 'utf8')).slice(1), input().text);
});

check('a failed write cleans temporary data, returns a static error and permits retry', async t => {
  const { exportRoot } = await fixture(t); let fail = true;
  const service = createLiveExportService({ exportRoot, fsImpl: { ...fs, open: async (...args) => {
    const handle = await fs.open(...args);
    if (args[1] === 'wx' && fail) { fail = false; handle.writeFile = async () => { throw new Error('synthetic-secret-provider-path'); }; }
    return handle;
  } } });
  await assert.rejects(service.exportText(input()), failure => {
    assert.equal(failure.code, 'EXPORT_FAILED'); assert.equal(failure.status, 500); assert.ok(!failure.message.includes('synthetic')); return true;
  });
  assert.deepEqual(await fs.readdir(exportRoot), []);
  const result = await service.exportText(input()); assert.equal(result.saved, true);
  assert.deepEqual(await fs.readdir(exportRoot), [result.fileName]);
});

check('corrupt existing export is never overwritten or reported as a valid saved transcript', async t => {
  const { exportRoot, service } = await fixture(t);
  const result = await service.exportText(input()); await fs.writeFile(result.path, 'corrupt fixture');
  await assert.rejects(createLiveExportService({ exportRoot }).exportText(input()), { code: 'EXPORT_FAILED' });
  assert.equal(await fs.readFile(result.path, 'utf8'), 'corrupt fixture');
});

check('invalid input does not create any export directory', async t => {
  const { exportRoot, service } = await fixture(t);
  await assert.rejects(service.exportText(input({ runId: '../../elsewhere' })), { code: 'INVALID_EXPORT' });
  await assert.rejects(fs.stat(exportRoot), { code: 'ENOENT' });
});

async function serverFixture(t) {
  const f = await fixture(t); let unexpected = 0;
  const forbidden = () => { unexpected++; throw new Error('No credentials or cloud calls allowed'); };
  const store = { list: () => [], resolve: forbidden };
  const server = createApp({ store, speech: forbidden, translation: forbidden, correction: forbidden, exportRoot: f.exportRoot });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.stopAnalysis(); await new Promise(resolve => server.close(resolve)); assert.equal(unexpected, 0); });
  const post = (body = input(), options = {}) => fetch(origin + '/api/live-export', { method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...options });
  return { ...f, origin, post };
}

check('HTTP export is local-only, uses the injected directory and deduplicates concurrent requests', async t => {
  const { post, origin, exportRoot } = await serverFixture(t);
  assert.equal((await fetch(origin + '/api/profiles')).status, 200);
  const replies = await Promise.all(Array.from({ length: 8 }, () => post()));
  for (const reply of replies) assert.equal(reply.status, 200);
  const results = await Promise.all(replies.map(reply => reply.json()));
  assert.equal(new Set(results.map(value => value.path)).size, 1);
  assert.equal(path.dirname(results[0].path), exportRoot); assert.equal((await fs.readdir(exportRoot)).length, 1);
});

check('HTTP rejects foreign or absent origin, invalid JSON, traversal and oversized requests', async t => {
  const { post, origin, exportRoot } = await serverFixture(t);
  for (const headers of [{ 'Content-Type': 'application/json' }, { Origin: 'https://foreign.example', 'Content-Type': 'application/json' },
    { Origin: origin.replace('127.0.0.1', 'localhost'), 'Content-Type': 'application/json' }]) {
    assert.equal((await post(input(), { headers })).status, 403);
  }
  assert.equal((await post(input(), { headers: { Origin: origin, 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post(input(), { body: '{"broken' })).status, 400);
  assert.equal((await post(input({ runId: '../outside' }))).status, 400);
  assert.equal((await post(input({ text: 'a'.repeat(LIVE_EXPORT_BODY_BYTES) }))).status, 413);
  await assert.rejects(fs.stat(exportRoot), { code: 'ENOENT' });
});

check('HTTP disk failures have a static error and never expose local diagnostics', async t => {
  const { post, exportRoot } = await serverFixture(t);
  await fs.writeFile(exportRoot, 'a file blocks the directory');
  const result = await post(); assert.equal(result.status, 500);
  const body = await result.json(); assert.match(body.error, /使用页面的下载功能/);
  assert.ok(!body.error.includes(exportRoot)); assert.ok(!JSON.stringify(body).includes('EEXIST'));
});
