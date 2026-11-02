# Lines view: assistive navigation and line context — implementation plan

From a review of the Lines view on 2026-10-30 (`engine/web/src/lib/views/Lines.tsx`,
`components/LineViewer.tsx`, `data/lines.ts`, `internal/slice/at.go`). The view is a fast reader
with colour by kind, search, jump to time, bookmarks, notes, window marks and gutter marks for the
selected statement. What it lacks: the text itself is inert (cursor numbers, sql_ids, `obj#`,
`tim=`, `ela=` are plain characters), context appears only after a click and only as labels, there
is no go-to-line, no structural stepping beyond the selected statement's marks, no outline of the
file, and the hit list does not know which statement a hit belongs to.

"Lib" marks work in the engine submodule's shared UI (`engine/web/src/lib`), "Engine" work in its
Go server (`engine/internal/slice`, `engine/api/engine.openapi.yaml`), "Desk" work in this repo.
Lib and Engine changes are committed in `modern-tkprof` and pinned here (HANDOFF.md § "The two-repo
workflow"): `make web` + Go rebuild in the submodule, `pnpm build:engine` here. Every lib change
needs `cd engine/web && pnpm typecheck`; every engine route change needs `go test ./internal/engine`
(the OpenAPI contract test) and the spec updated in the same commit.

Reproduce and check with the dev browser recipe in the README ("Dev browser mode"); traces from
`engine/testdata/traces/19c/` (`basic_binds.trc` for binds and plans, `io_waits.trc` for waits,
`multisession_a.trc` + `multisession_b.trc` for markers and files, `big_loop.trc` for size).

## Status (2026-10-30)

All three phases landed in `modern-tkprof` (Phase 1: c1f48b4, 48daeac, 95ef75b; Phase 2: 08ed659,
bd92a5f, 60ca3f6, 02a58a5; Phase 3: 96b88bd, f43d520, 0daa5a0, a35b387, 3982911) and are pinned here. Tick an item here when it lands and
add a **Done** line under it with the commit and what differs from the plan.

| Item | Phase | Where | Status |
|---|---|---|---|
| 1.1 Hover decode cards | 1 | Lib | done |
| 1.2 Elapsed heat gutter | 1 | Lib | done |
| 1.3 Go to line, cursor, sql_id, execution | 1 | Lib | done |
| 1.4 Line card actions | 1 | Lib | done |
| 1.5 Search presets and scopes | 1 | Lib | done |
| 1.6 Keyboard map and muted kinds | 1 | Lib | done |
| 1.7 Jump history in the status bar | 1 | Lib | done |
| 2.1 `lines?annot=2`: ids per line | 2 | Engine | done |
| 2.2 Live references in the rows | 2 | Lib | done |
| 2.3 Sticky context header | 2 | Lib | done |
| 2.4 Cursor focus | 2 | Lib | done |
| 2.5 Hits with their statement | 2 | Lib | done |
| 2.6 Outline panel | 2 | Lib | done |
| 3.1 `at` with execution span and neighbours | 3 | Engine | done |
| 3.2 `lines/next`: structural stepping | 3 | Engine + Lib | done |
| 3.3 `lines/profile` and the density strip | 3 | Engine + Lib | done |
| 3.4 Line drawer parity | 3 | Lib + Desk | done |
| 3.5 Folding and block copy | 3 | Lib | done |

Order inside a phase is by value; phases are by dependency (Phase 2 rests on 2.1, Phase 3 on its
endpoints). Each item is one PR in the repo it touches; an item that spans both repos lands
engine first, then the pin.

## Phase 1: no engine change

### 1.1 Hover decode cards

**Where:** new `lib/data/linefields.ts` (pure parsing, unit tested) and a `LineCard` popover in
`lib/components/LineViewer.tsx`; the row gets a `title`-free hover target (the popover, not a
native tooltip, so it can hold a table).

**Change:** parse the fixed grammar of one line's text (`docs/trace-format-19c.md`):

- Call lines (`PARSE`/`EXEC`/`FETCH`/`CLOSE #N:`): `c` CPU µs, `e` elapsed µs, `p` physical
  reads, `cr` consistent gets, `cu` current gets, `mis` hard parse (1) or not, `r` rows, `dep`
  recursive depth, `og` optimizer goal (1 ALL_ROWS, 2 FIRST_ROWS, 3 RULE, 4 CHOOSE), `plh` plan
  hash, `tim`; CLOSE `type` (0 hard, 1 soft and cached, 2 soft, 3 cached). Durations are shown with
  `fmtDur`, `tim` as the offset from the trace start and, with `doc.wallOffsetUs`, as a clock time
  (`data/clock.ts`).
- Wait lines: event name, `ela`, then `p1..p3` named by `doc.events[...].p1Name..p3Name` (the trace prints them as
  `file#=`, `block#=`, `name|mode=`, `driver id=`, so the raw labels are the fallback), `obj#` with the object
  name when the ref bundle knows it (`doc` plan lines carry `owner.object` by `obj`), the wait
  class (`doc.events[...]`).
- STAT lines: `id`, `pid`, `cnt`, `obj` (name as above), `op` and the parenthesised stats (`cr`,
  `pr`, `pw`, `str`, `time`, `cost`, `size`, `card`).
- `BINDS #N:` and `Bind#n` blocks: the bind position, `oacdty` as a type name, `mxl`, `avl`, and
  the `value=` line; a bind without `value=` says so (dup, NULL, memory dump).
- `XCTEND`: commit or rollback, read-only.
- `PARSING IN CURSOR`: `len`, `dep`, `uid`, `oct` as the command name, `lid`, `hv`, `ad`, `sqlid`.
- `ERROR #N:err=` / `PARSE ERROR`: the ORA number, text from `oraErr` where known.

The card opens after 350 ms over the row text (not the gutter), closes on leave, scroll or key,
and never steals focus. One card component, rows unchanged (no per-row listeners: the viewer's
container handles `pointermove` and reads `data-ln`).

**Check:** `basic_binds.trc`: hover an EXEC line shows CPU, elapsed, rows, hard parse, depth,
goal, plan hash and a clock time; a WAIT `db file sequential read` shows file, block, blocks,
object name; a STAT line shows op, rows, cr, time; a `Bind#0` line shows type and value.
`pnpm test` covers the parser on the fixture lines of each kind.

**Done** (c1f48b4): `data/linefields.ts` + tests, `LineCard` portalled to `document.body` (the
layer's `will-change: transform` would have contained a fixed card); LOB and more marker lines decode
too; the card opens only over the text span, touch pointers are ignored.

### 1.2 Elapsed heat gutter

**Where:** `LineViewer.tsx` `Row`, `lines.css` (`.lv-gut`), `linefields.ts` (a cheap `elaOf(text, kind)`).

**Change:** for call and wait rows, parse `e=` or `ela=` of the rendered rows only (~100) and draw
a 3 px bar in the right gutter whose length is `log10(µs)` scaled to the gutter width (1 µs
nothing, 1 ms a third, 1 s full), tinted with the row's tone. A `title` on the bar gives the
duration. The bar is below the row actions, so the selected row keeps its Copy and Link buttons.
Toggle in the toolbar (`Heat`, on by default, kept in `LinesUi`).

**Check:** `io_waits.trc`: the long waits stand out while scrolling; a 1 s wait fills the gutter;
switching Heat off removes the bars; scrolling stays at 60 fps in the Performance panel
(the parse is on `Row` render only, memoised by text).

**Done** (c1f48b4): the bar is `log10(µs)/6` of the gutter (1 ms is half, not a third), under the
row actions (the gutter became a column).

### 1.3 Go to line, cursor, sql_id, execution

**Where:** `Lines.tsx` `runJump` and `data/lines.ts` `parseJump` (rename the box "Go to").

**Change:** the Go to box accepts, besides the times it takes today:

- `12345`, `L12345`, `:12345`: a line (a bare number below the first tim is seconds today;
  keep that for numbers with a unit, and make a bare integer a line: say so in the placeholder).
- `#140124363561040`: the cursor's PARSING IN CURSOR line in this file (`doc.cursors` by `number`
  and file; several parses of the same number: the nearest after the selected line, wrapping).
- a 13-character sql_id, or a sql_id prefix with `*`: the first cursor of that statement in this
  file (`doc.statements` → `cursors` → `line`); `9h8pw1x9xgbsj/3` execution 3 of it: the EXEC line
  from `api/executions?stmt=` (`source.ts` has the query; the row with that `execNo`) or, without it, the cursor line.
- Errors name what was tried: "no cursor #… in this file", "no statement 9h8…".

A click on the result selects the line as a click does (resolves the at bar).

**Check:** each form lands on the right line in `basic_binds.trc`; a sql_id that is only in
`multisession_b.trc` says so while `_a` is open; `1.5s` and `14:03:07` keep working.

**Done** (48daeac): `parseGoTo` in `data/lines.ts`; a bare number is a line, a bare tim is no longer
accepted; `sql_id/N` fetches the executions with an all-inclusive scope (`ALL_SCOPE`), not the views'
filters, and follows a row into another file with `openLinesAt`.

### 1.4 Line card actions

**Where:** `Lines.tsx` the `lines-at` bar, split into its own `LineCard` component
(`lib/views/LinesAt.tsx`), `state/store.ts` for any action it needs.

**Change:** the bar keeps its labels and adds actions after each object:

- Statement: *Open* (`selectStmt`: the Statements workbench with the detail), *Mark*
  (`pickStmt` without leaving the view: the gutter marks follow it; today a click already does
  this, the button makes it explicit for a line that belongs to another statement than the
  marked one), *Parsed at* (the cursor's `line`, `goTo`), elapsed and executions of the statement
  from `doc.stats.statements` so the card says how big it is.
- Execution: *Open* (the Statements workbench with `selectExec`, which opens the Executions
  section at it), *Binds* (`api/executions/detail` `bindLine`, `goTo`), *EXEC line*.
- Wait: *Open event* (today's link), *Waits of this event on this statement* (the Waits view with
  the event selected and the statement filter), the object name after `obj#`.
- Cursor: number, depth, plan hash, `execs`, *Plan* (`selectStmt` + the plan section; the
  `planHash` is on the cursor).
- Context: session id, module, action from `doc.contexts[ctx]` with *Open session*
  (the Sessions view with `setContexts(new Set([ctx]))`).

Everything stays on one line at 1440 px and wraps to two at 1024 px; the card is empty-safe for
header and blank lines ("no statement at this line" as today).

**Check:** on `basic_binds.trc` click an EXEC line: Open lands in the statement's detail with that
execution expanded; Binds lands on its `BINDS #` line; on a WAIT line the object name shows; on a
`*** SESSION ID` line Open session lands in Sessions.

**Done** (48daeac): `views/LinesAt.tsx`. Execution Open calls `selectStmt` then `selectExec`
(`selectStmt` clears `exec`); Binds / EXEC line fetch `executions` + `executionDetail` on click and
cache the detail; "Waits of this statement" is `pickStmt` + `selectEvent` + `setView('waits')`.

### 1.5 Search presets and scopes

**Where:** `Lines.tsx` the search form and `LinesPanel.tsx`.

**Change:**

- A *Presets* menu (`ToolbarMenu`) next to the search box with regex searches that fill the box
  and run: Errors (`^(ERROR #|PARSE ERROR)`), Hard parses (`^PARSE #.*mis=1`), Waits over 10 ms
  (`ela= \d{5,}` with a prompt for the threshold), Long calls (`,e=\d{6,}`), Commits
  (`^XCTEND`), Session markers (`^\*\*\* (SESSION|CLIENT|MODULE|ACTION)`), Top-level parses
  (`^PARSING IN CURSOR.*dep=0`), Plan dumps (`^STAT #.*id=1 `).
- Scopes: a *Scope* segment: whole file (today), the time window (`winRange` → `from`, stop at
  `to`: the client aborts the stream at the first hit past `to` and reports it), the selected
  statement (post-filter the hits with the mark lines: a hit between the statement's cursor parse
  and close counts; exact per-hit ownership comes with 2.5).
- The last five searches are kept in `LinesUi` as chips above the hit list; clicking one re-runs
  it. Each keeps its hits until re-run, so switching back is instant.

**Check:** Errors preset on `multisession_a.trc` lists the ORA lines; the window scope lists only
hits in the window's lines; a re-run from a chip shows the same count.

**Done** (95ef75b): the statement scope starts the stream at the first mark and cuts it after the
last one (same hits as a post-filter, fewer lines scanned); clipped searches have no `scanned`
count; the threshold presets take their milliseconds from a field in the Presets menu (no
`prompt()`, which a webview may not show).

### 1.6 Keyboard map and muted kinds

**Where:** `LineViewer.tsx` `onKeyDown`, `Lines.tsx` `onKeyDown`, a `?` help popover in the
toolbar, `lines.css` for muting.

**Change:** keys in the viewer (no modifier, not in a text field; the viewer already owns arrows,
Page keys, Home, End and `b`):

| Key | Action | Needs |
|---|---|---|
| `/` | focus the search box | 1 |
| `g` | focus the Go to box | 1.3 |
| `Enter` | open the statement of the selected line (`selectStmt`) | 1 |
| `m` / `M` | next / previous mark of the selected statement (the toolbar's ▲ ▼) | 1 |
| `h` | toggle the heat gutter | 1.2 |
| `]` / `[` | next / previous call | 3.2 (client-side within loaded pages until then) |
| `w` / `W` | next / previous wait | 3.2 |
| `c` / `C` | next / previous PARSING IN CURSOR | 1 (`doc.cursors`) |
| `e` / `E` | next / previous error | 1 (`doc.errors`) |
| `x` / `X` | next / previous commit | 3.2 |
| `f` | focus the selected line's cursor | 2.4 |
| `?` | the key map | 1 |

Muted kinds: a *Mute* menu with checkboxes per kind group (framing: blank, header, separator;
binds; STAT; markers). Muted rows get `opacity: .45` through a class on the viewer
(`lv-mute-binds` …), no change in line counts or scrolling. Kept in `LinesUi`.

**Check:** every key does its action with the viewer focused and nothing while typing in the
search box; muted binds dim the `BINDS` blocks of `basic_binds.trc` and the status bar still
counts every line.

**Done** (95ef75b): `]`/`[`, `w`/`W`, `x`/`X` step within the loaded pages
(`PageCache.nextOfKind`) until 3.2; keys are ignored when the target is a button; a Waits group was
added to Mute.

### 1.7 Jump history in the status bar

**Where:** `Lines.tsx`, `LinesUi`.

**Change:** every `goTo` from a jump (search hit, mark, bookmark, Go to, line card action, deep
link) pushes the line it left onto a per-file stack (cap 50); the status bar shows *← back to
line N* while the stack is not empty, `Backspace` in the viewer pops it. Arrow and page movement
does not push. (The desktop's Back/Forward in `navHistory.ts` replaces entries while stepping
through lines of one file, so this stays inside the view and is independent of it.)

**Check:** search, step three hits, Backspace three times returns to the line before the search.

**Done** (48daeac): `LinesUi.back` + `cur`; `jump()` wraps `goTo` for every jump site; a
first-visit deep link does not push (nothing to return to).

## Phase 2: ids per line

### 2.1 `lines?annot=2`: ids per line (Engine)

**Where:** `internal/slice/lines_annot.go`, `at.go` (the file info and binary searches),
`api/engine.openapi.yaml` `/s/{id}/api/lines` (`annot` enum gains `"2"`), `lines_api_test.go`.

**Change:** `annot=2` answers `{from, total, lines: [{t, k, c, s, u, x, w}]}`: per line the call
id `c`, statement `s`, cursor `u`, exec number `x` and wait id `w` by the rules of `api/at`,
-1 where absent and omitted from the JSON when all are -1 (framing lines). Computed per page in
one pass: binary search the first call row and first wait row whose line is ≥ `from`, walk both
forward to the page's last line, and assign ids by the same switch `at` uses (cursor text lines
from `fileInfo.cursors`, STAT from `plans`, BINDS from `bindOwner`). Cost is O(page + rows in
the page) and one page fetch; measured against `big_loop.trc` to stay under the 20 ms budget of
HANDOFF § "Budgets" (`annot=1` is < 20 ms there).

Lib side: `fetchLinesAnnot` takes a `rich` flag, `PageCache` keeps the ids as parallel
`Int32Array`s next to `kinds`, `cache.line(n)` returns them; the view asks for `annot=2` and the
at bar fills from the cache at once (the `api/at` call stays for `ctx`, `bindSet` and `planLine`,
which the page form does not carry).

**Check:** the contract test passes; `lines_api_test.go` compares `annot=2` ids of every line of
`basic_binds.trc` with `api/at` of the same line; `annot=1` answers are unchanged byte for byte.

**Done** (08ed659 engine, bd92a5f lib): `internal/slice/lines_annot2.go`; `TestLinesAnnot2MatchesAt`
compares every line of every fixture with `api/at` on the mem and disk handlers (130k lines).
`big_loop.trc` is not in this checkout, so the 20 ms budget is measured only on the small fixtures
(0.9–1.35 ms per 2000-line page). The standalone `LinesHandler` (no model) answers `annot=2` like
`annot=1`. The card fills from the cache at once; `api/at` still adds ctx, bind set and plan line.

### 2.2 Live references in the rows

**Where:** `LineViewer.tsx` `Row` (the text run), `components/StmtLink.tsx`, `linefields.ts`.

**Change:** the row text is cut into runs with links where the text names something the model
knows: `#N` on call, wait, STAT and BINDS lines links to the statement of the line's cursor
(the id from 2.1; the link's `title` is the sql_id and a 60-character preview), `sqlid='…'` is a
`StmtLink`, `obj#=N` / `obj=N` get the object name as a title and a link to the plan line when
the statement's plan has that object, `plh=N` links to the plan with that hash. Links use
`data-act` like Copy and Link, so the container's click handler dispatches them and the rows stay
memoised on `(text, kind, ids)`; a click on a link does not also select the row. Search match
highlighting composes with the runs (`highlightRuns` over the plain runs).

**Check:** on `basic_binds.trc` clicking `#139851226503912` of an EXEC line opens its statement;
a search for `EXEC` keeps both the marks and the links on the same row.

**Done** (60ca3f6): `data/linerefs.ts` (`refRuns`, `mergeHits`); links are `<a data-act="ref">`
without href (mouse only); tooltips are set once on first hover from the cached ids; a plain click
on a cursor or sqlid opens the statement, Shift+click jumps to its PARSING IN CURSOR line; `obj`
jumps to the plan line; a Refs toggle in the toolbar.

### 2.3 Sticky context header

**Where:** `LineViewer.tsx` (a pinned row above the layer), `Lines.tsx`.

**Change:** one row pinned at the top of the viewer shows the statement (sql_id, preview) and
execution (`#x`) of the first visible line, from the cache ids of 2.1 (no request while
scrolling). A click on it jumps to the cursor's PARSING IN CURSOR line; a second pinned line
shows the enclosing block when the top line is inside a BINDS or STAT block ("BINDS of exec #3,
line 12,345"). Hidden when the top line has no statement.

**Check:** scroll into a long bind block of `basic_binds.trc`: the header names the execution
throughout; at the file header it is hidden.

**Done** (60ca3f6): one pinned row as a sibling above the scroll container (the viewer shrinks by a
row); the BINDS / STAT block is a second segment of the same row, with the block's first line when
found within the loaded pages; not refreshed on resize (it would flicker at the file's end).

### 2.4 Cursor focus

**Where:** `LineViewer.tsx`, `Lines.tsx` (`LinesUi.focus`), `lines.css`.

**Change:** *Focus* (toolbar, key `f`) takes the selected line's cursor id and dims every row of
another cursor (rows without a cursor are dimmed too); the status bar says "focus: cursor #N of
9h8pw1x9xgbsj · Esc clears". Pure CSS class per row from the cache ids.

**Check:** focus on an EXEC of `basic_binds.trc`: its PARSING IN CURSOR, calls, waits, binds and
STAT lines stay bright, the rest dims; Esc clears.

**Done** (bd92a5f): rows without a cursor dim too; the selected row stays at 70 %; Esc clears only
after a running search had its turn.

### 2.5 Hits with their statement

**Where:** `LinesPanel.tsx` `HitList`, `Lines.tsx` search, `data/lines.ts`.

**Change:** the server's hit carries only `line, col, text`; the view resolves the statement of
each hit from the page cache when the page is loaded, else lazily (the hit list is virtualized:
resolve the visible hits by loading their pages, at most 20 pages in the LRU today, raised to 40).
The list shows a sql_id chip per hit and a *Group by statement* toggle (statement, count, first
hit; a group expands to its hits). The statement scope of 1.5 then uses exact ownership.

**Check:** search `WAIT` on `basic_binds.trc`: every hit shows its sql_id; grouped, the counts
add up to the hit count.

**Done** (02a58a5): pages are loaded only for the hits in view (not the overscan) and, in group
mode, for opened groups, so a sparse hit list cannot thrash the 40-page LRU; the statement scope
drops a hit whose loaded line belongs to another statement and keeps hits on unloaded pages.

### 2.6 Outline panel

**Where:** new `lib/views/LinesOutline.tsx`, a third tab in the Hits & bookmarks menu (which
becomes *Navigate*), `data/doc.ts` for a per-file cursor index.

**Change:** a virtualized tree of the open file: session markers (`doc.contexts` of the file, by
line: session id, module, action) → the cursors parsed under them (`doc.cursors` of the file by
line: `#N`, depth, sql_id, 60-character preview, `execs`, elapsed from `doc.stats.statements`) → their
executions (exec number, elapsed, line: `api/executions?stmt=` on expand, the rows of that cursor). A click jumps
and selects the line; the node of the selected line is highlighted as the selection moves (binary
search by line). A filter box narrows by sql_id or text. Depth > 0 cursors are collapsed under
their parent's node by default (parent = the last cursor of lower depth before them).

**Check:** `multisession_a.trc`: the tree shows its sessions and cursors in file order; expanding
a cursor lists its executions; a click on one lands on the EXEC line and the at bar agrees.

**Done** (02a58a5): `data/outline.ts` + `views/LinesOutline.tsx`; the Hits & bookmarks menu is
*Navigate*; cursors before the first marker sit under a "file start" node; with a filter the
matching cursors are listed flat under their markers; the executions cache lives in the component
(refetched after the popover closes), the open nodes and filter in `LinesUi.outline`.

## Phase 3: endpoints and parity

### 3.1 `at` with execution span and neighbours (Engine)

**Where:** `at.go` `atAnswer`, the OpenAPI `AtAnswer` schema (additive, no protocol bump).

**Change:** add `execFrom` and `execTo` (the first and last line of the execution the line belongs
to: the calls of a cursor with the same `ExecNo` are adjacent rows, so two binary searches on
`(cursor, execNo)` over the file's call rows, the first line being the EXEC's BINDS block when it
has one and the last the last FETCH or CLOSE), `prevExec` and `nextExec` (the EXEC lines of the
neighbouring executions of the same cursor), `cursorLine` and `closeLine` (the cursor's parse and
CLOSE lines), and `object` (the ref bundle name for a wait's `obj#`). The line card gets
*⇤ exec start*, *exec end ⇥*, *‹ prev exec*, *next exec ›* (keys `d` / `D`).

**Check:** contract test; `at` on a FETCH of execution 2 in `basic_binds.trc` gives the span
and the neighbours; the card's buttons land on them.

**Done** (96b88bd engine, f43d520 lib): the calls of one execution are not adjacent rows (other
cursors interleave), so the span is found by bounded walks over the file's rows filtered on the
cursor (100k rows; -1 beyond); the exec fields are filled for `execNo >= 1` only (PARSE, CLOSE and
XCTEND have 0); `object` comes from the wait's stored `ObjID` through the ref bundle, untested with
a bundle (no fixture has one). The card hides *EXEC line* when the span is known.

### 3.2 `lines/next`: structural stepping (Engine + Lib)

**Where:** new route `/s/{id}/api/lines/next` in `at.go`, OpenAPI, `data/lines.ts` `nextLine`,
`Lines.tsx` key handling of 1.6.

**Change:** `lines/next?file=&from=&what=call|wait|cursor|plan|ctx|error|commit&dir=1|-1`
answers `{line}` or 404 at the file's end. Calls and waits: `firstCall` / `firstWait` on
`Line`; cursors, plans and contexts: `fileInfo` arrays; errors: the model's errors by line
(add a sorted per-file list to `fileInfo`); commits: XCTEND lines are not indexed, so `what=commit`
scans the line index text from `from` with the classifier, capped at 2 M lines per call with a
`{line: -1, scanned}` answer at the cap (the client continues). The keys of 1.6 that were
client-side within loaded pages switch to the endpoint.

**Check:** contract test; `]` from line 1 of `io_waits.trc` visits every call in order, `w` every
wait; `e` on a file without errors says "no error after line N" in the status bar.

**Done** (96b88bd engine, f43d520 lib): commits come from `model.Transactions` per file (no text
scan, no `scanned` cap); `fileInfo` gained `errors` and `commits`; `from` defaults to 0. The lib
also got `p`/`P` (STAT dump) and `s`/`S` (session marker) keys and a Step menu; `PageCache.nextOfKind`
stays (unused in the app, tested).

### 3.3 `lines/profile` and the density strip (Engine + Lib)

**Where:** new route `/s/{id}/api/lines/profile`, `at.go`; new `lib/components/LineStrip.tsx`
beside the viewer's scrollbar, `lines.css`.

**Change:** `lines/profile?file=&buckets=N` (N ≤ 2000) answers per bucket of lines the counts of
calls, waits, cursor parses and errors (binary searches at bucket edges: 4 searches × N, well
under a millisecond on the fact tables) and the total. The strip (14 px wide, full height of the
viewer) paints call and wait density in the kind tones, ticks for errors and cursor parses, and,
from the client, the search hits (hits), bookmarks (◆), the selected statement's marks, the time
window band and the visible range. A click jumps to that bucket's first line; a drag scrubs.
Re-fetched on `rev` (live sessions).

**Check:** `big_loop.trc`: the strip shows where the waits are; a click lands in the right
region; the hits of a search appear as ticks within 100 ms of the search.

**Done** (0daa5a0 engine, a35b387 lib): the answer also carries `commits`, `maxCalls`, `maxWaits`
and `size`; trailing buckets stay (zero) when `size` does not divide `total`. The client fetches
2000 buckets once per file and `rev` and down-samples per pixel row (`data/linestrip.ts`); a click
jumps to the exact line under the pointer, a drag scrubs (reveal) and selects on release; the strip
spans the pinned header too.

### 3.4 Line drawer parity (Lib + Desk)

**Where:** `src/workspace/session/LineDrawer.tsx` (desk) and the standalone shell's drawer
(`engine/web/src/app`, kept in step), a new lib `LineDrawerBody` component.

**Change:** the drawer renders its ±40 lines through `LineViewer` with `annot=2` pages (colour
by kind, heat gutter, live references, the line card of 1.4 below the head) instead of a plain
`<ol>`; Prev/Next and "In Lines tab" stay. Both shells mount the lib component, so the
"copied from the standalone shell" drift ends.

**Check:** a "line N" link in the Statements executions table opens the drawer coloured, with
the card naming the execution; Shift+click still opens the tab.

**Done** (a35b387 lib; desktop re-export in this repo, since 2026-11-01 imported from `@lib` directly): `components/LineDrawer.tsx` in the lib,
mounted by both shells; the shared owner wiring (decode context, line card, reference clicks and
titles, `useLineAt`) is in `views/linesShared.ts`. Prev / Next move ±80 lines from the middle of the
visible range; no pinned header, marks, search or strip in the drawer. The compare server
(`mtkprof serve a b -compare`) now serves `/api/lines` through the shared handler, so the drawer's
`annot` pages work per side (`fetchLinesAnnot` takes `side`).

### 3.5 Folding and block copy

**Where:** `LineViewer.tsx`, `Lines.tsx`, `linefields.ts`.

**Change:** a BINDS block, a STAT dump and a SQL text longer than 12 lines get a fold handle on
their first line; folded, the block shows one summary row ("BINDS: 14 binds", "STAT: 23 plan
lines", "SQL text: 180 lines") and the lines below it keep their numbers (the viewer maps a
folded range to one row height: `scrollmap.ts` gains a list of folded ranges, like the time
window range). *Copy block* on the card copies the execution span of 3.1 or the folded block.

**Check:** folding a STAT dump in `basic_binds.trc` collapses it to one row; line numbers after it
are unchanged; Copy block of an execution yields its EXEC through CLOSE lines.

**Done** (3982911): `data/folds.ts` maps visual rows to lines through a sorted fold list; the SQL
threshold is more than 12 text lines and END OF STMT stays visible; a STAT handle is only the dump's
first line; handles (▾) are looked for in the loaded lines around the view (20 before, 240 after the
first visible line, re-scanned every 20 lines and on page arrival); keys `z` / `Z`; Copy block loads
at most 4 pages. Also fixed: the viewer's view-change notifier kept a cancelled frame id after
StrictMode's effect replay, so the strip's view box and the fold scan never moved in dev.

## Order and verification

1. Phase 1 as three PRs in `modern-tkprof`: 1.1 + 1.2, then 1.3 + 1.4 + 1.7, then 1.5 + 1.6;
   pin each here with a one-line desktop commit. Screenshots before and after per PR
   (engine CLAUDE.md: UI changes are verified with a screenshot).
2. 2.1 alone (engine + lib cache), then 2.2 + 2.3 + 2.4, then 2.5 + 2.6.
3. 3.1 + 3.2 together, 3.3, 3.4 (engine PR then the desktop drawer), 3.5 last.

Per PR: `cd engine/web && pnpm typecheck && pnpm test`, `make test` in `engine/` for route
changes, `pnpm typecheck && pnpm test` here after the pin, and the item's **Check** in dev browser
mode at 1440 and 1024 px, light and dark.

## Review follow-up (2026-10-30)

Notes from the first review of the landed phases, all in `modern-tkprof` d0d2ad2 and pinned here.

| # | Note | Done |
|---|------|------|
| R1 | The view jumped up and down when clicking lines: the line card above the viewer changed height with the selection, and the pinned header row came and went. | The card is one fixed row (horizontal scroll when it overflows); the header row is always rendered, empty when there is no statement at the top. |
| R2 | Bind variables: show the real translated value (from `oacdty`) and the datatype. | Hover cards and the inspector show `Bind :N`, the datatype name, the value the engine decoded (DATE / TIMESTAMP / INTERVAL dumps included) and the ISO form. The attribute tokens (`mxl`, `mal`, `scl`, `pre`, `frm`, `csi`, `avl`, …) are named too. `api/at` now returns `bindLine` and `binds` for every line of a BINDS block, because engine sessions ship the document without its facts tables; dump and continuation lines inside a block resolve to their set in `api/at` and `annot=2`. |
| R3 | Clicking a cursor number went straight to the Statements view. | A popup anchored at the reference: label, cursor and depth, command, executions / elapsed / CPU / waits / rows / disk / buffer gets / hard parses / cursors, the SQL text, and the actions Open in Statements, Mark, Parsed at line N, Copy SQL. Same for sql_id and plan-hash references; Shift+click still jumps to the parse line. Esc, a click outside, scrolling the viewer or a resize closes it. |
| R4 | An optional side view that translates the selected line, every metric in a meaningful unit. | `Inspect` toolbar button and key `i`; a resizable column inside the Lines pane with the raw text, a Translated table (label, value with unit, raw token, one-line meaning; zero values included), a Binds table for bind lines, and the line card's objects and actions stacked below. The one-row card hides while the inspector is open. |

Known limits: the inspector follows the selected (clicked) line, not the hover; the hover card of a bind line translates only after some line of its block was selected once in an engine session (the bind set arrives with `api/at`), while a document with facts tables resolves at once; the raw `oacdty` number is shown only when the document has the `dty` column.

## Phase 4: UX follow-up (2026-10-30)

From the UX review after the review follow-up. Same workflow: lib and engine work land in `modern-tkprof`, then the pin here.
Wave 1 is file-disjoint work (data, viewer, popovers, palette, inspector, engine); waves 2 and 3 integrate it in `Lines.tsx`.

| Item | Where | Status |
|---|---|---|
| 4.1 `View` menu: Wrap, Heat, Strip, Links, Hints and the Mute groups (with colour swatches) in one menu; toggles persisted globally (`state/linesPrefs.ts`), bookmarks and folds stay per file | Lib | done |
| 4.2 Command palette (Cmd/Ctrl+K): step actions, presets, toggles, folds, Go to forms, with their keys; recent commands first | Lib | done |
| 4.3 Object and wait popups: `obj#` and the event name open a popup like the cursor's (plan lines of the object / event class, p1–p3, totals, actions); Shift+click keeps the jump | Lib | done |
| 4.4 Inspector values as links (cursor, sql_id, plan hash, object); follow-hover toggle; hover cards off while the inspector is open | Lib | done |
| 4.5 Inlay hints (`Hints`, key `n`): bind value and type, clock time after `tim=`, object names, long durations, rendered dim inside the visible rows from the page cache | Lib | done |
| 4.6 Gaps: "gap before" as a derived field and a gutter tick above a threshold; `lines/next?what=gap&min=` and keys `t`/`T`; threshold in the View menu | Engine + Lib | done |
| 4.7 Execution summary in the inspector (calls, rows, waits, span) from `executionDetail` | Lib | done |
| 4.8 Range selection (Shift+click, Shift+arrows): the status bar sums calls, waits and rows; `y` copies the range | Lib | done |
| 4.9 Bulk folding: fold all BINDS / STAT blocks of the file (`lines/blocks`) | Engine + Lib | done |

**Done** (all nine, `modern-tkprof` e54fd67). Differences from the table:
`View` holds Show (Wrap, Heat, Density strip, Reference links, Hints, the gap threshold), Dim (the Mute groups
with swatches) and Folds (Fold all BINDS / STAT, Unfold all); the palette is `Commands ⌘K` in the toolbar and
Cmd/Ctrl+K anywhere in the view, with dynamic Go to entries parsed from the typed text. Display toggles live in
`state/linesPrefs.ts` (localStorage `mtk.lines.prefs`, shared by the Statements drawer); folds, range, hits and
bookmarks stay per file. The wait popup also opens from an event name alone (the inspector's execution waits).
Gaps: a call is compared with the previous call (its own WAIT lines come first in the trace), a wait with the
previous line of either kind; the engine's `lines/next?what=gap&min=` follows the same rule, and `lines/blocks`
lists BINDS blocks from the calls' bind-set headers (a set without an owning call would be missed). Verified in
the browser on `basic_binds.trc` at 1440×900, light and dark: hints, gap tick + inlay + inspector row at 1 ms
(line 89), range 71–76 with its sums, fold all BINDS (35 blocks), statement / object / wait popups, follow-hover.

## Phase 5: simpler panels (2026-10-31)

From the UX review of the Lines panels (one line was described by five surfaces: card, pinned header, hover card,
inspector, popups). Same functions, fewer places. All in the lib (`modern-tkprof`), then the pin here.

| # | Change | Where it went |
|---|--------|---------------|
| 5.1 | Toolbar: one row instead of ~15 controls on two | Search box with one Options menu (Match, Scope, Ready-made searches, Threshold); Enter searches, the box's × clears, Cancel while running. `Step` (statement marks first, then the kinds, gaps and search hits). The window group only when a window is set. `Go to or run a command ⌘K` opens the palette (it parses lines, #cursor, sql_id[/N] and times; `g` opens it too, errors go to the status bar); `?` shows the key map under that button. `View`. `Panel`. |
| 5.2 | Line card → breadcrumb | session › statement (SQL, execs · time) › exec k of n with ‹ › (n only when the cursor ran more than once; the trace numbers executions per cursor) › the line, then wait event and object, binds, plan line. Stays while the side panel is open. Dropped from the row: kind pill, cursor number, depth, plan hash, the second exec count (all in the inspector); module and action are the session's tooltip. |
| 5.3 | Pinned header → overlay | Shown only when the top line belongs to another statement than the selected line; it lies over the top row (content-wide, from the start edge), so the viewer never changes size (R1 holds without an empty band). |
| 5.4 | One Actions menu | Grouped: Line (Bookmark, Note, Focus, Copy line, Copy link, Inspect, Copy block), Statement (Open, Mark, Plan, Parsed at, Cursor CLOSE, its waits of this event), Execution (Open, Binds, EXEC line, Start, End, Copy its lines), Session (Open in Sessions). The toolbar's Line menu and the in-row Copy / Link buttons are gone. |
| 5.5 | One docked side panel | Tabs Line · Outline · Hits · Bookmarks replace the inspector column and the Navigate popover (which covered the text). `i` opens it at Line (again: closes); a search opens it at Hits; saving a note at Bookmarks. Hover cards are off only while the Line tab shows (4.4). |
| 5.6 | Compact inspector | One line per field (value, raw token); the meaning is the row's tooltip. The raw-text box, the exec start / end / prev / next / Binds buttons and "At this line" are gone (breadcrumb and Actions). "Follow the pointer" is a checkbox. The Execution grid has its CSS (it had none). |
| 5.7 | Quieter rows | Reference underlines on the selected and hovered row only (still clickable everywhere; always underlined on touch). Heat bars right of the line number, in the row's tone; the 8.5rem action gutter at the row end is gone. |
| 5.8 | Legend → View menu | "Line colours · tick to dim": every colour with its swatch, a tick where the lines can be dimmed, plus the statement marks. The status bar keeps only state. |
| 5.9 | Hover card | Two columns; zero fields named on one line (`splitZeros`); long values take both columns. |
| 5.10 | Statements drawer | No Prev / Next (the drawer scrolls the whole file); "Back to line N" while the target is out of view; the same breadcrumb, with Bookmark and Copy line. |
| 5.11 | Small fixes | The hits list's column number is in the row's tooltip, not a column; the active recent-search chip is readable (it had white text on the light tint); the outline drops cursor number and depth when narrow (they are the sql_id's tooltip). |

Verified in the browser on `basic_binds.trc` at 1440×900 and 1024×768: toolbar, Options, Step, Actions, every
panel tab, a search with recent chips, the hover card, View, the header overlay (line 1,693 scrolled up), the key
map, a Go to error, the drawer with Back. No console errors.
