# Roadmap

## Done (v0.1 core)

- Streaming parser for every 19c line kind (see `trace-format-19c.md`),
  zero unknown lines on the real fixtures, ~340 MB/s.
- Dimensional model: statements, cursor instances, calls with recursive
  hierarchy and self-time, waits attributed to calls (in-call vs between
  calls), bind sets, STAT plans, transactions, errors, session contexts,
  wall-clock anchoring, trcsess multi-session files, split/truncated files.
- Golden tests: call statistics, library cache misses and wait tables match
  Oracle's `tkprof` on all 19 fixtures (`internal/golden`).
- Text report: resource profile (Millsap), statements ranked by response time
  with recursive children, per-statement call table (tkprof-compatible
  exclusive numbers), profile, wait detail by object, executions, binds,
  plans, recursive links, errors.
- JSON document for the UI (`mtkprof json`): dimension tables + fact tables
  as gzip-packed typed columns (118 MB trace -> 6.5 MB document).
- **Web UI** (`web/`, Vite + React + TypeScript, embedded in the binary via
  `mtkprof serve`, standalone via `mtkprof html`): Overview (response-time
  profile bar, stat strip, activity timeline with window brushing, resource
  profile, top statements), Statements table + inspector (SQL, response-time
  profile, self/inclusive call table, executions with binds, plans, recursive
  links, errors), Waits + event inspector (log histogram, by statement /
  object / p1), Timeline swimlane of calls, Sessions (contexts, roll-ups,
  context filter), Pivot (calls or waits × one or two dimensions × measures,
  CSV download). Light and dark, keyboard navigation in tables.
- `mtkprof export`: CSV tables (statements, cursors, contexts, events, calls,
  waits, binds, plan lines, transactions, errors) for DuckDB / Excel / Python.
- CI workflow: tests, web build check, release binaries on tags.
- Cross-compiles for linux/amd64, linux/arm64, windows/amd64, aix/ppc64,
  solaris/amd64 (pure Go).

## Next

1. **UI polish**: raw trace line viewer (jump to line from any row; needs the
   server or an embedded line index), resizable inspector, column chooser,
   URL state (deep links to a statement / window), bind-value search,
   wait-event scatter over time, "compare two executions".
2. ~~**Server-side slicing** for huge traces~~ (done): `serve -facts=false`
   answers the UI's group-by and detail queries from the model
   (`internal/slice`), the browser never holds the fact rows.
3. **Multi-file input**: follow `TRACE CONTINUES IN FILE`, merge PX slave
   traces with the QC trace, accept directories.
4. **Memory**: 118 MB trace -> ~600 MB RSS. Compact the fact structs, intern
   more, add an aggregation-only mode for multi-GB files, optionally spill
   facts to disk.
5. **Bind value decoding**: TIMESTAMP / TSTZ / INTERVAL memory dumps, RAW,
   collections; typed values in JSON.
6. **Reference data at runtime**: optional `--objects objects.csv` /
   `--datafiles` to map obj# and file# to names (query templates provided).
7. **More formats**: 12.1/12.2 traces (should mostly work, untested),
   23ai additions, Windows trace files, `RPC CALL` lines, LOB write ops.
8. **Compare mode**: two traces side by side (before/after a change).
9. **Packaging**: GitHub release workflow building all targets, checksums.
