// Explicit, small paid benchmark; excluded from the offline test suite.
import fs from 'node:fs';
import { Store } from './store.mjs';
import { translate } from './adapters.mjs';
import { financeReference } from './server.mjs';

if (!process.argv.includes('--call-api')) {
  console.log('Add --call-api to compare three configured models on two short finance samples.');
  process.exit(1);
}
const store = new Store();
const qwen = store.resolve('qwen-translate');
const providers = {
  plus: qwen,
  flash: { ...qwen, model: 'qwen-flash', label: 'Qwen Flash' },
  mt: { ...qwen, model: 'qwen-mt-lite', label: 'Qwen MT Lite', thinkingOff: '' },
  deepseek: store.resolve('deepseek-translate'),
};
const finance = financeReference('corporate');
const samples = [
  'The debt-to-equity ratio measures financial leverage. Debt plus equity equals total assets. A higher ratio does not necessarily mean a company is insolvent. Keep net debt separate from total debt when calculating net debt to EBITDA.',
  'Suppose the yield rises by twenty-five basis points. A bond with a modified duration of five years would lose approximately one point two five percent in price, ignoring convexity. This is a change of one quarter of a percentage point in yield, not twenty-five percent. A call option gives the holder the right, but not the obligation, to buy the underlying asset.',
];
const result = { checkedAt: new Date().toISOString(), method: 'Same finance glossary and rules; two synthetic text samples; sequential calls; no audio recognition.', records: [] };
const orders = process.argv.includes('--fast-only') ? [['flash', 'mt'], ['mt', 'flash']] : [['plus', 'deepseek', 'flash'], ['flash', 'plus', 'deepseek']];
for (const [round, order] of orders.entries()) {
  for (const key of order) {
    const profile = providers[key];
    const begin = performance.now();
    let firstTextMs = null;
    try {
      const translated = await translate(profile, { source: samples[round], glossary: finance.glossary,
        context: finance.context, domainRules: finance.rules, signal: AbortSignal.timeout(20000),
        ...(process.argv.includes('--stream') ? { onText: text => { if (text && firstTextMs === null) firstTextMs = Math.round(performance.now() - begin); } } : {}) });
      const record = { round: round + 1, key, model: profile.model, elapsedMs: Math.round(performance.now() - begin), firstTextMs, source: samples[round], target: translated.target, usage: translated.usage };
      result.records.push(record); console.log(JSON.stringify(record));
    } catch (error) {
      const record = { round: round + 1, key, model: profile.model, elapsedMs: Math.round(performance.now() - begin), error: error.code || error.name || 'FAILED' };
      result.records.push(record); console.log(JSON.stringify(record));
    }
  }
}
fs.writeFileSync(new URL(`./test-assets/translation-speed${process.argv.includes('--fast-only') ? '-fast' : ''}${process.argv.includes('--stream') ? '-stream' : ''}.json`, import.meta.url), JSON.stringify(result, null, 2));
