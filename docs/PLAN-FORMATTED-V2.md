# Plan: Formatted Trace view, round 2 (2026-11-06)

The ten changes of the mock-up `docs/mockups/formatted-v2/index.html` (built from three design reviews of the
formatted view on 2026-11-06; the reviews' points are in its captions) and the twelve suspected bugs in its last box,
implemented in the shared lib (`web/src/lib`) so the CLI UI and the desktop app both get them. The mock-up's
`src/rows.css` / `chrome.css` hold the proposed CSS rules and `src/present.js` the row transformations; port from them,
do not invent new rules where the mock-up has one. The screenshots to match are `docs/mockups/formatted-v2/shots/
composite-a-proposed-light.png` (io_waits.trc lines 84–136, c7ry5gr75qv4b highlighted, line 118 selected) and
`composite-b-proposed-light.png` (lines 10355–10401, 52nzchs09dgn1 highlighted, line 10378 selected), plus the dark ones.

## Where the code is

- `web/src/lib/views/readableRows.ts`: a line → `ReadableCell` (lane, Δ, bar, hot, clock). `readableRows.test.ts`.
- `web/src/lib/data/readable.ts`: `describeLine` → `LineView` (label, tone, `parts` segments, bar role, plan cells,
  bind rows); `planDump`. `readable.test.ts`.
- `web/src/lib/components/LineViewer.tsx`: `ReadableRow` (≈ lines 600–670) draws the cells: `.lv-bar` (Δ text
  `.lv-rdlt` over the bar), `.lv-ln`, `.lv-lane`, fold handle, `.lv-dur`, `.lv-kd`, `.lv-tx` (parts via `segNode`),
  `.lv-rclk`; the plan head row (≈ 702) and the sticky `.lv-head` overlay (≈ 488); `PlanCells.tsx` the plan table cells.
- `web/src/lib/components/FormattedHead.tsx`: the column header row and the resize grips (`cols` pref, `--w-<key>`).
- `web/src/lib/styles/lines.css` from "readable mode" (≈ line 386) to the end: the grid, bars, tints, tables, chips.
- `web/src/lib/views/Lines.tsx`: the toolbar (≈ 1106–1300: Raw|Formatted, Fold repeats, Δ, Hot spot, the
  `.lines-hl` Highlighting chip ≈ 1130, search, menus), the breadcrumb (`LinesAt.tsx`), hot spots, folds, the palette.
- `web/src/lib/views/ReadableOverview.tsx`: the stacked bar (`.rd-track`) and the statement chips (`.rd-chip-st`).
- `web/src/lib/state/linesPrefs.ts`: prefs (`readable`, `foldRepeats`, `rdDelta`, `cols`, …).
- `web/src/lib/data/linetime.ts` (`fmtDelta`, `clockCell`), `lanecolor.ts`, `folds.ts`, `format.ts`.
- Decisions: `docs/DESIGN.md` § "Formatted Lines view" (update it when a decision changes; the rejected alternatives
  stay listed). Verification: the `verify-mtkprof` skill; a drive script that opens a trace, clicks Trace, goes to a
  line through the palette (⌘K, type the number, Enter) and screenshots is
  `/private/tmp/claude-501/-Users-davidbudac-claude-projects-modern-tkprof/78056359-08e4-4f53-a3f7-d37aaa73da7f/scratchpad/shots.mjs`
  (copy it next to your evidence; it reads `/tmp/verify-mtkprof/state.env`). Evidence goes under
  `/tmp/verify-mtkprof/evidence/formatted-v2/<batch>/`.

## Batches (sequential: they all touch LineViewer.tsx and lines.css)

Each batch: implement; unit tests for every rule that is logic (readableRows / readable / a new helper), not for CSS;
`pnpm -r typecheck`; `pnpm --filter web test` (vitest); launch the dev shell with the verify-mtkprof skill and screenshot
io_waits.trc at lines 118 and 10378 (both highlighted states come from the go-to) light and dark, plus basic_binds.trc
at line 48; compare with the mock-up composites; `cleanup.sh`; commit to `main` with a concise message (no push).
The Go engine, `make web` and `docs/` updates are batch E.

### A. Tints, weights, clock (mock-up §1, §2, §4 without the bracket, §9; bugs 3, 8, 9)
1. Highlight the lane, not the row: `.lv-mk*` rows lose their fill; the Statement cell gets `--hl` at 14 %, the band
   goes from 4 to 6 px in the lane's own hue (drop the `color-mix` toward ink: bug 3), the line-number cell keeps the
   3 px start bar. The selection is one amber fill, line-number cell included (bug 8). Keep `lanes-by-line` working.
2. Hot spots: `.lv-hot` fills with `--s-critical` at 16 % (22 % dark), 3 px start bar, Duration at 600 in
   `--s-critical`; nothing else uses that hue. A STAT row whose own time is ≥ 1 % of the traced time marks its
   A-Time cell the same way.
3. Operation column: calls (PARSE, EXEC, FETCH, CLOSE, CURSOR) uppercase 600 `--ink`; waits lowercase `wait`
   `--ink-3` 400 with a 6 px class dot (hollow ring for idle) before the event name in Detail; PLAN/BINDS 500
   `--ink-2`; marks `--ink-3`. `hard parse` is a tan pill (`--s-warning` 18 %), not red; `hard close` /
   `already in the cursor cache` wording is batch C.
4. Wait share on a call row: when e − c ≥ 10 % of e and ≥ 100 µs, append `· 631 ms waiting (99 %)` (`--ink-2`,
   `--s-critical` from 50 %). Unit test on PARSE/EXEC/FETCH lines.
5. Clock: the full stamp on the first visible row, the selected row and when HH:MM:SS changes; otherwise `.828158`
   right-aligned under the full one; the column default shrinks to ~10 ch (the saved width goes to Detail). Needs the
   previous row's clock: compute in `readableRows.ts` (the previous line with a time) and let the viewer force the full
   form on the first row of the viewport.
6. Header: `Duration` right-aligned over its numbers; resize grips only on hover (bug 9); the A-Time bar gets a track
   and a gap from the Cost number (bug 9 second half; the rest of the plan table is batch D).

### B. Time (mock-up §3 and its Δ variant; bug 5)
1. The bar moves into the Duration cell: number, then a 56 px track (`--ink` 8 %), log scale 1 µs → 10 s with faint
   decade ticks; waits fill in their class colour, calls in slate with the CPU part the solid darker end. The Δ cell
   is text only (`rdDelta` pref still hides it). Column defaults change (`--d-bar`, `--d-dur`; FormattedHead).
2. Δ in formatted mode is the unexplained gap: start(this) − end(previous line with a time), start = tim − own time
   (ela or e), never negative (bug 5), blank under 50 µs, `--ink-3` by default, emphasised (`--s-warning`, 500) when
   ≥ 1 ms and ≥ 2× the previous line's duration; the tooltip keeps the tim-to-tim number. Pinned mode (Δ from the
   pin) and raw mode are unchanged. The Δ filter / colour-by-delta (`colorBy === 'delta'`, `step`) keeps using the
   tim-to-tim step. Unit tests.
3. Magnitude ramp on Duration and Δ numbers: µs `--ink-2` 400, ms `--ink` 500, s `--ink` 650; units `--ink-3`.

### C. Structure (mock-up §4 bracket, §5, §6, §7; bugs 4, 10)
1. Sticky lane row: the Statement column becomes a 14 px band column (6 px band + gutter); a lane's identity is ONE
   sticky row at the top of the viewport while its lane scrolls (reuse the `.lv-head` / plan-head overlay mechanism):
   sql_id (lane colour, 600) · SQL start (`--ink-3`, 48 ch) · `2.486 s here · exec 1 of 1` right-aligned (`--ink-2`);
   it covers only the top row, from the band column to the right edge. The sql_id is never truncated (bug 10). The
   `cols` pref for the lane column still resizes it. Each execution's first row (BINDS if present, else EXEC) carries
   an `exec N` tag (`--ink-3`, 11 px) at the start of Detail.
2. Row economy: BINDS blocks with ≤ 4 binds of ≤ 24 chars render inline on the BINDS row as chips `:B1 = 8706` +
   `NUMBER` dimmed + `SQL with values →`; their Bind# and attribute lines fold quietly (`Fold.quiet`), the number
   column shows a dotted gap mark. Blank, `=====` and `END OF STMT` lines fold quietly: the rule becomes a full-width
   1 px hairline on the next CURSOR row, `end of statement` disappears. CLOSE reads `cached` / `closed` (`--ink-3`).
   SQL*Net `1 byte` is dropped (`8,101 bytes` stays). A 1 px `--ruling` top border on each execution's first row.
   0 µs durations in `--ink-3`. The CURSOR row reads `c7ry5gr75qv4b  SELECT · user 165 · 99 chars` on one row.
3. Runs: for ≥ 3 consecutive waits of the same event + object, rows after the first draw the prefix in `--ink-3` at
   60 % (ditto) and the varying fields as right-aligned micro-columns (`file 12 | block 171160 | 8 blocks`, no `·`),
   aligned down the run; an idle/network wait inside the run breaks the ditto, not the alignment.
4. Bracket: non-idle waits under a call are indented 2 ch in Detail with a 1 px rule in the lane colour from the first
   such wait after the previous call down to the call that closes them, hooking (└) into the call row; idle waits
   between calls get neither.
5. The fold handle `▾` moves to the head row's Operation cell: `▾ PLAN`, `▾ BINDS` (bug 4); the keys (`z`) unchanged.

### D. Tables and chrome (mock-up §8, §10; bugs 1, 2, 6, 7, 11, 12)
1. Plan and bind tables span from the Operation column to the right edge (through Clock) on `--surface-sunken`
   with a 1 px `--hairline` frame; headers 11 px `--ink-3` 500 with one hairline; `A-Time (bar: self)`; the bar's
   56 px track; estimates ≥ 10× off per start in `--s-critical`; `SQL with values →` after the last bind row. When
   narrow, columns drop in the order Cost, E-Rows, Starts, Writes, then Name (merged into Operation), never
   Operation / A-Rows / A-Time / Buffers / Reads, and the head row says `n columns hidden` (bug 6).
2. Toolbar: one row that never wraps at ≥ 1100 px: the search shrinks first (min 14 ch), then the labels fold to
   icons (bug 1). The `Highlighting …` chip goes; the outlined statement chip in the overview carries the × and the
   count; the count is the real one, with `first 1,000 marked` in the tooltip while the marks are capped (bug 2).
   Pressed toggles use the quiet style (ink on `--wash`); only Raw|Formatted keeps a solid segment.
3. Overview: the bar is labelled `Where the time went · 6.46 s` (11 px `--ink-3`), 12 px tall, a thin time axis under
   it, and a viewport bracket (two 1 px ticks + a 20 % wash) that follows the visible rows; chips read
   `sql_id 2.486 s · 38 %`; statements under 1 % fold into one `+4 under 1 %` chip that expands on click.
4. The header `Key: value` layout: the key column grows to the longest key of the block (bug 7).
5. Fold repeats: with it on, the run of 26 `direct path read` waits at io_waits lines 96–121 stays unfolded with no
   handle row (bug 11: find out why: the rule says runs of 3+ identical waits fold; `api/lines/repeats`, `folds.ts`,
   `repeatFold`); toggling it must keep the selected line in view (bug 12).

### E. Finish
`docs/DESIGN.md` § Formatted Lines view rewritten for the new decisions (keep the rejected alternatives), `docs/HANDOFF.md`
gets a "Formatted view round 2" entry with the commits and the evidence paths, `make web` (the embedded UI is committed),
`scripts/ci-local.sh --no-release` green, push.

## Log
(each batch appends: commit, what differs from the plan and why, evidence path)

### A. done (commit 636bd9d, not pushed; evidence `/tmp/verify-mtkprof/evidence/formatted-v2/A/`: io_waits 118 and 10378, basic_binds 48, light and dark, plus raw-mode, colour-by-wait-class and header-hover checks; drive script `drive-A.mjs` there)
All six items. Unit tests added: `waitShare` and the Operation `op`/`dot` fields (readable.test.ts), the clock prefix rule `clockFull`/`clockShort` and hot flags (readableRows.test.ts). `pnpm -r typecheck` and `pnpm --filter mtkprof-web test` (the package is `mtkprof-web`, `--filter web` matches nothing) green: 629 tests.
Where it differs from the plan or the mock-up, and why:
- **Selection beats the hot fill** (`.lv-rd.lv-sel` declared after `.lv-hot`): the plan and mock leave it to the cascade (hot would win, so `j` would land on a red row with no cursor). The hot bar and red Duration still show on a selected hot row. The selected row's Statement cell also drops the lane tint (blue over amber read grey); the 6 px band stays. The same transparent number cell applies to `.lv-range` rows (same oklch bug).
- **Idle waits are never hot spots in the row** (`readableRows.ts`: `hot` needs `bar.role !== 'idle'`), as in the mock's `model.js`. The engine's hot list (`api/lines/hot`, `j`/`J`, strip) still includes them, so `j` can land on an unmarked idle row; drop idle there if that bothers (engine change, not done).
- **Lane highlight is by lane, not by `marks`**: new `LineViewer` prop `hlStmt` (Lines.tsx passes the selected statement) and class `lv-hlane` on every row whose `lane.stmt` matches (BINDS, PLAN, blank rows included, and waits past the 1,000-wait cap); the number cell's 3 px bar still comes from `marks`. The tint is `--hl` (the statement's colour), the band `--lane`, so colour-by-line modes keep their band colour (checked with Wait class).
- **Clock**: the first-row-in-view full stamp is a class `lv-ftop` that the viewer sets on the DOM at scroll time (`markTop` in `place()` and after every render: the first row in the top 8 with a short clock), no React state per pixel. The "previous row with a clock" for `clockFull` is the previous line with a tim OR a `***` line (the mock's rule), not tim lines only, so a run of `***` lines is not all full. With folds or the Δ filter active it is still the previous trace line, not the previous displayed row. The micros are no longer dimmed (mock p9). Default width 11.7 digits (84 px in the mock: ~10 ch plus the 12 px padding); Detail keeps 6ch free at its end for the whole stamp, which reaches left into it (`flex-end`). `FORMATTED_COLUMNS.clk.def` is 11.7.
- **Operation column**: COMMIT / ROLLBACK count as calls (loud); ERROR, LOB, RPC and FILE rows keep their old tone. The wait share, `op` and the dot are separate `LineView` fields (`waited`, `op`, `dot`), not part of `parts`, so the existing detail-text tests stay as they were. `.rd-evobj` (the object of a wait) went to `--ink-2` as in the mock's section 4.
- **Duration header**: it was already right-aligned; the 3.5ch padding was in the header's font and 0.5ch off (the unit slot is 3 digits of the rows' font): now `3 * --lv-chw`, exact to the pixel.
- **A-Time cell** grew 12ch to 14ch for the 4ch track (starts 2ch in, a gap from Cost); batch D restructures it anyway. The plan's hot-cell rule is `.lv-tb .pc.pc-hot`; `PlanRow.hot` is set in `readableRows` from the new `hotUs` input (1 % of the file span, Lines.tsx).
- Not touched (as scoped): raw mode (its `.lv-mk`/`.lv-sel` rules are unchanged: the cyan number cell on a selected raw row remains), the colhead colour/size of mock section 10, DESIGN.md/`make web` (batch E).
Hooks for later batches: `ReadableCell.plan.hot` and `--hot-fill` (the D table); `LineView.op` (the Operation weights, C's `exec N` tag and `▾ PLAN` handle); `hlStmt` on the viewer (C's sticky lane row knows the highlighted lane).
Blockers for B: none. Note for B: `.lv-hot > :first-child` is the time cell (`.lv-bar`), which B moves/reshapes: keep the 3 px red bar on whatever is the first cell; `.lv-dhit` (Δ filter hit) still overrides the hot fill and start bar on a row that is both (existing cascade, left as is).


### B. done (commit a8a306f, not pushed; evidence `/tmp/verify-mtkprof/evidence/formatted-v2/B/`: io_waits 118, 10378 and 36, basic_binds 48, light and dark; Δ-emphasis shots io_waits 775 and 6887 and basic_binds 86 (light, dark); Δ pinned at 118; raw mode; 3x zooms; drive scripts `drive-B*.mjs` there)
All three items. `pnpm -r typecheck` and `pnpm --filter mtkprof-web test` green (645 tests). New pure helpers in `data/linetime.ts` (`unexplainedGap`, `gapDelta`, `GAP_MIN_US`, `barFrac`, `magnitudeOf`) with tests there; the cell fields in `readableRows.ts` (`trackW`, `trackCpuW`, `fromPin`, `deltaUs`, `deltaEmph`) with tests (gap never negative, blank under 50 µs, the emphasis boundaries, the PARSE at io_waits 39 blank, the tooltip keeps tim-to-tim, a pin turns the column back).
Where it differs from the plan or the mock, and why:
- **Existing tests changed (3), not just kept**: `Δ is the time from the line with a time before` (+121 µs) is the old meaning and became the pinned test plus the gap tests; `hot spots and bars on the file scale` (`barW` 0.5) became the log-scale `trackW` test; every `scaleUs: …` argument was dropped from the test inputs.
- **The linear scale is deleted, not kept dormant**: `ReadableInputs.scaleUs`, `ReadableCell.barW/cpuW`, `Fold.w` and the `max` of the hot-spot state in `Lines.tsx` (it only fed `scaleUs`) are gone; a fold row's track is `barFrac(fold.us)` in `other`.
- **Δ is the gap of the plan, not the mock's main panel** (the mock's p3 keeps tim-to-tim with a 50 µs floor; its `p3gap` variant is the plan's rule). So a call that follows waits it covers (FETCH 122, the 637 ms line) has a blank Δ; the gap shows on the first wait after the previous call. Reference line = the previous line with a tim of any kind (the plan's wording, and the mock's `prevT`), not `gapBefore`'s calls-only reference.
- **The ramp on Δ is weight only** (µs 400, ms 500, s 650, colour stays `--ink-3`; amber when emphasised); the mock ramps only the Duration numbers and dims Δ, and the plan's item 3 also names Δ, so weight is the compromise. The Δ from a pin keeps its old look (ink, dim when before the pin, regular weight).
- **Column defaults**: `dur` 20 digits (10 for the number + the 72 px of gap, 56 px track and pad: `--d-dur`), min 136 px so a width saved by an older version (72 px) is clamped instead of cutting the track; `bar` (now the Δ column) stays 12 digits: its longest text is 8 characters + 16 px padding, 11 digits would clip `+10.5 min`. The `bar` key and `--w-bar` name are kept (saved `cols` widths); the header still reads `Δ · time`. The Duration header's right padding is now `--trk-tail + 4px + 3 digits`.
- The call phase colour is `--c-phase-<parse|exec|fetch|close>` (other calls `--c-phase-other`); a track is drawn on every row with a duration (empty at < 1 µs), so the numbers line up.
- Not exercised in the app: a fold row's track (Fold repeats folded nothing in the sidecar engine build on io_waits at lines 100 and 6900: batch D's bug 11); the code path is the same `DurCell`. Zero durations in `--ink-3` (C item 2) not done.
- `docs/PLAN-FORMATTED-V2.md` is still untracked (batch A did not commit it either); only `web/src` is in a8a306f.


### C. done (commit cdb1133, not pushed; evidence `/tmp/verify-mtkprof/evidence/formatted-v2/C/`: io_waits 118, 10378, 3000, 84 and basic_binds 48, light and dark; `*-scrolled-*` are the same go-tos scrolled 10 rows (the sticky lane row in mid-lane); `keys-*.png` and `drive-C-keys.mjs` (ArrowUp/Down over folded lines, `z`, search, `i`); raw mode `io_waits-raw100-light.png`; drive scripts `drive-C*.mjs` there)
All five items. `pnpm -r typecheck`, `pnpm --filter mtkprof-web test` (665) and `go test ./internal/slice ./internal/engine` green. Tests added: run detection / ditto / micro-columns, the bracket (which waits belong to which call, idle excluded, WAIT #0), the first row of an execution, the CURSOR one-row text, CLOSE wording, `#bytes=1` dropped, bind chips, `bindFolds` inline blocks, `frameFolds` (and that the lines vanish from and return to the layout), `mergeFolds` on 60,000 folds, and the Go `TestLinesBlocksFrame`.
**The one engine change**: `api/lines/blocks?what=frame` (Go `frameBlocks` in `internal/slice/lines_blocks.go`, openapi enum + text, `desktop/src/engine/api.d.ts` regenerated; additive, no protocol bump, an older engine answers 400 and the view just keeps the lines as rows). The framing folds must be global like every fold (a goto far down lands on the wrong line if the folds above it load lazily with the pages), and a client guess from `Cursor.line` is wrong on `nasty_sql.trc` (END OF STMT inside the text), so the engine lists, for each PARSING IN CURSOR of the file, the `=====` before it and its END OF STMT, each checked with `trace.Classifier`. The client folds each quietly under the line above it (`Fold.frame`); `mergeFolds` is now linear (it was O(n²) and the frame folds are two per cursor). The desktop rebuilds its sidecar from the same source.
Where it differs from the plan or the mock, and why:
- **Blank lines are folded only where they already were** (under a BINDS header). The other blanks (before a `***` timestamp, after a marker group, a handful per trace) stay rows: the engine has no list of them and finding them is a read of the whole raw file, which a 2 GB trace should not pay for 4 rows. Say so if you want it (a Go pass over `LineIndex` cached per file).
- **Inline binds by count, not by value length**: a BINDS block of ≤ 4 binds is one quiet fold (`Fold.inline`, `INLINE_BINDS`) and its chips are cut at 40 characters (`bindChip`, the full value in the tooltip); the plan's "of ≤ 24 chars" needs the values, which an engine session's document does not have until each header is asked of `/api/at` one by one, and the folds must be known up front. `z` on such a row (or a go-to/search into one of its lines) opens it as the table, with its attribute lines folded under each bind as for a bigger block; `Lines.tsx` swaps in `bindFolds(block)` for the opened ones.
- **The rule above a CURSOR row** is drawn from "the line above is hidden by a quiet fold and this is a PARSING IN CURSOR line" (`--hairline-strong`); a rule whose line above is a table row or a repeat fold's last line stays a row (the fold would take the table's head away; `frameFolds(…, skip)` and `mergeFolds`' overlap rule). The dotted gap mark (a 1 px dotted rule at the top of the number cell, an element `.lv-gapmark`) is on any row after a quiet fold except a rule-top one.
- **Sticky lane row in formatted mode replaces `.lv-head`** (the statement of the top line when it is not the selected one): it shows for every top row in a lane except the selected line and a CURSOR row (that names itself), from the band column (the Δ and number cells of the top row stay visible, built from the same `lv-bar`/`lv-ln` spacer cells so the widths match), `${elapsed} here · exec N of M` (`stats.executions`; no exec when the line is in none). The old `BINDS of exec #N` / `STAT dump` block note is gone in formatted mode. Raw mode keeps `.lv-head`.
- **The lane column is 14 px** (`--d-lane`, `FORMATTED_COLUMNS.lane.def` 2 digits, min 14, header label empty, the grip kept); the old label/sub and the `↳n` badge on rows are gone (the badge is in the sticky row); `Lane.label/sub` stay in the data (tests, tooltips). `--lane` moved from the lane cell to the row so the bracket can use it.
- **`execNo` 0 means "in no execution"** (a CLOSE has x=0, not -1): the sticky row and the `exec N` tag need `> 0` (the old head's `>= 0` shows `exec #0` on a CLOSE; left alone in raw mode).
- **Table-style BINDS rows carry the `exec N` tag** as an extra 10 ch first cell of the table (head row; an empty cell on each bind row so the columns still line up), as the mock's non-p8 variant does; batch D restyles the tables anyway. The handle `▾` of a plan/BINDS table is in the head row's Operation cell (`▾ PLAN`, `▾ BINDS`; the plan's on its head row, a `button[data-act=fold][data-ln]`); other foldable lines (long SQL text) keep the handle column. The overlay head row of a plan has no handle.
- **Runs** are decided from the lines around a row (±60, through waits/markers/blanks, until another kind of line): ≥ 3 waits of one event and object, userio waits of exactly file / block / blocks; the prefix is not padded to the longest prefix of the block (all rows of a run share it, so they align; two runs of different events do not align with each other). **Bracket** scans ±300 lines; past that (or an unloaded page) a non-idle wait is drawn as inside (`in`) and the rule is not cut. `readableRowsOf` is rebuilt when pages load, so a row computed at a page edge is recomputed.
- Not done / left: 0 µs in `--ink-3` is done (`.lv-dnum.zero`); `hard close` wording is `closed`/`cached` with the old words in the tooltip, and the one existing test that asserted `hard close` (`readable.test.ts`) was changed to `closed` (plan: wording is C). `z` on an opened framing handle does nothing (it only opens; `Z` is for user folds).
Note for D: the plan/bind table cells start at the Detail column (x of Detail), not the Operation column: that is D's item 1. The rows' height is unchanged; the BINDS table's exec tag cell (`.pc-tag`, 10 ch) shifts its columns right by that much.


### D. done (commit 903ede1, not pushed; evidence `/tmp/verify-mtkprof/evidence/formatted-v2/D/`: io_waits 118, 10378, 84 and basic_binds 48, light and dark, at 1600×1000 (`*-1600-*`) and 1280×900 with the side panel open (`*-panel-1280-*`), io_waits 118 at 1280 without the panel (`*-nopanel-1280-*`), 8 binds at io_waits 160 (`*-binds-*`), the trace header at io_waits 1 (`*-header-*`), raw mode (`*-raw-*`), the toolbar at 1100…1800 px with the pin, the Δ filter and Fold repeats on (`toolbar-*.png`), the overview bar (`overview-*.png`: label, axis, bracket, `+4 under 1 %` open, after the ×), Fold repeats at line 96 (`repeats-before/after-click-96.png`) and at 118 (`repeats-*-click-118.png`, `repeats-open-run-handle.png`, `repeats-run-folded-again.png`); drive scripts `drive-D*.mjs` there)
All five items and the dittoed-dot defect. `pnpm -r typecheck`, `pnpm --filter mtkprof-web test` (690) and `go test ./internal/slice ./internal/engine` green. No route changed (no `gen:api`, no protocol bump); `make web` and DESIGN.md/HANDOFF are still batch E.
**Bug 11, the cause**: not the engine and not the client's fold merge. `api/lines/repeats` answers the run (`{from:96,to:121,kind:run,n:26}`, with the UI's `small=64587` too; Go test `TestLinesRepeatsIOWaitsRun`), and the merge keeps it. What the runs showed (batch B's "nothing folded at lines 100 and 6900", the mock's "stayed unfolded") is a go-to into a run: `goTo` opens the fold that hides the target line by adding it to `openRepeats`, for good, and an opened fold of repeats had no handle anywhere (`foldable` knows blocks only), so it read as unfolded with no handle row, and neither `z` nor a click folded it again. The io_waits state of the composites (line 118 selected) is exactly that. Fix (`standingFolds`, tested in folds.test.ts): the selection is never folded away, so a run holding the selected line stands open and folds again when the selection leaves it; an opened run (by the user's ▸ or by the selection) keeps a ▾ on its first line, and `z`/a click on it folds it again, moving a selection inside it to the handle line. At line 96 (the handle itself) the run folds into its one handle row at once. **Bug 12**: the viewer's folds-changed effect kept the first visible line; in the formatted view it now keeps the selected line where it is on the screen when it is in view (checked: row top 586 before and after the toggle at 96 and at 118). Raw mode keeps its old behaviour.
Where it differs from the plan or the mock, and why:
- **`SQL with values →` is at the end of the last bind row, not a row of its own**: a row after the last bind needs a new kind of layout row (a foot like the head); the link on the last bind's row is the same reading without it. The BINDS head keeps the `exec N` tag cell (batch C) between `▾ BINDS` and Variable.
- **Column drops are decided by JS from the measured width** (`data/planlayout.ts`: `planHidden`, `PLAN_DROP`, `hiddenNote`; the viewer reads the Operation/Detail/Clock header cells with a ResizeObserver), not by CSS, so the head row can say `n columns hidden` (in Operation's cell; a cell too narrow for the word says only the count). The 1280 px shot with the 400 px panel open drops all five (the table is 520 px; Cost, E-Rows, Starts go first, then Writes and Name), and the Operation cell is then 12 digits (`TABLE ACCES…`, the tooltip has it). Without the panel nothing drops at 1280.
- **Toolbar thresholds are measured**, not guessed: with everything on (pin, Δ filter on, search at 14 digits) the row needs 1362 px of bar with all labels, 1232 without `.tb-f1` (the Go-to label), 1051 without `.tb-f2` (Colour label and mode, the Δ filter's mode and count, the window text), 921 without `.tb-f3` (Hot spot, Δ ≥, Δ from), 804 without `.tb-f4` (Raw/Formatted text and `v`); the container queries (87/79/67/59 rem) leave a margin. One row at 1100, 1180, 1280, 1400, 1600, 1800 (script `drive-D-toolbar.mjs`); it may wrap below 51 rem. The raw view keeps its Highlighting chip (it has no overview bar); in the formatted view the chip is gone, and the highlighted statement is always a chip in the bar, even when it is not among the 8 longest.
- **The count** on the outlined chip is the real one: `StmtMarks` has `totalCalls`/`totalWaits` (local doc and engine totals), and its tooltip says `first 1,000 waits marked` while the marks are capped (the Step menu and the marks themselves are as before). With several files the real count is the statement's in all of them, as the totals are.
- **Overview**: the track is DOM spans (not SVG) like the mock; the axis ticks are round wall-clock times (`data/overview.ts` `axisTicks`; offsets `+2 s` for a trace without a wall clock); the bracket is moved by the viewer's view-change callback without a React render (`viewSpan` reads the loaded lines in view; none loaded, no bracket).
- Header keys (bug 7): `ReadableCell.keyW`, the longest key of the contiguous header block (±60 lines), `--kw` on the row; the old 26 ch minimum stays only as the fallback.
- The dot fix: a micro-column row draws the dot inside its prefix only (`rd.dot && !rd.micro` for the one before the detail).
- Not done: the fractional first row under the sticky lane row (a go-to centres at `idx − (rows−1)/2`, a fraction when the view's height is not a multiple of 20 px; it peeks a sliver above the sticky row; the mock's rows are aligned): `revealTop('center')` could round, left alone.


### E. done (the docs commit and "Rebuild the embedded UI"; evidence `/tmp/verify-mtkprof/evidence/formatted-v2/E/`: io_waits 118 and 10378, basic_binds 48 at 1600x1000, light and dark, drive script `drive-E.mjs`)
- **The one fix**: `revealTop` (`data/scrollmap.ts`) returns a whole number of rows for `center` (rounded) and for `nearest` below the view (rounded up so the line stays fully visible); the viewer's go-to, `j`, the chips and the pending reveal all go through it, raw mode too. Unit test in `scrollmap.test.ts`. Checked: the first row under the sticky lane row at io_waits 118 is whole (the D shot had the sliver).
- `docs/DESIGN.md` § Formatted Lines view rewritten as implemented (rejected alternatives kept, the round's added); `docs/HANDOFF.md` has the "Formatted view round 2" entry with what is open; `docs/ARCHITECTURE.md` got a `lines/blocks` row (with `what=frame`), a paragraph on the formatted mode (sticky lane row, gap Δ, global folds) and the stale "scale of the time bars" note on `lines/hot`'s `max` fixed. The plan is committed; the mock-up `docs/mockups/formatted-v2/` already was (`135e202`, with all its shots, 37 MB, already on origin).
