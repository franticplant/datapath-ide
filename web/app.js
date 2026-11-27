import { lintRtl } from './rtl-linter.js';
import { buildModuleHierarchy } from './hierarchy.js';
import { computeInlineValues } from './inline-values.js';
import { formatVerilog } from './verilog-format.js';
import { installWaveform } from './waveform.js';
import { EngineClient } from './engine-client.js';
import { ConsoleBuffer } from './console-buffer.js';
import { createEditor } from './vendor/editor.js';
import { installLayout } from './layout.js';
import { renderExplorer } from './explorer.js';
import { validPath, createArchive, readArchive } from './archive.js';
import { installSimSettings } from './sim-settings.js';
import { EditorGroups } from './groups.js';
import { THEMES, THEME_ORDER } from './themes.js';
import { createWorkspaceStorage } from './storage.js';
import { installTestRunner } from './test-runner.js';
import { installSearch } from './search.js';
import { decodeMips, parseMipsWord } from './mips-decode.js';
import { installHwState } from './hw-state.js';
import { installBoard } from './board.js';
import { installSchematic } from './schematic.js';
import { assembleMips, MIPS_MNEMONICS, MIPS_DIRECTIVES } from './mips-asm.js';
import { MIPS_REGISTERS } from './mips-decode.js';
import { extractFsmStates, stateNameFor } from './fsm-states.js';
import { createNavHistory } from './nav-history.js';
import { MIPS_TEMPLATE, MIPS_TEMPLATE_TOP } from './mips-template.js';
import { SHOWCASE_PROJECTS, showcaseProject } from './showcase-projects.js';
import { installTour, parseDeepLink } from './tour.js';
import { VERILOG_KEYWORDS, VERILOG_SYSTASKS, VERILOG_DIRECTIVES, VERILOG_SNIPPETS, SHORTCUTS, lookupHint, parseVerilogLiteral, searchRef } from './verilog-ref.js';

const STANDARDS = ['2001', '2005', '2009', '2012'];
const defaults = {
  'design.v': `module counter(input clk, input reset, output reg [3:0] count);\n  always @(posedge clk) begin\n    if (reset) count <= 0;\n    else count <= count + 1;\n  end\nendmodule\n`,
  'testbench.v': `\u0060timescale 1ns/1ps\nmodule testbench;\n  reg clk = 0;\n  reg reset = 1;\n  wire [3:0] count;\n  counter dut(.clk(clk), .reset(reset), .count(count));\n  always #5 clk = ~clk;\n  initial begin\n    $dumpfile("wave.vcd");\n    $dumpvars(0, testbench);\n    #12 reset = 0;\n    #50 $finish;\n  end\nendmodule\n`,
};

const $ = id => document.getElementById(id);
let files = Object.assign(Object.create(null), defaults);
let current = 'design.v';
let diagnostics = [];
let icarusDiagnostics = [];
let lastElaboratedJson = null, elaboratedFiles = null, elaboratedSources = null;
let lintSeq = 0, lintTimer = null, lintWorker = null, inlineTimer;
let outputOpened = false;
let simulationSettings = null;
let hideExcluded = false;
let folders = new Set();
let excluded = new Set();
let collapsed = new Set();
let cursorState = { line: 1, col: 1, lineText: '', word: '' };
let helpTab = 'card';
let waveform = null;       // installed after layout; referenced lazily by early handlers
let testRunner = null;
let hwState = null;
let board = null;
let schematic = null;
let nav = null;             // Back / Forward history (nav-history.js), created once the UI is installed
let tour = null;            // Featured showcase & 6-chapter interactive tour controller (tour.js)
let activeShowcaseId = null;
let fsmMap = null;

const FEATURED_DISMISSED_KEY = 'datapath.featured.dismissed';
function dismissFeatured() {
  try { localStorage.setItem(FEATURED_DISMISSED_KEY, '1'); } catch { /* ignore */ }
  tour?.hideFeatured();
}

const storage = createWorkspaceStorage({ onError: () => { $('save-state').textContent = 'IndexedDB unavailable — export a ZIP backup'; } });
let restoredAt = 0;         // savedAt of the snapshot this session started from
let hadSavedWorkspace = false;
let hydrated = false;       // true once the IndexedDB copy has been compared with the mirror
let pendingSave = false;    // saves requested before hydration finished

function validSnapshot(saved) {
  return saved && saved.files && typeof saved.files === 'object' && Object.keys(saved.files).length > 0;
}

function applySnapshot(saved) {
  files = Object.assign(Object.create(null), saved.files);
  current = Object.hasOwn(files, saved.current) ? saved.current : Object.keys(files)[0];
  folders = new Set(Array.isArray(saved.folders) ? saved.folders.filter(validPath) : []);
  excluded = new Set(Array.isArray(saved.excluded) ? saved.excluded.filter(path => Object.hasOwn(files, path)) : []);
  $('top-module').value = saved.topModule || '';
  if (STANDARDS.includes(saved.standard)) $('standard').value = saved.standard;
  restoredAt = Number(saved.savedAt) || 0;
}

try {
  const saved = storage.loadMirror();
  if (validSnapshot(saved)) { hadSavedWorkspace = true; applySnapshot(saved); }
} catch {
  $('save-state').textContent = 'Could not restore workspace';
}

function workspaceSnapshot() {
  return { files, current, folders: [...folders], excluded: [...excluded], topModule: $('top-module').value, standard: $('standard').value };
}

function save() {
  if (!hydrated) { pendingSave = true; return; }
  try {
    const { mirrored } = storage.save(workspaceSnapshot());
    $('save-state').textContent = mirrored ? 'Saved locally' : 'Saved to IndexedDB (large workspace)';
  } catch {
    $('save-state').textContent = 'Save failed — export your file';
  }
}

// The IndexedDB copy wins only when it is newer than the mirror (e.g. workspaces over the 1 MB mirror limit).
async function hydrateFromDurable() {
  const durable = await storage.loadDurable();
  hydrated = true;
  // Saves queued during boot only re-save the startup state, so a newer durable snapshot still wins.
  const hadPending = pendingSave;
  pendingSave = false;
  if (validSnapshot(durable) && Number(durable.savedAt) > restoredAt) {
    hadSavedWorkspace = true;
    dismissFeatured();
    applySnapshot(durable);
    groups.removePaths(() => true, current);
    groups.openFile(current);
    suggestModules();
    render();
    $('save-state').textContent = 'Restored from IndexedDB';
    return;
  }
  if (hadPending) save();
}

function suggestModules() {
  const names = new Set();
  for (const [name, text] of Object.entries(files)) {
    if (excluded.has(name) || !/\.(v|sv)$/i.test(name)) continue;
    for (const match of text.matchAll(/\bmodule\s+([a-zA-Z_][\w$]*)/g)) names.add(match[1]);
  }
  $('detected-modules').replaceChildren(...Array.from(names, name => {
    const option = document.createElement('option');
    option.value = name;
    return option;
  }));
}

const isAsm = path => /\.(?:asm|s)$/i.test(path);
const MIPS_COMPLETIONS = [
  ...MIPS_MNEMONICS.map(name => ({ label: name, type: 'keyword', detail: 'MIPS instruction', info: '' })),
  ...MIPS_REGISTERS.map((name, index) => ({ label: name, type: 'variable', detail: `register ${index}`, info: '' })),
  ...MIPS_DIRECTIVES.map(name => ({ label: name, type: 'macro', detail: 'Directive', info: '' })),
];

function collectCompletions(mode = 'verilog') {
  if (mode === 'mips') return MIPS_COMPLETIONS;
  const seen = new Set();
  const out = [];
  const push = (label, type, detail, info, apply = null) => {
    if (seen.has(label)) return;
    seen.add(label);
    out.push({ label, type, detail, info, apply });
  };
  for (const s of VERILOG_SNIPPETS) push(s.label, 'snippet', s.detail, s.detail, s.apply);
  for (const d of VERILOG_DIRECTIVES) push(d.name, 'macro', 'Directive', d.desc);
  for (const t of VERILOG_SYSTASKS) push(t.name, 'function', 'System task', `${t.format} — ${t.desc}`);
  for (const k of VERILOG_KEYWORDS) push(k.name, 'keyword', k.cat, `${k.format} — ${k.desc}`);
  for (const [path, text] of Object.entries(files)) {
    if (excluded.has(path) || !/\.(?:v|sv|vh|svh)$/i.test(path)) continue;
    for (const m of text.matchAll(/\b(?:module|wire|reg|logic|input|output|inout|parameter|localparam|integer)\s+(?:\[[^\]]+\]\s*)?([A-Za-z_][\w$]*)/g)) {
      push(m[1], 'variable', path, `Declared in ${path}`);
    }
  }
  return out;
}

let toastTimer = null;
function showToast(message, duration = 2200) {
  const el = $('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, duration);
}

function updateHint() {
  const hint = $('hint');
  if (!hint) return;
  const diag = diagnostics.find(d => d.file === current && d.line === cursorState.line);
  if (diag) {
    hint.innerHTML = `<span class="tag">${diag.severity.toUpperCase()}</span>${diag.message.replace(/</g, '&lt;')}`;
    delete hint.dataset.word;
    document.querySelector('.statusbar')?.classList.add('has-hint');
    return;
  }
  const ref = lookupHint(cursorState.lineText, cursorState.word);
  if (ref) {
    hint.innerHTML = `<span class="tag">${ref.category || 'Verilog'}</span><span class="f">${ref.format.replace(/</g, '&lt;')}</span>${ref.desc.replace(/</g, '&lt;')}`;
    hint.dataset.word = ref.name;
    document.querySelector('.statusbar')?.classList.add('has-hint');
    return;
  }
  hint.textContent = 'Ctrl+Click signal/literal to inspect · Ctrl+Space autocomplete';
  delete hint.dataset.word;
  document.querySelector('.statusbar')?.classList.remove('has-hint');
}

function hidePopover() {
  const pop = $('value-popover');
  if (!pop || pop.hidden) return;
  pop.hidden = true;
  nav?.overlayClosed(closePopoverFromHistory);
}
function closePopoverFromHistory() { hidePopover(); }

const escapeHtml = text => String(text).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

function mipsPopoverHtml(decoded, lineNumber) {
  const fieldRows = decoded.fields.map(field => {
    const detail = field.reg ? `${field.value} (${field.reg})` : field.hex ? `${field.value} (${field.hex})` : String(field.value);
    return `<span class="k">${field.name}</span><span class="v mips-field" data-copy="${escapeHtml(field.bits)}"><code>${field.bits}</code> ${escapeHtml(detail)}</span>`;
  }).join('');
  return `
    <div class="ins-h"><span class="ins-t" data-mips-asm>${escapeHtml(decoded.asm)}</span><span class="ins-s">MIPS ${decoded.type}-type · ${decoded.hex} (Ln ${lineNumber})</span><button id="pop-close" class="icon-btn" aria-label="Close">×</button></div>
    <div class="mips-bits" aria-label="Instruction bit fields">${decoded.fields.map(field => `<span class="mips-bitgroup"><code>${field.bits}</code><small>${field.name}</small></span>`).join('')}</div>
    <div class="ins-grid">${fieldRows}</div>
    <div class="ins-acts"><button class="chip" data-copy="${escapeHtml(decoded.asm)}">Copy assembly</button></div>`;
}

function placePopover(pop, coords) {
  pop.hidden = false;
  nav?.overlayOpened(closePopoverFromHistory);
  const maxX = Math.max(8, innerWidth - pop.offsetWidth - 12);
  const maxY = Math.max(8, innerHeight - pop.offsetHeight - 12);
  pop.style.left = `${Math.max(8, Math.min(coords.x + 8, maxX))}px`;
  pop.style.top = `${Math.max(8, Math.min(coords.y + 12, maxY))}px`;
  pop.querySelector('#pop-close').onclick = hidePopover;
  pop.querySelectorAll('[data-copy]').forEach(el => {
    el.onclick = () => navigator.clipboard?.writeText(el.dataset.copy).then(() => showToast(`Copied ${el.dataset.copy}`));
  });
}

function showInspectPopover(token, lineNumber, coords, filename = current) {
  const pop = $('value-popover');
  if (!pop) return;
  const mipsWord = /\.(?:mem|hex|v|sv)$/i.test(filename || '') ? parseMipsWord(token) : null;
  if (mipsWord !== null) {
    pop.innerHTML = mipsPopoverHtml(decodeMips(mipsWord), lineNumber);
    placePopover(pop, coords);
    return;
  }
  const sig = waveform.lookupSignal(token);
  const lit = !sig ? parseVerilogLiteral(token) : null;
  const ref = !sig && !lit ? lookupHint(token, token) : null;
  if (!sig && !lit && !ref) {
    hidePopover();
    return;
  }

  let html = '';
  if (sig) {
    html = `
      <div class="ins-h"><span class="ins-t">${sig.path}</span><span class="ins-s">[${sig.width}b] @ ${sig.time} (${sig.marker})</span><button id="pop-close" class="icon-btn" aria-label="Close">×</button></div>
      <div class="ins-grid">
        <span class="k">Hex</span><span class="v" data-copy="${sig.formatted.hex}">${sig.formatted.hex}</span>
        <span class="k">Unsigned</span><span class="v" data-copy="${sig.formatted.unsigned}">${sig.formatted.unsigned}</span>
        <span class="k">Signed</span><span class="v" data-copy="${sig.formatted.signed}">${sig.formatted.signed}</span>
        <span class="k">Binary</span><span class="v" data-copy="${sig.formatted.bin}">${sig.formatted.bin}</span>
        <span class="k">ASCII</span><span class="v" data-copy="${sig.formatted.ascii}">${sig.formatted.ascii}</span>
      </div>
      <div class="ins-acts">
        <button id="pop-wave" class="chip">Show in Waveform</button>
        <button id="pop-pin" class="chip">${sig.pinned ? 'Unpin' : 'Pin'}</button>
      </div>`;
  } else if (lit) {
    html = `
      <div class="ins-h"><span class="ins-t">${lit.raw}</span><span class="ins-s">${lit.width}-bit literal (Ln ${lineNumber})</span><button id="pop-close" class="icon-btn" aria-label="Close">×</button></div>
      <div class="ins-grid">
        <span class="k">Hex</span><span class="v" data-copy="${lit.hex}">${lit.hex}</span>
        <span class="k">Unsigned</span><span class="v" data-copy="${lit.unsigned}">${lit.unsigned}</span>
        <span class="k">Signed</span><span class="v" data-copy="${lit.signed}">${lit.signed}</span>
        <span class="k">Binary</span><span class="v" data-copy="${lit.bin}">${lit.bin}</span>
      </div>`;
  } else {
    html = `
      <div class="ins-h"><span class="ins-t">${ref.name}</span><span class="ins-s">${ref.category || 'Verilog'}</span><button id="pop-close" class="icon-btn" aria-label="Close">×</button></div>
      <div class="ins-grid">
        <span class="k">Syntax</span><span class="v">${ref.format.replace(/</g, '&lt;')}</span>
        <span class="k">Meaning</span><span class="v">${ref.desc.replace(/</g, '&lt;')}</span>
      </div>`;
  }

  pop.innerHTML = html;
  placePopover(pop, coords);
  const waveBtn = pop.querySelector('#pop-wave');
  if (waveBtn && sig) {
    waveBtn.onclick = () => {
      waveform.selectSignal(sig.path);
      if (layout.getState().dockHidden) layout.update({ dockHidden: false });
      document.querySelector('[data-panel="waveform"]').click();
      if (matchMedia('(max-width: 900px)').matches) selectView('waveform');
      hidePopover();
    };
  }
  const pinBtn = pop.querySelector('#pop-pin');
  if (pinBtn && sig) {
    pinBtn.onclick = () => {
      const nowPinned = waveform.togglePin(sig.path);
      pinBtn.textContent = nowPinned ? 'Unpin' : 'Pin';
    };
  }
}

document.addEventListener('pointerdown', e => {
  const pop = $('value-popover');
  if (pop && !pop.hidden && !pop.contains(e.target)) hidePopover();
});

const groups = new EditorGroups($('editor-groups'), {
  createEditor: (host, { onChange, onPosition }) => createEditor(host, onChange, onPosition, {
    getCompletions: collectCompletions,
    onInspectToken: showInspectPopover,
    onFormat: formatActive,
    onFocus: () => document.body.classList.add('typing'),
    onBlur: () => setTimeout(() => {
      if (!document.activeElement?.closest('.cm-editor')) document.body.classList.remove('typing');
    }, 120),
    onEscape: () => {
      if (layout?.getState().zen) { layout.exitZen(); return true; }
      return false;
    },
  }),
  hasFile: path => Object.hasOwn(files, path),
  getFile: path => files[path],
  getDiagnostics: () => editorDiagnostics(diagnostics),
  onChange: (name, text) => {
    dismissFeatured();
    files[name] = text;
    suggestModules();
    save();
    scheduleFsmRefresh();
    renderHierarchy();
    scheduleLint(name);
    scheduleInline();
  },
  onPosition: (line, col, lineText, word) => {
    $('cursor').textContent = `Ln ${line}, Col ${col}`;
    cursorState = { line, col, lineText: lineText || '', word: word || '' };
    updateHint();
  },
  onActivate: path => {
    if (path && path !== current) {
      current = path;
      renderExplorerSection();
      save();
    }
    updateTitle();
    scheduleInline();
  },
  onOpenMenu: actions => {
    const list = $('group-menu-list');
    list.replaceChildren();
    for (const [label, fn] of actions) {
      const b = document.createElement('button');
      b.textContent = label;
      b.onclick = () => { $('group-menu-dialog').close(); fn(); };
      list.append(b);
    }
    $('group-menu-dialog').showModal();
  },
  onToast: showToast,
});

$('close-group-menu').onclick = () => $('group-menu-dialog').close();

function updateTitle() {
  $('active-file').textContent = `Active: ${current}`;
  $('mobile-title').textContent = current.split('/').at(-1);
}

function renderExplorerSection() {
  updateTitle();
  renderExplorer($('files'), {
    files,
    folders,
    excluded,
    current,
    collapsed,
    hideExcluded,
    open: openFile,
    menu: showActions,
    drop: importDropped,
    toggleBuild: toggleBuildFile,
    onQuickDownload: path => downloadBlob(files[path], path.split('/').at(-1), 'text/plain'),
    onQuickRename: (path, isFolder) => startInlineRename(path, isFolder),
    onQuickDelete: (path, isFolder) => showDelete(path, isFolder),
  });
}

function openFile(name) {
  if (!Object.hasOwn(files, name)) return;
  current = name;
  groups.openFile(name);
  if (matchMedia('(max-width: 900px)').matches) selectView('code');
  render();
  save();
  nav?.record();
}

function toggleBuildFile(path, include) {
  if (include) excluded.delete(path);
  else excluded.add(path);
  refreshRtlProblems();
  suggestModules();
  render();
  save();
}

function render() {
  $('assemble').hidden = !Object.keys(files).some(isAsm);
  renderExplorerSection();
  renderHierarchy();
  groups.refresh();
  groups.setDiagnosticsAll(editorDiagnostics(diagnostics));
  simulationSettings?.render();
  if (!$('tests').hidden) testRunner?.render();
}

$('top-module').addEventListener('input', save);
$('standard').addEventListener('change', save);

let chordK = 0;
document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.shiftKey && e.key.toLowerCase() === 'p') { e.preventDefault(); openPalette(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'f') { e.preventDefault(); openWorkspaceSearch(); return; }
  if (mod && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); layout.toggleDockPosition(); return; }
  if ((mod || e.altKey) && e.shiftKey && e.key.toLowerCase() === 'a') { e.preventDefault(); assembleCommand(); return; }
  if (e.key === 'F12' && !mod && !e.altKey) { e.preventDefault(); goToDefinition(); return; }
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); chordK = Date.now(); return; }
  if (chordK && Date.now() - chordK < 1500 && e.key.toLowerCase() === 'z') { e.preventDefault(); chordK = 0; layout.toggleZen(); return; }
  chordK = 0;
  if (e.key === 'F10') { e.preventDefault(); layout.toggleZen(); }
  else if (e.key === 'F11') { e.preventDefault(); toggleFullscreen(); }
  else if (mod && e.key === '\\') { e.preventDefault(); groups.split(groups.active, 'right'); }
  else if (mod && e.key.toLowerCase() === 'j') { e.preventDefault(); layout.toggleDock(); }
  else if (e.altKey && !mod && e.key === '1') { e.preventDefault(); layout.setMode('edit'); }
  else if (e.altKey && !mod && e.key === '2') { e.preventDefault(); layout.setMode('run'); }
  else if (e.altKey && !mod && e.key === '3') { e.preventDefault(); layout.setMode('wave'); }
  else if (e.key === 'Escape' && layout.getState().zen && !document.querySelector('dialog[open]')) { e.preventDefault(); layout.exitZen(); }
  else if (e.key === 'Escape' && layout.isMaximized() && !document.querySelector('dialog[open]')) { e.preventDefault(); layout.setMaximized(false); }
  else if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); save(); storage.flush(); showToast('Saved locally'); }
  else if (mod && e.key === 'Enter' && !$('run').disabled) { e.preventDefault(); execute('run'); }
  else if (mod && e.key.toLowerCase() === 'b' && !$('compile').disabled) { e.preventDefault(); execute('compile'); }
  else if (e.shiftKey && e.key === 'F5' && !$('stop').disabled) { e.preventDefault(); engine.stop(); }
  else if (e.key === 'F2' && document.activeElement?.dataset.path) { e.preventDefault(); startInlineRename(document.activeElement.dataset.path, document.activeElement.dataset.folder === 'true'); }
});

function pathTaken(path) {
  return Object.hasOwn(files, path) || folders.has(path) || Object.keys(files).some(name => name.startsWith(`${path}/`)) || [...folders].some(name => name.startsWith(`${path}/`));
}
function canCreate(path) {
  return validPath(path) && !pathTaken(path) && !path.split('/').slice(0, -1).some((_, index, parts) => Object.hasOwn(files, parts.slice(0, index + 1).join('/')));
}
function showNewFile(prefix = '') { $('new-name').value = prefix ? `${prefix}/` : ''; $('new-error').textContent = ''; $('new-dialog').showModal(); $('new-name').focus(); }
$('new-file').onclick = () => showNewFile();
$('create-file').onclick = e => {
  const name = $('new-name').value.trim();
  if (!canCreate(name)) { e.preventDefault(); $('new-error').textContent = 'Enter a unique relative file path.'; return; }
  files[name] = '';
  openFile(name);
};
function showNewFolder(prefix = '') { $('folder-name').value = prefix ? `${prefix}/` : ''; $('folder-error').textContent = ''; $('folder-dialog').showModal(); $('folder-name').focus(); }
$('new-folder').onclick = () => showNewFolder();
$('create-folder').onclick = event => {
  const path = $('folder-name').value.trim();
  if (!canCreate(path)) { event.preventDefault(); $('folder-error').textContent = 'Enter a unique relative folder path.'; return; }
  folders.add(path);
  collapsed.delete(path);
  render();
  save();
};
$('collapse-folders').onclick = () => {
  for (const path of [...folders, ...Object.keys(files)]) {
    const parts = path.split('/');
    if (Object.hasOwn(files, path)) parts.pop();
    for (let i = 1; i <= parts.length; i++) collapsed.add(parts.slice(0, i).join('/'));
  }
  render();
};
$('toggle-excluded-visibility').onclick = () => {
  hideExcluded = !hideExcluded;
  $('toggle-excluded-visibility').setAttribute('aria-pressed', String(hideExcluded));
  render();
};

$('import').onclick = () => $('file-input').click();
$('mobile-import').onclick = () => $('file-input').click();
$('file-input').onchange = async event => {
  const selected = [...event.target.files];
  event.target.value = '';
  try {
    const incoming = Object.create(null);
    let size = 0;
    for (const file of selected) {
      size += file.size;
      if (size > 32 * 1024 * 1024) throw new Error('Files exceed 32 MB.');
      incoming[file.name] = await file.text();
    }
    await importEntries(incoming);
  } catch (error) {
    $('save-state').textContent = `Import failed: ${error.message}`;
  }
};

let actionTarget = { path: current, folder: false };
function renamePath(oldPath, newPath, folder) {
  if (oldPath === newPath) return;
  if (!canCreate(newPath) || (folder && newPath.startsWith(`${oldPath}/`))) throw new Error('Enter a unique relative path outside the original folder.');
  const matches = path => path === oldPath || (folder && path.startsWith(`${oldPath}/`));
  const renamed = path => newPath + path.slice(oldPath.length);
  for (const path of Object.keys(files).filter(matches)) {
    const next = renamed(path);
    files[next] = files[path];
    delete files[path];
    if (excluded.delete(path)) excluded.add(next);
  }
  folders = new Set([...folders].map(path => matches(path) ? renamed(path) : path));
  collapsed = new Set([...collapsed].map(path => matches(path) ? renamed(path) : path));
  groups.renamePaths(matches, renamed);
  if (matches(current)) current = renamed(current);
  suggestModules();
  render();
  save();
}

function showRename(path = current, folder = false) {
  actionTarget = { path, folder };
  $('rename-name').value = path;
  $('rename-error').textContent = '';
  $('rename-dialog').showModal();
  $('rename-name').focus();
}
$('rename-file').onclick = () => showRename();
$('confirm-rename').onclick = event => {
  try { renamePath(actionTarget.path, $('rename-name').value.trim(), actionTarget.folder); }
  catch (error) { event.preventDefault(); $('rename-error').textContent = error.message; }
};

function showDelete(path = current, folder = false) {
  actionTarget = { path, folder };
  const matches = name => name === path || (folder && name.startsWith(`${path}/`));
  const count = Object.keys(files).filter(matches).length;
  $('confirm-delete').disabled = count === Object.keys(files).length;
  $('delete-description').textContent = $('confirm-delete').disabled ? 'Keep at least one file in the workspace.' : `Delete ${path}${folder ? ' and its contents' : ''}? This cannot be undone.`;
  $('delete-dialog').showModal();
}
$('delete-file').onclick = () => showDelete();
$('confirm-delete').onclick = () => {
  const { path, folder } = actionTarget;
  const matches = name => name === path || (folder && name.startsWith(`${path}/`));
  for (const name of Object.keys(files).filter(matches)) { delete files[name]; excluded.delete(name); }
  folders = new Set([...folders].filter(name => !matches(name)));
  collapsed = new Set([...collapsed].filter(name => !matches(name)));
  const fallback = Object.keys(files)[0];
  groups.removePaths(matches, fallback);
  if (!Object.hasOwn(files, current)) current = groups.activePath() || fallback;
  suggestModules();
  render();
  save();
};

$('export').onclick = () => downloadBlob(files[current], current.split('/').at(-1), 'text/plain');

function uniquePath(path) {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const split = dot > slash ? dot : path.length;
  let next = path, n = 1;
  while (pathTaken(next)) next = `${path.slice(0, split)}-copy${n++}${path.slice(split)}`;
  return next;
}

function startInlineRename(path, folder) {
  const button = [...$('files').querySelectorAll('[data-path]')].find(item => item.dataset.path === path);
  if (!button) { showRename(path, folder); return; }
  const input = document.createElement('input');
  input.className = 'tree-rename';
  input.value = path;
  input.setAttribute('aria-label', `Rename ${path}`);
  button.replaceWith(input);
  input.focus();
  input.select();
  let finished = false;
  const commit = () => {
    if (finished) return;
    const next = input.value.trim();
    finished = true;
    try {
      renamePath(path, next, folder);
      if (path === next) render();
    } catch (error) {
      finished = false;
      $('save-state').textContent = error.message;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
    }
  };
  input.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); commit(); } else if (event.key === 'Escape') { finished = true; render(); } };
  input.onblur = () => { if (!finished) { finished = true; render(); } };
}

function showActions(path, folder) {
  const matches = name => name === path || (folder && name.startsWith(`${path}/`));
  const entries = Object.keys(files).filter(matches);
  const sources = entries.filter(name => /\.(?:v|sv|asm|s)$/i.test(name));
  const allExcluded = sources.length > 0 && sources.every(name => excluded.has(name));
  $('actions-title').textContent = `${folder ? 'Folder' : 'File'}: ${path}`;
  const list = $('actions-list');
  list.replaceChildren();
  function add(label, action) {
    const button = document.createElement('button');
    button.textContent = label;
    button.onclick = () => { $('actions-dialog').close(); action(); };
    list.append(button);
  }
  if (folder) { add('New file', () => showNewFile(path)); add('New folder', () => showNewFolder(path)); }
  add('Rename', () => startInlineRename(path, folder));
  add('Duplicate', () => {
    const destination = uniquePath(path);
    if (folder) {
      folders.add(destination);
      for (const name of entries) {
        const next = destination + name.slice(path.length);
        files[next] = files[name];
        if (excluded.has(name)) excluded.add(next);
      }
      for (const name of [...folders]) if (name.startsWith(`${path}/`)) folders.add(destination + name.slice(path.length));
    } else {
      files[destination] = files[path];
      if (excluded.has(path)) excluded.add(destination);
    }
    suggestModules();
    render();
    save();
  });
  add('Delete', () => showDelete(path, folder));
  add('Copy path', async () => { try { await navigator.clipboard.writeText(path); $('save-state').textContent = 'Path copied'; } catch { $('save-state').textContent = 'Could not copy path'; } });
  if (!folder) {
    add('Download file', () => downloadBlob(files[path], path.split('/').at(-1), 'text/plain'));
    add('Split right with file', () => { const g = groups.split(groups.active, 'right', { path, view: null }); if (g) save(); });
  }
  if (!folder && /\.(?:v|sv)$/i.test(path)) {
    const firstMod = files[path].match(/\bmodule\s+([a-zA-Z_][\w$]*)/)?.[1];
    if (firstMod) add(`Set "${firstMod}" as Top & Run`, () => {
      excluded.delete(path);
      $('top-module').value = firstMod;
      suggestModules();
      render();
      save();
      if (!$('run').disabled) execute('run');
    });
  }
  if (sources.length) add(allExcluded ? 'Include in build' : 'Exclude from build', () => {
    for (const name of sources) { if (allExcluded) excluded.delete(name); else excluded.add(name); }
    suggestModules();
    render();
    save();
  });
  $('actions-dialog').showModal();
}
$('close-actions').onclick = () => $('actions-dialog').close();

function downloadBlob(data, filename, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function chooseConflict(count) {
  return new Promise(resolve => {
    const dialog = $('conflict-dialog');
    $('conflict-description').textContent = `${count} file${count === 1 ? '' : 's'} already exist. Choose how to handle conflicts.`;
    let finished = false;
    const finish = value => { if (finished) return; finished = true; dialog.close(); resolve(value); };
    dialog.querySelectorAll('[data-conflict]').forEach(button => { button.onclick = () => finish(button.dataset.conflict); });
    dialog.oncancel = event => { event.preventDefault(); finish('cancel'); };
    dialog.showModal();
  });
}

async function importEntries(incoming, incomingFolders = [], incomingExcluded = []) {
  const entries = Object.entries(incoming);
  if (entries.some(([path, text]) => !validPath(path) || typeof text !== 'string')) throw new Error('Import contains an invalid file path.');
  if (incomingFolders.some(path => !validPath(path))) throw new Error('Import contains an invalid folder path.');
  const conflicts = entries.filter(([path]) => pathTaken(path)).length;
  const choice = conflicts ? await chooseConflict(conflicts) : 'overwrite';
  if (choice === 'cancel') return false;
  for (const path of incomingFolders) { if (!Object.hasOwn(files, path)) folders.add(path); }
  let last = null;
  for (const [original, content] of entries) {
    let path = original;
    if (pathTaken(path)) {
      if (choice === 'skip') continue;
      if (choice === 'keep') path = uniquePath(path);
      else if (!Object.hasOwn(files, path)) continue;
    } else if (!canCreate(path)) continue;
    files[path] = content;
    if (incomingExcluded.includes(original)) excluded.add(path);
    else excluded.delete(path);
    last = path;
  }
  suggestModules();
  if (last) openFile(last);
  else { render(); save(); }
  return last !== null || incomingFolders.length > 0;
}

async function importDropped(transfer, prefix = '') {
  try {
    const singleZip = !prefix && transfer.files?.length === 1 && /\.zip$/i.test(transfer.files[0].name);
    if (singleZip) {
      const f = transfer.files[0];
      if (f.size > 32 * 1024 * 1024) throw new Error('Archive exceeds 32 MB.');
      const project = readArchive(await f.arrayBuffer());
      await importEntries(project.files, project.folders, project.excluded);
      return;
    }
    const incoming = Object.create(null);
    const incomingFolders = [];
    let total = 0, count = 0;
    async function visit(entry, path) {
      if (++count > 5000 || !validPath(path)) throw new Error('Drop contains too many entries or an invalid path.');
      if (entry.isFile) {
        const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
        total += file.size;
        if (total > 32 * 1024 * 1024) throw new Error('Dropped files exceed 32 MB.');
        incoming[path] = await file.text();
      } else if (entry.isDirectory) {
        incomingFolders.push(path);
        const reader = entry.createReader();
        for (;;) {
          const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
          if (!batch.length) break;
          for (const child of batch) await visit(child, `${path}/${child.name}`);
        }
      }
    }
    const entries = [...(transfer.items || [])].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    if (entries.length) {
      for (const entry of entries) await visit(entry, prefix ? `${prefix}/${entry.name}` : entry.name);
    } else {
      for (const file of transfer.files || []) {
        total += file.size;
        if (total > 32 * 1024 * 1024) throw new Error('Dropped files exceed 32 MB.');
        incoming[prefix ? `${prefix}/${file.name}` : file.name] = await file.text();
      }
    }
    await importEntries(incoming, incomingFolders);
  } catch (error) {
    $('save-state').textContent = `Import failed: ${error.message}`;
  }
}

$('files').ondragover = event => { event.preventDefault(); $('files').classList.add('is-dragover'); };
$('files').ondragleave = event => { if (!$('files').contains(event.relatedTarget)) $('files').classList.remove('is-dragover'); };
$('files').ondrop = event => { event.preventDefault(); $('files').classList.remove('is-dragover'); importDropped(event.dataTransfer); };

// Fullscreen file drop overlay
let dragDepth = 0;
const hasNativeFiles = e => e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files');
document.addEventListener('dragenter', e => {
  if (!hasNativeFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $('dropzone').classList.add('on');
});
document.addEventListener('dragover', e => { if (hasNativeFiles(e)) e.preventDefault(); });
document.addEventListener('dragleave', e => {
  if (!hasNativeFiles(e)) return;
  if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').classList.remove('on'); }
});
document.addEventListener('drop', e => {
  if (!hasNativeFiles(e)) return;
  if ($('files').contains(e.target)) { dragDepth = 0; $('dropzone').classList.remove('on'); return; }
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').classList.remove('on');
  importDropped(e.dataTransfer);
});

$('import-project').onclick = () => $('project-input').click();
$('project-input').onchange = async event => {
  const file = event.target.files[0];
  event.target.value = '';
  if (!file) return;
  try {
    if (file.size > 32 * 1024 * 1024) throw new Error('Archive exceeds 32 MB.');
    const project = readArchive(await file.arrayBuffer());
    await importEntries(project.files, project.folders, project.excluded);
  } catch (error) {
    $('save-state').textContent = `Import failed: ${error.message}`;
  }
};
$('export-project').onclick = () => {
  try {
    const archive = createArchive(files, folders, excluded, waveform.currentVcd());
    downloadBlob(archive, 'datapath-workspace.zip', 'application/zip');
  } catch (error) {
    $('save-state').textContent = `Export failed: ${error.message}`;
  }
};

$('templates').onclick = () => openShowcase();
$('close-templates').onclick = () => $('template-dialog').close();
const templates = {
  blank: { 'examples/blank/design.v': 'module design;\nendmodule\n' },
  counter: {
    'examples/counter/counter.v': 'module example_counter(input clk, input reset, output reg [3:0] count);\n  always @(posedge clk) if (reset) count <= 0; else count <= count + 1;\nendmodule\n',
    'examples/counter/tb.v': 'module counter_tb;\n  reg clk = 0, reset = 1; wire [3:0] count;\n  example_counter dut(clk, reset, count);\n  always #5 clk = ~clk;\n  initial begin #10 reset = 0; #50 $finish; end\nendmodule\n',
  },
  rom: {
    'examples/rom/rom.v': 'module example_rom(output [7:0] value);\n  reg [7:0] mem [0:1];\n  initial $readmemh("examples/rom/data.mem", mem);\n  assign value = mem[0];\nendmodule\n',
    'examples/rom/tb.v': 'module rom_tb; wire [7:0] value; example_rom dut(value);\n  initial begin #1 $display("value=%h", value); $finish; end\nendmodule\n',
    'examples/rom/data.mem': '2a\nff\n',
  },
};
// ---------------------------------------------------------------- Showcase projects
const TAG_HUES = 5;
const tagHue = tag => [...tag].reduce((sum, ch) => (sum * 31 + ch.charCodeAt(0)) >>> 0, 7) % TAG_HUES;
function renderShowcaseCards() {
  $('showcase-grid').replaceChildren(...SHOWCASE_PROJECTS.map(project => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'showcase-card';
    card.dataset.project = project.id;
    const title = document.createElement('span');
    title.className = 'showcase-title';
    title.textContent = project.title;
    const sub = document.createElement('span');
    sub.className = 'showcase-sub';
    sub.textContent = project.subtitle;
    const tags = document.createElement('span');
    tags.className = 'showcase-tags';
    tags.append(...project.tags.map(tag => {
      const pill = document.createElement('span');
      pill.className = `showcase-tag t${tagHue(tag)}`;
      pill.textContent = tag;
      return pill;
    }));
    const note = document.createElement('span');
    note.className = 'showcase-note';
    note.textContent = 'Replaces workspace';
    card.append(title, sub, tags, note);
    card.setAttribute('aria-label', `${project.title}: ${project.subtitle} Replaces workspace.`);
    card.onclick = () => loadShowcaseProject(project.id);
    return card;
  }));
}
renderShowcaseCards();

// Replace the workspace with a fresh copy of a showcase project and point the UI at its feature.
function loadShowcaseProject(id, { silent = false } = {}) {
  const project = showcaseProject(id);
  if (!project) return false;
  dismissFeatured();
  activeShowcaseId = id;
  if ($('template-dialog').open) $('template-dialog').close();
  if (board?.isLive()) board.stopLive();
  files = Object.assign(Object.create(null), project.files);
  folders = new Set();
  excluded = new Set();
  collapsed = new Set();
  current = Object.hasOwn(files, project.openFile) ? project.openFile : Object.keys(files)[0];
  diagnostics = [];
  icarusDiagnostics = [];
  lastElaboratedJson = null;
  renderProblems([]);
  consoleOverride = null;
  waveform.clearVcd();
  $('top-module').value = project.topModule || '';
  groups.removePaths(() => true, current);
  suggestModules();
  openFile(current);
  if (!silent && !matchMedia('(max-width: 900px)').matches && !layout.getState().dockHidden && project.dockTab) {
    document.querySelector(`[data-panel="${project.dockTab}"]`)?.click();
  }
  schematic?.render();
  const schemSelect = $('schem-module');
  if (project.schematicModule && [...schemSelect.options].some(option => option.value === project.schematicModule)) schemSelect.value = project.schematicModule;
  if (!$('tests').hidden) testRunner?.render();
  save();
  storage.flush();
  $('save-state').textContent = `Loaded showcase: ${project.title}`;
  if (!silent) showToast(project.tryNext, 6000);
  return true;
}
function resetCleanWorkspace() {
  if (board?.isLive()) board.stopLive();
  activeShowcaseId = null;
  files = Object.assign(Object.create(null), defaults);
  folders = new Set();
  excluded = new Set();
  collapsed = new Set();
  current = 'design.v';
  diagnostics = [];
  icarusDiagnostics = [];
  lastElaboratedJson = null;
  renderProblems([]);
  consoleOverride = null;
  waveform.clearVcd();
  $('top-module').value = '';
  groups.removePaths(() => true, current);
  suggestModules();
  openFile(current);
  if (!matchMedia('(max-width: 900px)').matches && !layout.getState().dockHidden) showPanel('console');
  schematic?.render();
  save();
  storage.flush();
  $('save-state').textContent = 'Clean workspace ready';
  showToast('Started a clean Verilog workspace');
}
function openShowcase() {
  $('template-dialog').showModal();
  $('showcase-grid').querySelector('.showcase-card')?.focus();
}
$('open-showcase')?.addEventListener('click', openShowcase);

document.querySelectorAll('[data-template]').forEach(button => {
  button.onclick = async () => {
    $('template-dialog').close();
    if (button.dataset.template === 'mips') {
      // Ready to run: sources stay in the build and the testbench becomes the top module.
      if (await importEntries(MIPS_TEMPLATE)) {
        $('top-module').value = MIPS_TEMPLATE_TOP;
        if (Object.hasOwn(files, 'program.asm')) openFile('program.asm');
        save();
        showToast('MIPS32 template added — edit program.asm and press Ctrl+Enter');
      }
      return;
    }
    const template = templates[button.dataset.template];
    if (await importEntries(template, [], Object.keys(template).filter(path => /\.(?:v|sv)$/i.test(path)))) {
      $('save-state').textContent = 'Template added; its source files are excluded until included in the build.';
    }
  };
});

document.querySelectorAll('[data-panel]').forEach(button => button.onclick = event => {
  if (event.isTrusted && innerWidth > 900) outputOpened = true;
  document.querySelectorAll('[data-panel]').forEach(b => {
    b.classList.toggle('selected', b === button);
    b.setAttribute('aria-selected', String(b === button));
  });
  for (const name of ['problems', 'console', 'waveform', 'tests', 'hw-state', 'board', 'schematic']) $(name).hidden = name !== button.dataset.panel;
  if (button.dataset.panel === 'schematic') schematic?.render();
  if (button.dataset.panel === 'tests') testRunner?.render();
  if (button.dataset.panel === 'hw-state') hwState?.render();
  if (button.dataset.panel === 'board') board?.render();
  if (button.dataset.panel === 'waveform') waveform?.repaint();
  if (innerWidth <= 900) setMobileView('console');
  nav?.record();
});

function setMobileView(view) {
  document.body.dataset.view = view;
  document.querySelectorAll('button[data-view]').forEach(item => {
    const selected = item.dataset.view === view;
    item.classList.toggle('active', selected);
    if (selected) item.setAttribute('aria-current', 'page');
    else item.removeAttribute('aria-current');
  });
}
function selectView(view) {
  setMobileView(view);
  if (view === 'console' || view === 'waveform') { document.querySelector(`[data-panel="${view}"]`).click(); setMobileView(view); }
  nav?.record();
}
document.querySelectorAll('button[data-view]').forEach(button => button.onclick = () => selectView(button.dataset.view));

// Fullscreen toggle
function toggleFullscreen() {
  const doc = document;
  if (!doc.fullscreenElement && !doc.webkitFullscreenElement) {
    (doc.documentElement.requestFullscreen || doc.documentElement.webkitRequestFullscreen)?.call(doc.documentElement)?.catch?.(() => {});
  } else {
    (doc.exitFullscreen || doc.webkitExitFullscreen)?.call(doc)?.catch?.(() => {});
  }
}
$('toggle-fullscreen')?.addEventListener('click', toggleFullscreen);

// Reference Card Help Dialog
const HELP_TABS = [['card', 'Quick Card'], ['keywords', 'Keywords'], ['systasks', 'System Tasks'], ['directives', 'Directives'], ['shortcuts', 'Shortcuts']];
function renderHelpDialog() {
  const tabsEl = $('help-tabs');
  tabsEl.replaceChildren();
  for (const [id, label] of HELP_TABS) {
    const btn = document.createElement('button');
    btn.className = `chip${helpTab === id ? ' active' : ''}`;
    btn.textContent = label;
    btn.onclick = () => { helpTab = id; renderHelpDialog(); };
    tabsEl.append(btn);
  }
  const q = $('help-filter').value;
  const body = $('help-body');
  body.replaceChildren();

  const addItem = (title, desc, example = '') => {
    const row = document.createElement('div');
    row.className = 'hitem';
    const f = document.createElement('div');
    f.className = 'f';
    f.textContent = title;
    const d = document.createElement('div');
    d.className = 'd';
    d.textContent = desc;
    row.append(f, d);
    if (example) {
      const pre = document.createElement('pre');
      pre.textContent = example;
      row.append(pre);
    }
    body.append(row);
  };

  const res = searchRef(q, helpTab);
  if (helpTab === 'shortcuts') {
    for (const [k, d] of res) addItem(k, d);
  } else if (helpTab === 'card') {
    for (const op of res.operators) addItem(`${op.op} — ${op.name}`, op.desc);
    for (const st of res.systasks) addItem(st.format, st.desc);
    for (const dr of res.directives) addItem(dr.format, dr.desc);
    for (const kw of res.keywords) addItem(kw.format, kw.desc, kw.example);
  } else {
    for (const item of res) addItem(item.format, item.desc, item.example);
  }
}
function openHelp(initialFilter = '') {
  $('help-filter').value = initialFilter;
  renderHelpDialog();
  $('help-dialog').showModal();
  $('help-filter').focus();
}
$('open-help')?.addEventListener('click', () => openHelp(''));
$('close-help')?.addEventListener('click', () => $('help-dialog').close());
$('help-filter')?.addEventListener('input', renderHelpDialog);
$('hint')?.addEventListener('click', () => openHelp($('hint').dataset.word || ''));

// Mobile Touch Verilog Keybar
const KB_KEYS = [
  ['kbd', '⌨', 'Hide keyboard'], ['esc', 'Esc', 'Escape'], ['tab', '⇥', 'Indent'], ['untab', '⇤', 'Dedent'],
  ['left', '←', 'Left'], ['right', '→', 'Right'], ['up', '↑', 'Up'], ['down', '↓', 'Down'],
  ['<=', '<=', 'Nonblocking'], ['[', '['], [']', ']'], ['{', '{'], ['}', '}'], ['(', '('], [')', ')'],
  ["'h", "'h"], ["'b", "'b"], [';', ';'], [':', ':'], [',', ','], ['$', '$'], ['`', '`'], ['=', '='],
  ['comment', '//', 'Toggle comment'], ['undo', '↶', 'Undo'], ['redo', '↷', 'Redo'],
  ['size', 'Aa', 'Key size'], ['rows', '⇕', '1 / 2 rows'], ['hide', '⌄', 'Hide key row'],
];

function renderKeybar() {
  const bar = $('keybar');
  bar.replaceChildren();
  let repeat = null, delay = null, moved = false, startX = 0;
  const stop = () => { clearTimeout(delay); clearInterval(repeat); delay = repeat = null; };

  const runKey = k => {
    if (k === 'hide') {
      layout.update({ keybarOn: false });
      document.body.classList.remove('typing');
      showToast('Key row hidden — re-enable in More or Settings');
      return;
    }
    const ed = groups.activeEditor();
    if (!ed) return;
    if (k === 'kbd') { ed.blur(); document.body.classList.remove('typing'); return; }
    if (k === 'esc') { ed.closeCompletion(); return; }
    if (k === 'tab') { ed.indent(); return; }
    if (k === 'untab') { ed.dedent(); return; }
    if (k === 'left' || k === 'right' || k === 'up' || k === 'down') { ed.moveCursor(k); return; }
    if (k === 'comment') { ed.toggleComment(); return; }
    if (k === 'undo') { ed.undo(); return; }
    if (k === 'redo') { ed.redo(); return; }
    if (k === 'size') {
      const next = { s: 'm', m: 'l', l: 's' }[layout.getState().kbSize || 'm'];
      layout.update({ kbSize: next });
      showToast(`Key size: ${next.toUpperCase()}`);
      return;
    }
    if (k === 'rows') {
      const next = layout.getState().kbRows === 2 ? 1 : 2;
      layout.update({ kbRows: next });
      return;
    }
    ed.insertText(k);
  };

  for (const [k, label, title] of KB_KEYS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.kbKey = k;
    b.textContent = label;
    if (title) { b.title = title; b.setAttribute('aria-label', title); }
    if (/^(left|right|up|down)$/.test(k)) b.classList.add('nav');
    if (['size', 'rows', 'hide', 'kbd'].includes(k)) b.classList.add('meta');
    if (k === 'hide') b.dataset.keybarHide = '';
    let handled = false;
    b.addEventListener('pointerdown', e => {
      e.preventDefault();
      b.classList.add('down');
      if (b.classList.contains('nav')) {
        runKey(k);
        delay = setTimeout(() => { repeat = setInterval(() => runKey(k), 55); }, 360);
        handled = true;
      } else handled = false;
    });
    b.addEventListener('pointerup', () => { b.classList.remove('down'); stop(); if (!handled && !moved) runKey(k); });
    b.addEventListener('pointerleave', () => { b.classList.remove('down'); stop(); });
    b.addEventListener('pointercancel', () => { b.classList.remove('down'); stop(); });
    bar.append(b);
  }
  bar.addEventListener('pointerdown', e => { startX = e.clientX; moved = false; }, true);
  bar.addEventListener('pointermove', e => { if (Math.abs(e.clientX - startX) > 10) { moved = true; stop(); } }, true);
  bar.addEventListener('scroll', updateKbFade, { passive: true });
  updateKbFade();
}

function updateKbFade() {
  const bar = $('keybar');
  if (!bar) return;
  bar.classList.toggle('more-left', bar.scrollLeft > 4);
  bar.classList.toggle('more-right', bar.scrollLeft + bar.clientWidth < bar.scrollWidth - 4);
}

const VK = navigator.virtualKeyboard;
let vkOverlay = false;
if (VK) { try { VK.overlaysContent = true; vkOverlay = VK.overlaysContent === true; } catch { /* ignore */ } }
const VIEWPORT_STATE = { fullH: window.innerHeight, width: window.innerWidth };
function fitViewport() {
  const narrow = window.matchMedia('(max-width: 900px)').matches;
  const vv = window.visualViewport;
  const r = VK && VK.boundingRect;
  let h = window.innerHeight;
  let top = 0;
  if (vkOverlay && r && r.height > 0 && r.top > 0) h = Math.round(r.top);
  else if (!vkOverlay && vv) { h = Math.round(vv.height); top = Math.round(vv.offsetTop); }

  if (narrow) {
    document.body.style.height = `${h}px`;
    document.body.style.transform = top ? `translateY(${top}px)` : '';
  } else {
    document.body.style.height = '';
    document.body.style.transform = '';
  }

  if (VIEWPORT_STATE.width !== window.innerWidth) {
    VIEWPORT_STATE.width = window.innerWidth;
    VIEWPORT_STATE.fullH = window.innerHeight;
  } else if (!document.activeElement?.matches('input, textarea') || window.innerHeight > VIEWPORT_STATE.fullH) {
    if (window.innerHeight >= VIEWPORT_STATE.fullH - 80 || !document.body.classList.contains('keyboard-open')) {
      VIEWPORT_STATE.fullH = window.innerHeight;
    }
  }
  const keyboard = !narrow ? 0 : vkOverlay
    ? (r && r.height > 0 && r.top > 0 ? Math.max(0, window.innerHeight - h) : 0)
    : Math.max(0, VIEWPORT_STATE.fullH - h - top);
  document.body.classList.toggle('keyboard-open', keyboard > 80);
  document.body.style.setProperty('--keyboard-cover', `${keyboard}px`);
  requestAnimationFrame(updateKbFade);
}
if (VK) VK.addEventListener('geometrychange', fitViewport);
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', fitViewport);
  window.visualViewport.addEventListener('scroll', fitViewport);
}
window.addEventListener('resize', fitViewport);

// About dialog
function openAbout() {
  for (const id of ['settings-dialog', 'more-dialog']) if ($(id).open) $(id).close();
  $('about-dialog').showModal();
}
$('open-about').onclick = openAbout;
$('close-about').onclick = () => $('about-dialog').close();
$('settings-about').onclick = openAbout;

// Mobile More Sheet
function openMoreSheet() {
  const s = layout.getState();
  const grid = $('more-grid');
  grid.replaceChildren();
  const items = [
    ['Key row: ' + (s.keybarOn ? 'On' : 'Off'), () => {
      layout.update({ keybarOn: !s.keybarOn });
      showToast(s.keybarOn ? 'Key row hidden' : 'Key row shown while typing');
    }],
    ['Settings', () => $('preferences').click()],
    ['Verilog Card', () => openHelp('')],
    ['Command Palette', openPalette],
    ['Import Files', () => $('file-input').click()],
    ['Import ZIP', () => $('project-input').click()],
    ['Export ZIP', () => $('export-project').click()],
    ['Showcase Projects…', openShowcase],
    ['Interactive Hardware Tour', () => tour?.start(0)],
    ['Zen Mode', () => layout.toggleZen()],
    ['About Datapath Studio', openAbout],
  ];
  for (const [label, fn] of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.onclick = () => { $('more-dialog').close(); fn(); };
    grid.append(b);
  }
  $('more-dialog').showModal();
}
$('mobile-more')?.addEventListener('click', openMoreSheet);
$('close-more')?.addEventListener('click', () => $('more-dialog').close());

groups.restore(current);
render();
suggestModules();
renderKeybar();
const layout = installLayout(groups, () => requestAnimationFrame(() => { updateKbFade(); refreshInline(); }));
fitViewport();
simulationSettings = installSimSettings(() => files, () => excluded, (path, isExcluded) => {
  if (isExcluded) excluded.add(path);
  else excluded.delete(path);
  refreshRtlProblems();
  suggestModules();
  render();
  save();
});
waveform = installWaveform(showToast);
// Re-extract FSM encodings from the current RTL whenever a trace (run, test or opened VCD) loads.
waveform.store.subscribe((state, kind) => { if (kind === 'trace' && state.trace) refreshFsmStates(); if (['trace', 'cursor', 'layout'].includes(kind)) scheduleInline(); });
$('wave-radix').addEventListener('change', scheduleInline);
const log = new ConsoleBuffer();

function engineStatus(text, stateClass = '') {
  document.querySelectorAll('.engine-state').forEach(item => { item.textContent = text; });
  document.body.classList.remove('st-ready', 'st-running', 'st-done', 'st-error');
  if (stateClass) document.body.classList.add(stateClass);
}

function setBusy(busy) {
  $('run').disabled = busy;
  $('compile').disabled = busy;
  $('zen-run').disabled = busy;
  $('stop').disabled = !busy;
  document.body.classList.toggle('is-running', busy);
}

// Lines are grouped into plain text runs; only PASS/FAIL/WARNING lines get a span, so textContent stays the raw log.
const CONSOLE_CLASSES = [[/\b(?:FAIL(?:ED|URE|S)?|ERROR)\b/i, 'con-fail'], [/\bWARN(?:ING)?\b/i, 'con-warn'], [/\bPASS(?:ED|ES)?\b/i, 'con-pass']];
function renderConsoleText(target, text, filter = '') {
  const needle = filter.trim().toLowerCase();
  const fragment = document.createDocumentFragment();
  let plain = '';
  const lines = text.split(/(?<=\n)/);
  for (const line of lines) {
    if (needle && !line.toLowerCase().includes(needle)) continue;
    const cls = CONSOLE_CLASSES.find(([re]) => re.test(line))?.[1];
    if (!cls) { plain += line; continue; }
    if (plain) { fragment.append(plain); plain = ''; }
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = line;
    fragment.append(span);
  }
  if (plain) fragment.append(plain);
  target.replaceChildren(fragment);
}
let consoleOverride = null;   // a batch-test log shown in place of the live log
function showConsole() {
  const out = $('console-output');
  const text = consoleOverride ?? `${log.truncated ? '[Earlier output truncated]\n' : ''}${log.text}`;
  renderConsoleText(out, text, $('console-filter').value);
  if (layout.getState().autoScrollConsole) out.scrollTop = out.scrollHeight;
}
$('console-filter').addEventListener('input', showConsole);
$('clear-console').onclick = () => { consoleOverride = null; log.clear(); showConsole(); };
$('copy-console').onclick = async () => {
  try { await navigator.clipboard.writeText($('console-output').textContent); showToast('Console copied'); }
  catch { showToast('Could not copy console'); }
};

function jumpToLine(file, line) {
  if (Object.hasOwn(files, file)) current = file;
  groups.jump(file, line);
  renderExplorerSection();
}

function editorDiagnostics(items) { return items.map(item => item.rule ? { ...item, message: `[${item.rule}] ${item.message}${item.hint ? ` — ${item.hint}` : ''}` } : item); }

function renderProblems(items, summary = '') {
  groups.setDiagnosticsAll(editorDiagnostics(items));
  updateHint();
  const tab = document.querySelector('[data-panel="problems"]');
  tab.textContent = items.length ? `Problems (${items.length})` : 'Problems';
  const panel = $('problems');
  panel.replaceChildren();
  if (!items.length && !summary) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    const h2 = document.createElement('h2');
    h2.textContent = 'No diagnostics';
    const p = document.createElement('p');
    p.textContent = 'Compiler errors and warnings will appear here.';
    empty.append(h2, p);
    panel.append(empty);
    return;
  }
  if (summary) {
    const p = document.createElement('p');
    p.className = 'problem-summary';
    p.textContent = summary;
    panel.append(p);
  }
  const list = document.createElement('div');
  list.className = 'problem-list';
  for (const item of items) {
    const btn = document.createElement('button');
    btn.className = `problem-item is-${item.severity === 'warning' ? 'warning' : 'error'}`;
    const sev = document.createElement('span');
    sev.className = 'problem-sev';
    sev.textContent = item.severity.toUpperCase();
    const loc = document.createElement('span');
    loc.className = 'problem-loc';
    loc.textContent = `${item.file}:${item.line}`;
    const detail = document.createElement('span');
    detail.className = 'problem-detail';
    if (item.rule) { const rule = document.createElement('span'); rule.className = 'problem-rule'; rule.textContent = `[${item.rule}]`; detail.append(rule, ' '); }
    const msg = document.createElement('span'); msg.textContent = item.message; detail.append(msg);
    if (item.hint) { const hint = document.createElement('small'); hint.className = 'problem-hint'; hint.textContent = item.hint; detail.append(hint); }
    btn.append(sev, loc, detail);
    btn.onclick = () => jumpToLine(item.file, item.line);
    list.append(btn);
  }
  panel.append(list);
}

const engineReadyWaiters = [];
const simRunWaiters = [];
let suppressNextAutoWave = false;
function resolveSimWaiters(outcome) {
  while (simRunWaiters.length) simRunWaiters.shift()(outcome);
}
function waitEngineReady() {
  if (engine.ready) return Promise.resolve();
  return new Promise(resolve => engineReadyWaiters.push(resolve));
}

const engine = new EngineClient(() => new Worker('./simulator-worker.js', { type: 'module' }), event => {
  if (event.type === 'ready') {
    setBusy(false);
    engineStatus('Icarus WASM ready', 'st-ready');
    $('console-output').textContent ||= 'Ready.';
    while (engineReadyWaiters.length) engineReadyWaiters.shift()();
  } else if (event.type === 'status') {
    engineStatus(`${event.phase}…`, 'st-running');
  } else if (event.type === 'diagnostics') {
    icarusDiagnostics = event.items || [];
    refreshRtlProblems();
  } else if (event.type === 'output') {
    consoleOverride = null;
    log.append(event.chunk);
    showConsole();
  } else if (event.type === 'result') {
    setBusy(false);
    engineStatus('Complete', 'st-done');
    const suppressWave = suppressNextAutoWave;
    suppressNextAutoWave = false;
    if (event.memTrace && !event.vcdFiles?.length) {
      waveform.store.loadMemTrace(event.memTrace);
      if (!suppressWave) showToast(`Captured ${event.memTrace.arrays.length} memory array${event.memTrace.arrays.length === 1 ? '' : 's'} — see the State tab`);
    }
    if (event.vcdFiles?.length) {
      try {
        waveform.loadVcd(event.vcdFiles[0].data, event.vcdFiles[0].path);
        if (event.memTrace) waveform.store.loadMemTrace(event.memTrace);
        if (!suppressWave && layout.getState().autoSwitchWave) {
          document.querySelector('[data-panel="waveform"]').click();
          if (matchMedia('(max-width: 900px)').matches) selectView('waveform');
        } else if (!suppressWave) {
          showToast(`Waveform ready (${event.vcdFiles[0].path})`);
        }
      } catch (error) {
        log.append(`\nWaveform: ${error.message}\n`);
        showConsole();
      }
    }
    resolveSimWaiters({ ok: true, event });
  } else if (event.type === 'error') {
    setBusy(false);
    suppressNextAutoWave = false;
    engineStatus('Error', 'st-error');
    log.append(`\n${event.message}\n`);
    showConsole();
    renderProblems(diagnostics, event.message);
    if (layout.getState().dockHidden) layout.update({ mode: 'custom', dockHidden: false });
    document.querySelector('[data-panel="problems"]').click();
    if (matchMedia('(max-width: 900px)').matches) {
      selectView('console');
      document.querySelector('[data-panel="problems"]').click();
    }
    resolveSimWaiters({ ok: false, event });
  } else if (event.type === 'stopped') {
    suppressNextAutoWave = false;
    engineStatus('Force-stopped; restarting engine', 'st-error');
    $('run').disabled = true;
    $('compile').disabled = true;
    $('zen-run').disabled = true;
    $('stop').disabled = true;
    document.body.classList.remove('is-running');
    log.append('\nSimulation force-stopped; partial waveform unavailable.\n');
    showConsole();
    resolveSimWaiters({ ok: false, event });
  } else if (event.type === 'engine-error') {
    setBusy(true);
    suppressNextAutoWave = false;
    $('stop').disabled = true;
    engineStatus('Engine unavailable', 'st-error');
    log.append(`\n${event.message}\n`);
    showConsole();
    resolveSimWaiters({ ok: false, event });
  }
});

function execute(type, { suppressAutoWave = false, quiet = false } = {}) {
  if (!quiet) dismissFeatured();
  cancelLint();
  if (!engine.ready || engine.activeRunId !== null) return false;
  let settings;
  try {
    settings = simulationSettings.snapshot();
  } catch (error) {
    engineStatus('Error', 'st-error');
    log.clear();
    log.append(error.message);
    showConsole();
    document.querySelector('[data-panel="console"]').click();
    if (matchMedia('(max-width: 900px)').matches) selectView('console');
    return false;
  }
  if (!assembleBeforeBuild()) return false;
  log.limit = settings.outputCap;
  consoleOverride = null;
  if (layout.getState().autoClearConsole) log.clear();
  else if (log.text) log.append('\n--- Run ---\n');
  showConsole();
  waveform.clearVcd();
  icarusDiagnostics = [];
  refreshRtlProblems();
  suppressNextAutoWave = suppressAutoWave;
  setBusy(true);
  engineStatus('Starting…', 'st-running');
  if (!quiet) {
    if (layout.getState().dockHidden) layout.update({ mode: 'custom', dockHidden: false });
    document.querySelector('[data-panel="console"]').click();
    if (matchMedia('(max-width: 900px)').matches) selectView('console');
  }
  try {
    engine.run({ type, files: { ...files }, ...settings, topModule: $('top-module').value, standard: $('standard').value });
    return true;
  } catch (error) {
    suppressNextAutoWave = false;
    setBusy(false);
    engineStatus('Error', 'st-error');
    log.append(error.message);
    showConsole();
    return false;
  }
}

$('run').onclick = () => execute('run');
$('zen-run').onclick = () => execute('run');
$('compile').onclick = () => execute('compile');
$('stop').onclick = () => engine.stop();

// Command Palette
let paletteIndex = 0;
let paletteItems = [];
function buildCommands() {
  const s = layout.getState();
  return [
    { label: 'Mode: Edit', hint: 'Alt+1', run: () => layout.setMode('edit') },
    { label: 'Mode: Run / Debug', hint: 'Alt+2', run: () => layout.setMode('run') },
    { label: 'Mode: Waveform Focus', hint: 'Alt+3', run: () => layout.setMode('wave') },
    { label: s.zen ? 'Exit Zen Mode' : 'Enter Zen Mode', hint: 'F10 / Ctrl+K Z', run: () => layout.toggleZen() },
    { label: 'Toggle Fullscreen', hint: 'F11', run: toggleFullscreen },
    { label: 'Editor: Split Right', hint: 'Ctrl+\\', run: () => groups.split(groups.active, 'right') },
    { label: 'Editor: Split Down', hint: '', run: () => groups.split(groups.active, 'bottom') },
    { label: groups.maximized ? 'Editor: Restore All Panes' : 'Editor: Maximize Active Pane', hint: '', run: () => groups.maximize() },
    { label: 'Editor: Next Group', hint: '', run: () => groups.nextGroup() },
    { label: s.explorerHidden ? 'Show Explorer' : 'Hide Explorer', hint: '', run: () => layout.update({ mode: 'custom', explorerHidden: !s.explorerHidden }) },
    { label: s.dockHidden ? 'Show Output Panel' : 'Hide Output Panel', hint: 'Ctrl+J', run: () => layout.toggleDock() },
    { label: s.dockPosition === 'right' ? 'Dock Output: Bottom' : 'Dock Output: Right (Side-by-Side)', hint: 'Ctrl+Shift+D', run: () => layout.toggleDockPosition() },
    { label: s.inspectorHidden ? 'Show Inspector' : 'Hide Inspector', hint: '', run: () => layout.update({ mode: 'custom', inspectorHidden: !s.inspectorHidden }) },
    { label: 'Maximize / Restore Output', hint: '', run: () => $('maximize-dock').click() },
    { label: 'Verilog Reference Card', hint: '', run: () => openHelp('') },
    { label: `Toggle Word Wrap (${s.wrap ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ wrap: !s.wrap }) },
    { label: `Toggle Line Numbers (${s.showLineNumbers ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ showLineNumbers: !s.showLineNumbers }) },
    { label: `Toggle Fold Gutter (${s.showFoldGutter ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ showFoldGutter: !s.showFoldGutter }) },
    { label: `Toggle Active Line Highlight (${s.showActiveLine ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ showActiveLine: !s.showActiveLine }) },
    { label: `Toggle Status Bar (${s.showStatusBar ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ showStatusBar: !s.showStatusBar }) },
    { label: `Toggle Emacs Navigation (${s.emacs ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ emacs: !s.emacs }) },
    { label: `Toggle Mobile Key Row (${s.keybarOn ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ keybarOn: !s.keybarOn }) },
    { label: `Toggle Auto-Switch to Waveform (${s.autoSwitchWave ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ autoSwitchWave: !s.autoSwitchWave }) },
    { label: `Toggle Auto-Clear Console (${s.autoClearConsole ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ autoClearConsole: !s.autoClearConsole }) },
    { label: `Toggle Hide Excluded Files (${hideExcluded ? 'On' : 'Off'})`, hint: '', run: () => $('toggle-excluded-visibility').click() },
    ...THEME_ORDER.map(id => ({ label: `Theme: ${THEMES[id].name}`, hint: '', run: () => layout.update({ theme: id }) })),
    { label: 'Format Verilog', hint: 'Shift+Alt+F', run: formatActive },
    { label: `Toggle Inline Values (${s.inlineValues ? 'On' : 'Off'})`, hint: '', run: () => layout.update({ inlineValues: !s.inlineValues }) },
    { label: 'Compile Project', hint: 'Ctrl+B', run: () => { if (!$('compile').disabled) execute('compile'); } },
    { label: 'Run Simulation', hint: 'Ctrl+Enter', run: () => { if (!$('run').disabled) execute('run'); } },
    { label: 'Stop Simulation', hint: 'Shift+F5', run: () => { if (!$('stop').disabled) engine.stop(); } },
    { label: 'Clear Console', hint: '', run: () => $('clear-console').click() },
    { label: 'Search in Workspace', hint: 'Ctrl+Shift+F', run: () => openWorkspaceSearch() },
    { label: 'Go to Definition', hint: 'F12', run: () => goToDefinition() },
    { label: 'Run All Tests', hint: '', run: () => { showPanel('tests'); testRunner.runAll(); } },
    { label: 'Assemble MIPS (.asm -> .mem)', hint: 'Ctrl+Shift+A', run: () => assembleCommand() },
    { label: 'Show Register File / Memory State', hint: '', run: () => showPanel('hw-state') },
    { label: 'Show Hardware Board', hint: '', run: () => showPanel('board') },
    { label: 'Show RTL Schematic', hint: '', run: () => showPanel('schematic') },
    { label: 'Elaborate Schematic', hint: '', run: () => { showPanel('schematic'); schematic.elaborate(); } },
    { label: 'New File', hint: '', run: () => showNewFile() },
    { label: 'New Folder', hint: '', run: () => showNewFolder() },
    { label: 'Import ZIP', hint: '', run: () => $('import-project').click() },
    { label: 'Export ZIP', hint: '', run: () => $('export-project').click() },
    { label: 'Showcase Projects…', hint: '', run: () => openShowcase() },
    { label: 'Interactive Hardware Tour', hint: '6 chapters', run: () => tour?.start(0) },
    { label: 'About Datapath Studio', hint: '', run: () => openAbout() },
    { label: 'Starter Templates', hint: '', run: () => openShowcase() },
    { label: 'Editor & Workspace Settings', hint: '', run: () => $('preferences').click() },
    ...Object.keys(files).sort().map(path => ({ label: `Open file: ${path}`, hint: 'file', run: () => openFile(path) })),
  ];
}

function renderPalette() {
  const q = $('palette-input').value.trim().toLowerCase();
  paletteItems = buildCommands().filter(c => c.label.toLowerCase().includes(q));
  paletteIndex = Math.max(0, Math.min(paletteIndex, paletteItems.length - 1));
  const list = $('palette-list');
  list.replaceChildren();
  paletteItems.forEach((item, idx) => {
    const btn = document.createElement('button');
    btn.className = `palette-item${idx === paletteIndex ? ' selected' : ''}`;
    btn.setAttribute('role', 'option');
    btn.setAttribute('aria-selected', String(idx === paletteIndex));
    const lbl = document.createElement('span');
    lbl.textContent = item.label;
    const hint = document.createElement('span');
    hint.className = 'palette-hint';
    hint.textContent = item.hint;
    btn.append(lbl, hint);
    btn.onclick = () => { $('palette-dialog').close(); item.run(); };
    list.append(btn);
  });
}

function openPalette() {
  $('palette-input').value = '';
  paletteIndex = 0;
  renderPalette();
  $('palette-dialog').showModal();
  $('palette-input').focus();
}
$('open-palette').onclick = openPalette;
$('palette-input').oninput = () => { paletteIndex = 0; renderPalette(); };
$('palette-input').onkeydown = e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); if (paletteItems.length) { paletteIndex = (paletteIndex + 1) % paletteItems.length; renderPalette(); } }
  else if (e.key === 'ArrowUp') { e.preventDefault(); if (paletteItems.length) { paletteIndex = (paletteIndex - 1 + paletteItems.length) % paletteItems.length; renderPalette(); } }
  else if (e.key === 'Enter') { e.preventDefault(); const chosen = paletteItems[paletteIndex]; if (chosen) { $('palette-dialog').close(); chosen.run(); } }
};
$('palette-dialog').onclick = e => { if (e.target === $('palette-dialog')) $('palette-dialog').close(); };

// ---------------------------------------------------------------- MIPS assembler
// Assembles `paths`, writes each .mem output into the workspace and returns { ok, results, diagnostics }.
function assemblePaths(paths) {
  const results = [];
  const problems = [];
  for (const path of paths) {
    const result = assembleMips(files[path], { filename: path });
    results.push({ path, ...result });
    if (!result.ok) { problems.push(...result.diagnostics); continue; }
    if (Object.hasOwn(files, result.outputName) && files[result.outputName] === result.memText) continue;
    if (!Object.hasOwn(files, result.outputName) && !canCreate(result.outputName)) {
      problems.push({ file: path, line: 1, severity: 'error', message: `Cannot write ${result.outputName}` });
      continue;
    }
    files[result.outputName] = result.memText;
    groups.syncDocument(result.outputName, result.memText, null);
  }
  if (results.some(result => result.ok)) { suggestModules(); render(); save(); }
  return { ok: problems.length === 0, results, diagnostics: problems };
}

// Shows assembler errors in Problems and the editor; returns false when there were any.
function reportAssembly(outcome, context) {
  if (outcome.ok) return true;
  icarusDiagnostics = outcome.diagnostics;
  diagnostics = outcome.diagnostics;
  renderProblems(diagnostics, `${context}: ${outcome.diagnostics.length} assembler error${outcome.diagnostics.length === 1 ? '' : 's'}`);
  showPanel('problems');
  engineStatus('Assembly failed', 'st-error');
  return false;
}

const buildAsmPaths = () => Object.keys(files).filter(path => isAsm(path) && !excluded.has(path)).sort();

// Auto-assemble every included .asm/.s file before compiling, running or testing.
function assembleBeforeBuild(context = 'Run aborted') {
  const paths = buildAsmPaths();
  if (!paths.length) return true;
  return reportAssembly(assemblePaths(paths), context);
}

function assembleCommand() {
  const paths = isAsm(current) ? [current] : buildAsmPaths();
  if (!paths.length) { showToast('No .asm or .s files to assemble'); return; }
  const outcome = assemblePaths(paths);
  if (!reportAssembly(outcome, 'Assemble')) return;
  icarusDiagnostics = [];
  diagnostics = [];
  renderProblems([]);
  const words = outcome.results.reduce((sum, result) => sum + result.words.length, 0);
  const outputs = [...new Set(outcome.results.map(result => result.outputName))].join(', ');
  const message = `Assembled ${words} word${words === 1 ? '' : 's'} -> ${outputs}`;
  $('save-state').textContent = message;
  showToast(message);
}
$('assemble').onclick = assembleCommand;

// ---------------------------------------------------------------- FSM state names
function refreshFsmStates() {
  const sources = Object.fromEntries(Object.entries(files).filter(([path]) => /\.(?:v|sv|vh|svh)$/i.test(path) && !excluded.has(path)));
  fsmMap = extractFsmStates(sources);
  waveform.setFsmMap(fsmMap);
  scheduleInline();
}
let fsmTimer = null;
function scheduleFsmRefresh() {
  clearTimeout(fsmTimer);
  fsmTimer = setTimeout(() => { if (waveform?.store.getState().trace) refreshFsmStates(); }, 400);
}

function showPanel(name) {
  outputOpened = true;
  if (layout.getState().dockHidden) layout.update({ mode: 'custom', dockHidden: false });
  document.querySelector(`[data-panel="${name}"]`).click();
  if (innerWidth <= 900) setMobileView('console');
}

// Jump to file:line (Problems, Search, F12, Schematic): always a new history entry so Back returns here.
function openAt(file, line) {
  if (!Object.hasOwn(files, file)) return;
  current = file;
  groups.jump(file, line);
  if (matchMedia('(max-width: 900px)').matches) selectView('code');
  renderExplorerSection();
  save();
  nav?.record({ force: true });
}

const search = installSearch({ getFiles: () => files, openAt, notify: showToast });
function openWorkspaceSearch() { search.open(); }
function goToDefinition() { search.goToDefinition(cursorState.word); }

testRunner = installTestRunner({
  prepare: () => assembleBeforeBuild('Tests aborted'),
  getFiles: () => files,
  getExcluded: () => excluded,
  getSettings: () => simulationSettings.snapshot(),
  getStandard: () => $('standard').value,
  createWorker: () => new Worker('./simulator-worker.js', { type: 'module' }),
  onShowLog: entry => {
    consoleOverride = `--- ${entry.tb} (${entry.status.toUpperCase()}, ${entry.ms} ms) ---\n${entry.log}`;
    showPanel('console');
    showConsole();
  },
  onShowWave: entry => {
    if (!entry.vcd) return;
    try {
      waveform.loadVcd(entry.vcd.data, `${entry.tb}: ${entry.vcd.path}`);
      if (entry.memTrace) waveform.store.loadMemTrace(entry.memTrace);
      showPanel('waveform');
    } catch (error) { showToast(`Waveform: ${error.message}`); }
  },
});

hwState = installHwState({ store: waveform.store, notify: showToast });

// RTL sources for live sessions: included, non-testbench Verilog files in build order.
function liveSources() {
  const settings = simulationSettings.snapshot();
  return settings.sourceFiles.filter(path => !testRunner.isTestbench(path)).map(path => [path, files[path]]);
}
board = installBoard({
  store: waveform.store,
  getFiles: () => files,
  getLiveSources: () => { try { return liveSources(); } catch { return []; } },
  getSettings: () => simulationSettings.snapshot(),
  getStandard: () => $('standard').value,
  createWorker: () => new Worker('./simulator-worker.js', { type: 'module' }),
  notify: showToast,
  onOutput: lines => { log.append(`${lines.join('\n')}\n`); showConsole(); },
});

// The module instantiated as `dut` in the active testbench (the Top module field, else the first testbench).
function schematicTopHint(names) {
  const top = $('top-module').value.trim();
  const testbenches = Object.keys(files).filter(path => testRunner.isTestbench(path) && !excluded.has(path));
  const owner = testbenches.find(path => new RegExp(`\\bmodule\\s+${top}\\b`).test(files[path])) || testbenches[0];
  const dut = owner && /\b([A-Za-z_][\w$]*)\s+(?:#\s*\([^;]*?\)\s*)?dut\s*\(/.exec(files[owner])?.[1];
  return dut && names.includes(dut) ? dut : names[0];
}
schematic = installSchematic({
  store: waveform.store,
  getFiles: () => files,
  getRtlSources: () => { try { return liveSources(); } catch { return []; } },
  getSettings: () => simulationSettings.snapshot(),
  getStandard: () => $('standard').value,
  getTopHint: schematicTopHint,
  createWorker: () => new Worker('./elaborate-worker.js', { type: 'module' }),
  onJump: (file, line) => openAt(file, line),
  notify: showToast,
  onNavigate: () => nav?.record(),
  overlay: { opened: close => nav?.overlayOpened(close), closed: close => nav?.overlayClosed(close) },
  getStateName: (path, bits) => (fsmMap ? stateNameFor(fsmMap, path, bits) : null),
  onShowArray: path => { showPanel('hw-state'); hwState.select(path); },
  onProgress: phase => tour?.setBusyText(phase),
  onElaborated: ({ yosysJson, files: sourceFiles, sourceFiles: included }) => {
    lastElaboratedJson = yosysJson;
    elaboratedFiles = sourceFiles;
    elaboratedSources = included;
    refreshRtlProblems();
  },
});

// ---------------------------------------------------------------- Back / Forward history
const selectedPanel = () => document.querySelector('[data-panel].selected')?.dataset.panel || 'console';
const isNarrow = () => matchMedia('(max-width: 900px)').matches;
function restoreNav(state) {
  if (state.file && Object.hasOwn(files, state.file)) {
    if (state.file !== current) { current = state.file; groups.openFile(state.file); }
    if (state.line && (!isNarrow() || state.view === 'code')) groups.jump(state.file, state.line);
    renderExplorerSection();
  }
  if (state.panel) document.querySelector(`[data-panel="${state.panel}"]`)?.click();
  if (isNarrow() && state.view) setMobileView(state.view);
  if (state.crumbs?.length) schematic.navigateTo(state.crumbs);
  save();
}
nav = createNavHistory({
  snapshot: () => ({ view: document.body.dataset.view || 'code', panel: selectedPanel(), file: current, line: cursorState.line, crumbs: schematic.getCrumbs() }),
  keyOf: state => JSON.stringify([isNarrow() ? state.view : '', state.panel, state.file, state.crumbs]),
  restore: restoreNav,
  onBackState: ({ canBack }) => { $('nav-back').hidden = !canBack; },
  onExitGuard: () => showToast('Press back again to leave Datapath Studio', 2500),
});
// Every modal dialog / sheet is an overlay on the history stack. One observer keeps close-then-open
// (More -> About, a card click that loads a project) in order so the closed entry can be reused.
const dialogClosers = new Map([...document.querySelectorAll('dialog')].map(dialog => [dialog, () => { if (dialog.open) dialog.close(); }]));
new MutationObserver(records => {
  for (const record of records) {
    const close = dialogClosers.get(record.target);
    if (!close) continue;
    if (record.target.open) nav.overlayOpened(close);
    else nav.overlayClosed(close);
  }
}).observe(document.body, { attributes: true, attributeFilter: ['open'], subtree: true });
$('nav-back').onclick = () => nav.back();
document.addEventListener('keydown', event => {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === 'ArrowLeft') nav.back(); else nav.forward();
}, true);

function waitUntil(check, timeout = 25000) {
  return new Promise(resolve => {
    const start = Date.now();
    const poll = () => {
      if (check()) { resolve(true); return; }
      if (Date.now() - start >= timeout) { resolve(false); return; }
      setTimeout(poll, 40);
    };
    poll();
  });
}

tour = installTour({
  $,
  loadShowcase: (id, opts) => loadShowcaseProject(id, opts),
  openFile: path => openFile(path),
  setDockPosition: (pos, opts) => { if (!isNarrow()) layout.setDockPosition(pos, opts); },
  setInspectorHidden: hidden => { if (!isNarrow()) layout.update({ mode: 'custom', inspectorHidden: hidden }); },
  warmSchematic: () => schematic.warm(),
  runSimulation: async ({ suppressAutoWave = true } = {}) => {
    await waitEngineReady();
    const done = new Promise(resolve => simRunWaiters.push(resolve));
    if (!execute('run', { suppressAutoWave, quiet: true })) return { ok: false };
    return await done;
  },
  elaborateModule: async moduleName => {
    const select = $('schem-module');
    if (moduleName && [...select.options].some(opt => opt.value === moduleName)) select.value = moduleName;
    await schematic.elaborate();
  },
  showPanel,
  selectHwArray: (path, opts = {}) => {
    hwState.select(path);
    if (opts.abi && $('hw-abi').getAttribute('aria-pressed') !== 'true' && !$('hw-abi').disabled) $('hw-abi').click();
    if (opts.disasm && $('hw-disasm').getAttribute('aria-pressed') !== 'true' && !$('hw-disasm').disabled) $('hw-disasm').click();
    if (opts.view === 'table' && $('hw-view').textContent === 'Table view' && !$('hw-view').disabled) $('hw-view').click();
  },
  playHwState: () => { if (!waveform.store.getState().playing) waveform.store.play(); },
  pausePlayback: () => waveform.store.pause(),
  stepSchem: delta => waveform.store.stepCycle(delta),
  inspectSchemCell: name => {
    const cell = document.querySelector(`#schem-canvas .schem-cell[data-name="${name}"]`);
    if (cell) cell.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  },
  clickLatchWarning: () => {
    document.querySelector('#schem-warnings .schem-warning')?.click();
  },
  focusWaveSignal: path => { waveform.selectSignal(path); },
  stepWave: delta => waveform.store.stepCycle(delta),
  startLiveBoard: async moduleName => {
    $('board-mode-live').click();
    const select = $('board-module');
    if (moduleName && [...select.options].some(opt => opt.value === moduleName)) select.value = moduleName;
    if (!board.isLive()) $('board-live-start').click();
    await waitUntil(() => !$('board-live-stop').disabled && !$('board-tick').disabled);
  },
  demoBoardTick: async () => {
    const setSwitch = async (port, wanted) => {
      const btn = document.querySelector(`#board-live-inputs [data-port="${port}"] .board-switch`);
      if (!btn || btn.getAttribute('aria-checked') === String(wanted)) return;
      btn.click();
      await waitUntil(() => document.querySelector(`#board-live-inputs [data-port="${port}"] .board-switch`)?.getAttribute('aria-checked') === String(wanted), 5000);
    };
    await setSwitch('rst', false);
    await setSwitch('en', true);
    await setSwitch('up_down', true);
    if (!$('board-tick').disabled) $('board-tick').click();
  },
  runAllTests: async () => {
    await testRunner.runAll();
  },
  resetCleanWorkspace,
  waitEngineReady,
  getActiveProjectId: () => activeShowcaseId,
  hasTrace: () => Boolean(waveform.store.getState().trace),
  onOpenShowcase: openShowcase,
  onDismissHero: () => { try { localStorage.setItem(FEATURED_DISMISSED_KEY, '1'); } catch { /* ignore */ } },
});

hydrateFromDurable();

try { engine.start(); } catch (error) { engineStatus('Engine unavailable', 'st-error'); $('console-output').textContent = error.message; }

const deepLink = parseDeepLink(location.search);
if (deepLink?.kind === 'tour') tour.start(deepLink.index);
else if (deepLink?.kind === 'showcase') tour.launchShowcaseLive(deepLink.id);
else if (!hadSavedWorkspace && localStorage.getItem(FEATURED_DISMISSED_KEY) !== '1') tour.showFeatured();

// Background compiler uses its own worker so it never changes foreground output or run state.
// Only use synthesized findings while the elaborated source snapshot is still current.
function matchingElaboration() {
  if (!lastElaboratedJson || !elaboratedFiles || !elaboratedSources) return null;
  if (Object.keys(files).length !== Object.keys(elaboratedFiles).length || Object.keys(files).some(path => files[path] !== elaboratedFiles[path])) return null;
  let included;
  try { included = liveSources().map(([path]) => path); } catch { return null; }
  return JSON.stringify(included) === JSON.stringify(elaboratedSources) ? lastElaboratedJson : null;
}
function refreshRtlProblems() {
  const findings = layout.getState().strictRtlLint ? lintRtl(files, { excluded, yosysJson: matchingElaboration() }) : [];
  const merged = [...icarusDiagnostics];
  const keys = new Set(merged.map(item => `${item.file}:${item.line}:${String(item.message || '').trim().toLowerCase()}`));
  const latchLines = new Set(merged.filter(item => /latch.*infer|infer.*latch/i.test(item.message || '')).map(item => `${item.file}:${item.line}`));
  for (const item of findings) {
    const loc = `${item.file}:${item.line}`;
    const key = `${loc}:${String(item.message || '').trim().toLowerCase()}`;
    if (keys.has(key) || (item.rule === 'LATCH_INFERRED' && latchLines.has(loc))) continue;
    keys.add(key); if (item.rule === 'LATCH_INFERRED') latchLines.add(loc);
    merged.push(item);
  }
  diagnostics = merged;
  renderProblems(diagnostics);
}
$('opt-strict-lint').addEventListener('change', refreshRtlProblems);
function cancelLint() { ++lintSeq; clearTimeout(lintTimer); lintWorker?.terminate(); lintWorker = null; }
function scheduleLint(name) {
  cancelLint();
  if (!/\.(?:v|sv)$/i.test(name)) return;
  const seq = lintSeq;
  lintTimer = setTimeout(() => {
    if (engine.activeRunId !== null || board?.isLive()) return;
    // Strict RTL analysis is independent of the optional Icarus background worker.
    refreshRtlProblems();
    if (!layout.getState().liveLint) return;
    let settings;
    try { settings = simulationSettings.snapshot(); } catch { return; }
    lintWorker = new Worker('./simulator-worker.js', { type: 'module' });
    lintWorker.onmessage = ({ data }) => {
      if (data.type !== 'lint-result') return;
      if (seq === lintSeq && engine.activeRunId === null && !board?.isLive() && layout.getState().liveLint) { icarusDiagnostics = data.items || []; refreshRtlProblems(); }
      lintWorker?.terminate(); lintWorker = null;
    };
    lintWorker.postMessage({ type: 'lint', runId: seq, files: { ...files }, ...settings, topModule: $('top-module').value, standard: $('standard').value });
  }, 650);
}
function scheduleInline() { clearTimeout(inlineTimer); inlineTimer = setTimeout(refreshInline, 0); }
function refreshInline() {
  if (!waveform) return;
  const state = waveform.store.getState();
  for (const group of groups.groups) {
    const editor = group.editor;
    const name = editor.getFilename();
    const entries = layout.getState().inlineValues && /\.(?:v|sv)$/i.test(name) && state.trace
      ? computeInlineValues(files[name] || '', state.trace, waveform.store.currentTime(), { radix: $('wave-radix').value, fsmMap }) : [];
    editor.setInlineValues(entries);
  }
}
function formatActive() {
  const editor = groups.activeEditor();
  const name = editor?.getFilename();
  if (!name || !/\.(?:v|sv)$/i.test(name)) return;
  editor.replaceText(formatVerilog(files[name], { tabWidth: layout.getState().tabWidth }));
}
$('format-verilog').onclick = formatActive;
function renderHierarchy() {
  const target = $('hierarchy-tree');
  if (!target) return;
  target.replaceChildren();
  for (const entry of buildModuleHierarchy(files, excluded).flat) {
    const button = document.createElement('button');
    button.className = 'hierarchy-item';
    button.style.paddingLeft = `${8 + entry.depth * 14}px`;
    const loc = entry.instance || entry;
    button.textContent = `${entry.instance ? `${entry.instance.instance} : ` : ''}${entry.name}${entry.cyclic ? ' ↻' : ''} — ${loc.file}:${loc.line}`;
    button.onclick = () => openAt(loc.file, loc.line);
    target.append(button);
  }
}
for (const name of ['files', 'hierarchy']) $('sidebar-' + name).onclick = () => {
  $('files').hidden = name !== 'files'; $('hierarchy-tree').hidden = name !== 'hierarchy';
  $('sidebar-files').setAttribute('aria-pressed', String(name === 'files'));
  $('sidebar-hierarchy').setAttribute('aria-pressed', String(name === 'hierarchy'));
  if (name === 'hierarchy') renderHierarchy();
};
$('toggle-dock').addEventListener('click', () => { if (innerWidth > 900 && !layout.getState().dockHidden) outputOpened = true; });
let wasPhone = innerWidth <= 900;
window.addEventListener('resize', () => {
  const phone = innerWidth <= 900;
  if (phone && !wasPhone && !layout.getState().dockHidden) {
    const selected = document.querySelector('[data-panel].selected')?.dataset.panel;
    if (selected && (selected !== 'console' || outputOpened)) setMobileView('console');
  }
  wasPhone = phone;
});
if (location.protocol === 'http:' || location.protocol === 'https:') navigator.serviceWorker?.register('./sw.js').catch(() => {});
