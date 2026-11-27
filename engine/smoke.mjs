// Offline smoke test of the compiler/runtime before browser integration.
// Tests the shipped engine in web/engine/ by default; WASM_DIR=build/wasm checks a fresh build before copying it.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const wasmDir = process.env.WASM_DIR ? pathToFileURL(`${resolve(process.env.WASM_DIR)}/`) : new URL('../web/engine/', import.meta.url);
const { default: initPreprocessor } = await import(new URL('ivlpp.js', wasmDir));
const { default: initCompiler } = await import(new URL('ivl.js', wasmDir));
const { default: initRuntime } = await import(new URL('vvp.js', wasmDir));

// Preprocess + compile `sources` ({ name: text }) into a .vvp program image.
async function compile(sources, top, generation = '2005') {
  const diagnostics = [];
  // Emscripten adopts the options object as its Module, so each instance gets its own.
  const options = () => ({ print: line => diagnostics.push(line), printErr: line => diagnostics.push(line) });
  const preprocessor = await initPreprocessor(options());
  preprocessor.FS.mkdir('/src');
  for (const [name, text] of Object.entries(sources)) preprocessor.FS.writeFile(`/src/${name}`, text);
  const preprocessCode = preprocessor.callMain(['-L', '-o/preprocessed.v', ...Object.keys(sources).map(name => `/src/${name}`)]);
  if (preprocessCode) throw new Error(`Preprocessor failed (${preprocessCode}): ${diagnostics.join('\n')}`);
  const compiler = await initCompiler(options());
  compiler.FS.writeFile('/preprocessed.v', preprocessor.FS.readFile('/preprocessed.v'));
  compiler.FS.writeFile('/config', `basedir:/\nmodule:system.vpi\nmodule:v2005_math.vpi\ngeneration:${generation}\nflag:DLL=vvp.tgt\nfunctor:cprop\nfunctor:nodangle\nroot:${top}\nout:/program.vvp\n`);
  const compileCode = compiler.callMain(['-C/config', '--', '/preprocessed.v']);
  if (compileCode) throw new Error(`Compiler failed (${compileCode}): ${diagnostics.join('\n')}`);
  return compiler.FS.readFile('/program.vvp');
}

// A fresh runtime with /work as the working directory.
async function runtimeWith(program, files = {}) {
  const output = [];
  const runtime = await initRuntime({ print: line => output.push(line), printErr: line => output.push(line) });
  runtime.FS.mkdir('/work');
  for (const [name, text] of Object.entries(files)) runtime.FS.writeFile(`/work/${name}`, text);
  runtime.FS.chdir('/work');
  runtime.FS.writeFile('/program.vvp', program);
  return { runtime, output };
}

const assert = (condition, message) => { if (!condition) throw new Error(message); };

// 1. Multi-file design, $readmemh, v2005_math and VCD output.
{
  const program = await compile({
    'design.v': 'module rom(output [7:0] x); reg [7:0] mem [0:0]; initial $readmemh("data.mem", mem); assign x = mem[0]; endmodule\n',
    'test.v': 'module tb; wire [7:0] x; rom dut(x); initial begin $dumpfile("trace.vcd"); $dumpvars(0,tb); #1 $display("value=%h",x); $display("sqrt=%f sin=%f", $sqrt(9.0), $sin(0.0)); $finish; end endmodule\n',
  }, 'tb');
  const { runtime, output } = await runtimeWith(program, { 'data.mem': '2a\n' });
  const runCode = runtime.callMain(['/program.vvp']);
  assert(!runCode && output.includes('value=2a'), `Simulation failed (${runCode}): ${output.join('\n')}`);
  assert(output.includes('sqrt=3.000000 sin=0.000000'), `Math functions failed: ${output.join('\n')}`);
  assert(runtime.FS.readFile('/work/trace.vcd', { encoding: 'utf8' }).includes('$enddefinitions'), 'VCD file was not created');
}

// 2. Automatic register-file capture: $readmemh initial contents plus a timestamped clocked write.
{
  const program = await compile({
    'rf.v': '`timescale 1ns/1ns\nmodule rf(input clk, input we, input [4:0] wa, input [31:0] wd);\n  reg [31:0] regs [0:31];\n  initial $readmemh("regs.mem", regs);\n  always @(posedge clk) if (we) regs[wa] <= wd;\nendmodule\n',
    'tb.v': '`timescale 1ns/1ns\nmodule tb;\n  reg clk = 0, we = 0; reg [4:0] wa = 0; reg [31:0] wd = 0;\n  rf dut(clk, we, wa, wd);\n  always #5 clk = ~clk;\n  initial begin #12 we = 1; wa = 8; wd = 32\'h14; #10 we = 0; #20 $finish; end\nendmodule\n',
  }, 'tb');
  const regs = Array.from({ length: 32 }, (_, index) => index === 9 ? '0000000a' : '00000000').join('\n');
  const { runtime, output } = await runtimeWith(program, { 'regs.mem': `${regs}\n` });
  const runCode = runtime.callMain(['/program.vvp']);
  assert(!runCode, `Register-file simulation failed (${runCode}): ${output.join('\n')}`);
  const trace = JSON.parse(runtime.FS.readFile('/work/.datapath_mem.json', { encoding: 'utf8' }));
  const array = trace.arrays.find(item => item.path === 'tb.dut.regs');
  assert(trace.timescale === '1ns', `Unexpected timescale ${trace.timescale}`);
  assert(array && array.width === 32 && array.size === 32 && array.left === 0 && array.right === 31, `Bad array metadata: ${JSON.stringify(trace)}`);
  assert(array.init['9'] === '0000000a' && array.init['0'] === '00000000' && Object.keys(array.init).length === 32, `Bad initial snapshot: ${JSON.stringify(array.init)}`);
  assert(JSON.stringify(array.deltas) === JSON.stringify([[15, 8, '00000014']]), `Bad deltas: ${JSON.stringify(array.deltas)}`);
}

// 3. Steppable live session: drive inputs and advance time on a clocked counter.
{
  const program = await compile({
    'counter.v': 'module counter(input clk, input reset, output reg [3:0] count);\n  always @(posedge clk) if (reset) count <= 0; else count <= count + 1;\nendmodule\n',
    'live.v': 'module _live_board_tb;\n  reg clk = 0; reg reset = 1; wire [3:0] count;\n  reg [7:0] scratch [0:3];\n  counter dut(.clk(clk), .reset(reset), .count(count));\n  always @(negedge clk) scratch[count[1:0]] <= {4\'ha, count};\nendmodule\n',
  }, '_live_board_tb');
  const { runtime, output } = await runtimeWith(program);
  const call = (name, types, args) => runtime.ccall(name, 'number', types, args);
  const state = () => JSON.parse(runtime.FS.readFile('/work/.session_state.json', { encoding: 'utf8' }));
  const tick = () => {
    assert(call('vvp_session_set', ['string', 'string'], ['_live_board_tb.clk', '1']) === 0, 'set clk=1 failed');
    assert(call('vvp_session_step', ['number'], [1]) === 0, 'step after rising edge failed');
    assert(call('vvp_session_set', ['string', 'string'], ['_live_board_tb.clk', '0']) === 0, 'set clk=0 failed');
    assert(call('vvp_session_step', ['number'], [1]) === 0, 'step after falling edge failed');
  };
  assert(call('vvp_session_open', ['string'], ['/program.vvp']) === 0, `Session open failed: ${output.join('\n')}`);
  const opened = state();
  assert(opened.time === 0 && opened.signals['_live_board_tb.reset'] === '1', `Bad initial session state: ${JSON.stringify(opened)}`);
  assert(opened.arrays.some(item => item.path === '_live_board_tb.scratch' && item.size === 4), 'Session did not report memory arrays');
  tick();
  assert(state().signals['_live_board_tb.count'] === '0000', `Reset did not clear count: ${JSON.stringify(state())}`);
  assert(call('vvp_session_set', ['string', 'string'], ['_live_board_tb.reset', '0']) === 0, 'set reset=0 failed');
  assert(call('vvp_session_step', ['number'], [0]) === 0, 'delta step failed');
  const counts = [];
  for (let i = 0; i < 3; i++) { tick(); counts.push(state().signals['_live_board_tb.count']); }
  assert(JSON.stringify(counts) === JSON.stringify(['0001', '0010', '0011']), `Live counter did not count 1..3: ${counts}`);
  const scratch = state().arrays.find(item => item.path === '_live_board_tb.scratch');
  assert(scratch.words['3'] === 'a3' && scratch.words['1'] === 'a1', `Live array snapshot is stale: ${JSON.stringify(scratch)}`);
  assert(state().time === 8, `Unexpected live time ${state().time}`);
  assert(call('vvp_session_set', ['string', 'string'], ['_live_board_tb.missing', '1']) === -1, 'Unknown signal was accepted');
  assert(call('vvp_session_close', [], []) === 0, 'Session close failed');
}

// 4. Schematic target (json.tgt): synthesized RTL as Yosys-style JSON with hierarchy, latches and memories.
{
  const log = [];
  const options = () => ({ print: line => log.push(line), printErr: line => log.push(line) });
  const preprocessor = await initPreprocessor(options());
  const sources = {
    'counter.v': 'module counter(input clk, input reset, output reg [3:0] count);\n  always @(posedge clk) if (reset) count <= 0; else count <= count + 1;\nendmodule\n',
    'hier.v': 'module hier_child(input [3:0] a, input [3:0] b, input sel, output [3:0] y);\n  assign y = sel ? a : b;\nendmodule\nmodule latchy(input en, input [3:0] d, output reg [3:0] q);\n  always @(*) if (en) q = d;\nendmodule\n',
    'rf.v': 'module regfile(input clk, input we, input [4:0] ra, input [4:0] wa, input [31:0] wd, output [31:0] rd);\n  reg [31:0] regs [0:31];\n  always @(posedge clk) if (we) regs[wa] <= wd;\n  assign rd = regs[ra];\nendmodule\n',
    'top.v': 'module hier_top(input clk, input [3:0] x, input s, input en, output [3:0] z, output [3:0] l, output [31:0] rd);\n  hier_child u_child(.a(x), .b(~x), .sel(s), .y(z));\n  latchy u_latch(.en(en), .d(x), .q(l));\n  regfile u_rf(.clk(clk), .we(s), .ra({1\'b0, x}), .wa({1\'b0, x}), .wd({28\'d0, x}), .rd(rd));\nendmodule\n',
  };
  preprocessor.FS.mkdir('/work');
  for (const [name, text] of Object.entries(sources)) preprocessor.FS.writeFile(`/work/${name}`, text);
  assert(!preprocessor.callMain(['-L', '-o/preprocessed.v', ...Object.keys(sources).map(name => `/work/${name}`)]), `Schematic preprocess failed: ${log.join('\n')}`);
  const compiler = await initCompiler(options());
  compiler.FS.mkdir('/work');
  compiler.FS.writeFile('/preprocessed.v', preprocessor.FS.readFile('/preprocessed.v'));
  compiler.FS.writeFile('/config', 'basedir:/\nmodule:system.vpi\nmodule:v2005_math.vpi\ngeneration:2005\nflag:DLL=json.tgt\nflag:SCHEMATIC_NONFATAL=1\nfunctor:synth\nfunctor:synth2\nfunctor:cprop\nfunctor:nodangle\nroot:hier_top\nout:/work/schematic.json\n');
  const code = compiler.callMain(['-C/config', '--', '/preprocessed.v']);
  assert(code === 0, `json.tgt compile failed (${code}): ${log.join('\n')}`);
  const { modules } = JSON.parse(compiler.FS.readFile('/work/schematic.json', { encoding: 'utf8' }));
  const cellTypes = name => Object.values(modules[name].cells).map(cell => cell.type).sort();
  assert(modules.hier_top.attributes.top === '00000000000000000000000000000001', 'Top module not marked');
  assert(JSON.stringify(Object.keys(modules.hier_top.cells).filter(name => name.startsWith('u_')).sort()) === JSON.stringify(['u_child', 'u_latch', 'u_rf']), `Missing instances: ${Object.keys(modules.hier_top.cells)}`);
  assert(modules.hier_top.cells.u_child.type === 'hier_child' && JSON.stringify(modules.hier_top.cells.u_child.connections.y) === JSON.stringify(modules.hier_top.ports.z.bits), 'Instance port bits do not match parent nets');
  assert(cellTypes('hier_child').includes('$mux'), `hier_child cells: ${cellTypes('hier_child')}`);
  assert(cellTypes('latchy').includes('$dlatch') && log.some(line => /latch has been inferred for 'q'/.test(line)), `Latch missing: ${cellTypes('latchy')} ${log.join(' | ')}`);
  const memory = modules.regfile.cells.regs;
  assert(memory?.type === '$mem' && ['CLK', 'WR_ADDR', 'WR_DATA', 'WR_EN', 'RD_ADDR0', 'RD_DATA0'].every(pin => memory.connections[pin]), `Register file memory missing: ${JSON.stringify(memory)}`);
  assert(memory.port_directions.RD_DATA0 === 'output' && memory.connections.RD_DATA0.length === 32, 'Register file read port is wrong');
  assert(log.some(line => /kept as a behavioral block/.test(line)) && !log.some(line => /\berror:/.test(line)), `Unexpected schematic diagnostics: ${log.join(' | ')}`);
}

console.log('Icarus WASM smoke test passed');
