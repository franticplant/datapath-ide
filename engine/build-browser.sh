#!/bin/sh
# Build patched upstream Icarus v13.0 from build/icarus-src (or $ICARUS_SRC), entirely offline.
set -eu
src=${ICARUS_SRC:-build/icarus-src}
mkdir -p build/emscripten-tmp
export TMPDIR=/src/build/emscripten-tmp
cd "$src"
emconfigure ./configure --host=wasm32-unknown-emscripten
emmake make dep version_tag.h
emmake make -j4 -C ivlpp
# The compiler and runtime are linked by link-browser.sh (the target and VPI
# modules are linked in statically), so only their objects are built here.
emmake make -j4 -f Makefile -f - ivl-objects <<'EOF'
ivl-objects: $(O)
EOF
emmake make -C tgt-vvp dep
emmake make -j4 -C tgt-vvp vvp.tgt
emmake make -C vpi dep
emmake make -j4 -C vpi system.vpi
emmake make -C vpi v2005_math.o sys_clog2.o CFLAGS='-g -O2 -Dvlog_startup_routines=icarus_v2005_math_startup'
emmake make -C vvp dep
# Build the runtime objects only; link-browser.sh links them with the
# statically registered VPI modules and engine/vvp-live.cc.
emmake make -j4 -C vvp -f Makefile -f - vvp-objects <<'EOF'
vvp-objects: main.o $(O)
EOF
cd /src
ICARUS_SRC=$src sh engine/link-browser.sh
out=${WASM_OUT:-/src/build/wasm}
printf '{"type":"module"}\n' > "$out/package.json"
if [ -z "${WASM_OUT:-}" ]; then node engine/smoke.mjs; fi
