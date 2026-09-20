import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the production read-only snapshot with synthetic caption DOM. No
// browser, network, microphone, correction request or real caption data is used.
const script = readFileSync(new URL('./public/context-panel.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = script.indexOf(start), to = script.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `Production function boundaries must exist: ${start}`);
  return script.slice(from, to);
}
const snapshotFunctions = [
  section('  const cleanText', '  function installContextPanel'),
  section('    function correctionSettings()', '    function configureCorrection'),
  section('    function collectViews(', '    const contextExport'),
  section('    function copyText()', '    function refresh('),
].join('\n');

function caption(source, target, { state = '已完成', partial = false, placeholder = false } = {}) {
  const parts = {
    '.caption-state': { textContent: state },
    '.english-text': { textContent: source },
    '.chinese-text': { textContent: target, classList: { contains: name => name === 'placeholder' && placeholder } },
  };
  return {
    classList: { contains: name => name === 'caption-row' || name === 'partial' && partial },
    querySelector: selector => parts[selector] || null,
  };
}
function divider(label) {
  return { classList: { contains: name => name === 'session-divider' }, children: [{ textContent: label }] };
}
function harness(children) {
  const controls = {
    'finance-course': { value: 'general' }, glossary: { value: '' }, context: { value: '' },
  };
  const results = new Map(), calls = { getResult: 0, update: 0, configure: 0, request: 0, timers: 0 };
  const forbidden = name => () => { calls[name]++; throw new Error(`Snapshot must not call ${name}.`); };
  const context = {
    document: { getElementById: id => controls[id] || null },
    list: { children }, disposed: false, isOpen: true,
    language: { value: 'bilingual' }, correctionSwitch: { checked: false },
    correctionModel: { value: 'deepseek-translate' }, appliedCorrectionSettings: null,
    candidateCache: new Map(), ungroupedKey: {},
    // Keep the delayed rendered view deliberately empty: snapshots must use DOM.
    views: [], orderedNodes: [], dirtyRows: new Set(), rowCache: new WeakMap(), structureDirty: false,
    scheduler: {
      getResult(key) { calls.getResult++; return results.get(key) || null; },
      update: forbidden('update'), configure: forbidden('configure'),
    },
    fetch: forbidden('request'), setTimeout: forbidden('timers'),
  };
  runInNewContext(`${snapshotFunctions}\nglobalThis.api = { snapshotContext, copyText, collectViews };`, context);

  function seedCorrections() {
    context.correctionSwitch.checked = true;
    context.appliedCorrectionSettings = {
      profileId: context.correctionModel.value,
      financeCourse: controls['finance-course'].value, glossary: controls.glossary.value, context: controls.context.value,
    };
    const views = context.api.collectViews(true);
    for (const view of views) view.paragraphs.forEach((paragraph, index) => {
      context.candidateCache.set(paragraph.key, {
        source: paragraph.source, target: paragraph.target, complete: paragraph.complete,
        previousSource: view.paragraphs[index - 1]?.source.slice(-8000) || '',
        nextSource: view.paragraphs[index + 1]?.source.slice(0, 8000) || '',
      });
    });
    return views;
  }
  function snapshot(mode = context.language.value) {
    context.language.value = mode;
    const value = context.api.snapshotContext();
    assert.equal(calls.update + calls.configure + calls.request + calls.timers, 0, 'Snapshot must remain synchronous and read-only.');
    return { ...value };
  }
  return { context, controls, results, calls, seedCorrections, snapshot };
}

test('AI off exports grouped context in the selected language and copy uses the same snapshot', () => {
  const rows = Array.from({ length: 8 }, (_, index) => caption(`Sentence ${index + 1}.`, `译文${index + 1}。`));
  const h = harness([divider('第一场'), ...rows, divider('第二场'), caption('Final sentence.', '最后一句。')]);
  const englishA = rows.slice(0, 7).map(row => row.querySelector('.english-text').textContent).join(' ');
  const chineseA = rows.slice(0, 7).map(row => row.querySelector('.chinese-text').textContent).join(' ');
  for (const [mode, first, second, last] of [
    ['bilingual', `${englishA}\n\n${chineseA}`, 'Sentence 8.\n\n译文8。', 'Final sentence.\n\n最后一句。'],
    ['english', englishA, 'Sentence 8.', 'Final sentence.'],
    ['chinese', chineseA, '译文8。', '最后一句。'],
  ]) {
    const result = h.snapshot(mode);
    assert.deepEqual(result, { text: `第一场\n\n${first}\n\n${second}\n\n────────\n\n第二场\n\n${last}`, hasCorrections: false, language: mode });
    assert.equal(h.context.api.copyText(), result.text);
  }
  assert.equal(h.calls.getResult, 0, 'AI off must not consult correction results.');
});

test('partial rows and placeholders are excluded and empty selected-language exports retain language metadata', () => {
  const h = harness([
    divider('未完成场次'), caption('Listening now.', '正在听…', { partial: true }),
    caption('Abandoned partial.', '', { state: '未定稿' }), caption('Recognizing.', '', { state: '识别中' }),
    caption('Final English.', '等待译文…', { state: '翻译中', placeholder: true }),
  ]);
  assert.deepEqual(h.snapshot('bilingual'), { text: '未完成场次\n\nFinal English.', hasCorrections: false, language: 'bilingual' });
  assert.deepEqual(h.snapshot('chinese'), { text: '', hasCorrections: false, language: 'chinese' });
  h.context.list.children = [];
  assert.deepEqual(h.snapshot('english'), { text: '', hasCorrections: false, language: 'english' });
});

test('AI on uses only completed matching corrections and pending or unavailable corrections retain original text', () => {
  const row = caption('The yield rises.', '收益率上升。'), h = harness([divider('债券'), row]);
  h.seedCorrections();
  assert.equal(h.snapshot('chinese').text, '债券\n\n收益率上升。', 'A pending request contributes no correction.');
  h.results.set(row, { corrected: '债券收益率上升。', profileId: 'deepseek-translate', model: 'deepseek-flash' });
  assert.deepEqual(h.snapshot('chinese'), { text: '债券\n\n债券收益率上升。', hasCorrections: true, language: 'chinese' });
  assert.match(h.snapshot('bilingual').text, /The yield rises\.\n\n债券收益率上升。/);
  const reads = h.calls.getResult;
  assert.deepEqual(h.snapshot('english'), { text: '债券\n\nThe yield rises.', hasCorrections: false, language: 'english' });
  assert.equal(h.calls.getResult, reads, 'English-only output does not need a Chinese correction.');
  h.context.correctionSwitch.checked = false;
  assert.equal(h.snapshot('chinese').text, '债券\n\n收益率上升。');
  h.context.correctionSwitch.checked = true;
  for (const result of [{ corrected: '  ', profileId: 'deepseek-translate' }, { corrected: 'Wrong model result.', profileId: 'qwen-plus' }]) {
    h.results.set(row, result);
    assert.deepEqual(h.snapshot('chinese'), { text: '债券\n\n收益率上升。', hasCorrections: false, language: 'chinese' });
  }
  h.context.scheduler = null;
  assert.equal(h.snapshot('chinese').text, '债券\n\n收益率上升。');
});

test('source, translation, adjacent context, model and course settings invalidate stale corrections before observer updates', async t => {
  const changes = {
    source: h => { h.rows[7].querySelector('.english-text').textContent = 'New source.'; },
    translation: h => { h.rows[7].querySelector('.chinese-text').textContent = '新原译文。'; },
    previous: h => { h.rows[0].querySelector('.english-text').textContent = 'Changed previous context.'; },
    next: h => { h.rows[14].querySelector('.english-text').textContent = 'Changed next context.'; },
    model: h => { h.context.correctionModel.value = 'qwen-flash-translate'; },
    course: h => { h.controls['finance-course'].value = 'fx'; },
    glossary: h => { h.controls.glossary.value = 'yield=收益率'; },
    context: h => { h.controls.context.value = 'Fixed income lecture'; },
    incomplete: h => { h.rows[7].querySelector('.caption-state').textContent = '翻译中'; },
  };
  for (const [name, change] of Object.entries(changes)) await t.test(name, () => {
    const rows = Array.from({ length: 15 }, (_, index) => caption(`Source ${index}.`, `原文${index}。`));
    const h = harness([divider('第一场'), ...rows]); h.rows = rows; h.seedCorrections();
    h.results.set(rows[7], { corrected: '已完成校正段落。', profileId: 'deepseek-translate' });
    assert.equal(h.snapshot().hasCorrections, true);
    change(h);
    const result = h.snapshot();
    assert.equal(result.hasCorrections, false);
    assert.ok(!result.text.includes('已完成校正段落。'));
    assert.ok(result.text.includes('原文8。'), 'Stale corrections fall back to the original paragraph instead of dropping it.');
  });
});

test('collapsed sidebar exports fresh final tail immediately and keeps valid earlier corrections without scheduling work', () => {
  const rows = Array.from({ length: 8 }, (_, index) => caption(`Source ${index}.`, `原文${index}。`));
  const h = harness([divider('第一场'), ...rows]); h.seedCorrections();
  h.results.set(rows[7], { corrected: '当前尾段校正。', profileId: 'deepseek-translate' });
  h.context.isOpen = false;
  assert.equal(h.snapshot().hasCorrections, true, 'Closing the sidebar must not discard an otherwise valid result.');
  h.context.list.children.push(caption('A newly finalized tail.', '刚完成的尾句。'));
  const result = h.snapshot();
  assert.equal(result.hasCorrections, false, 'An expanded tail no longer matches the previous correction.');
  assert.match(result.text, /Source 7\. A newly finalized tail\.\n\n原文7。 刚完成的尾句。/);
  assert.equal(h.context.api.copyText(), result.text);
  assert.equal(h.context.views.length, 0, 'Snapshot must not mutate or depend on the delayed rendered views.');
});
