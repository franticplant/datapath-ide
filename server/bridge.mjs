#!/usr/bin/env node
// Datapath Studio self-hosted bridge: serves web/, syncs a workspace directory with browser tabs over
// WebSockets, and exposes the IDE plus a headless Icarus/RTL toolchain over MCP (POST /mcp).
// Zero npm dependencies: Node 22 standard library plus the repository's own web/ modules.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, stat, unlink } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { acceptWebSocket, rejectUpgrade } from './ws.mjs';

// require(), not `import`: Node 22's ESM facade for node:http reads every export, including the lazy
// `http.WebSocket` getter, which loads undici and its llhttp WebAssembly. Under `node --jitless`
// (the hardened systemd profile, where WebAssembly does not exist) that crashes the bridge at startup.
const { createServer } = createRequire(import.meta.url)('node:http');

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..');
export const DEFAULT_WEB_DIR = join(REPO_ROOT, 'web');
export const TOKEN_FILE = '.bridge-token';
export const CREDENTIAL_NAME = 'bridge-token'; // systemd LoadCredential[Encrypted]=bridge-token:...
export const META_FILE = '.datapath-project.json';
export const SERVER_INFO = { name: 'datapath-studio-mcp', version: '0.3.0' };
export const PROTOCOL_VERSION = '2024-11-05';
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 5000;
const MAX_BODY_BYTES = 16 * 1024 * 1024;
const TEMP_RE = /^\.[^/]*\.[0-9a-f]{12}\.tmp$/;
const HDL_RE = /\.(?:v|sv|vh|svh)$/i;
const TOKEN_RE = /^[0-9a-f]{32,}$/i;
// Tools that need WebAssembly (Icarus ivl/vvp); dropped with --no-wasm or when V8 runs --jitless.
export const WASM_TOOLS = ['verilog_elaborate', 'verilog_simulate'];

const log = (quiet, ...args) => { if (!quiet) console.error('[bridge]', ...args); };

export class BridgeError extends Error {
  constructor(message, code = 'EBRIDGE') { super(message); this.code = code; }
}

// ------------------------------------------------------------------------------------------------ paths

// Workspace-relative POSIX path check shared by WS messages, MCP tools and the disk scanner.
export function validateWorkspacePath(path) {
  if (typeof path !== 'string' || !path) return 'Path must be a non-empty string';
  if (path.length > 512) return 'Path is too long';
  if (path.startsWith('/')) return 'Absolute paths are not allowed';
  if (path.includes('\\')) return 'Backslashes are not allowed in paths';
  if (/[\u0000-\u001f\u007f]/.test(path)) return 'Control characters are not allowed in paths';
  const parts = path.split('/');
  for (const part of parts) {
    if (part === '' || part === '.' || part === '..') return `Invalid path segment in '${path}'`;
    if (part === '.git') return 'The .git directory is not part of the workspace';
  }
  if (path === TOKEN_FILE || path === META_FILE) return `'${path}' is reserved for the bridge`;
  if (TEMP_RE.test(parts.at(-1))) return 'Bridge temporary file names are reserved';
  return null;
}

function assertPath(path) {
  const problem = validateWorkspacePath(path);
  if (problem) throw new BridgeError(problem, 'EPATH');
  return path;
}

const inside = (root, target) => target === root || target.startsWith(root.endsWith(sep) ? root : root + sep);

async function atomicWrite(target, content, mode) {
  const temp = join(dirname(target), `.${target.split(sep).at(-1)}.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', mode ?? 0o644);
  try { await handle.writeFile(content); await handle.sync().catch(() => {}); } finally { await handle.close(); }
  try { await rename(temp, target); } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

// ------------------------------------------------------------------------------------------------ token

export function tokensEqual(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string' || !expected || !given) return false;
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(given).digest();
  return timingSafeEqual(a, b) && expected.length === given.length;
}

// --token, then DATAPATH_BRIDGE_TOKEN, then <workspace>/.bridge-token (generated 0600 when missing).
// Order: --token, $DATAPATH_BRIDGE_TOKEN, --token-file, the systemd credential
// ($CREDENTIALS_DIRECTORY/bridge-token), then <workspace>/.bridge-token (generated 0600 when missing).
// An explicit --token-file must exist; tokens from a file or credential are never written anywhere.
export async function resolveToken({ token = null, tokenFile = null, workspaceDir }) {
  if (typeof token === 'string' && token) return { token, source: 'argument' };
  if (process.env.DATAPATH_BRIDGE_TOKEN) return { token: process.env.DATAPATH_BRIDGE_TOKEN, source: 'environment' };
  const credential = tokenFile || (process.env.CREDENTIALS_DIRECTORY ? join(process.env.CREDENTIALS_DIRECTORY, CREDENTIAL_NAME) : null);
  if (credential) {
    let saved = null;
    try { saved = (await readFile(credential, 'utf8')).trim(); } catch (error) {
      if (tokenFile || error.code !== 'ENOENT') throw new BridgeError(`Cannot read token file ${credential}: ${error.code || error.message}`, 'ETOKEN');
    }
    if (saved !== null) {
      if (!TOKEN_RE.test(saved)) throw new BridgeError(`Token file ${credential} must contain at least 32 hex characters`, 'ETOKEN');
      return { token: saved, source: tokenFile ? 'token-file' : 'credential' };
    }
  }
  const file = join(workspaceDir, TOKEN_FILE);
  try {
    const saved = (await readFile(file, 'utf8')).trim();
    if (TOKEN_RE.test(saved)) return { token: saved, source: 'file' };
  } catch { /* Generated below. */ }
  const fresh = randomBytes(32).toString('hex');
  await atomicWrite(file, `${fresh}\n`, 0o600);
  return { token: fresh, source: 'generated' };
}

// ------------------------------------------------------------------------------------------------ workspace

// The on-disk workspace: an in-memory mirror with a monotonically increasing revision. Emits `change`
// events ({ type: 'file:changed' | 'file:deleted' | 'meta:changed', rev, ..., originClientId }).
export class Workspace extends EventEmitter {
  constructor(dir, { pollMs = 1000, quiet = true } = {}) {
    super();
    this.dir = resolve(dir);
    this.pollMs = pollMs;
    this.quiet = quiet;
    this.rev = 1;
    this.files = new Map(); // path -> { content, mtimeMs, size }
    this.folders = [];
    this.excluded = [];
    this.metaStamp = null;
    this.timer = null;
    this.scanning = null;
    this.queue = Promise.resolve();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    this.root = await realpath(this.dir);
    await this.loadMeta();
    for (const [path, entry] of await this.readTree()) this.files.set(path, entry);
    return this;
  }

  // Serialize mutations so concurrent writers see a consistent revision order.
  exclusive(fn) {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  startWatching() {
    if (this.timer || !(this.pollMs > 0)) return;
    this.timer = setInterval(() => { this.scan().catch(error => log(this.quiet, 'scan failed:', error.message)); }, this.pollMs);
    this.timer.unref?.();
  }

  stopWatching() { clearInterval(this.timer); this.timer = null; }

  async readTree() {
    const found = new Map();
    const walk = async (abs, rel) => {
      let entries;
      try { entries = await readdir(abs, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (found.size >= MAX_FILES) return;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue; // never follow links out of the workspace
        if (entry.isDirectory()) {
          if (entry.name === '.git' || entry.name === 'node_modules') continue;
          await walk(join(abs, entry.name), path);
        } else if (entry.isFile() && !validateWorkspacePath(path)) {
          try {
            const info = await stat(join(abs, entry.name));
            if (info.size > MAX_FILE_BYTES) continue;
            const known = this.files.get(path);
            if (known && known.mtimeMs === info.mtimeMs && known.size === info.size) { found.set(path, known); continue; }
            found.set(path, { content: await readFile(join(abs, entry.name), 'utf8'), mtimeMs: info.mtimeMs, size: info.size });
          } catch { /* Raced with a delete. */ }
        }
      }
    };
    await walk(this.root, '');
    return found;
  }

  async loadMeta() {
    try {
      const info = await stat(join(this.root, META_FILE));
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (stamp === this.metaStamp) return false;
      this.metaStamp = stamp;
      const meta = JSON.parse(await readFile(join(this.root, META_FILE), 'utf8'));
      const folders = cleanList(meta?.folders), excluded = cleanList(meta?.excluded);
      const changed = JSON.stringify([folders, excluded]) !== JSON.stringify([this.folders, this.excluded]);
      this.folders = folders; this.excluded = excluded;
      return changed;
    } catch { return false; }
  }

  // Poll for external edits (editors, git, the host side of a virtiofs mount) without relying on inotify.
  scan() {
    if (this.scanning) return this.scanning;
    this.scanning = this.exclusive(async () => {
      const next = await this.readTree();
      for (const [path, entry] of next) {
        const known = this.files.get(path);
        if (known === entry) continue;
        this.files.set(path, entry);
        if (known && known.content === entry.content) continue;
        this.rev++;
        this.emit('change', { type: 'file:changed', rev: this.rev, path, content: entry.content, originClientId: 'disk' });
      }
      for (const path of [...this.files.keys()]) {
        if (next.has(path)) continue;
        this.files.delete(path);
        this.rev++;
        this.emit('change', { type: 'file:deleted', rev: this.rev, path, originClientId: 'disk' });
      }
      if (await this.loadMeta()) {
        this.rev++;
        this.emit('change', { type: 'meta:changed', rev: this.rev, folders: [...this.folders], excluded: [...this.excluded], originClientId: 'disk' });
      }
    }).finally(() => { this.scanning = null; });
    return this.scanning;
  }

  async resolveTarget(path, { create = false } = {}) {
    assertPath(path);
    const target = join(this.root, ...path.split('/'));
    const parent = dirname(target);
    if (create) await mkdir(parent, { recursive: true });
    let realParent;
    try { realParent = await realpath(parent); } catch { throw new BridgeError(`No such file: ${path}`, 'ENOENT'); }
    if (!inside(this.root, realParent)) throw new BridgeError('Path escapes the workspace', 'EPATH');
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new BridgeError('Symbolic links are not writable through the bridge', 'EPATH');
      if (info.isDirectory()) throw new BridgeError(`'${path}' is a directory`, 'EPATH');
    } catch (error) { if (error instanceof BridgeError) throw error; }
    return target;
  }

  writeFile(path, content, originClientId = 'mcp') {
    return this.exclusive(async () => {
      if (typeof content !== 'string') throw new BridgeError('File content must be a string', 'EINVAL');
      if (Buffer.byteLength(content) > MAX_FILE_BYTES) throw new BridgeError('File is larger than 8 MB', 'EINVAL');
      const target = await this.resolveTarget(path, { create: true });
      const known = this.files.get(path);
      if (known && known.content === content) return { rev: this.rev, path, bytes: Buffer.byteLength(content), changed: false };
      if (!known && this.files.size >= MAX_FILES) throw new BridgeError('Workspace file limit reached', 'EINVAL');
      await atomicWrite(target, content);
      const info = await stat(target);
      this.files.set(path, { content, mtimeMs: info.mtimeMs, size: info.size });
      this.rev++;
      this.emit('change', { type: 'file:changed', rev: this.rev, path, content, originClientId });
      return { rev: this.rev, path, bytes: info.size, changed: true };
    });
  }

  deleteFile(path, originClientId = 'mcp') {
    return this.exclusive(async () => {
      const target = await this.resolveTarget(path);
      if (!this.files.has(path)) {
        try { if (!(await lstat(target)).isFile()) throw new Error(); } catch { throw new BridgeError(`No such file: ${path}`, 'ENOENT'); }
      }
      await unlink(target).catch(error => { if (error.code !== 'ENOENT') throw error; });
      this.files.delete(path);
      // Prune now-empty parent directories, never the workspace root.
      for (let dir = dirname(target); inside(this.root, dir) && dir !== this.root; dir = dirname(dir)) {
        try { await rmdir(dir); } catch { break; }
      }
      this.rev++;
      this.emit('change', { type: 'file:deleted', rev: this.rev, path, originClientId });
      return { rev: this.rev, path };
    });
  }

  setMeta({ folders, excluded } = {}, originClientId = 'mcp') {
    return this.exclusive(async () => {
      if (folders !== undefined) this.folders = cleanList(folders);
      if (excluded !== undefined) this.excluded = cleanList(excluded);
      const target = join(this.root, META_FILE);
      await atomicWrite(target, `${JSON.stringify({ folders: this.folders, excluded: this.excluded }, null, 2)}\n`);
      const info = await stat(target);
      this.metaStamp = `${info.mtimeMs}:${info.size}`;
      this.rev++;
      this.emit('change', { type: 'meta:changed', rev: this.rev, folders: [...this.folders], excluded: [...this.excluded], originClientId });
      return { rev: this.rev, folders: [...this.folders], excluded: [...this.excluded] };
    });
  }

  readFile(path) {
    assertPath(path);
    const entry = this.files.get(path);
    if (!entry) throw new BridgeError(`No such file: ${path}`, 'ENOENT');
    return { rev: this.rev, path, content: entry.content };
  }

  fileMap() { return Object.fromEntries([...this.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => [path, entry.content])); }

  snapshot() { return { rev: this.rev, files: this.fileMap(), folders: [...this.folders], excluded: [...this.excluded] }; }

  list() {
    const excluded = new Set(this.excluded);
    return {
      rev: this.rev,
      files: [...this.files].sort(([a], [b]) => a.localeCompare(b)).map(([path, entry]) => ({ path, bytes: Buffer.byteLength(entry.content), excluded: excluded.has(path) })),
      folders: [...this.folders],
    };
  }
}

function cleanList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(item => !validateWorkspacePath(item)))].sort();
}

// ------------------------------------------------------------------------------------------------ headless tools

let helpersPromise = null;
const engine = () => (helpersPromise ||= import(pathToFileURL(join(REPO_ROOT, 'tests/correctness/helpers.mjs')).href));
const webModule = name => import(pathToFileURL(join(REPO_ROOT, 'web', name)).href);

function sourceFiles(files, workspace) {
  const map = files && typeof files === 'object' ? files : workspace ? workspace.fileMap() : {};
  const out = {};
  for (const [path, text] of Object.entries(map)) {
    if (typeof text !== 'string') continue;
    const problem = validateWorkspacePath(path);
    if (problem) throw new BridgeError(`Invalid file path '${path}': ${problem}`, 'EPATH');
    out[path] = text;
  }
  return out;
}

function buildSources(files, workspace) {
  const all = sourceFiles(files, workspace);
  const excluded = !files && workspace ? new Set(workspace.excluded) : new Set();
  const included = Object.fromEntries(Object.entries(all).filter(([path]) => !excluded.has(path)));
  if (!Object.keys(included).some(path => /\.(?:v|sv)$/i.test(path))) throw new BridgeError('No Verilog (.v/.sv) source files to process', 'EINVAL');
  return { all, included, excluded };
}

// parseIvlLog only recognizes tagged lines (`error:`/`warning:`); Icarus also prints bare `file:line: syntax error`.
function withLogDiagnostics(result) {
  const diagnostics = [...(result.diagnostics || [])];
  if (!result.ok) {
    const seen = new Set(diagnostics.map(d => `${d.file}:${d.line}`));
    for (const raw of String(result.log || '').split('\n')) {
      const match = /^(?:\/work\/)?([^:\s][^:]*):(\d+):\s*(.+)$/.exec(raw.trim());
      if (!match || seen.has(`${match[1]}:${match[2]}`)) continue;
      seen.add(`${match[1]}:${match[2]}`);
      diagnostics.push({ file: match[1], line: Number(match[2]), severity: 'error', kind: 'other', message: match[3].trim() });
    }
    if (!diagnostics.length && result.log) diagnostics.push({ file: null, line: 0, severity: 'error', kind: 'other', message: String(result.log).split('\n').filter(Boolean).slice(-3).join(' ') });
  }
  return diagnostics;
}

// Testbench-looking modules are dropped from synthesis inputs (elaboration wants RTL only).
const isTestbench = (path, text) => /(?:^|\/)(?:tb_[^/]*|[^/]*_tb)\.s?v$/i.test(path) || /\$(?:dumpfile|finish)\b/.test(text);

export const headlessTools = {
  async verilog_lint({ files, compile = true, topModule } = {}, { workspace } = {}) {
    const { lintRtl } = await webModule('rtl-linter.js');
    const { all, included, excluded } = buildSources(files, workspace);
    const findings = lintRtl(all, { excluded });
    let compileResult = null;
    if (compile) {
      const { compileVvp } = await engine();
      const r = await compileVvp(included, { top: topModule || undefined });
      compileResult = { ok: r.ok, diagnostics: withLogDiagnostics(r) };
    }
    return { findings, count: findings.length, compile: compileResult };
  },

  async verilog_format({ code, tabWidth = 2 } = {}) {
    if (typeof code !== 'string') throw new BridgeError('`code` must be a string', 'EINVAL');
    const { formatVerilog } = await webModule('verilog-format.js');
    const formatted = formatVerilog(code, { tabWidth });
    return { code: formatted, changed: formatted !== code.replace(/\r\n?/g, '\n') };
  },

  async verilog_elaborate({ files, topModule, standard = '2005' } = {}, { workspace } = {}) {
    if (typeof topModule !== 'string' || !topModule) throw new BridgeError('`topModule` is required', 'EINVAL');
    const { included } = buildSources(files, workspace);
    const rtl = Object.fromEntries(Object.entries(included).filter(([path, text]) => !/\.(?:v|sv)$/i.test(path) || !isTestbench(path, text)));
    const { elaborateJson } = await engine();
    const r = await elaborateJson(Object.keys(rtl).some(p => /\.(?:v|sv)$/i.test(p)) ? rtl : included, { top: topModule, standard: String(standard) });
    if (!r.ok) return { ok: false, diagnostics: withLogDiagnostics(r), log: r.log };
    const { analyzeResources, analyzeCriticalPath } = await webModule('rtl-metrics.js');
    const { lintRtl } = await webModule('rtl-linter.js');
    const latches = lintRtl(rtl, { yosysJson: r.yosysJson }).filter(item => item.rule === 'LATCH_INFERRED');
    const resources = analyzeResources(r.yosysJson, topModule);
    const criticalPath = analyzeCriticalPath(r.yosysJson, topModule);
    return { ok: true, topModule, modules: Object.keys(r.yosysJson.modules || {}), resources, criticalPath, latches, diagnostics: r.diagnostics };
  },

  async verilog_simulate({ files, topModule, standard = '2005', maxOutputLines = 500 } = {}, { workspace } = {}) {
    const { included } = buildSources(files, workspace);
    const { compileVvp, runVvp } = await engine();
    const compiled = await compileVvp(included, { top: topModule || undefined, standard: String(standard) });
    if (!compiled.ok) return { ok: false, phase: compiled.phase || 'compile', diagnostics: withLogDiagnostics(compiled), log: compiled.log };
    const ran = await runVvp(compiled.program, included);
    let waveform = null;
    if (ran.vcd) {
      try {
        const { parseVcd } = await webModule('vcd.js');
        const trace = parseVcd(ran.vcd);
        waveform = {
          timescale: trace.timescale,
          endTime: String(trace.endTime),
          signalCount: trace.signals.length,
          signals: trace.signals.slice(0, 200).map(signal => ({
            path: signal.path, width: signal.width, changes: signal.changes.length,
            final: signal.changes.at(-1)?.value ?? null,
          })),
        };
      } catch (error) { waveform = { error: error.message }; }
    }
    const output = ran.output.slice(0, maxOutputLines);
    return {
      ok: ran.code === 0, exitCode: ran.code, output, truncated: ran.output.length > output.length,
      passed: ran.output.some(line => /\bPASS\b/.test(line)) && !ran.output.some(line => /\bFAIL\b/.test(line)),
      diagnostics: compiled.diagnostics, waveform,
    };
  },

  async mips_assemble({ source, filename = 'program.asm', baseAddress = 0 } = {}) {
    if (typeof source !== 'string') throw new BridgeError('`source` must be a string', 'EINVAL');
    const { assembleMips } = await webModule('mips-asm.js');
    const r = assembleMips(source, { filename, baseAddress });
    return {
      ok: r.ok, outputName: r.outputName, mem: r.memText, words: r.words.map(word => (word >>> 0).toString(16).padStart(8, '0')),
      instructions: r.listing, labels: r.labels, errors: r.diagnostics,
    };
  },
};

// Emscripten's Node glue sets process.exitCode when ivl/vvp exit non-zero (e.g. a design with syntax
// errors); a long-running bridge must not inherit that status from a tool call.
export async function runHeadless(name, args = {}, workspace = null) {
  const saved = process.exitCode;
  try { return await headlessTools[name](args, { workspace }); } finally { process.exitCode = saved; }
}

// ------------------------------------------------------------------------------------------------ MCP

const S = (type, description, extra = {}) => ({ type, description, ...extra });
const CLIENT = { clientId: S('string', 'Target browser tab (defaults to the most recent remote-enabled tab)') };
const FILES = { files: S('object', 'Map of workspace-relative path to file text (defaults to the bridge workspace)', { additionalProperties: { type: 'string' } }) };
const obj = (properties = {}, required = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });

export const TOOLS = [
  { name: 'ide_list_files', description: 'List workspace files (size, excluded-from-build flag), folders and connected browser tabs.', inputSchema: obj() },
  { name: 'ide_read_file', description: 'Read a workspace file.', inputSchema: obj({ path: S('string', 'Workspace-relative path') }, ['path']) },
  { name: 'ide_write_file', description: 'Create or overwrite a workspace file atomically and broadcast it to every connected browser tab. `format: true` formats Verilog first.', inputSchema: obj({ path: S('string', 'Workspace-relative path'), content: S('string', 'Full file text'), format: S('boolean', 'Format .v/.sv files with the Verible/verilog-mode formatter') }, ['path', 'content']) },
  { name: 'ide_delete_file', description: 'Delete a workspace file and broadcast the removal.', inputSchema: obj({ path: S('string', 'Workspace-relative path') }, ['path']) },
  { name: 'ide_set_build_files', description: 'Include or exclude files from the build (the IDE excluded list) and optionally replace the folder list.', inputSchema: obj({ include: S('array', 'Paths to include', { items: { type: 'string' } }), exclude: S('array', 'Paths to exclude', { items: { type: 'string' } }), folders: S('array', 'Replacement folder list', { items: { type: 'string' } }) }) },
  { name: 'ide_get_state', description: 'Live IDE state of a connected browser tab (open file, cursor, panel, run status).', inputSchema: obj({ ...CLIENT }), browser: true },
  { name: 'ide_navigate', description: 'Open a file/line, panel, layout mode or sidebar tab in a connected browser tab.', inputSchema: obj({ file: S('string', 'File to open'), line: S('integer', '1-based line'), panel: S('string', 'Output panel (problems, console, waveform, tests, hw-state, board, schematic)'), mode: S('string', 'Layout mode (edit, run, wave, zen)'), sidebarTab: S('string', 'Sidebar tab (files, hierarchy)'), ...CLIENT }), browser: true },
  { name: 'ide_open_showcase', description: 'Load a built-in showcase project (optionally at a tour chapter) in a connected browser tab.', inputSchema: obj({ id: S('string', 'Showcase id (mips-cpu, fpga-board, fsm-control, alu-suite, bug-hunter)'), chapter: S('integer', 'Tour chapter'), ...CLIENT }, ['id']), browser: true },
  { name: 'ide_run', description: 'Compile, run, assemble or stop in a connected browser tab.', inputSchema: obj({ action: S('string', 'compile | run | assemble | stop', { enum: ['compile', 'run', 'assemble', 'stop'] }), topModule: S('string', 'Top module override'), ...CLIENT }), browser: true },
  { name: 'ide_get_problems', description: 'Problems (Icarus diagnostics and RTL lint findings) shown in a connected browser tab.', inputSchema: obj({ ...CLIENT }), browser: true },
  { name: 'ide_apply_quick_fix', description: 'Apply the quick fix for the problem at file:line in a connected browser tab.', inputSchema: obj({ file: S('string', 'File'), line: S('integer', '1-based line'), ...CLIENT }, ['file', 'line']), browser: true },
  { name: 'ide_waveform', description: 'Move the waveform cursor, plot a signal or change the radix in a connected browser tab.', inputSchema: obj({ cursorTime: S('number', 'Cursor time'), plotSignal: S('string', 'Signal path or name'), radix: S('string', 'Radix'), ...CLIENT }), browser: true },
  { name: 'ide_schematic', description: 'Elaborate, inspect a cell, or toggle the critical path / resources overlays in a connected browser tab.', inputSchema: obj({ elaborate: S('boolean', 'Elaborate first'), moduleName: S('string', 'Module'), inspectCell: S('string', 'Cell to inspect'), criticalPath: S('boolean', 'Show critical path'), resources: S('boolean', 'Show resources'), ...CLIENT }), browser: true },
  { name: 'ide_board', description: 'Start/stop the Live DUT board, drive inputs and tick the clock in a connected browser tab.', inputSchema: obj({ liveAction: S('string', 'start | stop | tick'), drive: S('object', 'Port name to value'), ticks: S('integer', 'Clock ticks'), ...CLIENT }), browser: true },
  { name: 'verilog_lint', description: 'Run the 7-rule strict RTL linter (and an Icarus compile) headlessly over `files` or the workspace.', inputSchema: obj({ ...FILES, compile: S('boolean', 'Also compile with Icarus (default true)'), topModule: S('string', 'Top module for the compile') }) },
  { name: 'verilog_format', description: 'Format Verilog with the Verible / Emacs verilog-mode compatible formatter.', inputSchema: obj({ code: S('string', 'Verilog source'), tabWidth: S('integer', 'Indent width (default 2)') }, ['code']) },
  { name: 'verilog_elaborate', description: 'Synthesize a module with Icarus (WASM) and report resources, the critical path and latches.', inputSchema: obj({ ...FILES, topModule: S('string', 'Module to elaborate'), standard: S('string', 'Verilog generation (2005, 2012, ...)') }, ['topModule']) },
  { name: 'verilog_simulate', description: 'Compile and run a testbench with Icarus vvp (WASM); returns console output, diagnostics and a VCD summary.', inputSchema: obj({ ...FILES, topModule: S('string', 'Testbench top module'), standard: S('string', 'Verilog generation (2005, 2012, ...)') }) },
  { name: 'mips_assemble', description: 'Assemble MIPS32 source into $readmemh hex words with a listing.', inputSchema: obj({ source: S('string', 'Assembly source'), filename: S('string', 'Source name (sets the default .mem name)'), baseAddress: S('integer', 'Text base address') }, ['source']) },
];
const TOOL_BY_NAME = new Map(TOOLS.map(tool => [tool.name, tool]));
export const BROWSER_TOOLS = TOOLS.filter(tool => tool.browser).map(tool => tool.name);

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data !== undefined ? { data } : {}) } });
const rpcResult = (id, result) => ({ jsonrpc: '2.0', id, result });
const toolResult = value => ({ content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], structuredContent: value });
const toolError = message => ({ content: [{ type: 'text', text: message }], isError: true });
const resourceUri = path => `datapath://file/${path.split('/').map(encodeURIComponent).join('/')}`;
const mimeFor = path => HDL_RE.test(path) ? 'text/x-verilog' : /\.(?:asm|s)$/i.test(path) ? 'text/x-asm' : 'text/plain';

// JSON-RPC 2.0 / MCP dispatcher shared by POST /mcp and the stdio server.
// `callBrowser(method, params, clientId)` forwards live IDE tools; `getClients()` lists tabs.
export function createMcpHandler({ workspace = null, callBrowser = null, getClients = () => [], wasm = typeof WebAssembly !== 'undefined' } = {}) {
  const tools = TOOLS.filter(tool => wasm || !WASM_TOOLS.includes(tool.name));
  const enabled = new Set(tools.map(tool => tool.name));
  const needWorkspace = () => { if (!workspace) throw new BridgeError('No workspace is attached to this MCP server (start it with --dir or connect to a bridge)'); return workspace; };
  const stripClient = ({ clientId, ...rest }) => rest;

  async function callTool(name, args) {
    switch (name) {
      case 'ide_list_files': return { ...needWorkspace().list(), clients: getClients() };
      case 'ide_read_file': return needWorkspace().readFile(args.path);
      case 'ide_write_file': {
        let content = args.content;
        if (typeof content !== 'string') throw new BridgeError('`content` must be a string', 'EINVAL');
        const format = args.format === true && HDL_RE.test(String(args.path));
        if (format) content = (await headlessTools.verilog_format({ code: content })).code;
        const r = await needWorkspace().writeFile(args.path, content, 'mcp');
        return { rev: r.rev, path: r.path, bytes: r.bytes, formatted: format };
      }
      case 'ide_delete_file': return needWorkspace().deleteFile(args.path, 'mcp');
      case 'ide_set_build_files': {
        const ws = needWorkspace();
        for (const list of [args.include, args.exclude, args.folders]) {
          if (list === undefined) continue;
          if (!Array.isArray(list)) throw new BridgeError('include/exclude/folders must be arrays of paths', 'EINVAL');
          for (const path of list) assertPath(path);
        }
        const excluded = new Set(ws.excluded);
        for (const path of args.exclude || []) excluded.add(path);
        for (const path of args.include || []) excluded.delete(path);
        return ws.setMeta({ excluded: [...excluded], ...(args.folders !== undefined ? { folders: args.folders } : {}) }, 'mcp');
      }
      default:
        if (BROWSER_TOOLS.includes(name)) {
          if (!callBrowser) throw new BridgeError('No remote-enabled browser tab is connected (live IDE tools need the HTTP bridge and a tab with "Allow remote control" on).');
          return callBrowser(name, stripClient(args), args.clientId);
        }
        // Without WebAssembly the linter still runs; only the Icarus compile step is skipped.
        return runHeadless(name, name === 'verilog_lint' && !wasm ? { ...args, compile: false } : args, workspace);
    }
  }

  async function dispatch(method, params, id) {
    switch (method) {
      case 'initialize':
        return { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {}, resources: {} }, serverInfo: SERVER_INFO, instructions: 'Datapath Studio: edit the synced Verilog/MIPS workspace, drive open IDE tabs, and run the headless Icarus Verilog toolchain.' };
      case 'ping': return {};
      case 'tools/list': return { tools: tools.map(({ browser, ...tool }) => tool) };
      case 'tools/call': {
        const name = params?.name;
        if (!TOOL_BY_NAME.has(name) || !enabled.has(name)) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
        const args = params.arguments ?? {};
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw Object.assign(new Error('Tool arguments must be an object'), { rpcCode: -32602 });
        try { return toolResult(await callTool(name, args)); } catch (error) { return toolError(error.message || String(error)); }
      }
      case 'resources/list':
        if (!workspace) return { resources: [] };
        return { resources: workspace.list().files.map(file => ({ uri: resourceUri(file.path), name: file.path, mimeType: mimeFor(file.path), size: file.bytes })) };
      case 'resources/read': {
        const uri = String(params?.uri || '');
        if (!uri.startsWith('datapath://file/')) throw Object.assign(new Error(`Unknown resource: ${uri}`), { rpcCode: -32002 });
        let path;
        try { path = uri.slice('datapath://file/'.length).split('/').map(decodeURIComponent).join('/'); } catch { throw Object.assign(new Error('Malformed resource URI'), { rpcCode: -32602 }); }
        try {
          const { content } = needWorkspace().readFile(path);
          return { contents: [{ uri, mimeType: mimeFor(path), text: content }] };
        } catch (error) { throw Object.assign(new Error(error.message), { rpcCode: -32002 }); }
      }
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
    }
  }

  // Returns a response object, an array (batch), or null when nothing must be sent (notifications).
  async function handle(message) {
    if (Array.isArray(message)) {
      if (!message.length) return rpcError(null, -32600, 'Invalid Request: empty batch');
      const replies = (await Promise.all(message.map(handle))).filter(Boolean);
      return replies.length ? replies : null;
    }
    if (!message || typeof message !== 'object' || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
      return rpcError(message?.id, -32600, 'Invalid Request');
    }
    const isNotification = !Object.hasOwn(message, 'id');
    if (isNotification) {
      // notifications/initialized, notifications/cancelled, ... need no reply.
      if (!message.method.startsWith('notifications/')) { try { await dispatch(message.method, message.params, null); } catch { /* Notifications never answer. */ } }
      return null;
    }
    try { return rpcResult(message.id, await dispatch(message.method, message.params || {}, message.id)); } catch (error) {
      return rpcError(message.id, error.rpcCode || -32603, error.message || 'Internal error');
    }
  }

  return { handle, callTool, tools };
}

// ------------------------------------------------------------------------------------------------ HTTP / WS

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, value, headers = {}) {
  const body = JSON.stringify(value);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function bearer(header) {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(String(header || ''));
  return match ? match[1] : null;
}

function readBody(req, limit) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { rejectBody(Object.assign(new Error('Request body too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', rejectBody);
  });
}

// systemd socket activation (sd_listen_fds): the inherited listening socket is fd 3. Only honoured when
// LISTEN_PID names this process; the variables are then cleared so child processes never inherit them.
export function systemdListenFd(env = process.env, pid = process.pid) {
  if (Number(env.LISTEN_PID) !== pid) return null;
  const count = Number(env.LISTEN_FDS);
  if (!Number.isInteger(count) || count < 1) return null;
  if (count !== 1) throw new BridgeError(`Expected exactly one socket from systemd, got LISTEN_FDS=${env.LISTEN_FDS}`, 'ELISTEN');
  for (const key of ['LISTEN_PID', 'LISTEN_FDS', 'LISTEN_FDNAMES']) delete env[key];
  return 3;
}

export async function startBridgeServer({ port = 18473, host = '127.0.0.1', fd = null, workspaceDir = 'workspace', webDir = DEFAULT_WEB_DIR, token = null, tokenFile = null, wasm = typeof WebAssembly !== 'undefined', pollMs = 1000, quiet = false, rpcTimeoutMs = 30000 } = {}) {
  const workspace = await new Workspace(workspaceDir, { pollMs, quiet }).init();
  const { token: secret, source } = await resolveToken({ token, tokenFile, workspaceDir: workspace.root });
  const webRoot = await realpath(resolve(webDir));
  // connection -> { clientId, label, allowRemote, connectedAt, order (roster position), seq (recency for RPC routing) }
  const clients = new Map();
  const pending = new Map(); // rpc id -> { resolve, reject, timer, conn }
  let seq = 0;

  const clientList = () => [...clients.values()].sort((a, b) => a.order - b.order).map(({ clientId, label, allowRemote, connectedAt }) => ({ clientId, label, allowRemote, connectedAt }));
  const broadcast = message => { const text = JSON.stringify(message); for (const conn of clients.keys()) conn.send(text); };
  const broadcastClients = () => broadcast({ type: 'clients', clients: clientList() });
  workspace.on('change', broadcast);

  function callBrowser(method, params, clientId) {
    const candidates = [...clients].filter(([, info]) => info.allowRemote && (!clientId || info.clientId === clientId));
    if (!candidates.length) {
      const known = clientId && [...clients.values()].some(info => info.clientId === clientId);
      return Promise.reject(new BridgeError(clientId && known
        ? `Browser tab '${clientId}' has remote control disabled.`
        : clientId ? `No connected browser tab with clientId '${clientId}'.`
          : 'No remote-enabled browser tab is connected. Open Datapath Studio, connect it to this bridge and enable "Allow remote control".'));
    }
    // Most recently connected (or re-announced) remote-enabled tab wins.
    const [conn] = candidates.sort(([, a], [, b]) => b.seq - a.seq)[0];
    const id = randomUUID();
    return new Promise((resolveRpc, rejectRpc) => {
      const timer = setTimeout(() => { pending.delete(id); rejectRpc(new BridgeError(`Browser tab did not answer '${method}' within ${Math.round(rpcTimeoutMs / 1000)} s.`)); }, rpcTimeoutMs);
      pending.set(id, { resolve: resolveRpc, reject: rejectRpc, timer, conn });
      if (!conn.sendJson({ type: 'rpc', id, method, params: params || {} })) { clearTimeout(timer); pending.delete(id); rejectRpc(new BridgeError('Browser tab connection is not open.')); }
    });
  }

  const mcp = createMcpHandler({ workspace, callBrowser, getClients: clientList, wasm });

  async function onMessage(conn, text) {
    const info = clients.get(conn);
    let message;
    try { message = JSON.parse(text); } catch { conn.sendJson({ type: 'error', message: 'Messages must be JSON' }); return; }
    if (!message || typeof message !== 'object') return;
    const origin = info.clientId;
    try {
      switch (message.type) {
        case 'hello':
          if (typeof message.label === 'string' && message.label.trim()) info.label = message.label.trim().slice(0, 64);
          if (typeof message.allowRemote === 'boolean') info.allowRemote = message.allowRemote;
          if (typeof message.clientId === 'string' && message.clientId && message.clientId.length <= 128 && message.clientId !== info.clientId
            && ![...clients.values()].some(other => other !== info && other.clientId === message.clientId)) info.clientId = message.clientId;
          info.seq = ++seq;
          broadcastClients();
          break;
        case 'sync':
        case 'sync:request':
          conn.sendJson({ type: 'sync', ...workspace.snapshot(), clients: clientList() });
          break;
        case 'file:put': await workspace.writeFile(message.path, message.content, origin); break;
        case 'file:delete': await workspace.deleteFile(message.path, origin); break;
        case 'meta:put': await workspace.setMeta({ folders: message.folders, excluded: message.excluded }, origin); break;
        case 'rpc:result': {
          const call = pending.get(message.id);
          if (!call || call.conn !== conn) break;
          pending.delete(message.id); clearTimeout(call.timer);
          if (message.ok) call.resolve(message.result ?? null);
          else call.reject(new BridgeError(typeof message.error === 'string' ? message.error : message.error?.message || 'Browser RPC failed'));
          break;
        }
        default: conn.sendJson({ type: 'error', message: `Unknown message type: ${message.type}` });
      }
    } catch (error) {
      conn.sendJson({ type: 'error', message: error.message, path: message.path ?? null, request: message.type });
    }
  }

  async function serveStatic(req, res, pathname) {
    let rel;
    try { rel = decodeURIComponent(pathname); } catch { res.writeHead(400).end(); return; }
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.includes('\0')) { res.writeHead(400).end(); return; }
    const target = resolve(webRoot, `.${rel}`);
    if (!inside(webRoot, target)) { res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Forbidden'); return; }
    try {
      const real = await realpath(target);
      const info = await stat(real);
      if (!inside(webRoot, real) || !info.isFile()) throw new Error('not a file');
      const body = await readFile(real);
      res.writeHead(200, { 'Content-Type': CONTENT_TYPES[extname(real).toLowerCase()] || 'application/octet-stream', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }).end('Not found'); }
  }

  const server = createServer(async (req, res) => {
    let url;
    try { url = new URL(req.url, 'http://bridge.local'); } catch { res.writeHead(400).end(); return; }
    try {
      if (url.pathname === '/healthz') { sendJson(res, 200, { ok: true, rev: workspace.rev, clients: clients.size }); return; }
      if (url.pathname === '/mcp') {
        if (req.method !== 'POST') { sendJson(res, 405, { error: 'Use POST' }, { Allow: 'POST' }); return; }
        if (!tokensEqual(secret, bearer(req.headers.authorization))) { sendJson(res, 401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' }); return; }
        let message;
        try { message = JSON.parse(await readBody(req, MAX_BODY_BYTES)); } catch (error) {
          if (error.status === 413) { sendJson(res, 413, rpcError(null, -32600, error.message)); return; }
          sendJson(res, 400, rpcError(null, -32700, 'Parse error')); return;
        }
        const reply = await mcp.handle(message);
        if (reply === null) { res.writeHead(202, { 'Cache-Control': 'no-store' }).end(); return; }
        sendJson(res, 200, reply);
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
      await serveStatic(req, res, url.pathname);
    } catch (error) {
      log(quiet, 'request failed:', error.message);
      if (!res.headersSent) sendJson(res, 500, { error: 'Internal error' }); else res.destroy();
    }
  });

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => socket.destroy());
    let url;
    try { url = new URL(req.url, 'http://bridge.local'); } catch { rejectUpgrade(socket, 400, 'Bad Request'); return; }
    if (url.pathname !== '/ws' && !url.pathname.endsWith('/ws')) { rejectUpgrade(socket, 404, 'Not Found'); return; }
    const given = url.searchParams.get('token') || bearer(req.headers.authorization);
    if (!tokensEqual(secret, given)) { rejectUpgrade(socket, 401, 'Unauthorized'); return; }
    const conn = acceptWebSocket(req, socket, head);
    if (!conn) return;
    const requested = url.searchParams.get('clientId');
    const clientId = requested && requested.length <= 128 ? requested : randomUUID();
    // A reconnecting tab (same clientId) replaces its stale connection.
    for (const [other, info] of clients) if (info.clientId === clientId) { clients.delete(other); other.close(4000, 'Replaced by a newer connection'); }
    const label = (url.searchParams.get('label') || 'browser').trim().slice(0, 64) || 'browser';
    clients.set(conn, { clientId, label, allowRemote: false, connectedAt: new Date().toISOString(), order: ++seq, seq });
    conn.on('message', (data, binary) => { if (!binary) onMessage(conn, data); });
    conn.on('error', () => {});
    conn.on('close', () => {
      if (!clients.delete(conn)) return;
      for (const [id, call] of pending) if (call.conn === conn) { pending.delete(id); clearTimeout(call.timer); call.reject(new BridgeError('Browser tab disconnected before answering.')); }
      broadcastClients();
    });
    conn.sendJson({ type: 'sync', ...workspace.snapshot(), clients: clientList() });
    broadcastClients();
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    const ready = () => { server.off('error', rejectListen); resolveListen(); };
    if (fd !== null) server.listen({ fd }, ready); else server.listen(port, host, ready);
  });
  workspace.startWatching();
  const address = server.address();
  if (fd !== null) host = address.address;
  const shownHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
  const url = `http://${shownHost}:${address.port}`;
  const wsUrl = `ws://${shownHost}:${address.port}/ws`;
  log(quiet, `serving ${webRoot} and workspace ${workspace.root} on ${url}${fd !== null ? ` (socket fd ${fd})` : ''} (token from ${source}${wasm ? '' : ', WebAssembly tools off'})`);
  // Secrets from a token file or systemd credential stay out of logs (the journal is readable by adm).
  if (!quiet && source !== 'token-file' && source !== 'credential') {
    console.error(`[bridge] token: ${secret}`);
    console.error(`[bridge] pair a browser: ${url}/?bridgeToken=${secret}`);
    console.error(`[bridge] MCP endpoint: POST ${url}/mcp (Authorization: Bearer <token>)`);
  }

  let closing = null;
  function close() {
    if (closing) return closing;
    workspace.stopWatching();
    for (const [id, call] of pending) { pending.delete(id); clearTimeout(call.timer); call.reject(new BridgeError('Bridge is shutting down.')); }
    for (const conn of clients.keys()) conn.close(1001, 'Bridge shutting down');
    closing = new Promise(resolveClose => {
      server.close(() => resolveClose());
      setTimeout(() => { for (const conn of clients.keys()) conn.terminate(); server.closeAllConnections?.(); }, 200).unref?.();
    }).then(() => workspace.scanning);
    return closing;
  }

  return { port: address.port, host, url, wsUrl, token: secret, workspace, mcp, clients: clientList, callBrowser, close };
}

// ------------------------------------------------------------------------------------------------ CLI

export function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => inline ?? argv[++i];
    switch (flag) {
      case '--port': options.port = Number(value()); break;
      case '--host': options.host = value(); break;
      case '--dir': options.workspaceDir = value(); break;
      case '--web': options.webDir = value(); break;
      case '--token': options.token = value(); break;
      case '--token-file': options.tokenFile = value(); break;
      case '--listen-fd': options.fd = Number(value()); break;
      case '--no-wasm': options.wasm = false; break;
      case '--poll': case '--poll-ms': options.pollMs = Number(value()); break;
      case '--quiet': options.quiet = true; break;
      case '--help': case '-h': options.help = true; break;
      default: throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

const USAGE = `Usage: node server/bridge.mjs [--port 18473] [--host 127.0.0.1 | --listen-fd 3] [--dir workspace] [--web web]
       [--token TOKEN | --token-file FILE] [--no-wasm] [--poll-ms 1000] [--quiet]
Under systemd socket activation (LISTEN_FDS/LISTEN_PID) the inherited socket is used automatically,
and the token is read from the credential 'bridge-token' when $CREDENTIALS_DIRECTORY provides it.`;

// Run as a program only when this file is the entry point. Compare real paths: Node resolves symlinks
// for import.meta.url, so /opt/datapath-studio/current/... (a symlink to a release) would never match.
const entryUrl = (() => { try { return pathToFileURL(realpathSync(process.argv[1])).href; } catch { return null; } })();
if (process.argv[1] && import.meta.url === entryUrl) {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); console.error(USAGE); process.exit(2); }
  if (options.help) { console.log(USAGE); process.exit(0); }
  try { options.fd ??= systemdListenFd(); } catch (error) { console.error(`[bridge] ${error.message}`); process.exit(1); }
  if (options.fd !== null && !(Number.isInteger(options.fd) && options.fd >= 0)) { console.error('[bridge] --listen-fd needs a file descriptor number'); process.exit(2); }
  startBridgeServer(options).then(bridge => {
    const stop = signal => { log(options.quiet, `${signal}: shutting down`); bridge.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 2000).unref(); };
    process.once('SIGINT', () => stop('SIGINT'));
    process.once('SIGTERM', () => stop('SIGTERM'));
  }).catch(error => { console.error(`[bridge] ${error.message}`); process.exit(1); });
}
