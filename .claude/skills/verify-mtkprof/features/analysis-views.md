# Analysis views

Once a trace is open the header row (right of the tabs) offers Overview, Statements, Waits, Blocks, Timeline, Sessions and Pivot (plus Compare when two traces are compared, and Notes/Reports under `Tools`). Each summarises the trace from a different angle.

## Sub-features

- `view-overview` Overview shows the trace summary, a Timeline and a Statements panel.
- `view-statements` Statements shows a list (`aside[aria-label="Statements"]`) and detail pane.
- `view-statements-dialogue` one picked execution's `Binds | Dialogue` control (`[aria-label="Execution detail"]`); Dialogue draws `.dlg-svg`.
- `view-waits` Waits shows `Wait events` with a `hide idle` toggle.
- `view-statements-jump` the inspector's `[aria-label="Show this statement as"]` group: `Row flow` (plans to Flow, scrolls to the plan), `Dialogue` (the slowest execution in Dialogue mode, scrolled to), `Blocks` (the Blocks view with an `only <sql_id>` chip). The inspector's Waits list has an `in Blocks` link on block-I/O events (chips for the statement and the event); the Waits view's event detail has a `Blocks` row (an `only <event>` chip). A statement of one execution opens it.
- `view-blocks` Blocks shows the heading `Blocks` with "N block I/O waits · M files", one `.bm-panel` per file (a canvas and an `svg.bm-overlay`), the `By statement` facts column, and the toolbar: `[aria-label="Colour the marks by"]` (event / object / statement), `[aria-label="x axis"]` (I/O order / time), `select[aria-label="At most this many marks"]` (5,000 / 20,000 / 100,000). Empty traces (level_1) show `.bm-empty`.
- `view-timeline` Timeline shows lanes, the `Call kinds` legend and `Longest calls`.
- `view-sessions` Sessions shows `Session contexts` and a roll-up (`select[aria-label="Roll-up dimension"]`).
- `view-pivot` Pivot shows a pivot table.

## How to get to it (user POV)

- Click the view name in the views bar after opening a trace.
- Compare two open traces from the start page card `Compare two open traces`, or a tab's right-click menu (needs two ready, non-live tabs).

## Driving it with Playwright (scripts/drive.mjs)

Preconditions:

- A trace is open (`$T/level_8.trc`).

- **One view.** `node $S/drive.mjs --open $T/level_8.trc --view <Name> --name <name>` for each of Overview, Statements, Waits, Timeline, Sessions, Pivot. The named button becomes `aria-current=page`, the JSON has `errors: []`, and the screenshot shows the heading from the sub-feature list. (Statements and Waits were driven and ran clean with no console errors; the others are not yet driven.)
- **Dialogue.** `node $S/drive.mjs --open $T/io_waits.trc --view Statements --name dialogue --viewport 1440x1300 --click 'aside[aria-label="Statements"] >> text=52nzchs09dgn1' --click 'section:has(> header h2:text-is("Executions")) tr.row-click' --click '[aria-label="Execution detail"] button:has-text("Dialogue")' --click '.dlg-scale h4'` (the last click scrolls the figure into view): a `loop × 200` frame, the facts line "time to first row 2.450 s of 2.799 s". Driven 2026-11-03, `errors: []`. A mark's popover closes on any scroll (like every `usePopover` popup) and a bare `--click` may scroll the pane during the click: to pin one, `scrollIntoViewIfNeeded()` the mark first, then `click()`.
- **Idle toggle.** In Waits click `--click 'button:has-text("hide idle")'`; its `aria-pressed` flips and the event list changes.
- **Row flow.** `--open $T/io_waits.trc --view Statements --click 'aside[aria-label="Statements"] >> text=7r10y07tqpg98' --click '[aria-label="Plan view"] button:has-text("Row flow")'` (or the inspector's `.stmt-views button:has-text("Row flow")`): the plan section shows the Sankey (`.rf-fig`; node labels `.rf-label[data-node="<index in the dump>"]`, `--click` one to highlight its path; the scale is `[aria-label="Band scale"] button:has-text("linear")`). Driven 2026-11-03, no console errors.
- **Entry points.** `--open $T/io_waits.trc --view Statements --click 'aside[aria-label="Statements"] >> text=7r10y07tqpg98' --click '.stmt-views button:has-text("Dialogue")'` (then `Row flow`, `Blocks`), and Waits → `direct path read temp` → `the file blocks these waits read or wrote`. Driven 2026-11-03, `errors: []`.
- **Blocks.** `node $S/drive.mjs --open $T/io_waits.trc --view Blocks --name blocks` (driven 2026-11-03, `errors: []`): the header reads "8,747 block I/O waits · 3 files", panels file 10 / 12 / tempfile 203, the facts column has `7r10y07tqpg98` with "5,612 reads of 276 blocks: 20.3× per block". `--click '[aria-label="x axis"] button:has-text("time")'` switches the axis; the marks limit is a `<select>` (Playwright `selectOption`, not `--click`): 5,000 gives "showing 1 in 2 of 8,747". A brush is a mouse drag across an `svg.bm-overlay` (copy drive.mjs and use `page.mouse` down / move / up); the Window chip appears under the top row and the view re-queries; a double-click clears it.
- **Execution Loom.** `--open $T/exec_loom.trc --view Statements --click 'role=complementary[name="Statements"] >> role=button[name=/mtk_loom_ix/] >> nth=0' --click 'input[aria-label^="Compare execution"] >> nth=0' --click 'input[aria-label^="Compare execution"] >> nth=1' --click '[aria-label="Comparison view"] button:has-text("Loom")'`, then scroll `.loom` into view (a copy of drive.mjs): cold 5.82 ms against warm 648 µs. `mtk_loom_scan` with `nth=0` and `nth=2` compares a buffered scan with the direct-path one (Fetch 1 +240 ms: `enq: KO - fast object checkpoint`). The two runs of a statement can be on different cursors, so both checkboxes read "Compare execution #1": pick them by `nth`. The statement list's `>> text=<sql_id>` hits the inner sql_id button; the role selector above picks the row. Driven 2026-11-06, `errors: []`.
- **PX slave reads in Blocks.** `--open $T/px_io.trc,$T/px_io_slave_p000.trc,$T/px_io_slave_p001.trc,$T/px_io_slave_p002.trc,$T/px_io_slave_p003.trc --view Blocks`: "551 block I/O waits · 3 files", file 12 with 547 `direct path read` of obj# 141877 (MTK_PX_BIG) from the slaves. Driven 2026-11-06, `errors: []`.

## Gotchas

- The views are rendered from the shared lib `web/src/lib/views/` (repo root), also used by the CLI's UI.
- Timeline and Pivot show `loading…` while their query runs; the drive waits 1.5 s, extend it for slow traces.
- Statement counts differ between whole-trace and a narrowed selection; compare like with like.
