(() => {
  'use strict';

  const cleanText = value => String(value || '').replace(/\s+/g, ' ').trim();

  function readCaption(row) {
    const state = cleanText(row.querySelector('.caption-state')?.textContent);
    if (row.classList.contains('partial') || !state || ['未定稿', '识别中'].includes(state)) return null;
    const source = cleanText(row.querySelector('.english-text')?.textContent);
    const chinese = row.querySelector('.chinese-text');
    const target = chinese && !chinese.classList.contains('placeholder') ? cleanText(chinese.textContent) : '';
    return source || target ? { key: row, source, target, complete: state === '已完成' && Boolean(source && target) } : null;
  }

  function makeParagraphs(rows) {
    const paragraphs = [];
    let current = [], words = 0;
    const finish = () => {
      if (!current.length) return;
      paragraphs.push({ key: current[0].key, source: current.map(row => row.source).filter(Boolean).join(' '),
        target: current.map(row => row.target).filter(Boolean).join(' '), complete: current.every(row => row.complete),
        expandable: current.length < 7 && words < 120 });
      current = []; words = 0;
    };
    for (const row of rows) {
      current.push(row);
      words += row.source ? row.source.split(/\s+/).length : 0;
      if (current.length >= 7 || words >= 120) finish();
    }
    finish();
    return paragraphs;
  }

  function installContextPanel() {
    const panel = document.getElementById('caption-panel');
    const transcript = document.getElementById('transcript');
    const list = document.getElementById('caption-list');
    const tools = panel?.querySelector('.caption-tools');
    if (!panel || !transcript || !list || !tools || document.getElementById('classroom-context')) return;

    const create = (tag, className, text) => {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const body = create('div', 'caption-body');
    transcript.parentNode.insertBefore(body, transcript);
    body.append(transcript); // Preserve the original subtitle node, listeners and scroll reference.
    panel.classList.add('has-context-panel');

    const aside = create('aside', 'context-panel');
    aside.id = 'classroom-context'; aside.setAttribute('aria-labelledby', 'context-title');
    const header = create('header', 'context-header');
    const heading = create('div', 'context-heading');
    const title = create('h2', '', '上下文'); title.id = 'context-title';
    const count = create('span', 'context-count', '0 句已定稿');
    heading.append(title, count);
    const close = create('button', 'icon-button context-close', '×');
    close.type = 'button'; close.title = '关闭上下文'; close.setAttribute('aria-label', '关闭上下文侧栏');
    header.append(heading, close);

    const controls = create('div', 'context-controls');
    const language = create('select', 'context-language');
    language.setAttribute('aria-label', '上下文显示语言');
    for (const [value, label] of [['bilingual', '英中双语'], ['chinese', '仅中文'], ['english', '仅英文']]) {
      const option = create('option', '', label); option.value = value; language.append(option);
    }
    language.value = document.getElementById('display-language')?.value === 'chinese' ? 'chinese' : 'bilingual';
    const copy = create('button', 'button secondary small', '复制文本'); copy.type = 'button'; copy.disabled = true;
    controls.append(language, copy);
    const description = create('p', 'context-description', '按场次整理已定稿英文，中文随译文更新。');
    const correctionControls = create('div', 'context-correction-controls');
    const correctionLabel = create('label', 'context-correction-switch');
    const correctionSwitch = create('input'); correctionSwitch.type = 'checkbox'; correctionSwitch.id = 'context-correction-switch';
    correctionSwitch.setAttribute('role', 'switch'); correctionSwitch.disabled = true;
    correctionLabel.append(correctionSwitch, create('span', '', 'AI 上下文校正'));
    const correctionModel = create('select', 'context-correction-model'); correctionModel.id = 'context-correction-model';
    correctionModel.setAttribute('aria-label', '上下文校正模型'); correctionModel.disabled = true;
    const modelLoading = create('option', '', '正在读取可用模型…'); modelLoading.value = ''; correctionModel.append(modelLoading);
    const correctionCost = create('p', 'context-correction-cost', '开启后额外调用所选 API，原字幕继续实时更新。');
    const correctionStatus = create('p', 'context-correction-status', '默认关闭，仅显示原译文。');
    correctionStatus.setAttribute('role', 'status');
    correctionControls.append(correctionLabel, correctionModel, correctionCost, correctionStatus);
    const scroller = create('div', 'context-scroll');
    scroller.tabIndex = 0; scroller.setAttribute('aria-label', '整合后的课堂上下文');
    const empty = create('p', 'context-empty', '等待已定稿的字幕。临时识别内容不会进入上下文。');
    const content = create('div', 'context-content');
    scroller.append(empty, content);
    const feedback = create('p', 'context-feedback'); feedback.setAttribute('role', 'status');
    aside.append(header, controls, description, correctionControls, scroller, feedback);
    body.append(aside);
    aside.setAttribute('data-language', language.value);

    const toggle = create('button', 'button secondary small context-toggle', '上下文');
    toggle.id = 'context-toggle'; toggle.type = 'button'; toggle.setAttribute('aria-controls', aside.id);
    tools.append(toggle);

    const narrow = window.matchMedia('(max-width: 900px)');
    let isOpen = false, userToggled = false, timer = null, structureDirty = true, disposed = false;
    let orderedNodes = [], views = [], transcriptTop = transcript.scrollTop;
    const dirtyRows = new Set(), sessionElements = new Map();
    let rowCache = new WeakMap(), classroomGeneration = 0;
    const ungroupedKey = {};
    let scheduler = null, correctionProfilesReady = false, candidateVisibilityDirty = true;
    let sentCandidates = [];
    let appliedCorrectionSettings = null;
    const candidateCache = new Map();

    function correctionSettings() {
      return { financeCourse: document.getElementById('finance-course')?.value || 'general',
        glossary: document.getElementById('glossary')?.value || '', context: document.getElementById('context')?.value || '' };
    }

    function configureCorrection(paused = false) {
      const settings = correctionSettings();
      scheduler?.configure({ enabled: correctionSwitch.checked, visible: isOpen && !paused,
        profileId: correctionModel.value, settings });
      if (scheduler) appliedCorrectionSettings = { profileId: correctionModel.value, ...settings };
    }

    function installCorrectionScheduler() {
      if (scheduler || !window.ClassroomContextCorrection?.create || disposed) return;
      const generation = classroomGeneration;
      scheduler = window.ClassroomContextCorrection.create({
        async request(payload, signal) {
          const body = JSON.stringify(payload);
          if (new TextEncoder().encode(body).byteLength > 48 * 1024) throw new Error('段落及背景过长，请缩短补充背景后再校正。');
          const response = await fetch('/api/context-correction', { method: 'POST', signal,
            headers: { 'Content-Type': 'application/json' }, body });
          const data = await response.json().catch(() => ({}));
          if (!response.ok || typeof data.corrected !== 'string' || !data.corrected.trim()) {
            throw new Error(typeof data.error === 'string' ? data.error : '校正暂未完成，已保留原译文。');
          }
          return data;
        },
        onChange() { if (generation === classroomGeneration) schedule(); },
      });
      correctionSwitch.disabled = !correctionProfilesReady;
      configureCorrection(true); refresh(); configureCorrection(); schedule();
    }

    async function loadCorrectionProfiles() {
      try {
        const response = await fetch('/api/context-correction/profiles');
        const data = await response.json();
        if (!response.ok || !Array.isArray(data.profiles)) throw new Error();
        if (disposed) return;
        const profiles = data.profiles.filter(profile => profile.configured);
        const old = correctionModel.value;
        const preferred = profiles.find(profile => profile.id === old)?.id
          || profiles.find(profile => profile.id === data.defaultProfileId)?.id
          || profiles.find(profile => profile.id === 'deepseek-translate')?.id || profiles[0]?.id || '';
        correctionModel.replaceChildren();
        for (const profile of profiles) {
          const option = create('option', '', profile.label || profile.model || profile.id); option.value = profile.id;
          option.selected = profile.id === preferred; correctionModel.append(option);
        }
        if (!profiles.length) { const option = create('option', '', '暂无已配置的校正模型'); option.value = ''; correctionModel.append(option); }
        correctionProfilesReady = profiles.length > 0;
        correctionModel.disabled = !correctionProfilesReady; correctionSwitch.disabled = !correctionProfilesReady || !scheduler;
        if (!correctionProfilesReady) correctionSwitch.checked = false;
        configureCorrection(true); refresh(); configureCorrection(); updateCorrectionStatus(); schedule();
      } catch {
        if (disposed) return;
        correctionProfilesReady = false; correctionSwitch.checked = false; correctionSwitch.disabled = true; correctionModel.disabled = true;
        configureCorrection(); correctionStatus.textContent = '校正模型暂不可用，可通过课堂设置的“刷新 API 配置”重试。'; schedule();
      }
    }

    function updateCandidates() {
      // Keep the disabled feature out of the live rendering path entirely.
      if (!correctionSwitch.checked || !scheduler || !isOpen) return;
      const candidates = [], retained = new Set();
      let changed = false;
      const viewport = candidateVisibilityDirty ? scroller.getBoundingClientRect() : null;
      for (const view of views) {
        view.paragraphs.forEach((paragraph, index) => {
          retained.add(paragraph.key);
          const previousSource = view.paragraphs[index - 1]?.source.slice(-8000) || '';
          const nextSource = view.paragraphs[index + 1]?.source.slice(0, 8000) || '';
          const expandable = view === views.at(-1) && index === view.paragraphs.length - 1 && paragraph.expandable;
          const cached = candidateCache.get(paragraph.key);
          let priority = cached?.priority || 0;
          if (viewport) {
            const node = sessionElements.get(view.key)?.blocks.get(paragraph.key)?.node;
            const rect = node?.getBoundingClientRect();
            priority = rect && rect.bottom > viewport.top && rect.top < viewport.bottom ? 1 : 0;
          }
          if (!cached || cached.source !== paragraph.source || cached.target !== paragraph.target
            || cached.previousSource !== previousSource || cached.nextSource !== nextSource
            || cached.complete !== paragraph.complete || cached.expandable !== expandable || cached.priority !== priority) {
            const candidate = { key: paragraph.key, source: paragraph.source, target: paragraph.target,
              ...(previousSource ? { previous: { source: previousSource } } : {}), ...(nextSource ? { next: { source: nextSource } } : {}),
              complete: paragraph.complete, expandable, priority };
            candidateCache.set(paragraph.key, { ...candidate, previousSource, nextSource, candidate }); changed = true;
          }
          candidates.push(candidateCache.get(paragraph.key).candidate);
        });
      }
      for (const key of candidateCache.keys()) if (!retained.has(key)) { candidateCache.delete(key); changed = true; }
      if (candidates.length !== sentCandidates.length || candidates.some((candidate, index) => candidate !== sentCandidates[index])) changed = true;
      candidateVisibilityDirty = false;
      if (changed) { sentCandidates = candidates; scheduler.update(candidates); }
    }

    function correctedParagraph(paragraph) {
      return correctionSwitch.checked ? scheduler?.getResult(paragraph.key) || null : null;
    }

    function updateCorrectionStatus() {
      if (!correctionProfilesReady) { correctionStatus.textContent = '配置支持文字翻译的 API 后，可启用校正。'; return; }
      if (!scheduler) { correctionStatus.textContent = '正在加载校正组件…'; return; }
      if (!correctionSwitch.checked) { correctionStatus.textContent = '已关闭，显示原译文；已有校正结果保留在本页。'; return; }
      if (!isOpen) { correctionStatus.textContent = '侧栏已收起，后台校正已暂停。'; return; }
      let completed = 0, running = false, errors = 0;
      for (const view of views) for (const paragraph of view.paragraphs) {
        const state = scheduler.getState(paragraph.key);
        if (correctedParagraph(paragraph)) completed++;
        if (state?.status === 'running') running = true;
        if (state?.status === 'error') errors++;
      }
      correctionStatus.textContent = `${running ? '正在后台校正' : '已开启，等待稳定的完整译文'} · 已校正 ${completed} 段。每次一段，至少间隔 15 秒。${errors ? ` ${errors} 段未校正，仍显示原译文。` : ''}`;
    }

    function reconcile(parent, desired) {
      desired.forEach((node, index) => {
        if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
      });
      while (parent.children.length > desired.length) parent.lastElementChild.remove();
    }

    function collectViews(fresh = false) {
      if (!fresh) {
        if (structureDirty) { orderedNodes = Array.from(list.children); structureDirty = false; }
        for (const row of dirtyRows) rowCache.set(row, readCaption(row));
        dirtyRows.clear();
      }
      const sessions = [];
      let session = { key: ungroupedKey, heading: '课堂字幕', rows: [] };
      const finish = () => { if (session.rows.length) sessions.push({ ...session, paragraphs: makeParagraphs(session.rows) }); };
      for (const node of fresh ? Array.from(list.children) : orderedNodes) {
        if (node.classList.contains('session-divider')) {
          finish();
          const label = Array.from(node.children).map(child => cleanText(child.textContent)).filter(Boolean).join(' · ');
          session = { key: node, heading: label || cleanText(node.textContent) || '课堂字幕', rows: [] };
        } else if (node.classList.contains('caption-row')) {
          if (!fresh && !rowCache.has(node)) rowCache.set(node, readCaption(node));
          const row = fresh ? readCaption(node) : rowCache.get(node);
          if (row) session.rows.push(row);
        }
      }
      finish();
      return sessions;
    }

    function snapshotContext() {
      const mode = ['bilingual', 'chinese', 'english'].includes(language.value) ? language.value : 'bilingual';
      const none = { text: '', hasCorrections: false, language: mode };
      if (disposed) return none;
      const settings = correctionSwitch.checked && scheduler && appliedCorrectionSettings && mode !== 'english'
        ? { profileId: correctionModel.value, ...correctionSettings() } : null;
      const canUseCorrections = settings && Object.keys(settings).every(key => settings[key] === appliedCorrectionSettings[key]);
      let hasCorrections = false;
      // Read the latest DOM even before its observer callback; do not update the
      // scheduler, consume mutations, render, scroll or start any correction work.
      const text = collectViews(true).map(view => {
        const paragraphs = view.paragraphs.map((paragraph, index) => {
          const cached = canUseCorrections ? candidateCache.get(paragraph.key) : null;
          const matches = canUseCorrections && paragraph.complete && cached?.complete && cached.source === paragraph.source
            && cached.target === paragraph.target
            && cached.previousSource === (view.paragraphs[index - 1]?.source.slice(-8000) || '')
            && cached.nextSource === (view.paragraphs[index + 1]?.source.slice(0, 8000) || '');
          const result = matches ? scheduler.getResult(paragraph.key) : null;
          const corrected = result && result.profileId === settings.profileId && typeof result.corrected === 'string'
            && result.corrected.trim() ? result.corrected : '';
          if (corrected) hasCorrections = true;
          return [mode !== 'chinese' ? paragraph.source : '', mode !== 'english' ? corrected || paragraph.target : '']
            .filter(Boolean).join('\n\n');
        }).filter(Boolean);
        return paragraphs.length ? [view.heading, ...paragraphs].join('\n\n') : '';
      }).filter(Boolean).join('\n\n────────\n\n');
      return { text, hasCorrections, language: mode };
    }
    const contextExport = { snapshot: snapshotContext };
    window.ClassroomContextExport = contextExport;

    function copyText() {
      return snapshotContext().text;
    }

    function refresh(forceBottom = false) {
      if (!isOpen || disposed) return;
      const top = scroller.scrollTop;
      const follow = forceBottom || scroller.scrollHeight - scroller.clientHeight - top < 40;
      views = collectViews();
      updateCandidates();
      const currentKeys = new Set(), sections = [];
      for (const view of views) {
        currentKeys.add(view.key);
        let section = sessionElements.get(view.key);
        if (!section) {
          const node = create('section', 'context-session');
          const heading = create('h3', 'context-session-title');
          const paragraphs = create('div', 'context-paragraphs'); node.append(heading, paragraphs);
          section = { node, heading, paragraphs, blocks: new Map() }; sessionElements.set(view.key, section);
        }
        if (section.heading.textContent !== view.heading) section.heading.textContent = view.heading;
        const paragraphKeys = new Set(), blocks = [];
        for (const paragraph of view.paragraphs) {
          paragraphKeys.add(paragraph.key);
          let block = section.blocks.get(paragraph.key);
          if (!block) {
            const node = create('div', 'context-paragraph');
            const english = create('p', 'context-english'); english.lang = 'en';
            const chinese = create('p', 'context-chinese'); chinese.lang = 'zh-CN';
            const correctionMeta = create('div', 'context-correction-meta');
            const correctionBadge = create('span', 'context-corrected-badge', 'AI 已校正');
            const original = create('details', 'context-original');
            const originalSummary = create('summary', '', '原译文');
            const originalText = create('p'); originalText.lang = 'zh-CN'; original.append(originalSummary, originalText);
            correctionMeta.append(correctionBadge, original);
            node.append(english, chinese, correctionMeta);
            block = { node, english, chinese, correctionMeta, originalText }; section.blocks.set(paragraph.key, block);
          }
          const corrected = correctedParagraph(paragraph);
          const displayedTarget = corrected?.corrected || paragraph.target;
          if (block.english.textContent !== paragraph.source) block.english.textContent = paragraph.source;
          if (block.chinese.textContent !== displayedTarget) block.chinese.textContent = displayedTarget;
          if (block.originalText.textContent !== paragraph.target) block.originalText.textContent = paragraph.target;
          block.correctionMeta.hidden = !corrected;
          block.english.hidden = !paragraph.source; block.chinese.hidden = !displayedTarget;
          blocks.push(block.node);
        }
        reconcile(section.paragraphs, blocks);
        for (const key of section.blocks.keys()) if (!paragraphKeys.has(key)) section.blocks.delete(key);
        sections.push(section.node);
      }
      reconcile(content, sections);
      for (const key of sessionElements.keys()) if (!currentKeys.has(key)) sessionElements.delete(key);
      const total = views.reduce((sum, view) => sum + view.rows.length, 0);
      count.textContent = `${total} 句已定稿`;
      empty.hidden = total > 0;
      copy.disabled = !views.some(view => view.paragraphs.some(paragraph =>
        language.value !== 'chinese' && paragraph.source || language.value !== 'english' && paragraph.target));
      updateCorrectionStatus();
      scroller.scrollTop = follow ? scroller.scrollHeight : top;
    }

    function schedule() {
      if (!isOpen || timer !== null || disposed) return;
      const generation = classroomGeneration;
      timer = setTimeout(() => {
        if (generation !== classroomGeneration || disposed) return;
        timer = null; refresh();
      }, 250);
    }

    function restoreTranscriptPosition() {
      requestAnimationFrame(() => {
        if (narrow.matches && isOpen) return;
        transcript.scrollTop = document.getElementById('autoscroll')?.checked ? transcript.scrollHeight : transcriptTop;
      });
    }

    function setOpen(open, follow = open) {
      if (transcript.getClientRects().length) transcriptTop = transcript.scrollTop;
      isOpen = open;
      candidateVisibilityDirty = true;
      body.classList.toggle('context-open', open); aside.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open)); toggle.setAttribute('aria-pressed', String(open));
      toggle.title = open ? '关闭上下文，返回实时字幕' : '打开上下文，阅读整合段落';
      configureCorrection(true);
      if (open) refresh(follow);
      configureCorrection(); updateCorrectionStatus();
      restoreTranscriptPosition();
    }

    const observer = new MutationObserver(records => {
      for (const record of records) {
        if (record.target === list) structureDirty = true;
        const element = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const row = element?.closest('.caption-row');
        if (row) dirtyRows.add(row);
      }
      schedule();
    });
    observer.observe(list, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });

    function clearClassroomContext() {
      if (disposed) return;
      classroomGeneration++;
      clearTimeout(timer); timer = null;
      scheduler?.destroy(); scheduler = null;
      observer.takeRecords();
      dirtyRows.clear(); rowCache = new WeakMap();
      orderedNodes = []; views = []; structureDirty = true;
      candidateCache.clear(); sentCandidates = []; appliedCorrectionSettings = null;
      candidateVisibilityDirty = true; sessionElements.clear();
      content.replaceChildren(); count.textContent = '0 句已定稿';
      empty.hidden = false; copy.disabled = true; feedback.textContent = '';
      scroller.scrollTop = 0; transcriptTop = 0;
      // Recreate only the background scheduler. All user controls retain their values.
      installCorrectionScheduler();
      updateCorrectionStatus();
    }
    window.addEventListener('classroom-captions-cleared', clearClassroomContext);

    toggle.addEventListener('click', () => { userToggled = true; setOpen(!isOpen); });
    close.addEventListener('click', () => { userToggled = true; setOpen(false); toggle.focus({ preventScroll: true }); });
    language.addEventListener('change', () => {
      const top = scroller.scrollTop, follow = scroller.scrollHeight - scroller.clientHeight - top < 40;
      aside.setAttribute('data-language', language.value); copy.disabled = !copyText();
      scroller.scrollTop = follow ? scroller.scrollHeight : top;
    });
    transcript.addEventListener('scroll', () => {
      if (!narrow.matches || !isOpen) transcriptTop = transcript.scrollTop;
    }, { passive: true });
    narrow.addEventListener('change', () => { setOpen(userToggled ? isOpen : !narrow.matches, false); });
    scroller.addEventListener('scroll', () => {
      if (correctionSwitch.checked) { candidateVisibilityDirty = true; schedule(); }
    }, { passive: true });
    correctionSwitch.addEventListener('change', () => {
      candidateVisibilityDirty = true; configureCorrection(true); refresh(); configureCorrection(); schedule();
    });
    correctionModel.addEventListener('change', () => { configureCorrection(true); refresh(); configureCorrection(); schedule(); });
    for (const id of ['finance-course', 'glossary', 'context']) {
      document.getElementById(id)?.addEventListener(id === 'finance-course' ? 'change' : 'input', () => {
        if (correctionSwitch.checked) { configureCorrection(true); refresh(); configureCorrection(); schedule(); }
      });
    }
    document.getElementById('refresh-profiles')?.addEventListener('click', () => { void loadCorrectionProfiles(); });
    window.addEventListener('classroom-context-correction-ready', installCorrectionScheduler);
    window.addEventListener('pagehide', () => {
      disposed = true; clearTimeout(timer); observer.disconnect(); scheduler?.destroy();
      window.removeEventListener('classroom-captions-cleared', clearClassroomContext);
      if (window.ClassroomContextExport === contextExport) delete window.ClassroomContextExport;
    });
    copy.addEventListener('click', async () => {
      const { text, hasCorrections: usesCorrection } = snapshotContext(); if (!text) return;
      const generation = classroomGeneration;
      try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);
        if (generation !== classroomGeneration || disposed) return;
        feedback.textContent = usesCorrection ? '已复制当前展示文本（含 AI 校正译文）。' : '已复制当前展示的原字幕文本。';
      } catch {
        if (generation !== classroomGeneration || disposed) return;
        const field = create('textarea', 'context-copy-fallback'); field.value = text; field.readOnly = true;
        aside.append(field); field.select();
        let copied = false;
        try { copied = document.execCommand('copy'); } catch { /* Manual selection remains available. */ }
        field.remove(); copy.focus({ preventScroll: true });
        feedback.textContent = copied ? usesCorrection ? '已复制当前展示文本（含 AI 校正译文）。' : '已复制当前展示的原字幕文本。' : '复制未成功，可在侧栏选择文字后复制。';
      }
    });
    installCorrectionScheduler();
    setOpen(!narrow.matches);
    void loadCorrectionProfiles();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installContextPanel, { once: true });
  else installContextPanel();
})();
