// Featured Showcase launcher and smooth, non-blocking 6-chapter Interactive Hardware Tour.
import { SHOWCASE_PROJECTS, showcaseProject } from './showcase-projects.js';

export const TOUR_CHAPTERS = [
  {
    id: 'boot',
    step: 1,
    title: 'Boot',
    fullTitle: 'Boot a MIPS32 CPU',
    projectId: 'mips-cpu',
    panel: 'hw-state',
    copy: 'This Verilog CPU (mips_cpu.v) runs Fibonacci from program.asm — watch $t0–$t5 light up live.',
    assistLabel: 'Peek program.asm & IMEM',
    spotlight: '#hw-arrays',
  },
  {
    id: 'xray',
    step: 2,
    title: 'X-Ray',
    fullTitle: 'X-Ray the Datapath',
    projectId: 'mips-cpu',
    panel: 'schematic',
    copy: 'Same CPU, turned into live gates. Tap u_alu for live pin math, fan-in/out cones, or Jump to Code.',
    assistLabel: 'Inspect u_alu',
    spotlight: '#schem-learn-bar',
  },
  {
    id: 'debug',
    step: 3,
    title: 'Debug',
    fullTitle: 'Catch a Silent Latch',
    projectId: 'bug-hunter',
    panel: 'schematic',
    copy: 'A missing else in always @(*) silently builds a latch. Click the warning pill to jump straight to it.',
    assistLabel: 'Jump to Latch',
    spotlight: '#schem-warnings .schem-warning',
  },
  {
    id: 'time',
    step: 4,
    title: 'Time',
    fullTitle: 'Read States by Name',
    projectId: 'fsm-control',
    panel: 'waveform',
    copy: "No decoding 3'b010 in your head — FSM states render as FETCH → DECODE → EXEC right on the bus.",
    assistLabel: 'Step Cycle',
    spotlight: '#wave-step-next',
  },
  {
    id: 'touch',
    step: 5,
    title: 'Touch',
    fullTitle: 'Touch Live Hardware',
    projectId: 'fpga-board',
    panel: 'board',
    copy: 'No testbench needed. Flip rst off, en on, and hit Tick Clock to drive live LEDs & 7-seg digits.',
    assistLabel: 'Demo Tick',
    spotlight: '#board-tick',
  },
  {
    id: 'verify',
    step: 6,
    title: 'Verify',
    fullTitle: 'Verify Like an Engineer',
    projectId: 'alu-suite',
    panel: 'tests',
    copy: "Four self-checking ALU testbenches verified in one pass — click any row's Wave or Log to inspect.",
    assistLabel: 'Start Clean Workspace',
    spotlight: '#tests-summary',
  },
];

// Accepts a 1-based step (number or string) or a chapter id (case-insensitive); returns 0..5 or -1.
export function resolveChapterIndex(ref) {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref >= 1 && ref <= TOUR_CHAPTERS.length ? ref - 1 : -1;
  const raw = String(ref ?? '').trim().toLowerCase();
  if (!raw) return -1;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    return n >= 1 && n <= TOUR_CHAPTERS.length ? n - 1 : -1;
  }
  return TOUR_CHAPTERS.findIndex(chapter => chapter.id === raw);
}

// Parses ?tour=... or ?showcase=... query parameters into a safe launch directive or null.
export function parseDeepLink(search = '') {
  const params = new URLSearchParams(search || '');
  if (params.has('tour')) {
    const value = (params.get('tour') || '').trim().toLowerCase();
    if (!value || value === '1' || value === 'true') return { kind: 'tour', index: 0 };
    const index = resolveChapterIndex(value);
    if (index >= 0) return { kind: 'tour', index };
  }
  if (params.has('showcase')) {
    const id = (params.get('showcase') || '').trim();
    if (SHOWCASE_PROJECTS.some(project => project.id === id)) return { kind: 'showcase', id };
  }
  return null;
}

// Pure tour state machine with monotonic generation tokens so async setup never races user jumps.
export function createTourState({ onChange = null } = {}) {
  const state = { active: false, index: 0, done: new Set(), busyText: '', gen: 0 };
  const notify = () => onChange?.({ ...state, done: new Set(state.done) });
  const clamp = index => Math.max(0, Math.min(TOUR_CHAPTERS.length - 1, index));

  return {
    start(index = 0) {
      state.active = true;
      state.index = clamp(index);
      state.done.clear();
      state.busyText = '';
      state.gen += 1;
      notify();
      return state.gen;
    },
    goTo(index) {
      state.active = true;
      state.index = clamp(index);
      state.busyText = '';
      state.gen += 1;
      notify();
      return state.gen;
    },
    next() { return this.goTo(state.index + 1); },
    prev() { return this.goTo(state.index - 1); },
    markDone(index = state.index) {
      if (index < 0 || index >= TOUR_CHAPTERS.length || state.done.has(index)) return;
      state.done.add(index);
      notify();
    },
    setBusy(text = '') {
      if (state.busyText === text) return;
      state.busyText = text;
      notify();
    },
    stop() {
      state.active = false;
      state.busyText = '';
      state.gen += 1;
      notify();
    },
    isCurrent: gen => state.active && state.gen === gen,
    getState: () => ({ ...state, done: new Set(state.done) }),
  };
}

// Smooth grid-row expand/collapse helper: sets `hidden` cleanly after closing unless interrupted.
function setCollapsible(el, open) {
  if (!el) return;
  clearTimeout(el._collapseTimer);
  if (open) {
    el.hidden = false;
    void el.offsetHeight;
    el.classList.add('is-open');
    return;
  }
  el.classList.remove('is-open');
  if (el.hidden) return;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) { el.hidden = true; return; }
  el._collapseTimer = setTimeout(() => { if (!el.classList.contains('is-open')) el.hidden = true; }, 240);
}

const PASSIVE_TARGETS = [
  '#hw-arrays button, #hw-play, #hw-disasm, #hw-abi',
  '#schem-canvas .schem-cell, #schem-learn-bar .learn-change',
  '#schem-warnings .schem-warning, #schem-canvas .schem-cell.kind-latch',
  '#wave-step-next, #wave-step-prev, #wave-play, #wave-grid canvas',
  '#board-live-inputs .board-switch, #board-tick',
  '#tests-results button',
];

export function installTour({
  $,
  loadShowcase,
  openFile,
  setDockPosition,
  setInspectorHidden,
  warmSchematic,
  runSimulation,
  elaborateModule,
  showPanel,
  selectHwArray,
  playHwState,
  pausePlayback,
  stepSchem,
  inspectSchemCell,
  clickLatchWarning,
  focusWaveSignal,
  stepWave,
  startLiveBoard,
  demoBoardTick,
  runAllTests,
  resetCleanWorkspace,
  waitEngineReady,
  getActiveProjectId,
  hasTrace,
  onOpenShowcase,
  onDismissHero,
}) {
  const hero = $('featured-hero');
  const rail = $('tour-rail');
  const stepsEl = $('tour-steps');
  const counterEl = $('tour-counter');
  const copyEl = $('tour-copy');
  const busyEl = $('tour-busy');
  const assistBtn = $('tour-assist');
  const prevBtn = $('tour-prev');
  const nextBtn = $('tour-next');
  let spottedEl = null;

  function clearSpotlight() {
    if (spottedEl) spottedEl.classList.remove('tour-spot');
    spottedEl = null;
  }

  function applySpotlight(selector) {
    clearSpotlight();
    if (!selector) return;
    const target = document.querySelector(selector);
    if (!target) return;
    spottedEl = target;
    target.classList.add('tour-spot');
  }

  function buildButtons() {
    const chaptersEl = $('featured-chapters');
    if (chaptersEl) {
      chaptersEl.replaceChildren(...TOUR_CHAPTERS.map((ch, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'featured-chip';
        btn.dataset.tourChapter = ch.id;
        btn.innerHTML = `<span class="fc-num">${ch.step}</span><span>${ch.title}</span>`;
        btn.title = `${ch.fullTitle}: ${ch.copy}`;
        btn.onclick = () => start(idx);
        return btn;
      }));
    }
    if (stepsEl) {
      stepsEl.replaceChildren(...TOUR_CHAPTERS.map((ch, idx) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tour-step';
        btn.dataset.tourStep = String(idx);
        btn.title = ch.fullTitle;
        btn.innerHTML = `<span class="ts-dot">${ch.step}</span><span class="ts-lbl">${ch.title}</span>`;
        btn.onclick = () => goTo(idx);
        return btn;
      }));
    }
  }

  function render(state) {
    setCollapsible(rail, state.active);
    if (!state.active) { clearSpotlight(); return; }
    const ch = TOUR_CHAPTERS[state.index];
    counterEl.textContent = `${ch.step}/${TOUR_CHAPTERS.length}`;
    if (copyEl.dataset.step !== String(state.index)) {
      copyEl.dataset.step = String(state.index);
      copyEl.classList.remove('is-swapping');
      void copyEl.offsetWidth;
      copyEl.classList.add('is-swapping');
    }
    copyEl.textContent = ch.copy;
    busyEl.textContent = state.busyText;
    busyEl.hidden = !state.busyText;
    assistBtn.textContent = ch.assistLabel;
    assistBtn.disabled = Boolean(state.busyText);
    prevBtn.disabled = state.index === 0;
    nextBtn.textContent = state.index === TOUR_CHAPTERS.length - 1 ? 'Keep Exploring' : 'Next →';
    for (const btn of stepsEl.querySelectorAll('.tour-step')) {
      const idx = Number(btn.dataset.tourStep);
      btn.classList.toggle('is-active', idx === state.index);
      btn.classList.toggle('is-done', state.done.has(idx));
      btn.setAttribute('aria-current', idx === state.index ? 'step' : 'false');
    }
  }

  const machine = createTourState({ onChange: render });
  buildButtons();

  async function stageProject(projectId, guard, busyLabel) {
    machine.setBusy(busyLabel);
    await waitEngineReady();
    if (!guard()) return false;
    loadShowcase(projectId, { silent: true });
    const sim = await runSimulation({ suppressAutoWave: true });
    if (!guard()) return false;
    return sim.ok;
  }

  async function enterChapter(index, gen) {
    const guard = () => machine.isCurrent(gen);
    clearSpotlight();
    pausePlayback();
    const ch = TOUR_CHAPTERS[index];

    if (ch.id === 'boot') {
      setDockPosition?.('right', { show: true });
      setInspectorHidden?.(true);
      const ok = await stageProject('mips-cpu', guard, 'Compiling Verilog CPU…');
      if (!guard() || !ok) { machine.setBusy(''); return; }
      openFile?.('mips_cpu.v');
      showPanel('hw-state');
      selectHwArray('mips_cpu_tb.dut.u_rf.regs', { abi: true, disasm: false });
      playHwState();
      warmSchematic?.();
      machine.setBusy('');
      applySpotlight('#hw-arrays');
    } else if (ch.id === 'xray') {
      setDockPosition?.('right', { show: true });
      setInspectorHidden?.(true);
      if (getActiveProjectId() !== 'mips-cpu' || !hasTrace()) {
        const ok = await stageProject('mips-cpu', guard, 'Booting CPU for schematic…');
        if (!guard() || !ok) { machine.setBusy(''); return; }
      }
      openFile?.('mips_cpu.v');
      machine.setBusy('Elaborating RTL schematic…');
      showPanel('schematic');
      await elaborateModule('mips_cpu');
      if (!guard()) return;
      stepSchem(1);
      machine.setBusy('');
      applySpotlight('#schem-canvas .schem-cell.kind-module[data-name="u_alu"]');
      if (!document.querySelector('#schem-canvas .schem-cell.kind-module[data-name="u_alu"]')) applySpotlight('#schem-learn-bar');
    } else if (ch.id === 'debug') {
      setDockPosition?.('right', { show: true });
      setInspectorHidden?.(true);
      const ok = await stageProject('bug-hunter', guard, 'Checking RTL for latches…');
      if (!guard() || !ok) { machine.setBusy(''); return; }
      machine.setBusy('Elaborating schematic…');
      showPanel('schematic');
      await elaborateModule('datapath_slice');
      if (!guard()) return;
      machine.setBusy('');
      applySpotlight('#schem-warnings .schem-warning');
    } else if (ch.id === 'time') {
      setDockPosition?.('bottom', { show: true });
      setInspectorHidden?.(true);
      const ok = await stageProject('fsm-control', guard, 'Simulating control FSM…');
      if (!guard() || !ok) { machine.setBusy(''); return; }
      showPanel('waveform');
      focusWaveSignal('fsm_tb.dut.state');
      stepWave(1);
      machine.setBusy('');
      applySpotlight('#wave-step-next');
    } else if (ch.id === 'touch') {
      setDockPosition?.('right', { show: true });
      setInspectorHidden?.(true);
      machine.setBusy('Starting live FPGA DUT…');
      await waitEngineReady();
      if (!guard()) return;
      loadShowcase('fpga-board', { silent: true });
      showPanel('board');
      await startLiveBoard('fpga_counter');
      if (!guard()) return;
      machine.setBusy('');
      applySpotlight('#board-tick');
    } else if (ch.id === 'verify') {
      setDockPosition?.('right', { show: true });
      setInspectorHidden?.(true);
      machine.setBusy('Running 4 ALU testbenches…');
      await waitEngineReady();
      if (!guard()) return;
      loadShowcase('alu-suite', { silent: true });
      showPanel('tests');
      await runAllTests();
      if (!guard()) return;
      machine.setBusy('');
      machine.markDone(index);
      applySpotlight('#tests-summary');
    }
  }

  function start(index = 0) {
    if ($('template-dialog')?.open) $('template-dialog').close();
    hideFeatured();
    onDismissHero?.();
    const gen = machine.start(index);
    enterChapter(machine.getState().index, gen);
  }

  function goTo(index) {
    const gen = machine.goTo(index);
    enterChapter(machine.getState().index, gen);
  }

  function stop() {
    clearSpotlight();
    machine.stop();
  }

  function runAssist() {
    const state = machine.getState();
    if (!state.active) return;
    const ch = TOUR_CHAPTERS[state.index];
    clearSpotlight();
    machine.markDone(state.index);
    if (ch.id === 'boot') {
      pausePlayback();
      openFile?.('program.asm');
      showPanel('hw-state');
      selectHwArray('mips_cpu_tb.dut.u_imem.mem', { disasm: true, view: 'table' });
    } else if (ch.id === 'xray') {
      showPanel('schematic');
      inspectSchemCell('u_alu');
    } else if (ch.id === 'debug') {
      showPanel('schematic');
      clickLatchWarning();
    } else if (ch.id === 'time') {
      showPanel('waveform');
      stepWave(1);
    } else if (ch.id === 'touch') {
      showPanel('board');
      demoBoardTick();
    } else if (ch.id === 'verify') {
      stop();
      setDockPosition?.('bottom');
      resetCleanWorkspace();
    }
  }

  async function launchShowcaseLive(id) {
    if (!showcaseProject(id)) return false;
    hideFeatured();
    onDismissHero?.();
    await waitEngineReady();
    loadShowcase(id, { silent: true });
    if (id === 'mips-cpu') {
      if ((await runSimulation({ suppressAutoWave: true })).ok) {
        showPanel('hw-state');
        selectHwArray('mips_cpu_tb.dut.u_rf.regs', { abi: true });
        playHwState();
      }
    } else if (id === 'fpga-board') {
      showPanel('board');
      await startLiveBoard('fpga_counter');
    } else if (id === 'fsm-control') {
      if ((await runSimulation({ suppressAutoWave: true })).ok) {
        showPanel('waveform');
        focusWaveSignal('fsm_tb.dut.state');
        stepWave(1);
      }
    } else if (id === 'alu-suite') {
      showPanel('tests');
      await runAllTests();
    } else if (id === 'bug-hunter') {
      if ((await runSimulation({ suppressAutoWave: true })).ok) {
        showPanel('schematic');
        await elaborateModule('datapath_slice');
      }
    }
    return true;
  }

  function showFeatured() { setCollapsible(hero, true); }
  function hideFeatured() { setCollapsible(hero, false); }

  $('tour-start')?.addEventListener('click', () => start(0));
  $('dialog-tour-start')?.addEventListener('click', () => start(0));
  $('featured-browse')?.addEventListener('click', () => onOpenShowcase?.());
  $('featured-dismiss')?.addEventListener('click', () => { hideFeatured(); onDismissHero?.(); });
  $('tour-close')?.addEventListener('click', stop);
  $('tour-prev')?.addEventListener('click', () => { const s = machine.getState(); if (s.index > 0) goTo(s.index - 1); });
  $('tour-next')?.addEventListener('click', () => {
    const s = machine.getState();
    if (s.index >= TOUR_CHAPTERS.length - 1) stop();
    else goTo(s.index + 1);
  });
  assistBtn?.addEventListener('click', runAssist);

  document.addEventListener('click', event => {
    const state = machine.getState();
    if (!state.active || state.busyText) return;
    if (rail?.contains(event.target)) return;
    const sel = PASSIVE_TARGETS[state.index];
    if (sel && event.target.closest?.(sel)) {
      machine.markDone(state.index);
      clearSpotlight();
    }
  });

  return {
    start,
    goTo,
    stop,
    launchShowcaseLive,
    showFeatured,
    hideFeatured,
    setBusyText: text => { if (machine.getState().active && text) machine.setBusy(text); },
    isActive: () => machine.getState().active,
    isHeroVisible: () => Boolean(hero && !hero.hidden),
  };
}
