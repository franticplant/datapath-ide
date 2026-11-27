// MIPS32 ISA oracle, seeded 500-iteration fuzz round-trip, and live CPU execution vs JS reference interpreter.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assembleMips } from '../../web/mips-asm.js';
import { decodeMips, MIPS_REGISTERS } from '../../web/mips-decode.js';
import { compileAndRun } from './helpers.mjs';

const showcaseSrc = readFileSync(new URL('../../web/showcase-projects.js', import.meta.url), 'utf8');
const extractConst = name => {
  const match = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`).exec(showcaseSrc);
  if (!match) throw new Error(`Missing ${name}`);
  return match[1].replace(/\\`/g, '`');
};

let checks = 0;
const check = async (name, fn) => {
  try { await fn(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};
const hex = w => (w >>> 0).toString(16).padStart(8, '0');

await check('all 32 register numbers and ABI aliases encode equivalently', () => {
  for (let i = 0; i < 32; i++) {
    const a = assembleMips(`add ${MIPS_REGISTERS[i]}, $zero, $zero`).words[0];
    const b = assembleMips(`add $${i}, $0, $0`).words[0];
    assert.equal(a, b, `register $${i} (${MIPS_REGISTERS[i]}) mismatch`);
  }
  assert.equal(assembleMips('add $fp, $0, $0').words[0], assembleMips('add $s8, $0, $0').words[0]);
});

await check('immediate bounds & li/subi expansions', () => {
  const { words } = assembleMips(`
    addi $t0, $zero, -32768
    addi $t1, $zero, 32767
    ori  $t2, $zero, 0xffff
    li   $t3, 0x80000000
    li   $t4, 0xffffffff
    li   $t5, -1
    subi $t6, $t1, 100
  `);
  assert.deepEqual(words.map(hex), [
    '20088000', // addi $t0, $zero, -32768
    '20097fff', // addi $t1, $zero, 32767
    '340affff', // ori $t2, $zero, 0xffff
    '3c0b8000', // lui $t3, 0x8000
    '3c0cffff', // lui $t4, 0xffff
    '358cffff', // ori $t4, $t4, 0xffff
    '240dffff', // addiu $t5, $zero, -1
    '212eff9c', // addi $t6, $t1, -100
  ]);
});

await check('500-iteration seeded fuzz: assemble -> decode -> re-assemble round-trip', () => {
  let seed = 0x13572468;
  const rnd = max => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed % max; };
  const regs = Array.from({ length: 32 }, (_, i) => MIPS_REGISTERS[i]);
  const r3 = ['add', 'addu', 'sub', 'subu', 'and', 'or', 'xor', 'nor', 'slt', 'sltu'];
  const shifts = ['sll', 'srl', 'sra'];
  const immSigned = ['addi', 'addiu', 'slti', 'sltiu'];
  const immUnsig = ['andi', 'ori', 'xori'];
  const mem = ['lw', 'sw', 'lb', 'lbu', 'lh', 'lhu', 'sb', 'sh'];

  for (let iter = 0; iter < 500; iter++) {
    const kind = iter % 6;
    let line;
    const rd = regs[rnd(32)], rs = regs[rnd(32)], rt = regs[rnd(32)];
    if (kind === 0) line = `${r3[rnd(r3.length)]} ${rd}, ${rs}, ${rt}`;
    else if (kind === 1) line = `${shifts[rnd(shifts.length)]} ${rd}, ${rt}, ${rnd(32)}`;
    else if (kind === 2) line = `${immSigned[rnd(immSigned.length)]} ${rt}, ${rs}, ${rnd(65536) - 32768}`;
    else if (kind === 3) line = `${immUnsig[rnd(immUnsig.length)]} ${rt}, ${rs}, ${rnd(65536)}`;
    else if (kind === 4) line = `${mem[rnd(mem.length)]} ${rt}, ${rnd(4096) - 2048}(${rs})`;
    else line = `lui ${rt}, ${rnd(65536)}`;

    const w1 = assembleMips(line);
    assert.equal(w1.ok, true, `${line}: ${JSON.stringify(w1.diagnostics)}`);
    const dec = decodeMips(w1.words[0]);
    assert.ok(dec?.asm, `decode failed on ${hex(w1.words[0])}`);
    const w2 = assembleMips(dec.asm);
    assert.equal(w2.ok, true, `re-assemble ${dec.asm}: ${JSON.stringify(w2.diagnostics)}`);
    assert.equal(w2.words[0], w1.words[0], `round-trip mismatch for ${line} -> ${dec.asm}`);
  }
});

// Minimal JS MIPS reference interpreter for the single-cycle subset.
function simMipsRef(words, maxSteps = 200) {
  const r = new Int32Array(32);
  const dmem = new Int32Array(64);
  let pc = 0;
  for (let step = 0; step < maxSteps; step++) {
    const w = words[pc >>> 2] ?? 0;
    const op = w >>> 26, rs = (w >>> 21) & 31, rt = (w >>> 16) & 31, rd = (w >>> 11) & 31, funct = w & 63;
    const simm = (w & 0xffff) << 16 >> 16;
    let nextPc = (pc + 4) >>> 0;
    if (op === 0) {
      if (funct === 0x20) r[rd] = (r[rs] + r[rt]) | 0;
      else if (funct === 0x22) r[rd] = (r[rs] - r[rt]) | 0;
      else if (funct === 0x24) r[rd] = r[rs] & r[rt];
      else if (funct === 0x25) r[rd] = r[rs] | r[rt];
      else if (funct === 0x2a) r[rd] = r[rs] < r[rt] ? 1 : 0;
    } else if (op === 0x08) r[rt] = (r[rs] + simm) | 0;
    else if (op === 0x23) r[rt] = dmem[((r[rs] + simm) >>> 2) & 63];
    else if (op === 0x2b) dmem[((r[rs] + simm) >>> 2) & 63] = r[rt];
    else if (op === 0x04 && r[rs] === r[rt]) nextPc = (nextPc + (simm << 2)) >>> 0;
    else if (op === 0x05 && r[rs] !== r[rt]) nextPc = (nextPc + (simm << 2)) >>> 0;
    else if (op === 0x02) nextPc = ((nextPc & 0xf0000000) | ((w & 0x3ffffff) << 2)) >>> 0;
    r[0] = 0;
    if (nextPc === pc) break;
    pc = nextPc;
  }
  return { regs: Array.from(r, v => v >>> 0), dmem: Array.from(dmem, v => v >>> 0) };
}

await check('end-to-end CPU simulation matches JS MIPS interpreter bit-for-bit', async () => {
  const prog = `
        addi $s0, $zero, 0      # sum = 0
        addi $t0, $zero, 1      # i = 1
        addi $t1, $zero, 6      # limit = 6 (loop 1..5 -> sum = 15)
        addi $t2, $zero, 0      # byte offset = 0
loop:   beq  $t0, $t1, after
        add  $s0, $s0, $t0
        sw   $s0, 0($t2)
        addi $t2, $t2, 4
        addi $t0, $t0, 1
        bne  $t0, $t1, loop
after:  lw   $s1, 16($zero)     # word 4 = 15
        addi $t3, $zero, -3
        slt  $s2, $t3, $s1      # -3 < 15 -> 1
        slt  $s3, $s1, $t3      # 15 < -3 -> 0
        sub  $t4, $s1, $t3      # 15 - (-3) = 18
        or   $t5, $t4, $s2      # 18 | 1 = 19
        and  $t6, $t5, $s1      # 19 & 15 = 3
done:   j    done
  `;
  const asm = assembleMips(prog);
  assert.equal(asm.ok, true, JSON.stringify(asm.diagnostics));
  const ref = simMipsRef(asm.words);

  const mipsCpu = extractConst('MIPS_CPU');
  const tb = `\`timescale 1ns/1ns
  module mips_oracle_tb;
    reg clk = 0, reset = 1; wire [31:0] pc; integer k;
    mips_cpu dut(.clk(clk), .reset(reset), .pc_out(pc));
    always #5 clk = ~clk;
    initial begin
      #12 reset = 0;
      #500;
      for (k = 0; k < 32; k = k + 1) $display("R%0d=%08x", k, dut.u_rf.regs[k]);
      for (k = 0; k < 8; k = k + 1) $display("M%0d=%08x", k, dut.u_dmem.mem[k]);
      $finish;
    end
  endmodule`;

  const { output } = await compileAndRun(
    { 'mips_cpu.v': mipsCpu, 'tb.v': tb },
    { top: 'mips_oracle_tb' },
    { 'program.mem': asm.memText },
  );

  for (let k = 0; k < 32; k++) {
    const line = output.find(l => l.startsWith(`R${k}=`));
    assert.equal(line, `R${k}=${hex(ref.regs[k])}`, `reg $${k} mismatch`);
  }
  for (let k = 0; k < 8; k++) {
    const line = output.find(l => l.startsWith(`M${k}=`));
    assert.equal(line, `M${k}=${hex(ref.dmem[k])}`, `dmem[${k}] mismatch`);
  }
  assert.equal(ref.regs[16], 15); // $s0
  assert.equal(ref.regs[17], 15); // $s1
  assert.equal(ref.regs[18], 1);  // $s2
  assert.equal(ref.regs[19], 0);  // $s3
  assert.equal(ref.regs[14], 3);  // $t6
});

console.log(`MIPS ISA oracle suite passed (${checks} checks)`);
