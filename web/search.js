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

// Native regular expressions cannot be interrupted. Restrict patterns and input size to keep
// workspace searches bounded; report rejected patterns instead of risking a frozen UI.
function compileSearch(query, { matchCase = false, wholeWord = false, regex = false } = {}) {
  if (regex) {
    if (query.length > 256) throw new Error('Regex is too long (maximum 256 characters).');
    let inClass = false, escaped = false, variable = 0, previous = '';
    for (let i = 0; i < query.length; i++) {
      const c = query[i];
      if (escaped) { if (!inClass && /[1-9k]/.test(c)) throw new Error('Regex backreferences are not supported.'); escaped = false; previous = 'atom'; continue; }
      if (c === '\\') { escaped = true; continue; }
      if (c === '[' && !inClass) { inClass = true; continue; }
      if (c === ']' && inClass) { inClass = false; previous = 'atom'; continue; }
      if (inClass) continue;
      if (c === '*' || c === '+' || (c === '?' && query[i - 1] !== '(' && !/[+*?}]/.test(query[i - 1] || ''))) {
        if (previous === ')') throw new Error('Quantified groups are not supported in workspace regex search.');
        if (++variable > 1) throw new Error('Use at most one variable repetition in a workspace regex.');
        previous = 'quantifier'; continue;
      }
      if (c === '{') {
        const quant = /^\{(\d+)(?:,(\d*)?)?\}/.exec(query.slice(i));
        if (quant) {
          const min = Number(quant[1]), max = quant[2] === undefined ? min : quant[2] === '' ? Infinity : Number(quant[2]);
          if (previous === ')' || max > 1000 || (max !== min && ++variable > 1)) throw new Error('Regex repetition is too complex for workspace search.');
          i += quant[0].length - 1; previous = 'quantifier'; continue;
        }
      }
      previous = c;
    }
  }
  const pattern = regex ? query : escapeRegExp(query);
  const source = wholeWord ? `(?<![\\w$])(?:${pattern})(?![\\w$])` : pattern;
  return new RegExp(source, matchCase ? 'g' : 'gi');
}

export function searchFiles(files, query, options = {}) {
  if (!query) return { results: [], truncated: false };
  let re;
  try { re = compileSearch(query, options); } catch (error) { return { results: [], truncated: false, error: error.message }; }
  const results = [];
  for (const path of Object.keys(files).sort()) {
    const text = files[path];
    if (typeof text !== 'string') continue;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (options.regex && lines[i].length > 4096) return { results: [], truncated: false, error: `Regex search is limited to lines of 4096 characters (${path}:${i + 1}).` };
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(lines[i]))) {
        results.push({ file: path, line: i + 1, col: match.index + 1, text: lines[i], start: match.index, end: match.index + match[0].length });
        if (results.length >= MAX_RESULTS) return { results, truncated: true };
        if (!match[0].length) re.lastIndex = match.index + 1;
      }
    }
  }
  return { results, truncated: false };
}

export function installSearch({ getFiles, openAt, notify, replaceFiles = null, getCurrentFile = null }) {
  const $ = id => document.getElementById(id);
  const dialog = $('search-dialog');
  let mode = 'search';        // 'search' | 'definitions'
  let definitionItems = [];
  let active = 0;
  let searchResult = { results: [], truncated: false };
  const options = () => ({ matchCase: $('search-case').checked, wholeWord: $('search-word').checked, regex: $('search-regex').checked });

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
    searchResult = searchFiles(getFiles(), query, options());
    const { results, truncated, error } = searchResult;
    $('search-input').setAttribute('aria-invalid', String(Boolean(error)));
    $('search-count').classList.toggle('is-error', Boolean(error));
    $('replace-all').disabled = $('replace-in-file').disabled = Boolean(error || truncated || !results.length || !replaceFiles);
    if (error) { $('search-count').textContent = error; return; }
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

  function openReplace(query = '') {
    open(query);
    $('search-replace-row').hidden = false;
    $('search-replace-toggle').setAttribute('aria-expanded', 'true');
  }

  async function replace(inFile) {
    const query = $('search-input').value;
    const snapshot = getFiles();
    const result = searchFiles(snapshot, query, options());
    if (result.error || result.truncated || !result.results.length || !replaceFiles) return;
    const path = getCurrentFile?.() || result.results[active]?.file;
    const paths = new Set(result.results.map(item => item.file).filter(file => !inFile || file === path));
    const replacement = $('replace-input').value;
    const updates = {};
    for (const file of paths) {
      const re = compileSearch(query, options());
      updates[file] = snapshot[file].split('\n').map(line => options().regex ? line.replace(re, replacement) : line.replace(re, () => replacement)).join('\n');
    }
    if (!Object.keys(updates).length) return;
    try { await replaceFiles(updates); render(); }
    catch (error) { notify?.(`Replace failed: ${error.message}`); }
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
  $('search-regex').onchange = render;
  $('search-replace-toggle').onclick = () => { const row = $('search-replace-row'); row.hidden = !row.hidden; $('search-replace-toggle').setAttribute('aria-expanded', String(!row.hidden)); };
  $('replace-in-file').onclick = () => replace(true);
  $('replace-all').onclick = () => replace(false);
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

  return { open, openSearch: open, openReplace, goToDefinition, showDefinitions: goToDefinition, searchFiles };
}
