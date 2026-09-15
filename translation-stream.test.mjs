import test from 'node:test';
import assert from 'node:assert/strict';
import { translate } from './adapters.mjs';

// Every response is a local mock stream. No credentials or API calls are used.
const key = 'synthetic-translation-stream-secret';
const profile = { protocol: 'openai-chat', model: 'qwen-plus', thinkingOff: 'qwen',
  baseUrl: 'https://mock.example/v1', apiKey: key };
const event = (content, reason = null, extra = {}) => ({ choices: [{ index: 0, delta: { content }, finish_reason: reason }], ...extra });
const sse = value => `data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`;
const bytes = value => typeof value === 'string' ? new TextEncoder().encode(value) : value;
function mockResponse(chunks = [], { close = true, status = 200, contentType = 'text/event-stream' } = {}) {
  let streamController, cancelled = 0;
  const body = new ReadableStream({ start(controller) { streamController = controller; }, cancel() { cancelled++; } });
  for (const chunk of chunks) streamController.enqueue(bytes(chunk));
  if (close) streamController.close();
  return { response: new Response(body, { status, headers: { 'Content-Type': contentType } }),
    push(value) { streamController.enqueue(bytes(value)); }, end() { streamController.close(); },
    error(error) { streamController.error(error); }, get cancelled() { return cancelled; } };
}
function start(mock, { sample = {}, settings = profile } = {}) {
  const calls = [], updates = [];
  const promise = translate(settings, { source: 'The bond yield rises.', onText: text => updates.push(text), ...sample }, {
    fetchImpl: async (url, options) => { calls.push({ url, options, body: JSON.parse(options.body) }); return mock.response; },
  });
  return { promise, calls, updates };
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const errorCode = expected => error => {
  assert.equal(error.code, expected); assert.equal(error.message.includes(key), false); return true;
};

test('SSE delivers cumulative translations before the response ends and returns final usage', async () => {
  const mock = mockResponse([], { close: false }); const f = start(mock);
  mock.push(sse(event('债券'))); await tick();
  assert.deepEqual(f.updates, ['债券']);
  let complete = false; f.promise.then(() => { complete = true; });
  assert.equal(complete, false);
  mock.push(sse(event('收益率上升。')) + sse(event('', 'stop'))
    + sse({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29, raw_secret: key } }) + sse('[DONE]'));
  assert.deepEqual(await f.promise, { target: '债券收益率上升。', usage: { prompt_tokens: 20, completion_tokens: 9, total_tokens: 29 } });
  assert.deepEqual(f.updates, ['债券', '债券收益率上升。']);
  assert.equal(mock.cancelled, 1, 'DONE cancels the still-open response body');
  assert.equal(f.calls[0].options.signal.aborted, true);
  assert.equal(f.calls[0].body.stream, true);
  assert.deepEqual(f.calls[0].body.stream_options, { include_usage: true });
  assert.equal(f.calls[0].options.redirect, 'error');
  assert.equal(f.calls[0].options.headers.Accept, 'text/event-stream');
});

test('UTF-8, emoji, SSE comments and CRLF survive arbitrary one-byte chunk boundaries', async () => {
  const raw = '\uFEFF: keep-alive\r\nid: 1\r\nevent: message\r\n'
    + sse(event('收益率📈')).replaceAll('\n', '\r\n')
    + sse(event('减少 0.5%。', 'stop')).replaceAll('\n', '\r\n') + 'data: [DONE]\r\n\r\n';
  const wire = bytes(raw);
  const mock = mockResponse(Array.from(wire, byte => Uint8Array.of(byte))); const f = start(mock);
  assert.equal((await f.promise).target, '收益率📈减少 0.5%。');
  assert.deepEqual(f.updates, ['收益率📈', '收益率📈减少 0.5%。']);
});

test('multiple data lines form one SSE event and several events may share a network chunk', async () => {
  const raw = 'event: message\ndata: {"choices":[\ndata: {"index":0,"delta":{"content":"第一句。"},"finish_reason":null}]}\n\n'
    + sse(event('第二句。', 'stop')) + sse('[DONE]');
  const f = start(mockResponse([raw]));
  assert.equal((await f.promise).target, '第一句。第二句。');
  assert.deepEqual(f.updates, ['第一句。', '第一句。第二句。']);
});

test('bare CR separators and a terminal record without a final blank line are supported', async () => {
  const raw = sse(event('完整译文。')).replaceAll('\n', '\r') + 'data: [DONE]';
  const f = start(mockResponse([raw])); assert.equal((await f.promise).target, '完整译文。');
});

test('a clean EOF after explicit finish_reason stop completes without a DONE marker', async () => {
  const f = start(mockResponse([sse(event('完整。', 'stop'))]));
  assert.equal((await f.promise).target, '完整。');
});

test('DeepSeek final-choice usage is collected; role/reasoning/null deltas do not become text', async () => {
  const raw = sse({ choices: [{ delta: { role: 'assistant', content: null, reasoning_content: 'do not display' }, finish_reason: null }] })
    + sse(event('结论。', 'stop', { usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })) + sse('[DONE]');
  const f = start(mockResponse([raw]), { settings: { ...profile, thinkingOff: 'deepseek', model: 'deepseek-flash' } });
  assert.deepEqual(await f.promise, { target: '结论。', usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
  assert.deepEqual(f.updates, ['结论。']);
  assert.deepEqual(f.calls[0].body.thinking, { type: 'disabled' });
  assert.equal('enable_thinking' in f.calls[0].body, false);
});

test('stream request preserves Qwen thinking-off and financial prompt rules', async () => {
  const f = start(mockResponse([sse(event('译文。', 'stop')) + sse('[DONE]')]), {
    sample: { glossary: 'yield = 收益率', context: 'Bond pricing', domainRules: ['Preserve duration and convexity.'] },
  });
  await f.promise;
  const body = f.calls[0].body;
  assert.equal(body.enable_thinking, false); assert.equal('thinking' in body, false);
  assert.match(body.messages[0].content, /Preserve duration and convexity/);
  assert.deepEqual(JSON.parse(body.messages[1].content), { source: 'The bond yield rises.', glossary: 'yield = 收益率', context: 'Bond pricing' });
});

test('without an onText function the original non-streaming JSON path stays unchanged', async () => {
  let body;
  const result = await translate(profile, { source: 'English.', onText: null }, { fetchImpl: async (url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: ' 中文。 ' }, finish_reason: 'stop' }], usage: { total_tokens: 3 } }) };
  } });
  assert.deepEqual(result, { target: '中文。', usage: { total_tokens: 3 } });
  assert.equal(body.stream, false); assert.equal('stream_options' in body, false);
});

test('empty source returns immediately without fetch or update callback', async () => {
  let calls = 0;
  const result = await translate(profile, { source: '  ', onText: () => { calls++; } }, {
    fetchImpl: () => { calls++; throw new Error('must not fetch'); },
  });
  assert.deepEqual(result, { target: '' }); assert.equal(calls, 0);
});

test('finish_reason length rejects and cancels instead of returning a truncated final', async () => {
  const mock = mockResponse([sse(event('部分')) + sse(event('截断内容', 'length'))], { close: false });
  const f = start(mock);
  await assert.rejects(f.promise, errorCode('TRUNCATED_RESPONSE'));
  assert.deepEqual(f.updates, ['部分']); assert.equal(mock.cancelled, 1);
});

test('premature EOF and bare DONE cannot pass off an incomplete response as final', async t => {
  for (const raw of [sse(event('只有一半')), sse('[DONE]'), ': keepalive\n\n']) await t.test(raw.slice(0, 30), async () => {
    await assert.rejects(start(mockResponse([raw])).promise, errorCode('TRUNCATED_RESPONSE'));
  });
});

test('model interruption reasons and error events are sanitized', async t => {
  for (const raw of [
    sse(event('hidden', 'content_filter')), sse(event('', 'aborted')), sse(event('', 'insufficient_system_resource')),
    sse(event('', 'tool_calls')), sse({ error: { message: key } }),
    sse({ code: 'AccessDenied', message: key }), `event: error\ndata: ${key}\n\n`,
  ]) await t.test(raw.slice(0, 30), async () => {
    const mock = mockResponse([raw], { close: false });
    await assert.rejects(start(mock).promise, errorCode('PROVIDER_ERROR'));
    assert.equal(mock.cancelled, 1);
  });
});

test('malformed JSON, non-text content and inconsistent chunks fail without leaking bodies', async t => {
  for (const raw of [
    `data: {${key}\n\n`, sse({}), sse({ choices: 'bad' }),
    sse({ choices: [{ index: 0, delta: { content: { secret: key } } }] }),
    sse({ choices: [{ index: 1, delta: { content: key } }] }),
    sse(event('valid', 'stop')) + sse(event('unexpected extra content')),
  ]) await t.test(raw.slice(0, 35), async () => {
    const mock = mockResponse([raw], { close: false });
    await assert.rejects(start(mock).promise, errorCode('INVALID_RESPONSE'));
    assert.equal(mock.cancelled, 1);
  });
});

test('HTTP and non-SSE responses are rejected unread, sanitized and cancelled', async t => {
  for (const [status, contentType, expected] of [[401, 'application/json', 'HTTP_401'], [200, 'application/json', 'INVALID_RESPONSE']]) await t.test(String(status), async () => {
    const mock = mockResponse([JSON.stringify({ error: key })], { close: false, status, contentType });
    await assert.rejects(start(mock).promise, errorCode(expected)); assert.equal(mock.cancelled, 1);
  });
});

test('64 KiB output cap counts UTF-8 bytes before delivering the oversized update', async () => {
  const prefix = '译'.repeat(21000); // 63,000 bytes, below the limit.
  const mock = mockResponse([sse(event(prefix)) + sse(event('译'.repeat(1000)))], { close: false });
  const f = start(mock);
  await assert.rejects(f.promise, errorCode('TRUNCATED_RESPONSE'));
  assert.deepEqual(f.updates, [prefix]); assert.equal(mock.cancelled, 1);
});

test('an unbounded SSE line or payload fails instead of growing memory without limit', async () => {
  const mock = mockResponse(['data: ' + 'x'.repeat(270000)], { close: false });
  await assert.rejects(start(mock).promise, errorCode('INVALID_RESPONSE')); assert.equal(mock.cancelled, 1);
});

test('pre-aborted requests never call fetch', async () => {
  const controller = new AbortController(); controller.abort(); let called = false;
  await assert.rejects(translate(profile, { source: 'English.', signal: controller.signal, onText() {} }, {
    fetchImpl: () => { called = true; },
  }), errorCode('ABORTED'));
  assert.equal(called, false);
});

test('abort interrupts a pending body read, cancels it and prevents later updates', async () => {
  const controller = new AbortController(); const mock = mockResponse([], { close: false });
  const f = start(mock, { sample: { signal: controller.signal } });
  mock.push(sse(event('已收到'))); await tick();
  assert.deepEqual(f.updates, ['已收到']);
  controller.abort(); await assert.rejects(f.promise, errorCode('ABORTED'));
  assert.equal(mock.cancelled, 1); assert.equal(f.calls[0].options.signal.aborted, true);
  assert.deepEqual(f.updates, ['已收到']);
});

test('abort also cancels an injected fetch response that resolves late', async () => {
  const controller = new AbortController(); let resolveFetch;
  const promise = translate(profile, { source: 'English.', signal: controller.signal, onText() {} }, {
    fetchImpl: () => new Promise(resolve => { resolveFetch = resolve; }),
  });
  controller.abort(); await assert.rejects(promise, errorCode('ABORTED'));
  const mock = mockResponse([], { close: false }); resolveFetch(mock.response); await tick();
  assert.equal(mock.cancelled, 1);
});

test('callback errors are sanitized; pending asynchronous callbacks respect abort', async t => {
  await t.test('throwing callback', async () => {
    const mock = mockResponse([sse(event('译文'))], { close: false });
    const f = start(mock, { sample: { onText() { throw new Error(key); } } });
    await assert.rejects(f.promise, errorCode('TRANSLATION_CALLBACK')); assert.equal(mock.cancelled, 1);
  });
  await t.test('abort pending callback', async () => {
    const controller = new AbortController(); const mock = mockResponse([sse(event('译文'))], { close: false });
    let callbackCalled = false;
    const f = start(mock, { sample: { signal: controller.signal, onText() { callbackCalled = true; return new Promise(() => {}); } } });
    await tick(); assert.equal(callbackCalled, true);
    controller.abort(); await assert.rejects(f.promise, errorCode('ABORTED')); assert.equal(mock.cancelled, 1);
  });
});

test('network body errors and malformed UTF-8 are sanitized and close the request', async t => {
  await t.test('network failure', async () => {
    const mock = mockResponse([], { close: false }); const f = start(mock); await tick();
    mock.error(new Error(key));
    await assert.rejects(f.promise, errorCode('PROVIDER_CONNECTION'));
    assert.equal(f.calls[0].options.signal.aborted, true);
  });
  await t.test('invalid UTF-8', async () => {
    const f = start(mockResponse([Uint8Array.of(0xff)]));
    await assert.rejects(f.promise, errorCode('PROVIDER_CONNECTION'));
    assert.equal(f.calls[0].options.signal.aborted, true);
  });
});

test('Qwen MT-lite streams with a single raw user source and dedicated translation options', async () => {
  const source = 'The yield is 5%, not 50%. Keep the words "system" and "user".';
  const mock = mockResponse([sse(event('收益率')) + sse(event('为5%，而非50%。', 'stop')) + sse('[DONE]')]);
  const f = start(mock, { settings: { ...profile, model: 'qwen-mt-lite' }, sample: {
    source, glossary: 'yield = 收益率\nbond = 债券', context: 'A finance lecture about bond pricing.',
    domainRules: ['Do not include this rule in the raw source.'],
  } });
  assert.equal((await f.promise).target, '收益率为5%，而非50%。');
  assert.deepEqual(f.updates, ['收益率', '收益率为5%，而非50%。']);
  const body = f.calls[0].body;
  assert.deepEqual(body.messages, [{ role: 'user', content: source }]);
  assert.deepEqual(body.translation_options, { source_lang: 'English', target_lang: 'Chinese',
    terms: [{ source: 'yield', target: '收益率' }, { source: 'bond', target: '债券' }],
    domains: 'A finance lecture about bond pricing.' });
  assert.equal(body.stream, true);
  for (const field of ['enable_thinking', 'thinking', 'extra_body', 'incremental_output']) assert.equal(field in body, false);
});

test('Qwen MT non-streaming uses the same dedicated payload and keeps the JSON return contract', async () => {
  let body;
  const result = await translate({ ...profile, model: 'qwen-mt-lite', thinkingOff: 'deepseek' }, {
    source: '  Exact raw source.\nNext line. ', glossary: 'basis point = 基点', context: 'Fixed income lecture.',
  }, { fetchImpl: async (url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: '完整译文。' }, finish_reason: 'stop' }], usage: { total_tokens: 10 } }) };
  } });
  assert.deepEqual(result, { target: '完整译文。', usage: { total_tokens: 10 } });
  assert.deepEqual(body.messages, [{ role: 'user', content: '  Exact raw source.\nNext line. ' }]);
  assert.deepEqual(body.translation_options.terms, [{ source: 'basis point', target: '基点' }]);
  assert.equal(body.stream, false); assert.equal('stream_options' in body, false);
  assert.equal('thinking' in body, false); assert.equal('enable_thinking' in body, false);
});

test('MT terms deduplicate user overrides, omit malformed entries and separate finance notes', async () => {
  const f = start(mockResponse([sse(event('译文', 'stop')) + sse('[DONE]')]), {
    settings: { ...profile, model: 'qwen-mt-flash' }, sample: {
      glossary: 'yield = 自定义收益率\nYIELD = 公用词库译法\nduration = 久期 (bond duration, not time to maturity)\nNPV => 净现值（NPV）\nno mapping\n= blank source\nempty = ',
      context: 'Master-level finance lecture.\n中文课程背景\nMixed English 与中文\nBond pricing and convexity.',
    },
  });
  await f.promise;
  assert.deepEqual(f.calls[0].body.translation_options, { source_lang: 'English', target_lang: 'Chinese', terms: [
    { source: 'yield', target: '自定义收益率' }, { source: 'duration', target: '久期' }, { source: 'NPV', target: '净现值（NPV）' },
  ], domains: 'Master-level finance lecture.\nBond pricing and convexity.' });
});

test('MT with no valid glossary or English context omits optional customization fields', async () => {
  const f = start(mockResponse([sse(event('译文', 'stop')) + sse('[DONE]')]), {
    settings: { ...profile, model: 'qwen-mt-lite' }, sample: { glossary: 'plain words without a mapping', context: '固定收益课堂' },
  });
  await f.promise;
  assert.deepEqual(f.calls[0].body.translation_options, { source_lang: 'English', target_lang: 'Chinese' });
});

test('MT-plus and MT-turbo cumulative stream text replaces rather than repeats prior output', async t => {
  for (const model of ['qwen-mt-plus', 'qwen-mt-turbo']) await t.test(model, async () => {
    const f = start(mockResponse([sse(event('债券')) + sse(event('债券价格')) + sse(event('债券价格下跌。'))
      + sse(event('债券价格下跌。', 'stop')) + sse('[DONE]')]), { settings: { ...profile, model } });
    assert.equal((await f.promise).target, '债券价格下跌。');
    assert.deepEqual(f.updates, ['债券', '债券价格', '债券价格下跌。']);
  });
});

test('only exact qwen-mt- model prefix activates machine-translation formatting', async t => {
  for (const model of ['custom-qwen-mt-lite', 'qwen-plus', 'Qwen-MT-lite', 'qwen-mt']) await t.test(model, async () => {
    const f = start(mockResponse([sse(event('译文', 'stop')) + sse('[DONE]')]), { settings: { ...profile, model } });
    await f.promise;
    assert.equal(f.calls[0].body.messages[0].role, 'system');
    assert.equal('translation_options' in f.calls[0].body, false);
    assert.equal(f.calls[0].body.enable_thinking, false);
  });
});
