# mtkprof desktop

The desktop client of [mtkprof](https://github.com/davidbudac/modern-tkprof), the Oracle SQL trace
analyzer: an Electron shell that runs the mtkprof engine as a sidecar process and shows the shared
mtkprof UI against it. (Until 2026-11-09 the shell was Tauri 2, `src-tauri/` in Rust.) Internal team tool; builds are unsigned.

It lives in `desktop/` of the mtkprof repository, next to the engine and the CLI (repository
root: `go.mod`, `cmd/mtkprof`, `internal/`, `api/`) and the shared UI library (`web/src/lib`).
Until 2026-11-02 it was the separate repository `davidbudac/mtkprof-desktop` (archived, with the
older history) that pinned the engine as a git submodule.

User guide (install, unsigned-build bypass, tabs, connections, assistant, settings, cache, files): [../docs/DESKTOP.md](../docs/DESKTOP.md).

```
src/            desktop UI (React/TS); imports the shared UI library as @lib
src/engine/     EngineProvider/useEngine, engine client, SSE events, api.d.ts (generated)
src/workspace/  session tabs, open screen, progress, restore, annotations (bookmarks, notes)
src/workspace/session/  one tab's views over a lib store: the lib's shell module (web/src/lib/shell: view table,
                        ViewTabs, panes, Esc, view keys, Inspector) plus the desktop's own Notes, Reports, history, Tools menu
src/settings/   settings (store + context), Settings and About pages
src/updates/    the update check on start and its toast (electron/updates.ts asks GitHub)
src/connections/ connections (store, import/export, team file), remote browser, DB panel, jobs dock
src/prompts/    PromptHost: the engine's prompt events as a queued modal
src/library/    saved Pivot configurations (library.json) and the Library page
src/files.ts    save/open user files (reports, exports, imports)
src/shell.ts    the page's side of the shell bridge (`window.mtkprof`: invoke, listen, a dropped file's path)
src/platform.ts the shell's stores, dialogs, drop, log, app info, with the dev browser fallbacks
src/pages.tsx   the desktop pages next to the tabs (Connections, Library, Settings, About)
electron/       main process (TypeScript, bundled by esbuild into dist-electron/): main.ts (window, mtkprof://
                protocol, commands, single instance, open-file), engine.ts (sidecar lifecycle), loginpath.ts,
                open.ts, secrets.ts + vault.ts (assistant keys), files.ts (scoped file access), store.ts,
                menu.ts, windowstate.ts, updates.ts, log.ts, paths.ts; preload.ts (the bridge)
electron-builder.yml  installers (DMG, NSIS, AppImage, deb); build/ holds the icons
scripts/      build-engine.mjs (sidecar), build-electron.mjs, dev-app.mjs, smoke.sh, build-mac.sh,
              build-mac-quick.sh, ci-local.sh, release-local.sh
ci/           Dockerfile and helpers of the Linux/Windows legs of the local CI
```

## Prerequisites

Node 22+ with pnpm (`corepack enable` or `npm i -g pnpm`), Go (the version in the repository's
`go.mod`), git. `pnpm install` downloads Electron. No Rust, no system webview packages.

## Build and run

```
git clone git@github.com:davidbudac/modern-tkprof.git
cd modern-tkprof && pnpm install   # one pnpm workspace: web/ and desktop/
cd desktop
pnpm build:engine      # go build of ../cmd/mtkprof -> binaries/<os>-<arch>/mtkprof-engine
pnpm app               # build the UI and the main process, run the app
pnpm dev:app           # the app against the Vite dev server (UI hot reload)
pnpm dist              # installers for this system under release/ (electron-builder)
```

`MTKPROF_PROFILE=<dir>` (unpackaged runs, or with `MTKPROF_SMOKE=1`) puts the run's data, cache and
logs under `<dir>`: your own tabs, settings and keys stay out of it, and it gets a single-instance
lock of its own, so it runs beside an installed mtkprof. `pnpm dev:app` and unpackaged runs add
*Reload* and *Toggle Developer Tools* to the macOS View menu.

The shell (`electron/main.ts`): the page runs with `contextIsolation`, `sandbox` and no Node; it
reaches the shell only through `window.mtkprof` (`electron/preload.ts`, typed in `src/shell.ts`):
`invoke(command, args)` (answers `{ok, value}` or `{ok: false, error}`; `src/shell.ts` rejects with
the message, as Tauri's invoke did), `onEvent` (`engine://ready|crashed|failed`, `app://open`,
`menu://close-tab`) and `pathForFile` (a dropped file's path, webUtils). Commands from any other
frame or window are refused. The UI is served from `mtkprof://app/` (a privileged standard
scheme over `dist/`, with the CSP the Tauri config had), the engine's only allowed CORS origin;
a new window or a navigation away goes to the system browser (http/https) or nowhere.

### Dev browser mode

Without a display or the webkit libraries the UI still runs in a browser against an engine
started by hand; the app then takes the engine from the URL instead of `engine_start`, keeps its
stores in `localStorage` and opens paths typed into the open screen (no file dialog, no drop;
paths one per line, a folder path in the Folder field, and *Open files…* takes the names from a
file input, `multiple`, resolved against the Folder field since a browser gives no paths):

```
pnpm build:engine
MTKPROF_TOKEN=<32+ chars> binaries/*/mtkprof-engine engine -listen 127.0.0.1:47011 \
  -cache /tmp/mtk-desk -allow-origin http://127.0.0.1:5173
pnpm dev
# open http://127.0.0.1:5173/?engine=127.0.0.1:47011&token=<the token>
```

Connections in this mode: the team file and imports are read through the Vite server, so they
must be under the project (`src/connections/__fixtures__/team.json` is a sample); dialogs are
`prompt()`s. `&mock=db` (or `&mock=db:<id>,<id>`) answers the db routes `test`, `diag`,
`sessions`, `tracefiles` and `trace` of those connections with canned rows, to look at the DB
panel without a database. `pnpm test` runs the unit tests (vitest: connections store, prompt
queue, jobs, registry).

`pnpm build:engine --target <os>-<arch>` builds the sidecar for another system (`mac-x64` on an
Apple Silicon Mac, `win-x64`, `linux-x64`); electron-builder takes `binaries/<os>-<arch>/` for the
installer of that system.
`pnpm typecheck` checks the desktop code together with the library it imports.

## The engine sidecar

The sidecar is the repository's `mtkprof` CLI (`cmd/mtkprof`), shipped as `mtkprof-engine` (so the `.deb`'s
`/usr/bin/mtkprof-engine` does not clash with a CLI install of `mtkprof`) and run as
`mtkprof-engine engine -allow-origin mtkprof://app -cache <app cache dir>/mtkprof` with a fresh bearer token
in `MTKPROF_TOKEN` (never on the command line), from `resources/bin/` of the installed app
(`binaries/<os>-<arch>/` in unpacked runs). The shell (`electron/engine.ts`):

- reads the ready line within 10 s and refuses an engine whose `protocol` is not 1
  (`protocol mismatch (engine N, app 1)`, shown with a Retry button);
- holds the engine's stdin, so the engine exits with the app, and stops it on exit;
- forwards the engine's output to the log (`electron/log.ts`: stdout and `<log dir>/mtkprof.log`);
- restarts it when it exits unexpectedly: `engine://crashed {code, signal, message}`, then a new
  start at once, after 1 s, after 5 s; a fourth crash within a minute gives up with
  `engine://failed {message}`. Every start emits `engine://ready {addr, token, version, protocol,
  restarts}`.

Commands: `engine_start(opts?)` (idempotent), `engine_stop`, `engine_restart(opts?)`,
`engine_status` (`{state: running|stopped|crashed|failed, pid, uptime, restarts, error}`),
`engine_kill` (debug builds or `MTKPROF_SMOKE=1` only: kills the engine as a crash would). `opts`
is `{cacheDir?, cacheCap?, planVizUrl?}`.

On the UI side `EngineProvider`/`useEngine()` (`src/engine/`) hold the state, the `/engine/*`
client and an `EngineEvents` emitter fed from `GET /engine/events` (read with streaming `fetch`,
reconnecting with backoff). The types come from the engine's OpenAPI file: `pnpm gen:api`
regenerates `src/engine/api.d.ts`; the local CI fails when it is stale.

The smoke step of the local CI (`scripts/smoke.sh <app executable> <name>`) launches the packaged
app (electron-builder's unpacked dir) with `MTKPROF_SMOKE=1 MTKPROF_SMOKE_KILL_AFTER=<s>
MTKPROF_SMOKE_OPEN=<repo>/testdata/traces/19c/io_waits.trc`, a profile of its own (`MTKPROF_PROFILE`)
and `MTKPROF_SMOKE_SHOTS=<dir>`: the app opens the fixture on start (log line `session ready: …`),
the shell kills its engine once, that many seconds after it is first ready, and the app captures
its own window 3 s after each `session ready` and logs the toasts showing then, so the capture
needs no Screen Recording permission and is right even under other windows. The step keeps
`<leg>-ready.png` (the fixture's Overview) and `<leg>-restarted.png` (toast "Engine restarted",
the fixture re-opened) and fails unless the log shows the kill, a second ready engine, the session
ready twice and the toast, and every engine pid is gone after the app quits. On Linux it runs
under Xvfb and `dbus-run-session`, with `--no-sandbox` as root.

Assistant keys (`electron/secrets.ts`, `vault.ts`): a remembered key is encrypted with Electron's
`safeStorage` (its key in Keychain Services, DPAPI or the Secret Service / kwallet) into
`<data dir>/secrets.json`, bound to the endpoint it was typed for. The main process reads the open
`apikey` prompt from the engine and answers it itself, so a stored key never enters the page.
Without a keychain (Linux without a Secret Service: safeStorage's `basic_text`) a remembered key
lasts until the app quits. Keys the Tauri app kept in the OS keychain are not read.

## Workspace, settings, stores

One tab per engine session (`POST /engine/sessions`; several files or a folder are one session,
the engine expands folders and follows continuation files, and `session.files` says what it
opened: the tab's tooltip, the file count in the active tab, `dirs` for the 📁 marks): the open screen
(`+`; dialog, drop, path,
bind options, recent list), the progress panel from `job` events (cancel = `DELETE
/engine/jobs/{id}`), then the session's document (`/s/{id}/api/doc` → `fromRaw` + `attachRemote`)
in a lib store (`createSession`) under a `SessionProvider`, with the standalone shell's layout
(`src/workspace/session/`: the lib's shell module, `web/src/lib/shell`, which the standalone shell uses too, plus the
desktop's own rows and keys). The store outlives tab switches,
live updates (a live tab follows the engine with the lib's `followLive` long poll, `workspace/liveFollow.ts`, which swaps the document, the selection stays; `session` events only carry failed/closed) and
engine restarts (a new address or token re-opens every tab from its paths, a cache hit, and
rebinds the client). `linesApi` is on and `lineRefTarget` is `view`, so "show in trace" opens the
Lines tab.

**Compare tabs…** creates a fixed whole-trace snapshot from two ready non-live sessions via
`GET /engine/compare?a=&b=`. It uses the shared comparison view, with statement links back to
the original tabs only while their content identities still match. Comparison tabs survive
engine restarts but are excluded from workspace restoration after app exit. Tabs can be
reordered with the adjacent buttons or Alt+Shift+Left/Right while the title has focus.

Settings → Backup defaults to the existing connections/library format (version 1). Optional
investigation metadata uses version 2: merged notes/bookmarks, theme/bind/start-empty defaults,
and workspace path references that require explicit opening. Pending annotation writes are
flushed before export and tab close; imports refresh the open stores without discarding
unrelated persisted entries. No trace payloads or credentials are included.

Extension points: `src/pages.tsx` (desktop pages: id, label, icon, render),
`src/workspace/session/views.tsx` (a tab's views, in nav order: the lib's `baseViews` and the desktop's Notes and Reports), `Workspace.adopt(resp, {title,
live, reopen})` for sessions opened elsewhere (remote follow), `workspace.go(route)`,
`PromptHost` (`src/prompts/`) for `prompt` events, `annotations.ts` for per-trace notes,
`src/library/` for the saved pivots (`libraryFor` gives a session its `PivotLibrary`),
`src/files.ts` for saving and reading user files (dialog + fs; browser download / file input
in the dev browser mode).

`electron/store.ts` keeps JSON files in the app data dir, the folders the Tauri app used, so they
carry over (`%APPDATA%\com.davidbudac.mtkprof`, `~/Library/Application Support/com.davidbudac.mtkprof`,
`~/.local/share/com.davidbudac.mtkprof`; the cache is `%LOCALAPPDATA%`, `~/Library/Caches`,
`~/.cache` under the same name, Chromium's own files in its `chromium/`). The page keeps a copy of
each store and sends every change; a file is written 300 ms after its last change and on quit.
`window-state.json` holds the window's bounds. The files:

| file | keys |
|---|---|
| `settings.json` | `cacheDir`, `cacheCapGB`, `binds`, `salt`, `startEmpty`, `planVizUrl`, `theme`, `updateCheck`, `skippedVersion` |
| `workspace.json` | `open` (`[{title, set: {paths, options}}]`, restored on start), `active`, `recent` (last 20 `{title, set, at}`) |
| `annotations.json` | `{"<identity>": {bookmarks: [{file, line, label, note?, updated?}], notes: [Annotation]}}` (lib `Annotation`: statement, execution, window notes) |
| `library.json` | `pivots`: `[{id, name, config: PivotConfig, created, updated}]` (lib `SavedPivot`) |

`cacheDir`, `cacheCapGB` (`-cache-cap NG`) and `planVizUrl` are passed to `engine_start(opts)`;
changing them asks for *Restart engine* (`engine_restart(opts)`). `app_info` answers the cache,
data and log dirs, the engine binary and, in smoke runs, `MTKPROF_SMOKE_OPEN`.

## The engine and the shared UI

The engine is the repository root (`cmd/mtkprof`, `internal/`, `api/engine.openapi.yaml`). The
shell talks to it over loopback HTTP with a per-run bearer token and refuses an engine whose
`protocol` it does not know; since both are built from the same commit, they always match.

The shared UI is `web/src/lib`, imported as `@lib` (alias in `vite.config.ts`, `vitest.config.ts`
and `tsconfig.json`). Its own imports resolve from `web/node_modules`: the root
`pnpm-workspace.yaml` has both packages, and its catalog gives the versions both use (React,
Vite, TypeScript, Vitest) once. A lib change and the desktop's use of it go in one commit;
`scripts/ci-local.sh` at the repository root runs the desktop checks too.

## Local CI and releases

There is no GitHub Actions workflow, by decision (it costs money). Everything CI did runs from
this checkout with `scripts/ci-local.sh`:

```
scripts/ci-local.sh                         # checks, macOS, Linux, Windows
scripts/ci-local.sh --only checks,linux     # a subset (checks, macos, linux, windows)
scripts/ci-local.sh --skip-smoke --keep-going
```

It runs the checks (`pnpm install --frozen-lockfile`, `gen:api` leaving
`src/engine/api.d.ts` unchanged, `typecheck`, `test`), then builds and collects every installer
in `out/` with `out/SHA256SUMS`, stops at the first failed step and ends with a table of leg,
result, time and artifacts. Smoke screenshots are in `out-smoke/`, per-leg logs and `results.tsv`
in `out-logs/` (all three are gitignored).

For quick local iteration on a Mac, `scripts/build-mac-quick.sh [--dmg] [--open] [--run]` builds only
the arm64 app (`release/mac-arm64/mtkprof.app`; no checks, tests or smoke).

| leg | where | installers | smoke |
|---|---|---|---|
| macOS arm64, x64 | the host (a Mac) | `mtkprof_<v>_arm64.dmg`, `mtkprof_<v>_x64.dmg` (ad-hoc signed) | arm64 yes; x64 only where Rosetta 2 is installed (Apple Silicon Macs without it skip it) |
| Linux x64 | Docker, `ci/Dockerfile` (linux/amd64) | `.deb`, `.AppImage` (`--no-appimage` skips the AppImage) | yes (Xvfb + D-Bus in the container) |
| Windows x64 | the same image, cross-built by electron-builder (wine runs rcedit) | `mtkprof_<v>_x64-setup.exe` | none: nothing here runs Windows binaries |

Host needs: Node 24 and pnpm (the `packageManager` pin), Go (version of the repository's `go.mod`),
and for Linux/Windows Docker or OrbStack (on Apple Silicon the amd64 image runs under Rosetta). The
image holds the Linux and Windows toolchains (Node, pnpm, Go pinned as in the repo; the Electron
runtime libraries, Xvfb, wine); `node_modules` and the go/pnpm/Electron caches live in Docker
volumes `mtkprof-ci-*` so they never mix with the Mac's (`docker volume rm` to reset).

Not yet run end to end since the switch to Electron (2026-11-09): the electron-builder legs, the
Docker image and the release script. Timings of the Tauri runs no longer apply.

Known limits: the smoke test runs the unpacked app, not the installers (the AppImage, `.deb`
and NSIS installer are built, never installed); the Windows installer is built but never run
(no Windows smoke); the macOS x64 build is not run on an Apple Silicon Mac without Rosetta.

Releasing: one version and one tag for the CLI and the app. Bump the app version
(`package.json`) to the release version, commit, tag
`vX.Y.Z` on that commit and push the tag. Then `scripts/release-local.sh vX.Y.Z` at the repository
root publishes the GitHub release with the CLI binaries (it checks the app versions first), and on
a Mac

```
scripts/release-local.sh vX.Y.Z --dry-run   # everything but the upload
scripts/release-local.sh vX.Y.Z
```

adds the installers to that release. It refuses unless the tree is clean, HEAD is the tag, the
versions match and the release exists without installers; it runs all legs of `ci-local.sh`,
uploads `out/*` (their checksums as `SHA256SUMS-desktop`) and appends the checksums to the
release notes. It never creates or pushes the tag. Releases v0.3.1 and earlier are on the archived
[mtkprof-desktop releases page](https://github.com/davidbudac/mtkprof-desktop/releases).

### Updates

`src/updates/` (user side in `../docs/DESKTOP.md` § Updates). On start (setting `updateCheck`) and
from Settings → About the main process asks `api.github.com/repos/davidbudac/modern-tkprof/releases/latest`
(`electron/updates.ts`); a newer, non-draft, non-prerelease tag is offered in a toast, and
*Download* opens its release page. The app does not install updates itself: the Tauri updater's
signed in-place install (minisign key, `latest.json`) has no replacement yet (DESIGN § Desktop
app). `?mock=update` in the dev browser mode still shows the old download and install states
(`installsItself`), for the day an in-place install comes back.

The builds are not signed:

- **Windows**: SmartScreen says "Windows protected your PC": *More info* → *Run anyway*.
- **macOS**: Gatekeeper says "Not Opened": *Done*, then System Settings → Privacy & Security →
  *Open Anyway*, or `xattr -dr com.apple.quarantine /Applications/mtkprof.app`.
- **Linux**: `chmod +x mtkprof_*.AppImage`, or install the `.deb` with `sudo apt install ./mtkprof_*.deb`.

## License

Apache-2.0
