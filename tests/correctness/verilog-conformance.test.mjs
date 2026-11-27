// Verilog language conformance checks against WASM Icarus Verilog (ivlpp/ivl/vvp).
import assert from 'node:assert/strict';
import { compileVvp, compileAndRun } from './helpers.mjs';

let checks = 0;
const check = async (name, fn) => {
  try { await fn(); checks += 1; }
  catch (error) { error.message = `${name}: ${error.message}`; throw error; }
};

await check('NBA simultaneous swap and pipeline stages', async () => {
  const { output } = await compileAndRun({
    't.v': `module tb;
      reg clk = 0; reg [7:0] a = 8'h11, b = 8'h22, p1 = 0, p2 = 0, p3 = 0, in = 8'h01;
      always #5 clk = ~clk;
      always @(posedge clk) begin
        a <= b; b <= a;
        p1 <= in; p2 <= p1; p3 <= p2;
      end
      initial begin
        @(posedge clk); #1;
        $display("swap=%h:%h", a, b);
        in = 8'h02; @(posedge clk); #1;
        in = 8'h03; @(posedge clk); #1;
        $display("pipe=%h:%h:%h", p1, p2, p3);
        $finish;
      end
    endmodule`,
  }, { top: 'tb' });
  assert.ok(output.includes('swap=22:11'), output.join('\n'));
  assert.ok(output.includes('pipe=03:02:01'), output.join('\n'));
});

await check('signed arithmetic, arithmetic shift right, and negative comparison', async () => {
  const { output } = await compileAndRun({
    't.v': `module tb;
      reg signed [7:0] sa = -8'sd16, sb = 8'sd3;
      reg [7:0] ua = 8'hf0;
      wire signed [7:0] ash = sa >>> 2;
      wire [7:0] lsh = ua >> 2;
      wire lt_s = ($signed(ua) < $signed(sb));
      wire lt_u = (ua < sb);
      initial begin
        #1 $display("ash=%d lsh=%h lts=%b ltu=%b prod=%d", ash, lsh, lt_s, lt_u, sa * sb);
        $finish;
      end
    endmodule`,
  }, { top: 'tb' });
  assert.ok(output.some(line => /ash=\s*-4 lsh=3c lts=1 ltu=0 prod=\s*-48/.test(line)), output.join('\n'));
});

await check('indexed part-select (+:/-:), replication, concat, and OOB select', async () => {
  const { output } = await compileAndRun({
    't.v': `module tb;
      reg [15:0] w = 16'habcd;
      reg [4:0] idx = 5'd4;
      reg [4:0] oob = 5'd20;
      wire [7:0] ps_plus = w[idx +: 8];
      wire [7:0] ps_minus = w[15 -: 8];
      wire [7:0] rep = {2{4'h5}};
      wire oob_bit = w[oob];
      initial begin
        #1 $display("plus=%h minus=%h rep=%h oob=%b", ps_plus, ps_minus, rep, oob_bit);
        $finish;
      end
    endmodule`,
  }, { top: 'tb' });
  assert.ok(output.includes('plus=bc minus=ab rep=55 oob=x'), output.join('\n'));
});

await check('case, casez, casex priority matching', async () => {
  const { output } = await compileAndRun({
    't.v': `module tb;
      reg [3:0] sel = 4'b0110;
      reg [3:0] mask = 4'b10x1;
      reg [3:0] cz, cx;
      always @(*) begin
        casez (sel)
          4'b1???: cz = 4'h8;
          4'b01??: cz = 4'h4;
          default: cz = 4'h0;
        endcase
        casex (mask)
          4'b1001: cx = 4'ha;
          default: cx = 4'h0;
        endcase
      end
      initial begin
        #1 $display("cz=%h cx=%h", cz, cx);
        $finish;
      end
    endmodule`,
  }, { top: 'tb' });
  assert.ok(output.includes('cz=4 cx=a'), output.join('\n'));
});

await check('generate-for, localparam, and parameterized module override', async () => {
  const { output } = await compileAndRun({
    't.v': `module rev #(parameter W = 4) (input [W-1:0] a, output [W-1:0] y);
      genvar i;
      generate
        for (i = 0; i < W; i = i + 1) begin : g
          assign y[i] = a[W - 1 - i];
        end
      endgenerate
    endmodule
    module tb;
      localparam N = 8;
      reg [N-1:0] in = 8'b1101_0010;
      wire [N-1:0] out;
      rev #(.W(N)) dut(.a(in), .y(out));
      initial begin
        #1 $display("rev=%b", out);
        $finish;
      end
    endmodule`,
  }, { top: 'tb' });
  assert.ok(output.includes('rev=01001011'), output.join('\n'));
});

await check('functions and tasks compute recursive/iterative helpers', async () => {
  const { output } = await compileAndRun({
    't.v': `module tb;
      function [7:0] popcount(input [7:0] x);
        integer i;
        begin
          popcount = 0;
          for (i = 0; i < 8; i = i + 1) popcount = popcount + x[i];
        end
      endfunction
      initial begin
        $display("pop=%0d", popcount(8'b1011_0111));
        $finish;
      end
    endmodule`,
  }, { top: 'tb' });
  assert.ok(output.includes('pop=6'), output.join('\n'));
});

await check('4-state === vs == and tristate resolution', async () => {
  const { output } = await compileAndRun({
    't.v': `module tb;
      reg [3:0] xval = 4'b10xz;
      reg oe = 0; reg d = 1;
      tri bus = oe ? d : 1'bz;
      initial begin
        #1 $display("eq=%b ceq=%b bus=%b", (xval == 4'b10xz), (xval === 4'b10xz), bus);
        oe = 1; #1 $display("bus_on=%b", bus);
        $finish;
      end
    endmodule`,
  }, { top: 'tb' });
  assert.ok(output.includes('eq=x ceq=1 bus=z'), output.join('\n'));
  assert.ok(output.includes('bus_on=1'), output.join('\n'));
});

await check('$readmemh and $readmemb handle @addr and partial bounds', async () => {
  const { output } = await compileAndRun({
    't.v': `module tb;
      reg [7:0] mh [0:5], mb [0:3];
      initial begin
        $readmemh("h.mem", mh);
        $readmemb("b.mem", mb);
        $display("mh=%h:%h:%h mb=%b:%b", mh[0], mh[3], mh[4], mb[0], mb[1]);
        $finish;
      end
    endmodule`,
  }, { top: 'tb' }, {
    'h.mem': '// comment\naa\n@3 55\nff\n',
    'b.mem': '1010_0101\n11110000\n',
  });
  assert.ok(output.includes('mh=aa:55:ff mb=10100101:11110000'), output.join('\n'));
});

await check('-g2001 rejects SystemVerilog logic while -g2012 accepts SV constructs', async () => {
  const svSrc = { 'sv.v': 'module tb; typedef enum logic [1:0] {S0=2\'d0, S1=2\'d1} st_t; st_t s = S1; initial begin $display("sv=%0d", s); $finish; end endmodule' };
  const strict2001 = await compileVvp(svSrc, { top: 'tb', standard: '2001' });
  assert.equal(strict2001.ok, false, '-g2001 must reject SV typedef enum');
  const ran2012 = await compileAndRun(svSrc, { top: 'tb', standard: '2012' });
  assert.ok(ran2012.output.includes('sv=1'), ran2012.output.join('\n'));
});

await check('VPI memory capture handles ascending, descending, and multi-array modules', async () => {
  const { memTrace } = await compileAndRun({
    't.v': `\`timescale 1ns/1ns
    module tb;
      reg clk = 0;
      reg [7:0] asc [0:3];
      reg [15:0] desc [7:4];
      always #5 clk = ~clk;
      always @(posedge clk) begin
        asc[2] <= 8'h5a;
        desc[6] <= 16'hcafe;
      end
      initial begin
        asc[0] = 8'h11; asc[1] = 8'h22; asc[2] = 0; asc[3] = 0;
        desc[4] = 0; desc[5] = 0; desc[6] = 0; desc[7] = 16'hbeef;
        #10 $finish;
      end
    endmodule`,
  }, { top: 'tb' });
  assert.equal(memTrace.arrays.length, 2);
  const asc = memTrace.arrays.find(a => a.path === 'tb.asc');
  const desc = memTrace.arrays.find(a => a.path === 'tb.desc');
  assert.equal(asc.left, 0);
  assert.equal(asc.right, 3);
  assert.deepEqual(asc.deltas, [[5, 2, '5a']]);
  assert.equal(Math.min(desc.left, desc.right), 4);
  assert.equal(desc.init['7'], 'beef');
  assert.deepEqual(desc.deltas, [[5, 6, 'cafe']]);
});

console.log(`Verilog conformance suite passed (${checks} checks)`);
