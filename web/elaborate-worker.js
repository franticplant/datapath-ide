// RTL elaboration and schematic layout worker. Spawned lazily on the first Elaborate.
// Elaboration reuses the simulator's Icarus compiler: ivl synthesizes the design (synth, synth2)
// and the json.tgt target (engine/tgt-json.cc) writes Yosys-style JSON; elkjs lays it out.
// Everything loads from local URLs (./engine/, ./vendor/schematic/).

let elk = null;            // ELK instance
let elkPromise = null;     // in-flight loader so warm() + elaborate() share one load
let cache = null;          // { yosysJson, topModule }
let cachedKey = null;
let cachedReply = null;

function loadElk() {
  if (elk) return Promise.resolve(elk);
  if (!elkPromise) {
    elkPromise = import('./vendor/schematic/elk.js').then(({ default: ELK }) => {
      elk = new ELK();
      // elkjs detects that it runs inside a Worker and installs self.onmessage for its own
      // worker protocol; requests are handled by the listener below instead.
      if (typeof WorkerGlobalScope !== 'undefined') self.onmessage = null;
      return elk;
    });
  }
  return elkPromise;
}

function cacheKeyFor(data) {
  return JSON.stringify({
    topModule: data.topModule,
    standard: data.standard,
    flatten: Boolean(data.flatten),
    defines: data.defines || [],
    includeDirs: data.includeDirs || [],
    sources: (data.sourceFiles || []).map(path => [path, data.files?.[path] ?? '']),
  });
}

// ---------------------------------------------------------------- Icarus run

function populate(fs, files) {
  const dirs = new Set(['/work']);
  fs.mkdir('/work');
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== 'string' || !path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\r\n]/.test(path)) continue;
    let dir = '/work';
    for (const part of path.split('/').slice(0, -1)) {
      dir += `/${part}`;
      if (!dirs.has(dir)) { dirs.add(dir); try { fs.mkdir(dir); } catch { /* exists */ } }
    }
    fs.writeFile(`/work/${path}`, text);
  }
  return [...dirs];
}

export function ivlConfig({ topModule, standard }) {
  return [
    'basedir:/', 'module:system.vpi', 'module:v2005_math.vpi',
    `generation:${['2001', '2005', '2009', '2012'].includes(standard) ? standard : '2005'}`, 'generation:no-specify', 'warnings:n',
    'flag:DLL=json.tgt', 'flag:SCHEMATIC_NONFATAL=1',
    // syn-rules is left out on purpose: after synth2 it rewrites memory-writing processes into
    // a single whole-array flip-flop, which hides register-file writes.
    'functor:synth', 'functor:synth2', 'functor:cprop', 'functor:nodangle',
    `root:${topModule}`, 'out:/work/schematic.json', '',
  ].join('\n');
}

// Structured diagnostics from ivlpp/ivl output ("/work/a.v:5: warning: A latch has been inferred for 'q'.").
export function parseIvlLog(lines, compiled) {
  const items = [];
  const seen = new Set();
  for (const raw of lines) {
    const match = /^(?:\/work\/)?([^:\s][^:]*):(\d+):\s*(error|warning|sorry):\s*(.*)$/i.exec(raw.trim());
    if (!match) continue;
    const [, file, line, tag, message] = match;
    let severity = tag.toLowerCase() === 'error' ? 'error' : 'warning';
    // In schematic mode unsupported constructs are kept as behavioral blocks, so a successful
    // compile has no fatal errors left.
    if (compiled && severity === 'error') severity = 'warning';
    const kind = /latch has been inferred/i.test(message) ? 'latch'
      : /behavioral block|not synthesized|not currently supported/i.test(message) ? 'behavioral'
        : /no driver|undriven/i.test(message) ? 'undriven'
          : /combinational loop|logic loop/i.test(message) ? 'loop' : 'other';
    const key = `${file}:${line}:${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ file, line: Number(line), severity, kind, message: message.trim() });
  }
  return items;
}

// synth2 reports clocked array writes (regs[wa] <= wd) as unsupported and keeps the process
// behavioral, but json.tgt folds such processes into a $mem write port. Only blocks that really
// stayed behavioral become $proc cells, so the warnings for the other lines are false alarms.
export function dropModeledMemoryWrites(diagnostics, yosysJson) {
  const kept = new Set();
  for (const module of Object.values(yosysJson?.modules || {})) {
    for (const cell of Object.values(module.cells || {})) if (cell.type === '$proc' && cell.attributes?.src) kept.add(String(cell.attributes.src).replace(/^\/work\//, '').replace(/^(.*?:\d+).*$/, '$1'));
  }
  const memoryWrite = /Assignment to variable location in memory|Synchronous process kept as a behavioral block/i;
  const lines = new Set(diagnostics.filter(item => /Assignment to variable location in memory/i.test(item.message)).map(item => `${item.file}:${item.line}`));
  return diagnostics.filter(item => !(item.kind === 'behavioral' && memoryWrite.test(item.message) && lines.has(`${item.file}:${item.line}`) && !kept.has(`${item.file}:${item.line}`)));
}

export async function runIvlElaboration(request, loaders = {}) {
  const initPreprocessor = loaders.preprocessor || (await import('./engine/ivlpp.js')).default;
  const initCompiler = loaders.compiler || (await import('./engine/ivl.js')).default;
  const log = [];
  const options = () => ({ print: line => log.push(line), printErr: line => log.push(line) });
  const sources = (request.sourceFiles || []).filter(path => /\.(?:v|sv)$/i.test(path) && typeof request.files[path] === 'string');
  if (!sources.length) return { ok: false, diagnostics: [{ file: null, line: 0, severity: 'error', kind: 'other', message: 'No RTL source files to elaborate.' }], log: '' };
  const defines = (request.defines || []).filter(value => /^[A-Za-z_$][\w$]*(?:=[^\r\n]*)?$/.test(value));
  const includes = (request.includeDirs || []).filter(dir => dir === '.' || !/(?:^\/|\.\.)/.test(dir));

  const preprocessor = await initPreprocessor(options());
  const dirs = populate(preprocessor.FS, request.files);
  preprocessor.FS.writeFile('/pp.flags', [...defines.map(value => `D:${value}`), ...includes.map(dir => `I:/work${dir === '.' ? '' : `/${dir}`}`), ...dirs.map(dir => `I:${dir}`)].join('\n') + '\n');
  if (preprocessor.callMain(['-L', '-F/pp.flags', '-o/preprocessed.v', ...sources.map(path => `/work/${path}`)])) {
    return { ok: false, diagnostics: parseIvlLog(log, false).concat(log.length ? [] : [{ file: null, line: 0, severity: 'error', kind: 'other', message: 'Preprocessing failed.' }]), log: log.join('\n') };
  }
  const compiler = await initCompiler(options());
  compiler.FS.mkdir('/work');
  compiler.FS.writeFile('/preprocessed.v', preprocessor.FS.readFile('/preprocessed.v'));
  compiler.FS.writeFile('/config', ivlConfig(request));
  const code = compiler.callMain(['-C/config', '--', '/preprocessed.v']);
  const diagnostics = parseIvlLog(log, code === 0);
  if (code !== 0 || !compiler.FS.analyzePath('/work/schematic.json').exists) {
    if (!diagnostics.some(item => item.severity === 'error')) diagnostics.push({ file: null, line: 0, severity: 'error', kind: 'other', message: log.filter(Boolean).slice(-3).join(' ') || `Elaboration failed (exit ${code}).` });
    return { ok: false, diagnostics, log: log.join('\n') };
  }
  const yosysJson = JSON.parse(compiler.FS.readFile('/work/schematic.json', { encoding: 'utf8' }));
  return { ok: true, yosysJson, diagnostics: dropModeledMemoryWrites(diagnostics, yosysJson), log: log.join('\n') };
}

// Inline every submodule instance of `top` (bit ids are design-global, so wiring carries over).
export function flattenModule(yosysJson, top) {
  const modules = yosysJson.modules || {};
  const result = { ...modules[top], cells: {}, netnames: { ...(modules[top].netnames || {}) } };
  const inline = (module, prefix) => {
    for (const [name, cell] of Object.entries(module.cells || {})) {
      const child = modules[cell.type];
      const full = prefix ? `${prefix}.${name}` : name;
      if (child) {
        for (const [net, info] of Object.entries(child.netnames || {})) result.netnames[`${full}.${net}`] = { ...info, hide_name: 1 };
        inline(child, full);
      } else {
        result.cells[full] = cell;
      }
    }
  };
  inline(modules[top], '');
  return { ...yosysJson, modules: { ...modules, [top]: result } };
}

// ---------------------------------------------------------------- module JSON -> ELK graph

const OPERATORS = {
  $add: '+', $sub: '−', $mul: '×', $div: '÷', $mod: '%', $pow: '**', $neg: '−', $pos: '+',
  $eq: '==', $ne: '!=', $eqx: '===', $nex: '!==', $lt: '<', $le: '≤', $gt: '>', $ge: '≥',
  $shl: '<<', $shr: '>>', $sshl: '<<<', $sshr: '>>>', $shift: '>>', $shiftx: '>>',
  $logic_and: '&&', $logic_or: '||', $logic_not: '!',
  $reduce_and: '&', $reduce_or: '|', $reduce_xor: '^', $reduce_xnor: '~^', $reduce_bool: '|', $reduce_nand: '~&', $reduce_nor: '~|',
  $shiftx: '[ ]', $part: '[ ]=', $abs: '| |',
};
const GATES = { $and: '&', $or: '≥1', $xor: '=1', $xnor: '=', $not: '1', $nand: '&', $nor: '≥1', $buf: '1', $_AND_: '&', $_OR_: '≥1', $_XOR_: '=1', $_NOT_: '1' };

export function cellKind(type) {
  if (!type.startsWith('$')) return 'module';
  if (type.startsWith('$paramod')) return 'module';
  if (type === '$mux' || type === '$pmux' || type === '$bmux' || type === '$_MUX_') return 'mux';
  if (type === '$dlatch' || type === '$adlatch' || type === '$dlatchsr' || type.startsWith('$_DLATCH')) return 'latch';
  if (/dff/i.test(type)) return 'dff';
  if (type.startsWith('$mem')) return 'mem';
  if (Object.hasOwn(OPERATORS, type)) return 'op';
  if (Object.hasOwn(GATES, type)) return 'gate';
  return 'generic';
}

// "$paramod\\child\\W=..." and "$paramod$<hash>\\child" both name the module after the first backslash.
export const displayType = type => type.startsWith('$paramod') ? type.split('\\')[1] || type : type;

const SELECT_PINS = new Set(['S', 'EN', 'ARST', 'SRST', 'CLR', 'SET', 'R', 'E']);

function pinSide(kind, pin, direction) {
  if (direction === 'output') return 'EAST';
  if (kind === 'mux' && pin === 'S') return 'SOUTH';
  if ((kind === 'dff' || kind === 'latch') && SELECT_PINS.has(pin)) return 'SOUTH';
  return 'WEST';
}

const isConstBit = bit => typeof bit === 'string';
const constLabel = bits => {
  // Yosys lists bits LSB first.
  const msbFirst = [...bits].reverse().join('');
  if (/^[01]+$/.test(msbFirst)) {
    const value = BigInt(`0b${msbFirst}`);
    return bits.length === 1 ? `1'b${msbFirst}` : `${bits.length}'h${value.toString(16)}`;
  }
  return `${bits.length}'b${msbFirst}`;
};

// Best user-facing net name (and bit position) for each bit id.
function bitNames(module) {
  const map = new Map();
  const entries = Object.entries(module.netnames || {}).sort(([nameA, a], [nameB, b]) =>
    (a.hide_name || 0) - (b.hide_name || 0) || nameA.length - nameB.length);
  for (const [name, net] of entries) {
    net.bits.forEach((bit, index) => {
      if (!isConstBit(bit) && !map.has(bit)) map.set(bit, { name, index, width: net.bits.length, hidden: Boolean(net.hide_name) });
    });
  }
  return map;
}

function sliceFor(bits, names) {
  const first = names.get(bits[0]);
  if (!first) return null;
  for (let i = 0; i < bits.length; i++) {
    const entry = names.get(bits[i]);
    if (!entry || entry.name !== first.name || entry.index !== first.index + i) return { name: first.name, lo: first.index, hi: first.index, width: first.width, hidden: first.hidden, partial: true };
  }
  return { name: first.name, lo: first.index, hi: first.index + bits.length - 1, width: first.width, hidden: first.hidden };
}

function cellPorts(cell, kind, modules) {
  const directions = cell.port_directions || modules[cell.type]?.ports && Object.fromEntries(Object.entries(modules[cell.type].ports).map(([name, port]) => [name, port.direction])) || {};
  return Object.entries(cell.connections || {}).map(([pin, bits]) => ({
    pin, bits, direction: directions[pin] || 'input', side: pinSide(kind, pin, directions[pin] || 'input'),
  }));
}

const textWidth = (text, size = 7) => String(text).length * size;

// Converts one Yosys module into an ELK graph (and the metadata the renderer needs).
export function moduleGraph(yosysJson, moduleName) {
  const modules = yosysJson.modules || {};
  const module = modules[moduleName];
  if (!module) throw new Error(`Module ${moduleName} is not in the elaborated design`);
  const names = bitNames(module);
  const nodes = [];
  const drivers = new Map();   // bit -> { port, node }
  const sinks = [];            // { port, node, bits }

  for (const [name, port] of Object.entries(module.ports || {})) {
    const id = `port:${name}`;
    const width = port.bits.length;
    const input = port.direction === 'input';
    const label = width > 1 ? `${name} [${width - 1}:0]` : name;
    const pinId = `${id}.${input ? 'out' : 'in'}`;
    nodes.push({
      id, kind: 'port', direction: port.direction, name, label, width,
      w: Math.max(56, textWidth(label) + 26), h: 22,
      ports: [{ id: pinId, name: input ? 'out' : 'in', side: input ? 'EAST' : 'WEST', width }],
      layer: input ? 'FIRST' : port.direction === 'output' ? 'LAST' : 'NONE',
    });
    if (input || port.direction === 'inout') port.bits.forEach(bit => { if (!isConstBit(bit)) drivers.set(bit, { port: pinId, node: id }); });
    if (!input) sinks.push({ port: pinId, node: id, bits: port.bits });
  }

  for (const [name, cell] of Object.entries(module.cells || {})) {
    const id = `cell:${name}`;
    const kind = cellKind(cell.type);
    const ports = cellPorts(cell, kind, modules);
    const sideCount = side => ports.filter(port => port.side === side).length;
    const pinRows = Math.max(sideCount('WEST'), sideCount('EAST'), 1);
    const instance = cell.hide_name ? '' : name;
    const typeLabel = displayType(cell.type);
    // Boxes are wide enough for the longest west label plus the longest east label (8.5px mono),
    // and ports start below the title row (portTop) so labels never collide.
    const labelColumns = Math.max(...ports.filter(port => port.side === 'WEST').map(port => port.pin.length), 0)
      + Math.max(...ports.filter(port => port.side === 'EAST').map(port => port.pin.length), 0);
    const pinsWidth = labelColumns * 5.4 + 30;
    let w = 56, h = Math.max(40, pinRows * 18 + 14), portTop = 0;
    if (kind === 'module') {
      portTop = 26;
      w = Math.max(120, textWidth(`${instance} : ${typeLabel}`, 6.4) + 30, pinsWidth);
      h = Math.max(54, pinRows * 18 + portTop + 6);
    } else if (kind === 'dff' || kind === 'latch' || kind === 'mem' || kind === 'generic') {
      portTop = 20;
      const param = key => /^[01]+$/.test(cell.parameters?.[key] || '') ? parseInt(cell.parameters[key], 2) : '';
      const title = kind === 'mem' ? `${instance} ${param('SIZE')}×${param('WIDTH')}` : typeLabel;
      w = Math.max(72, textWidth(title, 6.4) + 24, pinsWidth);
      h = Math.max(56, pinRows * 18 + portTop + 6 + (ports.some(port => port.side === 'SOUTH') ? 10 : 0));
    } else if (kind === 'mux') {
      w = 44; h = Math.max(56, pinRows * 18 + 20);
    } else if (kind === 'op' || kind === 'gate') {
      w = 48; h = Math.max(40, pinRows * 18 + 8);
    }
    const src = String(cell.attributes?.src || '').split('|')[0] || null;
    nodes.push({
      id, kind, type: cell.type, typeLabel, name, instance, hidden: Boolean(cell.hide_name), src,
      glyph: OPERATORS[cell.type] || GATES[cell.type] || null,
      negated: ['$nand', '$nor', '$not', '$xnor', '$_NOT_'].includes(cell.type),
      params: cell.parameters ? Object.fromEntries(Object.entries(cell.parameters).map(([key, value]) => [key, /^[01]+$/.test(value) && value.length >= 32 ? parseInt(value, 2) : value])) : {},
      w, h, portTop,
      ports: ports.map(port => ({ id: `${id}.${port.pin}`, name: port.pin, side: port.side, width: port.bits.length, clock: /^(CLK|C)$/.test(port.pin) && (kind === 'dff' || kind === 'mem') })),
    });
    for (const port of ports) {
      const pinId = `${id}.${port.pin}`;
      if (port.direction === 'output') port.bits.forEach(bit => { if (!isConstBit(bit)) drivers.set(bit, { port: pinId, node: id }); });
      else sinks.push({ port: pinId, node: id, bits: port.bits });
    }
  }

  // One edge per (driver pin, sink pin) pair, carrying every bit between them as a single bus.
  const edges = [];
  for (const sink of sinks) {
    const groups = new Map();
    const constants = [];
    for (const bit of sink.bits) {
      if (isConstBit(bit)) { constants.push(bit); continue; }
      const driver = drivers.get(bit);
      if (!driver || driver.node === sink.node && sink.node.startsWith('port:')) continue;
      if (!groups.has(driver.port)) groups.set(driver.port, []);
      groups.get(driver.port).push(bit);
    }
    for (const [from, bits] of groups) {
      edges.push({ id: `e${edges.length}`, from, to: sink.port, width: bits.length, bits, slice: sliceFor(bits, names) });
    }
    if (constants.length && constants.length === sink.bits.length) {
      const id = `const:${sink.port}`;
      const label = constLabel(constants);
      nodes.push({ id, kind: 'const', label, w: Math.max(34, textWidth(label) + 14), h: 18, ports: [{ id: `${id}.out`, name: 'out', side: 'EAST', width: constants.length }] });
      edges.push({ id: `e${edges.length}`, from: `${id}.out`, to: sink.port, width: constants.length, bits: constants, slice: null, constant: label });
    }
  }
  return { module: moduleName, nodes, edges };
}

export async function layoutGraph(graph) {
  const engine = await loadElk();
  const elkGraph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.spacing.nodeNodeBetweenLayers': '46',
      'elk.spacing.nodeNode': '28',
      'elk.spacing.edgeEdge': '8',
      'elk.layered.spacing.edgeNodeBetweenLayers': '16',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.padding': '[top=20,left=20,bottom=20,right=20]',
    },
    children: graph.nodes.map(node => ({
      id: node.id, width: node.w, height: node.h,
      layoutOptions: {
        'elk.portConstraints': 'FIXED_SIDE',
        ...(node.portTop ? { 'elk.spacing.portsSurrounding': `[top=${node.portTop},left=0,bottom=6,right=0]` } : {}),
        ...(node.layer && node.layer !== 'NONE' ? { 'elk.layered.layering.layerConstraint': node.layer } : {}),
      },
      ports: node.ports.map(port => ({ id: port.id, width: 1, height: 1, layoutOptions: { 'elk.port.side': port.side } })),
    })),
    edges: graph.edges.map(edge => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })),
  };
  const laid = await engine.layout(elkGraph);
  const placed = new Map(laid.children.map(child => [child.id, child]));
  const nodes = graph.nodes.map(node => {
    const child = placed.get(node.id);
    const portPlaces = new Map((child.ports || []).map(port => [port.id, port]));
    return {
      ...node, x: child.x, y: child.y, w: child.width, h: child.height,
      ports: node.ports.map(port => ({ ...port, x: portPlaces.get(port.id)?.x ?? 0, y: portPlaces.get(port.id)?.y ?? 0 })),
    };
  });
  const routes = new Map((laid.edges || []).map(edge => [edge.id, edge]));
  const edges = graph.edges.map(edge => {
    const section = routes.get(edge.id)?.sections?.[0];
    const points = section ? [section.startPoint, ...(section.bendPoints || []), section.endPoint].map(point => [point.x, point.y]) : [];
    return { ...edge, points };
  });
  return { module: graph.module, width: laid.width, height: laid.height, nodes, edges };
}

// Modules a user can drill into (instantiated or top), in definition order.
function moduleList(yosysJson) {
  return Object.entries(yosysJson.modules || {}).map(([name, module]) => ({
    name, label: displayType(name), top: module.attributes?.top === '00000000000000000000000000000001' || module.attributes?.top === 1,
    cells: Object.keys(module.cells || {}).length,
  }));
}

// Guarded so the helpers above can also be imported outside a worker (Node checks).
if (typeof WorkerGlobalScope !== 'undefined') self.addEventListener('message', async ({ data }) => {
  const { requestId } = data;
  const started = performance.now();
  try {
    if (data.type === 'warm') {
      await Promise.all([loadElk(), import('./engine/ivlpp.js'), import('./engine/ivl.js')]);
      self.postMessage({ type: 'warmed', requestId });
    } else if (data.type === 'elaborate') {
      if (!/^[A-Za-z_][\w$]*$/.test(data.topModule || '')) throw new Error('Choose a top module to elaborate.');
      const key = cacheKeyFor(data);
      if (cachedReply && cachedKey === key) {
        self.postMessage({ ...cachedReply, requestId, elapsedMs: 0 });
        return;
      }
      const elkLoad = loadElk();
      self.postMessage({ type: 'progress', requestId, phase: 'Synthesizing RTL…' });
      const result = await runIvlElaboration(data);
      if (!result.ok) {
        cache = null;
        cachedKey = null;
        cachedReply = null;
        self.postMessage({ type: 'elaborate-failed', requestId, diagnostics: result.diagnostics, log: result.log, elapsedMs: Math.round(performance.now() - started) });
        return;
      }
      if (!elk) self.postMessage({ type: 'progress', requestId, phase: 'Loading layout engine…' });
      await elkLoad;
      self.postMessage({ type: 'progress', requestId, phase: 'Laying out schematic…' });
      const design = data.flatten ? flattenModule(result.yosysJson, data.topModule) : result.yosysJson;
      cache = { yosysJson: design, topModule: data.topModule };
      const graph = await layoutGraph(moduleGraph(design, data.topModule));
      const reply = { type: 'elaborated', topModule: data.topModule, modules: moduleList(design), yosysJson: design, graph, diagnostics: result.diagnostics };
      cachedKey = key;
      cachedReply = reply;
      self.postMessage({ ...reply, requestId, elapsedMs: Math.round(performance.now() - started) });
    } else if (data.type === 'layout') {
      if (!cache) throw new Error('Elaborate the design first.');
      const graph = await layoutGraph(moduleGraph(cache.yosysJson, data.moduleName));
      self.postMessage({ type: 'laid-out', requestId, moduleName: data.moduleName, graph, elapsedMs: Math.round(performance.now() - started) });
    }
  } catch (error) {
    self.postMessage({ type: 'error', requestId, message: error?.message || String(error) });
  }
});
