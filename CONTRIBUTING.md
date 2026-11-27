# Contributing

Thanks for helping improve Datapath Studio. Small, focused pull requests are easiest to review.

## Workflow

- `main` keeps a **linear history**: rebase on `main` and let PRs be squash- or rebase-merged; no merge commits.
- Commit messages use **`type(scope): what changed`**, for example `fix(schematic): keep inspector open after drill-down` or `feat(asm): support .half`. Common types: `feat`, `fix`, `docs`, `test`, `refactor`, `perf`, `build`, `ci`, `chore`.
- Run **`make test`** before pushing (unit tests, the WASM smoke test and the Playwright browser suite). CI runs the same checks plus a secret scan.
- Add or update tests with behavior changes: unit tests in `tests/unit/`, end-to-end checks as a new section in `tests/browser/workspace.cjs`.

## Ground rules

- **No secrets** in commits, tests or fixtures. CI runs gitleaks on every push and PR.
- **No network at runtime.** The app must keep working offline from its own origin: vendor dependencies under `web/vendor/`, never load from a CDN, and keep asset paths relative (the site is served from `/datapath-ide/` on GitHub Pages, so no leading-slash URLs).
- **Localhost by default.** Dev servers and test servers bind to `127.0.0.1`.
- **Third-party notices.** A new shipped dependency needs a row in `THIRD_PARTY_NOTICES.md` and its license in `web/vendor/LICENSES.txt` (`make bundle` regenerates it). Bundled files in `web/vendor/` must match what `make bundle` produces from `package-lock.json`.
- **Engine changes** (anything in `web/engine/`) go through `engine/patches/icarus-browser.patch`, `engine/tgt-json.cc` or `engine/vvp-live.cc`, followed by the clean rebuild in [engine/README.md](engine/README.md). Commit the rebuilt `web/engine/` files only when a clean rebuild reproduces them byte for byte. Never hand-edit the generated `.js`/`.wasm` files.
- Styling uses the existing theme variables (`--bg`, `--primary`, `--s-*`), so all nine themes keep working; check light and dark themes and a phone-sized viewport for UI changes.

## Development setup

See the README's *Development* section. On machines with `mvm` installed the Makefile runs Node and Playwright inside throwaway KVM microVMs automatically; set `USE_MVM=0` to use a local Node 22 and Playwright instead (CI does this).

## Licensing

By contributing you agree that your contribution is licensed under the MIT License (see `LICENSE`), except for changes to the Icarus-derived engine (`engine/`, `web/engine/`), which are licensed under GPL-2.0-or-later like the code they modify.
