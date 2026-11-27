// Differential correctness check: Live DUT (vvp-live.cc + liveWrapper) vs static Verilog TB.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { compileAndRun, runLiveSession } from './helpers.mjs';
import { parseModulePorts, liveWrapper } from '../../web/board.js';

const showcaseSrc = readFileSync(new URL('../../web/showcase-projects.js', import.meta.url), 'utf8');
const extractConst = name => {
  const re = new RegExp(`const ${name} = \`([\\s\\S]*?)\`;`);
  const match = re.exec(showcaseSrc);
  if (!match) throw new Error(`Could not extract ${name}`);
  return match[1].replace(/\\`/g, '`');
};

const pad = (val, width) => val.toString(2).padStart(width, '0').slice(-width);

async function diffCompare(name, source, moduleName, clockName, cycles, outputs) {
  const ports = parseModulePorts(source, moduleName);
  const wrapper = liveWrapper(moduleName, ports);
  const liveSnaps = await runLiveSession(
    { 'dut.v': source, '_live_board_tb.v': wrapper },
    '_live_board_tb',
    clockName,
    cycles,
  );

  // Build equivalent static TB applying the exact same inputs right after reset/neg-edge like live mode.
  const inputPorts = ports.filter(p => p.dir === 'input' && p.name !== clockName);
  const outPorts = ports.filter(p => p.dir !== 'input' && outputs.includes(p.name));
  const initRegs = ports.filter(p => p.dir === 'input').map(p => `  reg ${p.width > 1 ? `[${p.width - 1}:0] ` : ''}${p.name} = 0;`).join('\n');
  const outWires = ports.filter(p => p.dir !== 'input').map(p => `  wire ${p.width > 1 ? `[${p.width - 1}:0] ` : ''}${p.name};`).join('\n');
  const conn = ports.map(p => `.${p.name}(${p.name})`).join(', ');
  const stim = cycles.map((inp, idx) => {
    const sets = inputPorts.filter(p => Object.hasOwn(inp, p.name)).map(p => `${p.name} = ${p.width}'b${inp[p.name]};`).join(' ');
    const fmt = outPorts.map(p => `${p.name}=%b`).join(' ');
    const args = outPorts.map(p => p.name).join(', ');
    return `    ${sets} #1; ${clockName} = 1; #1; ${clockName} = 0; #1; $display("CYCLE ${idx}: ${fmt}", ${args});`;
  }).join('\n');
  const tb = `\`timescale 1ns/1ns\nmodule ref_tb;\n${initRegs}\n${outWires}\n  ${moduleName} dut(${conn});\n  initial begin\n${stim}\n    $finish;\n  end\nendmodule\n`;
  const { output } = await compileAndRun({ 'dut.v': source, 'ref_tb.v': tb }, { top: 'ref_tb' });

  for (let i = 0; i < cycles.length; i++) {
    const line = output.find(l => l.startsWith(`CYCLE ${i}: `));
    assert.ok(line, `${name}: missing ref output for cycle ${i}`);
    for (const outName of outputs) {
      const m = new RegExp(`\\b${outName}=([01xz]+)`).exec(line);
      assert.ok(m, `${name}: missing ${outName} in ${line}`);
      const liveVal = liveSnaps[i].signals[`_live_board_tb.${outName}`];
      assert.equal(liveVal, m[1], `${name} cycle ${i} port ${outName}: live=${liveVal} vs static=${m[1]}`);
    }
  }
}

let checks = 0;
const check = async (name, fn) => {
  try { await fn(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};

await check('counter matches static TB bit-for-bit across reset & wrap', async () => {
  const src = `module counter(input clk, input reset, output reg [3:0] count);
    always @(posedge clk) if (reset) count <= 0; else count <= count + 1;
  endmodule`;
  const seq = [
    { reset: '1' }, { reset: '0' }, { reset: '0' }, { reset: '0' },
    ...Array.from({ length: 15 }, () => ({ reset: '0' })),
    { reset: '1' }, { reset: '0' },
  ];
  await diffCompare('counter', src, 'counter', 'clk', seq, ['count']);
});

await check('fpga_counter matches static TB across reset, load, count up/down, wrap', async () => {
  const src = extractConst('FPGA_COUNTER');
  const seq = [
    { rst: '1', en: '0', up_down: '1', load: '0', din: '0000' },
    { rst: '0', en: '1', up_down: '1', load: '0', din: '0000' },
    { en: '1', up_down: '1', load: '0' },
    { load: '1', din: pad(0xc, 4) },
    { load: '0', en: '1', up_down: '1' },
    { en: '1', up_down: '0' },
    { en: '1', up_down: '0' },
    { load: '1', din: '0000' },
    { load: '0', en: '1', up_down: '0' }, // wraps 0x00 -> 0xff
    { en: '1', up_down: '1' },           // wraps 0xff -> 0x00
  ];
  await diffCompare('fpga_counter', src, 'fpga_counter', 'clk', seq, ['leds', 'hex_lo', 'hex_hi', 'zero_led', 'max_led']);
});

await check('multicycle_fsm matches static TB across R-type, lw, sw, beq transitions', async () => {
  const src = extractConst('MULTICYCLE_FSM');
  const seq = [
    { reset: '1', opcode: '000000' },
    { reset: '0', opcode: '000000' }, // DECODE
    {}, {}, {},                       // EXEC -> WRITEBACK -> FETCH
    { opcode: '100011' }, {}, {}, {}, {}, // lw: 5 cycles back to FETCH
    { opcode: '101011' }, {}, {}, {},     // sw: 4 cycles
    { opcode: '000100' }, {}, {},         // beq: 3 cycles
  ];
  await diffCompare('multicycle_fsm', src, 'multicycle_fsm', 'clk', seq, ['pc_write', 'ir_write', 'reg_write', 'mem_read', 'mem_write', 'alu_src_a', 'alu_src_b']);
});

console.log(`Live DUT differential suite passed (${checks} checks)`);
