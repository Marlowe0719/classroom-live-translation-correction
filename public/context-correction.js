(() => {
  'use strict';

  const asText = value => typeof value === 'string' ? value : '';
  const enqueue = typeof queueMicrotask === 'function' ? queueMicrotask : callback => Promise.resolve().then(callback);

  function create({ request, onChange = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    if (typeof request !== 'function') throw new TypeError('A correction request function is required.');
    let enabled = false, visible = false, profileId = '', destroyed = false;
    let settings = { financeCourse: '', glossary: '', context: '' };
    let configSignature = JSON.stringify([profileId, settings]);
    let latest = [], records = new Map(), timer = null, job = null, lastStarted = null, notificationPending = false;
    const candidateCache = new WeakMap(), results = new Map(), failures = new Map();

    function notify() {
      if (destroyed || notificationPending) return;
      notificationPending = true;
      enqueue(() => { notificationPending = false; if (!destroyed) onChange(); });
    }

    function cancelTimer() { if (timer !== null) { clearTimer(timer); timer = null; } }
    function abortJob() {
      if (!job || job.invalidated) return;
      job.invalidated = true;
      job.controller.abort();
      // The request still owns the concurrency slot until its promise settles.
    }

    function readCandidate(candidate) {
      const values = [asText(candidate.source), asText(candidate.target),
        asText(candidate.previous?.source), asText(candidate.previous?.target),
        asText(candidate.next?.source), asText(candidate.next?.target)];
      const cached = candidateCache.get(candidate);
      if (cached?.configSignature === configSignature && values.every((value, index) => value === cached.values[index])) return cached;
      const [source, target, previousSource, previousTarget, nextSource, nextTarget] = values;
      const payload = { profileId, source, target, ...settings };
      if (previousSource || previousTarget) payload.previous = { source: previousSource, target: previousTarget };
      if (nextSource || nextTarget) payload.next = { source: nextSource, target: nextTarget };
      const error = source.length > 10000 || target.length > 10000 ? '本段英文或译文超过 10000 字符，暂不校正。'
        : previousSource.length + previousTarget.length > 8000 || nextSource.length + nextTarget.length > 8000
          ? '相邻段落上下文超过 8000 字符，暂不校正。' : '';
      const value = { configSignature, values, payload, signature: JSON.stringify(payload), error, hasText: Boolean(source.trim() && target.trim()) };
      candidateCache.set(candidate, value);
      return value;
    }

    function processCandidates() {
      const updated = new Map();
      let changed = false;
      for (let index = 0; index < latest.length; index++) {
        const candidate = latest[index];
        if (!candidate || typeof candidate !== 'object' || candidate.key == null) continue;
        const parsed = readCandidate(candidate);
        const complete = Boolean(candidate.complete && parsed.hasText);
        const previous = records.get(candidate.key);
        let record;
        if (previous?.signature === parsed.signature) {
          record = previous;
          if (record.complete !== complete) changed = true;
        } else {
          record = { key: candidate.key, ...parsed, changedAt: now(), result: results.get(parsed.signature) || null, failure: failures.get(parsed.signature) || '' };
          changed = true;
        }
        record.complete = complete;
        record.expandable = Boolean(candidate.expandable);
        record.priority = Number.isFinite(candidate.priority) ? candidate.priority : 0;
        record.index = index;
        updated.set(candidate.key, record);
      }
      if (updated.size !== records.size) changed = true;
      records = updated;
      if (job) {
        const current = records.get(job.key);
        if (!current || current.signature !== job.signature || !current.complete) abortJob();
      }
      if (changed) notify();
    }

    function remember(signature, result) {
      results.delete(signature); results.set(signature, result);
      while (results.size > 256) results.delete(results.keys().next().value);
      for (const record of records.values()) if (record.signature === signature) record.result = result;
    }

    function validJob(currentJob) {
      const record = records.get(currentJob.key);
      return !destroyed && enabled && visible && job === currentJob && !currentJob.invalidated
        && record?.signature === currentJob.signature && record.complete;
    }

    function launch(record) {
      const currentJob = { key: record.key, signature: record.signature, controller: new AbortController(), invalidated: false };
      job = currentJob; lastStarted = now(); notify();
      let pending;
      try { pending = Promise.resolve(request(record.payload, currentJob.controller.signal)); }
      catch (error) { pending = Promise.reject(error); }
      pending.then(result => {
        if (!validJob(currentJob)) return;
        if (!result || typeof result.corrected !== 'string' || !result.corrected.trim()) throw new Error('校正服务没有返回有效文本。');
        remember(currentJob.signature, { corrected: result.corrected, profileId: result.profileId, model: result.model, cached: result.cached });
        notify();
      }).catch(error => {
        if (!validJob(currentJob)) return;
        const message = asText(error?.message) || '本段校正失败；修改文本或模型后可重新校正。';
        failures.delete(currentJob.signature); failures.set(currentJob.signature, message);
        while (failures.size > 256) failures.delete(failures.keys().next().value);
        // Current candidates retain their failure after history-cache eviction.
        for (const record of records.values()) if (record.signature === currentJob.signature) record.failure = message;
        notify();
      }).finally(() => {
        if (job === currentJob) job = null;
        if (!destroyed) { notify(); pump(); }
      });
    }

    function pump() {
      cancelTimer();
      if (destroyed || !enabled || !visible || !profileId || job) return;
      const time = now();
      let chosen = null, nextDue = Infinity;
      for (const record of records.values()) {
        if (!record.complete || record.error || record.result || record.failure || failures.has(record.signature)) continue;
        const due = Math.max(record.changedAt + (record.expandable ? 8000 : 4000), lastStarted === null ? -Infinity : lastStarted + 15000);
        if (due > time) { nextDue = Math.min(nextDue, due); continue; }
        const priority = Math.max(0, record.priority), chosenPriority = Math.max(0, chosen?.priority || 0);
        if (!chosen || priority > chosenPriority || priority === chosenPriority && record.index > chosen.index) chosen = record;
      }
      if (chosen) launch(chosen);
      else if (Number.isFinite(nextDue)) timer = setTimer(() => { timer = null; pump(); }, Math.max(0, nextDue - time));
    }

    function configure(options = {}) {
      if (destroyed) return;
      const oldEnabled = enabled, oldVisible = visible, oldSignature = configSignature;
      if ('enabled' in options) enabled = Boolean(options.enabled);
      if ('visible' in options) visible = Boolean(options.visible);
      if ('profileId' in options) profileId = asText(options.profileId);
      if (options.settings) settings = { ...settings, ...Object.fromEntries(['financeCourse', 'glossary', 'context']
        .filter(key => key in options.settings).map(key => [key, asText(options.settings[key])])) };
      configSignature = JSON.stringify([profileId, settings]);
      const configChanged = configSignature !== oldSignature;
      if (!enabled || !visible || configChanged) abortJob();
      if (!enabled) cancelTimer();
      else {
        if (!oldEnabled || configChanged) processCandidates();
        pump();
      }
      if (oldEnabled !== enabled || oldVisible !== visible || configChanged) notify();
    }

    function update(candidates) {
      if (destroyed) return;
      latest = Array.isArray(candidates) ? candidates : [];
      // Disabled mode keeps the latest reference without traversing any candidates.
      if (!enabled) return;
      processCandidates(); pump();
    }

    function getResult(key) {
      const record = records.get(key);
      if (destroyed || !enabled || !record?.complete || record.error) return null;
      const result = record.result || results.get(record.signature) || null;
      if (result && results.has(record.signature)) { results.delete(record.signature); results.set(record.signature, result); }
      return result;
    }

    function getState(key) {
      const record = records.get(key);
      if (destroyed || !enabled || !record?.complete) return { status: 'idle' };
      if (record.error) return { status: 'error', message: record.error };
      if (record.result || results.has(record.signature)) return { status: 'done' };
      if (record.failure || failures.has(record.signature)) return { status: 'error', message: record.failure || failures.get(record.signature) };
      if (job && !job.invalidated && job.signature === record.signature) return { status: 'running' };
      return profileId ? { status: 'waiting' } : { status: 'waiting', message: '请选择校正模型。' };
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true; cancelTimer(); abortJob();
      latest = []; records.clear(); results.clear(); failures.clear();
    }

    return { configure, update, getResult, getState, destroy };
  }

  window.ClassroomContextCorrection = { create };
  window.dispatchEvent(new Event('classroom-context-correction-ready'));
})();
