import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from './server.mjs';
import { validateLiveDraft, readLiveDraft, writeLiveDraft, LIVE_DRAFT_BYTES } from './live-draft.mjs';

// All files use a fresh synthetic temp directory; HTTP calls are loopback only.
function fixture(t) {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'live-draft-test-'));
  const protectedFiles = [], unexpected = [];
  const store = { root: temporaryRoot, protect(file) { protectedFiles.push(file); fs.chmodSync(file, 0o600); },
    list() { unexpected.push('list'); return []; }, resolve() { unexpected.push('resolve'); throw new Error('No API resolution allowed'); } };
  t.after(() => {
    const target = path.resolve(temporaryRoot);
    assert.ok(target.startsWith(path.resolve(os.tmpdir()) + path.sep + 'live-draft-test-'));
    fs.rmSync(target, { recursive: true, force: true });
  });
  return { store, protectedFiles, unexpected, file: path.join(temporaryRoot, 'live-draft.json') };
}
const row = (id = 'row-1', overrides = {}) => ({ id, source: 'The yield is 5%.', target: '收益率为5%。',
  final: true, translationStatus: 'done', seconds: 23.4, ...overrides });
const session = (id = 'session-1', rows = [row()]) => ({ id, createdAt: '2026-09-15T07:20:00.000Z',
  asrLabel: 'Qwen ASR', translationLabel: 'Qwen Flash', historical: false, rows });
const draft = () => ({ version: 1, sessions: [session()], settings: { asrId: 'qwen-asr-streaming',
  translationId: 'qwen-flash-translate', financeCourse: 'fixed-income', maxMinutes: 45, source: 'mic',
  displayLanguage: 'bilingual', autoscroll: true, fontSize: 29, glossary: 'yield = 收益率', context: 'Fixed income lecture.' } });
async function serverFixture(t) {
  const f = fixture(t);
  const forbidden = async () => { f.unexpected.push('cloud'); throw new Error('No cloud calls allowed'); };
  const server = createApp({ store: f.store, speech: forbidden, translation: forbidden });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.stopAnalysis(); await new Promise(resolve => server.close(resolve)); });
  const post = (body, headers = {}) => fetch(`${origin}/api/live-draft`, {
    method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
  return { ...f, server, origin, post };
}

test('valid captions preserve order, timestamps, unfinished rows and literal text only', () => {
  const input = draft();
  input.sessions.push(session('second', [row('partial', { source: '<img src=x onerror=alert(1)>', target: '', final: false, translationStatus: 'pending' })]));
  const result = validateLiveDraft(input);
  assert.deepEqual(result, input);
  assert.notEqual(result.sessions[0].rows[0], input.sessions[0].rows[0]);
});

test('schema rejects extra fields including HTML, keys, nested prototype fields and capture state', () => {
  const changes = [
    value => { value.apiKey = 'synthetic-secret'; }, value => { value.html = '<b>bad</b>'; },
    value => { value.sessions[0].rows[0].innerHTML = '<b>bad</b>'; },
    value => { value.sessions[0].stream = {}; }, value => { value.settings.autoStart = true; },
    value => { value.settings.apiKey = 'synthetic-secret'; },
    value => { Object.defineProperty(value.settings, '__proto__', { value: { polluted: true }, enumerable: true }); },
  ];
  for (const mutate of changes) { const value = draft(); mutate(value); assert.throws(() => validateLiveDraft(value), { code: 'INVALID_DRAFT' }); }
  assert.equal(Object.prototype.polluted, undefined);
});

test('every scalar field uses strict types and valid ranges', () => {
  const changes = [
    value => { value.version = '1'; }, value => { value.sessions[0].id = '../outside'; },
    value => { value.sessions[0].createdAt = 'invalid'; }, value => { value.sessions[0].historical = 'false'; },
    value => { value.sessions[0].rows[0].source = {}; }, value => { value.sessions[0].rows[0].final = 1; },
    value => { value.sessions[0].rows[0].seconds = '1'; }, value => { value.sessions[0].rows[0].seconds = NaN; },
    value => { value.sessions[0].rows[0].seconds = -1; }, value => { value.sessions[0].rows[0].translationStatus = 'working'; },
    value => { value.settings.maxMinutes = '45'; }, value => { value.settings.maxMinutes = 121; },
    value => { value.settings.asrId = 'https://evil.example'; }, value => { value.settings.fontSize = 47; },
    value => { value.settings.fontSize = 20.5; }, value => { value.settings.autoscroll = 1; },
    value => { value.settings.source = 'other'; }, value => { value.settings.financeCourse = 'invalid'; },
    value => { value.settings.displayLanguage = 'html'; }, value => { value.settings.context = 'x'.repeat(3001); },
  ];
  for (const mutate of changes) { const value = draft(); mutate(value); assert.throws(() => validateLiveDraft(value), { code: 'INVALID_DRAFT' }); }
});

test('65536-character caption fields are accepted, 65537 and duplicate IDs are rejected', () => {
  const value = draft(); value.sessions[0].rows[0].source = 'x'.repeat(65536); value.sessions[0].rows[0].target = 'y'.repeat(65536);
  assert.equal(validateLiveDraft(value).sessions[0].rows[0].source.length, 65536);
  value.sessions[0].rows[0].source += 'x'; assert.throws(() => validateLiveDraft(value), { code: 'INVALID_DRAFT' });
  for (const input of [{ version: 1, sessions: [session(), session()] }, { version: 1, sessions: [session('a', [row(), row()])] }]) {
    assert.throws(() => validateLiveDraft(input), { code: 'INVALID_DRAFT' });
  }
});

test('session and total row limits are enforced across the entire draft', () => {
  const sessions = Array.from({ length: 200 }, (_, i) => session(`s-${i}`, []));
  assert.equal(validateLiveDraft({ version: 1, sessions }).sessions.length, 200);
  assert.throws(() => validateLiveDraft({ version: 1, sessions: [...sessions, session('extra', [])] }), { code: 'INVALID_DRAFT' });
  const rows = Array.from({ length: 10000 }, (_, i) => row(`r-${i}`, { source: '', target: '' }));
  assert.equal(validateLiveDraft({ version: 1, sessions: [session('one', rows)] }).sessions[0].rows.length, 10000);
  assert.throws(() => validateLiveDraft({ version: 1, sessions: [session('one', rows), session('two')] }), { code: 'INVALID_DRAFT' });
});

test('the UTF-8 draft byte limit prevents oversized files despite valid individual fields', () => {
  const input = { version: 1, sessions: [session('large', Array.from({ length: 12 }, (_, i) => row(`r-${i}`, { source: '译'.repeat(65536) })))] };
  assert.ok(Buffer.byteLength(JSON.stringify(input)) > LIVE_DRAFT_BYTES);
  assert.throws(() => validateLiveDraft(input), { code: 'INVALID_DRAFT' });
});

test('private atomic writes increment revision and reject stale pages without changing the file', t => {
  const f = fixture(t);
  assert.deepEqual(readLiveDraft(f.store), { revision: 0, draft: null });
  assert.deepEqual(writeLiveDraft(f.store, { expectedRevision: 0, draft: draft() }), { saved: true, revision: 1, sessions: 1, rows: 1 });
  assert.equal(f.protectedFiles.length, 1); assert.match(f.protectedFiles[0], /live-draft\.json\..+\.tmp$/);
  const before = fs.readFileSync(f.file, 'utf8');
  assert.throws(() => writeLiveDraft(f.store, { expectedRevision: 0, draft: { version: 1, sessions: [] } }), { code: 'DRAFT_CONFLICT' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(readLiveDraft(f.store), { revision: 1, draft: draft() });
  assert.deepEqual(f.unexpected, []);
});

test('permission failure leaves the previous private draft and revision intact', t => {
  const f = fixture(t); writeLiveDraft(f.store, { expectedRevision: 0, draft: draft() });
  const before = fs.readFileSync(f.file, 'utf8');
  f.store.protect = () => { throw new Error('synthetic ACL failure'); };
  assert.throws(() => writeLiveDraft(f.store, { expectedRevision: 1, draft: draft() }), { code: 'DRAFT_STORAGE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  assert.deepEqual(fs.readdirSync(f.store.root), ['live-draft.json']);
});

test('invalid or corrupted existing drafts cannot be silently overwritten', t => {
  const f = fixture(t); fs.writeFileSync(f.file, '{not valid JSON');
  assert.throws(() => readLiveDraft(f.store), { code: 'DRAFT_STORAGE' });
  assert.throws(() => writeLiveDraft(f.store, { expectedRevision: 0, draft: draft() }), { code: 'DRAFT_STORAGE' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), '{not valid JSON');
});

test('draft GET/POST round-trip is local, revision-aware and never resolves or invokes an API', async t => {
  const f = await serverFixture(t);
  assert.deepEqual(await (await fetch(`${f.origin}/api/live-draft`)).json(), { revision: 0, draft: null });
  const saved = await f.post({ expectedRevision: 0, draft: draft() });
  assert.equal(saved.status, 200); assert.equal((await saved.json()).revision, 1);
  assert.deepEqual(await (await fetch(`${f.origin}/api/live-draft`)).json(), { revision: 1, draft: draft() });
  const responses = await Promise.all([f.post({ expectedRevision: 1, draft: draft() }), f.post({ expectedRevision: 1, draft: draft() })]);
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(readLiveDraft(f.store).revision, 2); assert.deepEqual(f.unexpected, []);
});

test('draft API rejects foreign origins, missing POST origin and unsafe bodies', async t => {
  const f = await serverFixture(t);
  const payload = { expectedRevision: 0, draft: draft() };
  const noOrigin = await fetch(`${f.origin}/api/live-draft`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal(noOrigin.status, 403);
  assert.equal((await f.post(payload, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await fetch(`${f.origin}/api/live-draft`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await f.post(payload, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.post({ ...payload, apiKey: 'synthetic-secret' })).status, 400);
  assert.equal((await f.post({ ...payload, expectedRevision: '0' })).status, 400);
  assert.deepEqual(readLiveDraft(f.store), { revision: 0, draft: null });
  assert.deepEqual(f.unexpected, []);
});

test('draft API body over 2 MiB fails without overwriting the existing captions', async t => {
  const f = await serverFixture(t); await f.post({ expectedRevision: 0, draft: draft() });
  const before = fs.readFileSync(f.file, 'utf8');
  const response = await f.post({ expectedRevision: 1, draft: { version: 1, sessions: [], extra: 'x'.repeat(LIVE_DRAFT_BYTES) } });
  assert.equal(response.status, 413); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
