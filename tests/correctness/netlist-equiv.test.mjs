// Equivalence oracle: evaluates synthesized JSON netlists from tgt-json.cc against real vvp simulation,
// plus Latch Precision & Recall across 16 designs.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileAndRun, elaborateJson } from './helpers.mjs';
import { flattenModule } from '../../web/elaborate-worker.js';

const showcaseSrc = readFileSync(new URL('../../web/showcase-projects.js', import.meta.url), 'utf8');
const extractConst = name => {
  const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(showcaseSrc);
  if (!match) throw new Error(`Missing ${name}`);
  return match[1].replace(/\\`/g, '`');
};

const padMsb = (bin, width) => bin.padStart(width, bin[0] === 'x' || bin[0] === 'z' ? bin[0] : '0').slice(-width);
const toSigned = (bits) => {
  const v = BigInt(`0b${bits}`);
  const w = BigInt(bits.length);
  return (v >> (w - 1n)) ? v - (1n << w) : v;
};
const bitsToMsb = (arr, bitMap) => arr.map(b => (typeof b === 'string' ? b : (bitMap.get(b) ?? 'x'))).reverse().join('');
const writeMsbToArr = (arr, msbStr, bitMap) => {
  const padded = padMsb(msbStr, arr.length);
  for (let i = 0; i < arr.length; i++) {
    const id = arr[i];
    if (typeof id === 'number') bitMap.set(id, padded[arr.length - 1 - i]);
  }
};
const valToMsb = (bigintVal, width) => {
  const mask = (1n << BigInt(width)) - 1n;
  return (bigintVal & mask).toString(2).padStart(width, '0');
};
const gateBit = (type, inputs) => {
  if (type === '$buf') return inputs[0];
  if (type === '$not' || type === '$_NOT_') return inputs[0] === '0' ? '1' : inputs[0] === '1' ? '0' : 'x';
  if (type === '$and' || type === '$_AND_' || type === '$nand') {
    const inv = type === '$nand';
    let r = inputs.includes('0') ? '0' : inputs.some(b => b !== '1') ? 'x' : '1';
    return inv ? (r === '0' ? '1' : r === '1' ? '0' : 'x') : r;
  }
  if (type === '$or' || type === '$_OR_' || type === '$nor') {
    const inv = type === '$nor';
    let r = inputs.includes('1') ? '1' : inputs.some(b => b !== '0') ? 'x' : '0';
    return inv ? (r === '0' ? '1' : r === '1' ? '0' : 'x') : r;
  }
  if (type === '$xor' || type === '$_XOR_' || type === '$xnor') {
    if (inputs.some(b => b !== '0' && b !== '1')) return 'x';
    const ones = inputs.filter(b => b === '1').length % 2;
    const r = ones ? '1' : '0';
    return type === '$xnor' ? (r === '0' ? '1' : '0') : r;
  }
  throw new Error(`Unsupported gate cell ${type}`);
};

function evalCombCell(cell, bitMap) {
  const t = cell.type;
  const conn = cell.connections || {};
  const get = pin => (conn[pin] ? bitsToMsb(conn[pin], bitMap) : null);
  const outBits = conn.Y || [];
  const outW = outBits.length;

  if (['$and', '$or', '$xor', '$nand', '$nor', '$xnor', '$not', '$buf', '$_AND_', '$_OR_', '$_XOR_', '$_NOT_'].includes(t)) {
    const ins = Object.entries(conn).filter(([k]) => k !== 'Y').map(([, bits]) => bitsToMsb(bits, bitMap));
    const width = outW;
    const res = [];
    for (let i = 0; i < width; i++) {
      res.push(gateBit(t, ins.map(s => s[s.length - 1 - i] ?? '0')));
    }
    writeMsbToArr(outBits, res.reverse().join(''), bitMap);
    return;
  }
  if (t === '$mux' || t === '$_MUX_') {
    const a = get('A'), b = get('B'), s = get('S');
    let out = '';
    for (let i = 0; i < outW; i++) {
      const ca = a[i] ?? 'x', cb = b[i] ?? 'x';
      if (s === '0') out += ca;
      else if (s === '1') out += cb;
      else out += ca === cb ? ca : 'x';
    }
    writeMsbToArr(outBits, out, bitMap);
    return;
  }
  if (t === '$pmux') {
    const s = get('S');
    const ds = Object.keys(conn).filter(k => /^D\d+$/.test(k)).sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)));
    if (/^[01]+$/.test(s)) {
      const idx = parseInt(s, 2);
      if (idx < ds.length) writeMsbToArr(outBits, get(ds[idx]), bitMap);
      else writeMsbToArr(outBits, 'x'.repeat(outW), bitMap);
    } else {
      writeMsbToArr(outBits, 'x'.repeat(outW), bitMap);
    }
    return;
  }
  if (t.startsWith('$reduce_')) {
    const a = [...get('A')];
    const fn = t === '$reduce_and' || t === '$reduce_nand' ? '$and' : t === '$reduce_or' || t === '$reduce_nor' ? '$or' : '$xor';
    let acc = a.reduce((p, c) => gateBit(fn, [p, c]));
    if (t === '$reduce_nand' || t === '$reduce_nor' || t === '$reduce_xnor') acc = gateBit('$not', [acc]);
    writeMsbToArr(outBits, acc, bitMap);
    return;
  }
  if (t === '$shiftx' || t === '$part') {
    const a = get('A'), b = get('B');
    if (t === '$shiftx') {
      if (!/^[01]+$/.test(b)) { writeMsbToArr(outBits, 'x'.repeat(outW), bitMap); return; }
      const shift = parseInt(b, 2);
      const low = a.length - shift - outW;
      let out = '';
      for (let i = 0; i < outW; i++) {
        const pos = low + i;
        out += pos >= 0 && pos < a.length ? a[pos] : 'x';
      }
      writeMsbToArr(outBits, out, bitMap);
      return;
    }
  }

  const a = get('A');
  const b = get('B');
  if (t === '$eqx' || t === '$nex') {
    const eq = a === b ? '1' : '0';
    writeMsbToArr(outBits, t === '$nex' ? (eq === '1' ? '0' : '1') : eq, bitMap);
    return;
  }
  if ((a && /[xz]/.test(a)) || (b && /[xz]/.test(b))) {
    writeMsbToArr(outBits, 'x'.repeat(outW), bitMap);
    return;
  }
  const ua = BigInt(`0b${a || '0'}`), ub = BigInt(`0b${b || '0'}`);
  const isSigned = cell.parameters?.A_SIGNED === '00000000000000000000000000000001' || cell.parameters?.A_SIGNED === 1;
  const cmpA = isSigned ? toSigned(a || '0') : ua;
  const cmpB = isSigned ? toSigned(b || '0') : ub;
  if (t === '$add') writeMsbToArr(outBits, valToMsb(ua + ub, outW), bitMap);
  else if (t === '$sub') writeMsbToArr(outBits, valToMsb(ua - ub, outW), bitMap);
  else if (t === '$mul') writeMsbToArr(outBits, valToMsb(ua * ub, outW), bitMap);
  else if (t === '$eq') writeMsbToArr(outBits, ua === ub ? '1' : '0', bitMap);
  else if (t === '$ne') writeMsbToArr(outBits, ua !== ub ? '1' : '0', bitMap);
  else if (t === '$gt') writeMsbToArr(outBits, cmpA > cmpB ? '1' : '0', bitMap);
  else if (t === '$ge') writeMsbToArr(outBits, cmpA >= cmpB ? '1' : '0', bitMap);
  else if (t === '$lt') writeMsbToArr(outBits, cmpA < cmpB ? '1' : '0', bitMap);
  else if (t === '$le') writeMsbToArr(outBits, cmpA <= cmpB ? '1' : '0', bitMap);
  else if (t === '$shl') writeMsbToArr(outBits, valToMsb(ua << ub, outW), bitMap);
  else if (t === '$shr') writeMsbToArr(outBits, valToMsb(ua >> ub, outW), bitMap);
  else if (t === '$sshr') {
    const sa = toSigned(padMsb(a, Math.max(outW, a.length)));
    writeMsbToArr(outBits, valToMsb(sa >> ub, outW), bitMap);
  } else {
    throw new Error(`Unsupported comb cell in equivalence checker: ${t}`);
  }
}

function evalNetlist(yosysJson, topModule, cycleInputs, { clockName = null } = {}) {
  const flat = flattenModule(yosysJson, topModule);
  const mod = flat.modules[topModule];
  const bitMap = new Map();
  const seqCells = [];
  const combCells = [];

  for (const [name, cell] of Object.entries(mod.cells || {})) {
    if (/^\$[sa]?dff/.test(cell.type)) seqCells.push({ name, cell });
    else if (cell.type === '$dlatch' || cell.type === '$proc' || cell.type === '$mem') {
      throw new Error(`Unexpected sequential/unmodeled cell ${cell.type} in equiv test`);
    } else combCells.push({ name, cell });
  }

  // Initialize flip-flop Q bits to x until reset/clocked.
  const ffState = new Map();
  for (const { name, cell } of seqCells) ffState.set(name, '0'.repeat(cell.connections.Q.length));

  const settleComb = (inputs) => {
    for (const [pName, port] of Object.entries(mod.ports || {})) {
      if (port.direction === 'input' && Object.hasOwn(inputs, pName)) {
        writeMsbToArr(port.bits, inputs[pName], bitMap);
      }
    }
    for (const { name, cell } of seqCells) writeMsbToArr(cell.connections.Q, ffState.get(name), bitMap);
    for (let pass = 0; pass < combCells.length + 2; pass++) {
      let changed = false;
      for (const { cell } of combCells) {
        const before = bitsToMsb(cell.connections.Y, bitMap);
        evalCombCell(cell, bitMap);
        if (bitsToMsb(cell.connections.Y, bitMap) !== before) changed = true;
      }
      if (!changed) break;
    }
  };

  const outputs = [];
  for (const inputs of cycleInputs) {
    settleComb({ ...inputs, ...(clockName ? { [clockName]: '0' } : {}) });
    if (clockName && seqCells.length) {
      const next = new Map();
      for (const { name, cell } of seqCells) {
        const conn = cell.connections;
        const qW = conn.Q.length;
        const arst = conn.ARST ? bitsToMsb(conn.ARST, bitMap) : '0';
        const aset = conn.ASET ? bitsToMsb(conn.ASET, bitMap) : '0';
        const srst = conn.SRST ? bitsToMsb(conn.SRST, bitMap) : '0';
        const sset = conn.SSET ? bitsToMsb(conn.SSET, bitMap) : '0';
        const en = conn.EN ? bitsToMsb(conn.EN, bitMap) : '1';
        if (arst === '1' || srst === '1') next.set(name, '0'.repeat(qW));
        else if (aset === '1' || sset === '1') next.set(name, '1'.repeat(qW));
        else if (en === '0') next.set(name, ffState.get(name));
        else next.set(name, bitsToMsb(conn.D, bitMap));
      }
      for (const [name, val] of next) ffState.set(name, val);
      settleComb({ ...inputs, [clockName]: '0' });
    }
    const row = {};
    for (const [pName, port] of Object.entries(mod.ports || {})) {
      if (port.direction !== 'input') row[pName] = bitsToMsb(port.bits, bitMap);
    }
    outputs.push(row);
  }
  return outputs;
}

async function verifyEquivalent(name, sources, topModule, cycleInputs, { clockName = null } = {}) {
  const elab = await elaborateJson(sources, { top: topModule });
  assert.equal(elab.ok, true, `${name}: elaborate failed: ${elab.log}`);
  const netOuts = evalNetlist(elab.yosysJson, topModule, cycleInputs, { clockName });

  // Reference vvp run over exact same vectors.
  const mod = elab.yosysJson.modules[topModule];
  const inPorts = Object.entries(mod.ports).filter(([, p]) => p.direction === 'input');
  const outPorts = Object.entries(mod.ports).filter(([, p]) => p.direction !== 'input');
  const decls = [
    ...inPorts.map(([n, p]) => `  reg ${p.bits.length > 1 ? `[${p.bits.length - 1}:0] ` : ''}${n} = 0;`),
    ...outPorts.map(([n, p]) => `  wire ${p.bits.length > 1 ? `[${p.bits.length - 1}:0] ` : ''}${n};`),
  ].join('\n');
  const conn = Object.keys(mod.ports).map(n => `.${n}(${n})`).join(', ');
  const body = cycleInputs.map((inp, idx) => {
    const sets = inPorts.filter(([n]) => n !== clockName && Object.hasOwn(inp, n)).map(([n, p]) => `${n} = ${p.bits.length}'b${inp[n]};`).join(' ');
    const clkPulse = clockName ? `${clockName} = 1; #1; ${clockName} = 0; ` : '';
    const fmt = outPorts.map(([n]) => `${n}=%b`).join(' ');
    const args = outPorts.map(([n]) => n).join(', ');
    return `    ${sets} #1; ${clkPulse}#1; $display("VEC ${idx}: ${fmt}", ${args});`;
  }).join('\n');
  const tb = `module equiv_tb;\n${decls}\n  ${topModule} dut(${conn});\n  initial begin\n${body}\n    $finish;\n  end\nendmodule\n`;

  const { output } = await compileAndRun({ ...sources, 'equiv_tb.v': tb }, { top: 'equiv_tb' });
  for (let i = 0; i < cycleInputs.length; i++) {
    const line = output.find(l => l.startsWith(`VEC ${i}: `));
    assert.ok(line, `${name}: missing VEC ${i}`);
    for (const [pName] of outPorts) {
      const m = new RegExp(`\\b${pName}=([01xz]+)`).exec(line);
      assert.equal(netOuts[i][pName], m[1], `${name} vec ${i} port ${pName}: net=${netOuts[i][pName]} vvp=${m[1]}`);
    }
  }
}

const bin = (n, w) => (BigInt.asUintN(w, BigInt(n))).toString(2).padStart(w, '0');
let checks = 0;
const check = async (name, fn) => {
  try { await fn(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};

// ---------------- 10 Netlist vs VVP equivalence modules ----------------
await check('equiv: 8-bit add/sub unit', () => verifyEquivalent('add_sub', {
  'm.v': 'module add_sub(input [7:0] a, b, input sub, output [7:0] y, output zero);\n  assign y = sub ? (a - b) : (a + b);\n  assign zero = (y == 8\'d0);\nendmodule',
}, 'add_sub', [
  { a: bin(0, 8), b: bin(0, 8), sub: '0' },
  { a: bin(10, 8), b: bin(25, 8), sub: '0' },
  { a: bin(255, 8), b: bin(1, 8), sub: '0' },
  { a: bin(7, 8), b: bin(7, 8), sub: '1' },
  { a: bin(3, 8), b: bin(10, 8), sub: '1' },
  { a: bin(0x80, 8), b: bin(0x7f, 8), sub: '1' },
]));

await check('equiv: 4:1 case mux ($pmux)', () => verifyEquivalent('mux4', {
  'm.v': `module mux4(input [3:0] a, b, c, d, input [1:0] sel, output reg [3:0] y);
    always @(*) case (sel) 2'd0: y=a; 2'd1: y=b; 2'd2: y=c; default: y=d; endcase
  endmodule`,
}, 'mux4', [
  { a: '0001', b: '0010', c: '0100', d: '1000', sel: '00' },
  { a: '0001', b: '0010', c: '0100', d: '1000', sel: '01' },
  { a: '0001', b: '0010', c: '0100', d: '1000', sel: '10' },
  { a: '0001', b: '0010', c: '0100', d: '1000', sel: '11' },
  { a: '1111', b: '1010', c: '0101', d: '0000', sel: '10' },
]));

await check('equiv: priority if/else-if encoder', () => verifyEquivalent('prio', {
  'm.v': `module prio(input [3:0] req, output reg [1:0] code, output reg valid);
    always @(*) begin
      valid = 1'b1;
      if (req[3]) code = 2'd3;
      else if (req[2]) code = 2'd2;
      else if (req[1]) code = 2'd1;
      else if (req[0]) code = 2'd0;
      else begin code = 2'd0; valid = 1'b0; end
    end
  endmodule`,
}, 'prio', Array.from({ length: 16 }, (_, i) => ({ req: bin(i, 4) }))));

await check('equiv: bit-slice, concat, repeat, and reductions', () => verifyEquivalent('bits', {
  'm.v': `module bits(input [7:0] x, input s, output [7:0] y, output parity, output nonzero);
    assign y = s ? {2{x[3:0]}} : {x[1:0], x[7:2]};
    assign parity = ^x;
    assign nonzero = |x;
  endmodule`,
}, 'bits', [0, 1, 0x55, 0xaa, 0xa5, 0x0f, 0xf0, 0xff].flatMap(x => [{ x: bin(x, 8), s: '0' }, { x: bin(x, 8), s: '1' }])));

await check('equiv: signed compare & arithmetic shift right', () => verifyEquivalent('scmp', {
  'm.v': `module scmp(input [7:0] a, b, input [2:0] sh, output lt_u, output [7:0] shl_y, output [7:0] shr_y);
    assign lt_u = (a < b);
    assign shl_y = a << sh;
    assign shr_y = a >> sh;
  endmodule`,
}, 'scmp', [
  { a: bin(0x81, 8), b: bin(0x01, 8), sh: '001' },
  { a: bin(0x05, 8), b: bin(0x05, 8), sh: '011' },
  { a: bin(0x01, 8), b: bin(0xff, 8), sh: '111' },
  { a: bin(0x5a, 8), b: bin(0x20, 8), sh: '010' },
]));

await check('equiv: mips_alu from showcase-projects.js', () => {
  const mipsSrc = extractConst('MIPS_CPU');
  const vecs = [];
  for (const op of [0, 1, 2, 6, 7, 3]) {
    vecs.push({ a: bin(7, 32), b: bin(3, 32), op: bin(op, 3) });
    vecs.push({ a: bin(-5, 32), b: bin(2, 32), op: bin(op, 3) });
    vecs.push({ a: bin(0x80000000, 32), b: bin(0x7fffffff, 32), op: bin(op, 3) });
  }
  return verifyEquivalent('mips_alu', { 'mips_cpu.v': mipsSrc }, 'mips_alu', vecs);
});

await check('equiv: mips_control decoder from showcase-projects.js', () => {
  const mipsSrc = extractConst('MIPS_CPU');
  const ops = [
    [0x00, 0x20], [0x00, 0x22], [0x00, 0x24], [0x00, 0x25], [0x00, 0x2a],
    [0x08, 0x00], [0x23, 0x00], [0x2b, 0x00], [0x04, 0x00], [0x05, 0x00], [0x02, 0x00], [0x3f, 0x00],
  ];
  return verifyEquivalent('mips_control', { 'mips_cpu.v': mipsSrc }, 'mips_control',
    ops.map(([op, funct]) => ({ op: bin(op, 6), funct: bin(funct, 6) })));
});

await check('equiv: parameterized child hierarchy ($paramod)', () => verifyEquivalent('param_top', {
  'm.v': `module inc #(parameter W = 4) (input [W-1:0] in, output [W-1:0] out);
    assign out = in + {{(W-1){1'b0}}, 1'b1};
  endmodule
  module param_top(input [3:0] a, input [5:0] b, output [3:0] ya, output [5:0] yb);
    inc #(4) u4(a, ya);
    inc #(6) u6(b, yb);
  endmodule`,
}, 'param_top', [
  { a: '0000', b: '000000' },
  { a: '1111', b: '011111' },
  { a: '0101', b: '111111' },
]));

await check('equiv: sync-reset counter ($dff/$sdff/$mux)', () => verifyEquivalent('cnt', {
  'm.v': `module cnt(input clk, rst, en, output reg [3:0] q);
    always @(posedge clk) if (rst) q <= 4'd0; else if (en) q <= q + 4'd1;
  endmodule`,
}, 'cnt', [
  { rst: '1', en: '0' }, { rst: '0', en: '1' }, { rst: '0', en: '1' },
  { rst: '0', en: '0' }, { rst: '0', en: '1' }, { rst: '1', en: '1' }, { rst: '0', en: '1' },
], { clockName: 'clk' }));

await check('equiv: async-reset register ($adff/$adffe)', () => verifyEquivalent('areg', {
  'm.v': `module areg(input clk, arst, en, input [3:0] d, output reg [3:0] q);
    always @(posedge clk or posedge arst) if (arst) q <= 4'd0; else if (en) q <= d;
  endmodule`,
}, 'areg', [
  { arst: '1', en: '0', d: '1010' },
  { arst: '0', en: '1', d: '1010' },
  { arst: '0', en: '0', d: '0101' },
  { arst: '0', en: '1', d: '1111' },
  { arst: '1', en: '1', d: '1111' },
], { clockName: 'clk' }));

// ---------------- 16-case Latch Precision & Recall Suite ----------------
const latchCases = [
  ['latch: simple missing-else', 'module l1(input en, d, output reg q); always @(*) if (en) q = d; endmodule', 'l1', true],
  ['latch: incomplete case', 'module l2(input [1:0] s, output reg y); always @(*) case (s) 2\'d0: y=1; 2\'d1: y=0; endcase endmodule', 'l2', true],
  ['latch: nested if missing branch', 'module l3(input a, b, output reg y); always @(*) if (a) begin if (b) y = 1; end else y = 0; endmodule', 'l3', true],
  ['latch: partial output in multi-out always', 'module l4(input en, a, output reg x, y); always @(*) begin x = a; if (en) y = a; end endmodule', 'l4', true],
  ['latch: multi-bit incomplete if', 'module l5(input ld, input [3:0] d, output reg [3:0] q); always @(*) if (ld) q = d; endmodule', 'l5', true],
  ['latch: casez without default', 'module l6(input [1:0] s, output reg y); always @(*) casez (s) 2\'b1?: y=1; endcase endmodule', 'l6', true],
  ['latch: two-level else-if missing final else', 'module l7(input a, b, output reg y); always @(*) if (a) y = 1; else if (b) y = 0; endmodule', 'l7', true],
  ['latch: datapath_slice showcase', extractConst('DATAPATH_SLICE'), 'leaky_ctrl', true],
  ['clean: default-at-top combinational', 'module c1(input en, d, output reg q); always @(*) begin q = 0; if (en) q = d; end endmodule', 'c1', false],
  ['clean: complete if-else', 'module c2(input s, a, b, output reg y); always @(*) if (s) y = a; else y = b; endmodule', 'c2', false],
  ['clean: full case with default', 'module c3(input [1:0] s, output reg y); always @(*) case (s) 2\'d0: y=0; 2\'d1: y=1; default: y=0; endcase endmodule', 'c3', false],
  ['clean: clocked DFF enable (no else is flip-flop, NOT latch)', 'module c4(input clk, en, d, output reg q); always @(posedge clk) if (en) q <= d; endmodule', 'c4', false],
  ['clean: continuous assign', 'module c5(input a, b, output y); assign y = a ^ b; endmodule', 'c5', false],
  ['clean: mips_control showcase', extractConst('MIPS_CPU'), 'mips_control', false],
  ['clean: alu32 showcase', extractConst('ALU32'), 'alu32', false],
  ['clean: multicycle_fsm showcase', extractConst('MULTICYCLE_FSM'), 'multicycle_fsm', false],
];

for (const [label, src, top, expectLatch] of latchCases) {
  await check(label, async () => {
    const elab = await elaborateJson({ 't.v': src }, { top });
    assert.equal(elab.ok, true, `${label}: elaborate failed: ${elab.log}`);
    const hasCell = Object.values(elab.yosysJson.modules[top].cells).some(c => c.type === '$dlatch');
    const hasDiag = elab.diagnostics.some(d => d.kind === 'latch');
    assert.equal(hasCell, expectLatch, `${label}: $dlatch cell=${hasCell}, expected=${expectLatch}`);
    assert.equal(hasDiag, expectLatch, `${label}: latch diag=${hasDiag}, expected=${expectLatch}`);
  });
}

console.log(`Netlist equivalence & latch precision suite passed (${checks} checks)`);
