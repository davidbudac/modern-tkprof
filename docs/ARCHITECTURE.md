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
| `Bind` | one bind value in one BINDS block | position, type, value (TIMESTAMP / INTERVAL memory dumps are decoded at build time: `model/bindtypes.go`), kind, typed (ISO 8601) |
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

* **Bind value decoding** (`bindtypes.go`): `Builder.Binds` turns the memory
  dump of a TSLTZ / INTERVAL YM / INTERVAL DS (and, should a version print
  them, TIMESTAMP / TSTZ / DATE) bind into text (`+03 04:05:06.789000000`,
  `-123-11`, `2024-07-01 22:59:59.5 (database time zone)`) and clears
  `IsDump`; an undecodable dump stays a dump. `Bind.Kind()` (from `Dty`) and
  `Bind.Typed()` (computed from `Value` on demand, so a redacted value never
  has one) give the ISO 8601 form: `P3DT4H5M6.789S`, `-P1Y6M`,
  `2024-02-29T13:14:15.123456+02:00`, `1999-12-31T00:00:00`; a restricted
  ROWID prints as the base-64 rowid with data object `AAAAAA`. The JSON binds
  table has a `kind` column (0 string, 1 number, 2 date, 3 timestamp,
  4 interval, 5 raw, 6 rowid, 7 other) and a `typed` string array (omitted when
  no bind can have one); `/api/executions` binds and `binds.csv` carry
  `kind` / `typed` too. Limits: RAW is printed by 19c one byte short (shown
  with a trailing `…`, no typed form); timestamps printed as NLS text keep the
  2-digit year (typed uses the RR rule), DATE text cut at 18 characters
  yields minute precision; TSLTZ has no offset (database time zone unknown);
  TSTZ regions show the UTC instant and the region id.

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
`?doc=http://127.0.0.1:8046/api/doc`; it is a local dev server). With
`-facts=false` (or `-slice`) the document carries `slice: true`, no fact tables,
and `serve` keeps the model to answer the slicing API below.
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

### Plan advisor (`web/vendor/ora-plan-core`, `web/src/data/advisor.ts`)

The UI depends on `@davidbudac/ora-plan-core` (`"file:./vendor/ora-plan-core"` in `web/package.json`), the pure
part of the visualizer extracted into `packages/ora-plan-core` of `davidbudac/ora-explain-plan-viz` (types, parsers,
analysis helpers, advisor; no React or DOM; unpublished). It is **vendored**: `web/vendor/ora-plan-core/` holds its
`package.json`, built `dist/` and a README with the source commit; `web/scripts/sync-core.sh` refreshes it from a
checkout of the visualizer (`npm run build:core` there first; then `pnpm install`, since pnpm copies `file:` deps
into `node_modules`). A clean clone needs only `pnpm install --frozen-lockfile`.

Per STAT plan, `StatementDetail` feeds `planRows(doc, plan)` (the same JSON rows as "Open in plan viz") to the
core's `parsePlanRows` and runs `runAdvisor(plan, null)` (no metadata bundle: only metadata-free rules run;
cardinality mismatch needs `card=` on the STAT lines). Findings (severity, title, explanation, node ids; the
suggestion is not shown) render as a "Plan advisor" block above the plan table, in the Findings ledger style; node ids jump to and
highlight the plan row; nothing renders without findings. Only `parsePlanRows`/`runAdvisor` are imported, so the
text and XML parsers tree-shake away (bundle +59 kB, +20 kB gzip).

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
shows `refPlan` in a collapsible block under the plan tables.

**DBMS_XPLAN overlay** (`internal/ref/xplan.go`, `overlayXPlans` in
`internal/model/ref.go`). `ref.ParseXPlans(text)` is a Go port of the
visualizer's `dbmsXplanParser.ts`: per plan (one per `Plan hash value:` line)
the plan hash, the table rows (Id, Operation depth from its indent, Name,
Rows/E-Rows, Bytes, Cost, Starts, A-Rows, A-Time, Buffers, Reads, Writes,
OMem/1Mem/Used-Mem; columns are located from the header line, missing ones are
-1), the Predicate Information block (id -> access / filter / storage, wrapped
lines joined, quotes respected), the Query Block Name / Object Alias block and
the Note section. `ApplyRef` overlays a parsed plan on every STAT `Plan` of
the statement whose `PLH` equals its hash, matching `PlanLine.ID` to the Id:
`Access`, `Filter`, `Alias`, `QBlock`, and `ERows` where STAT has no `card`
(`card < 0`); the plan gets `XPlanMatched`. A different hash overlays nothing
(a `Diag.Notes` line says so). No measure changes. Outputs: the text report
prints a `Predicates (from ref bundle DBMS_XPLAN):` block under the plan
table; the document's plan lines carry `access/filter/alias/qblock/eRows`
(omitted when empty) and plans `xPlanMatched`; `PlanRows` (the visualizer
contract) adds `access_predicates`, `filter_predicates`, `object_alias`,
`qblock_name` and fills `cardinality` from `ERows`; `plan_lines.csv` gets
`access_predicates`, `filter_predicates`, `e_rows`. The UI plan table shows a
flag per row with predicates (click to expand the text) and a header hint
when overlaid. See `docs/REF-BUNDLE.md`.

### Server-side slicing (`internal/slice`, `web/src/data/source.ts`)

`mtkprof serve -facts=false` (or `-slice`, which also works with facts) keeps the
parsed model after building the document instead of freeing it, and mounts
`slice.New(m).Handler()` under `/api/`. The endpoints read the fact rows through
`slice.FactSource` (`analyze.Facts` for calls and waits, plus bind values):
`memSource` over the model's tables, `diskSource` over the spill files of
`serve -spill` (next sections), same JSON either way. The document has no fact tables and is
flagged `slice: true`; the UI then asks the server for everything it used to
compute from the fact columns. The model is read-only after the build, so the
handlers run concurrently without locks; answers are JSON, CORS-open like
`/api/doc`, bounded, and cached by query (128 entries, < 4 MB each). A bad
parameter is a `400` with a plain-text reason. Common scope parameters: `from`,
`to` (`tim` µs; a row is in when its `[tim-ela, tim]` interval overlaps, as the
UI's window), `contexts` (comma separated ids), `stmt`, `event` (waits only) and
`idle=0|1` (waits, default 1). They map to `analyze.Filter` / `Matcher`, which
`analyze.Pivot` uses too.

| endpoint | answers | limits |
|---|---|---|
| `/api/pivot?fact=calls\|waits&by=dim[,dim]&measure=m[,m]&limit=N` | `analyze.Pivot` (rows, labels, extra, values, total, `groups`, `truncated`); `measure` sorts by the first and keeps only the listed measures | `limit` 1000 (max 100 000), 4 dims |
| `/api/timeline?bucket=µs` | CPU of top-level calls and wait time per event per bucket, spread over the buckets a call or wait covers and clamped to 100 % (`analyze.SpreadTimeline` = the UI's old `timeline()`); the UI folds it into classes / top events | default bucket = `TimelineBucket`; 400 above 100 000 buckets |
| `/api/calls?limit=&longest=` | the longest calls in scope (columns `id, stmt, kind, tim, e, c, r, line, dep, execNo, ctx`), total in scope, the longest N: the Timeline view | 20 000 calls, 100 longest |
| `/api/executions?stmt=&limit=&offset=&sort=` | executions of one statement (`analyze.Executions`) with bind values, total, avg and slowest; `sort` = `file` (default) `e c waitEla r p cr fetches start` (largest first) | 5000 rows |
| `/api/executions/detail?stmt=&cursor=&execNo=` | one execution: parse / exec / fetch call sums, waits per event, binds, plan hash (A/B comparison and the bind panel) | |
| `/api/waits?event=\|stmt=&sort=ela\|tim&limit=` | wait rows with total and time in scope | 1000 rows |
| `/api/waits/hist?event=` | log2 histogram (24 bins, counts and sums) | |
| `/api/waits/scatter?event=&max=` | waits over time: the 2000 slowest plus an even sample (`analyze.ScatterWaits`), rows `[tim, ela, line, stmt, ctx]` | 50 000 points |
| `/api/waits/by?event=&by=stmt\|obj\|p1\|p2&limit=` | `analyze.WaitsBy` with real keys (the event inspector's tables) | |
| `/api/profile` | CPU of top-level calls and waits per event in scope (the ledger, the top bar, the Waits table) | |
| `/api/stmt/roles` | wait time per statement and wait class (the bars of the Statements list) | |
| `/api/stmt/waits?stmt=1,2&max=` / `/api/stmt/spans?stmt=1,2&gap=µs` | top wait events of statements (with `maxLine` + `maxCtx`) / their merged call intervals (Overview notes, Lanes) | 200 statements |

Every row that carries a trace `line` also carries `ctx` (the context id; `/api/executions` rows and `executions/detail` have it too), so the UI maps it to the input file with `doc.fileOfCtx` and line links open the right file of a multi-file trace set. `stmt/spans` has no lines, hence no `ctx`.

`internal/slice/slice_test.go` runs every endpoint through `httptest` on
`io_waits.trc` and compares with the in-process `analyze` results, and checks
that every bad parameter is a 400. Differences to the in-browser numbers: the
executions list leaves out PX slave calls (`analyze.Executions`); the activity
chart and the lane strips apply the context filter to the CPU as well (the
in-browser path never did); the Pivot's time and p1/obj labels are the Go ones
(`HH:MM:SS.mmm` in the trace's zone).

UI side: `web/src/data/source.ts` defines `DataSource`, the questions the views
ask of the facts (`pivot`, `profile`, `timeline`, `calls`, `executions`,
`executionDetail`, `waitHist`, `waitScatter`, `waitTop`, `waitsBy`,
`stmtWaits`, `stmtRoles`, `stmtSpans`), with a `Scope` (window, contexts, idle)
instead of row-filter closures. Each returns `T | Promise<T>`.
`LocalSource` runs the code the views always ran over the fact columns
(synchronously: standalone HTML and `serve` with facts behave exactly as
before); `RemoteSource` fetches `/api/*` (base URL = where the document came
from, `load.ts`), caches answers by URL and is attached to documents with
`slice && !facts`. `sourceOf(doc)` picks one; `useSourceQuery(source, key, run,
keep)` runs a method, aborts the request of a stale key (`AbortController`) and
keeps the previous answer on screen while the next loads (same `keep` string).
Views show `loading…` or the error; a document without facts and without a
server still gets the "no fact tables" notes. `pnpm dev` proxies `/api` to
`MTKPROF_API` (default `http://127.0.0.1:8048`). Compare documents are not
sliced.

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
  them, so the numbers are identical (`TestNoFactsKeepsNumbers`). The
  aggregation-only mode (`-aggregate`, below) is what removes them.
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

With `-aggregate` (same machine, same files, 18 GB baseline re-measured for the
10 GB row):

| trace | command | `report` RSS / wall | `report -aggregate` RSS / wall |
|---|---|---|---|
| big_loop (118 MB) | | 220 MB / 0.59 s | 116 MB / 0.43 s |
| 1 GB (x9) | | 2.05 GB / 5.8 s (`-lowmem` 1.58 GB / 5.5 s) | 116 MB / 3.2 s |
| 10 GB (x90, 262M lines, 54.6M calls) | | 18.0 GB / 60.8 s | 454 MB / 32.3 s |

The 1 GB targets (HTML under 15 s and 4 GB) are met with room to spare. The
10 GB run finishes in about a minute but needs ~2 GB of RAM per GB of trace
for this bind-heavy shape (53M calls x 168 B plus executions and binds); a
trace with fewer, wider calls needs less. Cutting that further is what the
streaming `-aggregate` mode does (next section).

Parse speed on big_loop (bind heavy) went from 161 to 310 MB/s.

### Aggregation-only mode (`-aggregate`)

For traces whose calls and waits do not fit in memory (10 GB: 454 MB and 32 s instead of 18 GB and 61 s, table above).
`model.Options{Aggregate: true}` (implies `NoFacts`) keeps `Model.Calls`,
`Waits`, `Binds` and `BindSets` empty. The builder runs its normal call-stack
logic (waits attach to the next call of their cursor, `XCTEND` joins the
`log file sync` waits that follow it, a call's children are the pending deeper
calls, `Self*` = own minus children) and hands every fact to a `model.Sink`
the moment it is settled; `analyze.Accumulator` is the sink. What stays in
memory is the dimensions (statements, cursors, contexts, events, plans,
transactions, errors: small) plus the accumulators; what is open stays open:
the call being completed, the `XCTEND` that cursor-#0 waits can still join,
the recursive calls waiting for a parent (`model.ChildRec`, 48 bytes each: a
PL/SQL block that runs for an hour holds its children back until it ends) and
the waits waiting for a call.

The accumulator folds in two steps. A call is folded when complete: call
tables per statement and kind (count, misses, c, e, p, cr, cu, rows, self and
inclusive), first/last time, close types, hard-parse time, the session and time
bucket numbers, the call-kind counts, and (for `dep 0`) the top-level
quantities. The parts that depend on the parent (response time that excludes
calls nested in the same statement, recursive parent/child links, "has no
parent") are folded when the parent shows up (`Sink.Child`) or at the end for
orphans. Waits fold into the trace profile, the per-statement profile and wait
detail (by event and by obj#), the sessions, the time buckets and the idle
split of the findings. Executions (EXEC plus its FETCH calls; one open record
per cursor, since FETCH carries the number of the latest EXEC) fold into
per-statement count/min/avg/max, the slowest execution, the slowest
`max_evidence_rows`, the small-fetch totals and the plan hashes in order of
appearance; the elapsed time of every execution is kept (8 bytes each) for the
median of the outlier rule. `Statements`, `TraceProfile`, `StatementProfile`,
`PX`, `Contexts`, `Timeline`, `WaitsByEvent(m, nil)`, `WaitDetailEvents` /
`WaitDetailObjects`, `CallKinds`, `ExecSummaryOf` and the finding rules answer
from the aggregates when the model has them (`analyze.AggOf`), with the same
code for the rest (`profileOf`, the rule bodies) and the same ordering;
`TestAggregateMatchesFullModel` compares them with the full model on every
fixture and trace set, with default and eager thresholds, and the text report
test compares the reports line by line.

`analyze.TraceMinimap` (`stats.minimap`: 1024 buckets of top-level CPU and
wait µs per `Event.Class` over the whole span, PX slaves left out like
`TraceProfile`, so the sums equal the profile) is exact from the facts in a
full build; the accumulator keeps its own 100 µs cell grid (class per cell,
the timeline cells have none) and reduces it in `Finish`, a cell landing in
the bucket of its start (at most `ceil(100/bucketUs)` buckets early).

Details that make the numbers equal:

* Implicit cursors (used before their PARSING IN CURSOR) accumulate in a slot
  of their own (`-2-cursor`); when the builder adopts the cursor into the
  statement parsed later (`Sink.Adopt`) the slot is merged into the statement,
  edges included. Slots left over resolve to their (unknown) statement at the end.
* PX slave contexts are only known to be attached to a coordinator after the
  last file is read (`attachPX`). Each PX-flagged context accumulates in a
  shadow set; at the end the attached ones become `PXElapsed`/`PXCPU`/`PXSessions`
  and the PX totals, the others merge into the main set. The builder keeps the
  tim extent of every context's facts (`Model.aggExt`) for the matching.
* The time buckets need the bucket size, which depends on the whole span. The
  accumulator keeps 1 ms cells on an absolute grid from the first tim and
  coarsens by 10 above 20,000 cells (bounded memory for any span); the
  buckets of `BucketForSpan` are multiples of every cell size it can reach, so
  the buckets are exact when the first tim is the minimum (a monotonic
  trace). Files of one set whose tim clocks start apart, or spans beyond 16
  days, can move an event to the neighbouring bucket; a note says so.

What the report loses (and says in its header): the executions tables and
the BINDS sections (the `Executions: n, min, avg, max, slowest` summary line
stays), bind values everywhere (`NoFacts`), the evidence rows' call ids (they
point at nothing: `Call` is `None`; the executions of outlier and small-fetch
evidence are still identified by cursor line and exec number) and, in
documents, the fact tables and with them every drill-down that needs rows
(Pivot, Timeline details, event scatter, server-side slicing; `serve
-aggregate` serves the document only). `Transaction.Call` is `None`. The
per-execution finding rules (outliers, small fetches, plan changes) are
decided with the thresholds given when the model is built (`-findings-config`
is read before the trace). Everything else in the text report, the document
statistics and the findings equals the full model.

Memory is the dimensions plus the accumulators: independent of the number of
calls and waits except for 8 bytes per execution (`els`), 32-48 bytes per
recursive call whose parent has not been seen and 88 bytes per wait that has
no call yet (cursor-#0 waits that no `XCTEND` claims accumulate until the file
ends). A trace whose size comes from many distinct statements (literal SQL)
still pays for each statement (~1 KB of accumulator plus its text).

### Spill mode (`serve -spill`)

`-aggregate` keeps a 10 GB trace in 0.5 GB but throws the rows away. `serve
-spill[=DIR]` builds the same aggregation-only model (so the memory during the
build is the same, and the document is the aggregate one plus `slice: true`) and
writes every call, wait and bind value to temporary files while the trace is
read; the slicing endpoints then answer by scanning those files. Memory stays at
the size of the dimensions and aggregates whatever the trace size; the price is
disk of about the size of the trace (1.0x for the bind-heavy big_loop shape) and
a scan per drill-down (seconds on 10 GB instead of milliseconds in memory).
`-lowmem` leaves the binds out, `-bind-values redact|none` applies to the
spilled values (the spill writes the redacted text, `none` spills no binds).
`-aggregate` and `-spill` together mean `-spill`. The directory is written
`-spill=DIR` (a bare word after `-spill` is a trace file); the default is
`os.TempDir()`.

**Writing** (`internal/slice/spill.go`, `pagedfile.go`, `layout.go`). The
builder feeds the first sink (the `Accumulator`) and, with `Options.NewTee`, a
second one, `Spill`, through a `teeSink`; `Options.SpillBinds` also decodes the
BINDS blocks and hands them to the tee as `model.BindSink`, and the EXEC call
carries its set id in `Call.BindSet`. Files, in the directory
`mtkprof-spill-<key>-<pid>-<random>` (`key` = hash of the paths, sizes and
mtimes of the trace files, `SpillKey`):

| file | contents |
|---|---|
| `calls.bin` | one 154-byte record per call, by call id: 14 int64 measures (tim, c, e, p, cr, cu, r, self*, wait/idle ela), 9 int32 ids and counts, 6 byte codes. Little endian, fixed width |
| `waits.bin` | 70 bytes per wait, by wait id |
| `bindsets.bin`, `binds.bin`, `bindvals.bin` | 21-byte set records (line, cursor, first bind, n), 45-byte bind records (type, lengths, flags, offset into the value heap), the value text |
| `calls.stmt`, `waits.stmt` | uint32 row numbers grouped by statement (the per-statement index), written when the build ends |

Not stored: the statement of a row (it is the statement of its cursor, which an
implicit cursor adopted later changes, so it is looked up at read time through
`Model.Cursors`), `Wait.Number`, `BindSet.Call`. Two things make a plain
append impossible, and `pagedFile` (a cache of 48 pages of 256 KB per file)
handles them: a wait settles when its call arrives, so waits reach the sink out
of id order (a wait of an idle session can wait for the next call of its cursor
for the rest of the trace), and a call's `Parent` / `Orphan` are only known when
the parent completes (`model.ChildRec` now carries the call id for that). Writes
to a page near the newest go to the cache; older ones (a PL/SQL block that ends
after 600k children) are queued, sorted and applied page by page when 256k are
queued or 8 MB of data, so a straggler never costs a page read. A randomised
test compares the file with a byte slice. The indexes need no extra pass over
the trace: the number of rows per cursor is counted while writing, the layout of
the statement index follows, and one sequential pass over each table places the
row numbers (1M rows per chunk, sorted, one write per statement and chunk).
Session contexts are opened in file order, so the rows of a context are one
range (kept per context while writing). Write errors (disk full) are kept and
reported when the build ends; `Spill.Close` removes the directory.

**Reading** (`disk.go`). `diskSource` implements `analyze.Facts`: `EachCall` /
`EachWait` visit the rows a `Scan` hint can match in row order, decoding into one
reused `model.Call` / `Wait` (with `ID` and `Statement` filled in), and the
caller's `Matcher` still decides. A scan of everything or of some contexts
(their row ranges) reads sequentially through a 1 MB window with `ReadAt`
(no mmap, which is not portable); a scan of one statement walks its posting
list and reads the rows through a 64 KB window (several statements: their lists
merged in memory up to 8M rows, else a full scan). At most two scans run at a
time, a canceled request stops its scan within 4096 rows. `CallKind` (the
Pivot's "call kind" of a wait) reads 4096-row windows of the call file through a
four-window cache. Bind values: three reads per set. The analyze queries behind
the endpoints were rewritten once over `Facts` (`PivotOn`, `SpreadTimelineOn`,
`TopCallsOn`, ..., the old names are wrappers over the model), so there is one
implementation of every query, and two changes keep their memory independent of
the data: `/api/executions` streams the statement's calls once
(`analyze.EachExecution`, one open execution per cursor), counts, sums, tracks
the slowest and keeps only the requested page (a heap of offset+limit; `offset +
limit` is capped at 100,000), and `ScatterWaitsOn` finds the strided waits of the
elapsed-time order with two passes (a histogram per elapsed value, then the
waits at the wanted ranks) instead of sorting every wait. Still proportional to
the data, as before: `stmt/spans` keeps the call intervals of the asked
statements (<= 200), the scatter histogram has one entry per distinct elapsed
time. The 8 bytes per line of the raw-line index (`trace.LineIndex`, behind
`/api/lines`) were 2 GB for a 10 GB trace, as much as everything else; it now
keeps the offset of every 64th line (32 MB) and reads forward from it.

**Lifecycle.** The directory is created before the trace is read (a bad
`-spill=DIR` fails at once), removed on exit, on a failed build and on
SIGINT / SIGTERM / SIGHUP (also during the build). On start, directories of the
same trace key whose process is gone (a crash or kill -9) are removed;
directories of live processes are left alone (two servers on one trace work).
`TestSpillMatchesModel` builds io_waits, basic_binds, bind_types, plsql_recursive,
cursor_cache, midtrace, errors, lobs, multisession (one file and a + b) and a PX
coordinator + slave set both ways (model tables, spill files) and requires the
same canonical JSON from ~200-700 requests each (every pivot dimension, scope
filter, statement and event, every execution in detail with binds);
`TestSpillAllFixtures` does the same for every fixture; further tests cover the
codecs, `pagedFile`, stale and removed directories, redacted binds and
cancellation.

Measured (this machine: 16 cores, NVMe, spill files in the page cache;
`/api/pivot?fact=calls&by=stmt`, `/api/executions?stmt=<busiest>` = 1000 rows
with binds; each answer computed once, the response cache makes a repeat ~6 ms):

| | big_loop (118 MB, 600k calls, 360k binds) | 1 GB (big_loop body x9, 5.40M calls) |
|---|---|---|
| start to serving (parse, indexes, document) | 0.8 s | 5.6 s |
| RSS at the end of the build / idle | 161 MB peak / 35 MB | 160 MB peak / 66 MB |
| RSS after pivot / executions / the whole request sequence | 36 / 37 / 41 MB | 67 / 68 / 71 MB |
| pivot calls by stmt | 38 ms | 290 ms (cold files: 750 ms) |
| executions of the busiest statement (default, `sort=e&limit=100`) | 28, 23 ms | 174, 174 ms |
| execution detail | 7 ms | 6 ms |
| waits by event / by call kind | 5 / 21 ms | 6 / 93 ms |
| timeline / calls / profile | 20 / 62 / 22 ms | 132 / 190 / 135 ms |
| spill files | 118 MB: calls 92.5, binds 23.3, indexes 2.4, waits 0.04 | 1,064 MB: calls 832, binds 210, indexes 21.6, waits 0.4 |
| `serve -facts=false` (model in memory) for comparison | ~300 MB RSS | 1.88 GB RSS; pivot 172 ms, executions 62 ms |

A 10 GB trace of this shape (not measured): ~10 GB of disk, ~0.2-0.5 GB RSS
(the aggregates: 454 MB at 10 GB with `-aggregate`), a full scan about ten times
the 1 GB column (a few seconds warm, bound by the disk when cold); statement
questions stay fast through the index.

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

#### Comparison (`compare.go`)

`Compare(a, b *model.Model) Comparison` lines up two traces (B against A,
every delta is B - A): `Totals` (response time, CPU, in-call waits, idle,
unaccounted, parse/hard parse/execute/fetch counts, rows, disk/query/current
from the exclusive columns, statement and error counts), `Classes` (wait time
per event class), `Profile` (resource-profile components matched by name,
ranked by |delta|), `Statements` and `Events` (wait events matched by name,
ranked by |delta time|). Statements are keyed by sql_id; those without one
(commit, LOB, unknown, ...) by kind plus an FNV hash of the lower-cased,
whitespace-collapsed text; statements sharing a key in one trace are summed.
Each `StmtDelta` has `Status` `both|onlyA|onlyB`, per-side `StmtSide` numbers
(inclusive elapsed without think time, CPU, executions, per-execution elapsed,
parses, fetches, rows, disk/query/current, plan hashes from STAT dumps plus
EXEC `plh`), the deltas and `PlanChanged` (both sides know plan hashes and the
sets differ). The list is ranked by |delta elapsed|; `OnlyA()`, `OnlyB()` and
`Matched()` split it. `report.CompareText` (`mtkprof compare a b -n 30`) prints
it with the text report's helpers. `report.CompareDocument` is the JSON of
`html|serve|json a b -compare`: `{tool, version, format, compare:{a: Document,
b: Document, diff: Comparison}}`; `-compare` is explicit so it cannot clash with
other multi-file inputs, `serve` answers `/api/lines?side=a|b`. The UI loader
(`web/src/data/load.ts`) detects `compare`, loads both `TraceDoc`s and the store
keeps `compare` + `side`; `doc` is the active side, so every view works on it
(`actions.setSide` maps the selected statement through the diff). The Compare
tab is `web/src/views/Compare.tsx`; two executions of one statement are
compared in `web/src/views/ExecCompare.tsx` (derived from the fact columns, no
Go involved).

#### Findings (`findings.go`)

`Findings(m, Statements(m))` runs fixed rules and returns `[]Finding{Rule,
Title, Severity, Summary, Statement, ImpactUs, Evidence[]}`, most severe
first, then by impact. Evidence rows carry a printable label/value plus
statement / cursor / exec# / call / line ids for linking. Shown in the JSON
document (`stats.findings`), the text report (FINDINGS, after the statement
ranking) and on the UI Overview. Thresholds are the `analyze.Thresholds`
struct (`DefaultThresholds()`); `FindingsWith(m, stats, th)` takes custom ones
(`Findings` = defaults). `-findings-config file.json` (report, html, serve,
json; `-` = stdin) overlays a JSON object with any subset of the keys below
(unknown keys are an error listing the valid ones), `mtkprof findings-config`
prints the defaults, and the effective values are in `stats.findingsConfig`
(shown in a disclosure under the UI Findings). Pivot emits no findings. JSON key per constant:

| Rule | Fires when | Constants |
|---|---|---|
| `outlier-executions` (per statement) | execution (EXEC + its FETCHes) > 3x the median and > 100 ms; needs >= 3 executions | `OutlierFactor` (`outlier_factor`), `OutlierMinUs` (`outlier_min_us`), `OutlierMinExecs` (`outlier_min_execs`) |
| `plan-change` (per statement) | > 1 plan hash from STAT dumps or EXEC `plh` (0 ignored) | serious when one plan's avg exec >= 3x another's and the statement took >= 100 ms (`outlier_factor`, `notable_min_us`) |
| `hard-parses` | PARSE `mis` per execution > 0.5 for a statement with > 10 executions, or trace-wide with >= 20 hard parses at that ratio (short traces where every statement runs once stay quiet) | `HardParseRatio` (`hard_parse_ratio`), `HardParseMinExecs` (`hard_parse_min_execs`), `HardParseMinTotal` (`hard_parse_min_total`) |
| `parse-per-exec` | PARSE calls per execution > 0.9 with > 10 executions | `ParseExecRatio` (`parse_exec_ratio`), `ParseExecMinExecs` (`parse_exec_min_execs`) |
| `hard-closes` | > 10 CLOSE type=0 of statements parsed >= 3 times whose closes are > 50 % type 0 | `HardCloseShare` (`hard_close_share`), `HardCloseMinParses` (`hard_close_min_parses`), `HardCloseMinCount` (`hard_close_min_count`) |
| `think-time` | idle waits *between* calls (SQL*Net message from client, ...) > 30 % of response time; idle waits inside a call's time window are excluded | `ThinkTimeShare` (`think_time_share`) |
| `in-call-idle` (always info) | idle waits inside calls (PL/SQL lock timer from `dbms_session.sleep`, PX dequeues) > 10 % of response time | `InCallIdleShare` (`in_call_idle_share`) |
| `small-fetches` (per statement) | executions with >= 3 fetches at < 20 rows per fetch, together > 100 fetches and > 1000 rows | `SmallFetchRows` (`small_fetch_rows`), `SmallFetchMinFetchesPerExec` (`small_fetch_min_fetches_per_exec`), `SmallFetchMinFetches` (`small_fetch_min_fetches`), `SmallFetchMinRows` (`small_fetch_min_rows`) |
| `commit-per-row` | > 10 read-write commits at > 0.5 commits per INSERT/UPDATE/DELETE/MERGE execution | `CommitPerDMLRatio` (`commit_per_dml_ratio`), `CommitMinCount` (`commit_min_count`) |
| `round-trips` | > 100 `SQL*Net message to client` at > 0.5 per row of top-level calls | `RoundTripsPerRow` (`round_trips_per_row`), `RoundTripsMin` (`round_trips_min`) |

Severity: time-based rules map their impact against the response time
(trace span, or summed session time when sessions overlap): serious >= 25 %
and >= 1 s, notable >= 5 % and >= 100 ms, else info (`SeriousShare` (`serious_share`),
`SeriousMinUs` (`serious_min_us`), `NotableShare` (`notable_share`), `NotableMinUs` (`notable_min_us`)). `hard-closes` and
`round-trips` are count-based (notable from 1,000, serious from 10,000: `notable_count`, `serious_count`). `max_evidence_rows` and `bind_preview_max` cap evidence rows per finding and the outlier bind preview.
Floors: `commit-per-row` and single-statement `hard-parses` are at least
notable; `plan-change` is notable or serious as above.

## Repository layout

```
cmd/mtkprof/        CLI (report, compare, pivot, json, html, serve, plan, refscript, findings-config, lint, export); trace arguments are files and directories
internal/trace/     streaming parser
internal/model/     model + builder
internal/analyze/   aggregations (+ the streaming Accumulator of the aggregation-only mode)
internal/report/    text / json / csv renderers
internal/ref/       embedded reference data (wait classes, command types, bind datatypes) + the reference-bundle loader
web/                Vite + TypeScript UI (web/vendor/ora-plan-core: vendored shared plan core)
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
