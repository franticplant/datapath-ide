// Resource estimates and a weighted critical-path estimate over the Yosys-style JSON from engine/tgt-json.cc.
// Pure functions: they run inside elaborate-worker.js and in Node tests.

const FF_TYPES = new Set(['$dff', '$dffe', '$adff', '$adffe', '$sdff', '$sdffe', '$sdffce', '$dffsr', '$dffsre', '$aldff', '$aldffe']);
const LATCH_TYPES = new Set(['$dlatch', '$dlatchsr', '$adlatch']);
const MUX_TYPES = new Set(['$mux', '$pmux', '$bmux', '$_MUX_', '$_NMUX_']);
const GATE_TYPES = new Set(['$and', '$or', '$xor', '$xnor', '$not', '$nand', '$nor', '$buf', '$tribuf']);
const OP_TYPES = new Set(['$add', '$sub', '$mul', '$div', '$mod', '$pow', '$divfloor', '$modfloor', '$abs', '$neg', '$pos',
  '$eq', '$ne', '$eqx', '$nex', '$lt', '$le', '$gt', '$ge',
  '$shl', '$shr', '$sshr', '$sshl', '$shift', '$shiftx',
  '$reduce_and', '$reduce_or', '$reduce_xor', '$reduce_xnor', '$reduce_bool', '$reduce_nand', '$reduce_nor',
  '$logic_not', '$logic_and', '$logic_or', '$slice', '$concat', '$part', '$cast', '$substitute']);
const MEM_TYPES = new Set(['$mem', '$mem_v2', '$memrd', '$memrd_v2', '$memwr', '$memwr_v2']);

const METRIC_KEYS = ['ffBits', 'ffCells', 'latchBits', 'latchCells', 'muxes', 'ops', 'gates', 'memCells', 'memBits', 'behavioral', 'totalCells'];

function emptyMetrics() { return Object.fromEntries(METRIC_KEYS.map(k => [k, 0])); }
function addMetrics(into, from, times = 1) { for (const k of METRIC_KEYS) into[k] += from[k] * times; return into; }

// Parameters come as 32-char binary strings from tgt-json.cc, but accept numbers and decimal strings too.
function paramNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  if (/^[01]+$/.test(value) && value.length > 1) return parseInt(value, 2);
  if (/^\d+$/.test(value)) return parseInt(value, 10);
  return null;
}

function modulesOf(yosysJson) {
  const modules = yosysJson && typeof yosysJson === 'object' ? yosysJson.modules : null;
  return modules && typeof modules === 'object' ? modules : null;
}

function cellsOf(mod) { return mod && mod.cells && typeof mod.cells === 'object' ? Object.entries(mod.cells).filter(([, c]) => c && typeof c === 'object') : []; }

// Map a cell type (or a requested top name) to a module key, tolerating `$paramod\name\...` and `\name` keys.
function moduleResolver(modules) {
  const keys = Object.keys(modules);
  const cache = new Map();
  const clean = key => String(key).replace(/^\\/, '').replace(/^\$paramod\\([^\\]+)\\.*$/, '$1').replace(/^\$paramod\$[0-9a-f]+\\/, '');
  return type => {
    if (typeof type !== 'string' || !type) return null;
    if (cache.has(type)) return cache.get(type);
    let found = Object.prototype.hasOwnProperty.call(modules, type) ? type : null;
    if (!found && !type.startsWith('$')) found = keys.find(k => k === `\\${type}`) || null;
    if (!found && !type.startsWith('$')) {
      const matches = keys.filter(k => clean(k) === clean(type) || k.endsWith(`\\${type}`) || k.endsWith(`.${type}`));
      found = matches.length ? matches[0] : null;
    }
    if (!found && type.startsWith('$paramod')) {
      const matches = keys.filter(k => clean(k) === clean(type));
      found = matches.length === 1 ? matches[0] : null;
    }
    cache.set(type, found);
    return found;
  };
}

function isTopAttr(value) {
  if (value === true) return true;
  const n = paramNumber(value);
  return n != null && n !== 0;
}

function resolveTop(modules, requested) {
  const resolve = moduleResolver(modules);
  if (requested) { const hit = resolve(String(requested)); if (hit) return hit; }
  return Object.keys(modules).find(k => isTopAttr(modules[k]?.attributes?.top)) || null;
}

function cellWidth(cell) {
  const w = paramNumber(cell.parameters?.WIDTH);
  if (w != null && w > 0) return w;
  return Array.isArray(cell.connections?.Q) && cell.connections.Q.length ? cell.connections.Q.length : 1;
}

function isFlipFlop(type) { return FF_TYPES.has(type) || /^\$_(?:S?DFFC?E?|ALDFFE?|DFFSRE?)_[A-Z01]+_$/.test(type); }
function isLatch(type) { return LATCH_TYPES.has(type) || /^\$_DLATCH(?:SR)?_[A-Z01]+_$/.test(type); }
function isFineGate(type) { return /^\$_(?:AND|OR|XOR|XNOR|NAND|NOR|NOT|BUF|ANDNOT|ORNOT|AOI3|OAI3|AOI4|OAI4)_$/.test(type); }

function classify(type, resolve) {
  if (typeof type !== 'string') return 'behavioral';
  if (isFlipFlop(type)) return 'ff';
  if (isLatch(type)) return 'latch';
  if (MUX_TYPES.has(type)) return 'mux';
  if (GATE_TYPES.has(type) || isFineGate(type)) return 'gate';
  if (OP_TYPES.has(type)) return 'op';
  if (MEM_TYPES.has(type)) return 'mem';
  if (resolve(type)) return 'module';
  return 'behavioral'; // $proc, $func, $lpm, $udp, unknown primitives and black boxes
}

function memBitsOf(cell) {
  if (cell.type !== '$mem' && cell.type !== '$mem_v2') return 0;
  const width = paramNumber(cell.parameters?.WIDTH) || 0;
  let size = paramNumber(cell.parameters?.SIZE);
  if (size == null) { const abits = paramNumber(cell.parameters?.ABITS); size = abits != null ? 2 ** abits : 0; }
  return width * size;
}

function selfMetrics(mod, resolve) {
  const m = emptyMetrics();
  const children = [];
  for (const [, cell] of cellsOf(mod)) {
    const kind = classify(cell.type, resolve);
    switch (kind) {
      case 'ff': m.ffCells++; m.ffBits += cellWidth(cell); break;
      case 'latch': m.latchCells++; m.latchBits += cellWidth(cell); break;
      case 'mux': m.muxes++; break;
      case 'gate': m.gates++; break;
      case 'op': m.ops++; break;
      case 'mem': m.memCells++; m.memBits += memBitsOf(cell); break;
      case 'module': children.push(resolve(cell.type)); continue;
      default: m.behavioral++; break;
    }
    m.totalCells++;
  }
  return { metrics: m, children };
}

export function analyzeResources(yosysJson, topModule = null) {
  const modules = modulesOf(yosysJson);
  if (!modules) return { top: null, total: emptyMetrics(), byModule: [] };
  const resolve = moduleResolver(modules);
  const names = Object.keys(modules);
  const self = new Map(), children = new Map();
  for (const name of names) {
    const r = selfMetrics(modules[name], resolve);
    self.set(name, r.metrics);
    children.set(name, r.children);
  }
  const top = resolveTop(modules, topModule);

  // Depth-first order from the roots; edges that close a cycle are dropped so everything below stays finite.
  const instantiated = new Set();
  for (const list of children.values()) for (const c of list) instantiated.add(c);
  const roots = top ? [top] : names.filter(n => !instantiated.has(n));
  if (!top && !roots.length && names.length) roots.push(names[0]);
  const state = new Map(); // 1 = on stack, 2 = done
  const postorder = [];
  const dagChildren = new Map(names.map(n => [n, []]));
  const visit = root => {
    const stack = [[root, 0]];
    state.set(root, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const [node] = frame;
      const list = children.get(node) || [];
      if (frame[1] < list.length) {
        const child = list[frame[1]++];
        const s = state.get(child);
        if (s === 1) continue; // back edge: instantiation cycle
        dagChildren.get(node).push(child);
        if (!s) { state.set(child, 1); stack.push([child, 0]); }
      } else {
        state.set(node, 2);
        postorder.push(node);
        stack.pop();
      }
    }
  };
  for (const r of roots) if (!state.has(r)) visit(r);

  const inclusive = new Map();
  for (const name of postorder) {
    const acc = addMetrics(emptyMetrics(), self.get(name));
    for (const child of dagChildren.get(name)) addMetrics(acc, inclusive.get(child));
    inclusive.set(name, acc);
  }
  for (const name of names) if (!inclusive.has(name)) inclusive.set(name, addMetrics(emptyMetrics(), self.get(name)));

  const counts = new Map(names.map(n => [n, 0]));
  for (const r of roots) counts.set(r, counts.get(r) + 1);
  const order = [...postorder].reverse();
  for (const name of order) {
    const n = counts.get(name);
    if (!n) continue;
    for (const child of dagChildren.get(name)) counts.set(child, counts.get(child) + n);
  }

  const reached = order.filter(n => counts.get(n) > 0);
  const rest = names.filter(n => !reached.includes(n));
  const byModule = [...reached, ...rest].map(name => ({
    name,
    instanceCount: counts.get(name),
    self: { ...self.get(name) },
    inclusive: { ...inclusive.get(name) },
  }));

  const total = emptyMetrics();
  if (top) addMetrics(total, inclusive.get(top));
  else for (const r of roots) addMetrics(total, inclusive.get(r));
  return { top, total, byModule };
}

// ---------------------------------------------------------------------------
// Critical path

const WEIGHTS = {
  $not: 1, $buf: 1, $and: 1, $or: 1, $xor: 1, $nand: 1, $nor: 1, $xnor: 1, $tribuf: 1,
  $mux: 1.5, $pmux: 1.5, $bmux: 1.5, $_MUX_: 1.5, $_NMUX_: 1.5,
  $eq: 2, $ne: 2, $eqx: 2, $nex: 2, $lt: 2, $le: 2, $gt: 2, $ge: 2,
  $reduce_and: 2, $reduce_or: 2, $reduce_xor: 2, $reduce_xnor: 2, $reduce_bool: 2, $reduce_nand: 2, $reduce_nor: 2,
  $logic_not: 2, $logic_and: 2, $logic_or: 2,
  $shl: 2, $shr: 2, $sshl: 2, $sshr: 2, $shift: 2, $shiftx: 2,
  $add: 2.5, $sub: 2.5, $neg: 2.5, $abs: 2.5,
  $mul: 4, $div: 4, $mod: 4, $pow: 4, $divfloor: 4, $modfloor: 4,
  $pos: 0, $slice: 0, $concat: 0, $part: 0, $cast: 0, $substitute: 0,
};
const MEM_READ_WEIGHT = 2;
const OTHER_WEIGHT = 1.5;
const BITWISE = new Set(['$not', '$buf', '$and', '$or', '$xor', '$nand', '$nor', '$xnor', '$pos', '$tribuf']);
const RIPPLE = new Set(['$add', '$sub', '$neg']);

function weightOf(type) {
  if (Object.prototype.hasOwnProperty.call(WEIGHTS, type)) return WEIGHTS[type];
  if (isFineGate(type)) return 1;
  return OTHER_WEIGHT;
}

const round = d => Math.round(d * 10) / 10;
const bitsOf = value => (Array.isArray(value) ? value : []);
const isNet = b => typeof b === 'number' && Number.isFinite(b);

function emptyPath(name) {
  return { module: name, depth: 0, gateCount: 0, hasCombLoop: false, loopCells: [], startpoint: null, endpoint: null, cells: [], nets: [], steps: [] };
}

function directionOf(cell, pin) {
  const d = cell.port_directions?.[pin];
  if (d) return d;
  if (/^(Y|Q|RD_DATA\d*|DATA)$/.test(pin)) return 'output';
  return 'input';
}

function connectedClock(cell, pin) { return bitsOf(cell.connections?.[pin]).some(isNet); }

// Build the combinational arcs and the boundary points of one module.
// `summaryOf(type)` describes submodules: per output port, the inner depth from each input port.
function buildGraph(mod, resolve, summaryOf) {
  const arcs = []; // { from, to, cell, type, weight }
  const starts = new Map(); // bit -> label
  const softStarts = new Map(); // labels for bits that are not hard startpoints
  const ends = []; // { bit, label }
  const addStart = (bits, label) => { for (const b of bitsOf(bits)) if (isNet(b) && !starts.has(b)) starts.set(b, label); };
  const addEnd = (bits, label) => { for (const b of bitsOf(bits)) if (isNet(b)) ends.push({ bit: b, label }); };
  const arc = (from, to, cell, type, weight) => { if (isNet(from) && isNet(to) && from !== to) arcs.push({ from, to, cell, type, weight }); };
  const all = (ins, outs, cell, type, weight) => { for (const o of outs) for (const i of ins) arc(i, o, cell, type, weight); };

  for (const [name, port] of Object.entries(mod.ports || {})) {
    const dir = port?.direction;
    if (dir === 'input' || dir === 'inout') addStart(port.bits, `port:${name}`);
  }
  for (const [name, port] of Object.entries(mod.ports || {})) {
    const dir = port?.direction;
    if (dir === 'output' || dir === 'inout') addEnd(port.bits, `port:${name}`);
  }

  for (const [key, cell] of cellsOf(mod)) {
    const type = String(cell.type || '');
    const conns = cell.connections || {};
    const pins = Object.keys(conns);
    const inputs = pins.filter(p => directionOf(cell, p) !== 'output');
    const outputs = pins.filter(p => directionOf(cell, p) !== 'input');
    const pointName = boundaryName(mod, key, cell);
    const label = pin => `${pointName} (${pin})`;
    const sequential = () => {
      for (const p of outputs) addStart(conns[p], label(p));
      for (const p of inputs) if (!/^C(LK)?$/.test(p)) addEnd(conns[p], label(p));
    };

    if (isFlipFlop(type) || isLatch(type)) { sequential(); continue; }
    if (type === '$proc') {
      if (connectedClock(cell, 'CLK')) { sequential(); continue; }
      all(inputs.flatMap(p => bitsOf(conns[p])), outputs.flatMap(p => bitsOf(conns[p])), key, type, OTHER_WEIGHT);
      continue;
    }
    if (type === '$mem' || type === '$mem_v2' || type === '$memrd' || type === '$memrd_v2' || type === '$memwr' || type === '$memwr_v2') {
      for (const p of pins) {
        if (/^WR_|^CLK$|^EN$/.test(p) && directionOf(cell, p) !== 'output') addEnd(conns[p], label(p));
      }
      const syncRead = pins.some(p => /^RD_CLK/.test(p) && connectedClock(cell, p) && paramNumber(cell.parameters?.RD_CLK_ENABLE) !== 0)
        || (type.startsWith('$memrd') && connectedClock(cell, 'CLK') && paramNumber(cell.parameters?.CLK_ENABLE) !== 0);
      const addrPins = pins.filter(p => /^RD_ADDR\d*$/.test(p) || (type.startsWith('$memrd') && p === 'ADDR'));
      const dataPins = pins.filter(p => /^RD_DATA\d*$/.test(p) || (type.startsWith('$memrd') && p === 'DATA'));
      if (syncRead) {
        for (const p of addrPins) addEnd(conns[p], label(p));
        for (const p of dataPins) addStart(conns[p], label(p));
        continue;
      }
      for (const dp of dataPins) {
        const suffix = dp.replace(/^RD_DATA|^DATA$/, '');
        const ap = addrPins.find(p => p.replace(/^RD_ADDR|^ADDR$/, '') === suffix) || addrPins[0];
        if (ap) all(bitsOf(conns[ap]), bitsOf(conns[dp]), key, type, MEM_READ_WEIGHT);
      }
      continue;
    }
    const child = !type.startsWith('$') || type.startsWith('$paramod') ? resolve(type) : null;
    if (child) {
      const summary = summaryOf(child);
      if (!summary) {
        all(inputs.flatMap(p => bitsOf(conns[p])), outputs.flatMap(p => bitsOf(conns[p])), key, type, OTHER_WEIGHT);
        continue;
      }
      const fedInputs = new Set();
      for (const out of outputs) {
        const paths = summary.get(out);
        const outBits = bitsOf(conns[out]);
        const comb = [...(paths || new Map())].filter(([inp]) => inp !== null);
        // Pure register outputs are hard startpoints; mixed outputs keep their combinational arcs.
        if (!comb.length) { addStart(outBits, label(out)); continue; }
        for (const b of outBits) if (isNet(b) && !softStarts.has(b)) softStarts.set(b, label(out));
        for (const [inp, depth] of comb) {
          fedInputs.add(inp);
          all(bitsOf(conns[inp]), outBits, key, type, depth);
        }
      }
      for (const inp of inputs) if (!fedInputs.has(inp)) addEnd(conns[inp], label(inp));
      continue;
    }

    // Plain combinational primitive.
    const weight = weightOf(type);
    const y = outputs.flatMap(p => bitsOf(conns[p]));
    if (BITWISE.has(type) || isFineGate(type)) {
      for (const p of inputs) {
        const bits = bitsOf(conns[p]);
        if (bits.length === y.length) bits.forEach((b, i) => arc(b, y[i], key, type, weight));
        else all(bits, y, key, type, weight);
      }
      continue;
    }
    if (type === '$mux' || type === '$_MUX_' || type === '$_NMUX_') {
      for (const p of inputs) {
        const bits = bitsOf(conns[p]);
        if (p !== 'S' && bits.length === y.length) bits.forEach((b, i) => arc(b, y[i], key, type, weight));
        else all(bits, y, key, type, weight);
      }
      continue;
    }
    if (type === '$pmux') {
      const sWidth = bitsOf(conns.S).length;
      for (const p of inputs) {
        const bits = bitsOf(conns[p]);
        if (p !== 'S' && bits.length === y.length) bits.forEach((b, i) => arc(b, y[i], key, type, weight));
        else if (p === 'B' && y.length && bits.length === y.length * sWidth) bits.forEach((b, i) => arc(b, y[i % y.length], key, type, weight));
        else all(bits, y, key, type, weight);
      }
      continue;
    }
    if (RIPPLE.has(type)) {
      // Output bit i depends on operand bits 0..i (carry chain, LSB first).
      for (const p of inputs) {
        const bits = bitsOf(conns[p]);
        y.forEach((o, i) => { for (let k = 0; k <= i && k < bits.length; k++) arc(bits[k], o, key, type, weight); });
      }
      continue;
    }
    all(inputs.flatMap(p => bitsOf(conns[p])), y, key, type, weight);
  }
  return { arcs, starts, ends, softStarts };
}

// Iterative Tarjan SCC; returns a component id per node and the set of component ids that are cycles.
function stronglyConnected(nodes, succ) {
  let index = 0;
  const idx = new Map(), low = new Map(), onStack = new Set(), comp = new Map();
  const stack = [];
  let compId = 0;
  for (const start of nodes) {
    if (idx.has(start)) continue;
    const work = [[start, 0]];
    idx.set(start, index); low.set(start, index); index++;
    stack.push(start); onStack.add(start);
    while (work.length) {
      const frame = work[work.length - 1];
      const [v] = frame;
      const out = succ.get(v) || [];
      if (frame[1] < out.length) {
        const w = out[frame[1]++].to;
        if (!idx.has(w)) {
          idx.set(w, index); low.set(w, index); index++;
          stack.push(w); onStack.add(w);
          work.push([w, 0]);
        } else if (onStack.has(w)) {
          low.set(v, Math.min(low.get(v), idx.get(w)));
        }
      } else {
        work.pop();
        if (work.length) { const parent = work[work.length - 1][0]; low.set(parent, Math.min(low.get(parent), low.get(v))); }
        if (low.get(v) === idx.get(v)) {
          let w;
          do { w = stack.pop(); onStack.delete(w); comp.set(w, compId); } while (w !== v);
          compId++;
        }
      }
    }
  }
  return comp;
}

function pathThrough(mod, resolve, summaryOf) {
  const { arcs, starts, ends, softStarts } = buildGraph(mod, resolve, summaryOf);
  // Startpoints are sequential boundaries: never traverse into them.
  const live = arcs.filter(a => !starts.has(a.to));
  const nodes = new Set();
  for (const a of live) { nodes.add(a.from); nodes.add(a.to); }
  const succ = new Map();
  for (const a of live) { if (!succ.has(a.from)) succ.set(a.from, []); succ.get(a.from).push(a); }
  const comp = stronglyConnected(nodes, succ);
  const compSize = new Map();
  for (const c of comp.values()) compSize.set(c, (compSize.get(c) || 0) + 1);
  const loopArcs = live.filter(a => comp.get(a.from) === comp.get(a.to) && compSize.get(comp.get(a.from)) > 1);
  const loopSet = new Set(loopArcs);
  const dag = live.filter(a => !loopSet.has(a));

  // Kahn longest path over the remaining acyclic arcs.
  const indeg = new Map([...nodes].map(n => [n, 0]));
  const out = new Map();
  for (const a of dag) { indeg.set(a.to, indeg.get(a.to) + 1); if (!out.has(a.from)) out.set(a.from, []); out.get(a.from).push(a); }
  const depth = new Map(), pred = new Map();
  const queue = [...nodes].filter(n => indeg.get(n) === 0);
  for (const n of queue) depth.set(n, 0);
  for (let q = 0; q < queue.length; q++) {
    const n = queue[q];
    const d = depth.get(n);
    for (const a of out.get(n) || []) {
      const nd = d + a.weight;
      if (!depth.has(a.to) || nd > depth.get(a.to)) { depth.set(a.to, nd); pred.set(a.to, a); }
      indeg.set(a.to, indeg.get(a.to) - 1);
      if (indeg.get(a.to) === 0) queue.push(a.to);
    }
  }
  return { starts, ends, depth, pred, loopArcs, order: queue, out, softStarts };
}

// Per output port of a module: Map(inputPort|null -> inner depth); null marks a sequential (or undriven) source.
function moduleSummary(mod, resolve, summaryOf) {
  const { starts, depth, order, out } = pathThrough(mod, resolve, summaryOf);
  const ports = Object.entries(mod.ports || {});
  const outputs = ports.filter(([, p]) => p?.direction === 'output' || p?.direction === 'inout');
  const summary = new Map(outputs.map(([name]) => [name, new Map()]));
  const note = (map, key, d) => map.set(key, Math.max(map.get(key) ?? -Infinity, d));
  for (const [inName, inPort] of ports) {
    if (inPort?.direction !== 'input' && inPort?.direction !== 'inout') continue;
    const reach = new Map();
    for (const b of bitsOf(inPort.bits)) if (isNet(b)) reach.set(b, 0);
    if (!reach.size) continue;
    for (const n of order) {
      if (!reach.has(n)) continue;
      const d = reach.get(n);
      for (const a of out.get(n) || []) if (!reach.has(a.to) || d + a.weight > reach.get(a.to)) reach.set(a.to, d + a.weight);
    }
    for (const [outName, outPort] of outputs) {
      if (outName === inName) continue;
      for (const b of bitsOf(outPort.bits)) if (reach.has(b)) note(summary.get(outName), inName, reach.get(b));
    }
  }
  // Outputs fed from registers, memories or nothing at all start fresh paths in the parent.
  const seqReach = new Set();
  for (const [b, label] of starts) if (!label.startsWith('port:')) seqReach.add(b);
  for (const n of order) if (seqReach.has(n)) for (const a of out.get(n) || []) seqReach.add(a.to);
  for (const [outName, outPort] of outputs) {
    const map = summary.get(outName);
    if (bitsOf(outPort.bits).some(b => isNet(b) && (seqReach.has(b) || (!depth.has(b) && !map.size)))) map.set(null, 0);
  }
  return summary;
}

export function analyzeCriticalPath(yosysJson, moduleName) {
  const modules = modulesOf(yosysJson);
  if (!modules) return emptyPath(null);
  const resolve = moduleResolver(modules);
  const name = (moduleName && resolve(String(moduleName))) || resolveTop(modules, null) || Object.keys(modules)[0] || null;
  if (!name || !modules[name]) return emptyPath(name);

  const summaries = new Map();
  const inProgress = new Set();
  const summaryOf = key => {
    if (summaries.has(key)) return summaries.get(key);
    if (inProgress.has(key) || !modules[key]) return null; // recursive hierarchy: fall back to a single stage
    inProgress.add(key);
    const s = moduleSummary(modules[key], resolve, summaryOf);
    inProgress.delete(key);
    summaries.set(key, s);
    return s;
  };

  const mod = modules[name];
  const { starts, ends, depth, pred, loopArcs, softStarts } = pathThrough(mod, resolve, summaryOf);
  const cellOrder = new Map(cellsOf(mod).map(([key], i) => [key, i]));
  const loopCells = [...new Set(loopArcs.map(a => a.cell))].sort((a, b) => (cellOrder.get(a) ?? 0) - (cellOrder.get(b) ?? 0));

  let best = null;
  for (const end of ends) {
    const d = depth.get(end.bit) ?? 0;
    if (!best || d > best.d) best = { ...end, d };
  }
  if (!best) {
    for (const [bit, d] of depth) if (!best || d > best.d) best = { bit, label: netLabel(mod, bit), d };
  }
  const result = emptyPath(name);
  result.hasCombLoop = loopCells.length > 0;
  result.loopCells = loopCells;
  if (!best) return result;

  const chain = [];
  let cur = best.bit, guard = 0;
  const nets = [cur];
  while (pred.has(cur) && guard++ < 100000) { const a = pred.get(cur); chain.push(a); cur = a.from; nets.push(cur); }
  chain.reverse();
  nets.reverse();
  let cum = 0;
  result.steps = chain.map(a => {
    cum += a.weight;
    const cell = mod.cells[a.cell];
    return { cell: a.cell, type: a.type, label: stepLabel(mod, a.cell, cell, resolve), weight: round(a.weight), cumDepth: round(cum), src: typeof cell?.attributes?.src === 'string' && cell.attributes.src ? cell.attributes.src : null };
  });
  result.cells = [];
  for (const s of result.steps) if (result.cells[result.cells.length - 1] !== s.cell) result.cells.push(s.cell);
  result.nets = [...new Set(nets)];
  result.gateCount = result.steps.length;
  result.depth = round(best.d);
  result.startpoint = starts.get(cur) || softStarts.get(cur) || netLabel(mod, cur);
  result.endpoint = best.label;
  return result;
}

// ---------------------------------------------------------------------------
// Human-readable names. Cell keys stay raw (the schematic highlights by key); labels never expose
// Icarus internals such as `$dff$mips_cpu.v:26$_ivl_67`.

const isCleanName = name => typeof name === 'string' && name !== '' && !name.includes('$') && !/(?:^|[._])_?ivl_/.test(name);

// Best user-visible net name for a group of bits: covers them all, exact width, not a port alias, short.
function netnameFor(mod, bits) {
  const want = bitsOf(bits).filter(isNet);
  if (!want.length) return null;
  const ports = mod?.ports || {};
  let best = null;
  for (const [name, net] of Object.entries(mod?.netnames || {})) {
    if (!isCleanName(name) || net?.hide_name === 1) continue;
    const nb = bitsOf(net?.bits);
    if (!nb.includes(want[0])) continue;
    const score = (want.every(b => nb.includes(b)) ? 8 : 0) + (nb.length === want.length ? 4 : 0) + (Object.prototype.hasOwnProperty.call(ports, name) ? 0 : 2) - name.length / 1000;
    if (!best || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

function srcLine(cell) {
  const src = typeof cell?.attributes?.src === 'string' ? cell.attributes.src.split('|')[0].replace(/^\/?work\//, '') : '';
  const m = /:(\d+)(?:\.\d+)?(?:-[\d.]+)?$/.exec(src);
  return m ? Number(m[1]) : null;
}

const shortType = type => String(type || 'cell').replace(/^\$paramod\\([^\\]+)\\.*$/, '$1').replace(/^\$+/, '').replace(/\$.*$/, '') || 'cell';

function outputBits(cell) {
  const conns = cell?.connections || {};
  for (const pin of ['Y', 'Q', 'RD_DATA0', 'DATA']) if (conns[pin]) return conns[pin];
  const out = Object.keys(conns).find(p => cell.port_directions?.[p] === 'output');
  return out ? conns[out] : [];
}

// Name used for sequential boundaries: `pc` for a register driving net `pc`, else `dff:26`.
function boundaryName(mod, key, cell) {
  if (isCleanName(key)) return key;
  const type = String(cell?.type || '');
  const net = isFlipFlop(type) || isLatch(type) || type === '$proc' || type.startsWith('$mem') ? netnameFor(mod, outputBits(cell)) : null;
  if (net) return net;
  const line = srcLine(cell);
  return line != null ? `${shortType(type)}:${line}` : shortType(type);
}

// Label for one step on the path: `u_alu (mips_alu)`, `mux (alu_b)` or `mux :21`.
function stepLabel(mod, key, cell, resolve) {
  const type = String(cell?.type || '');
  if (!key.startsWith('$') && (!type.startsWith('$') || resolve(type))) {
    const child = shortType(resolve(type) || type);
    return child && child !== key ? `${key} (${child})` : key;
  }
  const short = shortType(type);
  if (!key.startsWith('$') && isCleanName(key)) return key === short ? key : `${key} (${short})`;
  const net = netnameFor(mod, outputBits(cell));
  if (net) return `${short} (${net})`;
  const line = srcLine(cell);
  return line != null ? `${short} :${line}` : short;
}

function netLabel(mod, bit) {
  const name = netnameFor(mod, [bit]);
  return name ? `net:${name}` : `net:${bit}`;
}
