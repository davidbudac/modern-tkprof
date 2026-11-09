# Roadmap

## Done (v0.1 core)

- Streaming parser for every 19c line kind (see `trace-format-19c.md`),
  zero unknown lines on the real fixtures, ~340 MB/s.
- Dimensional model: statements, cursor instances, calls with recursive
  hierarchy and self-time, waits attributed to calls (in-call vs between
  calls), bind sets, STAT plans, transactions, errors, session contexts,
  wall-clock anchoring, trcsess multi-session files, split/truncated files.
- Golden tests: call statistics, library cache misses and wait tables match
  Oracle's `tkprof` on every fixture with a tkprof output (`internal/golden`;
  29 for 19c, 19 each for 21c and 23ai).
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
- Local CI and release scripts (`scripts/ci-local.sh`, `scripts/release-local.sh`): tests, web build check, release binaries.
- Cross-compiles for linux/amd64, linux/arm64, windows/amd64, aix/ppc64,
  solaris/amd64 (pure Go).

## Current desktop follow-up (2026-10-29)

Implemented in the desktop and its pinned engine, beyond the original core list:

- Multi-file/PX input, runtime reference bundles, line drill-down, resizable panes,
  saved pivots, execution comparison, persistent cache and remote fetch/live follow.
- Compare two ready non-live desktop tabs through `GET /engine/compare`: whole-trace
  snapshot using the existing comparison analyzer; source statement navigation is guarded
  by content identity. Snapshots are not restored after quitting the desktop.
- Window percentages retain whole overlapping calls and explain values above 100%;
  pending scope queries no longer reuse unrelated scope totals. Window actions appear once.
- Opt-in investigation backups (notes/bookmarks, selected settings and workspace references),
  and accessible tab reordering in the desktop.

Remaining work:

1. Native platform coverage: Windows at all since the Electron switch (install, removal of a Tauri
   install, large-trace interaction, SSH prompts), Intel macOS hardware, and installer-level checks
   (building an installer is not installing it).
2. Remote compatibility: TCPS, AIX/Solaris scripts and older Oracle trace formats. Use the
   specific remaining checks in `REMOTE.md`; do not infer support from compilation.
3. Comparison enhancements: persisted comparison workspaces, filtered comparisons,
   comparison report export and cross-trace execution drill-down.
4. Deferred product features: partial documents during parse and detachable windows.

The list below is the original roadmap, retained as history rather than a current backlog.

## Original next list (historical)

1. **UI polish**: raw trace line viewer (jump to line from any row; needs the
   server or an embedded line index), resizable inspector, column chooser,
   URL state (deep links to a statement / window), bind-value search,
   wait-event scatter over time, "compare two executions".
2. ~~**Server-side slicing** for huge traces~~ (done): `serve -facts=false`
   answers the UI's group-by and detail queries from the model
   (`internal/slice`), the browser never holds the fact rows.
3. **Multi-file input**: follow `TRACE CONTINUES IN FILE`, merge PX slave
   traces with the QC trace, accept directories.
4. **Memory**: ~~118 MB trace -> ~600 MB RSS~~ (done: compact facts, and
   `-aggregate`, an aggregation-only mode that keeps no calls or waits;
   a 10 GB trace in ~0.5 GB, and ~~spilling the facts to disk for drill-down~~
   done: `serve -spill`, a 1 GB trace drillable in 66 MB RSS).
5. ~~**Bind value decoding**~~ (done): TSLTZ / INTERVAL memory dumps (and
   TIMESTAMP / TSTZ / DATE dumps), RAW, ROWID; `kind` / `typed` in JSON.
   Collections (dty 123) stay hex dumps.
6. **Reference data at runtime**: optional `--objects objects.csv` /
   `--datafiles` to map obj# and file# to names (query templates provided).
7. **More formats**: 21c and 23ai are done (docker fixtures, `testdata/traces/21c`,
   `23ai`, differences in `docs/trace-format-19c.md`; PX on 21c/23ai is untested
   as XE/Free have no parallel execution). Open: 12.1/12.2 traces (should mostly
   work, untested), Windows trace files, `RPC CALL` lines, LOB write ops.
8. **Compare mode**: two traces side by side (before/after a change).
9. **Packaging**: `scripts/release-local.sh` builds all targets with checksums and creates the GitHub release.
10. **Desktop app** (`docs/PLAN-DESKTOP.md`): `mtkprof engine` sidecar with
    persistent index cache, progress, minimap, line drill-down (`at`,
    `search`), SSH/ADR fetch and live follow, DB trace control, the same
    fetchers as CLI subcommands; Tauri 2 shell in `mtkprof-desktop`
    (internal team, Windows/macOS/Linux).
11. **Three new views** (`docs/PLAN-VIEWS.md`, concept study `docs/viz-concepts/`):
    Row flow (Sankey of a plan dump in the statement inspector), Dialogue
    (sequence diagram of one execution), Blocks (the I/O address space, new
    tab and `api/io/map` endpoint). Planned 2026-11-03; Row flow, Dialogue and Blocks done 2026-11-03.
