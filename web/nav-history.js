// Back / Forward navigation on the browser History API (Android swipe-back, Alt+Arrow, the topbar Back button).
//
// History entries carry { dp: 1, pos } plus one of:
//   root: true          exit guard below the app
//   navI: n             app state stack[n]
//   navI: n, ov: d      an overlay (dialog, sheet, popover, card) opened on top of stack[n]
// `pos` is the entry's position in the session history, so popstate knows whether it moved back or forward.
//
// Back closes the overlays opened on the current state first, then walks the app stack, and at the root asks
// for a second Back within `exitWindowMs`. An overlay closed by the UI gives its entry back with history.go(-n)
// on the next tick, unless a navigation or another overlay comes first: that one then reuses the entry with
// replaceState (no back + push race). Entries that end up stale (an overlay closed under a newer state) are
// skipped automatically in the direction of travel.

export function createNavHistory({ snapshot, restore, keyOf = state => JSON.stringify(state), onBackState = null, onExitGuard = null, exitWindowMs = 2500, win = window }) {
  const history = win.history;
  const stack = [snapshot()];
  let cur = 0;
  let pos = 1;
  let restoring = false;
  const overlays = [];            // { close, pos, navI }, innermost last
  let pendingBack = 0;            // popstate events caused by our own history.go(-n)
  let uiCloses = 0;               // top overlay entries waiting to be given back
  let backTimer = null;
  let exitArmedAt = 0;
  let flushTimer = null;
  let forceNext = false;
  let suppressClose = false;

  history.replaceState({ dp: 1, root: true, pos: 0 }, '');
  history.pushState({ dp: 1, navI: 0, pos: 1 }, '');

  const notify = () => onBackState?.({ canBack: cur > 0 || overlays.length > 0, canForward: cur < stack.length - 1, index: cur, overlays: overlays.length });

  // Writes `state` as the next entry, reusing an entry the UI already gave up if there is one.
  function enter(state) {
    if (uiCloses) {
      // Reuse the top given-up entry; any others below it become stale and are skipped later.
      clearTimeout(backTimer);
      backTimer = null;
      uiCloses = 0;
      history.replaceState({ ...state, pos }, '');
      return;
    }
    pos++;
    history.pushState({ ...state, pos }, '');
  }

  function flush() {
    flushTimer = null;
    const force = forceNext;
    forceNext = false;
    if (restoring) return;
    const next = snapshot();
    if (!force && keyOf(next) === keyOf(stack[cur])) { stack[cur] = next; return; }
    stack.length = cur + 1;
    stack.push(next);
    cur++;
    enter({ dp: 1, navI: cur });
    notify();
  }

  // Note a possible navigation; changes made in the same task (file + view + panel) become one entry.
  function record({ force = false } = {}) {
    if (restoring) return;
    forceNext = forceNext || force;
    if (!flushTimer) flushTimer = setTimeout(flush, 0);
  }

  function overlayOpened(close) {
    if (overlays.some(item => item.close === close)) return;
    if (flushTimer) { clearTimeout(flushTimer); flush(); }
    enter({ dp: 1, navI: cur, ov: overlays.length + 1 });
    overlays.push({ close, pos, navI: cur });
    notify();
  }

  function overlayClosed(close) {
    const index = overlays.findIndex(item => item.close === close);
    if (index < 0) return;               // already closed by Back
    const [item] = overlays.splice(index, 1);
    notify();
    if (suppressClose) return;
    // Only an entry still on top of the session history can be given back.
    if (item.pos !== pos - uiCloses) return;
    uiCloses++;
    clearTimeout(backTimer);
    backTimer = setTimeout(() => {
      backTimer = null;
      // A navigation recorded in the same task reuses the entry instead.
      if (flushTimer) { clearTimeout(flushTimer); flush(); }
      const count = uiCloses;
      uiCloses = 0;
      if (!count) return;
      pendingBack++;
      history.go(-count);
    }, 0);
  }

  function onPopState(event) {
    const state = event.state;
    if (!state || state.dp !== 1) return;
    const direction = Number(state.pos) < pos ? -1 : 1;
    pos = Number(state.pos) || 0;
    if (pendingBack > 0) { pendingBack--; return; }
    if (state.root) {
      if (Date.now() - exitArmedAt < exitWindowMs) { exitArmedAt = 0; history.back(); return; }
      exitArmedAt = Date.now();
      pos++;
      history.pushState({ dp: 1, navI: cur, pos }, '');
      onExitGuard?.();
      return;
    }
    const target = Math.max(0, Math.min(Number(state.navI) || 0, stack.length - 1));
    if (direction < 0 && overlays.length && target === cur && overlays.at(-1).navI === cur) {
      const { close } = overlays.pop();
      suppressClose = true;
      try { close(); } finally { suppressClose = false; }
      notify();
      return;
    }
    if (target === cur) {
      // A stale entry (overlay closed under a newer state): keep moving the same way.
      if (direction < 0) history.back(); else history.forward();
      return;
    }
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; forceNext = false; }
    stack[cur] = snapshot();
    cur = target;
    restoring = true;
    try { restore(stack[cur]); } finally { restoring = false; }
    notify();
  }
  win.addEventListener('popstate', onPopState);
  notify();

  return {
    record,
    overlayOpened,
    overlayClosed,
    back: () => history.back(),
    forward: () => history.forward(),
    isRestoring: () => restoring,
    // Lets async restores (schematic drill-down) finish without recording new entries.
    withRestoring(fn) { const was = restoring; restoring = true; try { return fn(); } finally { restoring = was; } },
    getState: () => ({ index: cur, length: stack.length, overlays: overlays.length, pos, stack: stack.map(entry => ({ ...entry })) }),
    destroy: () => win.removeEventListener('popstate', onPopState),
  };
}
