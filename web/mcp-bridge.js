// Opt-in workspace synchronisation and browser-side MCP RPC transport.
const CONFIG_KEY = 'datapath.mcp-bridge.v1';
const CLIENT_KEY = 'datapath.mcp-client.v1';
const REMOTE_DISABLED = 'Remote control is disabled in this browser tab (enable Allow remote control in Sync & MCP Bridge).';
const METHODS = new Set(['ide_get_state', 'ide_navigate', 'ide_open_showcase', 'ide_run', 'ide_get_problems', 'ide_apply_quick_fix', 'ide_waveform', 'ide_schematic', 'ide_board']);

export function installMcpBridge(hooks = {}) {
  let config = { enabled: false, url: '', token: '', label: '', allowRemote: false };
  try { const saved = JSON.parse(localStorage.getItem(CONFIG_KEY)); if (saved && typeof saved === 'object') config = { ...config, ...saved }; } catch { /* Unavailable or malformed preferences. */ }
  config.enabled = config.enabled === true;
  config.allowRemote = config.allowRemote === true;
  let clientId;
  try {
    clientId = sessionStorage.getItem(CLIENT_KEY);
    if (!clientId) { clientId = globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; sessionStorage.setItem(CLIENT_KEY, clientId); }
  } catch { clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
  if (!config.label) config.label = typeof innerWidth === 'number' && innerWidth <= 900 ? 'Phone' : 'Desktop';
  const pairing = new URL(location.href);
  if (pairing.searchParams.has('bridgeToken')) {
    config.token = pairing.searchParams.get('bridgeToken') || '';
    config.url = pairing.searchParams.get('bridgeUrl') || '';
    config.enabled = Boolean(config.token);
    config.allowRemote = pairing.searchParams.has('bridgeRemote') ? pairing.searchParams.get('bridgeRemote') === '1' : true;
    pairing.searchParams.delete('bridgeToken');
    history.replaceState(history.state, '', pairing.href);
    persist();
  }

  let socket = null, retryTimer = null, retryDelay = 1000, generation = 0;
  let connected = false, synced = false, suppressOutbound = false, rev = 0, clients = [], error = '';
  const pendingFiles = new Map(), timers = new Map();
  let pendingMeta = null;
  function persist() { try { localStorage.setItem(CONFIG_KEY, JSON.stringify(config)); } catch { /* Keep this tab usable without storage. */ } }
  function state() { return { ...config, clientId, connected, synced, rev, clients: [...clients], error }; }
  function publish() { hooks.onStatus?.(state()); }
  function send(message) {
    if (!connected || socket?.readyState !== 1) return false;
    try { socket.send(JSON.stringify(message)); return true; } catch { return false; }
  }
  function sendPending() {
    if (!synced) return;
    for (const [path, change] of pendingFiles) if (send(change)) pendingFiles.delete(path);
    if (pendingMeta && send(pendingMeta)) pendingMeta = null;
  }
  function flush() { for (const timer of timers.values()) clearTimeout(timer); timers.clear(); sendPending(); }
  function apply(fn) { suppressOutbound = true; try { fn(); } finally { suppressOutbound = false; } }
  async function rpc(message) {
    const { id, method } = message;
    if (!config.allowRemote) { send({ type: 'rpc:result', id, ok: false, error: REMOTE_DISABLED }); return; }
    try {
      if (!METHODS.has(method)) throw new Error(`Unknown browser method: ${method}`);
      const handler = hooks[method] || hooks.onRpc;
      if (typeof handler !== 'function') throw new Error(`Browser method is unavailable: ${method}`);
      hooks.onRemoteAction?.(method);
      const result = hooks[method] ? await handler(message.params || {}) : await handler(method, message.params || {});
      send({ type: 'rpc:result', id, ok: true, result: result ?? null });
    } catch (failure) { send({ type: 'rpc:result', id, ok: false, error: failure?.message || String(failure) }); }
  }
  function receive(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'rpc') { void rpc(message); return; }
    if (typeof message.rev === 'number' && message.rev < rev && message.type !== 'sync') return;
    if (typeof message.rev === 'number') rev = message.rev;
    if (message.type === 'clients') clients = Array.isArray(message.clients) ? message.clients : [];
    else if (message.type === 'sync') {
      clients = Array.isArray(message.clients) ? message.clients : [];
      apply(() => {
        hooks.onSync?.(message);
        // Local edits made while disconnected are retained and replayed after the server snapshot.
        for (const change of pendingFiles.values()) {
          if (change.type === 'file:put') hooks.onFileChanged?.({ path: change.path, content: change.content });
          else hooks.onFileDeleted?.({ path: change.path });
        }
        if (pendingMeta) hooks.onMetaChanged?.(pendingMeta);
      });
      synced = true; retryDelay = 1000; sendPending();
    } else if (message.originClientId !== clientId) {
      if (message.type === 'file:changed' && !pendingFiles.has(message.path)) apply(() => hooks.onFileChanged?.(message));
      else if (message.type === 'file:deleted' && !pendingFiles.has(message.path)) apply(() => hooks.onFileDeleted?.(message));
      else if (message.type === 'meta:changed' && !pendingMeta) apply(() => hooks.onMetaChanged?.(message));
    }
    publish();
  }
  function disconnectSocket() {
    generation++; clearTimeout(retryTimer); retryTimer = null;
    const old = socket; socket = null; connected = false; synced = false;
    if (old) { old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(); } catch { /* Already closed. */ } }
  }
  function connect() {
    disconnectSocket();
    if (!config.enabled || !config.token) { publish(); return; }
    let url;
    try {
      url = config.url ? new URL(config.url, location.href) : new URL('./ws', location.href);
      if (url.protocol === 'http:') url.protocol = 'ws:';
      else if (url.protocol === 'https:') url.protocol = 'wss:';
      if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('Bridge URL must use ws:// or wss://');
      url.searchParams.set('token', config.token); url.searchParams.set('clientId', clientId); url.searchParams.set('label', config.label);
      const attempt = generation; socket = new WebSocket(url.href); error = '';
      socket.onopen = () => { if (attempt !== generation) return; connected = true; send({ type: 'hello', clientId, label: config.label, allowRemote: config.allowRemote }); publish(); };
      socket.onmessage = event => { if (attempt !== generation) return; try { receive(JSON.parse(event.data)); } catch (failure) { hooks.onError?.(failure); } };
      socket.onerror = () => { if (attempt === generation) { error = 'Unable to connect to bridge'; publish(); } };
      socket.onclose = () => {
        if (attempt !== generation) return;
        socket = null; connected = false; synced = false; publish();
        if (config.enabled && config.token) { const delay = retryDelay; retryDelay = Math.min(15000, retryDelay * 2); retryTimer = setTimeout(connect, delay); }
      };
    } catch (failure) { error = failure.message || 'Invalid bridge URL'; hooks.onError?.(failure); }
    publish();
  }
  function configure(changes) {
    const previous = { ...config };
    config = { ...config, ...changes, enabled: changes.enabled === undefined ? config.enabled : changes.enabled === true, allowRemote: changes.allowRemote === undefined ? config.allowRemote : changes.allowRemote === true };
    persist();
    if (previous.enabled !== config.enabled || previous.url !== config.url || previous.token !== config.token || previous.label !== config.label) connect();
    else { if (connected && previous.allowRemote !== config.allowRemote) send({ type: 'hello', clientId, label: config.label, allowRemote: config.allowRemote }); publish(); }
  }
  function disconnect() { flush(); config.enabled = false; persist(); disconnectSocket(); pendingFiles.clear(); pendingMeta = null; for (const timer of timers.values()) clearTimeout(timer); timers.clear(); publish(); }
  function notifyFileChanged(path, content) {
    if (!config.enabled || !config.token || suppressOutbound || typeof path !== 'string' || typeof content !== 'string') return;
    pendingFiles.set(path, { type: 'file:put', path, content }); clearTimeout(timers.get(path));
    timers.set(path, setTimeout(() => { timers.delete(path); const change = pendingFiles.get(path); if (synced && change && send(change)) pendingFiles.delete(path); }, 250));
  }
  function notifyFileDeleted(path) {
    if (!config.enabled || !config.token || suppressOutbound || typeof path !== 'string') return;
    clearTimeout(timers.get(path)); timers.delete(path); pendingFiles.set(path, { type: 'file:delete', path }); sendPending();
  }
  function notifyMetaChanged(folders, excluded) {
    if (!config.enabled || !config.token || suppressOutbound) return;
    pendingMeta = { type: 'meta:put', folders: [...folders], excluded: [...excluded] }; sendPending();
  }
  if (config.enabled && config.token) connect(); else publish();
  return { getState: state, configure, connect, disconnect, flush, notifyFileChanged, notifyFileDeleted, notifyMetaChanged };
}
