import assert from 'node:assert/strict';
import { formatVerilog } from '../../web/verilog-format.js';
import { computeQuickFix, applyQuickFix, extractFileSymbols, buildInstantiationTemplate } from '../../web/rtl-quickfix.js';
import { lintRtl } from '../../web/rtl-linter.js';
import { analyzeResources } from '../../web/rtl-metrics.js';
import { SHOWCASE_PROJECTS, showcaseProject } from '../../web/showcase-projects.js';
import { MIPS_TEMPLATE } from '../../web/mips-template.js';
import { compileVvp, elaborateJson } from '../correctness/helpers.mjs';

let checks = 0;
async function check(name, fn) {
  try { await fn(); checks++; } catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const fmt = (src, opts) => formatVerilog(src, opts);
const idem = (src, opts) => { const a = fmt(src, opts); assert.equal(fmt(a, opts), a, 'formatVerilog is not idempotent'); return a; };
const dedent = src => src.split('\n').map(l => l.trimStart()).join('\n');
const MIPS_CPU = showcaseProject('mips-cpu').files['mips_cpu.v'];
const FSM = showcaseProject('fsm-control').files['multicycle_fsm.v'];

// ---------------------------------------------------------------------------
// formatVerilog

await check('mips_cpu.v is already formatted: aligned instantiations survive byte-for-byte', () => {
  assert.equal(fmt(MIPS_CPU), MIPS_CPU);
  const out = fmt(MIPS_CPU).split('\n');
  for (const inst of ['u_ctrl', 'u_imem', 'u_rf', 'u_alu', 'u_dmem']) {
    const at = out.findIndex(l => l.includes(` ${inst}(`));
    assert.ok(at > 0, inst);
    assert.equal(out[at], MIPS_CPU.split('\n')[at]);
  }
  assert.ok(out.includes('  mips_imem    u_imem(.addr(pc), .instr(instr));'));
  assert.ok(out.includes('                      .jump(jump), .alu_op(alu_op));'));
});

await check('fully dedented mips_cpu.v is restored exactly (continuations at openParenCol + 1)', () => {
  assert.equal(idem(dedent(MIPS_CPU)), MIPS_CPU);
  assert.equal(idem(dedent(FSM)), FSM);
});

await check('smashed continuation lines realign under the open paren', () => {
  const src = `module top;
  mips_control u_ctrl(.op(op), .funct(funct),
  .reg_write(reg_write),
      .jump(jump));
  assign y = f(a,
  g(b,
  c), d);
endmodule
`;
  assert.equal(idem(src), `module top;
  mips_control u_ctrl(.op(op), .funct(funct),
                      .reg_write(reg_write),
                      .jump(jump));
  assign y = f(a,
               g(b,
                 c), d);
endmodule
`);
});

await check('block-style port and parameter lists indent +tab and dedent on the closer', () => {
  const src = `module fifo #(
parameter W = 8,
    parameter D = 4
    ) (
input clk,
        output [W-1:0] q
        );
foo #(
.W(W)
) u_foo (
.a(a),
.b({c,
d})
);
endmodule`;
  assert.equal(idem(src), `module fifo #(
  parameter W = 8,
  parameter D = 4
) (
  input clk,
  output [W-1:0] q
);
  foo #(
    .W(W)
  ) u_foo (
    .a(a),
    .b({c,
        d})
  );
endmodule`);
  assert.equal(idem(src, { tabWidth: 4 }).split('\n')[1], '    parameter W = 8,');
});

await check('single-statement always / if / else bodies, else-if chains and loops', () => {
  const src = `module m(input clk, input reset, input en, input [3:0] d, output reg [3:0] q);
integer i;
always @(posedge clk)
if (reset)
q <= 0;
else if (en)
q <= d;
else
q <= q;
always @(posedge clk) begin
for (i = 0; i < 4; i = i + 1)
if (d[i])
q[i] <= 1'b1;
end
initial
begin
#1;
end
endmodule`;
  assert.equal(idem(src), `module m(input clk, input reset, input en, input [3:0] d, output reg [3:0] q);
  integer i;
  always @(posedge clk)
    if (reset)
      q <= 0;
    else if (en)
      q <= d;
    else
      q <= q;
  always @(posedge clk) begin
    for (i = 0; i < 4; i = i + 1)
      if (d[i])
        q[i] <= 1'b1;
  end
  initial
    begin
      #1;
    end
endmodule`);
});

await check('if/else with begin-end and aligned else on the following line', () => {
  const src = `module m;
always @(*) begin
if (a) begin
y = 1;
end else begin
y = 0;
end
end
always @(posedge clk)
if (reset)            pc <= 32'd0;
else if (jump)        pc <= 32'd4;
else                  pc <= pc;
endmodule`;
  assert.equal(idem(src), `module m;
  always @(*) begin
    if (a) begin
      y = 1;
    end else begin
      y = 0;
    end
  end
  always @(posedge clk)
    if (reset)            pc <= 32'd0;
    else if (jump)        pc <= 32'd4;
    else                  pc <= pc;
endmodule`);
});

await check('case items, multi-line item bodies, nested case, default and statement continuations', () => {
  const src = `module m;
always @(*) begin
case (sel)
2'd0: y = a;
2'd1: begin
y = b;
case (sub)
1'b0: z = 0;
default: z = 1;
endcase
end
2'd2:
y = a +
b;
EXEC:   if (op == 6'h23) y = 1;
else         y = 0;
default: ;
endcase
end
assign w = s ? a :
b;
endmodule`;
  assert.equal(idem(src), `module m;
  always @(*) begin
    case (sel)
      2'd0: y = a;
      2'd1: begin
        y = b;
        case (sub)
          1'b0: z = 0;
          default: z = 1;
        endcase
      end
      2'd2:
        y = a +
          b;
      EXEC:   if (op == 6'h23) y = 1;
              else         y = 0;
      default: ;
    endcase
  end
  assign w = s ? a :
    b;
endmodule`);
});

await check('block comments keep internal alignment, strings and // comments are untouched', () => {
  const src = `module m;
/* begin
 * end
 */
initial begin
$display("begin ( // end");   // end )
end
endmodule`;
  const out = idem(src);
  assert.equal(out, `module m;
  /* begin
   * end
   */
  initial begin
    $display("begin ( // end");   // end )
  end
endmodule`);
  // Comment continuation lines move with their opening line and keep relative alignment.
  assert.equal(idem('module m;\n    /* a\n       b */\nendmodule'), 'module m;\n  /* a\n     b */\nendmodule');
});

await check('preprocessor directives stay in column 0 and macro bodies are untouched', () => {
  const src = `  \`timescale 1ns/1ps
  \`default_nettype none
  \`define MAX(a, b) ((a) > (b) ? \\
      (a) : (b))
module m;
  \`ifdef SIM
initial $display("sim");
    \`else
initial $display("syn");
      \`endif
  \`include "defs.vh"
  wire [7:0] x = \`MAX(1, 2);
endmodule`;
  assert.equal(idem(src), `\`timescale 1ns/1ps
\`default_nettype none
\`define MAX(a, b) ((a) > (b) ? \\
      (a) : (b))
module m;
\`ifdef SIM
  initial $display("sim");
\`else
  initial $display("syn");
\`endif
\`include "defs.vh"
  wire [7:0] x = \`MAX(1, 2);
endmodule`);
});

await check('declaration continuations align under the first name; functions, tasks, generate and fork', () => {
  const src = `module m;
localparam [3:0] A = 4'd0, B = 4'd1,
C = 4'd2;
generate
for (genvar i = 0; i < 4; i = i + 1) begin : g
assign w[i] = x[i];
end
endgenerate
function [3:0] inc(input [3:0] v);
begin
inc = v + 1;
end
endfunction
task t;
fork
#1 a = 1;
join
endtask
endmodule : m`;
  assert.equal(idem(src), `module m;
  localparam [3:0] A = 4'd0, B = 4'd1,
                   C = 4'd2;
  generate
    for (genvar i = 0; i < 4; i = i + 1) begin : g
      assign w[i] = x[i];
    end
  endgenerate
  function [3:0] inc(input [3:0] v);
    begin
      inc = v + 1;
    end
  endfunction
  task t;
    fork
      #1 a = 1;
    join
  endtask
endmodule : m`);
});

await check('CRLF, tabs, trailing whitespace and tabWidth handling', () => {
  assert.equal(fmt('module m;\r\n\twire a;   \r\n\r\nendmodule\r\n'), 'module m;\n  wire a;\n\nendmodule\n');
  assert.equal(fmt('module m;\nwire a;\nendmodule', { tabWidth: 4 }), 'module m;\n    wire a;\nendmodule');
  assert.equal(fmt('module m;\nwire a;\nendmodule', { tabWidth: 'x' }), 'module m;\n  wire a;\nendmodule');
  assert.equal(fmt(''), '');
});

await check('robust on malformed / truncated input (never throws, keeps every line)', () => {
  const samples = ['end end endcase )))', 'module m(\n input a,\n', 'always @(posedge clk\n begin', 'if (a)\nelse\nelse', 'case (x)\n1:\n', '/* unterminated\n comment', '"unterminated\nstring', 'module m; begin : lbl end endmodule : m', '(* keep *) wire a;\n(* full_case *) case (x) endcase'];
  for (const s of samples) {
    const out = idem(s);
    assert.equal(out.split('\n').length, s.split('\n').length, s);
    assert.deepEqual(out.split('\n').map(l => l.trim()), s.split('\n').map(l => l.trim()));
  }
});

await check('idempotent and content-preserving on every showcase and template file', () => {
  let files = 0;
  const all = [...SHOWCASE_PROJECTS.flatMap(p => Object.entries(p.files)), ...Object.entries(MIPS_TEMPLATE)];
  for (const [name, text] of all) {
    if (!/\.s?v$/.test(name)) continue;
    for (const tabWidth of [2, 4]) {
      const out = idem(text, { tabWidth });
      assert.deepEqual(out.split('\n').map(l => l.trim()), text.split('\n').map(l => l.trim()), name);
    }
    assert.equal(idem(dedent(text)), fmt(text), name);
    files++;
  }
  assert.ok(files >= 15, `files=${files}`);
});

await check('every showcase project is already in canonical form', () => {
  for (const project of SHOWCASE_PROJECTS) {
    for (const [name, text] of Object.entries(project.files)) {
      if (/\.s?v$/.test(name)) assert.equal(fmt(text), text, `${project.id}/${name}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Quick fixes

const lintOne = (src, rule) => lintRtl({ 'dut.v': src }).filter(f => f.rule === rule);
async function compiles(src, top) {
  const r = await compileVvp({ 'dut.v': src }, { top });
  assert.ok(r.ok, r.log);
  assert.deepEqual(r.diagnostics, [], r.log);
  const e = await elaborateJson({ 'dut.v': src }, { top });
  assert.ok(e.ok, e.log);
  const res = analyzeResources(e.yosysJson, top);
  assert.equal(res.total.latchCells, 0, 'latch left behind');
  assert.ok(!lintRtl({ 'dut.v': src }, { yosysJson: e.yosysJson }).some(f => f.rule === 'LATCH_INFERRED'));
  return res;
}

await check('BLKSEQ fix swaps the flagged `=` for `<=`, ignoring ==, comments and strings', async () => {
  const src = `module r(input clk, input [3:0] d, output reg [3:0] q, output reg [3:0] s);
  always @(posedge clk) begin
    if (d == 4'd3 && d != 4'd4) q = d; // a = b
    s <= (d >= 4'd2) ? d : 4'd0;
  end
endmodule
`;
  const [diag] = lintOne(src, 'BLKSEQ');
  assert.equal(diag.line, 3);
  const fix = computeQuickFix(src, diag);
  assert.equal(fix.rule, 'BLKSEQ');
  assert.match(fix.title, /<=/);
  assert.deepEqual(fix.edits, [{ fromLine: 3, toLine: 3, text: "    if (d == 4'd3 && d != 4'd4) q <= d; // a = b" }]);
  const fixed = applyQuickFix(src, fix);
  assert.deepEqual(lintOne(fixed, 'BLKSEQ'), []);
  assert.equal(fixed.split('\n').length, src.split('\n').length);
  await compiles(fixed, 'r');
});

await check('BLKSEQ fix targets only the flagged signal on a busy line', () => {
  const src = `module r(input clk, input [3:0] d, output reg [3:0] q);
  integer i;
  always @(posedge clk) begin i = 0; q = d; end
endmodule
`;
  const [diag] = lintOne(src, 'BLKSEQ');
  const fixed = applyQuickFix(src, computeQuickFix(src, diag));
  assert.equal(fixed.split('\n')[2], '  always @(posedge clk) begin i = 0; q <= d; end');
  assert.deepEqual(lintOne(fixed, 'BLKSEQ'), []);
});

await check('NONBLK fix swaps the assignment `<=` for `=`, leaving comparisons alone', async () => {
  const src = `module c(input [3:0] a, input [3:0] b, output reg [3:0] y, output reg z);
  always @(*) begin
    y <= a & b;
    if (a <= b) z <= 1'b1; else z = 1'b0;
  end
endmodule
`;
  const diags = lintOne(src, 'NONBLK');
  assert.deepEqual(diags.map(d => d.line), [3, 4]);
  let fixed = src;
  for (const line of [3, 4]) {
    const diag = lintOne(fixed, 'NONBLK').find(d => d.line === line);
    const fix = computeQuickFix(fixed, diag);
    assert.equal(fix.edits[0].fromLine, line);
    fixed = applyQuickFix(fixed, fix);
  }
  assert.equal(fixed.split('\n')[2], '    y = a & b;');
  assert.equal(fixed.split('\n')[3], "    if (a <= b) z = 1'b1; else z = 1'b0;");
  assert.deepEqual(lintOne(fixed, 'NONBLK'), []);
  await compiles(fixed, 'c');
});

await check('INCOMPLETE_CASE fix inserts an indented default before endcase and removes the latch', async () => {
  const src = `module dec(input [1:0] s, input a, input b, output reg y);
  always @(*) begin
    case (s)
      2'd0: y = a;
      2'd1: y = b;
    endcase
  end
endmodule
`;
  const before = await elaborateJson({ 'dut.v': src }, { top: 'dec' });
  assert.ok(analyzeResources(before.yosysJson, 'dec').total.latchCells >= 1);
  const [diag] = lintOne(src, 'INCOMPLETE_CASE');
  const fix = computeQuickFix(src, diag);
  assert.equal(fix.rule, 'INCOMPLETE_CASE');
  assert.match(fix.title, /default/);
  assert.deepEqual(fix.edits, [{ fromLine: 6, toLine: 6, text: '      default: y = 0;\n    endcase' }]);
  const fixed = applyQuickFix(src, fix);
  assert.equal(fixed, src.replace('    endcase', '      default: y = 0;\n    endcase'));
  assert.deepEqual(lintOne(fixed, 'INCOMPLETE_CASE'), []);
  assert.equal(fmt(fixed), fixed);
  await compiles(fixed, 'dec');
});

await check('INCOMPLETE_CASE fix covers several targets (concatenation, nested case) with a begin/end default', async () => {
  const src = `module dec2(input [1:0] s, input [3:0] a, output reg [3:0] y, output reg p, output reg q);
  always @(*)
    casez (s)
      2'b00: begin y = a; {p, q} = 2'b01; end
      2'b01: begin
        y = ~a;
        case (a[0])
          1'b0: begin p = 1'b0; q = 1'b0; end
          default: begin p = 1'b1; q = 1'b1; end
        endcase
      end
      2'b1?: begin y = 4'd0; p = 1'b1; q = 1'b0; end
    endcase
endmodule
`;
  const [diag] = lintOne(src, 'INCOMPLETE_CASE');
  assert.equal(diag.line, 3);
  const fix = computeQuickFix(src, diag);
  assert.deepEqual(fix.edits[0], { fromLine: 13, toLine: 13, text: '      default: begin\n        y = 0;\n        p = 0;\n        q = 0;\n      end\n    endcase' });
  const fixed = applyQuickFix(src, fix);
  assert.deepEqual(lintOne(fixed, 'INCOMPLETE_CASE'), []);
  assert.equal(fmt(fixed), fixed);
  await compiles(fixed, 'dec2');
});

await check('INCOMPLETE_CASE fix on a one-line case keeps it on one line', async () => {
  const src = `module one(input s, input a, output reg y);
  always @* case (s) 1'b1: y = a; endcase
endmodule
`;
  const [diag] = lintOne(src, 'INCOMPLETE_CASE');
  const fixed = applyQuickFix(src, computeQuickFix(src, diag));
  assert.equal(fixed.split('\n')[1], "  always @* case (s) 1'b1: y = a; default: y = 0; endcase");
  assert.deepEqual(lintOne(fixed, 'INCOMPLETE_CASE'), []);
  await compiles(fixed, 'one');
});

await check('quick-fix edge cases: unknown rules, bad lines, CRLF, multi-edit ordering', () => {
  const src = 'module m;\nendmodule\n';
  assert.equal(computeQuickFix(src, { rule: 'UNUSED', line: 1 }), null);
  assert.equal(computeQuickFix(src, { rule: 'BLKSEQ', line: 99 }), null);
  assert.equal(computeQuickFix(src, { rule: 'BLKSEQ', line: 1 }), null);
  assert.equal(computeQuickFix(src, null), null);
  assert.equal(computeQuickFix(null, { rule: 'BLKSEQ', line: 1 }), null);
  assert.equal(applyQuickFix(src, null), src);
  const crlf = 'module r(input clk, input d, output reg q);\r\n  always @(posedge clk) q = d;\r\nendmodule\r\n';
  const fixed = applyQuickFix(crlf, computeQuickFix(crlf, { rule: 'BLKSEQ', line: 2, message: 'Blocking `=` assigns `q`' }));
  assert.equal(fixed, crlf.replace('q = d', 'q <= d'));
  const multi = applyQuickFix('a\nb\nc\nd', { edits: [{ fromLine: 1, toLine: 1, text: 'A\nA2' }, { fromLine: 3, toLine: 4, text: 'CD' }] });
  assert.equal(multi, 'A\nA2\nb\nCD');
});

// ---------------------------------------------------------------------------
// Symbols

const sym = (list, name, kind) => list.find(s => s.name === name && (!kind || s.kind === kind));

await check('extractFileSymbols on mips_cpu.v: modules, ports, nets, regs, always blocks', () => {
  const s = extractFileSymbols(MIPS_CPU);
  const lines = MIPS_CPU.split('\n');
  const lineOf = re => lines.findIndex(l => re.test(l)) + 1;
  const modules = s.filter(x => x.kind === 'module');
  assert.deepEqual(modules.map(m => m.name), ['mips_cpu', 'mips_control', 'mips_alu', 'mips_regfile', 'mips_imem', 'mips_dmem']);
  const cpu = modules[0];
  assert.equal(cpu.line, 4);
  assert.equal(cpu.endLine, lineOf(/^endmodule/));
  assert.equal(cpu.detail, 'module mips_cpu(clk, reset, pc_out)');
  assert.equal(cpu.scope, '');
  assert.deepEqual(s.filter(x => x.kind === 'port' && x.scope === 'mips_cpu').map(p => [p.name, p.direction, p.width]), [['clk', 'input', 1], ['reset', 'input', 1], ['pc_out', 'output', 32]]);
  assert.deepEqual({ ...sym(s, 'pc', 'reg') }, { name: 'pc', kind: 'reg', line: 5, detail: 'reg [31:0] pc', scope: 'mips_cpu', width: 32 });
  assert.equal(sym(s, 'funct', 'wire').width, 6);
  assert.equal(sym(s, 'funct', 'wire').detail, 'wire [5:0] funct = instr[5:0]');
  assert.equal(sym(s, 'take_branch', 'wire').width, 1);
  assert.ok(sym(s, 'jump', 'wire'));
  // mips_control: `output reg reg_dst, alu_src, ...` inherits direction and type.
  const ctrlPorts = s.filter(x => x.kind === 'port' && x.scope === 'mips_control');
  assert.equal(ctrlPorts.length, 11);
  assert.deepEqual(ctrlPorts.slice(2, 4).map(p => p.detail), ['output reg reg_dst', 'output reg alu_src']);
  assert.equal(ctrlPorts.at(-1).detail, 'output reg [2:0] alu_op');
  const always = s.filter(x => x.kind === 'always');
  assert.equal(always.length, 5);
  const pcAlways = always[0];
  assert.equal(pcAlways.name, 'always @(posedge clk)');
  assert.equal(pcAlways.scope, 'mips_cpu');
  assert.equal(pcAlways.line, lineOf(/always @\(posedge clk\)$/));
  assert.equal(pcAlways.endLine, pcAlways.line + 4);
  const ctrlAlways = always.find(a => a.scope === 'mips_control');
  assert.equal(ctrlAlways.name, 'always @(*)');
  assert.equal(ctrlAlways.endLine, lineOf(/^ {2}end$/));
  const regs = sym(s.filter(x => x.scope === 'mips_regfile'), 'regs', 'reg');
  assert.equal(regs.detail, 'reg [31:0] regs [0:31]');
  assert.ok(!s.some(x => x.name === 'i'), 'integers are not listed');
  for (const x of s) assert.ok(x.line >= 1 && x.line <= lines.length && typeof x.detail === 'string');
});

await check('extractFileSymbols on multicycle_fsm.v: localparams with widths, state regs, two always kinds', () => {
  const s = extractFileSymbols(FSM);
  const params = s.filter(x => x.kind === 'param');
  assert.deepEqual(params.map(p => p.name), ['FETCH', 'DECODE', 'EXEC', 'MEM', 'WRITEBACK']);
  assert.ok(params.every(p => p.width === 3 && p.line === 8 && p.scope === 'multicycle_fsm'));
  assert.equal(params[1].detail, "localparam [2:0] DECODE = 3'd1");
  assert.deepEqual(s.filter(x => x.kind === 'reg').map(r => [r.name, r.width]), [['state', 3], ['next_state', 3]]);
  assert.deepEqual(s.filter(x => x.kind === 'always').map(a => [a.name, a.line, a.endLine]), [['always @(posedge clk)', 13, 15], ['always @(*)', 18, 31], ['always @(*)', 34, 45]]);
  const ports = s.filter(x => x.kind === 'port');
  assert.equal(ports.length, 10);
  assert.deepEqual(sym(s, 'alu_src_b', 'port'), { name: 'alu_src_b', kind: 'port', line: 7, detail: 'output reg [1:0] alu_src_b', scope: 'multicycle_fsm', direction: 'output', width: 2 });
  // The testbench's task and its locals are scoped below the module.
  const tb = extractFileSymbols(showcaseProject('fsm-control').files['fsm_tb.v']);
  const task = sym(tb, 'run_instr', 'task');
  assert.equal(task.scope, 'fsm_tb');
  assert.equal(task.detail, 'task run_instr');
  assert.ok(task.endLine > task.line);
  assert.ok(!tb.some(x => x.kind === 'port'), 'task arguments are not ports');
});

await check('extractFileSymbols: non-ANSI ports, header parameters, functions and SV logic', () => {
  const src = `module old(clk, rst, q);
  parameter W = 4, D = W * 2;
  input clk, rst;
  output [W-1:0] q;
  reg [W-1:0] q;
  logic [D-1:0] wide;
  function [W-1:0] inc;
    input [W-1:0] v;
    reg [W-1:0] t;
    begin t = v + 1; inc = t; end
  endfunction
  always_ff @(posedge clk) q <= inc(q);
endmodule
module p #(parameter integer WIDTH = 16, DEPTH = 1 << 3) (input wire [WIDTH-1:0] din, output logic [$clog2(DEPTH)-1:0] cnt);
endmodule`;
  const s = extractFileSymbols(src);
  assert.deepEqual(s.filter(x => x.kind === 'port' && x.scope === 'old').map(p => [p.name, p.direction, p.width]), [['clk', 'input', 1], ['rst', 'input', 1], ['q', 'output', 4]]);
  assert.equal(sym(s, 'q', 'reg').width, 4);
  assert.equal(sym(s, 'wide', 'logic').width, 8);
  assert.equal(sym(s, 'inc', 'function').detail, 'function [W-1:0] inc');
  assert.equal(sym(s, 'inc', 'function').endLine, 11);
  assert.equal(sym(s, 't', 'reg').scope, 'old.inc');
  assert.ok(!s.some(x => x.name === 'v' && x.kind === 'port'));
  assert.equal(sym(s, 'always_ff @(posedge clk)', 'always').line, 12);
  assert.deepEqual(s.filter(x => x.kind === 'param').map(p => [p.name, p.scope, p.value]), [['W', 'old', '4'], ['D', 'old', 'W * 2'], ['WIDTH', 'p', '16'], ['DEPTH', 'p', '1 << 3']]);
  assert.equal(sym(s, 'din', 'port').width, 16);
  assert.equal(sym(s, 'cnt', 'port').width, 3);
  assert.equal(sym(s, 'p', 'module').detail, 'module p(din, cnt)');
  assert.deepEqual(extractFileSymbols(''), []);
  assert.deepEqual(extractFileSymbols(null), []);
  assert.doesNotThrow(() => extractFileSymbols('module (;; input [ output'));
});

// ---------------------------------------------------------------------------
// Instantiation builder

await check('buildInstantiationTemplate: mips_alu and mips_regfile from the showcase workspace', async () => {
  const files = showcaseProject('mips-cpu').files;
  assert.equal(buildInstantiationTemplate('mips_alu', files), `mips_alu u_mips_alu (
  .a(a),
  .b(b),
  .op(op),
  .y(y),
  .zero(zero)
);`);
  const rf = buildInstantiationTemplate('mips_regfile', files, { instanceName: 'u_rf', tabWidth: 4 });
  assert.equal(rf, `mips_regfile u_rf (
    .clk(clk),
    .we(we),
    .ra(ra),
    .rb(rb),
    .wa(wa),
    .wd(wd),
    .a(a),
    .b(b)
);`);
  assert.equal(buildInstantiationTemplate('nope', files), null);
  assert.equal(buildInstantiationTemplate('mips_alu', {}), null);
  // The generated text drops into a wrapper and compiles cleanly.
  const wrapper = `module wrap;\n  wire [31:0] a, b, y;\n  wire [2:0] op;\n  wire zero;\n${buildInstantiationTemplate('mips_alu', files).replace(/^/gm, '  ')}\nendmodule\n`;
  assert.equal(fmt(wrapper), wrapper);
  const r = await compileVvp({ 'alu.v': files['mips_cpu.v'], 'wrap.v': wrapper }, { top: 'wrap' });
  assert.ok(r.ok, r.log);
});

await check('buildInstantiationTemplate: parameterized and non-ANSI modules', async () => {
  const files = {
    'notes.txt': 'module fifo; (not HDL)',
    'fifo.v': `module fifo #(parameter WIDTH = 8, parameter DEPTH = 16, parameter AW = $clog2(DEPTH)) (
  input clk,
  input [WIDTH-1:0] din,
  output [WIDTH-1:0] dout
);
  localparam HIDDEN = 1;
  assign dout = din;
endmodule`,
    'old.v': `module old(clk, rst, q);
  input clk, rst;
  output [7:0] q;
  reg [7:0] q;
  always @(posedge clk) q <= rst ? 8'd0 : q + 8'd1;
endmodule
module empty;
endmodule`,
  };
  const fifo = buildInstantiationTemplate('fifo', files, { instanceName: 'u_fifo' });
  assert.equal(fifo, `fifo #(
  .WIDTH(8),
  .DEPTH(16)
) u_fifo (
  .clk(clk),
  .din(din),
  .dout(dout)
);`);
  assert.equal(buildInstantiationTemplate('old', files), `old u_old (
  .clk(clk),
  .rst(rst),
  .q(q)
);`);
  assert.equal(buildInstantiationTemplate('empty', files), 'empty u_empty ();');
  assert.equal(buildInstantiationTemplate('old', new Map(Object.entries(files)), { instanceName: 'x' }).split('\n')[0], 'old x (');
  const wrapper = `module wrap;\n  reg clk, rst;\n  wire [7:0] din, dout, q;\n${fifo}\n${buildInstantiationTemplate('old', files)}\nendmodule\n`;
  const r = await compileVvp({ 'fifo.v': files['fifo.v'], 'old.v': files['old.v'], 'wrap.v': wrapper }, { top: 'wrap' });
  assert.ok(r.ok, r.log);
  assert.deepEqual(r.diagnostics, []);
});

console.log(`Stage E unit checks passed (${checks})`);
