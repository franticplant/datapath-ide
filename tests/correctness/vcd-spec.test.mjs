// IEEE-1364 VCD parser & 4-state formatter edge-case tests.
import assert from 'node:assert/strict';
import { parseVcd, valueAt } from '../../web/vcd.js';
import { formatValue, formatTime } from '../../web/waveform.js';

let checks = 0;
const check = (name, fn) => {
  try { fn(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};

check('IEEE-1364 left-extension for 0, 1, x, and z vectors', () => {
  assert.equal(formatValue('0', 8, 'bin'), '0b00000000');
  assert.equal(formatValue('1', 8, 'bin'), '0b00000001');
  assert.equal(formatValue('101', 8, 'bin'), '0b00000101');
  assert.equal(formatValue('x', 8, 'bin'), '0bxxxxxxxx');
  assert.equal(formatValue('x1', 8, 'bin'), '0bxxxxxxx1');
  assert.equal(formatValue('z', 8, 'bin'), '0bzzzzzzzz');
  assert.equal(formatValue('z01', 8, 'bin'), '0bzzzzzz01');
  assert.equal(formatValue('x', 8, 'hex'), '0xxx');
  assert.equal(formatValue('z', 8, 'hex'), '0xzz');
});

check('64-bit BigInt timestamps and timescales round-trip cleanly', () => {
  const vcd = parseVcd('$timescale 10 ps $end $scope module tb $end $var wire 1 ! clk $end $upscope $end $enddefinitions $end #0 0! #100000000000000 1!');
  assert.equal(vcd.endTime, 100000000000000n);
  assert.equal(valueAt(vcd.signals[0], 99999999999999n), '0');
  assert.equal(valueAt(vcd.signals[0], 100000000000000n), '1');
  assert.equal(formatTime(100000000000000n, '10 ps'), '1000 s');
  assert.equal(formatTime(1n, '100 fs'), '100 fs');
});

check('aliased VCD IDs across scopes receive every transition', () => {
  const vcd = parseVcd('$timescale 1 ns $end $scope module tb $end $var wire 4 ! a $end $scope module dut $end $var wire 4 ! b $end $upscope $end $upscope $end $enddefinitions $end #0 B1010 ! #5 b0011 !');
  assert.equal(vcd.signals.length, 2);
  assert.equal(valueAt(vcd.signals[0], 0n), '1010');
  assert.equal(valueAt(vcd.signals[1], 5n), '0011');
});

check('post-header $comment, $dumpvars, uppercase X/Z, and real values parse without corruption', () => {
  const vcd = parseVcd(`
    $timescale 1 ns $end
    $scope module tb $end
    $var wire 1 ! clk $end
    $var wire 4 " bus $end
    $var real 64 # temp $end
    $upscope $end
    $enddefinitions $end
    $comment 0! 1" b1010 " ignore tokens inside comments $end
    $dumpvars
    0!
    bX1Z0 "
    r3.14159 #
    $end
    #10 1! B1111 " r2.5 #
  `);
  assert.equal(vcd.signals.find(s => s.path === 'tb.clk').changes.length, 2);
  assert.equal(valueAt(vcd.signals.find(s => s.path === 'tb.clk'), 0n), '0');
  assert.equal(valueAt(vcd.signals.find(s => s.path === 'tb.bus'), 0n), 'x1z0');
  assert.equal(valueAt(vcd.signals.find(s => s.path === 'tb.bus'), 10n), '1111');
});

check('rejects incomplete headers and non-numeric timestamps', () => {
  assert.throws(() => parseVcd('$scope module tb $end $var wire 1 ! a $end'));
  assert.throws(() => parseVcd('$enddefinitions $end #bad 0!'));
  assert.throws(() => parseVcd('$scope module tb $end $var wire 0 ! bad $end $enddefinitions $end'));
});

console.log(`VCD spec suite passed (${checks} checks)`);
