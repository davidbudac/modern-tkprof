# The I/O map (the Blocks view, round 2): plan

Written 2026-11-08 from the user's notes on the Blocks view (`docs/PLAN-VIEWS.md` § 6 built it on 2026-11-03):

1. improve its layout and function in line with the rest of the app (the Trace pane's toolbar, side panel, Display);
2. label the axes, and make zooming in and out obvious;
3. a more meaningful name ("I/O map"), and a shortcut (it had none);
4. map obj# to object names, with a choice to show the PDB and the schema, and a choice of what the colours mean (type, file, …);
5. more ways to look at the data.

No engine change: everything below works on the rows `/api/io/map` (and its local twin `ioMapOf`) already returns. The
view keeps its id `blocks` (`State.view`, `mtkprof:` links, `workspace.json`, the persisted `mtkprof.blocks.*` settings).

## Decisions

- **Name: "I/O map"**, the tab, the statement inspector's button, the Waits links. Code names (`BlockMap.tsx`,
  `blocklayout.ts`, `bm-` classes) stay.
- **Shortcut: ⌘I (Ctrl+I elsewhere), "I for I/O".** The ten digits stay as they are (renumbering breaks muscle memory and
  the assistant's links); `SessionViewDef.key` takes a letter too (matched by `KeyboardEvent.code`, so it works on any
  layout; not from a text field, where ⌘I can mean italic). The view tab's tooltip and the held-⌘ hint show it.
- **Layout like the Trace pane**: a full-bleed view with one toolbar row (x axis, colour, panels, the filter chips, the
  zoom buttons, Display, the side panel button), a zoom row under it, the navigator, the figure (scrolls), and a side
  panel with icon tabs (Objects, Statements, Distributions).
- **Zoom is the view's own, a stack** (`State.ioZoom`, like the lanes' `lanesZoom`): a time range, plus block ranges per
  panel. Dragging no longer sets the global time window; "Use as time window" in the zoom row does. The drag's shape
  decides (as in common chart tools): mostly sideways zooms time, mostly up/down zooms the panel's blocks, diagonal both;
  the brush shows which. Out: the zoom row's ‹ Out, `−`, a double-click; Reset: the button, `0`; in: `+` (2× at the
  centre), ⌘/Ctrl + wheel at the pointer; ← → pan. A navigator strip over the whole range (the global window, else the
  trace) shows the I/O over time and the zoomed range as a box: drag the box to pan, drag beside it for a new range. The
  zoomed range is re-queried after 200 ms of rest (fewer waits: less or no sampling); until then the old rows are drawn
  in the new range. A new global window, a new filter from a link, or another trace clears the stack.
- **Axes are titled**: "block # in the file" in the y gutter, the x title under the ticks ("I/O order: the n-th block
  I/O wait in view, of N" or "time since the start of the trace").
- **Object names** in this order: the reference bundle (owner, name, subobject, type), else the trace's own plans (the
  STAT line's `obj=` and the name in its `op`; type TABLE / INDEX / … from the operation), else `obj# N`. Display
  options (persisted): schema, PDB (the container of the waits' session, from the timestamp lines' `PDB1(3)`),
  partition, obj#. The Objects tab says where the names came from and how to get the rest (desktop: Connections ›
  Reference data; CLI: `mtkprof refscript`, then `-ref`).
- **Colour by**: event, object, object type, schema, tablespace, file, statement, session, latency (6 log buckets on a
  sequential ramp), read size (blocks per wait). Modes that need the reference bundle (schema, tablespace) say so and
  fall back to "unknown". A legend entry is a button: a click keeps only its marks bright (another click adds,
  Esc-free: a click on the active one clears), hover previews.
- **Panels by file or by object.** Per object, a panel holds that object's waits (temp waits a panel per tempfile, the
  top 12 objects get panels, the rest one "other objects" panel); its block axis is always packed. **Block axis:
  linear or packed** for file panels: packed collapses the empty block ranges between the touched runs (a break mark
  in the gutter), short runs widened to a minimum height like the order axis' short stretches.
- **Side panel tabs**: Objects (per object: waits, time, blocks moved, distinct blocks, re-reads per block, average
  latency, how sequential the access is), Statements (the former facts column), Distributions (latency histogram per
  event, log buckets, p50/p95/p99; blocks per wait). They count the rows shown (the sample says so).

## Batches

1. Shell: name, ⌘I, `SessionViewDef.key` letters, `State.ioZoom` and its actions, link labels. Tests.
2. Data: `data/objnames.ts`, the y scale (linear / packed, panels by object), the colour modes and the highlight mask in
   `blocklayout.ts`, `data/iostats.ts`. Tests.
3. View: `BlockMap.tsx` rebuilt on the above; CSS; screenshots light and dark, with and without a reference bundle.
4. Docs (DESIGN, ARCHITECTURE, DESKTOP, HANDOFF, site), `make web`, CI, commit, push.

## Log

### 2026-11-08: all four batches

- Shell: the tab is "I/O map", ⌘I / Ctrl+I (`letterOf`, `viewKeyOf` takes letters by `code`, not from a text field;
  `viewKeyLabel` writes them upper case; the desktop's `menuHint` ranges digits only). `State.ioZoom` with `zoomIO`
  (push or replace), `zoomOutIO`, `resetIOZoom`; cleared by `setWindow`, `pickBlock`, `showBlocks`, a side switch and a
  new trace. The statement inspector's button, its Waits list and the event detail say "I/O map".
- Data: `objnames.ts` (bundle → plans → obj#; `containerNames` from the timestamp markers), `iostats.ts` (objects,
  latency, sizes), `blocklayout.ts` (`YScale`: `linearY` / `packedY` / `touchedRuns`, panels by file or object with keys,
  `colorRows` with ten modes, `Coloring.entry`, `drawBlockMap(…, focus)`, `scaleRange`, `panRange`, `dragKind`, `rowsIn`,
  `timeExtent`).
- View: `BlockMap.tsx` rebuilt (toolbar, status row, navigator, legend buttons, titled axes, the side panel with four
  tabs), `blockmap.css` rewritten (ramps `--bm-lat-*`, `--bm-size-*`).
- Engine (found while checking names in the desktop): an engine session's aggregate model has no waits, so `ApplyRef` named
  only the plans' objects and no datafile, and the database fetch asked for no datafiles. `Accumulator.RefIDs`,
  `model.RefIDSource`, `Model.WaitRefIDs`; agg format 4, `CacheIndexFormat` 6.
- Differs from the plan: a single block range of a few blocks would fill a panel, so a block is at most 3 px tall
  (`MAX_PX_PER_BLOCK`; a linear range is widened, a packed stack centred); y labels closer than 12 px are left out; the
  colour menu marks schema and tablespace "(no names)" while nothing has them (the mode's tooltip and the legend say a reference bundle names them).
- Verified: web 827 tests, desktop 228, Go `./...`, `pnpm -r typecheck`; screenshots (dev browser mode, light and dark,
  1280 and 1600 px, with and without the reference bundle; the standalone HTML report) of ⌘I, a time zoom, a box zoom,
  ‹ Out, panels per object, latency, type with a legend highlight, packed with the PDB on, the distributions, a wheel zoom.
- An independent review found, and this round fixed: a tooltip or pinned popover indexing rows a zoom step had replaced
  (a crash; they now carry the rows they index); a packed axis of many scattered runs stacking segments above the
  panel (`segsThatFit`: an object panel grows for its runs, then the runs merge until they fit); the legend highlight kept
  as positions in a legend whose order changes with the rows (now by entry key, with a note when nothing highlighted is in
  range); a click with a little vertical jitter zooming to one wait (`dragKind`: within 10 px both ways is a click); a
  brush left drawn after a drag came back within the slop; links, Back / Forward and the hash keeping a zoom inside a
  window they replace (`apply` clears `ioZoom`); ⌘ letters by the physical key catching ⌘C on Dvorak (`letterOf` reads
  the typed letter first); the side panel's ← → losing focus (React clears `currentTarget`; the Trace pane's panel had
  the same bug); going back to no zoom waiting 200 ms; the name counts of an engine document.

Commit: `4117834`.
