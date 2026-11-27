import { basicSetup } from 'codemirror';
import { EditorState, Compartment, Prec, StateEffect, StateField } from '@codemirror/state';
import { EditorView, keymap, Decoration, WidgetType, ViewPlugin, hoverTooltip } from '@codemirror/view';
import { StreamLanguage, indentUnit, syntaxHighlighting, HighlightStyle, bracketMatching, foldService } from '@codemirror/language';
import { indentWithTab, toggleComment, undo as cmUndo, redo as cmRedo, indentMore, indentLess, cursorCharLeft, cursorCharRight, cursorLineUp, cursorLineDown, cursorLineBoundaryBackward, cursorLineEnd, cursorGroupForward, cursorGroupBackward, cursorDocStart, cursorDocEnd } from '@codemirror/commands';
import { autocompletion, completionKeymap, startCompletion, closeCompletion, acceptCompletion, completionStatus, snippetCompletion } from '@codemirror/autocomplete';
import { setDiagnostics, lintGutter } from '@codemirror/lint';
import { gotoLine, openSearchPanel, closeSearchPanel, searchPanelOpen, selectSelectionMatches } from '@codemirror/search';
import { tags } from '@lezer/highlight';

export function editorText(parent) {
  return EditorView.findFromDOM(parent?.querySelector('.cm-content') || parent)?.state.doc.toString() ?? '';
}

// Semantic keyword classes: structural (keyword), behavioral control flow (control), simulation-only (sim).
const KEYWORDS = new Set([
  'module', 'endmodule', 'macromodule', 'assign', 'generate', 'endgenerate',
  'and', 'or', 'nand', 'nor', 'xor', 'xnor', 'not', 'buf', 'bufif0', 'bufif1', 'notif0', 'notif1',
  'pullup', 'pulldown',
]);
const CONTROL = new Set([
  'always', 'always_ff', 'always_comb', 'always_latch', 'if', 'else', 'case', 'casex', 'casez', 'endcase',
  'default', 'for', 'while', 'repeat', 'forever', 'begin', 'end', 'posedge', 'negedge', 'edge', 'wait',
  'function', 'endfunction', 'task', 'endtask', 'local', 'return', 'break', 'continue',
]);
const SIM = new Set([
  'initial', 'fork', 'join', 'join_any', 'join_none', 'force', 'release', 'deassign', 'disable',
  'specify', 'endspecify', 'ifnone',
]);

// MIPS: real MIPS-I instructions vs assembler pseudo-instructions (mars-ide style italic cue).
const MIPS_PSEUDO = new Set(['nop', 'move', 'li', 'la', 'subi', 'not', 'neg', 'b', 'beqz', 'bnez', 'blt', 'bgt', 'ble', 'bge']);

const TYPES = new Set([
  'input', 'output', 'inout', 'wire', 'reg', 'logic', 'bit', 'byte', 'shortint', 'int', 'longint',
  'integer', 'real', 'realtime', 'time', 'signed', 'unsigned', 'parameter', 'localparam', 'defparam',
  'specparam', 'genvar', 'tri', 'tri0', 'tri1', 'triand', 'trior', 'wand', 'wor', 'supply0', 'supply1',
  'enum', 'struct', 'typedef', 'const',
]);

const verilogMode = StreamLanguage.define({
  name: 'verilog',
  startState: () => ({ inComment: false }),
  token(stream, state) {
    if (state.inComment) {
      if (stream.skipTo('*/')) { stream.eat('*'); stream.eat('/'); state.inComment = false; }
      else stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;
    if (stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match('/*')) {
      if (stream.skipTo('*/')) { stream.eat('*'); stream.eat('/'); }
      else state.inComment = true;
      return 'comment';
    }
    if (stream.match(/"(?:\\.|[^"\\])*"?/)) return 'string';
    if (stream.match(/`[A-Za-z_]\w*/)) return 'macroName';
    if (stream.match(/\$[A-Za-z_][\w$]*/)) return 'specialVar';
    if (stream.match(/(?:\d[\d_]*)?'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ_?]+/)) return 'number';
    if (stream.match(/0[xX][0-9a-fA-F_]+/)) return 'number';
    if (stream.match(/#\d[\d_]*(?:\.\d+)?/)) return 'simKeyword';
    if (stream.match(/\d[\d_]*(?:\.\d+)?/)) return 'number';
    if (stream.match(/\.[A-Za-z_][\w$]*/)) return 'attributeName';
    if (stream.match(/===|!==|<<<|>>>|<=|>=|==|!=|&&|\|\||<<|>>|~&|~\||~\^|\^~|[+\-*/%&|^~!<>?:=]/)) return 'operator';
    const word = stream.match(/[A-Za-z_][\w$]*/);
    if (word) {
      const id = word[0];
      if (TYPES.has(id)) return 'typeName';
      if (KEYWORDS.has(id)) return 'keyword';
      if (CONTROL.has(id)) return 'controlKeyword';
      if (SIM.has(id)) return 'simKeyword';
      return 'variableName';
    }
    stream.next();
    return null;
  },
  tokenTable: {
    comment: tags.comment,
    string: tags.string,
    macroName: tags.macroName,
    specialVar: tags.special(tags.variableName),
    number: tags.number,
    attributeName: tags.attributeName,
    operator: tags.operator,
    typeName: tags.typeName,
    keyword: tags.keyword,
    controlKeyword: tags.controlKeyword,
    simKeyword: tags.atom,
    variableName: tags.variableName,
  },
  languageData: {
    commentTokens: { line: '//', block: { open: '/*', close: '*/' } },
  },
});

// MIPS32 assembly: '#'/'//' comments, label:, mnemonic (first word of a statement), $registers,
// .directives, numbers, strings and char literals.
const mipsMode = StreamLanguage.define({
  name: 'mips',
  startState: () => ({ sawMnemonic: false }),
  token(stream, state) {
    if (stream.sol()) state.sawMnemonic = false;
    if (stream.eatSpace()) return null;
    if (stream.match('#') || stream.match('//')) { stream.skipToEnd(); return 'comment'; }
    if (stream.match(/"(?:\\.|[^"\\])*"?/)) return 'string';
    if (stream.match(/'(?:\\.|[^'\\])'/)) return 'string';
    if (stream.match(/\$[A-Za-z0-9_]+/)) return 'specialVar';
    if (stream.match(/-?0[xX][0-9a-fA-F]+|-?0[bB][01]+|-?\d+/)) return 'number';
    if (!state.sawMnemonic && stream.match(/[A-Za-z_.$][\w.$]*(?=\s*:)/)) { stream.match(/\s*:/); return 'attributeName'; }
    if (stream.match(/\.[A-Za-z_]\w*/)) { state.sawMnemonic = true; return 'macroName'; }
    if (stream.match(/[A-Za-z_][\w.]*/)) {
      if (!state.sawMnemonic) { state.sawMnemonic = true; return MIPS_PSEUDO.has(stream.current().toLowerCase()) ? 'pseudo' : 'keyword'; }
      return 'variableName';
    }
    if (stream.match(/[,()+-]/)) return 'operator';
    stream.next();
    return null;
  },
  tokenTable: {
    comment: tags.comment,
    string: tags.string,
    macroName: tags.macroName,
    specialVar: tags.special(tags.variableName),
    number: tags.number,
    attributeName: tags.attributeName,
    operator: tags.operator,
    keyword: tags.keyword,
    pseudo: tags.special(tags.controlKeyword),
    variableName: tags.variableName,
  },
  languageData: {
    commentTokens: { line: '#' },
  },
});

// Language by file name: Verilog for HDL (and data files, as before), MIPS for .asm/.s, plain otherwise.
export function editorModeFor(name) {
  if (/\.(?:asm|s)$/i.test(name || '')) return 'mips';
  if (/\.(?:txt|md|json|csv|log)$/i.test(name || '')) return 'plain';
  return 'verilog';
}

const verilogFold = foldService.of((state, lineStart) => {
  const pairs = { module: 'endmodule', begin: 'end', case: 'endcase', casex: 'endcase', casez: 'endcase', function: 'endfunction', task: 'endtask', generate: 'endgenerate', fork: 'join' };
  const words = /\b(module|endmodule|begin|end|case|casex|casez|endcase|function|endfunction|task|endtask|generate|endgenerate|fork|join)\b/g;
  const first = state.doc.lineAt(lineStart);
  const stack = [];
  for (let number = first.number; number <= state.doc.lines; number++) {
    const line = state.doc.line(number);
    const text = line.text.replace(/"(?:\\.|[^"\\])*"/g, '""').replace(/\/\/.*$/, '');
    for (const match of text.matchAll(words)) {
      const word = match[0];
      if (pairs[word]) stack.push(pairs[word]);
      else if (stack.at(-1) === word) {
        stack.pop();
        if (!stack.length) return number > first.number ? { from: first.to, to: line.from } : null;
      }
    }
    if (number === first.number && !stack.length) return null;
  }
  return null;
});

function wordAround(doc, pos, allowLiteral = false) {
  const line = doc.lineAt(pos);
  const offset = pos - line.from;
  const text = line.text;
  const isChar = allowLiteral ? /[\w$`'.]/ : /[\w$`]/;
  let start = offset, end = offset;
  while (start > 0 && isChar.test(text[start - 1])) start--;
  while (end < text.length && isChar.test(text[end])) end++;
  return text.slice(start, end);
}

// Decorations are restricted to visible ranges, so scrolling and large documents stay responsive.
const wordOccurrence = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) { if (update.docChanged || update.selectionSet || update.viewportChanged) this.decorations = this.build(update.view); }
  build(view) {
    const { doc, selection } = view.state;
    if (doc.length > 100000 || !selection.main.empty) return Decoration.none;
    const pos = selection.main.head, line = doc.lineAt(pos), offset = pos - line.from;
    let start = offset, end = offset;
    while (start > 0 && /[\w$]/.test(line.text[start - 1])) start--;
    while (end < line.length && /[\w$]/.test(line.text[end])) end++;
    const word = line.text.slice(start, end);
    if (word.length < 2 || /^\d/.test(word) || KEYWORDS.has(word) || CONTROL.has(word) || TYPES.has(word) || SIM.has(word)) return Decoration.none;
    const marks = [];
    for (const range of view.visibleRanges) {
      const text = doc.sliceString(range.from, range.to);
      let at = 0;
      while ((at = text.indexOf(word, at)) >= 0) {
        const from = range.from + at, to = from + word.length;
        const before = from > 0 ? doc.sliceString(from - 1, from) : '';
        const after = to < doc.length ? doc.sliceString(to, to + 1) : '';
        if ((!before || !/[\w$]/.test(before)) && (!after || !/[\w$]/.test(after))) marks.push(Decoration.mark({ class: 'cm-word-occ' }).range(from, to));
        at += word.length;
      }
    }
    return Decoration.set(marks, true);
  }
}, { decorations: value => value.decorations });

const indentGuides = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = this.build(view); }
  update(update) { if (update.docChanged || update.viewportChanged || update.transactions.some(tr => tr.reconfigured)) this.decorations = this.build(update.view); }
  build(view) {
    const marks = [], seen = new Set(), width = Math.max(1, view.state.facet(EditorState.tabSize));
    for (const range of view.visibleRanges) {
      let line = view.state.doc.lineAt(range.from);
      while (line.from <= range.to) {
        if (!seen.has(line.from)) {
          seen.add(line.from);
          const indent = /^ */.exec(line.text)[0].length;
          for (let column = width; column <= indent; column += width) marks.push(Decoration.mark({ class: 'cm-indent-guide' }).range(line.from + column - 1, line.from + column));
        }
        if (line.number === view.state.doc.lines) break;
        line = view.state.doc.line(line.number + 1);
      }
    }
    return Decoration.set(marks, true);
  }
}, { decorations: value => value.decorations });

const emacsKeymap = Prec.high(keymap.of([
  { key: 'Ctrl-f', run: cursorCharRight },
  { key: 'Ctrl-b', run: cursorCharLeft },
  { key: 'Ctrl-n', run: cursorLineDown },
  { key: 'Ctrl-p', run: cursorLineUp },
  { key: 'Ctrl-a', run: cursorLineBoundaryBackward },
  { key: 'Ctrl-e', run: cursorLineEnd },
  { key: 'Alt-f', run: cursorGroupForward },
  { key: 'Alt-b', run: cursorGroupBackward },
  { key: 'Alt-<', run: cursorDocStart },
  { key: 'Alt->', run: cursorDocEnd },
]));

export function createEditor(parent, onChange, onPosition, opts = {}) {
  const wrapComp = new Compartment();
  const indentComp = new Compartment();
  const fontComp = new Compartment();
  const emacsComp = new Compartment();
  const languageComp = new Compartment();
  const languageFor = mode => mode === 'mips' ? mipsMode : mode === 'plain' ? [] : [verilogMode, verilogFold];
  let mode = 'verilog';

  const highlight = HighlightStyle.define([
    { tag: tags.keyword, color: 'var(--s-keyword, #5fb3ff)', fontWeight: '600' },
    { tag: tags.controlKeyword, color: 'var(--s-control, #ffe066)', fontWeight: '600' },
    { tag: tags.special(tags.controlKeyword), color: 'var(--s-control, #ffe066)', fontWeight: '600', fontStyle: 'italic' },
    { tag: tags.atom, color: 'var(--s-sim, #ff5c8a)', fontWeight: '600' },
    { tag: tags.typeName, color: 'var(--s-type, #5ee8c0)' },
    { tag: tags.macroName, color: 'var(--s-directive, #d68bff)' },
    { tag: tags.special(tags.variableName), color: 'var(--s-systask, #ff5c8a)' },
    { tag: tags.number, color: 'var(--s-number, #ff9b4d)' },
    { tag: tags.string, color: 'var(--s-string, #a8ff60)' },
    { tag: tags.comment, color: 'var(--s-comment, #5c6370)', fontStyle: 'italic' },
    { tag: tags.operator, color: 'var(--s-operator, #9aa5b1)' },
    { tag: tags.attributeName, color: 'var(--s-port, #4dffc3)' },
  ]);

  const lineEffects = StateEffect.define();
  const lineMarks = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      value = value.map(tr.changes);
      for (const effect of tr.effects) if (effect.is(lineEffects)) value = effect.value;
      return value;
    },
    provide: field => EditorView.decorations.from(field),
  });

  class InlineValue extends WidgetType {
    constructor(text) { super(); this.text = text; }
    eq(other) { return this.text === other.text; }
    toDOM() { const el = document.createElement('span'); el.className = 'cm-inline-val'; el.textContent = this.text; return el; }
  }
  const inlineEffect = StateEffect.define();
  const inlineField = StateField.define({
    create: () => Decoration.none,
    update(value, tr) {
      value = value.map(tr.changes);
      for (const effect of tr.effects) if (effect.is(inlineEffect)) value = effect.value;
      return value;
    },
    provide: field => EditorView.decorations.from(field),
  });

  let preferences = { fontSize: 14, tabWidth: 2, wrap: false, emacs: false };
  let filename = '';
  let suppressChange = false;
  const states = new Map();

  function completionSource(context) {
    const token = context.matchBefore(/(?:`|\$)?[A-Za-z_][A-Za-z0-9_$]*/);
    if (!token) {
      if (!context.explicit) return null;
      const fallback = opts.getCompletions ? opts.getCompletions(mode) : [];
      return fallback.length ? { from: context.pos, options: toOptions(fallback), validFor: /^(?:`|\$)?[A-Za-z_][A-Za-z0-9_$]*$/ } : null;
    }
    if (!context.explicit && token.to - token.from < 2 && !token.text.startsWith('$') && !token.text.startsWith('`')) return null;
    const rawItems = opts.getCompletions ? opts.getCompletions(mode) : [];
    return {
      from: token.from,
      options: toOptions(rawItems),
      validFor: /^(?:`|\$)?[A-Za-z_][A-Za-z0-9_$]*$/,
    };
  }

  function toOptions(items) {
    return items.map(item => {
      if (item.apply && item.apply.includes('\n')) {
        return snippetCompletion(item.apply.replace('\n  \n', '\n  ${}\n'), {
          label: item.label,
          type: item.type || 'keyword',
          detail: item.detail || '',
          info: item.info || '',
        });
      }
      return {
        label: item.label,
        type: item.type || 'keyword',
        detail: item.detail || '',
        info: item.info || '',
      };
    });
  }

  const listener = EditorView.updateListener.of(update => {
    if (update.docChanged && !suppressChange) onChange(filename, update.state.doc.toString());
    if (update.docChanged || update.selectionSet) {
      const pos = update.state.selection.main.head;
      const line = update.state.doc.lineAt(pos);
      const word = wordAround(update.state.doc, pos, false);
      onPosition(line.number, pos - line.from + 1, line.text, word);
    }
  });

  const inspectHandler = EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button !== 0 || !(event.ctrlKey || event.metaKey) || !opts.onInspectToken) return false;
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos == null) return false;
      event.preventDefault();
      event.stopPropagation();
      let token = wordAround(view.state.doc, pos, true);
      if (token.startsWith('.')) token = token.slice(1);
      const line = view.state.doc.lineAt(pos).number;
      if (token) opts.onInspectToken(token, line, { x: event.clientX, y: event.clientY }, filename);
      return true;
    },
    dragover(event) {
      if (!opts.onDropModule || !Array.from(event.dataTransfer?.types || []).includes('application/x-datapath-module')) return false;
      event.preventDefault(); view.dom.classList.add('is-module-drop'); event.dataTransfer.dropEffect = 'copy'; return true;
    },
    dragleave(event) { if (!view.dom.contains(event.relatedTarget)) view.dom.classList.remove('is-module-drop'); return false; },
    drop(event) {
      if (!opts.onDropModule || !Array.from(event.dataTransfer?.types || []).includes('application/x-datapath-module')) return false;
      event.preventDefault(); event.stopPropagation(); view.dom.classList.remove('is-module-drop');
      const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (pos != null) opts.onDropModule(event.dataTransfer.getData('application/x-datapath-module'), pos);
      return true;
    },
    focus() { opts.onFocus?.(); return false; },
    blur() { opts.onBlur?.(); return false; },
  });

  const baseKeymap = Prec.high(keymap.of([
    { key: 'Shift-Alt-f', run: () => { opts.onFormat?.(); return true; } },
    { key: 'Mod-Space', run: startCompletion },
    { key: 'Mod-Shift-l', run: selectSelectionMatches },
    { key: 'Mod-.', run: () => { opts.onQuickFix?.(); return true; } },
    { key: 'F8', run: () => { opts.onNextProblem?.(1); return true; } },
    { key: 'Shift-F8', run: () => { opts.onNextProblem?.(-1); return true; } },
    { key: 'Tab', run: view => completionStatus(view.state) === 'active' ? acceptCompletion(view) : false },
    indentWithTab,
    { key: 'Mod-/', run: toggleComment },
    { key: 'Mod-g', run: gotoLine },
    { key: 'Mod-h', run: view => { openSearchPanel(view); view.dom.querySelector('input[name="replace"]')?.focus(); return true; } },
    { key: 'Escape', run: view => {
      if (completionStatus(view.state) === 'active') return closeCompletion(view);
      if (searchPanelOpen(view.state)) return closeSearchPanel(view);
      if (opts.onEscape?.()) return true;
      view.contentDOM.blur();
      return true;
    } },
  ]));

  const extensions = [
    baseKeymap,
    EditorState.allowMultipleSelections.of(true),
    EditorView.clickAddsSelectionRange.of(event => event.altKey),
    wordOccurrence,
    indentGuides,
    hoverTooltip((editorView, pos) => {
      if (!opts.onHover) return null;
      const line = editorView.state.doc.lineAt(pos), offset = pos - line.from;
      let start = offset, end = offset;
      while (start > 0 && /[\w$]/.test(line.text[start - 1])) start--;
      while (end < line.length && /[\w$]/.test(line.text[end])) end++;
      if (start === end) return null;
      const result = opts.onHover(line.text.slice(start, end), line.number, pos, editorView, line.text);
      if (!result) return null;
      const dom = result instanceof HTMLElement ? result : result.dom;
      if (!(dom instanceof HTMLElement)) return null;
      dom.classList.add('cm-hover-card');
      return { pos: result.pos ?? line.from + start, end: result.end ?? line.from + end, above: true, create: () => ({ dom }) };
    }),
    keymap.of(completionKeymap),
    emacsComp.of([]),
    basicSetup,
    languageComp.of(languageFor('verilog')),
    syntaxHighlighting(highlight),
    bracketMatching(),
    autocompletion({ override: [completionSource], icons: false, activateOnTyping: true, defaultKeymap: true }),
    lintGutter(),
    lineMarks,
    inlineField,
    wrapComp.of([]),
    indentComp.of([indentUnit.of('  '), EditorState.tabSize.of(2)]),
    fontComp.of(EditorView.theme({ '&': { fontSize: '14px' } })),
    EditorView.contentAttributes.of({ 'aria-label': 'Source editor', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off' }),
    inspectHandler,
    listener,
  ];

  const view = new EditorView({ state: EditorState.create({ doc: '', extensions }), parent });

  function applyPreferences(next) {
    preferences = { ...preferences, ...next };
    view.dispatch({
      effects: [
        wrapComp.reconfigure(preferences.wrap ? EditorView.lineWrapping : []),
        indentComp.reconfigure([indentUnit.of(' '.repeat(preferences.tabWidth || 2)), EditorState.tabSize.of(preferences.tabWidth || 2)]),
        fontComp.reconfigure(EditorView.theme({ '&': { fontSize: `${preferences.fontSize || 14}px` } })),
        emacsComp.reconfigure(preferences.emacs ? emacsKeymap : []),
      ],
    });
  }

  function setMode(next) {
    mode = next;
    view.dispatch({ effects: languageComp.reconfigure(languageFor(mode)) });
  }

  function emitPos() {
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    onPosition(line.number, pos - line.from + 1, line.text, wordAround(view.state.doc, pos, false));
  }

  return {
    dom: view.dom,
    open(name, text, viewState = null) {
      if (filename) states.set(filename, view.state);
      filename = name;
      let state = states.get(name);
      if (!state || state.doc.toString() !== text) state = EditorState.create({ doc: text ?? '', extensions });
      view.setState(state);
      setMode(editorModeFor(name));
      applyPreferences(preferences);
      if (viewState) {
        const len = view.state.doc.length;
        const anchor = Math.max(0, Math.min(len, viewState.anchor || 0));
        const head = Math.max(0, Math.min(len, viewState.head ?? anchor));
        view.dispatch({ selection: { anchor, head } });
        requestAnimationFrame(() => {
          view.scrollDOM.scrollTop = viewState.top || 0;
          view.scrollDOM.scrollLeft = viewState.left || 0;
        });
      }
      emitPos();
    },
    setTextIfChanged(text) {
      if (view.state.doc.toString() === text) return;
      const sel = view.state.selection.main;
      const top = view.scrollDOM.scrollTop;
      const left = view.scrollDOM.scrollLeft;
      suppressChange = true;
      try {
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: text },
          selection: { anchor: Math.min(sel.anchor, text.length), head: Math.min(sel.head, text.length) },
        });
        view.scrollDOM.scrollTop = top;
        view.scrollDOM.scrollLeft = left;
      } finally {
        suppressChange = false;
      }
    },
    getViewState() {
      const sel = view.state.selection.main;
      return { top: view.scrollDOM.scrollTop, left: view.scrollDOM.scrollLeft, anchor: sel.anchor, head: sel.head };
    },
    getFilename() { return filename; },
    getMode() { return mode; },
    rename(from, to) {
      const state = states.get(from);
      states.delete(from);
      if (state) states.set(to, state);
      if (filename === from) { filename = to; setMode(editorModeFor(to)); }
    },
    remove(name) { states.delete(name); if (filename === name) filename = ''; },
    configure: applyPreferences,
    jump(line) {
      const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
      view.dispatch({ selection: { anchor: target.from }, scrollIntoView: true });
      view.focus();
    },
    setInlineValues(entries) {
      const marks = entries.filter(e => e.line > 0 && e.line <= view.state.doc.lines).map(e => Decoration.widget({ widget: new InlineValue(e.text), side: 1 }).range(view.state.doc.line(e.line).to));
      view.dispatch({ effects: inlineEffect.of(Decoration.set(marks, true)) });
    },
    replaceText(text) { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }); },
    diagnostics(items) {
      const mapped = items.filter(item => item.file === filename && item.line > 0 && item.line <= view.state.doc.lines).map(item => {
        const line = view.state.doc.line(item.line);
        return { from: line.from, to: line.to, severity: item.severity === 'warning' ? 'warning' : 'error', message: item.message };
      });
      const marks = [...new Set(mapped.map(item => item.from))].sort((a, b) => a - b).map(pos => Decoration.line({ class: 'cm-diagnostic-line' }).range(pos));
      view.dispatch(setDiagnostics(view.state, mapped));
      view.dispatch({ effects: lineEffects.of(Decoration.set(marks)) });
    },
    focus() { view.focus(); },
    blur() { view.contentDOM.blur(); },
    destroy() { view.destroy(); },
    getCursorPos() { const pos = view.state.selection.main.head; const line = view.state.doc.lineAt(pos); return { pos, line: line.number, col: pos - line.from + 1 }; },
    insertText(text, pos = null) {
      const sel = view.state.selection.main;
      const from = pos == null ? sel.from : Math.max(0, Math.min(view.state.doc.length, pos));
      const to = pos == null ? sel.to : from;
      view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true });
      view.focus();
    },
    moveCursor(dir) {
      const map = { left: cursorCharLeft, right: cursorCharRight, up: cursorLineUp, down: cursorLineDown, home: cursorLineBoundaryBackward, end: cursorLineEnd };
      map[dir]?.(view);
      view.focus();
    },
    toggleComment() { toggleComment(view); view.focus(); },
    indent() { indentMore(view); view.focus(); },
    dedent() { indentLess(view); view.focus(); },
    undo() { cmUndo(view); view.focus(); },
    redo() { cmRedo(view); view.focus(); },
    triggerCompletion() { view.focus(); startCompletion(view); },
    closeCompletion() { closeCompletion(view); },
    measure() { view.requestMeasure(); },
  };
}
