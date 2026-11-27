// Two-device bridge + MCP end-to-end test, running entirely on loopback.
const { existsSync } = require('fs');
const { mkdtemp, mkdir, rm, writeFile, readFile } = require('fs/promises');
const { tmpdir } = require('os');
const { join, resolve, dirname } = require('path');
const { pathToFileURL } = require('url');
const assert = require('assert/strict');
const playwrightModule = process.env.PLAYWRIGHT_MODULE
  || [join(__dirname, '../../build/node_modules/playwright'), join(__dirname, '../../node_modules/playwright')].find(existsSync)
  || 'playwright';
const { chromium } = require(playwrightModule);
const chromiumPath = process.env.CHROMIUM_PATH || ['/ms-playwright/chromium-1140/chrome-linux/chrome'].find(existsSync);
const launchOptions = { ...(chromiumPath ? { executablePath: chromiumPath } : {}), chromiumSandbox: process.env.PW_CHROMIUM_SANDBOX !== '0' };

(async () => {
  const workspaceDir = await mkdtemp(join(tmpdir(), 'datapath-mcp-e2e-'));
  let bridge, browser;
  const errors = [];
  try {
    const initial = 'module counter(input clk, input reset, output reg [3:0] count);\n  always @(posedge clk) if (reset) count <= 0; else count <= count + 1;\nendmodule\n';
    const testbench = '`timescale 1ns/1ps\nmodule testbench;\nreg clk = 0; reg reset = 1; wire [3:0] count;\ncounter dut(.clk(clk), .reset(reset), .count(count));\nalways #5 clk = ~clk;\ninitial begin $dumpfile("wave.vcd"); $dumpvars(0, testbench); #12 reset = 0; #30 $display("MCP PASS"); $finish; end\nendmodule\n';
    await writeFile(join(workspaceDir, 'design.v'), initial);
    await writeFile(join(workspaceDir, 'testbench.v'), testbench);
    const { startBridgeServer } = await import(pathToFileURL(resolve(__dirname, '../../server/bridge.mjs')).href);
    bridge = await startBridgeServer({ port: Number(process.env.MCP_SYNC_PORT || 18580), host: '127.0.0.1', workspaceDir, webDir: resolve(__dirname, '../../web'), pollMs: 100, quiet: true });
    browser = await chromium.launch(launchOptions);
    const laptop = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const phone = await browser.newPage({ viewport: { width: 412, height: 915 } });
    for (const page of [laptop, phone]) page.on('pageerror', error => errors.push(error.message));
    const paired = new URL(bridge.url); paired.searchParams.set('bridgeToken', bridge.token);
    await Promise.all([laptop.goto(paired.href), phone.goto(paired.href)]);
    for (const page of [laptop, phone]) {
      await page.waitForFunction(() => !document.getElementById('run').disabled && !document.getElementById('bridge-pill').hidden && /Sync/.test(document.getElementById('bridge-pill').textContent), null, { timeout: 30000 });
      assert.equal(new URL(page.url()).searchParams.has('bridgeToken'), false);
    }
    const laptopId = await laptop.evaluate(() => sessionStorage.getItem('datapath.mcp-client.v1'));
    const phoneId = await phone.evaluate(() => sessionStorage.getItem('datapath.mcp-client.v1'));
    assert.ok(laptopId && phoneId && laptopId !== phoneId);
    if (process.env.BRIDGE_SCREENSHOT) {
      await laptop.locator('#bridge-pill').click();
      await laptop.waitForFunction(() => document.querySelectorAll('#bridge-clients li').length >= 2);
      assert.equal(await laptop.locator('#bridge-allow-remote').isChecked(), true);
      await mkdir(dirname(process.env.BRIDGE_SCREENSHOT), { recursive: true });
      await laptop.screenshot({ path: process.env.BRIDGE_SCREENSHOT });
      await laptop.locator('#bridge-done').click();
    }
    await laptop.locator('#files button[data-path="design.v"]').click();
    await phone.locator('button[data-view="files"]').click();
    await phone.locator('#files button[data-path="design.v"]').click();
    for (const page of [laptop, phone]) await page.evaluate(async () => { window.bridgeTestEditorText = (await import('./vendor/editor.js')).editorText; });
    const changed = initial.replace('count + 1', 'count + 2');
    await laptop.locator('#editor .cm-content').fill(changed);
    await phone.waitForFunction(expected => window.bridgeTestEditorText(document.querySelector('#editor')) === expected, changed, { timeout: 30000 });
    await laptop.waitForFunction(expected => window.bridgeTestEditorText(document.querySelector('#editor')) === expected, changed);
    assert.equal(await readFile(join(workspaceDir, 'design.v'), 'utf8'), changed);

    let id = 0;
    async function call(name, args = {}) {
      const response = await fetch(new URL('mcp', bridge.url), { method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method: 'tools/call', params: { name, arguments: args } }) });
      assert.equal(response.status, 200);
      const body = await response.json(); if (body.error) throw new Error(body.error.message);
      return body.result;
    }
    const unpack = result => {
      if (result.structuredContent) return result.structuredContent;
      const text = result.content?.find(item => item.type === 'text')?.text;
      if (!text) return result;
      try { return JSON.parse(text); } catch { return text; }
    };
    const unformatted = 'module counter(input clk,input reset,output reg [3:0] count);\nalways @(posedge clk) begin\nif(reset) count <= 0;\nelse count <= count + 1;\nend\nendmodule\n';
    const write = await call('ide_write_file', { path: 'design.v', content: unformatted, format: true });
    assert.notEqual(write.isError, true);
    const formatted = await readFile(join(workspaceDir, 'design.v'), 'utf8');
    assert.match(formatted, /\n\s+always/);
    for (const page of [laptop, phone]) await page.waitForFunction(expected => window.bridgeTestEditorText(document.querySelector('#editor')) === expected, formatted, { timeout: 30000 });

    const navigate = await call('ide_navigate', { clientId: laptopId, panel: 'schematic' });
    assert.notEqual(navigate.isError, true);
    await laptop.waitForFunction(() => !document.getElementById('schematic').hidden);
    const run = await call('ide_run', { clientId: laptopId, action: 'run', topModule: 'testbench' });
    assert.notEqual(run.isError, true);
    const runResult = unpack(run); assert.equal(runResult.ok, true); assert.match(runResult.consoleOutput, /MCP PASS/);
    const schem = await call('ide_schematic', { clientId: laptopId, moduleName: 'counter', elaborate: true, resources: true, criticalPath: true });
    assert.notEqual(schem.isError, true);
    const metrics = unpack(schem); assert.ok(metrics.resources?.total?.ffBits > 0); assert.ok(metrics.criticalPath?.depth > 0);
    const wave = await call('ide_waveform', { clientId: laptopId, cursorTime: 5, plotSignal: 'testbench.count', radix: 'hex' });
    assert.notEqual(wave.isError, true); assert.equal(unpack(wave).cursor, '5');
    const board = await call('ide_board', { clientId: laptopId, moduleName: 'counter', liveAction: 'start' });
    assert.notEqual(board.isError, true, JSON.stringify(board));
    const driven = await call('ide_board', { clientId: laptopId, drive: { reset: 0 }, ticks: 1 });
    assert.notEqual(driven.isError, true, JSON.stringify(driven));
    assert.ok(unpack(driven).cycle >= 1);
    const stopped = await call('ide_board', { clientId: laptopId, liveAction: 'stop' }); assert.notEqual(stopped.isError, true);

    // Disable both tabs so a non-targeted call cannot be routed to the other device.
    for (const page of [laptop, phone]) {
      await page.locator('#bridge-pill').click(); await page.locator('#bridge-allow-remote').uncheck(); await page.locator('#bridge-done').click();
    }
    await laptop.waitForFunction(() => document.getElementById('bridge-pill').textContent.includes('Synced'));
    await phone.waitForFunction(() => document.getElementById('bridge-pill').textContent.includes('Synced'));
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const status = unpack(await call('ide_list_files'));
      if ([laptopId, phoneId].every(id => status.clients?.some(client => client.clientId === id && client.allowRemote === false))) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const denied = await call('ide_navigate', { clientId: laptopId, panel: 'console' });
    assert.equal(denied.isError, true);
    assert.match(JSON.stringify(denied), /disabled|remote|no.*browser/i);
    const list = await call('ide_list_files'); assert.notEqual(list.isError, true); assert.ok(JSON.stringify(unpack(list)).includes('design.v'));
    assert.deepEqual(errors, []);
    console.log('MCP sync browser checks passed (2 devices, file sync, formatted write, navigate, run, schematic, waveform, board, remote gate)');
  } finally {
    if (browser) await browser.close();
    if (bridge) await bridge.close();
    await rm(workspaceDir, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
