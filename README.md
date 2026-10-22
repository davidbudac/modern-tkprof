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
mtkprof report trace.trc                 # text report (resource profile, statements, binds, plans)
mtkprof report trace.trc -sort cpu -top 20 -binds 3
mtkprof html   trace.trc                 # trace.html: interactive report, self-contained
mtkprof serve  trace.trc                 # same UI served at http://127.0.0.1:8046/
mtkprof json   trace.trc -o trace.json   # the full document (dimension tables + fact columns)
mtkprof lint   trace.trc                 # what the parser saw: line kinds, events, unknown lines
```

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
  measures; download as CSV.

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
