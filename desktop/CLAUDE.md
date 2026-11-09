# mtkprof desktop — notes for agents

The Electron client of mtkprof (Tauri 2 until 2026-11-09). Read the repository's `CLAUDE.md` first;
its rules apply here too. Then `README.md` here (layout, shell bridge, sidecar, CI, releases) and
`../docs/ARCHITECTURE.md` § "Engine mode".

## Where code goes

- Desktop-only code: `src/` (React/TS UI shell), `electron/` (main process: sidecar lifecycle,
  menus, open requests, secrets, scoped file access, stores; `preload.ts` is the bridge).
- The page reaches the main process only through `src/shell.ts` (`invoke`, `listen`) and the
  wrappers in `src/platform.ts` / `src/files.ts`. A new shell capability is a command in
  `electron/main.ts` plus a wrapper there; never expose Node or `ipcRenderer` to the page.
- Views, stores and shell behaviour shared with the CLI's UI: `../web/src/lib` (imported as `@lib`).
  Don't copy lib code into `src/`; extend the lib.
- Engine routes: `../internal/engine` and `../api/engine.openapi.yaml`, then `pnpm gen:api` here.
- `docs/PLAN-*.md` and `docs/VALIDATION-*.md` predate the 2026-11-02 merge: `engine/X` there is `X`
  at the repository root; they also describe the Tauri shell (`src-tauri/`).

## Commands (run in `desktop/`)

- `pnpm install` works from here or the root (one workspace, one lockfile at the root).
- `pnpm typecheck` (desktop UI with the lib, then `electron/`), `pnpm test` (`src/` and `electron/`), `pnpm gen:api`.
- `pnpm build:engine [--target <os>-<arch>]` builds the sidecar from `../cmd/mtkprof` into `binaries/`.
- `pnpm app` builds and runs the app; `pnpm dev:app` runs it on the Vite dev server. Set
  `MTKPROF_PROFILE=<dir>` so a run does not use (or change) the user's own tabs, settings and keys.
- `scripts/ci-local.sh [--only checks,macos,linux,windows]` builds and smoke-tests the installers.
  Linux and Windows run in Docker with the whole repository mounted at `/src`.

## Rules

- The app version (`package.json`) equals the release tag; the root release script refuses otherwise.
- Verify UI changes with the `verify-mtkprof` skill (dev browser mode, screenshots). Shell changes
  (`electron/`): a smoke run, `scripts/smoke.sh` on a packaged app or by hand with `MTKPROF_SMOKE=1
  MTKPROF_PROFILE=… MTKPROF_SMOKE_SHOTS=… MTKPROF_SMOKE_OPEN=… pnpm app` (the app takes its own screenshots).
