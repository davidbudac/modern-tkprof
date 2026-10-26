# Design decisions

Settled on 2026-10-22 in a design review. Each item is a decision, not a
guess; change this file when a decision changes.

## Purpose and audience

mtkprof analyzes Oracle SQL trace files (event 10046) for performance DBAs
and consultants. It must answer, in this order:

1. Where did the response time go (resource profile).
2. Which statement, and which execution of it.
3. Why that execution was slow: waits, plan step, bind values.
4. What the client did between calls: think time, network round trips,
   fetch sizes, commits.
5. The PL/SQL and recursive SQL hierarchy.
6. Trace-level findings (see below).

Comparison of two traces or two executions is v2.

## Inputs

- Oracle 19c and later, event 10046 / `sql_trace` / `DBMS_MONITOR` only.
  No 10053, ASH or AWR inputs. 19c, 21c (XE) and 23ai (Free) are tested
  with real fixtures and tkprof parity (`testdata/traces/{19c,21c,23ai}`; no
  PX traces on 21c/23ai, XE/Free have no parallel execution); 12.x is "should
  work, untested".
- A trace is a **set of files** forming one logical trace: several paths or a
  directory; `TRACE CONTINUES IN FILE` chains followed automatically; each
  file's process becomes a session-context dimension (as in `trcsess`
  output); PX slave traces attach to their query coordinator as child
  sessions, matched by time window and the coordinator's client id, module
  and action (done 2026-10-24, milestone 4: see ARCHITECTURE § Trace sets;
  slave work is shown per statement as `PX slaves: N sessions, X s` and kept
  out of the coordinator's response time).
- Size targets: a 1 GB trace produces the interactive HTML in under 15 s and
  under 4 GB RAM; a 10 GB trace produces the text report and HTML in
  minutes (`-aggregate` keeps no calls or waits: a 10 GB trace in ~0.5 GB;
  the report then lacks the executions tables, bind sections and fact
  tables). HTML reports are **always written in full** (no sampling);
  for traces whose fact tables are too big for a browser, `serve -facts=false`
  slices on the server (done 2026-10-24: the browser holds only the dimension
  tables and statistics; the Go server answers the Pivot, timeline, executions
  and event queries from the fact columns; see ARCHITECTURE § Server-side
  slicing).

## Outputs

Text and HTML are **equal in numbers, not in form**: every number reachable
in the UI is reachable from the CLI.

- Default command: `mtkprof <trace...>` (no subcommand) parses once and
  writes both reports next to the trace, named by appending to the first
  input: `trace.trc.txt` and `trace.trc.html` (the full file name is kept so
  an existing `trace.txt` is never overwritten). It takes the flags of
  `report` and `html`; the subcommands remain for stdout, `-o` and the rest.
- `report`: text report with resource profile, statements, call tables
  (tkprof-style exclusive numbers), executions with binds, plans, recursive
  links, sessions, time buckets, findings.
- `pivot` subcommand: `-fact calls|waits -by dim[,dim] -measure m` with the
  same dimensions and measures as the UI Pivot.
- `html`: self-contained interactive explorer (curated views: Overview,
  Statements, Waits, Timeline, Sessions; Pivot and CSV export as the escape
  hatch). `serve`: the same UI from a local server. The Overview answers
  "where did the time go" first: the statement concentration (top k = 80%),
  the response-time bar on a true
  time axis with a per-event ledger, the top statements on the same axis,
  then the session on wall-clock lanes (drag = time window; click a block = its interval as the window and its
  statement selected, double-click = open the statement; the window bar leads to the window's lines). A bucket chart
  (CPU plus waits per event, top 10, the rest folded; or per class) is the
  alternative time view. Statements is a workbench: ranked list, the
  statement's tkprof table/plan/executions in the centre, context on the
  right. Chrome is neutral (IBM Plex); hue is reserved for wait classes.
  UI, findings and CLI text state facts only: numbers, names, terse fragments;
  no narration, no remedies or advice (plan advisor suggestions are not shown).
- `json` and `export` (CSV tables) for other tools.
- Bind values are kept by default; `-redact-binds` replaces them with type,
  length and a stable hash (`-redact-salt S` salts the hash); `-binds none`
  drops them.

## Correctness contract

- tkprof parity (call statistics, library cache misses, wait tables) is a
  hard golden test on every fixture in `testdata/traces/19c`.
- TVD$XTAT's feature list is the parity checklist.
- A wait inside a call's `[tim-e, tim]` belongs to the call whatever its
  class (an idle `PL/SQL lock timer` of `dbms_session.sleep` is in the call's
  elapsed and in-call waits); idle time is only what lies between calls
  (think time). Response time = elapsed + idle between calls never counts a
  wait twice; the wait class stays on the event for the ledger and the
  `idle` filter (decided 2026-10-25, tkprof's numbers are unaffected).
- The response time of a trace set, or of any scope of it (files, sessions,
  window), is the sum over its sessions of each session's response time
  (DB-time-like, decided 2026-10-25): a session is one server process of a
  file chain (its contexts and chain continuations); its response time is
  its span from the first call start to the last call or wait, between-call
  idle included, each context clipped to its file's time range and the
  session to the window. PX slaves attached to a coordinator in scope are
  left out (their work is the statement's `PX slaves`); unattached slaves and
  independent sessions each count. A single-session trace's response time is
  its span, so single-file numbers do not change. Every percentage of the
  response time (ledger, top bar, statement shares, findings severities, the
  Files panel's per-file share, the text report) is of this sum; the
  wall-clock span is shown beside it ("wall 3.849 s").
- Fixtures are generated on the dbmint lab (`testdata/gen`) whenever a
  scenario is missing.

## Plans

- The only plan data in a trace is the STAT block: row-source actuals with
  cost / size / card estimates. mtkprof keeps its own lightweight plan view
  centred on actual versus estimate per step (rows vs card, starts, time,
  buffer gets), one plan per plan hash, one per execution when
  `plan_stat=all_executions` is on.
- Integration with `davidbudac/ora-explain-plan-viz` is a **data contract
  plus deep links**, not code sharing: each STAT dump becomes the JSON row
  array the visualizer auto-detects (`id, parent_id, depth, operation,
  object_name, cardinality, bytes, cost, actual_rows, starts,
  actual_elapsed_time, cr_buffer_gets, physical_reads, physical_writes,
  sql_id, plan_hash_value`) plus the SQL text and execution number.
  "Open in plan viz" links the latest dump per plan hash (per-execution
  choice when several exist) to a configurable base URL (default the hosted
  site; CLI flag for `html`/`serve`, UI setting in localStorage); the plan
  travels only in the URL fragment.
- Plan-level findings (misestimates, spills, nested-loop volume, pruning)
  stay in the visualizer's advisor.
- Done (2026-10-24): the shared core package `@davidbudac/ora-plan-core`
  (types, parsers, analysis, advisor; no React/DOM) lives in
  `packages/ora-plan-core` of the visualizer repo and is **vendored** into
  `web/vendor/ora-plan-core` (synced by `web/scripts/sync-core.sh`, nothing
  is published). The Plans section of the statement detail shows the
  advisor's findings per STAT plan, inline (see ARCHITECTURE § Plan advisor).
  Still open: a LICENSE file in the visualizer repo (the README says MIT).
  Small changes in the visualizer repo are made as part of this project when
  the integration needs them.
- Done via a Go port (no code sharing): the visualizer's DBMS_XPLAN parser is
  ported to `internal/ref/xplan.go`, and `ApplyRef` overlays predicates,
  query block / alias and estimates from the ref bundle's `plans/<sql_id>.txt`
  onto the STAT lines of plans with the same plan hash, by operation id
  (see `docs/REF-BUNDLE.md`).

## Findings (v1)

Trace-level only, with fixed documented thresholds (overrides are a later
version), severity info / notable / serious, evidence rows, shown on the
Overview and in the text report. In the UI they follow the file / session /
window selection (computed over the rows in scope, severities against the
scope's response time); a finding about the whole set is tagged "whole set".

- Outlier executions: far slower than the statement's median (default:
  above 3x the median and above 100 ms), with their binds.
- Plan change within the trace: a statement with more than one plan hash.
- Parse and cursor churn: hard parses per execution, parse-to-execute ratio
  near 1 (default above 0.9 with more than 10 executions), hard closes
  (type=0) instead of cursor caching.
- Client-side time: think time dominating (default above 30% of response
  time), small fetch sizes (rows per fetch), commit per row, SQL*Net round
  trips per row.

## Enrichment (offline only)

`mtkprof refscript trace.trc > ref.sql` writes a SQL*Plus script tailored to
the trace (its obj#, file#, uid and sql_ids). The DBA runs it; it spools
objects, datafiles, users and DBMS_XPLAN output (DISPLAY_CURSOR with
DISPLAY_AWR fallback). Default uses DBA views and V$ (SELECT_CATALOG_ROLE);
`refscript -lite` emits an ALL_ views variant any schema can run.
`--ref dir` applies the bundle to every output. The analysis commands never
connect to a database; `mtkprof ref -db` / `trace` / `fetch -db` and the
desktop engine do (`internal/remote/db`, docs/REMOTE.md), and `ref -db`
runs the same queries (`report.RefQueries`, the values `RefScript` prints)
to fetch the bundle directly.

## Deferred to v2

Comparison mode; raw trace line viewer (serve mode only); DBMS_XPLAN overlay
via the shared package (the core's `dbmsXplanParser` is vendored, not wired up yet); configurable finding thresholds. (Server-side slicing
in `serve` is done: see Inputs.)

## Desktop app (decided 2026-10-25)

Plan, protocol and the full decision log: `docs/PLAN-DESKTOP.md`.

- Internal team tool for Windows, macOS and Linux (all first-class); private,
  unsigned GitHub releases; no updater. Traces of 1–2 GB are the ceiling.
- The Go core is the engine: `mtkprof engine` runs locally as a sidecar
  process, holds N open traces, always builds in aggregate + spill mode, and
  keeps the spill directory as a persistent index cache (user cache dir,
  20 GB LRU) keyed by trace content identity. No Rust rewrite of the parser
  or model; no remote-engine mode; no LOD tiles (a 1024-bucket minimap in the
  document instead).
- The shell is Tauri 2 (Rust) around the React/TS UI, in a separate private
  repository (`mtkprof-desktop`) that pins this repo as a git submodule.
  Committed; GPUI is not revisited.
- Transport: loopback HTTP with a bearer token, SSE events (jobs, sessions,
  prompts), the existing `/api/*` handlers per session, OpenAPI contract in
  `api/engine.openapi.yaml` with a protocol version.
- Remote access lives in the engine and is also exposed as CLI subcommands
  (`fetch`, `follow`, `trace`, `ref -db`): SSH through the system `ssh`/`sftp`
  binaries with an `SSH_ASKPASS` bridge (Go library fallback), Oracle through
  a pure-Go thin driver with username/password over TCP/TCPS (ADR views, trace
  enable/disable, reference data). Live follow over SSH only. No secret is
  ever stored: every credential is prompted through one prompt mechanism.
  Connection definitions (no secrets) are an import/export file plus a
  watched team file.
- `web/` stays the single source of the views: split into `lib` (shared) and
  `app` (standalone shell); `mtkprof html` and `serve` keep working; views
  that need the engine (Lines, connections, annotations) are desktop-only.
- v1 = phases 1–5 of the plan (engine, shell, Lines, remote, report download
  + annotations + saved pivots); cross-trace compare is post-v1.
- Every engine answer equals the CLI's (`serve -spill` parity test); the
  golden test stays the correctness contract.

## Project

- Repository `davidbudac/modern-tkprof` is private for now; pushed after each
  milestone; licence Apache-2.0 (`LICENSE`, added 2026-10-24); publishing is a
  separate decision.
- CI and releases run locally (`scripts/ci-local.sh`, `scripts/release-local.sh`);
  GitHub Actions is not used, by the owner's decision (cost). The scripts
  mirror the former workflow: vet, tests (golden and engine contract
  included), web build, embedded-UI check, `make release`; the release script
  needs a clean tree at the tag and uploads with `gh release create`.
- Release artifacts (decided 2026-10-25): one full binary per platform (with
  the pure-Go Oracle driver, ~27 MB) plus `mtkprof-lite-<os>-<arch>` built
  with `-tags nooracle` (~12 MB) for linux, aix and solaris, the database
  hosts where the trace files are local and the db commands are not needed.
  The desktop sidecar is always the full build.
- Every feature lands with unit or golden tests; UI work is verified with
  screenshots; commits go to main with concise messages. The user sets scope
  and priorities; implementation details are the implementer's, reported
  briefly.
- Milestone order: (1) text-report parity, findings, bind redaction;
  (2) plan JSON and "Open in plan viz"; (3) ref bundle; (4) file sets and PX
  merge; (5) memory and size work for 1 GB traces; (6) comparison.
