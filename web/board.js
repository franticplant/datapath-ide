// Board tab: LED banks, 7-segment displays and probes, replayed from the shared trace or driven live
// through a steppable vvp session (vvp_session_* in a dedicated worker).
import { formatTime, formatValue } from './waveform.js';

export const LIVE_TOP = '_live_board_tb';
const SVG = 'http://www.w3.org/2000/svg';
const MAX_LEDS = 32;
const MAX_DIGITS = 8;

// ---------------------------------------------------------------- port parsing

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');

// Tiny integer evaluator for port ranges: numbers, parameters, + - * / % ** << >> and parentheses.
function evaluate(expression, params) {
  const tokens = expression.match(/\d+'[sS]?[dDhHbBoO][0-9a-fA-F_]+|\d+|[A-Za-z_][\w$]*|\*\*|<<|>>|[-+*/%()]/g) || [];
  let pos = 0;
  const peek = () => tokens[pos];
  const literal = token => {
    const sized = /^\d+'[sS]?([dDhHbBoO])([0-9a-fA-F_]+)$/.exec(token);
    if (!sized) return Number(token);
    const radix = { d: 10, h: 16, b: 2, o: 8 }[sized[1].toLowerCase()];
    return parseInt(sized[2].replace(/_/g, ''), radix);
  };
  function primary() {
    const token = tokens[pos++];
    if (token === '(') { const value = expr(); if (tokens[pos++] !== ')') throw new Error('Unbalanced range'); return value; }
    if (token === '-') return -primary();
    if (token === '+') return primary();
    if (/^\d/.test(token ?? '')) return literal(token);
    if (/^[A-Za-z_]/.test(token ?? '') && Object.hasOwn(params, token)) return params[token];
    throw new Error(`Unknown value ${token ?? ''}`);
  }
  function power() { let value = primary(); while (peek() === '**') { pos++; value **= primary(); } return value; }
  function term() {
    let value = power();
    while (['*', '/', '%'].includes(peek())) {
      const op = tokens[pos++]; const right = power();
      value = op === '*' ? value * right : op === '/' ? Math.trunc(value / right) : value % right;
    }
    return value;
  }
  function sum() { let value = term(); while (peek() === '+' || peek() === '-') { const op = tokens[pos++]; const right = term(); value = op === '+' ? value + right : value - right; } return value; }
  function expr() { let value = sum(); while (peek() === '<<' || peek() === '>>') { const op = tokens[pos++]; const right = sum(); value = op === '<<' ? value << right : value >> right; } return value; }
  const value = expr();
  if (pos !== tokens.length || !Number.isFinite(value)) throw new Error('Unsupported range expression');
  return value;
}

function widthOf(range, params) {
  if (!range) return 1;
  const match = /^\[([^:\]]+):([^\]]+)\]$/.exec(range.replace(/\s+/g, ''));
  if (!match) throw new Error(`Unsupported range ${range}`);
  return Math.abs(evaluate(match[1], params) - evaluate(match[2], params)) + 1;
}

// Splits on commas that are not nested inside (), [] or {}.
function splitTopLevel(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth--;
    else if (ch === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map(part => part.trim()).filter(Boolean);
}

function matchingParen(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

const DECL = /^(input|output|inout)\b\s*(?:(?:wire|reg|logic|tri|var|signed|unsigned)\b\s*)*(\[[^\]]*\])?\s*(?:(?:signed|unsigned)\b\s*)?(.*)$/s;

// Ports of `moduleName` in `text`, ANSI or Verilog-95 style: [{ name, dir, width }].
export function parseModulePorts(text, moduleName) {
  const source = stripComments(text);
  const header = new RegExp(`\\bmodule\\s+${moduleName.replace(/\$/g, '\\$')}\\b`).exec(source);
  if (!header) throw new Error(`Module ${moduleName} not found`);
  const endIndex = source.indexOf('endmodule', header.index);
  const moduleText = source.slice(header.index, endIndex < 0 ? undefined : endIndex);
  let cursor = header[0].length;
  const params = {};
  const addParams = list => {
    for (const item of splitTopLevel(list)) {
      const param = /^(?:parameter|localparam)?\s*(?:integer|signed|unsigned|\[[^\]]*\]\s*)*\s*([A-Za-z_][\w$]*)\s*=\s*(.+)$/s.exec(item.trim());
      if (param) { try { params[param[1]] = evaluate(param[2], params); } catch { /* Non-numeric parameter. */ } }
    }
  };
  const hash = /^\s*#\s*\(/.exec(moduleText.slice(cursor));
  if (hash) {
    const open = cursor + hash[0].length - 1;
    const close = matchingParen(moduleText, open);
    addParams(moduleText.slice(open + 1, close).replace(/\bparameter\b/g, ''));
    cursor = close + 1;
  }
  const open = moduleText.indexOf('(', cursor);
  const semicolon = moduleText.indexOf(';', cursor);
  let portList = '';
  let bodyStart = semicolon + 1;
  if (open >= 0 && (semicolon < 0 || open < semicolon)) {
    const close = matchingParen(moduleText, open);
    portList = moduleText.slice(open + 1, close);
    bodyStart = moduleText.indexOf(';', close) + 1;
  }
  const body = moduleText.slice(bodyStart);
  for (const statement of body.split(';')) {
    const param = /^\s*(?:parameter|localparam)\b([\s\S]*)$/.exec(statement);
    if (param) addParams(param[1]);
  }

  const ports = [];
  const byName = new Map();
  const declare = (name, dir, range) => {
    const port = { name, dir, width: widthOf(range, params) };
    if (byName.has(name)) Object.assign(byName.get(name), port);
    else { byName.set(name, port); ports.push(port); }
  };
  let currentDir = null, currentRange = null;
  for (const item of splitTopLevel(portList)) {
    const decl = DECL.exec(item);
    if (decl) {
      currentDir = decl[1]; currentRange = decl[2] || null;
      const name = /([A-Za-z_][\w$]*)\s*(?:=.*)?$/s.exec(decl[3].trim())?.[1];
      if (name) declare(name, currentDir, currentRange);
    } else {
      const name = /^([A-Za-z_][\w$]*)/.exec(item)?.[1];
      if (!name) continue;
      if (currentDir) declare(name, currentDir, currentRange);   // ANSI continuation: "input a, b"
      else { byName.set(name, { name, dir: null, width: 1 }); ports.push(byName.get(name)); }   // Verilog-95 header
    }
  }
  for (const statement of body.split(';')) {
    const decl = DECL.exec(statement.trim());
    if (!decl) continue;
    for (const item of splitTopLevel(decl[3])) {
      const name = /^([A-Za-z_][\w$]*)/.exec(item)?.[1];
      if (name && byName.has(name)) declare(name, decl[1], decl[2] || null);
    }
  }
  const missing = ports.filter(port => !port.dir);
  if (missing.length) throw new Error(`No direction declared for port ${missing[0].name}`);
  return ports;
}

export const isClockName = name => /^(?:clk|clock)(?:_?i|_in)?$/i.test(name) || /^(?:sys_?)?clk/i.test(name);
const resetPolarity = name => /^(?:rst|reset)(?:_?i|_in)?$/i.test(name) ? 1 : /^(?:rst_?n|reset_?n|n_?rst|n_?reset|rstb|resetb)(?:_?i)?$/i.test(name) ? 0 : null;

// Hidden top that drives the DUT's inputs from regs and exposes its outputs as wires.
export function liveWrapper(moduleName, ports) {
  const range = port => port.width > 1 ? `[${port.width - 1}:0] ` : '';
  const lines = ['`timescale 1ns/1ns', `module ${LIVE_TOP};`];
  for (const port of ports) {
    if (port.dir === 'input') {
      const polarity = resetPolarity(port.name);
      lines.push(`  reg ${range(port)}${port.name} = ${polarity === null ? 0 : polarity};`);
    } else lines.push(`  wire ${range(port)}${port.name};`);
  }
  lines.push(`  ${moduleName} dut(${ports.map(port => `.${port.name}(${port.name})`).join(', ')});`, 'endmodule', '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- live worker client

class LiveClient {
  constructor(createWorker) {
    this.worker = createWorker();
    this.pending = new Map();
    this.nextId = 0;
    this.chain = Promise.resolve();
    this.worker.onmessage = ({ data }) => {
      if (data?.type !== 'live-reply') return;
      const entry = this.pending.get(data.requestId);
      if (!entry) return;
      this.pending.delete(data.requestId);
      if (data.error) entry.reject(new Error(data.error));
      else entry.resolve(data);
    };
    this.worker.onerror = event => {
      for (const entry of this.pending.values()) entry.reject(new Error(event.message || 'Live engine failed'));
      this.pending.clear();
    };
  }

  // Requests run one at a time so the worker never interleaves session calls.
  request(type, payload = {}) {
    const run = () => new Promise((resolve, reject) => {
      const requestId = ++this.nextId;
      this.pending.set(requestId, { resolve, reject });
      this.worker.postMessage({ ...payload, type, requestId });
    });
    const result = this.chain.then(run, run);
    this.chain = result.catch(() => {});
    return result;
  }

  terminate() {
    this.worker.terminate();
    for (const entry of this.pending.values()) entry.reject(new Error('Live session stopped'));
    this.pending.clear();
  }
}

// ---------------------------------------------------------------- widgets

const SEGMENTS = {
  a: '6,4 34,4 30,9 10,9', b: '35,6 35,33 30,30 30,10', c: '35,37 35,64 30,60 30,40',
  d: '6,66 34,66 30,61 10,61', e: '5,37 5,64 10,60 10,40', f: '5,6 5,33 10,30 10,10', g: '7,35 12,31 28,31 33,35 28,39 12,39',
};
const DIGIT_SEGMENTS = ['abcdef', 'bc', 'abdeg', 'abcdg', 'bcfg', 'acdfg', 'acdefg', 'abc', 'abcdefg', 'abcdfg', 'abcefg', 'cdefg', 'adef', 'bcdeg', 'adefg', 'aefg'];

function sevenSegmentDigit(nibble) {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 40 70');
  svg.setAttribute('class', 'seg-digit');
  const unknown = nibble === null;
  const lit = unknown ? 'g' : DIGIT_SEGMENTS[nibble];
  for (const [name, points] of Object.entries(SEGMENTS)) {
    const polygon = document.createElementNS(SVG, 'polygon');
    polygon.setAttribute('points', points);
    polygon.setAttribute('class', `seg seg-${name}${lit.includes(name) ? ` on${unknown ? ' unknown' : ''}` : ''}`);
    svg.append(polygon);
  }
  return svg;
}

// `bits` is an MSB-first binary string padded to `width`, or null when unknown.
function widgetBody(kind, width, bits) {
  const body = document.createElement('div');
  body.className = 'board-widget-body';
  if (kind === 'led') {
    const row = document.createElement('div');
    row.className = 'led-row';
    const shown = Math.min(width, MAX_LEDS);
    for (let bit = shown - 1; bit >= 0; bit--) {
      const value = bits ? bits[width - 1 - bit] : 'x';
      const led = document.createElement('span');
      led.className = 'led-cell';
      const lamp = document.createElement('span');
      lamp.className = `led led-${value}`;
      lamp.dataset.bit = String(bit);
      lamp.title = `bit ${bit} = ${value}`;
      const label = document.createElement('small');
      label.textContent = String(bit);
      led.append(lamp, label);
      row.append(led);
    }
    body.append(row);
  } else if (kind === 'seg') {
    const display = document.createElement('div');
    display.className = 'seg-display';
    const digits = Math.min(Math.ceil(width / 4), MAX_DIGITS);
    const padded = bits ? bits.padStart(digits * 4, '0').slice(-digits * 4) : null;
    for (let digit = 0; digit < digits; digit++) {
      const nibble = padded?.slice(digit * 4, digit * 4 + 4);
      display.append(sevenSegmentDigit(nibble && !/[xz]/.test(nibble) ? parseInt(nibble, 2) : null));
    }
    body.append(display);
  }
  const readout = document.createElement('output');
  readout.className = 'board-readout';
  readout.textContent = bits ? formatValue(bits, width, 'hex') : '—';
  body.append(readout);
  return body;
}

function widgetCard({ kind, label, title, width, bits, onRemove = null, attrs = {} }) {
  const card = document.createElement('section');
  card.className = `board-widget board-${kind}`;
  for (const [key, value] of Object.entries(attrs)) card.dataset[key] = value;
  const head = document.createElement('header');
  const name = document.createElement('span');
  name.className = 'board-widget-name';
  name.textContent = label;
  name.title = title || label;
  const meta = document.createElement('small');
  meta.textContent = width > 1 ? `[${width - 1}:0]` : '1b';
  head.append(name, meta);
  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon-btn board-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove ${label} widget`);
    remove.onclick = onRemove;
    head.append(remove);
  }
  card.append(head, widgetBody(kind, width, bits));
  return card;
}

const KIND_LABELS = { led: 'LED Bank', seg: '7-Segment Hex', probe: 'Bit Probe' };

// ---------------------------------------------------------------- install

export function installBoard({ store, getFiles, getLiveSources, getSettings, getStandard, createWorker, notify, onOutput }) {
  const $ = id => document.getElementById(id);
  const S = store.getState();
  const panel = $('board');
  let mode = 'replay';
  let widgets = [];          // replay: [{ id, kind, path }]
  let nextWidget = 1;
  let frame = 0;
  let live = null;           // { client, module, ports, clock, state, busy, timer }
  const orderKey = 'datapath.board-order.v1';
  let boardOrder = {};
  try { const saved = JSON.parse(localStorage.getItem(orderKey)); if (saved && typeof saved === 'object' && !Array.isArray(saved)) boardOrder = saved; } catch { /* Invalid saved order. */ }
  let boardDrag = null;
  function arrange(host, key) {
    const saved = Array.isArray(boardOrder[key]) ? boardOrder[key] : [];
    const cards = [...host.children].filter(item => item.dataset.orderKey);
    cards.sort((a, b) => {
      const ai = saved.indexOf(a.dataset.orderKey), bi = saved.indexOf(b.dataset.orderKey);
      return (ai < 0 ? Infinity : ai) - (bi < 0 ? Infinity : bi);
    });
    cards.forEach(card => host.append(card));
    for (const card of cards) {
      const handle = card.querySelector('header, .board-input-name') || card;
      handle.draggable = true;
      handle.title = handle.title || 'Drag to reorder';
      handle.addEventListener('dragstart', event => {
        if (event.target.closest('button, input, select, textarea')) { event.preventDefault(); return; }
        boardDrag = { card, host, key, orderKey: card.dataset.orderKey }; card.classList.add('is-dragging');
        event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', card.dataset.orderKey);
      });
      handle.addEventListener('dragend', () => { card.classList.remove('is-dragging'); host.querySelectorAll('.is-drop-before').forEach(item => item.classList.remove('is-drop-before')); boardDrag = null; });
      card.addEventListener('dragover', event => {
        if (!boardDrag || boardDrag.host !== host || boardDrag.orderKey === card.dataset.orderKey) return;
        event.preventDefault(); event.dataTransfer.dropEffect = 'move';
        host.querySelectorAll('.is-drop-before').forEach(item => item.classList.remove('is-drop-before'));
        card.classList.add('is-drop-before');
      });
      card.addEventListener('dragleave', event => { if (!card.contains(event.relatedTarget)) card.classList.remove('is-drop-before'); });
      card.addEventListener('drop', event => {
        if (!boardDrag || boardDrag.host !== host || boardDrag.orderKey === card.dataset.orderKey) return;
        event.preventDefault(); event.stopPropagation();
        // A simulation tick can replace every card while the drag is in progress.
        const source = [...host.children].find(item => item.dataset.orderKey === boardDrag.orderKey);
        if (!source || !card.isConnected || source === card) { card.classList.remove('is-drop-before'); boardDrag = null; return; }
        host.insertBefore(source, card); card.classList.remove('is-drop-before'); source.classList.remove('is-dragging');
        boardOrder[key] = [...host.children].map(item => item.dataset.orderKey).filter(Boolean);
        try { localStorage.setItem(orderKey, JSON.stringify(boardOrder)); } catch { /* Reordering still works for this session. */ }
        boardDrag = null;
      });
    }
  }


  // ------------------------------------------------ replay
  const leaf = path => path.split('.').at(-1);
  const depth = path => path.split('.').length;

  function autoPopulate() {
    const signals = [...(S.trace?.signals || [])].sort((a, b) => depth(a.path) - depth(b.path));
    // Icarus gives aliased nets (a port and the wire driving it) one VCD identifier; show each net once.
    const seen = new Set();
    const unique = signals.filter(signal => !seen.has(signal.id) && seen.add(signal.id));
    const bits = unique.filter(signal => signal.width === 1).slice(0, 6);
    const buses = unique.filter(signal => signal.width > 1 && signal.width <= 32).slice(0, 3);
    widgets = [...buses.map(signal => ({ kind: 'seg', path: signal.path })), ...bits.map(signal => ({ kind: 'led', path: signal.path }))]
      .map(widget => ({ ...widget, id: nextWidget++ }));
  }

  function bitsFor(signal) {
    const raw = store.valueOf(signal);
    if (raw === null) return null;
    return raw.padStart(signal.width, /^[xz]/.test(raw) ? raw[0] : '0');
  }

  function renderReplay() {
    const host = $('board-widgets');
    host.replaceChildren();
    $('board-replay-empty').hidden = S.trace !== null;
    $('board-time').textContent = S.trace ? formatTime(store.currentTime(), S.trace.timescale) : '—';
    for (const id of ['board-step-prev', 'board-play', 'board-step-next', 'board-add-widget']) $(id).disabled = !S.trace;
    $('board-play').setAttribute('aria-pressed', String(S.playing));
    $('board-play').textContent = S.playing ? '❚❚' : '▶';
    if (!S.trace) return;
    const occurrences = new Map();
    for (const widget of widgets) {
      const signal = store.signalByPath(widget.path);
      if (!signal) continue;
      const base = `${widget.path}|${widget.kind}`; const count = occurrences.get(base) || 0; occurrences.set(base, count + 1);
      host.append(widgetCard({
        kind: widget.kind, label: leaf(widget.path), title: widget.path, width: signal.width, bits: bitsFor(signal),
        attrs: { signal: widget.path, widget: String(widget.id), orderKey: `${base}|${count}` },
        onRemove: () => { widgets = widgets.filter(item => item !== widget); renderReplay(); },
      }));
    }
    arrange(host, `replay:${S.trace?.signals[0]?.path.split('.')[0] || S.rawLabel || 'trace'}`);
  }

  function renderSignalOptions() {
    const select = $('board-widget-signal');
    const previous = select.value;
    select.replaceChildren(...(S.trace?.signals || []).map(signal => new Option(`${signal.path} [${signal.width}]`, signal.path)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  function onTrace() {
    renderSignalOptions();
    const keep = widgets.length && widgets.every(widget => store.signalByPath(widget.path));
    if (!keep) autoPopulate();
    schedule();
  }

  // ------------------------------------------------ live
  function liveBits(name, width) {
    const raw = live?.state?.signals?.[`${LIVE_TOP}.${name}`];
    if (!raw) return null;
    return raw.padStart(width, /^[xz]/.test(raw) ? raw[0] : '0');
  }

  function setLiveStatus(text, error = false) {
    $('board-live-status').textContent = text;
    $('board-live-status').classList.toggle('is-error', error);
  }

  async function liveRequest(type, payload) {
    if (!live) return null;
    live.busy = true;
    const started = performance.now();
    try {
      const reply = await live.client.request(type, payload);
      if (reply.state && live) {
        live.state = reply.state;
        if (reply.state.output?.length) onOutput?.(reply.state.output);
        setLiveStatus(`${reply.state.finished ? 'Finished' : 'Live'} · ${(performance.now() - started).toFixed(1)} ms`);
      }
      return reply;
    } catch (error) {
      setLiveStatus(error.message, true);
      return null;
    } finally {
      if (live) live.busy = false;
      renderLive();
    }
  }

  function inputControl(port) {
    const wrap = document.createElement('div');
    wrap.className = 'board-input';
    wrap.dataset.port = port.name;
    wrap.dataset.orderKey = `input:${port.name}`;
    const label = document.createElement('span');
    label.className = 'board-input-name';
    label.textContent = port.width > 1 ? `${port.name}[${port.width - 1}:0]` : port.name;
    wrap.append(label);
    const bits = liveBits(port.name, port.width);
    if (port.width === 1) {
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'board-switch';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-checked', String(bits === '1'));
      toggle.setAttribute('aria-label', `${port.name} switch`);
      toggle.textContent = bits ?? 'x';
      toggle.onclick = () => liveRequest('live-set', { signals: { [port.name]: bits === '1' ? '0' : '1' } });
      wrap.append(toggle);
    } else {
      const field = document.createElement('input');
      field.className = 'board-bus-input';
      field.setAttribute('aria-label', `${port.name} value (hex)`);
      field.spellcheck = false;
      field.value = bits && !/[xz]/.test(bits) ? BigInt(`0b${bits}`).toString(16) : '';
      field.placeholder = 'hex';
      field.onchange = () => {
        const text = field.value.trim().replace(/^0x/i, '').replace(/_/g, '');
        if (!/^[0-9a-f]+$/i.test(text)) { setLiveStatus(`Enter a hex value for ${port.name}`, true); return; }
        const value = BigInt(`0x${text}`) & ((1n << BigInt(port.width)) - 1n);
        liveRequest('live-set', { signals: { [port.name]: value.toString(2).padStart(port.width, '0') } });
      };
      const bitsRow = document.createElement('div');
      bitsRow.className = 'board-bits';
      for (let bit = Math.min(port.width, MAX_LEDS) - 1; bit >= 0; bit--) {
        const value = bits ? bits[port.width - 1 - bit] : 'x';
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `board-bit bit-${value}`;
        button.textContent = value;
        button.title = `${port.name}[${bit}]`;
        button.setAttribute('aria-label', `${port.name} bit ${bit}`);
        button.onclick = () => {
          const current = (bits || '0'.repeat(port.width)).replace(/[xz]/g, '0').split('');
          current[port.width - 1 - bit] = current[port.width - 1 - bit] === '1' ? '0' : '1';
          liveRequest('live-set', { signals: { [port.name]: current.join('') } });
        };
        bitsRow.append(button);
      }
      wrap.append(field, bitsRow);
    }
    return wrap;
  }

  function renderLiveArrays(host) {
    for (const array of live?.state?.arrays || []) {
      const card = document.createElement('section');
      card.className = 'board-widget board-mem';
      card.dataset.array = array.path;
      card.dataset.orderKey = `array:${array.path}`;
      const head = document.createElement('header');
      const name = document.createElement('span');
      name.className = 'board-widget-name';
      name.textContent = array.path.replace(`${LIVE_TOP}.`, '');
      const meta = document.createElement('small');
      meta.textContent = `${array.size}×${array.width}`;
      head.append(name, meta);
      const grid = document.createElement('div');
      grid.className = 'board-mem-grid';
      const low = Math.min(array.left, array.right);
      for (let offset = 0; offset < Math.min(array.size, 64); offset++) {
        const cell = document.createElement('span');
        cell.className = 'board-mem-cell';
        const hex = array.words[String(low + offset)] ?? '0'.repeat(Math.ceil(array.width / 4));
        cell.textContent = `${low + offset}: ${hex}`;
        grid.append(cell);
      }
      card.append(head, grid);
      host.append(card);
    }
  }

  function renderLive() {
    const running = live !== null;
    $('board-live-start').disabled = running;
    $('board-live-stop').disabled = !running;
    $('board-module').disabled = running;
    $('board-tick').disabled = !running || !live?.clock || live.busy;
    $('board-auto-clock').disabled = !running || !live?.clock;
    $('board-live-time').textContent = live?.state
      ? `${live.clock ? `cycle ${live.cycles} · ` : ''}${formatTime(BigInt(live.state.time), live.state.timescale)}`
      : '—';
    const inputs = $('board-live-inputs');
    const outputs = $('board-live-outputs');
    inputs.replaceChildren();
    outputs.replaceChildren();
    if (!running || !live.state) return;
    for (const port of live.ports) {
      if (port.dir === 'input' && port.name !== live.clock) inputs.append(inputControl(port));
    }
    for (const port of live.ports) {
      if (port.dir === 'input') continue;
      const bits = liveBits(port.name, port.width);
      outputs.append(widgetCard({ kind: port.width === 1 ? 'led' : 'seg', label: port.name, width: port.width, bits, attrs: { port: port.name, orderKey: `output:${port.name}` } }));
    }
    renderLiveArrays(outputs);
    arrange(inputs, `live:${live.module}:inputs`);
    arrange(outputs, `live:${live.module}:outputs`);
  }

  function renderModules() {
    const select = $('board-module');
    const previous = select.value;
    const names = [];
    for (const [, text] of getLiveSources()) {
      for (const match of stripComments(text).matchAll(/\bmodule\s+([A-Za-z_][\w$]*)/g)) if (!names.includes(match[1])) names.push(match[1]);
    }
    select.replaceChildren(...names.map(name => new Option(name, name)));
    if (names.includes(previous)) select.value = previous;
  }

  function stopAutoClock() {
    if (live?.timer) clearInterval(live.timer);
    if (live) live.timer = null;
    $('board-auto-clock').value = '0';
  }

  async function tick(count = 1) {
    if (!live?.clock) return null;
    const reply = await liveRequest('live-tick', { clock: live.clock, count });
    if (reply?.state && live) { live.cycles += count; renderLive(); }
    return reply;
  }

  async function startLive() {
    const moduleName = $('board-module').value;
    if (!moduleName || live) return;
    const sources = getLiveSources();
    const owner = sources.find(([, text]) => new RegExp(`\\bmodule\\s+${moduleName}\\b`).test(stripComments(text)));
    let ports;
    try {
      if (!owner) throw new Error(`${moduleName} is not in an included RTL source`);
      ports = parseModulePorts(owner[1], moduleName);
      if (!ports.length) throw new Error(`${moduleName} has no ports to drive`);
    } catch (error) {
      setLiveStatus(error.message, true);
      return;
    }
    let settings;
    try { settings = getSettings(); } catch (error) { setLiveStatus(error.message, true); return; }
    const clock = ports.find(port => port.dir === 'input' && port.width === 1 && isClockName(port.name))?.name || null;
    const reset = ports.find(port => port.dir === 'input' && port.width === 1 && resetPolarity(port.name) !== null);
    const wrapperPath = `${LIVE_TOP}.v`;
    const files = { ...getFiles(), [wrapperPath]: liveWrapper(moduleName, ports) };
    live = { client: new LiveClient(createWorker), module: moduleName, ports, clock, state: null, busy: true, timer: null, cycles: 0 };
    setLiveStatus(`Compiling ${moduleName}…`);
    renderLive();
    const started = await liveRequest('live-start', {
      ...settings, parameters: [], files, standard: getStandard(),
      sourceFiles: [...sources.map(([path]) => path), wrapperPath],
    });
    if (!started) { stopLive(true); return; }
    // Power-on reset: one clock edge with reset asserted so registers start defined.
    if (clock && reset) {
      await tick(1);
      setLiveStatus(`Live · power-on reset applied; release ${reset.name} to run`);
    }
  }

  async function stopLive(keepStatus = false) {
    if (!live) return;
    stopAutoClock();
    const session = live;
    live = null;
    try { await Promise.race([session.client.request('live-stop'), new Promise(resolve => setTimeout(resolve, 500))]); } catch { /* Worker is discarded anyway. */ }
    session.client.terminate();
    if (!keepStatus) setLiveStatus('Stopped');
    renderLive();
  }

  // ------------------------------------------------ shared
  function setMode(next) {
    mode = next;
    for (const name of ['replay', 'live']) {
      $(`board-mode-${name}`).setAttribute('aria-pressed', String(mode === name));
      $(`board-${name}`).hidden = mode !== name;
    }
    if (mode === 'live') renderModules();
    schedule();
  }

  function render() {
    frame = 0;
    if (mode === 'replay') renderReplay();
    else renderLive();
  }

  function schedule() {
    if (panel.hidden || frame) return;
    frame = requestAnimationFrame(render);
  }

  store.subscribe((_, kind) => {
    if (kind === 'trace') onTrace();
    else if (mode === 'replay' && (kind === 'cursor' || kind === 'playing' || kind === 'layout')) schedule();
  });

  const kindSelect = $('board-widget-kind');
  kindSelect.replaceChildren(...Object.entries(KIND_LABELS).map(([value, text]) => new Option(text, value)));
  $('board-add-widget').onclick = () => {
    const path = $('board-widget-signal').value;
    if (!store.signalByPath(path)) return;
    widgets.push({ id: nextWidget++, kind: kindSelect.value, path });
    renderReplay();
  };
  $('board-step-prev').onclick = () => store.stepCycle(-1);
  $('board-step-next').onclick = () => store.stepCycle(1);
  $('board-play').onclick = () => { if (S.playing) store.pause(); else store.play(); };
  $('board-mode-replay').onclick = () => setMode('replay');
  $('board-mode-live').onclick = () => setMode('live');
  $('board-live-start').onclick = startLive;
  $('board-live-stop').onclick = () => stopLive();
  $('board-tick').onclick = () => tick(1);
  $('board-auto-clock').onchange = () => {
    if (!live) return;
    if (live.timer) clearInterval(live.timer);
    live.timer = null;
    const hz = Number($('board-auto-clock').value);
    if (hz > 0) live.timer = setInterval(() => { if (live && !live.busy) tick(1); }, 1000 / hz);
  };
  setMode('replay');

  return { render: () => { if (mode === 'live') renderModules(); render(); }, stopLive, isLive: () => live !== null };
}
