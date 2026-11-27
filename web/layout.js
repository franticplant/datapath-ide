/* Workspace layout state, 9 themes + syntax cards, Zen/Fullscreen, and mobile keybar config. */
import { THEMES, THEME_ORDER, applyTheme, normalizeThemeId } from './themes.js';

const key = 'datapath.layout.v1';
const defaults = () => ({
  explorerWidth: 210,
  inspectorWidth: 245,
  dockHeight: Math.round(Math.max(300, Math.min(440, (typeof innerHeight === 'number' ? innerHeight : 900) * 0.42))),
  dockWidth: Math.round(Math.max(440, Math.min(760, (typeof innerWidth === 'number' ? innerWidth : 1440) * 0.48))),
  dockPosition: 'bottom',
  explorerHidden: false,
  inspectorHidden: typeof innerWidth === 'number' && innerWidth >= 900 && innerWidth <= 1360,
  dockHidden: false,
  mode: 'custom',
  zen: false,
  fontSize: 14,
  tabWidth: 2,
  wrap: false,
  theme: 'amoled',
  syntax: 'auto',
  emacs: false,
  showLineNumbers: true,
  showFoldGutter: true,
  showActiveLine: true,
  showStatusBar: true,
  keybarOn: true,
  kbSize: 'm',
  kbRows: 1,
  liveLint: true,
  strictRtlLint: true,
  inlineValues: true,
  autoSwitchWave: true,
  autoClearConsole: true,
  autoScrollConsole: true,
});

export function installLayout(groups, onLayoutChange = null) {
  const $ = id => document.getElementById(id);
  let state = defaults();
  let preZen = null;

  try {
    const data = JSON.parse(localStorage.getItem(key));
    if (data && typeof data === 'object') {
      state = { ...state, ...data };
      if (data.theme === 'dark') state.theme = 'amoled';
      // Never lock a reload into Zen mode
      state.zen = false;
    }
  } catch { /* Keep defaults if preferences cannot be read. */ }

  const clamp = (value, min, max) => Math.max(min, Math.min(max, Number(value) || min));
  const themeLabel = id => THEMES[normalizeThemeId(id)]?.name || 'AMOLED Black';

  function buildThemeCards() {
    const host = $('theme-cards');
    if (!host) return;
    host.replaceChildren();
    for (const id of THEME_ORDER) {
      const t = THEMES[id];
      const card = document.createElement('button');
      card.type = 'button';
      card.className = `theme-card${state.theme === id ? ' active' : ''}`;
      card.dataset.themeCard = id;
      card.style.background = t.ui[1];
      card.style.color = t.ui[4];

      const sw = document.createElement('div');
      sw.className = 'sw';
      sw.style.background = t.ui[0];
      sw.innerHTML = `<span style="color:${t.syn[0]};font-weight:700">module</span><span style="color:${t.syn[11]}">if</span><span style="color:${t.syn[1]}">reg</span><span style="color:${t.syn[12]}">#5</span>`;

      const nm = document.createElement('div');
      nm.className = 'nm';
      nm.textContent = t.name;

      card.append(sw, nm);
      card.onclick = () => update({ theme: id });
      host.append(card);
    }

    const synSelect = $('syntax-theme');
    if (synSelect && !synSelect.options.length) {
      const auto = document.createElement('option');
      auto.value = 'auto';
      auto.textContent = 'Match theme';
      synSelect.append(auto);
      for (const id of THEME_ORDER) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = THEMES[id].name;
        synSelect.append(opt);
      }
    }

    const themeSelect = $('editor-theme');
    if (themeSelect && !themeSelect.dataset.populated) {
      themeSelect.dataset.populated = '1';
      themeSelect.replaceChildren();
      for (const id of THEME_ORDER) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = THEMES[id].name;
        themeSelect.append(opt);
      }
    }
  }

  function apply() {
    state.explorerWidth = clamp(state.explorerWidth, 160, 420);
    state.inspectorWidth = clamp(state.inspectorWidth, 200, 440);
    state.dockHeight = clamp(state.dockHeight, 150, Math.max(150, innerHeight * 0.78));
    state.dockWidth = clamp(state.dockWidth, 280, Math.max(280, innerWidth * 0.78));
    state.dockPosition = state.dockPosition === 'right' ? 'right' : 'bottom';
    state.fontSize = clamp(state.fontSize, 11, 20);
    state.tabWidth = Number(state.tabWidth) === 4 ? 4 : 2;
    state.theme = normalizeThemeId(state.theme);
    state.syntax = state.syntax === 'auto' || Object.hasOwn(THEMES, state.syntax) ? state.syntax : 'auto';
    state.kbSize = ['s', 'm', 'l'].includes(state.kbSize) ? state.kbSize : 'm';
    state.kbRows = Number(state.kbRows) === 2 ? 2 : 1;

    for (const flag of ['wrap', 'emacs', 'explorerHidden', 'inspectorHidden', 'dockHidden', 'zen']) state[flag] = state[flag] === true;
    for (const flag of ['showLineNumbers', 'showFoldGutter', 'showActiveLine', 'showStatusBar', 'keybarOn', 'liveLint', 'strictRtlLint', 'inlineValues', 'autoSwitchWave', 'autoClearConsole', 'autoScrollConsole']) {
      state[flag] = state[flag] !== false;
    }
    state.mode = ['edit', 'run', 'wave', 'zen', 'custom'].includes(state.mode) ? state.mode : 'custom';

    buildThemeCards();
    applyTheme(state.theme, state.syntax);

    document.documentElement.style.setProperty('--explorer-width', `${state.explorerWidth}px`);
    document.documentElement.style.setProperty('--inspector-width', `${state.inspectorWidth}px`);
    document.documentElement.style.setProperty('--dock-height', `${state.dockHeight}px`);
    document.documentElement.style.setProperty('--dock-width', `${state.dockWidth}px`);

    document.body.classList.toggle('explorer-hidden', state.explorerHidden);
    document.body.classList.toggle('inspector-hidden', state.inspectorHidden);
    document.body.classList.toggle('dock-hidden', state.dockHidden);
    document.body.classList.toggle('dock-right', state.dockPosition === 'right');
    document.body.classList.toggle('mode-wave', state.mode === 'wave');
    document.body.classList.toggle('is-zen', state.zen);
    document.body.classList.toggle('status-hidden', !state.showStatusBar);
    document.body.classList.toggle('no-keybar', !state.keybarOn);
    document.body.classList.toggle('kb2', state.kbRows === 2);
    document.body.dataset.kb = state.kbSize;
    $('zen-bar').hidden = !state.zen;

    for (const card of document.querySelectorAll('#theme-cards .theme-card')) {
      card.classList.toggle('active', card.dataset.themeCard === state.theme);
    }

    $('toggle-explorer').setAttribute('aria-pressed', String(!state.explorerHidden));
    $('toggle-inspector').setAttribute('aria-pressed', String(!state.inspectorHidden));
    $('toggle-dock').setAttribute('aria-pressed', String(!state.dockHidden));
    const rightDock = state.dockPosition === 'right';
    $('toggle-dock-side')?.setAttribute('aria-pressed', String(rightDock));
    $('toggle-dock-side')?.setAttribute('aria-label', rightDock ? 'Dock output to bottom' : 'Dock output to right');
    const dockSplitter = $('dock-splitter');
    dockSplitter.classList.toggle('vertical', rightDock);
    dockSplitter.classList.toggle('horizontal', !rightDock);
    dockSplitter.setAttribute('aria-orientation', rightDock ? 'vertical' : 'horizontal');
    for (const m of ['edit', 'run', 'wave', 'zen']) {
      $(`mode-${m}`).setAttribute('aria-pressed', String(state.zen ? m === 'zen' : state.mode === m));
    }

    for (const [id, min, max, value] of [
      ['explorer-splitter', 160, 420, state.explorerWidth],
      ['inspector-splitter', 200, 440, state.inspectorWidth],
      ['dock-splitter', rightDock ? 280 : 150, Math.floor((rightDock ? innerWidth : innerHeight) * 0.78), rightDock ? state.dockWidth : state.dockHeight],
    ]) {
      const el = $(id);
      el.setAttribute('aria-valuemin', min);
      el.setAttribute('aria-valuemax', max);
      el.setAttribute('aria-valuenow', Math.round(value));
    }

    $('font-size').value = String(state.fontSize);
    $('tab-width').value = String(state.tabWidth);
    $('editor-theme').value = state.theme;
    if ($('syntax-theme')) $('syntax-theme').value = state.syntax;
    if ($('emacs-nav')) $('emacs-nav').checked = state.emacs;
    $('word-wrap').checked = state.wrap;
    $('show-line-numbers').checked = state.showLineNumbers;
    $('show-fold-gutter').checked = state.showFoldGutter;
    $('show-active-line').checked = state.showActiveLine;
    $('show-status-bar').checked = state.showStatusBar;
    if ($('keybar-on')) $('keybar-on').checked = state.keybarOn;
    if ($('kb-size')) $('kb-size').value = state.kbSize;
    if ($('kb-rows')) $('kb-rows').value = String(state.kbRows);
    $('opt-strict-lint').checked = state.strictRtlLint;
    $('live-lint').checked = state.liveLint;
    $('inline-values').checked = state.inlineValues;
    $('auto-switch-wave').checked = state.autoSwitchWave;
    $('auto-clear-console').checked = state.autoClearConsole;
    $('auto-scroll-console').checked = state.autoScrollConsole;
    $('console-autoscroll-quick').checked = state.autoScrollConsole;

    $('footer-wrap').textContent = `Wrap: ${state.wrap ? 'On' : 'Off'}`;
    $('footer-tab').textContent = `Spaces: ${state.tabWidth}`;
    $('footer-theme').textContent = `Theme: ${themeLabel(state.theme)}`;

    groups.setVisualFlags({
      showLineNumbers: state.showLineNumbers,
      showFoldGutter: state.showFoldGutter,
      showActiveLine: state.showActiveLine,
    });
    groups.configureAll({
      fontSize: state.fontSize,
      tabWidth: state.tabWidth,
      wrap: state.wrap,
      emacs: state.emacs,
    });
    onLayoutChange?.({ ...state });
  }

  function persist() {
    try { localStorage.setItem(key, JSON.stringify(state)); } catch { $('save-state').textContent = 'Could not save layout settings'; }
  }

  function update(changes) {
    Object.assign(state, changes);
    apply();
    persist();
  }

  function exitZen() {
    if (!state.zen) return;
    const restored = preZen ? { ...preZen, zen: false } : { zen: false, mode: state.mode === 'zen' ? 'custom' : state.mode };
    preZen = null;
    update(restored);
  }

  function toggleZen() {
    if (state.zen) { exitZen(); return; }
    preZen = { mode: state.mode, explorerHidden: state.explorerHidden, inspectorHidden: state.inspectorHidden, dockHidden: state.dockHidden };
    document.body.classList.remove('dock-maximized');
    $('maximize-dock').setAttribute('aria-pressed', 'false');
    update({ zen: true });
  }

  function setMode(mode) {
    if (mode === 'zen') { toggleZen(); return; }
    document.body.classList.remove('dock-maximized');
    $('maximize-dock').setAttribute('aria-pressed', 'false');
    $('maximize-dock').setAttribute('aria-label', 'Maximize output');
    if (mode === 'edit') update({ mode: 'edit', zen: false, explorerHidden: false, dockHidden: true, inspectorHidden: true });
    else if (mode === 'run') update({ mode: 'run', zen: false, explorerHidden: true, dockHidden: false, inspectorHidden: false, dockHeight: Math.max(state.dockHeight, Math.round(innerHeight * 0.45)) });
    else if (mode === 'wave') {
      update({ mode: 'wave', zen: false, dockPosition: 'bottom', explorerHidden: true, dockHidden: false, inspectorHidden: false });
      document.querySelector('[data-panel="waveform"]').click();
    }
  }

  function setMaximized(on) {
    document.body.classList.toggle('dock-maximized', on);
    $('maximize-dock').setAttribute('aria-label', on ? 'Restore output' : 'Maximize output');
    $('maximize-dock').setAttribute('aria-pressed', String(on));
  }
  const isMaximized = () => document.body.classList.contains('dock-maximized');
  function setDockPosition(pos, { show = false } = {}) {
    update({ dockPosition: pos === 'right' ? 'right' : 'bottom', ...(show ? { dockHidden: false } : {}) });
  }
  function toggleDockPosition() {
    setDockPosition(state.dockPosition === 'right' ? 'bottom' : 'right', { show: true });
  }

  function toggleDock() {
    update({ mode: 'custom', zen: false, dockHidden: !state.dockHidden });
  }

  $('preferences').onclick = () => $('settings-dialog').showModal();
  $('close-settings')?.addEventListener('click', () => $('settings-dialog').close());
  $('settings-dialog')?.addEventListener('click', e => { if (e.target === $('settings-dialog')) $('settings-dialog').close(); });

  $('font-size').onchange = event => update({ fontSize: Number(event.target.value) });
  $('tab-width').onchange = event => update({ tabWidth: Number(event.target.value) });
  $('editor-theme').onchange = event => update({ theme: event.target.value });
  $('syntax-theme')?.addEventListener('change', event => update({ syntax: event.target.value }));
  $('kb-size')?.addEventListener('change', event => update({ kbSize: event.target.value }));
  $('kb-rows')?.addEventListener('change', event => update({ kbRows: Number(event.target.value) }));

  for (const [id, field] of [
    ['word-wrap', 'wrap'],
    ['emacs-nav', 'emacs'],
    ['show-line-numbers', 'showLineNumbers'],
    ['show-fold-gutter', 'showFoldGutter'],
    ['show-active-line', 'showActiveLine'],
    ['show-status-bar', 'showStatusBar'],
    ['keybar-on', 'keybarOn'],
    ['live-lint', 'liveLint'],
    ['opt-strict-lint', 'strictRtlLint'],
    ['inline-values', 'inlineValues'],
    ['auto-switch-wave', 'autoSwitchWave'],
    ['auto-clear-console', 'autoClearConsole'],
    ['auto-scroll-console', 'autoScrollConsole'],
  ]) {
    $(id)?.addEventListener('change', event => update({ [field]: event.target.checked }));
  }
  $('console-autoscroll-quick').onchange = event => update({ autoScrollConsole: event.target.checked });

  $('footer-wrap').onclick = () => update({ wrap: !state.wrap });
  $('footer-tab').onclick = () => update({ tabWidth: state.tabWidth === 2 ? 4 : 2 });
  $('footer-theme').onclick = () => {
    const idx = THEME_ORDER.indexOf(state.theme);
    update({ theme: THEME_ORDER[(idx + 1) % THEME_ORDER.length] });
  };

  $('toggle-explorer').onclick = () => update({ mode: 'custom', explorerHidden: !state.explorerHidden });
  $('toggle-inspector').onclick = () => update({ mode: 'custom', inspectorHidden: !state.inspectorHidden });
  $('toggle-dock').onclick = toggleDock;
  $('toggle-dock-side')?.addEventListener('click', toggleDockPosition);
  $('collapse-dock').onclick = () => { setMaximized(false); update({ mode: 'custom', dockHidden: true }); };
  for (const m of ['edit', 'run', 'wave', 'zen']) $(`mode-${m}`).onclick = () => setMode(m);
  $('exit-zen').onclick = exitZen;
  $('maximize-dock').setAttribute('aria-pressed', 'false');
  $('maximize-dock').onclick = () => setMaximized(!isMaximized());

  const splitterSpec = id => {
    if (id === 'explorer-splitter') return { field: 'explorerWidth', axis: 'clientX', direction: 1, reset: 210 };
    if (id === 'inspector-splitter') return { field: 'inspectorWidth', axis: 'clientX', direction: -1, reset: 245 };
    const right = state.dockPosition === 'right';
    return right
      ? { field: 'dockWidth', axis: 'clientX', direction: -1, snap: [Math.round(innerWidth * 0.52), 380] }
      : { field: 'dockHeight', axis: 'clientY', direction: -1, snap: [Math.round(innerHeight * 0.52), 280] };
  };

  for (const id of ['explorer-splitter', 'inspector-splitter', 'dock-splitter']) {
    const element = $(id);
    element.onpointerdown = event => {
      if (event.button !== 0) return;
      const { field, axis, direction } = splitterSpec(id);
      const start = event[axis];
      const original = state[field];
      element.setPointerCapture(event.pointerId);
      element.classList.add('dragging');
      element.onpointermove = move => { state[field] = original + direction * (move[axis] - start); apply(); };
    };
    element.onpointerup = element.onpointercancel = () => {
      element.classList.remove('dragging');
      element.onpointermove = null;
      persist();
    };
    element.ondblclick = () => {
      const spec = splitterSpec(id);
      if (spec.snap) {
        const [wide, compact] = spec.snap;
        update({ [spec.field]: Math.abs(state[spec.field] - wide) < 28 ? compact : wide });
      } else {
        update({ [spec.field]: spec.reset });
      }
    };
    element.onkeydown = event => {
      const { field, axis, direction } = splitterSpec(id);
      const positive = axis === 'clientX' ? 'ArrowRight' : 'ArrowDown';
      const negative = axis === 'clientX' ? 'ArrowLeft' : 'ArrowUp';
      if (event.key === positive || event.key === negative) {
        event.preventDefault();
        update({ [field]: state[field] + direction * (event.key === positive ? 10 : -10) });
      }
    };
  }

  apply();
  return { getState: () => ({ ...state }), update, setMode, toggleZen, exitZen, toggleDock, setDockPosition, toggleDockPosition, setMaximized, isMaximized, apply };
}
