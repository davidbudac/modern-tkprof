# Desktop app: implementation plan

Written 2026-10-25 after the architecture review (decisions below). This is
the handoff for implementation. Read `docs/HANDOFF.md`, `docs/DESIGN.md` and
`docs/ARCHITECTURE.md` first; this file assumes them.

Two repositories:

- **`modern-tkprof`** (this repo): gains an engine mode (`mtkprof engine`), a
  persistent index cache, line drill-down, LOD tiles and the remote fetchers.
  The CLI stays as it is; every engine answer must equal the CLI's.
- **`mtkprof-desktop`** (new): the Tauri 2 shell, the desktop UI (today's
  `web/` plus desktop-only views) and packaging. Depends on this repo through a
  git submodule pinned to a tag.

## 0. Decisions (settled 2026-10-25)

| Decision | Choice | Why |
|---|---|---|
| Core | the existing Go packages, run as a sidecar process `mtkprof engine` | 19k golden-tested lines, ~340 MB/s parse, spill mode holds a 1 GB trace in 66 MB RSS with ~300 ms pivots. A Rust core would re-implement all of it for speed the GUI does not get from the parser. GUI speed comes from the query layer, the on-disk index and LOD tiles. |
| Shell | Tauri 2 (Rust) around the React/TS UI, talking to the engine over loopback HTTP | days to a working app with every current view; the engine protocol is shell-agnostic. GPUI (native, `gpui-kit`) stays an option if webview rendering limits the Lines or Timeline views; revisit after phase 3 with measurements. |
| Process model | one engine per app instance, N open traces ("sessions") per engine, crash-isolated from the GUI | a 10 GB parse dying must not take the window down |
| Storage | the engine always builds in aggregate + spill mode; the spill directory becomes a persistent index cache keyed by trace identity | one code path; open once, reopen instantly; RSS independent of trace size |
| Bulk data | the existing packed document (format 3) and JSON answers; Arrow IPC only if a non-web frontend ever needs it | the TS loader exists; no new format until there is a second consumer |
| Transport | HTTP/1.1 on `127.0.0.1:<ephemeral>`, bearer token from the environment, SSE for events; unix sockets later if needed | works on Windows, macOS, Linux without special cases; the web UI already speaks it |
| Remote access | SSH/SFTP (`x/crypto/ssh`, `pkg/sftp`) and Oracle via a pure-Go thin driver (`sijms/go-ora/v2` now; `oracle/go-oracledb` when out of beta), both inside the engine | no Oracle Instant Client to ship; one process holds the connections; Go has the mature drivers |
| Secrets | the shell keeps them in the OS keychain and passes them per request; the engine never persists them and never logs them | |
| UI source of truth | `web/` in this repo becomes a library package (`web/src/lib`) consumed by both the standalone shell (`web/src/app`) and the desktop repo via the submodule | one copy of every view; `mtkprof html/serve` keep working |
| Protocol contract | OpenAPI 3.1 file `api/engine.openapi.yaml` in this repo, protocol version integer, TS client generated from it | the shell pins a tag; a mismatch is detected at startup, not at the first odd answer |

## 1. Target architecture

```
mtkprof-desktop (new repo)
  src-tauri/            Rust: spawn engine (externalBin), token, keychain, dialogs, recent, menus, updater
  src/                  TS/React: workspace (session tabs), Lines view, Connections, Progress, Settings
  engine/               git submodule -> modern-tkprof @ tag; builds the sidecar, imports web/src/lib
          |  http://127.0.0.1:<port>   Authorization: Bearer <token>   SSE /engine/events
modern-tkprof
  cmd/mtkprof engine    control plane: sessions, jobs, cache, connections
  internal/engine       server, session, job, cache, events
  internal/slice        /api/* (as today) + lines/at, at, search, tiles
  internal/remote       ssh (sftp, follow), db (go-ora: ADR views, trace control, ref queries)
  internal/trace, model, analyze, report, ref   unchanged except the hooks listed below
```

Data flow for one trace: `POST /engine/sessions {paths}` → job `open`: cache
hit? load dimension tables + reopen spill files : parse (aggregate build with
`Spill` tee, `Tiles` tee, progress hook) → write manifest → session `ready` →
UI fetches `/s/{id}/api/doc` (format 3, `slice: true`) and attaches a
`RemoteSource` at `/s/{id}/api/`. Everything the views ask goes to the same
handlers `serve -spill` uses today.

## 2. Engine protocol v1

Process:

```
mtkprof engine [-listen 127.0.0.1:0] [-cache DIR] [-allow-origin O,...] [-idle-exit DURATION]
  token: env MTKPROF_TOKEN (required; 32+ bytes); stdout, once ready, one line:
  {"ready":true,"addr":"127.0.0.1:41233","version":"v0.3.0","protocol":1}
  exits when stdin closes (parent gone) unless -detach
```

Every request except `GET /engine/health` needs `Authorization: Bearer
<token>`. CORS: only the origins in `-allow-origin` (the shell passes
`tauri://localhost`, `http://tauri.localhost`; dev adds `http://localhost:5173`).
Errors: `{"error": {"code": "bad_request|not_found|conflict|cancelled|internal", "message": "..."}}`
with the matching HTTP status. Every list is bounded; limits are the ones in
`internal/slice`.

### Control plane

| method, path | body / params | answer |
|---|---|---|
| `GET /engine/health` | | `{version, protocol, uptime, sessions, cache:{bytes, entries, cap}}` |
| `GET /engine/events` | SSE | `job` (`{id, kind, state, phase, done, total, unit, message}`), `session` (`{id, state, rev}`), `log` |
| `POST /engine/sessions` | `{paths:[], options:{follow:true, binds:"keep\|redact\|none", salt, thresholds, aggregateOnly:false}}` | `{session, job}`; states `opening → ready \| failed`, `live` while following |
| `GET /engine/sessions`, `GET /engine/sessions/{id}` | | `{id, paths, state, rev, cacheKey, files:[...], opened, bytes, lines}` |
| `DELETE /engine/sessions/{id}` | | closes, keeps the cache |
| `GET /engine/jobs`, `DELETE /engine/jobs/{id}` | | list / cancel (`context.Context` per job) |
| `GET /engine/cache`, `DELETE /engine/cache/{key}` | | entries with size, last use, source paths |
| `POST /engine/compare` | `{a, b}` session ids | the compare document (`analyze.Compare`) |

### Per session, mounted at `/s/{id}/`

Existing (unchanged handlers): `api/doc`, the 13 endpoints of
`internal/slice` (`pivot timeline calls executions executions/detail waits
waits/hist waits/scatter waits/by profile stmt/roles stmt/waits stmt/spans`),
`api/lines?file&from&n`.

New:

| path | answer |
|---|---|
| `api/doc?rev=` | the document; `rev` increments when ref data is applied or a live session advances |
| `api/lines?...&annot=1` | JSON `{from, total, lines:[{t, k}]}`; `k` is the parser's line kind (`trace.Kind`) |
| `api/lines/at?file&tim=` | first line whose record has `tim >= tim` (binary search over the call rows of that file, then over waits) |
| `api/at?file&line=` | the model objects at or before that line: `{call, stmt, cursor, execNo, wait, bindSet, ctx, planLine}`; `None` where absent |
| `api/search?file&q&regex=0\|1&case=0\|1&from&limit` | NDJSON stream of `{line, col, text}` then `{done:true, scanned, truncated}`; literal search via `bytes.Index` chunked scan (GB/s), regex via `regexp` on line boundaries; cancelable |
| `api/tiles/levels` | `[{level, bucketUs, buckets}]` |
| `api/tiles?level&from&to` | `{bucketUs, from, n, cpu:[], waits:{<class>:[]}, calls:[], waitsN:[], maxCall:[]}` for at most 4096 buckets |
| `api/plan?stmt&plh&exec` | `report.PlanRows` for one STAT dump (what `mtkprof plan` prints) |
| `POST api/ref` | `{dir}` or `{connection}`; job; on success `model.ApplyRef`, `rev++` |
| `api/report?format=text\|json\|csv&execs=&...` | the CLI's outputs for this session (download) |

### Remote

| path | body / answer |
|---|---|
| `POST /engine/connections` | `{id, kind:"ssh"\|"db", spec}`; held in memory only. ssh spec: `{host, port, user, auth:{agent\|key:{path, passphrase}\|password}, hostKey:"<known fingerprint>"}`; db spec: `{dsn or host/port/service, user, password, role:"normal\|sysdba", wallet?}` |
| `DELETE /engine/connections/{id}`, `POST .../test` | |
| `GET /engine/connections/{id}/ls?path` | directory listing (ssh) |
| `GET /engine/connections/{id}/diag` | candidate trace directories: `$ORACLE_BASE/diag/rdbms/*/*/trace` found via `ls`, or `V$DIAG_INFO` when the connection is a db |
| `POST /engine/connections/{id}/fetch` | ssh `{paths:[], gzip:true}` → job → `{localPaths}` under `<cache>/remote/<conn>/`; resumable; db `{adrHome, name}` → job reading `V$DIAG_TRACE_FILE_CONTENTS` by `LINE_NUMBER` in 50 000-row chunks |
| `POST /engine/connections/{id}/follow` | `{path}` → a `live` session: SFTP stat + read of the tail every 500 ms into the streaming parser; `rev++` on each settled batch |
| `GET /engine/connections/{id}/tracefiles?sid&serial&since` | `V$DIAG_TRACE_FILE` joined with `V$PROCESS.TRACEFILE` / `V$SESSION` |
| `GET /engine/connections/{id}/sessions` | `V$SESSION` rows for picking what to trace |
| `POST /engine/connections/{id}/trace` | `{sid, serial, enable, waits:true, binds:true, planStat:"all_executions"}` → `DBMS_MONITOR.SESSION_TRACE_ENABLE/DISABLE` |

Unknown host keys: the engine answers `409` with the fingerprint; the shell
asks the user and retries with `hostKey` set. Nothing from `spec` is written to
disk or logs.

### Contract

`api/engine.openapi.yaml` describes every endpoint above and the existing
slice endpoints. `internal/engine/contract_test.go` walks the mux and fails
when a route is missing from the schema or vice versa. The desktop repo
generates its client with `openapi-typescript` from the submodule's file.
`protocol` increments on any breaking change; the shell refuses to start an
engine whose `protocol` it does not know.

## 3. Persistent index cache

Directory `<cache>/mtkprof/index/<key>/` where `<cache>` is
`os.UserCacheDir()` (override `-cache`), `key = SpillKey(paths) + format
version + bind mode + salt hash`. Contents:

```
manifest.json        engine version, index format, protocol, source files (abs path, size, mtime), options, created, lastUsed, bytes
dims.bin             model.Model without the fact tables (statements, cursors, contexts, events, plans, transactions, errors, File, Diag, Agg, Stats)
calls.bin waits.bin bindsets.bin binds.bin bindvals.bin calls.stmt waits.stmt   today's spill files, unchanged layout
lines-<i>.idx        trace.LineIndex checkpoints per input file (today rebuilt on every serve)
tiles/level-<L>.bin  LOD pyramid (§ 4)
```

Work:

- `internal/model/persist.go`: `Encode(w, m)` / `Decode(r)` of the dimension
  tables. Versioned, explicit binary (not gob: unexported fields in
  `FileEntry`, and gob's type descriptors make the format fragile). Round-trip
  test over every fixture: the document bytes of the decoded model equal the
  original's.
- `trace.LineIndex`: `Save(w)` / `Load(path, r)`; keep the stride constant in
  the file header.
- `slice.Spill`: `SpillOptions.Persist bool` and a fixed `Dir`; `Close` keeps
  the files when persisted; `OpenSpill(dir, m)` returns the `FactSource`
  without writing. `RemoveStale` stays for the temp case.
- `internal/engine/cache.go`: lookup by key, manifest validation (source
  size+mtime must match, else rebuild), LRU eviction by bytes (default cap 20 GB,
  setting), `engine cache ls|rm` CLI for support.
- Parity test `TestCacheRoundTrip` (extends `TestSpillAllFixtures`): for every
  fixture, build → persist → reopen → every slice endpoint answers
  byte-identically to the in-memory source.
- The engine never uses `MemSource`: one path, and the small-trace cost is
  negligible (a 5 MB trace spills about 5 MB). If disk pivots on small traces
  ever feel slow, add a `memSource` loaded *from* the spill files, not a
  second build path.

## 4. LOD timeline tiles

Purpose: pan and zoom the global activity chart over a 10 GB trace in
O(viewport), not O(rows). Perfetto's pattern.

- Levels: level 0 bucket width is the smallest power of two in µs such that
  the trace span has at most 2^20 buckets; level L has bucket `base × 8^L`;
  the top level has at most 1024 buckets. The pyramid is about 1.15× level 0.
- Per bucket (uint32 µs within the bucket, clamped; uint32 counts): CPU of
  top-level calls spread over the buckets the call covers (as
  `analyze.SpreadTimeline`), wait µs per wait class (fixed class list from
  `internal/ref/data/event_name_19c.csv`, idle included as its own class),
  call count, wait count, max call ela, max wait ela.
- Built as a second tee sink during the build (`internal/slice/tiles.go`,
  implements `model.Sink`), written to `tiles/level-0.bin` then the upper
  levels reduced from it at `Finish`. Level 0 is written through a bounded
  in-memory window because calls arrive in file order and a call's CPU is
  spread backwards from `tim`: keep the last 4 s of buckets hot, flush older.
- Served by `api/tiles`: the UI asks for the level that gives 512–2048 buckets
  for its viewport; the coarsest level ships inside the document (`stats.minimap`).
- Event-level detail (which events, not which class) stays on `api/timeline`
  for the viewport once the scope is small enough that its row count is bounded.
- Test: for every fixture, summing tile CPU/wait columns over the whole span
  equals `/api/profile`'s totals within rounding; a zoomed window's tiles
  equal `/api/timeline` with the same bucket width.

## 5. Line drill-down

Engine side is § 2 (`lines annot`, `lines/at`, `at`, `search`). Notes:

- `at` works per file: calls of one file are contiguous rows in `calls.bin`
  and in line order (`Call.Line`), so a binary search over the file's row
  range finds the enclosing call; waits likewise; cursors from
  `Statement`/`Cursor.Line`; bind sets from `BindSet.Line`.
- `lines/at?tim` uses the same rows the other way (`Call.Tim`, `Wait.Tim`).
- `lines?annot=1` runs `trace.Classify(line) Kind` per returned line (factor
  the kind detection out of `Parser.processLine` into a pure function; no
  state needed for a single line except "inside SQL text", which the
  annotation may get wrong for text lines and marks as `KindText`).
- `search` scans the file in 4 MB chunks with overlap for line boundaries;
  literal mode uses `bytes.Index`, regex mode `regexp` applied per line;
  streams hits as they are found; honours the request context.

UI (desktop repo, reusing `web/src/lib`): a **Lines** view (full tab, in
addition to the drawer): virtualized viewer with page cache and prefetch, kind
colouring, gutter marks for the selected statement's calls and waits, click a
line → `at` → highlight the statement/execution in the sidebar; every table row
keeps its "show in trace" link (`line` + `ctx` → file); search box with
literal/regex toggle and a hit list; bookmarks (local, per cache key); jump to
time (`lines/at`).

## 6. Remote fetch

`internal/remote/ssh`: `x/crypto/ssh` + `pkg/sftp`. Auth: agent
(`SSH_AUTH_SOCK`; on Windows the OpenSSH agent named pipe), key file with
optional passphrase, password. Host keys: `knownhosts` from the user's
`~/.ssh/known_hosts` plus the shell-confirmed fingerprint. Fetch downloads
with resume (`Seek` on both sides) into `<cache>/remote/<conn>/<name>` and
verifies size; `gzip:true` runs `gzip -c <file>` remotely when `gzip` exists
and streams through `compress/gzip`. Follow: stat every 500 ms, read the new
tail, feed the parser; the session is `live`; the UI polls `doc?rev=` on
`session` events.

`internal/remote/db`: `database/sql` with `sijms/go-ora/v2` behind an
interface so `oracle/go-oracledb` can replace it. Queries:

- list: `V$DIAG_TRACE_FILE` (12.2+), `V$PROCESS.TRACEFILE` joined to
  `V$SESSION` for "this session's trace", `V$DIAG_INFO` for the ADR home.
- fetch: `SELECT payload FROM v$diag_trace_file_contents WHERE adr_home=:h AND
  trace_filename=:f AND line_number BETWEEN :a AND :b ORDER BY line_number`,
  chunks of 50 000 rows, progress per chunk; warn in the UI above ~200 MB and
  suggest SSH (one row per line is slow at GB scale).
- trace control: `DBMS_MONITOR.SESSION_TRACE_ENABLE(sid, serial, waits=>true,
  binds=>true, plan_stat=>'ALL_EXECUTIONS')` / `SESSION_TRACE_DISABLE`.
- ref bundle: the queries `report.RefScript` prints, executed directly and
  written into the session's cache dir as the bundle layout
  `internal/ref/bundle.go` reads; then `model.ApplyRef`. Refactor
  `internal/report/refscript.go` so the SQL text per query is a Go value both
  the script writer and the fetcher use.

Verify on dbmint first (there is a `dbmint-oracle-test` skill): which of
`V$DIAG_*` a PDB-local user sees, the privileges needed
(`SELECT_CATALOG_ROLE` or direct grants, `EXECUTE ON DBMS_MONITOR`), and
throughput of `V$DIAG_TRACE_FILE_CONTENTS` on a 100 MB trace. Record the
answers in `docs/REMOTE.md`.

## 7. Shell (Tauri 2) and desktop UI

Repo `mtkprof-desktop` (name is the user's call; Apache-2.0 like this repo).

```
src-tauri/        tauri.conf.json: externalBin ["engine/mtkprof"], CSP connect-src 127.0.0.1:*
                  commands: engine_start (random token → env, parse ready line, health check), engine_restart,
                  keychain get/set/delete (keyring crate), pick_files, recent files, window state
                  plugins: shell, dialog, fs (scoped), store, window-state, updater, log, process, single-instance
src/              App shell: session tabs, open/progress, Lines, Connections, Settings; imports web/src/lib
engine/           submodule modern-tkprof; `pnpm build:engine` cross-compiles cmd/mtkprof for the host; CI builds the 3 targets
```

UI work in this repo (so both shells share it):

- Split `web/src` into `lib/` (data, views, components, styles) and `app/`
  (the standalone shell: `main.tsx`, `App.tsx`, `TopBar.tsx`, `urlstate.ts`).
  `lib/index.ts` exports the views, `DataSource`, loaders and the store.
- `attachRemote(doc, apiBase)` already takes a base; make `fetchLines`,
  `probeLines` and `planviz` take the base and an optional auth header from a
  small `ApiClient` (`lib/data/client.ts`: base URL, bearer token, `fetch`
  wrapper with `AbortSignal`). The standalone app uses an unauthenticated
  relative client.
- A `SessionProvider` context (desktop) instead of the single global document.

Desktop-only views: Workspace (tabs, recent, drag-drop a file), Open progress
(bytes, lines, statements so far, cancel), Lines (§ 5), Connections (list,
add/edit ssh and db, test, browse, fetch, follow, trace on/off), Settings
(cache cap and location, engine path/version, plan viz URL), About.

## 8. Phases and work packages

Rules as in `docs/PLAN-M1.md`: each package on its own branch, `make test`
green before merge, additive edits only in shared files (`cmd/mtkprof/main.go`,
`internal/slice/slice.go`, `web/src/lib/data/types.ts`), new code in new
files, UI verified by screenshot. Engine answers must stay equal to
`serve -spill` (parity test) and the golden test must stay green.

### Phase 1: engine mode (this repo)

| Pkg | Scope | Files | Done when |
|---|---|---|---|
| E1 engine server | `mtkprof engine`: listen, token, origins, health, events (SSE), sessions, jobs with `context` cancellation, per-session mount of the existing slice mux + `lines` + `doc`; ready line on stdout; exit on stdin EOF | `internal/engine/{server,session,job,events}.go`, `cmd/mtkprof/engine.go` | two sessions open at once, each answering `/s/{id}/api/*` byte-identical to `serve -spill`; cancel mid-parse frees everything; `httptest` coverage |
| E2 persistent cache | § 3: `model.Encode/Decode`, `LineIndex.Save/Load`, `Spill.Persist`, `OpenSpill`, manifest, LRU, `engine cache` CLI | `internal/model/persist.go`, `internal/trace/lineindex.go`, `internal/slice/spill.go`, `internal/engine/cache.go` | `TestCacheRoundTrip` green on every fixture; 1 GB trace reopens in < 2 s |
| E3 progress | `model.Options.OnProgress(bytes, lines, statements)` called every 64 MB from the builder; job events carry it; stretch: a snapshot document every 5 s from the accumulator under a mutex (`doc?partial=1`) | `internal/model/builder.go` (hook only), `internal/analyze/accum.go` (snapshot), `internal/engine/job.go` | the UI progress bar moves on a 1 GB trace; snapshot numbers converge to the final document |
| E4 contract | `api/engine.openapi.yaml`, `contract_test.go`, error envelope, `protocol` constant | `api/`, `internal/engine/contract_test.go` | test fails on an undocumented route |
| E5 docs | ARCHITECTURE § Engine, DESIGN § Desktop app (decisions above), HANDOFF | `docs/` | |

E1 and E2 can run in parallel (E1 starts on temp spill, switches to the cache
when E2 lands). E3 and E4 after E1.

### Phase 2: shell bootstrap (desktop repo) and UI library split (this repo)

| Pkg | Scope | Done when |
|---|---|---|
| U1 lib split | `web/src/lib` + `web/src/app`, `ApiClient`, `SessionProvider`-ready store; `make web` unchanged | `pnpm typecheck`, vitest, standalone HTML and `serve` unchanged (screenshot) |
| S1 repo | `mtkprof-desktop`: Tauri 2 scaffold, submodule, engine build script, CI matrix (linux x64, windows x64, macos arm64+x64), unsigned artifacts | app opens on all three |
| S2 engine lifecycle | spawn with token, parse ready line, health poll, restart on crash with a toast, exit on quit | kill -9 the engine → UI shows "engine restarted", sessions re-open from cache |
| S3 workspace | open file(s)/directory, recent list, session tabs, progress panel with cancel, every current view bound to `/s/{id}/api/` | open two traces, switch tabs, close one |
| S4 settings | cache location/cap, plan viz URL, theme; `engine cache` listing in the UI | |

### Phase 3: line drill-down

| Pkg | Scope | Done when |
|---|---|---|
| E6 lines API | `lines annot`, `lines/at`, `at`, `search` (§ 5), `trace.Classify` | unit tests on fixtures: `at` returns the call that `Call.Line` says; search finds every `WAIT #` line of a fixture; a cancelled search stops within 100 ms |
| S5 Lines view | § 5 UI; "show in trace" from every row opens the Lines view at the line with the object highlighted | screenshot; 10 GB trace scrolls at 60 fps on WebKitGTK (measure; this is the GPUI decision point) |

### Phase 4: remote

| Pkg | Scope | Done when |
|---|---|---|
| E7 connections + ssh | § 6 ssh: connections registry, test, ls, diag, fetch (resume, gzip), follow | integration test against dbmint (`ssh -p 2200 oracle@dbmint`): fetch a fixture, compare sha; follow a trace while `run_gen.sh` writes it |
| E8 db | § 6 db: go-ora, tracefiles, sessions, fetch via ADR view, trace enable/disable, ref fetch + apply; `docs/REMOTE.md` with the privilege findings | integration test on dbmint PDB1: list this session's trace, enable trace, run a statement, fetch, open; the ref bundle applied equals `-ref` of a `refscript` run |
| S6 connections UI | add/edit/test connections, keychain, host-key prompt, remote browser, fetch with progress, follow (live badge, auto-refresh), trace on/off, "fetch reference data" button | screenshots |

### Phase 5: beyond the CLI

| Pkg | Scope |
|---|---|
| E9 tiles | § 4 sink, files, endpoints, minimap in the document, parity test |
| S7 timeline | activity chart on tiles with smooth pan/zoom; drag = window as today; event detail from `api/timeline` when zoomed in |
| S8 cross-session | compare any two open sessions (`/engine/compare`), execution A/B across sessions |
| S9 annotations | notes on statements/executions/time windows, saved pivots and filters, per cache key in the shell's store; export as Markdown |
| S10 reports | download text/JSON/CSV of a session (`api/report`); "open standalone HTML" (`report` writes it) |

### Phase 6: release

Signing (Apple Developer ID + notarization of the bundle including the
sidecar; Windows signing optional), updater endpoint, crash log location,
`docs/DESKTOP.md` user guide, first tagged release of both repos with matching
tags.

## 9. Budgets (measure, do not guess)

| | target |
|---|---|
| reopen a cached 10 GB trace | < 2 s to `ready` |
| fresh open, 1 GB | parse at today's speed; progress event every 64 MB; snapshot every 5 s |
| pivot on 1 GB spill | ≤ 300 ms (today 290) |
| `api/tiles` request | < 50 ms |
| `api/lines` page (2000 lines) | < 20 ms |
| literal search, 1 GB | < 3 s, first hit < 100 ms |
| UI pan/zoom | 60 fps at ≤ 2048 buckets on WebKitGTK |
| engine RSS idle, 10 GB trace open | < 500 MB |

## 10. Risks

- **WebKitGTK** (Linux webview) is the slowest renderer. Measure the Lines
  view and the tiles chart there in phase 3 before investing in more charts.
  Heavy charts are canvas, never DOM/SVG per point.
- **Windows**: loopback listener plus token (no firewall prompt for
  127.0.0.1); Defender scanning spill files slows the first open; document the
  exclusion.
- **Model persistence** must be versioned from day one; a format bump
  invalidates the cache (rebuild, never crash).
- **`V$DIAG_TRACE_FILE_CONTENTS`** is slow and may not show CDB-level traces
  to a PDB user. SSH is the primary path; the view is the fallback.
- **Signing**: the sidecar inside the macOS bundle must be signed and
  notarized with the app; test the pipeline early with an ad-hoc signature.
- **Two repos in lockstep**: the submodule pin and the `protocol` check are
  the only guards; release both from the same tag.
- **go-ora** is community-maintained; keep the driver behind an interface.

## 11. For the user to decide

- Desktop repo name (default `mtkprof-desktop`), app id (default
  `com.davidbudac.mtkprof`), licence (default Apache-2.0).
- Keychain backend: OS keyring via the `keyring` crate (recommended) or
  Tauri's stronghold plugin.
- Cache cap default (plan says 20 GB) and location.
- Whether to push the visualizer repo and publish this repo before the
  desktop repo depends on the submodule (a private submodule works with the
  user's credentials).
