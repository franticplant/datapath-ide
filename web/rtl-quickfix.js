// Pure RTL editor helpers: lint quick fixes, per-file symbols and instantiation templates.
import { maskVerilog } from './verilog-lex.js';
import { formatVerilog, tokenizeVerilog, verilogBlocks } from './verilog-format.js';

const IDENT = /^[A-Za-z_][\w$]*$|^\\\S+$/;
const KEYWORDS = new Set(['module', 'macromodule', 'endmodule', 'input', 'output', 'inout', 'wire', 'reg', 'logic', 'integer', 'genvar',
  'parameter', 'localparam', 'signed', 'unsigned', 'begin', 'end', 'if', 'else', 'case', 'casex', 'casez', 'endcase', 'default', 'always',
  'always_ff', 'always_comb', 'always_latch', 'initial', 'assign', 'function', 'endfunction', 'task', 'endtask', 'for', 'while', 'repeat',
  'forever', 'posedge', 'negedge', 'or', 'and', 'not', 'generate', 'endgenerate', 'tri', 'wand', 'wor', 'supply0', 'supply1', 'var', 'bit',
  'byte', 'int', 'shortint', 'longint', 'real', 'realtime', 'time', 'automatic', 'static', 'fork', 'join', 'join_any', 'join_none', 'unique',
  'priority', 'wait', 'disable', 'event', 'specparam', 'type']);
const DIRECTIONS = new Set(['input', 'output', 'inout']);
const NET_TYPES = new Set(['wire', 'reg', 'logic', 'tri', 'wand', 'wor', 'supply0', 'supply1', 'var', 'integer', 'bit', 'byte', 'int',
  'shortint', 'longint', 'real', 'realtime', 'time']);
const SYMBOL_KIND = { reg: 'reg', wire: 'wire', logic: 'logic', tri: 'wire', wand: 'wire', wor: 'wire', supply0: 'wire', supply1: 'wire' };
const OPENERS = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const isIdent = t => IDENT.test(t) && !KEYWORDS.has(t);

// ---------------------------------------------------------------------------------------------------------------
// Quick fixes

function splitLines(source) { return source.split('\n').map(line => line.replace(/\r$/, '')); }

// Names quoted in backticks inside a lint message (`q`, `alu_op`), ignoring operators such as `=`.
function namesFromMessage(message) {
  return [...String(message || '').matchAll(/`([^`]+)`/g)].map(m => m[1]).filter(n => /^[A-Za-z_][\w$]*$/.test(n) && !KEYWORDS.has(n));
}

// Paren depth before each column of a masked line.
function depthMap(masked) {
  const depth = [];
  let d = 0;
  for (let i = 0; i < masked.length; i++) {
    const c = masked[i];
    if (c === ')' || c === ']' || c === '}') d = Math.max(0, d - 1);
    depth.push(d);
    if (c === '(' || c === '[' || c === '{') d++;
  }
  return depth;
}

// Walk back from `at` over whitespace and `[..]` selects to the assignment target; returns { start, names }.
function lhsBefore(masked, at) {
  let i = at - 1;
  const skipWs = () => { while (i >= 0 && /\s/.test(masked[i])) i--; };
  skipWs();
  while (i >= 0 && masked[i] === ']') {
    let d = 0;
    for (; i >= 0; i--) { if (masked[i] === ']') d++; else if (masked[i] === '[' && --d === 0) { i--; break; } }
    skipWs();
  }
  if (i >= 0 && masked[i] === '}') {
    let d = 0; const end = i;
    for (; i >= 0; i--) { if (masked[i] === '}') d++; else if (masked[i] === '{' && --d === 0) break; }
    if (i < 0) return null;
    const names = [...masked.slice(i, end + 1).matchAll(/[A-Za-z_][\w$]*/g)].map(m => m[0]).filter(n => !KEYWORDS.has(n));
    return { start: i, names };
  }
  const end = i + 1;
  while (i >= 0 && /[\w$.]/.test(masked[i])) i--;
  const text = masked.slice(i + 1, end);
  if (!/^[A-Za-z_]/.test(text) || KEYWORDS.has(text)) return null;
  return { start: i + 1, names: [text.split('.')[0]] };
}

// True when the text before an assignment target ends a statement prefix (`;`, `)`, label `:`, begin/else...).
function boundaryBefore(masked, start) {
  const before = masked.slice(0, start).replace(/\s+$/, '');
  return !before || /[;):*]$/.test(before) || /(?:^|[^\w$])(?:begin|else|end|fork)$/.test(before) || /#\s*[\w.]+$/.test(before);
}

function assignmentOps(masked, kind) {
  const depth = depthMap(masked);
  const found = [];
  for (let i = 0; i < masked.length; i++) {
    if (masked[i] !== '=' || depth[i] !== 0) continue;
    const prev = masked[i - 1] || '';
    const next = masked[i + 1] || '';
    if (next === '=') { i++; continue; }
    if (kind === 'blocking' && /[=!<>+\-*/%&|^~:]/.test(prev)) continue;
    if (kind === 'nonblocking' && (prev !== '<' || /[<=!>]/.test(masked[i - 2] || ''))) continue;
    const opStart = kind === 'nonblocking' ? i - 1 : i;
    const lhs = lhsBefore(masked, opStart);
    if (!lhs || !boundaryBefore(masked, lhs.start)) continue;
    found.push({ start: opStart, end: i + 1, names: lhs.names });
  }
  return found;
}

function swapOperator(source, diagnostic, kind, replacement) {
  const line = Number(diagnostic.line);
  const lines = splitLines(source);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  const masked = splitLines(maskVerilog(source))[line - 1];
  const ops = assignmentOps(masked, kind);
  if (!ops.length) return null;
  const wanted = namesFromMessage(diagnostic.message);
  let chosen = wanted.length ? ops.filter(op => op.names.some(n => wanted.includes(n))) : [];
  if (!chosen.length) chosen = [ops[0]];
  let text = lines[line - 1];
  for (const op of [...chosen].reverse()) text = text.slice(0, op.start) + replacement + text.slice(op.end);
  const names = [...new Set(chosen.flatMap(op => op.names))];
  return { names, text, line };
}

function caseDefaultFix(source, diagnostic) {
  const line = Number(diagnostic.line);
  const lines = splitLines(source);
  if (!Number.isInteger(line) || line < 1 || line > lines.length) return null;
  const tokens = tokenizeVerilog(source);
  const isCase = t => t.t === 'case' || t.t === 'casex' || t.t === 'casez';
  // The case keyword on the diagnostic line, else the nearest one within a few lines.
  let at = -1;
  let best = Infinity;
  tokens.forEach((t, i) => {
    if (!isCase(t)) return;
    const distance = Math.abs(t.line - (line - 1)) + (t.line < line - 1 ? 0.5 : 0);
    if (distance < best && distance <= 3) { best = distance; at = i; }
  });
  if (at < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = at; i < tokens.length; i++) {
    if (isCase(tokens[i])) depth++;
    else if (tokens[i].t === 'endcase' && --depth === 0) { end = i; break; }
    else if (tokens[i].t === 'endmodule') break;
  }
  if (end < 0) return null;
  // Skip the `(selector)` header.
  let body = at + 1;
  if (tokens[body]?.t === '(') {
    let d = 0;
    for (; body < end; body++) { if (tokens[body].t === '(') d++; else if (tokens[body].t === ')' && --d === 0) { body++; break; } }
  }
  const maskedLines = splitLines(maskVerilog(source));
  const targets = [];
  const ops = new Map();
  for (let l = tokens[body]?.line ?? tokens[end].line; l <= tokens[end].line; l++) {
    let masked = maskedLines[l];
    // Restrict to the case body on the header/endcase lines.
    const from = l === tokens[at].line ? (tokens[body]?.line === l ? tokens[body].pos : masked.length) : 0;
    const to = l === tokens[end].line ? tokens[end].pos : masked.length;
    masked = ' '.repeat(from) + masked.slice(from, to);
    for (const kind of ['blocking', 'nonblocking']) {
      for (const op of assignmentOps(masked, kind)) {
        for (const name of op.names) {
          if (!ops.has(name)) { targets.push(name); ops.set(name, kind === 'blocking' ? '=' : '<='); }
        }
      }
    }
  }
  const wanted = namesFromMessage(diagnostic.message).filter(n => targets.includes(n));
  const names = wanted.length ? wanted : targets;
  const lead = l => (lines[l].match(/^[ \t]*/) || [''])[0];
  const caseLine = tokens[at].line;
  const caseIndent = lead(caseLine);
  const firstLabel = tokens[body];
  const firstOnLine = firstLabel && firstLabel.line !== caseLine && firstLabel.line <= tokens[end].line
    && !maskedLines[firstLabel.line].slice(0, firstLabel.pos).trim();
  let labelIndent = firstOnLine && firstLabel.line !== tokens[end].line ? lead(firstLabel.line) : null;
  const step = labelIndent != null && labelIndent.length > caseIndent.length ? labelIndent.length - caseIndent.length : 2;
  if (labelIndent == null) labelIndent = caseIndent + ' '.repeat(step);
  const inner = labelIndent + ' '.repeat(step);
  const assign = n => `${n} ${ops.get(n)} 0;`;
  const endLine = tokens[end].line;
  const endcaseFirst = !maskedLines[endLine].slice(0, tokens[end].pos).trim();
  let text;
  if (endcaseFirst) {
    const block = names.length === 0 ? [`${labelIndent}default: ;`]
      : names.length === 1 ? [`${labelIndent}default: ${assign(names[0])}`]
        : [`${labelIndent}default: begin`, ...names.map(n => inner + assign(n)), `${labelIndent}end`];
    text = [...block, lines[endLine]].join('\n');
  } else {
    const inline = names.length === 0 ? 'default: ;' : names.length === 1 ? `default: ${assign(names[0])}` : `default: begin ${names.map(assign).join(' ')} end`;
    const original = lines[endLine];
    const pos = tokens[end].pos;
    const gap = /\s$/.test(original.slice(0, pos)) ? '' : ' ';
    text = `${original.slice(0, pos)}${gap}${inline} ${original.slice(pos)}`;
  }
  return { names, text, line: endLine + 1 };
}

const tick = names => names.map(n => `\`${n}\``).join(', ');

export function computeQuickFix(source, diagnostic) {
  if (typeof source !== 'string' || !diagnostic || typeof diagnostic !== 'object') return null;
  const rule = diagnostic.rule;
  if (rule === 'BLKSEQ') {
    const r = swapOperator(source, diagnostic, 'blocking', '<=');
    return r && { title: `Use non-blocking \`<=\` for ${tick(r.names)}`, rule, edits: [{ fromLine: r.line, toLine: r.line, text: r.text }] };
  }
  if (rule === 'NONBLK') {
    const r = swapOperator(source, diagnostic, 'nonblocking', '=');
    return r && { title: `Use blocking \`=\` for ${tick(r.names)}`, rule, edits: [{ fromLine: r.line, toLine: r.line, text: r.text }] };
  }
  if (rule === 'INCOMPLETE_CASE') {
    const r = caseDefaultFix(source, diagnostic);
    return r && {
      title: r.names.length ? `Add \`default:\` branch assigning ${tick(r.names)}` : 'Add empty `default:` branch',
      rule, edits: [{ fromLine: r.line, toLine: r.line, text: r.text }],
    };
  }
  return null;
}

export function applyQuickFix(source, fix) {
  if (typeof source !== 'string' || !fix || !Array.isArray(fix.edits) || !fix.edits.length) return source;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const lines = source.split(/\r?\n/);
  const edits = fix.edits
    .filter(e => Number.isInteger(e?.fromLine) && Number.isInteger(e?.toLine) && e.fromLine >= 1 && e.toLine >= e.fromLine - 1 && e.fromLine <= lines.length + 1)
    .sort((a, b) => b.fromLine - a.fromLine);
  for (const e of edits) {
    const count = Math.max(0, Math.min(e.toLine, lines.length) - e.fromLine + 1);
    lines.splice(e.fromLine - 1, count, ...String(e.text ?? '').split(/\r?\n/));
  }
  return lines.join(eol);
}

// ---------------------------------------------------------------------------------------------------------------
// Module / symbol scanning

function tokenText(source, tokens, from, to) {
  // Source text spanning tokens[from..to) on one line, else the tokens joined by spaces.
  if (from >= to) return '';
  const a = tokens[from];
  const b = tokens[to - 1];
  if (a.line === b.line) return source.split('\n')[a.line].slice(a.pos, b.pos + b.t.length).replace(/\s+/g, ' ').trim();
  return tokens.slice(from, to).map(t => t.t).join(' ');
}

function matchClose(tokens, i, limit = tokens.length) {
  let d = 0;
  for (let k = i; k < limit; k++) {
    if (OPENERS[tokens[k].t]) d++;
    else if (CLOSERS.has(tokens[k].t) && --d === 0) return k;
  }
  return limit;
}

// Split tokens[from..to) at top-level commas.
function splitTop(tokens, from, to) {
  const parts = [];
  let d = 0;
  let s = from;
  for (let k = from; k < to; k++) {
    const t = tokens[k].t;
    if (OPENERS[t]) d++;
    else if (CLOSERS.has(t)) d--;
    else if (t === ',' && d === 0) { parts.push([s, k]); s = k + 1; }
  }
  if (s < to) parts.push([s, to]);
  return parts;
}

// Tiny constant evaluator for widths: integers, sized literals, parameters and + - * / % ** << >> ( ).
function evalExpr(tokens, params) {
  let i = 0;
  const peek = () => tokens[i]?.t;
  const primary = () => {
    const t = tokens[i++]?.t;
    if (t == null) throw new Error('eof');
    if (t === '(') { const v = expr(); if (tokens[i++]?.t !== ')') throw new Error(')'); return v; }
    if (t === '-') return -primary();
    if (t === '+') return primary();
    if (t === '$clog2' && peek() === '(') { i++; const v = expr(); i++; return v <= 1 ? 0 : Math.ceil(Math.log2(v)); }
    const sized = /^(?:\d[\d_]*)?\s*'[sS]?([bBoOdDhH])\s*([\w?]+)$/.exec(t);
    if (sized) {
      const radix = { b: 2, o: 8, d: 10, h: 16 }[sized[1].toLowerCase()];
      const v = parseInt(sized[2].replace(/_/g, ''), radix);
      if (Number.isNaN(v)) throw new Error('nan');
      return v;
    }
    if (/^\d[\d_]*$/.test(t)) return Number(t.replace(/_/g, ''));
    if (params.has(t)) return params.get(t);
    throw new Error(`unknown ${t}`);
  };
  const power = () => { let v = primary(); while (peek() === '*' && tokens[i + 1]?.t === '*') { i += 2; v **= primary(); } return v; };
  const term = () => {
    let v = power();
    for (;;) {
      const t = peek();
      if (t === '*' && tokens[i + 1]?.t !== '*') { i++; v *= power(); } else if (t === '/') { i++; v = Math.trunc(v / power()); } else if (t === '%') { i++; v %= power(); } else return v;
    }
  };
  const sum = () => { let v = term(); for (;;) { const t = peek(); if (t === '+') { i++; v += term(); } else if (t === '-') { i++; v -= term(); } else return v; } };
  const expr = () => {
    let v = sum();
    for (;;) {
      if (peek() === '<' && tokens[i + 1]?.t === '<') { i += 2; v *= 2 ** sum(); } else if (peek() === '>' && tokens[i + 1]?.t === '>') { i += 2; v = Math.floor(v / 2 ** sum()); } else return v;
    }
  };
  try { const v = expr(); return i === tokens.length && Number.isFinite(v) ? v : null; } catch { return null; }
}

function rangeWidth(tokens, from, to, params) {
  // tokens[from] is '[' and tokens[to - 1] is ']'.
  const inner = tokens.slice(from + 1, to - 1);
  let d = 0;
  const colon = inner.findIndex(t => { if (OPENERS[t.t]) d++; else if (CLOSERS.has(t.t)) d--; return t.t === ':' && d === 0; });
  if (colon < 0) return null;
  const msb = evalExpr(inner.slice(0, colon), params);
  const lsb = evalExpr(inner.slice(colon + 1), params);
  return msb == null || lsb == null ? null : Math.abs(msb - lsb) + 1;
}

// Parse one declaration element list (tokens[from..to)), e.g. `input wire [7:0] a, b` or `localparam A = 1, B = 2`.
// `carry` holds the direction/type/range inherited across ANSI port-list elements.
function parseDeclarators(source, tokens, from, to, params, carry = null) {
  const out = [];
  let state = carry ? { ...carry } : { keyword: null, direction: null, type: null, signed: false, range: null, width: null };
  for (const [s, e] of splitTop(tokens, from, to)) {
    let k = s;
    let restarted = false;
    while (k < e) {
      const t = tokens[k].t;
      if (DIRECTIONS.has(t)) { state = { keyword: t, direction: t, type: null, signed: false, range: null, width: null }; restarted = true; k++; continue; }
      if (t === 'parameter' || t === 'localparam') { state = { keyword: t, direction: null, type: null, signed: false, range: null, width: null }; restarted = true; k++; continue; }
      if (NET_TYPES.has(t)) {
        if (!restarted && !state.direction && !(state.keyword === 'parameter' || state.keyword === 'localparam')) state = { keyword: t, direction: null, type: null, signed: false, range: null, width: null };
        state.type = t; restarted = true; k++; continue;
      }
      if (t === 'signed' || t === 'unsigned') { state.signed = t === 'signed'; k++; continue; }
      if (t === '[') {
        const close = Math.min(matchClose(tokens, k, e), e - 1);
        state.range = tokenText(source, tokens, k, close + 1);
        state.width = rangeWidth(tokens, k, close + 1, params);
        restarted = true;
        k = close + 1;
        continue;
      }
      break;
    }
    // The declared name; the last identifier before `=` handles SV forms like `parameter int W = 8`.
    let nameAt = -1;
    let eq = e;
    for (let j = k; j < e; j++) {
      const t = tokens[j].t;
      if (t === '=') { eq = j; break; }
      if (OPENERS[t]) { if (nameAt >= 0) break; j = matchClose(tokens, j, e); continue; }
      if (IDENT.test(t) && !KEYWORDS.has(t)) nameAt = j;
    }
    if (nameAt < 0) continue;
    const unpacked = [];
    for (let j = nameAt + 1; j < eq; j++) {
      if (tokens[j].t === '[') { const c = Math.min(matchClose(tokens, j, eq), eq - 1); unpacked.push(tokenText(source, tokens, j, c + 1)); j = c; }
    }
    const value = eq < e ? tokenText(source, tokens, eq + 1, e) : null;
    out.push({ ...state, name: tokens[nameAt].t, line: tokens[nameAt].line + 1, array: unpacked.join(''), value, valueTokens: eq < e ? tokens.slice(eq + 1, e) : [] });
  }
  return { decls: out, carry: state };
}

function declDetail(d) {
  const parts = [d.direction || d.keyword];
  if (d.type && d.type !== d.keyword) parts.push(d.type);
  if (d.signed) parts.push('signed');
  if (d.range) parts.push(d.range);
  parts.push(d.name + (d.array ? ` ${d.array}` : ''));
  return parts.filter(Boolean).join(' ') + (d.value != null ? ` = ${d.value}` : '');
}

// Scan a file into modules (with params and ordered ports) and a flat symbol list.
function scanFile(source) {
  const text = String(source ?? '').replace(/\r\n?/g, '\n');
  const tokens = tokenizeVerilog(text);
  const blocks = verilogBlocks(text);
  const usedBlocks = new Set();
  const blockEnd = (keyword, line) => {
    const idx = blocks.findIndex((b, i) => !usedBlocks.has(i) && b.line === line && (b.keyword === keyword));
    if (idx < 0) return undefined;
    usedBlocks.add(idx);
    return blocks[idx].endLine;
  };
  const symbols = [];
  const modules = [];
  let mod = null;
  let sub = null;
  let start = true;
  for (let i = 0; i < tokens.length;) {
    const tok = tokens[i];
    const t = tok.t;
    if ((t === 'module' || t === 'macromodule') && start) {
      let k = i + 1;
      while (tokens[k] && (tokens[k].t === 'automatic' || tokens[k].t === 'static')) k++;
      const nameTok = tokens[k];
      if (!nameTok || !isIdent(nameTok.t)) { i++; continue; }
      k++;
      mod = { name: nameTok.t, line: tok.line + 1, endLine: blockEnd(t, tok.line + 1), params: [], ports: [], ansi: false, paramMap: new Map() };
      modules.push(mod);
      const modSymbol = { name: mod.name, kind: 'module', line: mod.line, endLine: mod.endLine, detail: '', scope: '' };
      symbols.push(modSymbol);
      const addParam = d => {
        const v = evalExpr(d.valueTokens, mod.paramMap);
        if (v != null) mod.paramMap.set(d.name, v);
        mod.params.push({ name: d.name, value: d.value, local: d.keyword === 'localparam', literal: d.valueTokens.every(x => !isIdent(x.t)) });
        symbols.push({ name: d.name, kind: 'param', line: d.line, detail: declDetail({ ...d, keyword: d.keyword || 'parameter' }), scope: mod.name, ...(d.width != null ? { width: d.width } : {}), value: d.value });
      };
      while (tokens[k] && tokens[k].t === 'import') { while (tokens[k] && tokens[k].t !== ';') k++; k++; }
      if (tokens[k]?.t === '#' && tokens[k + 1]?.t === '(') {
        const close = matchClose(tokens, k + 1);
        const { decls } = parseDeclarators(text, tokens, k + 2, close, mod.paramMap, { keyword: 'parameter', direction: null, type: null, signed: false, range: null, width: null });
        decls.forEach(addParam);
        k = close + 1;
      }
      if (tokens[k]?.t === '(') {
        const close = matchClose(tokens, k);
        mod.ansi = tokens.slice(k + 1, close).some(x => DIRECTIONS.has(x.t));
        if (mod.ansi) {
          const { decls } = parseDeclarators(text, tokens, k + 1, close, mod.paramMap, { keyword: 'input', direction: 'input', type: null, signed: false, range: null, width: null });
          for (const d of decls) {
            const port = { name: d.name, direction: d.direction, type: d.type, range: d.range, width: d.width ?? (d.range ? null : 1), line: d.line };
            mod.ports.push(port);
            symbols.push({ name: d.name, kind: 'port', line: d.line, detail: declDetail(d), scope: mod.name, direction: d.direction, ...(port.width != null ? { width: port.width } : {}) });
          }
        } else {
          for (const [s, e] of splitTop(tokens, k + 1, close)) {
            const id = tokens.slice(s, e).find(x => isIdent(x.t));
            if (id) mod.ports.push({ name: id.t, direction: null, type: null, range: null, width: null, line: id.line + 1 });
          }
        }
        k = close + 1;
      }
      while (tokens[k] && tokens[k].t !== ';') k++;
      modSymbol.detail = `module ${mod.name}(${mod.ports.map(p => p.name).join(', ')})`;
      modSymbol.addParam = addParam;
      mod.symbol = modSymbol;
      i = k + 1;
      start = true;
      continue;
    }
    if (t === 'endmodule') { mod = null; sub = null; i++; start = true; continue; }
    if (mod && start && (t === 'function' || t === 'task')) {
      let k = i + 1;
      let nameAt = -1;
      for (; k < tokens.length && tokens[k].t !== ';' && tokens[k].t !== '('; k++) {
        if (tokens[k].t === '[') { k = matchClose(tokens, k); continue; }
        if (isIdent(tokens[k].t)) nameAt = k;
      }
      if (nameAt >= 0) {
        const name = tokens[nameAt].t;
        symbols.push({ name, kind: t, line: tok.line + 1, endLine: blockEnd(t, tok.line + 1), detail: tokenText(text, tokens, i, nameAt + 1), scope: mod.name });
        sub = name;
      }
      if (tokens[k]?.t === '(') k = matchClose(tokens, k) + 1;
      while (k < tokens.length && tokens[k].t !== ';') k++;
      i = k + 1;
      start = true;
      continue;
    }
    if (t === 'endfunction' || t === 'endtask') { sub = null; i++; start = true; if (tokens[i]?.t === ':') i += 2; continue; }
    if (mod && start && /^always(?:_ff|_comb|_latch)?$/.test(t)) {
      let k = i + 1;
      if (tokens[k]?.t === '@') {
        k++;
        if (tokens[k]?.t === '(') k = matchClose(tokens, k) + 1; else k++;
      }
      const header = tokenText(text, tokens, i, k).replace(/@\s+/, '@').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')');
      symbols.push({ name: header, kind: 'always', line: tok.line + 1, endLine: blockEnd(t, tok.line + 1), detail: header, scope: sub ? `${mod.name}.${sub}` : mod.name });
      i = k;
      start = true;
      continue;
    }
    if (mod && start && (DIRECTIONS.has(t) || NET_TYPES.has(t) || t === 'parameter' || t === 'localparam' || t === 'genvar')) {
      let k = i;
      let d = 0;
      for (; k < tokens.length; k++) {
        const x = tokens[k].t;
        if (OPENERS[x]) d++; else if (CLOSERS.has(x)) d--; else if (x === ';' && d <= 0) break;
        if (x === 'endmodule' || x === 'begin' || x === 'end') break;
      }
      const { decls } = parseDeclarators(text, tokens, i, k, mod.paramMap);
      for (const decl of decls) {
        const scope = sub ? `${mod.name}.${sub}` : mod.name;
        if (decl.keyword === 'parameter' || decl.keyword === 'localparam') { if (!sub) mod.symbol.addParam(decl); continue; }
        if (decl.direction) {
          if (sub) continue; // function/task arguments are not module ports
          const width = decl.width ?? (decl.range ? null : 1);
          const port = mod.ports.find(p => p.name === decl.name);
          if (port) Object.assign(port, { direction: decl.direction, type: decl.type, range: decl.range, width });
          else mod.ports.push({ name: decl.name, direction: decl.direction, type: decl.type, range: decl.range, width, line: decl.line });
          symbols.push({ name: decl.name, kind: 'port', line: decl.line, detail: declDetail(decl), scope, direction: decl.direction, ...(width != null ? { width } : {}) });
          continue;
        }
        const kind = SYMBOL_KIND[decl.type || decl.keyword];
        if (!kind) continue;
        const width = decl.width ?? (decl.range ? null : 1);
        symbols.push({ name: decl.name, kind, line: decl.line, detail: declDetail(decl), scope, ...(width != null ? { width } : {}) });
      }
      i = tokens[k]?.t === ';' ? k + 1 : Math.max(k, i + 1);
      start = true;
      continue;
    }
    // Statement-start tracking for the next declaration.
    start = t === ';' || t === 'begin' || t === 'end' || t === 'generate' || t === 'endgenerate' || t === 'endcase' || t === 'else' || t === 'join';
    i++;
    if ((t === 'begin' || t === 'end') && tokens[i]?.t === ':') i += 2;
  }
  for (const s of symbols) delete s.addParam;
  if (mod?.symbol) delete mod.symbol.addParam;
  return { symbols, modules };
}

export function extractFileSymbols(source) {
  if (typeof source !== 'string') return [];
  return scanFile(source).symbols.sort((a, b) => a.line - b.line || (a.kind === 'module' ? -1 : 0));
}

function fileEntries(files) {
  if (!files) return [];
  if (files instanceof Map) return [...files.entries()];
  if (Array.isArray(files)) return files.map(f => (Array.isArray(f) ? f : [f?.path ?? f?.name, f?.text ?? f?.content ?? f?.source]));
  return Object.entries(files);
}

export function buildInstantiationTemplate(moduleName, files, { instanceName, tabWidth = 2 } = {}) {
  if (!moduleName) return null;
  const entries = fileEntries(files).filter(([, text]) => typeof text === 'string');
  // Prefer HDL sources, but accept any text entry.
  entries.sort(([a], [b]) => Number(!/\.(?:s?v|vh|svh)$/i.test(a || '')) - Number(!/\.(?:s?v|vh|svh)$/i.test(b || '')));
  let mod = null;
  for (const [, text] of entries) {
    if (!text.includes(moduleName)) continue;
    mod = scanFile(text).modules.find(m => m.name === moduleName);
    if (mod) break;
  }
  if (!mod) return null;
  const inst = instanceName || `u_${moduleName}`;
  const params = mod.params.filter(p => !p.local && p.literal && p.value != null);
  const lines = [];
  if (params.length) {
    lines.push(`${moduleName} #(`, ...params.map((p, i) => `.${p.name}(${p.value})${i < params.length - 1 ? ',' : ''}`));
    lines.push(mod.ports.length ? `) ${inst} (` : `) ${inst} ();`);
  } else {
    lines.push(mod.ports.length ? `${moduleName} ${inst} (` : `${moduleName} ${inst} ();`);
  }
  if (mod.ports.length) {
    lines.push(...mod.ports.map((p, i) => `.${p.name}(${p.name})${i < mod.ports.length - 1 ? ',' : ''}`));
    lines.push(');');
  }
  return formatVerilog(lines.join('\n'), { tabWidth });
}
