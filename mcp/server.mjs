#!/usr/bin/env node
// Datapath Studio MCP server over stdio (line-delimited JSON-RPC 2.0).
//   node mcp/server.mjs --url http://127.0.0.1:18473 --token <tok>   forward to a running bridge (live IDE tabs too)
//   node mcp/server.mjs --dir <workspace>                             serve a directory + headless WASM tools directly
// stdout carries JSON-RPC messages only; every diagnostic goes to stderr.
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';

// Keep stray library logging off the protocol stream.
for (const method of ['log', 'info', 'debug']) console[method] = (...args) => console.error(...args);

const USAGE = 'Usage: node mcp/server.mjs (--url http://127.0.0.1:18473 [--token TOKEN] | --dir WORKSPACE) [--quiet]';

function parseArgs(argv) {
  const options = { url: process.env.DATAPATH_BRIDGE_URL || null, token: process.env.DATAPATH_BRIDGE_TOKEN || null, dir: null, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const [flag, inline] = arg.startsWith('--') && arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, null];
    const value = () => inline ?? argv[++i];
    if (flag === '--url') options.url = value();
    else if (flag === '--token') options.token = value();
    else if (flag === '--dir') { options.dir = value(); options.url = null; }
    else if (flag === '--quiet') options.quiet = true;
    else if (flag === '--help' || flag === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

const write = message => { process.stdout.write(`${JSON.stringify(message)}\n`); };

// Forwarding transport: each JSON-RPC message is POSTed to <url>/mcp with the bearer token.
function remoteHandler(baseUrl, token) {
  const endpoint = new URL('mcp', baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`).href;
  return {
    async handle(message) {
      let response;
      try {
        response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify(message),
        });
      } catch (error) {
        return errorFor(message, -32603, `Bridge unreachable at ${endpoint}: ${error.cause?.code || error.message}`);
      }
      if (response.status === 202) return null;
      const text = await response.text();
      if (response.status === 401) return errorFor(message, -32001, 'Bridge rejected the token (401 Unauthorized)');
      try { return JSON.parse(text); } catch { return errorFor(message, -32603, `Bridge returned HTTP ${response.status}`); }
    },
  };
}

function errorFor(message, code, text) {
  const reply = item => (item && typeof item === 'object' && Object.hasOwn(item, 'id') ? { jsonrpc: '2.0', id: item.id, error: { code, message: text } } : null);
  if (Array.isArray(message)) { const all = message.map(reply).filter(Boolean); return all.length ? all : null; }
  return reply(message);
}

async function localHandler(dir, quiet) {
  const { Workspace, createMcpHandler } = await import('../server/bridge.mjs');
  const workspace = await new Workspace(resolve(dir), { pollMs: 0, quiet }).init();
  const inner = createMcpHandler({ workspace, callBrowser: null, getClients: () => [] });
  return {
    async handle(message) {
      await workspace.scan(); // pick up edits made on disk since the last call
      return inner.handle(message);
    },
  };
}

async function main() {
  let options;
  try { options = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); console.error(USAGE); process.exit(2); }
  if (options.help) { console.error(USAGE); process.exit(0); }
  const handler = options.url ? remoteHandler(options.url, options.token) : await localHandler(options.dir || 'workspace', options.quiet);
  if (!options.quiet) console.error(options.url ? `[mcp] forwarding to ${options.url}` : `[mcp] serving ${resolve(options.dir || 'workspace')}`);

  const inflight = new Set();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on('line', line => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    const task = Promise.resolve()
      .then(() => handler.handle(message))
      .then(reply => { if (reply) write(reply); })
      .catch(error => {
        console.error('[mcp]', error);
        const reply = errorFor(message, -32603, error.message || 'Internal error');
        if (reply) write(reply);
      })
      .finally(() => inflight.delete(task));
    inflight.add(task);
  });
  lines.on('close', async () => { await Promise.allSettled([...inflight]); process.exit(0); });
}

main().catch(error => { console.error('[mcp] fatal:', error); process.exit(1); });
