// Built-in Showcase Projects: complete, ready-to-run workspaces that each demonstrate a group of IDE features.
// Loading one replaces the workspace (see loadShowcaseProject in app.js).

// ---------------------------------------------------------------- 1. MIPS32 single-cycle CPU
const MIPS_PROGRAM = `# @out program.mem
# First six Fibonacci numbers in $t0..$t5 (1, 1, 2, 3, 5, 8), stored to data memory
# words 0..5, then F6 is loaded back into $s0. Run assembles this file into program.mem.

        addi $t0, $zero, 1      # F1 = 1
        addi $t1, $zero, 1      # F2 = 1
        add  $t2, $t0, $t1      # F3 = 2
        add  $t3, $t1, $t2      # F4 = 3
        add  $t4, $t2, $t3      # F5 = 5
        add  $t5, $t3, $t4      # F6 = 8

        sw   $t0, 0($zero)      # dmem[0] = 1
        sw   $t1, 4($zero)      # dmem[1] = 1
        sw   $t2, 8($zero)      # dmem[2] = 2
        sw   $t3, 12($zero)     # dmem[3] = 3
        sw   $t4, 16($zero)     # dmem[4] = 5
        sw   $t5, 20($zero)     # dmem[5] = 8

        lw   $s0, 20($zero)     # $s0 = dmem[5] = 8
        beq  $s0, $t5, done     # loaded value matches F6?
        sub  $s0, $s0, $s0      # no: clear $s0 so the testbench fails
done:   j    done               # park here (watch the PC marker in State)
`;

const MIPS_CPU = `\`timescale 1ns/1ns
// Single-cycle MIPS32 subset CPU: add sub and or slt addi lw sw beq bne j (and nop).
// program.mem (assembled from program.asm) is loaded into instruction memory; PC starts at 0.
module mips_cpu(input clk, input reset, output [31:0] pc_out);
  reg  [31:0] pc;
  wire [31:0] instr;
  wire [5:0]  op = instr[31:26], funct = instr[5:0];
  wire [4:0]  rs = instr[25:21], rt = instr[20:16], rd = instr[15:11];
  wire [31:0] imm = {{16{instr[15]}}, instr[15:0]};
  wire reg_dst, alu_src, mem_to_reg, reg_write, mem_write, branch_eq, branch_ne, jump;
  wire [2:0]  alu_op;
  wire [31:0] rs_val, rt_val, alu_y, mem_rd;
  wire zero;

  mips_control u_ctrl(.op(op), .funct(funct), .reg_dst(reg_dst), .alu_src(alu_src), .mem_to_reg(mem_to_reg),
                      .reg_write(reg_write), .mem_write(mem_write), .branch_eq(branch_eq), .branch_ne(branch_ne),
                      .jump(jump), .alu_op(alu_op));
  mips_imem    u_imem(.addr(pc), .instr(instr));
  mips_regfile u_rf(.clk(clk), .we(reg_write), .ra(rs), .rb(rt), .wa(reg_dst ? rd : rt),
                    .wd(mem_to_reg ? mem_rd : alu_y), .a(rs_val), .b(rt_val));
  mips_alu     u_alu(.a(rs_val), .b(alu_src ? imm : rt_val), .op(alu_op), .y(alu_y), .zero(zero));
  mips_dmem    u_dmem(.clk(clk), .we(mem_write), .addr(alu_y), .wd(rt_val), .rd(mem_rd));

  wire [31:0] pc_plus4 = pc + 32'd4;
  wire take_branch = (branch_eq & zero) | (branch_ne & ~zero);
  always @(posedge clk)
    if (reset)            pc <= 32'd0;
    else if (jump)        pc <= {pc_plus4[31:28], instr[25:0], 2'b00};
    else if (take_branch) pc <= pc_plus4 + (imm << 2);
    else                  pc <= pc_plus4;
  assign pc_out = pc;
endmodule

// Main decoder + ALU decoder in one block; every output has a default, so no latches.
module mips_control(input [5:0] op, input [5:0] funct,
                    output reg reg_dst, alu_src, mem_to_reg, reg_write, mem_write, branch_eq, branch_ne, jump,
                    output reg [2:0] alu_op);
  always @(*) begin
    {reg_dst, alu_src, mem_to_reg, reg_write, mem_write, branch_eq, branch_ne, jump} = 8'b0;
    alu_op = 3'd2;                                                   // add
    case (op)
      6'h00: begin                                                   // R-type
        reg_dst = 1'b1; reg_write = 1'b1;
        case (funct)
          6'h22: alu_op = 3'd6;                                      // sub
          6'h24: alu_op = 3'd0;                                      // and
          6'h25: alu_op = 3'd1;                                      // or
          6'h2a: alu_op = 3'd7;                                      // slt
          default: alu_op = 3'd2;                                    // add (nop writes $zero)
        endcase
      end
      6'h08: begin alu_src = 1'b1; reg_write = 1'b1; end                     // addi
      6'h23: begin alu_src = 1'b1; mem_to_reg = 1'b1; reg_write = 1'b1; end  // lw
      6'h2b: begin alu_src = 1'b1; mem_write = 1'b1; end                     // sw
      6'h04: begin alu_op = 3'd6; branch_eq = 1'b1; end                      // beq
      6'h05: begin alu_op = 3'd6; branch_ne = 1'b1; end                      // bne
      6'h02: jump = 1'b1;                                                    // j
      default: ;
    endcase
  end
endmodule

module mips_alu(input [31:0] a, input [31:0] b, input [2:0] op, output reg [31:0] y, output zero);
  always @(*)
    case (op)
      3'd0: y = a & b;
      3'd1: y = a | b;
      3'd2: y = a + b;
      3'd6: y = a - b;
      3'd7: y = ($signed(a) < $signed(b)) ? 32'd1 : 32'd0;
      default: y = 32'd0;
    endcase
  assign zero = (y == 32'd0);
endmodule

// 32 x 32 register file: two asynchronous read ports, one clocked write port, $zero hard-wired.
module mips_regfile(input clk, input we, input [4:0] ra, input [4:0] rb, input [4:0] wa, input [31:0] wd,
                    output [31:0] a, output [31:0] b);
  reg [31:0] regs [0:31];
  integer i;
  initial for (i = 0; i < 32; i = i + 1) regs[i] = 32'd0;
  always @(posedge clk) if (we && wa != 5'd0) regs[wa] <= wd;
  assign a = (ra == 5'd0) ? 32'd0 : regs[ra];
  assign b = (rb == 5'd0) ? 32'd0 : regs[rb];
endmodule

module mips_imem(input [31:0] addr, output [31:0] instr);
  reg [31:0] mem [0:63];
  integer i;
  initial begin
    for (i = 0; i < 64; i = i + 1) mem[i] = 32'd0;   // unused words decode as nop
    $readmemh("program.mem", mem);
  end
  assign instr = mem[addr[7:2]];
endmodule

// Word-addressed data memory, cleared at power-up so the State tab shows no x words.
module mips_dmem(input clk, input we, input [31:0] addr, input [31:0] wd, output [31:0] rd);
  reg [31:0] mem [0:63];
  integer i;
  initial for (i = 0; i < 64; i = i + 1) mem[i] = 32'd0;
  always @(posedge clk) if (we) mem[addr[7:2]] <= wd;
  assign rd = mem[addr[7:2]];
endmodule
`;

const MIPS_CPU_TB = `\`timescale 1ns/1ns
// Self-checking testbench: runs program.mem, expects $s0 (register 16) = 8 and dmem word 5 = 8.
module mips_cpu_tb;
  reg clk = 0, reset = 1;
  wire [31:0] pc;
  mips_cpu dut(.clk(clk), .reset(reset), .pc_out(pc));
  always #5 clk = ~clk;
  initial begin
    $dumpfile("mips_cpu.vcd");
    $dumpvars(0, mips_cpu_tb);
    #12 reset = 0;
    #250;
    if (dut.u_rf.regs[16] === 32'd8 && dut.u_dmem.mem[5] === 32'd8)
      $display("PASS: $s0 = %0d, dmem[5] = %0d (Fibonacci 1 1 2 3 5 8)", dut.u_rf.regs[16], dut.u_dmem.mem[5]);
    else
      $display("FAIL: $s0 = %0d, dmem[5] = %0d, expected 8", dut.u_rf.regs[16], dut.u_dmem.mem[5]);
    $finish;
  end
endmodule
`;

// ---------------------------------------------------------------- 2. FPGA board lab
const FPGA_COUNTER = `\`timescale 1ns/1ns
// 8-bit loadable up/down counter, wired like a dev board: switches in, LEDs and two hex digits out.
// Board tab -> Live DUT -> Start Live: flip rst/en/up_down/load, type din, then Tick Clock.
module fpga_counter(input clk, input rst, input en, input up_down, input load, input [3:0] din,
                    output reg [7:0] leds, output [3:0] hex_lo, output [3:0] hex_hi,
                    output zero_led, output max_led);
  always @(posedge clk)
    if (rst)       leds <= 8'h00;
    else if (load) leds <= {4'h0, din};
    else if (en)   leds <= up_down ? leds + 8'h01 : leds - 8'h01;

  assign hex_lo   = leds[3:0];           // right 7-segment digit
  assign hex_hi   = leds[7:4];           // left 7-segment digit
  assign zero_led = (leds == 8'h00);
  assign max_led  = (leds == 8'hff);
endmodule
`;

const FPGA_TB = `\`timescale 1ns/1ns
// Reset, load 9, count up 3, count down 5, wrap below zero: Replay mode on the Board tab plays this back.
module fpga_board_tb;
  reg clk = 0, rst = 1, en = 0, up_down = 1, load = 0;
  reg [3:0] din = 4'h0;
  wire [7:0] leds;
  wire [3:0] hex_lo, hex_hi;
  wire zero_led, max_led;
  integer errors = 0;
  fpga_counter dut(.clk(clk), .rst(rst), .en(en), .up_down(up_down), .load(load), .din(din),
                   .leds(leds), .hex_lo(hex_lo), .hex_hi(hex_hi), .zero_led(zero_led), .max_led(max_led));
  always #5 clk = ~clk;

  task expect_leds(input [7:0] value);
    if (leds !== value) begin
      errors = errors + 1;
      $display("FAIL: leds = %h at %0t, expected %h", leds, $time, value);
    end
  endtask

  initial begin
    $dumpfile("fpga_board.vcd");
    $dumpvars(0, fpga_board_tb);
    #12 rst = 0;                 expect_leds(8'h00);
    if (!zero_led) errors = errors + 1;
    load = 1; din = 4'h9; #10 load = 0; expect_leds(8'h09);
    en = 1; up_down = 1;     #30; expect_leds(8'h0c);
    up_down = 0;             #50; expect_leds(8'h07);
    #70;                          expect_leds(8'h00);
    #10;                          expect_leds(8'hff);
    if (!max_led || hex_hi !== 4'hf) errors = errors + 1;
    en = 0;                  #20;
    if (errors == 0) $display("PASS: counter loaded, counted up/down and wrapped (leds = %h)", leds);
    else $display("FAIL: %0d check(s) failed", errors);
    $finish;
  end
endmodule
`;

// ---------------------------------------------------------------- 3. Multi-cycle control FSM
const MULTICYCLE_FSM = `\`timescale 1ns/1ns
// Multi-cycle MIPS control unit: FETCH -> DECODE -> EXEC -> [MEM] -> [WRITEBACK].
//   R-type: F D E W (4)   lw: F D E M W (5)   sw: F D E M (4)   beq: F D E (3)
// The waveform shows these localparam names directly on the state bus.
module multicycle_fsm(input clk, input reset, input [5:0] opcode,
                      output reg pc_write, ir_write, reg_write, mem_read, mem_write, alu_src_a,
                      output reg [1:0] alu_src_b);
  localparam [2:0] FETCH = 3'd0, DECODE = 3'd1, EXEC = 3'd2, MEM = 3'd3, WRITEBACK = 3'd4;

  reg [2:0] state, next_state;

  // State register
  always @(posedge clk)
    if (reset) state <= FETCH;
    else       state <= next_state;

  // Next-state logic (default first: no latches)
  always @(*) begin
    next_state = FETCH;
    case (state)
      FETCH:  next_state = DECODE;
      DECODE: next_state = EXEC;
      EXEC:   if (opcode == 6'h23 || opcode == 6'h2b) next_state = MEM;        // lw / sw
              else if (opcode == 6'h00)                next_state = WRITEBACK;  // R-type
              else                                     next_state = FETCH;      // beq
      MEM:    if (opcode == 6'h23) next_state = WRITEBACK;                      // lw
              else                 next_state = FETCH;                          // sw
      WRITEBACK: next_state = FETCH;
      default:   next_state = FETCH;
    endcase
  end

  // Control outputs (Moore; every output defaults to 0)
  always @(*) begin
    {pc_write, ir_write, reg_write, mem_read, mem_write, alu_src_a} = 6'b0;
    alu_src_b = 2'b00;
    case (state)
      FETCH:     begin mem_read = 1'b1; ir_write = 1'b1; pc_write = 1'b1; alu_src_b = 2'b01; end  // PC + 4
      DECODE:    alu_src_b = 2'b11;                                                         // branch target
      EXEC:      begin alu_src_a = 1'b1; alu_src_b = (opcode == 6'h00 || opcode == 6'h04) ? 2'b00 : 2'b10; end
      MEM:       if (opcode == 6'h23) mem_read = 1'b1; else mem_write = 1'b1;
      WRITEBACK: reg_write = 1'b1;
      default:   ;
    endcase
  end
endmodule
`;

const FSM_TB = `\`timescale 1ns/1ns
// Runs R-type -> lw -> sw -> beq through the controller and checks each instruction's cycle count.
module fsm_tb;
  reg clk = 0, reset = 1;
  reg [5:0] opcode = 6'h00;
  wire pc_write, ir_write, reg_write, mem_read, mem_write, alu_src_a;
  wire [1:0] alu_src_b;
  integer errors = 0, writes = 0, stores = 0;
  multicycle_fsm dut(.clk(clk), .reset(reset), .opcode(opcode), .pc_write(pc_write), .ir_write(ir_write),
                     .reg_write(reg_write), .mem_read(mem_read), .mem_write(mem_write),
                     .alu_src_a(alu_src_a), .alu_src_b(alu_src_b));
  always #5 clk = ~clk;
  always @(posedge clk) begin
    if (reg_write) writes = writes + 1;
    if (mem_write) stores = stores + 1;
  end

  // Issue one instruction at FETCH and count the cycles until the FSM is back in FETCH.
  task run_instr(input [5:0] op, input integer expected);
    integer cycles;
    begin
      opcode = op;
      cycles = 0;
      @(posedge clk); #1 cycles = 1;
      while (dut.state !== 3'd0) begin @(posedge clk); #1 cycles = cycles + 1; end
      if (cycles !== expected) begin
        errors = errors + 1;
        $display("FAIL: opcode %h took %0d cycles, expected %0d", op, cycles, expected);
      end else $display("opcode %h: %0d cycles", op, cycles);
    end
  endtask

  initial begin
    $dumpfile("fsm.vcd");
    $dumpvars(0, fsm_tb);
    #12 reset = 0;
    run_instr(6'h00, 4);   // R-type
    run_instr(6'h23, 5);   // lw
    run_instr(6'h2b, 4);   // sw
    run_instr(6'h04, 3);   // beq
    #10;
    if (errors == 0 && writes == 2 && stores == 1) $display("PASS: all 5 states visited, %0d register writes, %0d store", writes, stores);
    else $display("FAIL: errors = %0d, writes = %0d (expected 2), stores = %0d (expected 1)", errors, writes, stores);
    $finish;
  end
endmodule
`;

// ---------------------------------------------------------------- 4. 32-bit ALU + test suite
const ALU32 = `\`timescale 1ns/1ns
// Hierarchical 32-bit MIPS ALU: shared adder/subtractor, logic unit and shifter, plus zero/neg flags.
//   alu_ctrl: AND 0  OR 1  ADD 2  XOR 3  SLL 4  SRL 5  SUB 6  SLT 7  NOR 12
module alu_adder(input [31:0] a, input [31:0] b, input sub, output [31:0] sum);
  assign sum = a + (sub ? ~b : b) + {31'd0, sub};      // a - b = a + ~b + 1
endmodule

module alu_logic(input [31:0] a, input [31:0] b, input [1:0] op, output reg [31:0] y);
  always @(*)
    case (op)
      2'd0: y = a & b;
      2'd1: y = a | b;
      2'd2: y = a ^ b;
      default: y = ~(a | b);
    endcase
endmodule

module alu_shifter(input [31:0] b, input [4:0] shamt, input right, output [31:0] y);
  assign y = right ? b >> shamt : b << shamt;
endmodule

module alu32(input [31:0] a, input [31:0] b, input [3:0] alu_ctrl, input [4:0] shamt,
             output reg [31:0] result, output zero, output neg);
  localparam [3:0] ALU_AND = 4'd0, ALU_OR = 4'd1, ALU_ADD = 4'd2, ALU_XOR = 4'd3, ALU_SLL = 4'd4,
                   ALU_SRL = 4'd5, ALU_SUB = 4'd6, ALU_SLT = 4'd7, ALU_NOR = 4'd12;
  wire        do_sub = (alu_ctrl == ALU_SUB) || (alu_ctrl == ALU_SLT);
  wire [31:0] sum, logic_y, shift_y;
  reg  [1:0]  logic_op;

  alu_adder   u_adder(.a(a), .b(b), .sub(do_sub), .sum(sum));
  alu_logic   u_logic(.a(a), .b(b), .op(logic_op), .y(logic_y));
  alu_shifter u_shift(.b(b), .shamt(shamt), .right(alu_ctrl == ALU_SRL), .y(shift_y));

  // Signed less-than: on overflow the sign of a decides.
  wire less = (a[31] != b[31]) ? a[31] : sum[31];

  always @(*) begin
    logic_op = 2'd0;
    case (alu_ctrl)
      ALU_OR:  logic_op = 2'd1;
      ALU_XOR: logic_op = 2'd2;
      ALU_NOR: logic_op = 2'd3;
      default: logic_op = 2'd0;
    endcase
  end

  always @(*)
    case (alu_ctrl)
      ALU_ADD, ALU_SUB:                  result = sum;
      ALU_AND, ALU_OR, ALU_XOR, ALU_NOR: result = logic_y;
      ALU_SLL, ALU_SRL:                  result = shift_y;
      ALU_SLT:                           result = {31'd0, less};
      default:                           result = 32'd0;
    endcase

  assign zero = (result == 32'd0);
  assign neg  = result[31];
endmodule
`;

const aluTb = (name, title, body) => `\`timescale 1ns/1ns
// ${title}
module ${name};
  reg  [31:0] a = 0, b = 0;
  reg  [3:0]  alu_ctrl = 0;
  reg  [4:0]  shamt = 0;
  wire [31:0] result;
  wire zero, neg;
  integer errors = 0, checks = 0;
  alu32 dut(.a(a), .b(b), .alu_ctrl(alu_ctrl), .shamt(shamt), .result(result), .zero(zero), .neg(neg));

  task check(input [3:0] ctrl, input [31:0] x, input [31:0] y, input [4:0] sh, input [31:0] expected);
    begin
      alu_ctrl = ctrl; a = x; b = y; shamt = sh;
      #10 checks = checks + 1;
      if (result !== expected) begin
        errors = errors + 1;
        $display("FAIL: ctrl %0d a=%h b=%h shamt=%0d -> %h, expected %h", ctrl, x, y, sh, result, expected);
      end
    end
  endtask

  initial begin
    $dumpfile("${name}.vcd");
    $dumpvars(0, ${name});
${body}
    if (errors == 0) $display("PASS: ${name} (%0d checks)", checks);
    else $display("FAIL: ${name}: %0d of %0d checks failed", errors, checks);
    $finish;
  end
endmodule
`;

const TB_ARITH = aluTb('tb_alu_arith', 'ADD, SUB and SLT (signed) checks.', `    check(4'd2, 32'd7, 32'd5, 0, 32'd12);                 // ADD
    check(4'd2, 32'hffffffff, 32'd1, 0, 32'd0);           // ADD wraps
    check(4'd2, 32'h7fffffff, 32'd1, 0, 32'h80000000);    // ADD overflow (no trap)
    check(4'd6, 32'd7, 32'd5, 0, 32'd2);                  // SUB
    check(4'd6, 32'd5, 32'd7, 0, 32'hfffffffe);           // SUB negative
    check(4'd7, 32'd3, 32'd9, 0, 32'd1);                  // SLT 3 < 9
    check(4'd7, 32'd9, 32'd3, 0, 32'd0);                  // SLT 9 < 3
    check(4'd7, 32'hfffffffd, 32'd2, 0, 32'd1);           // SLT -3 < 2
    check(4'd7, 32'h80000000, 32'h7fffffff, 0, 32'd1);    // SLT most negative < most positive`);

const TB_LOGIC = aluTb('tb_alu_logic', 'AND, OR, XOR and NOR checks.', `    check(4'd0, 32'hf0f0ff00, 32'h0ff0f0f0, 0, 32'h00f0f000);  // AND
    check(4'd1, 32'hf0f0ff00, 32'h0ff0f0f0, 0, 32'hfff0fff0);  // OR
    check(4'd3, 32'hf0f0ff00, 32'h0ff0f0f0, 0, 32'hff000ff0);  // XOR
    check(4'd12, 32'hf0f0ff00, 32'h0ff0f0f0, 0, 32'h000f000f); // NOR
    check(4'd12, 32'd0, 32'd0, 0, 32'hffffffff);               // NOR 0, 0 = ~0
    check(4'd3, 32'h12345678, 32'h12345678, 0, 32'd0);         // XOR x, x = 0`);

const TB_SHIFT = aluTb('tb_alu_shift', 'SLL and SRL checks (b is shifted by shamt, like MIPS).', `    check(4'd4, 0, 32'h00000001, 5'd4, 32'h00000010);   // SLL 1 << 4
    check(4'd4, 0, 32'h80000001, 5'd1, 32'h00000002);   // SLL drops the top bit
    check(4'd4, 0, 32'h0000ffff, 5'd16, 32'hffff0000);  // SLL 16
    check(4'd5, 0, 32'h80000000, 5'd31, 32'h00000001);  // SRL 31
    check(4'd5, 0, 32'hf0000000, 5'd4, 32'h0f000000);   // SRL is logical (zero fill)
    check(4'd5, 0, 32'h12345678, 5'd0, 32'h12345678);   // SRL 0`);

const TB_FLAGS = aluTb('tb_alu_flags', 'zero and neg flag checks.', `    check(4'd6, 32'd42, 32'd42, 0, 32'd0);
    if (!zero || neg) begin errors = errors + 1; $display("FAIL: 42 - 42 should set zero only"); end
    check(4'd6, 32'd1, 32'd2, 0, 32'hffffffff);
    if (zero || !neg) begin errors = errors + 1; $display("FAIL: 1 - 2 should set neg only"); end
    check(4'd2, 32'd1, 32'd2, 0, 32'd3);
    if (zero || neg) begin errors = errors + 1; $display("FAIL: 1 + 2 should clear both flags"); end
    check(4'd0, 32'hff00ff00, 32'h00ff00ff, 0, 32'd0);
    if (!zero) begin errors = errors + 1; $display("FAIL: AND of disjoint masks should set zero"); end`);

// ---------------------------------------------------------------- 5. Schematic & latch bug hunter
const DATAPATH_SLICE = `\`timescale 1ns/1ns
// 8-bit accumulator datapath slice: control -> operand mux -> ALU -> accumulator register.
// Schematic -> Elaborate shows the hierarchy; double-click u_leaky_ctrl to find the LATCH.

module slice_mux(input [7:0] a, input [7:0] b, input sel, output [7:0] y);
  assign y = sel ? b : a;
endmodule

module slice_alu(input [7:0] x, input [7:0] y, input [1:0] op, output reg [7:0] r);
  always @(*)
    case (op)
      2'd0: r = x + y;
      2'd1: r = x - y;
      2'd2: r = x & y;
      default: r = x | y;
    endcase
endmodule

module slice_reg(input clk, input rst, input en, input [7:0] d, output reg [7:0] q);
  always @(posedge clk)
    if (rst)     q <= 8'h00;
    else if (en) q <= d;
endmodule

// Decodes mode (0 add a, 1 add imm, 2 and a, 3 or a) into ALU op / operand select / register enable.
module leaky_ctrl(input [1:0] mode, input valid, output reg [1:0] alu_op, output reg use_imm, output reg load_en);
  always @(*) begin
    use_imm = (mode == 2'd1);   // mode 1 adds the immediate instead of the a input
    load_en = valid;
  end

  // BUG (classic missing-else latch): alu_op is only assigned when valid is 1, so it must
  // remember its old value otherwise -> Icarus infers a LATCH.
  always @(*)
    if (valid) alu_op = (mode == 2'd1) ? 2'd0 : mode;   // mode 1 = add immediate
  // FIX: add a default for every path, e.g.
  //   else alu_op = 2'd0;
  // or assign  alu_op = 2'd0;  before the if.
endmodule

module datapath_slice(input clk, input rst, input valid, input [1:0] mode, input [7:0] a, input [7:0] imm,
                      output [7:0] acc, output [7:0] alu_out);
  wire [1:0] alu_op;
  wire use_imm, load_en;
  wire [7:0] operand;

  leaky_ctrl u_leaky_ctrl(.mode(mode), .valid(valid), .alu_op(alu_op), .use_imm(use_imm), .load_en(load_en));
  slice_mux  u_mux(.a(a), .b(imm), .sel(use_imm), .y(operand));
  slice_alu  u_alu(.x(acc), .y(operand), .op(alu_op), .r(alu_out));
  slice_reg  u_reg(.clk(clk), .rst(rst), .en(load_en), .d(alu_out), .q(acc));
endmodule
`;

const DATAPATH_TB = `\`timescale 1ns/1ns
// Drives the slice through add / add-immediate / and / or so the schematic wires and buses animate.
module datapath_slice_tb;
  reg clk = 0, rst = 1, valid = 0;
  reg [1:0] mode = 2'd0;
  reg [7:0] a = 8'h00, imm = 8'h00;
  wire [7:0] acc, alu_out;
  datapath_slice dut(.clk(clk), .rst(rst), .valid(valid), .mode(mode), .a(a), .imm(imm), .acc(acc), .alu_out(alu_out));
  always #5 clk = ~clk;
  initial begin
    $dumpfile("datapath_slice.vcd");
    $dumpvars(0, datapath_slice_tb);
    #12 rst = 0;
    valid = 1; mode = 2'd0; a = 8'h05;   #10;   // acc = 0 + 5
    mode = 2'd1; imm = 8'h03;            #10;   // acc = 5 + 3   (immediate)
    mode = 2'd0; a = 8'h10;              #10;   // acc = 8 + 16
    valid = 0; mode = 2'd2;              #20;   // hold: alu_op keeps its old value (the latch!)
    valid = 1; mode = 2'd2; a = 8'h0f;   #10;   // acc = 24 & 15
    mode = 2'd3; a = 8'hf0;              #10;   // acc = 8 | 240
    valid = 0;                           #10;
    $display("acc = %h (expected f8)", acc);
    if (acc === 8'hf8) $display("PASS: datapath slice accumulated 5, +3, +16, &15, |f0");
    else $display("FAIL: acc = %h, expected f8", acc);
    $finish;
  end
endmodule
`;

export const SHOWCASE_PROJECTS = [
  {
    id: 'mips-cpu',
    title: 'MIPS32 Single-Cycle CPU',
    subtitle: 'Fibonacci in assembly on a hierarchical single-cycle CPU: registers, IMEM and DMEM all light up.',
    tags: ['MIPS ASM', 'State Heat', 'Schematic', 'Ctrl+Click'],
    tryNext: 'Hit Run (auto-assembles program.asm -> program.mem), then check State (RegFile heat, IMEM PC disasm, DMEM) and Schematic!',
    openFile: 'program.asm',
    topModule: 'mips_cpu_tb',
    schematicModule: 'mips_cpu',
    dockTab: 'hw-state',
    files: { 'program.asm': MIPS_PROGRAM, 'mips_cpu.v': MIPS_CPU, 'mips_cpu_tb.v': MIPS_CPU_TB },
  },
  {
    id: 'fpga-board',
    title: 'Interactive FPGA Board Lab',
    subtitle: 'Loadable up/down counter on switches, LEDs and 7-segment digits, live or replayed.',
    tags: ['Live DUT', '7-Seg & LEDs', 'Replay Board', 'Schematic'],
    tryNext: 'Open Board -> Live DUT -> Start Live to flip switches & tick the clock, or hit Run for Replay mode!',
    openFile: 'fpga_counter.v',
    topModule: 'fpga_board_tb',
    schematicModule: 'fpga_counter',
    dockTab: 'board',
    files: { 'fpga_counter.v': FPGA_COUNTER, 'fpga_board_tb.v': FPGA_TB },
  },
  {
    id: 'fsm-control',
    title: 'Multi-Cycle CPU Control FSM',
    subtitle: 'Five-state MIPS controller; the waveform shows FETCH, DECODE and EXEC by name.',
    tags: ['FSM States', 'Waveform', 'Inspector', 'Schematic'],
    tryNext: 'Hit Run -> Waveform shows FETCH / DECODE / EXEC / MEM / WRITEBACK directly on the state bus & Inspector!',
    openFile: 'multicycle_fsm.v',
    topModule: 'fsm_tb',
    schematicModule: 'multicycle_fsm',
    dockTab: 'waveform',
    files: { 'multicycle_fsm.v': MULTICYCLE_FSM, 'fsm_tb.v': FSM_TB },
  },
  {
    id: 'alu-suite',
    title: '32-Bit MIPS ALU + Test Suite',
    subtitle: 'Hierarchical ALU with four self-checking testbenches run as one suite.',
    tags: ['Run All Tests', 'Multi-TB', 'F12 / Search', 'Schematic'],
    tryNext: 'Open Tests -> Run All Tests to run all 4 testbenches sequentially with 1-click Wave/Log inspection!',
    openFile: 'alu32.v',
    topModule: '',
    schematicModule: 'alu32',
    dockTab: 'tests',
    files: { 'alu32.v': ALU32, 'tb_alu_arith.v': TB_ARITH, 'tb_alu_logic.v': TB_LOGIC, 'tb_alu_shift.v': TB_SHIFT, 'tb_alu_flags.v': TB_FLAGS },
  },
  {
    id: 'bug-hunter',
    title: 'RTL Schematic & Latch Bug Hunter',
    subtitle: 'Four-block datapath slice hiding a classic missing-else latch. Find it in the schematic.',
    tags: ['Schematic', 'Latch Alert', 'Live VCD Overlay', 'Flatten / SVG'],
    tryNext: 'Hit Run, then Schematic -> Elaborate to catch the inferred LATCH, jump to the buggy line, and drill into submodules!',
    openFile: 'datapath_slice.v',
    topModule: 'datapath_slice_tb',
    schematicModule: 'datapath_slice',
    dockTab: 'schematic',
    files: { 'datapath_slice.v': DATAPATH_SLICE, 'datapath_slice_tb.v': DATAPATH_TB },
  },
];

export const showcaseProject = id => SHOWCASE_PROJECTS.find(project => project.id === id) || null;
