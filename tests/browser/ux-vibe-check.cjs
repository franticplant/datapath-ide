// Automated UX scenario audit across Desktop (1440x900), Laptop (1280x720), and Phone (412x915).
// Run offline inside Playwright mvm:
//   mvm run -i mcr.microsoft.com/playwright:v1.48.2-jammy -u $(id -u):$(id -g) -- node tests/browser/ux-vibe-check.cjs
const { existsSync, mkdirSync } = require('fs');
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

    console.log(JSON.stringify(report, null, 2));
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
