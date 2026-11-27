import { maskVerilog } from './verilog-lex.js';
import { valueAt } from './vcd.js';
import { formatValue } from './waveform.js';
import { stateNameFor } from './fsm-states.js';

export function computeInlineValues(source, trace, cursorTime, { scopeHint = '', radix = 'hex', fsmMap = null, maxPerLine = 3 } = {}) {
  if (!trace?.signals || cursorTime == null) return [];
  const lines = maskVerilog(source).split('\n');
  const signals = trace.signals;
  let scope = '';
  const result = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const module = /\b(?:module|macromodule)\s+([\w$]+)/.exec(line);
    if (module) scope = module[1];
    const names = new Set();
    if (/\b(?:input|output|inout|wire|reg|logic|integer)\b/.test(line)) {
      for (const match of line.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) names.add(match[0]);
    }
    for (const match of line.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:\[[^\]]+\]\s*)?(?:<=|=(?!=))/g)) names.add(match[1]);
    const items = [];
    for (const name of names) {
      const candidates = signals.filter(s => s.path.split('.').at(-1) === name);
      const signal = candidates.find(s => scopeHint && (s.path === `${scopeHint}.${name}` || s.path.includes(`.${scopeHint}.`))) || candidates.find(s => scope && s.path.split('.').includes(scope)) || candidates[0];
      if (!signal) continue;
      const raw = typeof trace.valueAt === 'function' ? trace.valueAt(signal, cursorTime) : valueAt(signal, BigInt(cursorTime));
      const value = radix === 'state' && fsmMap ? stateNameFor(fsmMap, signal.path, raw) || formatValue(raw, signal.width, 'hex') : formatValue(raw, signal.width, radix);
      items.push({ name, path: signal.path, value });
      if (items.length >= maxPerLine) break;
    }
    if (items.length) result.push({ line: i + 1, text: items.map(x => `${x.name} = ${x.value}`).join('  '), items });
    if (/\bendmodule\b/.test(line)) scope = '';
  }
  return result;
}
