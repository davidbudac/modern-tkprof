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
* **Interactive**: `mtkprof html trace.trc` writes a single self-contained
  HTML file with the explorer and the data inside; nothing leaves the machine.

## Usage

```
mtkprof report trace.trc                 # text report (profile, statements, executions, binds, plans, sessions, time buckets)
mtkprof report trace.trc -sort cpu -top 20 -binds 3 -execs 10   # -execs N: executions listed per statement (0 none, -1 all)
mtkprof pivot  trace.trc -fact waits -by event,obj -top 10       # group-by like the UI Pivot; -by '?' lists dims/measures
mtkprof pivot  trace.trc -by module,stmt -measure e,c,count -window 10:15:00,10:20:00 -csv
mtkprof html   trace.trc                 # trace.html: interactive report, self-contained
mtkprof serve  trace.trc                 # same UI served at http://127.0.0.1:8046/
mtkprof json   trace.trc -o trace.json   # the full document (dimension tables + fact columns)
mtkprof plan   trace.trc -list          # statements with STAT plans (sql_id, plan hash, dumps, root cost/time)
mtkprof plan   trace.trc -sql_id 70qh8zxg4kk69 -o plan.json   # plan(s) as JSON rows for ora-explain-plan-viz; -plan-hash, -exec N
mtkprof plan   trace.trc -sql_id 70qh8zxg4kk69 -viz           # "Open in plan viz" link (plan stays in the URL fragment)
mtkprof refscript trace.trc -o ref.sql  # SQL*Plus script for the DBA: names for the trace's obj#/file#/uid, DBMS_XPLAN per sql_id (-lite: ALL_ views only)
mtkprof report trace.trc -ref ref/       # apply the spooled bundle (also html, serve, json, export, pivot, plan): object/datafile/user names + DBMS_XPLAN
mtkprof lint   trace.trc                 # what the parser saw: line kinds, events, unknown lines
mtkprof report a.trc b.trc dir/          # several files / directories = one trace set (see "Trace sets")
```

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

Reference bundle: a trace carries only numbers (obj#, file#, user ids) and
no plan text. `mtkprof refscript` writes a read-only SQL*Plus script tailored
to the trace; the DBA runs it and `-ref dir` applies what it spooled to every
output. mtkprof never connects to a database. See `docs/REF-BUNDLE.md`.

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
make release        # dist/mtkprof-<os>-<arch> for every target + SHA256SUMS
```

Cross-compiling by hand:

```
GOOS=aix GOARCH=ppc64 go build -o mtkprof-aix ./cmd/mtkprof
GOOS=windows GOARCH=amd64 go build -o mtkprof.exe ./cmd/mtkprof
```

## Trace files

Oracle 19c and later (12c mostly works, untested). The parser understands
every line kind of the 19c format, including bind memory dumps, truncated and
split files, `trcsess` output and PX slave traces; see
`docs/trace-format-19c.md`. Enable tracing with, for example:

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
internal/trace/     streaming line parser
internal/model/     dimensional model + builder
internal/analyze/   profiles, statement statistics, executions, timelines
internal/report/    text report, JSON document
internal/ui/        embedded web UI (built from web/)
internal/golden/    comparison against tkprof output
web/                Vite + React + TypeScript explorer
testdata/           real 19.27 traces, tkprof output, generator scripts, v$ exports
docs/               architecture, trace format reference, roadmap
```

## Status

Early. The parser and model are solid (tested against real traces and
tkprof); the UI is a first version. See `docs/ROADMAP.md`.
