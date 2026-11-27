import assert from 'node:assert/strict';
import { LINT_RULES, lintRtl } from '../../web/rtl-linter.js';
import { analyzeResources, analyzeCriticalPath } from '../../web/rtl-metrics.js';
import { SHOWCASE_PROJECTS, showcaseProject } from '../../web/showcase-projects.js';
import { MIPS_TEMPLATE } from '../../web/mips-template.js';
import { elaborateJson } from '../correctness/helpers.mjs';

let checks = 0;
async function check(name, fn) {
  try { await fn(); checks++; } catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const lint = (source, options) => lintRtl({ 'dut.v': source }, options);
const rules = (findings, rule) => findings.filter(f => f.rule === rule);
const lines = (findings, rule) => rules(findings, rule).map(f => f.line);
const bin = n => n.toString(2).padStart(32, '0');

// ---------------------------------------------------------------------------
// lintRtl

await check('rule catalogue', () => {
  assert.deepEqual(Object.keys(LINT_RULES).sort(), ['BLKSEQ', 'INCOMPLETE_CASE', 'LATCH_INFERRED', 'NONBLK', 'UNDRIVEN', 'UNUSED', 'WIDTH_TRUNC']);
  assert.equal(LINT_RULES.BLKSEQ.title, 'Blocking assignment in sequential block');
  assert.equal(LINT_RULES.NONBLK.title, 'Non-blocking assignment in combinational block');
  assert.equal(LINT_RULES.INCOMPLETE_CASE.title, 'Case statement missing default branch');
  assert.equal(LINT_RULES.LATCH_INFERRED.title, 'Latch inferred in synthesis');
  assert.equal(LINT_RULES.WIDTH_TRUNC.title, 'Possible bit-width truncation');
  assert.equal(LINT_RULES.UNDRIVEN.title, 'Internal signal has no driver');
  assert.equal(LINT_RULES.UNUSED.title, 'Internal signal is never read');
  for (const rule of Object.values(LINT_RULES)) { assert.equal(rule.severity, 'warning'); assert.ok(rule.description.length > 40); }
});

await check('BLKSEQ: blocking assignment in clocked blocks', () => {
  const f = lint(`module m(input clk, input rst_n, input [3:0] d, output reg [3:0] q, output reg [3:0] r, output reg [3:0] s);
  always @(posedge clk) q = d;
  always @(negedge clk or negedge rst_n) begin
    if (!rst_n) r <= 4'd0;
    else begin
      r = d; // flagged
    end
  end
  always_ff @(posedge clk) s = d;
endmodule`);
  assert.deepEqual(lines(f, 'BLKSEQ'), [2, 6, 9]);
  const item = rules(f, 'BLKSEQ')[0];
  assert.deepEqual(Object.keys(item).sort(), ['file', 'hint', 'line', 'message', 'rule', 'severity']);
  assert.equal(item.file, 'dut.v');
  assert.equal(item.severity, 'warning');
  assert.match(item.message, /`q`/);
  assert.match(item.hint, /<=/);
});

await check('BLKSEQ: comparisons, for-loop control, integer/genvar vars and block scope are not flagged', () => {
  const f = lint(`module m(input clk, input [7:0] a, input [7:0] b, output reg [7:0] q, output reg lt, output reg [7:0] y);
  reg [7:0] mem [0:3];
  integer i;
  integer count;
  always @(posedge clk) begin
    if (a == b || a != 8'd3 || a === b || a !== b || a <= b || a >= b) q <= a;
    for (i = 0; i < 4; i = i + 1) mem[i] <= a;
    count = count + 1;
    lt <= (a <= b);
  end
  always @(posedge clk)
    if (a <= b) q <= b;
  always @(*) y = mem[0] + count[7:0];
  genvar g;
  generate for (g = 0; g < 2; g = g + 1) begin : gen
    wire t = a[g];
  end endgenerate
endmodule`);
  assert.deepEqual(rules(f, 'BLKSEQ'), []);
  assert.deepEqual(rules(f, 'NONBLK'), []);
});

await check('BLKSEQ: single-statement always ends at its semicolon', () => {
  const f = lint(`module m(input clk, input d, output reg q, output reg y);
  always @(posedge clk) q <= d;
  always @(*) y = q;
endmodule`);
  assert.deepEqual(f, []);
  const g = lint(`module m(input clk, input d, output reg q, output reg y);
  always @(posedge clk)
    if (d) q <= 1'b1;
    else q <= 1'b0;
  always @* y = q;
endmodule`);
  assert.deepEqual(g, []);
});

await check('NONBLK: non-blocking assignment in combinational blocks', () => {
  const f = lint(`module m(input a, input b, output reg x, output reg y, output reg z, output reg w);
  always @(*) x <= a;
  always @* begin
    y <= a & b;
  end
  always @(a or b) z <= a | b;
  always_comb w <= a ^ b;
endmodule`);
  assert.deepEqual(lines(f, 'NONBLK'), [2, 4, 6, 7]);
  assert.match(rules(f, 'NONBLK')[0].message, /`x`/);
  assert.deepEqual(rules(f, 'BLKSEQ'), []);
});

await check('INCOMPLETE_CASE: combinational case without default', () => {
  const f = lint(`module m(input [1:0] s, input a, input b, output reg y);
  always @(*) begin
    case (s)
      2'd0: y = a;
      2'd1: y = b;
    endcase
  end
endmodule`);
  assert.deepEqual(lines(f, 'INCOMPLETE_CASE'), [3]);
  assert.match(rules(f, 'INCOMPLETE_CASE')[0].message, /`y`/);
  const z = lint(`module m(input [2:0] s, input a, output reg y);
  always @* casez (s) 3'b1??: y = a; 3'b01?: y = 1'b0; endcase
endmodule`);
  assert.deepEqual(lines(z, 'INCOMPLETE_CASE'), [2]);
});

await check('INCOMPLETE_CASE: defaults, prior assignment, full coverage, clocked blocks and unique case are fine', () => {
  const f = lint(`module m(input clk, input [1:0] s, input [2:0] t, input a, input b, output reg y, output reg z, output reg w, output reg v, output reg u, output reg q);
  localparam IDLE = 2'd0, RUN = 2'd1, WAIT = 2'd2, DONE = 2'd3;
  always @(*) begin
    y = 1'b0;
    case (s)
      2'd0: y = a;
      2'd1: y = b;
    endcase
  end
  always @(*) begin
    case (t)
      3'd0: z = a;
      default: z = b;
    endcase
  end
  always @(*) begin
    case (s)
      IDLE: w = a;
      RUN: w = b;
      WAIT: w = 1'b0;
      DONE: w = 1'b1;
    endcase
  end
  always @(posedge clk) case (s) 2'd0: q <= a; endcase
  always_comb unique case (s) 2'd0: v = a; 2'd1: v = b; endcase
  always @(*) begin
    u = 1'b0;
    if (a) case (s) 2'd3: u = b; endcase
  end
endmodule`);
  assert.deepEqual(rules(f, 'INCOMPLETE_CASE'), []);
});

await check('WIDTH_TRUNC: wider sized literals and identifiers', () => {
  const f = lint(`module m(input clk, input [15:0] wide, input [3:0] n, output [7:0] y, output [7:0] z, output reg [7:0] r, output [3:0] c);
  wire [7:0] init = 12'hfff;
  assign y = 16'h00ff;
  assign z = wide;
  always @(posedge clk) r <= wide;
  assign c = {n, n};
endmodule`);
  assert.deepEqual(lines(f, 'WIDTH_TRUNC'), [2, 3, 4, 5, 6]);
  const msg = rules(f, 'WIDTH_TRUNC')[1].message;
  assert.match(msg, /16'h00ff/);
  assert.match(msg, /16 bits/);
  assert.match(msg, /8 bits/);
});

await check('WIDTH_TRUNC: slices, comparisons, shifts, matching widths and parameters are not flagged', () => {
  const f = lint(`module m #(parameter W = 16) (input [15:0] wide, input [7:0] a, input [7:0] b, input [W-1:0] pw, output [7:0] y, output flag, output [7:0] s, output [7:0] t, output [8:0] sum, output [7:0] u, output [7:0] v, output [7:0] k);
  assign y = wide[7:0];
  assign flag = (wide == 16'h0001);
  assign s = wide >> 8;
  assign t = a + b;
  assign sum = a + b;
  assign u = pw;
  assign v = 0;
  assign k = {a[3:0], b[3:0]};
endmodule`);
  assert.deepEqual(rules(f, 'WIDTH_TRUNC'), []);
});

await check('UNDRIVEN / UNUSED: internal signals', () => {
  const f = lint(`module m(input a, input b, output y, output z);
  wire floating;
  wire dead;
  reg  never;
  wire ok;
  assign ok = a & b;
  assign y = floating | ok;
  assign dead = a;
  assign z = b;
endmodule`);
  assert.deepEqual(rules(f, 'UNDRIVEN').map(x => [x.line, /`floating`/.test(x.message)]), [[2, true]]);
  assert.deepEqual(rules(f, 'UNUSED').map(x => x.line), [3, 4]);
  assert.match(rules(f, 'UNUSED')[0].message, /assigned but never read/);
  assert.match(rules(f, 'UNUSED')[1].message, /declared but never used/);
});

await check('UNDRIVEN / UNUSED: ports, named/positional instance connections, for loops and memories count', () => {
  const files = {
    'child.v': 'module child(input [3:0] i, output [3:0] o);\n  assign o = ~i;\nendmodule\n',
    'top.v': `module top(input clk, input [3:0] a, output [3:0] y, output [3:0] q);
  wire [3:0] n1, n2, n3;
  reg [3:0] mem [0:3];
  reg [3:0] acc;
  integer i;
  child u1(.i(a), .o(n1));
  child u2(n1, n2);
  child u3(.i(n2), .o(n3));
  always @(posedge clk) begin
    for (i = 0; i < 4; i = i + 1) mem[i] <= n3;
    acc <= mem[a[1:0]];
  end
  assign y = acc;
  assign q = n3;
endmodule`,
  };
  const f = lintRtl(files);
  assert.deepEqual(f, []);
});

await check('UNDRIVEN / UNUSED: testbench modules are skipped', () => {
  const f = lintRtl({
    'tb.v': `module tb;
  reg clk;
  reg unused_tb;
  wire [3:0] y;
  wire never_driven;
  dut u(.a(never_driven), .y(y));
  initial begin clk = 0; #10 $display("%d", y); $finish; end
endmodule`,
    'probe.v': 'module probe(input a, output y);\n  wire spare;\n  assign y = a;\n  initial $dumpfile("x.vcd");\nendmodule\n',
    'dut.v': 'module dut(input a, output [3:0] y);\n  assign y = {4{a}};\nendmodule\n',
  });
  assert.deepEqual(rules(f, 'UNDRIVEN'), []);
  assert.deepEqual(rules(f, 'UNUSED'), []);
});

await check('ROM init with $readmemh is synthesizable, comments/strings are masked', () => {
  const f = lint(`module rom(input [3:0] addr, output [7:0] data);
  reg [7:0] mem [0:15];
  /* wire ghost; assign data = 16'hffff; */
  initial $readmemh("rom.mem", mem); // "always @(posedge clk) q = d;"
  assign data = mem[addr];
endmodule`);
  assert.deepEqual(f, []);
});

await check('LATCH_INFERRED: synthetic yosysJson src parsing and dedupe', () => {
  const yosysJson = { modules: {
    m: { attributes: {}, ports: {}, netnames: { 'q': { hide_name: 0, bits: [5, 6] } }, cells: {
      '$dlatch$a': { type: '$dlatch', attributes: { src: '/work/foo.v:12.3-14.5' }, connections: { EN: [2], D: [3, 4], Q: [5, 6] } },
      '$dlatch$b': { type: '$dlatch', attributes: { src: 'foo.v:12' }, connections: { EN: [2], D: [3, 4], Q: [5, 6] } },
      '$dlatchsr$c': { type: '$dlatchsr', attributes: { src: '/work/rtl/bar.v:3' }, connections: { Q: [9] } },
      '$dff$d': { type: '$dff', attributes: { src: 'foo.v:20' }, connections: { Q: [7] } },
    } },
  } };
  const f = lintRtl({ 'foo.v': 'module m; endmodule', 'rtl/bar.v': 'module n; endmodule' }, { yosysJson });
  const latches = rules(f, 'LATCH_INFERRED');
  assert.deepEqual(latches.map(x => `${x.file}:${x.line}`), ['foo.v:12', 'rtl/bar.v:3']);
  assert.match(latches[0].message, /`q`/);
  assert.match(latches[0].message, /`m`/);
  assert.deepEqual(rules(lintRtl({ 'foo.v': '', 'rtl/bar.v': '' }, { yosysJson, excluded: new Set(['foo.v']) }), 'LATCH_INFERRED').map(x => x.file), ['rtl/bar.v']);
  assert.deepEqual(lintRtl({}, { yosysJson: { modules: null } }), []);
});

await check('included files only, sorted output', () => {
  const bad = 'module m(input clk, input d, output reg q);\n  always @(posedge clk) q = d;\nendmodule\n';
  const files = { 'b.v': bad, 'a.sv': bad, 'notes.txt': bad, 'prog.asm': bad, 'skip.v': bad };
  const f = lintRtl(files, { excluded: new Set(['skip.v']) });
  assert.deepEqual(f.map(x => `${x.file}:${x.line}:${x.rule}`), ['a.sv:2:BLKSEQ', 'b.v:2:BLKSEQ']);
  const mixed = lint('module m(input clk, input a, output reg q, output reg y);\n  always @(*) y <= a;\n  always @(posedge clk) q = a;\n  wire [3:0] t = 8\'hff;\nendmodule\n');
  assert.deepEqual(mixed.map(x => `${x.line}:${x.rule}`), ['2:NONBLK', '3:BLKSEQ', '4:UNUSED', '4:WIDTH_TRUNC']);
});

await check('showcase projects and the MIPS template lint clean (no false positives)', () => {
  for (const project of SHOWCASE_PROJECTS) assert.deepEqual(lintRtl(project.files), [], project.id);
  assert.deepEqual(lintRtl(MIPS_TEMPLATE), []);
});

await check('half-typed and malformed sources never throw or hang', () => {
  const source = Object.entries(showcaseProject('mips-cpu').files).filter(([p]) => p.endsWith('.v')).map(([, t]) => t).join('\n');
  const started = performance.now();
  for (let cut = 0; cut < source.length; cut += 97) assert.ok(Array.isArray(lintRtl({ 'x.v': source.slice(0, cut) })));
  for (const junk of ['module', 'module m(', 'module m; always @(posedge', 'module m; case (', 'endmodule endmodule', 'module m; assign = ;', '`define X(a) a\nmodule m; wire `X(y); endmodule', 'module m; begin end end end']) {
    assert.ok(Array.isArray(lintRtl({ 'j.v': junk })), junk);
  }
  assert.ok(performance.now() - started < 10000);
});

// ---------------------------------------------------------------------------
// analyzeResources

const cell = (type, connections, parameters = {}, src = null) => ({ type, parameters, attributes: src ? { src } : {}, port_directions: {}, connections });
const RES_FIXTURE = { modules: {
  top: { attributes: { top: bin(1) }, ports: {}, netnames: {}, cells: {
    u_a: cell('leaf', {}), u_b: cell('leaf', {}), u_mid: cell('mid', {}), reg0: cell('$dff', { Q: [1, 2] }, { WIDTH: bin(2) }),
  } },
  mid: { attributes: {}, ports: {}, netnames: {}, cells: { u_leaf: cell('leaf', {}), m0: cell('$mux', {}), p0: cell('$proc', {}) } },
  leaf: { attributes: {}, ports: {}, netnames: {}, cells: {
    ff: cell('$adffe', { Q: [1, 2, 3, 4] }, { WIDTH: bin(4) }), lat: cell('$dlatch', { Q: [5] }),
    add: cell('$add', {}), eq: cell('$eq', {}), g1: cell('$and', {}), g2: cell('$not', {}), pm: cell('$pmux', {}),
    ram: cell('$mem', {}, { WIDTH: bin(8), SIZE: bin(16) }), rom: cell('$mem_v2', {}, { WIDTH: 8, ABITS: 3 }),
    mystery: cell('$weird_prim', {}),
  } },
  orphan: { attributes: {}, ports: {}, netnames: {}, cells: { x: cell('$xor', {}) } },
} };

await check('analyzeResources: self, inclusive, instance counts and totals', () => {
  const r = analyzeResources(RES_FIXTURE, 'top');
  assert.equal(r.top, 'top');
  const by = Object.fromEntries(r.byModule.map(m => [m.name, m]));
  assert.deepEqual(r.byModule.slice(0, 3).map(m => m.name), ['top', 'mid', 'leaf']);
  assert.deepEqual(by.leaf.self, { ffBits: 4, ffCells: 1, latchBits: 1, latchCells: 1, muxes: 1, ops: 2, gates: 2, memCells: 2, memBits: 192, behavioral: 1, totalCells: 10 });
  assert.equal(by.leaf.instanceCount, 3);
  assert.equal(by.mid.instanceCount, 1);
  assert.equal(by.top.instanceCount, 1);
  assert.equal(by.orphan.instanceCount, 0);
  assert.deepEqual(by.mid.inclusive, { ffBits: 4, ffCells: 1, latchBits: 1, latchCells: 1, muxes: 2, ops: 2, gates: 2, memCells: 2, memBits: 192, behavioral: 2, totalCells: 12 });
  assert.equal(by.top.self.ffBits, 2);
  assert.equal(by.top.self.totalCells, 1);
  assert.deepEqual(r.total, by.top.inclusive);
  assert.equal(r.total.ffBits, 2 + 3 * 4);
  assert.equal(r.total.memBits, 3 * 192);
  assert.equal(r.total.totalCells, 1 + 2 + 3 * 10);
});

await check('analyzeResources: auto top, roots, cyclic hierarchy and bad input', () => {
  assert.equal(analyzeResources(RES_FIXTURE).top, 'top');
  assert.equal(analyzeResources(RES_FIXTURE, 'nope').top, 'top');
  const noTop = { modules: { a: { cells: { u: cell('b', {}), f: cell('$dff', { Q: [1] }) } }, b: { cells: { g: cell('$and', {}) } }, c: { cells: { g: cell('$or', {}) } } } };
  const r = analyzeResources(noTop);
  assert.equal(r.top, null);
  assert.equal(r.total.totalCells, 3);
  assert.equal(r.total.gates, 2);
  const cyclic = { modules: { a: { attributes: { top: 1 }, cells: { u: cell('b', {}), g: cell('$and', {}) } }, b: { cells: { u: cell('a', {}), g: cell('$or', {}) } } } };
  const c = analyzeResources(cyclic);
  assert.equal(c.total.gates, 2);
  assert.deepEqual(c.byModule.map(m => [m.name, m.instanceCount]), [['a', 1], ['b', 1]]);
  const paramod = { modules: { top: { attributes: { top: 1 }, cells: { u: cell('$paramod\\leaf\\top.u', {}) } }, '$paramod\\leaf\\top.u': { cells: { f: cell('$dff', { Q: [1, 2, 3] }) } } } };
  assert.equal(analyzeResources(paramod).total.ffBits, 3);
  for (const bad of [null, undefined, {}, { modules: 5 }, 'x']) {
    const e = analyzeResources(bad);
    assert.equal(e.top, null); assert.deepEqual(e.byModule, []); assert.equal(e.total.totalCells, 0);
  }
});

// ---------------------------------------------------------------------------
// analyzeCriticalPath

const dir = (map) => map;
const PATH_FIXTURE = { modules: {
  top: {
    attributes: { top: bin(1) },
    ports: { a: { direction: 'input', bits: [2, 3] }, b: { direction: 'input', bits: [4, 5] }, clk: { direction: 'input', bits: [1] }, y: { direction: 'output', bits: [20, 21] }, q: { direction: 'output', bits: [30, 31] } },
    netnames: { s1: { hide_name: 0, bits: [10, 11] } },
    cells: {
      g_and: { type: '$and', attributes: { src: 'top.v:3' }, port_directions: dir({ A: 'input', B: 'input', Y: 'output' }), connections: { A: [2, 3], B: [4, 5], Y: [10, 11] } },
      g_add: { type: '$add', attributes: { src: 'top.v:4' }, port_directions: dir({ A: 'input', B: 'input', Y: 'output' }), connections: { A: [10, 11], B: [2, '0'], Y: [12, 13] } },
      g_mux: { type: '$mux', attributes: { src: 'top.v:5' }, port_directions: dir({ A: 'input', B: 'input', S: 'input', Y: 'output' }), connections: { A: [12, 13], B: [4, 5], S: [2], Y: [20, 21] } },
      u_pc: { type: '$dff', attributes: { src: 'top.v:7' }, port_directions: dir({ CLK: 'input', D: 'input', Q: 'output' }), connections: { CLK: [1], D: [40, 41], Q: [30, 31] } },
      g_inc: { type: '$not', attributes: { src: 'top.v:8' }, port_directions: dir({ A: 'input', Y: 'output' }), connections: { A: [30, 31], Y: [40, 41] } },
    },
  },
} };

await check('analyzeCriticalPath: weighted longest path from port to port', () => {
  const p = analyzeCriticalPath(PATH_FIXTURE, 'top');
  assert.equal(p.module, 'top');
  assert.equal(p.depth, 5);
  assert.equal(p.hasCombLoop, false);
  assert.deepEqual(p.loopCells, []);
  assert.equal(p.startpoint, 'port:a');
  assert.equal(p.endpoint, 'port:y');
  assert.deepEqual(p.cells, ['g_and', 'g_add', 'g_mux']);
  assert.equal(p.gateCount, 3);
  assert.deepEqual(p.steps, [
    { cell: 'g_and', type: '$and', label: 'g_and (and)', weight: 1, cumDepth: 1, src: 'top.v:3' },
    { cell: 'g_add', type: '$add', label: 'g_add (add)', weight: 2.5, cumDepth: 3.5, src: 'top.v:4' },
    { cell: 'g_mux', type: '$mux', label: 'g_mux (mux)', weight: 1.5, cumDepth: 5, src: 'top.v:5' },
  ]);
  assert.equal(p.nets.length, 4);
  assert.equal(p.nets[p.nets.length - 1], 20); // y[0] and y[1] tie at depth 5; the first endpoint bit wins
  assert.deepEqual(p.nets.slice(1, 3), [10, 12]);
  assert.ok(p.nets.every(n => typeof n === 'number'));
  assert.deepEqual(analyzeCriticalPath(PATH_FIXTURE), p); // resolves the top module
});

await check('analyzeCriticalPath: FF Q is a startpoint and FF D an endpoint', () => {
  const mod = structuredClone(PATH_FIXTURE);
  delete mod.modules.top.cells.g_mux;
  const p = analyzeCriticalPath(mod, 'top');
  assert.equal(p.depth, 1);
  assert.equal(p.startpoint, 'u_pc (Q)');
  assert.equal(p.endpoint, 'u_pc (D)');
  assert.deepEqual(p.cells, ['g_inc']);
  // A path never runs backwards through the register: its D side is not traversed into Q.
  mod.modules.top.cells.g_big = { type: '$mul', port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [2, 3], B: [4, 5], Y: [40, 41] } };
  const q = analyzeCriticalPath(mod, 'top');
  assert.equal(q.depth, 4);
  assert.equal(q.startpoint, 'port:a');
  assert.equal(q.endpoint, 'u_pc (D)');
});

await check('analyzeCriticalPath: combinational loops are reported without hanging or NaN', () => {
  const loop = { modules: { ring: {
    attributes: { top: bin(1) },
    ports: { en: { direction: 'input', bits: [2] }, out: { direction: 'output', bits: [4] } },
    netnames: {},
    cells: {
      n1: { type: '$not', port_directions: { A: 'input', Y: 'output' }, connections: { A: [3], Y: [5] } },
      a1: { type: '$and', port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [2], B: [5], Y: [3] } },
      buf: { type: '$buf', port_directions: { A: 'input', Y: 'output' }, connections: { A: [3], Y: [4] } },
      lone: { type: '$or', port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [2], B: [2], Y: [9] } },
    },
  } } };
  const p = analyzeCriticalPath(loop, 'ring');
  assert.equal(p.hasCombLoop, true);
  assert.deepEqual(p.loopCells, ['n1', 'a1']);
  assert.ok(Number.isFinite(p.depth));
  assert.equal(p.depth, 2);
  assert.equal(p.startpoint, 'port:en');
  assert.equal(p.endpoint, 'port:out');
});

await check('analyzeCriticalPath: submodules use their inner depth; register outputs start new paths', () => {
  const json = { modules: {
    top: {
      attributes: { top: bin(1) },
      ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [6] }, r: { direction: 'output', bits: [8] } },
      netnames: {},
      cells: {
        u_comb: { type: 'adder2', port_directions: { x: 'input', s: 'output' }, connections: { x: [2], s: [5] } },
        g: { type: '$not', port_directions: { A: 'input', Y: 'output' }, connections: { A: [5], Y: [6] } },
        u_reg: { type: 'regbox', port_directions: { clk: 'input', d: 'input', q: 'output' }, connections: { clk: [2], d: [6], q: [8] } },
      },
    },
    adder2: { attributes: {}, ports: { x: { direction: 'input', bits: [2] }, s: { direction: 'output', bits: [5] } }, netnames: {}, cells: {
      p: { type: '$add', port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [2], B: [2], Y: [3] } },
      q: { type: '$add', port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [3], B: [3], Y: [5] } },
    } },
    regbox: { attributes: {}, ports: { clk: { direction: 'input', bits: [2] }, d: { direction: 'input', bits: [6] }, q: { direction: 'output', bits: [8] } }, netnames: {}, cells: {
      ff: { type: '$dff', port_directions: { CLK: 'input', D: 'input', Q: 'output' }, connections: { CLK: [2], D: [6], Q: [8] } },
    } },
  } };
  const p = analyzeCriticalPath(json, 'top');
  assert.equal(p.depth, 6);
  assert.deepEqual(p.steps.map(s => [s.cell, s.weight]), [['u_comb', 5], ['g', 1]]);
  assert.equal(p.endpoint, 'port:y');
  const reg = analyzeCriticalPath(json, 'regbox');
  assert.deepEqual([reg.depth, reg.startpoint, reg.endpoint], [0, 'ff (Q)', 'port:q']);
  const self = { modules: { a: { attributes: { top: 1 }, ports: { i: { direction: 'input', bits: [1] }, o: { direction: 'output', bits: [2] } }, cells: { u: { type: 'a', port_directions: { i: 'input', o: 'output' }, connections: { i: [1], o: [2] } } } } } };
  assert.equal(analyzeCriticalPath(self, 'a').depth, 1.5); // recursive hierarchy falls back to one stage
});

await check('analyzeCriticalPath: friendly labels never leak Icarus internals', () => {
  const ff = '$dff$/work/top.v:26$_ivl_67', anon = '$dffe$top.v:40$_ivl_9', mux = '$mux$top.v:21$_ivl_23', add = '$add$top.v:24$_ivl_5', and = '$and$$_ivl_3';
  const json = { modules: { top: {
    attributes: { top: bin(1) },
    ports: { a: { direction: 'input', bits: [2] }, clk: { direction: 'input', bits: [1] }, pc_out: { direction: 'output', bits: [10, 11] } },
    netnames: { pc: { hide_name: 0, bits: [10, 11] }, pc_out: { hide_name: 0, bits: [10, 11] }, '_ivl_23': { hide_name: 1, bits: [12, 13] }, pc_next: { hide_name: 0, bits: [14, 15] } },
    cells: {
      [ff]: { type: '$dff', attributes: { src: '/work/top.v:26' }, port_directions: { CLK: 'input', D: 'input', Q: 'output' }, connections: { CLK: [1], D: [14, 15], Q: [10, 11] } },
      [mux]: { type: '$mux', attributes: { src: 'top.v:21' }, port_directions: { A: 'input', B: 'input', S: 'input', Y: 'output' }, connections: { A: [10, 11], B: [11, 10], S: [2], Y: [12, 13] } },
      [add]: { type: '$add', attributes: { src: 'top.v:24' }, port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [12, 13], B: ['1', '0'], Y: [14, 15] } },
      [and]: { type: '$and', attributes: {}, port_directions: { A: 'input', B: 'input', Y: 'output' }, connections: { A: [2], B: [2], Y: [20] } },
      [anon]: { type: '$dffe', attributes: { src: 'top.v:40' }, port_directions: { CLK: 'input', EN: 'input', D: 'input', Q: 'output' }, connections: { CLK: [1], EN: [20], D: [2], Q: [30] } },
    },
  } } };
  const p = analyzeCriticalPath(json, 'top');
  assert.equal(p.startpoint, 'pc (Q)'); // the register's own net wins over the pc_out port alias
  assert.equal(p.endpoint, 'pc (D)');
  assert.deepEqual(p.steps.map(s => s.label), ['mux :21', 'add (pc_next)']);
  assert.deepEqual(p.cells, [mux, add]);
  assert.deepEqual(p.steps.map(s => s.cell), [mux, add]);
  delete json.modules.top.cells[mux];
  delete json.modules.top.cells[add];
  const q = analyzeCriticalPath(json, 'top');
  assert.equal(q.endpoint, 'dffe:40 (EN)'); // no clean net on Q: type and source line
  assert.deepEqual(q.steps.map(s => s.label), ['and']);
  assert.equal(q.steps[0].cell, and);
});

await check('analyzeCriticalPath: empty and invalid input', () => {
  for (const bad of [null, {}, { modules: {} }]) {
    const p = analyzeCriticalPath(bad, 'x');
    assert.equal(p.depth, 0); assert.equal(p.gateCount, 0); assert.equal(p.hasCombLoop, false);
    assert.deepEqual(p.steps, []); assert.deepEqual(p.cells, []); assert.deepEqual(p.nets, []);
  }
  const wire = { modules: { w: { attributes: {}, ports: { a: { direction: 'input', bits: [2] }, y: { direction: 'output', bits: [2] } }, cells: {} } } };
  const p = analyzeCriticalPath(wire, 'w');
  assert.equal(p.module, 'w'); assert.equal(p.depth, 0); assert.equal(p.startpoint, 'port:a'); assert.equal(p.endpoint, 'port:y');
});

// ---------------------------------------------------------------------------
// Real ivl.wasm elaboration

const rtlOnly = files => Object.fromEntries(Object.entries(files).filter(([path]) => /\.v$/.test(path) && !/(^tb_|_tb\.v$)/.test(path)));

await check('real elaboration: mips_cpu resources and critical path', async () => {
  const project = showcaseProject('mips-cpu');
  const r = await elaborateJson(rtlOnly(project.files), { top: 'mips_cpu' });
  assert.ok(r.ok, r.log);
  const res = analyzeResources(r.yosysJson, 'mips_cpu');
  assert.equal(res.top, 'mips_cpu');
  assert.equal(res.total.ffBits, 32); // the PC register
  assert.equal(res.total.latchCells, 0);
  assert.equal(res.total.memBits, 64 * 32 + 64 * 32 + 32 * 32); // imem + dmem + register file
  assert.ok(res.total.muxes > 10 && res.total.ops > 5);
  assert.ok(res.byModule.some(m => m.name === 'mips_alu' && m.instanceCount === 1));
  const cp = analyzeCriticalPath(r.yosysJson, 'mips_cpu');
  assert.equal(cp.module, 'mips_cpu');
  assert.equal(cp.hasCombLoop, false);
  assert.ok(Number.isFinite(cp.depth) && cp.depth > 10, `depth ${cp.depth}`);
  assert.match(cp.startpoint, /\(Q\)$/);
  assert.match(cp.endpoint, /\(D\)$/);
  const cells = r.yosysJson.modules.mips_cpu.cells;
  assert.ok(cp.cells.every(c => c in cells));
  assert.ok(cp.cells.includes('u_alu') && cp.cells.includes('u_imem'));
  assert.equal(cp.gateCount, cp.steps.length);
  assert.equal(cp.steps[cp.steps.length - 1].cumDepth, cp.depth);
  // Friendly labels for the UI; raw keys stay intact for schematic highlighting.
  assert.equal(cp.startpoint, 'pc (Q)');
  assert.equal(cp.endpoint, 'pc (D)');
  assert.ok(cp.steps.every(s => typeof s.label === 'string' && s.label && !/\$|_ivl_/.test(s.label)), JSON.stringify(cp.steps.map(s => s.label)));
  assert.ok(cp.steps.some(s => s.label === 'u_alu (mips_alu)'));
  assert.ok(cp.steps.some(s => /^mux :\d+$/.test(s.label)));
  assert.ok(cp.steps.some(s => s.cell.startsWith('$') && s.cell.includes('_ivl_'))); // raw key preserved
  assert.deepEqual(cp.cells, cp.steps.map(s => s.cell).filter((c, i, all) => c !== all[i - 1]));
  for (const name of Object.keys(r.yosysJson.modules)) {
    const sub = analyzeCriticalPath(r.yosysJson, name);
    assert.ok(Number.isFinite(sub.depth));
    for (const text of [sub.startpoint, sub.endpoint, ...sub.steps.map(s => s.label)]) assert.ok(!/\$|_ivl_/.test(text ?? ''), `${name}: ${text}`);
    assert.ok(sub.steps.every(s => s.cell in r.yosysJson.modules[name].cells));
  }
  assert.deepEqual(rules(lintRtl(project.files, { yosysJson: r.yosysJson }), 'LATCH_INFERRED'), []);
});

await check('real elaboration: incomplete case infers a latch, found by both lint paths', async () => {
  const files = { 'dec.v': `module dec(input [1:0] s, input a, input b, output reg y);
  always @(*) begin
    case (s)
      2'd0: y = a;
      2'd1: y = b;
    endcase
  end
endmodule
` };
  const r = await elaborateJson(files, { top: 'dec' });
  assert.ok(r.ok, r.log);
  const res = analyzeResources(r.yosysJson, 'dec');
  assert.ok(res.total.latchCells >= 1 && res.total.latchBits >= 1);
  const f = lintRtl(files, { yosysJson: r.yosysJson });
  assert.deepEqual(lines(f, 'INCOMPLETE_CASE'), [3]);
  const latch = rules(f, 'LATCH_INFERRED');
  assert.equal(latch.length, 1);
  assert.equal(latch[0].file, 'dec.v');
  assert.ok(latch[0].line >= 2 && latch[0].line <= 6, `line ${latch[0].line}`);
  assert.match(latch[0].message, /`y`/);
  const cp = analyzeCriticalPath(r.yosysJson, 'dec');
  assert.equal(cp.hasCombLoop, false);
  assert.ok(Number.isFinite(cp.depth));
});

await check('real elaboration: bug-hunter latch in leaky_ctrl', async () => {
  const project = showcaseProject('bug-hunter');
  const r = await elaborateJson(rtlOnly(project.files), { top: 'datapath_slice' });
  assert.ok(r.ok, r.log);
  const res = analyzeResources(r.yosysJson, 'datapath_slice');
  assert.equal(res.byModule.find(m => m.name === 'leaky_ctrl').self.latchCells, 1);
  assert.equal(res.total.latchCells, 1);
  const latch = rules(lintRtl(project.files, { yosysJson: r.yosysJson }), 'LATCH_INFERRED');
  assert.deepEqual(latch.map(x => `${x.file}:${x.line}`), ['datapath_slice.v:34']);
  assert.match(latch[0].message, /`alu_op`.*`leaky_ctrl`/);
});

console.log(`Stage C unit checks passed (${checks})`);
