// Schematic tab: RTL elaboration (Icarus synth + json.tgt) laid out by elkjs (elaborate-worker.js) and drawn as hardware symbols,
// with live VCD values from the shared SimTrace, drill-down into submodules and click-to-source.
import { formatTime, formatValue } from './waveform.js';
import { decodeMips, MIPS_REGISTERS } from './mips-decode.js';

const SVG = 'http://www.w3.org/2000/svg';
const OP_GLYPH_FALLBACK = '?';

function el(name, attrs = {}, text = null) {
  const node = document.createElementNS(SVG, name);
  for (const [key, value] of Object.entries(attrs)) if (value !== null && value !== undefined) node.setAttribute(key, value);
  if (text !== null) node.textContent = text;
  return node;
}

// "design.v:3.5-3.18" -> { file: 'design.v', line: 3 }
export function parseSrc(src) {
  const match = /^(.*?):(\d+)(?:\.\d+)?(?:-\d+(?:\.\d+)?)?$/.exec(String(src || '').split('|')[0]);
  return match ? { file: match[1], line: Number(match[2]) } : null;
}

const shortType = node => node.typeLabel || node.type || '';

// ---------------------------------------------------------------- symbols

function pinLabel(group, port, node) {
  if (node.kind === 'port' || node.kind === 'const' || node.kind === 'op' || node.kind === 'gate') return;
  if (node.kind === 'mux' && port.name !== 'S') return;
  const inside = port.side === 'WEST' ? 5 : port.side === 'EAST' ? -5 : 0;
  const anchor = port.side === 'WEST' ? 'start' : port.side === 'EAST' ? 'end' : 'middle';
  const y = port.side === 'SOUTH' ? port.y - 5 : port.y + 3.5;
  group.append(el('text', { class: 'schem-pin', x: port.x + inside, y, 'text-anchor': anchor }, port.name));
  if (port.clock) {
    const x = port.x, cy = port.y;
    group.append(el('path', { class: 'schem-clock', d: `M ${x} ${cy - 5} L ${x + 7} ${cy} L ${x} ${cy + 5}` }));
  }
}

function drawPort(group, node) {
  const { w, h } = node;
  const tip = 9;
  const d = node.direction === 'input'
    ? `M 0 0 H ${w - tip} L ${w} ${h / 2} L ${w - tip} ${h} H 0 Z`
    : node.direction === 'output'
      ? `M ${tip} 0 H ${w} V ${h} H ${tip} L 0 ${h / 2} Z`
      : `M ${tip} 0 H ${w - tip} L ${w} ${h / 2} L ${w - tip} ${h} H ${tip} L 0 ${h / 2} Z`;
  group.append(el('path', { class: 'schem-shape', d }));
  group.append(el('text', { class: 'schem-label', x: node.direction === 'input' ? 8 : node.direction === 'output' ? w - 8 : w / 2, y: h / 2 + 4, 'text-anchor': node.direction === 'input' ? 'start' : node.direction === 'output' ? 'end' : 'middle' }, node.label));
}

function drawCell(group, node) {
  const { w, h } = node;
  if (node.kind === 'mux') {
    group.append(el('path', { class: 'schem-shape', d: `M 0 0 L ${w} ${Math.min(12, h / 4)} L ${w} ${h - Math.min(12, h / 4)} L 0 ${h} Z` }));
    group.append(el('text', { class: 'schem-glyph small', x: w / 2, y: h / 2 + 4, 'text-anchor': 'middle' }, node.type === '$pmux' ? 'PMUX' : 'MUX'));
  } else if (node.kind === 'op') {
    group.append(el('rect', { class: 'schem-shape', x: 0, y: 0, width: w, height: h, rx: Math.min(w, h) / 2 }));
    group.append(el('text', { class: 'schem-glyph', x: w / 2, y: h / 2 + 5, 'text-anchor': 'middle' }, node.glyph || OP_GLYPH_FALLBACK));
  } else if (node.kind === 'gate') {
    group.append(el('path', { class: 'schem-shape', d: `M 0 0 H ${w * 0.55} A ${w * 0.45} ${h / 2} 0 0 1 ${w * 0.55} ${h} H 0 Z` }));
    group.append(el('text', { class: 'schem-glyph', x: w * 0.45, y: h / 2 + 5, 'text-anchor': 'middle' }, node.glyph || OP_GLYPH_FALLBACK));
    if (node.negated) group.append(el('circle', { class: 'schem-bubble', cx: w + 3, cy: h / 2, r: 3 }));
  } else if (node.kind === 'const') {
    group.append(el('rect', { class: 'schem-shape', x: 0, y: 0, width: w, height: h, rx: h / 2 }));
    group.append(el('text', { class: 'schem-label', x: w / 2, y: h / 2 + 4, 'text-anchor': 'middle' }, node.label));
  } else if (node.kind === 'module') {
    group.append(el('rect', { class: 'schem-shape', x: 0, y: 0, width: w, height: h, rx: 8 }));
    group.append(el('path', { class: 'schem-header', d: `M 0 8 A 8 8 0 0 1 8 0 H ${w - 8} A 8 8 0 0 1 ${w} 8 V 20 H 0 Z` }));
    group.append(el('text', { class: 'schem-title', x: 8, y: 14 }, `${node.instance || '?'} : ${shortType(node)}`));
    group.append(el('text', { class: 'schem-drill', x: w - 8, y: 14, 'text-anchor': 'end' }, '⤵'));
  } else {
    const latch = node.kind === 'latch';
    group.append(el('rect', { class: 'schem-shape', x: 0, y: 0, width: w, height: h, rx: 4 }));
    const memSize = node.kind === 'mem' && node.params?.SIZE ? ` ${node.params.SIZE}×${node.params.WIDTH}` : '';
    const title = latch ? 'LATCH'
      : node.kind === 'dff' ? shortType(node).replace(/^\$/, '').toUpperCase()
        : node.kind === 'mem' ? `${node.instance || 'mem'}${memSize}`
          : shortType(node).replace(/^\$/, '');
    group.append(el('text', { class: 'schem-title center', x: w / 2, y: 13, 'text-anchor': 'middle' }, title));
    if (latch) {
      group.append(el('rect', { class: 'schem-badge', x: w - 24, y: -8, width: 26, height: 12, rx: 6 }));
      group.append(el('text', { class: 'schem-badge-text', x: w - 11, y: 1, 'text-anchor': 'middle' }, '!'));
    }
  }
  for (const port of node.ports) pinLabel(group, port, node);
}

function wirePath(points) {
  return points.map(([x, y], index) => `${index ? 'L' : 'M'} ${x} ${y}`).join(' ');
}

// ---------------------------------------------------------------- install

// onNavigate: the drill-down path changed (history entry); overlay: { opened, closed } for the inspector card;
// getStateName(path, bits): FSM state name or null; onShowArray(path): open the State tab on a captured array.
export function installSchematic({ store, getFiles, getRtlSources, getSettings, getStandard, getTopHint, createWorker, onJump, notify, onNavigate = null, overlay = null, getStateName = null, onShowArray = null, onProgress = null, onElaborated = null }) {
  const $ = id => document.getElementById(id);
  const S = store.getState();
  const panel = $('schematic');
  const canvas = $('schem-canvas');
  let worker = null;
  let nextRequest = 0;
  const pending = new Map();
  let design = null;        // { topModule, modules, flatten }
  let graph = null;         // laid-out graph currently shown
  let lastResources = null, lastCriticalPath = null;
  let criticalEnabled = false, resourcesEnabled = false;
  let crumbs = [];          // [{ label, module }]
  let diagnostics = [];
  let view = null;          // { x, y, w, h } viewBox
  let frame = 0;
  let flatten = false;
  let busy = false;
  const scopeCache = new Map();

  // ------------------------------------------------ graph index (pins -> nodes, fan-in / fan-out)
  const wireEls = new Map();   // edge id -> visible wire path
  const nodeEls = new Map();   // node id -> <g>
  let index = null;            // { nodeOfPin, nodes, inEdges, outEdges }
  let selection = null;        // { kind: 'node' | 'net', id, cone }
  let inspected = null;        // { node } | { net: edge }
  const coarse = matchMedia('(pointer: coarse), (max-width: 899px)');
  let lastPointerType = 'mouse';
  const inspectOnly = () => lastPointerType === 'touch' || coarse.matches;

  function buildIndex() {
    if (!graph) { index = null; return; }
    const nodeOfPin = new Map();
    const nodes = new Map();
    for (const node of graph.nodes) {
      nodes.set(node.id, node);
      for (const port of node.ports) nodeOfPin.set(port.id, node.id);
    }
    const inEdges = new Map(), outEdges = new Map();
    const add = (map, key, edge) => { if (!map.has(key)) map.set(key, []); map.get(key).push(edge); };
    for (const edge of graph.edges) {
      const from = nodeOfPin.get(edge.from), to = nodeOfPin.get(edge.to);
      if (from) add(outEdges, from, edge);
      if (to) add(inEdges, to, edge);
    }
    index = { nodeOfPin, nodes, inEdges, outEdges };
  }

  const nodeLabel = node => {
    if (node.kind === 'port') return `${node.direction} ${node.label}`;
    if (node.kind === 'const') return node.label;
    if (node.kind === 'mem') return `${node.instance || 'mem'} ${node.params?.SIZE ?? '?'}x${node.params?.WIDTH ?? '?'}`;
    return node.instance ? `${node.instance} : ${shortType(node)}` : shortType(node);
  };
  const netName = edge => edge.slice ? `${edge.slice.name}${edge.slice.width > 1 ? `[${edge.slice.hi}:${edge.slice.lo}]` : ''}` : edge.constant || 'net';
  const sameNet = (a, b) => a.slice && b.slice && !a.slice.hidden ? a.slice.name === b.slice.name : a.from === b.from;

  // Transitive cone: upstream (dir 'in') or downstream ('out') node ids, edges collected along the way.
  function walk(startIds, dir, nodeSet, edgeSet) {
    const queue = [...startIds];
    const seen = new Set(startIds);
    while (queue.length) {
      const id = queue.shift();
      for (const edge of (dir === 'in' ? index.inEdges : index.outEdges).get(id) || []) {
        edgeSet.add(edge.id);
        const next = index.nodeOfPin.get(dir === 'in' ? edge.from : edge.to);
        if (!next || seen.has(next)) continue;
        seen.add(next);
        nodeSet.add(next);
        queue.push(next);
      }
    }
  }

  function applySelection() {
    for (const element of [...nodeEls.values(), ...wireEls.values()]) element.classList.remove('is-selected', 'is-fanin', 'is-fanout');
    canvas.classList.toggle('has-focus', Boolean(selection && index));
    if (!selection || !index) return;
    const mark = (map, ids, cls) => { for (const id of ids) map.get(id)?.classList.add(cls); };
    const faninNodes = new Set(), fanoutNodes = new Set(), faninEdges = new Set(), fanoutEdges = new Set();
    if (selection.kind === 'node') {
      if (selection.cone) {
        walk([selection.id], 'in', faninNodes, faninEdges);
        walk([selection.id], 'out', fanoutNodes, fanoutEdges);
      } else {
        for (const edge of index.inEdges.get(selection.id) || []) { faninEdges.add(edge.id); const n = index.nodeOfPin.get(edge.from); if (n) faninNodes.add(n); }
        for (const edge of index.outEdges.get(selection.id) || []) { fanoutEdges.add(edge.id); const n = index.nodeOfPin.get(edge.to); if (n) fanoutNodes.add(n); }
      }
      faninNodes.delete(selection.id);
      fanoutNodes.delete(selection.id);
      mark(wireEls, faninEdges, 'is-fanin');
      mark(wireEls, fanoutEdges, 'is-fanout');
      mark(nodeEls, faninNodes, 'is-fanin');
      mark(nodeEls, fanoutNodes, 'is-fanout');
      mark(nodeEls, [selection.id], 'is-selected');
    } else {
      const edge = graph.edges.find(item => item.id === selection.id);
      if (!edge) return;
      const members = graph.edges.filter(item => sameNet(item, edge));
      mark(wireEls, members.map(item => item.id), 'is-selected');
      mark(nodeEls, members.map(item => index.nodeOfPin.get(item.from)).filter(Boolean), 'is-fanin');
      mark(nodeEls, members.map(item => index.nodeOfPin.get(item.to)).filter(Boolean), 'is-fanout');
    }
  }

  function selectNode(id, cone = false) { selection = { kind: 'node', id, cone }; applySelection(); }
  function selectNet(edge) {
    selection = { kind: 'net', id: edge.id };
    applySelection();
    openInspector({ net: edge });
  }
  function clearSelection() {
    selection = null;
    applySelection();
    closeInspector();
  }

  // ------------------------------------------------ live pin values
  function pinBits(scope, node, pin) {
    if (!scope) return null;
    if (node.kind === 'port') {
      const signal = store.signalByPath(`${scope}.${node.name}`);
      const raw = signal && store.valueOf(signal);
      return raw === null || raw === undefined ? null : raw.padStart(signal.width, /^[xz]/.test(raw) ? raw[0] : '0');
    }
    const edges = graph.edges.filter(edge => edge.to === pin.id || edge.from === pin.id);
    for (const edge of edges) {
      if (edge.width !== pin.width) continue;
      if (edge.constant && edge.to === pin.id) return [...edge.bits].reverse().join('');
      if (edge.slice && !edge.slice.hidden && !edge.slice.partial) { const bits = netBits(scope, edge.slice); if (bits) return bits; }
    }
    return null;
  }
  const hex = bits => bits === null ? '—' : /^x+$/i.test(bits) ? 'x' : /^z+$/i.test(bits) ? 'z' : formatValue(bits, bits.length, 'hex');
  const pinDirection = (node, pin) => node.kind === 'port' ? node.direction : pin.side === 'EAST' ? 'out' : 'in';

  // One-line explanation of what the cell does right now (live values when a VCD matches).
  function explain(node, values) {
    const v = name => values.get(name) ?? null;
    const glyph = node.glyph;
    if (node.kind === 'mux') {
      const s = v('S');
      if (node.type === '$pmux') {
        if (s === null) return { text: 'Parallel (one-hot) mux: B[i] is chosen when S[i] = 1, else A.' };
        const hot = s.split('').reverse().indexOf('1');
        return { text: hot < 0 ? 'No select bit is high: output = A (default).' : `S[${hot}] = 1: output = case ${hot} of B.`, active: hot < 0 ? 'A' : 'B' };
      }
      if (s === null) return { text: 'Y = S ? B : A' };
      return { text: `S = ${s}: output follows ${s === '1' ? 'B' : 'A'}.`, active: s === '1' ? 'B' : s === '0' ? 'A' : null };
    }
    if (node.kind === 'op' || node.kind === 'gate') {
      const a = v('A'), b = v('B'), y = v('Y');
      const op = glyph || shortType(node).replace(/^\$/, '');
      if (a !== null && b !== null && y !== null) return { text: `${hex(a)} ${op} ${hex(b)} = ${hex(y)}`, equation: true };
      if (a !== null && y !== null) return { text: `${op} ${hex(a)} = ${hex(y)}`, equation: true };
      return { text: b === undefined ? `Y = ${op} A` : `Y = A ${op} B` };
    }
    if (node.kind === 'dff') return { text: `Captures D on ${node.params?.CLK_POLARITY === '0' || node.params?.CLK_POLARITY === 0 ? 'negedge' : 'posedge'} CLK${values.has('EN') ? ' when EN = 1' : ''}${values.has('ARST') ? '; ARST resets it immediately' : ''}.` };
    if (node.kind === 'latch') return { text: 'Warning: level-sensitive latch — transparent while EN=1, holds Q otherwise. Usually a missing else / default.', warn: true };
    if (node.kind === 'mem') return { text: 'Memory array: reads are combinational (RD_ADDR -> RD_DATA); writes happen on CLK when WR_EN is set.' };
    if (node.kind === 'module') return { text: 'Submodule instance — open it to see the logic inside.' };
    if (node.kind === 'port') return { text: node.direction === 'input' ? 'Module input port.' : node.direction === 'output' ? 'Module output port.' : 'Bidirectional port.' };
    if (node.kind === 'const') return { text: `Constant ${node.label}.` };
    return { text: 'Behavioral block kept as-is by the synthesizer.' };
  }

  // ------------------------------------------------ inspector card
  const inspector = $('schem-inspector');
  const closeInspectorFromHistory = () => closeInspector({ fromHistory: true });
  function closeInspector({ fromHistory = false } = {}) {
    if (!inspected) return;
    inspected = null;
    inspector.hidden = true;
    inspector.replaceChildren();
    if (!fromHistory) overlay?.closed(closeInspectorFromHistory);
  }

  function openInspector(target) {
    const wasOpen = Boolean(inspected);
    inspected = target;
    renderInspector();
    inspector.hidden = false;
    if (!wasOpen) overlay?.opened(closeInspectorFromHistory);
  }

  function button(label, onclick, extra = {}) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'chip';
    item.textContent = label;
    Object.assign(item.dataset, extra.data || {});
    if (extra.pressed !== undefined) item.setAttribute('aria-pressed', String(extra.pressed));
    item.onclick = onclick;
    return item;
  }

  function renderInspector() {
    if (!inspected || !graph) return;
    const scope = S.trace ? scopeFor() : null;
    const head = document.createElement('header');
    const titles = document.createElement('div');
    const title = document.createElement('b');
    title.className = 'si-title';
    const sub = document.createElement('small');
    sub.className = 'si-sub';
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'icon-btn si-close';
    close.setAttribute('aria-label', 'Close inspector');
    close.textContent = '×';
    close.onclick = () => clearSelection();
    titles.append(title, sub);
    head.append(titles, close);
    const body = [];
    const actions = document.createElement('div');
    actions.className = 'si-actions';

    if (inspected.node) {
      const node = index.nodes.get(inspected.node.id) || inspected.node;
      const width = Math.max(...node.ports.filter(port => port.side === 'EAST').map(port => port.width), ...node.ports.map(port => port.width), 1);
      title.textContent = nodeLabel(node);
      sub.textContent = [`${width} bit${width === 1 ? '' : 's'}`, node.src ? parseSrc(node.src) && `${parseSrc(node.src).file}:${parseSrc(node.src).line}` : null, node.kind].filter(Boolean).join(' · ');
      inspector.dataset.kind = node.kind;
      const values = new Map(node.ports.map(port => [port.name, pinBits(scope, node, port)]));
      const info = explain(node, values);
      const note = document.createElement('p');
      note.className = `si-explain${info.warn ? ' is-warn' : ''}${info.equation ? ' is-equation' : ''}`;
      note.textContent = info.text;
      body.push(note);
      const table = document.createElement('table');
      table.className = 'si-pins';
      for (const port of node.ports) {
        const row = table.insertRow();
        row.dataset.pin = port.name;
        const name = row.insertCell();
        name.textContent = node.kind === 'port' ? node.name : port.name;
        if (info.active && port.name === info.active) {
          const pill = document.createElement('span');
          pill.className = 'si-active';
          pill.textContent = 'Active';
          name.append(' ', pill);
          row.classList.add('is-active');
        }
        row.insertCell().textContent = pinDirection(node, port);
        row.insertCell().textContent = String(port.width);
        const value = row.insertCell();
        value.className = 'si-value';
        value.textContent = scope ? hex(values.get(port.name)) : '—';
      }
      body.push(table);
      const where = parseSrc(node.src);
      // The card closes first so the jump reuses its history entry: Back then returns straight to the diagram.
      if (where) actions.append(button('Jump to Code', () => { closeInspector(); onJump(where.file, where.line); }, { data: { action: 'jump' } }));
      if (node.kind === 'module') actions.append(button('Open Submodule ⤵', () => drillInto(node), { data: { action: 'drill' } }));
      actions.append(button('Trace Cone', () => { selectNode(node.id, !(selection?.cone)); renderInspector(); }, { data: { action: 'cone' }, pressed: Boolean(selection?.kind === 'node' && selection.cone) }));
    } else {
      const edge = inspected.net;
      const members = graph.edges.filter(item => sameNet(item, edge));
      title.textContent = netName(edge);
      sub.textContent = `net · ${edge.width} bit${edge.width === 1 ? '' : 's'} · ${members.length} segment${members.length === 1 ? '' : 's'}`;
      inspector.dataset.kind = 'net';
      const bits = scope && edge.slice && !edge.slice.hidden && !edge.slice.partial ? netBits(scope, edge.slice) : edge.constant ? [...edge.bits].reverse().join('') : null;
      const note = document.createElement('p');
      note.className = 'si-explain is-equation';
      note.textContent = bits !== null ? `Value now: ${hex(bits)}` : scope ? 'No live value for this net.' : 'Run a simulation to see live values.';
      body.push(note);
      const table = document.createElement('table');
      table.className = 'si-pins';
      const drivers = [...new Set(members.map(item => index.nodeOfPin.get(item.from)).filter(Boolean))];
      const loads = [...new Set(members.map(item => index.nodeOfPin.get(item.to)).filter(Boolean))];
      for (const [role, ids] of [['driver', drivers], ['load', loads]]) {
        for (const id of ids) {
          const row = table.insertRow();
          const name = row.insertCell();
          const link = document.createElement('button');
          link.type = 'button';
          link.className = 'si-link';
          link.textContent = nodeLabel(index.nodes.get(id));
          link.onclick = () => { selectNode(id); openInspector({ node: index.nodes.get(id) }); };
          name.append(link);
          row.insertCell().textContent = role;
        }
      }
      body.push(table);
    }
    inspector.replaceChildren(head, ...body, actions);
  }

  // ------------------------------------------------ find in schematic
  let searchMatches = [];
  let searchIndex = -1;
  function resetSearch() { searchMatches = []; searchIndex = -1; $('schem-search-count').textContent = ''; }
  function computeMatches(query) {
    const q = query.trim().toLowerCase();
    if (!q || !graph) return [];
    const matches = [];
    for (const node of graph.nodes) {
      if (node.kind === 'const') continue;
      const hay = [node.instance, node.name, node.label, shortType(node), nodeLabel(node)].filter(Boolean).join(' ').toLowerCase();
      if (hay.includes(q)) matches.push({ kind: 'node', id: node.id });
    }
    const nets = new Set();
    for (const edge of graph.edges) {
      if (!edge.slice || edge.slice.hidden || nets.has(edge.slice.name)) continue;
      if (edge.slice.name.toLowerCase().includes(q)) { nets.add(edge.slice.name); matches.push({ kind: 'net', id: edge.id }); }
    }
    return matches;
  }
  function boxOf(match) {
    if (match.kind === 'node') { const node = index.nodes.get(match.id); return { x: node.x, y: node.y, w: node.w, h: node.h }; }
    const edge = graph.edges.find(item => item.id === match.id);
    const points = graph.edges.filter(item => sameNet(item, edge)).flatMap(item => item.points);
    const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  function focusMatch(match) {
    const box = boxOf(match);
    const rect = canvas.getBoundingClientRect();
    const aspect = rect.width && rect.height ? rect.width / rect.height : 1.6;
    let w = Math.max(box.w * 2.2, 260), h = Math.max(box.h * 2.2, 160);
    if (w / h > aspect) h = w / aspect; else w = h * aspect;
    animateView({ x: box.x + box.w / 2 - w / 2, y: box.y + box.h / 2 - h / 2, w, h });
    if (match.kind === 'node') { selectNode(match.id); openInspector({ node: index.nodes.get(match.id) }); }
    else selectNet(graph.edges.find(item => item.id === match.id));
  }
  let animation = 0;
  function animateView(target) {
    cancelAnimationFrame(animation);
    const start = view ? { ...view } : target;
    const began = performance.now();
    const step = now => {
      const t = Math.min(1, (now - began) / 180);
      const e = 1 - (1 - t) ** 3;
      setView({ x: start.x + (target.x - start.x) * e, y: start.y + (target.y - start.y) * e, w: start.w + (target.w - start.w) * e, h: start.h + (target.h - start.h) * e });
      if (t < 1) animation = requestAnimationFrame(step);
    };
    animation = requestAnimationFrame(step);
  }
  $('schem-search').addEventListener('input', () => {
    searchMatches = computeMatches($('schem-search').value);
    searchIndex = -1;
    $('schem-search-count').textContent = $('schem-search').value.trim() ? `0/${searchMatches.length}` : '';
  });
  $('schem-search').addEventListener('keydown', event => {
    if (event.key === 'Escape') { $('schem-search').value = ''; resetSearch(); return; }
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!searchMatches.length) searchMatches = computeMatches($('schem-search').value);
    if (!searchMatches.length) { $('schem-search-count').textContent = $('schem-search').value.trim() ? '0/0' : ''; return; }
    searchIndex = (searchIndex + (event.shiftKey ? searchMatches.length - 1 : 1)) % searchMatches.length;
    $('schem-search-count').textContent = `${searchIndex + 1}/${searchMatches.length}`;
    focusMatch(searchMatches[searchIndex]);
  });

  // ------------------------------------------------ minimap
  const minimap = $('schem-minimap');
  // Auto (shown above 640 px wide) until the Map chip sets an explicit preference.
  const narrowStage = matchMedia('(max-width: 640px)');
  let minimapPref = null;
  const minimapOn = () => minimapPref ?? !narrowStage.matches;
  narrowStage.addEventListener('change', () => renderMinimap());
  let minimapBox = null;
  function renderMinimap() {
    $('schem-map').setAttribute('aria-pressed', String(minimapOn()));
    minimap.toggleAttribute('hidden', !minimapOn() || !graph);   // SVG elements have no .hidden property
    minimap.replaceChildren();
    if (!graph || !minimapOn()) return;
    const margin = 20;
    minimapBox = { x: -margin, y: -margin, w: Math.max(graph.width, 60) + margin * 2, h: Math.max(graph.height, 40) + margin * 2 };
    minimap.setAttribute('viewBox', `${minimapBox.x} ${minimapBox.y} ${minimapBox.w} ${minimapBox.h}`);
    minimap.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    for (const node of graph.nodes) minimap.append(el('rect', { class: `mm-node kind-${node.kind}`, x: node.x, y: node.y, width: node.w, height: node.h, rx: 3 }));
    minimap.append(el('rect', { class: 'mm-view', id: 'schem-minimap-view' }));
    updateMinimapView();
  }
  function updateMinimapView() {
    const rect = minimap.querySelector('.mm-view');
    if (!rect || !view) return;
    rect.setAttribute('x', view.x); rect.setAttribute('y', view.y); rect.setAttribute('width', view.w); rect.setAttribute('height', view.h);
  }
  function minimapPan(event) {
    if (!view || !minimapBox) return;
    const point = minimap.createSVGPoint();
    point.x = event.clientX; point.y = event.clientY;
    const local = point.matrixTransform(minimap.getScreenCTM().inverse());
    setView({ ...view, x: local.x - view.w / 2, y: local.y - view.h / 2 });
  }
  let minimapDrag = false;
  minimap.addEventListener('pointerdown', event => { event.stopPropagation(); minimapDrag = true; try { minimap.setPointerCapture(event.pointerId); } catch { /* synthetic */ } minimapPan(event); });
  minimap.addEventListener('pointermove', event => { if (minimapDrag) minimapPan(event); });
  minimap.addEventListener('pointerup', () => { minimapDrag = false; });
  minimap.addEventListener('pointercancel', () => { minimapDrag = false; });
  $('schem-map').onclick = () => { minimapPref = !minimapOn(); renderMinimap(); };

  // ------------------------------------------------ live cycle learning bar
  const learnBar = $('schem-learn-bar');
  const leafOf = path => path.split('.').at(-1);
  function arrayLabel(path) {
    const parts = path.split('.');
    const leaf = parts.at(-1);
    return /^(?:mem|memory|ram|array|data)$/i.test(leaf) && parts.length > 1 ? parts.at(-2).replace(/^u_/, '') : leaf;
  }
  function currentInstruction() {
    const signals = S.trace?.signals || [];
    const pc = signals.find(signal => /^pc$/i.test(leafOf(signal.path)) && signal.width >= 8)
      || signals.find(signal => /(?:^|_)pc(?:_|$)/i.test(leafOf(signal.path)) && signal.width >= 8);
    if (!pc) return null;
    const pcRaw = store.valueOf(pc);
    if (!pcRaw || /[xz]/.test(pcRaw)) return null;
    const pcValue = Number(BigInt(`0b${pcRaw}`));
    const scope = pc.path.slice(0, pc.path.lastIndexOf('.'));
    const instrSignals = signals.filter(signal => signal.width === 32 && /^(?:instr|instruction|inst|ir)$/i.test(leafOf(signal.path)));
    const instr = instrSignals.find(signal => signal.path.startsWith(`${scope}.`)) || instrSignals[0];
    let word = null;
    if (instr) {
      const raw = store.valueOf(instr);
      if (raw && !/[xz]/.test(raw)) word = Number(BigInt(`0b${raw}`));
    }
    if (word === null) {
      const imem = store.memArrays().find(array => array.width === 32 && /imem|instr|rom|prog/i.test(array.path));
      const snapshot = imem && store.getMemorySnapshot(imem.path);
      const hexWord = snapshot?.words.get(snapshot.array.low + Math.floor(pcValue / 4));
      if (hexWord && !/[xz]/i.test(hexWord)) word = parseInt(hexWord, 16) >>> 0;
    }
    if (word === null) return null;
    const decoded = decodeMips(word);
    return { pc: pcValue, asm: decoded?.asm || `0x${word.toString(16).padStart(8, '0')}` };
  }
  function cycleChanges() {
    const now = store.currentTime();
    const previous = store.previousCycleTime(now) ?? 0n;
    const changes = [];
    for (const write of store.memWritesBetween(previous, now)) {
      const isRegfile = write.size === 32 && write.width === 32 && /reg|rf/i.test(write.path);
      const name = isRegfile ? MIPS_REGISTERS[write.index - write.low] : `${arrayLabel(write.path)}[${write.index - write.low}]`;
      const value = /[xz]/i.test(write.value) ? write.value : `0x${(write.value || '0').padStart(Math.ceil(write.width / 4), '0')}`;
      changes.push({ kind: 'mem', path: write.path, text: `${name} ← ${value}` });
    }
    if (getStateName && S.trace) {
      for (const signal of S.trace.signals) {
        if (/^next/i.test(leafOf(signal.path))) continue;
        const after = store.valueOf(signal, now);
        const before = store.valueOf(signal, previous);
        if (after === null || before === null || after === before) continue;
        const pad = raw => raw.padStart(signal.width, '0');
        const to = getStateName(signal.path, pad(after));
        if (!to) continue;
        const from = getStateName(signal.path, pad(before)) || formatValue(pad(before), signal.width, 'hex');
        changes.unshift({ kind: 'state', path: signal.path, text: `${leafOf(signal.path)}: ${from} → ${to}` });
      }
    }
    return { changes, previous, now };
  }
  function renderLearnBar() {
    const hasTrace = Boolean(S.trace || S.memTrace);
    learnBar.hidden = !hasTrace;
    if (!hasTrace) { learnBar.replaceChildren(); return; }
    const items = [];
    const instruction = currentInstruction();
    if (instruction) {
      const pill = document.createElement('span');
      pill.className = 'learn-pill learn-instr';
      pill.id = 'schem-learn-instr';
      pill.textContent = `PC 0x${instruction.pc.toString(16).padStart(8, '0')} · ${instruction.asm}`;
      pill.title = 'Instruction at the current PC';
      items.push(pill);
    }
    const label = document.createElement('span');
    label.className = 'learn-label';
    label.textContent = 'This cycle:';
    items.push(label);
    const { changes } = cycleChanges();
    if (!changes.length) {
      const idle = document.createElement('span');
      idle.className = 'learn-pill learn-idle';
      idle.textContent = 'No state writes this cycle';
      items.push(idle);
    }
    for (const change of changes.slice(0, 4)) {
      const pill = document.createElement(change.kind === 'mem' && onShowArray ? 'button' : 'span');
      pill.className = `learn-pill learn-change kind-${change.kind}`;
      pill.textContent = change.text;
      pill.dataset.path = change.path;
      if (pill.tagName === 'BUTTON') { pill.type = 'button'; pill.title = 'Show in the State tab'; pill.onclick = () => onShowArray(change.path); }
      items.push(pill);
    }
    if (changes.length > 4) {
      const more = document.createElement('span');
      more.className = 'learn-more';
      more.textContent = `+${changes.length - 4} more`;
      items.push(more);
    }
    learnBar.replaceChildren(...items);
  }


  // ------------------------------------------------ worker
  function request(type, payload) {
    if (!worker) {
      worker = createWorker();
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          setStatus(data.phase);
          onProgress?.(data.phase);
          return;
        }
        const entry = pending.get(data.requestId);
        if (!entry) return;
        pending.delete(data.requestId);
        if (data.type === 'error') entry.reject(new Error(data.message));
        else entry.resolve(data);
      };
      worker.onerror = event => {
        for (const entry of pending.values()) entry.reject(new Error(event.message || 'Elaboration worker failed'));
        pending.clear();
        worker = null;
      };
    }
    return new Promise((resolve, reject) => {
      const requestId = ++nextRequest;
      pending.set(requestId, { resolve, reject });
      worker.postMessage({ ...payload, type, requestId });
    });
  }

  // ------------------------------------------------ modules / defaults
  function rtlModules() {
    const names = [];
    for (const [, text] of getRtlSources()) {
      const clean = text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');
      for (const match of clean.matchAll(/\bmodule\s+([A-Za-z_][\w$]*)/g)) if (!names.includes(match[1])) names.push(match[1]);
    }
    return names;
  }

  function renderModules() {
    const select = $('schem-module');
    const previous = select.value;
    const names = rtlModules();
    select.replaceChildren(...names.map(name => new Option(name, name)));
    const hint = getTopHint?.(names);
    select.value = names.includes(previous) ? previous : hint && names.includes(hint) ? hint : names[0] || '';
  }

  function setStatus(text, error = false) {
    $('schem-status').textContent = text;
    $('schem-status').classList.toggle('is-error', error);
  }

  // ------------------------------------------------ warnings strip
  function renderWarnings() {
    const host = $('schem-warnings');
    host.replaceChildren();
    host.hidden = diagnostics.length === 0;
    for (const item of diagnostics.slice(0, 50)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `schem-warning is-${item.severity} kind-${item.kind}`;
      const tag = document.createElement('b');
      tag.textContent = item.kind === 'latch' ? 'LATCH' : item.severity === 'error' ? 'ERROR' : 'WARN';
      const loc = document.createElement('span');
      loc.className = 'schem-warning-loc';
      loc.textContent = item.file ? `${item.file}:${item.line}` : '';
      const message = document.createElement('span');
      message.textContent = item.message;
      button.append(tag, loc, message);
      button.title = item.message;
      button.disabled = !item.file;
      button.onclick = () => item.file && onJump(item.file, item.line);
      host.append(button);
    }
  }

  // ------------------------------------------------ crumbs
  function renderCrumbs() {
    const host = $('schem-crumbs');
    host.replaceChildren();
    crumbs.forEach((crumb, index) => {
      if (index) host.append(Object.assign(document.createElement('span'), { className: 'schem-crumb-sep', textContent: '›' }));
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'schem-crumb';
      button.textContent = crumb.label;
      button.title = crumb.module;
      button.disabled = index === crumbs.length - 1;
      if (index === crumbs.length - 1) button.setAttribute('aria-current', 'location');
      button.onclick = () => openLevel(index);
      host.append(button);
    });
  }

  async function openLevel(index, { silent = false } = {}) {
    const target = crumbs[index];
    if (!target || busy) return false;
    busy = true;
    try {
      const reply = await request('layout', { moduleName: target.module });
      crumbs = crumbs.slice(0, index + 1);
      lastCriticalPath = reply.criticalPath || null;
      showGraph(reply.graph);
      if (!silent) onNavigate?.();
      return true;
    } catch (error) {
      setStatus(error.message, true);
      return false;
    } finally {
      busy = false;
    }
  }

  async function drillInto(node, { silent = false } = {}) {
    if (busy || node.kind !== 'module') return false;
    busy = true;
    try {
      const reply = await request('layout', { moduleName: node.type });
      crumbs.push({ label: node.instance || node.name, module: node.type });
      lastCriticalPath = reply.criticalPath || null;
      showGraph(reply.graph);
      setStatus(`${node.instance} : ${shortType(node)} · ${reply.elapsedMs} ms layout`);
      if (!silent) onNavigate?.();
      return true;
    } catch (error) {
      setStatus(error.message, true);
      return false;
    } finally {
      busy = false;
    }
  }

  // History restore: move to the drill-down path `labels` (same top module) without recording.
  async function navigateTo(labels) {
    if (!Array.isArray(labels) || !labels.length || !crumbs.length || labels[0] !== crumbs[0].label) return false;
    let common = 0;
    while (common < Math.min(labels.length, crumbs.length) && labels[common] === crumbs[common].label) common++;
    if (common === labels.length && common === crumbs.length) return true;
    if (common < crumbs.length && !(await openLevel(common - 1, { silent: true }))) return false;
    for (const label of labels.slice(common)) {
      const node = graph?.nodes.find(item => item.kind === 'module' && (item.instance || item.name) === label);
      if (!node || !(await drillInto(node, { silent: true }))) return false;
    }
    return true;
  }

  // ------------------------------------------------ drawing
  function showGraph(next) {
    graph = next;
    closeInspector();
    selection = null;
    buildIndex();
    renderCrumbs();
    draw();
    fit();
    renderMinimap();
    renderCriticalPath();
    renderResources();
    resetSearch();
  }

  function draw() {
    canvas.replaceChildren();
    $('schem-empty').hidden = Boolean(graph);
    $('schem-export').disabled = !graph;
    if (!graph) return;
    const wires = el('g', { class: 'schem-wires' });
    const hits = el('g', { class: 'schem-hits', 'data-hits': '1' });
    wireEls.clear();
    nodeEls.clear();
    const labels = el('g', { class: 'schem-wire-labels' });
    const cells = el('g', { class: 'schem-cells' });
    for (const edge of graph.edges) {
      if (edge.points.length < 2) continue;
      const bus = edge.width > 1;
      const path = el('path', { class: `schem-wire${bus ? ' schem-bus' : ''}${edge.constant ? ' is-const' : ''}`, d: wirePath(edge.points), 'data-edge': edge.id });
      if (edge.slice && !edge.slice.hidden) path.dataset.net = edge.slice.name;
      path.append(el('title', {}, `${edge.slice ? `${edge.slice.name}${edge.slice.width > 1 ? `[${edge.slice.hi}:${edge.slice.lo}]` : ''}` : edge.constant || 'net'} (${edge.width} bit${edge.width === 1 ? '' : 's'})`));
      wires.append(path);
      wireEls.set(edge.id, path);
      const hit = el('path', { class: 'schem-hit', d: wirePath(edge.points), 'data-edge': edge.id });
      hit.addEventListener('click', event => {
        if (dragMoved) return;
        event.stopPropagation();
        selectNet(edge);
      });
      hits.append(hit);
      if (bus) {
        // Width pill near the driver end, value badge (filled by the overlay) near the sink end.
        const [x, y] = edge.points[0];
        const text = String(edge.width);
        const pill = el('g', { class: 'schem-width', transform: `translate(${x + 10} ${y - 9})` });
        pill.append(el('rect', { x: -1, y: -6, width: text.length * 6 + 6, height: 11, rx: 5.5 }), el('text', { x: 2, y: 2.5 }, text));
        labels.append(pill);
        const [ex, ey] = edge.points.at(-1);
        const [px] = edge.points.at(-2);
        const badge = el('g', { class: 'schem-value', transform: `translate(${Math.max(px, ex - 60)} ${ey - 9})`, 'data-edge': edge.id, visibility: 'hidden' });
        badge.append(el('rect', { x: -2, y: -6, width: 10, height: 11, rx: 3 }), el('text', { x: 2, y: 2.5 }, ''));
        labels.append(badge);
      }
    }
    for (const node of graph.nodes) {
      const group = el('g', {
        class: node.kind === 'port' ? `schem-port is-${node.direction}` : `schem-cell kind-${node.kind}${node.src ? ' has-src' : ''}`,
        transform: `translate(${node.x} ${node.y})`, 'data-node': node.id, 'data-type': node.type || null, 'data-name': node.instance || node.name || null,
      });
      if (node.kind === 'port') drawPort(group, node);
      else drawCell(group, node);
      const tip = node.kind === 'port' ? `${node.direction} ${node.label}` : `${node.instance ? `${node.instance} : ` : ''}${shortType(node)}${node.src ? `\n${node.src} — click to open source` : ''}${node.kind === 'module' ? '\nDouble-click to open' : ''}`;
      group.append(el('title', {}, tip));
      // Click selects and inspects. With a mouse on a wide screen it also jumps to the source (submodules
      // wait briefly so a double-click drill-down does not jump); on touch / narrow screens the card's
      // Jump to Code / Open Submodule buttons do that instead, so the diagram stays in view.
      let pendingJump = null;
      group.addEventListener('click', event => {
        if (event.detail > 1 || dragMoved) return;
        event.stopPropagation();
        selectNode(node.id);
        openInspector({ node });
        if (inspectOnly()) return;
        const where = parseSrc(node.src);
        if (!where) return;
        if (node.kind === 'module') pendingJump = setTimeout(() => onJump(where.file, where.line), 260);
        else onJump(where.file, where.line);
      });
      if (node.kind === 'module') group.addEventListener('dblclick', event => { event.preventDefault(); event.stopPropagation(); clearTimeout(pendingJump); drillInto(node); });
      nodeEls.set(node.id, group);
      cells.append(group);
    }
    canvas.append(wires, hits, cells, labels);
    applySelection();
    applyOverlay();
    applyCriticalPath();
  }

  // ------------------------------------------------ live VCD overlay
  // The VCD scope that best matches this module's nets, e.g. "testbench.dut" for counter.
  function scopeFor() {
    if (!S.trace || !graph) return null;
    const path = crumbs.map(crumb => crumb.label).join('/');
    const key = `${S.rawLabel}|${S.trace.signals.length}|${path}|${graph.module}`;
    if (scopeCache.has(key)) return scopeCache.get(key);
    const nets = new Set(graph.edges.filter(edge => edge.slice && !edge.slice.hidden).map(edge => edge.slice.name));
    for (const node of graph.nodes) if (node.kind === 'port') nets.add(node.name);
    const scores = new Map();
    for (const signal of S.trace.signals) {
      const cut = signal.path.lastIndexOf('.');
      if (cut < 0) continue;
      const scope = signal.path.slice(0, cut);
      if (nets.has(signal.path.slice(cut + 1))) scores.set(scope, (scores.get(scope) || 0) + 1);
    }
    // Prefer the scope reached by following the drill-down instance names, then the best match;
    // ties go to the deeper scope (the instance rather than testbench nets mirroring its ports).
    let best = null;
    for (const [scope, score] of scores) {
      const parts = scope.split('.');
      const followsCrumbs = crumbs.slice(1).every((crumb, index) => parts.at(-(crumbs.length - 1) + index) === crumb.label);
      const rank = score * 10 + (crumbs.length > 1 && followsCrumbs ? 5 : 0) + parts.length * 0.01;
      if (!best || rank > best.rank) best = { scope, rank };
    }
    const result = best?.scope ?? null;
    scopeCache.set(key, result);
    return result;
  }

  function netBits(scope, slice) {
    const signal = store.signalByPath(`${scope}.${slice.name}`);
    if (!signal) return null;
    const raw = store.valueOf(signal);
    if (raw === null) return null;
    const bits = raw.padStart(signal.width, /^[xz]/.test(raw) ? raw[0] : '0');
    // VCD strings are MSB first; slice indices count from the LSB.
    return bits.slice(signal.width - 1 - slice.hi, signal.width - slice.lo);
  }

  function applyOverlay() {
    frame = 0;
    $('schem-time').textContent = S.trace ? formatTime(store.currentTime(), S.trace.timescale) : '—';
    for (const id of ['schem-step-prev', 'schem-play', 'schem-step-next']) $(id).disabled = !S.trace;
    $('schem-play').setAttribute('aria-pressed', String(S.playing));
    $('schem-play').textContent = S.playing ? '❚❚' : '▶';
    renderLearnBar();
    if (!graph) return;
    if (inspected) renderInspector();
    const scope = scopeFor();
    $('schem-scope').textContent = scope ? `VCD: ${scope}` : S.trace ? 'VCD: no matching scope' : '';
    for (const edge of graph.edges) {
      const path = canvas.querySelector(`path[data-edge="${edge.id}"]`);
      if (!path) continue;
      const bits = scope && edge.slice && !edge.slice.hidden && !edge.slice.partial ? netBits(scope, edge.slice) : null;
      path.classList.remove('wire-1', 'wire-0', 'wire-x', 'wire-z', 'is-live');
      const badge = canvas.querySelector(`g.schem-value[data-edge="${edge.id}"]`);
      if (!bits) { badge?.setAttribute('visibility', 'hidden'); continue; }
      path.classList.add('is-live');
      if (edge.width === 1) {
        path.classList.add(`wire-${bits}`);
      } else if (badge) {
        const text = formatValue(bits, bits.length, 'hex');
        badge.querySelector('text').textContent = text;
        badge.querySelector('rect').setAttribute('width', String(text.length * 6.2 + 8));
        badge.classList.toggle('is-unknown', /[xz]/.test(bits));
        badge.setAttribute('visibility', 'visible');
      }
    }
  }

  function schedule() {
    if (panel.hidden || frame) return;
    frame = requestAnimationFrame(applyOverlay);
  }

  let fittedToCanvas = true;
  let lastStageW = 0;
  let lastStageH = 0;

  // ------------------------------------------------ zoom / pan
  function setView(next) {
    view = next;
    canvas.setAttribute('viewBox', `${view.x} ${view.y} ${view.w} ${view.h}`);
    updateMinimapView();
  }

  function fit() {
    if (!graph) return;
    fittedToCanvas = true;
    const margin = 24;
    const box = { x: -margin, y: -margin, w: Math.max(graph.width, 60) + margin * 2, h: Math.max(graph.height, 40) + margin * 2 };
    const rect = canvas.getBoundingClientRect();
    lastStageW = rect.width || 0;
    lastStageH = rect.height || 0;
    const aspect = rect.width && rect.height ? rect.width / rect.height : box.w / box.h;
    // Keep the drawing centred and unstretched.
    if (box.w / box.h > aspect) { const h = box.w / aspect; box.y -= (h - box.h) / 2; box.h = h; }
    else { const w = box.h * aspect; box.x -= (w - box.w) / 2; box.w = w; }
    setView(box);
  }

  function zoom(factor, cx = view.x + view.w / 2, cy = view.y + view.h / 2) {
    if (!view) return;
    fittedToCanvas = false;
    const w = Math.min(Math.max(view.w * factor, 40), 40000);
    const h = view.h * (w / view.w);
    setView({ x: cx - (cx - view.x) * (w / view.w), y: cy - (cy - view.y) * (h / view.h), w, h });
  }

  function toCanvas(event) {
    const rect = canvas.getBoundingClientRect();
    return [view.x + (event.clientX - rect.left) / rect.width * view.w, view.y + (event.clientY - rect.top) / rect.height * view.h];
  }

  // One pointer pans (after 4 px); two pointers pinch-zoom around their midpoint and pan as it moves.
  const pointers = new Map();
  let drag = null;
  let pinch = null;
  let dragMoved = false;
  canvas.addEventListener('wheel', event => {
    if (!view) return;
    event.preventDefault();
    const [cx, cy] = toCanvas(event);
    zoom(event.deltaY < 0 ? 1 / 1.15 : 1.15, cx, cy);
  }, { passive: false });
  const capture = id => { try { canvas.setPointerCapture(id); } catch { /* synthetic or already released */ } };
  function startPinch() {
    const [a, b] = [...pointers.values()];
    pinch = { dist: Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, view: { ...view } };
    drag = null;
    dragMoved = true;
    fittedToCanvas = false;
    canvas.classList.add('is-panning');
  }
  canvas.addEventListener('pointerdown', event => {
    lastPointerType = event.pointerType || 'mouse';
    if (!view || (event.pointerType === 'mouse' && event.button !== 0 && event.button !== 1)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size === 1) { drag = { x: event.clientX, y: event.clientY, view: { ...view }, id: event.pointerId }; dragMoved = false; }
    else if (pointers.size === 2) { for (const id of pointers.keys()) capture(id); startPinch(); }
  });
  canvas.addEventListener('pointermove', event => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const rect = canvas.getBoundingClientRect();
    if (pinch && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      const dist = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 1);
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const v = pinch.view;
      const w = Math.min(Math.max(v.w * pinch.dist / dist, 40), 40000);
      const h = v.h * (w / v.w);
      // The drawing point under the starting midpoint stays under the current midpoint.
      const cx = v.x + (pinch.mid.x - rect.left) / rect.width * v.w;
      const cy = v.y + (pinch.mid.y - rect.top) / rect.height * v.h;
      setView({ x: cx - (mid.x - rect.left) / rect.width * w, y: cy - (mid.y - rect.top) / rect.height * h, w, h });
      return;
    }
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!dragMoved && Math.hypot(dx, dy) < 4) return;
    if (!dragMoved) { dragMoved = true; fittedToCanvas = false; capture(drag.id); canvas.classList.add('is-panning'); }
    setView({ ...drag.view, x: drag.view.x - dx / rect.width * drag.view.w, y: drag.view.y - dy / rect.height * drag.view.h });
  });
  const endPointer = event => {
    pointers.delete(event.pointerId);
    if (pointers.size < 2 && pinch) {
      pinch = null;
      // Continue panning with the finger that stays down.
      const [rest] = [...pointers.entries()];
      drag = rest ? { x: rest[1].x, y: rest[1].y, view: { ...view }, id: rest[0] } : null;
    }
    if (pointers.size === 0) { drag = null; canvas.classList.remove('is-panning'); setTimeout(() => { dragMoved = false; }, 0); }
  };
  canvas.addEventListener('pointerup', endPointer);
  canvas.addEventListener('pointercancel', endPointer);
  // Empty background: click clears the selection, double-click / double-tap fits the drawing.
  const onBackground = event => !event.target.closest?.('.schem-cell, .schem-port, .schem-hit');
  canvas.addEventListener('click', event => { if (!dragMoved && onBackground(event)) clearSelection(); });
  canvas.addEventListener('dblclick', event => { if (onBackground(event)) fit(); });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || panel.hidden || !(selection || inspected) || document.querySelector('dialog[open]')) return;
    if (event.target.closest?.('input, textarea, .cm-editor')) return;
    clearSelection();
  });

  // ------------------------------------------------ export
  // Self-contained SVG: theme colors resolved inline so the file renders anywhere.
  function exportSvg() {
    if (!graph) return;
    const focused = canvas.classList.contains('has-focus');
    canvas.classList.remove('has-focus');
    const clone = canvas.cloneNode(true);
    const source = [canvas, ...canvas.querySelectorAll('*')];
    const target = [clone, ...clone.querySelectorAll('*')];
    const props = ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'visibility'];
    source.forEach((node, index) => {
      const style = getComputedStyle(node);
      target[index].setAttribute('style', props.map(prop => `${prop}:${style.getPropertyValue(prop)}`).join(';'));
      target[index].removeAttribute('class');
    });
    if (focused) canvas.classList.add('has-focus');
    clone.querySelector('[data-hits]')?.remove();
    const margin = 16;
    clone.setAttribute('xmlns', SVG);
    clone.setAttribute('viewBox', `${-margin} ${-margin} ${graph.width + margin * 2} ${graph.height + margin * 2}`);
    clone.setAttribute('width', String(Math.round(graph.width + margin * 2)));
    clone.setAttribute('height', String(Math.round(graph.height + margin * 2)));
    const background = el('rect', { x: -margin, y: -margin, width: graph.width + margin * 2, height: graph.height + margin * 2, fill: getComputedStyle(panel).getPropertyValue('--bg').trim() || '#000' });
    clone.insertBefore(background, clone.firstChild);
    const text = `<?xml version="1.0" encoding="UTF-8"?>\n${new XMLSerializer().serializeToString(clone)}\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${crumbs.map(crumb => crumb.label).join('.') || graph.module}.svg`.replace(/[^\w.-]+/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ------------------------------------------------ elaborate
  async function elaborate() {
    const topModule = $('schem-module').value;
    if (!topModule || busy) return;
    let settings;
    try { settings = getSettings(); } catch (error) { setStatus(error.message, true); return; }
    const sources = getRtlSources();
    busy = true;
    $('schem-elaborate').disabled = true;
    setStatus(worker ? `Elaborating ${topModule}…` : `Loading the elaboration engine, then elaborating ${topModule}…`);
    try {
      const fileSnapshot = { ...getFiles() };
      const reply = await request('elaborate', {
        files: fileSnapshot, sourceFiles: sources.map(([path]) => path), topModule, standard: getStandard(),
        defines: settings.defines, includeDirs: settings.includeDirs, flatten,
      });
      diagnostics = reply.diagnostics || [];
      renderWarnings();
      if (reply.type === 'elaborate-failed') {
        setStatus(`Elaboration failed${diagnostics[0] ? `: ${diagnostics[0].message}` : ''}`, true);
        return;
      }
      design = { topModule, modules: reply.modules, yosysJson: reply.yosysJson, flatten };
      lastResources = reply.resources || null;
      lastCriticalPath = reply.criticalPath || null;
      onElaborated?.({ yosysJson: reply.yosysJson, resources: lastResources, criticalPath: lastCriticalPath, files: fileSnapshot, sourceFiles: sources.map(([path]) => path) });
      crumbs = [{ label: topModule, module: topModule }];
      scopeCache.clear();
      showGraph(reply.graph);
      const latches = diagnostics.filter(item => item.kind === 'latch').length;
      setStatus(`${topModule}: ${reply.graph.nodes.length} nodes · ${reply.graph.edges.length} nets · ${reply.elapsedMs} ms${latches ? ` · ${latches} latch${latches === 1 ? '' : 'es'}` : ''}`);
      if (latches) notify?.(`${latches} latch${latches === 1 ? '' : 'es'} inferred in ${topModule}`);
    } catch (error) {
      setStatus(error.message, true);
    } finally {
      busy = false;
      $('schem-elaborate').disabled = false;
    }
  }

  store.subscribe((_, kind) => {
    if (kind === 'trace') scopeCache.clear();
    if (kind === 'cursor' || kind === 'trace' || kind === 'playing') schedule();
  });
  // Highlight graph elements by their cell keys and numeric net bits, not displayed net names.
  function applyCriticalPath() {
    const cells = new Set(lastCriticalPath?.hasCombLoop ? lastCriticalPath.loopCells || [] : lastCriticalPath?.cells || []);
    const nets = new Set((lastCriticalPath?.nets || []).filter(bit => typeof bit === 'number'));
    for (const node of graph?.nodes || []) nodeEls.get(node.id)?.classList.toggle('is-critpath', criticalEnabled && node.id.startsWith('cell:') && cells.has(node.name));
    for (const edge of graph?.edges || []) wireEls.get(edge.id)?.classList.toggle('is-critpath', criticalEnabled && edge.bits?.some(bit => typeof bit === 'number' && nets.has(bit)));
  }
  const displayLabel = value => String(value).replace(/\$_ivl_\d+/g, 'generated');
  const pointLabel = value => value == null ? '—' : displayLabel(typeof value === 'object' ? (value.name || value.cell || value.port || JSON.stringify(value)) : value);
  function renderCriticalPath() {
    const host = $('schem-critpath-banner');
    host.hidden = !criticalEnabled;
    host.replaceChildren();
    if (!criticalEnabled) { applyCriticalPath(); return; }
    const path = lastCriticalPath;
    if (!path) { host.textContent = 'Elaborate a module to inspect its critical path.'; applyCriticalPath(); return; }
    const summary = document.createElement('strong');
    summary.textContent = path.hasCombLoop ? `Combinational loop detected (${(path.loopCells || []).length} cells)` : `Depth ${path.depth} · ${path.gateCount} stages · ${pointLabel(path.startpoint)} → ${pointLabel(path.endpoint)}`;
    host.append(summary);
    const steps = document.createElement('div'); steps.className = 'schem-critical-steps';
    const items = path.hasCombLoop ? (path.loopCells || []).map(cell => ({ cell, type: 'loop' })) : path.steps || [];
    for (const step of items) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'chip';
      const head = step.label ? displayLabel(step.label) : `${displayLabel(step.cell)} (${displayLabel(step.type)})`;
      button.textContent = `${head}${step.cumDepth != null ? ` · ${step.cumDepth}` : ''}`;
      button.dataset.cell = step.cell;
      const id = `cell:${step.cell}`; button.disabled = !index?.nodes.has(id);
      button.onclick = () => { fittedToCanvas = false; focusMatch({ kind: 'node', id }); };
      steps.append(button);
    }
    host.append(steps); applyCriticalPath();
  }

  // Follow the first real instance path from the top to a module in the resource table.
  async function openResourceModule(name) {
    const modules = design?.yosysJson?.modules || {};
    const top = design?.topModule;
    if (!top || !modules[name]) return;
    const queue = [{ module: top, labels: [top], seen: new Set([top]) }];
    let target = null;
    while (queue.length) {
      const item = queue.shift();
      if (item.module === name) { target = item.labels; break; }
      for (const [instance, cell] of Object.entries(modules[item.module]?.cells || {})) {
        if (!modules[cell.type] || item.seen.has(cell.type)) continue;
        queue.push({ module: cell.type, labels: [...item.labels, instance], seen: new Set([...item.seen, cell.type]) });
      }
    }
    if (target && await navigateTo(target)) { onNavigate?.(); return; }
    if (busy) return;
    busy = true;
    try {
      const reply = await request('layout', { moduleName: name });
      crumbs = [{ label: name, module: name }]; lastCriticalPath = reply.criticalPath || null;
      showGraph(reply.graph); onNavigate?.();
    } catch (error) { setStatus(error.message, true); } finally { busy = false; }
  }
  function renderResources() {
    const host = $('schem-resources-panel'); host.hidden = !resourcesEnabled; host.replaceChildren();
    if (!resourcesEnabled) return;
    if (!lastResources) { host.textContent = 'Elaborate a module to see resource usage.'; return; }
    const total = lastResources.total || {};
    const badges = document.createElement('div'); badges.className = 'schem-resource-badges';
    for (const [label, value] of [['FF bits', total.ffBits], ['Latches', total.latchBits], ['Muxes', total.muxes], ['Ops', total.ops], ['Gates', total.gates], ['Memory', total.memBits], ['Behavioral', total.behavioral]]) {
      const badge = document.createElement('span'); badge.className = 'schem-resource-badge'; badge.textContent = `${label}: ${value ?? 0}`; badges.append(badge);
    }
    const table = document.createElement('table'); table.className = 'schem-resource-table';
    const head = document.createElement('thead'); const header = document.createElement('tr');
    for (const label of ['Module', 'Instances', 'FFs', 'Muxes', 'Ops', 'Mem']) { const th = document.createElement('th'); th.textContent = label; header.append(th); }
    head.append(header); table.append(head);
    const body = document.createElement('tbody');
    for (const module of lastResources.byModule || []) {
      const row = document.createElement('tr'); const nameCell = document.createElement('td');
      const button = document.createElement('button'); button.type = 'button'; button.textContent = module.name; button.onclick = () => openResourceModule(module.name);
      nameCell.append(button); row.append(nameCell);
      const self = module.self || {};
      for (const value of [module.instanceCount, self.ffBits, self.muxes, self.ops, self.memBits]) { const td = document.createElement('td'); td.textContent = String(value ?? 0); row.append(td); }
      body.append(row);
    }
    table.append(body); host.append(badges, table);
  }
  $('schem-critpath').onclick = () => { criticalEnabled = !criticalEnabled; $('schem-critpath').setAttribute('aria-pressed', String(criticalEnabled)); renderCriticalPath(); };
  $('schem-resources').onclick = () => { resourcesEnabled = !resourcesEnabled; $('schem-resources').setAttribute('aria-pressed', String(resourcesEnabled)); renderResources(); };
  $('schem-elaborate').onclick = elaborate;
  $('schem-flatten').onclick = () => {
    flatten = !flatten;
    $('schem-flatten').setAttribute('aria-pressed', String(flatten));
    if (design) elaborate();
  };
  $('schem-fit').onclick = fit;
  $('schem-zoom-in').onclick = () => zoom(1 / 1.25);
  $('schem-zoom-out').onclick = () => zoom(1.25);
  $('schem-export').onclick = exportSvg;
  $('schem-step-prev').onclick = () => store.stepCycle(-1);
  $('schem-step-next').onclick = () => store.stepCycle(1);
  $('schem-play').onclick = () => { if (S.playing) store.pause(); else store.play(); };
  draw();

  store.subscribe((_, kind) => { if (kind === 'mem') schedule(); });

  const stage = panel.querySelector('.schem-stage');
  if (stage && typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      if (!graph || !view || panel.hidden) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width <= 40 || rect.height <= 40) return;
      if (Math.abs(rect.width - lastStageW) <= 4 && Math.abs(rect.height - lastStageH) <= 4) return;
      lastStageW = rect.width;
      lastStageH = rect.height;
      if (fittedToCanvas) { fit(); return; }
      const aspect = rect.width / rect.height;
      const cx = view.x + view.w / 2;
      const cy = view.y + view.h / 2;
      const h = view.w / aspect;
      setView({ x: cx - view.w / 2, y: cy - h / 2, w: view.w, h });
    }).observe(stage);
  }

  return {
    render: () => { renderModules(); applyOverlay(); if (graph && (!view || fittedToCanvas)) fit(); },
    elaborate,
    warm: () => request('warm', {}).catch(() => {}),
    fit,
    hasWorker: () => worker !== null,
    getCrumbs: () => crumbs.map(crumb => crumb.label),
    navigateTo,
    closeInspector: () => closeInspector(),
    clearSelection,
    getView: () => (view ? { ...view } : null),
  };
}
