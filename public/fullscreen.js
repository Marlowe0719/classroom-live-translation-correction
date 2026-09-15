(() => {
  'use strict';

  function installFullscreen() {
    const panel = document.getElementById('caption-panel');
    const tools = panel?.querySelector('.caption-tools');
    const toolbar = panel?.querySelector('.caption-toolbar');
    const actions = document.querySelector('.start-actions');
    if (!panel || !tools || !toolbar || !actions || document.getElementById('caption-fullscreen-button')) return;

    const transcript = panel.querySelector('.transcript');
    const origin = document.createComment('Original classroom start/pause/end controls');
    actions.parentNode.insertBefore(origin, actions);
    const actionSlot = document.createElement('div');
    actionSlot.className = 'fullscreen-actions';
    actionSlot.setAttribute('role', 'group');
    actionSlot.setAttribute('aria-label', '开始、暂停与结束课堂');
    actionSlot.hidden = true;
    toolbar.append(actionSlot);

    const button = document.createElement('button');
    button.id = 'caption-fullscreen-button';
    button.type = 'button';
    button.className = 'button secondary small fullscreen-button';
    button.setAttribute('aria-controls', panel.id);
    tools.append(button);

    let active = false, fallback = false, nativeSeen = false, exitingNative = false;
    let requestVersion = 0, previousFocus = null;
    let hadScrollLock = false;

    function updateButton() {
      button.textContent = active ? '退出全屏' : '全屏字幕';
      button.setAttribute('aria-pressed', String(active));
      button.title = active ? `退出全屏（Esc）${fallback ? ' · 页面内全屏' : ''}` : '全屏查看字幕，保留开始、暂停与结束按钮';
      button.disabled = exitingNative;
    }

    function preserveReadingPosition(change) {
      const top = transcript?.scrollTop || 0;
      const atBottom = transcript && transcript.scrollHeight - transcript.clientHeight - top < 30;
      change();
      if (transcript) transcript.scrollTop = atBottom ? transcript.scrollHeight : top;
    }

    function showFullscreen(useFallback) {
      fallback = useFallback;
      preserveReadingPosition(() => {
        if (!active) {
          previousFocus = document.activeElement;
          hadScrollLock = document.documentElement.classList.contains('caption-fullscreen-open');
        }
        active = true;
        actionSlot.append(actions); // Move the existing buttons, preserving live.js listeners.
        actionSlot.hidden = false;
        panel.classList.add('caption-fullscreen-active');
        panel.classList.toggle('caption-fullscreen-fallback', fallback);
        document.documentElement.classList.add('caption-fullscreen-open');
      });
      updateButton();
    }

    function restorePage() {
      if (!active) return;
      requestVersion++;
      preserveReadingPosition(() => {
        active = false; fallback = false; nativeSeen = false;
        panel.classList.remove('caption-fullscreen-active', 'caption-fullscreen-fallback');
        if (!hadScrollLock) document.documentElement.classList.remove('caption-fullscreen-open');
        if (origin.parentNode) origin.parentNode.insertBefore(actions, origin.nextSibling);
        actionSlot.hidden = true;
      });
      updateButton();
      const focusTarget = previousFocus?.isConnected && !previousFocus.disabled ? previousFocus : button;
      focusTarget.focus({ preventScroll: true });
      previousFocus = null;
    }

    async function exitFullscreen() {
      if (exitingNative) return;
      if (document.fullscreenElement !== panel) { restorePage(); return; }
      exitingNative = true; updateButton();
      try {
        await document.exitFullscreen();
        if (document.fullscreenElement !== panel) restorePage();
      } catch {
        // Keep the controls reachable if a browser rejects the exit request.
        if (document.fullscreenElement === panel) { nativeSeen = true; showFullscreen(false); }
        else restorePage();
      } finally { exitingNative = false; updateButton(); }
    }

    async function enterFullscreen() {
      const version = ++requestVersion;
      showFullscreen(true);
      button.focus({ preventScroll: true });
      if (typeof panel.requestFullscreen !== 'function' || document.fullscreenEnabled === false) return;
      try {
        await panel.requestFullscreen();
        if (version !== requestVersion || !active) {
          if (!active && document.fullscreenElement === panel) await exitFullscreen();
          return;
        }
        if (document.fullscreenElement === panel) { nativeSeen = true; showFullscreen(false); }
      } catch {
        if (version === requestVersion && active) showFullscreen(document.fullscreenElement !== panel);
      }
    }

    button.addEventListener('click', () => { void (active ? exitFullscreen() : enterFullscreen()); });
    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === panel) {
        if (!active) { void exitFullscreen(); return; }
        nativeSeen = true; showFullscreen(false);
      } else if (nativeSeen) {
        // Esc and permission dialogs can exit native fullscreen. Do not stop audio.
        restorePage();
      }
    });
    document.addEventListener('keydown', event => {
      if (!active) return;
      if (event.key === 'Escape') { event.preventDefault(); void exitFullscreen(); return; }
      if (event.key !== 'Tab') return;
      const focusable = Array.from(panel.querySelectorAll('button, select, input, textarea, a[href], [tabindex]'))
        .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      if (!focusable.length) return;
      const current = document.activeElement;
      const currentIsFocusable = focusable.includes(current);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && (current === first || !currentIsFocusable)) {
        event.preventDefault(); last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (current === last || !currentIsFocusable)) {
        event.preventDefault(); first.focus({ preventScroll: true });
      }
    });
    updateButton();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installFullscreen, { once: true });
  else installFullscreen();
})();
