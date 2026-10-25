# Handoff — state of mtkprof on 2026-10-25 (milestones 1–6, the v1 tail, the follow-up round and desktop phase 1 done)

Read this, then `docs/DESIGN.md` (the decisions), then `docs/ARCHITECTURE.md`
(how the code is shaped) and `docs/trace-format-19c.md` (what the parser
must accept). `docs/ROADMAP.md` lists the longer tail.

Next body of work: the desktop app. `docs/PLAN-DESKTOP.md` (2026-10-25,
revised after a 33-question design interview, § 11 there) is the
implementation plan: engine mode in this repo, Tauri shell in a new private
repo, phases E1–E10 / U1 / S1–S9, protocol, cache layout, budgets. Phase 1
(engine, cache, contract, lib split) is done: see "Desktop phase 1: done".

## Where things stand

Repository `davidbudac/modern-tkprof` (private), branch `main`, pushed and
clean. Eight commits; everything described here is in them.

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
| Engine: sessions, jobs, SSE events, prompts, per-session `/s/{id}/api/*`, OpenAPI contract | `internal/engine`, `api/engine.openapi.yaml` | done (desktop phase 1); no remote, lines, ref or report routes yet |
| Persistent index cache (content identity, LRU, manifest, `engine cache`) | `internal/engine/cache*.go`, `identity.go`, `internal/{model,analyze,slice}/*persist*.go`, `internal/binfmt` | done; round-trip tests on every fixture |
| CI (test, web build check, release on tags) | `.github/workflows/ci.yml` | green on every push; release job verified with tag `v0.2.0-rc.1` |

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

## Desktop phase 1: done (2026-10-25)

`docs/PLAN-DESKTOP.md` phase 1. Merged on `main` (`9a7e16c`). Design:
`docs/ARCHITECTURE.md` § "Engine mode" and § "Persistent index cache".

| Package | What | Where | Status |
|---|---|---|---|
| E1 engine server | `mtkprof engine`: token, ready line, stdin EOF, sessions, jobs with cancel, SSE, prompts plumbing, per-session slice mux | `internal/engine/{server,session,job,events,prompts,errors}.go`, `cmd/mtkprof/engine.go`, `internal/remote/prompt.go` | done; httptest |
| E2 persistent cache | content identity, model/accumulator/spill/line-index persistence, manifest, LRU, `engine cache ls\|rm\|wipe` | `internal/engine/{cache,cache_manifest,cache_routes,identity}.go`, `cmd/mtkprof/engine_cache.go`, `internal/{model,analyze,slice}/*persist*.go`, `trace.LineIndex.Save/LoadLineIndex`, `internal/binfmt` | done; `TestCacheRoundTrip` on every fixture |
| E3 progress + minimap | `model.Options.OnProgress`, `analyze.TraceMinimap`, `stats.minimap` | `internal/model/builder.go`, `internal/analyze/minimap.go`, `internal/report` | done; sums equal the profile |
| E4 contract | OpenAPI file, route walk test | `api/engine.openapi.yaml`, `internal/engine/contract_test.go` | done |
| E5 docs | this section, ARCHITECTURE, README, CLAUDE.md | `docs/`, `README.md`, `CLAUDE.md` | done |
| U1 lib split | `web/src/lib` (views, components, data, state) + `web/src/app`, `ApiClient`, `SessionProvider`, minimap strip | `web/src/lib/data/client.ts`, `web/src/lib/state/session.tsx`, `web/src/lib/components/Minimap.tsx`, `web/src/app/*` | done; vitest, standalone HTML and `serve` unchanged |

**Run the engine by hand** (PATH as in "Build, test, run"):

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
Endpoints and query parameters of the per-session API are the ones of `serve
-spill`; the schema is `api/engine.openapi.yaml`.

**Budgets** (`docs/PLAN-DESKTOP.md` § 9), measured in phase 1:

| | target | measured |
|---|---|---|
| reopen a cached trace | 2 GB < 2 s to `ready` | `big_loop.trc` (118 MB): 32 ms + 5 ms document; 2 GB not measured (needs a 2 GB fixture) |
| fresh open | parse at today's speed | `big_loop.trc`: ≈ 0.8 s including persist |
| engine RSS idle | < 300 MB with 2 GB open | 27 MB after a hit on `big_loop.trc` |
| cache entry size | | ≈ the trace size |
| pivot on 1 GB / 2 GB | ≤ 300 ms / ≤ 600 ms | spill numbers from "Spill mode" (290 ms at 1 GB); not re-measured through the engine |
| `api/report` on `big_loop.trc` (118 MB, session open) | | text/json/html 5-8 ms (`html` 1.3 MB), csv 1.9 s (16 MB zip); `MTKPROF_BIG=... go test ./internal/engine -run ReportBig -v` |
| `api/lines` page, search, follow, minimap 60 fps | | lines/at/at/search measured in `TestMeasureBig` (`internal/slice`); follow, minimap and the UI (S5) not built |

**What the next phases need**

- Phase 2, in the new private repo `mtkprof-desktop` (S1 Tauri scaffold with
  this repo as a submodule, S2 engine lifecycle, S3 workspace, S4 settings):
  the protocol is `api/engine.openapi.yaml` (generate the TS client with
  `openapi-typescript`), the UI is `@lib` (`createSession`, `SessionProvider`,
  `ApiClient` with base `/s/{id}`), the engine is `bin/mtkprof engine` with
  `-allow-origin tauri://localhost,http://tauri.localhost`. Refuse an engine
  whose `protocol` is not 1. Read the event stream with `fetch`, not
  `EventSource`. Things the shell must handle: `failed` sessions with
  `error: "cancelled"`, 409 on removing an open cache entry, `options.follow`
  not implemented (400).
- E6 (lines API) and E10 (`api/report`) are done, plus `api/plan`: the session
  mounts `lines` (also `annot=1`), `lines/at`, `at`, `search`, `plan` and
  `report` (see "As built" in `docs/PLAN-DESKTOP.md` § 2); `mtkprof serve`
  serves the first five in its slicing modes. No cache format change.
  Report limits: a session's model is the aggregate one, so the text report
  has no executions tables and says "bind sets 0" in its Volume line, the
  JSON and HTML documents have no fact tables.
- E7–E9 (prompts + ssh, db, CLI subcommands) have not started;
  `internal/remote` only holds the `Prompter` interface so far.
- Known limits: sessions are never evicted (closing is the client's job);
  `rev` stays 1; `GET /engine/cache` costs one `readdir` + manifest read per
  entry; a 2 GB trace has not been run through the engine.

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
