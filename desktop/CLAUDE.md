# mtkprof desktop — notes for agents

The Tauri 2 client of mtkprof. Read the repository's `CLAUDE.md` first; its rules apply here too.
Then `README.md` here (layout, sidecar, CI, releases) and `../docs/ARCHITECTURE.md` § "Engine mode".

## Where code goes

- Desktop-only code: `src/` (React/TS shell), `src-tauri/` (Rust: sidecar lifecycle, menus, open
  requests, secrets).
- Views, stores and shell behaviour shared with the CLI's UI: `../web/src/lib` (imported as `@lib`).
  Don't copy lib code into `src/`; extend the lib.
- Engine routes: `../internal/engine` and `../api/engine.openapi.yaml`, then `pnpm gen:api` here.
- `docs/PLAN-*.md` and `docs/VALIDATION-*.md` predate the 2026-11-02 merge: `engine/X` there is `X`
  at the repository root.

## Commands (run in `desktop/`)

- `pnpm install` works from here or the root (one workspace, one lockfile at the root).
- `pnpm typecheck` (desktop code and the lib together), `pnpm test`, `pnpm gen:api`.
- `pnpm build:engine` builds the sidecar from `../cmd/mtkprof` into `src-tauri/binaries/`.
- `scripts/ci-local.sh [--only checks,macos,linux,windows]` builds and smoke-tests the installers.
  Linux and Windows run in Docker with the whole repository mounted at `/src`.
- `cargo fmt --manifest-path src-tauri/Cargo.toml` before committing Rust; CI checks it.

## Rules

- App versions (`package.json`, `src-tauri/Cargo.toml`, `Cargo.lock`) equal the release tag; the
  root release script refuses otherwise.
- Verify UI changes with the `verify-mtkprof` skill (dev browser mode, screenshots).
