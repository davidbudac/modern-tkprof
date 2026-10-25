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

Selecting some files of a set (the UI) means selecting their contexts
(`Context.FileIdx`): every slicing endpoint takes `contexts=`, and
`/api/statements?contexts=` recomputes the statement table for them
(`analyze.StatementsOn`; in a chain the parent of a recursive call may be in
the next file, and is looked up there). Attached PX slaves' calls stay in
`pxEla`/`pxCpu`/`pxSessions` in a subset too.

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
place (`web/src/lib/data/columns.ts`; `Int32Array` wraps like the writer's `int32`
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

### Plan advisor (`web/vendor/ora-plan-core`, `web/src/lib/data/advisor.ts`)

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

`report.RefQueries(m, lite)` holds the SQL per bundle file as values;
`report.RefScript(m, opts)` (`mtkprof refscript`) renders them into a
read-only SQL*Plus script and `internal/remote/db` `FetchRef` (`mtkprof ref
-db`) runs them directly, writing the same files. Per trace: the distinct
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

### Server-side slicing (`internal/slice`, `web/src/lib/data/source.ts`)

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
UI's window), `contexts` (comma separated ids; absent or empty = all; `-` = the
explicit empty set, no row: `analyze.Filter.NoContexts`, which the Files panel
sends for "None"), `stmt`, `event` (waits only) and
`idle=0|1` (waits, default 1). They map to `analyze.Filter` / `Matcher`, which
`analyze.Pivot` uses too.

| endpoint | answers | limits |
|---|---|---|
| `/api/pivot?fact=calls\|waits&by=dim[,dim]&measure=m[,m]&limit=N` | `analyze.Pivot` (rows, labels, extra, values, total, `groups`, `truncated`); `measure` sorts by the first and keeps only the listed measures | `limit` 1000 (max 100 000), 4 dims |
| `/api/timeline?bucket=µs` | CPU of top-level calls and wait time per event per bucket, spread over the buckets a call or wait covers and clamped to 100 % (`analyze.SpreadTimeline` = the UI's old `timeline()`); the UI folds it into classes / top events | default bucket = `TimelineBucket`; 400 above 100 000 buckets |
| `/api/calls?limit=&longest=` | the longest calls in scope (columns `id, stmt, kind, tim, e, c, r, line, dep, execNo, ctx`), total in scope, the longest N: the Timeline view | 20 000 calls, 100 longest |
| `/api/executions?stmt=&limit=&offset=&sort=` (+ scope) | executions of one statement (`analyze.Executions`; with a scope: those whose EXEC call is in scope, summing the fetches in scope: `EachExecutionIn`) with bind values, total, avg and slowest; `sort` = `file` (default) `e c waitEla r p cr fetches start` (largest first) | 5000 rows |
| `/api/executions/detail?stmt=&cursor=&execNo=` | one execution: parse / exec / fetch call sums, waits per event, binds, plan hash (A/B comparison and the bind panel) | |
| `/api/waits?event=\|stmt=&sort=ela\|tim&limit=` | wait rows with total and time in scope | 1000 rows |
| `/api/waits/hist?event=` | log2 histogram (24 bins, counts and sums) | |
| `/api/waits/scatter?event=&max=` | waits over time: the 2000 slowest plus an even sample (`analyze.ScatterWaits`), rows `[tim, ela, line, stmt, ctx]` | 50 000 points |
| `/api/waits/by?event=&by=stmt\|obj\|p1\|p2&limit=` | `analyze.WaitsBy` with real keys (the event inspector's tables) | |
| `/api/profile` | CPU of top-level calls and waits per event in scope (the ledger, the top bar, the Waits table) | |
| `/api/statements` | `doc.stats.statements` over the scope (`from`, `to`, `contexts`; `idle` changes nothing): `{statements: [StmtStats]}`, one per statement in id order, the JSON of the document's entries, from `analyze.StatementsOn` (the call rows of the scope; a recursive call in scope counts in the links and `childUs` of its parent's statement whether or not the parent call is in scope; cursors, plans and errors follow the scope; equal to `Statements(m)` without parameters, model or spill). The Statements table of a file or session subset | one entry per statement |
| `/api/stmt/roles` (+ scope) | wait time per statement and wait class (the bars of the Statements list); every wait, idle included, unless `idle=0` | |
| `/api/stmt/waits?stmt=1,2&max=` / `/api/stmt/spans?stmt=1,2&gap=µs` (+ scope) | top wait events of statements (with `maxLine` + `maxCtx`; idle waits count unless `idle=0`) / their merged call intervals (Overview notes, Lanes), over the rows in scope | 200 statements |
| `/api/plan?stmt\|sql_id&plh&exec` | the rows of one STAT dump as `mtkprof plan` prints them (`report.PlanRow`; several plan hashes without `plh`: `{hash: rows}`); needs only the model | |

Every row that carries a trace `line` also carries `ctx` (the context id; `/api/executions` rows and `executions/detail` have it too), so the UI maps it to the input file with `doc.fileOfCtx` and line links open the right file of a multi-file trace set. `stmt/spans` has no lines, hence no `ctx`.

**Line endpoints** (`Server.WithLines(lis)` adds them to `Handler()`; they need the line indexes, so the slice server alone does not serve them; the engine and `serve`'s slicing modes call it):

| endpoint | answers |
|---|---|
| `/api/lines?file&from&n[&annot=1]` | raw lines as `text/plain` (`X-Total-Lines`); with `annot=1` JSON `{from,total,lines:[{t,k}]}`, `k` = `trace.Kind.String()` from `trace.Classify`. A page that starts mid-file seeds the "inside SQL text" state from the 64 lines before it and from an `END OF STMT` seen before any `PARSING IN CURSOR` in the page; a statement longer than both is wrong until its `END OF STMT`. Bind value continuation lines and PARSE ERROR text come out as `unknown` |
| `/api/lines/at?file&tim` | `{line}`: first line whose call or wait has `tim >=` (binary search over the file's call rows, then waits, smaller line wins; past the end: the last record's line; 404 without rows) |
| `/api/at?file&line` | `{call,stmt,cursor,execNo,wait,bindSet,ctx,planLine,kind}`, -1 where absent; `kind` is the line's. WAIT line: its wait and attributed call; PARSING IN CURSOR / SQL text / END OF STMT: only the cursor; STAT: `planLine` (index into `Model.PlanLines`) and its cursor; BINDS block: the EXEC it is attached to; otherwise the last call at or before the line |
| `/api/search?file&q&regex&case&from&limit` | NDJSON `{line,col,text}` per matching line (first match, byte column, text cut at 400 bytes), then `{done,scanned,truncated}`; 4 MB chunks from the line-index checkpoint, `bytes.Index` (ASCII-folded for `case=0`) or `regexp` per line; `limit` 1000 (max 10 000); stops within a chunk of a cancel |

`FactSource` gained `RowsOfContext`, `CallAt` and `WaitAt` for this: a binary search reads single fixed-width spill records, it never scans. `at` assumes the calls of one file are adjacent rows in line order, which holds for the builder's output; a plan's file is inferred (see `files()` in `at.go`) because `Plan` has no context.

`internal/slice/slice_test.go` runs every endpoint through `httptest` on
`io_waits.trc` and compares with the in-process `analyze` results, and checks
that every bad parameter is a 400. Differences to the in-browser numbers: the
executions list leaves out PX slave calls (`analyze.Executions`); the activity
chart and the lane strips apply the context filter to the CPU as well (the
in-browser path never did); the Pivot's time and p1/obj labels are the Go ones
(`HH:MM:SS.mmm` in the trace's zone).

UI side: `web/src/lib/data/source.ts` defines `DataSource`, the questions the views
ask of the facts (`pivot`, `profile`, `timeline`, `calls`, `executions`,
`executionDetail`, `waitHist`, `waitScatter`, `waitTop`, `waitsBy`,
`stmtWaits`, `stmtRoles`, `stmtSpans`, `stmtMarks`), with a `Scope` (window, contexts, idle)
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

#### Lines view (`web/src/lib/views/Lines.tsx`, desktop plan S5)

The raw trace as a full tab, in the shared library (the standalone app and the
desktop shell both mount `Lines`). It needs the line endpoints above, so the tab
exists only when the document has `slice` and the `linesApi` state is true
(`probeLinesApi`: one `GET /api/at?line=1` at load that must answer JSON;
`app/main.tsx` awaits it before the document opens so `#view=lines&file=&line=`
restores). Pieces:

- `data/lines.ts`: `fetchLinesAnnot`, `lineAt`, `objectsAt`, `search` (NDJSON read
  incrementally with `fetch` + `ReadableStream`, `onHit` per line, resolves with
  `{scanned, truncated, done}`; abort rejects with `AbortError`), `parseJump`
  (`1.5s`, `250ms`, `900us` = offset from the trace start, a bare number >= the first
  tim = absolute; with timestamps also a clock time `HH:MM:SS[.fff]` or
  `YYYY-MM-DD HH:MM:SS[.fff]` in the trace file's zone, `data/clock.ts`: a bare time is
  read on the start's day, or the next when that is where the trace is), `matchSpan`
  (the hit's byte column to a highlight range), `matchSpans` / `highlightRuns` (every
  match of the last search inside a row; the viewer wraps them in `<mark>`) and
  `linePermalink`.
- `data/linecache.ts` `PageCache`: pages of 2000 lines (the API's maximum) per file,
  LRU of 20, one request per page shared by all askers, prefetch of the neighbours,
  `keepOnly` aborts the requests of pages the user scrolled past. Kinds are kept as a
  `Uint8Array` per page.
- `components/LineViewer.tsx` + `data/scrollmap.ts`: **not** react-virtual. A 2.9 M
  line trace is 58 M px at 20 px a row and browsers stop scrolling an element near
  33 M px (Firefox 18 M), a 2 GB trace has tens of millions of lines. So the scroll
  bar covers at most 8 M px and maps linearly to the first visible line (exactly
  pixel per row below the cap); wheel and keys move by lines; the component renders
  a window of ~100 rows that shifts in steps of 20 lines and moves with a
  `transform`. No React state changes per line or per pixel; rows are memoised on
  `(line, text, kind, mark, selected, bookmark)`. Horizontal scroll is native (the
  gutter is `position: sticky`), wrap mode only changes the row CSS. react-virtual
  is used for the hit list (up to 10 000 hits).
- `components/colors.ts` `lineTone`: kind -> role colour (calls `cpu`, waits `userio`,
  cursor lines `sysio`, binds `network`, STAT/commit `commit`, lob/rpc `other`,
  errors `--s-critical`, framing lines dim); `lines.css` mixes it 55 % into the ink.
- Gutter marks: `DataSource.stmtMarks(stmt)` (local: the document's fact columns;
  remote: `api/calls?stmt=&limit=5000&longest=0` and `api/waits?stmt=&sort=tim&limit=1000`,
  so the 5000 longest calls and the first 1000 waits; `partial` says so). Previous/next
  mark buttons step through them. Opening the tab with a statement selected starts at
  its first mark.
- Click (or arrow keys) -> `api/at` (60 ms debounce) -> the at bar (statement link,
  exec#, cursor, wait event from the line's `nam='...'`, bind set, plan line) and the
  store: `pickStmt`, `selectExec`, `selectEvent`. Selecting from a click does not
  re-jump to the statement's first mark.
- Search box: literal/regex, case, "from here" (selected line + 1), Enter runs it,
  hits stream into a virtualized list (flushed every 100 ms, the first at once, the
  first hit is selected), Esc or Cancel aborts, F3 / Shift+F3 step through the hits.
  Jump to time (`lines/at`) and "Window start" (the store's time window).
- Bookmarks live in `State.bookmarks` (`addBookmark`, `removeBookmark`,
  `setBookmarks`; `{file, line, label}`); b, the toolbar button or a right-click on
  the line number toggles one; the second panel tab edits them. Not persisted here
  (the desktop shell stores them as annotations; a bookmark can carry a note, see
  below).
- Store: `view: 'lines'`, `linesApi`, `lineRefTarget` (`'drawer'` default, the desktop
  shell sets `'view'`), `linesView {file, line, seq}` (`openLinesAt(file, line)` bumps
  `seq`, which makes the view scroll and resolve the line; `setLinesLine` does not),
  `bookmarks`. `LineRef` opens the drawer, or the tab as `lineRefTarget` says; Shift
  flips it; the drawer has an "In Lines tab" button. What the view keeps while another
  tab is shown (position, query, hits, panel) lives in a `WeakMap` keyed by store and
  file, so switching tabs does not lose a search.
- The selected row shows Copy (its text) and Link (in `.lv-gut`, a fixed-width gutter that ends every row, sticky at the
  viewport's right edge: the row's text ends before it, so a long line is not laid under the buttons;
  `linePermalink`: the page URL +
  `#view=lines&file=&line=`, opened by the URL sync like any deep link; not offered where
  `lineRefTarget` is `'view'`, the desktop shell). `data/clipboard.ts` falls back to a
  hidden textarea on plain http.
- URL: `#view=lines&file=1&line=4711` (file only for a multi-file trace; clicking
  through lines replaces the history entry).

The Pivot view has a "Statement only" box (sql_id, datalist of the statements) and, for
waits, an "Event only" select: the `PivotState.stmt` / `event` filters, also set by an
applied configuration. A saved `PivotConfig` keeps its window as offsets and, when the
save form's "window by clock time" is ticked, also as `windowClock` (wall µs): applying
it to a trace with timestamps selects that clock window (cut to the trace; outside it
the window is dropped with a notice), otherwise the offsets apply. The field is
optional; the library file stays version 1. The Pivot controls are three groups (shape
pickers, "only" filters, saved / columns / CSV) that wrap as a whole, so a row never
breaks inside a group (checked at 1280, 1500 and 1920 px).

#### Notes and saved Pivot configurations (store additions, desktop plan S8/S9)

The lib keeps them in the store; persisting them is the shell's job (the desktop
app: per content identity in `annotations.json`, the library in `library.json`).
The standalone app keeps notes for the page lifetime and hides every affordance.

- `State.annotations: Annotation[]` (`data/annotations.ts`): notes on statements,
  executions and time windows, `{id, kind, note, created, updated, ...}`. A statement
  is named by a `StmtRef {sqlId, hash}` (FNV-1a of kind + text: ids are positions and
  do not survive another parse); `resolveStmt` matches sql_id + hash, else a unique
  sql_id. An execution adds `execNo` and `cursorLine` (execution numbers count per
  cursor; the cursor's trace line picks it, `execKey`). A window is `from`/`to` tim +
  optional `label`. Lines are the bookmarks: `Bookmark` gained `note?` and `updated?`
  (`setBookmarkNote`; `addBookmark` keeps a note). Actions `setAnnotations`,
  `addAnnotation` (an existing id is replaced), `updateAnnotation` (bumps `updated`),
  `removeAnnotation`; `setLoaded` clears them.
- `State.annotationsEnabled` (default false) shows the affordances: "✎ Add note" and
  the note box in `StatementDetail`, a ✎ column in its executions table, the window
  note chips and "Annotate window" in `Timeline`, "✎ Note" and the note per bookmark
  in `Lines` (gutter mark `lv-note`, note as tooltip). Notes that exist are shown
  regardless. Editor: `components/Note.tsx` (`NoteEditor`, `NoteBox`).
- File format and merge (pure, unit-tested): `annotationsFile` / `parseAnnotationsFile`
  (`{version: 1, identity, trace, exported, annotations}`, bookmarks as kind `line`),
  `mergeAnnotations` / `mergeBookmarks` (by id or line, the newer `updated` wins),
  `annotationsMarkdown` (grouped by kind, labels and times from the caller).
- Pivot: the view's configuration moved from component state into
  `State.pivot: PivotState {fact, by, sort per fact, limit, stmt, event, notice}`
  (`actions.setPivot`), so a store can save and apply it. `Store.getPivotConfig()`
  returns a `PivotConfig` (`data/pivotconfig.ts`) with stable keys: the window as
  offsets from the trace's first tim, contexts as `{session, module, action}`, the
  statement as a `StmtRef`, the event by name, the idle flag. `applyPivotConfig(cfg)`
  resolves it against the store's document (`resolvePivotConfig`), cuts the window
  to the span, switches to the Pivot view and returns what it dropped; the view
  shows that as a dismissable notice. `stmt`/`event` filter the pivot query
  (`PivotQuery.stmt/event`) and show as chips.
- `Session.library?: PivotLibrary` (external store: `subscribe`, `getSnapshot`,
  `save(name, cfg)`, optional `manage()`) feeds the Pivot view's "Saved" menu, shown
  when `State.libraryEnabled` and a library is present. `libraryFile`,
  `parseLibraryFile` (also reads `{library: {...}}` inside a bigger export),
  `mergeLibrary`, `describePivotConfig` are the file side.

#### Files panel (`web/src/lib/views/FilesPanel.tsx`, `data/fileset.ts`, `data/stmtstats.ts`, `data/scopedstmts.ts`)

For a document of several input files (`doc.multiFile`) the shell shows a collapsible left pane (`FilesPane`: panel, resize
handle, `PaneToggle side="start"`; open by default for several files, `State.filesOpen` remembers the choice) and a top-bar
entry (`FilesToggle`, which reads "3 of 7 files" with a clear button when a subset is selected). A single-file document has
neither; a `TRACE CONTINUES IN FILE` chain that was followed lists its parts in `file.files`, so it counts as several
files. The Overview heading repeats the count. Below 64rem the panel stacks above the view (a short scrolling list, no resize
handle or edge tab; the top-bar chip opens and closes it) and the top bar drops its mini profile so the tabs and chips stay
on screen.

- **State.** `State.files: Set<number> | null` (null = all; a set of every file is normalised to null, an empty set shows
  nothing). `actions.setFiles` drops a context selection that falls outside the files. `Scope` gains `files`, and
  `scopeOf(state).contexts` is the **effective** context filter: the explicit selection (`setContexts`, the Sessions ticks)
  intersected with the contexts of the selected files (`doc.contexts[i].fileIdx`), memoised on identity. Everything that
  filters or queries by scope (`callFilter`, `waitFilter`, `scopeParams` -> `contexts=`, the views' cache keys through
  `ctxKey`) therefore follows the file selection without knowing about files. No file selected is an empty set: the
  remote source sends `contexts=-` for it (an empty `contexts=` means "all" to the server; `-` is the explicit empty set,
  `analyze.Filter.NoContexts`, accepted by every scoped endpoint). Hash: `#files=0,2`
  (`app/urlstate.ts`; indexes the trace does not have are ignored, none left = all).
- **The panel.** One row per `doc.file.files` entry, PX slave files indented under the coordinator file their contexts attach
  to (`fileTree`: most `Context.parent` votes, no coordinator = top level). Checkbox, name, size, lines, contexts, pid,
  instance, wall-clock span; chips `PX`, `Chain n/m` (files sharing `FileEntry.chain`), `Followed`, `Continued`; and the
  file's share of busy time (CPU + non-idle waits) and of wait time. The shares come from one pass over the fact columns
  for the in-browser source (`localFileShares`) and from `api/profile?contexts=<the file's contexts>&idle=0` per file for a
  server (three at a time, cached by URL). Controls: All / None / Invert; click a name = only that file, ⌘/Ctrl-click
  toggles, Shift-click adds the rows in between (`clickFile`, pure and tested).
- **Statements of the scope.** `DataSource.statements(scope)`: the engine answers `GET api/statements?contexts=&from=&to=`
  (`{"statements": StmtStats[]}`, one per statement id; a 404 = older engine, remembered, answered `null`); the in-browser
  source computes the same objects from the fact columns (`scopedStatements`, the JavaScript twin of `analyze.Statements`;
  the idle toggle does not apply to calls, so `idle=` is not sent). `useScopedStatements(doc)` returns the whole-trace table
  while `scopeNarrows` is false (no request) and the scope's table when a window, contexts or files narrow it; without an
  answer (404, no facts) it returns the whole-trace table with a notice. Used by the Statements list ("n of m statements in
  scope", zero-call statements hidden), the statement detail and context headers, the Overview top statements, the lede and
  percentages (`scopeSpanUs`: the window, else the span of the selected files), and, without the window, the Overview lanes
  and the Timeline lanes. The lists under a statement follow the same scope: `executions(stmt, scope)` (`api/executions` with
  `contexts`/`from`/`to`: an execution is in when its EXEC call is), `stmtWaits`, `stmtRoles` and `stmtSpans` (the matching
  `api/stmt/*`; in the browser the fact columns through the same call / wait filters), the Context header (first and last
  call, cursors, trace line come from the scoped `StmtStats`), and the plans (`StmtStats.plans` = dumps of the cursors in
  scope; the in-browser `scopedStatements` derives `cursors`, `plans` and `planHashes` as `analyze.StatementsOn` does). The
  lanes (Overview and Timeline) list statements with calls in scope only (none while the scope's table is on its way,
  `ScopedStatements.pending`); the Timeline folds the other statements of the scope into one lane. The top-bar tab counts read
  "13 of 59" (statements with calls in scope, events with waits in scope, sessions in scope) and the Overview "Trace" facts
  (statements, executions, calls, waits, rows, reads, errors, commits, lines) are the scope's. Not scoped, still whole trace:
  findings (the Findings heading says so when files or sessions are selected) and the notes under the facts.
- **Share of the response time** (`data/response.ts`: one definition for the Statements list, the statement detail and the
  Overview ledger). A statement's response time is `elapsed + idleUs` (`StmtStats`); its share is measured against the scope's
  response time, the Overview heading (`scopeSpanUs`: the window, else the span of the selected files, else the trace's). It is
  not capped: the time is summed over sessions (two sessions running a statement at once count twice against the wall clock) and
  an idle wait inside a call (a `PL/SQL lock timer` in a sleep) is part of the call's `e` and of `idleUs`, so a statement can
  exceed 100 % of its scope; the percentage then carries a tooltip saying so.
- **Other views.** Sessions groups the contexts by file (header row with the file's checkbox; contexts of unselected files are
  dimmed and cannot be ticked; the roll-ups count the selected files). The Lines view's file picker lists the selected files
  and moves to the first selected one when the selection changes (a deep link or bookmark to another file stays).
- **Time axis** (`selectionSpan` in `data/fileset.ts`, `useAxis` in `data/scopedstmts.ts`). With files or sessions selected, the
  Overview lanes (and their wait / CPU strips), the by-event / by-class chart and the Timeline view span the selection's own
  range: the min first tim to the max last tim of the selected files (`FileEntry`) or, with an explicit session selection, of
  those contexts (`stats.contexts`, within the selected files); a PX slave file alone is the slave's range, with its coordinator
  file the union; no times = the whole trace. An explicit time window narrows further (a brush inside the axis; a window outside
  the range is ignored). The minimap keeps the whole-set axis and shades the selection's range (`.minimap-sel`) beside the
  window's shade. Buckets are counted from the trace's start, so the chart / strips pick the bucket of the selection
  (`selectionBucket`, `pickBucket` of its span) raised until the whole trace fits in 20000 buckets (the engine refuses more
  than 100000) and show only the buckets inside the range.
- **Saved Pivot configurations.** `PivotConfig.files?: string[]` stores the file selection as file *names* (not indexes: they
  apply to another set); the save form shows "with file selection" when a subset of several files is selected, next to "window
  by clock time". Applying selects the files of that name (`State.files`; every file = no selection); names the set does not
  have are reported in the Pivot notice ("2 of 3 files (a.trc, b.trc)", or "file selection (...)" when none exist, selection
  unchanged). A configuration without `files` leaves the selection as it is; its session contexts are checked against the
  selection that stays (contexts outside the selected files are dropped with a note). Old library files load unchanged; a
  malformed or empty list is ignored.
- Desktop shell: `FilesPane`, `FilesPanel`, `FilesToggle`, `filesPanelOpen` and `useScopedStatements` are exported from
  `@lib`; the shell puts `FilesPane` first in its `.body` grid and adds `has-files` to `.shell` (see `app/App.tsx`).

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

### Engine mode (`mtkprof engine`)

The desktop app's sidecar (`cmd/mtkprof/engine.go`, `internal/engine`; plan
and decisions: `docs/PLAN-DESKTOP.md`). One process holds N open traces,
always built the way `serve -spill` builds (aggregation-only model, facts in
spill files), and keeps the spill as a persistent index cache. Every session
mounts the handlers of `serve -spill` at `/s/{id}/`, so its answers equal the
CLI's.

**Process contract**

| | |
|---|---|
| token | env `MTKPROF_TOKEN`, at least 32 bytes, else exit 2. Never a flag (argv is visible). |
| ready line | one JSON line on stdout once the listener is up: `{"ready":true,"addr":"127.0.0.1:41233","version":"…","protocol":1}`. Logs go to stderr. |
| exit | stdin EOF (parent gone) unless `-detach`; SIGINT/SIGTERM; `-idle-exit D` after D with no sessions and no requests. Sessions are closed, their cache entries stay. |
| `-listen` | default `127.0.0.1:0` (any free port) |
| `-cache DIR` | cache root, default `<os.UserCacheDir()>/mtkprof` |
| `-cache-cap SIZE` | LRU limit, default `20G` (suffixes K, M, G, T = powers of 1024) |
| `-allow-origin O,…` | CORS origins, exact match; none = no CORS headers |
| `-idle-exit D` | default 0 (never) |
| `-idle D` | close a ready session after D without a request on its `/s/{id}/` mount (a pending `api/doc` long poll counts) and without a running job of its own; same as `DELETE /engine/sessions/{id}` (a `session` event with state `closed`, one log line, the cache entry stays). Opening and live (`follow`) sessions never. Default 0 (never) |
| `-detach` | keep running when stdin closes |

GC is set to 20 % unless `GOGC` is set (every session is a spill build).

**Auth and CORS.** Every request except `GET /engine/health` needs
`Authorization: Bearer <token>` (constant-time compare, 401 `unauthorized`).
CORS headers (`Access-Control-Allow-Origin`, `Vary: Origin`) only for origins
in `-allow-origin`, never `*`; preflights are answered before the token
check. The event stream needs the header, so clients read it with `fetch`,
not `EventSource`.

**Routes.** The control plane (`routes` in `internal/engine/server.go`):
health, `events` (SSE), `prompts/{id}`, `sessions` (open, list, get, close),
`jobs` (list, cancel), `cache` (list, remove one, wipe). `GET /engine/cache` is served from an in-memory listing (`cache_listing.go`) built by one scan and updated by the cache's own commits, removals and touches; it is trusted while the mtime of `<cache>/index` is the one it saw (and at least 50 ms old), so another process's `engine cache rm` is noticed on the next call. Per session
(`sessionRoutes` in `session.go`, mounted under `/s/{id}`): `api/doc`,
`api/report` (`internal/engine/report.go`), and the endpoints of
`internal/slice`: the 14 JSON ones (the 13 above and `api/plan`, `plan.go`)
and the line endpoints (`lines` incl. `annot=1`, `lines/at`, `at`, `search`,
mounted with `WithLines(co.Lines)`). Request and response
shapes, status codes and error codes are in `api/engine.openapi.yaml`
(protocol 1); `internal/engine/contract_test.go` walks `Server.Routes()` and
fails when a route is missing from the schema or the schema has a route the
engine does not serve (it also checks the protocol number and the schemas).
Change the YAML and the code together. Not built yet: ref, connections
(see `docs/PLAN-DESKTOP.md` § 2).

`api/report?format=text|json|csv|html` streams the CLI outputs of the
session's (aggregate) model: `report.Text` with the CLI's defaults (so no
executions tables, as `report -aggregate`), `report.JSON` without facts,
`report.ExportCSVZip` (same tables and bytes as `export`; calls, waits and
binds come from the spill through `report.CSVFacts` = `slice.FactSource`),
and the standalone HTML. `api/plan?stmt|sql_id&plh&exec` is `mtkprof plan`
(`report.SelectPlans`). `mtkprof serve` has the line endpoints and `plan` in
its slicing modes (`-spill`, `-facts=false`, `-slice`); plain `serve` keeps
the standalone `/api/lines`.

**Sessions, jobs, events, prompts**

* Session: one open trace set. `POST /engine/sessions {paths, options}`
  answers 202 `{session, job}`. States `opening → ready | failed`; `closed`
  only appears in the event of a `DELETE`. `identity` is the content identity
  of the files without options (the key annotations will use),
  `cacheIdentity` the cache entry, `hit` whether it opened without a parse,
  `rev` the document revision (1 for an opened trace; `?rev=` on `api/doc`
  is accepted and ignored there; it will increment when a reference bundle
  is applied; a live session counts its snapshots, see "Live sessions").
  `options.follow=true` makes a live session. Directories in `paths` are
  expanded as on the CLI, at most 1000 inputs.
* Job: a cancelable piece of work with its own `context.Context` (child of
  the engine's). Kind `open`; phases `parse` (unit bytes, `done/total`, plus
  `lines` and `statements`; progress from `model.Options.OnProgress`) →
  `index` (persisting the entry; miss only) → `ready`. Finished jobs stay
  listed (last 100). On a cache hit the job goes straight to `ready`.
* Events (`GET /engine/events`, SSE, `: mtkprof engine` comment first,
  keepalive comment every 15 s): `job`, `session`, `prompt`, `log`. A new
  subscriber gets the open prompts first; there is no replay of anything
  else, clients `GET` the lists after (re)connecting.
* Prompts: `internal/engine/prompts.go` is the one mechanism for asking the
  user a secret or a confirmation (`remote.Prompter`, `internal/remote`).
  `Ask` publishes a `prompt` event (`state: open`) and blocks until
  `POST /engine/prompts/{id}` with `{answer}` or `{cancel:true}`, or its
  context ends (`state: closed`). Nothing in an answer is logged. No caller
  yet; remote access (E7–E9) will be the first.
* Errors: `{"error":{"code","message"}}`; `bad_request` 400, `unauthorized`
  401, `not_found` 404, `conflict` 409, `cancelled` 409, `needs_prompt` 428,
  `internal` 500. The slice endpoints keep their plain-text 400s.

**Cancel mechanism (the cancel tee).** The builder has no context. `buildSession`
wraps the spill's tee sink in `cancelSink`: every 4096 facts it checks the
job context and, when cancelled, panics with `errCancelled`; `buildFiles`
recovers that (and any parser panic, as an error instead of taking the engine
down) and returns it. `OpenTrace` also checks the context before and after the
build, so a cancelled build is never committed: the build directory is
aborted and the session ends `failed` with `cancelled`. `DELETE
/engine/jobs/{id}` answers 202 and 409 when the job already finished.

#### Live sessions

`POST /engine/sessions {paths:[file], options:{follow:true, batchMs, batchMB}}`
follows a local growing file; `POST /engine/connections/{id}/follow {path,
options}` does it over the local mirror of a remote file that E7's follow job
writes (`<cache>/remote/<conn>/<name>`; the session waits until the job has
opened the mirror at its resume offset, `mirrorOnly:true` is the mirror
alone). Code: `internal/engine/live.go`, `internal/model/live.go`,
`internal/slice/spill_live.go`, `internal/trace/live.go`,
`internal/deepcopy`.

* **Not cached.** A growing file has no identity (`identity` and
  `cacheIdentity` are empty): the build spills into a temporary directory
  under `<cache>/live/` (`slice.NewSpill`, key `live`, so leftovers of a dead
  engine are removed by the next one) that `DELETE` removes. Reopen the file
  normally once it stops growing to get a cache entry.
* **Input.** One file, the builder `BuildFiles` uses for a single file
  (`model.NewLiveBuilder`), and the files it continues in. The parser reads a
  `tailReader` that never returns EOF: at the end of the file it polls (100
  ms, a quarter of `batchMs` if shorter) until more is written, so a line
  still being written waits for its newline (`tail -f` and the mirror deliver
  partial lines). A file that shrinks (truncated, replaced) fails the
  session; the end of a remote follow's mirror job fails it after the bytes
  the mirror wrote are parsed, with a last snapshot.
* **Chains.** When the current file has a `*** TRACE CONTINUES IN FILE x
  ***` marker (`(*Builder).ContinuesIn`) and the reader is at its end, it
  looks for x (`model.FindContinuation`, at most every 250 ms: the path in
  the marker, the same name next to the file, a `*.trc` there whose header
  names it; never a file of the chain already). Once x is there the reader
  returns EOF, the parser of the file ends (flushing its open records, as
  `BuildFiles` parses each file of a chain with its own parser), the
  builder takes `EndFile` and `ContinueLive(x)` (`NextFile` as a
  continuation, `Followed`; the first switch makes the build multi-file, so
  the header pid becomes `Context.Process`, also of the contexts so far),
  and a new parser reads x with its own line scan and line view. Snapshots
  take the current file's and the total statistics (`Snapshot(file,
  total, …)`), list every file and note the followed ones as `BuildFiles`
  does; a `log` and a `session` event go out at the switch. A remote
  follow (`liveSpec.follow`) starts a second follow job on the same
  connection for x's name in the remote file's directory (`runFollow` with
  `wait`: it polls `Stat` every 500 ms until the host has it); once that
  job has opened its local file, the first job is cancelled (its stream is
  closed, which stops `tail` on the host) and the reader waits until it has
  finished, reads what it wrote last, then switches. The session's end
  cancels the current and a pending mirror. `TestSnapshotOfChain`
  (`internal/model`: snapshots across the switch equal `BuildFiles` of the
  chain so far), `TestLiveFollowChain` (every slice and line endpoint of
  both files equals a normal open of the chain) and
  `TestLiveFollowRemoteChain` (lib transport: the first mirror is
  cancelled, the second cancelled by DELETE, nothing lingers on the host)
  cover it, on the real `midtrace_start` pair.
* **Snapshot point.** `bufio` calls `Read` only when no complete line is
  buffered, so inside `Read` every complete line has been delivered and the
  builder is between two records: that is where snapshots are taken, in the
  parser goroutine, with nothing to lock.
* **Snapshot** (`(*Builder).Snapshot`). The builder with its model and its
  first sink (the `analyze.Accumulator`) is deep-copied by reflection
  (`internal/deepcopy`: unexported fields, shared objects stay shared,
  strings and pointer-free blocks copied as blocks), the parser's open
  records (a cursor text, a PARSE ERROR text, a BINDS block:
  `Parser.Pending`) are handed to the copy, and the copy is finished
  (`EndFile`, `Finish`) as if the input ended there; the live builder goes
  on untouched. A new field of `Builder`, `Model` or the accumulator is
  copied automatically; one that must stay shared (a func, a channel) is
  shared, and an alias into the middle of another object (`openX` →
  `xbuf`) becomes a copy of its own, which the finishing code must not
  mind. `TestSnapshotEqualsPrefixBuild` (`internal/model`, ~150 cuts per
  fixture) and `TestLivePrefixesMatchOpen` (`internal/engine`, every slice
  and line endpoint at 7 cuts of 12 fixtures) prove a snapshot equals a
  normal open of the prefix, byte for byte.
* **Spill.** What the copy settles on finishing (the open XCTEND, the waits
  still looking for a call, the recursive calls still waiting for a parent)
  goes to a `slice.LiveOverlay` instead of the spill's sink: it writes those
  rows at their ids without counting them (the live build writes the same ids
  again when it settles them; a later parent clears an orphan mark), then
  `Source` writes the cached pages out (`pagedFile.sync`: no drop, no
  truncate) and returns a source over every row so far. Readers `ReadAt`
  the files while the build goes on writing; rows below a snapshot's counts
  only ever change to their settled values. The statement indexes are built
  at `Finish`, which a live build never reaches; a live spill
  (`SpillOptions.Live`) keeps a cursor index instead (`curIndex`,
  `calls.cur` / `waits.cur`): every row the build settles is appended to its
  cursor's list (the cursor of a settled row never changes, its statement
  can: an implicit cursor is adopted later). A cursor buffers up to 64k row
  numbers in memory, then writes them as a block; all buffers are written
  once they hold 1M ids together, so memory is bounded and nothing is
  rebuilt per snapshot. A snapshot's statement scan maps the statements to
  their cursors in its own model, adds the rows its overlay wrote (not
  settled, their cursor may still change), sorts and dedupes them below its
  row counts and reads those rows (more than 8M: a full scan, as for a
  finished spill). `TestLivePostings` (`internal/slice`, tiny buffers)
  checks at 25 cuts per fixture that the postings hold every row a full
  scan finds and that the scoped scan answers the same.
  Bind sets of the open BINDS block are left out of the copy (the next
  snapshot has them). The line index grows with the bytes read
  (`trace.LineScan`); each snapshot gets a view bounded by its line count.
* **Batches.** A snapshot is due when lines were added since the last one
  and `batchMs` (default 1000, 50..60000) has passed, or `batchMB` MiB of
  input (0 = off), never sooner than 3× the cost of the last snapshot
  (adaptive: a big state snapshots less often); the first one as soon as the
  reader has caught up with the file. Each swaps the session's handlers
  atomically (requests in flight finish on the snapshot they started on; old
  snapshots are garbage once unused), `rev++`, a `session` event
  `{state: live, rev}`, and job progress (`done` = bytes parsed).
* **States.** `opening` (until the first snapshot) → `live` → `failed` on a
  stream error (the last snapshot is still served) or `closed` by `DELETE`,
  which cancels the job (and a remote follow's mirror job), waits for the
  requests in flight and removes the spill. Job kind `live`, phase
  `follow`, ends `cancelled` on `DELETE`.
* **`api/doc`.** The latest snapshot, its revision in `X-Rev` (exposed to
  CORS). `?rev=N` with nothing newer than N waits up to 25 s for the next
  snapshot or the end of the follow (a long poll; compare `X-Rev`).
* **`mtkprof follow -serve`** (`cmd/mtkprof/fetch.go` `followServe`,
  `internal/engine/standalone.go`). The CLI runs an engine in-process
  (cache and live spill in a temporary directory, no token, no control
  plane): `FollowRemote(cl, path, local, options)` starts the follow job
  and the live session exactly as `POST /engine/connections/{id}/follow`
  does (`startRemoteFollow`, connection `""`; chain files next to `local`),
  and `SessionHandler(id)` serves the session's routes at the root, which
  the CLI mounts under `/api/` (GET and HEAD only) next to the UI at `/`.
  So its answers, `X-Rev` and the long poll are the engine's.
  `TestCLIFollowServe` (in-process SSH server, lib transport) follows the
  real `midtrace_start` pair through it.

Measured (`MTKPROF_BIG=… go test ./internal/engine -run LiveBig -v`; 100 MB
prefix of `big_loop.trc`): catch-up 1.3 s (one snapshot); a snapshot on
top of 100 MB costs 55-85 ms (deep copy ≈ 10-20 ms, finishing the copy
most of the rest, the document a few ms), far below the 1 s batch.
Latency from a write to a snapshot is ≤ poll (100 ms) + the rest of the
batch period + the snapshot; through the in-process SSH server on the lib
transport (500 ms SFTP poll) 0.2-1.0 s in `TestLiveFollowRemote`.

#### Persistent index cache

Code: `internal/engine/cache*.go`, `identity.go`; formats in
`internal/model/persist.go`, `internal/analyze/persist.go`,
`internal/slice/spill_persist.go`, `trace.LineIndex.Save`/`LoadLineIndex`, all
on the explicit binary helpers of `internal/binfmt` (not gob: unexported
fields, fragile type descriptors). The package comment of `cache.go` is the
API reference.

```
<cache>/index/<identity>/
  manifest.json                 written last
  dims.bin                      model.Encode: the model without the fact tables
  agg.bin                       analyze.Accumulator.Encode: what the document and text report are computed from
  calls.bin waits.bin bindsets.bin binds.bin bindvals.bin calls.stmt waits.stmt   the spill, unchanged layout
  spill.idx                     what the spill kept in memory: row counts, statement index layout, context row ranges
  lines-<i>.idx                 trace.LineIndex checkpoints of input file i (File.Files order)
```

Directories 0700, files 0600. An entry is built in `index/.build-<pid>-<random>`
and renamed into place after the manifest is written and every file synced;
`OpenCache` removes build directories of dead processes and entries without a
valid manifest, so a crash leaves nothing half-written. Several processes may
share a directory; the first commit of an identity wins.

**Identity.**

```
identity(file) = sha256(size ‖ first 1 MiB)                    size: 8 bytes little endian
identity(set)  = sha256(sorted file identities ‖ options)      options: format, bind mode, salt hash, thresholds hash, no-follow
```

A trace that was moved, renamed or fetched again hits the cache; order and
names of the files do not matter. Two files of equal size whose first MiB agree
but differ later collide: the price of not reading 2 GB to open from the cache.

| In the identity (a different value is a different entry) | Not in it |
|---|---|
| the input files' content identities | file names, paths, mtime |
| `CacheIndexFormat` | `-ref` bundle / `ApplyRef` (applied after every load; the model is stored before it, and it is not idempotent) |
| bind mode (`keep`, `redact`, `none`) | `-allow-origin`, `-cache-cap`, process flags |
| salt hash (`sha256("mtkprof-salt\0"+salt)`; the salt itself is never stored) | the plan-viz URL and other UI settings |
| sha256 of the finding thresholds (JSON; they shape the aggregates) | |
| no-follow (`CacheOpenOptions.NoFollow`: chain following off; the engine sessions always follow chains, so it is false there; `options.follow` of a session means live follow and is not this) | |

The identity without options (`engine.TraceIdentity`, the session's
`identity`) is what annotations will be keyed by. Live (`follow`) sessions
are not cached: a growing file has no stable identity.

**Validation.** `Lookup` reads `manifest.json` and requires: `indexFormat ==
CacheIndexFormat`; the directory name equals the manifest identity; the
identity recomputed from `inputs` and `options` equals the directory name;
at least one file; every file of the entry present with the recorded size.
Anything else removes the entry and is a miss. `Load` matches the entry's
source files to the paths the caller opened by content identity (so the
model shows the new paths and the line viewer reads the file where it is
now); a source that is not among them is read from its recorded path if it
still has its size, else `ErrCacheStale` and a rebuild. Any decoding error
is a miss too: the entry is removed and rebuilt, never a crash. Concurrent opens of one identity in a process wait for the first
build.

**LRU and pinning.** `lastUsed` is touched on every hit. After a build the
cache evicts least recently used entries until the total is at most
`-cache-cap`. Entries that a session has open (ref-counted by `Load`/`Close`)
and the entry just built are never evicted; `DELETE /engine/cache/{identity}`
answers 409 for an open one, `DELETE /engine/cache` skips them
(`{removed, skipped, bytes}`). The cap can therefore be exceeded while
sessions hold big entries. CLI for support, with no engine running:
`mtkprof engine cache ls|rm <identity-prefix>|wipe [-cache DIR]`.

**Format bumps.** An entry is a set of files whose formats are versioned
separately: `model.PersistVersion` (dims), `analyze.AccumPersistVersion`
(agg), `slice.SpillIdxVersion`, `trace.LineIndexVersion`, each checked in its
file header (`binfmt.ErrFormat` on mismatch). `CacheIndexFormat`
(`internal/engine/cache.go`) covers them as a whole and is part of the
identity and the manifest: bump it whenever any part changes, and old
entries are simply not found (they age out through the LRU or `engine cache
wipe`). `TestCacheIndexFormatCoversParts` fails when a part version changes without
`CacheIndexFormat` (update its expectation with the bump), and the
struct-shape guards (`TestAccumPersistCoversEveryField`,
`TestPersistCoversEveryField` in `internal/model`) fail when a field is added
without a bump. Current values: `CacheIndexFormat` 2, `PersistVersion` 1,
`AccumPersistVersion` 2, `SpillIdxVersion` 1, `LineIndexVersion` 1.

**Measured** (`big_loop.trc`, 118 MB, bind-heavy; `MTKPROF_BIG=… go test
./internal/engine -run Big -v`):

| | |
|---|---|
| first open (parse + persist) | ≈ 0.8 s |
| reopen from the cache | ≈ 32 ms, + 5 ms to build the document |
| RSS after reopen | ≈ 27 MB |
| entry size | ≈ the trace size (the spill dominates) |

`TestCacheRoundTrip` proves every slice endpoint answers byte-identically
from a persisted entry and from the in-memory source on every fixture;
`TestCacheHitAfterMoveAndRename`, `TestCacheOptionsAreSeparateEntries`,
`TestCacheEvictLRU`, `TestCacheManifestMismatchIsMiss`,
`TestCacheCrashLeavesNoHalfEntry` cover the rest.

#### Minimap

`stats.minimap` (`analyze.TraceMinimap`, `internal/analyze/minimap.go`) is
the overview strip of the UI: `{bucketUs, cpu[], waits{class: []}}`, at most
1024 equal buckets over the trace span (fewer when the span is shorter than
1024 µs). Attribution is by completion: a top-level call's whole CPU goes to
the bucket of its `tim`, a wait's whole elapsed time to the bucket of its
`tim`; nothing is spread. PX slaves attached to a coordinator are left out
like in `TraceProfile`, so Σ CPU equals the profile's CPU and Σ per class
equals the profile rows of that class. Both build modes produce it: exact
from the facts in a full build, from the accumulator's private cell grid
(100 µs cells) in an aggregate build, where an event can land up to one
bucket early. It is part of `agg.bin`, so a cache hit serves it without a
scan. Zoomed ranges ask `/api/timeline`.

### internal/analyze

* Resource profile (Millsap): CPU, each wait event, unaccounted-for, over any
  filter (whole file, one statement, one session, one time window).
* Statement table: tkprof-style call statistics + response-time ranking,
  with recursive children attached (nothing is lost when sorting).
* Executions: EXEC + following FETCHes grouped, with the bind set, rows,
  elapsed, waits — the unit for "why was *this* execution slow".
* Pivot (`pivot.go`): `Pivot(m, FactCalls|FactWaits, by, Filter)` groups the
  call or wait facts by dimensions and accumulates every measure. Dimension
  and measure ids, labels and semantics mirror `web/src/lib/views/Pivot.tsx`;
  `Filter` mirrors the UI's time-window / context / idle filters
  (`web/src/lib/state/store.ts`). Used by `mtkprof pivot`. The same file has
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
(`web/src/lib/data/load.ts`) detects `compare`, loads both `TraceDoc`s and the store
keeps `compare` + `side`; `doc` is the active side, so every view works on it
(`actions.setSide` maps the selected statement through the diff). The Compare
tab is `web/src/lib/views/Compare.tsx`; two executions of one statement are
compared in `web/src/lib/views/ExecCompare.tsx` (derived from the fact columns, no
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
cmd/mtkprof/        CLI (report, compare, pivot, json, html, serve, plan, refscript, findings-config, lint, export, engine); trace arguments are files and directories
internal/trace/     streaming parser (+ LineIndex with Save/Load)
internal/model/     model + builder (+ persist.go: binary encoding of the dimension tables)
internal/analyze/   aggregations (+ the streaming Accumulator of the aggregation-only mode, its persistence, the minimap)
internal/report/    text / json / csv renderers
internal/slice/     server-side slicing: in-memory and spill (disk, persistable) FactSources, the /api endpoints
internal/engine/    `mtkprof engine`: control plane (sessions, jobs, SSE events, prompts), persistent index cache, content identity
internal/binfmt/    explicit versioned binary reader/writer used by the persistence code
internal/remote/    remote-access plumbing shared by the engine and CLI subcommands (the Prompter interface)
internal/remote/db/ Oracle connection (go-ora): sessions, trace files, ADR fetch, DBMS_MONITOR, ref bundle
internal/ref/       embedded reference data (wait classes, command types, bind datatypes) + the reference-bundle loader
api/                engine.openapi.yaml (the engine protocol, checked by internal/engine/contract_test.go)
web/                Vite + TypeScript UI (web/vendor/ora-plan-core: vendored shared plan core)
  web/src/lib/      the UI library (views, components, data incl. ApiClient, state, styles); imported as @lib; never imports app/
  web/src/app/      the standalone shell (App, TopBar, Inspector, LineDrawer, urlstate) used by html and serve
testdata/           real 19c/21c/23ai fixtures (+ tkprof output as golden reference), generator scripts
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
