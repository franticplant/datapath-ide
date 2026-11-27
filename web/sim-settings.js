import { validPath } from './archive.js';
const key = 'datapath.sim-settings.v1';
const defaults = { defines: '', includeDirs: '', parameters: '', plusargs: '', warnings: [], specify: false, stopAsFinish: true, outputCap: 512, vcdCap: 32, order: [] };
const lines = value => value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
export function installSimSettings(getFiles, getExcluded, onExcludedChange) {
  const $ = id => document.getElementById(id);
  let state = { ...defaults };
  try { const saved = JSON.parse(localStorage.getItem(key)); if (saved && typeof saved === 'object') state = { ...state, ...saved }; } catch { /* Use defaults. */ }
  for (const name of ['defines', 'includeDirs', 'parameters', 'plusargs']) if (typeof state[name] !== 'string') state[name] = '';
  if (!Array.isArray(state.warnings)) state.warnings = [];
  if (!Array.isArray(state.order)) state.order = [];
  const fields = { 'defines': 'defines', 'include-dirs': 'includeDirs', 'parameters': 'parameters', 'plusargs': 'plusargs', 'output-cap': 'outputCap', 'vcd-cap': 'vcdCap' };
  for (const [id, name] of Object.entries(fields)) { $(id).value = state[name]; $(id).addEventListener('input', event => { state[name] = event.target.value; save(); }); }
  for (const [id, name] of [['specify', 'specify'], ['stop-as-finish', 'stopAsFinish']]) { $(id).checked = !!state[name]; $(id).addEventListener('change', event => { state[name] = event.target.checked; save(); }); }
  document.querySelectorAll('[data-warning]').forEach(input => { input.checked = state.warnings.includes(input.dataset.warning); input.onchange = () => { state.warnings = [...document.querySelectorAll('[data-warning]:checked')].map(item => item.dataset.warning); save(); }; });
  function save() { try { localStorage.setItem(key, JSON.stringify(state)); } catch { $('save-state').textContent = 'Could not save simulation settings'; } }
  function render() {
    const files = getFiles(); const excluded = getExcluded(); const paths = Object.keys(files).filter(path => /\.(?:v|sv)$/i.test(path));
    state.order = [...new Set([...state.order.filter(path => paths.includes(path)), ...paths])];
    const container = $('source-order'); container.replaceChildren();
    state.order.forEach((path, index) => {
      const row = document.createElement('div'); row.className = 'source-row';
      const label = document.createElement('label'); const check = document.createElement('input'); check.type = 'checkbox'; check.checked = !excluded.has(path); check.setAttribute('aria-label', `Include ${path} in build`); check.onchange = () => onExcludedChange(path, !check.checked);
      const name = document.createElement('span'); name.textContent = path; name.title = path; label.append(check, name);
      const up = document.createElement('button'); up.textContent = '↑'; up.disabled = index === 0; up.setAttribute('aria-label', `Move ${path} up`); up.onclick = () => { [state.order[index - 1], state.order[index]] = [state.order[index], state.order[index - 1]]; save(); render(); };
      const down = document.createElement('button'); down.textContent = '↓'; down.disabled = index === state.order.length - 1; down.setAttribute('aria-label', `Move ${path} down`); down.onclick = () => { [state.order[index + 1], state.order[index]] = [state.order[index], state.order[index + 1]]; save(); render(); };
      row.append(label, up, down); container.append(row);
    });
  }
  function snapshot() {
    const defines = lines(state.defines); const includeDirs = lines(state.includeDirs); const parameters = lines(state.parameters); const plusargs = lines(state.plusargs);
    if (defines.some(value => !/^[A-Za-z_$][\w$]*(?:=.*)?$/.test(value))) throw new Error('Invalid macro definition. Use NAME or NAME=value.');
    if (includeDirs.some(path => path !== '.' && !validPath(path))) throw new Error('Include paths must be relative project paths.');
    if (parameters.some(value => !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+=.+$/.test(value))) throw new Error('Invalid parameter override. Use top.PARAM=value.');
    if (plusargs.some(value => !value.startsWith('+'))) throw new Error('Runtime plusargs must start with +.');
    const outputCap = Number(state.outputCap); const vcdCap = Number(state.vcdCap);
    if (!Number.isInteger(outputCap) || outputCap < 4 || outputCap > 8192 || !Number.isInteger(vcdCap) || vcdCap < 1 || vcdCap > 32) throw new Error('Set output limit to 4–8192 Ki characters and VCD limit to 1–32 MiB.');
    return { defines, includeDirs, parameters, plusargs, warnings: state.warnings.filter(item => ['all', 'implicit', 'portbind', 'timescale'].includes(item)), specify: !!state.specify, stopAsFinish: !!state.stopAsFinish, outputCap: outputCap * 1024, vcdCap: vcdCap * 1024 * 1024, sourceFiles: state.order.filter(path => Object.hasOwn(getFiles(), path) && !getExcluded().has(path)) };
  }
  render(); return { render, snapshot };
}
