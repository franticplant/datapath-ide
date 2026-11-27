// Strict RTL lint: fast, text-based Verilog checks plus synthesis-backed latch findings.
// Everything here is pure (no DOM, no workers) so it runs in the UI thread and in Node tests.
import { maskVerilog } from './verilog-lex.js';

export const LINT_RULES = {
  BLKSEQ: {
    title: 'Blocking assignment in sequential block',
    severity: 'warning',
    description: 'A clocked always block updates a register with blocking `=`. Other clocked blocks may read the new or the old value depending on scheduling order, so simulation can disagree with hardware. Use non-blocking `<=` for registers.',
  },
  NONBLK: {
    title: 'Non-blocking assignment in combinational block',
    severity: 'warning',
    description: 'A combinational always block uses non-blocking `<=`. Later statements in the same block see stale values, so the block needs extra delta cycles and can simulate differently from the gates it describes. Use blocking `=` in combinational logic.',
  },
  INCOMPLETE_CASE: {
    title: 'Case statement missing default branch',
    severity: 'warning',
    description: 'A case statement in combinational logic has no `default:` branch and its outputs are not assigned beforehand, so unlisted selector values keep the previous value and synthesis infers a latch.',
  },
  LATCH_INFERRED: {
    title: 'Latch inferred in synthesis',
    severity: 'warning',
    description: 'Elaboration produced a level-sensitive latch: some path through a combinational block leaves a signal unassigned. Assign every output on every path (else/default branches or defaults at the top of the block), or make the block clocked.',
  },
  WIDTH_TRUNC: {
    title: 'Possible bit-width truncation',
    severity: 'warning',
    description: 'The right-hand side is wider than the signal it is assigned to, so its upper bits are silently dropped. Size the expression to match or select the intended bits explicitly.',
  },
  UNDRIVEN: {
    title: 'Internal signal has no driver',
    severity: 'warning',
    description: 'An internal wire or register is read but nothing assigns it or connects it to an instance output, so it stays `x`/`z` in simulation.',
  },
  UNUSED: {
    title: 'Internal signal is never read',
    severity: 'warning',
    description: 'An internal wire or register is never read by any logic, instance or port, so it has no effect on the design. It is often a typo or leftover from a refactor.',
  },
};

// ---------------------------------------------------------------------------
// Tokenizer

const KEYWORDS = new Set(`always always_comb always_ff always_latch and assign automatic begin buf bufif0 bufif1 case casex casez cmos
deassign default defparam disable do edge else end endcase endfunction endgenerate endmodule endprimitive endspecify endtable endtask
enum event final for force forever fork function generate genvar highz0 highz1 if ifnone import initial inout input inside int integer
join join_any join_none large localparam logic longint macromodule medium module nand negedge nmos nor not notif0 notif1 or output
package parameter pmos posedge primitive priority pull0 pull1 pulldown pullup rcmos real realtime reg release repeat return rnmos rpmos
rtran rtranif0 rtranif1 scalared shortint signed small specify specparam strong0 strong1 struct supply0 supply1 table task time tran
tranif0 tranif1 tri tri0 tri1 triand trior trireg typedef union unique unique0 unsigned uwire var vectored wait wand weak0 weak1 while
wire wor xnor xor bit byte void`.split(/\s+/));

const DIRECTIVES_SKIP_LINE = new Set(['define', 'undef', 'include', 'timescale', 'ifdef', 'ifndef', 'elsif', 'else', 'endif',
  'default_nettype', 'resetall', 'celldefine', 'endcelldefine', 'line', 'pragma', 'begin_keywords', 'end_keywords',
  'unconnected_drive', 'nounconnected_drive', 'undefineall']);

const TOKEN_RE = new RegExp([
  String.raw`(\s+)`,
  String.raw`(\\\S+)`,
  String.raw`(\x60[A-Za-z_][\w$]*)`,
  String.raw`((?:\d[\d_]*\s*)?'[sS]?[bBoOdDhH]\s*[0-9a-fA-FxXzZ?_]+|'[01xXzZ](?![\w$])|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?)`,
  String.raw`(\$?[A-Za-z_][\w$]*)`,
  String.raw`(<<<=|>>>=|===|!==|<<<|>>>|<<=|>>=|==|!=|<=|>=|&&|\|\||<<|>>|\*\*|->|\+:|-:|::|\+\+|--|\+=|-=|\*=|\/=|%=|&=|\|=|\^=|~&|~\||~\^|\^~)`,
  String.raw`([\s\S])`,
].join('|'), 'y');

function tokenize(source, macros) {
  const text = maskVerilog(source).replace(/\(\*(?!\s*\))[\s\S]*?\*\)/g, m => m.replace(/[^\n]/g, ' '));
  const tokens = [];
  let line = 1;
  TOKEN_RE.lastIndex = 0;
  let match;
  while (TOKEN_RE.lastIndex < text.length && (match = TOKEN_RE.exec(text))) {
    const [raw, ws, escaped, directive, num, word, op, ch] = match;
    const pos = match.index;
    if (ws !== undefined) { line += countLines(ws); continue; }
    if (directive !== undefined) {
      const name = directive.slice(1);
      if (DIRECTIVES_SKIP_LINE.has(name)) {
        let end = pos;
        for (;;) {
          const nl = text.indexOf('\n', end);
          const stop = nl < 0 ? text.length : nl;
          if (name !== 'define' || !/\\\s*$/.test(text.slice(end, stop)) || nl < 0) { end = stop; break; }
          end = nl + 1;
        }
        const body = text.slice(pos + raw.length, end);
        if (name === 'define') {
          const m = /^\s*([A-Za-z_][\w$]*)/.exec(body);
          if (m) macros.set(m[1], body.slice(m.index + m[0].length));
        }
        line += countLines(body);
        TOKEN_RE.lastIndex = end;
        continue;
      }
      tokens.push({ k: 'macro', v: name, line, pos, end: pos + raw.length });
      continue;
    }
    const tok = { line, pos, end: pos + raw.length };
    if (escaped !== undefined) Object.assign(tok, { k: 'id', v: escaped.slice(1) });
    else if (num !== undefined) Object.assign(tok, { k: 'num', v: num });
    else if (word !== undefined) Object.assign(tok, word[0] === '$' ? { k: 'sys', v: word } : KEYWORDS.has(word) ? { k: 'kw', v: word } : { k: 'id', v: word });
    else Object.assign(tok, { k: 'op', v: op ?? ch });
    tokens.push(tok);
    if (num !== undefined) line += countLines(num);
  }
  return { tokens, text };
}

function countLines(s) { let n = 0; for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++; return n; }

// ---------------------------------------------------------------------------
// Expressions: a small Pratt parser shared by constant evaluation and width inference.

const BINARY_PREC = {
  '||': 2, '&&': 3, '|': 4, '^': 5, '~^': 5, '^~': 5, '&': 6,
  '==': 7, '!=': 7, '===': 7, '!==': 7, '<': 8, '<=': 8, '>': 8, '>=': 8,
  '<<': 9, '>>': 9, '<<<': 9, '>>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '%': 11, '**': 12,
};
const UNARY_OPS = new Set(['~', '-', '+', '!', '&', '|', '^', '~&', '~|', '~^', '^~']);
const COMPARE_OPS = new Set(['||', '&&', '==', '!=', '===', '!==', '<', '<=', '>', '>=']);

function parseNumber(text) {
  const clean = text.replace(/\s+/g, '');
  const based = /^(\d[\d_]*)?'([sS])?([bBoOdDhH])([0-9a-fA-FxXzZ?_]+)$/.exec(clean);
  if (based) {
    const digits = based[4].replace(/_/g, '');
    const hasXZ = /[xXzZ?]/.test(digits);
    const radix = { b: 2, o: 8, d: 10, h: 16 }[based[3].toLowerCase()];
    const value = hasXZ ? null : parseInt(digits, radix);
    return { t: 'num', size: based[1] ? parseInt(based[1].replace(/_/g, ''), 10) : null, value: Number.isFinite(value) ? value : null, hasXZ };
  }
  if (/^'[01xXzZ]$/.test(clean)) return { t: 'num', size: null, value: /[01]/.test(clean[1]) ? Number(clean[1]) : null, hasXZ: !/[01]/.test(clean[1]), fill: true };
  if (/^\d[\d_]*$/.test(clean)) return { t: 'num', size: null, value: parseInt(clean.replace(/_/g, ''), 10), hasXZ: false };
  return { t: 'num', size: null, value: null, real: true, hasXZ: false };
}

function parseExpression(tokens, start, end) {
  let i = start;
  const peek = () => (i < end ? tokens[i] : null);
  const isOp = v => { const t = peek(); return t && t.k === 'op' && t.v === v; };
  const fail = () => { throw new SyntaxError('expr'); };
  function expect(v) { if (!isOp(v)) fail(); i++; }
  function list(close) {
    const items = [];
    if (isOp(close)) { i++; return items; }
    for (;;) { items.push(expr(0)); if (isOp(',')) { i++; continue; } expect(close); return items; }
  }
  function selects(node) {
    while (isOp('[')) {
      i++;
      const a = expr(0);
      let sel = { a };
      if (isOp(':') || isOp('+:') || isOp('-:')) { const kind = tokens[i].v; i++; sel = { a, b: expr(0), kind }; }
      expect(']');
      node.selects.push(sel);
    }
    return node;
  }
  function primary() {
    const t = peek();
    if (!t) fail();
    if (t.k === 'num') { i++; return parseNumber(t.v); }
    if (t.k === 'id') {
      i++;
      if (isOp('(')) { i++; return { t: 'call', name: t.v, args: list(')') }; }
      if (isOp('.') || isOp('::')) { while (isOp('.') || isOp('::')) { i += 2; } return selects({ t: 'id', name: null, hier: true, selects: [] }); }
      return selects({ t: 'id', name: t.v, selects: [] });
    }
    if (t.k === 'sys') { i++; return { t: 'call', name: t.v, args: isOp('(') ? (i++, list(')')) : [] }; }
    if (t.k === 'macro') { i++; if (isOp('(')) { i++; list(')'); } return { t: 'unknown' }; }
    if (t.k === 'op') {
      if (t.v === '(') { i++; const inner = expr(0); if (isOp(':')) { i++; expr(0); if (isOp(':')) { i++; expr(0); } } expect(')'); return inner; }
      if (t.v === '{') {
        i++;
        const first = expr(0);
        if (isOp('{')) { i++; const items = list('}'); expect('}'); return { t: 'rep', n: first, items }; }
        const items = [first];
        while (isOp(',')) { i++; items.push(expr(0)); }
        expect('}');
        return { t: 'cat', items };
      }
      if (t.v === "'" ) { i++; if (isOp('{')) { i++; list('}'); } return { t: 'unknown' }; }
      if (UNARY_OPS.has(t.v)) { i++; return { t: 'un', op: t.v, a: unaryOperand() }; }
    }
    fail();
  }
  function unaryOperand() {
    const t = peek();
    if (t && t.k === 'op' && UNARY_OPS.has(t.v)) { i++; return { t: 'un', op: t.v, a: unaryOperand() }; }
    return primary();
  }
  function expr(minPrec) {
    let left = unaryOperand();
    for (;;) {
      const t = peek();
      if (!t || t.k !== 'op') break;
      if (t.v === '?' && minPrec <= 1) {
        i++;
        const a = expr(0);
        expect(':');
        const b = expr(1);
        left = { t: 'tern', c: left, a, b };
        continue;
      }
      const prec = BINARY_PREC[t.v];
      if (!prec || prec < minPrec || prec <= 1) break;
      i++;
      const right = expr(t.v === '**' ? prec : prec + 1);
      left = { t: 'bin', op: t.v, a: left, b: right };
    }
    return left;
  }
  try {
    const node = expr(0);
    return i === end ? node : null;
  } catch {
    return null;
  }
}

function clog2(n) { if (n <= 1) return 0; let r = 0; for (let v = n - 1; v > 0; v = Math.floor(v / 2)) r++; return r; }

// Evaluate a constant expression; returns { value, parametric } or null.
function evalConst(node, params) {
  if (!node) return null;
  switch (node.t) {
    case 'num': return node.value == null ? null : { value: node.value, parametric: false };
    case 'id': {
      if (node.selects.length || node.hier) return null;
      const p = params.get(node.name);
      return p && p.value != null ? { value: p.value, parametric: p.parametric } : null;
    }
    case 'un': {
      const a = evalConst(node.a, params);
      if (!a) return null;
      const v = { '-': -a.value, '+': a.value, '!': a.value ? 0 : 1, '~': ~a.value }[node.op];
      return v === undefined ? null : { value: v, parametric: a.parametric };
    }
    case 'bin': {
      const a = evalConst(node.a, params), b = evalConst(node.b, params);
      if (!a || !b) return null;
      const x = a.value, y = b.value;
      const ops = {
        '+': x + y, '-': x - y, '*': x * y, '/': y ? Math.trunc(x / y) : null, '%': y ? x % y : null, '**': x ** y,
        '<<': x * 2 ** y, '>>': Math.floor(x / 2 ** y), '<<<': x * 2 ** y, '>>>': Math.floor(x / 2 ** y),
        '&': x & y, '|': x | y, '^': x ^ y, '==': +(x === y), '!=': +(x !== y), '<': +(x < y), '<=': +(x <= y),
        '>': +(x > y), '>=': +(x >= y), '&&': +(x && y), '||': +(x || y),
      };
      const v = ops[node.op];
      return v == null || !Number.isFinite(v) ? null : { value: v, parametric: a.parametric || b.parametric };
    }
    case 'tern': {
      const c = evalConst(node.c, params);
      if (!c) return null;
      const r = evalConst(c.value ? node.a : node.b, params);
      return r && { value: r.value, parametric: r.parametric || c.parametric };
    }
    case 'call': {
      if (node.name === '$clog2' && node.args.length === 1) {
        const a = evalConst(node.args[0], params);
        return a && { value: clog2(a.value), parametric: a.parametric };
      }
      return null;
    }
    default: return null;
  }
}

function bitLength(value) { return value <= 0 ? 1 : Math.floor(Math.log2(value)) + 1; }

// Self-determined width of an expression; { w, flex } or null when it cannot be told for sure.
// `flex` marks an unsized literal whose width is just the bits its value needs.
function widthOf(node, mod) {
  if (!node) return null;
  switch (node.t) {
    case 'num':
      if (node.real || node.fill) return null;
      if (node.size != null) return { w: node.size };
      return node.value == null ? null : { w: bitLength(node.value), flex: true };
    case 'id': {
      if (node.hier || mod.params.has(node.name)) return null;
      const sig = mod.signals.get(node.name);
      if (!sig || sig.width == null || sig.parametric) return null;
      if (!node.selects.length) return sig.isArray ? null : { w: sig.width };
      if (sig.isArray && node.selects.length === 1 && !node.selects[0].kind) return { w: sig.width };
      return null; // explicit bit/part selects are trusted as intentional
    }
    case 'un':
      if (['~', '-', '+'].includes(node.op)) return widthOf(node.a, mod);
      return { w: 1 };
    case 'bin': {
      if (COMPARE_OPS.has(node.op)) return { w: 1 };
      if (['<<', '>>', '<<<', '>>>', '**'].includes(node.op)) return null;
      const a = widthOf(node.a, mod), b = widthOf(node.b, mod);
      if (!a || !b) return null;
      return { w: Math.max(a.w, b.w), flex: a.flex && b.flex };
    }
    case 'tern': {
      const a = widthOf(node.a, mod), b = widthOf(node.b, mod);
      if (!a || !b) return null;
      return { w: Math.max(a.w, b.w), flex: a.flex && b.flex };
    }
    case 'cat': {
      let w = 0;
      for (const item of node.items) { const x = widthOf(item, mod); if (!x || x.flex) return null; w += x.w; }
      return { w };
    }
    case 'rep': {
      const n = evalConst(node.n, mod.params);
      if (!n || n.parametric) return null;
      const inner = widthOf({ t: 'cat', items: node.items }, mod);
      return inner && { w: n.value * inner.w };
    }
    case 'call':
      if ((node.name === '$signed' || node.name === '$unsigned') && node.args.length === 1) return widthOf(node.args[0], mod);
      return null;
    default: return null;
  }
}

// Width of an assignment target, or null when unknown.
function lhsWidth(node, mod) {
  if (!node) return null;
  if (node.t === 'cat') {
    let w = 0;
    for (const item of node.items) { const x = lhsWidth(item, mod); if (x == null) return null; w += x; }
    return w;
  }
  if (node.t !== 'id' || node.hier) return null;
  const sig = mod.signals.get(node.name);
  if (!sig || sig.width == null || sig.parametric) return null;
  let sels = node.selects;
  if (sig.isArray) { if (!sels.length) return null; sels = sels.slice(1); }
  if (!sels.length) return sig.width;
  if (sels.length > 1) return null;
  const sel = sels[0];
  if (!sel.kind) return 1;
  if (sel.kind === '+:' || sel.kind === '-:') { const w = evalConst(sel.b, mod.params); return w && !w.parametric ? w.value : null; }
  const a = evalConst(sel.a, mod.params), b = evalConst(sel.b, mod.params);
  return a && b && !a.parametric && !b.parametric ? Math.abs(a.value - b.value) + 1 : null;
}

// ---------------------------------------------------------------------------
// Parser

const NET_KINDS = new Set(['wire', 'reg', 'logic', 'tri', 'tri0', 'tri1', 'wand', 'wor', 'triand', 'trior', 'trireg', 'uwire', 'supply0', 'supply1', 'bit', 'var']);
const VAR_KINDS = new Set(['integer', 'int', 'genvar', 'real', 'realtime', 'time', 'shortint', 'longint', 'byte']);
const FIXED_WIDTH = { integer: 32, int: 32, time: 64, shortint: 16, longint: 64, byte: 8 };
const EXEMPT_BLOCKING = new Set(['integer', 'int', 'genvar', 'real', 'realtime', 'time', 'shortint', 'longint', 'byte']);
const UU_KINDS = new Set(['wire', 'reg', 'logic', 'tri', 'tri0', 'tri1', 'wand', 'wor', 'triand', 'trior', 'trireg', 'uwire', 'bit', 'var', 'user']);
const DIRECTIONS = new Set(['input', 'output', 'inout']);
const GATES = new Set(['and', 'or', 'nand', 'nor', 'xor', 'xnor', 'not', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1',
  'pullup', 'pulldown', 'tran', 'tranif0', 'tranif1', 'rtran', 'rtranif0', 'rtranif1', 'nmos', 'pmos', 'cmos', 'rnmos', 'rpmos', 'rcmos']);
const ASSIGN_OPS = new Set(['=', '<=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=', '<<<=', '>>>=']);
const TB_TASKS = new Set(['$display', '$displayb', '$displayh', '$displayo', '$write', '$monitor', '$strobe', '$finish', '$stop',
  '$dumpfile', '$dumpvars', '$dumpon', '$dumpoff', '$dumpall', '$dumpflush', '$fopen', '$fclose', '$fdisplay', '$fwrite',
  '$fmonitor', '$fstrobe', '$fscanf', '$sscanf', '$error', '$fatal', '$info', '$warning']);
const READMEM = new Set(['$readmemh', '$readmemb']);
const STMT_END = new Set(['end', 'endcase', 'endmodule', 'endfunction', 'endtask', 'join', 'join_any', 'join_none', 'endgenerate']);

class ModuleParser {
  constructor(tokens, text, file, start, macros) {
    this.t = tokens;
    this.text = text;
    this.i = start;
    this.macros = macros;
    this.mod = {
      name: null, file, line: tokens[start].line,
      ports: [], signals: new Map(), params: new Map(),
      reads: new Set(), drives: new Set(), instances: [],
      testbench: false, assignments: [], findings: [], macrosUsed: new Set(), wildcard: false,
    };
  }

  peek(o = 0) { return this.t[this.i + o] || null; }
  isOp(v, o = 0) { const t = this.peek(o); return !!t && t.k === 'op' && t.v === v; }
  isKw(v, o = 0) { const t = this.peek(o); return !!t && t.k === 'kw' && t.v === v; }
  done() { return this.i >= this.t.length; }

  // Index just past the bracket that closes the one at `at`.
  matchClose(at) {
    const pairs = { '(': ')', '[': ']', '{': '}' };
    let depth = 0;
    for (let j = at; j < this.t.length; j++) {
      const tk = this.t[j];
      if (tk.k !== 'op') { if (tk.k === 'kw' && tk.v === 'endmodule') return j; continue; }
      if (pairs[tk.v]) depth++;
      else if (tk.v === ')' || tk.v === ']' || tk.v === '}') { depth--; if (depth === 0) return j + 1; }
    }
    return this.t.length;
  }

  // First index in [from, limit) holding one of `stops` at bracket depth 0.
  findTop(from, stops, limit = this.t.length, stopKw = STMT_END) {
    let depth = 0;
    for (let j = from; j < limit; j++) {
      const tk = this.t[j];
      if (tk.k === 'kw' && depth === 0 && stopKw.has(tk.v)) return j;
      if (tk.k !== 'op') continue;
      if (depth === 0 && stops.has(tk.v)) return j;
      if (tk.v === '(' || tk.v === '[' || tk.v === '{') depth++;
      else if (tk.v === ')' || tk.v === ']' || tk.v === '}') { if (depth === 0) return j; depth--; }
    }
    return limit;
  }

  splitTop(from, to) {
    const parts = [];
    let s = from;
    for (;;) {
      const c = this.findTop(s, new Set([',']), to, new Set());
      parts.push([s, c]);
      if (c >= to) return parts;
      s = c + 1;
    }
  }

  // Identifiers in a token range that name local signals (hierarchical references skipped).
  idents(from, to) {
    const out = [];
    for (let j = from; j < to; j++) {
      const tk = this.t[j];
      if (tk.k === 'macro') { this.mod.macrosUsed.add(tk.v); continue; }
      if (tk.k !== 'id') continue;
      const prev = this.t[j - 1], next = this.t[j + 1];
      if (prev && prev.k === 'op' && (prev.v === '.' || prev.v === '::')) continue;
      if (next && next.k === 'op' && (next.v === '.' || next.v === '::')) continue;
      if (prev && prev.k === 'op' && prev.v === "'") continue;
      out.push(tk.v);
    }
    return out;
  }
  read(from, to) { for (const name of this.idents(from, to)) this.mod.reads.add(name); }
  drive(names) { for (const name of names) this.mod.drives.add(name); }

  snippet(from, to) {
    if (from >= to) return '';
    const s = this.text.slice(this.t[from].pos, this.t[to - 1].end).replace(/\s+/g, ' ').trim();
    return s.length > 48 ? `${s.slice(0, 45)}…` : s;
  }

  addFinding(rule, line, message, hint) {
    this.mod.findings.push({ file: this.mod.file, line, severity: LINT_RULES[rule].severity, rule, message, hint });
  }

  // -- declarations -------------------------------------------------------

  declare(name, info) {
    const existing = this.mod.signals.get(name);
    if (!existing) { this.mod.signals.set(name, { name, ...info }); return; }
    if (info.dir) existing.dir = info.dir;
    if (info.isPort) existing.isPort = true;
    if (info.width != null && (existing.width == null || info.explicitWidth)) { existing.width = info.width; existing.parametric = info.parametric; }
    if (info.kind && (!existing.kind || existing.kind === 'wire')) existing.kind = info.kind;
    if (info.isArray) existing.isArray = true;
  }

  // Parse `[msb:lsb]` at this.i; returns { width, parametric } or null and advances.
  packedRange() {
    const open = this.i;
    const close = this.matchClose(open);
    this.i = close;
    const colon = this.findTop(open + 1, new Set([':']), close - 1, new Set());
    if (colon >= close - 1) return { width: null, parametric: false };
    const a = evalConst(parseExpression(this.t, open + 1, colon), this.mod.params);
    const b = evalConst(parseExpression(this.t, colon + 1, close - 1), this.mod.params);
    if (!a || !b) return { width: null, parametric: true };
    return { width: Math.abs(a.value - b.value) + 1, parametric: a.parametric || b.parametric };
  }

  // Declaration items after the type: name [dims] [= expr] {, ...}. Stops at ';' (consumed) or at `stop` set.
  declItems(base, { endAt = null } = {}) {
    const end = endAt ?? this.findTop(this.i, new Set([';']));
    for (const [s, e] of this.splitTop(this.i, end)) {
      let j = s;
      // Ports in ANSI lists may repeat the type per item; tolerate `[range]` before the name too.
      let width = base.width, parametric = base.parametric;
      while (j < e && this.t[j].k === 'op' && this.t[j].v === '[') {
        const save = this.i; this.i = j; const r = this.packedRange(); j = this.i; this.i = save;
        width = r.width; parametric = r.parametric;
      }
      const nameTok = this.t[j];
      if (!nameTok || nameTok.k !== 'id') { this.read(s, e); continue; }
      j++;
      let isArray = false;
      while (j < e && this.t[j].k === 'op' && this.t[j].v === '[') { isArray = true; j = this.matchClose(j); }
      this.declare(nameTok.v, { kind: base.kind, dir: base.dir, isPort: !!base.dir, width, parametric, isArray, line: nameTok.line, local: !!base.local, explicitWidth: base.explicitWidth });
      if (j < e && this.t[j].k === 'op' && this.t[j].v === '=') {
        this.drive([nameTok.v]);
        this.read(j + 1, e);
        this.mod.assignments.push({ lhsName: nameTok.v, rhs: [j + 1, e], line: nameTok.line, declInit: true });
      }
    }
    this.i = endAt == null ? end + 1 : end;
  }

  // After a direction or net keyword: [kind] [signed] [range] ...
  declHead(first) {
    let dir = DIRECTIONS.has(first) ? first : null;
    let kind = dir ? null : first;
    let width = 1, parametric = false, explicitWidth = false;
    if (FIXED_WIDTH[kind]) width = FIXED_WIDTH[kind];
    if (kind === 'real' || kind === 'realtime' || kind === 'genvar') width = null;
    for (;;) {
      const tk = this.peek();
      if (!tk) break;
      if (tk.k === 'kw' && (NET_KINDS.has(tk.v) || VAR_KINDS.has(tk.v))) {
        if (!kind || kind === 'var') kind = tk.v;
        if (FIXED_WIDTH[tk.v]) width = FIXED_WIDTH[tk.v];
        this.i++;
        continue;
      }
      if (tk.k === 'kw' && ['signed', 'unsigned', 'scalared', 'vectored', 'automatic'].includes(tk.v)) { this.i++; continue; }
      if (tk.k === 'op' && tk.v === '(' && kind && NET_KINDS.has(kind)) { this.i = this.matchClose(this.i); continue; } // drive strength
      if (tk.k === 'op' && tk.v === '#') { this.skipDelay(); continue; }
      if (tk.k === 'op' && tk.v === '[') {
        const r = this.packedRange();
        width = r.width; parametric = r.parametric; explicitWidth = true;
        continue;
      }
      // A user-defined type name before the signal name (e.g. `input state_t s`).
      if (tk.k === 'id' && this.peek(1)?.k === 'id') { kind = kind || 'user'; width = null; this.i++; continue; }
      break;
    }
    return { dir, kind: kind || 'wire', width, parametric, explicitWidth };
  }

  paramList(overridable, endAt = null) {
    const end = endAt ?? this.findTop(this.i, new Set([';']));
    for (const [s, e] of this.splitTop(this.i, end)) {
      let j = s;
      while (j < e && (this.t[j].k === 'kw' || (this.t[j].k === 'op' && this.t[j].v === '['))) {
        if (this.t[j].k === 'kw' && (this.t[j].v === 'parameter' || this.t[j].v === 'localparam')) overridable = this.t[j].v === 'parameter';
        j = this.t[j].v === '[' ? this.matchClose(j) : j + 1;
      }
      // type parameter or user type: skip a leading type identifier
      if (j + 1 < e && this.t[j].k === 'id' && this.t[j + 1].k === 'id') j++;
      const nameTok = this.t[j];
      if (!nameTok || nameTok.k !== 'id') continue;
      const eq = this.findTop(j + 1, new Set(['=']), e, new Set());
      const value = eq < e ? evalConst(parseExpression(this.t, eq + 1, e), this.mod.params) : null;
      this.mod.params.set(nameTok.v, { value: value ? value.value : null, parametric: overridable || !!value?.parametric, line: nameTok.line });
    }
    this.i = endAt == null ? end + 1 : end;
  }

  skipDelay() {
    this.i++; // '#'
    if (this.isOp('(')) { this.i = this.matchClose(this.i); return; }
    if (this.peek() && ['num', 'id'].includes(this.peek().k)) this.i++;
    while (this.isOp('.') || this.isOp('::')) this.i += 2;
  }

  enumBody() {
    // At '{' of `enum [type] {A, B=3, C}`: declare the names as parameters with their values.
    const close = this.matchClose(this.i);
    let next = 0;
    for (const [s, e] of this.splitTop(this.i + 1, close - 1)) {
      const nameTok = this.t[s];
      if (!nameTok || nameTok.k !== 'id') continue;
      const eq = this.findTop(s + 1, new Set(['=']), e, new Set());
      if (eq < e) { const v = evalConst(parseExpression(this.t, eq + 1, e), this.mod.params); next = v ? v.value : null; }
      this.mod.params.set(nameTok.v, { value: next, parametric: false, line: nameTok.line });
      next = next == null ? null : next + 1;
    }
    this.i = close;
  }

  // -- module structure ---------------------------------------------------

  parse() {
    this.i++; // module
    while (this.peek()?.k === 'kw' && ['automatic', 'static'].includes(this.peek().v)) this.i++;
    const nameTok = this.peek();
    this.mod.name = nameTok?.v || '?';
    this.mod.line = nameTok?.line || this.mod.line;
    this.i++;
    while (this.isKw('import')) this.i = this.findTop(this.i, new Set([';'])) + 1;
    if (this.isOp('#') && this.isOp('(', 1)) {
      const close = this.matchClose(this.i + 1);
      this.i += 2;
      this.paramList(true, close - 1);
      this.i = close;
    }
    if (this.isOp('(')) this.portList();
    if (this.isOp(';')) this.i++;
    this.body();
    return this.mod;
  }

  portList() {
    const close = this.matchClose(this.i);
    let head = null;
    for (const [s, e] of this.splitTop(this.i + 1, close - 1)) {
      if (s >= e) continue;
      const tk = this.t[s];
      if (tk.k === 'kw' && (DIRECTIONS.has(tk.v) || NET_KINDS.has(tk.v) || VAR_KINDS.has(tk.v))) {
        this.i = s + 1;
        const h = this.declHead(tk.v);
        if (!DIRECTIONS.has(tk.v) && head) h.dir = head.dir;
        head = h;
        this.declItems(head, { endAt: e });
        for (const sig of this.mod.signals.values()) if (sig.isPort && !this.mod.ports.includes(sig.name)) this.mod.ports.push(sig.name);
      } else if (head && tk.k === 'id') {
        this.i = s;
        this.declItems(head, { endAt: e });
        for (const sig of this.mod.signals.values()) if (sig.isPort && !this.mod.ports.includes(sig.name)) this.mod.ports.push(sig.name);
      } else if (tk.k === 'id' && this.t[s + 1]?.k === 'id') {
        // interface port `bus_if.mp name` or `type name`
        const name = this.t[e - 1];
        if (name.k === 'id') { this.declare(name.v, { kind: 'user', dir: 'inout', isPort: true, width: null, line: name.line }); this.mod.ports.push(name.v); }
      } else {
        // Non-ANSI: names only, directions follow in the body. `.a(b)` style port expressions: use the inner names.
        for (const name of this.idents(s, e)) { if (!this.mod.ports.includes(name)) this.mod.ports.push(name); this.declare(name, { kind: null, isPort: true, width: null, line: tk.line }); }
      }
    }
    this.i = close;
  }

  body() {
    while (!this.done()) {
      const tk = this.peek();
      const before = this.i;
      if (tk.k === 'kw') {
        if (tk.v === 'endmodule') { this.i++; return; }
        this.moduleItem(tk);
      } else if (tk.k === 'id') {
        this.identItem();
      } else if (tk.k === 'macro') {
        this.mod.macrosUsed.add(tk.v);
        this.i++;
      } else {
        this.i++;
      }
      if (this.i <= before) this.i = before + 1;
    }
  }

  moduleItem(tk) {
    const v = tk.v;
    if (DIRECTIONS.has(v)) {
      this.i++;
      const head = this.declHead(v);
      this.declItems(head);
      for (const sig of this.mod.signals.values()) if (sig.isPort && !this.mod.ports.includes(sig.name)) this.mod.ports.push(sig.name);
      return;
    }
    if (NET_KINDS.has(v) || VAR_KINDS.has(v)) {
      this.i++;
      this.declItems(this.declHead(v));
      return;
    }
    switch (v) {
      case 'parameter': case 'localparam': this.i++; this.paramList(v === 'parameter'); return;
      case 'specparam': case 'defparam': case 'import': this.i = this.findTop(this.i, new Set([';'])) + 1; return;
      case 'typedef': this.typedef(); return;
      case 'enum': {
        this.i++;
        const head = this.declHead('logic');
        if (this.isOp('{')) this.enumBody();
        this.declItems({ ...head, kind: 'user' });
        return;
      }
      case 'assign': this.continuousAssign(); return;
      case 'always': case 'always_ff': case 'always_comb': case 'always_latch': this.always(v, tk.line); return;
      case 'initial': case 'final': this.initial(); return;
      case 'function': case 'task': this.skipRoutine(v === 'function' ? 'endfunction' : 'endtask'); return;
      case 'specify': this.skipTo('endspecify'); return;
      case 'begin': this.i++; if (this.isOp(':')) this.i += 2; return;
      case 'end': this.i++; if (this.isOp(':')) this.i += 2; return;
      case 'if': case 'for': case 'case': case 'casex': case 'casez': case 'while':
        this.i++;
        if (this.isOp('(')) { const close = this.matchClose(this.i); this.read(this.i + 1, close - 1); this.drive(this.forTargets(this.i + 1, close - 1, v)); this.i = close; }
        return;
      case 'default': this.i++; if (this.isOp(':')) this.i++; return;
      default:
        if (GATES.has(v)) { this.gate(v); return; }
        this.i++;
    }
  }

  forTargets(from, to, kw) {
    if (kw !== 'for') return [];
    const out = [];
    for (let j = from; j < to; j++) {
      const tk = this.t[j];
      if (tk.k === 'kw' && tk.v === 'genvar' && this.t[j + 1]?.k === 'id') this.declare(this.t[j + 1].v, { kind: 'genvar', width: null, line: tk.line, local: true });
      if (tk.k === 'id' && this.t[j + 1]?.k === 'op' && (ASSIGN_OPS.has(this.t[j + 1].v) && this.t[j + 1].v !== '<=' || this.t[j + 1].v === '++' || this.t[j + 1].v === '--')) out.push(tk.v);
    }
    return out;
  }

  typedef() {
    const end = this.findTop(this.i, new Set([';']));
    for (let j = this.i; j < end; j++) {
      if (this.t[j].k === 'kw' && this.t[j].v === 'enum') {
        const open = this.findTop(j, new Set(['{']), end, new Set());
        if (open < end) { const save = this.i; this.i = open; this.enumBody(); this.i = save; }
        break;
      }
    }
    this.i = end + 1;
  }

  skipTo(kw) {
    while (!this.done() && !this.isKw(kw) && !this.isKw('endmodule')) this.i++;
    if (this.isKw(kw)) this.i++;
  }

  skipRoutine(endKw) {
    const start = this.i;
    this.skipTo(endKw);
    // Routines may read and write module signals; count both so nothing is falsely flagged.
    const names = this.idents(start, this.i);
    for (const name of names) { this.mod.reads.add(name); this.mod.drives.add(name); }
    for (let j = start; j < this.i; j++) if (this.t[j].k === 'sys' && TB_TASKS.has(this.t[j].v)) this.mod.testbench = true;
  }

  continuousAssign() {
    this.i++;
    while (this.isOp('(') ) this.i = this.matchClose(this.i); // strength
    if (this.isOp('#')) this.skipDelay();
    const end = this.findTop(this.i, new Set([';']));
    for (const [s, e] of this.splitTop(this.i, end)) {
      const eq = this.findTop(s, new Set(['=']), e, new Set());
      if (eq >= e) { this.read(s, e); continue; }
      this.assignment(s, eq, eq + 1, e, '=', { kind: 'cont' }, this.t[s].line);
    }
    this.i = end + 1;
  }

  gate(kind) {
    this.i++;
    while (this.isOp('(') && !this.isTerminalList()) this.i = this.matchClose(this.i); // strengths
    if (this.isOp('#')) this.skipDelay();
    const end = this.findTop(this.i, new Set([';']));
    while (this.i < end) {
      if (this.peek().k === 'id') { this.i++; while (this.isOp('[')) this.i = this.matchClose(this.i); }
      if (!this.isOp('(')) { this.i++; continue; }
      const close = this.matchClose(this.i);
      const terms = this.splitTop(this.i + 1, close - 1);
      const outputs = ['buf', 'not'].includes(kind) ? terms.length - 1 : ['pullup', 'pulldown'].includes(kind) ? terms.length : /^r?tran/.test(kind) ? terms.length : 1;
      terms.forEach(([s, e], n) => {
        if (n < outputs) { const lhs = this.lhsTargets(s, e); this.drive(lhs.targets); for (const name of lhs.indexReads) this.mod.reads.add(name); }
        if (n >= outputs || /tran/.test(kind)) this.read(s, e);
      });
      this.i = close;
      if (this.isOp(',')) this.i++;
    }
    this.i = end + 1;
  }

  isTerminalList() {
    // Strength specs contain only keywords like strong0/weak1; terminal lists contain identifiers.
    const close = this.matchClose(this.i);
    for (let j = this.i + 1; j < close - 1; j++) if (this.t[j].k !== 'kw' && !(this.t[j].k === 'op' && this.t[j].v === ',')) return true;
    return false;
  }

  identItem() {
    const typeTok = this.peek();
    let j = this.i + 1;
    if (this.isOp('::', 1)) { this.i = this.findTop(this.i, new Set([';'])) + 1; return; }
    let paramsRange = null;
    if (this.t[j]?.k === 'op' && this.t[j].v === '#') {
      if (this.t[j + 1]?.k === 'op' && this.t[j + 1].v === '(') { const close = this.matchClose(j + 1); paramsRange = [j + 2, close - 1]; j = close; }
      else j += 2;
    }
    const nameTok = this.t[j];
    // `label:` in generate case items or named blocks
    if (this.t[this.i + 1]?.k === 'op' && this.t[this.i + 1].v === ':') { this.i += 2; return; }
    if (nameTok?.k === 'op' && nameTok.v === '(') {
      // unnamed instance (UDPs) or a stray call
      this.instance(typeTok, null, j, paramsRange);
      return;
    }
    if (nameTok?.k !== 'id') { this.i++; return; }
    let k = j + 1;
    while (this.t[k]?.k === 'op' && this.t[k].v === '[') k = this.matchClose(k);
    if (this.t[k]?.k === 'op' && this.t[k].v === '(') { this.instance(typeTok, nameTok, j, paramsRange); return; }
    if (this.t[k]?.k === 'op' && [';', ',', '='].includes(this.t[k].v)) {
      // variable of a user-defined type: `state_t state, next;`
      this.i = j;
      this.declItems({ kind: 'user', width: null, parametric: false });
      return;
    }
    this.i++;
  }

  instance(typeTok, firstName, at, paramsRange) {
    if (paramsRange) this.read(...paramsRange);
    const end = this.findTop(at, new Set([';']));
    this.i = at;
    while (this.i < end) {
      let name = null;
      if (this.peek().k === 'id') { name = this.peek(); this.i++; while (this.isOp('[')) { const c = this.matchClose(this.i); this.read(this.i + 1, c - 1); this.i = c; } }
      if (!this.isOp('(')) { this.i++; continue; }
      const close = this.matchClose(this.i);
      const conns = [];
      let position = 0;
      for (const [s, e] of this.splitTop(this.i + 1, close - 1)) {
        if (s >= e) { position++; continue; }
        if (this.t[s].k === 'op' && this.t[s].v === '.') {
          if (this.t[s + 1]?.k === 'op' && this.t[s + 1].v === '*') { conns.push({ wildcard: true }); this.mod.wildcard = true; continue; }
          const port = this.t[s + 1]?.v;
          if (this.t[s + 2]?.k === 'op' && this.t[s + 2].v === '(') {
            const c = this.matchClose(s + 2);
            conns.push({ port, range: [s + 3, c - 1] });
          } else {
            conns.push({ port, implicit: true, names: [port] });
          }
        } else {
          conns.push({ position, range: [s, e] });
        }
        position++;
      }
      for (const conn of conns) if (conn.range) conn.names = this.idents(...conn.range), conn.lhs = this.lhsTargets(...conn.range);
      this.mod.instances.push({ type: typeTok.v, name: name?.v ?? null, line: (name || typeTok).line, conns });
      this.i = close;
      if (this.isOp(',')) this.i++;
    }
    this.i = end + 1;
  }

  // -- procedural code ----------------------------------------------------

  always(kw, line) {
    this.i++;
    let kind = kw === 'always_ff' ? 'seq' : kw === 'always_comb' || kw === 'always_latch' ? 'comb' : 'other';
    if (this.isOp('@')) {
      this.i++;
      if (this.isOp('*')) { this.i++; if (kind === 'other') kind = 'comb'; }
      else if (this.isOp('(')) {
        const close = this.matchClose(this.i);
        let edge = false, star = false;
        for (let j = this.i + 1; j < close - 1; j++) {
          const tk = this.t[j];
          if (tk.k === 'kw' && (tk.v === 'posedge' || tk.v === 'negedge')) edge = true;
          if (tk.k === 'op' && tk.v === '*') star = true;
        }
        this.read(this.i + 1, close - 1);
        if (kind === 'other') kind = edge ? 'seq' : 'comb';
        if (star && !edge) kind = kw === 'always_ff' ? 'seq' : 'comb';
        this.i = close;
      } else if (this.peek()?.k === 'id') { this.read(this.i, this.i + 1); this.i++; }
    }
    const ctx = { kind, line, condDepth: 0, uncond: new Set(), cases: [], locals: new Set(), loopVars: new Set(), timing: false, initial: false };
    this.statement(ctx);
  }

  initial() {
    this.i++;
    const ctx = { kind: 'initial', condDepth: 0, uncond: new Set(), cases: [], locals: new Set(), loopVars: new Set(), timing: false, initial: true };
    this.statement(ctx);
    if (ctx.timing) this.mod.testbench = true;
  }

  statement(ctx) {
    const tk = this.peek();
    if (!tk) return;
    const start = this.i;
    if (tk.k === 'op') {
      switch (tk.v) {
        case ';': this.i++; return;
        case '@':
          this.i++;
          if (this.isOp('*')) this.i++;
          else if (this.isOp('(')) { const c = this.matchClose(this.i); this.read(this.i + 1, c - 1); this.i = c; }
          else if (this.peek()?.k === 'id') { this.read(this.i, this.i + 1); this.i++; }
          ctx.timing = true;
          this.statement(ctx);
          return;
        case '#': this.skipDelay(); ctx.timing = true; this.statement(ctx); return;
        case '->': this.i = this.findTop(this.i, new Set([';'])) + 1; ctx.timing = true; return;
        default: break;
      }
    }
    if (tk.k === 'kw') {
      switch (tk.v) {
        case 'begin': case 'fork': this.block(ctx, tk.v === 'begin' ? new Set(['end']) : new Set(['join', 'join_any', 'join_none'])); return;
        case 'if': {
          this.i++;
          if (this.isOp('(')) { const c = this.matchClose(this.i); this.read(this.i + 1, c - 1); this.i = c; }
          ctx.condDepth++;
          this.statement(ctx);
          if (this.isKw('else')) { this.i++; this.statement(ctx); }
          ctx.condDepth--;
          return;
        }
        case 'unique': case 'unique0': case 'priority': {
          this.i++;
          if (this.isKw('case') || this.isKw('casex') || this.isKw('casez')) { this.caseStatement(ctx, true); return; }
          this.statement(ctx);
          return;
        }
        case 'case': case 'casex': case 'casez': this.caseStatement(ctx, false); return;
        case 'for': this.forStatement(ctx); return;
        case 'while': case 'repeat': {
          this.i++;
          if (this.isOp('(')) { const c = this.matchClose(this.i); this.read(this.i + 1, c - 1); this.i = c; }
          ctx.condDepth++; this.statement(ctx); ctx.condDepth--;
          return;
        }
        case 'forever': this.i++; ctx.timing = true; ctx.condDepth++; this.statement(ctx); ctx.condDepth--; return;
        case 'do': {
          this.i++; ctx.condDepth++; this.statement(ctx); ctx.condDepth--;
          if (this.isKw('while')) { this.i++; if (this.isOp('(')) { const c = this.matchClose(this.i); this.read(this.i + 1, c - 1); this.i = c; } }
          if (this.isOp(';')) this.i++;
          return;
        }
        case 'wait': {
          this.i++; ctx.timing = true;
          if (this.isOp('(')) { const c = this.matchClose(this.i); this.read(this.i + 1, c - 1); this.i = c; }
          this.statement(ctx);
          return;
        }
        case 'disable': case 'deassign': case 'release': case 'return': {
          const end = this.findTop(this.i, new Set([';']));
          this.read(this.i + 1, end);
          this.i = end + 1;
          return;
        }
        case 'assign': case 'force': {
          this.i++;
          const end = this.findTop(this.i, new Set([';']));
          const eq = this.findTop(this.i, new Set(['=']), end, new Set());
          if (eq < end) this.assignment(this.i, eq, eq + 1, end, '=', { ...ctx, kind: 'cont' }, tk.line);
          else this.read(this.i, end);
          this.i = end + 1;
          return;
        }
        default:
          if (NET_KINDS.has(tk.v) || VAR_KINDS.has(tk.v)) { this.localDecl(ctx); return; }
          if (STMT_END.has(tk.v) || tk.v === 'else') return; // let the caller handle it
          break;
      }
    }
    if (tk.k === 'sys') { this.systemTask(ctx); return; }
    this.simpleStatement(ctx);
    if (this.i === start) this.i++;
  }

  block(ctx, closers) {
    this.i++;
    if (this.isOp(':')) this.i += 2;
    while (!this.done()) {
      const tk = this.peek();
      if (tk.k === 'kw' && closers.has(tk.v)) { this.i++; break; }
      if (tk.k === 'kw' && (tk.v === 'endmodule' || tk.v === 'endcase')) return;
      const before = this.i;
      this.statement(ctx);
      if (this.i === before) this.i++;
    }
    if (this.isOp(':')) this.i += 2;
  }

  localDecl(ctx) {
    const v = this.peek().v;
    this.i++;
    const head = this.declHead(v);
    const before = new Set(this.mod.signals.keys());
    this.declItems({ ...head, local: true });
    for (const name of this.mod.signals.keys()) if (!before.has(name)) ctx.locals.add(name);
  }

  systemTask(ctx) {
    const tk = this.peek();
    this.i++;
    let args = null;
    if (this.isOp('(')) { const c = this.matchClose(this.i); args = [this.i + 1, c - 1]; this.i = c; }
    if (this.isOp(';')) this.i++;
    if (TB_TASKS.has(tk.v)) this.mod.testbench = true;
    if (ctx.initial && !READMEM.has(tk.v)) ctx.timing = true;
    if (!args) return;
    const names = this.idents(...args);
    for (const name of names) this.mod.reads.add(name);
    if (READMEM.has(tk.v) || tk.v === '$fscanf' || tk.v === '$sscanf') this.drive(names);
  }

  forStatement(ctx) {
    this.i++;
    if (!this.isOp('(')) return;
    const close = this.matchClose(this.i);
    const semi1 = this.findTop(this.i + 1, new Set([';']), close - 1, new Set());
    const semi2 = this.findTop(semi1 + 1, new Set([';']), close - 1, new Set());
    // Loop control: init and step assignments are never reported.
    const control = (s, e) => {
      let j = s;
      if (this.t[j] && this.t[j].k === 'kw' && (VAR_KINDS.has(this.t[j].v) || NET_KINDS.has(this.t[j].v))) {
        while (this.t[j] && this.t[j].k === 'kw') j++;
        if (this.t[j]?.k === 'id') { this.declare(this.t[j].v, { kind: 'integer', width: 32, line: this.t[j].line, local: true }); ctx.locals.add(this.t[j].v); }
      }
      for (const [a, b] of this.splitTop(j, e)) {
        const eq = this.findTop(a, ASSIGN_OPS, b, new Set());
        const lhs = this.lhsTargets(a, eq < b ? eq : b);
        for (const name of lhs.targets) { ctx.loopVars.add(name); this.mod.drives.add(name); this.mod.reads.add(name); }
        for (const name of lhs.indexReads) this.mod.reads.add(name);
        if (eq < b) this.read(eq + 1, b);
      }
    };
    control(this.i + 1, semi1);
    this.read(semi1 + 1, semi2);
    control(semi2 + 1, close - 1);
    this.i = close;
    ctx.condDepth++;
    this.statement(ctx);
    ctx.condDepth--;
  }

  caseStatement(ctx, qualified) {
    const kwTok = this.peek();
    this.i++;
    let selector = null;
    if (this.isOp('(')) { const c = this.matchClose(this.i); selector = [this.i + 1, c - 1]; this.read(...selector); this.i = c; }
    if (this.isKw('inside')) this.i++;
    const info = { line: kwTok.line, kind: kwTok.v, assigned: new Set(), hasDefault: false, labels: [], before: new Set(ctx.uncond) };
    ctx.cases.push(info);
    ctx.condDepth++;
    while (!this.done() && !this.isKw('endcase') && !this.isKw('endmodule')) {
      const before = this.i;
      if (this.isKw('default')) {
        this.i++;
        if (this.isOp(':')) this.i++;
        info.hasDefault = true;
        this.statement(ctx);
      } else {
        const colon = this.findTop(this.i, new Set([':']), this.t.length, new Set(['endcase', 'endmodule']));
        if (colon >= this.t.length || this.t[colon].k !== 'op') { this.i = colon; break; }
        for (const [s, e] of this.splitTop(this.i, colon)) info.labels.push(parseExpression(this.t, s, e));
        this.read(this.i, colon);
        this.i = colon + 1;
        this.statement(ctx);
      }
      if (this.i === before) this.i++;
    }
    if (this.isKw('endcase')) this.i++;
    ctx.condDepth--;
    ctx.cases.pop();
    for (const outer of ctx.cases) for (const name of info.assigned) outer.assigned.add(name);
    if (ctx.kind !== 'comb' || info.hasDefault || qualified) return;
    if (this.fullCoverage(info, selector)) return;
    const missing = [...info.assigned].filter(name => !info.before.has(name) && !ctx.locals.has(name));
    if (!missing.length) return;
    const list = missing.map(n => `\`${n}\``).join(', ');
    this.addFinding('INCOMPLETE_CASE', info.line,
      `\`${info.kind}\` has no \`default:\` branch and ${list} ${missing.length > 1 ? 'are' : 'is'} not assigned before it, so unlisted values infer a latch.`,
      `Add \`default: ${missing[0]} = ...;\` or assign ${list} at the top of the always block.`);
  }

  fullCoverage(info, selector) {
    if (!selector || info.kind !== 'case') return false;
    const width = lhsWidth(parseExpression(this.t, ...selector), this.mod);
    if (width == null || width > 12) return false;
    const values = new Set();
    for (const label of info.labels) {
      const v = evalConst(label, this.mod.params);
      if (!v) return false;
      values.add(v.value);
    }
    return values.size >= 2 ** width;
  }

  simpleStatement(ctx) {
    const start = this.i;
    const end = this.findTop(start, new Set([';']));
    const line = this.t[start].line;
    const op = this.findTop(start, ASSIGN_OPS, end, new Set());
    if (op < end) {
      let rhs = op + 1;
      // intra-assignment timing control: `a <= #1 b` / `a = @(posedge c) b`
      if (this.t[rhs]?.k === 'op' && this.t[rhs].v === '#') { const save = this.i; this.i = rhs; this.skipDelay(); rhs = this.i; this.i = save; }
      else if (this.t[rhs]?.k === 'op' && this.t[rhs].v === '@') { rhs = this.t[rhs + 1]?.v === '(' ? this.matchClose(rhs + 1) : rhs + 2; }
      const v = this.t[op].v;
      this.assignment(start, op, rhs, end, v === '<=' ? '<=' : v === '=' ? '=' : 'compound', ctx, line);
    } else {
      // `i++`, task calls, bare expressions
      const incr = this.findTop(start, new Set(['++', '--']), end, new Set());
      if (incr < end) {
        const names = this.idents(start, end);
        for (const name of names) { this.mod.reads.add(name); this.mod.drives.add(name); }
      } else {
        this.read(start, end);
        // A user task call may write any of its arguments.
        if (this.t[start].k === 'id' && this.t[start + 1]?.k === 'op' && this.t[start + 1].v === '(') this.drive(this.idents(start + 1, end));
      }
    }
    this.i = end < this.t.length && this.t[end].k === 'op' && this.t[end].v === ';' ? end + 1 : end;
  }

  // LHS targets (assigned names) vs. names only read inside index expressions.
  lhsTargets(from, to) {
    const targets = [], indexReads = [];
    let bracket = 0;
    for (let j = from; j < to; j++) {
      const tk = this.t[j];
      if (tk.k === 'op') {
        if (tk.v === '[') bracket++;
        else if (tk.v === ']') bracket--;
        continue;
      }
      if (tk.k !== 'id') continue;
      const prev = this.t[j - 1], next = this.t[j + 1];
      if (prev?.k === 'op' && (prev.v === '.' || prev.v === '::')) continue;
      if (next?.k === 'op' && (next.v === '.' || next.v === '::')) continue;
      (bracket > 0 ? indexReads : targets).push(tk.v);
    }
    return { targets, indexReads };
  }

  assignment(ls, le, rs, re, op, ctx, line) {
    const { targets, indexReads } = this.lhsTargets(ls, le);
    this.drive(targets);
    for (const name of indexReads) this.mod.reads.add(name);
    this.read(rs, re);
    if (ctx.condDepth === 0 && ctx.uncond) for (const name of targets) ctx.uncond.add(name);
    if (ctx.cases) for (const info of ctx.cases) for (const name of targets) info.assigned.add(name);
    this.mod.assignments.push({ lhs: [ls, le], rhs: [rs, re], line });
    if (ctx.kind === 'seq' && (op === '=' || op === 'compound')) {
      const flagged = targets.filter(name => {
        if (ctx.locals.has(name) || ctx.loopVars.has(name) || this.mod.params.has(name)) return false;
        const sig = this.mod.signals.get(name);
        return !(sig && (EXEMPT_BLOCKING.has(sig.kind) || sig.local));
      });
      if (flagged.length) {
        const list = [...new Set(flagged)].map(n => `\`${n}\``).join(', ');
        this.addFinding('BLKSEQ', line, `Blocking \`=\` assigns ${list} inside a clocked always block.`, 'Use non-blocking `<=` for registers updated on a clock edge so every block sees the same pre-edge values.');
      }
    }
    if (ctx.kind === 'comb' && op === '<=') {
      const list = [...new Set(targets)].map(n => `\`${n}\``).join(', ') || 'a signal';
      this.addFinding('NONBLK', line, `Non-blocking \`<=\` assigns ${list} inside a combinational always block.`, 'Use blocking `=` in combinational logic so later statements see the updated value.');
    }
  }
}

function parseSource(file, source, macros) {
  const { tokens, text } = tokenize(source, macros);
  const modules = [];
  for (let i = 0; i < tokens.length; i++) {
    const tk = tokens[i];
    if (tk.k === 'kw' && (tk.v === 'module' || tk.v === 'macromodule')) {
      const parser = new ModuleParser(tokens, text, file, i, macros);
      const mod = parser.parse();
      mod.parser = parser;
      modules.push(mod);
      i = parser.i - 1;
    }
  }
  return modules;
}

// ---------------------------------------------------------------------------
// Rules that need the whole module (and other modules' port lists)

function checkWidths(mod) {
  const { parser } = mod;
  for (const a of mod.assignments) {
    const lhsNode = a.declInit ? { t: 'id', name: a.lhsName, selects: [] } : parseExpression(parser.t, ...a.lhs);
    const lw = a.declInit ? (() => { const s = mod.signals.get(a.lhsName); return s && !s.isArray && !s.parametric ? s.width : null; })() : lhsWidth(lhsNode, mod);
    if (lw == null) continue;
    const rhsNode = parseExpression(parser.t, ...a.rhs);
    const rw = widthOf(rhsNode, mod);
    if (!rw || rw.w <= lw) continue;
    const lhsText = a.declInit ? a.lhsName : parser.snippet(...a.lhs);
    const rhsText = parser.snippet(...a.rhs);
    const dropped = rw.w - lw;
    mod.findings.push({
      file: mod.file, line: a.line, severity: LINT_RULES.WIDTH_TRUNC.severity, rule: 'WIDTH_TRUNC',
      message: rw.flex
        ? `\`${rhsText}\` needs ${rw.w} bits but \`${lhsText}\` is ${lw} bit${lw === 1 ? '' : 's'} wide; the value is truncated.`
        : `\`${rhsText}\` is ${rw.w} bits wide but \`${lhsText}\` is ${lw} bit${lw === 1 ? '' : 's'}; the upper ${dropped} bit${dropped === 1 ? ' is' : 's are'} dropped.`,
      hint: `Match the widths, or select the intended bits explicitly (e.g. \`${rhsNode?.t === 'id' && rhsNode.name ? rhsNode.name : 'expr'}[${lw - 1}:0]\`).`,
    });
  }
}

function checkConnectivity(mod, portsByModule, macros) {
  if (mod.testbench || mod.ports.length === 0) return;
  const reads = new Set(mod.reads), drives = new Set(mod.drives);
  for (const inst of mod.instances) {
    const ports = portsByModule.get(inst.type);
    for (const conn of inst.conns) {
      if (conn.wildcard) continue;
      const dir = ports ? (conn.port != null ? ports.dirs.get(conn.port) : ports.dirs.get(ports.order[conn.position])) : null;
      const names = conn.names || [];
      if (dir === 'input') { for (const n of names) reads.add(n); continue; }
      if (dir === 'output') {
        for (const n of conn.lhs ? conn.lhs.targets : names) drives.add(n);
        for (const n of conn.lhs ? conn.lhs.indexReads : []) reads.add(n);
        continue;
      }
      for (const n of names) { reads.add(n); drives.add(n); }
    }
  }
  for (const name of mod.macrosUsed) {
    const body = macros.get(name);
    if (body) for (const m of body.matchAll(/[A-Za-z_][\w$]*/g)) { reads.add(m[0]); drives.add(m[0]); }
  }
  if (mod.wildcard) return;
  for (const sig of mod.signals.values()) {
    if (sig.isPort || sig.local || !UU_KINDS.has(sig.kind)) continue;
    const isRead = reads.has(sig.name), isDriven = drives.has(sig.name);
    if (!isDriven && isRead) {
      mod.findings.push({ file: mod.file, line: sig.line, severity: LINT_RULES.UNDRIVEN.severity, rule: 'UNDRIVEN',
        message: `\`${sig.name}\` is read but nothing assigns it or connects it to an instance output.`,
        hint: `Drive \`${sig.name}\` from an assign, an always block or an instance output, or remove it.` });
    } else if (!isRead) {
      mod.findings.push({ file: mod.file, line: sig.line, severity: LINT_RULES.UNUSED.severity, rule: 'UNUSED',
        message: isDriven ? `\`${sig.name}\` is assigned but never read.` : `\`${sig.name}\` is declared but never used.`,
        hint: `Remove \`${sig.name}\`, or connect it to the logic or output port that should use it.` });
    }
  }
}

// ---------------------------------------------------------------------------
// Synthesis-backed latches

export function parseSrcLocation(src) {
  if (typeof src !== 'string' || !src) return null;
  const first = src.split('|')[0].trim();
  const m = /^(.*?):(\d+)(?:\.\d+)?(?:-\d+(?:\.\d+)?)?$/.exec(first);
  if (!m) return null;
  const file = m[1].replace(/^\/?work\//, '').replace(/^\.\//, '');
  return file ? { file, line: Number(m[2]) } : null;
}

const LATCH_TYPES = new Set(['$dlatch', '$dlatchsr', '$adlatch', '$_DLATCH_P_', '$_DLATCH_N_']);

function latchFindings(yosysJson, includedFiles, excluded) {
  const modules = yosysJson && typeof yosysJson === 'object' ? yosysJson.modules : null;
  if (!modules || typeof modules !== 'object') return [];
  const byKey = new Map();
  const basenames = new Map();
  for (const path of includedFiles) {
    const base = path.split('/').pop();
    basenames.set(base, basenames.has(base) ? null : path);
  }
  for (const [modKey, mod] of Object.entries(modules)) {
    const cells = mod?.cells && typeof mod.cells === 'object' ? mod.cells : {};
    for (const [cellName, cell] of Object.entries(cells)) {
      if (!cell || !LATCH_TYPES.has(cell.type) && !/^\$_DLATCH/.test(cell.type || '')) continue;
      const loc = parseSrcLocation(cell.attributes?.src);
      if (!loc) continue;
      let file = loc.file;
      if (!includedFiles.has(file)) {
        const alt = basenames.get(file.split('/').pop());
        if (alt) file = alt;
        else if (excluded.has(file)) continue;
      }
      if (excluded.has(file)) continue;
      const signal = netnameFor(mod, cell.connections?.Q) || cellName.replace(/^\$\w+\$/, '');
      const moduleName = String(modKey).replace(/^\$paramod\\([^\\]+)\\.*$/, '$1');
      const key = `${file}:${loc.line}`;
      const entry = byKey.get(key) || { file, line: loc.line, signals: new Set(), modules: new Set() };
      entry.signals.add(signal);
      entry.modules.add(moduleName);
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].map(entry => {
    const signals = [...entry.signals].sort().map(s => `\`${s}\``).join(', ');
    const mods = [...entry.modules].sort().map(s => `\`${s}\``).join(', ');
    return {
      file: entry.file, line: entry.line, severity: LINT_RULES.LATCH_INFERRED.severity, rule: 'LATCH_INFERRED',
      message: `Synthesis inferred a latch for ${signals} in module ${mods}.`,
      hint: 'Assign it on every path of the combinational block (add an else/default, or a default value at the top), or make the block clocked.',
    };
  });
}

function netnameFor(mod, bits) {
  if (!Array.isArray(bits) || !bits.length || !mod?.netnames) return null;
  const want = bits.filter(b => typeof b === 'number');
  if (!want.length) return null;
  let best = null;
  for (const [name, net] of Object.entries(mod.netnames)) {
    const nb = Array.isArray(net?.bits) ? net.bits : [];
    if (!nb.includes(want[0])) continue;
    const score = (net.hide_name ? 0 : 2) + (want.every(b => nb.includes(b)) ? 1 : 0);
    if (!best || score > best.score) best = { name, score };
  }
  return best?.name ?? null;
}

// ---------------------------------------------------------------------------

function fileEntries(files) {
  if (!files) return [];
  const entries = files instanceof Map ? [...files.entries()] : Object.entries(files);
  return entries.map(([path, value]) => [path, typeof value === 'string' ? value : typeof value?.content === 'string' ? value.content : typeof value?.text === 'string' ? value.text : null]).filter(([, text]) => text != null);
}

export function lintRtl(files, { excluded = new Set(), yosysJson = null } = {}) {
  const skip = excluded instanceof Set ? excluded : new Set(excluded || []);
  const sources = fileEntries(files).filter(([path]) => /\.s?v$/i.test(path) && !skip.has(path));
  const macros = new Map();
  const modules = [];
  for (const [path, text] of sources) {
    try { modules.push(...parseSource(path, text, macros)); } catch { /* a file the parser cannot follow just yields no findings */ }
  }
  const portsByModule = new Map();
  for (const mod of modules) {
    const dirs = new Map();
    for (const name of mod.ports) dirs.set(name, mod.signals.get(name)?.dir || null);
    portsByModule.set(mod.name, { order: mod.ports, dirs });
  }
  const findings = [];
  for (const mod of modules) {
    checkWidths(mod);
    checkConnectivity(mod, portsByModule, macros);
    findings.push(...mod.findings);
  }
  findings.push(...latchFindings(yosysJson, new Set(sources.map(([p]) => p)), skip));
  const seen = new Set();
  const unique = findings.filter(f => {
    const key = `${f.rule}|${f.file}|${f.line}|${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return unique.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0) || a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0) || (a.message < b.message ? -1 : a.message > b.message ? 1 : 0));
}
