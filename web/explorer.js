/* Explorer tree with build checkboxes, drag-and-drop folders, and hover quick actions. */
import { validPath } from './archive.js';

const ICON_CHEVRON = '<svg class="i chev" viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg>';
const ICON_FOLDER = '<svg class="i" viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const ICON_DOWNLOAD = '<svg class="i" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>';
const ICON_RENAME = '<svg class="i" viewBox="0 0 24 24"><path d="M4 20h4L18.5 9.5a2.8 2.8 0 0 0-4-4L4 16zM13.5 6.5l4 4"/></svg>';
const ICON_TRASH = '<svg class="i" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
const ICON_MORE = '<svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.5" fill="currentColor" stroke="none"/></svg>';

function quickBtn(html, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'tree-act';
  b.innerHTML = html;
  b.title = label;
  b.setAttribute('aria-label', label);
  b.onclick = e => { e.stopPropagation(); onClick(); };
  return b;
}

export function renderExplorer(parent, { files, folders, excluded, current, collapsed, hideExcluded = false, open, menu, drop, toggleBuild, onQuickRename, onQuickDelete, onQuickDownload }) {
  const tree = { folders: new Map(), files: [] };

  function addFolder(path) {
    let node = tree;
    for (const part of path.split('/')) {
      if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
      node = node.folders.get(part);
    }
    return node;
  }

  for (const folder of folders) if (validPath(folder)) addFolder(folder);
  for (const path of Object.keys(files)) {
    if (hideExcluded && excluded.has(path)) continue;
    const parts = path.split('/');
    const name = parts.pop();
    (parts.length ? addFolder(parts.join('/')) : tree).files.push({ path, name });
  }

  function renderNode(node, prefix, depth) {
    for (const [name, child] of [...node.folders].sort(([a], [b]) => a.localeCompare(b))) {
      const path = prefix ? `${prefix}/${name}` : name;
      const isCollapsed = collapsed.has(path);
      const row = document.createElement('div');
      row.className = `tree-row is-folder${isCollapsed ? '' : ' is-open'}`;
      row.style.setProperty('--tree-depth', depth);

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'tree-folder';
      toggle.dataset.path = path;
      toggle.dataset.folder = 'true';
      toggle.setAttribute('aria-expanded', String(!isCollapsed));
      toggle.innerHTML = `<span class="tw">${ICON_CHEVRON}</span><span class="fi-folder">${ICON_FOLDER}</span>`;
      const lbl = document.createElement('span');
      lbl.className = 'tree-name';
      lbl.textContent = name;
      toggle.append(lbl);

      toggle.onclick = () => {
        if (collapsed.has(path)) collapsed.delete(path);
        else collapsed.add(path);
        repaint();
      };
      toggle.oncontextmenu = event => { event.preventDefault(); menu(path, true); };
      toggle.ondragover = event => {
        event.preventDefault();
        event.stopPropagation();
        parent.classList.remove('is-dragover');
        toggle.classList.add('is-dragover');
      };
      toggle.ondragleave = () => toggle.classList.remove('is-dragover');
      toggle.ondrop = event => {
        event.preventDefault();
        event.stopPropagation();
        toggle.classList.remove('is-dragover');
        drop(event.dataTransfer, path);
      };

      const acts = document.createElement('span');
      acts.className = 'tree-acts';
      if (onQuickRename) acts.append(quickBtn(ICON_RENAME, `Rename folder ${path}`, () => onQuickRename(path, true)));
      if (onQuickDelete) acts.append(quickBtn(ICON_TRASH, `Delete folder ${path}`, () => onQuickDelete(path, true)));

      const actions = document.createElement('button');
      actions.type = 'button';
      actions.className = 'tree-more';
      actions.innerHTML = ICON_MORE;
      actions.setAttribute('aria-label', `Actions for folder ${path}`);
      actions.onclick = e => { e.stopPropagation(); menu(path, true); };

      row.append(toggle, acts, actions);
      parent.append(row);
      if (!isCollapsed) renderNode(child, path, depth + 1);
    }

    for (const { path, name } of node.files.sort((a, b) => a.name.localeCompare(b.name))) {
      const row = document.createElement('div');
      row.className = `tree-row${path === current ? ' is-active' : ''}${excluded.has(path) ? ' is-excluded' : ''}`;
      row.style.setProperty('--tree-depth', depth);

      if (/\.(?:v|sv|asm|s)$/i.test(path) && toggleBuild) {
        const check = document.createElement('input');
        check.type = 'checkbox';
        check.className = 'tree-build-toggle';
        check.checked = !excluded.has(path);
        check.title = 'Include in build';
        check.setAttribute('aria-label', `Include ${path} in build`);
        check.onclick = event => event.stopPropagation();
        check.onchange = () => toggleBuild(path, check.checked);
        row.append(check);
      }

      const button = document.createElement('button');
      button.type = 'button';
      button.className = `tree-file${path === current ? ' active' : ''}`;
      button.dataset.path = path;
      button.title = path;
      button.draggable = true;
      button.ondragstart = event => { event.dataTransfer.setData('application/x-datapath-file', JSON.stringify({ path })); event.dataTransfer.effectAllowed = 'copy'; };

      const ext = (name.includes('.') ? name.split('.').pop() : 'txt').toLowerCase();
      const badge = document.createElement('span');
      badge.className = `file-icon ext-${ext}`;
      badge.textContent = ext.toUpperCase().slice(0, 3);

      const label = document.createElement('span');
      label.className = 'tree-name';
      label.textContent = name;

      button.append(badge, label);
      if (excluded.has(path)) {
        const note = document.createElement('span');
        note.className = 'excluded-note';
        note.textContent = 'excluded';
        button.append(note);
      }
      button.onclick = () => open(path);
      button.oncontextmenu = event => { event.preventDefault(); menu(path, false); };

      const acts = document.createElement('span');
      acts.className = 'tree-acts';
      if (onQuickDownload) acts.append(quickBtn(ICON_DOWNLOAD, `Download ${path}`, () => onQuickDownload(path)));
      if (onQuickRename) acts.append(quickBtn(ICON_RENAME, `Rename ${path}`, () => onQuickRename(path, false)));
      if (onQuickDelete) acts.append(quickBtn(ICON_TRASH, `Delete ${path}`, () => onQuickDelete(path, false)));

      const actions = document.createElement('button');
      actions.type = 'button';
      actions.className = 'tree-more';
      actions.innerHTML = ICON_MORE;
      actions.setAttribute('aria-label', `Actions for ${path}`);
      actions.onclick = e => { e.stopPropagation(); menu(path, false); };

      row.append(button, acts, actions);
      parent.append(row);
    }
  }

  function repaint() {
    parent.replaceChildren();
    renderNode(tree, '', 0);
  }

  repaint();
}
