/* Split editor groups: binary split tree managing CodeMirror 6 panes and tab drag-and-drop. */

const DND_MIME = 'application/x-datapath-view';
const STORAGE_KEY = 'datapath.groups.v1';

export class EditorGroups {
  constructor(host, hooks) {
    this.host = host;
    this.hooks = hooks;
    this.groups = [];
    this.nextId = 0;
    this.drag = null;
    this.maximized = false;
    this.restoring = false;
    this.visualFlags = { showLineNumbers: true, showFoldGutter: true, showActiveLine: true };

    const initial = this.createGroup();
    this.active = initial;
    this.tree = { group: initial };
    this.mount();

    this.onResize = () => this.paint();
    window.addEventListener('resize', this.onResize);
  }

  destroy() {
    window.removeEventListener('resize', this.onResize);
    for (const g of this.groups) g.editor?.destroy?.();
  }

  createGroup() {
    const g = { id: ++this.nextId, tabs: [], index: 0 };
    g.host = document.createElement('section');
    g.host.className = 'editor-group';
    g.host.dataset.group = String(g.id);

    g.bar = document.createElement('div');
    g.bar.className = 'group-bar';

    g.tabsEl = document.createElement('div');
    g.tabsEl.className = 'group-tabs';
    g.tabsEl.setAttribute('role', 'tablist');
    g.tabsEl.setAttribute('aria-label', `Editor group ${g.id}`);

    g.actions = document.createElement('div');
    g.actions.className = 'group-actions';

    g.bar.append(g.tabsEl, g.actions);

    g.body = document.createElement('div');
    g.body.className = 'group-body editor-wrap';

    g.editor = this.hooks.createEditor(g.body, {
      onChange: (name, text) => {
        this.hooks.onChange(name, text, g.editor);
        this.syncDocument(name, text, g.editor);
      },
      onPosition: (line, col, lineText, word) => {
        if (g === this.active) this.hooks.onPosition(line, col, lineText, word);
      },
    });

    g.host.append(g.bar, g.body);

    g.host.addEventListener('focusin', e => {
      if (g.body.contains(e.target) && this.active !== g) this.activate(g, g.index, false);
    });
    g.host.addEventListener('pointerdown', e => {
      if ((g.body.contains(e.target) || g.bar.contains(e.target)) && this.active !== g) {
        this.activate(g, g.index, false);
      }
    }, true);

    g.host.addEventListener('dragover', e => {
      if (!this.drag || !Array.from(e.dataTransfer?.types || []).includes(DND_MIME)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      g.host.dataset.drop = this.edgeForEvent(g, e);
    });

    g.host.addEventListener('dragleave', e => {
      if (!g.host.contains(e.relatedTarget)) delete g.host.dataset.drop;
    });

    g.host.addEventListener('drop', e => {
      if (!this.drag) return;
      e.preventDefault();
      e.stopPropagation();
      const { group: from, tab } = this.drag;
      const edge = this.edgeForEvent(g, e);
      this.endDrag();

      const target = edge === 'center' ? g : this.split(g, edge, null);
      if (!target) return;

      if (target === from && edge === 'center' && from.tabs.includes(tab)) {
        const at = e.target.closest('[data-tab]');
        if (at) {
          const i = from.tabs.indexOf(tab);
          const j = Number(at.dataset.tab);
          from.tabs.splice(i, 1);
          from.tabs.splice(j, 0, tab);
        }
        from.index = Math.max(0, from.tabs.indexOf(tab));
      } else {
        from.tabs = from.tabs.filter(t => t !== tab);
        from.index = Math.max(0, Math.min(from.index, from.tabs.length - 1));
        const existing = target.tabs.find(t => t.path === tab.path);
        if (!existing) target.tabs.push(tab);
        target.index = target.tabs.indexOf(existing || tab);
      }

      if (!from.tabs.length && from !== target && this.groups.length > 1) this.remove(from);
      this.activate(target, target.index);
      this.persist();
    });

    this.groups.push(g);
    return g;
  }

  tab(g = this.active) {
    return g?.tabs[g.index] || g?.tabs[0] || null;
  }

  activePath() {
    return this.tab(this.active)?.path || null;
  }

  activeEditor() {
    return this.active?.editor || null;
  }

  edgeForEvent(g, e) {
    if (e.target.closest('.group-bar')) return 'center';
    const r = g.body.getBoundingClientRect();
    if (!r.width || !r.height) return 'center';
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    const n = Math.min(x, 1 - x, y, 1 - y);
    if (n > 0.23) return 'center';
    if (n === x) return 'left';
    if (n === 1 - x) return 'right';
    return n === y ? 'top' : 'bottom';
  }

  endDrag() {
    this.drag = null;
    for (const g of this.groups) {
      delete g.host.dataset.drop;
      g.body.style.pointerEvents = '';
    }
  }

  captureView(g = this.active) {
    const t = this.tab(g);
    if (t && g?.editor) t.view = g.editor.getViewState();
  }

  openFile(path) {
    if (!this.hooks.hasFile(path)) return;
    const g = this.active;
    this.captureView(g);
    let idx = g.tabs.findIndex(t => t.path === path);
    if (idx < 0) {
      g.tabs.push({ path, view: null });
      idx = g.tabs.length - 1;
    }
    this.activate(g, idx);
    this.persist();
  }

  activate(g, index = g.index, shouldFocus = false) {
    if (!this.groups.includes(g)) return;
    if (!this.restoring) this.captureView(this.active);
    this.active = g;
    g.index = Math.max(0, Math.min(index, g.tabs.length - 1));
    this.refresh();
    const currentTab = this.tab(g);
    if (currentTab) this.hooks.onActivate?.(currentTab.path);
    if (shouldFocus) g.editor.focus();
  }

  syncDocument(path, text, sourceEditor) {
    for (const g of this.groups) {
      if (g.editor === sourceEditor) continue;
      if (this.tab(g)?.path === path) g.editor.setTextIfChanged(text);
    }
  }

  renamePaths(matches, mapper) {
    for (const g of this.groups) {
      for (const t of g.tabs) {
        if (matches(t.path)) {
          const next = mapper(t.path);
          g.editor.rename(t.path, next);
          t.path = next;
        }
      }
    }
    this.refresh();
    this.persist();
  }

  removePaths(matches, fallbackPath) {
    for (const g of [...this.groups]) {
      for (const t of g.tabs) {
        if (matches(t.path)) g.editor.remove(t.path);
      }
      g.tabs = g.tabs.filter(t => !matches(t.path));
      g.index = Math.max(0, Math.min(g.index, g.tabs.length - 1));
      if (!g.tabs.length && this.groups.length > 1) this.remove(g);
    }
    if (!this.active.tabs.length && fallbackPath && this.hooks.hasFile(fallbackPath)) {
      this.active.tabs.push({ path: fallbackPath, view: null });
      this.active.index = 0;
    }
    this.refresh();
    this.persist();
  }

  closeTab(g, index) {
    if (this.groups.length === 1 && g.tabs.length <= 1) return;
    const t = g.tabs[index];
    if (!t) return;
    g.tabs.splice(index, 1);
    g.index = Math.max(0, Math.min(g.index, g.tabs.length - 1));
    if (!g.tabs.length && this.groups.length > 1) this.remove(g);
    this.activate(this.groups.includes(g) ? g : this.active, g.index);
    this.persist();
  }

  split(g = this.active, edge = 'right', clonedTab = null) {
    if (this.groups.length >= 6) {
      this.hooks.onToast?.('At most six split panes.');
      return null;
    }
    const sourceTab = clonedTab === undefined || clonedTab === null
      ? (clonedTab === null ? null : (this.tab(g) ? { path: this.tab(g).path, view: null } : null))
      : clonedTab;
    const tabToOpen = edge && arguments.length < 3 && this.tab(g) ? { path: this.tab(g).path, view: null } : sourceTab;

    const fresh = this.createGroup();
    if (tabToOpen) fresh.tabs.push({ path: tabToOpen.path, view: tabToOpen.view || null });

    const replace = node => {
      if (node.group === g) {
        const before = edge === 'left' || edge === 'top';
        return {
          axis: edge === 'left' || edge === 'right' ? 'row' : 'column',
          ratio: 0.5,
          first: before ? { group: fresh } : node,
          second: before ? node : { group: fresh },
        };
      }
      if (!node.group) {
        return { ...node, first: replace(node.first), second: replace(node.second) };
      }
      return node;
    };

    this.tree = replace(this.tree);
    this.maximized = false;
    this.mount();
    this.activate(fresh, 0, true);
    this.persist();
    return fresh;
  }

  remove(g) {
    if (this.groups.length <= 1) return;
    const prune = node => {
      if (node.group) return node.group === g ? null : node;
      const first = prune(node.first);
      const second = prune(node.second);
      if (!first) return second;
      if (!second) return first;
      return { ...node, first, second };
    };
    this.tree = prune(this.tree);
    this.groups = this.groups.filter(x => x !== g);
    g.editor?.destroy?.();
    g.host.remove();
    if (this.active === g) this.active = this.groups[0];
    this.mount();
    this.paint();
  }

  nextGroup() {
    if (this.groups.length <= 1) return;
    const idx = (this.groups.indexOf(this.active) + 1) % this.groups.length;
    this.activate(this.groups[idx], this.groups[idx].index, true);
  }

  maximize() {
    this.maximized = !this.maximized;
    this.paint();
  }

  configureAll(prefs) {
    for (const g of this.groups) g.editor.configure(prefs);
  }

  setVisualFlags(flags) {
    this.visualFlags = { ...this.visualFlags, ...flags };
    for (const g of this.groups) this.applyBodyFlags(g);
  }

  applyBodyFlags(g) {
    g.body.classList.toggle('hide-line-numbers', !this.visualFlags.showLineNumbers);
    g.body.classList.toggle('hide-fold-gutter', !this.visualFlags.showFoldGutter);
    g.body.classList.toggle('hide-active-line', !this.visualFlags.showActiveLine);
  }

  setDiagnosticsAll(items) {
    for (const g of this.groups) g.editor.diagnostics(items);
  }

  jump(file, line) {
    const existingGroup = this.groups.find(g => this.tab(g)?.path === file);
    if (existingGroup) {
      this.activate(existingGroup, existingGroup.index);
      existingGroup.editor.jump(line);
      return;
    }
    this.openFile(file);
    this.active.editor.jump(line);
  }

  refresh() {
    const totalTabs = this.groups.reduce((sum, g) => sum + g.tabs.length, 0);
    for (const g of this.groups) {
      this.renderGroup(g, totalTabs <= 1);
    }
    this.paint();
  }

  renderGroup(g, isSingleLastTab) {
    const currentTab = this.tab(g);
    g.tabsEl.replaceChildren();

    g.tabs.forEach((t, idx) => {
      const wrap = document.createElement('div');
      wrap.className = `group-tab${idx === g.index ? ' selected' : ''}`;
      wrap.draggable = true;
      wrap.dataset.tab = String(idx);

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-label';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', String(idx === g.index));
      btn.title = t.path;
      btn.textContent = t.path.split('/').at(-1);
      btn.onclick = () => this.activate(g, idx, true);

      const close = document.createElement('button');
      close.type = 'button';
      close.className = 'tab-close';
      close.setAttribute('aria-label', `Close ${t.path}`);
      close.textContent = '×';
      close.disabled = isSingleLastTab;
      close.onclick = e => { e.stopPropagation(); this.closeTab(g, idx); };

      wrap.addEventListener('dragstart', e => {
        this.drag = { group: g, tab: t };
        e.dataTransfer.setData(DND_MIME, t.path);
        e.dataTransfer.effectAllowed = 'move';
        for (const pane of this.groups) pane.body.style.pointerEvents = 'none';
      });
      wrap.addEventListener('dragend', () => this.endDrag());
      wrap.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
      wrap.addEventListener('auxclick', e => { if (e.button === 1 && !close.disabled) { e.preventDefault(); this.closeTab(g, idx); } });

      wrap.append(btn, close);
      g.tabsEl.append(wrap);
    });

    g.actions.replaceChildren();
    const mkAct = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = label;
      b.title = title;
      b.setAttribute('aria-label', title);
      b.onclick = fn;
      g.actions.append(b);
    };

    mkAct(
      '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/></svg>',
      'Split right',
      () => this.split(g, 'right')
    );
    mkAct(
      '<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/></svg>',
      'Split down',
      () => this.split(g, 'bottom')
    );
    mkAct(
      '<svg class="i" viewBox="0 0 24 24"><circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
      'Editor group actions',
      () => this.openMenu(g)
    );

    if (currentTab && this.hooks.hasFile(currentTab.path)) {
      const content = this.hooks.getFile(currentTab.path);
      if (g.editor.getFilename() !== currentTab.path) {
        g.editor.open(currentTab.path, content, currentTab.view);
      } else {
        g.editor.setTextIfChanged(content);
      }
      g.editor.diagnostics(this.hooks.getDiagnostics?.() || []);
    }
    this.applyBodyFlags(g);
  }

  openMenu(g) {
    this.activate(g, g.index);
    const actions = [
      ['Split right', () => this.split(g, 'right')],
      ['Split down', () => this.split(g, 'bottom')],
      [this.maximized ? 'Restore all panes' : 'Maximize active pane', () => this.maximize()],
    ];
    if (this.groups.length > 1) {
      const next = this.groups[(this.groups.indexOf(g) + 1) % this.groups.length];
      actions.push(['Next group', () => this.nextGroup()]);
      actions.push(['Move view to next group', () => {
        const t = this.tab(g);
        if (!t) return;
        if (!next.tabs.some(x => x.path === t.path)) next.tabs.push(t);
        next.index = next.tabs.findIndex(x => x.path === t.path);
        g.tabs = g.tabs.filter(x => x !== t);
        if (!g.tabs.length) this.remove(g);
        this.activate(next, next.index, true);
        this.persist();
      }]);
      actions.push(['Join group into next', () => {
        for (const t of g.tabs) if (!next.tabs.some(x => x.path === t.path)) next.tabs.push(t);
        this.remove(g);
        this.activate(next, next.index, true);
        this.persist();
      }]);
    }
    this.hooks.onOpenMenu?.(actions);
  }

  mount() {
    const build = node => {
      if (node.group) return node.group.host;
      const box = document.createElement('div');
      box.className = `group-split split-${node.axis}`;
      const a = build(node.first);
      const b = build(node.second);
      const handle = document.createElement('div');
      handle.className = 'group-divider';
      handle.tabIndex = 0;
      handle.setAttribute('role', 'separator');
      handle.setAttribute('aria-label', 'Resize editor groups');
      handle.setAttribute('aria-orientation', node.axis === 'row' ? 'vertical' : 'horizontal');

      const size = () => {
        a.style.flex = `${node.ratio} 1 0`;
        b.style.flex = `${1 - node.ratio} 1 0`;
        handle.setAttribute('aria-valuenow', String(Math.round(node.ratio * 100)));
      };
      a.style.flex = '';
      b.style.flex = '';
      size();

      handle.onpointerdown = e => {
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        handle.onpointermove = mv => {
          const r = box.getBoundingClientRect();
          const raw = node.axis === 'row' ? (mv.clientX - r.left) / r.width : (mv.clientY - r.top) / r.height;
          node.ratio = Math.max(0.15, Math.min(0.85, raw));
          size();
        };
        handle.onpointerup = handle.onpointercancel = () => {
          handle.onpointermove = null;
          this.persist();
          for (const g of this.groups) g.editor.measure();
        };
      };

      handle.onkeydown = e => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        const delta = ['ArrowLeft', 'ArrowUp'].includes(e.key) ? -0.05 : 0.05;
        node.ratio = Math.max(0.15, Math.min(0.85, node.ratio + delta));
        size();
        this.persist();
      };

      box.append(a, handle, b);
      return box;
    };

    const root = build(this.tree);
    root.style.flex = '';
    this.host.replaceChildren(root);
    this.refresh();
  }

  paint() {
    const narrow = window.matchMedia('(max-width: 899px)').matches;
    this.host.classList.toggle('single-group', narrow || !!this.maximized);
    for (const g of this.groups) {
      const isActive = g === this.active;
      g.host.classList.toggle('active-group', isActive);
      if (isActive) g.body.id = 'editor';
      else if (g.body.id === 'editor') g.body.removeAttribute('id');
      if (isActive || !narrow) g.editor.measure();
    }
  }

  serialize() {
    const walk = node => node.group
      ? { tabs: node.group.tabs.map(t => ({ path: t.path, view: t.view || null })), index: node.group.index, active: node.group === this.active }
      : { axis: node.axis, ratio: node.ratio, first: walk(node.first), second: walk(node.second) };
    return walk(this.tree);
  }

  persist() {
    if (this.restoring) return;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.serialize())); } catch { /* ignore storage errors */ }
  }

  restore(fallbackPath) {
    let layout = null;
    try { layout = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { layout = null; }
    if (!layout) {
      this.openFile(fallbackPath);
      return;
    }

    this.restoring = true;
    const original = this.groups[0];
    let count = 0;
    let usedOriginal = false;

    const walk = (node, depth = 0) => {
      if (!node || depth > 5 || ++count > 12) throw new Error('Invalid group layout');
      if (Array.isArray(node.tabs)) {
        const g = usedOriginal ? this.createGroup() : original;
        usedOriginal = true;
        g.tabs = node.tabs
          .filter(t => t && typeof t.path === 'string' && this.hooks.hasFile(t.path))
          .slice(0, 50)
          .map(t => ({ path: t.path, view: t.view || null }));
        g.index = Number.isInteger(node.index) ? Math.max(0, Math.min(node.index, g.tabs.length - 1)) : 0;
        if (node.active) this.active = g;
        return { group: g };
      }
      if (!['row', 'column'].includes(node.axis)) throw new Error('Invalid split axis');
      return {
        axis: node.axis,
        ratio: Number.isFinite(node.ratio) ? Math.max(0.15, Math.min(0.85, node.ratio)) : 0.5,
        first: walk(node.first, depth + 1),
        second: walk(node.second, depth + 1),
      };
    };

    try {
      original.tabs = [];
      this.tree = walk(layout);
      if (!this.groups.includes(this.active)) this.active = this.groups[0];
      for (const g of [...this.groups]) {
        if (!g.tabs.length && this.groups.length > 1) this.remove(g);
      }
      if (!this.active.tabs.length && fallbackPath && this.hooks.hasFile(fallbackPath)) {
        this.active.tabs.push({ path: fallbackPath, view: null });
        this.active.index = 0;
      }
      this.mount();
      this.activate(this.active, this.active.index);
    } catch {
      for (const g of [...this.groups]) if (g !== original) { g.editor?.destroy?.(); g.host.remove(); }
      this.groups = [original];
      this.active = original;
      original.tabs = fallbackPath && this.hooks.hasFile(fallbackPath) ? [{ path: fallbackPath, view: null }] : [];
      original.index = 0;
      this.tree = { group: original };
      this.mount();
      this.activate(original, 0);
    } finally {
      this.restoring = false;
    }
  }
}
