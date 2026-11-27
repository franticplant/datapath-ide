// Automated UX scenario audit across Desktop (1440x900), Laptop (1280x720), and Phone (412x915).
// Run offline inside Playwright mvm:
//   mvm run -i mcr.microsoft.com/playwright:v1.48.2-jammy -u $(id -u):$(id -g) -- node tests/browser/ux-vibe-check.cjs
const { existsSync, mkdirSync } = require('fs');
const assert = require('assert/strict');
const { createServer } = require('http');
const { readFile } = require('fs/promises');
const { join, extname } = require('path');

const playwrightModule = process.env.PLAYWRIGHT_MODULE
  || [join(__dirname, '../../build/node_modules/playwright'), join(__dirname, '../../node_modules/playwright')].find(existsSync)
  || 'playwright';
const { chromium } = require(playwrightModule);
const chromiumPath = process.env.CHROMIUM_PATH || ['/ms-playwright/chromium-1140/chrome-linux/chrome'].find(existsSync);
const launchOptions = { ...(chromiumPath ? { executablePath: chromiumPath } : {}), chromiumSandbox: process.env.PW_CHROMIUM_SANDBOX !== '0' };
const webRoot = join(__dirname, '../../web');
const outDir = process.env.UX_AUDIT_DIR || null;
if (outDir) mkdirSync(outDir, { recursive: true });

const box = async loc => {
  const count = await loc.count();
  if (!count) return null;
  const visible = await loc.first().isVisible().catch(() => false);
  if (!visible) return { visible: false, width: 0, height: 0 };
  const b = await loc.first().boundingBox();
  return b ? { visible: true, x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) } : { visible: false, width: 0, height: 0 };
};

(async () => {
  const server = createServer(async (req, res) => {
    const pathOnly = req.url.split('?')[0];
    const reqPath = pathOnly === '/' ? '/index.html' : pathOnly;
    try {
      const data = await readFile(join(webRoot, reqPath));
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml' }[extname(reqPath)] || 'text/plain';
      res.writeHead(200, { 'Content-Type': type }); res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(8089, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:8089/';
  let browser;
  const report = { scenarios: {}, errors: [] };
  const snap = async (page, name) => {
    if (outDir) await page.screenshot({ path: join(outDir, name) });
  };
  const metrics = async (page) => ({
    viewport: page.viewportSize(),
    overflowX: await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    topbarWrapped: await page.evaluate(() => { const r = document.querySelector('.topbar')?.getBoundingClientRect(); return r ? r.height > 48 : false; }),
    explorer: await box(page.locator('.sidebar')),
    inspector: await box(page.locator('.inspector')),
    editor: await box(page.locator('#editor-groups')),
    featuredHero: await box(page.locator('#featured-hero')),
    tourRail: await box(page.locator('#tour-rail')),
    bottomDock: await box(page.locator('.bottom')),
    schemToolbar: await box(page.locator('.schem-toolbar')),
    schemCanvas: await box(page.locator('#schem-canvas')),
    schemInspector: await box(page.locator('#schem-inspector')),
    waveToolbar: await box(page.locator('.wave-toolbar')),
    waveGrid: await box(page.locator('#wave-grid')),
    boardInputs: await box(page.locator('#board-live-inputs')),
    boardOutputs: await box(page.locator('#board-live-outputs')),
  });

  try {
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    page.on('pageerror', e => report.errors.push(e.message));

    // 1. Fresh Laptop (1280x720) & Phone (412x915)
    await page.goto(baseUrl);
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    await page.waitForSelector('#featured-hero:not([hidden])');
    report.scenarios.laptopFresh = await metrics(page);
    await snap(page, '01-laptop-fresh.png');

    await page.setViewportSize({ width: 412, height: 915 });
    report.scenarios.phoneFresh = await metrics(page);
    await snap(page, '01-phone-fresh.png');

    // 2. Laptop Tour Ch 1 -> Ch 2 (measure pre-warmed X-Ray timing + dimensions) -> Ch 3 Debug + Jump visibility
    await page.setViewportSize({ width: 1280, height: 720 });
    const settle = () => page.waitForFunction(() => !document.getElementById('tour-rail').hidden && document.getElementById('tour-busy').hidden && !document.getElementById('tour-assist').disabled, null, { timeout: 60000 });
    await page.locator('#tour-start').click();
    await settle();
    report.scenarios.laptopCh1Boot = await metrics(page);

    const t0 = Date.now();
    await page.locator('#tour-next').click();
    await settle();
    await page.waitForSelector('#schem-canvas .schem-cell.kind-module[data-name="u_alu"]');
    report.scenarios.laptopCh2Xray = { elaborateMs: Date.now() - t0, ...(await metrics(page)) };
    await snap(page, '02-laptop-xray.png');

    await page.locator('#tour-next').click();
    await settle();
    await page.waitForSelector('#schem-warnings .schem-warning');
    await page.locator('#tour-assist').click();
    await page.waitForFunction(() => document.getElementById('active-file').textContent.includes('datapath_slice.v'));
    const jumpedCursor = await page.evaluate(() => {
      const c = document.querySelector('#editor-groups .cm-activeLine')?.getBoundingClientRect();
      const s = document.querySelector('#editor-groups .cm-scroller')?.getBoundingClientRect();
      return { activeLineVisible: Boolean(c && s && c.top >= s.top - 4 && c.bottom <= s.bottom + 4), lineText: document.querySelector('#cursor')?.textContent };
    });
    report.scenarios.laptopCh3Debug = { ...jumpedCursor, ...(await metrics(page)) };
    await snap(page, '03-laptop-debug.png');

    // 3. Laptop Ch 4 Waveform
    await page.locator('#tour-next').click();
    await settle();
    await page.waitForSelector('.wave-row[data-path="fsm_tb.dut.state"]');
    report.scenarios.laptopCh4Wave = {
      waveRowsVisible: await page.locator('.wave-row:not(.wave-ruler)').count(),
      ...(await metrics(page)),
    };
    await snap(page, '04-laptop-wave.png');

    // 4. Laptop Ch 5 Live FPGA Board + Phone Board
    await page.locator('#tour-next').click();
    await settle();
    await page.waitForFunction(() => !document.getElementById('board-tick').disabled, null, { timeout: 30000 });
    await page.locator('#tour-assist').click();
    await page.waitForFunction(() => document.querySelector('#board-live-outputs [data-port="leds"] .board-readout')?.textContent === '0x01');
    report.scenarios.laptopCh5Board = await metrics(page);
    await snap(page, '05-laptop-board.png');

    await page.setViewportSize({ width: 412, height: 915 });
    const phoneBoardAfterRightDock = await box(page.locator('#board-live-outputs'));
    await page.locator('button[data-view="console"]').click();
    await page.locator('[data-panel="board"]').click();
    report.scenarios.phoneBoard = { visibleBeforeNavTap: phoneBoardAfterRightDock?.visible, ...(await metrics(page)) };
    await snap(page, '05-phone-board.png');

    // 5. Phone Schematic + Inspector height
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('[data-tour-step="1"]').click();
    await settle();
    report.scenarios.desktopXray = await metrics(page);
    await page.setViewportSize({ width: 412, height: 915 });
    const schemVisibleOnResize = await page.locator('#schem-fit').isVisible();
    if (!schemVisibleOnResize) {
      await page.locator('button[data-view="console"]').click();
      await page.locator('[data-panel="schematic"]').click();
    }
    await page.locator('#schem-fit').click();
    await page.locator('#schem-canvas .schem-cell.kind-module[data-name="u_alu"]').click();
    await page.waitForSelector('#schem-inspector:not([hidden])');
    report.scenarios.phoneSchematicInspect = { visibleImmediatelyOnResize: schemVisibleOnResize, ...(await metrics(page)) };
    await snap(page, '06-phone-schematic.png');

    // 6. Light Theme check on 1440x900
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#preferences').click();
    await page.locator('#editor-theme').selectOption('light');
    await page.getByRole('button', { name: 'Done' }).click();
    report.scenarios.desktopLightTheme = await metrics(page);
    await snap(page, '07-light-theme.png');

    assert.equal(report.scenarios.laptopFresh.inspector.visible, false);
    assert.ok(report.scenarios.laptopFresh.editor.width >= 900);
    assert.equal(report.scenarios.phoneBoard.visibleBeforeNavTap, true);
    assert.equal(report.scenarios.phoneSchematicInspect.visibleImmediatelyOnResize, true);
    for (const [name, scenario] of Object.entries(report.scenarios)) {
      assert.equal(scenario.overflowX, false, `${name}: horizontal overflow`);
      assert.equal(scenario.topbarWrapped, false, `${name}: wrapped topbar`);
    }
    assert.deepEqual(report.errors, []);

    const featurePage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    featurePage.on('pageerror', e => report.errors.push(e.message));
    await featurePage.goto(baseUrl);
    await featurePage.waitForFunction(() => !document.getElementById('run').disabled);
    // Stage B's diagnostic clearing check is for the compiler alone.
    await featurePage.locator('#preferences').click();
    await featurePage.locator('#opt-strict-lint').uncheck();
    await featurePage.getByRole('button', { name: 'Done' }).click();
    await featurePage.locator('#sidebar-hierarchy').click();
    await featurePage.locator('#hierarchy-tree button').filter({ hasText: 'dut : counter' }).click();
    assert.match(await featurePage.locator('#active-file').textContent(), /testbench\.v/);
    assert.match(await featurePage.locator('#cursor').textContent(), /Ln 6,/);
    await featurePage.locator('#sidebar-files').click();
    const editor = featurePage.locator('.cm-content').first();
    await editor.click();
    await featurePage.keyboard.press('Control+A');
    await featurePage.keyboard.insertText('module testbench;\n  broken ???;\nendmodule\n');
    await featurePage.waitForFunction(() => /Problems \([1-9]/.test(document.querySelector('[data-panel="problems"]').textContent), null, { timeout: 30000 });
    await editor.click(); await featurePage.keyboard.press('Control+A');
    await featurePage.keyboard.insertText('`timescale 1ns/1ps\nmodule testbench;\nreg clk = 0;\nwire [3:0] count;\ncounter dut(.clk(clk), .reset(1\'b0), .count(count));\ninitial begin\n$dumpfile("wave.vcd");\n$dumpvars(0, testbench);\n#5 $finish;\nend\nendmodule\n');
    await featurePage.waitForFunction(() => document.querySelector('[data-panel="problems"]').textContent === 'Problems', null, { timeout: 30000 });
    await featurePage.keyboard.press('Shift+Alt+f');
    await featurePage.waitForFunction(() => document.querySelector('.cm-content').textContent.includes('  reg clk'));
    await featurePage.locator('#run').click();
    await featurePage.waitForSelector('.wave-row[data-path="testbench.count"]', { timeout: 60000 });
    await featurePage.waitForSelector('.cm-inline-val', { timeout: 30000 });
    featurePage.once('dialog', dialog => dialog.accept('Audit group'));
    await featurePage.locator('#wave-add-group').click();
    assert.equal(await featurePage.locator('.wave-group').count(), 1);
    featurePage.once('dialog', dialog => dialog.accept('testbench.count[3:1]'));
    await featurePage.locator('#wave-add-slice').click();
    assert.equal(await featurePage.locator('.wave-row[data-path="testbench.count[3:1]"]').count(), 1);
    featurePage.once('dialog', dialog => dialog.accept('Audit view'));
    await featurePage.locator('#wave-save-view').click();
    await featurePage.locator('.wave-group button').click();
    await featurePage.locator('#wave-views').selectOption('Audit view');
    assert.ok(await featurePage.locator('.wave-row[data-path="testbench.count[3:1]"]').isVisible());
    await featurePage.locator('#sidebar-hierarchy').click();
    await snap(featurePage, '08-stage-b-ide.png');
    await featurePage.locator('#wave-delete-view').click();
    report.stageB = { hierarchy: 'passed', liveLint: 'passed', inlineValues: 'passed', formatter: 'passed', waveformViews: 'passed' };

    // Strict RTL lint should update Problems while typing without running simulation.
    await featurePage.locator('#preferences').click();
    await featurePage.locator('#opt-strict-lint').check();
    await featurePage.getByRole('button', { name: 'Done' }).click();
    await editor.click(); await featurePage.keyboard.press('Control+A');
    await featurePage.keyboard.insertText('module testbench(input clk, input d, output reg q);\nalways @(posedge clk) begin\n  q = d;\nend\nendmodule\n');
    await featurePage.waitForFunction(() => [...document.querySelectorAll('#problems .problem-rule')].some(el => el.textContent === '[BLKSEQ]'), null, { timeout: 30000 });
    await featurePage.locator('[data-panel="problems"]').click();
    assert.ok(await featurePage.locator('#problems .problem-rule').filter({ hasText: '[BLKSEQ]' }).isVisible());
    await snap(featurePage, '11-stage-c-lint.png');

    // The tour's MIPS CPU has already been elaborated in the schematic.
    if (await page.locator('#schem-inspector').isVisible()) await page.getByRole('button', { name: 'Close inspector' }).click();
    await page.locator('#schem-resources').click();
    await page.waitForSelector('#schem-resources-panel:not([hidden]) .schem-resource-badge');
    const totals = await page.locator('#schem-resources-panel .schem-resource-badge').allTextContents();
    for (const name of ['FF bits', 'Muxes', 'Ops', 'Memory']) {
      const badge = totals.find(text => text.startsWith(`${name}:`));
      assert.ok(badge && Number(badge.split(':')[1]) > 0, `${name}: expected non-zero resources (${totals.join(', ')})`);
    }
    await page.locator('#schem-critpath').click();
    await page.waitForSelector('#schem-critpath-banner:not([hidden])');
    assert.match(await page.locator('#schem-critpath-banner').textContent(), /Depth [1-9]/);
    assert.ok(await page.locator('.schem-cell.is-critpath').count() > 0);
    for (const [name, viewport] of [['stageCLaptop', { width: 1280, height: 720 }], ['stageCPhone', { width: 412, height: 915 }]]) {
      await page.setViewportSize(viewport);
      const dimensions = await metrics(page);
      assert.equal(dimensions.overflowX, false, `${name}: horizontal overflow`);
      assert.equal(dimensions.topbarWrapped, false, `${name}: wrapped topbar`);
      assert.equal(await page.locator('#schem-resources-panel').isVisible(), true);
      assert.equal(await page.locator('#schem-critpath-banner').isVisible(), true);
      assert.ok(dimensions.schemCanvas.height >= 150, `${name}: schematic canvas is too short`);
      report.scenarios[name] = dimensions;
      await snap(page, name === 'stageCLaptop' ? '09-stage-c-resources-critpath.png' : '10-stage-c-phone.png');
    }
    report.stageC = { strictLint: 'passed', resources: totals, criticalPath: 'passed', responsive: 'passed' };
    assert.deepEqual(report.errors, []);
    await featurePage.close();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
