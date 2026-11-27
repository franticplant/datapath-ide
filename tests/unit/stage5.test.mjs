// Unit checks for nav-history.js against a fake History API (async traversal like browsers).
// Run offline: mvm run -i docker.io/library/node:22-alpine -- node tests/unit/stage5.test.mjs
import assert from 'node:assert/strict';
import { createNavHistory } from '../../web/nav-history.js';

function fakeWindow() {
  const listeners = new Set();
  const win = {
    left: false,
    entries: [{ state: null }],
    index: 0,
    addEventListener: (type, fn) => { if (type === 'popstate') listeners.add(fn); },
    removeEventListener: (type, fn) => listeners.delete(fn),
  };
  const go = delta => setTimeout(() => {
    const next = win.index + delta;
    if (next < 0) { win.left = true; return; }
    if (next >= win.entries.length) return;
    win.index = next;
    for (const fn of listeners) fn({ state: win.entries[next].state });
  }, 1);
  win.history = {
    pushState(state) { win.entries.length = win.index + 1; win.entries.push({ state }); win.index++; },
    replaceState(state) { win.entries[win.index] = { state }; },
    go, back: () => go(-1), forward: () => go(1),
  };
  return win;
}
const tick = (ms = 10) => new Promise(resolve => setTimeout(resolve, ms));

function harness() {
  const win = fakeWindow();
  const app = { view: 'code', file: 'a.v', overlays: [] };
  const log = { exit: 0 };
  const nav = createNavHistory({
    win,
    snapshot: () => ({ view: app.view, file: app.file }),
    restore: state => { app.view = state.view; app.file = state.file; },
    onExitGuard: () => { log.exit++; },
  });
  const go = async (patch) => { Object.assign(app, patch); nav.record(); await tick(); };
  const overlay = name => {
    const close = () => { app.overlays = app.overlays.filter(item => item !== name); };
    return {
      open: () => { app.overlays.push(name); nav.overlayOpened(close); },
      closeByUi: () => { close(); nav.overlayClosed(close); },
    };
  };
  const back = async () => { win.history.back(); await tick(30); };
  const forward = async () => { win.history.forward(); await tick(30); };
  return { win, app, nav, log, go, overlay, back, forward };
}

let checks = 0;
const check = async (name, fn) => {
  try { await fn(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};

await check('back and forward walk the app stack', async () => {
  const { app, nav, go, back, forward } = harness();
  await go({ view: 'files' });
  await go({ view: 'console' });
  await go({ file: 'b.v', view: 'code' });
  assert.equal(nav.getState().length, 4);
  await back();
  assert.deepEqual([app.view, app.file], ['console', 'a.v']);
  await back();
  assert.equal(app.view, 'files');
  await forward();
  assert.equal(app.view, 'console');
  await forward();
  assert.deepEqual([app.view, app.file], ['code', 'b.v']);
});

await check('same-task changes become one entry; unchanged state records nothing', async () => {
  const { app, nav } = harness();
  app.view = 'files'; nav.record();
  app.file = 'c.v'; nav.record();
  await tick();
  assert.equal(nav.getState().length, 2);
  nav.record();
  await tick();
  assert.equal(nav.getState().length, 2);
});

await check('back closes an overlay without leaving the state', async () => {
  const { app, nav, go, overlay, back } = harness();
  await go({ view: 'console' });
  overlay('about').open();
  assert.deepEqual(app.overlays, ['about']);
  await back();
  assert.deepEqual(app.overlays, []);
  assert.equal(app.view, 'console');
  assert.equal(nav.getState().index, 1);
  await back();
  assert.equal(app.view, 'code');
});

await check('overlay closed by the UI gives its entry back', async () => {
  const { win, app, go, overlay, back } = harness();
  await go({ view: 'console' });
  const sheet = overlay('more');
  sheet.open();
  const depth = win.index;
  sheet.closeByUi();
  await tick(30);
  assert.equal(win.index, depth - 1);
  await back();
  assert.equal(app.view, 'code', 'one Back after closing the sheet goes to the previous state');
});

await check('pendingBack reuse: close an overlay and navigate in the same task', async () => {
  const { win, app, nav, go, overlay, back } = harness();
  await go({ view: 'console' });
  const dialog = overlay('templates');
  dialog.open();
  const before = win.entries.length;
  dialog.closeByUi();
  app.file = 'project.v'; app.view = 'code';
  nav.record();
  await tick(30);
  assert.equal(win.entries.length, before, 'the dialog entry is reused, not popped and pushed');
  assert.equal(nav.getState().index, 2);
  await back();
  assert.deepEqual([app.view, app.file], ['console', 'a.v']);
});

await check('overlay -> overlay hand-off (More -> About) reuses the entry', async () => {
  const { win, app, go, overlay, back } = harness();
  await go({ view: 'console' });
  const more = overlay('more');
  const about = overlay('about');
  more.open();
  const before = win.entries.length;
  more.closeByUi();
  about.open();
  await tick(30);
  assert.equal(win.entries.length, before);
  await back();
  assert.deepEqual(app.overlays, []);
  assert.equal(app.view, 'console');
});

await check('navigation under an open card: Back restores the state, then closes the card', async () => {
  const { app, go, overlay, back } = harness();
  await go({ view: 'console' });                // schematic
  overlay('inspector').open();
  await go({ view: 'code', file: 'cpu.v' });    // Jump to Code from the card
  await back();
  assert.deepEqual([app.view, app.file, app.overlays], ['console', 'a.v', ['inspector']]);
  await back();
  assert.deepEqual(app.overlays, []);
  assert.equal(app.view, 'console');
});

await check('stale entries are skipped in the direction of travel', async () => {
  const { app, go, overlay, back } = harness();
  await go({ view: 'console' });
  const card = overlay('inspector');
  card.open();
  await go({ view: 'code' });
  card.closeByUi();                             // not on top any more: its entry stays, stale
  await tick(30);
  await back();                                 // lands on the stale card entry -> restores console
  assert.equal(app.view, 'console');
  await back();                                 // base console entry is a duplicate -> skipped to code root
  await tick(40);
  assert.equal(app.view, 'code');
});

await check('root exit guard: first Back warns, second leaves', async () => {
  const { win, log, back } = harness();
  await back();
  assert.equal(log.exit, 1);
  assert.equal(win.left, false);
  await back();
  await tick(30);
  assert.equal(win.left, true);
});

console.log(`Stage 5 unit checks passed (${checks})`);
