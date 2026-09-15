import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { asrVocabulary } from './asr-hints.mjs';
import { transcribe } from './adapters.mjs';
import { createQwenNativeLive, QWEN_NATIVE_REALTIME_MODEL } from './qwen-native-live.mjs';

// All provider calls are mocked. The finance pack is public local course data.
const finance = JSON.parse(readFileSync(new URL('./finance-pack.json', import.meta.url), 'utf8'));
const general = finance.courses.find(course => course.id === 'general').terms;
const financeGlossary = general.map(term => `${term.en} = ${term.zh}${term.note ? ` (${term.note})` : ''}`).join('\n');

test('real finance annotations never become ASR hints', () => {
  const result = asrVocabulary(financeGlossary, 3);
  assert.deepEqual(Object.keys(result), general.map(term => term.en));
  assert.equal(Object.keys(result).some(term => /\p{Script=Han}/u.test(term)), false);
  assert.equal(result['basis point'], 3);
  assert.equal(result['debt-to-equity ratio'], 3);
  assert.equal(result['net debt'], 3);
});

test('every supported definition separator removes its whole translation and annotation', () => {
  const glossary = [
    'basis point = 基点 (缩写bp，复数bps；1基点=0.01个百分点，100基点=1个百分点。)',
    'credit spread => 信用利差 (中文；English fragment, another; still not a hint)',
    'net present value → 净现值，注释；更多说明',
    'interest rate：利率，中文；trailing English',
    'discount rate: 折现率, discarded; fragment',
    'foo, bar = 一个源词字段，右边不能分拆',
    '= invalid blank source, must not be admitted',
  ].join('\r\n');
  assert.deepEqual(asrVocabulary(glossary, 5), {
    'basis point': 5, 'credit spread': 5, 'net present value': 5,
    'interest rate': 5, 'discount rate': 5, 'foo, bar': 5,
  });
});

test('plain word-list lines still support comma/semicolon separators and multi-word phrases', () => {
  const result = asrVocabulary('basis point, credit spread; present value，capital asset pricing model；free cash flow、EBITDA\n  net debt  ', 3);
  assert.deepEqual(Object.keys(result), ['basis point', 'credit spread', 'present value',
    'capital asset pricing model', 'free cash flow', 'EBITDA', 'net debt']);
});

test('first user occurrence wins case-insensitive deduplication before the shared pack', () => {
  const result = asrVocabulary(`BASIS POINT, Yield\nbasis point = 自定义译文；不要变成热词\n${financeGlossary}`, 5);
  assert.deepEqual(Object.keys(result).slice(0, 2), ['BASIS POINT', 'Yield']);
  assert.equal(Object.hasOwn(result, 'basis point'), false);
  assert.equal(Object.hasOwn(result, 'yield'), false);
  assert.equal(Object.keys(result).length, general.length);
});

test('100 unique terms and 100 characters remain the limits; duplicates do not crowd out later terms', () => {
  const long = 'z'.repeat(110);
  const glossary = ['Alpha', ...Array(120).fill('ALPHA'), long, 'z'.repeat(100),
    ...Array.from({ length: 120 }, (_, i) => `term ${i}`)].join('\n');
  const result = asrVocabulary(glossary, 3);
  assert.equal(Object.keys(result).length, 100);
  assert.deepEqual(Object.keys(result).slice(0, 3), ['Alpha', 'z'.repeat(100), 'term 0']);
  assert.equal(Object.keys(result).at(-1), 'term 97');
  assert.equal(Object.keys(result).every(term => term.length <= 100), true);
});

test('prototype-like terms are safe own data properties and survive JSON encoding', () => {
  const result = asrVocabulary('__proto__, constructor, prototype, toString\n__PROTO__ = 重复词', 5);
  assert.equal(Object.getPrototypeOf(result), Object.prototype);
  for (const key of ['__proto__', 'constructor', 'prototype', 'toString']) {
    assert.equal(Object.hasOwn(result, key), true);
    assert.equal(result[key], 5);
    assert.equal(Object.getOwnPropertyDescriptor(result, key).value, 5);
    assert.equal(JSON.parse(JSON.stringify(result))[key], 5);
  }
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(Object.prototype.constructor, Object);
});

test('empty input is empty and existing integer weights remain within 1..5', () => {
  assert.deepEqual(asrVocabulary(undefined, 3), {});
  assert.deepEqual(asrVocabulary(' , ; \n = ignored，annotation', 5), {});
  for (const weight of [1, 2, 3, 4, 5]) assert.deepEqual(asrVocabulary('basis point', weight), { 'basis point': weight });
  for (const weight of [0, 6, 2.5, '3', undefined]) assert.throws(() => asrVocabulary('term', weight), RangeError);
});

test('native HTTP ASR sends only source terms and preserves weight five', async () => {
  let body;
  const result = await transcribe({ protocol: 'qwen-asr-native', model: 'qwen-audio-3.0-asr-flash',
    baseUrl: 'https://mock.example/api/v1', apiKey: 'synthetic-test-key' },
  { wav: Buffer.from('synthetic-wav'), glossary: financeGlossary }, {
    fetchImpl: async (url, options) => {
      body = JSON.parse(options.body);
      return { ok: true, json: async () => ({ output: { text: 'The yield rose.' } }) };
    },
  });
  assert.equal(result.source, 'The yield rose.');
  assert.deepEqual(body.parameters.vocabulary, Object.fromEntries(general.map(term => [term.en, 5])));
});

test('native live ASR sends the same source terms with its original weight three', t => {
  let socket;
  class MockSocket extends EventEmitter {
    constructor() { super(); this.readyState = 0; this.sent = []; socket = this; }
    send(data, options, callback) { this.sent.push(JSON.parse(data)); callback?.(); }
    terminate() { this.readyState = 3; this.emit('close'); }
  }
  const live = createQwenNativeLive({ model: QWEN_NATIVE_REALTIME_MODEL,
    baseUrl: 'https://dashscope.aliyuncs.com/api/v1', apiKey: 'synthetic-test-key' },
  { glossary: financeGlossary, WebSocketImpl: MockSocket });
  t.after(() => live.close());
  socket.readyState = 1; socket.emit('open');
  assert.deepEqual(socket.sent[0].payload.parameters.vocabulary, Object.fromEntries(general.map(term => [term.en, 3])));
});
