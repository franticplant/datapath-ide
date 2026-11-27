// Shared offline WASM Icarus Verilog harness for Stage A correctness suites.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { ivlConfig, parseIvlLog, dropModeledMemoryWrites } from '../../web/elaborate-worker.js';

const wasmDir = process.env.WASM_DIR ? pathToFileURL(`${resolve(process.env.WASM_DIR)}/`) : new URL('../../web/engine/', import.meta.url);
const { default: initPreprocessor } = await import(new URL('ivlpp.js', wasmDir));
const { default: initCompiler } = await import(new URL('ivl.js', wasmDir));
const { default: initRuntime } = await import(new URL('vvp.js', wasmDir));

function writeTree(fs, base, files) {
  const dirs = new Set([base]);
  try { fs.mkdir(base); } catch { /* exists */ }
  for (const [path, text] of Object.entries(files)) {
    let dir = base;
    for (const part of path.split('/').slice(0, -1)) {
      dir += `/${part}`;
      if (!dirs.has(dir)) { dirs.add(dir); try { fs.mkdir(dir); } catch { /* exists */ } }
    }
    fs.writeFile(`${base}/${path}`, text);
  }
  return [...dirs];
}

export async function compileVvp(sources, { top, standard = '2005', extraFlags = [] } = {}) {
  const log = [];
  const options = () => ({ print: line => log.push(line), printErr: line => log.push(line) });
  const verilogFiles = Object.keys(sources).filter(path => /\.(?:v|sv)$/i.test(path));
  const pp = await initPreprocessor(options());
  const dirs = writeTree(pp.FS, '/work', sources);
  pp.FS.writeFile('/pp.flags', dirs.map(d => `I:${d}`).join('\n') + '\n');
  const ppCode = pp.callMain(['-L', '-F/pp.flags', '-o/preprocessed.v', ...verilogFiles.map(p => `/work/${p}`)]);
  if (ppCode) return { ok: false, phase: 'preprocess', program: null, log: log.join('\n'), diagnostics: parseIvlLog(log, false) };

  const ivl = await initCompiler(options());
  ivl.FS.mkdir('/work');
  ivl.FS.writeFile('/preprocessed.v', pp.FS.readFile('/preprocessed.v'));
  ivl.FS.writeFile('/config', [
    'basedir:/', 'module:system.vpi', 'module:v2005_math.vpi',
    `generation:${standard}`, 'generation:no-specify', 'warnings:n',
    'flag:DLL=vvp.tgt', 'functor:cprop', 'functor:nodangle',
    ...extraFlags,
    ...(top ? [`root:${top}`] : []),
    'out:/program.vvp', '',
  ].join('\n'));
  const ivlCode = ivl.callMain(['-C/config', '--', '/preprocessed.v']);
  const diagnostics = parseIvlLog(log, ivlCode === 0);
  if (ivlCode) return { ok: false, phase: 'compile', program: null, log: log.join('\n'), diagnostics };
  return { ok: true, program: ivl.FS.readFile('/program.vvp'), log: log.join('\n'), diagnostics };
}

export async function runVvp(program, runtimeFiles = {}) {
  const output = [];
  const rt = await initRuntime({ print: line => output.push(line), printErr: line => output.push(line) });
  writeTree(rt.FS, '/work', runtimeFiles);
  rt.FS.chdir('/work');
  rt.FS.writeFile('/program.vvp', program);
  const code = rt.callMain(['/program.vvp']);
  let memTrace = null;
  if (rt.FS.analyzePath('/work/.datapath_mem.json').exists) {
    memTrace = JSON.parse(rt.FS.readFile('/work/.datapath_mem.json', { encoding: 'utf8' }));
  }
  let vcd = null;
  for (const name of rt.FS.readdir('/work')) {
    if (/\.vcd$/i.test(name)) vcd = rt.FS.readFile(`/work/${name}`, { encoding: 'utf8' });
  }
  return { code, output, memTrace, vcd };
}

export async function compileAndRun(sources, options = {}, runtimeFiles = {}) {
  const compiled = await compileVvp(sources, options);
  if (!compiled.ok) throw new Error(`Compile failed: ${compiled.log}`);
  const ran = await runVvp(compiled.program, runtimeFiles);
  if (ran.code !== 0) throw new Error(`Runtime exit ${ran.code}: ${ran.output.join('\n')}`);
  return ran;
}

export async function elaborateJson(sources, { top, standard = '2005' }) {
  const log = [];
  const options = () => ({ print: line => log.push(line), printErr: line => log.push(line) });
  const verilogFiles = Object.keys(sources).filter(path => /\.(?:v|sv)$/i.test(path));
  const pp = await initPreprocessor(options());
  const dirs = writeTree(pp.FS, '/work', sources);
  pp.FS.writeFile('/pp.flags', dirs.map(d => `I:${d}`).join('\n') + '\n');
  if (pp.callMain(['-L', '-F/pp.flags', '-o/preprocessed.v', ...verilogFiles.map(p => `/work/${p}`)])) {
    return { ok: false, yosysJson: null, diagnostics: parseIvlLog(log, false), log: log.join('\n') };
  }
  const ivl = await initCompiler(options());
  ivl.FS.mkdir('/work');
  ivl.FS.writeFile('/preprocessed.v', pp.FS.readFile('/preprocessed.v'));
  ivl.FS.writeFile('/config', ivlConfig({ topModule: top, standard }));
  const code = ivl.callMain(['-C/config', '--', '/preprocessed.v']);
  const rawDiag = parseIvlLog(log, code === 0);
  if (code !== 0 || !ivl.FS.analyzePath('/work/schematic.json').exists) {
    return { ok: false, yosysJson: null, diagnostics: rawDiag, log: log.join('\n') };
  }
  const yosysJson = JSON.parse(ivl.FS.readFile('/work/schematic.json', { encoding: 'utf8' }));
  return { ok: true, yosysJson, diagnostics: dropModeledMemoryWrites(rawDiag, yosysJson), log: log.join('\n') };
}

// Steps a live vvp session cleanly (mirrors simulator-worker.js live session protocol).
export async function runLiveSession(sources, topModule, clockName, cycleInputs, { standard = '2005' } = {}) {
  const compiled = await compileVvp(sources, { top: topModule, standard });
  if (!compiled.ok) throw new Error(`Live compile failed: ${compiled.log}`);
  const output = [];
  const rt = await initRuntime({ print: line => output.push(line), printErr: line => output.push(line) });
  rt.FS.mkdir('/work');
  rt.FS.chdir('/work');
  rt.FS.writeFile('/program.vvp', compiled.program);
  const call = (name, types, args) => rt.ccall(name, 'number', types, args);
  const readState = () => JSON.parse(rt.FS.readFile('/work/.session_state.json', { encoding: 'utf8' }));
  if (call('vvp_session_open', ['string'], ['/program.vvp']) !== 0) throw new Error(`vvp_session_open failed: ${output.join('\n')}`);

  const snapshots = [];
  for (const inputs of cycleInputs) {
    for (const [name, bits] of Object.entries(inputs)) {
      if (call('vvp_session_set', ['string', 'string'], [`${topModule}.${name}`, bits]) !== 0) {
        throw new Error(`vvp_session_set failed for ${name}=${bits}`);
      }
    }
    call('vvp_session_step', ['number'], [0]);
    if (clockName) {
      call('vvp_session_set', ['string', 'string'], [`${topModule}.${clockName}`, '1']);
      call('vvp_session_step', ['number'], [1]);
      call('vvp_session_set', ['string', 'string'], [`${topModule}.${clockName}`, '0']);
      call('vvp_session_step', ['number'], [1]);
    }
    snapshots.push(readState());
  }
  call('vvp_session_close', [], []);
  return snapshots;
}
