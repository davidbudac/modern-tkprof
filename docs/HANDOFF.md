# Handoff — state of mtkprof on 2026-10-25 (milestones 1–6, the v1 tail, the follow-up round, desktop app v1 implemented)

Read this, then `docs/DESIGN.md` (the decisions), then `docs/ARCHITECTURE.md`
(how the code is shaped) and `docs/trace-format-19c.md` (what the parser
must accept). `docs/ROADMAP.md` lists the longer tail. Desktop: the plan is
`docs/PLAN-DESKTOP.md`, the user guide `docs/DESKTOP.md`, the remote part
`docs/REMOTE.md`.

## Files panel (package F2, 2026-10-25)

For a trace set (several files or a directory) the standalone UI has a Files side panel: which source traces every view
shows. Design and code map: `docs/ARCHITECTURE.md` § "Files panel". In short: `State.files` (+ `#files=0,2`), the effective
context filter in `scopeOf`, `FilesPanel` / `FilesPane` / `FilesToggle` (lib exports; the desktop shell mounts them per tab
and keeps the selection in `workspace.json`, packages D2/D3, desktop pin `95c52a8`), scoped statement statistics through
`DataSource.statements` and `useScopedStatements` (engine `api/statements`, package F1, `analyze.StatementsOn`).

- Package F3 (2026-10-25) finished the scoping: the lists under a statement (executions, waits, plans, Context header), the
  lanes, the top-bar counts and the Trace facts follow the file / session / window scope; "no file selected" is the server
  parameter `contexts=-`; narrow layout and dark theme checked. Details: `docs/ARCHITECTURE.md` § "Files panel".
- Package W2 (2026-10-25): the Overview lanes, strips, chart and Timeline span the selection's own time range (the minimap
  shades it); saved Pivot configurations can store the file selection by file name ("with file selection").
- Still whole set, by design or for now: findings (the Findings heading says so) and the notes under the facts.
- Open (core, not UI): a statement's response time is `elapsed + idleUs`, and the builder counts an idle-class wait *inside* a
  call (`PL/SQL lock timer` of `dbms_session.sleep`) in both the call's `e` and `Call.IdleEla`, so a sleeping statement shows
  twice its real time ("4.001 s, 159 % of selection" for two `sleep(1)`). Fixing it means deciding where such waits belong
  (`WaitEla` vs `IdleEla`) and touches goldens, findings and the persisted aggregates; the UI only explains it in a tooltip.
- Verified by screenshot on a six-file set (two multisession files, a PX coordinator + slave, a two-part chain) in `/tmp/f2-shots`
  (not kept in the repo).

## Desktop app v1 (2026-10-25)

Phases 1–5 of `docs/PLAN-DESKTOP.md` are implemented in two repos:
`davidbudac/modern-tkprof` (this one: engine, cache, remote, shared UI
library, CLI) and the private `davidbudac/mtkprof-desktop` (Tauri 2 shell and
the desktop UI; pins this repo as the submodule `engine/`). Phase 6 (tag both,
publish the installers) is run with the local scripts (no GitHub Actions), see
"Open". Design of the
engine side: `docs/ARCHITECTURE.md` § "Engine mode" and § "Persistent index
cache".

### Status of the packages

Paths are in this repo unless marked **desk:** (`mtkprof-desktop`). All done,
`make test` green (desktop: `pnpm typecheck`, `pnpm test`).

| Pkg | What | Where |
|---|---|---|
| E1 | `mtkprof engine`: token, ready line, stdin EOF, sessions, jobs with cancel, SSE, prompts plumbing, per-session slice mux | `internal/engine/{server,session,job,events,prompts,errors}.go`, `cmd/mtkprof/engine.go` |
| E2 | persistent index cache: content identity, model/accumulator/spill/line-index persistence, manifest, LRU, `engine cache ls\|rm\|wipe` | `internal/engine/{cache,cache_manifest,cache_routes,identity}.go`, `cmd/mtkprof/engine_cache.go`, `internal/{model,analyze,slice}/*persist*.go`, `internal/binfmt` |
| E3 | progress events, minimap | `model.Options.OnProgress` (`internal/model/builder.go`), `internal/analyze/minimap.go`, `stats.minimap` |
| E4 | contract: OpenAPI file + route walk test | `api/engine.openapi.yaml`, `internal/engine/contract_test.go` |
| E5 | docs for engine mode | `docs/ARCHITECTURE.md`, `README.md`, `CLAUDE.md` |
| E6 | lines API: `lines` (+`annot`), `lines/at`, `at`, `search`; `trace.Classify` | `internal/slice/lines*.go`, `internal/trace/classify.go` |
| E7 | prompts, ssh (system ssh + askpass bridge, x/crypto fallback), engine connections, `askpass` | `internal/remote/{prompt.go,sshcli,sshlib,sshconn,sshtest}`, `internal/engine/connections.go`, `cmd/mtkprof/askpass.go` |
| E7b | live follow sessions: snapshotting streaming build, `rev` per snapshot, long-poll `api/doc` | `internal/engine/live.go`, `internal/model/live.go`, `internal/slice/spill_live.go` |
| E8 | Oracle: go-ora, tracefiles, sessions, ADR fetch (record semantics, resume), trace on/off, ref fetch; lite fallback | `internal/remote/db`, `internal/engine/connections_db.go` |
| E9 | CLI `fetch`, `follow`, `trace`, `ref -db`, `askpass` | `cmd/mtkprof/{fetch,trace,refdb,askpass}.go` |
| E10 | `api/report` text/JSON/CSV/HTML | `internal/engine/report.go` |
| I1 | engine opens sessions through the cache; cache routes | `internal/engine` |
| I2 | lines API and report mounted in engine and `serve`; `api/plan` | `internal/engine`, `internal/slice` |
| F1 | `GET /s/{id}/api/statements?contexts=&from=&to=` (also `serve -slice/-spill`): `doc.stats.statements` recomputed over a scope by `analyze.StatementsOn` (calls of the spill or the model), so a file / session subset of a trace set gets its own Statements table; the UI side (file picker) is not done | `internal/analyze/stmts_on.go`, `internal/slice/slice.go`, `api/engine.openapi.yaml` |
| I3 | db connections in the engine; `POST /s/{id}/api/ref` with a kept bundle; one terminal prompter | `internal/engine/{connections_db,ref}.go` |
| U1 | UI split: `web/src/lib` (shared) and `web/src/app` (standalone shell), `ApiClient`, `SessionProvider`, minimap strip | `web/src/lib`, `web/src/app` |
| S1 | Tauri scaffold, submodule, CI matrix, installers | **desk:** `src-tauri/`, `.github/workflows/build.yml`, `scripts/` |
| S2 | engine lifecycle: spawn, ready line, protocol check, crash restart (0 s, 1 s, 5 s), toast | **desk:** `src-tauri/src/engine.rs`, `src/engine/` |
| S3 | workspace: tabs, open/drop/path, recent, progress and cancel, restore, live badge | **desk:** `src/workspace/` |
| S4 | settings and About, cache list/remove/wipe | **desk:** `src/settings/` |
| S5 | Lines view | lib: `web/src/lib/views/Lines*.tsx`, `data/{lines,linecache}.ts`; **desk:** wiring (`linesApi`, `lineRefTarget: 'view'`, bookmarks) |
| S6 | connections UI: definitions, prompts modal, remote browser, DB panel, jobs, import/export, team file | **desk:** `src/connections/`, `src/prompts/`, `src-tauri/src/connections.rs` |
| S7 | Reports view | **desk:** `src/workspace/session/ReportsView.tsx` |
| S8 | notes and bookmarks per content identity; Markdown/JSON export, JSON import | lib: `web/src/lib/data/annotations.ts`, `NoteEditor`/`NoteBox`; **desk:** `src/workspace/annotations.ts`, `session/AnnotationsView.tsx` |
| S9 | saved Pivot configurations, Library page | lib: `web/src/lib/data/pivotconfig.ts`, `Store.getPivotConfig/applyPivotConfig`; **desk:** `src/library/` |
| D1 | user guide, REMOTE.md, this section | `docs/DESKTOP.md`, `docs/REMOTE.md` |

Lib API added for the desktop (exports on `@lib`): S5 `Lines`, `probeLinesApi`,
`fetchLinesAnnot`, `lineAt`, `objectsAt`, `search`, `parseJump`, `PageCache`;
store actions `openLinesAt`, `setLinesLine`, `addBookmark`, `removeBookmark`,
`setBookmarks`; state `linesApi`, `lineRefTarget`, `linesView`, `bookmarks`.
S8/S9: `State.annotations` + `annotationsEnabled`, actions `setAnnotations`/
`addAnnotation`/`updateAnnotation`/`removeAnnotation`/`setBookmarkNote`,
`State.pivot` + `setPivot`, `getPivotConfig()`/`applyPivotConfig(cfg)`,
`libraryEnabled`, `Session.library` (`PivotLibrary`), `useLibrary`. The
standalone app looks and works as before.

### The two-repo workflow

- `mtkprof-desktop/engine/` is a git submodule of this repo, pinned to a
  commit (now `3066d7c`, `main`). Bump: `cd engine && git fetch && git
  checkout <commit> && cd .. && git add engine && git commit`. The shell
  refuses an engine whose `protocol` is not 1 (`engine.Protocol`), so engine,
  protocol and shared UI move with the pin.
- `main` of this repo is pushed (`origin/main` = `3066d7c`). The remote
  branch `wip-desktop-phase1` (a phase-1 pin point) is no longer needed now that
  `main` is pushed; delete it when convenient.
- API types: `pnpm gen:api` regenerates `src/engine/api.d.ts` from
  `engine/api/engine.openapi.yaml`; CI fails when it is stale. A breaking
  protocol change here bumps `engine.Protocol` and the app's `APP_PROTOCOL`.
- Shared UI dependencies: the desktop package repeats the runtime
  dependencies of `web/package.json`; `pnpm check:deps` (also in the desktop CI) fails on
  drift after a bump.
- Former desktop CI (`.github/workflows/build.yml`, desk; replaced by the
  desktop repo's local scripts, see "Open"): matrix windows-x64 (NSIS),
  macos-arm64 and macos-x64 (DMG), linux-x64 (AppImage, deb). Steps: submodule
  over ssh with the read-only deploy key on `modern-tkprof` (secret
  `ENGINE_DEPLOY_KEY`), `pnpm check:deps`, `gen:api` diff, `cargo fmt`,
  `pnpm typecheck`, `pnpm test`, `build:engine --target`, `tauri build`,
  smoke. A `v*` tag publishes the installers as a prerelease.
- Smoke step (`scripts/smoke.sh`): launches the release build with
  `MTKPROF_SMOKE=1`, `MTKPROF_SMOKE_OPEN=<fixture>` and
  `MTKPROF_SMOKE_KILL_AFTER=<s>`; screenshots the Overview, lets the shell
  kill the engine once, screenshots the restart ("Engine restarted",
  fixture re-opened) and fails unless the log shows the restart, the session
  ready twice and the engine gone after quit. Linux runs under
  `dbus-run-session` (single-instance needs a session bus).
- Local Linux builds need the webkit2gtk dev packages (`sudo apt install
  libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev
  libayatana-appindicator3-dev patchelf`); without a display the UI runs in a
  browser against a hand-started engine ("Dev browser mode" in the desktop
  README).

### Budgets: target and measured

| | target | measured |
|---|---|---|
| reopen a cached trace | 2 GB < 2 s to `ready` | `big_loop.trc` (118 MB): 32 ms + 5 ms document; **2 GB not measured** (needs a 2 GB fixture) |
| fresh open | parse at today's speed | `big_loop.trc`: ≈ 0.8 s including persist |
| engine RSS idle | < 300 MB with 2 GB open | 27 MB after a hit on `big_loop.trc` |
| cache entry size | | ≈ the trace size |
| pivot on 1 GB / 2 GB | ≤ 300 ms / ≤ 600 ms | spill numbers: 290 ms at 1 GB; not re-measured through the engine |
| `api/lines` page (2000 lines) | < 20 ms | fetch ~2 ms + 1 ms parse on `big_loop.trc` (2.88 M lines), scrolling 60 fps in headless Chrome |
| literal search | 2 GB < 5 s, first hit < 100 ms | whole `big_loop.trc` 92 ms |
| `api/report` on `big_loop.trc` (session open) | | text/json/html 5-8 ms (`html` 1.3 MB), csv 1.9 s (16 MB zip); `MTKPROF_BIG=... go test ./internal/engine -run ReportBig -v` |
| follow latency | < 2 s | live snapshot at 100 MB: 55-85 ms; write → snapshot 0.2-1.0 s in-process (`TestLiveFollowRemote`); dbmint: 149 ms (cli) / 501 ms (lib) |
| SSH fetch | line speed, resume | dbmint: 117.7 MB in 0.97 s (gzip, VM loopback), sha256 equal; resume correct |
| ADR (db) fetch | | 0.39 MB/s (301 s for 117.7 MB) to ~1 MB/s when the lab is quiet; flat in the offset |
| minimap / Timeline pan, zoom | 60 fps on WebView2 | **not measured** on WebView2, WKWebView or WebKitGTK |
| Lines page size / LRU in WebView2 on a 2 GB trace | | **not measured** |

### Verified on dbmint (details and numbers in `docs/REMOTE.md`)

- ssh: gated tests (sha256 equal over cli+gzip, cli, lib, scp; resume;
  diag; follow latency), `mtkprof fetch` of the 117.7 MB trace, engine
  connection → `test` → `diag` → `fetch` → `follow` live session, no stray
  `tail` after closing.
- Oracle 19.27, `mtk` in PDB1: views, PDB visibility, record semantics of
  `V$DIAG_TRACE_FILE_CONTENTS` (the first run found the fetch assumed lines =
  rows; fixed in `9fe0294`), byte-equal fetch and resume (fixture and the big
  trace), `DBMS_MONITOR` on/off, `ref -db -lite` and the per-query fallback of
  the full mode.

### Open

Needs a person or a machine:

- **Windows 11**: `ssh.exe` and `SSH_ASKPASS`, the OpenSSH agent pipe. The plan's
  rule "UI verified by screenshot on Windows first" has no record here: no
  Windows screenshot is documented. macOS is done (see below).
- **No GitHub Actions** (owner's decision, cost; `docs/DESIGN.md` § Project).
  CI and releases are local: `scripts/ci-local.sh` and
  `scripts/release-local.sh <tag>` here, `mtkprof-desktop/scripts/ci-local.sh`
  and `scripts/release-local.sh` there. **desk:** v0.3.1 released that way on
  2026-10-25 (prerelease, engine still `53042d0` = v0.3.0, no engine tag
  needed): all five installers built on the MacBook (DMGs native; deb,
  AppImage and the Windows NSIS cross-build in the `mtkprof-ci:local` amd64
  OrbStack image, NSIS 3.11 built in because bookworm's 3.08 lacks
  `RestartManager.nsh`); smokes passed on macOS arm64 and Linux, skipped on
  macOS x64 (no Rosetta 2) and Windows (no machine). The installers
  themselves were not installed or launched; a Windows run
  (`scripts/smoke.sh x86_64-pc-windows-msvc windows-x64` from Git Bash) is
  still open. Actions is not disabled in the repo settings (the CLI call was
  refused in the agent session); with no workflow files nothing runs.
- Local Linux Tauri build needs `sudo apt install` of the webkit2gtk dev libs;
  without them the Linux leg runs in Docker (`docs/PLAN-DESKTOP.md` § "Status
  and how to continue"): the Rust build and the `.deb` (10.8 MB, ships
  `/usr/bin/mtkprof-desktop` + `/usr/bin/mtkprof-engine`) were produced that
  way for `834d7e4`, and `scripts/smoke.sh` passed under `xvfb-run` +
  `dbus-run-session` in that container (open, kill, restart, re-open from
  the cache); the AppImage fails in Docker (`failed to run
  linuxdeploy`: the linuxdeploy plugin's static-pie runtime does not execute
  in the container at all, with or without `/dev/fuse` and
  `APPIMAGE_EXTRACT_AND_RUN=1`) and is only produced by GitHub's runner.
  macOS legs: done by hand on the MacBook (Apple M4, macOS 27) on 2026-10-25
  with `mtkprof-desktop/docs/HANDOFF-macos-build.md` for v0.3.0 (`834d7e4`,
  engine `53042d0`): checks green (35 tests, `api.d.ts` unchanged), both
  DMGs built (`mtkprof_0.3.0_aarch64.dmg` 9.9 MiB, `_x64.dmg` 10.4 MiB),
  `scripts/smoke.sh` passed on arm64 (open 40 ms, kill, restart < 1 s,
  re-open from the cache 12 ms; restarted screenshot shows the toast and
  "restarts 1"). Notes: Node 26 / pnpm 12.9.1 there (the recipe says 22/10,
  CI uses 24); `screencapture` needs Screen Recording permission for the
  host app; `--bundles dmg` deletes the `.app`, so the recipe's `xattr` path
  does not exist (not needed: the smoke runs `release/` directly). Follow-up
  the same day, **desk:** `a38c276` on main (after v0.3.0, untagged):
  the v0.3.0 DMG app is "damaged" for Gatekeeper on Apple Silicon (only the
  linker's ad-hoc signature, bundle unsigned; no Open Anyway), fixed with
  `bundle.macOS.signingIdentity: "-"` (now "Not Opened" + Open Anyway in
  Privacy & Security, both seen on screen, Open Anyway not clicked); the
  status bar showed "0 sessions" with a trace open until the next 5 s health
  poll, now re-polled on session events (smoke screenshot shows "1
  sessions"); the bundled sidecar starts from the DMG copy; user docs say
  Open Anyway instead of right-click → Open (gone since macOS 15). Still
  open: x64 smoke (no Rosetta on the MacBook), the drag-to-Applications
  hand install.
- Stray 32 MB binary in history (`mtkprof` at the repo root, removed in
  `a89bc12`); a history rewrite is the user's call, relevant before the repo is
  published.
- ~~`-tags nooracle`~~ decided 2026-10-25: `make release` builds both, the
  full binaries and `mtkprof-lite-<os>-<arch>` (`-tags nooracle`, ~12 MB)
  for linux/aix/solaris, the database hosts. The desktop sidecar is always
  the full build.
- REMOTE.md "Open": TCPS (dbmint has no TCPS listener: setting one up
  needs a wallet and a listener restart), AIX/Solaris scripts. Verified
  2026-10-25 (REMOTE.md "Second round"): full `ref -db` equals the refscript
  bundle, `DBMS_SESSION` needs `ALTER SESSION`, `-since` time zones, tracing
  a PDB session from `CDB$ROOT` (`CONTAINER_DATA=ALL`), the engine's db
  routes end to end.
- 2 GB trace through the engine: measured (REMOTE.md table): 13 s open,
  146 MB peak RSS, 0.25 s reopen. Not measured: WebView2 frame rates.

Deferred by the agents (small, none blocks v1):

- Tab reorder (Tauri's drop handler disables HTML5 drag on Windows).
- A dev-server reload leaves engine sessions behind (dev mode only).
- No React error boundary around a tab's views.
- Done in package D1 (desktop): export everything together (connections +
  library, Settings → Backup), tab error boundary, dev-reload session
  cleanup. Done in W1: Pivot statement/event-only pickers, clock-time
  windows in saved configurations, clock time in "Jump to time",
  search-match highlighting and per-line copy/permalink in Lines.
- Live sessions: done in package G2 (cursor index of
  the live spill, `TRACE CONTINUES IN` chains, `mtkprof follow -serve`; see
  ARCHITECTURE "Live sessions"). Still open there: the UI does not long-poll
  `api/doc?rev=` (reload shows new data); the remote chain test runs on the
  lib transport only (the cli `tail` cleanup is the same stream close that
  `TestOpenSSHFollowAndThroughput` checks); a chain is followed forward only
  (following a file that has `CONTINUED FROM` does not pull in the earlier
  file).
- Done in package G1: adaptive db fetch ranges (50 000
  to 400 000 numbers; on dbmint a 50 000 query takes ~5 s so it never grows
  there, REMOTE.md "Second round"),
  `mtkprof engine -idle D` (opt-in session eviction), an in-memory cache
  listing.
- Known limits: sessions are evicted only with `-idle D` (default: closing is
  the client's job). A session's model is the aggregate one, so its text report has no executions
  tables and its JSON/HTML documents no fact tables.

### Run the engine by hand

PATH as in "Build, test, run".

```
export MTKPROF_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')   # 48 hex chars; 32+ bytes required
./bin/mtkprof engine -cache /tmp/mtk-cache -detach > /tmp/engine.out &         # without -detach it exits when stdin closes
cat /tmp/engine.out                                                            # {"ready":true,"addr":"127.0.0.1:PORT","version":"…","protocol":1}
H="Authorization: Bearer $MTKPROF_TOKEN"; A=127.0.0.1:PORT
curl -s -XPOST -H "$H" -d '{"paths":["/abs/path/trace.trc"]}' http://$A/engine/sessions   # 202 {session, job}
curl -sN -H "$H" http://$A/engine/events                  # SSE: job (phase, done/total), session, prompt, log
curl -s  -H "$H" http://$A/engine/sessions                # state opening → ready; hit=true when it came from the cache
curl -s  -H "$H" http://$A/s/SESSION_ID/api/doc | head -c 300      # the document (format 3, slice: true)
curl -s  -H "$H" "http://$A/s/SESSION_ID/api/pivot?fact=waits&by=event,stmt"
curl -s  -H "$H" http://$A/engine/cache                   # entries, bytes, cap
curl -s  -XDELETE -H "$H" http://$A/engine/sessions/SESSION_ID    # closes; the cache entry stays
curl -s  -XDELETE -H "$H" http://$A/engine/jobs/JOB_ID            # cancel a running open
./bin/mtkprof engine cache ls -cache /tmp/mtk-cache               # also rm <identity-prefix>, wipe
```

Stop it with SIGTERM to the pid found by port (`ss -ltnp | grep :PORT`).
The per-session endpoints and parameters are those of `serve -spill`; the
schema is `api/engine.openapi.yaml`. Live sessions: `options.follow`, state
`live`, `rev` per snapshot, `api/doc?rev=` long poll (ARCHITECTURE § Engine
mode, "Live sessions").

## Where things stand

Repository `davidbudac/modern-tkprof` (private), branch `main`, pushed and
clean. Everything described here is in it.

Working and tested:

| Area | Location | Status |
|---|---|---|
| Streaming 10046 parser (every 19c line kind) | `internal/trace` | done; unit tests; 0 unknown lines on all fixtures |
| Dimensional model (statements, cursor instances, call hierarchy with self time, wait attribution, binds, plans, contexts, wall clock) | `internal/model` | done; unit tests |
| Aggregations (profiles, statement stats, executions, group-bys, timeline) | `internal/analyze` | done |
| Golden comparison against Oracle's tkprof | `internal/golden` | passes on all 19 fixtures |
| Text report, JSON document (format 2, packed columns), CSV export | `internal/report` | done |
| CLI: `report`, `pivot`, `html`, `serve`, `json`, `export`, `lint`, `plan`, `refscript`, `compare`, `findings-config`, `engine` (+ `engine cache`) | `cmd/mtkprof` | done |
| Findings (9 rules, fixed thresholds) in JSON, text report and Overview | `internal/analyze/findings.go`, `internal/report/text_findings.go`, `web/src/lib/views/Findings.tsx` | done; unit tests on fixtures + hand-built models |
| Go group-by with the UI Pivot's dims/measures; sessions and time-bucket stats | `internal/analyze/pivot.go` | done; unit tests |
| Bind redaction (`-redact-binds`, `-bind-values keep\|redact\|none`, `-binds none`) as a model post-pass | `internal/model/redact.go`, `cmd/mtkprof/bindflags.go` | done; tests prove no value leaks into text/JSON/CSV |
| Web UI (Overview ledger + lanes + minimap strip, Statements workbench, Waits + event inspector, Timeline, Sessions, Pivot), light/dark, IBM Plex embedded; split into `web/src/lib` (shared library) and `web/src/app` (standalone shell) | `web/` → embedded as `internal/ui/dist/index.html` | redesigned 2026-10-23 (`docs/mockups/`), split 2026-10-25 (U1), reviewed by screenshot |
| Real fixtures: 19.27 (21), 21c XE (19), 23ai Free (19) + tkprof output + generators (dbmint, docker) + v$ exports | `testdata/` | done |
| Engine: sessions, jobs, SSE events, prompts, per-session `/s/{id}/api/*`, OpenAPI contract | `internal/engine`, `api/engine.openapi.yaml` | done (desktop phases 1 to 4 engine side: remote connections ssh and db, lines, report, ref) |
| Persistent index cache (content identity, LRU, manifest, `engine cache`) | `internal/engine/cache*.go`, `identity.go`, `internal/{model,analyze,slice}/*persist*.go`, `internal/binfmt` | done; round-trip tests on every fixture |
| CI (test, web build check, cross-build) and release | `scripts/ci-local.sh`, `scripts/release-local.sh` | replaced the GitHub Actions workflow (removed 2026-10-25); `ci-local.sh` passes |

Numbers (after milestone 5): 118 MB trace → text report in 0.61 s / 220 MB
RSS, standalone HTML 12.7 MB in 0.78 s / 255 MB RSS; 1 GB trace → HTML in
7.3 s / 2.1 GB (1.6 GB with `-lowmem`); 10 GB → report or HTML in ~1 min but
~20 GB RSS (bind-heavy shape). AIX, Windows, arm64, Solaris builds compile.

## Build, test, run

```
export PATH=$HOME/.local/go/bin:$PATH      # Go 1.27 lives here on this machine
make build                                  # bin/mtkprof
make test                                   # go test ./...  (unit + golden)
make web                                    # pnpm build in web/, copies the single-file UI into internal/ui/dist
./bin/mtkprof report testdata/traces/19c/plsql_recursive.trc | less
./bin/mtkprof html   testdata/traces/19c/io_waits.trc -o /tmp/io.html
./bin/mtkprof serve  testdata/traces/19c/io_waits.trc            # http://127.0.0.1:8046/
cd web && pnpm typecheck && pnpm dev                              # UI dev; set ?doc=http://127.0.0.1:8046/api/doc or run serve first (vite proxy not configured)
```

`web/src/lib` is the UI library (views, components, data, state, styles; imported as `@lib`
by the standalone shell `web/src/app` and by the desktop repo); `lib/` never imports `app/`.
One `Store` per open trace is created by `createSession()` and provided through
`SessionProvider`; views read it with `useStore`/`useActions`. Server calls go through an
`ApiClient` (`lib/data/client.ts`, base = server root, paths `/api/...`).

After any change under `web/src`, run `make web` and rebuild Go, otherwise
the binary serves the old UI. The built `internal/ui/dist/index.html` is
committed on purpose so `go build` alone works.

## Things that are easy to get wrong

- **tkprof prints exclusive numbers.** Parent calls include their recursive
  children in `c/e/p/cr/cu`; the model keeps both (`E` and `SelfE`, etc.).
  The golden test compares the *self* columns. Response-time rankings in the
  UI use inclusive elapsed plus idle time between the statement's calls.
- **Cursor adoption.** Calls for a cursor number that was never parsed in the
  file are attributed to the first statement later parsed under that number
  (tkprof's rule), flagged `Cursor.Assumed`. Split traces (`TRACE CONTINUED
  FROM FILE`) are excluded from part of the golden check for this reason;
  see the comment in `internal/golden/golden_test.go`.
- **`END OF STMT` inside SQL text** is real (fixture `nasty_sql.trc`); the
  parser only accepts the terminator once at least `len-4` bytes were read.
  `PARSE ERROR` text has no terminator; it ends after `len+1` bytes or at the
  next trace line.
- **Waits on cursor #0 after `XCTEND`** (log file sync) belong to the commit;
  the builder routes them to the last XCTEND until the next call.
- **Wait classes** come from `internal/ref/data/event_name_19c.csv` (a real
  `v$event_name` export); idle detection uses the `Idle` class.
- **Harness quirks** (Claude Code / T3): `cd` at the start of a Bash call is
  unreliable, use absolute paths; `pkill -f`/`pgrep -f` match the wrapper
  shell, find servers by port (`ss -ltnp | grep :8046`).
- **dbmint lab** (`~/.claude/skills/dbmint-oracle-test`): Oracle 19.27 in a
  VM, `ssh -p 2200 oracle@dbmint`, needs `dangerouslyDisableSandbox`. Schema
  `MTK` exists in `PDB1`; `testdata/gen/run_gen.sh` regenerates the fixtures
  idempotently and runs tkprof on them. Never run destructive SQL there.

## Milestone 1: done (2026-10-22)

Delivered on `main` (see `docs/PLAN-M1.md` for how the work was split):
text report executions table (`-execs N`), SESSIONS and TIME BUCKETS
sections, FINDINGS section; `mtkprof pivot` sharing `analyze.Pivot` with the
same dimension/measure ids as `web/src/lib/views/Pivot.tsx`; findings in
`stats.findings` of the JSON document and on the Overview; bind redaction on
every output; `plan_change.trc` fixture (one sql_id, two plan hashes, forced
with `optimizer_index_cost_adj`).

Follow-ups left open by milestone 1 (small, not blocking):

- Findings thresholds are constants in `internal/analyze/findings.go`
  (`docs/ARCHITECTURE.md` lists them). The trace-wide `hard-parses` rule fires
  as *info* on most lab fixtures because every statement there runs once.
  `think-time` counts in-call idle waits too (PL/SQL lock timer from
  `dbms_session.sleep`).
- Executions table: exec # is per cursor (SQL*Plus reopens the cursor, so it
  is 1 on every row); the cursor line column disambiguates.
- UI Pivot buckets time with its own `pickBucket`; the CLI uses
  `analyze.TimelineBucket`. Pick one.
- JSON `stats` could carry `analyze.Contexts` (the SESSIONS numbers) so the UI
  Sessions view stops recomputing them.
- Redaction: an optional salt, and literal redaction inside SQL text, were
  deliberately not done.
- `web/pnpm-workspace.yaml` (`allowBuilds: esbuild`) is what pnpm 12 needs to
  run esbuild's postinstall; the old `pnpm` field in `package.json` is ignored.

## UI redesign (2026-10-23)

Shell: top bar (file, mini profile bar, tabs, filter chips, theme) + sub-bar
(database, session, module, span); no rail. Selecting a statement anywhere
opens it in the Statements workbench (`actions.selectStmt`); `pickStmt`
selects without leaving the view. Only wait events use the right-hand
inspector.

- Overview (`views/Overview.tsx`): statement-concentration line, response-time
  bar on a true time axis with a per-component ledger (`derive.componentRows`),
  top statements drawn on the same axis (`derive.quickSegments`, one pass over
  the waits cached per document), findings, lanes on wall-clock time
  (`views/Lanes.tsx`, drag = window, click = open) with a bucket-chart
  alternative, trace facts.
- Statements (`views/Statements.tsx`): virtualized ranked list (sort select,
  self/inclusive, no SYS, j/k), `StatementDetail` in the centre,
  `StatementContext` on the right (where it ran, waits with obj#, recursive
  links, findings with evidence).
- Fonts: IBM Plex Sans/Mono latin subsets in `web/src/fonts` (OFL), inlined
  by the single-file build (~100 KB).
- Mockups that led here: `docs/mockups/` (A ledger, B workbench, C replay).

## Milestone 2: done (2026-10-24) — plan JSON and "Open in plan viz"

Specified in `docs/DESIGN.md` § Plans. Delivered on `main`:

- `internal/report/planjson.go`: each STAT dump becomes the V$SQL_PLAN-style
  row array the visualizer auto-detects (`PlanRows`, `PlanJSON`,
  `LatestPlans`, `PlansOf`); the root row has `parent_id: null`; the first
  row carries `sql_text`, `execution` (ordinal of the dump for that plan
  hash) and `trace_line`. `PlanVizURL` builds the deep link (payload →
  gzip → base64url → `<base>#gz=`), error above 100 000 chars.
- `mtkprof plan <trace> -sql_id X [-plan-hash H] [-exec N] [-viz] [-list]`.
- `-plan-viz-url` on `html`, `serve`, `json`, `plan`; the document carries it
  as top-level `planViz` (empty flag drops it).
- UI (`web/src/lib/data/planviz.ts`, `views/StatementDetail.tsx`): per plan hash
  a dump picker (when several), "Open in plan viz ↗", "Copy JSON", ⚙ to set
  the base URL (localStorage `mtkprof.planVizUrl` > document `planViz` >
  hosted default). Verified end to end against the hosted visualizer.
- Visualizer repo: `jsonPlanParser` now reads `sql_text` from the first row
  (commit `7e52b2d` on its main, **not pushed yet**; pushing deploys the
  site).

Left open: no UI unit test (web/ has no vitest); the "too large for a link"
path is untested in the browser; visualizer shows "0ms" for µs-scale plans
(its display rounds to ms).

## Milestone 1 follow-ups: done (2026-10-24)

Unpacked `json` writes u8 columns as number arrays (loader also accepts
base64); `serve` sends CORS on `/api/doc`; one bucket rule
(`analyze.BucketForSpan`, mirrored by `derive.pickBucket`); `stats.contexts`
feeds the Sessions view; `hard-parses` needs >= 20 hard parses trace-wide;
`think-time` excludes in-call idle (new `in-call-idle` info finding);
`-redact-salt` (sha256(salt+value)[:4] tokens).

## Milestone 3: done (2026-10-24) — ref bundle

`mtkprof refscript <trace> [-lite] [-o ref.sql]` writes a read-only SQL*Plus
script (objects, datafiles, users, DBMS_XPLAN per sql_id, chunked IN-lists);
`-ref dir` on every output applies it as a post-pass (`model.ApplyRef`,
`internal/ref/bundle.go`): plan lines get owner.object, waits get object and
datafile names (text report, CSV, JSON `objects`/`files`/`users` tables, UI),
`Statement.RefPlan` shows the DBMS_XPLAN text. `testdata/reference/bundle/`
holds a real run from dbmint. See `docs/REF-BUNDLE.md`.

## Milestone 4: done (2026-10-24) — trace sets and PX

Every command takes files and directories; `model.BuildFiles` follows
`TRACE CONTINUES IN FILE` chains (parsed as one stream, `-no-follow` to
disable) and parses independent files as separate sessions (`Context.FileIdx`,
`File.Files`). PX slave files (`(P000)` header image or `_p000_` name) attach
to a coordinator context of another file by time-window overlap plus client
id / module / action (`Context.PX`, `Context.Parent`); slave work is reported
as `pxEla`/`pxCpu`/`pxSessions` per statement and nested in SESSIONS, not in
the profile. Pivot/timeline still include slave calls in their own contexts.
`serve` keeps one line index per file (`/api/lines?file=i&from=N&n=M`); the
UI line viewer only asks for file 0 so far.

## UI polish round 2: done (2026-10-24)

Raw line viewer drawer (serve only), resizable panes (localStorage), column
chooser on Pivot and executions, URL hash state (`#view=&sql=&ev=&win=`),
wait scatter over time in the event inspector, bucket chart clamped to 100 %.

## Configurable finding thresholds: done (2026-10-24)

`analyze.Thresholds` (29 numeric keys, `DefaultThresholds`), `-findings-config
file.json|-` on report/html/serve/json, `mtkprof findings-config` prints the
defaults, document `stats.findingsConfig`, Findings view shows them.

## Milestone 6: done (2026-10-24) — comparison

`analyze.Compare` (statements by sql_id, else kind + normalised text; events
by name). `mtkprof compare a b [-n 30]` text report; `html|serve|json a b
-compare` writes `{compare:{a,b,diff}}`; UI Compare tab (totals, profile
bars, statement and event deltas, A/B toggle in the top bar, `side=b` in the
hash) and "Execution A vs B" panel in the executions table (tick two rows).
Compare documents are not server-sliced.

## DBMS_XPLAN overlay: done (2026-10-24)

`internal/ref/xplan.go` is a Go port of the visualizer's DBMS_XPLAN parser.
With `-ref`, a plan file whose plan hash matches a STAT plan overlays access
and filter predicates, alias, query block and (when STAT has no card) the
estimate onto `PlanLine`; text report prints a Predicates block, plan JSON
rows carry `access_predicates`/`filter_predicates`/`object_alias`/
`qblock_name`, UI shows ⚑ per row. The shared-package extraction from the
visualizer repo was not done (DESIGN.md § Plans updated).

## Milestone 5: done (2026-10-24) — memory and size

Compact facts (Call 168 B, Wait 88 B, Bind 56 B; `WallUs` derived from tim
and the anchor table; bind values in arena chunks), pre-sized fact tables,
shared executions index, GOGC 40 % (20 % with `-lowmem`), streamed packed
document (`report.WriteDocument`, `ui.WriteStandalone`), document **format
3** with delta-coded monotonic columns (loader in `web/src/lib/data/columns.ts`).
`-lowmem` on report/pivot/html/json/serve/export drops bind values only.
Analysis ordering is now deterministic (map-iteration dependence removed).
Not done: an aggregation-only mode (calls and waits must be retained for the
analyses); `MTKPROF_CPUPROFILE|MEMPROFILE|HEAPPROFILE` env hooks exist.

## Server-side slicing: done (2026-10-24)

`serve -facts=false` (or `-slice`) keeps the model and answers
`/api/pivot|timeline|executions|executions/detail|calls|waits|waits/hist|
waits/scatter|waits/by|profile|stmt/roles|stmt/waits|stmt/spans`
(`internal/slice`, httptest-covered). The document carries `slice: true`; the
UI's `DataSource` (`web/src/lib/data/source.ts`) picks `RemoteSource` then,
`LocalSource` for standalone HTML. big_loop: 284 KB document, ~290 MB RSS,
pivots in ~20 ms. Executions lists cap at the 5000 slowest; PX slave calls are
left out of remote executions; remote pivot labels are formatted by Go.

## Follow-up round: done (2026-10-24)

- **Aggregation-only mode** `-aggregate` on report/html/json/serve
  (`model.Options.Aggregate` → `analyze.Accumulator`): no calls/waits
  retained; 10 GB trace → text report in 32 s / 454 MB (was 18 GB); output
  equals `report -lowmem -execs 0`. Not on pivot/export/plan/compare.
- **Bind value decoding** (`internal/model/bindtypes.go`): TSLTZ, INTERVAL
  YM/DS memory dumps decoded; DATE/TIMESTAMP/TSTZ/ROWID get typed ISO forms;
  JSON/CSV/API binds carry `kind` and `typed`. New real fixture
  `bind_types.trc` (scenario `testdata/gen/sc_bind_types.sql`). Collections
  stay hex; TSTZ region ids are not mapped to names.
- **Web unit tests**: vitest (27 tests: planviz, columns format 3, pickBucket
  parity with Go, delta); `pnpm test` runs inside `make test` and CI.
- **Multi-file line viewer**: links pass `?file=i`; drawer names the file.
- **LICENSE**: Apache-2.0 added (publishing the repo is still the user's call).

## Spill mode: done (2026-10-24)

`serve -spill[=DIR]` builds in aggregate mode and writes the fact rows to
compact columnar temp files (`internal/slice` `diskSource`, plain ReadAt, no
mmap; per-statement indexes; stale-dir cleanup; removed on exit/signals).
Every slice endpoint answers from disk with the same JSON as the in-memory
source (`TestSpillAllFixtures`). 1 GB trace: 66 MB RSS idle, pivot 290 ms,
executions page 174 ms, 1.06 GB of spill files. `trace.LineIndex` is now
sparse (every 64th line). `/api/executions` streams one page.

## Shared core package and multi-version fixtures: done (2026-10-24)

- **`@davidbudac/ora-plan-core`**: extracted in the visualizer repo
  (`packages/ora-plan-core`, commits `16b687d`, `8e08600` on its local main,
  **not pushed**: the auto-mode classifier denies pushes to that repo as a
  production deploy). mtkprof vendors the built package in
  `web/vendor/ora-plan-core` (`web/scripts/sync-core.sh` refreshes it) and
  shows the visualizer's advisor findings per STAT plan ("Plan advisor" in
  the Statements workbench). Bundle +59 KB.
- **21c / 23ai fixtures**: `testdata/gen/run_gen_docker.sh` generates the
  19 scenarios in `gvenzl/oracle-xe:21-slim` and `gvenzl/oracle-free:23-slim`
  (the latter is 26ai Free, 23.26.3); `testdata/traces/21c`, `testdata/traces/23ai`.
  Parser fixes: unprintable bind value line, unbracketed trcsess pid marker,
  CLIENT IP / CONNECTION ID markers, "Oracle AI Database" banner, 23ai
  `image:` PX header. Golden enumerates every version directory; one
  documented deviation (23ai `midtrace_start`, assumed-cursor exemption). PX
  scenarios skipped on XE/Free (serial). 12.2 has no free image.

## Still open (need the user)

- Push the visualizer repo (`7e52b2d`, `16b687d`, `8e08600`): deploys the
  hosted site; denied for the agent as a production deploy.
- Publish this repo (Apache-2.0 LICENSE is in; release job verified).
- Visualizer LICENSE file.

## Known gaps and small bugs

- The Statements workbench sorts by one measure at a time; the Pivot is the
  escape hatch for multi-column comparisons (column chooser exists now).
- Overview lanes show the top 12 statements by response time.
- `Chart.tsx` re-resolves CSS colours on theme change via a probe element.
- `commandName` is empty for synthetic statements (commit, LOB, unknown) by
  design; the UI shows the kind instead.
- Compare mode: the UI has no per-component profile table (the text report
  has one); dark theme of the Compare tab not reviewed.
- PX matching exercised on one QC + one slave fixture only; cross-file `tim`
  ordering assumes one host (a note is emitted when offsets differ > 2 s).
- Remote (sliced) activity chart applies the context filter to CPU too; the
  local path never did.

## Agentboard

Todos #27 (memory), #28 (UI polish round 2), #29 (multi-file / PX merge),
#30 (M1 follow-ups) were delivered in this round and closed on 2026-10-24.
