# Analysis views

Once a trace is open the header row (right of the tabs) offers Overview, Statements, Waits, Timeline, Sessions and Pivot (plus Compare when two traces are compared, and Notes/Reports under `Tools`). Each summarises the trace from a different angle.

## Sub-features

- `view-overview` Overview shows the trace summary, a Timeline and a Statements panel.
- `view-statements` Statements shows a list (`aside[aria-label="Statements"]`) and detail pane.
- `view-waits` Waits shows `Wait events` with a `hide idle` toggle.
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
- **Idle toggle.** In Waits click `--click 'button:has-text("hide idle")'`; its `aria-pressed` flips and the event list changes.
- **Row flow.** `--open $T/io_waits.trc --view Statements --click 'aside[aria-label="Statements"] >> text=7r10y07tqpg98' --click '[aria-label="Plan view"] button:has-text("Flow")'`: the plan section shows the Sankey (`.rf-fig`; node labels `.rf-label[data-node="<index in the dump>"]`, `--click` one to highlight its path; the scale is `[aria-label="Band scale"] button:has-text("linear")`). Driven 2026-11-03, no console errors.

## Gotchas

- The views are rendered from the shared lib `web/src/lib/views/` (repo root), also used by the CLI's UI.
- Timeline and Pivot show `loading…` while their query runs; the drive waits 1.5 s, extend it for slow traces.
- Statement counts differ between whole-trace and a narrowed selection; compare like with like.
