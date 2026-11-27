const CACHE = 'datapath-shell-v2';
const CORE = ["./", "./app.js", "./archive.js", "./board.js", "./console-buffer.js", "./elaborate-worker.js", "./engine/ivl.js", "./engine/ivl.wasm", "./engine/ivlpp.js", "./engine/ivlpp.wasm", "./engine/vvp.js", "./engine/vvp.wasm", "./engine-client.js", "./explorer.js", "./favicon.svg", "./fsm-states.js", "./groups.js", "./hierarchy.js", "./hw-state.js", "./index.html", "./inline-values.js", "./layout.js", "./manifest.webmanifest", "./mips-asm.js", "./mips-decode.js", "./mips-template.js", "./nav-history.js", "./rtl-linter.js", "./rtl-metrics.js", "./schematic.js", "./search.js", "./showcase-projects.js", "./sim-settings.js", "./sim-trace.js", "./simulator-worker.js", "./storage.js", "./style.css", "./test-runner.js", "./themes.js", "./tour.js", "./vcd.js", "./vendor/editor.js", "./vendor/schematic/elk.js", "./vendor/zip.js", "./verilog-format.js", "./verilog-lex.js", "./verilog-ref.js", "./wave-utils.js", "./waveform.js"];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(CORE))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('datapath-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  const networkFirst = local && !/\.(?:wasm|json)$/i.test(url.pathname) && !url.pathname.includes('/vendor/');
  event.respondWith(caches.open(CACHE).then(async cache => {
    const fetchUpdate = () => fetch(event.request).then(response => { if (response.ok) cache.put(event.request, response.clone()); return response; });
    if (networkFirst) { try { return await fetchUpdate(); } catch { return (await cache.match(event.request)) || Response.error(); } }
    const cached = await cache.match(event.request);
    if (cached) { fetchUpdate().catch(() => {}); return cached; }
    try { return await fetchUpdate(); } catch { return Response.error(); }
  }));
});
