import { maskVerilog } from './verilog-lex.js';
const ident = '[A-Za-z_$][\\w$]*';
const lineAt = (s, i) => 1 + (s.slice(0, i).match(/\n/g) || []).length;
function balanced(s, start) {
  let depth = 0;
  for (let i = start; i < s.length; i++) { if (s[i] === '(') depth++; else if (s[i] === ')' && --depth === 0) return i + 1; }
  return -1;
}
export function buildModuleHierarchy(files, excluded = new Set()) {
  const modules = [];
  for (const [file, source] of Object.entries(files)) {
    if (excluded.has(file) || !/\.(?:v|sv)$/i.test(file)) continue;
    const text = maskVerilog(source);
    const re = /\b(?:module|macromodule)\s+([A-Za-z_$][\w$]*)\b([\s\S]*?)\bendmodule\b/g;
    for (const m of text.matchAll(re)) {
      const header = m[2].split(';')[0];
      modules.push({ name: m[1], file, line: lineAt(text, m.index), ports: header.trim(), instances: [], _text: m[0], _offset: m.index });
    }
  }
  const names = new Set(modules.map(m => m.name));
  for (const mod of modules) {
    const re = new RegExp(`\\b(${ident})\\s*`, 'g');
    let m;
    while ((m = re.exec(mod._text))) {
      if (!names.has(m[1]) || /\b(?:module|macromodule)\s*$/.test(mod._text.slice(0, m.index))) continue;
      let pos = re.lastIndex;
      if (mod._text[pos] === '#') { pos++; while (/\s/.test(mod._text[pos] || '')) pos++; if (mod._text[pos] !== '(' || (pos = balanced(mod._text, pos)) < 0) continue; }
      const rest = mod._text.slice(pos).match(/^\s*([A-Za-z_$][\w$]*)\s*(?:\[[^\]]+\]\s*)?\(/);
      if (rest) mod.instances.push({ type: m[1], instance: rest[1], file: mod.file, line: lineAt(maskVerilog(files[mod.file]), mod._offset + m.index) });
    }
    delete mod._text; delete mod._offset;
  }
  const byName = new Map(modules.map(m => [m.name, m]));
  const referenced = new Set(modules.flatMap(m => m.instances.map(i => i.type)));
  const visited = new Set();
  function tree(mod, instance = null, ancestors = new Set()) {
    visited.add(mod.name);
    const cyclic = ancestors.has(mod.name);
    const next = new Set(ancestors); next.add(mod.name);
    return { ...mod, instance, cyclic, children: cyclic ? [] : mod.instances.filter(i => byName.has(i.type)).map(i => tree(byName.get(i.type), i, next)) };
  }
  const roots = modules.filter(m => !referenced.has(m.name)).map(m => tree(m));
  for (const mod of modules) if (!visited.has(mod.name)) roots.push(tree(mod));
  const flat = [];
  const flatten = (n, depth) => { flat.push({ ...n, depth }); n.children.forEach(c => flatten(c, depth + 1)); };
  roots.forEach(n => flatten(n, 0));
  return { modules, roots, flat };
}
