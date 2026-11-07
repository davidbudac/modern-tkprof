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
