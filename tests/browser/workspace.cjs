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
const assert = require('assert');

const webRoot = join(__dirname, '../../web');

(async () => {
  const server = createServer(async (req, res) => {
    const reqPath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const data = await readFile(join(webRoot, reqPath));
      const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' }[extname(reqPath)] || 'text/plain';
      res.writeHead(200, { 'Content-Type': type }); res.end(data);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(8080, '127.0.0.1', resolve));
  const baseUrl = 'http://127.0.0.1:8080/';
  let browser;
  try {
    browser = await chromium.launch(launchOptions);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const browserErrors = [];
    page.on('pageerror', error => browserErrors.push(error.message));
    const editorText = () => page.evaluate(async () => (await import('/vendor/editor.js')).editorText(document.querySelector('#editor')));
    await page.goto(baseUrl);
    await page.waitForFunction(() => !document.getElementById('run').disabled);

    // 1. Default simulation on mobile auto-switches to Waveform and enables Download VCD
    await page.locator('#run').click();
    await page.waitForFunction(() => ['Complete', 'Error', 'Engine unavailable'].includes(document.querySelector('.engine-state').textContent), null, { timeout: 60000 });
    assert.equal(await page.locator('.engine-state').first().textContent(), 'Complete', await page.locator('#console-output').textContent());
    assert.equal(await page.locator('body').getAttribute('data-view'), 'waveform');
    assert.ok(await page.locator('.wave-row:not(.wave-ruler)').count() > 0);
    assert.equal(await page.locator('#download-vcd').isDisabled(), false);

    // 2. VCD parser + formatValue unit checks
    const trace = await page.evaluate(async () => {
      const { parseVcd, valueAt } = await import('/vcd.js');
      const { formatValue, formatTime } = await import('/waveform.js');
      const vcd = parseVcd('$timescale 1 ns $end $scope module tb $end $var wire 1 ! clk $end $var wire 4 " bus $end $upscope $end $enddefinitions $end #0 0! bx " #5 1! b1010 " #10 x!');
      return { timescale: vcd.timescale, paths: vcd.signals.map(s => s.path), before: valueAt(vcd.signals[0], -1n), at5: valueAt(vcd.signals[1], 5n), at10: valueAt(vcd.signals[0], 10n), endTime: String(vcd.endTime), hex: formatValue('1x01', 4, 'hex'), bin: formatValue('10', 4, 'bin'), dec: formatValue('1111', 4, 'dec'), signed: formatValue('11111111', 8, 'signed'), ascii: formatValue('01000001', 8, 'ascii'), time: formatTime(25n, '1 ns') };
    });
    assert.deepEqual(trace, { timescale: '1 ns', paths: ['tb.clk', 'tb.bus'], before: null, at5: '1010', at10: 'x', endTime: '10', hex: '0xx', bin: '0b0010', dec: '15', signed: '-1', ascii: 'A', time: '25 ns' });

    // 3. EngineClient stale-runId & force-stop lifecycle checks
    const engine = await page.evaluate(async () => {
      const { EngineClient } = await import('/engine-client.js');
      const workers = []; const events = [];
      const client = new EngineClient(() => { const worker = { postMessage() {}, terminate() { this.terminated = true; } }; workers.push(worker); return worker; }, event => events.push(event));
      client.start(); workers[0].onmessage({ data: { type: 'ready' } });
      const first = client.run({ type: 'run' }); client.stop();
      workers[0].onmessage({ data: { type: 'result', runId: first } });
      workers[1].onmessage({ data: { type: 'ready' } });
      const second = client.run({ type: 'run' });
      workers[1].onmessage({ data: { type: 'output', runId: first } });
      workers[1].onmessage({ data: { type: 'result', runId: second } });
      return { first, second, types: events.map(e => e.type), terminated: workers[0].terminated, ready: client.ready };
    });
    assert.deepEqual(engine, { first: 1, second: 2, types: ['ready', 'stopped', 'ready', 'result'], terminated: true, ready: true });

    // 4. ConsoleBuffer bounded retention checks
    const buffer = await page.evaluate(async () => {
      const { ConsoleBuffer } = await import('/console-buffer.js');
      const log = new ConsoleBuffer(5); log.append('abc'); log.append('def');
      const result = { text: log.text, truncated: log.truncated }; log.clear();
      return { ...result, cleared: log.text, clearFlag: log.truncated };
    });
    assert.deepEqual(buffer, { text: 'bcdef', truncated: true, cleared: '', clearFlag: false });

    // 5. Real Worker: multi-file + `include across subdirs + $readmemh + custom $dumpfile
    const actualEngine = await page.evaluate(async () => {
      const worker = new Worker('/simulator-worker.js', { type: 'module' });
      const events = [];
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('Worker test timed out')); }, 30000);
        worker.onmessage = ({ data }) => {
          events.push(data);
          if (data.type === 'ready') worker.postMessage({ type: 'run', runId: 10, standard: '2005', topModule: 'tb', defines: ['MAGIC=42'], includeDirs: ['inc'], parameters: ['tb.WIDTH=16'], plusargs: ['+hex=data.mem'], warnings: ['all'], specify: true, stopAsFinish: true, sourceFiles: ['src/rom.v', 'src/tb.v'], files: {
            'inc/defs.vh': '`define WIDTH 8\n',
            'src/rom.v': '`include "defs.vh"\nmodule rom(output [`WIDTH-1:0] x); reg [`WIDTH-1:0] mem [0:0]; reg [8*32-1:0] path; initial begin if (!$value$plusargs("hex=%s", path)) path="missing.mem"; $readmemh(path, mem); end assign x = mem[0]; endmodule\n',
            'src/tb.v': 'module tb; parameter WIDTH=8; wire [7:0] x; rom dut(x); initial begin $dumpfile("custom.vcd"); $dumpvars(0,tb); #1 $display("value=%h width=%0d macro=%0d sqrt=%f sin=%f",x,WIDTH,`MAGIC,$sqrt(9.0),$sin(0.0)); $finish; end endmodule\n',
            'data.mem': '2a\n'
          } });
          if (data.type === 'result' || data.type === 'error') { clearTimeout(timer); worker.terminate(); resolve(events); }
        };
        worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
        worker.postMessage({ type: 'init' });
      });
    });
    assert.equal(actualEngine.at(-1).type, 'result', JSON.stringify(actualEngine));
    assert.ok(actualEngine.some(event => event.type === 'output' && event.chunk.includes('value=2a width=16 macro=42 sqrt=3.000000 sin=0.000000')), JSON.stringify(actualEngine));
    assert.equal(actualEngine.at(-1).vcdFiles[0].path, 'custom.vcd');
    assert.ok(actualEngine.at(-1).vcdFiles[0].data.includes('$enddefinitions'));
    const stopEngine = await page.evaluate(async () => {
      const worker = new Worker('/simulator-worker.js', { type: 'module' }); const events = [];
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('$stop test timed out')); }, 30000);
        worker.onmessage = ({ data }) => { events.push(data); if (data.type === 'ready') worker.postMessage({ type: 'run', runId: 11, standard: '2005', topModule: 'tb', stopAsFinish: true, outputCap: 4096, files: { 'tb.v': 'module tb; integer i; initial begin for (i=0;i<1000;i=i+1) $display("long output line %0d",i); $stop; $display("AFTER_STOP"); end endmodule' } }); if (data.type === 'result' || data.type === 'error') { clearTimeout(timer); worker.terminate(); resolve(events); } };
        worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); };
        worker.postMessage({ type: 'init' });
      });
    });
    assert.equal(stopEngine.at(-1).type, 'result', JSON.stringify(stopEngine));
    assert.ok(stopEngine.some(event => event.type === 'output' && event.chunk.includes('Output limit reached')));
    assert.ok(!stopEngine.some(event => event.type === 'output' && event.chunk.includes('AFTER_STOP')));
    const stopSemantics = await page.evaluate(async () => {
      const worker = new Worker('/simulator-worker.js', { type: 'module' }); const events = [];
      return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { worker.terminate(); reject(new Error('$stop semantics test timed out')); }, 30000);
        worker.onmessage = ({ data }) => { events.push(data); if (data.type === 'ready') worker.postMessage({ type: 'run', runId: 12, standard: '2005', topModule: 'tb', stopAsFinish: true, files: { 'tb.v': 'module tb; initial begin $display("BEFORE_STOP"); $stop; $display("AFTER_STOP"); end endmodule' } }); if (data.type === 'result' || data.type === 'error') { clearTimeout(timer); worker.terminate(); resolve(events); } };
        worker.onerror = event => { clearTimeout(timer); worker.terminate(); reject(new Error(event.message)); }; worker.postMessage({ type: 'init' });
      });
    });
    assert.equal(stopSemantics.at(-1).type, 'result', JSON.stringify(stopSemantics));
    assert.ok(stopSemantics.some(event => event.type === 'output' && event.chunk.includes('BEFORE_STOP')));
    assert.ok(!stopSemantics.some(event => event.type === 'output' && event.chunk.includes('AFTER_STOP')));

    // 6. Desktop: Compile syntax error -> Problems clickable file:line jump
    await page.setViewportSize({ width: 1440, height: 900 });
    const initialExplorer = await page.locator('.sidebar').boundingBox();
    await page.locator('#explorer-splitter').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(Math.round((await page.locator('.sidebar').boundingBox()).width), Math.round(initialExplorer.width) + 10);
    const splitter = await page.locator('#explorer-splitter').boundingBox();
    await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + 20);
    await page.mouse.down(); await page.mouse.move(splitter.x + splitter.width / 2 + 20, splitter.y + 20); await page.mouse.up();
    assert.equal(Math.round((await page.locator('.sidebar').boundingBox()).width), Math.round(initialExplorer.width) + 30);
    await page.locator('#toggle-explorer').click();
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    assert.equal(await page.locator('.sidebar').isVisible(), true);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#toggle-explorer').click();
    await page.locator('#toggle-inspector').click();
    assert.equal(await page.locator('.inspector').isVisible(), false);
    await page.locator('#toggle-inspector').click();
    await page.locator('#maximize-dock').click();
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('dock-maximized')), true);
    assert.equal(await page.locator('#maximize-dock').getAttribute('aria-pressed'), 'true');
    await page.locator('#maximize-dock').click();
    await page.locator('#preferences').click();
    await page.locator('#font-size').selectOption('16');
    await page.locator('#tab-width').selectOption('4');
    await page.locator('#editor-theme').selectOption('light');
    await page.locator('#word-wrap').check();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('compile').disabled);
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'light');
    assert.equal(await page.locator('#font-size').inputValue(), '16');
    assert.equal(await page.locator('#tab-width').inputValue(), '4');
    assert.equal(await page.locator('#word-wrap').isChecked(), true);
    await page.locator('#files button', { hasText: 'design.v' }).click();
    const originalDesign = await editorText();
    await page.locator('#editor .cm-content').fill('module demo;\nendmodule\n');
    await page.locator('.cm-foldGutter [title="Fold line"]').first().click();
    assert.ok(await page.locator('.cm-foldPlaceholder').count() > 0);
    await page.locator('.cm-foldPlaceholder').first().click();
    await page.locator('#editor .cm-content').press('Control+h');
    assert.equal(await page.locator('.cm-search input[name="replace"]').isVisible(), true);
    await page.locator('.cm-search input[name="replace"]').press('Escape');
    await page.locator('#editor .cm-content').press('Control+Home');
    await page.locator('#editor .cm-content').press('Control+/');
    assert.match(await editorText(), /^\/\/ ?module demo;/);
    await page.locator('#editor .cm-content').press('Control+z');
    assert.ok((await editorText()).startsWith('module demo;'));
    await page.locator('#editor .cm-content').press('Tab');
    assert.ok((await editorText()).startsWith('    module demo;'));
    await page.locator('#editor .cm-content').press('Shift+Tab');
    assert.ok((await editorText()).startsWith('module demo;'));
    await page.locator('#editor .cm-content').press('Control+g');
    assert.ok(await page.locator('.cm-panel input').count() >= 1);
    await page.locator('.cm-panel input').first().fill('2');
    await page.locator('.cm-panel input').first().press('Enter');
    assert.ok((await page.locator('#cursor').textContent()).startsWith('Ln 2,'));
    await page.locator('#editor .cm-content').fill('module broken;\n  wire a;\n  syntax error here;\nendmodule\n');
    await page.locator('#compile').click();
    await page.waitForFunction(() => document.querySelector('.engine-state').textContent === 'Error', null, { timeout: 30000 });
    assert.equal(await page.locator('#problems').isVisible(), true);
    assert.ok(await page.locator('.problem-item').count() >= 1);
    assert.ok(await page.locator('.cm-diagnostic-line').count() >= 1);
    assert.ok((await page.locator('.problem-loc').first().textContent()).includes('design.v:3'));
    await page.locator('.problem-item').first().click();
    assert.ok((await page.locator('#cursor').textContent()).startsWith('Ln 3,'));
    await page.locator('#editor .cm-content').fill(originalDesign);

    // 7. Live Stop on an infinite loop + automatic engine restart + recovery Run
    await page.locator('#files button', { hasText: 'testbench.v' }).click();
    const originalTb = await editorText();
    await page.locator('#editor .cm-content').fill('module testbench;\n  reg clk = 0;\n  always #5 clk = ~clk;\nendmodule\n');
    await page.locator('#run').click();
    await page.waitForFunction(() => !document.getElementById('stop').disabled, null, { timeout: 10000 });
    await page.locator('#stop').click();
    await page.waitForFunction(() => document.querySelector('.engine-state').textContent === 'Icarus WASM ready', null, { timeout: 15000 });
    assert.ok((await page.locator('#console-output').textContent()).includes('force-stopped'));
    assert.equal(await page.locator('#download-vcd').isDisabled(), true);
    await page.locator('#editor .cm-content').fill(originalTb);
    await page.locator('#run').click();
    await page.waitForFunction(() => document.querySelector('.engine-state').textContent === 'Complete', null, { timeout: 30000 });
    assert.ok(await page.locator('.wave-row:not(.wave-ruler)').count() > 0);

    // 8. Mobile file CRUD, persistence, and VCD ruler/cursor/zero-duration checks
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'New file' }).click();
    await page.getByRole('button', { name: 'Cancel' }).click();
    assert.equal(await page.locator('#new-dialog').isVisible(), false);
    await page.getByRole('button', { name: 'New file' }).click();
    await page.locator('#new-name').fill('src/test.v');
    await page.getByRole('button', { name: 'Create file' }).click();
    assert.equal(await page.locator('body').getAttribute('data-view'), 'code');
    await page.locator('#editor .cm-content').fill('module test; endmodule\n');
    await page.getByRole('button', { name: 'Inspect', exact: true }).click();
    await page.locator('#top-module').fill('test');
    await page.reload();
    assert.equal(await editorText(), 'module test; endmodule\n');
    assert.equal(await page.locator('#top-module').inputValue(), 'test');
    await page.getByRole('button', { name: 'Console', exact: true }).last().click();
    await page.getByRole('tab', { name: 'Problems' }).click();
    assert.equal(await page.locator('#problems').isVisible(), true);
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    await page.getByRole('button', { name: 'Waveform', exact: true }).last().click();
    await page.locator('#vcd-input').setInputFiles({ name: 'sample.vcd', mimeType: 'text/plain', buffer: Buffer.from('$timescale 1 ns $end $scope module tb $end $var wire 1 ! clk $end $upscope $end $enddefinitions $end #0 0! #5 1! #10') });
    await page.waitForFunction(() => document.querySelectorAll('.wave-row:not(.wave-ruler)').length === 1);
    assert.equal(await page.locator('.wave-row:not(.wave-ruler)').count(), 1);
    assert.equal(await page.locator('.wave-label span').textContent(), 'tb.clk');
    assert.equal(await page.getByRole('combobox', { name: 'Radix for tb.clk', includeHidden: true }).isVisible(), false);
    await page.setViewportSize({ width: 1440, height: 900 });
    assert.equal(await page.getByRole('combobox', { name: 'Radix for tb.clk' }).isVisible(), true);
    await page.locator('.wave-row:not(.wave-ruler) canvas.wave-trace').click({ position: { x: 360, y: 15 } });
    assert.equal(await page.locator('.wave-label strong').textContent(), '1');
    await page.locator('.wave-ruler canvas').click({ position: { x: 0, y: 15 } });
    assert.equal(await page.locator('.wave-label strong').textContent(), '0');
    await page.locator('#signal-picker > summary').click();
    await page.getByRole('checkbox', { name: 'Show tb.clk' }).uncheck();
    assert.equal(await page.locator('.wave-row:not(.wave-ruler)').count(), 0);
    await page.getByRole('checkbox', { name: 'Show tb.clk' }).check();
    await page.locator('#signal-picker > summary').click();
    await page.locator('#marker-b').click();
    await page.locator('.wave-ruler canvas').click({ position: { x: 360, y: 15 } });
    assert.match(await page.locator('#wave-cursor').textContent(), /B: 5 ns.*Δ: 5 ns/);
    await page.locator('#previous-edge').click();
    assert.match(await page.locator('#wave-cursor').textContent(), /B: 0 ns/);
    await page.locator('#next-edge').click();
    assert.match(await page.locator('#wave-cursor').textContent(), /B: 5 ns/);
    await page.locator('#wave-zoom-in').click();
    assert.equal(await page.locator('#wave-zoom').inputValue(), '2');
    await page.locator('#wave-fit').click();
    assert.equal(await page.locator('#wave-zoom').inputValue(), '1');
    await page.locator('#inspector-filter').fill('clk');
    await page.getByRole('button', { name: 'Pin tb.clk' }).click();
    assert.equal(await page.getByRole('button', { name: 'Unpin tb.clk' }).getAttribute('aria-pressed'), 'true');
    await page.locator('#vcd-input').setInputFiles({ name: 'two.vcd', mimeType: 'text/plain', buffer: Buffer.from('$timescale 1 ns $end $scope module tb $end $var wire 1 ! clk $end $var wire 8 " data $end $upscope $end $enddefinitions $end #0 0! b11111111 " #5 1! b01000001 " #10 0! b01000010 "') });
    await page.waitForSelector('.wave-row[data-path="tb.data"]');
    await page.getByRole('combobox', { name: 'Radix for tb.data' }).selectOption('signed');
    assert.equal(await page.locator('.wave-row[data-path="tb.data"] strong').textContent(), '-1');
    await page.locator('.wave-row[data-path="tb.data"] .wave-label').dragTo(page.locator('.wave-row[data-path="tb.clk"] .wave-label'));
    assert.deepEqual(await page.locator('.wave-row:not(.wave-ruler)').evaluateAll(rows => rows.map(row => row.dataset.path)), ['tb.data', 'tb.clk']);
    await page.locator('#marker-b').click();
    const rulerRect = await page.locator('.wave-ruler canvas').boundingBox();
    await page.mouse.move(rulerRect.x + 10, rulerRect.y + 15); await page.mouse.down(); await page.mouse.move(rulerRect.x + 360, rulerRect.y + 15); await page.mouse.up();
    assert.match(await page.locator('#wave-cursor').textContent(), /B: 5 ns.*Δ: 5 ns/);
    await page.getByRole('combobox', { name: 'Radix for tb.data' }).selectOption('ascii');
    assert.equal(await page.locator('.wave-row[data-path="tb.data"] strong').textContent(), 'A');
    await page.locator('#signal-picker > summary').click();
    await page.locator('#signal-filter').fill('data');
    assert.equal(await page.getByRole('checkbox', { name: 'Show tb.data' }).count(), 1);
    assert.equal(await page.getByRole('checkbox', { name: 'Show tb.clk' }).count(), 0);
    await page.locator('#signal-picker > summary').click();
    await page.locator('.wave-row[data-path="tb.data"] canvas.wave-trace').hover({ position: { x: 100, y: 15 } });
    await page.mouse.wheel(0, -100);
    assert.equal(await page.locator('#wave-zoom').inputValue(), '2');
    await page.locator('#wave-grid').evaluate(element => { element.scrollLeft = 0; });
    const traceRect = await page.locator('.wave-row[data-path="tb.data"] canvas.wave-trace').boundingBox();
    await page.keyboard.down('Shift'); await page.mouse.move(traceRect.x + 150, traceRect.y + 15); await page.mouse.down(); await page.mouse.move(traceRect.x + 60, traceRect.y + 15); await page.mouse.up(); await page.keyboard.up('Shift');
    assert.ok(await page.locator('#wave-grid').evaluate(element => element.scrollLeft) > 0);
    await page.locator('#wave-fit').click();
    await page.locator('#vcd-input').setInputFiles({ name: 'zero.vcd', mimeType: 'text/plain', buffer: Buffer.from('$scope module tb $end $var wire 1 ! clk $end $upscope $end $enddefinitions $end #0 1!') });
    await page.waitForFunction(() => document.querySelectorAll('.wave-row:not(.wave-ruler)').length === 1);
    assert.equal(await page.locator('.wave-row:not(.wave-ruler) canvas.wave-trace').first().getAttribute('data-width'), '720');
    await page.getByRole('button', { name: 'Rename', exact: true }).click();
    await page.locator('#rename-name').fill('src/renamed.v');
    await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
    assert.equal(await page.locator('#active-file').textContent(), 'Active: src/renamed.v');
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('button', { name: 'Delete file', exact: true }).click();
    assert.equal(await page.locator('#active-file').textContent(), 'Active: testbench.v');
    await page.reload();
    assert.equal(await page.getByRole('button', { name: 'src/renamed.v', exact: true }).count(), 0);

    // 9. Project tree, per-file build set, inline rename and archive round-trip.
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    await page.locator('#new-folder').click();
    await page.locator('#folder-name').fill('assets/empty');
    await page.locator('#create-folder').click();
    assert.equal(await page.locator('[data-path="assets/empty"]').count(), 1);
    await page.locator('#new-file').click();
    await page.locator('#new-name').fill('rtl/bad.v');
    await page.locator('#create-file').click();
    await page.locator('#editor .cm-content').fill('this is not valid verilog\n');
    await page.getByRole('button', { name: 'Actions for rtl/bad.v' }).click();
    await page.getByRole('button', { name: 'Exclude from build' }).click();
    assert.ok((await page.locator('[data-path="rtl/bad.v"]').textContent()).includes('excluded'));
    await page.locator('#top-module').fill('');
    await page.locator('#compile').click();
    await page.waitForFunction(() => ['Complete', 'Error'].includes(document.querySelector('.engine-state').textContent), null, { timeout: 30000 });
    assert.equal(await page.locator('.engine-state').first().textContent(), 'Complete', await page.locator('#console-output').textContent());
    await page.locator('[data-path="rtl/bad.v"]').focus();
    await page.keyboard.press('F2');
    await page.getByRole('textbox', { name: 'Rename rtl/bad.v' }).fill('rtl/renamed.v');
    await page.getByRole('textbox', { name: 'Rename rtl/bad.v' }).press('Enter');
    assert.equal(await page.locator('[data-path="rtl/renamed.v"]').count(), 1);
    assert.ok(await page.evaluate(() => Object.hasOwn(JSON.parse(localStorage.getItem('datapath.workspace.v1')).files, 'rtl/renamed.v')), await page.locator('#save-state').textContent());
    await page.reload();
    assert.ok((await page.locator('[data-path="rtl/renamed.v"]').textContent()).includes('excluded'));
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-project').click();
    const download = await downloadPromise;
    const zipBytes = await readFile(await download.path());
    await page.locator('#project-input').setInputFiles({ name: 'project.zip', mimeType: 'application/zip', buffer: zipBytes });
    await page.waitForSelector('#conflict-dialog[open]');
    assert.equal(await page.locator('#conflict-dialog').isVisible(), true);
    await page.locator('[data-conflict="keep"]').click();
    await page.waitForSelector('[data-path="rtl/renamed-copy1.v"]');
    assert.equal(await page.locator('[data-path="rtl/renamed-copy1.v"]').count(), 1);
    assert.ok((await page.locator('[data-path="rtl/renamed-copy1.v"]').textContent()).includes('excluded'));
    await page.getByRole('button', { name: 'Actions for folder rtl' }).click();
    await page.getByRole('button', { name: 'Duplicate', exact: true }).click();
    assert.equal(await page.locator('[data-path="rtl-copy1/renamed.v"]').count(), 1);
    await page.locator('[data-path="rtl-copy1"]').focus();
    await page.keyboard.press('F2');
    await page.getByRole('textbox', { name: 'Rename rtl-copy1' }).fill('hardware');
    await page.getByRole('textbox', { name: 'Rename rtl-copy1' }).press('Enter');
    assert.equal(await page.locator('[data-path="hardware/renamed.v"]').count(), 1);
    await page.evaluate(() => { const transfer = new DataTransfer(); transfer.items.add(new File(['de\nad\n'], 'drop.mem', { type: 'text/plain' })); document.getElementById('files').dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: transfer })); });
    await page.waitForSelector('[data-path="drop.mem"]');
    const rejectedArchive = await page.evaluate(async () => { const { zipSync, strToU8 } = await import('/vendor/zip.js'); const { readArchive } = await import('/archive.js'); try { readArchive(zipSync({ '../escape.v': strToU8('bad') })); return false; } catch { return true; } });
    assert.equal(rejectedArchive, true);
    await page.locator('#templates').click();
    await page.locator('[data-template="rom"]').click();
    assert.ok((await page.locator('[data-path="examples/rom/rom.v"]').textContent()).includes('excluded'));
    await page.locator('#advanced-settings summary').click();
    await page.locator('#defines').fill('MAGIC=42');
    await page.locator('#include-dirs').fill('inc');
    await page.locator('#parameters').fill('tb.WIDTH=16');
    await page.locator('#plusargs').fill('+hex=data.mem');
    await page.locator('[data-warning="implicit"]').check();
    await page.locator('#specify').check();
    await page.locator('#output-cap').fill('64');
    await page.locator('#vcd-cap').fill('2');
    const beforeOrder = await page.locator('#source-order label span').allTextContents();
    await page.locator('#source-order button[aria-label^="Move "][aria-label$=" down"]').first().click();
    const afterOrder = await page.locator('#source-order label span').allTextContents();
    assert.equal(afterOrder[0], beforeOrder[1]);
    await page.reload();
    await page.locator('#advanced-settings summary').click();
    assert.equal(await page.locator('#defines').inputValue(), 'MAGIC=42');
    assert.equal(await page.locator('#parameters').inputValue(), 'tb.WIDTH=16');
    assert.equal(await page.locator('#plusargs').inputValue(), '+hex=data.mem');
    assert.equal(await page.locator('[data-warning="implicit"]').isChecked(), true);
    assert.equal(await page.locator('#specify').isChecked(), true);
    assert.equal(await page.locator('#output-cap').inputValue(), '64');
    assert.equal(await page.locator('#vcd-cap').inputValue(), '2');
    assert.deepEqual(await page.locator('#source-order label span').allTextContents(), afterOrder);

    // 11. Pass 5: Workspace modes (Edit/Run/Wave/Zen), dock collapse, footer toggles, command palette, console/run/wave/explorer toggles
    await page.locator('#mode-edit').click();
    assert.equal(await page.locator('.bottom').isVisible(), false);
    await page.locator('#mode-run').click();
    assert.equal(await page.locator('.bottom').isVisible(), true);
    assert.equal(await page.locator('.inspector').isVisible(), true);
    assert.equal(await page.locator('.sidebar').isVisible(), false);
    await page.locator('#mode-wave').click();
    assert.equal(await page.locator('#editor').isVisible(), false);
    assert.equal(await page.locator('#waveform').isVisible(), true);
    await page.locator('#mode-zen').click();
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('is-zen')), true);
    assert.equal(await page.locator('.topbar').isVisible(), false);
    assert.equal(await page.locator('#zen-bar').isVisible(), true);
    await page.locator('#exit-zen').click();
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('is-zen')), false);
    await page.locator('#toggle-explorer').click();

    await page.keyboard.press('Control+j');
    assert.equal(await page.locator('.bottom').isVisible(), false);
    await page.keyboard.press('Control+j');
    assert.equal(await page.locator('.bottom').isVisible(), true);

    const wrapBefore = await page.locator('#footer-wrap').textContent();
    await page.locator('#footer-wrap').click();
    assert.notEqual(await page.locator('#footer-wrap').textContent(), wrapBefore);
    const tabBefore = await page.locator('#footer-tab').textContent();
    await page.locator('#footer-tab').click();
    assert.notEqual(await page.locator('#footer-tab').textContent(), tabBefore);

    await page.keyboard.press('Control+Shift+p');
    assert.equal(await page.locator('#palette-dialog').isVisible(), true);
    await page.locator('#palette-input').fill('Line Numbers');
    await page.locator('#palette-input').press('Enter');
    assert.equal(await page.locator('#editor').evaluate(el => el.classList.contains('hide-line-numbers')), true);
    await page.keyboard.press('Control+Shift+p');
    await page.locator('#palette-input').fill('Line Numbers');
    await page.locator('#palette-input').press('Enter');
    assert.equal(await page.locator('#editor').evaluate(el => el.classList.contains('hide-line-numbers')), false);

    // Exclude duplicate copy files from Section 9 ZIP conflict test using 1-click Explorer build toggles
    await page.locator('#files').getByRole('checkbox', { name: 'Include design-copy1.v in build' }).uncheck();
    await page.locator('#files').getByRole('checkbox', { name: 'Include testbench-copy1.v in build' }).uncheck();

    // Run with auto-switch-wave disabled -> stays on Console while VCD loads
    await page.locator('#defines').fill('');
    await page.locator('#include-dirs').fill('');
    await page.locator('#parameters').fill('');
    await page.locator('#plusargs').fill('');
    await page.locator('#preferences').click();
    await page.locator('#auto-switch-wave').uncheck();
    await page.getByRole('button', { name: 'Done' }).click();
    await page.locator('#top-module').fill('testbench');
    await page.locator('#run').click();
    await page.waitForFunction(() => ['Complete', 'Error'].includes(document.querySelector('.engine-state').textContent), null, { timeout: 30000 });
    assert.equal(await page.locator('.engine-state').first().textContent(), 'Complete', await page.locator('#console-output').textContent());
    assert.equal(await page.locator('#console').isVisible(), true);
    assert.equal(await page.locator('#download-vcd').isDisabled(), false);
    await page.locator('#clear-console').click();
    assert.equal(await page.locator('#console-output').textContent(), '');
    await page.locator('#preferences').click();
    await page.locator('#auto-switch-wave').check();
    await page.getByRole('button', { name: 'Done' }).click();

    // Waveform toggles: short names, gridlines, clear marker B, snap
    await page.getByRole('tab', { name: 'Waveform' }).click();
    await page.locator('#vcd-input').setInputFiles({ name: 'hier.vcd', mimeType: 'text/plain', buffer: Buffer.from('$timescale 1 ns $end $scope module tb $end $scope module dut $end $var wire 1 ! clk $end $var wire 8 " data $end $upscope $end $upscope $end $enddefinitions $end #0 0! b00001010 " #5 1! b00010100 " #10 0!') });
    await page.waitForSelector('.wave-row[data-path="tb.dut.clk"]');
    await page.locator('#wave-short-names').click();
    assert.equal(await page.locator('.wave-row[data-path="tb.dut.clk"] .wave-label span').textContent(), 'clk');
    await page.locator('#wave-short-names').click();
    assert.equal(await page.locator('.wave-row[data-path="tb.dut.clk"] .wave-label span').textContent(), 'tb.dut.clk');
    await page.locator('#wave-gridlines').click();
    assert.ok(await page.locator('canvas.wave-trace[data-gridlines="true"]').count() > 0);
    await page.locator('#marker-b').click();
    await page.locator('#clear-marker-b').click();
    assert.match(await page.locator('#wave-cursor').textContent(), /B: —/);
    await page.locator('#wave-snap').click();
    assert.equal(await page.locator('#wave-snap').getAttribute('aria-pressed'), 'true');

    // Explorer hide-excluded filter toggle
    await page.locator('#toggle-excluded-visibility').click();
    assert.equal(await page.locator('#toggle-excluded-visibility').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-path="examples/rom/rom.v"]').count(), 0);
    await page.locator('#toggle-excluded-visibility').click();
    assert.equal(await page.locator('[data-path="examples/rom/rom.v"]').count(), 1);

    // 12. mars-ide overhaul: 9 themes + persistence, live hint + Reference Card, autocomplete, Ctrl+click inspect card, split editor groups + Zen, mobile Verilog keybar + More sheet
    await page.locator('#preferences').click();
    await page.locator('[data-theme-card="tokyo-night"]').click();
    await page.locator('#syntax-theme').selectOption('dracula');
    await page.getByRole('button', { name: 'Done' }).click();
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    assert.equal(await page.locator('body').getAttribute('data-theme'), 'tokyo-night');
    await page.locator('#preferences').click();
    assert.equal(await page.locator('#syntax-theme').inputValue(), 'dracula');
    await page.locator('[data-theme-card="amoled"]').click();
    await page.locator('#syntax-theme').selectOption('auto');
    await page.getByRole('button', { name: 'Done' }).click();

    await page.getByRole('tab', { name: 'Waveform' }).click();
    await page.locator('#vcd-input').setInputFiles({ name: 'inspect.vcd', mimeType: 'text/plain', buffer: Buffer.from('$timescale 1 ns $end $scope module tb $end $scope module dut $end $var wire 1 ! clk $end $var wire 8 " data $end $upscope $end $upscope $end $enddefinitions $end #0 0! b00101010 " #5 1! b01000001 "') });
    await page.waitForSelector('.wave-row[data-path="tb.dut.data"]');

    await page.locator('#files button', { hasText: 'design.v' }).click();
    const designBackup = await editorText();
    await page.locator('#editor .cm-content').fill('data\n$readmemh\n');
    await page.locator('#editor .cm-line').nth(1).click();
    assert.match(await page.locator('#hint').textContent(), /\$readmemh/);
    await page.locator('#hint').click();
    assert.equal(await page.locator('#help-dialog').isVisible(), true);
    assert.match(await page.locator('#help-filter').inputValue(), /readmemh/i);
    await page.locator('#close-help').click();

    await page.locator('#editor .cm-content').click();
    await page.keyboard.press('Control+Space');
    await page.waitForSelector('.cm-tooltip-autocomplete');
    assert.equal(await page.locator('.cm-tooltip-autocomplete').isVisible(), true);
    await page.keyboard.press('Escape');

    await page.locator('#editor .cm-line').first().click({ position: { x: 10, y: 8 }, modifiers: ['Control'] });
    assert.equal(await page.locator('#value-popover').isVisible(), true);
    assert.match(await page.locator('#value-popover').textContent(), /0x2a|0b00101010/);
    await page.locator('#pop-pin').click();
    assert.equal(await page.locator('#pop-pin').textContent(), 'Unpin');
    await page.locator('#pop-close').click();

    await page.locator('.active-group .group-actions button[aria-label="Split right"]').click();
    assert.equal(await page.locator('.editor-group').count(), 2);
    await page.locator('#editor .cm-content').fill('module synced_split;\nendmodule\n');
    const firstPaneText = await page.evaluate(async () => (await import('/vendor/editor.js')).editorText(document.querySelectorAll('.editor-group')[0].querySelector('.group-body')));
    assert.equal(firstPaneText, 'module synced_split;\nendmodule\n');
    await page.keyboard.press('F10');
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('is-zen')), true);
    assert.equal(await page.locator('.editor-group').count(), 2);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('is-zen')), false);
    await page.locator('.active-group .tab-close').click();
    assert.equal(await page.locator('.editor-group').count(), 1);
    await page.locator('#editor .cm-content').fill(designBackup);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Code', exact: true }).click();
    await page.locator('#editor .cm-content').click();
    assert.equal(await page.locator('#keybar').isVisible(), true);
    await page.locator('[data-kb-key="<="]').dispatchEvent('pointerdown', { bubbles: true });
    await page.locator('[data-kb-key="<="]').dispatchEvent('pointerup', { bubbles: true });
    assert.ok((await editorText()).includes('<='));
    await page.locator('[data-kb-key="size"]').dispatchEvent('pointerdown', { bubbles: true });
    await page.locator('[data-kb-key="size"]').dispatchEvent('pointerup', { bubbles: true });
    assert.equal(await page.locator('body').getAttribute('data-kb'), 'l');
    await page.locator('[data-kb-key="rows"]').dispatchEvent('pointerdown', { bubbles: true });
    await page.locator('[data-kb-key="rows"]').dispatchEvent('pointerup', { bubbles: true });
    assert.equal(await page.locator('body').evaluate(el => el.classList.contains('kb2')), true);
    await page.locator('#mobile-more').click();
    assert.equal(await page.locator('#more-dialog').isVisible(), true);
    await page.locator('#close-more').click();
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.locator('#editor .cm-content').fill(designBackup);

    // 13. Stage 1: wave setup persists across re-run, canvas transport + value search, batch testbench runner,
    //     console coloring/filter, Verilog-2001, .mem MIPS decode, workspace search, F12 go-to-definition, IndexedDB storage
    const engineDone = async () => {
      await page.waitForFunction(() => ['Complete', 'Error'].includes(document.querySelector('.engine-state').textContent), null, { timeout: 60000 });
      assert.equal(await page.locator('.engine-state').first().textContent(), 'Complete', await page.locator('#console-output').textContent());
    };
    const waveCursor = () => page.locator('#wave-cursor').textContent();
    await page.locator('#top-module').fill('testbench');
    await page.locator('#run').click();
    await engineDone();
    await page.waitForSelector('.wave-row[data-path="testbench.count"]');
    assert.equal(await page.locator('.wave-row[data-path="testbench.count"] canvas.wave-trace').count(), 1);
    assert.equal(await page.locator('#wave-grid svg').count(), 0);
    assert.equal(await page.locator('.wave-ruler canvas').count(), 1);
    assert.ok(Number(await page.locator('.wave-row[data-path="testbench.count"] canvas.wave-trace').evaluate(canvas => canvas.width)) > 0);
    await page.locator('#signal-picker > summary').click();
    await page.getByRole('checkbox', { name: 'Show testbench.reset', exact: true }).uncheck();
    await page.locator('#signal-picker > summary').click();
    await page.getByRole('combobox', { name: 'Radix for testbench.count', exact: true }).selectOption('bin');
    await page.locator('#inspector-filter').fill('testbench.count');
    await page.getByRole('button', { name: 'Pin testbench.count', exact: true }).click();
    const orderBefore = await page.locator('.wave-row:not(.wave-ruler)').evaluateAll(rows => rows.map(row => row.dataset.path));
    await page.locator('#run').click();
    await engineDone();
    await page.waitForSelector('.wave-row[data-path="testbench.count"]');
    assert.equal(await page.locator('.wave-row[data-path="testbench.reset"]').count(), 0);
    assert.equal(await page.getByRole('combobox', { name: 'Radix for testbench.count', exact: true }).inputValue(), 'bin');
    assert.equal(await page.getByRole('button', { name: 'Unpin testbench.count', exact: true }).count(), 1);
    assert.deepEqual(await page.locator('.wave-row:not(.wave-ruler)').evaluateAll(rows => rows.map(row => row.dataset.path)), orderBefore);
    await page.locator('#inspector-filter').fill('');

    await page.locator('.wave-row[data-path="testbench.count"] .wave-label span').click();
    await page.locator('#wave-value-search').fill('3');
    await page.locator('#wave-value-find').click();
    assert.match(await waveCursor(), /A: 35 ns/);
    assert.equal(await page.locator('.wave-row[data-path="testbench.count"] strong').textContent(), '0b0011');
    await page.locator('#wave-value-search').fill("4'b0101");
    await page.locator('#wave-value-search').press('Enter');
    assert.match(await waveCursor(), /A: 55 ns/);
    await page.locator('#wave-value-search').fill('0x3');
    await page.locator('#wave-value-find').click();
    assert.match(await waveCursor(), /A: 35 ns/);
    await page.locator('#wave-value-search').fill('f');
    await page.locator('#wave-value-find').click();
    assert.match(await page.locator('#wave-error').textContent(), /No transition/);
    assert.match(await waveCursor(), /A: 35 ns/);
    await page.locator('#wave-step-next').click();
    assert.match(await waveCursor(), /A: 45 ns/);
    await page.locator('#wave-step-prev').click();
    assert.match(await waveCursor(), /A: 35 ns/);
    await page.locator('#wave-play').click();
    assert.equal(await page.locator('#wave-play').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.getElementById('wave-play').getAttribute('aria-pressed') === 'false', null, { timeout: 10000 });
    assert.match(await waveCursor(), /A: 55 ns/);
    assert.equal(await page.locator('.wave-row[data-path="testbench.count"] strong').textContent(), '0b0101');
    const searchUnits = await page.evaluate(async () => {
      const { parseSearchValue } = await import('/sim-trace.js');
      return ['0x1F', "8'hff", '0b101', "'d12", '12', 'ab'].map(value => String(parseSearchValue(value)));
    });
    assert.deepEqual(searchUnits, ['31', '255', '5', '12', '12', '171']);
    await page.locator('#signal-picker > summary').click();
    await page.getByRole('checkbox', { name: 'Show testbench.reset', exact: true }).check();
    await page.locator('#signal-picker > summary').click();

    const createFile = async (path, text) => {
      await page.locator('#new-file').click();
      await page.locator('#new-name').fill(path);
      await page.locator('#create-file').click();
      await page.locator('#editor .cm-content').fill(text);
    };
    await createFile('suite/alu.v', '`define ALU_W 4\nmodule alu_core;\n  reg [`ALU_W-1:0] r = 4\'d5;\nendmodule\n');
    await createFile('suite/tb_pass.v', 'module tb_pass;\nalu_core u0();\ninitial begin\n  $dumpfile("ok.vcd");\n  $dumpvars(0, tb_pass);\n  #1 $display("WARNING: slow path");\n  $display("PASS: adder ok");\n  $finish;\nend\nendmodule\n');
    await createFile('suite/tb_fail.v', 'module tb_fail;\nalu_core u0();\ninitial begin\n  #1 $display("FAIL: expected 6 got %0d", u0.r);\n  $finish;\nend\nendmodule\n');
    await page.getByRole('tab', { name: 'Tests' }).click();
    assert.equal(await page.locator('#tests').isVisible(), true);
    assert.equal(await page.getByRole('checkbox', { name: 'Testbench suite/tb_pass.v', exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: 'Testbench suite/tb_fail.v', exact: true }).isChecked(), true);
    assert.equal(await page.getByRole('checkbox', { name: 'Testbench suite/alu.v', exact: true }).isChecked(), false);
    assert.equal(await page.getByRole('checkbox', { name: 'Testbench design.v', exact: true }).isChecked(), false);
    assert.equal(await page.getByRole('checkbox', { name: 'Testbench testbench.v', exact: true }).isChecked(), true);
    await page.getByRole('checkbox', { name: 'Testbench testbench.v', exact: true }).uncheck();
    const suiteDone = () => page.waitForFunction(() => !document.getElementById('run-all-tests').disabled
      && document.querySelectorAll('#tests-results tbody tr').length === 2
      && ![...document.querySelectorAll('#tests-results tbody tr')].some(row => /is-(?:queued|running)/.test(row.className)), null, { timeout: 120000 });
    await page.locator('#run-all-tests').click();
    assert.equal(await page.locator('#stop-tests').isDisabled(), false, await page.locator('#tests').textContent());
    await page.locator('#stop-tests').click();
    await suiteDone();
    assert.match(await page.locator('#tests-summary').textContent(), /stopped/);
    assert.equal(await page.locator('#tests-results tbody tr.is-skipped').count(), 1);
    await page.locator('#run-all-tests').click();
    await suiteDone();
    const passRow = page.locator('#tests-results tr[data-tb="suite/tb_pass.v"]');
    const failRow = page.locator('#tests-results tr[data-tb="suite/tb_fail.v"]');
    assert.ok(await passRow.evaluate(row => row.classList.contains('is-pass')), await passRow.textContent());
    assert.ok(await failRow.evaluate(row => row.classList.contains('is-fail')), await failRow.textContent());
    assert.equal(await passRow.locator('.tests-status').textContent(), 'PASS');
    assert.equal(await failRow.locator('.tests-status').textContent(), 'FAIL');
    assert.deepEqual(await passRow.locator('td').evaluateAll(cells => cells.slice(2, 5).map(cell => cell.textContent)), ['tb_pass', '1', '0']);
    assert.deepEqual(await failRow.locator('td').evaluateAll(cells => cells.slice(2, 5).map(cell => cell.textContent)), ['tb_fail', '0', '1']);
    assert.match(await passRow.locator('td').nth(5).textContent(), /^\d+ ms$/);
    assert.equal(await page.locator('#tests-summary').textContent(), '1/2 passed, 1 failed');
    assert.equal(await page.getByRole('button', { name: 'Waveform for suite/tb_fail.v' }).isDisabled(), true);

    await page.getByRole('button', { name: 'Log for suite/tb_fail.v' }).click();
    assert.equal(await page.locator('#console').isVisible(), true);
    assert.match(await page.locator('#console-output .con-fail').last().textContent(), /FAIL: expected 6 got 5/);
    await page.getByRole('tab', { name: 'Tests' }).click();
    await page.getByRole('button', { name: 'Log for suite/tb_pass.v' }).click();
    const consoleText = await page.locator('#console-output').textContent();
    assert.ok(consoleText.includes('WARNING: slow path\nPASS: adder ok\n'), consoleText);
    assert.match(await page.locator('#console-output .con-pass').last().textContent(), /PASS: adder ok/);
    assert.match(await page.locator('#console-output .con-warn').first().textContent(), /WARNING: slow path/);
    assert.equal(await page.locator('#console-output .con-fail').count(), 0);
    await page.locator('#console-filter').fill('pass');
    assert.ok((await page.locator('#console-output').textContent()).includes('PASS: adder ok'));
    assert.ok(!(await page.locator('#console-output').textContent()).includes('WARNING'));
    await page.locator('#console-filter').fill('');
    assert.equal(await page.locator('#console-output').textContent(), consoleText);
    await page.getByRole('tab', { name: 'Tests' }).click();
    await page.getByRole('button', { name: 'Waveform for suite/tb_pass.v' }).click();
    assert.equal(await page.locator('#waveform').isVisible(), true);
    await page.waitForSelector('.wave-row[data-path="tb_pass.u0.r"] canvas.wave-trace');

    await page.locator('#standard').selectOption('2001');
    await page.locator('#top-module').fill('tb_pass');
    await page.locator('#run').click();
    await engineDone();
    assert.ok((await page.locator('#console-output').textContent()).includes('PASS: adder ok'));
    assert.ok(await page.locator('#console-output .con-pass').count() >= 1);
    const strict2001 = await page.evaluate(async () => {
      const worker = new Worker('/simulator-worker.js', { type: 'module' });
      const run = (runId, standard) => new Promise(resolve => {
        worker.onmessage = ({ data }) => { if (data.type === 'result' || data.type === 'error') resolve(data.type); };
        worker.postMessage({ type: 'compile', runId, standard, topModule: 'tb', files: { 'tb.v': 'module tb; reg clk = 0, q; always_ff @(posedge clk) q <= 1; endmodule\n' } });
      });
      await new Promise(resolve => { worker.onmessage = ({ data }) => { if (data.type === 'ready') resolve(); }; worker.postMessage({ type: 'init' }); });
      const result = { v2001: await run(21, '2001'), sv2012: await run(22, '2012') };
      worker.terminate();
      return result;
    });
    assert.deepEqual(strict2001, { v2001: 'error', sv2012: 'result' });

    await createFile('prog.mem', '012a4020\n8d090004\n');
    await page.locator('#editor .cm-line').first().click({ position: { x: 10, y: 8 }, modifiers: ['Control'] });
    assert.equal(await page.locator('#value-popover').isVisible(), true);
    assert.equal(await page.locator('#value-popover [data-mips-asm]').textContent(), 'add $t0, $t1, $t2');
    assert.match(await page.locator('#value-popover').textContent(), /R-type/);
    assert.match(await page.locator('#value-popover').textContent(), /funct/);
    await page.locator('#pop-close').click();
    await page.locator('#editor .cm-line').nth(1).click({ position: { x: 10, y: 8 }, modifiers: ['Control'] });
    assert.equal(await page.locator('#value-popover [data-mips-asm]').textContent(), 'lw $t1, 4($t0)');
    await page.locator('#pop-close').click();
    const mipsUnits = await page.evaluate(async () => {
      const { decodeMips } = await import('/mips-decode.js');
      return ['012a4020', "32'h00084080", '1109fffd', '08100004', '3c011001', '03e00008', '012a402a', 'ad280008', '00000000'].map(word => decodeMips(word).asm);
    });
    assert.deepEqual(mipsUnits, ['add $t0, $t1, $t2', 'sll $t0, $t0, 2', 'beq $t0, $t1, -3', 'j 0x00400010', 'lui $at, 0x1001', 'jr $ra', 'slt $t0, $t1, $t2', 'sw $t0, 8($t1)', 'nop']);

    await page.keyboard.press('Control+Shift+F');
    assert.equal(await page.locator('#search-dialog').isVisible(), true);
    await page.locator('#search-input').fill('alu_core');
    assert.ok(await page.locator('.search-result').count() >= 3);
    assert.match(await page.locator('#search-count').textContent(), /results? in 3 files/);
    await page.locator('.search-result', { hasText: 'suite/alu.v:2' }).click();
    assert.equal(await page.locator('#search-dialog').isVisible(), false);
    assert.equal(await page.locator('#active-file').textContent(), 'Active: suite/alu.v');
    assert.ok((await page.locator('#cursor').textContent()).startsWith('Ln 2,'));
    await page.keyboard.press('Control+Shift+p');
    await page.locator('#palette-input').fill('Search in Workspace');
    await page.locator('#palette-input').press('Enter');
    assert.equal(await page.locator('#search-dialog').isVisible(), true);
    await page.locator('#close-search').click();

    await page.locator('[data-path="suite/tb_pass.v"]').click();
    await page.locator('#editor .cm-line').nth(1).click({ position: { x: 4, y: 8 } });
    await page.keyboard.press('F12');
    assert.equal(await page.locator('#active-file').textContent(), 'Active: suite/alu.v');
    assert.ok((await page.locator('#cursor').textContent()).startsWith('Ln 2,'));
    await page.locator('[data-path="suite/tb_fail.v"]').click();
    await page.locator('#editor .cm-line').nth(1).click({ position: { x: 4, y: 8 } });
    await page.keyboard.press('Control+Shift+p');
    await page.locator('#palette-input').fill('Go to Definition');
    await page.locator('#palette-input').press('Enter');
    assert.equal(await page.locator('#active-file').textContent(), 'Active: suite/alu.v');
    const definitions = await page.evaluate(async () => {
      const { findDefinitions } = await import('/search.js');
      const files = { 'a.v': '`define ALU_W 4\nmodule top;\nendmodule\n', 'b.v': 'module m;\n  function automatic [3:0] inc(input [3:0] x); inc = x + 1; endfunction\n  task pulse; begin end endtask\nendmodule\n' };
      return ['`ALU_W', 'top', 'inc', 'pulse', 'missing'].map(word => findDefinitions(files, word).map(hit => `${hit.kind}@${hit.file}:${hit.line}`).join());
    });
    assert.deepEqual(definitions, ['define@a.v:1', 'module@a.v:2', 'function@b.v:2', 'task@b.v:3', '']);

    await page.waitForTimeout(400);
    const readDurable = () => page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('datapath-studio');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const get = request.result.transaction('workspace', 'readonly').objectStore('workspace').get('current');
        get.onsuccess = () => { resolve(Object.keys(get.result?.snapshot?.files || {})); request.result.close(); };
        get.onerror = () => reject(get.error);
      };
    }));
    const durableFiles = await readDurable();
    assert.ok(durableFiles.includes('suite/tb_pass.v') && durableFiles.includes('prog.mem'), JSON.stringify(durableFiles));
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    assert.equal(await page.locator('#standard').inputValue(), '2001');
    assert.equal(await page.locator('[data-path="suite/tb_fail.v"]').count(), 1);
    await page.locator('#file-input').setInputFiles({ name: 'big.mem', mimeType: 'text/plain', buffer: Buffer.from('012a4020\n'.repeat(140000)) });
    await page.waitForSelector('[data-path="big.mem"]');
    assert.equal(await page.evaluate(() => localStorage.getItem('datapath.workspace.v1')), null);
    assert.match(await page.locator('#save-state').textContent(), /IndexedDB/);
    await page.waitForTimeout(400);
    assert.ok((await readDurable()).includes('big.mem'));
    await page.reload();
    await page.waitForSelector('[data-path="big.mem"]');
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    assert.equal(await page.locator('#active-file').textContent(), 'Active: big.mem');
    assert.equal(await page.locator('[data-path="suite/alu.v"]').count(), 1);
    await page.locator('#delete-file').click();
    await page.getByRole('button', { name: 'Delete file', exact: true }).click();
    assert.equal(await page.locator('[data-path="big.mem"]').count(), 0);
    const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem('datapath.workspace.v1')));
    assert.ok(mirror && Object.hasOwn(mirror.files, 'suite/alu.v') && !Object.hasOwn(mirror.files, 'big.mem'));
    await page.locator('#standard').selectOption('2005');

    // 14. Stage 2: captured register file / memory State tab (heat, ABI, disassembly, PC), Board replay widgets,
    //     and a Live DUT session on `counter` driven without any testbench.
    const waitText = (selector, text, timeout = 10000) => page.waitForFunction(([sel, expected]) => document.querySelector(sel)?.textContent === expected, [selector, text], { timeout })
      .catch(async error => { throw new Error(`${selector}: expected ${JSON.stringify(text)}, got ${JSON.stringify(await page.locator(selector).first().textContent().catch(() => null))} (${error.message})`); });
    await createFile('mips/regfile.v', 'module regfile(input clk, input we, input [4:0] wa, input [31:0] wd);\n  reg [31:0] regs [0:31];\n  integer i;\n  initial for (i = 0; i < 32; i = i + 1) regs[i] = i;\n  always @(posedge clk) if (we) regs[wa] <= wd;\nendmodule\n');
    await createFile('mips/cpu_tb.v', '`timescale 1ns/1ns\nmodule cpu_tb;\n  reg clk = 0;\n  reg [31:0] pc = 0;\n  reg [31:0] imem [0:15];\n  wire [31:0] instr = imem[pc[5:2]];\n  reg we = 0; reg [4:0] wa = 0; reg [31:0] wd = 0;\n  regfile rf(.clk(clk), .we(we), .wa(wa), .wd(wd));\n  always #5 clk = ~clk;\n  initial begin\n    $readmemh("mips/prog.mem", imem);\n    $dumpfile("cpu.vcd");\n    $dumpvars(0, cpu_tb);\n    #12 we = 1; wa = 8; wd = rf.regs[9] + rf.regs[10]; pc = 4;\n    #10 we = 0;\n    #20 $finish;\n  end\nendmodule\n');
    await createFile('mips/prog.mem', '012a4020\n8d090004\n');
    await page.locator('#top-module').fill('cpu_tb');
    await page.locator('#run').click();
    await engineDone();
    await page.getByRole('tab', { name: 'State' }).click();
    assert.equal(await page.locator('#hw-state').isVisible(), true);
    await waitText('#hw-arrays [data-array="cpu_tb.rf.regs"]', 'cpu_tb.rf.regs (32×32)');
    assert.equal(await page.locator('#hw-arrays [data-array="cpu_tb.imem"]').textContent(), 'cpu_tb.imem (16×32)');
    await page.locator('#hw-arrays [data-array="cpu_tb.rf.regs"]').click();
    await page.waitForFunction(() => /^0 [a-z]+s$/.test(document.getElementById('hw-time').textContent));
    await waitText('.hw-cell[data-index="9"] .hw-value', '0x00000009');
    assert.equal(await page.locator('.hw-cell.heat0').count(), 0);
    await page.locator('#hw-step-next').click();
    await waitText('#hw-time', '5 ns');
    await page.locator('#hw-step-next').click();
    await waitText('#hw-time', '15 ns');
    await waitText('.hw-cell[data-index="8"] .hw-value', '0x00000013');
    await page.waitForSelector('.hw-cell[data-index="8"].heat0');
    assert.equal(await page.locator('.hw-cell.heat0').count(), 1);
    await page.locator('#hw-step-prev').click();
    await waitText('.hw-cell[data-index="8"] .hw-value', '0x00000008');
    assert.equal(await page.locator('.hw-cell[data-index="8"].heat0').count(), 0);
    await page.locator('#hw-step-next').click();
    await page.waitForSelector('.hw-cell[data-index="8"].heat0');
    await page.locator('#hw-abi').click();
    await waitText('.hw-cell[data-index="8"] .hw-name', '$t0');
    assert.equal(await page.locator('.hw-cell[data-index="31"] .hw-name').textContent(), '$ra');
    await page.locator('#hw-filter').fill('$t0');
    await page.waitForFunction(() => document.querySelectorAll('.hw-cell').length === 1);
    await page.locator('#hw-filter').fill('');
    await page.locator('#hw-radix').selectOption('unsigned');
    await waitText('.hw-cell[data-index="8"] .hw-value', '19');
    await page.locator('#hw-radix').selectOption('hex');
    const snapshotUnits = await page.evaluate(async () => {
      const { createSimTrace } = await import('/sim-trace.js');
      const store = createSimTrace();
      store.loadMemTrace({ timescale: '1ns', arrays: [{ path: 'm', width: 8, size: 4, left: 0, right: 3, init: { 0: '00', 1: '00', 2: '00', 3: '00' }, deltas: [[10, 0, '01'], [20, 1, '02'], [30, 2, '03'], [40, 3, '04'], [50, 0, '05']] }] });
      const at = time => { const snap = store.getMemorySnapshot('m', time); return [[...snap.words.values()].join(''), [0, 1, 2, 3].map(index => snap.heat.get(index) ?? '-').join('')]; };
      return [at(5n), at(30n), at(45n), at(50n)];
    });
    assert.deepEqual(snapshotUnits, [['00000000', '----'], ['01020300', '210-'], ['01020304', '3210'], ['05020304', '0321']]);

    await page.locator('#hw-arrays [data-array="cpu_tb.imem"]').click();
    await waitText('#hw-view', 'Table view');
    await page.locator('#hw-view').click();
    await page.locator('#hw-disasm').click();
    await waitText('.hw-row[data-index="0"] .hw-asm', 'add $t0, $t1, $t2');
    assert.equal(await page.locator('.hw-row[data-index="1"] .hw-asm').textContent(), 'lw $t1, 4($t0)');
    assert.equal(await page.locator('.hw-row[data-index="1"] .hw-addr').textContent(), '0x00000004');
    await page.waitForSelector('.hw-row[data-index="1"].is-pc');
    await page.locator('#hw-step-prev').click();
    await page.waitForSelector('.hw-row[data-index="0"].is-pc');

    await page.getByRole('tab', { name: 'Board' }).click();
    assert.equal(await page.locator('#board-replay').isVisible(), true);
    await page.waitForSelector('#board-widgets .board-seg svg.seg-digit');
    await page.waitForSelector('#board-widgets .board-led .led');
    await page.locator('#board-widget-kind').selectOption('seg');
    await page.locator('#board-widget-signal').selectOption('cpu_tb.pc');
    await page.locator('#board-add-widget').click();
    await page.locator('#board-widget-kind').selectOption('led');
    await page.locator('#board-widget-signal').selectOption('cpu_tb.we');
    await page.locator('#board-add-widget').click();
    await waitText('#board-time', '5 ns');
    assert.equal(await page.locator('#board-widgets .board-seg[data-signal="cpu_tb.pc"]').last().locator('.board-readout').textContent(), '0x00000000');
    assert.equal(await page.locator('#board-widgets .board-led[data-signal="cpu_tb.we"]').last().locator('.led').getAttribute('class'), 'led led-0');
    assert.equal(await page.locator('#board-widgets .board-seg[data-signal="cpu_tb.pc"]').last().locator('svg.seg-digit').count(), 8);
    await page.locator('#board-step-next').click();
    await waitText('#board-time', '15 ns');
    assert.equal(await page.locator('#board-widgets .board-seg[data-signal="cpu_tb.pc"]').last().locator('.board-readout').textContent(), '0x00000004');
    assert.equal(await page.locator('#board-widgets .board-led[data-signal="cpu_tb.we"]').last().locator('.led').getAttribute('class'), 'led led-1');
    assert.equal(await page.locator('#board-widgets .board-seg[data-signal="cpu_tb.pc"]').last().locator('svg.seg-digit').last().locator('.seg.on').count(), 4);
    const widgetCount = await page.locator('#board-widgets .board-widget').count();
    await page.getByRole('button', { name: 'Remove we widget' }).last().click();
    assert.equal(await page.locator('#board-widgets .board-widget').count(), widgetCount - 1);
    const portUnits = await page.evaluate(async () => {
      const { parseModulePorts, liveWrapper } = await import('/board.js');
      const ansi = parseModulePorts('module alu #(parameter W = 8) (input clk, input [W-1:0] a, b, output reg [W:0] y, output z); endmodule', 'alu');
      const v95 = parseModulePorts('module old(clk, d, q); parameter N = 4; input clk; input [N-1:0] d; output [N-1:0] q; reg [N-1:0] q; endmodule', 'old');
      return { ansi: ansi.map(p => `${p.dir}:${p.name}:${p.width}`).join(), v95: v95.map(p => `${p.dir}:${p.name}:${p.width}`).join(), wrapper: liveWrapper('old', v95) };
    });
    assert.equal(portUnits.ansi, 'input:clk:1,input:a:8,input:b:8,output:y:9,output:z:1');
    assert.equal(portUnits.v95, 'input:clk:1,input:d:4,output:q:4');
    assert.equal(portUnits.wrapper, '`timescale 1ns/1ns\nmodule _live_board_tb;\n  reg clk = 0;\n  reg [3:0] d = 0;\n  wire [3:0] q;\n  old dut(.clk(clk), .d(d), .q(q));\nendmodule\n');

    await page.locator('#board-mode-live').click();
    assert.equal(await page.locator('#board-live').isVisible(), true);
    await page.locator('#board-module').selectOption('counter');
    await page.locator('#board-live-start').click();
    await page.waitForFunction(() => !document.getElementById('board-live-stop').disabled && !document.getElementById('board-tick').disabled, null, { timeout: 30000 })
      .catch(async () => { throw new Error(`Live start failed: ${await page.locator('#board-live-status').textContent()}`); });
    await waitText('#board-live-outputs [data-port="count"] .board-readout', '0x0', 30000);
    const resetSwitch = page.getByRole('switch', { name: 'reset switch' });
    assert.equal(await resetSwitch.getAttribute('aria-checked'), 'true');
    await resetSwitch.click();
    await page.waitForFunction(() => document.querySelector('[data-port="reset"] .board-switch')?.getAttribute('aria-checked') === 'false');
    for (const expected of ['0x1', '0x2', '0x3']) {
      await page.locator('#board-tick').click();
      await waitText('#board-live-outputs [data-port="count"] .board-readout', expected);
    }
    assert.equal(await page.locator('#board-live-outputs [data-port="count"] svg.seg-digit .seg.on').count(), 5);
    assert.match(await page.locator('#board-live-status').textContent(), /Live · \d+(?:\.\d)? ms/);
    assert.match(await page.locator('#board-live-time').textContent(), /^cycle 4 · \d+ [pn]s$/);
    await page.locator('#board-live-stop').click();
    await page.waitForFunction(() => !document.getElementById('board-live-start').disabled);
    assert.equal(await page.locator('#board-live-outputs .board-widget').count(), 0);
    await page.locator('#board-mode-replay').click();

    // 15. Stage 3: RTL schematic (Icarus synth + json.tgt + elkjs), live VCD overlay, hierarchy drill-down,
    //     SVG export, latch warnings, and the side-by-side Live Board layout.
    const sectionRequests = [];
    const onRequest = request => sectionRequests.push(request.url());
    page.context().on('request', onRequest);
    await createFile('schem/hier.v', 'module hier_child(input [3:0] a, input [3:0] b, input sel, output [3:0] y);\n  assign y = sel ? a : b;\nendmodule\nmodule hier_top(input [3:0] x, input s, output [3:0] z);\n  hier_child u_child(.a(x), .b(~x), .sel(s), .y(z));\nendmodule\n');
    await createFile('schem/latch.v', 'module latchy(input en, input [3:0] d, output reg [3:0] q);\n  always @(*) if (en) q = d;\nendmodule\n');
    await page.getByRole('tab', { name: 'Schematic' }).click();
    assert.equal(await page.locator('#schematic').isVisible(), true);
    assert.equal(sectionRequests.filter(url => /elaborate-worker\.js|vendor\/schematic\/|engine\/ivl/.test(url)).length, 0, 'Schematic assets must load lazily');
    const elaborate = async module => {
      await page.locator('#schem-module').selectOption(module);
      await page.locator('#schem-elaborate').click();
      await page.waitForFunction(name => !document.getElementById('schem-elaborate').disabled && document.getElementById('schem-status').textContent.startsWith(`${name}:`), module, { timeout: 60000 })
        .catch(async () => { throw new Error(`Elaborate ${module} failed: ${await page.locator('#schem-status').textContent()}`); });
    };
    await elaborate('counter');
    assert.ok(await page.locator('#schem-canvas .schem-cell').count() >= 3);
    assert.equal(await page.locator('#schem-canvas .schem-port').count(), 3);
    assert.ok(await page.locator('#schem-canvas .schem-wire').count() >= 5);
    assert.equal(await page.locator('#schem-canvas .schem-cell.kind-dff').count(), 1);
    assert.equal(await page.locator('#schem-canvas .schem-cell.kind-mux').count(), 1);
    assert.ok(await page.locator('#schem-canvas .schem-cell.kind-op').count() >= 1);
    assert.ok(await page.locator('#schem-canvas path.schem-bus[data-net="count"]').count() >= 1);
    assert.equal(await page.locator('#schem-canvas .schem-width text').first().textContent(), '4');
    assert.ok(sectionRequests.some(url => url.endsWith('/vendor/schematic/elk.js')) && sectionRequests.some(url => url.endsWith('/engine/ivl.wasm')), JSON.stringify(sectionRequests.filter(url => !/\.(?:v|vcd)$/.test(url))));
    await page.locator('#schem-canvas .schem-cell.kind-dff').click();
    assert.equal(await page.locator('#active-file').textContent(), 'Active: design.v');
    assert.ok((await page.locator('#cursor').textContent()).startsWith('Ln 2,'));

    await page.locator('#top-module').fill('testbench');
    await page.locator('#run').click();
    await engineDone();
    await page.getByRole('tab', { name: 'Schematic' }).click();
    await page.waitForFunction(() => document.getElementById('schem-scope').textContent === 'VCD: testbench.dut');
    const countBadge = () => page.evaluate(() => {
      const wire = document.querySelector('#schem-canvas path.schem-bus[data-net="count"]');
      const badge = wire && document.querySelector(`#schem-canvas g.schem-value[data-edge="${wire.dataset.edge}"]`);
      return badge && badge.getAttribute('visibility') === 'visible' ? badge.querySelector('text').textContent : null;
    });
    await page.waitForFunction(() => /^0x/.test(document.querySelector('#schem-canvas g.schem-value[visibility="visible"] text')?.textContent || ''));
    await page.locator('#schem-step-next').click();
    await page.waitForFunction(() => document.getElementById('schem-time').textContent === '5 ns');
    await page.waitForFunction(() => document.querySelector('#schem-canvas path.schem-bus[data-net="count"].is-live'));
    assert.equal(await countBadge(), '0x0');
    await page.locator('#schem-step-next').click();
    await page.waitForFunction(() => document.getElementById('schem-time').textContent === '15 ns');
    await page.waitForFunction(() => {
      const wire = document.querySelector('#schem-canvas path.schem-bus[data-net="count"]');
      return document.querySelector(`#schem-canvas g.schem-value[data-edge="${wire.dataset.edge}"] text`)?.textContent === '0x1';
    });
    assert.equal(await page.locator('#schem-canvas path.schem-wire[data-net="clk"].wire-1').count(), 1);
    assert.equal(await page.locator('#schem-canvas path.schem-wire[data-net="reset"].wire-0').count(), 1);

    await elaborate('hier_top');
    const child = page.locator('#schem-canvas .schem-cell.kind-module[data-name="u_child"]');
    assert.equal(await child.count(), 1);
    await child.dblclick();
    await page.waitForFunction(() => [...document.querySelectorAll('#schem-crumbs .schem-crumb')].map(item => item.textContent).join('/') === 'hier_top/u_child');
    assert.equal(await page.locator('#schem-canvas .schem-cell.kind-mux').count(), 1);
    assert.deepEqual(await page.locator('#schem-canvas .schem-port').evaluateAll(ports => ports.map(port => port.querySelector('text').textContent).sort()), ['a [3:0]', 'b [3:0]', 'sel', 'y [3:0]']);
    await page.locator('#schem-crumbs .schem-crumb', { hasText: 'hier_top' }).click();
    await page.waitForFunction(() => document.querySelectorAll('#schem-crumbs .schem-crumb').length === 1 && document.querySelector('#schem-canvas .schem-cell.kind-module[data-name="u_child"]'));
    const svgDownload = page.waitForEvent('download');
    await page.locator('#schem-export').click();
    const exported = await readFile(await (await svgDownload).path(), 'utf8');
    assert.match(exported, /<svg[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.ok(exported.includes('u_child : hier_child') && !exported.includes('var(--'), 'Exported SVG must be self-contained');
    assert.equal((await svgDownload).suggestedFilename(), 'hier_top.svg');
    await page.locator('#schem-flatten').click();
    await page.waitForFunction(() => document.getElementById('schem-status').textContent.startsWith('hier_top:') && !document.querySelector('#schem-canvas .schem-cell.kind-module') && document.querySelector('#schem-canvas .schem-cell.kind-mux'), null, { timeout: 60000 });
    await page.locator('#schem-flatten').click();
    await page.waitForFunction(() => document.querySelector('#schem-canvas .schem-cell.kind-module'), null, { timeout: 60000 });

    await elaborate('latchy');
    assert.equal(await page.locator('#schem-canvas .schem-cell.kind-latch').count(), 1);
    assert.equal(await page.locator('#schem-canvas .schem-cell.kind-latch .schem-title').textContent(), 'LATCH');
    const latchWarning = page.locator('#schem-warnings .schem-warning.kind-latch');
    assert.equal(await latchWarning.count(), 1);
    assert.match(await latchWarning.textContent(), /schem\/latch\.v:2.*latch has been inferred for 'q'/);
    await latchWarning.click();
    assert.equal(await page.locator('#active-file').textContent(), 'Active: schem/latch.v');
    assert.ok((await page.locator('#cursor').textContent()).startsWith('Ln 2,'));
    const schematicUnits = await page.evaluate(async () => {
      const { parseSrc } = await import('/schematic.js');
      const { parseIvlLog, cellKind, displayType } = await import('/elaborate-worker.js');
      return {
        src: parseSrc('design.v:3.5-3.18'),
        log: parseIvlLog(['/work/a.v:5: warning: A latch has been inferred for \'q\'.', '/work/b.v:9: sorry: Assignment to variable location in memory is not currently supported in synthesis.', '/work/c.v:2: error: Unable to bind wire'], true).map(item => `${item.file}:${item.line}:${item.severity}:${item.kind}`),
        kinds: ['$dff', '$adffe', '$dlatch', '$mux', '$pmux', '$add', '$and', '$mem', 'hier_child', '$paramod\\adder\\top.u1', '$proc'].map(cellKind),
        label: displayType('$paramod\\adder\\top.u1'),
      };
    });
    assert.deepEqual(schematicUnits, {
      src: { file: 'design.v', line: 3 },
      log: ['a.v:5:warning:latch', 'b.v:9:warning:behavioral', 'c.v:2:warning:other'],
      kinds: ['dff', 'dff', 'latch', 'mux', 'mux', 'op', 'gate', 'mem', 'module', 'module', 'generic'],
      label: 'adder',
    });
    page.context().off('request', onRequest);
    assert.deepEqual(sectionRequests.filter(url => !url.startsWith(baseUrl)), [], 'Schematic must not fetch remote resources');

    await page.getByRole('tab', { name: 'Board' }).click();
    await page.locator('#board-mode-live').click();
    await page.locator('#board-module').selectOption('counter');
    await page.locator('#board-live-start').click();
    await waitText('#board-live-outputs [data-port="count"] .board-readout', '0x0', 30000);
    const boardBox = await page.locator('#board').boundingBox();
    const switchBox = await page.locator('#board-live-inputs [data-port="reset"]').boundingBox();
    const segBox = await page.locator('#board-live-outputs [data-port="count"] .seg-display').boundingBox();
    assert.ok(switchBox.x + switchBox.width <= segBox.x, `Switches and displays should sit side by side: ${JSON.stringify({ switchBox, segBox })}`);
    for (const box of [switchBox, segBox]) assert.ok(box.y >= boardBox.y && box.y + box.height <= boardBox.y + boardBox.height + 0.5, `Board content is clipped: ${JSON.stringify({ box, boardBox })}`);
    await page.locator('#board-live-stop').click();
    await page.waitForFunction(() => !document.getElementById('board-live-start').disabled);
    await page.locator('#board-mode-replay').click();

    // 16. Stage 4: MIPS32 assembler (.asm -> .mem) with the Mini-CPU template, and symbolic FSM state names.
    await page.locator('#templates').click();
    await page.locator('[data-template="mips"]').click();
    await page.waitForSelector('[data-path="program.asm"]');
    assert.equal(await page.locator('#active-file').textContent(), 'Active: program.asm');
    assert.equal(await page.locator('#editor .cm-content').getAttribute('data-language'), 'mips');
    assert.equal(await page.locator('#top-module').inputValue(), 'mips_tb');
    assert.equal(await page.locator('#assemble').isVisible(), true);
    assert.ok(await page.locator('#editor .cm-line').first().locator('span').count() > 0, 'asm comments should be highlighted');
    const templateAsm = await editorText();
    await page.locator('#assemble').click();
    await page.waitForSelector('[data-path="program.mem"]');
    assert.equal(await page.locator('#save-state').textContent(), 'Assembled 7 words -> program.mem');
    await page.locator('[data-path="program.mem"]').click();
    assert.equal(await page.locator('#editor .cm-content').getAttribute('data-language'), 'verilog');
    const memText = await editorText();
    assert.ok(memText.includes('20080001 // 0x00000000: addi $t0, $zero, 1'), memText);
    assert.ok(memText.includes('150afffd // 0x00000014: bne  $t0, $t2, loop'), memText);
    assert.ok(memText.includes('08000006 // 0x00000018: j    done'), memText);
    await page.locator('#editor .cm-line').first().click({ position: { x: 10, y: 8 }, modifiers: ['Control'] });
    assert.equal(await page.locator('#value-popover').isVisible(), false);
    await page.locator('#editor .cm-line').nth(1).click({ position: { x: 10, y: 8 }, modifiers: ['Control'] });
    assert.equal(await page.locator('#value-popover [data-mips-asm]').textContent(), 'addi $t0, $zero, 1');
    await page.locator('#pop-close').click();

    await page.locator('[data-path="program.asm"]').click();
    await page.locator('#editor .cm-content').fill(templateAsm.replace('add  $t1, $t1, $t0', 'addx $t1, $t1, $t0'));
    await page.locator('#run').click();
    await waitText('.engine-state', 'Assembly failed');
    assert.equal(await page.locator('#problems').isVisible(), true);
    assert.equal(await page.locator('.problem-item').count(), 1);
    assert.equal(await page.locator('.problem-loc').textContent(), 'program.asm:8');
    assert.match(await page.locator('.problem-item').textContent(), /Unknown instruction 'addx'/);
    assert.ok(await page.locator('#editor .cm-diagnostic-line').count() >= 1);
    assert.equal(await page.locator('#run').isDisabled(), false);
    await page.getByRole('tab', { name: 'Tests' }).click();
    await page.locator('#run-all-tests').click();
    assert.equal(await page.locator('#tests-summary').textContent(), 'Suite aborted: fix the problems first.');
    assert.equal(await page.locator('#problems').isVisible(), true);
    await page.locator('#editor .cm-content').fill(templateAsm.replace('addi $t2, $zero, 6', 'addi $t2, $zero, 7'));
    await page.locator('#run').click();
    await engineDone();
    assert.match(await page.locator('#console-output').textContent(), /FAIL: \$t1 = 21, expected 15/);
    assert.match(await page.evaluate(() => JSON.parse(localStorage.getItem('datapath.workspace.v1')).files['program.mem']), /^00000000|^\/\//m);
    await page.getByRole('tab', { name: 'State' }).click();
    await page.locator('#hw-arrays [data-array="mips_tb.dut.u_rf.regs"]').click();
    await page.locator('#hw-play').click();
    assert.equal(await page.locator('#hw-play').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.getElementById('hw-play').getAttribute('aria-pressed') === 'false', null, { timeout: 30000 });
    await waitText('.hw-cell[data-index="9"] .hw-value', '0x00000015');
    await page.locator('#hw-arrays [data-array="mips_tb.dut.u_imem.mem"]').click();
    if ((await page.locator('#hw-view').textContent()) === 'Table view') await page.locator('#hw-view').click();
    if ((await page.locator('#hw-disasm').getAttribute('aria-pressed')) !== 'true') await page.locator('#hw-disasm').click();
    await waitText('.hw-row[data-index="0"] .hw-asm', 'addi $t0, $zero, 1');
    assert.equal(await page.locator('.hw-row[data-index="6"].is-pc .hw-asm').textContent(), 'j 0x00000018');

    const asmUnits = await page.evaluate(async () => {
      const { assembleMips } = await import('/mips-asm.js');
      const result = assembleMips('loop: blt $t0, $t1, loop\nli $t0, 0x12345678\n.word loop', { filename: 'x.s' });
      return { ok: result.ok, out: result.outputName, words: result.words.map(word => word.toString(16)) };
    });
    assert.deepEqual(asmUnits, { ok: true, out: 'x.mem', words: ['109082a', '1420fffe', '3c081234', '35085678', '0'] });

    await createFile('fsm/fsm3.v', "module fsm3(input clk, input reset, input go, output reg done);\n  localparam [1:0] IDLE = 2'd0, RUN = 2'd1, DONE = 2'd2;\n  reg [1:0] state;\n  always @(posedge clk)\n    if (reset) state <= IDLE;\n    else case (state)\n      IDLE: if (go) state <= RUN;\n      RUN:  state <= DONE;\n      DONE: state <= IDLE;\n      default: state <= IDLE;\n    endcase\n  always @(*) done = (state == DONE);\nendmodule\n");
    await createFile('fsm/fsm3_tb.v', '`timescale 1ns/1ns\nmodule fsm3_tb;\n  reg clk = 0, reset = 1, go = 1;\n  wire done;\n  fsm3 dut(.clk(clk), .reset(reset), .go(go), .done(done));\n  always #5 clk = ~clk;\n  initial begin\n    $dumpfile("fsm.vcd");\n    $dumpvars(0, fsm3_tb);\n    #12 reset = 0;\n    #50 $finish;\n  end\nendmodule\n');
    await page.locator('#top-module').fill('fsm3_tb');
    await page.locator('#run').click();
    await engineDone();
    await page.getByRole('tab', { name: 'Waveform' }).click();
    const stateRow = '.wave-row[data-path="fsm3_tb.dut.state"]';
    await page.waitForSelector(stateRow);
    await page.locator(`${stateRow} .wave-label span`).click();
    const seen = [];
    for (let i = 0; i < 4; i++) {
      await page.locator('#wave-step-next').click();
      seen.push(await page.locator(`${stateRow} strong`).textContent());
    }
    assert.deepEqual(seen, ['IDLE', 'RUN', 'DONE', 'IDLE']);
    await page.locator('#wave-step-prev').click();
    assert.equal(await page.locator(`${stateRow} strong`).textContent(), 'DONE');
    await page.locator('#inspector-filter').fill('dut.state');
    assert.equal(await page.locator('#signal-inspector .inspector-signal-value').first().textContent(), 'DONE');
    await page.locator('#inspector-filter').fill('');
    await page.getByRole('combobox', { name: 'Radix for fsm3_tb.dut.state', exact: true }).selectOption('hex');
    assert.equal(await page.locator(`${stateRow} strong`).textContent(), '0x2');
    await page.getByRole('combobox', { name: 'Radix for fsm3_tb.dut.state', exact: true }).selectOption('state');
    assert.equal(await page.locator(`${stateRow} strong`).textContent(), 'DONE');
    assert.equal(await page.locator('.wave-row[data-path="fsm3_tb.dut.done"] strong').textContent(), '1');
    assert.equal(await page.locator('.wave-row[data-path="fsm3_tb.clk"] strong').textContent(), '1');
    await page.getByRole('combobox', { name: 'Radix for fsm3_tb.dut.state', exact: true }).selectOption('');

    // 17. Showcase Projects gallery: five 1-click workspaces that each exercise a feature group.
    const SHOWCASE_IDS = ['mips-cpu', 'fpga-board', 'fsm-control', 'alu-suite', 'bug-hunter'];
    const dockOpen = () => page.evaluate(() => !document.body.classList.contains('dock-hidden'));
    const loadProject = async id => {
      await page.locator('#templates').click();
      await page.waitForSelector('#template-dialog[open]');
      await page.locator(`#template-dialog [data-project="${id}"]`).click();
      await page.waitForFunction(() => !document.getElementById('template-dialog').open);
      const project = await page.evaluate(async name => (await import('/showcase-projects.js')).showcaseProject(name), id);
      await page.waitForSelector(`[data-path="${project.openFile}"]`);
      assert.equal(await page.locator('#active-file').textContent(), `Active: ${project.openFile}`);
      assert.deepEqual((await page.locator('#files [data-path]').evaluateAll(items => [...new Set(items.map(item => item.dataset.path))])).sort(), Object.keys(project.files).sort());
      assert.equal(await page.locator('#top-module').inputValue(), project.topModule);
      assert.equal(await page.locator('#schem-module').inputValue(), project.schematicModule);
      assert.equal(await page.locator('#toast').textContent(), project.tryNext);
      assert.equal(await page.locator('.problem-item').count(), 0);
      if (await dockOpen()) assert.equal(await page.locator(`#${project.dockTab}`).isVisible(), true, `${id} should open the ${project.dockTab} panel`);
      const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem('datapath.workspace.v1')));
      assert.deepEqual(Object.keys(mirror.files).sort(), Object.keys(project.files).sort());
      return project;
    };
    const runPasses = async pattern => {
      await page.locator('#run').click();
      await engineDone();
      assert.match(await page.locator('#console-output').textContent(), pattern);
    };

    assert.equal(await page.locator('#templates').textContent(), 'Projects');
    await page.locator('#templates').click();
    assert.equal(await page.locator('#template-title').textContent(), 'Showcase Projects & Templates');
    assert.deepEqual(await page.locator('#template-dialog [data-project]').evaluateAll(cards => cards.map(card => card.dataset.project)), SHOWCASE_IDS);
    assert.equal(await page.locator('#template-dialog [data-template]').count(), 4);
    assert.equal(await page.locator('[data-project="mips-cpu"] .showcase-tag').count(), 4);
    assert.equal(await page.locator('[data-project="mips-cpu"] .showcase-note').textContent(), 'Replaces workspace');
    assert.equal(await page.locator('#showcase-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 2);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('template-dialog').open);
    await page.keyboard.press('Control+Shift+P');
    await page.locator('#palette-input').fill('Showcase Projects');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#template-dialog[open]');
    await page.keyboard.press('Escape');

    // mips-cpu: Fibonacci program auto-assembled on Run; RegFile, IMEM and DMEM in the State tab.
    await loadProject('mips-cpu');
    assert.equal(await page.locator('[data-path="design.v"]').count(), 0, 'Showcase projects replace the workspace');
    assert.equal(await page.locator('#editor .cm-content').getAttribute('data-language'), 'mips');
    assert.equal(await page.locator('#assemble').isVisible(), true);
    await runPasses(/PASS: \$s0 = 8, dmem\[5\] = 8/);
    assert.ok(Object.hasOwn(await page.evaluate(() => JSON.parse(localStorage.getItem('datapath.workspace.v1')).files), 'program.mem'));
    await page.getByRole('tab', { name: 'State' }).click();
    for (const array of ['u_rf.regs', 'u_imem.mem', 'u_dmem.mem']) await page.waitForSelector(`#hw-arrays [data-array="mips_cpu_tb.dut.${array}"]`);
    await page.locator('#hw-arrays [data-array="mips_cpu_tb.dut.u_rf.regs"]').click();
    await page.locator('#hw-play').click();
    assert.equal(await page.locator('#hw-play').getAttribute('aria-pressed'), 'true');
    await page.waitForFunction(() => document.getElementById('hw-play').getAttribute('aria-pressed') === 'false', null, { timeout: 30000 });
    const hwValue = index => page.evaluate(i => document.querySelector(`#hw-state .hw-cell[data-index="${i}"] .hw-value, #hw-state .hw-row[data-index="${i}"] .hw-value`)?.textContent, index);
    await page.waitForFunction(() => document.querySelector('#hw-state [data-index="16"] .hw-value')?.textContent === '0x00000008');
    assert.deepEqual(await Promise.all([8, 9, 10, 11, 12, 13].map(hwValue)), ['0x00000001', '0x00000001', '0x00000002', '0x00000003', '0x00000005', '0x00000008']);
    await page.locator('#hw-arrays [data-array="mips_cpu_tb.dut.u_dmem.mem"]').click();
    await page.waitForFunction(() => document.querySelector('#hw-state [data-index="5"] .hw-value')?.textContent === '0x00000008');
    assert.deepEqual(await Promise.all([0, 1, 2, 3, 4, 5, 6].map(hwValue)), ['0x00000001', '0x00000001', '0x00000002', '0x00000003', '0x00000005', '0x00000008', '0x00000000']);
    await page.locator('#hw-arrays [data-array="mips_cpu_tb.dut.u_imem.mem"]').click();
    if ((await page.locator('#hw-view').textContent()) === 'Table view') await page.locator('#hw-view').click();
    if ((await page.locator('#hw-disasm').getAttribute('aria-pressed')) !== 'true') await page.locator('#hw-disasm').click();
    await waitText('#hw-state .hw-row[data-index="0"] .hw-asm', 'addi $t0, $zero, 1');
    await waitText('#hw-state .hw-row.is-pc .hw-asm', 'j 0x0000003c');
    await page.getByRole('tab', { name: 'Schematic' }).click();
    await elaborate('mips_cpu');
    assert.equal(await page.locator('#schem-warnings .schem-warning').count(), 0, await page.locator('#schem-warnings').textContent());
    for (const name of ['u_ctrl', 'u_imem', 'u_rf', 'u_alu', 'u_dmem']) assert.equal(await page.locator(`#schem-canvas .schem-cell.kind-module[data-name="${name}"]`).count(), 1, name);

    // fpga-board: Board panel, Live DUT switches + Tick Clock, then a Replay run.
    await loadProject('fpga-board');
    await page.getByRole('tab', { name: 'Board' }).click();
    await page.locator('#board-mode-live').click();
    assert.equal(await page.locator('#board-module').inputValue(), 'fpga_counter');
    await page.locator('#board-live-start').click();
    await page.waitForFunction(() => !document.getElementById('board-live-stop').disabled && !document.getElementById('board-tick').disabled, null, { timeout: 30000 })
      .catch(async () => { throw new Error(`Live start failed: ${await page.locator('#board-live-status').textContent()}`); });
    const leds = '#board-live-outputs [data-port="leds"] .board-readout';
    await waitText(leds, '0x00', 30000);
    const ledClass = port => page.locator(`#board-live-outputs [data-port="${port}"] .led`).first().getAttribute('class');
    assert.equal(await ledClass('zero_led'), 'led led-1');
    const flip = async (port, expected) => {
      await page.getByRole('switch', { name: `${port} switch`, exact: true }).click();
      await page.waitForFunction(([name, value]) => document.querySelector(`#board-live-inputs [data-port="${name}"] .board-switch`)?.getAttribute('aria-checked') === value, [port, String(expected)]);
    };
    await flip('rst', false);
    await flip('en', true);
    await flip('up_down', true);
    for (const expected of ['0x01', '0x02', '0x03']) {
      await page.locator('#board-tick').click();
      await waitText(leds, expected);
    }
    assert.equal(await ledClass('zero_led'), 'led led-0');
    await page.getByRole('textbox', { name: 'din value (hex)' }).fill('c');
    await page.getByRole('textbox', { name: 'din value (hex)' }).press('Enter');
    await page.waitForFunction(() => document.querySelector('#board-live-inputs [data-port="din"] .board-bit[aria-label="din bit 3"]')?.textContent === '1');
    await flip('load', true);
    await page.locator('#board-tick').click();
    await waitText(leds, '0x0c');
    await waitText('#board-live-outputs [data-port="hex_lo"] .board-readout', '0xc');
    await flip('load', false);
    await flip('up_down', false);
    await page.locator('#board-tick').click();
    await waitText(leds, '0x0b');
    assert.ok(await page.locator('#board-live-outputs [data-port="hex_hi"] svg.seg-digit').count() >= 1);
    await page.locator('#board-live-stop').click();
    await page.waitForFunction(() => !document.getElementById('board-live-start').disabled);
    await page.locator('#board-mode-replay').click();
    await runPasses(/PASS: counter loaded, counted up\/down and wrapped/);
    await page.getByRole('tab', { name: 'Board' }).click();
    await page.waitForSelector('#board-widgets .board-seg svg.seg-digit');

    // fsm-control: symbolic state names on the waveform state bus and in the Inspector.
    await loadProject('fsm-control');
    await runPasses(/PASS: all 5 states visited/);
    await page.getByRole('tab', { name: 'Waveform' }).click();
    const fsmRow = '.wave-row[data-path="fsm_tb.dut.state"]';
    await page.waitForSelector(fsmRow);
    await page.locator(`${fsmRow} .wave-label span`).click();
    const fsmSeen = [];
    for (let i = 0; i < 17; i++) {
      await page.locator('#wave-step-next').click();
      fsmSeen.push(await page.locator(`${fsmRow} strong`).textContent());
    }
    assert.deepEqual(fsmSeen.slice(0, 5), ['FETCH', 'DECODE', 'EXEC', 'WRITEBACK', 'FETCH'], fsmSeen.join());
    assert.deepEqual([...new Set(fsmSeen)].sort(), ['DECODE', 'EXEC', 'FETCH', 'MEM', 'WRITEBACK'], fsmSeen.join());
    await page.locator('#inspector-filter').fill('dut.next_state');
    assert.match(await page.locator('#signal-inspector .inspector-signal-value').first().textContent(), /^(?:FETCH|DECODE|EXEC|MEM|WRITEBACK)$/);
    await page.locator('#inspector-filter').fill('');

    // alu-suite: four self-checking testbenches in one Run All Tests.
    await loadProject('alu-suite');
    await page.getByRole('tab', { name: 'Tests' }).click();
    for (const tb of ['tb_alu_arith.v', 'tb_alu_logic.v', 'tb_alu_shift.v', 'tb_alu_flags.v']) assert.equal(await page.getByRole('checkbox', { name: `Testbench ${tb}`, exact: true }).isChecked(), true, tb);
    assert.equal(await page.getByRole('checkbox', { name: 'Testbench alu32.v', exact: true }).isChecked(), false);
    await page.locator('#run-all-tests').click();
    await page.waitForFunction(() => !document.getElementById('run-all-tests').disabled && /passed/.test(document.getElementById('tests-summary').textContent)
      && !/Running/.test(document.getElementById('tests-summary').textContent), null, { timeout: 120000 });
    assert.equal(await page.locator('#tests-summary').textContent(), '4/4 passed');
    assert.equal(await page.locator('#tests-results tbody tr').count(), 4);

    // bug-hunter: latch warning pill, jump to the buggy line, drill into u_leaky_ctrl.
    await loadProject('bug-hunter');
    await runPasses(/PASS: datapath slice accumulated/);
    await page.getByRole('tab', { name: 'Schematic' }).click();
    await elaborate('datapath_slice');
    for (const name of ['u_leaky_ctrl', 'u_mux', 'u_alu', 'u_reg']) assert.equal(await page.locator(`#schem-canvas .schem-cell.kind-module[data-name="${name}"]`).count(), 1, name);
    const leak = page.locator('#schem-warnings .schem-warning.kind-latch');
    assert.equal(await leak.count(), 1);
    assert.match(await leak.textContent(), /^LATCHdatapath_slice\.v:34.*latch has been inferred for 'alu_op'/);
    await page.waitForFunction(() => document.getElementById('schem-scope').textContent === 'VCD: datapath_slice_tb.dut');
    await page.locator('#schem-canvas .schem-cell.kind-module[data-name="u_leaky_ctrl"]').dblclick();
    await page.waitForFunction(() => [...document.querySelectorAll('#schem-crumbs .schem-crumb')].map(item => item.textContent).join('/') === 'datapath_slice/u_leaky_ctrl');
    assert.equal(await page.locator('#schem-canvas .schem-cell.kind-latch').count(), 1);
    await leak.click();
    assert.equal(await page.locator('#active-file').textContent(), 'Active: datapath_slice.v');
    assert.ok((await page.locator('#cursor').textContent()).startsWith('Ln 34,'));

    // Pixel 8: More sheet -> Showcase Projects, single-column cards inside the viewport.
    await page.setViewportSize({ width: 412, height: 915 });
    await page.locator('#mobile-more').click();
    await page.getByRole('button', { name: 'Showcase Projects…' }).click();
    await page.waitForSelector('#template-dialog[open]');
    assert.equal(await page.locator('#showcase-grid').evaluate(grid => getComputedStyle(grid).gridTemplateColumns.split(' ').length), 1);
    const sheetBox = await page.locator('#template-dialog').boundingBox();
    assert.ok(sheetBox.x >= 0 && sheetBox.x + sheetBox.width <= 412 && sheetBox.height <= 915 * 0.85 + 1, JSON.stringify(sheetBox));
    assert.equal(await page.locator('#template-dialog .showcase-scroll').evaluate(el => el.scrollHeight > el.clientHeight), true);
    await page.locator('[data-project="fsm-control"]').scrollIntoViewIfNeeded();
    await page.locator('[data-project="fsm-control"]').click();
    await page.waitForFunction(() => !document.getElementById('template-dialog').open);
    assert.equal(await page.locator('body').getAttribute('data-view'), 'code');
    assert.equal(await page.locator('#active-file').textContent(), 'Active: multicycle_fsm.v');
    await page.setViewportSize({ width: 1440, height: 900 });

    // 18. Polish: semantic syntax colors (structural / behavioral / simulation, MIPS real vs pseudo),
    //     1-tap mobile key row toggle, and the About dialog.
    const tokenStyles = words => page.evaluate(list => {
      const spans = [...document.querySelectorAll('#editor .cm-content .cm-line span')];
      return Object.fromEntries(list.map(word => {
        const span = spans.find(item => item.textContent === word);
        if (!span) return [word, null];
        const style = getComputedStyle(span);
        return [word, { color: style.color, italic: style.fontStyle === 'italic' }];
      }));
    }, words);
    await createFile('sem/colors.v', 'module sem(input a, input b, output y);\n  and g1(y, a, b);\n  assign y2 = a;\n  always @(*) if (a) begin\n    case (b)\n      default: ;\n    endcase\n  end\n  initial #10 $display("x");\nendmodule\n');
    await page.waitForFunction(() => [...document.querySelectorAll('#editor .cm-content .cm-line span')].some(span => span.textContent === '#10'));
    const vStyles = await tokenStyles(['module', 'and', 'assign', 'always', 'if', 'case', 'begin', 'initial', '#10', 'input', '$display']);
    for (const [word, style] of Object.entries(vStyles)) assert.ok(style, `${word} should be highlighted`);
    const structural = vStyles.module.color, behavioral = vStyles.always.color, simOnly = vStyles.initial.color;
    assert.deepEqual([vStyles.and.color, vStyles.assign.color], [structural, structural]);
    assert.deepEqual([vStyles.if.color, vStyles.case.color, vStyles.begin.color], [behavioral, behavioral, behavioral]);
    assert.equal(vStyles['#10'].color, simOnly);
    assert.equal(new Set([structural, behavioral, simOnly, vStyles.input.color]).size, 4, JSON.stringify(vStyles));
    assert.equal(vStyles.always.italic, false);
    assert.equal(behavioral, await page.evaluate(() => { const probe = document.createElement('span'); probe.style.color = 'var(--s-control)'; document.body.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; }));
    await createFile('sem/colors.asm', 'start:  addi $t0, $zero, 1\n        add  $t1, $t0, $t0\n        li   $t2, 5\n        move $t3, $t2\n        nop\n        beq  $t0, $t1, start\n');
    await page.waitForFunction(() => document.querySelector('#editor .cm-content')?.getAttribute('data-language') === 'mips');
    const mStyles = await tokenStyles(['addi', 'add', 'beq', 'li', 'move', 'nop']);
    assert.deepEqual([mStyles.add.color, mStyles.beq.color], [mStyles.addi.color, mStyles.addi.color]);
    assert.deepEqual([mStyles.move.color, mStyles.nop.color], [mStyles.li.color, mStyles.li.color]);
    assert.notEqual(mStyles.addi.color, mStyles.li.color);
    assert.equal(mStyles.addi.color, structural);
    assert.equal(mStyles.li.color, behavioral);
    assert.deepEqual([mStyles.addi.italic, mStyles.li.italic, mStyles.move.italic, mStyles.nop.italic], [false, true, true, true]);
    await page.locator('#open-help').click();
    await page.waitForSelector('#help-dialog[open]');
    assert.equal(await page.locator('#help-syntax-key .syntax-key-item').count(), 4);
    assert.equal(await page.locator('#help-syntax-key .k-control code').first().evaluate(code => getComputedStyle(code).color), behavioral);
    await page.locator('#close-help').click();

    // About: desktop brand button, Settings footer, palette.
    await page.locator('#open-about').click();
    await page.waitForSelector('#about-dialog[open]');
    assert.equal(await page.locator('#about-author').textContent(), 'franticplant');
    assert.equal(await page.locator('#about-author').getAttribute('href'), 'https://github.com/franticplant');
    assert.equal(await page.locator('#about-author').getAttribute('target'), '_blank');
    assert.match(await page.locator('#about-author').getAttribute('rel'), /noopener/);
    assert.match(await page.locator('#about-dialog').textContent(), /Created by franticplant/);
    assert.equal(await page.locator('#about-repo').getAttribute('href'), 'https://github.com/franticplant/datapath-ide');
    assert.equal(await page.evaluate(async () => (await fetch(document.querySelector('link[rel="icon"]').href)).status), 200);
    assert.equal(await page.locator('#about-dialog .about-pills li').count(), 6);
    assert.deepEqual(await page.evaluate(async () => Promise.all(['engine/COPYING.icarus', 'vendor/LICENSES.txt'].map(async path => (await fetch(path)).status))), [200, 200]);
    await page.locator('#close-about').click();
    await page.waitForFunction(() => !document.getElementById('about-dialog').open);
    await page.locator('#preferences').click();
    await page.locator('#settings-about').click();
    await page.waitForFunction(() => document.getElementById('about-dialog').open && !document.getElementById('settings-dialog').open);
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.getElementById('about-dialog').open);
    await page.keyboard.press('Control+Shift+P');
    await page.locator('#palette-input').fill('About Datapath');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#about-dialog[open]');
    await page.locator('#close-about').click();

    // Pixel 8: hide the key row from the row itself, re-enable it from More, About from More.
    await page.setViewportSize({ width: 412, height: 915 });
    await page.locator('#editor .cm-content').click();
    await page.waitForFunction(() => document.body.classList.contains('typing'));
    assert.equal(await page.locator('#keybar').isVisible(), true);
    const hideKey = page.locator('#keybar [data-keybar-hide]');
    assert.equal(await hideKey.getAttribute('aria-label'), 'Hide key row');
    assert.equal(await hideKey.textContent(), '⌄');
    await hideKey.dispatchEvent('pointerdown', { bubbles: true });
    await hideKey.dispatchEvent('pointerup', { bubbles: true });
    await page.waitForFunction(() => document.body.classList.contains('no-keybar'));
    assert.equal(await page.locator('#toast').textContent(), 'Key row hidden — re-enable in More or Settings');
    assert.equal(await page.locator('#keybar').isVisible(), false);
    await page.locator('#mobile-more').click();
    assert.equal(await page.locator('#more-grid button').first().textContent(), 'Key row: Off');
    await page.locator('#more-grid button', { hasText: 'Key row: Off' }).click();
    await page.waitForFunction(() => !document.body.classList.contains('no-keybar') && !document.getElementById('more-dialog').open);
    await page.locator('#mobile-more').click();
    assert.equal(await page.locator('#more-grid button').first().textContent(), 'Key row: On');
    await page.locator('#more-grid button', { hasText: 'About Datapath Studio' }).click();
    await page.waitForSelector('#about-dialog[open]');
    const aboutBox = await page.locator('#about-dialog').boundingBox();
    assert.ok(aboutBox.x >= 0 && aboutBox.x + aboutBox.width <= 412 && aboutBox.y >= 0 && aboutBox.y + aboutBox.height <= 915, JSON.stringify(aboutBox));
    const authorBox = await page.locator('#about-author').boundingBox();
    assert.ok(authorBox.y + authorBox.height <= aboutBox.y + aboutBox.height, 'Author credit must be visible without scrolling');
    assert.equal(await page.locator('#about-dialog').evaluate(dialog => dialog.scrollWidth <= dialog.clientWidth), true);
    await page.locator('#close-about').click();
    await page.waitForFunction(() => !document.getElementById('about-dialog').open);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 19. Stage 5: Back / Forward history, schematic interactivity (inspector, fan-in/out, cone, find, minimap,
    //     pinch zoom) and the live cycle learning bar.
    const viewBox = () => page.locator('#schem-canvas').evaluate(svg => svg.getAttribute('viewBox').split(' ').map(Number));
    await page.locator('#open-about').click();
    await page.waitForSelector('#about-dialog[open]');
    const urlBefore = page.url();
    await page.evaluate(() => window.history.back());
    await page.waitForFunction(() => !document.getElementById('about-dialog').open);
    assert.equal(page.url(), urlBefore);
    assert.equal(await page.locator('#run').count(), 1);

    await loadProject('mips-cpu');
    await runPasses(/PASS: \$s0 = 8/);
    await page.getByRole('tab', { name: 'Schematic' }).click();
    await elaborate('mips_cpu');
    await page.waitForFunction(() => /^VCD: /.test(document.getElementById('schem-scope').textContent) && !/no matching/.test(document.getElementById('schem-scope').textContent));
    assert.equal(await page.locator('#schem-minimap').isVisible(), true);
    assert.ok(await page.locator('#schem-minimap .mm-node').count() >= 5);

    // Net highlight: every segment of the net plus its driver (fan-in) and loads (fan-out).
    for (let i = 0; i < 3; i++) await page.locator('#schem-step-next').click();
    await waitText('#schem-time', '25 ns');
    const netEdge = await page.locator('#schem-canvas path.schem-wire[data-net="alu_y"]').first().getAttribute('data-edge');
    await page.locator(`#schem-canvas path.schem-hit[data-edge="${netEdge}"]`).dispatchEvent('click');
    await page.waitForSelector('#schem-inspector:not([hidden])');
    assert.equal(await page.locator('#schem-canvas').evaluate(svg => svg.classList.contains('has-focus')), true);
    assert.equal(await page.locator('#schem-canvas path.schem-wire.is-selected').count(), await page.locator('#schem-canvas path.schem-wire[data-net="alu_y"]').count());
    assert.equal(await page.locator('#schem-canvas .schem-cell.kind-module[data-name="u_alu"].is-fanin').count(), 1);
    assert.ok(await page.locator('#schem-canvas .is-fanout').count() >= 2);
    assert.match(await page.locator('#schem-inspector .si-title').textContent(), /^alu_y/);
    assert.match(await page.locator('#schem-inspector .si-explain').textContent(), /^Value now: 0x[0-9a-f]{8}$/);

    // Cell: inspector with live pins, fan-in/out, Trace Cone, Active mux branch.
    await page.locator('#schem-canvas .schem-cell.kind-op[data-type="$add"]').first().click();
    await page.waitForFunction(() => document.querySelector('#schem-inspector .si-title')?.textContent === '$add');
    assert.match(await page.locator('#schem-inspector .si-explain').textContent(), /^0x[0-9a-f]{8} \+ 0x[0-9a-f]{8} = 0x[0-9a-f]{8}$/);
    assert.ok((await page.locator('#schem-inspector .si-pins .si-value').allTextContents()).every(value => /^0x[0-9a-f]+$/.test(value)));
    assert.equal(await page.locator('#schem-canvas .schem-cell.is-selected').count(), 1);
    const nearby = await page.locator('#schem-canvas .schem-cell.is-fanin, #schem-canvas .schem-cell.is-fanout, #schem-canvas .schem-port.is-fanin, #schem-canvas .schem-port.is-fanout').count();
    assert.ok(nearby >= 2);
    await page.locator('#schem-inspector [data-action="cone"]').click();
    assert.equal(await page.locator('#schem-inspector [data-action="cone"]').getAttribute('aria-pressed'), 'true');
    assert.ok(await page.locator('#schem-canvas .schem-cell.is-fanin, #schem-canvas .schem-cell.is-fanout, #schem-canvas .schem-port.is-fanin, #schem-canvas .schem-port.is-fanout').count() > nearby);
    let activeMux = false;
    for (let i = 0; i < await page.locator('#schem-canvas .schem-cell.kind-mux').count() && !activeMux; i++) {
      await page.locator('#schem-canvas .schem-cell.kind-mux').nth(i).click();
      activeMux = await page.locator('#schem-inspector .si-active').count() === 1;
    }
    assert.ok(activeMux, 'a mux with a live select shows its Active input');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.getElementById('schem-inspector').hidden && !document.getElementById('schem-canvas').classList.contains('has-focus'));

    // Find in schematic (cell, then net), minimap toggle and click-to-pan, pinch zoom.
    const fitBox = await viewBox();
    await page.locator('#schem-search').fill('u_rf');
    await page.locator('#schem-search').press('Enter');
    assert.equal(await page.locator('#schem-search-count').textContent(), '1/1');
    await page.waitForFunction(() => document.querySelector('#schem-inspector .si-title')?.textContent === 'u_rf : mips_regfile');
    assert.equal(await page.locator('#schem-canvas .schem-cell[data-name="u_rf"].is-selected').count(), 1);
    await page.waitForTimeout(300);
    assert.ok((await viewBox())[2] < fitBox[2], 'find zooms in on the match');
    await page.locator('#schem-search').fill('alu_y');
    await page.locator('#schem-search').press('Enter');
    await page.waitForFunction(() => /^alu_y/.test(document.querySelector('#schem-inspector .si-title')?.textContent || ''));
    assert.ok(await page.locator('#schem-canvas path.schem-wire.is-selected').count() >= 1);
    await page.locator('#schem-search').fill('');
    await page.locator('#schem-fit').click();
    await page.locator('#schem-map').click();
    assert.equal(await page.locator('#schem-minimap').isVisible(), false);
    await page.locator('#schem-map').click();
    assert.equal(await page.locator('#schem-minimap').isVisible(), true);
    const beforePan = await viewBox();
    const mapBox = await page.locator('#schem-minimap').boundingBox();
    await page.mouse.click(mapBox.x + mapBox.width * 0.85, mapBox.y + mapBox.height * 0.8);
    const afterPan = await viewBox();
    assert.ok(afterPan[0] !== beforePan[0] && Math.abs(afterPan[2] - beforePan[2]) < 0.01, 'minimap click pans without zooming');
    await page.locator('#schem-fit').click();
    const pinchBefore = await viewBox();
    await page.evaluate(() => {
      const svg = document.getElementById('schem-canvas');
      const rect = svg.getBoundingClientRect();
      const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
      const fire = (type, id, x) => svg.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: cy, bubbles: true, isPrimary: id === 11 }));
      fire('pointerdown', 11, cx - 40); fire('pointerdown', 12, cx + 40);
      fire('pointermove', 12, cx + 80); fire('pointermove', 11, cx - 80);
      fire('pointerup', 11, cx - 80); fire('pointerup', 12, cx + 80);
    });
    const pinchAfter = await viewBox();
    assert.ok(Math.abs(pinchAfter[2] / pinchBefore[2] - 0.5) < 0.02, `pinch doubles the zoom: ${pinchBefore} -> ${pinchAfter}`);
    assert.ok(Math.abs((pinchAfter[0] + pinchAfter[2] / 2) - (pinchBefore[0] + pinchBefore[2] / 2)) < 1, 'pinch stays centred on the fingers');
    await page.locator('#schem-canvas').dispatchEvent('dblclick');   // on the background itself (cells may sit under any point after zooming)
    const fitted = await viewBox();
    assert.deepEqual(fitted.map(Math.round), pinchBefore.map(Math.round), `double-click on the background fits: ${fitted} vs ${pinchBefore}`);

    // Learning bar: decoded instruction + what changed this cycle; a change pill opens the State tab.
    assert.equal(await page.locator('#schem-learn-bar').isVisible(), true);
    while ((await page.locator('#schem-time').textContent()) !== '5 ns') await page.locator('#schem-step-prev').click();
    const instrSeen = [], changeSeen = [];
    for (let i = 0; i < 17; i++) {
      instrSeen.push(await page.locator('#schem-learn-instr').textContent());
      changeSeen.push(...await page.locator('#schem-learn-bar .learn-change').allTextContents());
      await page.locator('#schem-step-next').click();
    }
    assert.equal(instrSeen[0], 'PC 0x00000000 · addi $t0, $zero, 1', instrSeen.join(' | '));
    assert.ok(instrSeen.some(text => /^PC 0x00000008 · add \$t2, \$t0, \$t1$/.test(text)), instrSeen.join(' | '));
    assert.ok(instrSeen.some(text => /^PC 0x000000[0-9a-f]{2} · sw \$t\d, \d+\(\$zero\)$/.test(text)), instrSeen.join(' | '));
    assert.ok(changeSeen.includes('$t0 ← 0x00000001') && changeSeen.includes('$t5 ← 0x00000008'), changeSeen.join(' | '));
    assert.ok(changeSeen.some(text => /^dmem\[\d\] ← 0x0000000[1-8]$/.test(text)), changeSeen.join(' | '));
    await page.locator('#schem-step-prev').click();
    while (!(await page.locator('#schem-learn-bar button.learn-change').count())) await page.locator('#schem-step-prev').click();
    const pillPath = await page.locator('#schem-learn-bar button.learn-change').first().getAttribute('data-path');
    await page.locator('#schem-learn-bar button.learn-change').first().click();
    assert.equal(await page.locator('#hw-state').isVisible(), true);
    assert.equal(await page.locator(`#hw-arrays [data-array="${pillPath}"]`).getAttribute('aria-pressed'), 'true');

    // Pixel 8: Code -> Files -> Schematic -> Open Submodule -> Jump to Code, then Back unwinds each step.
    await page.getByRole('tab', { name: 'Schematic' }).click();
    if (await page.locator('#schem-crumbs .schem-crumb').count() > 1) await page.locator('#schem-crumbs .schem-crumb').first().click();
    await page.setViewportSize({ width: 412, height: 915 });
    await page.locator('button[data-view="code"]').click();
    await page.locator('button[data-view="files"]').click();
    await page.locator('button[data-view="console"]').click();
    await page.locator('[data-panel="schematic"]').click();
    await page.waitForFunction(() => document.body.dataset.view === 'console' && !document.getElementById('schematic').hidden);
    await page.locator('#schem-fit').click();
    await page.locator('#schem-canvas .schem-cell.kind-module[data-name="u_alu"]').click();
    await page.waitForSelector('#schem-inspector:not([hidden]) [data-action="drill"]');
    assert.equal(await page.locator('body').getAttribute('data-view'), 'console', 'a tap inspects without leaving the diagram');
    const inspectorBox = await page.locator('#schem-inspector').boundingBox();
    const stageBox = await page.locator('.schem-stage').boundingBox();
    assert.ok(Math.abs(inspectorBox.width - stageBox.width) < 4 && inspectorBox.y + inspectorBox.height <= stageBox.y + stageBox.height + 1, 'card docks full width at the bottom on phones');
    await page.locator('#schem-inspector [data-action="drill"]').click();
    const crumbsText = () => page.locator('#schem-crumbs .schem-crumb').evaluateAll(items => items.map(item => item.textContent).join('/'));
    await page.waitForFunction(() => [...document.querySelectorAll('#schem-crumbs .schem-crumb')].map(item => item.textContent).join('/') === 'mips_cpu/u_alu');
    await page.locator('#schem-canvas .schem-cell.has-src').first().click();
    await page.locator('#schem-inspector [data-action="jump"]').click();
    await page.waitForFunction(() => document.body.dataset.view === 'code');
    assert.equal(await page.locator('#active-file').textContent(), 'Active: mips_cpu.v');
    assert.equal(await page.locator('#nav-back').isVisible(), true);
    await page.evaluate(() => window.history.back());
    await page.waitForFunction(() => document.body.dataset.view === 'console' && !document.getElementById('schematic').hidden);
    assert.equal(await crumbsText(), 'mips_cpu/u_alu');
    assert.equal(await page.locator('#schem-inspector').isVisible(), false);
    await page.evaluate(() => window.history.back());
    await page.waitForFunction(() => [...document.querySelectorAll('#schem-crumbs .schem-crumb')].map(item => item.textContent).join('/') === 'mips_cpu');
    assert.equal(await page.locator('body').getAttribute('data-view'), 'console');
    await page.locator('#nav-back').click();   // the Console view (Schematic was its second tap)
    await page.waitForFunction(() => document.body.dataset.view === 'console' && !document.getElementById('console').hidden);
    await page.locator('#nav-back').click();
    await page.waitForFunction(() => document.body.dataset.view === 'files');
    await page.locator('#nav-back').click();
    await page.waitForFunction(() => document.body.dataset.view === 'code');
    await page.evaluate(() => window.history.forward());
    await page.waitForFunction(() => document.body.dataset.view === 'files');
    await page.locator('#mobile-more').click();
    await page.locator('#more-grid button', { hasText: 'About Datapath Studio' }).click();
    await page.waitForSelector('#about-dialog[open]');
    await page.evaluate(() => window.history.back());
    await page.waitForFunction(() => !document.getElementById('about-dialog').open && !document.getElementById('more-dialog').open);
    assert.equal(await page.locator('body').getAttribute('data-view'), 'files', 'Back closes the dialog opened from the sheet, nothing more');
    await page.locator('button[data-view="code"]').click();
    await page.setViewportSize({ width: 1440, height: 900 });

    // FSM: symbolic transitions in the learning bar.
    await loadProject('fsm-control');
    await runPasses(/PASS: all 5 states visited/);
    await page.getByRole('tab', { name: 'Schematic' }).click();
    await page.waitForSelector('#schem-learn-bar:not([hidden])');
    const fsmChanges = [];
    for (let i = 0; i < 8; i++) {
      await page.locator('#schem-step-next').click();
      fsmChanges.push(...await page.locator('#schem-learn-bar .learn-change.kind-state').allTextContents());
    }
    assert.ok(fsmChanges.includes('state: FETCH → DECODE') && fsmChanges.includes('state: DECODE → EXEC'), fsmChanges.join(' | '));
    assert.equal(await page.locator('#schem-learn-instr').count(), 0, 'no PC, no instruction pill');

    // Root exit guard: after a fresh load, the first Back only warns.
    await page.reload();
    await page.waitForFunction(() => !document.getElementById('run').disabled);
    const rootUrl = page.url();
    await page.evaluate(() => window.history.back());
    await waitText('#toast', 'Press back again to leave Datapath Studio');
    assert.equal(page.url(), rootUrl);
    assert.equal(await page.locator('#run').count(), 1);

    assert.deepEqual(browserErrors, []);
    console.log('Browser workspace checks passed');
  } finally {
    if (browser) await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
