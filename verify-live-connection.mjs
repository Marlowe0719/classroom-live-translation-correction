// Manual integration check. Never runs as part of the offline test suite.
import fs from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { parseWav } from './audio.mjs';

if (!process.argv.includes('--call-api')) {
  console.log('This check uses paid APIs. Run explicitly with --call-api after configuring the accounts.');
  process.exit(1);
}
const sample = parseWav(fs.readFileSync(new URL('./test-assets/finance-streaming.wav', import.meta.url)));
if (sample.duration > 25) throw new Error('The integration sample must stay below 25 seconds.');
const asrId = process.argv.find(x => x.startsWith('--asr='))?.slice(6) || 'qwen-realtime';
const translationId = process.argv.find(x => x.startsWith('--translation='))?.slice(14) || 'deepseek-translate';
const port = Number(process.argv.find(x => x.startsWith('--port='))?.slice(7) || '8766');
if (![8766, 8770].includes(port)) throw new Error('Unsupported local check port.');
const started = performance.now();
const report = { source: 'Local synthetic financial English with pauses', asrId, translationId,
  sampleSeconds: sample.duration, firstPartialMs: null, firstChineseMs: null, finals: [], translations: [], status: 'pending' };
const ws = new WebSocket(`ws://127.0.0.1:${port}/api/live`, { origin: `http://127.0.0.1:${port}` });
const elapsed = () => Math.round(performance.now() - started);
let sendTask;
try {
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.terminate(); reject(new Error('Live check timed out.')); }, 45000);
    const finish = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    ws.on('error', () => finish(new Error('Local live connection failed.')));
    ws.on('open', () => ws.send(JSON.stringify({ type: 'start', asrId, translationId,
      financeCourse: 'fixed-income', glossary: '', context: 'Local synthetic connection test.', maxMinutes: 10 })));
    ws.on('message', bytes => {
      let event; try { event = JSON.parse(bytes.toString()); } catch { return finish(new Error('Non-JSON live response.')); }
      if (event.type === 'ready' && !sendTask) {
        report.mode = event.mode;
        report.readyMs = elapsed();
        sendTask = (async () => {
          for (let offset = 0; offset < sample.pcm.length; offset += 6400) {
            if (ws.readyState !== WebSocket.OPEN) return;
            const chunk = sample.pcm.subarray(offset, offset + 6400);
            ws.send(chunk);
            await delay(chunk.length / 32);
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'stop' }));
        })().catch(finish);
      } else if (event.type === 'partial' && event.source && report.firstPartialMs === null) {
        report.firstPartialMs = elapsed();
      } else if (event.type === 'final') {
        report.finals.push({ id: event.id, source: event.source, atMs: elapsed() });
      } else if (event.type === 'translation') {
        if (event.target && report.firstChineseMs === null) report.firstChineseMs = elapsed();
        if (event.done !== false) report.translations.push({ id: event.id, target: event.target, atMs: elapsed() });
      } else if (event.type === 'error') {
        finish(new Error(String(event.message || 'Live provider rejected the request.').replace(/sk-[^\s]+/g, '[redacted]')));
      } else if (event.type === 'stopped') {
        report.stoppedMs = elapsed();
        report.status = 'ok';
        finish();
      }
    });
    ws.on('close', () => { if (report.status !== 'ok') finish(new Error('Live connection closed before stopped.')); });
  });
  await sendTask;
  if (!report.finals.length || (translationId !== 'none' && translationId !== 'builtin' && !report.translations.length)) {
    throw new Error('No completed transcript or translation was received.');
  }
  const output = process.argv.find(x => x.startsWith('--output='))?.slice(9) || 'live-connection-check.json';
  if (!/^[a-z0-9-]+\.json$/.test(output)) throw new Error('Invalid output filename.');
  fs.writeFileSync(new URL(`./test-assets/${output}`, import.meta.url), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (ws.readyState === WebSocket.OPEN) ws.close();
  else if (ws.readyState < WebSocket.CLOSING) ws.terminate();
}
