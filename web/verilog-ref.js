/* Verilog-2001/2005 & SystemVerilog quick reference, hint bar lookup, and literal decoder. */

export const VERILOG_KEYWORDS = [
  { name: 'module', cat: 'Structural', format: 'module name(port_list); ... endmodule', desc: 'Declares a hardware module boundary and its I/O ports.', example: 'module alu(\n  input  [31:0] a, b,\n  input  [2:0]  op,\n  output reg [31:0] y\n);\nendmodule' },
  { name: 'endmodule', cat: 'Structural', format: 'endmodule', desc: 'Closes a module declaration.', example: 'endmodule' },
  { name: 'input', cat: 'Ports & Nets', format: 'input [wire|signed] [msb:lsb] name', desc: 'Input port driven from outside the module.' },
  { name: 'output', cat: 'Ports & Nets', format: 'output [reg|wire|signed] [msb:lsb] name', desc: 'Output port; declare output reg if assigned in always/initial.' },
  { name: 'inout', cat: 'Ports & Nets', format: 'inout [msb:lsb] name', desc: 'Bidirectional tri-state port.' },
  { name: 'wire', cat: 'Ports & Nets', format: 'wire [msb:lsb] name [= expr];', desc: 'Combinational net driven by assign or module outputs.' },
  { name: 'reg', cat: 'Ports & Nets', format: 'reg [msb:lsb] name [= init];', desc: 'Procedural variable or memory element (array: reg [w-1:0] mem [0:N-1]).' },
  { name: 'logic', cat: 'Ports & Nets', format: 'logic [msb:lsb] name;', desc: 'SystemVerilog unified 4-state net/variable type.' },
  { name: 'integer', cat: 'Ports & Nets', format: 'integer i;', desc: 'Signed 32-bit procedural integer (ideal for loop counters).' },
  { name: 'signed', cat: 'Ports & Nets', format: 'wire/reg signed [msb:lsb] name;', desc: 'Enables two\'s-complement arithmetic comparisons and >>> shifts.' },
  { name: 'parameter', cat: 'Params', format: 'parameter NAME = value;', desc: 'Compile-time constant overridable per instance (#(.WIDTH(16))).' },
  { name: 'localparam', cat: 'Params', format: 'localparam NAME = expr;', desc: 'Internal module constant that cannot be overridden from outside.' },
  { name: 'assign', cat: 'Behavioral', format: 'assign net = expr;', desc: 'Continuous combinational assignment outside procedural blocks.', example: 'assign zero = (alu_out == 32\'d0);' },
  { name: 'always', cat: 'Behavioral', format: 'always @(posedge clk) | always @(*)', desc: 'Sequential (edge-triggered, use <=) or combinational (use =) block.', example: 'always @(posedge clk) begin\n  if (reset) q <= 0;\n  else if (en) q <= d;\nend' },
  { name: 'always_ff', cat: 'Behavioral', format: 'always_ff @(posedge clk)', desc: 'SystemVerilog sequential logic block (flips/registers).' },
  { name: 'always_comb', cat: 'Behavioral', format: 'always_comb', desc: 'SystemVerilog combinational block with automatic sensitivity list.' },
  { name: 'posedge', cat: 'Timing', format: '@(posedge clk)', desc: '0 → 1 rising edge sensitivity event.' },
  { name: 'negedge', cat: 'Timing', format: '@(negedge clk)', desc: '1 → 0 falling edge sensitivity event.' },
  { name: 'initial', cat: 'Simulation', format: 'initial begin ... end', desc: 'Runs once at t=0; used in testbenches & $readmemh ROM/RAM init.' },
  { name: 'begin', cat: 'Control', format: 'begin ... end', desc: 'Sequential statement block (use begin/end whenever body has >1 line).' },
  { name: 'if', cat: 'Control', format: 'if (cond) ... else ...', desc: 'Conditional branch inside procedural blocks or generate constructs.' },
  { name: 'else', cat: 'Control', format: 'else stmt', desc: 'Fallback branch; always cover defaults in comb logic to avoid latches.' },
  { name: 'case', cat: 'Control', format: 'case (sel) val: ...; default: ...; endcase', desc: 'Exact-match multi-way branch (0, 1, x, z matched literally).' },
  { name: 'casex', cat: 'Control', format: 'casex (sel) 4\'b1xxx: ...; endcase', desc: 'Case ignoring x and z don\'t-care bits.' },
  { name: 'casez', cat: 'Control', format: 'casez (sel) 4\'b1???: ...; endcase', desc: 'Case treating z or ? as wildcard bits (great for instruction decode).' },
  { name: 'default', cat: 'Control', format: 'default: stmt;', desc: 'Fallback arm of a case/casex/casez statement.' },
  { name: 'for', cat: 'Control', format: 'for (i = 0; i < N; i = i + 1)', desc: 'Loop over hardware instances (generate) or memory initialization.' },
  { name: 'while', cat: 'Control', format: 'while (cond) stmt', desc: 'Simulation procedural loop while condition holds.' },
  { name: 'repeat', cat: 'Control', format: 'repeat (N) @(posedge clk);', desc: 'Repeats a procedural statement N times (handy in testbenches).' },
  { name: 'forever', cat: 'Control', format: 'forever #5 clk = ~clk;', desc: 'Infinite simulation loop (e.g., clock generator inside initial).' },
  { name: 'generate', cat: 'Structural', format: 'generate genvar i; for (...) ... endgenerate', desc: 'Replicates structural gates/muxes/modules at elaboration time.' },
  { name: 'genvar', cat: 'Structural', format: 'genvar i;', desc: 'Integer index variable used inside generate-for loops.' },
  { name: 'function', cat: 'Structural', format: 'function [msb:lsb] fname(input ...); ... endfunction', desc: 'Zero-time combinational helper returning a single value.' },
  { name: 'task', cat: 'Simulation', format: 'task tname(input/output ...); ... endtask', desc: 'Reusable procedural routine; may contain #delays and @events.' },
  { name: 'and', cat: 'Primitives', format: 'and g0(out, in0, in1, ...);', desc: 'Built-in structural AND gate primitive (output port is always first).' },
  { name: 'or', cat: 'Primitives', format: 'or g0(out, in0, in1, ...);', desc: 'Built-in structural OR gate primitive.' },
  { name: 'xor', cat: 'Primitives', format: 'xor g0(out, in0, in1, ...);', desc: 'Built-in structural XOR gate primitive.' },
  { name: 'nand', cat: 'Primitives', format: 'nand g0(out, in0, in1, ...);', desc: 'Built-in structural NAND gate primitive.' },
  { name: 'nor', cat: 'Primitives', format: 'nor g0(out, in0, in1, ...);', desc: 'Built-in structural NOR gate primitive.' },
  { name: 'xnor', cat: 'Primitives', format: 'xnor g0(out, in0, in1, ...);', desc: 'Built-in structural XNOR gate primitive.' },
  { name: 'not', cat: 'Primitives', format: 'not g0(out, in);', desc: 'Built-in structural inverter gate primitive.' },
  { name: 'buf', cat: 'Primitives', format: 'buf g0(out, in);', desc: 'Built-in structural buffer gate primitive.' },
];

export const VERILOG_SYSTASKS = [
  { name: '$display', format: '$display("fmt %h %0d %b", sig, ...);', desc: 'Prints formatted output plus newline immediately.' },
  { name: '$write', format: '$write("fmt", ...);', desc: 'Prints formatted output without trailing newline.' },
  { name: '$monitor', format: '$monitor("t=%0t sig=%h", $time, sig);', desc: 'Auto-prints whenever any argument changes at end of timestep.' },
  { name: '$strobe', format: '$strobe("fmt", ...);', desc: 'Prints at end of current timestep after nonblocking <= updates settle.' },
  { name: '$readmemh', format: '$readmemh("prog.mem", mem_array [, start, end]);', desc: 'Loads hex words from a .mem text file into a unpacked memory array.' },
  { name: '$readmemb', format: '$readmemb("bits.mem", mem_array [, start, end]);', desc: 'Loads binary words from a file into a memory array.' },
  { name: '$dumpfile', format: '$dumpfile("wave.vcd");', desc: 'Specifies the VCD trace filename captured for the Waveform viewer.' },
  { name: '$dumpvars', format: '$dumpvars(level, scope_or_var);', desc: 'Starts recording signals (level 0 = all signals beneath scope).' },
  { name: '$finish', format: '$finish [(n)];', desc: 'Cleanly terminates simulation (call at end of self-checking testbenches).' },
  { name: '$stop', format: '$stop [(n)];', desc: 'Halts simulation (treated as $finish by default in batch runs).' },
  { name: '$time', format: '$time', desc: 'Returns current 64-bit simulation timestamp in timescale units.' },
  { name: '$realtime', format: '$realtime', desc: 'Returns current simulation time as a floating-point number.' },
  { name: '$signed', format: '$signed(expr)', desc: 'Casts expression to two\'s-complement signed without altering bits.' },
  { name: '$unsigned', format: '$unsigned(expr)', desc: 'Casts expression to unsigned.' },
  { name: '$clog2', format: '$clog2(N)', desc: 'Ceiling log2 integer function (e.g., address width for depth N).' },
  { name: '$value$plusargs', format: '$value$plusargs("hex=%s", var)', desc: 'Reads runtime +key=value argument passed in Simulation Settings.' },
  { name: '$test$plusargs', format: '$test$plusargs("VERBOSE")', desc: 'Returns 1 if +VERBOSE runtime plusarg was supplied.' },
  { name: '$random', format: '$random [(seed)]', desc: 'Returns pseudo-random signed 32-bit integer.' },
  { name: '$urandom', format: '$urandom [(seed)]', desc: 'Returns unsigned 32-bit pseudo-random integer.' },
  { name: '$fopen', format: 'fd = $fopen("out.txt", "w");', desc: 'Opens a workspace file for I/O; pair with $fdisplay / $fclose.' },
  { name: '$fclose', format: '$fclose(fd);', desc: 'Closes a file descriptor opened with $fopen.' },
  { name: '$sqrt', format: '$sqrt(x)', desc: 'Real square root (v2005_math VPI, built in).' },
  { name: '$sin', format: '$sin(x)', desc: 'Real sine in radians (v2005_math VPI, built in).' },
];

export const VERILOG_DIRECTIVES = [
  { name: '`timescale', format: '`timescale 1ns / 1ps', desc: 'Sets simulation time unit and precision for subsequent modules.' },
  { name: '`define', format: '`define NAME value', desc: 'Defines a preprocessor macro referenced later as `NAME.' },
  { name: '`undef', format: '`undef NAME', desc: 'Undefines a previously defined macro.' },
  { name: '`include', format: '`include "header.vh"', desc: 'Inlines another file relative to source or Include Paths.' },
  { name: '`ifdef', format: '`ifdef MACRO ... `else ... `endif', desc: 'Conditionally compiles source if MACRO is defined.' },
  { name: '`ifndef', format: '`ifndef MACRO ... `endif', desc: 'Conditionally compiles source if MACRO is NOT defined (include guard).' },
  { name: '`else', format: '`else', desc: 'Alternative branch inside `ifdef / `ifndef.' },
  { name: '`endif', format: '`endif', desc: 'Ends an `ifdef / `ifndef preprocessor block.' },
  { name: '`default_nettype', format: '`default_nettype none', desc: 'Disables implicit 1-bit wire declarations to catch typos at compile time.' },
];

export const VERILOG_SNIPPETS = [
  { label: 'always @(posedge clk)', apply: 'always @(posedge clk) begin\n  \nend', detail: 'Sequential clocked block' },
  { label: 'always @(*)', apply: 'always @(*) begin\n  \nend', detail: 'Combinational block' },
  { label: 'initial dumpvars', apply: 'initial begin\n  $dumpfile("wave.vcd");\n  $dumpvars(0, testbench);\n  \n  $finish;\nend', detail: 'VCD testbench scaffold' },
  { label: 'module template', apply: 'module name(\n  input clk,\n  input reset\n);\n\nendmodule', detail: 'Module skeleton' },
];

export const VERILOG_OPERATORS = [
  { op: '=', name: 'Blocking assign', desc: 'Updates immediately inside comb always @(*) or initial blocks.' },
  { op: '<=', name: 'Nonblocking assign', desc: 'Schedules end-of-step update; REQUIRED in clocked always @(posedge clk).' },
  { op: '{a, b}', name: 'Concatenation', desc: 'Joins vectors MSb-to-LSb, e.g. {inst[31:26], 26\'b0}.' },
  { op: '{N{x}}', name: 'Replication', desc: 'Sign extension: {{16{imm[15]}}, imm[15:0]}.' },
  { op: '>>>', name: 'Arith right shift', desc: 'Preserves sign bit when LHS is declared signed or $signed(...).' },
  { op: '===', name: 'Case equality', desc: '4-state exact match including x and z bits (no x propagation).' },
  { op: 'c ? a : b', name: 'Ternary MUX', desc: 'Combinational 2:1 mux usable in assign expressions.' },
  { op: 'N\'hFF', name: 'Sized literal', desc: 'Width\'baseDigits (b=bin, o=oct, d=dec, h=hex), _ ignored.' },
];

export const SHORTCUTS = [
  ['Ctrl/Cmd + Enter', 'Run simulation'],
  ['Ctrl/Cmd + B', 'Compile syntax check'],
  ['Shift + F5', 'Stop simulation'],
  ['F10  /  Ctrl+K Z', 'Toggle Zen mode (preserves split panes)'],
  ['F11', 'Toggle browser Fullscreen'],
  ['Ctrl/Cmd + J', 'Toggle Output panel (Problems / Console / Waveform)'],
  ['Ctrl/Cmd + \\', 'Split active editor right'],
  ['Ctrl/Cmd + Shift + P', 'Command Palette'],
  ['Ctrl/Cmd + Space', 'Trigger autocomplete'],
  ['Ctrl/Cmd + Click', 'Inspect VCD signal or literal value'],
  ['Ctrl/Cmd + /', 'Toggle line comment (//)'],
  ['Ctrl/Cmd + G / H', 'Go to line / Find & Replace'],
  ['Alt + 1 / 2 / 3', 'Edit / Run / Wave workspace modes'],
];

const BY_NAME = new Map([
  ...VERILOG_KEYWORDS.map(x => [x.name, { ...x, category: x.cat }]),
  ...VERILOG_SYSTASKS.map(x => [x.name, { ...x, category: 'System task' }]),
  ...VERILOG_DIRECTIVES.map(x => [x.name, { ...x, category: 'Directive' }]),
]);

export function lookupHint(lineText = '', wordAtCursor = '') {
  if (wordAtCursor) {
    const exact = BY_NAME.get(wordAtCursor);
    if (exact) return exact;
  }
  const clean = lineText.replace(/\/\/.*$/, '');
  const directive = clean.match(/`[A-Za-z_]\w*/)?.[0];
  if (directive && BY_NAME.has(directive)) return BY_NAME.get(directive);
  const sys = clean.match(/\$[A-Za-z_][\w$]*/)?.[0];
  if (sys && BY_NAME.has(sys)) return BY_NAME.get(sys);
  for (const m of clean.matchAll(/\b[A-Za-z_]\w*\b/g)) {
    if (BY_NAME.has(m[0])) return BY_NAME.get(m[0]);
  }
  return null;
}

export function parseVerilogLiteral(raw) {
  if (!raw) return null;
  const s = raw.trim().replace(/_/g, '');
  const sized = /^(\d+)?'([sS]?)([bBoOdDhH])([0-9a-fA-FxXzZ?]+)$/.exec(s);
  if (sized) {
    const base = sized[3].toLowerCase();
    const digits = sized[4].toLowerCase().replace(/\?/g, 'z');
    if (/[xz]/.test(digits)) return { raw, width: Number(sized[1]) || digits.length * (base === 'h' ? 4 : base === 'o' ? 3 : 1), hex: `0x${digits}`, unsigned: '— (x/z)', signed: '— (x/z)', bin: digits };
    const radix = base === 'h' ? 16 : base === 'o' ? 8 : base === 'b' ? 2 : 10;
    const val = base === 'd' ? BigInt(digits) : BigInt(`${base === 'h' ? '0x' : base === 'o' ? '0o' : '0b'}${digits}`);
    const width = Number(sized[1]) || 32;
    const mask = (1n << BigInt(width)) - 1n;
    const masked = val & mask;
    const signBit = 1n << BigInt(width - 1);
    const signed = (sized[2] || (masked & signBit)) ? (masked & signBit ? masked - (1n << BigInt(width)) : masked) : masked;
    return {
      raw,
      width,
      hex: '0x' + masked.toString(16).padStart(Math.ceil(width / 4), '0'),
      unsigned: String(masked),
      signed: String(signed),
      bin: '0b' + masked.toString(2).padStart(Math.min(width, 64), '0'),
    };
  }
  if (/^(?:0x[0-9a-fA-F]+|\d+)$/.test(s)) {
    const val = BigInt(s);
    const width = val > 0xffffffffn ? 64 : 32;
    return {
      raw,
      width,
      hex: '0x' + val.toString(16),
      unsigned: String(val),
      signed: String(BigInt.asIntN(width, val)),
      bin: '0b' + val.toString(2),
    };
  }
  return null;
}

export function searchRef(query, tab = 'card') {
  const q = (query || '').trim().toLowerCase();
  const match = item => !q || `${item.name || item.op || item[0]} ${item.format || ''} ${item.desc || item.cat || item[1] || ''}`.toLowerCase().includes(q);
  if (tab === 'keywords') return VERILOG_KEYWORDS.filter(match);
  if (tab === 'systasks') return VERILOG_SYSTASKS.filter(match);
  if (tab === 'directives') return VERILOG_DIRECTIVES.filter(match);
  if (tab === 'shortcuts') return SHORTCUTS.filter(match);
  return {
    keywords: VERILOG_KEYWORDS.filter(match),
    systasks: VERILOG_SYSTASKS.filter(match),
    directives: VERILOG_DIRECTIVES.filter(match),
    operators: VERILOG_OPERATORS.filter(match),
  };
}
