// Unit checks for the MIPS assembler/decoder and FSM state-name extraction.
// Run offline: mvm run -i docker.io/library/node:22-alpine -- node tests/unit/stage4.test.mjs
import assert from 'node:assert/strict';
import { assembleMips, defaultOutputName } from '../../web/mips-asm.js';
import { decodeMips } from '../../web/mips-decode.js';
import { extractFsmStates, stateNameFor, parseLiteral } from '../../web/fsm-states.js';
import { SHOWCASE_PROJECTS } from '../../web/showcase-projects.js';
import { THEMES, THEME_ORDER, SYN_VARS } from '../../web/themes.js';

let checks = 0;
const check = (name, fn) => {
  try { fn(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};
const hex = words => words.map(word => word.toString(16).padStart(8, '0'));
const asm = (source, options) => {
  const result = assembleMips(source, options);
  assert.ok(result.ok, JSON.stringify(result.diagnostics));
  return result;
};

// ------------------------------------------------------------ assembler: encodings
check('R-type', () => {
  const { words } = asm(`add $t0, $t1, $t2
addu $s0, $s1, $s2
sub $v0, $a0, $a1
subu $8, $9, $10
and $t0, $t1, $t2
or $t0, $t1, $t2
xor $t0, $t1, $t2
nor $t0, $t1, $t2
slt $t0, $t1, $t2
sltu $t0, $t1, $t2
sll $t0, $t0, 2
srl $t0, $t1, 31
sra $t0, $t1, 4
sllv $t0, $t1, $t2
srlv $t0, $t1, $t2
srav $t0, $t1, $t2
jr $ra
jalr $t0
jalr $s0, $t0
mult $t0, $t1
multu $t0, $t1
div $t0, $t1
divu $t0, $t1
mfhi $t2
mflo $t3
syscall`);
  assert.deepEqual(hex(words), [
    '012a4020', '02328021', '00851022', '012a4023', '012a4024', '012a4025', '012a4026', '012a4027', '012a402a', '012a402b',
    '00084080', '000947c2', '00094103', '01494004', '01494006', '01494007', '03e00008', '0100f809', '01008009',
    '01090018', '01090019', '0109001a', '0109001b', '00005010', '00005812', '0000000c',
  ]);
});

check('I-type and immediates', () => {
  const { words } = asm(`addi $t0, $zero, -4
addiu $t0, $t0, 0x10
andi $t0, $t1, 0xffff
ori $t0, $t1, 0b1010
xori $t0, $t1, 'A'
slti $t0, $t1, -1
sltiu $t0, $t1, 5
lui $at, 0x1001
lw $t1, 4($t0)
sw $t0, 8($t1)
lb $t0, -1($sp)
lbu $t0, 0($sp)
lh $t0, 2($gp)
lhu $t0, ($fp)
sb $t0, 3($a0)
sh $t0, -2($a1)`);
  assert.deepEqual(hex(words), [
    '2008fffc', '25080010', '3128ffff', '3528000a', '39280041', '2928ffff', '2d280005', '3c011001',
    '8d090004', 'ad280008', '83a8ffff', '93a80000', '87880002', '97c80000', 'a0880003', 'a4a8fffe',
  ]);
});

check('branches and jumps: forward/backward offsets', () => {
  const { words, labels } = asm(`start:  beq $t0, $t1, done
        nop
loop:   addi $t0, $t0, 1
        bne $t0, $t2, loop
        j start
        jal loop
done:   beq $zero, $zero, done`);
  assert.equal(labels.loop, 8);
  assert.equal(labels.done, 24);
  assert.deepEqual(hex(words), ['11090005', '00000000', '21080001', '150afffe', '08000000', '0c000002', '1000ffff']);
});

check('pseudo-instructions and sizing', () => {
  const { words, labels, listing } = asm(`        nop
        move $t0, $t1
        li $t0, 5
        li $t1, -5
        li $t2, 0xffff
        li $t3, 0x12345678
        li $t4, 0x10000
        la $t5, data
        subi $t0, $t0, 3
        not $t0, $t1
        neg $t0, $t1
        blt $t0, $t1, back
back:   bgt $t0, $t1, back
        ble $t0, $t1, back
        bge $t0, $t1, back
data:   .word 0xdeadbeef, back, -1`);
  assert.equal(labels.back, 4 * 15);
  assert.equal(labels.data, 4 * 21);
  assert.deepEqual(hex(words), [
    '00000000', '01204021', '24080005', '2409fffb', '340affff', '3c0b1234', '356b5678', '3c0c0001',
    '3c0d0000', '35ad0054', '2108fffd', '01204027', '00094022', '0109082a', '14200000',
    '0128082a', '1420fffe', '0128082a', '1020fffc', '0109082a', '1020fffa',
    'deadbeef', '0000003c', 'ffffffff',
  ]);
  assert.equal(listing.length, words.length);
});

check('round trip with decodeMips', () => {
  const lines = ['add $t0, $t1, $t2', 'sll $t0, $t0, 2', 'jr $ra', 'jalr $t0', 'jalr $s0, $t0', 'mult $t0, $t1', 'divu $a0, $a1', 'mfhi $t2', 'mflo $t3', 'syscall',
    'sllv $t0, $t1, $t2', 'addi $t0, $zero, -4', 'andi $t0, $t1, 0xffff', 'lui $at, 0x1001', 'lw $t1, 4($t0)', 'sb $t0, 3($a0)', 'lhu $t0, 0($fp)'];
  const { words } = asm(lines.join('\n'));
  assert.deepEqual(words.map(word => decodeMips(word).asm), lines);
});

check('.org, .data, @out and mem text', () => {
  const result = asm(`// @out build/prog.mem
.text
main:  lw $t0, value($zero)
       j main
.org 0x10
tail:  nop
.data
value: .word 42`, { filename: 'src/prog.s' });
  assert.equal(result.outputName, 'build/prog.mem');
  assert.equal(result.labels.value, 0x14);
  assert.deepEqual(hex(result.words), ['8c080014', '08000000', '00000000', '00000000', '00000000', '0000002a']);
  const lines = result.memText.trim().split('\n');
  assert.match(lines[0], /^\/\//);
  assert.equal(lines[1], '8c080014 // 0x00000000: main:  lw $t0, value($zero)'.replace('main:  ', ''));
  assert.match(lines[3], /^00000000 \/\/ 0x00000008: \(gap\)$/);
  assert.equal(defaultOutputName('mips/program.asm'), 'mips/program.mem');
  assert.equal(defaultOutputName('a.S'), 'a.mem');
});

// ------------------------------------------------------------ assembler: diagnostics
check('errors carry line numbers', () => {
  const result = assembleMips(`addi $t0, $zero, 1
bogus $t0
addi $t0, $t9x, 1
sll $t0, $t0, 32
addi $t0, $t0, 40000
beq $t0, $t1, nowhere
dup: nop
dup: nop
andi $t0, $t0, -1
# @out ../escape.mem`, { filename: 'p.asm' });
  assert.equal(result.ok, false);
  assert.deepEqual(result.diagnostics.map(item => [item.line, item.file, item.severity]), [
    [2, 'p.asm', 'error'], [3, 'p.asm', 'error'], [4, 'p.asm', 'error'], [5, 'p.asm', 'error'], [6, 'p.asm', 'error'], [8, 'p.asm', 'error'], [9, 'p.asm', 'error'], [10, 'p.asm', 'error'],
  ]);
  assert.match(result.diagnostics[0].message, /Unknown instruction 'bogus'/);
  assert.match(result.diagnostics[1].message, /Unknown register/);
  assert.match(result.diagnostics[2].message, /Shift amount 32 is out of range/);
  assert.match(result.diagnostics[3].message, /out of range \[-32768, 32767\]/);
  assert.match(result.diagnostics[4].message, /Undefined label 'nowhere'/);
  assert.match(result.diagnostics[5].message, /Duplicate label 'dup'/);
  assert.match(result.diagnostics[6].message, /out of range \[0, 65535\]/);
});

check('branch range and jump region', () => {
  const far = assembleMips(`beq $t0, $t1, far\n.org 0x40000\nfar: nop`);
  assert.match(far.diagnostics[0].message, /Branch offset .* out of range/);
  const region = assembleMips(`j 0x10000000`);
  assert.match(region.diagnostics[0].message, /outside the current 256 MB region/);
});

// ------------------------------------------------------------ FSM state names
const FSM_FILES = {
  'fsm.v': `module ctrl(input clk, input reset, output busy);
  localparam [1:0] IDLE = 2'd0,
                   RUN  = 2'b01,
                   DONE = 2'h2;
  localparam WIDTH = 8;          // not a state
  reg [1:0] state, next_state;
  always @(*) begin
    next_state = state;
    case (state)
      IDLE: next_state = RUN;
      RUN:  next_state = DONE;
      default: next_state = IDLE;
    endcase
  end
  always @(posedge clk) state <= reset ? IDLE : next_state;
  assign busy = state == RUN;
endmodule
module params(input clk);
  parameter S_A = 0, S_B = 1, S_C = 3;
  reg [1:0] fsm_state;
  reg [7:0] counter;
endmodule
module top_tb;
  reg clk = 0, reset = 1;
  ctrl dut(.clk(clk), .reset(reset), .busy());
  params #(.S_A(0)) u_params(.clk(clk));
endmodule
`,
  'enum.sv': `module sv_fsm(input logic clk);
  typedef enum logic [2:0] { FETCH, DECODE = 3'd3, EXEC } state_t;
  state_t state, next;
  enum logic [1:0] { OFF, ON = 2'd2 } power;
endmodule
`,
};
check('localparam case FSM', () => {
  const map = extractFsmStates(FSM_FILES);
  assert.equal(stateNameFor(map, 'top_tb.dut.state', '00'), 'IDLE');
  assert.equal(stateNameFor(map, 'top_tb.dut.state', '01'), 'RUN');
  assert.equal(stateNameFor(map, 'top_tb.dut.next_state', '10'), 'DONE');
  assert.equal(stateNameFor(map, 'top_tb.dut.state', '11'), null);
  assert.equal(stateNameFor(map, 'top_tb.dut.state', 'xx'), null);
  assert.equal(stateNameFor(map, 'top_tb.dut.busy', '1'), null);
  assert.equal(stateNameFor(map, 'top_tb.reset', '0'), null);
});
check('parameter fallback and SV enums', () => {
  const map = extractFsmStates(FSM_FILES);
  assert.equal(stateNameFor(map, 'top_tb.u_params.fsm_state', '11'), 'S_C');
  assert.equal(stateNameFor(map, 'top_tb.u_params.counter', '00000001'), null);
  assert.equal(stateNameFor(map, 'sv_fsm.state', '000'), 'FETCH');
  assert.equal(stateNameFor(map, 'sv_fsm.next', '011'), 'DECODE');
  assert.equal(stateNameFor(map, 'sv_fsm.state', '100'), 'EXEC');
  assert.equal(stateNameFor(map, 'sv_fsm.power', '10'), 'ON');
  assert.equal(parseLiteral("4'hA"), 10n);
  assert.equal(parseLiteral("3'b010"), 2n);
  assert.equal(parseLiteral('12'), 12n);
  assert.equal(parseLiteral("2'bx1"), null);
});

// ------------------------------------------------------------ showcase projects
check('showcase projects are complete and consistent', () => {
  assert.deepEqual(SHOWCASE_PROJECTS.map(project => project.id), ['mips-cpu', 'fpga-board', 'fsm-control', 'alu-suite', 'bug-hunter']);
  for (const project of SHOWCASE_PROJECTS) {
    for (const key of ['title', 'subtitle', 'tryNext', 'openFile', 'schematicModule', 'dockTab']) assert.ok(typeof project[key] === 'string' && project[key], `${project.id}.${key}`);
    assert.equal(project.tags.length, 4, project.id);
    assert.ok(Object.hasOwn(project.files, project.openFile), project.id);
    const verilog = Object.values(project.files).join('\n');
    if (project.topModule) assert.match(verilog, new RegExp(`\\bmodule\\s+${project.topModule}\\b`), project.id);
    assert.match(verilog, new RegExp(`\\bmodule\\s+${project.schematicModule}\\b`), project.id);
    for (const [path, text] of Object.entries(project.files)) {
      if (!path.endsWith('.asm')) continue;
      const result = assembleMips(text, { filename: path });
      assert.ok(result.ok, JSON.stringify(result.diagnostics));
      assert.equal(result.outputName, 'program.mem');
    }
  }
  const fsm = extractFsmStates(SHOWCASE_PROJECTS.find(project => project.id === 'fsm-control').files);
  assert.deepEqual([0, 1, 2, 3, 4].map(value => stateNameFor(fsm, 'fsm_tb.dut.state', value.toString(2).padStart(3, '0'))), ['FETCH', 'DECODE', 'EXEC', 'MEM', 'WRITEBACK']);
});

// ------------------------------------------------------------ semantic syntax colors
check('semantic syntax slots are distinct and readable in every theme', () => {
  const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const luminance = hex => {
    const [r, g, b] = rgb(hex).map(v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const contrast = (a, b) => { const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  const distance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));
  assert.equal(THEME_ORDER.length, 9);
  for (const id of THEME_ORDER) {
    const theme = THEMES[id];
    assert.equal(theme.syn.length, SYN_VARS.length, id);
    const color = name => theme.syn[SYN_VARS.indexOf(name)];
    const slots = ['keyword', 'control', 'sim', 'type', 'number'];
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        if (i > 2 || (i === 0 && j > 2)) continue;   // only pairs involving the new control/sim slots or keyword vs them
        assert.ok(distance(color(slots[i]), color(slots[j])) >= 60, `${id}: ${slots[i]} ${color(slots[i])} vs ${slots[j]} ${color(slots[j])}`);
      }
    }
    for (const slot of ['control', 'sim']) assert.ok(contrast(color(slot), theme.ui[1]) >= 3.5, `${id}: ${slot} contrast ${contrast(color(slot), theme.ui[1]).toFixed(2)}`);
  }
});

console.log(`Stage 4 unit checks passed (${checks})`);
