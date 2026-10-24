# Architecture

`mtkprof` is a modern replacement for Oracle's `tkprof` and Trivadis' TVD$XTAT:
it parses raw SQL trace files (event 10046 / `sql_trace`), builds a
dimensional model of everything in the trace, and renders it as text,
JSON and an interactive web UI.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Core language | Go, pure (no cgo) | Must run on Linux, Windows **and AIX** DB servers as a single static binary, like `tkprof`. Go cross-compiles `aix/ppc64`, `windows/amd64`, `linux/{amd64,arm64}`, `solaris/amd64` from one machine. Rust has no usable AIX target; Java would pin us to the JDK 8 shipped in `$ORACLE_HOME`. |
| Trace format scope | Oracle 19c and later | Older line variants (pre-11.2 cursor numbers, `p1=/p2=/p3=` only waits, old bind blocks) are not a goal. The parser is lenient, so most of them still work, but they are not tested. |
| UI | TypeScript + Vite, embedded into the Go binary (`go:embed`) and into self-contained HTML reports | A DBA can run `mtkprof html trace.trc` on the server, copy one `.html` file to a laptop and explore it offline. `mtkprof serve` gives the same UI live. Trace data never leaves the machine. |
| Data model | Star schema in memory: fact tables (calls, waits, binds, plan lines, transactions, errors) + dimensions (statement, cursor instance, session context, event, object, time) | "Break it down by dimensions and measures" is the whole point. Every fact row carries the ids of its dimensions so any slice is a group-by. |
| Analysis | Done in Go, exported pre-aggregated + raw facts to the UI | Fast for multi-GB traces; the UI stays a thin, responsive explorer. Raw facts are also exportable as CSV/NDJSON for DuckDB, Excel, etc. |

## Pipeline

```
trace file ──► internal/trace (streaming line parser, emits typed records via a Handler)
           ──► internal/model  (Builder: cursors, statements, call hierarchy, wait attribution,
                                 bind sets, plan trees, session context, wall-clock anchoring)
           ──► internal/analyze (resource profiles, per-statement stats, executions, group-bys)
           ──► internal/report  (text report, JSON document for the UI, CSV export)
           ──► web/             (Vite + TS explorer, embedded)
```

### internal/trace — line parser

* Reads with a large buffered reader, line by line, no regexes on the hot path.
* Recognises every 19c line kind: header, `*** ` markers (timestamp, SESSION ID,
  CLIENT ID, SERVICE NAME, MODULE NAME, ACTION NAME, CLIENT DRIVER, CONTAINER ID,
  dump-size / continuation markers), `PARSING IN CURSOR … END OF STMT`,
  `PARSE/EXEC/FETCH/CLOSE`, `WAIT`, `STAT`, `BINDS` (full bind blocks incl.
  `No oacdef`, hex dumps, multi-line values), `XCTEND`, `ERROR`, `PARSE ERROR`,
  `LOB*` calls, `RPC CALL/BINDS/EXEC`.
* Unknown lines are reported with line numbers, never fatal.
* Numbers are parsed from byte slices; event names and SQL ids are interned.

### internal/model — the dimensional model

Facts (slices of structs, referenced by index):

| Fact | Grain | Key measures |
|---|---|---|
| `Call` | one PARSE/EXEC/FETCH/CLOSE/LOB*/RPC/XCTEND line | c, e, p, cr, cu, mis, r, plus self-time (e minus recursive children) |
| `Wait` | one WAIT line | ela, p1..p3, obj#, attributed call |
| `Bind` | one bind value in one BINDS block | position, type, value |
| `PlanLine` | one STAT line | cnt (rows), str (starts), cr, pr, pw, time, cost, size, card |
| `Transaction` | one XCTEND | rlbk, rd_only |
| `Error` | ERROR / PARSE ERROR | err code |

Dimensions: `Statement` (sql_id, hash, text, command type, parsing user, depth),
`Cursor` (one PARSING IN CURSOR instance), `Context` (session id, client id,
service, module, action, client driver, container; a new snapshot whenever a
marker changes it), `Event` (name, wait class, parameter names), `Object`
(obj#), wall-clock time (derived from `tim` and the nearest `*** timestamp`).

Rules that give the model its meaning:

* **Cursor instances**: a cursor number (`#…`) is reused; each `PARSING IN
  CURSOR` opens a new instance. A call for a number with no open instance
  gets an implicit instance bound to an "unknown statement".
* **Recursion hierarchy**: a call line is written when the call *completes*,
  so every call at depth `d+1` that completed since the previous depth-`d`
  call is a child of the next depth-`d` call. Parent resources (`c`, `e`,
  `p`, `cr`, `cu`) include children; the model computes self-time to avoid
  double counting.
* **Wait attribution**: `WAIT #n` lines precede the call line of cursor `n`
  they belong to. Waits whose `tim` is before the call started (think time,
  `SQL*Net message from client`) are flagged as *between calls*.
* **Synthetic statements**: `XCTEND` becomes a COMMIT/ROLLBACK statement,
  LOB calls become one statement per LOB operation kind, so they show up in
  profiles like everything else (tkprof silently drops them).
* **Wall clock**: `tim` is microseconds from an unspecified origin; every
  `*** <timestamp>` marker re-anchors it.
* **Bind redaction**: `RedactBinds` (`redact.go`) is a post-pass over
  `Binds` run by the CLI before any output, so every format agrees. `redact`
  replaces values with `<TYPE len=N h=8-hex SHA-256>` (dumps:
  `<TYPE dump len=N>`; NULLs and metadata kept). `-redact-salt S` (implies
  `redact`; `RedactBindsSalt`) hashes `S + 0x00 + value` instead, so equal
  values still match across traces with the same salt but cannot be looked up
  in a table of known-value hashes without it. `none` empties `Binds` and
  `BindSets` and sets every `Call.BindSet` to `None`. The mode is recorded
  in `Diag.BindMode` (`kept|redacted|none`) and in `Diag.Notes`.

### Trace sets: file chains, sessions, PX (`internal/model/files.go`, `px.go`)

`model.BuildFiles(paths, opts)` is the entry point for everything the CLI
builds; `model.Build(path)` is the single-file case (`NoFollow`) and produces
the same model as before. Steps:

1. `ExpandInputs`: directories become their `*.trc` (non-recursive, sorted),
   duplicates (by absolute path) are dropped.
2. Chains (`planFiles`): each file's head (64 KB) and tail are scanned for
   `TRACE CONTINUED FROM FILE` / `TRACE CONTINUES IN FILE`. A reference is
   resolved by the path in the marker, then its base name in the directory of
   the file that names it, then among the inputs (by file name, then by the
   file's own `Trace file` header, which survives renames), then among the
   neighbours in that directory by header name. Files found this way are added
   (`FileEntry.Followed`). Chains are ordered head to tail, chains and
   independent files in input order. Unresolved references are noted in
   `Diag.Notes` (only when several files are involved). `Options.NoFollow`
   skips all of it.
3. Parsing: one `trace.Parser` per file feeding one `Builder`.
   `Builder.NextFile(path, continuation)`: a **continuation** keeps all state
   (`open` cursors, pending waits/binds/parents, wall-clock offset), so calls
   after the split attribute to cursors parsed before it and there are no
   implicit/assumed cursors for them; an **independent** file first flushes
   orphan/unattributed counts and then resets cursor numbers, pending state and
   the session context (cursor addresses are only unique per process). In both
   cases the next record opens a new `Context` carrying `FileIdx`, and in a
   multi-file build the header's `Unix process pid` becomes `Context.Process`
   (as `trcsess` markers do). `tim` values are assumed to share a clock (same
   host); the wall-clock anchor of each file is its own, and a note is added
   when the files' wall-minus-tim offsets differ by more than 2 s.
4. `FileInfo.Files` (`FileEntry`: name, size, lines, first/last tim and wall
   time, pid, instance, `PX`, `Chain`, `Followed`, the chain markers) lists the
   files; `FileInfo` itself still describes the first file. Line numbers
   (`Call.Line`, ...) are per file; `Context.FileIdx` says which. `Diag.Lines`
   and `Bytes` are summed. `Span` covers all files.
5. PX (`attachPX`, only when several files were built): a file is a PX slave
   when its header says `(P000)`/`(PZ99)` or its name is `..._p000_...`;
   its contexts get `Context.PX`. Each slave context is matched to a
   coordinator context: a non-PX context of another file whose tim window
   (widened by 0.5 s) overlaps the slave context's, without a contradicting
   client id or module (empty is neutral); the best candidate by equal action,
   equal client id, equal module, then overlap length becomes `Context.Parent`.
   (PX wait events carry no qcsid in 19c, so the QC's identity cannot be read
   from the slave's lines.) `Model.PXChild(ctx)` = slave with a parent.

Attached slaves stay in their own contexts, but analysis keeps them out of the
coordinator's numbers: `analyze.Statements` accumulates their calls into
`StmtStats.PXElapsed` (Σ self elapsed), `PXCPU` and `PXSessions` (distinct
slave processes) instead of Parse/Exec/Fetch/Elapsed/Waits; the whole-trace
profile, statement profiles, executions and findings skip them
(`analyze.PX` totals their CPU/waits/idle for the report). Unattached slave
traces (no coordinator in the set) are analysed like any session, which keeps
tkprof parity. Pivot, the timeline and the UI's fact-based views contain the
slaves' calls under their own contexts.

### internal/report — document for the UI

The document is format 3: dimension tables as JSON objects, fact tables
(calls, waits, bind sets, binds) as typed columns. In the packed form
(`WriteDocument` / `DocumentBytes` / `JSON` with `Packed`), every numeric
column of a table is laid out in one little-endian buffer, gzip compressed and
base64 encoded (`blob`); the column descriptors keep `{t, off, n}`, plus
`"d":1` for columns stored as differences to the previous row (`line` and `tim`
of calls and waits, the bind-set links `line`/`call`/`first`, the bind `set`
column): sorted ids and times gzip to a fraction as deltas, which took the
big_loop document from 20.1 to 11.5 MB (-43 %). The loader integrates them in
place (`web/src/data/columns.ts`; `Int32Array` wraps like the writer's `int32`
subtraction). The browser decodes with `DecompressionStream` and creates
typed-array views, so a 600k-call trace is a ~11 MB document that loads in a
few seconds. The packed form is **streamed** (`stream.go`): the writer reads
the model column by column through getters, feeds gzip in 16k-row chunks and
base64-encodes straight into the output, so no column copy, packed buffer or
document string exists; `mtkprof html` writes the page around it
(`ui.WriteStandalone`). `BuildDocument` (unpacked arrays, used by `json`
without `-packed` and tests) still builds the columns in memory. `mtkprof html` inlines the document into the embedded UI page
(`internal/ui`); `mtkprof serve` serves it from `/api/doc` (always with
`Access-Control-Allow-Origin: *` and an OPTIONS reply, so `pnpm dev` can load
`?doc=http://127.0.0.1:8046/api/doc`; it is a local dev server).
Unpacked documents (`mtkprof json` without `-packed`) carry u8 columns as
number arrays, like the other columns. `stats.contexts` is `analyze.Contexts`
(the SESSIONS numbers); the Sessions view uses it and only recomputes from the
fact tables for documents without it. `stats.bucketUs` / the time bucket of
pivot and timeline follow `analyze.BucketForSpan` (UI: `pickBucket`).

`planjson.go` turns each STAT dump (`model.Plan`) into the JSON row array that
`davidbudac/ora-explain-plan-viz` auto-detects (`PlanRows` / `PlanJSON`:
`id, parent_id` (null for the root), `depth, operation, object_name, object_id,
cardinality, bytes, cost, actual_rows, starts, actual_elapsed_time` (µs),
`cr_buffer_gets, physical_reads, physical_writes, sql_id, plan_hash_value`; the
first row also carries `sql_text`, `execution` and `trace_line`). `LatestPlans`
/ `PlansOf` select dumps per statement, and `PlanVizURL` builds the "Open in
plan viz" link (`<base>#gz=` + gzip + base64url of
`{"plans":[{"rawInput":rows}],"viewMode":"hierarchical"}`, refused above
100 000 chars). `mtkprof plan` is the CLI front end (`-list`, `-sql_id`,
`-plan-hash`, `-exec`, `-viz`); `html`/`serve`/`json` take `-plan-viz-url`,
stored as `Document.planViz` for the UI.

### Reference bundle (`internal/ref/bundle.go`, `internal/model/ref.go`, `internal/report/refscript.go`)

mtkprof never connects to a database. `report.RefScript(m, opts)` (`mtkprof
refscript`) writes a read-only SQL*Plus script for one trace: the distinct
obj# (wait `obj#`, STAT `obj=`), file# (p1 of events whose first parameter is
`file#` / `file number`), parsing user ids and sql_ids with text are put into
chunked (<= 1000) IN-lists; it spools `ref/objects.csv`, `ref/datafiles.csv`
(datafiles plus tempfiles keyed by `file# + db_files`, the number waits
report), `ref/users.csv` and `ref/plans/<sql_id>.txt`
(DBMS_XPLAN.DISPLAY_CURSOR, DISPLAY_AWR fallback inside a PL/SQL block).
`-lite` reads ALL_ views and skips the datafiles. sql_ids are validated before
they reach the script.

`ref.LoadBundle(dir)` reads that layout into `ref.Bundle{Objects, Files,
Users, Plans}`; every file is optional, headers are case-insensitive, quoted
and BOM-tolerant, `*_objects.csv` / `datafiles_*.csv` are accepted too (the
raw lab exports), and a plan file without `Plan hash value` (aged-out cursor)
is dropped. `model.ApplyRef(m, b)` is a post-pass like `RedactBinds`: it only
adds names. It fills `Model.Objects`, `Files`, `Users` (only entries the
trace references, keyed by the trace's obj# / file# / uid), fills empty
`PlanLine.Object` with `owner.name[.subobject]`, sets `Statement.RefPlan` and
adds a `Diag.Notes` line. Lookups: `m.ObjectName`, `ObjectOwner`, `FileName`,
`UserName`, `WaitFile`. The document gets `objects[{id, owner, name,
subobject, type}]`, `files[{file, name, tablespace, type}]`, `users[{id,
name}]` (omitted without `-ref`; fact tables are unchanged) and `refPlan` on
statements. Text report: object names in "Wait detail by object", the user
name after `uid`, the DBMS_XPLAN text under the statement's plan. CSV:
`waits.csv` gets `object_name`, `file_name`; `plan_lines.csv` gets `owner`.
The pivot's `obj` and file-number `p1` groups print names. The UI maps
obj# / file# / user ids through `TraceDoc.objectName/fileName/userName` and
shows `refPlan` in a collapsible block under the plan tables. See
`docs/REF-BUNDLE.md`.

### Memory and size

Targets (DESIGN § Inputs): 1 GB trace → HTML under 15 s and under 4 GB; 10 GB →
report and HTML in minutes. What the model costs and how it is kept small:

* Fact structs are laid out for size: `Call` 168 bytes (was ~290), `Wait` 88
  (~140), `Bind` 56 (~120). 64-bit measures first, then `int32` ids and line
  numbers (per file; 2 billion lines), then `uint8` codes. `WallUs` is not
  stored: `Model.CallWall` / `WaitWall` derive it from `tim` and the table of
  `*** timestamp` anchors (`Model.anchors`, found by (file, line)), identical
  to what the builder used to store (CSV `wall_us` and `Execution.WallUs` are
  byte-identical). `Bind.TypeName()` is derived from `Dty`; the unused
  `Call.LobType/Bytes/Op` were dropped; the parser no longer keeps the bind
  buffer address and interns `oacflg`/`fl2`; bind values are copied into 64 KB
  arena chunks (`Parser.str`) instead of one allocation each, and the parser
  reuses its `BindSet` buffer (so handlers must not keep `BindSet.Binds`).
* `BuildFiles` samples the file (whole file up to 8 MB, else 8 windows of 1 MB,
  +25 %) for the number of calls, waits and binds and pre-sizes the slices
  (`Builder.Reserve`, capped at 24 GB each). A wrong guess costs one
  append-growth step, which used to hold 2.25x the table for a moment and was
  most of the peak.
* `analyze.AllExecutions` builds the executions of all statements in two passes
  with exact sizes (one backing array for all `Fetches`), and the text report
  shares one copy between the executions tables and the findings
  (`FindingsExec`); the per-statement `analyze.Executions` is O(statements x
  calls).
* GC target 40 % (20 % with `-lowmem`; `GOGC` in the environment wins): the
  heap is a few huge pointer-free slices, so collecting early is cheap.
* `-lowmem` = `model.Options.NoFacts`: bind values are not retained
  (`Binds`/`BindSets` empty, `Diag.BindMode` = none). Calls and waits stay:
  every aggregation (statements, profiles, executions, findings, pivot) reads
  them, so the numbers are identical (`TestNoFactsKeepsNumbers`). A real
  aggregation-only mode would need the analyses rewritten as streaming
  accumulators fed by the builder; not done.
* Hidden developer hooks: `MTKPROF_CPUPROFILE`, `MTKPROF_MEMPROFILE` (allocs at
  exit) and `MTKPROF_HEAPPROFILE` (heap in use right after the build) write
  pprof files.

Measured on this machine (16 cores, SSD, file cache warm; `/usr/bin/time -v`),
before = commit e705298:

| trace | command | before RSS / wall | after RSS / wall |
|---|---|---|---|
| big_loop (118 MB, 600k calls, 360k binds) | `report` | 540 MB / 1.04 s | 220 MB / 0.61 s |
| | `html` (document 20.1 → 11.5 MB, file 21.2 → 12.6 MB) | 607 MB / 1.15 s | 255 MB / 0.78 s |
| 1 GB (big_loop body x9) | `report` | 5.47 GB / 10.1 s | 2.05 GB / 6.0 s |
| | `report -lowmem` | | 1.58 GB / 5.6 s |
| | `html` (file 181.9 → 104.3 MB) | 5.67 GB / 10.6 s | 2.08 GB / 7.3 s |
| | `html -lowmem` (file 39.5 MB) | | 1.57 GB / 6.5 s |
| | `pivot -by stmt -lowmem` | | 0.93 GB / 3.3 s |
| 10 GB (x10 of the 1 GB file, 259M lines) | `report` | not run (~55 GB extrapolated) | 20.1 GB / 64 s |
| | `report -lowmem` | | 15.3 GB / 59 s |
| | `html` (file 1.03 GB) | | 20.7 GB / 74 s |

The 1 GB targets (HTML under 15 s and 4 GB) are met with room to spare. The
10 GB run finishes in about a minute but needs ~2 GB of RAM per GB of trace
for this bind-heavy shape (53M calls x 168 B plus executions and binds); a
trace with fewer, wider calls needs less. Cutting that further needs the
analyses to stream (see "not done" above).

Parse speed on big_loop (bind heavy) went from 161 to 310 MB/s.

### internal/analyze

* Resource profile (Millsap): CPU, each wait event, unaccounted-for, over any
  filter (whole file, one statement, one session, one time window).
* Statement table: tkprof-style call statistics + response-time ranking,
  with recursive children attached (nothing is lost when sorting).
* Executions: EXEC + following FETCHes grouped, with the bind set, rows,
  elapsed, waits — the unit for "why was *this* execution slow".
* Pivot (`pivot.go`): `Pivot(m, FactCalls|FactWaits, by, Filter)` groups the
  call or wait facts by dimensions and accumulates every measure. Dimension
  and measure ids, labels and semantics mirror `web/src/views/Pivot.tsx`;
  `Filter` mirrors the UI's time-window / context / idle filters
  (`web/src/app/store.ts`). Used by `mtkprof pivot`. The same file has
  `TimelineBucket` (bucket size of the timeline, shared with the JSON
  document) and `Contexts` (per session-context stats, as in the UI Sessions
  view, used by the report's SESSIONS section).

#### Findings (`findings.go`)

`Findings(m, Statements(m))` runs fixed rules and returns `[]Finding{Rule,
Title, Severity, Summary, Statement, ImpactUs, Evidence[]}`, most severe
first, then by impact. Evidence rows carry a printable label/value plus
statement / cursor / exec# / call / line ids for linking. Shown in the JSON
document (`stats.findings`), the text report (FINDINGS, after the statement
ranking) and on the UI Overview. Thresholds are named constants:

| Rule | Fires when | Constants |
|---|---|---|
| `outlier-executions` (per statement) | execution (EXEC + its FETCHes) > 3x the median and > 100 ms; needs >= 3 executions | `OutlierFactor`, `OutlierMinUs`, `OutlierMinExecs` |
| `plan-change` (per statement) | > 1 plan hash from STAT dumps or EXEC `plh` (0 ignored) | serious when one plan's avg exec >= 3x another's and the statement took >= 100 ms |
| `hard-parses` | PARSE `mis` per execution > 0.5 for a statement with > 10 executions, or trace-wide with >= 20 hard parses at that ratio (short traces where every statement runs once stay quiet) | `HardParseRatio`, `HardParseMinExecs`, `HardParseMinTotal` |
| `parse-per-exec` | PARSE calls per execution > 0.9 with > 10 executions | `ParseExecRatio`, `ParseExecMinExecs` |
| `hard-closes` | > 10 CLOSE type=0 of statements parsed >= 3 times whose closes are > 50 % type 0 | `HardCloseShare`, `HardCloseMinParses`, `HardCloseMinCount` |
| `think-time` | idle waits *between* calls (SQL*Net message from client, ...) > 30 % of response time; idle waits inside a call's time window are excluded | `ThinkTimeShare` |
| `in-call-idle` (always info) | idle waits inside calls (PL/SQL lock timer from `dbms_session.sleep`, PX dequeues) > 10 % of response time | `InCallIdleShare` |
| `small-fetches` (per statement) | executions with >= 3 fetches at < 20 rows per fetch, together > 100 fetches and > 1000 rows | `SmallFetchRows`, `SmallFetchMinFetchesPerExec`, `SmallFetchMinFetches`, `SmallFetchMinRows` |
| `commit-per-row` | > 10 read-write commits at > 0.5 commits per INSERT/UPDATE/DELETE/MERGE execution | `CommitPerDMLRatio`, `CommitMinCount` |
| `round-trips` | > 100 `SQL*Net message to client` at > 0.5 per row of top-level calls | `RoundTripsPerRow`, `RoundTripsMin` |

Severity: time-based rules map their impact against the response time
(trace span, or summed session time when sessions overlap): serious >= 25 %
and >= 1 s, notable >= 5 % and >= 100 ms, else info (`SeriousShare`,
`SeriousMinUs`, `NotableShare`, `NotableMinUs`). `hard-closes` and
`round-trips` are count-based (notable from 1,000, serious from 10,000).
Floors: `commit-per-row` and single-statement `hard-parses` are at least
notable; `plan-change` is notable or serious as above.

## Repository layout

```
cmd/mtkprof/        CLI (report, pivot, json, html, serve, plan, refscript, lint, export); trace arguments are files and directories
internal/trace/     streaming parser
internal/model/     model + builder
internal/analyze/   aggregations
internal/report/    text / json / csv renderers
internal/ref/       embedded reference data (wait classes, command types, bind datatypes) + the reference-bundle loader
web/                Vite + TypeScript UI
testdata/           real 19c fixtures (+ tkprof output as golden reference), generator scripts
docs/               this file, trace-format-19c.md, ROADMAP.md
```

## Build targets

```
GOOS=linux   GOARCH=amd64 go build ./cmd/mtkprof
GOOS=linux   GOARCH=arm64 go build ./cmd/mtkprof
GOOS=windows GOARCH=amd64 go build ./cmd/mtkprof
GOOS=aix     GOARCH=ppc64 go build ./cmd/mtkprof      # AIX 7.2+
GOOS=solaris GOARCH=amd64 go build ./cmd/mtkprof
```
