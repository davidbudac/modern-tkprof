# Trace pane, round 3 (2026-11-07)

The user's notes on the Trace pane after round 2 (`docs/PLAN-FORMATTED-V2.md`), with the judgement
calls made on them. Three batches, in order; each is committed and pushed on its own, verified by
screenshot in the dev shell (`verify-mtkprof` skill) at 1600 and 1280 px, light and dark. Each batch
appends to the Log at the end (commits, deviations, evidence paths).

## The notes and the decisions

1. **SQL text of a CURSOR, formatted like the plan; in full when wrap is on.** A band like the plan
   table, pretty-printed SQL in full with Wrap long lines on (batch 2).
2. **Hot spot steps both ways.** ↑ and ↓ in the toolbar (batch 1).
3. **The sql_id chips row crowds on a large trace.** Replaced by a statement picker: one button where
   the overview label was, opening a searchable list (batch 3).
4. **The pane is too busy.** The settings move to a **Display** tab of the existing right-hand side
   panel; the toolbar keeps the things used while reading and shows active states as chips (batch 3).
5. **"Where the time went · 1.3 min" goes** (batch 1).
6. **A click on a sql_id in a row opens the statement popup** (batch 1).
7. **The Duration scale.** How it worked: red (a hot spot) = a non-idle call or wait of 1 % of the
   file's traced time or more (`fileSpan * 0.01`, global; 1.3 min → 780 ms, so 800 ms red, 544 ms
   not); the bar was a separate absolute log scale, 1 µs empty to 10 s full (8 px a decade), on which
   544 ms, 800 ms and 5.6 s are within 8 px of each other, and nothing showed the 1 % line. Decision:
   **one scale, the share of the traced time.** The bar becomes log of the share, 0.01 % empty to
   100 % full (4 decades, 14 px each on the 56 px track), with a tick at 1 % (the midpoint) on every
   track: a bar past the tick is a hot spot, and the rule is visible. The hot rule itself is
   unchanged (batch 1).
8. **A call's Detail: rows apart, the gets as a group** (batch 1).

The user's list ended with an empty bullet; nothing was assumed for it.

## Batch 1: Duration scale, hot spot ↑ ↓, no overview label, sql_id popup, call Detail

- **Bar = share of the traced time.** `data/linetime.ts`: `barFrac(us, spanUs)` = clamp(log10(us /
  spanUs × 10⁴) / 4, 0, 1) (`spanUs` ≤ 0: 0); constants for the range (0.01 %…100 %) and the hot share
  (1 %). Every Duration track of the formatted view (calls, waits, the fold of repeats) uses it with
  the file's traced time (`fileSpan` in `views/Lines.tsx`; thread it into `readableRowsOf`). Each
  track draws a tick at 1 % (the midpoint) in `--s-critical` (1 px, quiet enough not to read as a
  bar; check both themes) and faint decade ticks at 0.1 % and 10 %. Fill colours stay (wait class,
  slate call with its CPU part). The hot rule does not change (≥ 1 %, non-idle; row fill, red
  Duration). The plan's A-Time bar (own time of the plan) is not this scale and stays.
- **The Duration header says the scale.** Over the track column the header shows `1 %` at the tick's
  x (11 px `--ink-3`); its tooltip: `bar: share of the traced time (78.0 s), log scale from 0.01 % to
  100 %; red from 1 % (780 ms): a hot spot (idle waits never)`. Right alignment of the header over the
  numbers must stay to the pixel.
- **Hot spot ↑ ↓.** The toolbar's `Hot spot ↓ 6` becomes `Hot spot ↑ ↓ 6`: two buttons (previous,
  `J`; next, `j`) in one group with the count; disabled when there are none; the label folds to
  icons at the same container-query step as now.
- **No overview label.** `ReadableOverview.tsx`: the `Where the time went · 6.46 s` text goes; the
  bar keeps an aria-label with that information. (Batch 3 puts the statement picker in that slot.)
- **A sql_id in a row opens the statement popup.** Every sql_id the formatted rows draw (the CURSOR
  row, the sticky lane row, the Δ-filter kept rows' labels, any other) and the breadcrumb's sql_id
  (`lv-head-id` in `views/Lines.tsx`) open `StmtPopover` at the click (the path `refClickOf` takes for
  a `sqlid` reference: `linesShared.ts`), whatever the `links` pref says; Shift-click goes to its
  PARSING IN CURSOR line in this file, as the raw view's links do. The click does not select the row.
  The popup's own "open in Statements" action is the way on.
- **A call's Detail in groups** (PARSE, EXEC, FETCH and the other calls with these fields;
  `data/readable.ts` `callParts` and the cells in `components/LineViewer.tsx`):
  `[exec N]  [rows]  [query 498  current 0  disk 496]  [cpu 5.17 ms]  [hard parse] · 631 ms waiting (99 %)`.
  - Rows in a slot of its own: the number right-aligned in a fixed width, then `row`/`rows` in
    `--ink-3`; on a FETCH always (0 rows too), on other calls when r > 0. A call without a rows value
    keeps the slot empty, so the groups after it align down consecutive call rows.
  - The gets group, tkprof's words: `query` (cr=), `current` (cu=), `disk` (p=), labels `--ink-3`,
    numbers in the ink (a 0 in `--ink-3`), fixed-width number slots (fit 1,234,567 without moving;
    longer numbers may push), in one quiet framed box (`--surface-sunken`, 1 px `--hairline`, small
    radius) so it reads as one thing apart from rows. Shown when any of the three is > 0; the tooltip
    keeps the trace tokens (`cr=498 cu=0 p=496`).
  - CPU after the group, as today only where it is not all of the duration; then the notes (hard parse
    pill, `cached`/`closed`, the waiting share) unchanged.
  - The `exec N` tag stays first.
- Tests: `linetime.test.ts` (barFrac at 0.01 %, 1 %, 100 %, span 0), the readable tests for the call
  parts (slots, the group shown or not), the hot-spot stepping both ways if there is a test seam.
- Docs: `docs/DESIGN.md` § Formatted Lines view: the Time bullet (the new scale, why: the user's 544 ms
  vs 800 ms vs 5.6 s; the absolute log scale goes into "rejected"), the call Detail (the round-1 note
  "fixed slots for them inside Detail were tried and rejected" is superseded: say what changed and
  why), the overview label, the sql_id click.

## Batch 2: the SQL band

- **Look:** the CURSOR row stays the head (as a plan's head row is). The SQL text lines under it are
  drawn as a band like the plan table: from the Operation column to the right edge (through Clock) on
  `--surface-sunken` in a 1 px `--hairline` frame, the existing SQL highlighting (keywords, literals,
  binds, comments), the rows' Operation cells empty. Plan band and SQL band must read as the same
  family (same insets, frame, surface, font size).
- **Wrap off:** one row per trace line of the text, cut at the right edge (as now), in the band.
- **Wrap on** (`prefs.wrap`, "Wrap long lines"; the formatted view ignores it today): the text lines
  after the first fold quietly into the first (the line range is known globally from
  `api/lines/blocks?what=frame`: from the PARSING IN CURSOR line + 1 to its END OF STMT − 1), and that
  one row grows to the **pretty-printed** statement in full (pre-wrap for a line longer than the band).
  Only the SQL band grows; every other formatted row stays one 20 px line.
  - Pretty-printing: add `sql-formatter` to `web/package.json` (lib dependency; check the desktop
    build resolves it), `formatDialect` with the `plsql` dialect only (tree-shaken), keyword case
    preserved, 2-space indent; on a throw, or for text over 20,000 characters, the text as the trace
    has it. Memoised per statement text (a small LRU). Measure the bundle growth of the CLI UI and say
    it in the Log.
  - Scrolling with a tall row: wheel, keys, the scroll bar, go-to, `j`, the sticky lane row and the
    plan head overlay must behave (the raw view's wrap mode is the precedent for tall rows; read how it
    handles them). A go-to into a folded text line lands on the band row. Copy (`y`) of lines copies
    the trace's own text.
- Tests for the fold of the text lines in wrap mode and for the formatter's fallback.
- Docs: DESIGN.md (the SQL band, wrap, the dependency and why), ARCHITECTURE.md if a module is added.

## Batch 3: statement picker and the Display panel

- **Statement picker** (replaces the chips row of `ReadableOverview.tsx`): in the overview row's left
  slot, a button: with a highlighted statement its swatch, sql_id (lane colour), `638 ms · 10 %`, the
  real counts `5 calls · 34 waits` and a ×; with none, `Highlight a statement` (muted) and ▾. It opens
  a popover: a filter box (sql_id or SQL text, case-insensitive) over a list of the file's statements
  by time here, longest first, each row: swatch, sql_id, time, share, executions, the SQL's start
  (`--ink-3`, cut); virtualised (`@tanstack/react-virtual`) so thousands are fine; ↑ ↓ Enter Esc;
  `None` first when one is highlighted. Picking highlights it and goes to its first line in this
  file (what a chip did). The `+n under 1 %` chip and the chips row go. The bar's segments keep the
  click (go to the line at that time) and gain a hover title naming the statement (sql_id, time,
  share). A palette command "Highlight a statement…" opens the picker; give it a key if a free one
  fits (check the KeyMap).
- **Display tab** in the side panel (`PANEL_TABS` in `views/Lines.tsx`), with a sliders button in
  the toolbar that opens the panel on it (and closes it when it is already open on Display); the
  panel button keeps opening the last other tab. Sections:
  - Formatted view only: **Colour the lanes by** (the radio list and its key, as the menu had),
    **Fold repeats** (checkbox, `r`), **Δ column** (checkbox).
  - **Δ filter**: threshold, Off / Highlight / Filter, the count note.
  - **Show**: the View menu's toggles (wrap, heat bars, density strip, links, hints, clock, delta)
    and Gap ticks.
  - **Line colours · tick to dim.**
  - **Folds**: Fold all BINDS, Fold all STAT, Unfold all.
  - Formatted view only: **Key**: red = a call or wait of 1 % of the traced time (with the number)
    or more; the Δ emphasis (amber); the lane highlight; the bar's scale.
- **The toolbar after:** Raw | Formatted, the search (with its Options), Hot spot ↑ ↓, Step, Go to
  ⌘K, the input-file select (multi-file only), the state chips, Display, Side panel. Gone from it:
  the Colour menu, the Fold repeats icon, the Δ toggle, the Δ filter menu, the View menu (their keys
  and palette commands keep working). State chips (shown only when not default): `Δ ≥ 10 ms · filter
  · 34` with × (a click opens Display), the pin chip, the window group, the raw view's Highlighting
  chip. Re-measure the container-query fold steps for the shorter bar.
- Docs: DESIGN.md (the toolbar and panel decision with what moved and why; the picker; the rejected
  chips row), HANDOFF.md (current state, open list), ARCHITECTURE.md if components are added.
- Then `make web` (embedded UI), `scripts/ci-local.sh --no-release`, commit, push.


## Round 3b (2026-11-07): the user's notes on batches 1–3

The user accepted batches 1–3 and asked for the "looked off" items of the Log to be fixed, plus:

1. **Colour only for the highlighted sql_ids.** Statements took the categorical colours by elapsed rank
   (`statementTones`), so the picker and the lanes used colours up front and the palette ran out. Now
   in the Trace pane only a highlighted statement has a colour; every other statement is neutral.
2. **Several statements at once in the picker**, by key: Space toggles highlight, `f` toggles filter
   for the focused sql_id; a key and a button select / deselect all.
3. **A highlight covers every line of every cursor of the statement** (a statement with several
   cursors: all of them), in both views.
4. **The density strip on the right becomes the map of the highlighted statements** (where their lines
   are).
5. **Icons instead of text in the side panel** for buttons and options, as far as it makes sense.

Decisions:

- **The highlight set.** The Trace pane keeps an ordered set of highlighted statements (Lines UI state
  per file, not the app's single `selection.stmt`, which other views use). Arriving from another view
  with a selected statement adds it; `l` toggles the selected line's statement in the set. **Colours:**
  a statement gets a colour when it is added, the lowest free slot of `blocklayout.CATEGORICAL`, and
  keeps it while highlighted (removing one recolours nobody); past the palette's size slots repeat.
  In the Statement lane mode (the default) the bands of the other statements are neutral (a quiet
  `--ink-3`-ish band), their sql_ids (CURSOR row, sticky lane row) in the ink; the overview track draws
  the other statements' segments in neutral greys (two alternating, so neighbours separate) and the
  highlighted ones in their colours; the picker shows a swatch only for highlighted rows. The other lane
  modes (Execution, Session, …) are unchanged. Scope: the Trace pane; other views keep their colours.
- **What a highlight covers.** Every line whose statement (the engine's per-line `stmt` id of the
  annotated pages, `CachedLine.stmt`) is in the set: PARSING IN CURSOR, the SQL text, END OF STMT,
  PARSE / EXEC / FETCH / CLOSE, `WAIT #n`, BINDS and its Bind lines, STAT lines, ERROR — whatever cursor
  number it went by. Not the bounded marks (the 5,000 longest calls, the first 1,000 waits). If the
  engine leaves some of those kinds without a stmt id, extend it (mind the cache-format rule in
  CLAUDE.md if a persisted struct changes). **Look:** the lane band in the statement's colour and a
  light row tint in it (about 8 % light, 12 % dark; hot spots and the selection beat it), in both views;
  the number cell's start bar on calls and waits stays. (Round 2 rejected a row tint because it stopped at
  the marks' cap and striped BINDS and PLAN rows; covering every line removes both reasons, and with only
  the highlighted statements in colour the tint no longer competes with fourteen lane colours.)
- **The statement filter.** A filtered set beside the highlight set: when it is non-empty the trace
  shows only the lines of the filtered statements' cursors, the rest folded like the Δ filter's Filter
  mode (quiet folds with a dashed rule and a count, `z` shows them); with the Δ filter also on, the rows
  shown pass both. The lines come from the engine for the whole file (a new route, e.g.
  `api/lines/stmts?file=&ids=…` answering each statement's line runs `[from, to]` in the file, bounded
  with a `truncated` flag; and a binned form for the strip, see batch 5), so the folds are global like
  every fold. A state chip in the toolbar while a filter is on (`Filter: 2 statements ×`, a click opens
  the picker). Check how `ui.focus` (the cursor focus) relates and keep the two from fighting.
- **The picker, multi-select.** Each row: a highlight toggle (the colour swatch when on, an empty
  ring when off) and a filter toggle (a funnel icon), then sql_id, time, share, executions, SQL start.
  Header: tri-state checkboxes over both toggle columns = select / deselect all of the rows listed (after
  the text filter). Keys: the filter box has the focus when the picker opens; ↓ moves into the list;
  in the list ↑ ↓ move, **Space** toggles highlight, **f** toggles filter, **a** highlights all listed /
  none (if all listed are on, off; else on), **A** (Shift+a) the same for filter, **Enter** goes to the
  focused statement's first line in this file and closes, **Esc** closes, `/` or any other printable
  key goes back to the filter box (and types). A click on a row toggles highlight; a click on the
  funnel toggles filter; double-click goes. A footer names the keys. The closed button: one highlighted
  → as now; several → their swatches stacked and `3 highlighted`; `· 2 filtered` when a filter is on;
  × clears both; it must fit at 1280 and 1100 px (the counts fold into the title before anything is cut).
- **Time here per file** (Log batch 3, looked off 3): the picker's time and share, and the lane row's
  `here`, are the statement's time in the open input file (the same numbers as the overview track).
- **The strip** (batch 5): the strip beside the scroll bar drops its density layer (calls and waits) and
  draws the highlighted statements' lines over the whole file, each in its colour (a binned answer of the
  batch-4 route), with the viewport box, the selected line, and quiet ticks for search hits, bookmarks
  and hot spots at its edge. With nothing highlighted it shows only those ticks.
- **Icons in the side panel** (batch 5): the tabs become icons with tooltips and aria-labels (the
  active tab's name as the panel's heading), which also ends the tab strip's clipping; in the Display tab
  the Show toggles become a grid of icon toggle buttons (pressed state, tooltip with name and key), the
  Δ filter's Off / Highlight / Filter an icon segmented control, Fold all BINDS / STAT / Unfold all icon
  buttons; buttons in the Line, Hits, Bookmarks and As run tabs (copy, previous / next, group by, remove,
  note, follow) icons where the icon is unambiguous. Lane colour modes stay a labelled list (no icon
  says "Recursive depth"). Every icon button has a tooltip and an aria-label. Icons in the style of
  `components/icons.tsx`.

## Batch 4: the highlight set, colours, the statement filter, the multi-select picker

As decided above: the highlight set and its colours; neutral lanes, track and picker swatches for the
rest; a highlight covering every line of the statement's cursors, band and tint, both views; the engine
route for a statement's line runs (OpenAPI + contract test + `pnpm gen:api`, additive, no protocol bump
unless it breaks something); the statement filter with its folds and chip; the picker's multi-select,
keys, header toggles, closed button (fixes looked-off 1 of batch 3); time per file (looked-off 3). Tests
for the set's colour slots, the picker's key handling (pure parts), the filter's folds, the route.
Docs: DESIGN.md (the highlight model, the colour rule and the reversal of round 2's tint rejection with
the reason, the filter, the picker keys), ARCHITECTURE.md (the route).

## Batch 5: the strip, icons, the rest of the open list, finish

The strip and the icons as decided above, then the open items of the batch 1–3 Logs:
- At 1280 px with the side panel open a hot FETCH's Detail is cut (`631 ms wa…`): the Detail compacts
  before it cuts (e.g. the gets box's labels shorten to `q` / `cu` / `d` with full words in the title,
  `cpu` drops its label, the waiting note to `631 ms wait 99 %`), by container queries on the rows'
  width; the waiting share is the last thing cut.
- A tall wrapped SQL band: its line number and Operation cell stay in view while the band is scrolled
  (sticky inside the row).
- The formatter re-spaces PL/SQL (`set_action ('x')`): no space between an identifier and its argument
  list's `(` (post-process, keywords such as IN, VALUES, AND, OR, NOT, EXISTS, AS, FROM excepted, or a
  formatter option if there is one); no change of a literal or comment.
- With the panel closed, Fold repeats on and a lane colour other than Statement have no sign: a state
  chip each (`Repeats folded ×`, `Lanes: Session ×`), like the Δ filter's.
- Anything else still open in the Logs that is cheap; list the rest in HANDOFF.
Docs: DESIGN.md, HANDOFF.md (current state, open list), ARCHITECTURE.md. Then `make web`, rebuild Go,
`scripts/ci-local.sh --no-release`, commit, push.

## Log

### Batch 1 (2026-11-07): Duration scale, Hot spot ↑ ↓, no overview label, sql_id popup, call Detail

Commit: `0767d7a` ("Trace pane round 3, batch 1: …"; this Log entry got its SHA in the commit after it). Tests: `pnpm --filter mtkprof-web test` 702 pass (was 699), `pnpm -r typecheck`
clean, desktop `pnpm test` 228 pass. No Go change; `internal/ui/dist` not rebuilt (batch 3 does that).
Evidence: `/tmp/verify-mtkprof/evidence/trace-v3/1/` (1600 and 1280 px, light and dark: `io_waits-118-final-*`, `basic_binds-48-final-*`, the
75 s SQLT trace with two hot spots `orcl_ora_3484_S94737_SQLT_TRACE-hot{1,2}-*`, the popups `sqlid-popup-{cursor-row,lane-row}-*`, the raw
header's `raw-head-popup-1600-light.png`; the drivers `drive-*.mjs` beside them, `drive-7.mjs` measures the Detail cell's overflow).

- **Scale.** `barFrac(us, spanUs)` and `HOT_SHARE` in `data/linetime.ts`; `ReadableInputs.spanUs` (optional, 0 = empty tracks), `LineViewer`'s
  new `spanUs` prop (the fold's track), `FormattedHead`'s new required `spanUs` (header tooltip). `fileSpan * 0.01` in `views/Lines.tsx` is now
  one `hotUs` (also the Hot spot tooltip). The tick is a `::after` of `.lv-trk` over the fill (1 px, `--hot-tick` = `--s-critical` at 75 %), faint
  ink ticks at a quarter and three quarters; the header's `1 %` is an absolutely placed span in `.lv-ch-dur` at `trk-pad + trk-w/2` from the
  column's end edge, so it sits on the tick at any column width and the "Duration" label is untouched. On the 75 s SQLT trace 366 ms (0.49 %)
  shows a bar just short of the tick and the 4.715 s one well past it, both themes.
- **Hot spot ↑ ↓.** `hotStep` / `firstAbove` moved to `data/lines.ts` (tested); the group is `.lines-hot` (label `tb-f3`, two `quiet` buttons with
  aria-labels, the count). Measured: no toolbar overflow from 860 px up with the second button (`drive-6.mjs`), so the container-query steps
  were not changed.
- **Overview.** The label is gone; its text is in the track's `aria-label`. Deviation: I also dropped the 210 px label column of `.time-bar`
  (an empty 210 px hole at the left of the bar looked broken); the track takes the full width. **Batch 3: put the picker's slot back
  (`grid-template-columns: 210px minmax(0, 1fr)` on `.time-bar` is how it was).**
- **sql_id popup.** The CURSOR row's sql_id is a `Seg.ref` (`sqlid:…`) drawn as a `.lv-ref` link, handled by the viewer's existing `data-act="ref"`
  path into `refClickOf`, so it is independent of the `links` pref and does not select the row. The sticky lane row and `lv-head-id` (the raw
  view's header over the top rows) call a new `openStmt` in `views/Lines.tsx` (popup; Shift: the cursor's parse line). Verified: popup at the
  click, selection unchanged, Esc closes, Shift on the lane id goes to line 84 (io_waits). Not done because there is nothing to do: the Δ filter's
  `labelAll` sets `lane.label` on every kept row but no component draws a lane label any more (the `data-act="lane"` branch of `onAct` is dead
  code too); a DOM scan of the formatted rows with Δ highlight and Δ filter on found every 13-character sql_id inside a link or button. The
  breadcrumb of the selected line (`LinesAt`) already opens the popup through `StmtLink`; left as it is.
- **Call Detail.** `callParts` in `data/readable.ts` returns `{ call: { rows, gets, cpu }, notes }`; `LineView.call` is new and `parts` of a call
  is only its notes. `gets` (cr + cu) and `reads` are gone from the Detail (the tooltip of the box has the tokens). The CPU now reads `cpu 5.17 ms`
  (label first, as in the plan's sketch; it was `5.17 ms cpu`). Deviations to fit 1280 px: (1) the `exec N` tag has a 6 ch slot on a call row
  that has a group, otherwise the EXEC row's tag would shift its groups against the PARSE and FETCH rows (the plan did not say; it is needed for
  the alignment it asks for); (2) the box is in 11 px type (`--text-xs`), the pairs 0.75 ch apart, the number slots 9 ch (1,234,567 fits), the
  rows slot 7 ch for the number + `row(s)`: with 12 px type and roomier gaps the hot FETCH of `io_waits.trc` (line 122: all groups and
  `· 631 ms waiting (99 %)`) lost the end of the waiting note at 1280 with the panel closed. It fits now with 5 px to spare; with the side panel open
  the detail is cut as it always was. `CallDetail` renders nothing for a call with no rows, gets or cpu (the tag and notes as before).
- **For batch 2.** The CURSOR row's Detail is still `rd.parts`; the SQL text lines are `sql-text` rows with `sqlSegs`. `Seg` now has an optional
  `ref`. `.lv-ref` on a formatted row underlines on hover and on the selected row only (the raw view's rule).
- **For batch 3.** `FormattedHead` takes `spanUs`; the toolbar's `.lines-hot` group is the Hot spot control to keep; the header's Duration tooltip
  is built there. The overview row's left slot is empty (above). The dev-shell driver for 1280/1600 × light/dark is `drive-1.mjs` (`STOPS=`,
  `PREFS=`, `ZOOM=`/`DSF=` for a zoomed crop); with `dangerouslyDisableSandbox`.
- **Looked off, not fixed.** At 1280 px with the side panel open the Detail of a hot FETCH is cut (it is where the new groups plus the waiting
  share need ~110 ch); the notes cut first, as designed. The gets box is quiet enough that on the amber selected row its sunken fill reads as a
  slightly cooler patch (light theme); acceptable, not changed.

### Batch 2 (2026-11-07): the SQL band, and two fixes to batch 1

Commit: `73b5b29` ("Trace pane round 3, batch 2: …"; this Log entry got its SHA in the commit after it). Tests: `go test ./internal/slice ./internal/engine` pass (new `TestLinesBlocksFrameTexts`, which checks
every fixture set), `pnpm --filter mtkprof-web test` 714 pass (was 702 after batch 1: +7 `sqlformat.test.ts`, +5 in `lines.test.ts`), desktop `pnpm test` 228 pass,
`pnpm -r typecheck` clean, `pnpm --filter mtkprof-web build` and the desktop's `vite build` resolve `sql-formatter`. `internal/ui/dist` not rebuilt (batch 3 does that).
Evidence: `/tmp/verify-mtkprof/evidence/trace-v3/2/` (1600 and 1280 px, light and dark, wrap off `-off-` and on `-on-`: `io_waits-132-*`, `basic_binds-{36,75}-*`,
`orcl_ora_3484_S94737_SQLT_TRACE-44839-*` with the wheel steps `-w1`..`-w3` (100, 100, 400 px), `-planhead-` (the plan's head overlay with a band above), `basic_binds-78-goto-*`
(go-to into a folded text line), `keys-*` / `scrollbar-*` (the key and scroll-bar runs of `drive-3.mjs`), `copy-basic_binds-75-84-*` (`y`), `io_waits-118-final-*` and
`io_waits-118-zoomgets-*` / `-zoomtick-*` (the two batch-1 fixes); drivers `drive-1.mjs` (go-to, prefs, `WHEELS`, `KEYS`, `FOCUSROW`, any trace by absolute path),
`drive-2.mjs` (measures the hot FETCH's Detail at a width), `drive-3.mjs` (keys, `j` / `J`, End / Home and the scroll bar with a visibility assertion per move: 0 bad on the 112 k-line
SQLT trace, on `basic_binds.trc` and on a trace that ends with a band), `drive-4.mjs` (`y` over a folded band: the clipboard equals the trace's lines 75..84).

- **Batch-1 fix 1, the gets box.** Three cells of a mini table: `query 498 │ current 0 │ disk 496`. Each cell is label, a gap of 0.4 digit, the number right-aligned in a 9-digit
  slot; the cells are apart by a 1 px `--hairline` rule and 0.5 digit of padding. Deviation (judgement call): I kept the slot at 9 digits, which is what 1,234,567 needs; "7 digits
  incl. separators" could also mean 7 characters (999,999), which would make the box 40 px narrower: it is `.rd-gets b { inline-size: 9ch }`. At 1280 px with the side panel closed the
  hot FETCH of `io_waits.trc` line 122 still shows `· 631 ms waiting (99 %)`, 4.8 px clear of the clock's reserved end padding (measured, `drive-2.mjs`; batch 1 had 5).
- **Batch-1 fix 2, the 1 % tick.** `--hot-tick` is `--s-critical` at 38 % (light) and 55 % (dark): a salmon tick between the two grey ones, findable, no longer a red dashed line.
- **The SQL band.** `TableBand` with `sql` (the plan's `.lv-tbl`, so the same insets, frame, surface and font); rows of a band come from `bands` (new `LineViewer` prop; `sqlBandAt` bisects).
  The first/last rules are inset shadows so a band is exactly its lines tall and its first line is not pushed down. Wrap off: a row per trace line, ellipsis at the right edge.
- **Deviation: the engine.** The plan said the range comes from `what=frame`, but that answer is only the rule lines and the END OF STMT lines, and a client cannot tell them apart
  (the PARSING line of an adopted cursor is in no cursor, `nasty_sql.trc` has an END OF STMT inside a text), and a wrong guess hides real lines. So `frame` also answers `texts`:
  `[first text line, last text line, statement id]` (`frameBlocks`), only where the model's text of the statement is those lines line for line (the 2 statements of `nasty_sql.trc`
  with an END OF STMT inside are left out and keep their rows). OpenAPI and `desktop/src/engine/api.d.ts` are updated; additive, no `Protocol` bump; an older engine sends none and the
  text lines stay rows. A prebuilt desktop sidecar needs `pnpm build:engine` (HANDOFF says so).
- **Wrap on.** `frameFolds(ranges, skip, bands)` makes `Fold.sql` (text lines after the first, and the END OF STMT line, folded into the first) in place of the END OF STMT frame fold; the
  row draws `doc.statements[id].text` through `prettyLines` (`data/sqlformat.ts`). `goTo` into a folded text line does not open the fold (`reveal` maps it to the band's row; the selection highlights
  the band); `z` on the band opens it as rows and `z` on one of them folds it again. `y` was already by line number: the clipboard holds the trace's lines.
- **Pretty-printing.** `formatDialect` + `plsql`, `keywordCase: 'preserve'`, `tabWidth: 2`; deviation: `linesBetweenQueries: 0` (the default put a blank line after every `;` of a PL/SQL block). 64-entry
  LRU; the trace's text on a throw or over 20,000 characters. Dependency `sql-formatter ^15.9.0` in `web/package.json` (+ `pnpm-lock.yaml`; 8 small transitive packages).
  **Bundle: `mtkprof-web` single file 1,773.79 kB → 1,841.84 kB (+68 kB, +3.8 %), gzip 628.04 → 646.35 kB (+18.3 kB, +2.9 %); with the formatter stubbed out it is 1,779.54 kB, so the
  formatter is +62 kB (+16 kB gzip) and this batch's own code +6 kB.**
- **Tall rows: the raw wrap mode is not a precedent.** `.lv-wrap` lets rows grow and the viewer's 20 px arithmetic is then wrong below the first tall one; nothing there handles it. For the band I kept the grid
  for everything that counts rows (scroll bar, keys, go-to, folds: a band is one row, so the scroll bar does not move with the width or the formatter) and made the pixel position measured while a tall row is
  rendered: `offsetOf` / `topFromOffset` place the layer (again after every commit: a page arriving or a resize changes a band), the wheel moves by pixels, `settle` checks a reveal against the real heights
  when a tall row lies between the top of the view and the target (and waits for the rows of a far jump to load; the top edge is rounded to a whole 20 px line, inside a tall row too, so no sliver shows under the
  sticky lane row), `tailTop` lets the last band at the end of the file be scrolled to its end. A view without a tall row takes none of these paths (wrap off: identical to before; checked with the same key run).
  The sticky lane row and the plan head overlay are laid over the top 20 px and behave (`-planhead-` shot). Found and fixed on the way: a far `j` with tall rows near the target left it 600 px below the view
  (its reveal was settled before the page loaded).
- **Looked off, not fixed.** (1) With the top of the view inside a tall band its line number (top-aligned in the row) has scrolled away, so the left columns are blank beside the lines being read; the sticky
  lane row names the statement. (2) A reveal that must centre a band lands on a 20 px line, so the centring is up to 10 px off. (3) The gets box is the same width as before (315 px at 11 px type), see
  fix 1. (4) The formatter lays PL/SQL out as it sees it (`set_action ('x')` gets a space before the parenthesis); it does not keep the trace's spacing. (5) Highlighting is per line: a block comment or literal that
  runs over a line break of the pretty text is not known to the next line.
- **For batch 3.** The overview slot and `FormattedHead` notes of batch 1 stand. The Display panel's "Show" section keeps the "Wrap long lines" toggle: the formatted view now honours it (the SQL band); its tooltip (`SHOW_TOGGLES` in
  `views/Lines.tsx`) says so already. `make web` is still to do: the embedded UI predates all of this, and the embedded CLI UI needs
  the rebuilt engine (`texts`) to show bands in wrap mode.

### Batch 3 (2026-11-07): the statement picker, the Display tab, a shorter toolbar

Commit: `0d0c23a` ("Trace pane round 3, batch 3: …"; this Log entry got its SHA in the commit after it). Tests: `pnpm --filter mtkprof-web test` 736 pass (was 714: +12 `stmtpick.test.ts`, +13 `display.test.ts`,
the 4 `splitChips` tests of `overview.test.ts` replaced by 1), `pnpm -r typecheck` clean, desktop `pnpm test` 228 pass, `go test` unchanged (no Go change), `scripts/ci-local.sh --no-release` PASS (vet, go test, web,
embedded-UI check, desktop; 59 s). `make web` rebuilt `internal/ui/dist/index.html` (1,841.84 kB, after batch 2, to 1,856.62 kB: +14.8 kB, gzip 646.35 to 649.61 kB) and the embedded CLI UI was smoke-tested on
`bin/mtkprof serve -spill io_waits.trc` (picker, list, Display tab, 0 console errors: `embedded-cli-1440.png`).
Evidence: `/tmp/verify-mtkprof/evidence/trace-v3/3/` (1600, 1280, 1100 px, light and dark; the matrix of `run-matrix.sh`, the drivers `drive-2.mjs` (a scripted run: `STEPS=goto:118;click:…;press:L;type:…;shot:…`), `measure.js` / `fit.js`
(the toolbar's needed width per fold step, and whether a real bar is one line), `timing.js` (the picker's cost), `smoke-cli.mjs`). **Best before / after pair: `/tmp/verify-mtkprof/evidence/trace-v3/2/io_waits-118-final-1600-light.png`
(batch 2) against `io_waits-118-after-1600-light.png`** (the same line, the same width: eleven toolbar controls and a two-row overview, the track and a row of chips, become seven controls and one overview row; the Duration header is 26 px higher).
Per width and theme: `toolbar-formatted-*`, `toolbar-raw-*`, `picker-none-bar-*` (none highlighted, closed), `io_waits-118-after-*` (one highlighted, closed), `sqlt-picker-open-*` and `sqlt-picker-filter-*` (open on the SQLT trace's 1,463
statements, `from dba_hist` typed), `display-formatted-*`, `display-raw-*`, `dfilter-chip-*` and `toolbar-dfilter-*` (the Δ filter on), plus `toolbar-badge-1280-light.png`, `tabs-with-count-1600-light.png`, `reopen-centred-*`.

- **Picker.** `views/StatementPicker.tsx` (a `ToolbarMenu` whose popover is a filter box over a react-virtual list), rows and filter in `data/stmtpick.ts` (`pickRows`, `filterRows`, `sqlCut`). Button, rows, `None`, keys, pick = highlight and go to
  its first line: as the plan says. Open state is `LinesUi.picker` (so `L` and the palette command open it; it is closed when the palette opens and when the tab unmounts). Measured on the SQLT trace (1,463 statements): 38 ms to open,
  33 ms per keystroke (two frames; 26 rows in the DOM); `from dba_` leaves 69, `from dba_hist` 25. The popover gives the focus back to where it was, as the palette does (a development build runs effects twice, which took the filter
  box for "where it was": found and fixed with a ref). Reopening with a statement deep in the list centres it (row ~390 of 1,463: scrollTop 9893, the highlighted row in view). The chips row, `+n under 1 %`, `splitChips` and `UNDER_SHARE` are gone from the code.
  The track's segments have a title (`sql_id · 2.486 s · 38 % of the traced time`).
- **Display tab.** `views/LinesDisplay.tsx`, `data/display.ts` (the Show toggles, the dim groups, the Δ modes, `PANEL_TABS`, `panelAfter`, `displayBadge`, `deltaChipParts`); sections as the plan lists them, formatted-only ones absent in raw.
  The sliders button (label folds at the third step, badge) opens the panel on Display and closes it there; the Side panel button opens the last other tab (`LinesUi.lastTab`, tested through `panelAfter`).
- **Toolbar.** Raw | Formatted, the search, Hot spot ↑ ↓, Step, Go to (pushed right), the file select, the state chips (Δ filter, pin, window, raw Highlighting chip), Display, Side panel. Steps re-measured (`measure.js`, worst case: Δ chip with
  100,000+, the pin, the window group, the file select at its least, the search at 14 ch): 1538 / 1400 / 1140 / 1042 / 909 px; limits 98, 89, 73, 67 rem (were 87, 79, 67, 59); one line from 928 px in the worst case (it wraps below 58 rem), from 816 px with only the
  Δ chip and the pin (`fit.js` at 900, 1000, 1100, 1280, 1440, 1600: no overflow, one row). DESIGN.md says the numbers.
- **Keys.** Added `L` (Shift+l; `l` highlights the selected line's statement, `L` opens the picker; free in every key handler of the lib and the desktop shell; in the KeyMap) and the palette commands "Highlight a statement…" (`L`) and
  "Side panel: Display". Every other key and palette command is unchanged.
- **Deviations (judgement calls).** (1) The picker's column has one width, `clamp(14rem, 24 %, 25rem)`, not the width of its content: sized to the content the track jumped 200 px each time a statement was picked; a control that fills
  its column is not the "empty hole" of the 210 px label slot. (2) The track also draws the highlighted statement when it is not among the 8 longest, outlined (a statement picked from a list of 1,463 usually is not). (3) The overview row
  now shows whenever the file has statements (it was hidden when none had time), so the picker is there. (4) The list includes statements without time and recursive SYS SQL (they have a swatch of the neutral tone); "time here" is the
  statement's elapsed time in the whole trace set, as the lane row says it (see below). (5) The Δ chip's mode and count (`· filter · 34`) fold away at the second step, so the chip reads `Δ ≥ 10 ms ×` from 1424 px down. (6) The badge counts the
  Show toggles, the gap ticks' threshold and the dimmed groups, not the Δ filter (its own chip) nor the lane colours, Fold repeats and the Δ column (they show in the rows). (7) The side panel's tabs have 6 px padding (12 before): six tabs and a
  hit count do not fit 400 px otherwise (the labels were cut to `Bookm…` and `Hits 8,7…` at 8 px). (8) Found while measuring: the search's Options button broke into letters when the bar was tight (its least width was not its box); the
  search's buttons are `nowrap` now. (9) The toolbar's order follows the plan (the search after the view switch, then Hot spot), so it differs from round 2's (Hot spot first). (10) The wrap rule is `< 51rem`, and `< 58rem` when the window
  group or the file select is there (`:has()`). (11) The commit's attribution line names the model that wrote it (Sonnet 5.5), not the Opus 5.5 of batches 1 and 2.
- **Looked off, not fixed.** (1) At 1280 px with a statement highlighted the picker's counts are cut (`5 calls · 34 …`; at 1100 `5 c…`); the title has them. (2) The Go-to label folds below 98 rem in every state, though a bar with nothing
  on needs 947 px: the worst case sets the steps, so between 1392 and 1568 px the label could have stayed. (3) "Time here" in the picker is the whole trace set's elapsed time for a statement, not its part in this input file (the lane row
  says the same; per-file time needs the engine). (4) With the panel closed, Fold repeats, the lane colour and the Δ column have no sign in the toolbar (the rows show them); only the Show and dim settings have the badge. (5) The panel's
  tab strip still clips at narrow panel widths (the tabs ellipsise, as before); at 400 px a hit count and a bookmark count together (`Hits 8,744`, `Bookmarks 12`) leave about 10 px.

### Batch 4 (2026-11-07): the highlight set, colour only for what is highlighted, the statement filter, the multi-select picker

Commits: engine `e97fda4` ("Trace pane round 3b, batch 4 (engine): api/lines/stmts, the failed parse's lines get their statement, a cursor's `=====` rule goes with it") and web
`ce3cc56` ("Trace pane round 3b, batch 4: …"); this Log entry got its SHAs in the commit after them. Tests: `pnpm --filter mtkprof-web test` 773 pass (was 736: +7 `hlset`, +11 `stmtfilter`, +12
`pickkeys`, +4 `lines` (the routes), +2 `readableRows`, +1 `stmtpick`), `pnpm -r typecheck` clean, desktop `pnpm test` 228 pass, `go vet ./...` and `go test ./internal/...` pass (new in `internal/slice`:
`TestAnnotStmtIDs`, `TestStmtMapMatchesAnnot` (the route's line map equals the `annot=2` statement of EVERY line of every fixture, model-backed and spill-backed, and the SQLT trace, 29 ms to build for its
112 k lines), `TestLinesStmtsRoute`, `TestLinesStmtsBadRequests`; the engine contract test counts 35 session routes now). `go test ./internal/slice` takes about 92 s (the existing
`TestLinesAnnot2MatchesAt`). `internal/ui/dist` not rebuilt (batch 5 does it); `desktop/src/engine/api.d.ts` regenerated (`pnpm gen:api`). Additive: no `engine.Protocol` bump, no persisted struct changed.
Evidence: `/tmp/verify-mtkprof/evidence/trace-v3/4/` (1600 and 1280 px, light and dark, the 1100 px strips; `run-matrix.sh` regenerates the matrix with `drive-2.mjs`; `drive-3.mjs` prints the stack of a console error
through CDP; `measure2.js` / `measure3.js` / `fit.js` the toolbar's needed width). **Best three:** `picker-multi-1600-light.png` (the picker open after `L`, ↓ and Space on two statements and `f` on one: two
highlighted, one filtered, all by keys), `cursors-filter-1600-light.png` (one statement parsed under three cursors of `cursor_cache.trc`, highlighted and filtered: its three blocks with the dashed folds between them) and
`trace-all-filtered-1280-light.png` (the SQLT trace after `a` and `A` on the 25 statements that read `dba_hist`: 25 highlighted in repeating colours, 25 filtered, the chip). Also: `trace-formatted-hl-*`, `trace-raw-hl-*`
(two statements highlighted, both views), `overview-hl-*` / `overview-calm-*` (the track: coloured highlighted stretches over neutral greys, and nothing highlighted), `bar-none|one|several-filtered-1100-*` (the closed button),
`toolbar-all-chips-1100-*`, `picker-all-keys-*` (`a` / `A`), `calm-*` (nothing highlighted: neutral lanes), `t5-raw`, `t6-trace` (arrival from the Statements view).

- **The route.** `GET /s/{id}/api/lines/stmts?file=&ids=1,2,3[&limit=][&union=1|&bins=B]` (`internal/slice/lines_stmts.go`, OpenAPI schema `LinesStmts`). `ids`: 1 to 20,000 distinct statement ids (400 for a bad one; an id with no
  lines gets an empty entry). Default: `{total, stmts:[{id, lines, runs:[[from,to],…]}], truncated}` (`lines` is the whole-file count even when `runs` is cut); `union=1`: `{total, lines, runs, truncated}` (the merged runs of all
  the ids: the statement filter's list, `fetchStmtUnion`); `bins=B` (1 to 2,000, the layout of `lines/profile`: `size = ceil(total/B)`, bucket i is the lines `i*size+1 .. (i+1)*size`): `{total, buckets, size,
  stmts:[{id, lines, counts:[…]}]}` (no limit, `fetchStmtBins`); `limit` (default 100,000, max 500,000) caps the runs, the earliest in line order are kept; `bins` with `union` is 400. A line belongs to statement X iff `annot=2`
  answers `s == X` for it, computed without a full-file text scan: a cached per-file run-length "line → statement" map (`stmtMaps`, rebuilt when the line count or the call or wait row ranges change) swept from the call rows (a
  call's statement runs on until the next call row: the default rule), wait rows, and the blocks read from small pieces of text (cursor blocks, plan blocks, BINDS blocks, the `=====` rule above a cursor).
- **Audit of the per-line ids** (`TestAnnotStmtIDs`, every line kind of a cursor against the model on all fixtures): PARSING IN CURSOR, SQL text, END OF STMT, calls, WAIT, BINDS with its Bind and attribute lines, STAT and ERROR already had
  the right statement. Two gaps: (1) the `PARSE ERROR` line and the SQL text under it took the call before them (a failed parse has a cursor and statement of its own); fixed in `lines_annot2.go` and in `Server.at` (they must agree). (2)
  Three PARSING IN CURSOR blocks of the SQLT fixture (about 100 lines) belong to no model cursor: the parser reads past their END OF STMT (the first PL/SQL block's `len=` is never reached) and takes the next blocks for
  statement text. Not fixable without changing the parser; the equality tests allow it for that fixture only (at most 120 lines, only for those three kinds). **Deviation (my addition, asked of the engine mid-batch):** a `=====`
  rule that is the line right before a cursor's first line belongs to that cursor, in `annot=2`, `/api/at` and the route: with the filter on, the rule above the next cursor was a stray row at the end of every run, and in the
  raw view the highlight tint ran over the next statement's rule.
- **The set and colours** (`data/hlset.ts`): `LinesUi.hl` (an `HlSet`: the ids in order and the colour slot of each), per file; `addHl` takes the lowest free slot of `blocklayout.CATEGORICAL` (7), a removal recolours nobody, past 7 the
  least used slot repeats. `readableRowsOf` gets only the highlighted statements' tones (a lane band of any other statement is `NEUTRAL_LANE`, its sql_id in the ink), `statementTones` is not used by the pane any more. The
  overview track: highlighted stretches in their colours (outlined), the others in two greys by rank parity. A different `selection.stmt` arriving from another view joins the set (`ui.hlSeen`; the line clicks of this
  view set it first in `dispatchAt`, so they do not); verified with Statements → Trace (`t6-trace-1600-light.png`). `l` toggles the selected line's statement, the palette has "Highlight the line's statement", "Highlight or filter statements…",
  "Filter by the line's statement", "Stop highlighting", "Stop filtering by statement". **Deviation:** a new key `F` (Shift+f; free in every handler) toggles the selected line's statement in the filter (the plan named none).
- **The highlight** (`LineViewer`'s `hlColors`: statement id → colour; `Row`'s `hc`): every line whose per-line `stmt` is in the set gets `lv-hlrow` (8 % tint, 12 % dark, `--hl` on the row) in both views; the formatted lane cell
  14 % over it; calls and waits keep the 3 px bar. The marks of the selected statement are no longer drawn (they stay for `m` / `M`, the search scope and the strip). Hot spots, the Δ highlight and the selection win by rule order.
  Statements of several cursors: highlighted on all of them (`cursor_cache.trc`'s `cj8rvwsf0srvp` is parsed three times).
- **The filter** (`LinesUi.filter`, `data/stmtfilter.ts`): `fetchStmtUnion` → `runFolds` (quiet folds under the last kept row, dashed rule, the lines above the first run under line 1 with a count), `linesInRuns` for the Δ filter's
  intersection; the folds replace the others as the Δ filter's do; chip `Filter: 2 statements · 1,204 lines ×` (a click opens the picker in the formatted view; in the raw view it says where the list is); a filter that leaves the focused
  cursor's statement out clears `ui.focus`; an engine without the route: the filter switches itself off and the status bar says why. **Found and fixed on the way:** with two filtered statements and the Δ filter at 1 µs on the
  SQLT trace React reported "maximum update depth": `ensurePages` loaded the run of pages from the first row to the last and the cache kept 40, so far-apart rows evicted each other's pages for ever. It loads the pages that hold a rendered row
  and `PageCache.reserve` grows the cache to hold them (DESIGN).
- **The picker** (`StatementPicker.tsx`, `data/pickkeys.ts`): as the plan's keys; `pickerKey(mode, event, atTop)` is a pure function (tested) and the filter box keeps the DOM focus the whole time, so typing is never lost. **Deviations:** Enter goes to
  the first line and closes but no longer highlights (a click and Space toggle); no `None` row (the header box, `a` and the × do it); double-click goes; PgUp / PgDn / Home / End move too. The closed button is as the plan says
  (stacked swatches and `3 highlighted`, `· 2 filtered` as a funnel and the count); it is a container (`container: stmt-pick`) so the counts go to the title below 22 rem, the time and share below 17 rem, the word `filtered` below
  12.5 rem, with a filter on the counts are always in the title and the time goes below 20 rem. At 1100 px (252 px of button) a highlighted statement shows its sql_id and nothing is cut.
- **Per-file numbers** (`data/filestmts.ts` `useFileStmts`): the picker, the track's titles and the lane row's `here` / `exec N of M` use the statement's elapsed time and executions inside the open file (the document's table for one input
  file, `api/statements` of the file's contexts for a set).
- **Toolbar fit.** The chip's words fold with `.tb-f2` / `.tb-f3` / `.tb-f4`; the widest steps come later while it is on (`.lines-row:has(.lines-sstate)`: 112 / 103 / 83 / 75 rem). Measured with everything on at once (Δ chip 74,307, pin, window
  group, file select, two filtered statements: `fit.js`) the row is one line with the search at 112 px or more at 1100, 1280, 1440, 1600, 1800 and 2000 px. Cost: with a filter on the Go-to label folds below 1792 px.
- **Attribution.** As in batch 3 the commits' `Co-Authored-By` line names the model that wrote them (Sonnet 5.5), not the Opus 5.5 the brief gave; the engine half was written by a fork of this session.
- **Notes for batch 5.** The strip asks `fetchStmtBins(client, file, hlIds, buckets)` (`api/lines/stmts?bins=`): per highlighted statement the lines in each bucket, the layout of `fetchLineProfile` (same `size`, so the two align); the
  colours are `hlColors` of `Lines.tsx`. The strip's `marks` prop still carries the selected statement's marks (`StripHost`): replace it. `hlSeen` / the set are in `LinesUi`, per file. `internal/ui/dist` and the Display tab's strip toggle text
  ("the selected statement") are batch 5's. The raw view's chip has a grey swatch for several statements (stack them like the picker's button if wanted).
- **Looked off, not fixed.** (1) A line in no cursor (blank, `***`) takes the previous call's statement, so a filter keeps it with that statement (`line 91` and `92` of `io_waits.trc` are in the middle of `c7ry5gr75qv4b`'s run). (2) The
  SQLT quirk above. (3) The picker's tint is light in the plan and SQL bands (their sunken surface sits over it). (4) With a filter on, the Go-to label folds early (above). (5) A filtered view of far-apart rows loads a page per
  row: 100 pages of 2,000 lines for a statement that ran everywhere on a big file (the screen waits for them).

### Batch 5 (2026-11-07): the line map, icons in the side panel, the statement filter keeps the view's folds, the open list

Commits: `BATCH5_SHA` ("Trace pane round 3b, batch 5: …"; this Log entry got its SHA in the commit after it). Tests: `pnpm --filter mtkprof-web test` 799 pass (was 773: `linestrip` rewritten
for the new mapping (+9), `tightCalls` +5, `composeFilterFolds` +7 in `folds.test.ts`, `hlStops` and the filter-with-folds scenario +6 in `stmtfilter.test.ts`, the panel tabs' names in `display.test.ts`), `pnpm -r typecheck` clean,
desktop `pnpm test` 228 pass, `scripts/ci-local.sh --no-release` **PASS** in 58 s (go vet, go test (unit, golden, engine contract), web install / typecheck / test / build, embedded-UI check, desktop api types / cargo fmt / typecheck / test). `make web` rebuilt
`internal/ui/dist/index.html` (1,856.62 kB after batch 3 to 1,890.17 kB: +33.6 kB, gzip 649.61 to 660.33 kB, for batches 4 and 5 together), `make build`, and the embedded CLI UI was smoke-tested on `bin/mtkprof serve -spill io_waits.trc` (the line map canvas, `l`, `m` with its
status note, the six panel tabs, the nine Display toggles, 0 console errors: `smoke-cli.mjs`, `embedded-cli-1440.png`). No Go change: the engine route of batch 4 is all the strip needs (the desktop sidecar was
rebuilt with `pnpm build:engine`: the prebuilt one was from before the route).
Evidence: `/tmp/verify-mtkprof/evidence/trace-v3/5/` (1600 and 1280 px, light and dark; `run-matrix.sh` regenerates the matrix with `drive-2.mjs`, which gained `wheel:`; `detail.js` measures a call Detail's width and whether its
waiting share is clipped, `fit.js` / `measure3.js` the toolbar). **Best four:** `cursors-filter-1600-light.png` (compare with batch 4's: the same filter with `end of statement`, blank and attribute rows gone), `strip-hl-1600-light.png` /
`strip-hl-1280-dark.png` (55 statements highlighted on the SQLT trace: the line map, and the colours of the lanes), `panel-display-1280-light.png` (icon tabs with the heading, the toggle grids, the Δ filter's segmented control) and
`io_waits-122-panel-1280-light.png` (the hot FETCH at 1280 with the panel open: the Detail compacted, the waiting share whole). Also `band-scrolled-*` (a tall band half-way: line number and `SQL` tag in view), `basic_binds-36-wrap-*`
(`set_action('arraysize15')`), `strip-none-*` (ticks only: a hit, a bookmark, hot spots), `raw-chip-*`, `toolbar-chips-*`, `panel-{line,hits,bookmarks}-*`, `delta-goto80-1600-light.png` (the Δ filter's opened fold, composed).

- **Line map.** `LineStrip` draws, from `fetchStmtBins` (one request per change of the highlight set, file or `rev`; none with nothing highlighted), each highlighted statement's lines in its colour (2 px marks, stripes where
  several share a pixel row), the selected line (2 px amber), the visible range, the window, and quiet ticks (bookmarks, hot spots at the start edge, hits at the end edge). The density layer is gone, and with it the error, cursor and commit ticks
  (they came from `lines/profile`, which the UI no longer asks for): **deviation, noted in DESIGN and HANDOFF**: the plan listed hits, bookmarks and hot spots only. 16 px wide (was 14). The toggle is "Line map" in Display (was "Density strip").
- **`m` / `M`** go to the start of the next / previous *run* of any highlighted statement (`fetchStmtRuns`, `hlStops`); the Step menu's row, the palette ("Next highlight" / "Previous highlight") and the search scope "Highlighted statements"
  use the same list. Why runs, not calls and waits of the set: DESIGN. The line card's "Mark its calls and waits" became "Highlight its statement". **Deviation:** opening the tab with a statement selected starts at its first line in the file
  (`stmtLineIn`), not at its first bounded mark. The raw view's chip shows the set (stacked swatches, `3 highlighted`, ×).
- **Icons.** Tabs, Display (Show and Rows toggles, Δ modes, folds), Line, Hits, Bookmarks, As run, recent searches, close; 30 new icons in `components/icons.tsx` (lucide shapes). Every button has a tooltip and an `aria-label`; the tab strip cannot
  clip any more. The Show toggles have a caption under the grid (name and key of the one hovered or focused): **deviation (addition)**, the descriptions are long and the grid alone is glyphs. Lane colours, line colours and the inputs stay text.
- **The regression.** `composeFilterFolds` (DESIGN has the rules). **The Δ filter had it too**, wherever one of its folds is opened (a go-to into a hidden line): fixed the same way, with the quiet folds only (a repeat or user fold would hide a Δ-kept
  row); `goTo` into an opened filter fold also opens the view's fold over the line.
- **Open list.** Detail compaction (container `rdtx`, steps at 108 / 98 / 88 / 74 / 56 ch; the groups are a clipped block, the waiting share is whole: measured at 1280 with the panel open, `detail.js`); the tall band's number and Operation cell
  (`--stick`, a `SQL` tag appears while stuck: **deviation (addition)**, the band's Operation cell is empty otherwise); `tightCalls`; chips for Fold repeats and the lane colour (the label steps now depend on the number of chips: `:has(.lines-state ~ .lines-state)`
  two, three, four); the tint on the bands (13 % / 17 % over the sunken ground).
- **Looked off, not fixed.** (1) With all four optional chips, the pin, a window and a file select at 1100 px the search is at its least width (23 px; 128 px or more from 1280). (2) At 1280 with the panel open the groups of a hot call's Detail are clipped (the
  CPU is out, the gets box is cut at its end when `rows` and the share leave less than its width); only room helps. (3) The line map is thin on a 112,000-line trace with few highlighted lines (one pixel row is 140 lines; the marks are 2 px). (4) The Go-to label
  still folds early with a filter on. (5) A far reveal that must centre a tall band is up to 10 px off. Nothing else of the batch 1 to 4 Logs was left that is cheap; the rest is in HANDOFF's open list.
- **Attribution.** As in batches 3 and 4 the commit's `Co-Authored-By` line is the one this session was given (Sonnet 5.5), not the Opus 5.5 of the brief.
