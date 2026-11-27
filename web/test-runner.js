// Batch testbench runner: each selected TB compiles against the RTL sources with its own top module, one after another.
import { EngineClient } from './engine-client.js';

const TB_NAME = /(?:^|\/)tb[_.-]|[_.-]tb\.(?:v|sv)$/i;
const SOURCE = /\.(?:v|sv)$/i;
const prefsKey = 'datapath.tests.v1';

export function looksLikeTestbench(path, text) {
  if (!SOURCE.test(path)) return false;
  return TB_NAME.test(path) || (typeof text === 'string' && (text.includes('$finish') || /testbench/i.test(text)));
}

export function firstModule(text) {
  return /\bmodule\s+([A-Za-z_][\w$]*)/.exec(String(text || '').replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''))?.[1] || '';
}

// Counts PASS/FAIL markers in simulator output. ERROR lines count as failures.
export function parseTestOutput(text) {
  let pass = 0, fail = 0;
  for (const line of String(text || '').split('\n')) {
    if (/\b(?:FAIL(?:ED|URE|S)?|ERROR)\b/i.test(line)) fail++;
    else if (/\bPASS(?:ED|ES)?\b/i.test(line)) pass++;
  }
  return { pass, fail };
}

export function installTestRunner({ prepare = null, getFiles, getExcluded, getSettings, getStandard, createWorker, onShowLog, onShowWave, onState }) {
  const $ = id => document.getElementById(id);
  let overrides = {};
  try { const saved = JSON.parse(localStorage.getItem(prefsKey)); if (saved?.overrides && typeof saved.overrides === 'object') overrides = saved.overrides; } catch { /* Use detection. */ }
  let results = [];
  let running = false;
  let stopRequested = false;
  let engine = null;
  let engineReady = null;     // promise resolved when the worker is ready
  let resolveReady = null;
  let currentRun = null;      // { resolve, log, vcd, diagnostics }

  const savePrefs = () => { try { localStorage.setItem(prefsKey, JSON.stringify({ overrides })); } catch { /* Ignore. */ } };
  const isTestbench = path => Object.hasOwn(overrides, path) ? overrides[path] === true : looksLikeTestbench(path, getFiles()[path]);

  function ensureEngine() {
    if (engine) return engineReady;
    engineReady = new Promise(resolve => { resolveReady = resolve; });
    engine = new EngineClient(createWorker, event => {
      if (event.type === 'ready') { resolveReady?.(); return; }
      if (event.type === 'engine-error') { finishRun({ status: 'error', message: event.message }); return; }
      if (!currentRun) return;
      if (event.type === 'output') currentRun.log += event.chunk;
      else if (event.type === 'diagnostics') currentRun.diagnostics = event.items || [];
      else if (event.type === 'result') { currentRun.vcd = event.vcdFiles?.[0] || null; currentRun.memTrace = event.memTrace || null; finishRun({ status: 'done' }); }
      else if (event.type === 'error') finishRun({ status: 'error', message: event.message });
      else if (event.type === 'stopped') finishRun({ status: 'stopped' });
    });
    engine.start();
    return engineReady;
  }

  function finishRun(outcome) {
    const run = currentRun;
    if (!run) return;
    currentRun = null;
    run.resolve(outcome);
  }

  // RTL = included sources not marked as testbenches, in the configured source order.
  function sources() {
    const settings = getSettings();
    const excluded = getExcluded();
    const files = getFiles();
    const ordered = settings.sourceFiles.filter(path => Object.hasOwn(files, path) && !excluded.has(path));
    return { settings, rtl: ordered.filter(path => !isTestbench(path)), tbs: ordered.filter(isTestbench) };
  }

  async function runAll() {
    if (running) return;
    // e.g. assemble .asm sources first; a false result aborts the suite.
    if (prepare && !prepare()) { $('tests-summary').textContent = 'Suite aborted: fix the problems first.'; return; }
    let plan;
    try { plan = sources(); } catch (error) { $('tests-summary').textContent = error.message; return; }
    if (!plan.tbs.length) { $('tests-summary').textContent = 'No testbenches selected.'; render(); return; }
    running = true;
    stopRequested = false;
    results = plan.tbs.map(tb => ({ tb, top: firstModule(getFiles()[tb]), status: 'queued', pass: 0, fail: 0, ms: null, log: '', vcd: null, message: '' }));
    updateControls();
    render();
    for (const entry of results) {
      if (stopRequested) { entry.status = 'skipped'; continue; }
      await ensureEngine();
      const started = performance.now();
      const files = getFiles();
      entry.top = firstModule(files[entry.tb]);
      entry.status = 'running';
      render();
      const collected = { log: '', vcd: null, diagnostics: [] };
      const outcome = await new Promise(resolve => {
        currentRun = Object.assign(collected, { resolve });
        try {
          engine.run({ type: 'run', files: { ...files }, ...plan.settings, sourceFiles: [...plan.rtl, entry.tb], topModule: entry.top, standard: getStandard() });
        } catch (error) {
          finishRun({ status: 'error', message: error.message });
        }
      });
      entry.ms = Math.round(performance.now() - started);
      entry.log = collected.log + (outcome.message ? `\n${outcome.message}\n` : '');
      entry.vcd = collected.vcd;
      entry.memTrace = collected.memTrace || null;
      const counts = parseTestOutput(collected.log);
      entry.pass = counts.pass;
      entry.fail = counts.fail;
      entry.message = outcome.message || '';
      if (outcome.status === 'stopped') entry.status = 'stopped';
      else if (outcome.status === 'error') entry.status = 'error';
      else entry.status = counts.fail > 0 ? 'fail' : 'pass';
      render();
    }
    running = false;
    updateControls();
    render();
  }

  function stop() {
    if (!running) return;
    stopRequested = true;
    if (engine && engine.activeRunId !== null) {
      // stop() reports 'stopped' for the active run, then restarts the worker; wait for its next 'ready'.
      engine.stop();
      engineReady = new Promise(resolve => { resolveReady = resolve; });
    }
  }

  function updateControls() {
    $('run-all-tests').disabled = running;
    $('stop-tests').disabled = !running;
    onState?.(running);
  }

  function renderFiles() {
    const host = $('tests-files');
    host.replaceChildren();
    const files = getFiles();
    const excluded = getExcluded();
    const paths = Object.keys(files).filter(path => SOURCE.test(path)).sort();
    for (const path of paths) {
      const label = document.createElement('label');
      label.className = `tests-file${excluded.has(path) ? ' is-excluded' : ''}`;
      const check = document.createElement('input');
      check.type = 'checkbox';
      check.checked = isTestbench(path);
      check.setAttribute('aria-label', `Testbench ${path}`);
      check.onchange = () => {
        if (check.checked === looksLikeTestbench(path, getFiles()[path])) delete overrides[path];
        else overrides[path] = check.checked;
        savePrefs();
        renderFiles();
      };
      const name = document.createElement('span');
      name.textContent = path;
      name.title = excluded.has(path) ? `${path} (excluded from build)` : path;
      const role = document.createElement('span');
      role.className = 'tests-role';
      role.textContent = excluded.has(path) ? 'excluded' : isTestbench(path) ? 'TB' : 'RTL';
      label.append(check, name, role);
      host.append(label);
    }
  }

  const STATUS_TEXT = { queued: 'Queued', running: 'Running…', pass: 'PASS', fail: 'FAIL', error: 'ERROR', stopped: 'Stopped', skipped: 'Skipped' };

  function render() {
    renderFiles();
    const body = $('tests-results').tBodies[0];
    body.replaceChildren();
    for (const entry of results) {
      const row = body.insertRow();
      row.dataset.tb = entry.tb;
      row.className = `is-${entry.status}`;
      const cell = text => { const td = row.insertCell(); td.textContent = text; return td; };
      const status = cell(STATUS_TEXT[entry.status] || entry.status);
      status.className = 'tests-status';
      cell(entry.tb).className = 'tests-name';
      cell(entry.top || '—');
      cell(String(entry.pass));
      cell(String(entry.fail));
      cell(entry.ms === null ? '—' : `${entry.ms} ms`);
      const actions = row.insertCell();
      actions.className = 'tests-actions';
      const log = document.createElement('button');
      log.className = 'chip';
      log.textContent = 'Log';
      log.setAttribute('aria-label', `Log for ${entry.tb}`);
      log.disabled = entry.ms === null;
      log.onclick = () => onShowLog(entry);
      const wave = document.createElement('button');
      wave.className = 'chip';
      wave.textContent = 'Wave';
      wave.setAttribute('aria-label', `Waveform for ${entry.tb}`);
      wave.disabled = !entry.vcd;
      wave.onclick = () => onShowWave(entry);
      actions.append(log, wave);
      if (entry.message) row.title = entry.message;
    }
    const done = results.filter(entry => ['pass', 'fail', 'error', 'stopped'].includes(entry.status));
    const passed = results.filter(entry => entry.status === 'pass').length;
    const failed = results.filter(entry => entry.status === 'fail' || entry.status === 'error').length;
    const summary = $('tests-summary');
    summary.classList.toggle('is-pass', !running && results.length > 0 && failed === 0 && passed === results.length);
    summary.classList.toggle('is-fail', failed > 0);
    if (!results.length) summary.textContent = 'No tests run yet';
    else if (running) summary.textContent = `Running ${Math.min(done.length + 1, results.length)}/${results.length}… ${passed} passed, ${failed} failed`;
    else summary.textContent = `${passed}/${results.length} passed${failed ? `, ${failed} failed` : ''}${results.some(entry => entry.status === 'stopped' || entry.status === 'skipped') ? ' (stopped)' : ''}`;
  }

  $('run-all-tests').onclick = runAll;
  $('stop-tests').onclick = stop;
  $('run-all-tests').disabled = false;
  render();

  return { render: renderFiles, runAll, stop, isRunning: () => running, isTestbench };
}
