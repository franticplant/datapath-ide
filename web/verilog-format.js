// Token-aware Verilog/SystemVerilog indenter following Verible / Emacs verilog-mode conventions.
// Only leading whitespace changes; everything after the first character of a line (aligned columns,
// comments, strings) is kept verbatim, so formatting is idempotent by construction.
import { maskVerilog } from './verilog-lex.js';

const DIRECTIVES = new Set(['timescale', 'define', 'undef', 'undefineall', 'include', 'ifdef', 'ifndef', 'elsif', 'else', 'endif',
  'default_nettype', 'resetall', 'celldefine', 'endcelldefine', 'line', 'pragma', 'begin_keywords', 'end_keywords',
  'unconnected_drive', 'nounconnected_drive']);

// Blocks opened at statement start; `header` blocks run a declaration header up to the first `;`.
const BLOCKS = {
  module: { close: 'endmodule', header: true }, macromodule: { close: 'endmodule', header: true },
  interface: { close: 'endinterface', header: true }, program: { close: 'endprogram', header: true },
  package: { close: 'endpackage', header: true }, primitive: { close: 'endprimitive', header: true },
  class: { close: 'endclass', header: true }, function: { close: 'endfunction', header: true },
  task: { close: 'endtask', header: true }, begin: { close: 'end' }, generate: { close: 'endgenerate' },
  specify: { close: 'endspecify' }, table: { close: 'endtable' }, fork: { close: ['join', 'join_any', 'join_none'] },
};
const CLOSERS = new Set(['end', 'endcase', 'endmodule', 'endinterface', 'endprogram', 'endpackage', 'endprimitive', 'endclass',
  'endfunction', 'endtask', 'endgenerate', 'endspecify', 'endtable', 'join', 'join_any', 'join_none']);
const CASES = new Set(['case', 'casex', 'casez', 'randcase']);
const COND_HANGS = new Set(['if', 'for', 'while', 'repeat', 'wait', 'foreach']);
const PLAIN_HANGS = new Set(['else', 'forever', 'initial', 'final', 'always', 'always_ff', 'always_comb', 'always_latch', 'do']);
const PREFIXES = new Set(['unique', 'unique0', 'priority', 'virtual', 'static', 'automatic', 'protected', 'local', 'extern', 'pure', 'rand']);
const OPEN = { '(': ')', '[': ']', '{': '}' };
// Declaration continuations (`localparam A = 0,\n B = 1;`) align under the first declared name (verilog-mode style).
const DECL_KW = new Set(['input', 'output', 'inout', 'wire', 'reg', 'logic', 'integer', 'genvar', 'parameter', 'localparam', 'tri', 'wand', 'wor',
  'supply0', 'supply1', 'real', 'realtime', 'time', 'bit', 'byte', 'int', 'shortint', 'longint', 'var', 'signed', 'unsigned', 'specparam', 'event']);
const CLOSE = new Set([')', ']', '}']);

const TOKEN_RE = /\\\S+|`?[A-Za-z_][\w$]*|\$[\w$]*|\d[\d_]*\s*'[sS]?[bBoOdDhH]\s*[\w?]+|'[sS]?[bBoOdDhH]\s*[\w?]+|'[01xzXZ]|\d[\w.]*|::|[()[\]{};:#@,]|\S/g;

function normalizeTab(tabWidth) {
  const n = Number(tabWidth);
  return Number.isFinite(n) ? Math.max(0, Math.min(8, Math.floor(n))) : 2;
}

// Classify each line: directive/macro-continuation lines are kept out of the token stream; lines that start
// inside a block comment or a multi-line string are reported so their leading whitespace is handled specially.
function analyseLines(source) {
  const lines = source.split('\n');
  const masked = maskVerilog(source).split('\n');
  // Hide `(* attribute *)` instances from the parser (they would otherwise start a statement).
  for (let i = 0; i < masked.length; i++) masked[i] = masked[i].replace(/\(\*(?!\s*\))[^]*?\*\)/g, m => ' '.repeat(m.length));
  const inside = new Array(lines.length).fill(null); // null | 'comment' | 'string' at the line start
  const startsIn = [];
  let offset = 0;
  const ranges = [...source.matchAll(/\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:\\[\s\S]|[^"\\\n])*"?/g)]
    .map(m => [m.index, m.index + m[0].length, m[0][0] === '"' ? 'string' : 'comment']);
  let r = 0;
  const lineStart = [];
  for (let i = 0; i < lines.length; i++) { lineStart.push(offset); offset += lines[i].length + 1; }
  for (let i = 0; i < lines.length; i++) {
    const pos = lineStart[i];
    while (r < ranges.length && ranges[r][1] <= pos) r++;
    if (r < ranges.length && ranges[r][0] < pos && ranges[r][1] > pos) {
      inside[i] = ranges[r][2];
      // Find the line on which this protected range opened.
      let j = i - 1;
      while (j > 0 && lineStart[j] > ranges[r][0]) j--;
      startsIn[i] = j;
    }
  }
  const kind = new Array(lines.length).fill('code');
  let macro = false;
  for (let i = 0; i < lines.length; i++) {
    const m = inside[i] ? masked[i] : masked[i].trimStart();
    if (macro) { kind[i] = 'macro'; macro = /\\\s*$/.test(lines[i]); masked[i] = ''; continue; }
    const d = !inside[i] && /^`([A-Za-z_]\w*)/.exec(m);
    if (d && DIRECTIVES.has(d[1])) {
      kind[i] = 'directive';
      macro = d[1] === 'define' && /\\\s*$/.test(lines[i]);
      masked[i] = '';
    }
  }
  return { lines, masked, inside, startsIn, kind, ranges, lineStart };
}

function tokenizeLine(text, line) {
  const out = [];
  for (const m of text.matchAll(TOKEN_RE)) out.push({ t: m[0], line, pos: m.index });
  return out;
}

// The structural engine. `onLine(lineIndex, firstToken)` must return the formatted indent of that line;
// it is called before the line's tokens are consumed so parenthesis columns use formatted positions.
class Engine {
  constructor(tab) {
    this.tab = tab;
    this.stack = [{ type: 'block', kw: '', close: null, anchor: 0, body: 0, stmt: null, line: 0 }];
    this.parens = [];
    this.blocks = [];
    this.prev = null;
  }

  get top() { return this.stack[this.stack.length - 1]; }

  // Index of the effective top frame once if-frames waiting for `else` are resolved by a non-`else` token.
  effectiveTop() {
    let i = this.stack.length - 1;
    if (this.stack[i].type === 'if' && this.stack[i].phase === 'awaitElse') {
      i--;
      while (i > 0 && isSingle(this.stack[i])) i--;
    }
    return i;
  }

  indentFor(token) {
    if (this.parens.length) {
      const p = this.parens[this.parens.length - 1];
      if (token && CLOSE.has(token.t)) return p.base;
      return p.block ? p.base + this.tab : p.col + 1;
    }
    const top = this.top;
    if (token?.t === 'else' && top.type === 'if' && top.phase === 'awaitElse') return top.anchor;
    const idx = this.effectiveTop();
    if (token && CLOSERS.has(token.t)) {
      const match = this.findCloser(token.t, idx);
      if (match >= 0) return this.stack[match].anchor;
    }
    const f = this.stack[idx];
    if (f.stmt) return f.stmt.declCol ?? f.stmt.anchor + this.tab;
    if (f.phase === 'cond') return f.anchor + this.tab;
    return f.body;
  }

  findCloser(word, from) {
    for (let i = from; i > 0; i--) {
      const f = this.stack[i];
      if (f.type === 'block' && (Array.isArray(f.close) ? f.close.includes(word) : f.close === word)) return i;
      if (f.type === 'case' && word === 'endcase') return i;
    }
    return -1;
  }

  push(frame) { frame.blockIndex = this.blocks.length; this.blocks.push({ keyword: frame.kw, type: frame.type, line: frame.line + 1, endLine: null, anchor: frame.anchor }); this.stack.push(frame); }

  // Pop the top frame (ended on `line`) and propagate statement completion to its parent.
  complete(line) {
    const f = this.stack.pop();
    if (this.blocks[f.blockIndex]) this.blocks[f.blockIndex].endLine = (f.endLine ?? line) + 1;
    this.childDone(line);
  }

  childDone(line) {
    const p = this.top;
    if (p.type === 'if' && p.phase === 'body') { p.phase = 'awaitElse'; p.endLine = line; return; }
    if (isSingle(p) && p.phase === 'body') this.complete(line);
  }

  resolveElse(token) {
    while (this.top.type === 'if' && this.top.phase === 'awaitElse' && token.t !== 'else') this.complete(this.top.endLine);
  }

  // Anchor for a statement starting at `token` (column `col`) inside frame `f`.
  anchorFor(token, col, lineIndent, first, f) {
    if (first) return lineIndent;
    if (token.t === 'begin' || token.t === 'fork') return isSingle(f) ? f.anchor : lineIndent;
    if (token.t === 'if' && f.kw === 'else' && this.prev?.t === 'else') return f.anchor;
    if (f.type === 'item') return col;
    return lineIndent;
  }

  feed(token, col, lineIndent, first, next) {
    const t = token.t;
    if (this.skipLabel) {
      if (this.skipLabel === 1 && t === ':') { this.skipLabel = 2; this.prev = token; return; }
      if (this.skipLabel === 2 && /^[A-Za-z_\\]/.test(t)) { this.skipLabel = 0; this.prev = token; return; }
      this.skipLabel = 0;
    }
    if (this.parens.length) { this.bracket(token, col, lineIndent, next); this.prev = token; return; }
    this.resolveElse(token);
    const f = this.top;

    if (OPEN[t]) {
      if (!f.stmt && !(f.phase === 'cond') && this.atStart(f)) this.startStmt(token, col, lineIndent, first, f);
      this.bracket(token, col, lineIndent, next);
      this.prev = token;
      return;
    }
    if (CLOSE.has(t)) { this.prev = token; return; }

    // `else` either continues an if-frame or (stray) acts as a plain hang.
    if (t === 'else' && f.type === 'if' && f.phase === 'awaitElse') {
      f.type = 'hang'; f.kw = 'else'; f.phase = 'body'; f.stmt = null; f.endLine = undefined;
      this.prev = token;
      return;
    }

    // Closing keywords pop back to their opener.
    if (CLOSERS.has(t)) {
      const match = this.findCloser(t, this.stack.length - 1);
      if (match > 0) {
        while (this.stack.length - 1 > match) { const g = this.stack.pop(); if (this.blocks[g.blockIndex]) this.blocks[g.blockIndex].endLine = token.line + 1; }
        this.complete(token.line);
        if (next?.t === ':') this.skipLabel = 1;
        this.prev = token;
        return;
      }
    }

    // Timing-control condition (`@(...)`, `@*`, `#5`).
    if (f.phase === 'cond') {
      if (f.kw === '@' || f.kw === '#') { f.phase = 'body'; this.prev = token; return; }
      f.phase = 'body'; // `if` without parentheses (malformed): treat the token as the body.
    }

    if (t === ';') {
      if (f.stmt) { f.stmt = null; if (isSingle(f)) this.complete(token.line); else if (f.type === 'if') { f.phase = 'awaitElse'; f.endLine = token.line; } }
      else if (isSingle(f) || f.type === 'if') {
        if (f.type === 'if' && f.phase === 'body') { f.phase = 'awaitElse'; f.endLine = token.line; } else this.complete(token.line);
      }
      this.prev = token;
      return;
    }

    if (f.type === 'case' && !f.stmt && f.phase !== 'cond') {
      // A case-item label starts here.
      f.stmt = { anchor: first ? lineIndent : lineIndent, label: true };
      if (t === 'default' && next?.t !== ':') this.openItem(f, token);
      this.prev = token;
      return;
    }
    if (f.type === 'case' && f.stmt?.label && t === ':') { this.openItem(f, token); this.prev = token; return; }

    if (this.atStart(f) && !f.stmt) {
      if (PREFIXES.has(t)) { if (t === 'extern' || t === 'pure') this.plainNext = true; this.prev = token; return; }
      const anchor = this.anchorFor(token, col, lineIndent, first, f);
      const plain = this.plainNext || ((t === 'fork') && (this.prev?.t === 'wait' || this.prev?.t === 'disable'));
      this.plainNext = false;
      if (!plain && BLOCKS[t]) {
        const spec = BLOCKS[t];
        this.push({ type: 'block', kw: t, close: spec.close, anchor, body: anchor + this.tab, stmt: spec.header ? { anchor } : null, line: token.line });
        if (!spec.header && next?.t === ':') this.skipLabel = 1;
      } else if (!plain && CASES.has(t)) {
        this.push({ type: 'case', kw: t, anchor, body: anchor + this.tab, stmt: null, phase: 'cond', line: token.line });
      } else if (!plain && (COND_HANGS.has(t) || t === '@' || t === '#')) {
        this.push({ type: t === 'if' ? 'if' : 'hang', kw: t, anchor, body: anchor + this.tab, stmt: null, phase: 'cond', line: token.line });
      } else if (!plain && PLAIN_HANGS.has(t)) {
        this.push({ type: 'hang', kw: t, anchor, body: anchor + this.tab, stmt: null, phase: 'body', line: token.line });
      } else {
        f.stmt = { anchor, decl: DECL_KW.has(t) ? token.line : -1 };
      }
    } else if (f.stmt && f.stmt.decl === token.line && f.stmt.declCol == null && /^[A-Za-z_\\]/.test(t) && !DECL_KW.has(t)) {
      f.stmt.declCol = col; // first declared name on the declaration's opening line
    }
    this.prev = token;
  }

  atStart(f) {
    if (f.type === 'block') return true;
    if (f.type === 'case') return f.phase !== 'cond';
    return f.phase === 'body';
  }

  startStmt(token, col, lineIndent, first, f) {
    if (f.type === 'case' && f.phase !== 'cond') { f.stmt = { anchor: lineIndent, label: true }; return; }
    f.stmt = { anchor: this.anchorFor(token, col, lineIndent, first, f) };
  }

  openItem(caseFrame, token) {
    const anchor = caseFrame.stmt.anchor;
    caseFrame.stmt = null;
    this.push({ type: 'item', kw: 'item', anchor, body: anchor + this.tab, stmt: null, phase: 'body', line: token.line });
  }

  bracket(token, col, lineIndent, next) {
    const t = token.t;
    if (OPEN[t]) {
      const block = !next || next.line !== token.line;
      this.parens.push({ ch: t, col, base: lineIndent, block });
      return;
    }
    if (CLOSE.has(t)) {
      this.parens.pop();
      if (!this.parens.length) {
        const f = this.top;
        if (f.phase === 'cond') f.phase = 'body';
      }
    }
  }
}

function isSingle(f) { return f.type === 'hang' || f.type === 'item'; }

// Walk the source, calling the engine for every line. Returns { indents, shifts, blocks } plus the analysis.
function run(source, tab) {
  const info = analyseLines(source);
  const { lines, masked, inside, startsIn, kind } = info;
  const engine = new Engine(tab);
  const tokens = [];
  for (let i = 0; i < lines.length; i++) if (kind[i] === 'code') tokens.push(...tokenizeLine(masked[i], i));
  const out = new Array(lines.length);
  const shift = new Array(lines.length).fill(0);
  let k = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lead = line.match(/^[ \t]*/)[0].length;
    let indent;
    let outLine;
    if (kind[i] === 'macro' || inside[i] === 'string') {
      outLine = line; indent = lead;
    } else if (inside[i] === 'comment') {
      const delta = shift[startsIn[i]] || 0;
      const keep = Math.max(0, lead + delta);
      indent = keep;
      outLine = line.trim() ? ' '.repeat(keep) + line.slice(lead) : '';
      shift[i] = delta;
    } else if (kind[i] === 'directive') {
      indent = 0; outLine = line.slice(lead);
    } else {
      const first = tokens[k]?.line === i ? tokens[k] : null;
      indent = engine.indentFor(first);
      outLine = line.slice(lead).length ? ' '.repeat(indent) + line.slice(lead) : '';
      shift[i] = indent - lead;
    }
    const base = outLine.length - line.length; // column offset applied to every original position on this line
    let firstOnLine = true;
    while (k < tokens.length && tokens[k].line === i) {
      const tok = tokens[k];
      const col = tok.pos + base;
      engine.feed(tok, col, indent, firstOnLine && !inside[i], tokens[k + 1]);
      firstOnLine = false;
      k++;
    }
    out[i] = outLine;
  }
  for (const b of engine.blocks) if (b.endLine == null) b.endLine = lines.length;
  return { out, blocks: engine.blocks, info };
}


export function formatVerilog(source, { tabWidth = 2 } = {}) {
  if (typeof source !== 'string' || !source) return typeof source === 'string' ? source : '';
  source = source.replace(/\r\n?/g, '\n');
  const tab = normalizeTab(tabWidth);
  const { out, info } = run(source, tab);
  const result = out.map((line, i) => {
    const nextInString = info.inside[i + 1] === 'string' || info.kind[i + 1] === 'macro';
    return nextInString ? line : line.replace(/[ \t]+$/, '');
  });
  return result.join('\n');
}

// Structural outline used by rtl-quickfix.js: every block/statement frame with 1-based start/end lines.
export function verilogBlocks(source, { tabWidth = 2 } = {}) {
  if (typeof source !== 'string') return [];
  return run(source.replace(/\r\n?/g, '\n'), normalizeTab(tabWidth)).blocks;
}

// Tokens of the masked source (comments, strings, attributes and directives removed) with 0-based lines.
export function tokenizeVerilog(source) {
  if (typeof source !== 'string') return [];
  const { masked, kind } = analyseLines(source.replace(/\r\n?/g, '\n'));
  const tokens = [];
  for (let i = 0; i < masked.length; i++) if (kind[i] === 'code') tokens.push(...tokenizeLine(masked[i], i));
  return tokens;
}
