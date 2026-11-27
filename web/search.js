// Workspace-wide text search (Ctrl+Shift+F) and Go to Definition (F12) over the in-memory project files.
const MAX_RESULTS = 500;
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Lines that declare `name` as a module-like unit, function, task or macro.
function definitionPatterns(name) {
  const id = escapeRegExp(name);
  return [
    { kind: 'module', re: new RegExp(`\\b(?:module|macromodule|interface|program|package|primitive)\\s+(?:automatic\\s+|static\\s+)?${id}(?![\\w$])`) },
    { kind: 'function', re: new RegExp(`\\bfunction\\b[^;(=]*?(?<![\\w$])${id}\\s*[(;]`) },
    { kind: 'task', re: new RegExp(`\\btask\\s+(?:automatic\\s+|static\\s+)?${id}(?![\\w$])`) },
    { kind: 'define', re: new RegExp(`\`define\\s+${id}(?![\\w$])`) },
  ];
}

export function findDefinitions(files, word) {
  const name = String(word || '').replace(/^`/, '');
  if (!/^[A-Za-z_][\w$]*$/.test(name)) return [];
  const patterns = definitionPatterns(name);
  const results = [];
  for (const [path, text] of Object.entries(files)) {
    if (typeof text !== 'string') continue;
    const lines = text.split('\n');
    lines.forEach((line, index) => {
      const code = line.replace(/\/\/.*$/, '');
      const hit = patterns.find(pattern => pattern.re.test(code));
      if (hit) results.push({ file: path, line: index + 1, kind: hit.kind, text: line.trim() });
    });
  }
  return results;
}

export function searchFiles(files, query, { matchCase = false, wholeWord = false } = {}) {
  if (!query) return { results: [], truncated: false };
  const source = wholeWord ? `(?<![\\w$])${escapeRegExp(query)}(?![\\w$])` : escapeRegExp(query);
  const re = new RegExp(source, matchCase ? 'g' : 'gi');
  const results = [];
  for (const path of Object.keys(files).sort()) {
    const text = files[path];
    if (typeof text !== 'string') continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      re.lastIndex = 0;
      const match = re.exec(lines[i]);
      if (!match) continue;
      results.push({ file: path, line: i + 1, col: match.index + 1, text: lines[i], start: match.index, end: match.index + match[0].length });
      if (results.length >= MAX_RESULTS) return { results, truncated: true };
    }
  }
  return { results, truncated: false };
}

export function installSearch({ getFiles, openAt, notify }) {
  const $ = id => document.getElementById(id);
  const dialog = $('search-dialog');
  let mode = 'search';        // 'search' | 'definitions'
  let definitionItems = [];
  let active = 0;

  function resultButton(item, preview) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'search-result';
    button.setAttribute('role', 'option');
    const loc = document.createElement('span');
    loc.className = 'search-loc';
    loc.textContent = `${item.file}:${item.line}`;
    button.append(loc, preview);
    button.onclick = () => { dialog.close(); openAt(item.file, item.line); };
    return button;
  }

  function highlight(item) {
    const preview = document.createElement('span');
    preview.className = 'search-text';
    const lead = item.text.length - item.text.trimStart().length;
    const start = Math.max(lead, item.start - 60);
    preview.append(document.createTextNode((start > lead ? '…' : '') + item.text.slice(start, item.start)));
    const mark = document.createElement('mark');
    mark.textContent = item.text.slice(item.start, item.end);
    preview.append(mark, document.createTextNode(item.text.slice(item.end, item.end + 120)));
    return preview;
  }

  function setActive(index) {
    const buttons = [...$('search-results').querySelectorAll('.search-result')];
    if (!buttons.length) return;
    active = (index + buttons.length) % buttons.length;
    buttons.forEach((button, i) => { button.classList.toggle('selected', i === active); button.setAttribute('aria-selected', String(i === active)); });
    buttons[active].scrollIntoView({ block: 'nearest' });
  }

  function render() {
    const list = $('search-results');
    list.replaceChildren();
    active = 0;
    if (mode === 'definitions') {
      for (const item of definitionItems) {
        const preview = document.createElement('span');
        preview.className = 'search-text';
        const kind = document.createElement('span');
        kind.className = 'search-kind';
        kind.textContent = item.kind;
        preview.append(kind, document.createTextNode(` ${item.text}`));
        list.append(resultButton(item, preview));
      }
      $('search-count').textContent = `${definitionItems.length} definitions`;
      setActive(0);
      return;
    }
    const query = $('search-input').value;
    const { results, truncated } = searchFiles(getFiles(), query, { matchCase: $('search-case').checked, wholeWord: $('search-word').checked });
    for (const item of results) list.append(resultButton(item, highlight(item)));
    const fileCount = new Set(results.map(item => item.file)).size;
    $('search-count').textContent = !query ? '' : results.length
      ? `${results.length}${truncated ? '+' : ''} result${results.length === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`
      : 'No results';
    setActive(0);
  }

  function open(query = '') {
    mode = 'search';
    $('search-title').textContent = 'Search in Workspace';
    if (query) $('search-input').value = query;
    if (!dialog.open) dialog.showModal();
    render();
    $('search-input').focus();
    $('search-input').select();
  }

  // Jumps directly for a single match; lists several; reports none.
  function goToDefinition(word) {
    const name = String(word || '').replace(/^`/, '');
    const items = findDefinitions(getFiles(), name);
    if (!items.length) { notify?.(name ? `No definition found for ${name}` : 'Place the cursor on an identifier'); return items; }
    if (items.length === 1) { openAt(items[0].file, items[0].line); return items; }
    mode = 'definitions';
    definitionItems = items;
    $('search-title').textContent = `Definitions of ${name}`;
    $('search-input').value = name;
    if (!dialog.open) dialog.showModal();
    render();
    return items;
  }

  $('search-input').addEventListener('input', () => { mode = 'search'; $('search-title').textContent = 'Search in Workspace'; render(); });
  $('search-case').onchange = render;
  $('search-word').onchange = render;
  $('close-search').onclick = () => dialog.close();
  dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
  $('search-input').addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActive(active + 1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(active - 1); }
    else if (event.key === 'Enter') {
      event.preventDefault();
      $('search-results').querySelectorAll('.search-result')[active]?.click();
    }
  });

  return { open, goToDefinition };
}
