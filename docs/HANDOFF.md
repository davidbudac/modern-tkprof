# Handoff — state of mtkprof on 2026-10-22

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
| CLI: `report`, `html`, `serve`, `json`, `export`, `lint` | `cmd/mtkprof` | done |
| Web UI (Overview, Statements + inspector, Waits + event inspector, Timeline, Sessions, Pivot), light/dark | `web/` → embedded as `internal/ui/dist/index.html` | first version, reviewed by screenshot |
| Real 19.27 fixtures + tkprof output + generator + v$ exports | `testdata/` | done |
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

## Milestone 1 (next): text-report parity, findings, bind redaction

Decisions are in `docs/DESIGN.md`. Concretely:

1. **Text report sections** (`internal/report/text_report.go`): add per
   statement an executions table (exec #, start wall time, elapsed, cpu,
   rows, disk, query, fetches, bind preview; `-execs N` to cap) reusing
   `analyze.Executions`; a sessions section (one row per `model.Context`
   with calls, response, cpu, waits, idle, first/last time); a time-bucket
   section (from `analyze.Timeline` with the same bucket choice as the UI,
   `report.timelineBucket`); and a findings section (below).
2. **`pivot` subcommand** (`cmd/mtkprof`): `mtkprof pivot trace.trc -fact
   calls|waits -by dim[,dim] -measure m [-top N] [-window start,end]
   [-context id,...]`. Dimensions and measures must match
   `web/src/views/Pivot.tsx` (lists are in that file's `callDims`,
   `waitDims`, `callMeasures`, `waitMeasures`). Implement the group-by once
   in Go (`internal/analyze`, `KeyAgg` is a start) and have both the text
   report and the CLI use it.
3. **Findings** (`internal/analyze/findings.go`, new): rules and defaults from
   `docs/DESIGN.md` § Findings; output a `[]Finding{Rule, Severity, Summary,
   Evidence []Row, Statement ID}`; add to `report.Stats` (JSON) and to the
   text report; UI section on the Overview (`web/src/views/Overview.tsx`)
   with evidence rows linking to statements. Add fixtures to exercise each
   rule (the `cursor_cache`, `basic_binds` and `io_waits` fixtures already
   trigger churn, outliers and client-time cases; a plan-change fixture needs
   a new scenario in `testdata/gen` — e.g. gather stats between executions).
4. **Bind redaction**: `-redact-binds` (type + length + stable hash) and
   `-binds none` on `report`, `html`, `json`, `export`; implement in the
   builder or as a post-pass over `model.Binds` so every output agrees.
5. Golden tests must stay green; add unit tests for the findings rules.

Milestones 2–6 (plan JSON + "Open in plan viz", ref bundle, file sets + PX,
size/memory, comparison) are specified in `docs/DESIGN.md`; the visualizer's
JSON contract and parser entry points were researched and are summarised in
`docs/DESIGN.md` § Plans (repo `davidbudac/ora-explain-plan-viz`,
`src/lib/parser/jsonPlanParser.ts`, `src/lib/url.ts`).

## Known gaps and small bugs

- Overview timeline y-axis can exceed 100 % (CPU is spread over a call's
  duration and Oracle's `c` can exceed `e`); label says "% of time busy".
- Statements table scrolls horizontally when the inspector is open; no
  column chooser yet.
- `Chart.tsx` re-resolves CSS colours on theme change via a probe element;
  the Timeline swimlane caches colours per render.
- The CI workflow has never run; expect small fixes (pnpm version pin,
  frozen lockfile) on first push to a public repo.
- Memory: ~600 MB RSS for a 118 MB trace (milestone 5).
- `commandName` is empty for synthetic statements (commit, LOB, unknown) by
  design; the UI shows the kind instead.

## Agentboard

Todos #27 (memory), #28 (UI polish round 2), #29 (multi-file / PX merge)
exist for the repo; close or update them as work lands.
