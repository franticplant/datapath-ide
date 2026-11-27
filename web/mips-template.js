// "MIPS32 Mini-CPU + program.asm" starter: a single-cycle MIPS subset CPU, its program and a self-checking testbench.

export const MIPS_TEMPLATE_TOP = 'mips_tb';

const PROGRAM = `# @out program.mem
# Sum 1 + 2 + 3 + 4 + 5 into $t1 (expected: 15 = 0x0000000f).
# Assemble (Ctrl+Shift+A) or just Run: .asm files are assembled into program.mem first.

        addi $t0, $zero, 1      # i     = 1
        addi $t1, $zero, 0      # sum   = 0
        addi $t2, $zero, 6      # limit = 6 (loop while i != limit)
loop:   add  $t1, $t1, $t0      # sum  += i
        addi $t0, $t0, 1        # i    += 1
        bne  $t0, $t2, loop     # repeat until i == limit
done:   j    done               # stop here
`;

const CPU = `// Single-cycle MIPS32 subset: add sub and or slt addi lw sw beq bne j (and nop).
// Instructions come from program.mem (assembled from program.asm); PC starts at 0.
module mips_mini(input clk, input reset, output [31:0] pc_out);
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

  wire [31:0] pc_next = pc + 32'd4;
  wire take = (branch_eq & zero) | (branch_ne & ~zero);
  always @(posedge clk)
    if (reset)     pc <= 32'd0;
    else if (jump) pc <= {pc_next[31:28], instr[25:0], 2'b00};
    else if (take) pc <= pc_next + (imm << 2);
    else           pc <= pc_next;
  assign pc_out = pc;
endmodule

module mips_control(input [5:0] op, input [5:0] funct,
                    output reg reg_dst, alu_src, mem_to_reg, reg_write, mem_write, branch_eq, branch_ne, jump,
                    output reg [2:0] alu_op);
  always @(*) begin
    {reg_dst, alu_src, mem_to_reg, reg_write, mem_write, branch_eq, branch_ne, jump} = 8'b0;
    alu_op = 3'd2;                                                   // add
    case (op)
      6'h00: begin
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
    $readmemh("program.mem", mem, 0);
  end
  assign instr = mem[addr[7:2]];
endmodule

module mips_dmem(input clk, input we, input [31:0] addr, input [31:0] wd, output [31:0] rd);
  reg [31:0] mem [0:63];
  always @(posedge clk) if (we) mem[addr[7:2]] <= wd;
  assign rd = mem[addr[7:2]];
endmodule
`;

const TESTBENCH = `\`timescale 1ns/1ns
// Self-checking testbench: runs program.mem and expects $t1 (register 9) = 15.
module mips_tb;
  reg clk = 0, reset = 1;
  wire [31:0] pc;
  mips_mini dut(.clk(clk), .reset(reset), .pc_out(pc));
  always #5 clk = ~clk;
  initial begin
    $dumpfile("mips.vcd");
    $dumpvars(0, mips_tb);
    #12 reset = 0;
    #400;
    if (dut.u_rf.regs[9] === 32'd15) $display("PASS: $t1 = %0d", dut.u_rf.regs[9]);
    else $display("FAIL: $t1 = %0d, expected 15", dut.u_rf.regs[9]);
    $finish;
  end
endmodule
`;

export const MIPS_TEMPLATE = { 'program.asm': PROGRAM, 'mips_mini.v': CPU, 'mips_tb.v': TESTBENCH };
