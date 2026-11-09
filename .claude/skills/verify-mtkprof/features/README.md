# mtkprof verification map

Maintained source for verifying user-facing behavior of the mtkprof desktop app in dev browser mode. Read this index, then the matching feature file.

## Baseline preconditions

- Run `scripts/launch.sh` then `scripts/doctor.sh` (see `../SKILL.md`); require doctor exit 0. Never drive an instance this run did not start.
- Every drive starts from a fresh browser context: no trace open, default settings. The engine cache dir is empty at launch.
- Sample traces live in `/Users/davidbudac/claude_projects/modern-tkprof/testdata/traces/19c/`; always pass ABSOLUTE paths.

## Driving conventions

- Use `node scripts/drive.mjs` for single-shot journeys; copy and extend it for multi-step ones.
- Prefer the stable handles in the SKILL.md table (ids, roles, aria-labels) over coordinates or DOM order.
- Wait for named elements (`.session-tab-main`, `.session-nav .tabs button.tab`), not fixed sleeps.
- The app-only features (native file pickers, drag-drop, sidecar spawn, auto-update) are not reachable here; say so rather than substituting.
- Run `scripts/cleanup.sh` at the end; evidence stays in `/tmp/verify-mtkprof/evidence/`.

## Proof and skip reporting

- Proof for UI features: screenshot with the `mtkprof` brand and the tab visible, the ARIA snapshot, and `errors: []` in the JSON summary.
- Report an unreachable path with the attempted command and the unmet precondition.

## Features

- [Open a trace](./open-trace.md) covers the start page path form, multi-file sets, bad paths and the recent list.
- [Lines view](./lines-view.md) covers the raw trace text viewer, search and persisted prefs.
- [Analysis views](./analysis-views.md) covers Overview, Statements, Waits, Blocks, Timeline, Sessions and Pivot.
- [App pages](./app-pages.md) covers Settings and Connections.
- [Import names](./import-names.md) covers the names script dialog (I/O map, statement inspector, Connections › Reference data).
