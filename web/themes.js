/* Theme system modeled on AMOLED/tonal IDE palettes, with independent syntax overrides. */

export const THEMES = {
  amoled: {
    dark: true,
    name: 'AMOLED Black',
    ui: ['#000000', '#000000', '#0a0a0a', '#141414', '#e8e8e8', '#7d8590', '#3d8bff', '#ffb02e', '#2ee67a', '#ffd24d', '#ff3b5c'],
    syn: ['#5fb3ff', '#5ee8c0', '#d68bff', '#ff5c8a', '#ff9b4d', '#a8ff60', '#5c6370', '#9aa5b1', '#4dffc3', '#2a0010', '#241c00', '#ffe066', '#ff5c8a'],
  },
  midnight: {
    dark: true,
    name: 'Midnight',
    ui: ['#0d1220', '#111827', '#161f33', '#1d2840', '#d7def0', '#8592b0', '#5b8cff', '#ffb454', '#57d9a3', '#ffcc66', '#ff5f6d'],
    syn: ['#7aa2f7', '#2ac3de', '#bb9af7', '#f7768e', '#ff9e64', '#9ece6a', '#5f6b8a', '#89ddff', '#73daca', '#3d1f2a', '#3a3320', '#ffe580', '#ff6ab4'],
  },
  'tokyo-night': {
    dark: true,
    name: 'Tokyo Night',
    ui: ['#1a1b26', '#1f2030', '#24283b', '#2c3149', '#c0caf5', '#787c99', '#7aa2f7', '#ff9e64', '#9ece6a', '#e0af68', '#f7768e'],
    syn: ['#7aa2f7', '#2ac3de', '#bb9af7', '#f7768e', '#ff9e64', '#9ece6a', '#565f89', '#89ddff', '#73daca', '#3d1f2a', '#3a3320', '#ffe580', '#ff6ab4'],
  },
  dracula: {
    dark: true,
    name: 'Dracula',
    ui: ['#282a36', '#2b2d3a', '#313443', '#3a3d4f', '#f8f8f2', '#8b8fa8', '#bd93f9', '#ffb86c', '#50fa7b', '#f1fa8c', '#ff5555'],
    syn: ['#ff79c6', '#8be9fd', '#bd93f9', '#ffb86c', '#bd93f9', '#f1fa8c', '#6272a4', '#f8f8f2', '#50fa7b', '#4a2433', '#45422a', '#ff6e6e', '#ffb86c'],
  },
  nord: {
    dark: true,
    name: 'Nord',
    ui: ['#2e3440', '#323946', '#3b4252', '#434c5e', '#eceff4', '#8f9bb3', '#88c0d0', '#ebcb8b', '#a3be8c', '#ebcb8b', '#bf616a'],
    syn: ['#81a1c1', '#5fb8a8', '#b48ead', '#d08770', '#b48ead', '#a3be8c', '#616e88', '#eceff4', '#ebcb8b', '#43303a', '#45413a', '#ebcb8b', '#d08770'],
  },
  gruvbox: {
    dark: true,
    name: 'Gruvbox',
    ui: ['#282828', '#2c2c2c', '#32302f', '#3c3836', '#ebdbb2', '#a89984', '#83a598', '#fe8019', '#b8bb26', '#fabd2f', '#fb4934'],
    syn: ['#fb4934', '#fe8019', '#d3869b', '#83a598', '#d3869b', '#b8bb26', '#928374', '#ebdbb2', '#fabd2f', '#4a2622', '#4a4022', '#fabd2f', '#83a598'],
  },
  catppuccin: {
    dark: true,
    name: 'Catppuccin Mocha',
    ui: ['#1e1e2e', '#212131', '#262637', '#313244', '#cdd6f4', '#9399b2', '#89b4fa', '#fab387', '#a6e3a1', '#f9e2af', '#f5c2e7'],
    syn: ['#89b4fa', '#94e2c5', '#cba6f7', '#f38ba8', '#fab387', '#a6e3a1', '#7f849c', '#89dceb', '#f9e2af', '#45273a', '#45402f', '#f9e2af', '#f5c2e7'],
  },
  light: {
    dark: false,
    name: 'Paper Light',
    ui: ['#f6f7f9', '#ffffff', '#eef0f4', '#e3e6ec', '#1f2328', '#667085', '#2563eb', '#c2410c', '#15803d', '#a16207', '#dc2626'],
    syn: ['#1d4ed8', '#0e7490', '#7e22ce', '#c2410c', '#b45309', '#15803d', '#7c8593', '#475569', '#0f766e', '#fde2e2', '#fdf3d0', '#c026d3', '#e11d48'],
  },
  contrast: {
    dark: true,
    name: 'High Contrast',
    ui: ['#000000', '#000000', '#111111', '#242424', '#ffffff', '#d4d4d4', '#a8c5ff', '#ffd24d', '#50fa7b', '#ffe066', '#ff5c77'],
    syn: ['#8ab4ff', '#5ee8c0', '#e29eff', '#ff80ab', '#ffb86c', '#a8ff60', '#9e9e9e', '#ffffff', '#ffd24d', '#4d0018', '#3d2e00', '#fff59d', '#ff80ab'],
  },
};

export const THEME_ORDER = [
  'amoled',
  'midnight',
  'tokyo-night',
  'dracula',
  'nord',
  'gruvbox',
  'catppuccin',
  'light',
  'contrast',
];

const UI_VARS = ['bg', 'surface', 'panel', 'raised', 'text', 'muted', 'primary', 'accent', 'success', 'warning', 'error'];
// control: Verilog behavioral control flow + MIPS pseudo-instructions; sim: simulation/testbench-only constructs.
export const SYN_VARS = ['keyword', 'type', 'directive', 'systask', 'number', 'string', 'comment', 'operator', 'port', 'errbg', 'warnbg', 'control', 'sim'];

export function normalizeThemeId(themeId) {
  if (themeId === 'dark') return 'amoled';
  return Object.hasOwn(THEMES, themeId) ? themeId : 'amoled';
}

export function applyTheme(themeId, syntaxId = 'auto') {
  const resolved = normalizeThemeId(themeId);
  const synResolved = syntaxId === 'auto' || !Object.hasOwn(THEMES, syntaxId) ? resolved : syntaxId;
  const uiTheme = THEMES[resolved];
  const synTheme = THEMES[synResolved];
  const root = document.documentElement;

  UI_VARS.forEach((name, idx) => root.style.setProperty(`--${name}`, uiTheme.ui[idx]));
  SYN_VARS.forEach((name, idx) => {
    root.style.setProperty(`--s-${name}`, synTheme.syn[idx]);
    root.style.setProperty(`--syn-${name}`, `var(--s-${name})`);
  });

  root.style.setProperty('--hair', uiTheme.dark
    ? (resolved === 'contrast' ? 'rgba(255,255,255,0.28)' : 'color-mix(in srgb, var(--text) 9%, transparent)')
    : 'color-mix(in srgb, var(--text) 12%, transparent)');
  root.style.setProperty('--hover', 'color-mix(in srgb, var(--text) 7%, transparent)');
  root.style.setProperty('--sel', 'color-mix(in srgb, var(--primary) 26%, transparent)');
  root.style.setProperty('--chip', 'color-mix(in srgb, var(--text) 7%, transparent)');

  // Compatibility aliases so Waveform & sub-panels track all 9 themes seamlessly
  root.style.setProperty('--bg-canvas', 'var(--surface)');
  root.style.setProperty('--bg-surface', 'var(--panel)');
  root.style.setProperty('--bg-elevated', 'var(--raised)');
  root.style.setProperty('--bg-active', 'var(--sel)');
  root.style.setProperty('--border', 'var(--hair)');
  root.style.setProperty('--text-primary', 'var(--text)');
  root.style.setProperty('--text-secondary', 'var(--muted)');
  root.style.setProperty('--text-muted', 'var(--muted)');
  root.style.setProperty('--warn', 'var(--warning)');
  root.style.setProperty('--err', 'var(--error)');
  root.style.setProperty('--syntax-keyword', 'var(--s-keyword)');
  root.style.setProperty('--syntax-string', 'var(--s-string)');
  root.style.setProperty('--syntax-number', 'var(--s-number)');
  root.style.setProperty('--syntax-atom', 'var(--s-systask)');

  root.dataset.dark = uiTheme.dark ? '1' : '0';
  root.style.colorScheme = uiTheme.dark ? 'dark' : 'light';
  document.body.dataset.theme = resolved;

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', uiTheme.ui[2]);

  return resolved;
}
