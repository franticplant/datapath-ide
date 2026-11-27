import initPreprocessor from './engine/ivlpp.js';
import initCompiler from './engine/ivl.js';
import initRuntime from './engine/vvp.js';

const MAX_OUTPUT = 512 * 1024;
const FLUSH_BYTES = 16 * 1024;
const FLUSH_MS = 50;
const MAX_VCD = 32 * 1024 * 1024;
const MEM_TRACE = '/work/.datapath_mem.json';
const SESSION_STATE = '/work/.session_state.json';
const LIVE_TOP = '_live_board_tb';
const ENGINE_FILES = new Set(['.datapath_mem.json', '.session_state.json']);

function populate(fs, files) {
  fs.mkdir('/work');
  files = Object.fromEntries(Object.entries(files).filter(([path]) => !ENGINE_FILES.has(path)));
  const dirs = new Set(['/work']);
  for (const [path, content] of Object.entries(files)) {
    if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\r\n]/.test(path) || typeof content !== 'string') throw new Error(`Invalid project path: ${path}`);
    const parts = path.split('/');
    let dir = '/work';
    for (const part of parts.slice(0, -1)) {
      dir += `/${part}`;
      dirs.add(dir);
      try { fs.mkdir(dir); } catch (error) { if (!fs.analyzePath(dir).exists) throw error; }
    }
    fs.writeFile(`/work/${path}`, content);
  }
  fs.chdir('/work');
  return Array.from(dirs);
}

function collectVcd(fs, limit, path = '/work') {
  const results = [];
  for (const name of fs.readdir(path)) {
    if (name === '.' || name === '..') continue;
    const full = `${path}/${name}`; const stat = fs.stat(full);
    if (fs.isDir(stat.mode)) results.push(...collectVcd(fs, limit, full));
    else if (/\.vcd$/i.test(name)) {
      if (stat.size > limit) throw new Error(`VCD exceeds capture limit: ${full}`);
      results.push({ path: full.slice(6), data: fs.readFile(full, { encoding: 'utf8' }) });
    }
  }
  return results;
}

function parseDiagnostics(lines) {
  const items = [];
  for (const raw of lines) {
    const match = raw.match(/^(?:\/work\/)?([^:\s][^:]*):(\d+):\s*(warning:\s*|error:\s*)?(.*)$/i);
    if (!match) continue;
    const file = match[1];
    const line = Number(match[2]);
    const tag = (match[3] || '').toLowerCase();
    const message = match[4].trim() || raw.trim();
    const severity = tag.startsWith('warning') ? 'warning' : 'error';
    items.push({ file, line, severity, message });
  }
  return items;
}

// Validate a request, then preprocess and compile it. Throws on any failure (diagnostics are posted first).
async function buildProgram(data, buildOptions, phase, buildLines, runId) {
  const files = data.files || {};
  const selected = Array.isArray(data.sourceFiles) ? data.sourceFiles : Object.keys(files).filter(path => /\.(?:v|sv)$/i.test(path));
  if (selected.some(path => !Object.hasOwn(files, path) || !/\.(?:v|sv)$/i.test(path))) throw new Error('Invalid source file selection.');
  const sources = selected.map(path => `/work/${path}`);
  if (!sources.length) throw new Error('Add at least one Verilog source file.');
  const top = (data.topModule || '').trim();
  if (top && !/^[a-zA-Z_][\w$]*$/.test(top)) throw new Error('Invalid top module name.');
  if (!['2001', '2005', '2009', '2012'].includes(data.standard)) throw new Error('Unsupported language standard.');
  const defines = Array.isArray(data.defines) ? data.defines : [];
  const includePaths = Array.isArray(data.includeDirs) ? data.includeDirs : [];
  const parameters = Array.isArray(data.parameters) ? data.parameters : [];
  const plusargs = Array.isArray(data.plusargs) ? data.plusargs : [];
  const warnings = Array.isArray(data.warnings) ? data.warnings : [];
  if (defines.some(value => typeof value !== 'string' || !/^[A-Za-z_$][\w$]*(?:=[^\r\n]*)?$/.test(value))) throw new Error('Invalid macro definition.');
  if (includePaths.some(path => typeof path !== 'string' || (path !== '.' && (!path || path.startsWith('/') || /[\\\r\n]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'))))) throw new Error('Invalid include path.');
  if (parameters.some(value => typeof value !== 'string' || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+=[^\r\n]+$/.test(value))) throw new Error('Invalid parameter override.');
  if (plusargs.some(value => typeof value !== 'string' || !value.startsWith('+') || /[\r\n]/.test(value))) throw new Error('Invalid runtime plusarg.');
  if (warnings.some(value => !['all', 'implicit', 'portbind', 'timescale'].includes(value))) throw new Error('Invalid warning option.');

  phase('preprocessing');
  const preprocessor = await initPreprocessor(buildOptions());
  const includeDirs = populate(preprocessor.FS, files);
  preprocessor.FS.writeFile('/pp.flags', [...defines.map(value => `D:${value}`), ...includePaths.map(path => `I:/work${path === '.' ? '' : `/${path}`}`), ...includeDirs.map(dir => `I:${dir}`)].join('\n') + '\n');
  let code = preprocessor.callMain(['-L', '-F/pp.flags', ...(warnings.includes('all') ? ['-Wredef-chg'] : []), '-o/preprocessed.v', ...sources]);
  if (code) throw new Error(`Preprocessing failed (exit ${code}).`);
  const preprocessed = preprocessor.FS.readFile('/preprocessed.v');

  phase('compiling');
  const compiler = await initCompiler(buildOptions());
  compiler.FS.writeFile('/preprocessed.v', preprocessed);
  const warningFlags = new Set('n');
  if (warnings.includes('all')) for (const flag of 'nidpsta') warningFlags.add(flag);
  if (warnings.includes('implicit')) warningFlags.add('i'); if (warnings.includes('portbind')) warningFlags.add('p'); if (warnings.includes('timescale')) warningFlags.add('t');
  compiler.FS.writeFile('/config', `basedir:/\nmodule:system.vpi\nmodule:v2005_math.vpi\ngeneration:${data.standard}\ngeneration:${data.specify ? 'specify' : 'no-specify'}\nwarnings:${[...warningFlags].join('')}\n${parameters.map(value => `defparam:${value}\n`).join('')}flag:DLL=vvp.tgt\nfunctor:cprop\nfunctor:nodangle\n${top ? `root:${top}\n` : ''}out:/program.vvp\n`);
  code = compiler.callMain(['-C/config', '--', '/preprocessed.v']);
  const diagnostics = parseDiagnostics(buildLines);
  if (diagnostics.length) self.postMessage({ type: 'diagnostics', runId, items: diagnostics });
  if (code) throw new Error(`Compilation failed (exit ${code}).`);
  return { files, program: compiler.FS.readFile('/program.vvp'), plusargs };
}

// Memory/register-file capture written by vvp (engine/vvp-live.cc); absent when the design has no arrays.
function readMemTrace(fs) {
  if (!fs.analyzePath(MEM_TRACE).exists) return null;
  try {
    const trace = JSON.parse(fs.readFile(MEM_TRACE, { encoding: 'utf8' }));
    return trace && Array.isArray(trace.arrays) ? trace : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- live sessions
// One steppable vvp instance per worker, driven through the exported vvp_session_* API.
let live = null;   // { runtime, output: string[] }

function liveState(code) {
  const state = JSON.parse(live.runtime.FS.readFile(SESSION_STATE, { encoding: 'utf8' }));
  const output = live.output.splice(0);
  return { ...state, code, output };
}

function liveCall(name, types, args) {
  return live.runtime.ccall(name, 'number', types, args);
}

function liveSet(signals) {
  for (const [path, bits] of Object.entries(signals || {})) {
    if (!/^[01xzXZ]+$/.test(bits) || liveCall('vvp_session_set', ['string', 'string'], [`${LIVE_TOP}.${path}`, bits]) !== 0) {
      throw new Error(`Cannot drive ${path}`);
    }
  }
}

function liveStep(ticks) {
  const code = liveCall('vvp_session_step', ['number'], [ticks]);
  if (code < 0) throw new Error('Simulation exceeded the per-step event limit (combinational loop?).');
  return code;
}

async function handleLive(data) {
  const { requestId } = data;
  const reply = (payload) => self.postMessage({ type: 'live-reply', requestId, ...payload });
  try {
    if (data.type === 'live-start') {
      if (live) throw new Error('A live session is already running.');
      const buildLines = [];
      const output = [];
      const log = line => { output.push(line); if (buildLines.length < 2000) buildLines.push(line); };
      let built;
      try {
        built = await buildProgram({ ...data, topModule: LIVE_TOP }, () => ({ print: log, printErr: log }), () => {}, buildLines, requestId);
      } catch (error) {
        throw new Error([error.message, ...buildLines].join('\n'));
      }
      const { files, program } = built;
      const runtime = await initRuntime({ print: line => output.push(line), printErr: line => output.push(line) });
      populate(runtime.FS, files);
      runtime.FS.writeFile('/program.vvp', program);
      live = { runtime, output };
      const code = liveCall('vvp_session_open', ['string'], ['/program.vvp']);
      if (code < 0) { live = null; throw new Error(`Could not start the live session.\n${output.join('\n')}`); }
      reply({ state: liveState(code) });
      return;
    }
    if (!live) throw new Error('No live session is running.');
    if (data.type === 'live-set') {
      liveSet(data.signals);
      reply({ state: liveState(liveStep(0)) });
    } else if (data.type === 'live-step') {
      reply({ state: liveState(liveStep(Math.max(0, Math.min(1e9, Number(data.ticks) || 0)))) });
    } else if (data.type === 'live-tick') {
      // One full clock cycle per tick: rising edge, settle, falling edge, settle (one time unit per phase).
      const count = Math.max(1, Math.min(10000, Number(data.count) || 1));
      let code = 0;
      for (let i = 0; i < count && code === 0; i++) {
        liveSet({ ...(data.signals || {}), [data.clock]: '1' });
        code = liveStep(1);
        if (code) break;
        liveSet({ [data.clock]: '0' });
        code = liveStep(1);
      }
      reply({ state: liveState(code) });
    } else if (data.type === 'live-stop') {
      liveCall('vvp_session_close', [], []);
      const output = live.output.splice(0);
      live = null;
      reply({ stopped: true, output });
    }
  } catch (error) {
    reply({ error: error.message || String(error) });
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === 'init') { self.postMessage({ type: 'ready', version: 'Icarus Verilog 13.0', capabilities: { cooperativeStop: false, liveSessions: true } }); return; }
  if (typeof data.type === 'string' && data.type.startsWith('live-')) { await handleLive(data); return; }
  if (data.type !== 'run' && data.type !== 'compile') return;
  const { runId } = data;
  const outputLimit = Number.isInteger(data.outputCap) && data.outputCap >= 4096 && data.outputCap <= 8192 * 1024 ? data.outputCap : MAX_OUTPUT;
  const vcdLimit = Number.isInteger(data.vcdCap) && data.vcdCap >= 1024 * 1024 && data.vcdCap <= MAX_VCD ? data.vcdCap : MAX_VCD;
  let pending = '';
  let sentBytes = 0;
  let truncated = false;
  let lastFlush = performance.now();
  const buildLines = [];

  const flush = (force = false) => {
    if (!pending) return;
    const now = performance.now();
    if (!force && pending.length < FLUSH_BYTES && now - lastFlush < FLUSH_MS) return;
    self.postMessage({ type: 'output', runId, stream: 'combined', chunk: pending });
    pending = '';
    lastFlush = now;
  };

  const logLine = (line, recordBuild = false) => {
    if (recordBuild && buildLines.length < 2000) buildLines.push(line);
    if (truncated) return;
    const next = `${line}\n`;
    if (sentBytes + next.length > outputLimit) {
      const remaining = outputLimit - sentBytes;
      if (remaining > 0) pending += next.slice(0, remaining);
      pending += '\n[Output limit reached; further output truncated]\n';
      truncated = true;
      flush(true);
      return;
    }
    pending += next;
    sentBytes += next.length;
    flush(false);
  };

  const phase = name => self.postMessage({ type: 'status', runId, phase: name });
  const buildOptions = () => ({ print: line => logLine(line, true), printErr: line => logLine(line, true) });
  const runOptions = () => ({ print: line => logLine(line, false), printErr: line => logLine(line, false) });

  try {
    const { files, program, plusargs } = await buildProgram(data, buildOptions, phase, buildLines, runId);

    let vcdFiles = [];
    let memTrace = null;
    if (data.type === 'run') {
      phase('simulating');
      const runtime = await initRuntime(runOptions());
      populate(runtime.FS, files);
      runtime.FS.writeFile('/program.vvp', program);
      const code = runtime.callMain([...(data.stopAsFinish ? ['-n'] : []), '/program.vvp', ...plusargs]);
      if (code) throw new Error(`Simulation failed (exit ${code}).`);
      vcdFiles = collectVcd(runtime.FS, vcdLimit).filter(file => !Object.hasOwn(files, file.path) || files[file.path] !== file.data);
      memTrace = readMemTrace(runtime.FS);
    }

    flush(true);
    self.postMessage({ type: 'result', runId, exitCode: 0, vcdFiles, memTrace, partial: false });
  } catch (error) {
    const diagnostics = parseDiagnostics(buildLines);
    if (diagnostics.length) self.postMessage({ type: 'diagnostics', runId, items: diagnostics });
    flush(true);
    self.postMessage({ type: 'error', runId, message: error.message || String(error) });
  }
};
