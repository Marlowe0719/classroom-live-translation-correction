import test from 'node:test';
import assert from 'node:assert/strict';
import { createAudioPacer } from './live-session.mjs';

// Pure virtual-clock simulations: no audio devices, sockets, keys, or providers.
function lecture(seconds, { absolute, callbackLateMs = 8, sendCostMs = 1 } = {}) {
  let now = 0, wakeAt = null, queue = 0, peakQueue = 0, sentBytes = 0;
  const rate = 32000, frame = 3200;
  const pacer = createAudioPacer({ now: () => now });
  const drain = () => {
    wakeAt = null;
    if (!queue) { pacer.reset(); return; }
    if (absolute && pacer.delayMs() > 0) { wakeAt = now + pacer.delayMs() + callbackLateMs; return; }
    queue -= frame; sentBytes += frame;
    if (absolute) pacer.advance(frame);
    now += sendCostMs;
    wakeAt = now + (absolute ? pacer.delayMs() : 100) + callbackLateMs;
  };
  // The browser captures against its audio clock: one 200 ms packet every
  // 200 ms. Server callbacks are deliberately late on every single frame.
  for (let arrival = 200; arrival <= seconds * 1000; arrival += 200) {
    while (wakeAt !== null && wakeAt < arrival) { now = wakeAt; drain(); }
    now = Math.max(now, arrival); queue += 6400; peakQueue = Math.max(peakQueue, queue);
    if (wakeAt === null) drain();
  }
  return { queueMs: queue / rate * 1000, peakQueueMs: peakQueue / rate * 1000, sentBytes };
}

test('reproduces the observed ~38 second backlog from repeated relative timer delay', () => {
  const old = lecture(38, { absolute: false });
  assert(old.queueMs > 3000, `relative timers must reproduce >3s queue, got ${old.queueMs}ms`);
  const fixed = lecture(38, { absolute: true });
  assert(fixed.queueMs <= 200); assert(fixed.peakQueueMs <= 300);
});

test('absolute audio deadlines keep a 90 second lecture bounded despite every callback being late', () => {
  const result = lecture(90, { absolute: true, callbackLateMs: 12, sendCostMs: 3 });
  assert(result.queueMs <= 200); assert(result.peakQueueMs <= 300);
  assert(result.sentBytes >= (90 - 0.2) * 32000);
});

test('absolute pacing also stays bounded over a full 45 minute lecture', () => {
  const result = lecture(45 * 60, { absolute: true, callbackLateMs: 8, sendCostMs: 1 });
  assert(result.queueMs <= 200); assert(result.peakQueueMs <= 300);
});

test('callback and serialization time are deducted from the next wait, not added to it', () => {
  let now = 0; const pacer = createAudioPacer({ now: () => now });
  pacer.advance(3200); assert.equal(pacer.delayMs(), 100);
  now = 8; assert.equal(pacer.delayMs(), 92);
  now = 109; assert.equal(pacer.delayMs(), 0);
  pacer.advance(3200); assert.equal(pacer.delayMs(), 91);
  now = 209; pacer.advance(3200); assert.equal(pacer.delayMs(), 91);
});

test('a long event-loop pause permits only bounded recovery instead of dumping the whole queue', () => {
  let now = 0; const pacer = createAudioPacer({ now: () => now }); pacer.advance(3200);
  now = 2000;
  let immediate = 0;
  while (pacer.delayMs() === 0 && immediate < 100) { pacer.advance(3200); immediate++; }
  assert.equal(immediate, 3, 'at most 300ms of PCM after a long pause');
  assert.equal(pacer.delayMs(), 100);
});

test('idle reset and a shorter final PCM frame use the correct duration', () => {
  let now = 0; const pacer = createAudioPacer({ now: () => now }); pacer.advance(3200);
  now = 10000; pacer.reset(); assert.equal(pacer.delayMs(), 0);
  pacer.advance(640); assert.equal(pacer.delayMs(), 20);
  now += 20; assert.equal(pacer.delayMs(), 0);
});
