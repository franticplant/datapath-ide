// Unified file, line, symbol and command navigation.
import { extractFileSymbols } from './rtl-quickfix.js';

export function installQuickOpen({ getFiles, getCurrentFile, openFile, openAt, getCommands }) {
  const dialog = document.getElementById('quick-open-dialog');
  const input = document.getElementById('quick-open-input');
  const list = document.getElementById('quick-open-list');
  let entries = [], active = 0;
  const score = (text, query) => {
    text = String(text).toLowerCase(); query = query.toLowerCase();
    if (!query) return 0;
    let pos = 0, total = 0, previous = -2;
    for (const char of query) {
      const index = text.indexOf(char, pos); if (index < 0) return Infinity;
      total += index === previous + 1 ? 0 : index - pos + 2;
      previous = index; pos = index + 1;
    }
    return total + text.length / 1000;
  };
  function select(index) {
    if (!entries.length) return;
    active = (index + entries.length) % entries.length;
    [...list.children].forEach((item, i) => { item.classList.toggle('selected', i === active); item.setAttribute('aria-selected', String(i === active)); });
    list.children[active]?.scrollIntoView({ block: 'nearest' });
  }
  function render() {
    const raw = input.value, prefix = /^[@:>]/.test(raw) ? raw[0] : '', query = prefix ? raw.slice(1).trim() : raw.trim();
    const current = getCurrentFile();
    let items;
    if (prefix === ':') {
      const line = Number(query);
      items = Number.isSafeInteger(line) && line > 0 && current ? [{ label: `Go to line ${line}`, hint: current, run: () => openAt(current, line) }] : [];
    } else if (prefix === '@') {
      items = extractFileSymbols(getFiles()[current] || '').map(symbol => ({ label: symbol.name, hint: `${symbol.kind} · ${symbol.line}`, run: () => openAt(current, symbol.line) }));
    } else if (prefix === '>') {
      items = getCommands().map(command => ({ label: command.label, hint: command.hint || 'command', run: command.run }));
    } else {
      items = Object.keys(getFiles()).sort().map(path => ({ label: path, hint: 'file', run: () => openFile(path) }));
    }
    entries = items.map(item => ({ item, rank: prefix === ':' ? 0 : score(item.label, query) })).filter(entry => Number.isFinite(entry.rank)).sort((a, b) => a.rank - b.rank || a.item.label.localeCompare(b.item.label)).slice(0, 100).map(entry => entry.item);
    active = 0; list.replaceChildren();
    for (const item of entries) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'quick-open-item'; button.setAttribute('role', 'option');
      const label = document.createElement('span'); label.textContent = item.label;
      const hint = document.createElement('small'); hint.textContent = item.hint;
      button.append(label, hint); button.onclick = () => { dialog.close(); item.run(); }; list.append(button);
    }
    select(0);
  }
  input.addEventListener('input', render);
  input.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); select(active + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter') { event.preventDefault(); list.children[active]?.click(); }
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  return { open(initial = '') { input.value = initial; if (!dialog.open) dialog.showModal(); render(); input.focus(); input.setSelectionRange(input.value.length, input.value.length); } };
}
