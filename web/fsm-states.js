// Symbolic FSM state names for waveform values, extracted from Verilog/SystemVerilog source.
// extractFsmStates(files) -> map; stateNameFor(map, 'tb.dut.state', '01', 2) -> 'FETCH' (or null).

const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/.*$/gm, '');

// Verilog literal or plain decimal -> BigInt (null for x/z or unsupported forms).
export function parseLiteral(text) {
  const t = String(text).trim().replace(/_/g, '');
  let match;
  if ((match = /^(\d+)?\s*'\s*[sS]?\s*([bBoOdDhH])\s*([0-9a-fA-F]+)$/.exec(t))) {
    const radix = { b: 2, o: 8, d: 10, h: 16 }[match[2].toLowerCase()];
    const digits = match[3].toLowerCase();
    if (radix === 10) return /^\d+$/.test(digits) ? BigInt(digits) : null;
    const prefix = { 2: '0b', 8: '0o', 16: '0x' }[radix];
    try { return BigInt(prefix + digits); } catch { return null; }
  }
  if (/^\d+$/.test(t)) return BigInt(t);
  return null;
}

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

const widthOfRange = range => {
  const match = /\[\s*(\d+)\s*:\s*(\d+)\s*\]/.exec(range || '');
  return match ? Math.abs(Number(match[1]) - Number(match[2])) + 1 : null;
};

// enum items "{ IDLE, FETCH = 2'd2, DECODE }" -> [[name, BigInt]]
function enumItems(body) {
  const items = [];
  let next = 0n;
  for (const item of splitTopLevel(body)) {
    const match = /^([A-Za-z_]\w*)\s*(?:=\s*(.+))?$/.exec(item);
    if (!match) continue;
    const value = match[2] === undefined ? next : parseLiteral(match[2]);
    if (value === null) continue;
    items.push([match[1], value]);
    next = value + 1n;
  }
  return items;
}

function analyzeModule(name, body) {
  const constants = new Map();      // NAME -> { value, group }
  const groups = [];                // [[name...]] per declaration statement
  const declared = new Map();       // signal -> width (null when unknown)
  const signals = new Map();        // signal -> Map(valueString -> stateName)
  const instances = new Map();      // instance -> module type
  const assign = (signal, pairs) => {
    if (!signals.has(signal)) signals.set(signal, new Map());
    const map = signals.get(signal);
    for (const [stateName, value] of pairs) if (!map.has(value.toString())) map.set(value.toString(), stateName);
  };

  // localparam / parameter statements (each statement is one group of related constants).
  for (const match of body.matchAll(/\b(?:localparam|parameter)\b([^;]*);/g)) {
    const group = [];
    const text = match[1].replace(/^\s*(?:(?:integer|signed|unsigned|logic|bit|reg|int)\b\s*)*(?:\[[^\]]*\]\s*)?/, '');
    for (const item of splitTopLevel(text)) {
      const decl = /^([A-Za-z_]\w*)\s*=\s*([\s\S]+)$/.exec(item);
      if (!decl) continue;
      let value = parseLiteral(decl[2]);
      if (value === null && constants.has(decl[2].trim())) value = constants.get(decl[2].trim()).value;
      if (value === null) continue;
      constants.set(decl[1], { value, group: groups.length });
      group.push(decl[1]);
    }
    if (group.length) groups.push(group);
  }

  // Declared signal widths.
  for (const match of body.matchAll(/\b(?:reg|wire|logic|bit|output\s+reg|output\s+logic|output|input)\b\s*(?:signed\s*)?(\[[^\]]*\])?\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*[;,)=]/g)) {
    for (const signal of match[2].split(',').map(part => part.trim())) if (!declared.has(signal)) declared.set(signal, widthOfRange(match[1]));
  }

  // SystemVerilog enums: typedef enum ... {...} type_t;  and  enum ... {...} a, b;
  const enumTypes = new Map();
  for (const match of body.matchAll(/\btypedef\s+enum\b[^{]*\{([^}]*)\}\s*([A-Za-z_]\w*)\s*;/g)) enumTypes.set(match[2], enumItems(match[1]));
  for (const match of body.matchAll(/(?<!typedef\s)\benum\b[^{]*\{([^}]*)\}\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)\s*;/g)) {
    const items = enumItems(match[1]);
    for (const signal of match[2].split(',').map(part => part.trim())) assign(signal, items);
  }
  for (const [type, items] of enumTypes) {
    for (const match of body.matchAll(new RegExp(`\\b${type}\\s+([A-Za-z_]\\w*(?:\\s*,\\s*[A-Za-z_]\\w*)*)\\s*;`, 'g'))) {
      for (const signal of match[1].split(',').map(part => part.trim())) assign(signal, items);
    }
  }
  for (const items of [...enumTypes.values()]) for (const [stateName, value] of items) if (!constants.has(stateName)) constants.set(stateName, { value, group: -1 });

  // case (sig) selectors whose arm labels are >= 2 constants of this module.
  const groupPairs = group => (group >= 0 ? groups[group] : []).map(constName => [constName, constants.get(constName).value]);
  for (const match of body.matchAll(/\bcase[zx]?\s*\(\s*([A-Za-z_]\w*)\s*\)([\s\S]*?)\bendcase\b/g)) {
    const [, selector, arms] = match;
    const used = new Set();
    for (const label of arms.matchAll(/([A-Za-z_]\w*)\s*(?=,|:(?!:))/g)) if (constants.has(label[1])) used.add(label[1]);
    if (used.size < 2) continue;
    const pairs = [];
    const seenGroups = new Set([...used].map(constName => constants.get(constName).group));
    for (const group of seenGroups) pairs.push(...(group >= 0 ? groupPairs(group) : [...used].map(constName => [constName, constants.get(constName).value])));
    assign(selector, pairs);
    // Registers loaded from the same constants (next_state = FETCH;) share the encoding.
    for (const assignment of body.matchAll(/\b([A-Za-z_]\w*)\s*<?=\s*([A-Za-z_]\w*)\s*;/g)) {
      if (used.has(assignment[2]) || pairs.some(([constName]) => constName === assignment[2])) assign(assignment[1], pairs);
    }
  }

  // Fallback: *state* signals in a module with >= 2 distinct constants that fit their width.
  for (const [signal, width] of declared) {
    if (signals.has(signal) || !/state/i.test(signal)) continue;
    const candidates = [...constants].filter(([constName, { value }]) => /^[A-Z][A-Z0-9_]*$/.test(constName) && (width === null || value < (1n << BigInt(width))));
    const distinct = new Set(candidates.map(([, { value }]) => value.toString()));
    if (distinct.size >= 2) assign(signal, candidates.map(([constName, { value }]) => [constName, value]));
  }

  // Instances: "type [#(...)] name (" (keywords excluded).
  const keywords = new Set(['module', 'if', 'else', 'case', 'casez', 'casex', 'for', 'while', 'always', 'assign', 'initial', 'begin', 'end', 'function', 'task', 'wire', 'reg', 'logic', 'input', 'output', 'inout', 'localparam', 'parameter', 'return', 'repeat', 'forever', 'generate', 'genvar', 'integer']);
  for (const match of body.matchAll(/\b([A-Za-z_]\w*)\s*(?:#\s*\((?:[^()]|\([^()]*\))*\)\s*)?([A-Za-z_]\w*)\s*\(/g)) {
    if (!keywords.has(match[1]) && !keywords.has(match[2]) && !match[1].startsWith('$')) instances.set(match[2], match[1]);
  }
  return { name, signals, instances };
}

// files: { path: text } (only Verilog sources are read).
export function extractFsmStates(files) {
  const modules = new Map();
  for (const [path, text] of Object.entries(files || {})) {
    if (!/\.(?:v|sv|vh|svh)$/i.test(path) || typeof text !== 'string') continue;
    for (const match of stripComments(text).matchAll(/\bmodule\s+([A-Za-z_]\w*)([\s\S]*?)\bendmodule\b/g)) {
      modules.set(match[1], analyzeModule(match[1], match[2]));
    }
  }
  return { modules, cache: new Map() };
}

// Encoding table for a waveform signal path, resolved through the instance hierarchy
// (tb.dut.state -> module of instance "dut" in tb), else an unambiguous leaf match.
export function stateMapFor(fsmMap, signalPath) {
  if (!fsmMap?.modules?.size) return null;
  if (fsmMap.cache.has(signalPath)) return fsmMap.cache.get(signalPath);
  const parts = signalPath.split('.');
  const leaf = parts.pop();
  let result = null;
  let module = fsmMap.modules.get(parts[0]);
  if (module) {
    for (const part of parts.slice(1)) {
      const type = module.instances.get(part);
      if (type && fsmMap.modules.has(type)) module = fsmMap.modules.get(type);
    }
    result = module.signals.get(leaf) || null;
  }
  if (!result) {
    const candidates = [...fsmMap.modules.values()].map(item => item.signals.get(leaf)).filter(Boolean);
    const unique = new Set(candidates.map(map => JSON.stringify([...map])));
    if (unique.size === 1) result = candidates[0];
  }
  fsmMap.cache.set(signalPath, result);
  return result;
}

export function stateNameFor(fsmMap, signalPath, rawBits) {
  if (rawBits === null || rawBits === undefined || /[xz]/i.test(rawBits)) return null;
  const map = stateMapFor(fsmMap, signalPath);
  if (!map) return null;
  return map.get(BigInt(`0b${rawBits || '0'}`).toString()) || null;
}
