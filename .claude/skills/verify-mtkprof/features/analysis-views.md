# Analysis views

Once a trace is open the header row (right of the tabs) offers Overview, Statements, Waits, Blocks, Timeline, Sessions and Pivot (plus Compare when two traces are compared, and Notes/Reports under `Tools`). Each summarises the trace from a different angle.

## Sub-features

- `view-overview` Overview shows the trace summary, a Timeline and a Statements panel.
- `view-statements` Statements shows a list (`aside[aria-label="Statements"]`) and detail pane.
- `view-statements-dialogue` one picked execution's `Binds | Dialogue` control (`[aria-label="Execution detail"]`); Dialogue draws `.dlg-svg`.
- `view-waits` Waits shows `Wait events` with a `hide idle` toggle.
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
- **Row flow.** `--open $T/io_waits.trc --view Statements --click 'aside[aria-label="Statements"] >> text=7r10y07tqpg98' --click '[aria-label="Plan view"] button:has-text("Flow")'`: the plan section shows the Sankey (`.rf-fig`; node labels `.rf-label[data-node="<index in the dump>"]`, `--click` one to highlight its path; the scale is `[aria-label="Band scale"] button:has-text("linear")`). Driven 2026-11-03, no console errors.
- **Blocks.** `node $S/drive.mjs --open $T/io_waits.trc --view Blocks --name blocks` (driven 2026-11-03, `errors: []`): the header reads "8,747 block I/O waits · 3 files", panels file 10 / 12 / tempfile 203, the facts column has `7r10y07tqpg98` with "5,612 reads of 276 blocks: 20.3× per block". `--click '[aria-label="x axis"] button:has-text("time")'` switches the axis; the marks limit is a `<select>` (Playwright `selectOption`, not `--click`): 5,000 gives "showing 1 in 2 of 8,747". A brush is a mouse drag across an `svg.bm-overlay` (copy drive.mjs and use `page.mouse` down / move / up); the Window chip appears under the top row and the view re-queries; a double-click clears it.

## Gotchas

- The views are rendered from the shared lib `web/src/lib/views/` (repo root), also used by the CLI's UI.
- Timeline and Pivot show `loading…` while their query runs; the drive waits 1.5 s, extend it for slow traces.
- Statement counts differ between whole-trace and a narrowed selection; compare like with like.
