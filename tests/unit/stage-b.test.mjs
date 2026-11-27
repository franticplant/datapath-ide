import assert from 'node:assert/strict';
import { formatVerilog } from '../../web/verilog-format.js';
import { buildModuleHierarchy } from '../../web/hierarchy.js';
import { computeInlineValues } from '../../web/inline-values.js';
import { extractFsmStates } from '../../web/fsm-states.js';
import { parseSliceSpec, sliceBits } from '../../web/wave-utils.js';
import { MIPS_TEMPLATE } from '../../web/mips-template.js';
let checks = 0;
function check(fn) { fn(); checks++; }
check(() => { const source = 'module m;\r\ninitial begin\r\n$display("begin // end"); // end\r\nend\r\nendmodule\r\n'; const out = formatVerilog(source); assert.equal(out, 'module m;\n  initial begin\n    $display("begin // end"); // end\n  end\nendmodule\n'); assert.equal(formatVerilog(out), out); });
check(() => { const source = 'module m;\n/* begin\n * end */\ncase (x)\n1: x = 1;\nendcase\nendmodule'; const out = formatVerilog(source); assert.ok(out.includes('/* begin\n * end */')); assert.equal(formatVerilog(out), out); });
check(() => { const files = { 'a.v': 'module top;\n child #( .P(1 + (2)) ) u_child();\nendmodule\nmodule child; endmodule', 'b.v': 'module unused; endmodule' }; const h = buildModuleHierarchy(files); assert.equal(h.roots.find(x => x.name === 'top').children[0].instance.instance, 'u_child'); assert.equal(h.roots.find(x => x.name === 'top').children[0].instance.line, 2); assert.equal(buildModuleHierarchy(files, new Set(['b.v'])).modules.length, 2); });
check(() => { const h = buildModuleHierarchy({ 'a.sv': 'module a; b x(); endmodule\nmodule b; a y(); endmodule' }); assert.equal(h.roots.length, 1); assert.equal(h.flat.length, 3); assert.equal(h.flat[2].cyclic, true); });
check(() => { const h = buildModuleHierarchy(MIPS_TEMPLATE); assert.ok(h.modules.some(m => m.name === 'mips_alu')); assert.ok(h.flat.some(m => m.instance?.instance === 'u_alu')); });
check(() => { const trace = { signals: [{ path: 'tb.a.x', width: 4, changes: [{time: 0n, value: '0010'}, {time: 5n, value: '1111'}] }, { path: 'tb.b.x', width: 4, changes: [{time: 0n, value: '0011'}] }, { path: 'tb.a.y', width: 1, changes: [{time: 0n, value: '1'}] }] }; const source = 'module a;\nwire [3:0] x; // y\nwire y;\nassign x = y;\nendmodule'; const values = computeInlineValues(source, trace, 5n, { scopeHint: 'tb.a', radix: 'hex', maxPerLine: 1 }); assert.equal(values.find(x => x.line === 2).items[0].value, '0xf'); assert.equal(values.find(x => x.line === 4).items.length, 1); assert.ok(!values.some(x => x.line === 1)); });
check(() => { assert.deepEqual(parseSliceSpec(' pc [ 7 : 4 ] '), { signal: 'pc', msb: 7, lsb: 4 }); assert.deepEqual(parseSliceSpec('a[3]'), { signal: 'a', msb: 3, lsb: 3 }); assert.equal(parseSliceSpec('a[1:4]'), null); });
check(() => { assert.equal(sliceBits('10xz0011', 8, 5, 2), 'xz00'); assert.equal(sliceBits('z', 4, 3, 1), 'zzz'); assert.throws(() => sliceBits('1', 4, 4, 0), RangeError); });
check(() => {
  // Default 'hex' (and auto/state) radix shows FSM state names; explicit numeric radices still win.
  const source = 'module fsm(input clk);\n  localparam [2:0] FETCH = 3\'d0, DECODE = 3\'d1;\n  reg [2:0] state, next_state;\n  always @(posedge clk) state <= next_state;\n  always @(*) case (state) FETCH: next_state = DECODE; default: next_state = FETCH; endcase\nendmodule\n';
  const trace = { signals: [{ path: 'tb.dut.state', width: 3, changes: [{ time: 0n, value: '000' }] }, { path: 'tb.dut.next_state', width: 3, changes: [{ time: 0n, value: '001' }] }] };
  const at = (radix, fsmMap = extractFsmStates({ 'fsm.v': source })) => computeInlineValues(source, trace, 0n, { scopeHint: 'tb.dut', radix, fsmMap }).find(x => x.line === 3).items;
  for (const radix of ['hex', 'auto', 'state']) assert.deepEqual(at(radix).map(x => `${x.name}=${x.value}`), ['state=FETCH', 'next_state=DECODE'], radix);
  assert.deepEqual(at('bin').map(x => x.value), ['0b000', '0b001']);
  assert.deepEqual(at('dec').map(x => x.value), ['0', '1']);
  assert.deepEqual(at('hex', null).map(x => x.value), ['0x0', '0x1']);
});
console.log(`Stage B unit checks passed (${checks})`);
