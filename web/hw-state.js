// State tab: register-file grid and memory table for arrays captured by vvp, following the shared SimTrace cursor.
import { decodeMips, MIPS_REGISTERS } from './mips-decode.js';
import { formatTime } from './waveform.js';

const GRID_LIMIT = 64;
const TABLE_ROW_LIMIT = 4096;

// Formats one captured word (hex digits from vvp) in the requested radix; x/z words stay as raw hex.
export function formatWord(hex, width, radix) {
  if (hex === undefined || hex === null) return '—';
  if (/[xz]/i.test(hex)) return hex;
  const value = BigInt(`0x${hex || '0'}`) & ((1n << BigInt(width)) - 1n);
  if (radix === 'unsigned') return value.toString();
  if (radix === 'signed') return (width > 0 && value >> BigInt(width - 1) ? value - (1n << BigInt(width)) : value).toString();
  if (radix === 'bin') return `0b${value.toString(2).padStart(width, '0')}`;
  return `0x${value.toString(16).padStart(Math.ceil(width / 4), '0')}`;
}

const isZero = hex => /^0*$/.test(hex || '');
const zeroWord = width => '0'.repeat(Math.ceil(width / 4));

export function installHwState({ store, notify }) {
  const $ = id => document.getElementById(id);
  const S = store.getState();
  const panel = $('hw-state');
  const prefs = { radix: 'hex', abi: false, disasm: false, hideZeros: false };
  const viewOverride = new Map();   // array path -> 'grid' | 'table'
  let selected = null;
  let frame = 0;

  const arrays = () => store.memArrays();
  const currentArray = () => arrays().find(array => array.path === selected) || null;
  const viewFor = array => viewOverride.get(array.path) || (array.size <= GRID_LIMIT ? 'grid' : 'table');
  const shortPath = path => path.split('.').slice(-3).join('.');

  // Program counter at the cursor: a VCD signal named pc (preferred) or *_pc / pc_*.
  function programCounter() {
    const signals = S.trace?.signals || [];
    const leaf = signal => signal.path.split('.').at(-1);
    const candidate = signals.find(signal => /^pc$/i.test(leaf(signal)))
      || signals.find(signal => /(?:^|_)pc(?:_|$)/i.test(leaf(signal)) && signal.width >= 8);
    if (!candidate) return null;
    const raw = store.valueOf(candidate);
    if (!raw || /[xz]/.test(raw)) return null;
    return { path: candidate.path, value: Number(BigInt(`0b${raw}`)) };
  }

  function nameFor(array, index) {
    if (prefs.abi && array.size === 32 && index - array.low >= 0 && index - array.low < 32) return MIPS_REGISTERS[index - array.low];
    return String(index);
  }

  // Filter by decimal index, 0x byte address (word index × 4 for 32-bit words) or register name.
  function matchesFilter(array, index, filter) {
    if (!filter) return true;
    if (/^0x[0-9a-f]+$/.test(filter)) {
      const wanted = parseInt(filter, 16);
      return array.width === 32 ? (index - array.low) * 4 === wanted : index === wanted;
    }
    if (/^\d+$/.test(filter)) return index === Number(filter);
    return nameFor(array, index).toLowerCase().includes(filter.replace(/^\$?/, '$')) || nameFor(array, index).toLowerCase().includes(filter);
  }

  function copy(text) {
    navigator.clipboard?.writeText(text).then(() => notify?.(`Copied ${text}`)).catch(() => notify?.('Could not copy value'));
  }

  function renderArrays() {
    const host = $('hw-arrays');
    host.replaceChildren();
    for (const array of arrays()) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.array = array.path;
      chip.textContent = `${shortPath(array.path)} (${array.size}×${array.width})`;
      chip.title = array.path;
      chip.setAttribute('aria-pressed', String(array.path === selected));
      chip.onclick = () => { selected = array.path; render(); };
      host.append(chip);
    }
  }

  function renderToolbar(array) {
    $('hw-time').textContent = store.hasTime() ? formatTime(store.currentTime(), S.memTrace?.timescale || S.trace?.timescale) : '—';
    renderPlayButton();
    for (const [id, on] of [['hw-abi', prefs.abi], ['hw-disasm', prefs.disasm], ['hw-hide-zeros', prefs.hideZeros]]) $(id).setAttribute('aria-pressed', String(on));
    $('hw-abi').disabled = !array || array.size !== 32;
    $('hw-disasm').disabled = !array || array.width !== 32;
    $('hw-view').disabled = !array;
    $('hw-view').textContent = array && viewFor(array) === 'grid' ? 'Table view' : 'Grid view';
    for (const id of ['hw-step-prev', 'hw-play', 'hw-step-next']) $(id).disabled = !store.hasTime();
  }

  function renderGrid(host, array, snapshot, filter) {
    const grid = document.createElement('div');
    grid.className = 'hw-grid';
    grid.setAttribute('role', 'list');
    for (let offset = 0; offset < array.size; offset++) {
      const index = array.low + offset;
      const hex = snapshot.words.get(index) ?? zeroWord(array.width);
      if (prefs.hideZeros && isZero(hex)) continue;
      if (!matchesFilter(array, index, filter)) continue;
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.setAttribute('role', 'listitem');
      const heat = snapshot.heat.get(index);
      cell.className = `hw-cell${heat === undefined ? '' : ` heat${heat}`}`;
      cell.dataset.index = String(index);
      const name = document.createElement('span');
      name.className = 'hw-name';
      name.textContent = nameFor(array, index);
      const value = document.createElement('span');
      value.className = 'hw-value';
      value.textContent = formatWord(hex, array.width, prefs.radix);
      cell.append(name, value);
      const written = snapshot.lastWriteTime.get(index);
      cell.title = `${array.path}[${index}] = ${value.textContent}${written === undefined ? '' : ` · written @ ${written}`} · click to copy`;
      cell.onclick = () => copy(value.textContent);
      grid.append(cell);
    }
    host.append(grid);
  }

  function renderTable(host, array, snapshot, filter) {
    const table = document.createElement('table');
    table.className = 'hw-table';
    const showDisasm = prefs.disasm && array.width === 32;
    const head = table.createTHead().insertRow();
    for (const title of ['', 'Index', array.width === 32 ? 'Address' : '', 'Value', ...(showDisasm ? ['Disassembly'] : [])]) {
      const th = document.createElement('th');
      th.textContent = title;
      head.append(th);
    }
    const body = table.createTBody();
    const pc = programCounter();
    const pcIndex = pc ? array.low + (pc.value >>> 2) : null;
    let rows = 0;
    for (let offset = 0; offset < array.size && rows < TABLE_ROW_LIMIT; offset++) {
      const index = array.low + offset;
      const hex = snapshot.words.get(index) ?? zeroWord(array.width);
      if (prefs.hideZeros && isZero(hex) && index !== pcIndex) continue;
      if (!matchesFilter(array, index, filter)) continue;
      rows++;
      const row = body.insertRow();
      const heat = snapshot.heat.get(index);
      row.className = `hw-row${heat === undefined ? '' : ` heat${heat}`}${index === pcIndex ? ' is-pc' : ''}`;
      row.dataset.index = String(index);
      const marker = row.insertCell();
      marker.className = 'hw-pc';
      marker.textContent = index === pcIndex ? '▶' : '';
      if (index === pcIndex) marker.title = `${pc.path} = 0x${pc.value.toString(16)}`;
      row.insertCell().textContent = nameFor(array, index);
      const address = row.insertCell();
      address.className = 'hw-addr';
      address.textContent = array.width === 32 ? `0x${(offset * 4).toString(16).padStart(8, '0')}` : '';
      const value = row.insertCell();
      value.className = 'hw-value';
      value.textContent = formatWord(hex, array.width, prefs.radix);
      value.title = 'Click to copy';
      value.onclick = () => copy(value.textContent);
      if (showDisasm) {
        const asm = row.insertCell();
        asm.className = 'hw-asm';
        asm.textContent = /[xz]/i.test(hex) ? '' : decodeMips(parseInt(hex, 16) >>> 0)?.asm || '';
      }
    }
    host.append(table);
  }

  function render() {
    frame = 0;
    const list = arrays();
    if (!list.some(array => array.path === selected)) selected = list[0]?.path || null;
    const array = currentArray();
    renderArrays();
    renderToolbar(array);
    $('hw-empty').hidden = Boolean(array);
    const host = $('hw-body');
    host.replaceChildren();
    if (!array) return;
    const snapshot = store.getMemorySnapshot(array.path);
    const filter = $('hw-filter').value.trim().toLowerCase();
    host.dataset.view = viewFor(array);
    if (viewFor(array) === 'grid') renderGrid(host, array, snapshot, filter);
    else renderTable(host, array, snapshot, filter);
    if (S.memTrace?.truncated) {
      const note = document.createElement('p');
      note.className = 'hw-note';
      note.textContent = 'Capture limit reached; later writes are not shown.';
      host.append(note);
    }
  }

  // Coalesce bursts (scrubbing, playback) into one paint, and skip work while the tab is hidden.
  function schedule() {
    if (panel.hidden || frame) return;
    frame = requestAnimationFrame(render);
  }

  function renderPlayButton() {
    $('hw-play').setAttribute('aria-pressed', String(S.playing));
    $('hw-play').textContent = S.playing ? '❚❚' : '▶';
    $('hw-play').setAttribute('aria-label', S.playing ? 'Pause' : 'Play cycles');
  }

  store.subscribe((_, kind) => {
    if (kind === 'playing') renderPlayButton();
    if (kind === 'mem' || kind === 'cursor' || kind === 'trace' || kind === 'playing') schedule();
  });
  $('hw-step-prev').onclick = () => store.stepCycle(-1);
  $('hw-step-next').onclick = () => store.stepCycle(1);
  $('hw-play').onclick = () => { if (S.playing) store.pause(); else store.play(); };
  $('hw-radix').onchange = () => { prefs.radix = $('hw-radix').value; render(); };
  $('hw-abi').onclick = () => { prefs.abi = !prefs.abi; render(); };
  $('hw-disasm').onclick = () => { prefs.disasm = !prefs.disasm; render(); };
  $('hw-hide-zeros').onclick = () => { prefs.hideZeros = !prefs.hideZeros; render(); };
  $('hw-view').onclick = () => {
    const array = currentArray();
    if (!array) return;
    viewOverride.set(array.path, viewFor(array) === 'grid' ? 'table' : 'grid');
    render();
  };
  $('hw-filter').oninput = render;

  return { render, select: path => { selected = path; render(); } };
}
