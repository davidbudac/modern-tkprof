---
name: verify-mtkprof
description: Launch and drive the mtkprof desktop app (Tauri shell, Vite/TS frontend in desktop/src/, Go engine at the repo root) in "dev browser mode" with headless Playwright, capture screenshots as proof, and clean up. Use whenever you must prove a UI change in desktop/src/ or web/src/lib works in the real app (opening Oracle 10046 traces, Lines/Statements/Waits views, Settings, Connections), or when asked to run, screenshot or verify mtkprof.
---

# Verify mtkprof

Surface: the frontend served by Vite **without Tauri**, talking over HTTP to the engine sidecar (`?engine=HOST:PORT&token=...` in the URL; see `src/platform.ts` `devEngine()`). The real Tauri window is NOT driven here (native dialogs, sidecar spawn and `tauri://` CORS are unverified by this skill). Scripts are in `scripts/` (run from any cwd; all use absolute paths internally).

Evidence root: **`/tmp/verify-mtkprof/evidence/<UTC-timestamp>/`** (set `VERIFY_MTKPROF_ROOT=/tmp/other-dir` for launch, drive and cleanup to run beside another instance, e.g. from a worktree while a session in the main checkout has one up; `drive.mjs --viewport 1000x700` sets the window size) (screenshots, `<name>.aria.txt`, `<name>.json`). Engine/vite logs of each run are copied to `/tmp/verify-mtkprof/evidence/logs-run-*/` by cleanup. Cleanup never deletes evidence. Run scratch (`run-*`, `state.env`) is `/tmp/verify-mtkprof/`.

## Launch

```sh
S=/Users/davidbudac/claude_projects/modern-tkprof/.claude/skills/verify-mtkprof/scripts
$S/launch.sh        # prints "ready: ..." and URL=...; exit 0 only when usable
```

What it does: picks two free ports, makes a 48-hex-char token (engine needs `MTKPROF_TOKEN` of 32+ chars), starts the prebuilt `src-tauri/binaries/mtkprof-engine-aarch64-apple-darwin engine -detach -listen 127.0.0.1:<p> -cache <fresh dir> -allow-origin http://127.0.0.1:<vite port>` and `node node_modules/vite/bin/vite.js --host 127.0.0.1 --port <p> --strictPort`, records PIDs in `/tmp/verify-mtkprof/state.env`, and waits until `/engine/health` answers and vite serves `/`. A fresh cache dir means an empty data dir; no seed data or migrations exist.

- **Engine stdin gotcha:** without `-detach` the engine prints `stopping (stdin closed)` and exits as soon as stdin closes (nohup/background launches). launch.sh passes `-detach` and `</dev/null`. If you launch by hand, either add `-detach` or hold stdin open: `... < <(sleep 7200) &`.
- **Vite PID gotcha:** `node_modules/.bin/vite` and `pnpm dev` are wrappers; the recorded PID would be the wrapper and the real server would outlive cleanup. Hence the direct `node .../vite.js`.
- **Ports:** `vite.config.ts` has `strictPort: true` on 5173 and a user dev server may already own 5173 (it did: leave it alone). launch.sh always uses its own ports, so runs do not collide. Only one verification instance at a time (launch refuses while `state.env` exists).
- The engine binary is gitignored (`src-tauri/binaries/*`). If missing: `pnpm build:engine` (needs Go). Needs `pnpm install` done (`node_modules`).
- UI readiness = the start page's **Open files…** button (`.open-screen .actions button.primary`) is enabled (it reads "Waiting for the engine…" otherwise). drive.mjs waits for that.
- `mock=db` in the URL enables the mock database-connection routes for the Connections page (`src/connections/mock.ts`); it does not affect traces.

## Doctor

```sh
$S/doctor.sh      # read-only; exit 0 = worth driving
```
Checks: both PIDs alive, each port listened on by exactly our PID, `/engine/health` shape, token accepted (`GET /engine/sessions` 200) and missing token rejected (401), CORS header for the vite origin, vite serves `/`, Playwright module present. Run it first whenever something looks off; on FAIL run `cleanup.sh` and relaunch.

## Drive

Headless Playwright, imported from `/Users/davidbudac/.claude/skills/deck-to-pptx/node_modules/playwright/index.mjs` (Chromium builds in `~/Library/Caches/ms-playwright`). Run node from outside the repo (e.g. `cd /tmp`). Each invocation uses a fresh browser context (no trace open, empty localStorage).

```sh
cd /tmp
T=/Users/davidbudac/claude_projects/modern-tkprof/testdata/traces/19c
node $S/drive.mjs --open $T/level_8.trc --view Trace --name lines          # open, switch view, screenshot
node $S/drive.mjs --page Settings --name settings                          # no trace needed
node $S/drive.mjs --open $T/level_8.trc,$T/level_4.trc --view Waits --name two
# extras: --click "<css>" (repeatable, after view/page), --prefs '{"wrap":true}' (seeds localStorage['mtk.lines.prefs']), --evidence <dir>
```
It prints a JSON summary (tab titles, offered views, active view, console errors) and each screenshot path; exit 1 with a `*-failure.png` if an assertion fails. For multi-step journeys, copy drive.mjs and extend it; the stable handles are:

| Thing | Handle |
| --- | --- |
| Start-page Folder input / Paths textarea / submit | `#open-dir`, `#open-path` (one ABSOLUTE path per line; relative fails "no such file"), `form button[type=submit]` |
| Session tabs / close / new-trace "+" | `.session-tab-main` (role=tab), `button[aria-label="Close <title>"]`, `button[aria-label="Open a trace"]` |
| Views | `.session-nav .tabs button.tab` in the one header row (`.frame-top`), right of the tabs (text: Overview, Trace (the Lines view, id `lines`), Statements, Waits, Timeline, Sessions, Pivot; Notes and Reports are under the `Tools` menu); active one has `aria-current=page`. Only while a trace tab is active |
| Trace popover | click the ACTIVE tab's button again (`.session-tab.on > .session-tab-main`, `aria-expanded`); the popover is `.trace-pop` |
| App pages | `.page-links button` (icons; `aria-label` `Connections`, `Settings`) |
| Tab state | `.tab-dot.busy` (opening), `.tab-dot.bad` (failed), `.tab-banner.bad[role=alert]` |
| Lines search | `input[aria-label="Search the trace text"]` |

Sample traces: `testdata/traces/19c/*.trc` (`level_1/4/8`, `basic_binds`, `bind_types`, `cursor_cache`, `errors`, `io_waits`, `lobs`, `midtrace_start`, ...). Several paths in one submit open as ONE tab titled `<first> (+N)`.

Feature recipes: [features/README.md](features/README.md).

## Evidence

- Capture the user action and resulting state: start page, paths filled, final view screenshot (drive.mjs does all three), plus `<name>.aria.txt` (ARIA tree) and `<name>.json` (tabs, views, `errors` = browser console errors; must be `[]`).
- Exercise the real path (type paths into the form, click view buttons); do not poke app state except the documented localStorage prefs seeding.
- Side-effect check for opens: `curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:$ENGINE_PORT/engine/sessions` (values from `/tmp/verify-mtkprof/state.env`) lists the session; engine index files land in `<run>/cache`.
- Look at the screenshot (Read it); a green exit code with a blank page is not proof.
- Report which feature IDs/entry points were driven; do not claim a path verified through a different one.

## Cleanup

```sh
$S/cleanup.sh     # run after EVERY attempt, failed or not
```
Kills only the PIDs in `state.env` (never by name; a user dev server on 5173 is untouched), removes the run dir and `state.env`, saves the run logs under `evidence/`. Evidence is kept. Afterwards `ls /tmp/verify-mtkprof/evidence` to confirm.

## Sandbox note

If curl/launch fails with connection or resolve errors on 127.0.0.1, the Bash sandbox may be the cause: retry with `dangerouslyDisableSandbox: true` before diagnosing the app.
