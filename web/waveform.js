// Waveform view: DOM rows (labels, radix, drag reorder) with DPR-scaled <canvas> traces that only paint the visible time window.
import { parseSliceSpec, sliceBits } from './wave-utils.js';
export { parseSliceSpec, sliceBits } from './wave-utils.js';
import { createSimTrace } from './sim-trace.js';
import { stateNameFor } from './fsm-states.js';

export function formatValue(value, width, radix) {
  if (value === null) return '—';
  if (width === 1 && radix !== 'ascii') return value;
  const bits = value.padStart(width, /^[xz]/.test(value) ? value[0] : '0');
  if (radix === 'bin') return `0b${bits}`;
  if (radix === 'dec' || radix === 'signed') {
    if (/[xz]/.test(bits)) return `0b${bits}`;
    const number = BigInt(`0b${bits}`);
    return String(radix === 'signed' && bits[0] === '1' ? number - (1n << BigInt(width)) : number);
  }
  if (radix === 'ascii') {
    if (/[xz]/.test(bits)) return `0b${bits}`;
    const padded = bits.padStart(Math.ceil(bits.length / 8) * 8, '0');
    return [...padded.matchAll(/.{8}/g)].map(match => {
      const code = parseInt(match[0], 2);
      return code >= 32 && code <= 126 ? String.fromCharCode(code) : '.';
    }).join('');
  }
  const padded = bits.padStart(Math.ceil(bits.length / 4) * 4, /^[xz]/.test(bits) ? bits[0] : '0');
  return `0x${padded.match(/.{4}/g).map(n => /x/.test(n) ? 'x' : /z/.test(n) ? 'z' : parseInt(n, 2).toString(16)).join('')}`;
}

export function formatTime(ticks, timescale) {
  const match = /^(1|10|100)\s*(s|ms|us|ns|ps|fs)$/.exec((timescale || '').trim());
  if (!match) return `${ticks} ticks`;
  const units = [['s', 1000000000000000n], ['ms', 1000000000000n], ['us', 1000000000n], ['ns', 1000000n], ['ps', 1000n], ['fs', 1n]];
  const factor = units.find(([name]) => name === match[2])[1];
  const fs = ticks * BigInt(match[1]) * factor;
  if (fs === 0n) return `0 ${match[2]}`;
  for (const [name, size] of units) if (fs % size === 0n) return `${fs / size} ${name}`;
  return `${fs} fs`;
}

const ROW_HEIGHT = 30;
const BASE_WIDTH = 720;
const RADIX_OPTIONS = [['', 'Auto'], ['hex', 'Hex'], ['bin', 'Bin'], ['dec', 'Dec'], ['signed', 'Signed'], ['ascii', 'ASCII'], ['state', 'State']];

// Per-signal numeric change times (binary-searchable) and a prefix count of x/z values (O(1) band coloring).
const signalCache = new WeakMap();
function signalIndex(signal) {
  let index = signalCache.get(signal);
  if (!index) {
    const count = signal.changes.length;
    const times = new Float64Array(count);
    const unknown = new Int32Array(count + 1);
    for (let i = 0; i < count; i++) {
      const { time, value } = signal.changes[i];
      times[i] = Number(time);
      unknown[i + 1] = unknown[i] + (value.includes('x') || value.includes('z') ? 1 : 0);
    }
    index = { times, unknown };
    signalCache.set(signal, index);
  }
  return index;
}
function lastIndexAtOrBefore(times, t) {
  let low = 0, high = times.length;
  while (low < high) { const mid = (low + high) >>> 1; if (times[mid] <= t) low = mid + 1; else high = mid; }
  return low - 1;
}

export function installWaveform(onStatusCopy = null) {
  const $ = id => document.getElementById(id);
  const container = $('wave-grid');
  const store = createSimTrace();
  const S = store.getState();
  const prefsKey = 'datapath.wave-prefs.v1';
  let prefs = { shortNames: false, gridlines: false, snap: false };
  try {
    const saved = JSON.parse(localStorage.getItem(prefsKey));
    if (saved && typeof saved === 'object') {
      prefs = { shortNames: saved.shortNames === true, gridlines: saved.gridlines === true, snap: saved.snap === true };
    }
  } catch { /* Ignore invalid wave prefs. */ }

  const groups = new Map();
  const slices = new Map();
  const viewsKey = 'datapath.wave-views.v1';
  let views = {};
  try { views = JSON.parse(localStorage.getItem(viewsKey)) || {}; } catch { /* Invalid saved views. */ }
  function refreshViews() {
    const select = $('wave-views'); const selected = select.value;
    select.replaceChildren(new Option('Select view', ''));
    Object.keys(views).sort().forEach(name => select.add(new Option(name, name)));
    select.value = selected;
  }
  function addSlice(spec) {
    const parsed = parseSliceSpec(spec); if (!parsed || !S.trace) return false;
    const source = store.signalByPath(parsed.signal) || S.trace.signals.find(s => s.path.split('.').at(-1) === parsed.signal);
    if (!source || parsed.msb >= source.width) return false;
    const path = `${source.path}[${parsed.msb}${parsed.msb === parsed.lsb ? '' : ':' + parsed.lsb}]`;
    if (store.signalByPath(path)) return true;
    const signal = { ...source, path, width: parsed.msb - parsed.lsb + 1, changes: source.changes.map(c => ({ time: c.time, value: sliceBits(c.value, source.width, parsed.msb, parsed.lsb) })) };
    S.trace.signals.push(signal); S.order.push(path); S.visible.add(path); slices.set(path, `${source.path}[${parsed.msb}:${parsed.lsb}]`);
    return true;
  }
  function saveViews() { try { localStorage.setItem(viewsKey, JSON.stringify(views)); } catch { $('wave-error').textContent = 'Could not save views'; } refreshViews(); }
  let width = BASE_WIDTH;
  let dragSource = null;
  let frame = 0;
  let rows = [];          // [{ path, row, canvas, value }]
  let axisCanvas = null;

  const span = () => Number(S.trace?.endTime || 1n) || 1;
  const displayName = path => prefs.shortNames ? path.split('.').at(-1) : path;
  let fsmMap = null;
  const radixFor = path => S.overrides.get(path) || $('wave-radix').value;
  // FSM state names win under Auto and State radix (and the global State radix); unknown encodings,
  // x and z fall back to hex.
  const displayValue = (signal, raw) => {
    const override = S.overrides.get(signal.path);
    const radix = radixFor(signal.path);
    if (fsmMap && (!override || radix === 'state')) {
      const name = stateNameFor(fsmMap, signal.path, raw);
      if (name) return name;
    }
    return formatValue(raw, signal.width, radix === 'state' ? 'hex' : radix);
  };
  const valueFor = signal => displayValue(signal, store.valueOf(signal));
  const xOf = time => Number(time) / span() * width;
  const savePrefs = () => { try { localStorage.setItem(prefsKey, JSON.stringify(prefs)); } catch { /* Ignore storage failures. */ } };
  const applyPrefsUI = () => {
    $('wave-short-names').setAttribute('aria-pressed', String(prefs.shortNames));
    $('wave-gridlines').setAttribute('aria-pressed', String(prefs.gridlines));
    $('wave-snap').setAttribute('aria-pressed', String(prefs.snap));
  };

  // ---------------------------------------------------------------- viewport geometry
  function labelWidth() {
    return container.querySelector('.wave-label')?.offsetWidth || 0;
  }
  function viewport() {
    const visibleWidth = Math.max(1, Math.min(width, container.clientWidth - labelWidth()));
    const offset = Math.max(0, Math.min(container.scrollLeft, width - visibleWidth));
    return { visibleWidth, offset };
  }
  function themeColors() {
    const css = getComputedStyle(container);
    const read = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
    return {
      text: read('--text', '#e8e8e8'), muted: read('--muted', '#7d8590'), hair: read('--hair', 'rgba(128,128,128,.2)'),
      primary: read('--primary', '#3d8bff'), accent: read('--accent', '#ffb02e'),
      success: read('--success', '#2ee67a'), warning: read('--warning', '#ffd24d'), error: read('--error', '#ff3b5c'),
      font: `11px ${read('--mono', 'monospace')}`,
    };
  }
  function prepareCanvas(canvas, cssWidth, offset) {
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(cssWidth * dpr));
    const pixelHeight = Math.round(ROW_HEIGHT * dpr);
    if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
    if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.left = `${offset}px`;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssWidth, ROW_HEIGHT);
    return ctx;
  }

  // ---------------------------------------------------------------- painting
  function drawMarkers(ctx, colors, offset, visibleWidth) {
    for (const [time, color] of [[S.markerA, colors.primary], [S.markerB, colors.accent]]) {
      if (time === null) continue;
      const x = Math.round(xOf(time) - offset) + 0.5;
      if (x < -1 || x > visibleWidth + 1) continue;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, ROW_HEIGHT); ctx.stroke();
    }
  }
  function drawGridlines(ctx, colors, offset) {
    ctx.strokeStyle = colors.hair;
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.beginPath();
    for (let i = 1; i < 10; i++) {
      const x = Math.round(width * i / 10 - offset) + 0.5;
      ctx.moveTo(x, 0); ctx.lineTo(x, ROW_HEIGHT);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const valueColor = (value, colors) => value.includes('x') ? colors.error : value.includes('z') ? colors.warning : colors.success;
  const levelY = value => value === '1' ? 7 : value === '0' ? 23 : 15;

  function drawSignal(entry, colors, { visibleWidth, offset }) {
    const signal = store.signalByPath(entry.path);
    const canvas = entry.canvas;
    canvas.dataset.width = String(width);
    canvas.dataset.gridlines = String(prefs.gridlines);
    const ctx = prepareCanvas(canvas, visibleWidth, offset);
    if (!signal) return;
    if (prefs.gridlines) drawGridlines(ctx, colors, offset);
    const { times, unknown: unknownCount } = signalIndex(signal);
    const changes = signal.changes;
    const scale = width / span();
    const t0 = offset / scale, t1 = (offset + visibleWidth) / scale;
    const first = Math.max(0, lastIndexAtOrBefore(times, t0));
    const endX = width - offset;
    const oneBit = signal.width === 1;
    const labels = [];
    // Wide bus hexagons and dashed z levels share one path per stroke style; everything else is an
    // integer-aligned fillRect, which stays cheap even with software rasterization.
    let pathColor = null, pathDash = false;
    const usePath = (color, dash) => {
      if (color === pathColor && dash === pathDash) return;
      if (pathColor) ctx.stroke();
      ctx.strokeStyle = color;
      ctx.setLineDash(dash ? [4, 3] : []);
      ctx.beginPath();
      pathColor = color;
      pathDash = dash;
    };
    ctx.lineWidth = oneBit ? 2 : 1.3;
    for (let i = first; i < times.length && times[i] <= t1; i++) {
      // Merge a run of transitions closer than 1.5px into one band, so dense regions cost O(1) draw calls.
      if (i + 1 < times.length && (times[i + 1] - times[i]) * scale < 1.5) {
        let last = i + 1;
        while (last + 1 < times.length && times[last + 1] <= t1 && (times[last + 1] - times[last]) * scale < 1.5) last++;
        const unknown = unknownCount[last + 1] - unknownCount[i] > 0;
        const bandStart = Math.floor(times[i] * scale - offset);
        ctx.fillStyle = unknown ? colors.error : colors.success;
        ctx.fillRect(bandStart, 6, Math.max(1, Math.ceil(times[last] * scale - offset) - bandStart), 18);
        i = last;
      }
      const value = changes[i].value;
      const x1 = Math.round(times[i] * scale - offset);
      const right = Math.round(Math.min((i + 1 < times.length ? times[i + 1] * scale : width) - offset, endX));
      const color = valueColor(value, colors);
      if (/x/.test(value) && right > x1) {
        if (pathColor) { ctx.stroke(); pathColor = null; }
        const left = Math.max(0, x1), edge = Math.min(visibleWidth, right);
        if (edge > left) {
          ctx.save(); ctx.beginPath(); ctx.rect(left, 6, edge - left, 18); ctx.clip();
          ctx.globalAlpha = 0.12; ctx.fillStyle = color; ctx.fillRect(left, 6, edge - left, 18);
          ctx.globalAlpha = 0.45; ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.beginPath();
          for (let x = left - 18; x < edge; x += 6) { ctx.moveTo(x, 24); ctx.lineTo(x + 18, 6); } ctx.stroke(); ctx.restore();
        }
      }
      if (!oneBit && /z/.test(value)) { usePath(color, true); ctx.moveTo(x1, 15); ctx.lineTo(right, 15); }
      if (oneBit) {
        const y = levelY(value);
        ctx.fillStyle = color;
        if (i > 0) {
          const previous = levelY(changes[i - 1].value);
          if (previous !== y) ctx.fillRect(x1 - 1, Math.min(previous, y) - 1, 2, Math.abs(previous - y) + 2);
        }
        if (value === 'z') { usePath(color, true); ctx.moveTo(x1, y); ctx.lineTo(right, y); }
        else ctx.fillRect(x1, y - 1, Math.max(1, right - x1), 2);
      } else if (right - x1 < 8) {
        ctx.fillStyle = color;
        ctx.fillRect(x1, 6, 1, 18);
        ctx.fillRect(x1, 6, Math.max(1, right - x1), 1);
        ctx.fillRect(x1, 23, Math.max(1, right - x1), 1);
      } else {
        usePath(color, false);
        const bevel = 4;
        ctx.moveTo(x1, 15); ctx.lineTo(x1 + bevel, 6); ctx.lineTo(right - bevel, 6); ctx.lineTo(right, 15);
        ctx.lineTo(right - bevel, 24); ctx.lineTo(x1 + bevel, 24); ctx.closePath();
        // Label only the on-screen part of the segment so long segments stay readable while scrolling.
        const left = Math.max(x1, 0), visibleRight = Math.min(right, visibleWidth);
        const available = Math.floor((visibleRight - left - 12) / 7);
        if (available > 2) {
          const display = displayValue(signal, value);
          labels.push([display.length <= available ? display : `${display.slice(0, available - 1)}…`, (left + visibleRight) / 2]);
        }
      }
    }
    if (pathColor) ctx.stroke();
    ctx.setLineDash([]);
    if (labels.length) {
      ctx.font = colors.font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = colors.text;
      for (const [text, x] of labels) ctx.fillText(text, x, 15);
    }
    drawMarkers(ctx, colors, offset, visibleWidth);
  }

  function drawAxis(colors, { visibleWidth, offset }) {
    if (!axisCanvas || !S.trace) return;
    axisCanvas.dataset.width = String(width);
    const ctx = prepareCanvas(axisCanvas, visibleWidth, offset);
    const divisions = 10 * Math.max(1, Math.round(width / BASE_WIDTH));
    ctx.strokeStyle = colors.muted;
    ctx.fillStyle = colors.muted;
    ctx.lineWidth = 1;
    ctx.font = colors.font;
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i <= divisions; i++) {
      const x = width * i / divisions - offset;
      if (x < -80 || x > visibleWidth + 80) continue;
      ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, 20); ctx.lineTo(Math.round(x) + 0.5, 29); ctx.stroke();
      if (i === divisions - 1 && width / divisions < 90) continue;
      const tick = S.trace.endTime * BigInt(i) / BigInt(divisions);
      const isLast = i === divisions;
      ctx.textAlign = isLast ? 'right' : 'left';
      ctx.fillText(formatTime(tick, S.trace.timescale), isLast ? x - 4 : x + 3, 16);
    }
    drawMarkers(ctx, colors, offset, visibleWidth);
    for (const [name, time, color] of [['A', S.markerA, colors.primary], ['B', S.markerB, colors.accent]]) {
      if (time === null) continue;
      const x = xOf(time) - offset; if (x < -6 || x > visibleWidth + 6) continue;
      ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(x - 5, 1); ctx.lineTo(x + 5, 1); ctx.lineTo(x, 9); ctx.closePath(); ctx.fill();
      ctx.font = `bold 9px ${colors.font.slice(5)}`; ctx.fillText(name, x + 4, 12);
    }
  }

  // Paints every canvas whose row intersects the vertical viewport.
  function paint() {
    frame = 0;
    if (!S.trace || container.hidden) return;
    const colors = themeColors();
    const view = viewport();
    drawAxis(colors, view);
    const top = container.scrollTop - ROW_HEIGHT, bottom = container.scrollTop + container.clientHeight + ROW_HEIGHT;
    for (const entry of rows) {
      const y = entry.top;
      if (y < top || y > bottom) { entry.stale = true; continue; }
      entry.stale = false;
      drawSignal(entry, colors, view);
    }
  }
  function schedulePaint() { if (!frame) frame = requestAnimationFrame(paint); }

  // ---------------------------------------------------------------- DOM rows
  function updateValues() {
    const showCursor = S.trace !== null;
    $('clear-marker-b').disabled = S.markerB === null;
    if (showCursor) {
      const ts = S.trace.timescale;
      $('wave-cursor').textContent = `A: ${formatTime(S.markerA, ts)} · B: ${S.markerB === null ? '—' : formatTime(S.markerB, ts)} · Δ: ${S.markerB === null ? '—' : formatTime(S.markerB - S.markerA, ts)}`;
    }
    $('marker-a').setAttribute('aria-pressed', String(S.activeMarker === 'A'));
    $('marker-b').setAttribute('aria-pressed', String(S.activeMarker === 'B'));
    for (const entry of rows) {
      const signal = store.signalByPath(entry.path);
      if (!signal) continue;
      entry.value.textContent = valueFor(signal);
      entry.value.title = entry.value.textContent;
    }
  }

  // Trace drags select a zoom range; the ruler remains a direct marker scrubber.
  function createPointerHandler(track, path = null) {
    let gesture = null;
    const pixelAt = event => Math.max(0, Math.min(width, event.clientX - track.getBoundingClientRect().left));
    function timeAt(event, snap = true) {
      const px = pixelAt(event);
      let target = S.trace.endTime * BigInt(Math.round(px / width * 1000000)) / 1000000n;
      if (snap && prefs.snap && S.selected) {
        const signal = store.signalByPath(S.selected);
        if (signal) {
          let bestDist = 12;
          for (const change of signal.changes) {
            const dist = Math.abs(xOf(change.time) - px);
            if (dist < bestDist) { bestDist = dist; target = change.time; }
          }
        }
      }
      return target;
    }
    track.addEventListener('pointerdown', event => {
      if (!S.trace || (event.button !== 0 && event.button !== 1)) return;
      event.preventDefault();
      if (path && S.selected !== path) store.selectSignal(path);
      const pan = event.button === 1 || event.shiftKey;
      gesture = { pan, ruler: !path, x: event.clientX, startPx: pixelAt(event), startTime: timeAt(event, false), scroll: container.scrollLeft, box: null };
      if (!pan && !path) {
        const px = pixelAt(event);
        const choices = [['A', S.markerA], ['B', S.markerB]].filter(([, time]) => time !== null).map(([name, time]) => ({ name, distance: Math.abs(xOf(time) - px) })).filter(item => item.distance <= 9).sort((a, b) => a.distance - b.distance || (a.name === S.activeMarker ? -1 : 1));
        if (choices.length) store.setActiveMarker(choices[0].name);
        store.setMarker(timeAt(event));
      }
      try { track.setPointerCapture(event.pointerId); } catch { /* Synthetic pointer. */ }
    });
    track.addEventListener('pointermove', event => {
      if (!gesture) return;
      if (gesture.pan) { container.scrollLeft = gesture.scroll - (event.clientX - gesture.x); return; }
      if (gesture.ruler) { store.setMarker(timeAt(event)); return; }
      if (Math.abs(event.clientX - gesture.x) < 6 && !gesture.box) return;
      if (!gesture.box) { gesture.box = document.createElement('div'); gesture.box.className = 'wave-zoom-box'; track.append(gesture.box); }
      const px = pixelAt(event), end = timeAt(event, false), start = gesture.startTime;
      const lo = start < end ? start : end, hi = start < end ? end : start;
      gesture.box.style.left = `${Math.min(gesture.startPx, px)}px`;
      gesture.box.style.width = `${Math.abs(px - gesture.startPx)}px`;
      gesture.box.textContent = `${formatTime(lo, S.trace.timescale)} – ${formatTime(hi, S.trace.timescale)} · Δ ${formatTime(hi - lo, S.trace.timescale)}`;
    });
    track.addEventListener('pointerup', event => {
      if (!gesture) return;
      const current = gesture; gesture = null;
      if (current.box) {
        const end = timeAt(event, false); current.box.remove();
        const left = Math.min(current.startPx, pixelAt(event)), right = Math.max(current.startPx, pixelAt(event));
        if (end !== current.startTime && right - left >= 6) {
          const oldWidth = width, visible = viewport().visibleWidth;
          const zoom = Math.max(1, Math.min(1000, visible / ((right - left) / oldWidth) / BASE_WIDTH));
          $('wave-zoom').max = String(Math.max(10, Math.ceil(zoom)));
          $('wave-zoom').value = String(zoom); buildRows();
          container.scrollTo({ left: (left / oldWidth) * width, behavior: 'smooth' });
        }
      } else if (!current.pan && !current.ruler) store.setMarker(timeAt(event));
    });
    track.addEventListener('pointercancel', () => { gesture?.box?.remove(); gesture = null; });
  }

  function makeTrack(canvas, path = null) {
    const track = document.createElement('div');
    track.className = 'wave-track';
    track.style.width = `${width}px`;
    track.append(canvas);
    createPointerHandler(track, path);
    return track;
  }

  function installRowDrop(label, row, path) {
    const clear = () => { for (const el of container.querySelectorAll('.is-drop-above, .is-drop-below')) el.classList.remove('is-drop-above', 'is-drop-below'); };
    label.draggable = true;
    label.ondragstart = event => { dragSource = path; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', path); };
    label.ondragend = () => { dragSource = null; clear(); };
    row.ondragover = event => {
      if (!dragSource || dragSource === path) return;
      event.preventDefault(); event.stopPropagation(); clear();
      row.classList.add(event.clientY < row.getBoundingClientRect().top + row.offsetHeight / 2 ? 'is-drop-above' : 'is-drop-below');
    };
    row.ondragleave = event => { if (!row.contains(event.relatedTarget)) row.classList.remove('is-drop-above', 'is-drop-below'); };
    row.ondrop = event => {
      if (!dragSource || dragSource === path) return;
      event.preventDefault(); event.stopPropagation();
      const below = row.classList.contains('is-drop-below');
      const source = dragSource; dragSource = null; clear();
      const from = S.order.indexOf(source); if (from < 0) return;
      S.order.splice(from, 1); const target = S.order.indexOf(path);
      S.order.splice(target + (below ? 1 : 0), 0, source);
      store.moveSignal(source, 0); // Notify all waveform views of the new order.
    };
  }

  function buildRows() {
    rows = [];
    axisCanvas = null;
    container.replaceChildren();
    if (!S.trace) return;
    width = BASE_WIDTH * Number($('wave-zoom').value);
    const ruler = document.createElement('div');
    ruler.className = 'wave-row wave-ruler';
    const title = document.createElement('div');
    title.className = 'wave-label';
    title.textContent = S.trace.timescale || 'ticks';
    axisCanvas = document.createElement('canvas');
    axisCanvas.className = 'wave-axis';
    axisCanvas.setAttribute('aria-label', 'Time ruler');
    ruler.append(title, makeTrack(axisCanvas));
    const fragment = document.createDocumentFragment();
    fragment.append(ruler);

    let collapsed = false;
    for (const path of S.order) {
      if (groups.has(path)) {
        const group = groups.get(path); collapsed = group.collapsed;
        const row = document.createElement('div'); row.className = 'wave-row wave-group';
        const label = document.createElement('button'); label.className = 'wave-label'; label.draggable = true;
        label.textContent = `${group.collapsed ? '▸' : '▾'} ${group.name}`;
        label.onclick = () => { group.collapsed = !group.collapsed; buildRows(); };
        installRowDrop(label, row, path);
        row.append(label); fragment.append(row); continue;
      }
      if (collapsed) continue;
      if (!S.visible.has(path) || !store.signalByPath(path)) continue;
      const row = document.createElement('div');
      row.className = 'wave-row';
      row.dataset.path = path;
      row.classList.toggle('selected', path === S.selected);

      const label = document.createElement('div');
      label.className = 'wave-label';
      label.draggable = true;
      label.title = 'Drag to reorder';
      installRowDrop(label, row, path);

      const name = document.createElement('span');
      name.textContent = displayName(path);
      name.title = path;
      name.onclick = () => store.selectSignal(path);

      const value = document.createElement('strong');
      value.dataset.signalValue = path;

      const radix = document.createElement('select');
      radix.className = 'signal-radix';
      radix.setAttribute('aria-label', `Radix for ${path}`);
      for (const [id, text] of RADIX_OPTIONS) radix.append(new Option(text, id));
      radix.value = S.overrides.get(path) || '';
      radix.onchange = () => store.setRadixOverride(path, radix.value);
      label.append(name, value, radix);

      const canvas = document.createElement('canvas');
      canvas.className = 'wave-trace';
      canvas.setAttribute('role', 'img');
      canvas.setAttribute('aria-label', `${path} waveform`);
      canvas.dataset.width = String(width);
      canvas.dataset.gridlines = String(prefs.gridlines);
      row.append(label, makeTrack(canvas, path));
      fragment.append(row);
      rows.push({ path, row, canvas, value, stale: true });
    }
    container.append(fragment);
    // Row positions are fixed until the next rebuild; read them once so painting never forces layout.
    for (const entry of rows) entry.top = entry.row.offsetTop;
    updateValues();
    paint();
  }

  // ---------------------------------------------------------------- side panels
  function copyValue(text) {
    navigator.clipboard?.writeText(text)
      .then(() => {
        $('save-state').textContent = 'Signal value copied';
        onStatusCopy?.(`Copied ${text}`);
      })
      .catch(() => { $('save-state').textContent = 'Could not copy signal value'; });
  }

  function renderInspector() {
    const target = $('signal-inspector');
    target.replaceChildren();
    if (!S.trace) {
      const p = document.createElement('p');
      p.textContent = 'No waveform loaded.';
      target.append(p);
      return;
    }
    const filter = $('inspector-filter').value.trim().toLowerCase();
    const paths = S.order.filter(path => path.toLowerCase().includes(filter)).sort((a, b) => Number(S.pinned.has(b)) - Number(S.pinned.has(a)));
    for (const path of paths) {
      const signal = store.signalByPath(path);
      if (!signal) continue;
      const row = document.createElement('div');
      row.className = `signal-inspector-row${S.pinned.has(path) ? ' is-pinned' : ''}`;
      const pin = document.createElement('button');
      pin.textContent = S.pinned.has(path) ? '★' : '☆';
      pin.setAttribute('aria-label', `${S.pinned.has(path) ? 'Unpin' : 'Pin'} ${path}`);
      pin.setAttribute('aria-pressed', String(S.pinned.has(path)));
      pin.onclick = () => store.togglePin(path);

      const name = document.createElement('button');
      name.className = 'inspector-signal-name';
      name.textContent = displayName(path);
      name.title = path;
      name.onclick = () => store.selectSignal(path);

      const value = document.createElement('button');
      value.className = 'inspector-signal-value';
      value.textContent = valueFor(signal);
      value.title = `Copy ${value.textContent}`;
      value.setAttribute('aria-label', `Copy value of ${path}`);
      value.onclick = () => copyValue(value.textContent);

      row.append(pin, name, value);
      target.append(row);
    }
  }

  function renderSignalTree() {
    const target = $('signal-tree');
    target.replaceChildren();
    if (!S.trace) return;
    const filter = $('signal-filter').value.trim().toLowerCase();
    const root = { children: new Map(), signals: [] };
    for (const path of S.order.filter(name => !groups.has(name) && name.toLowerCase().includes(filter))) {
      const parts = path.split('.');
      const name = parts.pop();
      let node = root;
      for (const part of parts) {
        if (!node.children.has(part)) node.children.set(part, { children: new Map(), signals: [] });
        node = node.children.get(part);
      }
      node.signals.push({ path, name });
    }
    function append(node, parent) {
      for (const [name, child] of node.children) {
        const section = document.createElement('details');
        section.open = true;
        const summary = document.createElement('summary');
        summary.textContent = name;
        section.append(summary);
        append(child, section);
        parent.append(section);
      }
      for (const signal of node.signals) {
        const row = document.createElement('div');
        row.className = 'signal-tree-row';
        const label = document.createElement('label');
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.checked = S.visible.has(signal.path);
        check.setAttribute('aria-label', `Show ${signal.path}`);
        check.onchange = () => store.toggleVisible(signal.path, check.checked);
        label.append(check, document.createTextNode(signal.name));

        const index = S.order.indexOf(signal.path);
        const up = document.createElement('button');
        up.textContent = '↑';
        up.setAttribute('aria-label', `Move ${signal.path} up`);
        up.disabled = index === 0;
        up.onclick = () => store.moveSignal(signal.path, -1);

        const down = document.createElement('button');
        down.textContent = '↓';
        down.setAttribute('aria-label', `Move ${signal.path} down`);
        down.disabled = index === S.order.length - 1;
        down.onclick = () => store.moveSignal(signal.path, 1);

        row.append(label, up, down);
        parent.append(row);
      }
    }
    append(root, target);
  }

  function showTraceChrome() {
    const loaded = S.trace !== null;
    $('wave-error').textContent = '';
    $('wave-empty').hidden = loaded;
    container.hidden = !loaded;
    $('download-vcd').disabled = !loaded;
    for (const id of ['wave-play', 'wave-step-prev', 'wave-step-next', 'wave-value-find']) $(id).disabled = !loaded;
    if (loaded) container.setAttribute('aria-label', `${S.rawLabel} waveforms`);
    else {
      $('wave-cursor').textContent = 'No trace loaded';
      $('clear-marker-b').disabled = true;
    }
  }

  function updatePlayButton() {
    const button = $('wave-play');
    button.setAttribute('aria-pressed', String(S.playing));
    button.textContent = S.playing ? '❚❚' : '▶';
    button.setAttribute('aria-label', S.playing ? 'Pause playback' : 'Play cycles');
    button.title = S.playing ? 'Pause playback' : 'Play: step clock cycles';
  }

  store.subscribe((_, kind) => {
    if (kind === 'trace') {
      showTraceChrome();
      renderSignalTree();
      buildRows();
      renderInspector();
      updatePlayButton();
    } else if (kind === 'layout') {
      renderSignalTree();
      buildRows();
      renderInspector();
    } else if (kind === 'cursor') {
      updateValues();
      renderInspector();
      schedulePaint();
    } else if (kind === 'selection') {
      for (const entry of rows) entry.row.classList.toggle('selected', entry.path === S.selected);
    } else if (kind === 'pins') {
      renderInspector();
    } else if (kind === 'playing') {
      updatePlayButton();
    }
  });

  // ---------------------------------------------------------------- controls
  function zoomTo(value, anchor) {
    if (!S.trace) return;
    const rect = container.getBoundingClientRect();
    const labelW = labelWidth();
    const position = anchor === undefined ? Math.max(0, (rect.width - labelW) / 2) : Math.max(0, anchor - rect.left - labelW);
    const fraction = (container.scrollLeft + position) / width;
    $('wave-zoom').value = String(Math.max(1, Math.min(Number($('wave-zoom').max), value)));
    buildRows();
    container.scrollLeft = fraction * width - position;
    paint();
  }

  function lookupSignal(name) {
    if (!S.trace || !name) return null;
    const exact = S.trace.signals.find(s => s.path === name);
    const byLeaf = exact || S.trace.signals.find(s => s.path.split('.').at(-1) === name);
    if (!byLeaf) return null;
    const time = store.currentTime();
    const raw = store.valueOf(byLeaf, time);
    return {
      path: byLeaf.path,
      width: byLeaf.width,
      time: formatTime(time, S.trace.timescale),
      marker: S.activeMarker,
      raw,
      pinned: S.pinned.has(byLeaf.path),
      formatted: {
        hex: formatValue(raw, byLeaf.width, 'hex'),
        unsigned: formatValue(raw, byLeaf.width, 'dec'),
        signed: formatValue(raw, byLeaf.width, 'signed'),
        bin: formatValue(raw, byLeaf.width, 'bin'),
        ascii: formatValue(raw, byLeaf.width, 'ascii'),
        state: fsmMap ? stateNameFor(fsmMap, byLeaf.path, raw) : null,
      },
    };
  }

  function findValue() {
    const query = $('wave-value-search').value;
    const target = S.selected;
    if (!S.trace || !target) { $('wave-error').textContent = 'Select a signal to search.'; return null; }
    const time = store.findNextValue(target, query);
    $('wave-error').textContent = time === null ? `No transition of ${displayName(target)} matches "${query.trim()}".` : '';
    if (time !== null) {
      // Bring the hit into view.
      const { visibleWidth } = viewport();
      const x = xOf(time);
      if (x < container.scrollLeft || x > container.scrollLeft + visibleWidth) container.scrollLeft = Math.max(0, x - visibleWidth / 2);
    }
    return time;
  }

  $('wave-add-group').onclick = () => {
    if (!S.trace) return;
    const name = prompt('Group name', 'Group'); if (name === null) return;
    const id = `@group:${Date.now()}:${Math.random()}`;
    groups.set(id, { name: name.trim() || 'Group', collapsed: false });
    const index = S.selected ? S.order.indexOf(S.selected) : -1;
    S.order.splice(index < 0 ? S.order.length : index, 0, id); buildRows();
  };
  $('wave-add-slice').onclick = () => {
    if (!S.trace) return;
    const source = store.signalByPath(S.selected);
    const spec = prompt('Signal slice', source && source.width > 1 ? `${source.path}[${source.width - 1}:0]` : '');
    if (spec === null) return;
    if (!addSlice(spec)) { $('wave-error').textContent = 'Enter a valid slice of a loaded signal.'; return; }
    $('wave-error').textContent = ''; renderSignalTree(); buildRows();
  };
  $('wave-save-view').onclick = () => {
    if (!S.trace) return;
    const name = prompt('View name'); if (!name?.trim()) return;
    views[name.trim()] = { order: [...S.order], visible: [...S.visible], groups: [...groups].map(([id, group]) => [id, { ...group }]), slices: [...slices], overrides: [...S.overrides], prefs: { ...prefs } };
    saveViews(); $('wave-views').value = name.trim();
  };
  $('wave-delete-view').onclick = () => { const name = $('wave-views').value; if (!name) return; delete views[name]; saveViews(); };
  $('wave-views').onchange = () => {
    const view = views[$('wave-views').value]; if (!view || !S.trace) return;
    groups.clear(); for (const [id, group] of view.groups || []) groups.set(id, { ...group });
    for (const [, spec] of view.slices || []) addSlice(spec);
    const allowed = new Set([...S.trace.signals.map(s => s.path), ...groups.keys()]);
    S.order = [...(view.order || []).filter(path => allowed.has(path)), ...S.order.filter(path => !view.order?.includes(path) && !groups.has(path))];
    S.visible = new Set((view.visible || []).filter(path => allowed.has(path)));
    S.overrides = new Map(view.overrides || []); prefs = { ...prefs, ...view.prefs }; savePrefs(); applyPrefsUI(); renderSignalTree(); buildRows(); renderInspector();
  };
  refreshViews();
  function plotSignal(pathOrName) {
    if (!S.trace || typeof pathOrName !== 'string' || !pathOrName) return false;
    const signal = S.trace.signals.find(item => item.path === pathOrName)
      || S.trace.signals.find(item => item.path.endsWith(`.${pathOrName}`))
      || S.trace.signals.find(item => item.path.split('.').at(-1) === pathOrName.split('.').at(-1));
    if (!signal) return false;
    if (!S.order.includes(signal.path)) S.order.push(signal.path);
    let currentGroup = null;
    for (const path of S.order) { if (groups.has(path)) currentGroup = groups.get(path); if (path === signal.path) break; }
    if (currentGroup?.collapsed) currentGroup.collapsed = false;
    S.visible.add(signal.path); store.selectSignal(signal.path, { reveal: true });
    renderSignalTree(); buildRows(); renderInspector();
    rows.find(item => item.path === signal.path)?.row.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return true;
  }
  document.addEventListener('datapath:plot-signal', event => { if (typeof event.detail === 'string') plotSignal(event.detail); });
  const plotPanel = $('waveform');
  plotPanel.addEventListener('dragover', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('application/x-datapath-signal')) return;
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; plotPanel.classList.add('is-plot-drop');
  });
  plotPanel.addEventListener('dragleave', event => { if (!plotPanel.contains(event.relatedTarget)) plotPanel.classList.remove('is-plot-drop'); });
  plotPanel.addEventListener('drop', event => {
    if (!Array.from(event.dataTransfer?.types || []).includes('application/x-datapath-signal')) return;
    event.preventDefault(); event.stopPropagation(); plotPanel.classList.remove('is-plot-drop');
    const raw = event.dataTransfer.getData('application/x-datapath-signal'); let name = raw;
    try { const parsed = JSON.parse(raw); name = typeof parsed === 'string' ? parsed : parsed.path || parsed.name; } catch { /* Plain signal path. */ }
    if (!plotSignal(name)) $('wave-error').textContent = `Signal not found: ${name || ''}`;
  });
  $('open-vcd').onclick = () => $('vcd-input').click();
  $('download-vcd').onclick = () => {
    if (!S.rawVcd) return;
    const url = URL.createObjectURL(new Blob([S.rawVcd], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = S.rawLabel.split('/').at(-1) || 'wave.vcd';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  $('wave-fit').onclick = () => { if (!S.trace) return; $('wave-zoom').max = '10'; $('wave-zoom').value = '1'; buildRows(); container.scrollLeft = 0; paint(); };
  $('wave-zoom').oninput = () => buildRows();
  $('wave-zoom-in').onclick = () => zoomTo(Number($('wave-zoom').value) + 1);
  $('wave-zoom-out').onclick = () => zoomTo(Number($('wave-zoom').value) - 1);
  $('wave-radix').onchange = () => { updateValues(); renderInspector(); paint(); };
  $('signal-filter').oninput = renderSignalTree;
  $('inspector-filter').oninput = renderInspector;
  $('marker-a').onclick = () => store.setActiveMarker('A');
  $('marker-b').onclick = () => store.setActiveMarker('B');
  $('clear-marker-b').onclick = () => store.clearMarkerB();
  $('wave-short-names').onclick = () => { prefs.shortNames = !prefs.shortNames; applyPrefsUI(); savePrefs(); buildRows(); renderInspector(); };
  $('wave-gridlines').onclick = () => { prefs.gridlines = !prefs.gridlines; applyPrefsUI(); savePrefs(); paint(); };
  $('wave-snap').onclick = () => { prefs.snap = !prefs.snap; applyPrefsUI(); savePrefs(); };
  $('previous-edge').onclick = () => store.edgeStep(-1);
  $('next-edge').onclick = () => store.edgeStep(1);
  $('wave-step-prev').onclick = () => store.stepCycle(-1);
  $('wave-step-next').onclick = () => store.stepCycle(1);
  $('wave-play').onclick = () => { if (S.playing) store.pause(); else store.play(); };
  $('wave-value-find').onclick = findValue;
  $('wave-value-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); findValue(); } };
  applyPrefsUI();
  updatePlayButton();
  showTraceChrome();

  container.addEventListener('scroll', schedulePaint, { passive: true });
  if (typeof ResizeObserver === 'function') new ResizeObserver(schedulePaint).observe(container);
  // Theme switches restyle CSS variables; repaint so canvas colors follow.
  new MutationObserver(schedulePaint).observe(document.body, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
  container.addEventListener('wheel', event => {
    if (!S.trace || !(event.target instanceof Element) || !event.target.closest('.wave-track')) return;
    event.preventDefault();
    zoomTo(Number($('wave-zoom').value) + (event.deltaY < 0 ? 1 : -1), event.clientX);
  }, { passive: false });
  document.addEventListener('keydown', event => {
    if (!S.trace || $('waveform').hidden || !$('waveform').contains(event.target) || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName) || event.target.isContentEditable) return;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      store.edgeStep(event.key === 'ArrowRight' ? 1 : -1);
    }
  });
  $('vcd-input').onchange = async event => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      if (file.size > 32 * 1024 * 1024) throw new Error('VCD exceeds the 32 MB limit.');
      store.loadVcd(await file.text(), file.name);
      store.clearMemTrace();
    } catch (error) {
      $('wave-error').textContent = `Could not open VCD: ${error.message}`;
    }
  };

  return {
    store,
    loadVcd: (text, label) => store.loadVcd(text, label),
    clearVcd: () => store.clearVcd(),
    currentVcd: () => S.rawVcd,
    lookupSignal,
    plotSignal,
    selectSignal: path => store.selectSignal(path, { reveal: true }),
    togglePin: path => store.togglePin(path),
    repaint: schedulePaint,
    // Symbolic FSM names (fsm-states.js); null disables them.
    setFsmMap: map => { fsmMap = map; if (S.trace) { updateValues(); renderInspector(); paint(); } },
  };
}
