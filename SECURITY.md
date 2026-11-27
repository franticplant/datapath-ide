# Security policy

## Reporting a vulnerability

Please report security issues privately through **GitHub Security Advisories**: open <https://github.com/franticplant/datapath-ide/security/advisories/new> ("Report a vulnerability"). Do not open a public issue for something exploitable.

Include what you found, how to reproduce it (a minimal project ZIP or Verilog snippet helps), the browser and version, and the impact you expect. You should get an acknowledgement within a week. Fixes are released as a new tagged version, and the advisory is published once a fixed build is live on GitHub Pages.

## Supported versions

Only the latest release and the live site at <https://franticplant.github.io/datapath-ide/> receive fixes.

## Security model

- **Client-side only.** The site is static files. Compilation, simulation, elaboration and layout run in the browser, in WebAssembly inside dedicated Web Workers (`web/simulator-worker.js`, `web/elaborate-worker.js`). There is no backend and no server-side code execution; your Verilog, assembly and memory files never leave the browser.
- **No third-party network calls.** The editor, ZIP library, layout engine and Icarus WebAssembly modules are vendored under `web/vendor/` and `web/engine/` and loaded from the same origin. The browser test suite asserts that the schematic loads lazily and requests nothing from other origins.
- **Untrusted designs.** Simulated code runs inside the WASM sandbox of a worker with its own in-memory file system. A runaway simulation can be stopped (the worker is terminated and restarted); output and VCD sizes are capped.
- **Imports.** ZIP and folder imports are validated in `web/archive.js` and `web/app.js` before anything is written: every path must be relative, with no leading `/`, no backslashes or control characters, and no `.`, `..` or empty segments (zip-slip protection). Archives are limited to 32 MB (compressed and total uncompressed) and 5,000 entries; encrypted, ZIP64 and multi-disk archives are rejected. Files only ever land in the in-browser workspace.
- **Storage.** Workspaces live in the browser's IndexedDB and localStorage for this origin only. Clearing site data deletes them; export a ZIP for backups.
- **Local development** serves `web/` on `127.0.0.1` by default (`make serve`).

## Out of scope

Issues that require a malicious browser extension, a compromised device, or social engineering; denial of service against your own tab (an infinite simulation loop is stoppable with **Stop**); and Icarus Verilog language-support gaps that are not memory-safety issues (report those upstream).
