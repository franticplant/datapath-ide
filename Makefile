# Datapath Studio (datapath-ide) developer tasks.
# With mvm on PATH, Node/Playwright run in throwaway microVMs (offline); USE_MVM=0 uses local tools (CI).

SHELL      := /bin/sh
PORT       ?= 18473
NODE_IMAGE ?= docker.io/library/node:22-alpine
PY_IMAGE   ?= docker.io/library/python:3.13-alpine
PW_IMAGE   ?= mcr.microsoft.com/playwright:v1.48.2-jammy
USE_MVM    ?= $(shell command -v mvm >/dev/null 2>&1 && echo 1 || echo 0)

ifeq ($(USE_MVM),1)
NODE   := mvm run -i $(NODE_IMAGE) --
PW     := mvm run -i $(PW_IMAGE) -u $(shell id -u):$(shell id -g) --
BUNDLE := mvm build node -w build --
SERVE  := mvm run -i $(PY_IMAGE) -p $(PORT):$(PORT) -- python3 -m http.server $(PORT) --bind 0.0.0.0 --directory web
else
NODE   :=
PW     :=
BUNDLE :=
SERVE  := python3 -m http.server $(PORT) --bind 127.0.0.1 --directory web
endif

VENDOR_FILES := editor.js zip.js LICENSES.txt schematic/elk.js
REQUIRED_ASSETS := web/index.html web/favicon.svg web/style.css web/app.js \
  web/engine/ivlpp.js web/engine/ivlpp.wasm web/engine/ivl.js web/engine/ivl.wasm \
  web/engine/vvp.js web/engine/vvp.wasm web/engine/COPYING.icarus \
  $(addprefix web/vendor/,$(VENDOR_FILES))

.PHONY: help serve test test-unit test-smoke test-correctness test-browser test-ux check check-assets check-paths bundle check-bundle clean

help: ## Show this help
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z_-]+:.*## / {printf "  %-14s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

serve: ## Serve web/ on http://127.0.0.1:$(PORT)/
	@echo "Datapath Studio on http://127.0.0.1:$(PORT)/"
	$(SERVE)

test: check test-unit test-smoke test-correctness test-browser test-ux ## Run every check (what CI runs)

test-unit: ## Unit tests (assembler, decoder, FSM, themes, showcase, history, tour)
	$(NODE) sh -c 'node tests/unit/stage4.test.mjs && node tests/unit/stage5.test.mjs && node tests/unit/tour.test.mjs && node tests/unit/stage-b.test.mjs && node tests/unit/stage-c.test.mjs'

test-smoke: ## Icarus WASM smoke test against web/engine (WASM_DIR=build/wasm for a fresh build)
	$(NODE) node engine/smoke.mjs

test-correctness: ## Engine, netlist equivalence, Live DUT differential, MIPS oracle and VCD spec suites
	$(NODE) sh -c 'for f in tests/correctness/*.test.mjs; do node "$$f" || exit 1; done'

test-browser: ## Playwright end-to-end suite (sections 1-20)
	$(PW) node tests/browser/workspace.cjs

test-ux: ## Playwright responsive UX scenario audit
	$(PW) node tests/browser/ux-vibe-check.cjs

check: check-assets check-paths ## Static checks: shipped assets and Pages-safe paths

check-assets: ## Required engine and vendored assets exist
	@missing=0; for f in $(REQUIRED_ASSETS); do [ -s "$$f" ] || { echo "missing: $$f"; missing=1; }; done; \
	[ $$missing -eq 0 ] && echo "assets ok"

check-paths: ## No root-relative URLs in web/ (the site is served from /datapath-ide/)
	@if grep -nE '(src|href)="/[^/]|url\(/[^/]|(import|fetch)\(['"'"'"]/[^/]|new (Worker|URL)\(['"'"'"]/[^/]' \
	    web/index.html web/*.js web/*.css; then echo "root-relative asset paths found"; exit 1; else echo "paths ok"; fi

bundle: ## Rebuild web/vendor from package-lock.json (needs dependencies installed)
	$(BUNDLE) sh -c 'node scripts/bundle-editor.mjs && node scripts/bundle-schematic.mjs'
	@for f in $(VENDOR_FILES); do mkdir -p "web/vendor/$$(dirname $$f)"; cp "build/vendor/$$f" "web/vendor/$$f"; done
	@echo "web/vendor updated"

check-bundle: ## Rebuild into build/vendor and require byte-identical web/vendor
	$(BUNDLE) sh -c 'node scripts/bundle-editor.mjs && node scripts/bundle-schematic.mjs'
	@for f in $(VENDOR_FILES); do cmp "build/vendor/$$f" "web/vendor/$$f" || { echo "web/vendor/$$f differs from a fresh bundle"; exit 1; }; done
	@echo "bundle reproducible"

clean: ## Remove generated output (keeps build/ caches)
	rm -rf dist build/vendor build/preview
