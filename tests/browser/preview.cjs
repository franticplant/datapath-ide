// Playwright resolution works the same under mvm (build/node_modules) and in CI (npm ci -> node_modules):
// PLAYWRIGHT_MODULE overrides it. Chromium comes from the Playwright image (/ms-playwright) unless
// CHROMIUM_PATH says otherwise. PW_CHROMIUM_SANDBOX=0 only for root CI containers that cannot sandbox.
const { existsSync } = require('fs');
const playwrightModule = process.env.PLAYWRIGHT_MODULE
  || [require('path').join(__dirname, '../../build/node_modules/playwright'), require('path').join(__dirname, '../../node_modules/playwright')].find(existsSync)
  || 'playwright';
const { chromium } = require(playwrightModule);
const chromiumPath = process.env.CHROMIUM_PATH || ['/ms-playwright/chromium-1140/chrome-linux/chrome'].find(existsSync);
const launchOptions = { ...(chromiumPath ? { executablePath: chromiumPath } : {}), chromiumSandbox: process.env.PW_CHROMIUM_SANDBOX !== '0' };
const { createServer } = require('http');
const { readFile } = require('fs/promises');
const { join, extname } = require('path');
const root = join(__dirname, '../../web');
(async () => {
  const server = createServer(async (req, res) => { try { const path = req.url === '/' ? '/index.html' : req.url; const body = await readFile(join(root, path)); res.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }[extname(path)] || 'text/plain' }); res.end(body); } catch { res.writeHead(404); res.end(); } });
  await new Promise(resolve => server.listen(8080, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('http://127.0.0.1:8080/'); await page.waitForFunction(() => !document.getElementById('run').disabled);
    await page.locator('#run').click(); await page.waitForFunction(() => document.querySelector('.engine-state').textContent === 'Complete', null, { timeout: 60000 });
    await page.screenshot({ path: 'build/preview/desktop.png' });
  } finally { if (browser) await browser.close(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
