// Offline tests for the self-hosted bridge (server/), its RFC 6455 layer and the MCP servers (HTTP + stdio).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameParser, ProtocolError, acceptKey, connectWebSocket, encodeFrame, OPCODES } from '../../server/ws.mjs';
import { startBridgeServer, validateWorkspacePath, tokensEqual, TOOLS } from '../../server/bridge.mjs';
import { showcaseProject } from '../../web/showcase-projects.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
let checks = 0;
async function check(name, fn) {
  try { await fn(); checks++; } catch (error) { console.error(`FAIL: ${name}`); throw error; }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Fixed test ports from 18500 up. Never `port: 0`: inside mvm (libkrun TSI) kernel-ephemeral ports
// (32768-60999) refuse loopback connections, while fixed ports below 32768 work natively.
let nextTestPort = Number(process.env.MCP_TEST_PORT_BASE) || 18500;
async function onTestPort(start, attempts = 50) {
  for (let i = 0; i < attempts; i++) {
    const port = nextTestPort++;
    try { return await start(port); } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  }
  throw new Error('No free test port in range');
}
// For child processes: probe a port with a throwaway listener, then hand the number over.
async function freeTestPort() {
  const { createServer } = await import('node:net');
  return onTestPort(port => new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(port)));
  }));
}
const temps = [];
async function tempDir(prefix = 'dp-bridge-') { const dir = await mkdtemp(join(tmpdir(), prefix)); temps.push(dir); return dir; }

// Raw HTTP so paths are sent exactly as written (fetch would normalize `%2e%2e`).
function http(url, { method = 'GET', path, headers = {}, body } = {}) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: target.hostname, port: target.port, method, path: path ?? `${target.pathname}${target.search}`, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const text = buffer.toString('utf8');
        let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json, bytes: buffer.length });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

// WebSocket client with a message inbox: `await client.next(m => m.type === 'sync')`.
async function wsClient(url, options) {
  const conn = await connectWebSocket(url, options);
  const inbox = [], waiters = [];
  conn.on('message', (data, binary) => {
    const message = binary ? data : JSON.parse(data);
    inbox.push(message);
    for (const w of [...waiters]) if (w.match(message)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(message); inbox.splice(inbox.indexOf(message), 1); }
  });
  const closed = new Promise(resolve => conn.on('close', (code, reason) => resolve({ code, reason })));
  return {
    conn, inbox, closed,
    send: value => conn.sendJson(value),
    next(match = () => true, timeoutMs = 3000) {
      const found = inbox.find(match);
      if (found) { inbox.splice(inbox.indexOf(found), 1); return Promise.resolve(found); }
      return new Promise((resolve, reject) => {
        const waiter = { match, resolve, timer: setTimeout(() => { waiters.splice(waiters.indexOf(waiter), 1); reject(new Error(`timed out waiting for message; inbox: ${JSON.stringify(inbox).slice(0, 400)}`)); }, timeoutMs) };
        waiters.push(waiter);
      });
    },
    close: () => { conn.close(); return closed; },
  };
}

// Raw TCP WebSocket for protocol-violation tests: returns { socket, frames(), closeFrame() }.
async function rawWs(bridge) {
  const socket = netConnect({ host: '127.0.0.1', port: bridge.port });
  await new Promise((r, j) => { socket.once('connect', r); socket.once('error', j); });
  const key = Buffer.from('0123456789abcdef').toString('base64');
  socket.write(`GET /ws?token=${bridge.token}&clientId=raw HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  let buffer = Buffer.alloc(0), handshake = null;
  const parser = new FrameParser({ requireMask: false, forbidMask: true });
  const frames = [];
  let ended = false;
  socket.on('data', chunk => {
    if (!handshake) {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      handshake = buffer.subarray(0, end).toString();
      chunk = buffer.subarray(end + 4);
    }
    if (chunk.length) frames.push(...parser.push(chunk));
  });
  socket.on('close', () => { ended = true; });
  const waitFor = async (predicate, ms = 3000) => { const t = Date.now(); while (!predicate()) { if (Date.now() - t > ms) throw new Error('raw ws timeout'); await sleep(10); } };
  await waitFor(() => handshake);
  assert.match(handshake, /^HTTP\/1\.1 101/);
  assert.ok(handshake.includes(`Sec-WebSocket-Accept: ${acceptKey(key)}`));
  return {
    socket, frames, waitFor,
    ended: () => ended,
    async closeFrame() { await waitFor(() => frames.some(f => f.opcode === OPCODES.close)); const f = frames.find(x => x.opcode === OPCODES.close); return f.payload.readUInt16BE(0); },
  };
}

async function mcp(bridge, method, params, { token = bridge.token, id = 1 } = {}) {
  const r = await http(`${bridge.url}/mcp`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: { jsonrpc: '2.0', id, method, ...(params ? { params } : {}) } });
  return r;
}
async function tool(bridge, name, args = {}) {
  const r = await mcp(bridge, 'tools/call', { name, arguments: args });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.jsonrpc, '2.0');
  const result = r.json.result;
  return { ...result, value: result.isError ? null : JSON.parse(result.content[0].text) };
}

// ---------------------------------------------------------------------------------------------- ws.mjs

await check('RFC 6455 frame encoding/parsing: small, 16-bit and 64-bit lengths, masked, byte-by-byte', () => {
  for (const size of [0, 5, 125, 126, 300, 65535, 70000]) {
    const payload = Buffer.alloc(size, 0x61 + (size % 26));
    const frame = encodeFrame(OPCODES.text, payload, { mask: true });
    assert.equal(frame[1] & 0x7f, size < 126 ? size : size <= 0xffff ? 126 : 127);
    const parser = new FrameParser();
    const out = [];
    for (let i = 0; i < frame.length; i += Math.max(1, Math.floor(frame.length / 7))) out.push(...parser.push(frame.subarray(i, i + Math.max(1, Math.floor(frame.length / 7)))));
    assert.equal(out.length, 1);
    assert.equal(out[0].opcode, OPCODES.text);
    assert.ok(out[0].payload.equals(payload));
  }
  const two = Buffer.concat([encodeFrame(OPCODES.ping, Buffer.from('a'), { mask: true }), encodeFrame(OPCODES.binary, Buffer.from([1, 2]), { mask: true })]);
  assert.deepEqual(new FrameParser().push(two).map(f => f.opcode), [OPCODES.ping, OPCODES.binary]);
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo='); // RFC 6455 §1.3 example
});

await check('frame parser rejects malformed frames with the right close codes', () => {
  const code = buf => { try { new FrameParser().push(buf); return null; } catch (e) { assert.ok(e instanceof ProtocolError); return e.code; } };
  assert.equal(code(encodeFrame(OPCODES.text, Buffer.from('x'))), 1002, 'unmasked client frame');
  assert.equal(code(encodeFrame(OPCODES.text, Buffer.from('x'), { mask: true, rsv: 4 })), 1002, 'reserved bits');
  assert.equal(code(Buffer.from([0x83, 0x80, 0, 0, 0, 0])), 1002, 'unknown opcode');
  assert.equal(code(encodeFrame(OPCODES.ping, Buffer.alloc(126), { mask: true })), 1002, 'oversized control frame');
  assert.equal(code(encodeFrame(OPCODES.ping, Buffer.alloc(1), { mask: true, fin: false })), 1002, 'fragmented control frame');
  const huge = Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0x90, 0, 0]); // 9 MiB announced
  assert.equal(code(huge), 1009, '> 8 MB payload');
  const msb = Buffer.from([0x81, 0xff, 0x80, 0, 0, 0, 0, 0, 0, 1]);
  assert.equal(code(msb), 1002, '64-bit length with MSB set');
  assert.equal(new FrameParser().push(huge.subarray(0, 5)).length, 0, 'incomplete header waits for more data');
});

// ---------------------------------------------------------------------------------------------- bridge

const workspaceDir = await tempDir();
await writeFile(join(workspaceDir, 'existing.v'), 'module existing;\nendmodule\n');
const bridge = await onTestPort(port => startBridgeServer({ port, host: '127.0.0.1', workspaceDir, pollMs: 40, quiet: true }));

await check('token: generated 0600 file, timing-safe comparison, never part of the workspace', async () => {
  assert.match(bridge.token, /^[0-9a-f]{64}$/);
  const info = await stat(join(workspaceDir, '.bridge-token'));
  assert.equal(info.mode & 0o777, 0o600);
  assert.equal((await readFile(join(workspaceDir, '.bridge-token'), 'utf8')).trim(), bridge.token);
  assert.ok(tokensEqual(bridge.token, bridge.token));
  assert.ok(!tokensEqual(bridge.token, bridge.token.slice(0, -1)));
  assert.ok(!tokensEqual(bridge.token, ''));
  assert.deepEqual(Object.keys(bridge.workspace.fileMap()), ['existing.v'], 'pre-existing user files are kept, internal files hidden');
  const again = await onTestPort(port => startBridgeServer({ port, host: '127.0.0.1', workspaceDir, pollMs: 0, quiet: true }));
  assert.equal(again.token, bridge.token, 'token file is reused');
  await again.close();
});

await check('HTTP: /healthz public and data-free, static web/ with MIME types, traversal blocked', async () => {
  const health = await http(`${bridge.url}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(Object.keys(health.json).sort(), ['clients', 'ok', 'rev']);
  assert.equal(health.json.ok, true);
  assert.ok(!health.text.includes(bridge.token) && !health.text.includes('existing'));
  const index = await http(`${bridge.url}/`);
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.equal(index.headers['cache-control'], 'no-store');
  assert.match(index.text, /<html/i);
  for (const [path, type] of [['/app.js', /^text\/javascript/], ['/engine/ivl.wasm', /^application\/wasm$/], ['/manifest.webmanifest', /^application\/manifest\+json$/], ['/favicon.svg', /^image\/svg\+xml$/]]) {
    const r = await http(bridge.url, { method: 'HEAD', path });
    assert.equal(r.status, 200, path);
    assert.match(r.headers['content-type'], type, path);
  }
  for (const path of ['/%2e%2e/package.json', '/..%2fpackage.json', '/engine/%2e%2e/%2e%2e/Makefile']) {
    const r = await http(bridge.url, { path });
    assert.ok(r.status === 403 || r.status === 404, `${path} -> ${r.status}`);
    assert.ok(!r.text.includes('datapath-ide'), path);
  }
  assert.equal((await http(`${bridge.url}/nope.js`)).status, 404);
  assert.equal((await http(`${bridge.url}/app.js`, { method: 'POST' })).status, 405);
});

await check('auth: /mcp and /ws answer 401 without a valid bearer token', async () => {
  assert.equal((await mcp(bridge, 'ping', null, { token: null })).status, 401);
  assert.equal((await mcp(bridge, 'ping', null, { token: 'f'.repeat(64) })).status, 401);
  assert.equal((await http(`${bridge.url}/mcp`, { method: 'POST', headers: { Authorization: `Basic ${bridge.token}` }, body: {} })).status, 401);
  assert.equal((await http(`${bridge.url}/mcp`)).status, 405);
  for (const url of [`${bridge.wsUrl}`, `${bridge.wsUrl}?token=nope`, `${bridge.wsUrl}?token=${bridge.token}x`]) {
    await assert.rejects(connectWebSocket(url), error => error.status === 401, url);
  }
  await assert.rejects(connectWebSocket(`${bridge.url.replace('http', 'ws')}/other?token=${bridge.token}`), error => error.status === 404);
  const viaHeader = await wsClient(`${bridge.wsUrl}?clientId=hdr`, { headers: { Authorization: `Bearer ${bridge.token}` } });
  assert.equal((await viaHeader.next(m => m.type === 'sync')).type, 'sync');
  await viaHeader.close();
});

await check('WebSocket transport: medium/fragmented messages, ping/pong, oversized and malformed frames', async () => {
  const raw = await rawWs(bridge);
  await raw.waitFor(() => raw.frames.some(f => f.opcode === OPCODES.text && JSON.parse(f.payload).type === 'sync'));
  // Fragmented sync request (text + continuation + interleaved ping) is reassembled.
  const message = Buffer.from(JSON.stringify({ type: 'sync:request', pad: 'x'.repeat(400) }));
  raw.socket.write(encodeFrame(OPCODES.text, message.subarray(0, 150), { mask: true, fin: false }));
  raw.socket.write(encodeFrame(OPCODES.ping, Buffer.from('hi'), { mask: true }));
  raw.socket.write(encodeFrame(OPCODES.continuation, message.subarray(150), { mask: true, fin: true }));
  await raw.waitFor(() => raw.frames.some(f => f.opcode === OPCODES.pong));
  assert.equal(raw.frames.find(f => f.opcode === OPCODES.pong).payload.toString(), 'hi');
  await raw.waitFor(() => raw.frames.filter(f => f.opcode === OPCODES.text && JSON.parse(f.payload).type === 'sync').length === 2);
  // Oversized announced payload closes with 1009.
  raw.socket.write(Buffer.from([0x81, 0xff, 0, 0, 0, 0, 0, 0x90, 0, 0, 1, 2, 3, 4]));
  assert.equal(await raw.closeFrame(), 1009);
  await raw.waitFor(() => raw.ended());

  const bad = await rawWs(bridge);
  bad.socket.write(encodeFrame(OPCODES.text, Buffer.from('{}'))); // unmasked
  assert.equal(await bad.closeFrame(), 1002);
  const stray = await rawWs(bridge);
  stray.socket.write(encodeFrame(OPCODES.continuation, Buffer.from('x'), { mask: true }));
  assert.equal(await stray.closeFrame(), 1002);
  const utf = await rawWs(bridge);
  utf.socket.write(encodeFrame(OPCODES.text, Buffer.from([0xff, 0xfe]), { mask: true }));
  assert.equal(await utf.closeFrame(), 1007);

  // A medium (> 125 byte, 16-bit length) and a large (64-bit length) message through the real stack.
  const client = await wsClient(`${bridge.wsUrl}?token=${bridge.token}&clientId=medium`);
  await client.next(m => m.type === 'sync');
  const big = `// ${'x'.repeat(70000)}\nmodule big;\nendmodule\n`;
  client.send({ type: 'file:put', path: 'big.v', content: big });
  const changed = await client.next(m => m.type === 'file:changed' && m.path === 'big.v');
  assert.equal(changed.content, big);
  client.send({ type: 'file:delete', path: 'big.v' });
  await client.next(m => m.type === 'file:deleted' && m.path === 'big.v');
  const pong = new Promise(resolve => client.conn.once('pong', resolve));
  client.conn.ping(Buffer.from('p'));
  assert.equal((await pong).toString(), 'p');
  const closed = await client.close();
  assert.equal(closed.code, 1000);
});

await check('path validation rejects traversal, absolute, .git, reserved and control-character paths', async () => {
  for (const bad of ['', '/etc/passwd', '../x.v', 'a/../../x.v', 'a/./b.v', 'a//b.v', 'a\\b.v', '.git/config', 'src/.git/HEAD', '.bridge-token', '.datapath-project.json', 'x\u0000.v', 'x\n.v', '.x.v.0123456789ab.tmp', 'x'.repeat(600)]) {
    assert.ok(validateWorkspacePath(bad), `accepted ${JSON.stringify(bad)}`);
  }
  for (const good of ['a.v', 'rtl/cpu/alu.sv', '.gitignore', 'program.mem', 'a b.v']) assert.equal(validateWorkspacePath(good), null, good);
  const client = await wsClient(`${bridge.wsUrl}?token=${bridge.token}&clientId=evil`);
  await client.next(m => m.type === 'sync');
  for (const path of ['../escape.v', '.git/config', '.bridge-token', '/abs.v']) {
    client.send({ type: 'file:put', path, content: 'pwned' });
    const error = await client.next(m => m.type === 'error');
    assert.equal(error.request, 'file:put');
  }
  assert.equal((await readFile(join(workspaceDir, '.bridge-token'), 'utf8')).trim(), bridge.token);
  await assert.rejects(stat(join(workspaceDir, '..', 'escape.v')));
  await assert.rejects(stat(join(workspaceDir, '.git')));
  // Symlinks never escape the workspace.
  const outside = await tempDir('dp-outside-');
  await writeFile(join(outside, 'secret.v'), 'secret');
  await symlink(outside, join(workspaceDir, 'linkdir'));
  await symlink(join(outside, 'secret.v'), join(workspaceDir, 'linkfile.v'));
  client.send({ type: 'file:put', path: 'linkdir/evil.v', content: 'pwned' });
  assert.match((await client.next(m => m.type === 'error')).message, /escapes/);
  client.send({ type: 'file:put', path: 'linkfile.v', content: 'pwned' });
  assert.match((await client.next(m => m.type === 'error')).message, /Symbolic links/);
  await bridge.workspace.scan();
  assert.equal(await readFile(join(outside, 'secret.v'), 'utf8'), 'secret');
  assert.ok(!Object.keys(bridge.workspace.fileMap()).some(p => p.startsWith('link')), 'symlinks are not mirrored');
  const viaMcp = await tool(bridge, 'ide_write_file', { path: '../../tmp/x.v', content: 'x' });
  assert.equal(viaMcp.isError, true);
  assert.equal((await tool(bridge, 'ide_read_file', { path: '.bridge-token' })).isError, true);
  await unlink(join(workspaceDir, 'linkdir')); await unlink(join(workspaceDir, 'linkfile.v'));
  await client.close();
});

let laptop, phone;
await check('two clients: edits broadcast, persist atomically, and carry origin + rev', async () => {
  laptop = await wsClient(`${bridge.wsUrl}?token=${bridge.token}&clientId=laptop-1&label=laptop`);
  const sync = await laptop.next(m => m.type === 'sync');
  assert.deepEqual(Object.keys(sync).sort(), ['clients', 'excluded', 'files', 'folders', 'rev', 'type']);
  assert.deepEqual(Object.keys(sync.files), ['existing.v']);
  phone = await wsClient(`${bridge.wsUrl}?token=${bridge.token}&clientId=phone-1&label=phone`);
  await phone.next(m => m.type === 'sync');
  const roster = await laptop.next(m => m.type === 'clients' && m.clients.length === 2);
  assert.deepEqual(roster.clients.map(c => [c.clientId, c.label, c.allowRemote]), [['laptop-1', 'laptop', false], ['phone-1', 'phone', false]]);
  assert.ok(roster.clients.every(c => !Number.isNaN(Date.parse(c.connectedAt))));
  laptop.send({ type: 'hello', clientId: 'laptop-1', label: 'Laptop', allowRemote: false });
  await phone.next(m => m.type === 'clients' && m.clients.some(c => c.label === 'Laptop'));

  const before = bridge.workspace.rev;
  const content = 'module alu(input a, output y);\n  assign y = a;\nendmodule\n';
  laptop.send({ type: 'file:put', path: 'rtl/alu.v', content });
  const seen = await phone.next(m => m.type === 'file:changed' && m.path === 'rtl/alu.v');
  assert.deepEqual(seen, { type: 'file:changed', rev: before + 1, path: 'rtl/alu.v', content, originClientId: 'laptop-1' });
  assert.equal((await laptop.next(m => m.type === 'file:changed' && m.path === 'rtl/alu.v')).originClientId, 'laptop-1');
  assert.equal(await readFile(join(workspaceDir, 'rtl/alu.v'), 'utf8'), content);
  assert.deepEqual((await readdir(join(workspaceDir, 'rtl'))).sort(), ['alu.v'], 'no temp files left behind');
  // An identical re-put is a no-op (no rev bump, no echo).
  laptop.send({ type: 'file:put', path: 'rtl/alu.v', content });
  await sleep(120);
  assert.equal(bridge.workspace.rev, before + 1);
  assert.ok(!phone.inbox.some(m => m.type === 'file:changed'));

  phone.send({ type: 'meta:put', folders: ['rtl', 'tb'], excluded: ['rtl/alu.v', '../bad'] });
  const meta = await laptop.next(m => m.type === 'meta:changed');
  assert.deepEqual([meta.folders, meta.excluded, meta.originClientId], [['rtl', 'tb'], ['rtl/alu.v'], 'phone-1']);
  assert.deepEqual(JSON.parse(await readFile(join(workspaceDir, '.datapath-project.json'), 'utf8')), { folders: ['rtl', 'tb'], excluded: ['rtl/alu.v'] });

  phone.send({ type: 'file:delete', path: 'rtl/alu.v' });
  const gone = await laptop.next(m => m.type === 'file:deleted');
  assert.deepEqual([gone.path, gone.originClientId], ['rtl/alu.v', 'phone-1']);
  await assert.rejects(stat(join(workspaceDir, 'rtl')), 'empty directories are pruned');
  phone.send({ type: 'file:delete', path: 'rtl/alu.v' });
  assert.match((await phone.next(m => m.type === 'error')).message, /No such file/);

  phone.send({ type: 'sync' });
  const resync = await phone.next(m => m.type === 'sync');
  assert.ok(!('.datapath-project.json' in resync.files) && !('.bridge-token' in resync.files));
  assert.deepEqual(resync.excluded, ['rtl/alu.v']);
});

await check('external disk edits are pushed within the poll interval (no inotify needed)', async () => {
  await writeFile(join(workspaceDir, 'from-vim.v'), 'module vim;\nendmodule\n');
  const added = await phone.next(m => m.type === 'file:changed' && m.path === 'from-vim.v', 2000);
  assert.equal(added.originClientId, 'disk');
  assert.equal(added.content, 'module vim;\nendmodule\n');
  await laptop.next(m => m.type === 'file:changed' && m.path === 'from-vim.v');
  await mkdir(join(workspaceDir, 'sub'), { recursive: true });
  await writeFile(join(workspaceDir, 'sub/x.mem'), '00000000\n');
  await laptop.next(m => m.type === 'file:changed' && m.path === 'sub/x.mem');
  await unlink(join(workspaceDir, 'from-vim.v'));
  const removed = await phone.next(m => m.type === 'file:deleted' && m.path === 'from-vim.v', 2000);
  assert.equal(removed.originClientId, 'disk');
  await mkdir(join(workspaceDir, '.git'), { recursive: true });
  await writeFile(join(workspaceDir, '.git/HEAD'), 'ref: x');
  await sleep(150);
  assert.ok(!phone.inbox.some(m => m.path?.startsWith('.git')));
  const health = await http(`${bridge.url}/healthz`);
  assert.equal(health.json.clients, 2);
  assert.equal(health.json.rev, bridge.workspace.rev);
});

await check('MCP over HTTP: initialize, notifications, ping, tools/list, batches and errors', async () => {
  const init = await mcp(bridge, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(init.status, 200);
  assert.deepEqual(init.json.result.serverInfo, { name: 'datapath-studio-mcp', version: '0.2.0' });
  assert.equal(init.json.result.protocolVersion, '2024-11-05');
  assert.deepEqual(init.json.result.capabilities, { tools: {}, resources: {} });
  const note = await http(`${bridge.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` }, body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
  assert.equal(note.status, 202);
  assert.deepEqual((await mcp(bridge, 'ping')).json, { jsonrpc: '2.0', id: 1, result: {} });
  const list = (await mcp(bridge, 'tools/list')).json.result.tools;
  assert.deepEqual(list.map(t => t.name), ['ide_list_files', 'ide_read_file', 'ide_write_file', 'ide_delete_file', 'ide_set_build_files', 'ide_get_state', 'ide_navigate', 'ide_open_showcase', 'ide_run', 'ide_get_problems', 'ide_apply_quick_fix', 'ide_waveform', 'ide_schematic', 'ide_board', 'verilog_lint', 'verilog_format', 'verilog_elaborate', 'verilog_simulate', 'mips_assemble']);
  for (const t of list) { assert.equal(t.inputSchema.type, 'object'); assert.ok(t.description.length > 10); assert.ok(!('browser' in t)); }
  assert.equal(list.length, TOOLS.length);
  assert.equal((await mcp(bridge, 'nope/method')).json.error.code, -32601);
  assert.equal((await mcp(bridge, 'tools/call', { name: 'no_such_tool', arguments: {} })).json.error.code, -32602);
  const parse = await http(`${bridge.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` }, body: '{not json' });
  assert.equal(parse.status, 400);
  assert.equal(parse.json.error.code, -32700);
  const invalid = await http(`${bridge.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` }, body: { id: 3, method: 'ping' } });
  assert.equal(invalid.json.error.code, -32600);
  const batch = await http(`${bridge.url}/mcp`, { method: 'POST', headers: { Authorization: `Bearer ${bridge.token}` }, body: [{ jsonrpc: '2.0', id: 'a', method: 'ping' }, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 'b', method: 'tools/list' }] });
  assert.deepEqual(batch.json.map(r => r.id), ['a', 'b']);
});

await check('MCP workspace tools: write (formatted) / read / list / set build files / resources / delete broadcast to tabs', async () => {
  const messy = 'module m(input clk, output reg q);\nalways @(posedge clk)\nq <= ~q;\nendmodule\n';
  const write = await tool(bridge, 'ide_write_file', { path: 'rtl/m.v', content: messy, format: true });
  assert.equal(write.isError, undefined);
  const expected = 'module m(input clk, output reg q);\n  always @(posedge clk)\n    q <= ~q;\nendmodule\n';
  assert.deepEqual(write.value, { rev: bridge.workspace.rev, path: 'rtl/m.v', bytes: Buffer.byteLength(expected), formatted: true });
  assert.equal(await readFile(join(workspaceDir, 'rtl/m.v'), 'utf8'), expected);
  const pushed = await laptop.next(m => m.type === 'file:changed' && m.path === 'rtl/m.v');
  assert.equal(pushed.originClientId, 'mcp');
  assert.equal(pushed.content, expected);
  await phone.next(m => m.type === 'file:changed' && m.path === 'rtl/m.v');
  assert.deepEqual((await tool(bridge, 'ide_read_file', { path: 'rtl/m.v' })).value, { rev: bridge.workspace.rev, path: 'rtl/m.v', content: expected });
  const raw = await tool(bridge, 'ide_write_file', { path: 'notes.txt', content: 'x  \n', format: true });
  assert.equal(raw.value.formatted, false, 'only HDL files are formatted');
  const listing = (await tool(bridge, 'ide_list_files')).value;
  assert.deepEqual(listing.files.map(f => f.path), ['existing.v', 'notes.txt', 'rtl/m.v', 'sub/x.mem']);
  assert.ok(listing.files.every(f => typeof f.bytes === 'number' && typeof f.excluded === 'boolean'));
  assert.deepEqual(listing.clients.map(c => c.clientId), ['laptop-1', 'phone-1']);
  const build = (await tool(bridge, 'ide_set_build_files', { exclude: ['existing.v'], include: ['rtl/alu.v'], folders: ['rtl'] })).value;
  assert.deepEqual([build.excluded, build.folders], [['existing.v'], ['rtl']]);
  const meta = await phone.next(m => m.type === 'meta:changed' && m.originClientId === 'mcp');
  assert.deepEqual([meta.excluded, meta.originClientId], [['existing.v'], 'mcp']);
  assert.equal((await tool(bridge, 'ide_list_files')).value.files.find(f => f.path === 'existing.v').excluded, true);
  assert.equal((await tool(bridge, 'ide_set_build_files', { exclude: ['../x'] })).isError, true);
  const resources = (await mcp(bridge, 'resources/list')).json.result.resources;
  assert.ok(resources.some(r => r.uri === 'datapath://file/rtl/m.v' && r.mimeType === 'text/x-verilog'));
  assert.ok(!resources.some(r => /bridge-token|datapath-project/.test(r.uri)));
  const read = (await mcp(bridge, 'resources/read', { uri: 'datapath://file/rtl/m.v' })).json.result.contents[0];
  assert.equal(read.text, expected);
  assert.equal((await mcp(bridge, 'resources/read', { uri: 'datapath://file/.bridge-token' })).json.error.code, -32002);
  assert.deepEqual((await tool(bridge, 'ide_delete_file', { path: 'notes.txt' })).value.path, 'notes.txt');
  assert.equal((await laptop.next(m => m.type === 'file:deleted' && m.path === 'notes.txt')).originClientId, 'mcp');
  assert.equal((await tool(bridge, 'ide_delete_file', { path: 'notes.txt' })).isError, true);
});

await check('browser RPC: refused without remote-enabled tab, routed to the latest allowRemote tab, errors surface', async () => {
  let r = await tool(bridge, 'ide_navigate', { file: 'rtl/m.v', line: 2 });
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /No remote-enabled browser tab/);
  // Node's own WebSocket implementation (undici) as an independent RFC 6455 client, when available.
  let tablet = null;
  if (typeof WebSocket === 'function') {
    tablet = new WebSocket(`${bridge.wsUrl}?token=${bridge.token}&clientId=tablet-1&label=tablet`);
    const inbox = [];
    tablet.onmessage = event => inbox.push(JSON.parse(event.data));
    await new Promise((resolve, reject) => { tablet.onopen = resolve; tablet.onerror = reject; });
    const t = Date.now(); while (!inbox.some(m => m.type === 'sync')) { if (Date.now() - t > 3000) throw new Error('undici sync'); await sleep(10); }
    tablet.send(JSON.stringify({ type: 'hello', clientId: 'tablet-1', label: 'tablet', allowRemote: false }));
  }
  phone.send({ type: 'hello', clientId: 'phone-1', label: 'phone', allowRemote: false });
  laptop.send({ type: 'hello', clientId: 'laptop-1', label: 'Laptop', allowRemote: true });
  await phone.next(m => m.type === 'clients' && m.clients.find(c => c.clientId === 'laptop-1')?.allowRemote === true);
  const pending = tool(bridge, 'ide_navigate', { file: 'rtl/m.v', line: 2, panel: 'waveform' });
  const call = await laptop.next(m => m.type === 'rpc');
  assert.deepEqual([call.method, call.params], ['ide_navigate', { file: 'rtl/m.v', line: 2, panel: 'waveform' }]);
  assert.ok(!phone.inbox.some(m => m.type === 'rpc'), 'disabled tabs never receive RPCs');
  laptop.send({ type: 'rpc:result', id: call.id, ok: true, result: { opened: 'rtl/m.v', line: 2 } });
  r = await pending;
  assert.equal(r.isError, undefined);
  assert.deepEqual(r.value, { opened: 'rtl/m.v', line: 2 });
  // Browser-side failures and explicit clientId targeting.
  const failing = tool(bridge, 'ide_run', { action: 'run', clientId: 'laptop-1' });
  const runCall = await laptop.next(m => m.type === 'rpc' && m.method === 'ide_run');
  assert.deepEqual(runCall.params, { action: 'run' });
  phone.send({ type: 'rpc:result', id: runCall.id, ok: true, result: 'spoofed' }); // wrong tab: ignored
  laptop.send({ type: 'rpc:result', id: runCall.id, ok: false, error: 'Compile failed: 2 errors' });
  r = await failing;
  assert.equal(r.isError, true);
  assert.equal(r.content[0].text, 'Compile failed: 2 errors');
  r = await tool(bridge, 'ide_get_state', { clientId: 'phone-1' });
  assert.match(r.content[0].text, /remote control disabled/);
  r = await tool(bridge, 'ide_get_state', { clientId: 'ghost' });
  assert.match(r.content[0].text, /No connected browser tab/);
  // A tab that disconnects mid-call rejects the pending RPC instead of hanging.
  const orphan = tool(bridge, 'ide_get_problems', {});
  await laptop.next(m => m.type === 'rpc' && m.method === 'ide_get_problems');
  await laptop.close();
  r = await orphan;
  assert.match(r.content[0].text, /disconnected/);
  await phone.next(m => m.type === 'clients' && !m.clients.some(c => c.clientId === 'laptop-1'));
  if (tablet) tablet.close();
});

// ---------------------------------------------------------------------------------------------- headless tools

const MIPS = showcaseProject('mips-cpu').files;
const FSM = showcaseProject('fsm-control').files;

await check('headless verilog_format and verilog_lint (7-rule linter + Icarus compile)', async () => {
  const f = await tool(bridge, 'verilog_format', { code: 'module m;\nwire a;\nendmodule', tabWidth: 4 });
  assert.deepEqual(f.value, { code: 'module m;\n    wire a;\nendmodule', changed: true });
  const lint = await tool(bridge, 'verilog_lint', { files: { 'r.v': 'module r(input clk, input d, output reg q);\n  always @(posedge clk) q = d;\nendmodule\n' } });
  assert.deepEqual(lint.value.findings.map(x => [x.rule, x.line]), [['BLKSEQ', 2]]);
  assert.equal(lint.value.compile.ok, true);
  const broken = await tool(bridge, 'verilog_lint', { files: { 'b.v': 'module b(;\nendmodule\n' } });
  assert.equal(broken.value.compile.ok, false);
  assert.ok(broken.value.compile.diagnostics.some(d => d.file === 'b.v'));
  assert.equal((await tool(bridge, 'verilog_lint', { files: { '../x.v': 'module x; endmodule' } })).isError, true);
  assert.equal((await tool(bridge, 'verilog_lint', { files: { 'a.txt': 'hi' } })).isError, true);
});

await check('headless verilog_elaborate: resources, critical path and latches from ivl.wasm', async () => {
  const r = (await tool(bridge, 'verilog_elaborate', { files: MIPS, topModule: 'mips_cpu' })).value;
  assert.equal(r.ok, true);
  assert.ok(r.modules.includes('mips_alu'));
  assert.ok(r.resources.total.ffBits >= 32);
  assert.equal(r.criticalPath.startpoint, 'pc (Q)');
  assert.ok(r.criticalPath.depth > 5);
  assert.deepEqual(r.latches, []);
  const bug = (await tool(bridge, 'verilog_elaborate', { files: showcaseProject('bug-hunter').files, topModule: 'datapath_slice' })).value;
  assert.equal(bug.resources.total.latchCells, 1);
  assert.deepEqual(bug.latches.map(l => `${l.file}:${l.line}`), ['datapath_slice.v:34']);
  const fail = (await tool(bridge, 'verilog_elaborate', { files: { 'x.v': 'module x(;' }, topModule: 'x' })).value;
  assert.equal(fail.ok, false);
  assert.equal((await tool(bridge, 'verilog_elaborate', { files: MIPS })).isError, true, 'topModule is required');
});

await check('headless verilog_simulate (vvp + VCD summary) and mips_assemble', async () => {
  const sim = (await tool(bridge, 'verilog_simulate', { files: FSM, topModule: 'fsm_tb' })).value;
  assert.equal(sim.ok, true, JSON.stringify(sim).slice(0, 500));
  assert.ok(sim.output.some(line => /cycles/.test(line)));
  assert.ok(sim.waveform.signalCount > 5);
  assert.ok(sim.waveform.signals.some(s => s.path === 'fsm_tb.dut.state' && s.width === 3));
  const asm = (await tool(bridge, 'mips_assemble', { source: MIPS['program.asm'] })).value;
  assert.equal(asm.ok, true);
  assert.equal(asm.outputName, 'program.mem');
  assert.equal(asm.words[0], '20080001'); // addi $t0, $zero, 1
  assert.ok(asm.mem.includes('20080001'));
  const cpu = (await tool(bridge, 'verilog_simulate', { files: { ...MIPS, 'program.mem': asm.mem }, topModule: 'mips_cpu_tb' })).value;
  assert.ok(cpu.passed, cpu.output.join('\n'));
  const bad = (await tool(bridge, 'mips_assemble', { source: 'frob $t0\n' })).value;
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].line, 1);
  const compileError = (await tool(bridge, 'verilog_simulate', { files: { 'x.v': 'module x(;' } })).value;
  assert.equal(compileError.ok, false);
});

await check('headless tools default to the bridge workspace (respecting excluded files)', async () => {
  await tool(bridge, 'ide_write_file', { path: 'rtl/blk.v', content: 'module blk(input clk, input d, output reg q);\n  always @(posedge clk) q = d;\nendmodule\n' });
  const lint = (await tool(bridge, 'verilog_lint', { compile: false })).value;
  assert.ok(lint.findings.some(x => x.file === 'rtl/blk.v' && x.rule === 'BLKSEQ'));
  assert.ok(!lint.findings.some(x => x.file === 'existing.v'));
});

// ---------------------------------------------------------------------------------------------- stdio

function stdioServer(args) {
  const child = spawn(process.execPath, [join(ROOT, 'mcp/server.mjs'), ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  const lines = [], waiters = [];
  child.stdout.on('data', chunk => {
    out += chunk;
    let index;
    while ((index = out.indexOf('\n')) >= 0) {
      const line = out.slice(0, index); out = out.slice(index + 1);
      const message = JSON.parse(line); // every stdout line must be JSON
      lines.push(message);
      for (const w of [...waiters]) if (w.id === message.id) { waiters.splice(waiters.indexOf(w), 1); w.resolve(message); }
    }
  });
  child.stderr.on('data', chunk => { err += chunk; });
  let nextId = 1;
  return {
    child, lines, stderr: () => err,
    raw: text => child.stdin.write(text),
    call(method, params) {
      const id = nextId++;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) })}\n`);
      const found = lines.find(m => m.id === id);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const w = { id, resolve };
        waiters.push(w);
        setTimeout(() => reject(new Error(`stdio timeout for ${method}: ${err}`)), 15000).unref();
      });
    },
    stop() { child.stdin.end(); return new Promise(resolve => child.on('exit', resolve)); },
  };
}

await check('stdio MCP server with --dir: JSON-only stdout, workspace + headless tools, browser tools refused', async () => {
  const dir = await tempDir('dp-stdio-');
  await writeFile(join(dir, 'top.v'), 'module top;\nendmodule\n');
  const s = stdioServer(['--dir', dir]);
  const init = await s.call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } });
  assert.equal(init.result.serverInfo.name, 'datapath-studio-mcp');
  s.raw(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  s.raw('this is not json\n');
  const tools = await s.call('tools/list');
  assert.equal(tools.result.tools.length, 19);
  assert.ok(s.lines.some(m => m.id === null && m.error?.code === -32700), 'parse errors are reported');
  assert.ok(!s.lines.some(m => m.id === undefined), 'notifications get no reply');
  const write = await s.call('tools/call', { name: 'ide_write_file', arguments: { path: 'rtl/a.v', content: 'module a;\nwire x;\nendmodule\n', format: true } });
  assert.equal(JSON.parse(write.result.content[0].text).path, 'rtl/a.v');
  assert.equal(await readFile(join(dir, 'rtl/a.v'), 'utf8'), 'module a;\n  wire x;\nendmodule\n');
  await writeFile(join(dir, 'later.v'), 'module later;\nendmodule\n');
  const list = JSON.parse((await s.call('tools/call', { name: 'ide_list_files', arguments: {} })).result.content[0].text);
  assert.deepEqual(list.files.map(f => f.path), ['later.v', 'rtl/a.v', 'top.v'], 'disk edits are visible; no token file in --dir mode');
  await assert.rejects(stat(join(dir, '.bridge-token')));
  const nav = await s.call('tools/call', { name: 'ide_navigate', arguments: { file: 'top.v' } });
  assert.equal(nav.result.isError, true);
  assert.match(nav.result.content[0].text, /remote-enabled browser tab/);
  const fmt = await s.call('tools/call', { name: 'verilog_format', arguments: { code: 'module m;\nwire w;\nendmodule' } });
  assert.equal(JSON.parse(fmt.result.content[0].text).code, 'module m;\n  wire w;\nendmodule');
  const asm = await s.call('tools/call', { name: 'mips_assemble', arguments: { source: 'addi $t0, $zero, 1\n' } });
  assert.equal(JSON.parse(asm.result.content[0].text).words[0], '20080001');
  const res = await s.call('resources/read', { uri: 'datapath://file/top.v' });
  assert.equal(res.result.contents[0].text, 'module top;\nendmodule\n');
  assert.equal(await s.stop(), 0);
  assert.ok(!s.stderr().includes('Error'), s.stderr());
});

await check('stdio MCP server with --url forwards to the running bridge (and reports a bad token)', async () => {
  const s = stdioServer(['--url', bridge.url, '--token', bridge.token, '--quiet']);
  const init = await s.call('initialize', {});
  assert.equal(init.result.protocolVersion, '2024-11-05');
  const listing = JSON.parse((await s.call('tools/call', { name: 'ide_list_files', arguments: {} })).result.content[0].text);
  assert.ok(listing.files.some(f => f.path === 'rtl/m.v'));
  assert.deepEqual(listing.clients.map(c => c.clientId), ['phone-1']);
  const write = await s.call('tools/call', { name: 'ide_write_file', arguments: { path: 'from-stdio.v', content: 'module s;\nendmodule\n' } });
  assert.equal(write.result.isError, undefined);
  assert.equal((await phone.next(m => m.type === 'file:changed' && m.path === 'from-stdio.v')).originClientId, 'mcp');
  assert.equal(await s.stop(), 0);
  const bad = stdioServer(['--url', bridge.url, '--token', 'wrong', '--quiet']);
  const denied = await bad.call('ping');
  assert.equal(denied.error.code, -32001);
  await bad.stop();
});

await check('shutdown closes clients, pending work and the HTTP server cleanly', async () => {
  const closed = phone.closed;
  await bridge.close();
  const info = await closed;
  assert.equal(info.code, 1001);
  await assert.rejects(http(`${bridge.url}/healthz`));
  assert.equal(bridge.close(), bridge.close(), 'close() is idempotent');
});

await check('CLI: node server/bridge.mjs serves, honours --token/--quiet-free banner, and exits 0 on SIGTERM', async () => {
  const dir = await tempDir('dp-cli-');
  const child = spawn(process.execPath, [join(ROOT, 'server/bridge.mjs'), '--port', String(await freeTestPort()), '--host', '127.0.0.1', '--dir', dir, '--token', 'cli-token-123', '--poll-ms', '100'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '', out = '';
  child.stderr.on('data', c => { err += c; });
  child.stdout.on('data', c => { out += c; });
  const started = Date.now();
  while (!/on (http:\/\/127\.0\.0\.1:\d+)/.test(err)) { if (Date.now() - started > 5000) throw new Error(`bridge CLI did not start: ${err}`); await sleep(20); }
  const url = /on (http:\/\/127\.0\.0\.1:\d+)/.exec(err)[1];
  assert.equal((await http(`${url}/healthz`)).status, 200);
  assert.equal((await mcp({ url, token: 'cli-token-123' }, 'ping')).status, 200);
  assert.equal((await mcp({ url, token: 'other' }, 'ping')).status, 401);
  assert.equal(out, '', 'logs go to stderr');
  await assert.rejects(stat(join(dir, '.bridge-token')), 'an explicit --token is not written to disk');
  child.kill('SIGTERM');
  const code = await new Promise(resolve => child.on('exit', resolve));
  assert.equal(code, 0);
  assert.match(err, /SIGTERM: shutting down/);
});

for (const dir of temps) await rm(dir, { recursive: true, force: true });
console.log(`MCP bridge checks passed (${checks})`);
