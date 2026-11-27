# datapath-ide — Datapath Studio

[![CI](https://github.com/franticplant/datapath-ide/actions/workflows/ci.yml/badge.svg)](https://github.com/franticplant/datapath-ide/actions/workflows/ci.yml)
[![Pages](https://github.com/franticplant/datapath-ide/actions/workflows/pages.yml/badge.svg)](https://github.com/franticplant/datapath-ide/actions/workflows/pages.yml)

**Datapath Studio** is a Verilog and MIPS32 hardware IDE that runs entirely in your browser. The Icarus Verilog 13 compiler and simulator are compiled to WebAssembly and run in Web Workers, so your designs never leave your machine and the app makes no network requests beyond loading its own files.

**Live demo: <https://franticplant.github.io/datapath-ide/>**

## Features

- **Icarus Verilog v13 in WebAssembly**: compile, run and stop simulations locally; diagnostics in Problems jump to the line; `$readmemh`, `` `include ``, defines, parameters, plusargs and source order are supported.
- **Waveforms**: VCD viewer with markers, cycle stepping, playback, value search, pins and per-signal radix. **Symbolic FSM waveforms** show state names (`FETCH`, `DECODE`, …) from `localparam`/`parameter` case selectors and SystemVerilog enums.
- **MIPS32 assembler**: `.asm` → `$readmemh`-ready `.mem` with address/source comments, MIPS-I instructions plus `li la move nop b beqz bnez blt bgt ble bge …`, line-accurate errors; Run assembles automatically. Ctrl+Click any 8-digit hex word to decode it.
- **Interactive RTL schematic**: elaboration with the same Icarus compiler (registers, muxes, operators, gates, memories, submodules) laid out by ELKjs, with **latch detection**, a **live VCD overlay** on wires, drill-down, click-to-inspect cards (live pin values, active mux input, operator equations), fan-in/fan-out and full dataflow-cone highlighting, find, minimap, pinch-zoom and SVG export.
- **Live cycle learning bar**: the instruction at the current PC and what the last clock edge changed (`$t2 ← 0x00000002`, `dmem[2] ← …`, `state: FETCH → DECODE`).
- **State tab**: register files and memories captured from every run, with recent-write heat, MIPS ABI names, inline disassembly and a PC marker.
- **FPGA board**: replay LEDs and 7-segment displays from a trace, or drive any module live (**Live DUT**) with switches, hex inputs and a clock button.
- **Tests**: run every testbench in the workspace as a suite with PASS/FAIL counts and one-click waveform/log inspection.
- **Featured Showcase & 6-chapter Interactive Tour**: walk from `Boot` (MIPS32 CPU) → `X-Ray` (live RTL schematic) → `Debug` (latch warning) → `Time` (symbolic FSM waveforms) → `Touch` (Live DUT FPGA board) → `Verify` (4-TB test suite) without blocking the IDE, or deep-link straight into any stage with `?tour=1` or `?showcase=…`.
- **5 built-in Showcase Projects**: single-cycle MIPS CPU, FPGA board lab, multi-cycle control FSM, 32-bit ALU with a test suite, and a latch bug hunter.
- **Editor**: CodeMirror 6 with split panes, Verilog/MIPS completion, a reference card, F12 go-to-definition and workspace search; **9 AMOLED/tonal themes** with semantic coloring (structural vs. behavioral vs. simulation-only Verilog, real vs. pseudo MIPS instructions).
- **Mobile and touch**: phone layout with a Verilog key row, bottom sheet, pinch-zoom, and **Back navigation** (Android back, ‹ button, Alt+←/→) through dialogs, jumps to code and schematic levels.
- **Your files stay yours**: workspaces are saved in browser storage; import/export project ZIPs.

## Quick start

Open the [live demo](https://franticplant.github.io/datapath-ide/) and press **Start Interactive Tour** (or jump straight in with [`?tour=1`](https://franticplant.github.io/datapath-ide/?tour=1)), or open **Showcase** for any of the 5 built-in labs.

To run it locally, serve the `web/` directory over HTTP (any static server works; there is no build step):

```sh
python3 -m http.server 18473 --bind 127.0.0.1 --directory web
# or: make serve   (inside an mvm microVM when mvm is installed)
```

Then open <http://127.0.0.1:18473/>.

## Using Datapath Studio

Create or import Verilog and memory files in **Files**, pick the top module in **Inspect**, then **Compile** or **Run** (Ctrl+Enter). A testbench that calls `$dumpfile`/`$dumpvars` fills the **Waveform** panel. Files can be excluded from the build from their action menu; advanced settings cover defines, include paths, warnings, parameter overrides, plusargs and source order.

- **Tests** runs every testbench (auto-detected by `tb_*`/`*_tb.v` names or `$finish`/`testbench` content, toggle per file) against the remaining RTL, each with its own top module.
- **State** shows captured register files and memories at the waveform cursor; recent writes glow and fade over four write steps.
- **Board** replays LEDs, 7-segment displays and probes, or in **Live DUT** mode runs any RTL module without a testbench.
- **Schematic** elaborates a module on first use (the worker and layout engine load lazily). Click a block to inspect it, double-click to open it, click a wire to follow its net, **Trace Cone** for the whole dataflow; on phones a tap only inspects and the card's **Jump to Code** / **Open Submodule** act on it.
- **Assemble** (Ctrl+Shift+A or Alt+Shift+A) writes `program.asm` to the name in a `# @out file.mem` line (default: same name with `.mem`), relative to the project root like `$readmemh`. Supported directives: `.text .data .word .org .globl`.
- **Back**: Android back / ‹ / Alt+← closes the open dialog or card first, then steps back through jumps to code, file switches, dock tabs, mobile views and schematic levels; at the start of a session the first Back only warns.

Limits: Icarus supports only part of SystemVerilog. Stop terminates and restarts the simulation worker without keeping a partial waveform. The VCD size limit is checked after the run. Other VPI modules and FST waveforms are not bundled. Browser storage can be cleared by the browser, so **Export ZIP** for backups.

## Development

Everything runs from the checked-in `web/` directory; `make help` lists the tasks.

| Task | Command |
| --- | --- |
| Serve locally | `make serve` |
| All checks (what CI runs) | `make test` |
| Unit tests (assembler, decoder, FSM, themes, showcase, history, tour) | `make test-unit` |
| Icarus WASM smoke test | `make test-smoke` |
| Playwright end-to-end suite | `make test-browser` |
| Rebuild `web/vendor` from `package-lock.json` | `make bundle` |
| Prove `web/vendor` is reproducible | `make check-bundle` |

When [`mvm`](https://github.com/franticplant/mvm) is on `PATH`, the Makefile runs Node, Playwright and Python in throwaway microVMs (offline, project mounted read-only); `USE_MVM=0` uses a local Node 22 / Python 3 instead, which is what CI does. Install dependencies with `mvm fetch` (or `npm ci --ignore-scripts`) before `make bundle`.

### Reproducible tooling

Local builds, bundling, and Playwright runs are sandboxed with [**mvm**](https://github.com/franticplant/mvm) — ephemeral KVM microVMs with offline builds, read-only project mounts, hidden secrets, and manifest-only fetches. CI actions are pinned to full commit SHAs, and vendored bundles must reproduce byte-for-byte from `package-lock.json`.

### Engine

`web/engine/` holds the Icarus Verilog `v13_0` modules (`ivlpp`, `ivl`, `vvp`) compiled with Emscripten, plus two additions: a Yosys-style JSON netlist target for the schematic (`engine/tgt-json.cc`) and memory capture / live sessions for the simulator (`engine/vvp-live.cc`). All upstream changes live in `engine/patches/icarus-browser.patch`. [engine/README.md](engine/README.md) documents the reproducible build (a clean rebuild is byte-identical to `web/engine/`) and its smoke test (`WASM_DIR=build/wasm node engine/smoke.mjs` before copying a fresh build).

### Project layout

```
web/            the static site (index.html, app.js, workers, vendor/, engine/)
editor/         CodeMirror entry points bundled into web/vendor/
engine/         Icarus patch, JSON target, vvp live extensions, build scripts, smoke test
scripts/        bundling scripts
tests/unit/     Node unit tests
tests/browser/  Playwright end-to-end suite
.github/        CI, Pages deployment, signed releases, Dependabot
```

## Releases

Pushing a `vX.Y.Z` tag runs the Release workflow: tests, a reproducible `datapath-ide-static-vX.Y.Z.tar.gz` of the site, `SHA256SUMS`, and a build provenance attestation. Verify a download with:

```sh
sha256sum -c SHA256SUMS
gh attestation verify datapath-ide-static-vX.Y.Z.tar.gz --repo franticplant/datapath-ide
```

## Security

Everything runs client-side with no backend; local builds and agent-assisted development are isolated in disposable KVM microVMs via [**mvm**](https://github.com/franticplant/mvm). See [SECURITY.md](SECURITY.md) for the security model and how to report a vulnerability privately.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md): linear history, `type(scope): what changed` commits, `make test` before pushing.

## License

Datapath Studio's own code (web UI, editor glue, MIPS assembler/decoder, schematic viewer, live board, tests and scripts) is [MIT](LICENSE).

The Icarus Verilog derived engine in `engine/` and `web/engine/` is **GPL-2.0-or-later** ([engine/COPYING.icarus](engine/COPYING.icarus)); its corresponding source is upstream `v13_0` plus the files in `engine/`. Vendored libraries (CodeMirror 6, Lezer, ELKjs, fflate) keep their own licenses, listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) with full texts in [web/vendor/LICENSES.txt](web/vendor/LICENSES.txt).

Created by [franticplant](https://github.com/franticplant).
