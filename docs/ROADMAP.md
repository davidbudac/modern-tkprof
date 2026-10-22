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
- JSON document for the UI (`mtkprof json`).
- Cross-compiles for linux/amd64, linux/arm64, windows/amd64, aix/ppc64,
  solaris/amd64 (pure Go).

## Next

1. **Web UI** (`web/`, Vite + TypeScript): overview (profile, timeline),
   statements table with drill-down, executions with binds, plans with row
   source stats, waits by event/object/file, recursive tree, session/module
   dimensions, time-window filtering. Embedded in the binary
   (`mtkprof serve`) and in a self-contained HTML (`mtkprof html`).
2. **Dimension slicing API**: generic group-by (statement × event × object ×
   module × time bucket × exec) exposed to the UI and as `mtkprof export`
   (CSV / NDJSON for DuckDB, Excel).
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
