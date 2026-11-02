# mtkprof-desktop

The desktop app for [mtkprof](https://github.com/davidbudac/modern-tkprof), the Oracle SQL trace
analyzer: a Tauri 2 shell that runs the mtkprof engine as a sidecar process and shows the shared
mtkprof UI against it. Internal team tool; builds are unsigned.

User notes (install, unsigned-build bypass, tabs, cache, settings): [docs/DESKTOP.md](docs/DESKTOP.md).

```
src/            desktop UI (React/TS); imports the shared UI library as @lib
src/engine/     EngineProvider/useEngine, engine client, SSE events, api.d.ts (generated)
src/workspace/  session tabs, open screen, progress, restore, annotations (bookmarks, notes)
src/workspace/session/  one tab's views over a lib store: the lib's shell module (engine/web/src/lib/shell: view table,
                        ViewTabs, panes, Esc, view keys, Inspector) plus the desktop's own Notes, Reports, history, Tools menu
src/settings/   settings (store + context), Settings and About pages
src/connections/ connections (store, import/export, team file), remote browser, DB panel, jobs dock
src/prompts/    PromptHost: the engine's prompt events as a queued modal
src/library/    saved Pivot configurations (library.json) and the Library page
src/files.ts    save/open user files (reports, exports, imports)
src/platform.ts Tauri APIs with the dev browser fallbacks
src/pages.tsx   the desktop pages next to the tabs (Connections, Library, Settings, About)
src-tauri/      Rust shell: engine sidecar lifecycle (src/engine.rs), app_info (src/app.rs), plugins, bundling
engine/       git submodule -> modern-tkprof (engine sources + web/src/lib)
scripts/      build-engine.mjs (sidecar), check-lib-deps.mjs, smoke.sh, build-mac-quick.sh, ci-local.sh, release-local.sh
ci/           Dockerfile and helpers of the Linux/Windows legs of the local CI
```

## Prerequisites

All platforms: Rust (stable, via rustup), Node 22+ with pnpm (`corepack enable` or
`npm i -g pnpm`), Go (the version in `engine/go.mod`), git.

- **Windows**: Visual Studio Build Tools (C++ workload); WebView2 ships with Windows 10/11.
- **macOS**: Xcode command line tools (`xcode-select --install`).
- **Linux** (Debian/Ubuntu):
  ```
  sudo apt-get install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev libayatana-appindicator3-dev patchelf build-essential
  ```

## Build and run

```
git clone --recurse-submodules git@github.com:davidbudac/mtkprof-desktop.git
cd mtkprof-desktop
pnpm install
pnpm build:engine      # go build of engine/cmd/mtkprof -> src-tauri/binaries/mtkprof-engine-<target-triple>
pnpm tauri dev         # dev window with Vite hot reload
pnpm tauri build       # installers under src-tauri/target/release/bundle/
```

### Dev browser mode

Without a display or the webkit libraries the UI still runs in a browser against an engine
started by hand; the app then takes the engine from the URL instead of `engine_start`, keeps its
stores in `localStorage` and opens paths typed into the open screen (no file dialog, no drop;
paths one per line, a folder path in the Folder field, and *Open files…* takes the names from a
file input, `multiple`, resolved against the Folder field since a browser gives no paths):

```
pnpm build:engine
MTKPROF_TOKEN=<32+ chars> src-tauri/binaries/mtkprof-engine-* engine -listen 127.0.0.1:47011 \
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

`pnpm build:engine --target <triple>` builds the sidecar for another Rust target (e.g.
`x86_64-apple-darwin` on an Apple Silicon Mac); pass the same `--target` to `pnpm tauri build`.
`pnpm typecheck` checks the desktop code together with the library it imports.

## The engine sidecar

The sidecar is the `mtkprof` CLI of the submodule, shipped as `mtkprof-engine` (so the `.deb`'s
`/usr/bin/mtkprof-engine` does not clash with a CLI install of `mtkprof`) and run as
`mtkprof-engine engine -allow-origin … -cache <app cache dir>/mtkprof` with a fresh bearer token
in `MTKPROF_TOKEN` (never on the command line). The shell (`src-tauri/src/engine.rs`):

- reads the ready line within 10 s and refuses an engine whose `protocol` is not 1
  (`protocol mismatch (engine N, app 1)`, shown with a Retry button);
- holds the engine's stdin, so the engine exits with the app, and stops it on exit;
- forwards the engine's stderr to the log (`tauri-plugin-log`: stdout and the app log dir);
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

The smoke step of the local CI (`scripts/smoke.sh`) launches the release build with `MTKPROF_SMOKE=1
MTKPROF_SMOKE_KILL_AFTER=<s> MTKPROF_SMOKE_OPEN=engine/testdata/traces/19c/io_waits.trc`: the app
opens the fixture on start (log line `session ready: …`), the shell kills its engine once, that
many seconds after it is first ready, and the step screenshots the window before
(`<leg>-ready.png`: the fixture's Overview) and after (`<leg>-restarted.png`: toast "Engine
restarted", the engine dot's menu "restarts 1", the fixture re-opened), and fails unless the log shows the
restart, the session ready twice and the engine is gone after the app quits. On Linux the app needs a D-Bus session bus (single-instance),
so the script runs it under `dbus-run-session`.

## Workspace, settings, stores

One tab per engine session (`POST /engine/sessions`; several files or a folder are one session,
the engine expands folders and follows continuation files, and `session.files` says what it
opened: the tab's tooltip, the file count in the active tab, `dirs` for the 📁 marks): the open screen
(`+`; dialog, drop, path,
bind options, recent list), the progress panel from `job` events (cancel = `DELETE
/engine/jobs/{id}`), then the session's document (`/s/{id}/api/doc` → `fromRaw` + `attachRemote`)
in a lib store (`createSession`) under a `SessionProvider`, with the standalone shell's layout
(`src/workspace/session/`: the lib's shell module, `engine/web/src/lib/shell`, which the standalone shell uses too, plus the
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

The store plugin keeps JSON files in the app data dir (`%APPDATA%\com.davidbudac.mtkprof`,
`~/Library/Application Support/com.davidbudac.mtkprof`, `~/.local/share/com.davidbudac.mtkprof`):

| file | keys |
|---|---|
| `settings.json` | `cacheDir`, `cacheCapGB`, `binds`, `salt`, `startEmpty`, `planVizUrl`, `theme` |
| `workspace.json` | `open` (`[{title, set: {paths, options}}]`, restored on start), `active`, `recent` (last 20 `{title, set, at}`) |
| `annotations.json` | `{"<identity>": {bookmarks: [{file, line, label, note?, updated?}], notes: [Annotation]}}` (lib `Annotation`: statement, execution, window notes) |
| `library.json` | `pivots`: `[{id, name, config: PivotConfig, created, updated}]` (lib `SavedPivot`) |

`cacheDir`, `cacheCapGB` (`-cache-cap NG`) and `planVizUrl` are passed to `engine_start(opts)`;
changing them asks for *Restart engine* (`engine_restart(opts)`). `app_info` answers the cache,
data and log dirs, the engine binary and, in smoke runs, `MTKPROF_SMOKE_OPEN`.

## The engine submodule

`engine/` pins one commit of `modern-tkprof`. The shell talks to the engine over loopback HTTP
with a per-run bearer token and refuses an engine whose `protocol` it does not know, so engine,
protocol and shared UI move together with the pin.

```
git submodule update --init            # after clone or after pulling a new pin
cd engine && git fetch && git checkout <commit-or-tag> && cd ..
git add engine && git commit -m "engine: bump to <commit-or-tag>"
```

The shared UI lives in `engine/web/src/lib` and is imported as `@lib` (alias in
`vite.config.ts` and `tsconfig.json`). Its imports resolve from this package's `node_modules`,
so the runtime dependencies of `engine/web/package.json` are repeated in `package.json`;
`pnpm check:deps` (also run by the local CI) fails when they drift after a bump.

## Local CI and releases

There is no GitHub Actions workflow, by decision (it costs money). Everything CI did runs from
this checkout with `scripts/ci-local.sh`:

```
scripts/ci-local.sh                         # checks, macOS, Linux, Windows
scripts/ci-local.sh --only checks,linux     # a subset (checks, macos, linux, windows)
scripts/ci-local.sh --skip-smoke --keep-going
```

It runs the checks (`pnpm install --frozen-lockfile`, `check:deps`, `gen:api` leaving
`src/engine/api.d.ts` unchanged, `cargo fmt --check`, `typecheck`, `test`), then builds and
collects every installer in `out/` with `out/SHA256SUMS`, stops at the first failed step and ends
with a table of leg, result, time and artifacts. Smoke screenshots are in `out-smoke/`, per-leg
logs and `results.tsv` in `out-logs/` (all three are gitignored).

For quick local iteration on a Mac, `scripts/build-mac-quick.sh [--app] [--open] [--run]` builds only
the arm64 app (thin LTO, own cache in `src-tauri/target-quick/`; no checks, tests or smoke).

| leg | where | installers | smoke |
|---|---|---|---|
| macOS arm64, x64 | the host (a Mac) | `mtkprof_<v>_aarch64.dmg`, `mtkprof_<v>_x64.dmg` | arm64 yes; x64 only where Rosetta 2 is installed (Apple Silicon Macs without it skip it) |
| Linux x64 | Docker, `ci/Dockerfile` (linux/amd64) | `mtkprof_<v>_amd64.deb`, `mtkprof_<v>_amd64.AppImage` (`--no-appimage` skips the AppImage) | yes (Xvfb + D-Bus in the container) |
| Windows x64 | the same image, cross-built with `cargo-xwin` | `mtkprof_<v>_x64-setup.exe` | none: nothing here runs Windows binaries |

Host needs: Node 24 and pnpm (the `packageManager` pin), Go (version of `engine/go.mod`), Rust
with `aarch64-apple-darwin` and `x86_64-apple-darwin`, and for Linux/Windows Docker or OrbStack (on
Apple Silicon the amd64 image runs under Rosetta). The macOS smoke launches the app and takes
screenshots, so it needs a logged-in GUI session and Screen Recording permission for the app that
runs the shell. The image holds the Linux and Windows toolchains (Node, pnpm, Go and Rust pinned
as in the repo); `node_modules`, `src-tauri/target` and the cargo/go/pnpm/xwin caches live in
Docker volumes `mtkprof-ci-*` so they never mix with the Mac's (`docker volume rm` to reset).

A full run takes about 10 minutes on an M4 once the image and the volumes are warm (the first
run builds the 3.4 GB image, about 6 minutes, and compiles every crate once).

Known limits: the smoke test runs the release binary, not the installers (the AppImage, `.deb`
and NSIS installer are built, never installed); the Windows installer is built but never run
(no Windows smoke); the macOS x64 build is not run on an Apple Silicon Mac without Rosetta.
The Linux binary is built on Debian 12 (glibc 2.36), so the `.deb` and AppImage need a distro at
least that new.

Releasing: bump the version (`package.json`, `src-tauri/Cargo.toml` and `Cargo.lock`), commit, tag
`vX.Y.Z` on that commit and push the tag, then

```
scripts/release-local.sh vX.Y.Z --dry-run   # everything but `gh release create`
scripts/release-local.sh vX.Y.Z
```

It refuses unless the tree is clean, HEAD is the tag and the versions match, runs all legs of
`ci-local.sh` and publishes `out/*` as a GitHub prerelease with `gh release create --verify-tag`
(`--notes-file` for your own notes). It never creates or pushes the tag. There is no updater:
About shows the version and links to the
[releases page](https://github.com/davidbudac/mtkprof-desktop/releases).

The builds are not signed:

- **Windows**: SmartScreen says "Windows protected your PC": *More info* → *Run anyway*.
- **macOS**: Gatekeeper says "Not Opened": *Done*, then System Settings → Privacy & Security →
  *Open Anyway*, or `xattr -dr com.apple.quarantine /Applications/mtkprof.app`.
- **Linux**: `chmod +x mtkprof_*.AppImage`, or install the `.deb` with `sudo apt install ./mtkprof_*.deb`.

## License

Apache-2.0
