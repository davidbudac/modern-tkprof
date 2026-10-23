# Handoff — state of mtkprof on 2026-10-22 (after milestone 1)

Read this, then `docs/DESIGN.md` (the decisions), then `docs/ARCHITECTURE.md`
(how the code is shaped) and `docs/trace-format-19c.md` (what the parser
must accept). `docs/ROADMAP.md` lists the longer tail.

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
| CLI: `report`, `pivot`, `html`, `serve`, `json`, `export`, `lint` | `cmd/mtkprof` | done |
| Findings (9 rules, fixed thresholds) in JSON, text report and Overview | `internal/analyze/findings.go`, `internal/report/text_findings.go`, `web/src/views/Findings.tsx` | done; unit tests on fixtures + hand-built models |
| Go group-by with the UI Pivot's dims/measures; sessions and time-bucket stats | `internal/analyze/pivot.go` | done; unit tests |
| Bind redaction (`-redact-binds`, `-bind-values keep\|redact\|none`, `-binds none`) as a model post-pass | `internal/model/redact.go`, `cmd/mtkprof/bindflags.go` | done; tests prove no value leaks into text/JSON/CSV |
| Web UI (Overview ledger + lanes, Statements workbench, Waits + event inspector, Timeline, Sessions, Pivot), light/dark, IBM Plex embedded | `web/` → embedded as `internal/ui/dist/index.html` | redesigned 2026-10-23 (`docs/mockups/`), reviewed by screenshot |
| Real 19.27 fixtures (20, incl. `plan_change`) + tkprof output + generator + v$ exports | `testdata/` | done |
| CI (test, web build check, release on tags) | `.github/workflows/ci.yml` | written, never run (repo private, no push of a tag) |

Numbers: parse ~340 MB/s; 118 MB trace → text report in 0.96 s, standalone
HTML of 20 MB that loads in ~6 s; AIX, Windows, arm64, Solaris builds verified
to compile.

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
same dimension/measure ids as `web/src/views/Pivot.tsx`; findings in
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

- Overview (`views/Overview.tsx`): generated summary sentence, response-time
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

## Milestone 2 (next): plan JSON and "Open in plan viz"

Specified in `docs/DESIGN.md` § Plans; the visualizer's JSON contract and
parser entry points are summarised there (repo
`davidbudac/ora-explain-plan-viz`, `src/lib/parser/jsonPlanParser.ts`,
`src/lib/url.ts`). Milestones 3–6 (ref bundle, file sets + PX, size/memory,
comparison) follow.

## Known gaps and small bugs

- Overview bucket chart ("by event" / "by class") y-axis can exceed 100 %
  (CPU is spread over a call's duration and Oracle's `c` can exceed `e`).
- The Statements workbench replaced the wide sortable table; the list sorts
  by one measure at a time (select). The Pivot is the escape hatch for
  multi-column comparisons.
- Overview "The session over time" lanes show the top 12 statements by
  response time; the others have no lane (the Timeline tab folds them).
- `Chart.tsx` re-resolves CSS colours on theme change via a probe element;
  the Timeline swimlane caches colours per render.
- The CI workflow has never run; expect small fixes (pnpm version pin,
  frozen lockfile) on first push to a public repo.
- Memory: ~600 MB RSS for a 118 MB trace (milestone 5).
- `mtkprof json` without `-packed` writes `u8` columns (call kind, flags) as
  base64 strings (Go marshals `[]byte` that way); the UI loader rejects such
  a document ("column kind: unexpected value"). `-packed` (what `html` and
  `serve` use) is fine.
- `mtkprof serve` sends no CORS header, so the Vite dev server cannot load
  `?doc=http://127.0.0.1:8046/api/doc`; copy the JSON into `web/` meanwhile.
- `commandName` is empty for synthetic statements (commit, LOB, unknown) by
  design; the UI shows the kind instead.

## Agentboard

Todos #27 (memory), #28 (UI polish round 2), #29 (multi-file / PX merge)
exist for the repo; close or update them as work lands.
