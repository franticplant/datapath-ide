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
  const assertHorizontalBounds = async (page, container, elements) => {
    const bounds = await page.locator(container).boundingBox();
    assert.ok(bounds, `${container} must be visible`);
    for (const selector of elements) {
      const target = page.locator(selector);
      assert.equal(await target.isVisible(), true, `${selector} must be visible`);
      const rect = await target.boundingBox();
      assert.ok(rect && rect.x >= bounds.x - 1 && rect.x + rect.width <= bounds.x + bounds.width + 1, `${selector} exceeds ${container} bounds`);
    }
  };
  const assertActiveTabVisible = async page => {
    await page.waitForFunction(() => {
      const tab = document.querySelector('.panel-tabs [data-panel].selected');
      const strip = document.querySelector('.panel-tabs');
      if (!tab || !strip) return false;
      const a = tab.getBoundingClientRect(), b = strip.getBoundingClientRect();
      return a.width > 0 && a.left >= b.left - 1 && a.right <= b.right + 1;
    });
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
    assert.doesNotMatch(await page.locator('#console-output').textContent(), /loading/i);
    await assertHorizontalBounds(page, '.sidebar', ['#new-file', '#new-folder', '#import', '#export', '#collapse-folders', '#toggle-excluded-visibility']);
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
    await assertHorizontalBounds(page, '.schem-toolbar', ['#schem-module', '#schem-elaborate', '#schem-critpath', '#schem-resources', '#schem-flatten', '#schem-step-prev', '#schem-play', '#schem-step-next', '#schem-fit', '#schem-search', '#schem-map', '#schem-export']);
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
    await assertHorizontalBounds(page, '.wave-toolbar', ['#wave-add-group', '#wave-add-slice', '#wave-views', '#open-vcd', '#download-vcd', '#wave-fit', '#previous-edge', '#next-edge', '#wave-step-prev', '#wave-play', '#wave-step-next', '#wave-value-search', '#wave-value-find', '#wave-short-names', '#wave-gridlines', '#wave-snap', '#wave-cursor']);
    await assertHorizontalBounds(page, '.bottom', ['#wave-cursor']);
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
    if (schemVisibleOnResize) await assertActiveTabVisible(page);
    await assertHorizontalBounds(page, '.schem-toolbar', ['#schem-module', '#schem-elaborate', '#schem-critpath', '#schem-resources', '#schem-flatten', '#schem-step-prev', '#schem-play', '#schem-step-next', '#schem-fit', '#schem-search', '#schem-map', '#schem-export']);
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
    assert.equal(await featurePage.locator('.side-actions').isVisible(), false);
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
    await featurePage.locator('.problem-row').filter({ hasText: '[BLKSEQ]' }).locator('.problem-fix').click();
    await featurePage.waitForFunction(() => document.querySelector('#editor .cm-content').textContent.includes('q <= d;') && ![...document.querySelectorAll('#problems .problem-rule')].some(el => el.textContent === '[BLKSEQ]'), null, { timeout: 30000 });
    await featurePage.keyboard.press('Control+Shift+h');
    await featurePage.waitForSelector('#search-dialog[open]');
    await featurePage.locator('#search-regex').check();
    await featurePage.locator('#search-input').fill('q');
    await featurePage.waitForFunction(() => /result/.test(document.getElementById('search-count').textContent));
    await featurePage.locator('#replace-input').fill('state_q');
    await featurePage.locator('#replace-in-file').click();
    await featurePage.waitForFunction(() => document.querySelector('#editor .cm-content').textContent.includes('state_q <= d;'));
    await featurePage.locator('#close-search').click();
    await featurePage.locator('#sidebar-hierarchy').click();
    const beforeInstance = await editor.textContent();
    await featurePage.locator('.hierarchy-add').first().click();
    assert.notEqual(await editor.textContent(), beforeInstance);
    assert.match(await editor.textContent(), /counter\s+u_counter\s*\(/);

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
    assert.doesNotMatch(await page.locator('#schem-critpath-banner').textContent(), /\$_ivl_/);
    assert.doesNotMatch(await page.locator('#schem-critpath-banner').textContent(), /\((\w+)\)\s*\(\1\)/);
    assert.ok(await page.locator('.schem-cell.is-critpath').count() > 0);
    for (const [name, viewport] of [['stageCLaptop', { width: 1280, height: 720 }], ['stageCPhone', { width: 412, height: 915 }]]) {
      await page.setViewportSize(viewport);
      const dimensions = await metrics(page);
      await assertHorizontalBounds(page, '.schem-toolbar', ['#schem-module', '#schem-export']);
      if (name === 'stageCPhone') await assertActiveTabVisible(page);
      assert.equal(dimensions.overflowX, false, `${name}: horizontal overflow`);
      assert.equal(dimensions.topbarWrapped, false, `${name}: wrapped topbar`);
      assert.equal(await page.locator('#schem-resources-panel').isVisible(), true);
      assert.equal(await page.locator('#schem-critpath-banner').isVisible(), true);
      assert.ok(dimensions.schemCanvas.height >= 150, `${name}: schematic canvas is too short`);
      report.scenarios[name] = dimensions;
      await snap(page, name === 'stageCLaptop' ? '09-stage-c-resources-critpath.png' : '10-stage-c-phone.png');
    }
    // Wave 1/2: quick open, formatter, tabs, breadcrumbs and tactile interactions.
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.keyboard.press('Control+p'); await page.waitForSelector('#quick-open-dialog[open]');
    await page.locator('#quick-open-input').fill('mips_cpu.v'); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.getElementById('active-file').textContent.includes('mips_cpu.v'));
    await page.keyboard.press('Control+Shift+o'); await page.locator('#quick-open-input').fill('@mips_alu');
    await page.keyboard.press('Enter');
    const symbolLine = Number((await page.locator('#cursor').textContent()).match(/Ln (\d+)/)?.[1]);
    const symbolSource = await page.evaluate(async () => (await import('./vendor/editor.js')).editorText(document.querySelector('#editor')));
    assert.match(symbolSource.split('\n')[symbolLine - 1], /\bmodule\s+mips_alu\b/);
    await page.keyboard.press('Control+p'); await page.locator('#quick-open-input').fill(':16'); await page.keyboard.press('Enter');
    assert.match(await page.locator('#cursor').textContent(), /Ln 16,/);
    assert.match(await page.locator('#editor-breadcrumbs').textContent(), /mips_cpu\.v.*mips_cpu/);
    await page.locator('#editor .cm-content').focus(); await page.keyboard.press('Shift+Alt+f');
    const sourceText = () => page.evaluate(async () => (await import('./vendor/editor.js')).editorText(document.querySelector('#editor')));
    const formatted = await sourceText();
    assert.match(formatted, /^\s{10,}\.reg_write\(reg_write\)/m);
    assert.ok(await page.locator('#editor .cm-indent-guide').count() > 0);
    await page.getByRole('tab', { name: 'mips_cpu.v', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin Tab' }).click();
    assert.equal(await page.locator('.group-tab.is-pinned').count(), 1);
    await page.keyboard.press('Control+p'); await page.locator('#quick-open-input').fill('program.asm'); await page.keyboard.press('Enter');
    await page.locator('.active-group .group-tab.selected .tab-close').click();
    await page.keyboard.press('Control+Shift+t');
    assert.match(await page.locator('#active-file').textContent(), /program\.asm/);
    await page.getByRole('tab', { name: 'mips_cpu.v', exact: true }).click();
    await page.keyboard.press('Control+p'); await page.locator('#quick-open-input').fill(':16'); await page.keyboard.press('Enter');
    await snap(page, '12-wave2-vscode-ux.png');
    await page.locator('#compile').click();
    await page.waitForFunction(() => ['Complete', 'Error'].includes(document.querySelector('.engine-state').textContent), null, { timeout: 60000 });
    assert.equal(await page.locator('.engine-state').first().textContent(), 'Complete', await page.locator('#console-output').textContent());
    await page.locator('#run').click();
    await page.waitForFunction(() => ['Complete', 'Error'].includes(document.querySelector('.engine-state').textContent), null, { timeout: 60000 });
    assert.equal(await page.locator('.engine-state').first().textContent(), 'Complete', await page.locator('#console-output').textContent());
    await page.waitForSelector('#wave-grid .wave-row[data-path]', { timeout: 60000 });
    await page.locator('[data-panel="schematic"]').click();
    await page.locator('#schem-module').selectOption('mips_cpu'); await page.locator('#schem-elaborate').click();
    await page.waitForFunction(() => !document.getElementById('schem-elaborate').disabled && document.getElementById('schem-status').textContent.startsWith('mips_cpu:'), null, { timeout: 60000 });
    if (await page.locator('#schem-inspector').isVisible()) await page.getByRole('button', { name: 'Close inspector' }).click();
    const wirePaths = () => page.locator('#schem-canvas .schem-wire').evaluateAll(items => items.map(item => item.getAttribute('d')));
    const originalWires = await wirePaths();
    const cell = page.locator('#schem-canvas .schem-cell').first(); const originalTransform = await cell.getAttribute('transform');
    const cellBox = await cell.boundingBox();
    await page.mouse.move(cellBox.x + cellBox.width / 2, cellBox.y + cellBox.height / 2); await page.mouse.down();
    await page.mouse.move(cellBox.x + cellBox.width / 2 + 35, cellBox.y + cellBox.height / 2 + 20, { steps: 6 }); await page.mouse.up();
    assert.notEqual(await cell.getAttribute('transform'), originalTransform);
    const movedWires = await wirePaths();
    const changedWires = movedWires.filter((wire, index) => wire !== originalWires[index]);
    assert.ok(changedWires.length > 0, 'dragging a connected cell reroutes its wires');
    for (const wire of changedWires) {
      const coords = [...wire.matchAll(/[ML]\s+(-?[\d.]+)\s+(-?[\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])]);
      assert.ok(coords.length >= 4, 'rerouted wire has orthogonal elbows');
      for (let i = 1; i < coords.length; i++) assert.ok(coords[i][0] === coords[i - 1][0] || coords[i][1] === coords[i - 1][1], 'wire segments are orthogonal');
    }
    assert.equal(await page.locator('#schem-reset-layout').isDisabled(), false);
    await page.locator('#schem-canvas .schem-port').first().click(); await page.waitForSelector('#schem-inspector:not([hidden])');
    const cardBefore = await page.locator('#schem-inspector').boundingBox(), header = await page.locator('#schem-inspector header').boundingBox();
    await page.mouse.move(header.x + 25, header.y + 8); await page.mouse.down(); await page.mouse.move(header.x - 35, header.y - 25, { steps: 5 }); await page.mouse.up();
    assert.notEqual((await page.locator('#schem-inspector').boundingBox()).x, cardBefore.x);
    await snap(page, '13-wave2-tactile-drag.png');
    await page.locator('#schem-reset-layout').click(); assert.equal(await cell.getAttribute('transform'), originalTransform);
    assert.deepEqual(await wirePaths(), originalWires);
    await page.locator('#schem-inspector [data-action="plot"]').click();
    assert.equal(await page.locator('#waveform').isVisible(), true);
    const track = page.locator('#wave-grid .wave-row[data-path] .wave-track').first(); const trackBox = await track.boundingBox();
    await page.mouse.move(trackBox.x + 30, trackBox.y + 14); await page.mouse.down(); await page.mouse.move(trackBox.x + 180, trackBox.y + 14, { steps: 5 }); await page.mouse.up();
    assert.ok(Number(await page.locator('#wave-zoom').inputValue()) > 1);
    await page.locator('#wave-fit').click(); await page.locator('#marker-a').click();
    const ruler = await page.locator('.wave-ruler .wave-track').boundingBox();
    await page.mouse.click(ruler.x + 80, ruler.y + 10);
    const cursorBefore = await page.locator('#wave-cursor').textContent();
    await page.mouse.move(ruler.x + 80, ruler.y + 3); await page.mouse.down(); await page.mouse.move(ruler.x + 140, ruler.y + 3, { steps: 5 }); await page.mouse.up();
    assert.notEqual(await page.locator('#wave-cursor').textContent(), cursorBefore);
    report.wave2 = { quickOpen: 'passed', formatter: 'passed', quickFix: 'passed', breadcrumbsAndTabs: 'passed', regexReplace: 'passed', schematicDrag: 'passed', plot: 'passed', waveformDrag: 'passed' };
    report.stageC = { strictLint: 'passed', resources: totals, criticalPath: 'passed', responsive: 'passed' };
    assert.deepEqual(report.errors, []);
    await featurePage.close();

    // Regression checks for editor key handling and drags that cross a board redraw.
    const reviewPage = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    reviewPage.on('pageerror', error => report.errors.push(error.message));
    await reviewPage.goto(baseUrl);
    await reviewPage.waitForFunction(() => !document.getElementById('run').disabled);
    await reviewPage.locator('#preferences').click();
    await reviewPage.locator('#emacs-nav').check();
    await reviewPage.locator('#live-lint').uncheck();
    await reviewPage.getByRole('button', { name: 'Done' }).click();
    await reviewPage.getByRole('checkbox', { name: 'Include testbench.v in build' }).uncheck();
    const reviewEditor = reviewPage.locator('#editor .cm-content');
    const reviewSource = 'module review_dut(input clk, input a, input b, output reg q, output reg r);\nalways @(posedge clk) begin\n  q = a;\n  r = b;\nend\nendmodule\n';
    await reviewEditor.fill(reviewSource);
    await reviewPage.waitForFunction(() => [...document.querySelectorAll('#problems .problem-rule')].filter(el => el.textContent === '[BLKSEQ]').length === 2, null, { timeout: 30000 });
    await reviewPage.locator('#editor .cm-line').nth(3).click();
    await reviewPage.keyboard.press('Control+p');
    assert.equal(await reviewPage.locator('#quick-open-dialog').isVisible(), false, 'Emacs Ctrl-p stays in the editor');
    assert.match(await reviewPage.locator('#cursor').textContent(), /Ln 3,/);
    await reviewPage.keyboard.press('Control+Home');
    await reviewPage.keyboard.press('F8'); assert.match(await reviewPage.locator('#cursor').textContent(), /Ln 3,/);
    await reviewPage.keyboard.press('F8'); assert.match(await reviewPage.locator('#cursor').textContent(), /Ln 4,/);
    await reviewPage.keyboard.press('Shift+F8'); assert.match(await reviewPage.locator('#cursor').textContent(), /Ln 3,/);

    await reviewPage.locator('[data-panel="board"]').click();
    await reviewPage.locator('#board-mode-live').click();
    await reviewPage.locator('#board-module').selectOption('review_dut');
    await reviewPage.locator('#board-live-start').click();
    await reviewPage.waitForSelector('#board-live-inputs [data-port="b"] .board-input-name', { timeout: 60000 });
    const cycleBefore = await reviewPage.locator('#board-live-time').textContent();
    await reviewPage.evaluate(() => {
      const handle = document.querySelector('#board-live-inputs [data-port="b"] .board-input-name');
      const transfer = new DataTransfer(); window.reviewBoardDrag = { transfer, original: handle.closest('[data-port]') };
      handle.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    });
    await reviewPage.locator('#board-tick').click();
    await reviewPage.waitForFunction(previous => document.getElementById('board-live-time').textContent !== previous, cycleBefore);
    await reviewPage.evaluate(() => {
      if (window.reviewBoardDrag.original.isConnected) throw new Error('Board did not redraw during drag');
      const target = document.querySelector('#board-live-inputs [data-port="a"]');
      target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: window.reviewBoardDrag.transfer }));
      target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: window.reviewBoardDrag.transfer }));
    });
    const ports = await reviewPage.locator('#board-live-inputs > [data-port]').evaluateAll(rows => rows.map(row => row.dataset.port));
    assert.deepEqual(ports, ['b', 'a'], 'board reorder survives a redraw without duplicate cards');
    await reviewPage.locator('#board-live-stop').click();

    await reviewPage.locator('#files button[data-path="design.v"]').click();
    const editorText = () => reviewPage.evaluate(async () => (await import('./vendor/editor.js')).editorText(document.querySelector('#editor')));
    const beforeDrop = await editorText();
    await reviewPage.evaluate(() => {
      const source = document.querySelector('#files .tree-file[data-path="testbench.v"]');
      const target = document.querySelector('#editor .cm-content'), rect = target.getBoundingClientRect(), transfer = new DataTransfer();
      source.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: transfer }));
      if (transfer.types.includes('text/plain')) throw new Error('Explorer drag exposes filename as text');
      const init = { bubbles: true, cancelable: true, dataTransfer: transfer, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2 };
      target.dispatchEvent(new DragEvent('dragover', init)); target.dispatchEvent(new DragEvent('drop', init));
    });
    await reviewPage.waitForFunction(() => document.getElementById('active-file').textContent.includes('testbench.v'));
    await reviewPage.locator('.active-group .group-tab.selected .tab-close').click();
    await reviewPage.keyboard.press('Alt+Shift+t');
    assert.match(await reviewPage.locator('#active-file').textContent(), /testbench\.v/, 'Alt+Shift+T reopens the closed tab');
    await reviewPage.locator('#files button[data-path="design.v"]').click();
    assert.equal(await editorText(), beforeDrop, 'dropping an Explorer file does not paste its filename');
    assert.deepEqual(report.errors, []);
    report.reviewFixes = { emacs: 'passed', problems: 'passed', explorerDrop: 'passed', boardRedraw: 'passed', reopenFallback: 'passed' };
    await reviewPage.close();
    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
