<img src="assets/icon.svg" width="64" height="64" alt="">

# mtkprof

A modern analyzer for Oracle SQL trace files (event 10046 / `DBMS_MONITOR` /
`sql_trace`). It does what `tkprof` and TVD$XTAT do, then goes further: the
whole trace becomes a dimensional model (statements, cursors, calls, waits,
binds, plans, sessions, time) that you can profile, slice and explore in an
interactive UI, offline, from one file.

* **One static binary** for Linux, Windows, AIX and Solaris. Copy it next to
  the trace file like `tkprof`.
* **Fast**: ~350 MB/s parse; a 118 MB trace is reported in under a second.
* **Exact**: call statistics, library cache misses and wait tables match
  Oracle's own `tkprof` on every fixture (`internal/golden`), while keeping
  what tkprof throws away: per-execution binds, recursive hierarchy, commits,
  LOB calls, session/module/action context, wall-clock time.
* **Interactive**: `mtkprof trace.trc` writes the text report and a single
  self-contained HTML file with the explorer and the data inside; nothing leaves the machine.

## Usage

```
mtkprof trace.trc                        # trace.trc.txt (text report) + trace.trc.html (interactive), next to the trace
mtkprof report trace.trc                 # text report (profile, statements, executions, binds, plans, sessions, time buckets)
mtkprof report trace.trc -sort cpu -top 20 -binds 3 -execs 10   # -execs N: executions listed per statement (0 none, -1 all)
mtkprof pivot  trace.trc -fact waits -by event,obj -top 10       # group-by like the UI Pivot; -by '?' lists dims/measures
mtkprof pivot  trace.trc -by module,stmt -measure e,c,count -window 10:15:00,10:20:00 -csv
mtkprof html   trace.trc                 # trace.html: interactive report, self-contained
mtkprof serve  trace.trc                 # same UI served at http://127.0.0.1:8046/
mtkprof json   trace.trc -o trace.json   # the full document (dimension tables + fact columns)
mtkprof findings-config > f.json       # default finding thresholds; edit, then pass -findings-config f.json to report/html/serve/json
mtkprof plan   trace.trc -list          # statements with STAT plans (sql_id, plan hash, dumps, root cost/time)
mtkprof plan   trace.trc -sql_id 70qh8zxg4kk69 -o plan.json   # plan(s) as JSON rows for ora-explain-plan-viz; -plan-hash, -exec N
mtkprof plan   trace.trc -sql_id 70qh8zxg4kk69 -viz           # "Open in plan viz" link (plan stays in the URL fragment)
mtkprof refscript trace.trc -o ref.sql  # SQL*Plus script for the DBA: names for the trace's obj#/file#/uid, DBMS_XPLAN per sql_id (-lite: ALL_ views only)
mtkprof report trace.trc -ref ref/       # apply the spooled bundle (also html, serve, json, export, pivot, plan): object/datafile/user names + DBMS_XPLAN
mtkprof compare a.trc b.trc -n 30       # text report of B against A: totals, profiles, changed/new/missing statements, wait events
mtkprof serve  a.trc b.trc -compare      # the UI with a Compare tab (also html, json): A/B toggle in the top bar switches the trace the views show
mtkprof lint   trace.trc                 # what the parser saw: line kinds, events, unknown lines
mtkprof report a.trc b.trc dir/          # several files / directories = one trace set (see "Trace sets")
```

### Following a growing trace

```
mtkprof follow oracle@dbhost /u01/.../cdb1_ora_4711.trc -o live.trc          # mirror it (tail -f over ssh); Ctrl-C stops, rerun resumes
mtkprof follow oracle@dbhost /u01/.../cdb1_ora_4711.trc -serve                # live report at http://127.0.0.1:8046/ while it grows
mtkprof follow oracle@dbhost /u01/.../cdb1_ora_4711.trc -serve=127.0.0.1:9000 -o live.trc -batch-ms 2000
```

`-serve` parses the stream as it arrives and serves the report of everything
so far: the browser UI at `/` (reload for newer data) and the engine's
per-session `/api/*` routes (read-only), a new snapshot at most every
`-batch-ms` (default 1000). `GET /api/doc` carries the snapshot's revision in
`X-Rev`; `GET /api/doc?rev=N` waits up to 25 s for a newer one. When the
trace continues in another file (`*** TRACE CONTINUES IN FILE x ***`), x is
mirrored next to the first and followed too. The mirror is temporary unless
`-o` names it. It listens on 127.0.0.1 unless `-serve=ADDR` says otherwise.
Details: `docs/REMOTE.md`, `docs/ARCHITECTURE.md` ("Live sessions").

### Engine (desktop app backend)

`mtkprof engine` is the local backend of the desktop app (`mtkprof-desktop`):
one process that holds several open traces, answers the same `/api/*`
endpoints as `serve -spill` for each of them at `/s/{id}/`, and keeps an
index of every trace it has opened, so opening it again takes milliseconds.
It is not meant for interactive use; run it by hand to try the protocol:

```
export MTKPROF_TOKEN=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')   # 32+ bytes, required
mtkprof engine -detach &                  # prints {"ready":true,"addr":"127.0.0.1:PORT",...}; -cache DIR, -cache-cap 20G, -allow-origin, -idle-exit, -idle
curl -H "Authorization: Bearer $MTKPROF_TOKEN" -d '{"paths":["trace.trc"]}' http://127.0.0.1:PORT/engine/sessions
mtkprof engine cache ls                   # also: rm <identity-prefix>, wipe (-cache DIR)
```

The index cache lives in `<user cache dir>/mtkprof/index/` (e.g.
`~/.cache/mtkprof` on Linux), about as large as the traces, evicted least
recently used above 20 GB. Entries are keyed by file content (size and the
first MiB), not by path. The protocol is `api/engine.openapi.yaml`; details in
`docs/ARCHITECTURE.md` ("Engine mode").

### Claude Code (and other MCP clients)

`mtkprof mcp` serves the analysis tools over MCP on stdin/stdout, so an agent
can analyse traces from a description of the problem:

```
claude mcp add -s user mtkprof -- mtkprof mcp     # once; -binds keep to show bind values
```

Then ask in Claude Code, for example "the batch traced in
/u01/diag/.../orcl_ora_4711.trc got slow after 14:05, why?". The agent opens
the trace with `open_trace` (files or a directory, absolute paths) and works
with `overview`, `statements`, `statement`, `executions`, `pivot`, `timeline`,
`lines` and `search_lines`. Their answers are the numbers of the UI, parsed in
process; nothing leaves the machine except what the agent sends its model.
Bind values are masked (type, length, a hash salted per server); SQL text is
not. `mtkprof mcp <trace...>` opens those traces on the first tool call.

### Desktop app

The desktop app (private repo `davidbudac/mtkprof-desktop`, a Tauri shell that
runs `mtkprof engine` as a sidecar and pins this repo as a submodule) opens
traces in tabs, fetches them over ssh or from the database, and adds Lines,
notes, reports and saved pivots. Install, unsigned-build steps and a guide:
[`docs/DESKTOP.md`](docs/DESKTOP.md); remote access and grants:
[`docs/REMOTE.md`](docs/REMOTE.md).

### Trace sets

A trace can be several files. Every command that takes a trace accepts any
number of files and directories (a directory contributes its `*.trc`, not
recursive, sorted):

```
mtkprof report trace_part1.trc trace_part2.trc      # one logical trace
mtkprof html   /u01/.../trace/ -o all.html          # all *.trc in a directory
mtkprof report qc.trc cdb1_p000_8505.trc            # query coordinator + PX slave
mtkprof report start.trc -no-follow                 # do not follow split-file chains
```

* **Split traces** (`*** TRACE CONTINUES IN FILE x ***` at the end of a file,
  `*** TRACE CONTINUED FROM FILE x ***` at the start of the next) are followed
  automatically, even from one end only: the named path, else its name next to
  the file, else among the inputs, else a neighbour whose own `Trace file`
  header has that name. The files are parsed as one stream, so calls after the
  split still belong to cursors opened before it. `-no-follow` disables this.
* **Independent files** are separate sessions: each file's process and session
  become session contexts, the same as in `trcsess` output (`FILES` in the
  text report, `file.files` / `contexts[].fileIdx` in the JSON).
* **PX slaves** (`...p000...` traces) are attached to their query coordinator
  by time window, client id, module and action. They are shown nested under
  it, and their work is reported as `PX slaves: N sessions, X s` on the
  statement instead of being added to the coordinator's response time.
  Pivot, timeline and the UI's fact-based views still contain the slaves'
  calls (separate contexts); filter on the context to separate them.

Bind values are kept by default. On `report`, `html`, `serve`, `json` and
`export`, `-redact-binds` (or `-bind-values redact`) replaces each value with
its type, length and a stable hash, e.g. `<VARCHAR2 len=11 h=a2334142>`, so
equal values stay recognisable across executions; `-binds none` (or
`-bind-values none`) drops bind values entirely. On `report`, `-binds N` still
sets how many bind sets to print per statement. The hash is for correlation,
not secrecy: short values (numbers, codes) can be recovered by brute force,
and SQL text, including its literals, is not redacted. `-redact-salt <string>`
(implies redaction) mixes a salt into the hash: equal values still match across
traces redacted with the same salt, but tokens cannot be looked up in a table of
hashes of known values without it.

Big traces: a 1 GB trace takes about 7 s and 2 GB of memory for the HTML
report (and the text report about 6 s; 10 GB: about a minute, ~20 GB) (see `docs/ARCHITECTURE.md`, "Memory and
size"). `-lowmem` (`report`, `pivot`, `html`, `json`, `serve`, `export`) does
not retain bind values: no BINDS sections, no binds column in the executions
tables, no bind evidence in findings, no `binds.csv` rows and no bind views in
the UI. Every other number is identical; calls and waits are always kept, because
every aggregation reads them (unless you use `-aggregate`, below). `html`/`serve`/`json` also take `-facts=false` to
leave the raw fact tables (and with them the UI's drill-down) out of the
document. For `html`/`json` that makes the Pivot, Timeline, executions and
event drill-downs unavailable; for `serve` it does the opposite: with
`mtkprof serve huge.trc -facts=false` (or `-slice`) the server keeps the parsed
model and answers the UI's group-by and detail queries itself (`/api/pivot`,
`/api/timeline`, `/api/executions`, ...), so the browser loads a document of a
few hundred kB and stays fully interactive on a trace whose fact tables would
be millions of rows. The server then holds the model in memory (big_loop,
118 MB trace: ~300 MB RSS instead of ~40 MB), and `Download CSV` of the Pivot
asks it for every group.

For traces of 10 GB and up use `-aggregate` (`report`, `html`, `json`, `serve`;
implies `-lowmem` and `-facts=false`): calls and waits are folded into
aggregates while the trace is read and never stored, so memory is independent
of the trace size (a 10 GB trace: about 0.5 GB, 32 s, instead of ~20 GB).
Statement call tables, resource profiles, sessions, time buckets, recursive
links and findings are the same as without it. Left out: the per-execution
tables and bind sections of the text report (the `Executions: n, min, avg, max,
slowest` line stays) and the raw fact tables of the document (no drill-down,
no Pivot; `serve -aggregate` serves the document without slicing). The report
header says so. Details: `docs/ARCHITECTURE.md`, "Aggregation-only mode".

To keep the drill-down on such a trace use `serve -spill` (or `-spill=DIR` for a
directory with room; the default is the system temp dir). It reads the trace
like `-aggregate` (memory independent of the trace) and writes calls, waits and
bind values to fixed-width temporary files, about the size of the trace, while
reading; Pivot, Timeline, executions with bind values and the event drill-downs
are answered from them by sequential scans (a statement's executions through an
index). A 1 GB trace serves in 66 MB RSS (160 MB at the peak of the build) with
the Pivot in about 0.3 s, against 1.9 GB for `-facts=false`. The files are
removed on exit (also on Ctrl-C), and leftovers of a crashed run on the same
trace on the next start; `-lowmem` leaves out the bind values, `-bind-values
redact` writes them redacted. Details: `docs/ARCHITECTURE.md`, "Spill mode".

Reference bundle: a trace carries only numbers (obj#, file#, user ids) and
no plan text. `mtkprof refscript` writes a read-only SQL*Plus script tailored
to the trace; the DBA runs it and `-ref dir` applies what it spooled to every
output. Only `mtkprof ref -db` (same queries, run directly) and the `trace` /
`fetch -db` commands connect to a database. See `docs/REF-BUNDLE.md` and
`docs/REMOTE.md`.

### The report

The text and HTML reports share one model:

* **Resource profile** (Millsap): response time = CPU + each wait event +
  unaccounted-for, for the whole trace, per statement, or for any time window.
* **Statements** ranked by response time *including* their recursive children
  and the idle time between their calls; the call table shows tkprof-style
  exclusive numbers with an inclusive toggle.
* **Executions**: every EXEC with its fetches, elapsed, rows and bind values,
  so the slow one with the odd bind is one click away.
* **Plans**: row-source statistics from the STAT lines, one per plan hash,
  with the hot steps highlighted.
* **Waits**: by event, class, object, file, statement; duration histograms.
* **Timeline**: activity over time; brush a window and every view follows.
* **Sessions**: module / action / client id / service / session contexts, with
  filtering (trcsess merges included).
* **Compare** (two traces, before/after a change): `mtkprof compare a.trc b.trc`
  or `html|serve|json a.trc b.trc -compare`. Statements are matched by sql_id
  (statements without one by kind and normalised text), wait events by name.
  The Compare tab shows totals (A, B, Δ with a coloured sign), both profiles on
  one time scale, the statements ranked by |Δ elapsed| (new, missing, slower,
  faster, plan changed) and the wait-event deltas; click a statement to open it
  in the Statements workbench of trace A or B (A/B toggle in the top bar).
  In the Statements workbench any two executions of one statement can be ticked
  (or shift-clicked) for an "Execution A vs B" panel: call statistics, waits by
  event, bind values (differing ones highlighted) and plan hash.
* **Pivot**: pick a fact table (calls or waits), one or two dimensions and the
  measures; download as CSV. `mtkprof pivot` gives the same group-by on the
  command line (any number of `-by` dimensions up to 4, `-window` as wall
  clock or seconds from the start, `-context` ids from the SESSIONS section).

## Build

Needs Go 1.24+ (pure Go, no cgo). The web UI needs Node 20+ and pnpm, but a
pre-built UI is committed, so `go build` alone produces a working binary.

```
make build          # bin/mtkprof for this machine
make test           # unit + golden tests
make web            # rebuild the UI and embed it (web/ -> internal/ui/dist)
make release        # dist/mtkprof-<os>-<arch> for every target + SHA256SUMS;
                    # plus mtkprof-lite-<os>-<arch> (linux, aix, solaris): built with
                    # -tags nooracle, no Oracle client code, ~12 MB instead of ~27 MB,
                    # for database hosts where the trace files are local
```

Cross-compiling by hand:

```
GOOS=aix GOARCH=ppc64 go build -o mtkprof-aix ./cmd/mtkprof
GOOS=windows GOARCH=amd64 go build -o mtkprof.exe ./cmd/mtkprof
```

## Trace files

Oracle 19c, 21c and 23ai (tested against real traces and `tkprof` output for
all three; 12c mostly works, untested). The parser understands
every line kind of the 19c format, including bind memory dumps, truncated and
split files, `trcsess` output and PX slave traces, plus the 21c / 23ai
differences; see `docs/trace-format-19c.md`. Enable tracing with, for example:

```sql
alter session set tracefile_identifier = 'mytest';
alter session set events 'sql_trace wait=true, bind=true, plan_stat=all_executions';
-- or: exec dbms_monitor.session_trace_enable(waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS')
-- ... run the workload ...
alter session set events 'sql_trace off';
select value from v$diag_info where name = 'Default Trace File';
```

## Repository

```
cmd/mtkprof/        CLI
internal/engine/    `mtkprof engine`: sessions, jobs, persistent index cache
internal/trace/     streaming line parser
internal/model/     dimensional model + builder
internal/analyze/   profiles, statement statistics, executions, timelines
internal/report/    text report, JSON document
internal/ui/        embedded web UI (built from web/)
internal/golden/    comparison against tkprof output
web/                Vite + React + TypeScript explorer (src/lib: shared UI library, src/app: standalone shell)
api/                engine protocol (OpenAPI)
testdata/           real 19.27 traces, tkprof output, generator scripts, v$ exports
docs/               architecture, trace format reference, roadmap
site/               website: landing page and documentation (static, see site/README.md)
```

## Status

Early. The parser and model are solid (tested against real traces and
tkprof); the UI is a first version. See `docs/ROADMAP.md`.

## Licence

Apache-2.0, see `LICENSE`.
