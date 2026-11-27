# Icarus Verilog Browser WASM Engine

Clean upstream Emscripten build of **Icarus Verilog `v13_0`** (`dfeee909ed9f20b4870dd93423156c0170c0e1ff`), producing three isolated ES6 WebAssembly modules (`ivlpp`, `ivl`, `vvp`) executed inside a dedicated Web Worker (`web/simulator-worker.js`).

## Schematic target in `ivl` (`json.tgt`)

`engine/tgt-json.cc` is linked into `ivl.wasm` next to the vvp code generator. The patched `t-dll.cc` selects it when the config contains `flag:DLL=json.tgt`; every other DLL value still selects the vvp generator. The Schematic tab (`web/elaborate-worker.js`) compiles RTL with this config:

```
flag:DLL=json.tgt
flag:SCHEMATIC_NONFATAL=1
functor:synth
functor:synth2
functor:cprop
functor:nodangle
root:<top>
out:/work/schematic.json
```

The output is Yosys-style JSON (`modules` → `ports`, `cells`, `netnames`, with `src` attributes):

- **Bits:** every nexus gets integer bit ids. Buffers, part selects (including variable selects whose index folds to a constant), concatenations, sign extension and repeats are folded by uniting bits, and constant drivers become `"0"/"1"/"x"/"z"` bits.
- **Cells:** LPMs map to `$dff`/`$dffe`/`$adff`/`$sdff`, `$dlatch`, `$mux`/`$pmux`, arithmetic and comparison cells, shifts and reductions; gates map to `$and`/`$or`/`$xor`/`$not`/….
- **Memories:** array writers (kept processes) and readers (`IVL_LPM_ARRAY`) merge into one `$mem` cell per array, with `WR_*` and `RD_ADDRn`/`RD_DATAn` pins.
- **Other kept processes** become `$proc` blocks.
- **Hierarchy:** each module instance becomes a module, referenced from its parent by an instance cell. Repeated module types are keyed as `$paramod\<type>\<path>`.

`flag:SCHEMATIC_NONFATAL` (patched `synth2.cc`) leaves processes that cannot be synthesized, such as register-file writes, in the design with a warning instead of failing. It also skips `initial` blocks. Normal compilation never sets it. `syn-rules` is deliberately not run: after `synth2` it rewrites memory-writing processes into a single whole-array flip-flop.

## Browser extensions to `vvp`

`engine/vvp-live.cc` is linked into `vvp.wasm` and uses only the public VPI API plus three hooks added by the patch:

- `vvp/schedule.cc` splits `schedule_simulate()` into `schedule_sim_begin()`, `schedule_sim_run(bounded, limit, max_events)` and `schedule_sim_end()`. Batch runs call all three unchanged; a bounded run drains every event at times `<= limit`, then leaves the clock at `limit`, or stops after `max_events`. Weak references call `vvp_live_start_of_sim()` / `vvp_live_end_of_sim()` when `vvp-live.o` is linked.
- `vvp/lib_main.cc` adds `vvp_live_load()`, which compiles a design like `vvp_run()` but leaves scheduling to the caller.

**Memory capture (every batch run).** Up to 16 reg arrays (`vpiMemory`) of up to 4096 words are found by walking the hierarchy at start of simulation. Contents are snapshotted when time first advances past 0, so `$readmemh` and `initial` loops count as initial values. All words are kept for arrays of 64 words or fewer; larger arrays keep only non-zero words. Later word writes are recorded through a whole-array `cbValueChange` callback, with simulation-time stamps in precision units (the same units as the VCD). The JSON goes to `/work/.datapath_mem.json` with at most 50,000 deltas and about 4 MiB, and `truncated` is set when a cap is hit.

**Live sessions** (exported, called with `ccall`; state exchanged through `/work/.session_state.json`):

| Function | Effect |
| --- | --- |
| `vvp_session_open(path)` | Load the program, run initialization and start-of-sim callbacks, settle time 0, write state. Returns `0`, `1` if already finished, `-1` on error. |
| `vvp_session_set(path, bits)` | `vpi_put_value(vpiBinStrVal, vpiNoDelay)` on a signal by full name. |
| `vvp_session_step(ticks)` | Run up to `now + ticks` (`0` drains the current time step), at most 200,000 events per call. Returns `0`, `1` after `$finish`, `-1` on error or event cap. |
| `vvp_session_close()` | Run final blocks and end-of-simulation callbacks. |

The state file lists `time`, `timescale`, `finished`, every reg/net/integer in the top-level scopes as binary strings, and current array words. No `SharedArrayBuffer` or COOP/COEP headers are needed: each call runs to completion inside the worker. `$stop` behaves as `$finish` in sessions.

## License

The compiled WebAssembly binaries in `web/engine/{ivlpp,ivl,vvp}.{js,wasm}` are derivative works of [Icarus Verilog](https://github.com/steveicarus/iverilog) and are distributed under the **GNU General Public License, version 2 or later** (see `engine/COPYING.icarus`). The corresponding source is upstream Icarus Verilog `v13_0` plus `engine/patches/icarus-browser.patch`.

## Reproducible Build (via `mvm`)

1. **Build the offline toolchain image** (uses `mvm image build` with empty build context and allowlisted Debian HTTPS mirrors):
   ```sh
   mvm image build -t localhost/iverilog-builder:1 -f engine/Containerfile.builder
   ```
2. **Stage a clean upstream Icarus `v13_0` checkout into `build/icarus-src` and apply `engine/patches/icarus-browser.patch`**. Verify the upstream commit before staging. Then configure, compile, statically link and smoke-test offline:
   ```sh
   mvm run -i localhost/iverilog-builder:1 -w build -- sh engine/build-browser.sh
   ```
   `build-browser.sh` builds the `vvp` objects without the upstream link step and lets `link-browser.sh` link them with the static VPI modules and `vvp-live.o`. Set `ICARUS_SRC=…` and `WASM_OUT=…` to build from another tree. After editing only `vvp` sources or `engine/vvp-live.cc`, rebuild the changed objects with `make -C vvp` and rerun `sh engine/link-browser.sh`; this takes a few seconds.
3. **Smoke-test the fresh build, then copy the verified browser modules to `web/engine/`**:
   ```sh
   mvm run -i docker.io/library/node:22-alpine -- sh -c 'WASM_DIR=build/wasm node engine/smoke.mjs'
   ```
   ```sh
   cp build/wasm/{ivlpp,ivl,vvp}.{js,wasm} web/engine/
   ```

## Verification (100% Offline inside `mvm`)

- **Node WASM smoke test** (multi-file + `$readmemh` + VCD; register-file capture with `$readmemh` initial values and a timestamped clocked write; a live session that drives a counter from 0 to 3; `json.tgt` output for a hierarchy with a latch and a register file):
  ```sh
  mvm run -i docker.io/library/node:22-alpine -- node engine/smoke.mjs
  ```
- **Sandboxed Chromium E2E test suite** (mobile `390×844` + desktop `1440×900`, real simulation, multi-file `` `include `` + `$readmemh` + custom VCD, syntax-error `Problems` jump-to-line, live `Stop` on infinite loop + restart recovery):
  ```sh
  mvm run -i mcr.microsoft.com/playwright:v1.48.2-jammy -u 1000:1000 -- node tests/browser/workspace.cjs
  ```

## Known Scope / Limitations
- `system.vpi` and `v2005_math.vpi` are statically linked; FST/zlib and other VPI modules are not yet linked.
- Stopping a runaway simulation uses Web Worker termination (`cooperativeStop: false`), which immediately halts infinite loops and restarts the engine without preserving partial VCD.
- SystemVerilog (`-g2012`) support follows upstream Icarus Verilog 13.0 (partial).
