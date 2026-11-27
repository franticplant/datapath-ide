# Third-party notices

Datapath Studio's own code is MIT licensed (see [LICENSE](LICENSE)). This file lists everything in the repository or the published site that comes from someone else, where it lives, and under which license. Full license texts for the bundled JavaScript are in [web/vendor/LICENSES.txt](web/vendor/LICENSES.txt), which the bundling scripts regenerate from the installed packages.

## Shipped in the web app

| Component | Version | Where | License |
| --- | --- | --- | --- |
| Icarus Verilog (`ivlpp`, `ivl`, `vvp`) | `v13_0` | `engine/`, `web/engine/` | GPL-2.0-or-later |
| CodeMirror 6 and Lezer (`@codemirror/*`, `codemirror`, `@lezer/*`) with `crelt`, `style-mod`, `w3c-keyname`, `@marijn/find-cluster-break` | see `package-lock.json` | `web/vendor/editor.js` | MIT |
| ELKjs | 0.12.2 | `web/vendor/schematic/elk.js` | EPL-2.0 OR GPL-3.0-or-later |
| fflate | 0.8.3 | `web/vendor/zip.js` | MIT |

### Icarus Verilog

- Upstream: <https://github.com/steveicarus/iverilog>, tag `v13_0` (commit `dfeee909ed9f20b4870dd93423156c0170c0e1ff`). Copyright Stephen Williams and the Icarus Verilog contributors.
- License: GNU General Public License, version 2 or (at your option) any later version. The full text is [engine/COPYING.icarus](engine/COPYING.icarus); the web app also serves it as `web/engine/COPYING.icarus` and links it from the About dialog.
- Local changes, all under the same license:
  - [`engine/patches/icarus-browser.patch`](engine/patches/icarus-browser.patch): `t-dll.cc` (selects the JSON schematic target), `vpi_modules.cc` and `vvp/vpi_modules.cc` (static VPI modules), `synth2.cc` (non-fatal schematic synthesis), `vvp/lib_main.cc` (`vvp_live_load()`), `vvp/schedule.cc` and `vvp/schedule.h` (bounded scheduling for live sessions).
  - [`engine/tgt-json.cc`](engine/tgt-json.cc): Yosys-style JSON netlist target linked into `ivl.wasm`.
  - [`engine/vvp-live.cc`](engine/vvp-live.cc): memory capture and live-session API linked into `vvp.wasm`.
- Corresponding source: upstream `v13_0` plus the files above. [engine/README.md](engine/README.md) documents the reproducible build (`engine/Containerfile.builder`, `engine/build-browser.sh`, `engine/link-browser.sh`); a clean rebuild is byte-identical to `web/engine/`.

### CodeMirror 6, Lezer

- <https://codemirror.net/>, <https://lezer.codemirror.net/>. Copyright Marijn Haverbeke and others. MIT.
- Bundled with esbuild from `editor/index.js` into `web/vendor/editor.js` by `scripts/bundle-editor.mjs`; the Verilog and MIPS highlighting modes in `editor/index.js` are Datapath Studio code.

### ELKjs

- <https://github.com/kieler/elkjs>. Copyright Kiel University and others. Dual licensed EPL-2.0 OR GPL-3.0-or-later; Datapath Studio uses it under EPL-2.0.
- Bundled unmodified (`elkjs/lib/elk.bundled.js`) into `web/vendor/schematic/elk.js` by `scripts/bundle-schematic.mjs`. Loaded only when the Schematic tab elaborates a design.

### fflate

- <https://github.com/101arrowz/fflate>. Copyright Arjun Barrett. MIT.
- Bundled from `editor/zip.js` into `web/vendor/zip.js` for project ZIP import and export.

## Build and test tools (not shipped)

| Tool | Used for | License |
| --- | --- | --- |
| Emscripten (`emscripten/emsdk:4.0.5`) | Compiling Icarus Verilog to WebAssembly | MIT / University of Illinois/NCSA |
| Debian bookworm toolchain (autoconf, bison, flex, gperf, make, g++) | Engine build image | Various (GPL and permissive) |
| esbuild 0.28.2 | Bundling `web/vendor/*.js` | MIT |
| Playwright 1.65.1 and the `mcr.microsoft.com/playwright:v1.48.2-jammy` Chromium | Browser test suite | Apache-2.0 (Chromium: BSD-3-Clause and others) |
| Node.js 22 | Unit and smoke tests, bundling | MIT |

## Adding or updating a dependency

Every new shipped dependency needs a row here and its license text in `web/vendor/LICENSES.txt` (rerun `make bundle`). Prefer MIT/BSD/Apache-2.0 compatible code; anything else needs a note on how it is used. See [CONTRIBUTING.md](CONTRIBUTING.md).
