// Shared waveform trace + playback state. Views subscribe and re-render on the change kinds they care about.
import { parseVcd, valueAt } from './vcd.js';

// Change kinds passed to subscribers:
//   'trace'     a trace was loaded or cleared (full rebuild)
//   'layout'    order / visibility / radix overrides changed (rows rebuild)
//   'cursor'    marker positions or active marker changed (redraw only)
//   'selection' selected signal changed
//   'pins'      pinned set changed
//   'playing'   playback started or stopped
//   'mem'       a memory/register-file trace was loaded or cleared

export function parseSearchValue(query) {
  const text = String(query || '').trim().toLowerCase().replace(/_/g, '');
  if (!text) return null;
  let match;
  if ((match = /^(?:\d+)?'?h([0-9a-f]+)$/.exec(text)) || (match = /^0x([0-9a-f]+)$/.exec(text))) return BigInt(`0x${match[1]}`);
  if ((match = /^(?:\d+)?'?b([01]+)$/.exec(text)) || (match = /^0b([01]+)$/.exec(text))) return BigInt(`0b${match[1]}`);
  if ((match = /^(?:\d+)?'?d(\d+)$/.exec(text)) || (match = /^0d(\d+)$/.exec(text))) return BigInt(match[1]);
  if (/^-\d+$/.test(text)) return BigInt(text);
  if (/^\d+$/.test(text)) return BigInt(text);
  if (/^[0-9a-f]+$/.test(text)) return BigInt(`0x${text}`);
  return null;
}

function matchesValue(raw, width, target) {
  if (raw === null || /[xz]/.test(raw)) return false;
  const value = BigInt(`0b${raw}`);
  if (target >= 0n) return value === target;
  // Negative search values compare in two's complement at the signal width.
  return value === ((1n << BigInt(width)) + target);
}

// Index a vvp memory trace ({ timescale, arrays: [{ path, width, size, left, right, init, deltas }] }) for time queries.
export function prepareMemTrace(raw) {
  if (!raw || !Array.isArray(raw.arrays)) return null;
  const arrays = raw.arrays.filter(array => array && typeof array.path === 'string').map(array => {
    const deltas = (Array.isArray(array.deltas) ? array.deltas : [])
      .filter(delta => Array.isArray(delta) && delta.length === 3)
      .map(([time, index, value]) => ({ time: Number(time), index: Number(index), value: String(value) }))
      .sort((a, b) => a.time - b.time);
    const writeTimes = [...new Set(deltas.map(delta => delta.time))];
    const init = new Map(Object.entries(array.init || {}).map(([index, value]) => [Number(index), String(value)]));
    const low = Math.min(Number(array.left) || 0, Number(array.right) || 0);
    return { path: array.path, width: Number(array.width) || 1, size: Number(array.size) || 0, left: Number(array.left) || 0, right: Number(array.right) || 0, low, init, deltas, writeTimes };
  });
  const endTime = arrays.reduce((end, array) => Math.max(end, array.writeTimes.at(-1) ?? 0), 0);
  return { timescale: raw.timescale || null, truncated: raw.truncated === true, arrays, endTime };
}

const lastAtOrBefore = (sorted, value, key = item => item) => {
  let low = 0, high = sorted.length;
  while (low < high) { const mid = (low + high) >>> 1; if (key(sorted[mid]) <= value) low = mid + 1; else high = mid; }
  return low - 1;
};

export function createSimTrace({ playIntervalMs = 180 } = {}) {
  const state = {
    trace: null,
    rawVcd: null,
    rawLabel: 'wave.vcd',
    markerA: 0n,
    markerB: null,
    activeMarker: 'A',
    selected: null,
    order: [],
    visible: new Set(),
    pinned: new Set(),
    overrides: new Map(),
    playing: false,
    memTrace: null,
  };
  const listeners = new Set();
  let playTimer = null;

  const emit = kind => { for (const fn of listeners) fn(state, kind); };
  const signalByPath = path => state.trace?.signals.find(signal => signal.path === path) || null;
  const currentTime = () => state.activeMarker === 'A' ? state.markerA : (state.markerB ?? 0n);
  const hasTime = () => state.trace !== null || state.memTrace !== null;
  const endTime = () => {
    const vcdEnd = state.trace?.endTime ?? 0n;
    const memEnd = BigInt(state.memTrace?.endTime ?? 0);
    return vcdEnd > memEnd ? vcdEnd : memEnd;
  };

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  function loadVcd(text, label = 'wave.vcd') {
    const parsed = parseVcd(text);
    if (!parsed.signals.length) throw new Error('No signals found in this VCD file.');
    pause();
    const paths = parsed.signals.map(signal => signal.path);
    const known = new Set(paths);
    // Keep the user's setup for signals that survive a re-run; new signals are appended visible.
    const previousOrder = state.order.filter(path => known.has(path));
    const shared = previousOrder.length > 0;
    const previous = new Set(previousOrder);
    const order = [...previousOrder, ...paths.filter(path => !previous.has(path))];
    const visible = new Set(order.filter(path => !previous.has(path) || state.visible.has(path)));
    state.trace = parsed;
    state.rawVcd = text;
    state.rawLabel = label || 'wave.vcd';
    state.markerA = 0n;
    state.markerB = null;
    state.activeMarker = 'A';
    state.order = order;
    state.visible = shared ? visible : new Set(order);
    state.pinned = new Set([...state.pinned].filter(path => known.has(path)));
    state.overrides = new Map([...state.overrides].filter(([path]) => known.has(path)));
    state.selected = state.selected && known.has(state.selected) ? state.selected : order[0] || null;
    emit('trace');
  }

  // Drops the loaded trace but remembers the signal setup so the next trace can restore it.
  function clearVcd() {
    pause();
    state.trace = null;
    state.rawVcd = null;
    state.markerA = 0n;
    state.markerB = null;
    state.activeMarker = 'A';
    emit('trace');
    clearMemTrace();
  }

  function setMarker(time) {
    if (!hasTime()) return;
    const clamped = time < 0n ? 0n : time;
    if (state.activeMarker === 'A') state.markerA = clamped;
    else state.markerB = clamped;
    emit('cursor');
  }

  function setActiveMarker(marker) {
    state.activeMarker = marker === 'B' ? 'B' : 'A';
    if (state.activeMarker === 'B' && state.markerB === null) state.markerB = 0n;
    emit('cursor');
  }

  function clearMarkerB() {
    state.markerB = null;
    state.activeMarker = 'A';
    emit('cursor');
  }

  function selectSignal(path, { reveal = false } = {}) {
    const signal = signalByPath(path);
    if (!signal) return false;
    state.selected = signal.path;
    if (reveal && !state.visible.has(signal.path)) {
      state.visible.add(signal.path);
      emit('layout');
    }
    emit('selection');
    return true;
  }

  function toggleVisible(path, show = !state.visible.has(path)) {
    if (show) state.visible.add(path);
    else state.visible.delete(path);
    emit('layout');
  }

  // Moves a signal by an offset, or before another signal when `beforePath` is given.
  function moveSignal(path, direction, beforePath = null) {
    const index = state.order.indexOf(path);
    if (index < 0) return;
    if (beforePath !== null) {
      if (beforePath === path || !state.order.includes(beforePath)) return;
      state.order.splice(index, 1);
      state.order.splice(state.order.indexOf(beforePath), 0, path);
    } else {
      const next = index + direction;
      if (next < 0 || next >= state.order.length) return;
      [state.order[index], state.order[next]] = [state.order[next], state.order[index]];
    }
    emit('layout');
  }

  function togglePin(path) {
    if (!signalByPath(path)) return false;
    if (state.pinned.has(path)) state.pinned.delete(path);
    else state.pinned.add(path);
    emit('pins');
    return state.pinned.has(path);
  }

  function setRadixOverride(path, radix) {
    if (radix) state.overrides.set(path, radix);
    else state.overrides.delete(path);
    emit('layout');
  }

  // Jump the active marker to the previous/next transition of the selected signal.
  function edgeStep(direction) {
    const signal = signalByPath(state.selected);
    if (!signal) return false;
    const now = currentTime();
    const times = signal.changes.map(change => change.time);
    const next = direction > 0 ? times.find(time => time > now) : times.findLast(time => time < now);
    if (next === undefined) return false;
    setMarker(next);
    return true;
  }

  // The playback clock: the selected 1-bit signal, else a clk-like 1-bit signal, else any 1-bit signal.
  function clockSignal() {
    const signals = state.trace?.signals || [];
    const selected = signalByPath(state.selected);
    if (selected?.width === 1 && /cl(?:oc)?k/i.test(selected.path.split('.').at(-1))) return selected;
    const oneBit = signals.filter(signal => signal.width === 1);
    const prefer = (list, test) => list.find(signal => test(signal.path.split('.').at(-1)));
    return prefer(oneBit, name => /^(?:clk|clock)$/i.test(name))
      || prefer(oneBit, name => /cl(?:oc)?k/i.test(name))
      || (selected?.width === 1 ? selected : null)
      || oneBit[0] || null;
  }

  // Without a VCD clock, step between memory write times instead.
  function memStep(direction) {
    const times = [...new Set((state.memTrace?.arrays || []).flatMap(array => array.writeTimes))].sort((a, b) => a - b).map(BigInt);
    const now = currentTime();
    const next = direction > 0 ? times.find(time => time > now) : times.findLast(time => time < now);
    if (next === undefined) return false;
    setMarker(next);
    return true;
  }

  // Step the active marker one clock cycle (rising edge); falls back to edge stepping.
  function stepCycle(direction) {
    const clock = clockSignal();
    if (!clock) return state.trace && state.selected ? edgeStep(direction) : memStep(direction);
    const now = currentTime();
    const rising = [];
    for (let i = 0; i < clock.changes.length; i++) {
      const previous = i ? clock.changes[i - 1].value : null;
      if (clock.changes[i].value === '1' && previous !== '1') rising.push(clock.changes[i].time);
    }
    const next = direction > 0 ? rising.find(time => time > now) : rising.findLast(time => time < now);
    if (next === undefined) return false;
    setMarker(next);
    return true;
  }

  // Start of the cycle that ends at `time`: the previous rising clock edge (or memory write step) before it.
  function previousCycleTime(time = currentTime()) {
    const clock = clockSignal();
    if (clock) {
      let previous = null;
      for (let i = 0; i < clock.changes.length; i++) {
        const change = clock.changes[i];
        if (change.time >= time) break;
        if (change.value === '1' && (i === 0 || clock.changes[i - 1].value !== '1')) previous = change.time;
      }
      return previous;
    }
    const times = [...new Set((state.memTrace?.arrays || []).flatMap(array => array.writeTimes))].sort((a, b) => a - b);
    const earlier = times.filter(at => at < Number(time));
    return earlier.length ? BigInt(earlier.at(-1)) : null;
  }

  // Array writes with from < time <= to (the last value per word), oldest array first.
  function memWritesBetween(from, to) {
    const out = [];
    const low = Number(from), high = Number(to);
    for (const array of state.memTrace?.arrays || []) {
      const last = new Map();
      for (const delta of array.deltas) {
        if (delta.time <= low) continue;
        if (delta.time > high) break;
        last.set(delta.index, delta);
      }
      for (const [index, delta] of last) out.push({ path: array.path, index, value: delta.value, time: delta.time, width: array.width, size: array.size, low: array.low });
    }
    return out;
  }

  function play() {
    if (!hasTime() || state.playing) return;
    if (currentTime() >= endTime()) setMarker(0n);
    state.playing = true;
    playTimer = setInterval(() => { if (!stepCycle(1)) pause(); }, playIntervalMs);
    emit('playing');
  }

  function pause() {
    if (playTimer !== null) clearInterval(playTimer);
    playTimer = null;
    if (!state.playing) return;
    state.playing = false;
    emit('playing');
  }

  // Moves Marker A to the next transition (wrapping) where `path` equals the hex/dec/bin query.
  function findNextValue(path, query) {
    const signal = signalByPath(path);
    const target = parseSearchValue(query);
    if (!signal || target === null) return null;
    const from = state.markerA;
    const hits = signal.changes.filter(change => matchesValue(change.value, signal.width, target));
    const hit = hits.find(change => change.time > from) || hits[0];
    if (!hit) return null;
    state.activeMarker = 'A';
    state.markerA = hit.time;
    emit('cursor');
    return hit.time;
  }

  function loadMemTrace(raw) {
    state.memTrace = prepareMemTrace(raw);
    if (state.memTrace && !state.memTrace.arrays.length) state.memTrace = null;
    emit('mem');
  }

  function clearMemTrace() {
    if (state.memTrace === null) return;
    state.memTrace = null;
    emit('mem');
  }

  /*
   * Contents of `arrayPath` at `time`: words (index -> hex), lastWriteTime (index -> time) and heat
   * (index -> 0..3), where 0 marks words written at the most recent write step <= time and 1..3 mark
   * words last written one to three write steps earlier.
   */
  function getMemorySnapshot(arrayPath, time = currentTime()) {
    const array = state.memTrace?.arrays.find(item => item.path === arrayPath);
    if (!array) return null;
    const at = Number(time);
    const words = new Map(array.init);
    const lastWriteTime = new Map();
    const end = lastAtOrBefore(array.deltas, at, delta => delta.time);
    for (let i = 0; i <= end; i++) {
      const delta = array.deltas[i];
      words.set(delta.index, delta.value);
      lastWriteTime.set(delta.index, delta.time);
    }
    const step = lastAtOrBefore(array.writeTimes, at);
    const levels = new Map();
    for (let level = 0; level < 4 && step - level >= 0; level++) levels.set(array.writeTimes[step - level], level);
    const heat = new Map();
    for (const [index, written] of lastWriteTime) if (levels.has(written)) heat.set(index, levels.get(written));
    const { path, width, size, left, right, low } = array;
    return { array: { path, width, size, left, right, low }, words, heat, lastWriteTime };
  }

  return {
    subscribe,
    loadMemTrace,
    clearMemTrace,
    getMemorySnapshot,
    memArrays: () => (state.memTrace?.arrays || []).map(({ path, width, size, left, right, low }) => ({ path, width, size, left, right, low })),
    endTime,
    hasTime,
    getState: () => state,
    signalByPath,
    currentTime,
    valueOf: (signal, time = currentTime()) => valueAt(signal, time),
    loadVcd,
    clearVcd,
    setMarker,
    setActiveMarker,
    clearMarkerB,
    selectSignal,
    toggleVisible,
    moveSignal,
    togglePin,
    setRadixOverride,
    edgeStep,
    stepCycle,
    previousCycleTime,
    memWritesBetween,
    play,
    pause,
    findNextValue,
  };
}
