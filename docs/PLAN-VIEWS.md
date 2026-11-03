# Three new views: implementation plan (Row flow, Dialogue, Blocks)

Written 2026-11-03 from the concept study in `docs/viz-concepts/` (five concepts mocked on real data
from `testdata/traces/19c/io_waits.trc`; the user picked three). Nothing of this is implemented yet;
the status table in § 9 is where the implementing agent records progress.

Before starting: `CLAUDE.md` (repo rules), `docs/HANDOFF.md` (current state), `docs/ARCHITECTURE.md`
§§ "Server-side slicing", "Engine mode", "Shell module", "internal/analyze", and `desktop/CLAUDE.md`.
File paths and line numbers below were checked at `3e61ced` (v0.5.0); re-check them, they drift.

## 1. What is being built

| view | where it lives | data | needs engine work |
|---|---|---|---|
| **Row flow** | the statement inspector, a `Table \| Flow` toggle on each plan section | plan lines already in the document (`doc.planLines`) | no |
| **Dialogue** | the statement inspector, a `Binds \| Dialogue` toggle when one execution is picked | the existing `executions/trace` answer (`DataSource.executionTrace`) | no |
| **Blocks** | a new top-level view (tab "Blocks") | a new endpoint over the wait facts: every physical I/O wait with a block address | yes: `GET /s/{id}/api/io/map` |

**Row flow** draws a row-source plan as a Sankey: leaves on the left, the root on the right, then a
"client" bar. Band width is the actual rows flowing from a child into its parent (STAT `cnt`); a
dashed ghost outline of the same band is the optimizer's estimate (`card`); node fill is the
operation's self time (its `time` minus its children's). It answers "where do rows multiply or
collapse, and which row source holds the time" at a glance, which the plan table answers only by
reading numbers. Mock-up: `docs/viz-concepts/row-flow.png`, `template.html` `fig2()`.

**Dialogue** draws one execution as a UML-style sequence diagram: lifelines Client, Server process,
and (only when used) Disk, TEMP, Others. One turn per call in trace order: the client's call arrow,
the server's activation sized by elapsed, side arrows for the waits grouped by event, the rows going
back as a dashed arrow, the client gap before the next call. Runs of alike round trips collapse into
a loop frame ("× 200", total server time, total client gaps); an iteration that is an outlier against
its run stays its own turn. It answers "how does the conversation unfold and on which side does the
waiting sit": chattiness, time to first row, fetch array size, a sort or spill before the first row.
Mock-up: `docs/viz-concepts/dialogue.png`, `fig4()`.

**Blocks** draws every physical I/O wait that carries a block address at (I/O order or time,
block number), one panel per file, marks as tall as the blocks they moved, coloured by event,
object or statement, with the objects' extents as faint bands. Full scans are diagonals, index
lookups vertical scatter, re-reads of the same blocks repeated hits, a sort spill a write stripe
then a read stripe, a multipass hash join a sawtooth of re-reads. Mock-up:
`docs/viz-concepts/block-map.png`, `fig1()`.

### Acceptance numbers (io_waits.trc, from `mtkprof export`)

The views must reproduce these; they are the ground truth the mock-up was checked against.

| what | value |
|---|---|
| block I/O waits (events with file#/block# parameters) | 8,747 |
| of which in datafile 12 (`direct path read`, blocks 167,795 to 172,288) | 194 |
| in tempfile 203 (temp writes 1,607 + temp reads 6,943, blocks 756,103 to 756,743) | 8,550 |
| in datafile 10 (`db file sequential read`, exp_head$) | 3 |
| stmt 22 (`7r10y07tqpg98`, hash join): direct reads / temp writes / temp reads | 71 / 276 / 5,612 |
| stmt 21 (`52nzchs09dgn1`, order by): direct reads / temp writes / temp reads | 26 / 1,331 / 1,331 |
| stmt 21 distinct temp blocks written (1,331 writes land on 639 blocks: runs, then a merge) | 639 |
| MTK_ORDERS obj 108611: extents / blocks; MTK_CUST obj 108609 | 26 / 496; 45 / 1,204 |
| stmt 22 plan: HASH JOIN inclusive 609,850 µs, children 3,396 + 2,015 µs, self | ≈ 604 ms |
| stmt 22 plan: SORT AGGREGATE inclusive 596,760 µs < child 609,850 µs | self clamps to 0, note shown |
| stmt 22 rows / estimates: CUST 20,000 / 20,000; ORDERS 100,001 / 100,000; join 100,001 / 99,364 | |
| stmt 21 plan: SORT ORDER BY self ≈ 2,446 ms, pw 1,331; scan 2,432 µs | |
| stmt 21 execution: calls PARSE, EXEC, 202 FETCH, CLOSE | 205 |
| stmt 21 fetches: 1 row, then 200 × 500 rows, then 0 rows | frame "× 200" |
| stmt 21 time to first row (FETCH #1 elapsed) / parse-to-close wall | 2.45 s / 2.80 s |
| stmt 21 FETCH #1: `direct path write temp` × 1,331, 2.38 s; temp reads in it | 856 of 1,331 |
| stmt 21 client gaps (`SQL*Net message from client`, 202 of them) | 307 ms, median 1.52 ms |
| stmt 15 (`64y0jakbjfvm9`): 102 fetches of ≤ 15 rows, 1,505 rows; client gaps | 7.5 ms vs 5.2 ms of server time |
| loop outliers: first EXEC of stmt 18 and 19 vs the run median | 483 µs and 380 µs vs 28 µs |

## 2. Rules that apply to all three

From `CLAUDE.md`, restated with what they mean here:

- `make test` green (Go unit + golden, `pnpm -r test`), `pnpm -r typecheck` clean (the desktop
  typechecks the lib with its own code), `scripts/ci-local.sh` before the last push.
- A lib or API change and the desktop's adaptation go in the same commit.
- Engine routes and `api/engine.openapi.yaml` change together; `go test ./internal/engine`
  (`TestContractRoutes`, `TestContractSchemas`, `TestRoutesServed`, `TestParityWithServeSpill`) must
  pass; then `cd desktop && pnpm gen:api` and commit `desktop/src/engine/api.d.ts`. Adding a GET
  endpoint is additive: `engine.Protocol` stays.
- The UI is verified with a screenshot before committing: the `verify-mtkprof` skill
  (`.claude/skills/verify-mtkprof/`, `drive.mjs --open <trace> --view <tab label> --name <shot>`)
  for the desktop shell, and `mtkprof serve testdata/traces/19c/io_waits.trc` in a browser for
  the standalone shell. Both themes (`data-theme` light and dark).
- `make web` rebuilds the embedded UI into `internal/ui/dist/index.html`; rebuild Go afterwards;
  the built UI is committed with the UI change (`scripts/ci-local.sh --strict` checks it).
- Docs change with the code: `docs/DESIGN.md` (decisions, § 8 below), `docs/ARCHITECTURE.md`
  (endpoint table ≈ line 329, a section per view, the repository layout), `docs/DESKTOP.md` § Views
  (user guide), `docs/HANDOFF.md` (status), `docs/ROADMAP.md`, and the website `site/docs.html` if
  it lists the views. Publishing the site (`scripts/publish-site.sh`) is a separate step: ask.
- Commits go to `main`, concise messages, push after each milestone (§ 7).
- No new npm dependencies. The three drawings are custom SVG (React elements) or canvas 2D, like
  `Lanes.tsx` (DOM + SVG) and `Minimap.tsx` (canvas). Do not build them as ECharts custom series:
  the labels, callouts and collapse logic are the point, and ECharts' custom series makes them
  harder, not easier. No d3.
- Colours come from the tokens in `web/src/lib/styles/tokens.css` (`--c-cpu`, `--c-userio`,
  `--c-sysio`, `--c-concurrency`, `--c-network`, `--c-idle`, `--c-other`, the `--c-phase-*` ramp,
  `--c-grid`, `--c-axis`); canvas code resolves them with `resolveVar()` from
  `components/colors.ts` and redraws on `State.theme` and on `prefers-color-scheme` (see
  `Minimap.tsx`). Wait classes map to roles with `roleOfClass()`.
- Every mark that has a trace line links to it: `LineRef` (`components/LineRef.tsx`) for lines,
  `StmtLink` for statements; the file of a call or wait is `doc.fileOfCtx(ctx)`. Nothing is
  hover-only: counts and totals are written on the figure; tooltips add detail.
- Empty and degraded states are explicit: "no physical I/O waits in scope", "no row-source
  statistics in this plan dump", "trace truncated at N rows", "sampled 1 in k".
- Pure data code goes in `web/src/lib/data/*.ts` with a `*.test.ts` beside it (vitest, node
  environment, no DOM; see `derive.test.ts`, `windowlines.test.ts`; docs are built with
  `makeDoc()` from `data/testdoc.ts`). Components are not unit-tested; their layout math is, so
  keep layout in the data module.
- Light and dark, keyboard reachable (the view tabs' chords, `Esc` through `useEscapeChain` only if
  the view adds a transient selection), `font-variant-numeric: tabular-nums` is already global.

## 3. Package G: a view without a digit chord (groundwork for Blocks)

`SessionViewDef.key: number` (`web/src/lib/shell/views.tsx:14-39`) is required and all ten digits
are taken: `baseViews` uses 0 to 7 and the desktop's `sessionViews`
(`desktop/src/workspace/session/views.tsx`) appends Notes 8 and Reports 9. Do not renumber (muscle
memory, docs, the assistant's links); make the chord optional.

- `key?: number`. `viewOfKey()` and `useViewKeys()` (`shell/viewKeys.ts`) skip rows without a key;
  the step action (⌥⌘← / →) still walks every shown view. `viewKeyLabel` / `viewKeyAria` return
  `''` for a row without a key; `ViewTabs` shows no hint for it.
- Tests: `shell/views.test.ts` hard-codes the eight ids, labels and keys; `viewKeys.test.ts`
  gets a case for a key-less row (chord ignored, step includes it).
- Desktop: `SessionNav.tsx` passes key hints; `pnpm -r typecheck` tells what else reads `key`.
  Check that the desktop no longer has its own copies of `viewKeys.ts` / `viewPanes.ts` (the
  HANDOFF of 2026-11-01 listed them as the next cleanup); if it does, delete them as part of this.

Done when: both shells build, chords 0 to 9 behave as before, a key-less row renders a tab.

## 4. Package R: Row flow (lib only)

### R1 Data: `web/src/lib/data/rowflow.ts`

Input: the plan lines of one dump, `doc.planLines.slice(plan.first, plan.first + plan.n)`
(`PlanLine` in `data/types.ts:120-155`: `id, parentId, pos, depth, op, object, obj, rows, starts,
cr, pr, pw, timeUs, cost, size, card, hasStats, eRows?`; `-1` means unknown for `cost`, `size`,
`card`).

```ts
export interface FlowNode {
  line: PlanLine
  children: FlowNode[]          // ordered by pos, then id
  rows: number                  // A-Rows = line.rows (total over all starts)
  est: number                   // E-Rows: line.card if ≥ 0, else line.eRows if ≥ 0, else -1
  inclusiveUs: number           // line.timeUs
  selfUs: number                // max(0, timeUs - Σ children.timeUs); 0 when the parent reports less than its children
  selfCr: number; selfPr: number; selfPw: number   // same subtraction
  clamped: boolean              // the parent reported less than its children (sampled timings): note it
}
export interface RowFlow {
  root: FlowNode | null         // parentId 0 (or a missing parent): one per dump; several → the first, note
  nodes: FlowNode[]             // DFS order (pre-order), the layout order
  maxDepth: number
  totalUs: number               // root inclusive
  maxRows: number
  hasStats: boolean             // any line.hasStats
  notes: string[]               // 'no row-source statistics', 'SORT AGGREGATE reports less than its child', 'cycle at id 7' …
}
export function rowFlow(lines: readonly PlanLine[]): RowFlow

export type FlowScale = 'sqrt' | 'linear'
export interface FlowLayout {
  width: number; height: number
  columns: number               // maxDepth + 2 (the client bar is the last column)
  nodes: { node: FlowNode; x: number; y: number; w: number; h: number; col: number; tone: 0|1|2|3|4 }[]
  links: { from: FlowNode; to: FlowNode | 'client'; path: string; estPath: string | null; width: number; estWidth: number }[]
}
export function flowLayout(flow: RowFlow, o: { width: number; scale: FlowScale; nodeW?: number; colGap?: number; rowGap?: number; minBand?: number }): FlowLayout
```

Rules:
- Tree: index lines by `id`; a line's parent is `parentId`; roots are lines whose parent is 0 or
  missing. Guard against cycles and duplicate ids (a dump glued from two STAT blocks): stop, note.
- Column of a node = `maxDepth - depth` (leaves left). Nodes stack within a column in DFS order
  with `rowGap`; a tree laid out in DFS order has no crossing bands.
- Node height = `scale(max(rows, Σ children.rows))`, minimum 2 px; the "client" bar =
  `scale(root.rows)`. `scale` is sqrt by default (a 10 M-row scan next to a 1-row lookup stays
  readable), linear on request (the mock-up's "wide river to a thread"); the choice persists.
- A link from child to parent is an SVG path with two cubic edges: it leaves the child's right
  edge over the child's rows share and enters the parent's left edge in the slot of that child
  (children stacked by DFS order). `minBand` 1.5 px keeps a 1-row band visible. The estimate
  ghost is the same slot at `scale(est)` width, drawn as a dashed stroke without fill; none when
  `est < 0`.
- `tone` is the self-time bin: < 1 ms, 1 to 10 ms, 10 to 100 ms, 0.1 to 1 s, ≥ 1 s (the mock-up's
  legend). Styled as five classes in CSS with `light-dark()` values, one hue (the `--c-cpu` blue
  ramp or the phase slate ramp), so it is not confused with the wait-class colours.

### R2 Component: `web/src/lib/views/RowFlow.tsx` + `styles/rowflow.css`

`<RowFlow doc plan lines scale onScale />`. One `<svg viewBox>` at width 100 % with the bands,
node bars and the client bar; labels in an absolutely positioned HTML layer over it (CSS
ellipsis, tabular numbers): operation + object to the left of each node (right-aligned), "rows ·
est. N" on wide bands, "self 604 ms · pr 5,612 · pw 276" under each node. A legend row above
(band = actual rows, dashed = estimate, node fill = self time with the five bins, scale toggle).
Hover: a popover (`usePopover`) with every measure of the line and a `LineRef` to `plan.line`
(the STAT line; file `doc.fileOfStmt(plan.statement)`). Click a node: highlight its path to the
root and its subtree, click again or `Esc` clears. `flow.notes` render as a `Note` under the
figure. Width: the figure follows the inspector width; height = layout height (≈ 28 px per node
minimum), no inner scrolling.

### R3 Integration: `StatementDetail.tsx` `PlanSection` (≈ line 307)

Add a segmented control `Table | Flow` next to the dump picker; `usePersisted('plan.view',
'table')` and `usePersisted('plan.flowScale', 'sqrt')` (`state/persist.ts`). `PlanAdvisor` stays
above either. When `!flow.hasStats` show the table and the note (a dump without row-source
statistics: `statistics_level` basic or cursor not closed). Keep "Open in plan viz", Copy JSON.
The desktop needs nothing (it renders the same `StatementDetail`), but typecheck it.

### R4 Tests: `data/rowflow.test.ts`

Synthetic `PlanLine[]` (unit tests of a pure function need no trace file): a chain
(SORT AGGREGATE over TABLE ACCESS FULL), a hash join with two children, a nested loop whose inner
side has `starts > 1`, a dump where the parent's time is below its children (clamp + note), `card
-1` (no ghost), `eRows` fallback, a cycle (note, no hang). Layout: widths monotone in rows,
`minBand`, no negative sizes, `columns === maxDepth + 2`, DFS order. Fixture pass: for every plan in
the gzipped docs under `data/testdata/` (`findings-plan_change.json.gz` …, if they carry
`planLines`; otherwise build a doc from `io_waits.trc` with the Go side: `mtkprof json`) `rowFlow`
never throws.

### R5 Verification

- io_waits.trc: stmt 22 (`7r10y07tqpg98`) shows the two scans into a dark HASH JOIN node and a
  thread to the client; the self time reads ≈ 604 ms, the SORT AGGREGATE note appears; stmt 21
  (`52nzchs09dgn1`) shows a river of equal width through SORT ORDER BY (self ≈ 2.45 s) to the client.
- plan_change.trc: two plan sections, each with its own flow; plan_stat_all.trc: the dump picker
  changes the flow; parallel.trc: PX plan lines (many rows, deep tree); nasty_sql.trc: long
  operation names ellipsize; a trace without STAT lines (level_1.trc): table + note.
- Screenshots light and dark, desktop (`drive.mjs --view Statements --click …`) and standalone.

### R6 Docs

`ARCHITECTURE.md`: a "Row flow" paragraph under the statements inspector with the self-time rule
and the layout; `DESKTOP.md` § Views; `DESIGN.md` § 8 decisions; HANDOFF status.

Done when: R4 green, R5 screenshots in the commit message or HANDOFF, `make web` dist committed.

## 5. Package D: Dialogue (lib only)

### D1 Data: `web/src/lib/data/dialogue.ts`

Input: `ExecTrace` from `source.executionTrace(stmt, ex)` (`data/exectrace.ts:53`:
`{calls: TraceCall[], children: TraceCall[], waits: TraceWait[], truncated}`; `TraceCall` has
`id, owner, parent, line, ctx, kind, cursor, stmt, dep, execNo, c, e, p, cr, cu, r, tim, selfE,
plh`; `TraceWait` has `id, call, owner, line, ctx, event, ela, p1, p2, p3, obj, tim, dep,
between`). The engine caps an answer at 50,000 children and 200,000 waits
(`internal/slice/exectrace.go:27-28`) and says `truncated`.

Wait attribution (checked in `internal/model/builder.go` `attachWait`, ≈ line 797): a wait is
attached to the call whose line follows it; `between` is set when its time falls outside the
call's `[tim - e, tim]`. So a `between` wait with `call = k` is the client gap **before** turn k.

```ts
export type Lifeline = 'client' | 'server' | 'disk' | 'temp' | 'others'
export interface Traffic { event: ID; n: number; us: number }
export interface Turn {
  call: TraceCall; kind: CallKind; rows: number; ela: number; cpu: number
  gapBefore: number; gapWaits: Traffic[]            // between waits attached to this call
  sides: Partial<Record<Exclude<Lifeline, 'client' | 'server'>, Traffic[]>>
  net: { toClient: Traffic | null; moreData: Traffic | null }
  recursive: { n: number; us: number }               // children calls (dep + 1) inside this call
  outlier: 'ela' | 'gap' | null                      // why it was kept out of its frame
}
export interface Frame { turns: Turn[]; n: number; kind: CallKind; rows: number; serverUs: number; cpuUs: number; gapUs: number; medianEla: number; medianGap: number; sides: Turn['sides']; net: Turn['net']; recursive: Turn['recursive'] }
export type Step = { type: 'turn'; turn: Turn } | { type: 'frame'; frame: Frame }
export interface Dialogue {
  lifelines: Lifeline[]                               // client, server, then disk / temp / others only when used
  steps: Step[]
  wall: { startTim: number; endTim: number; us: number }   // first call's tim - e … last call's tim
  totals: { cpuUs: number; byRole: Partial<Record<Role, number>>; gapUs: number; untimedUs: number }
  ttfrUs: number | null                               // time to first row: end of the first FETCH with rows > 0 minus wall.startTim
  truncated: boolean
}
export function dialogueOf(doc: TraceDoc, trace: ExecTrace, o?: { minRun?: number; outlierX?: number }): Dialogue
```

Rules:
- Lifeline of a wait, from `doc.events[wait.event]` (`Event {name, class, idle, p1Name …}`):
  name contains `temp` → `temp`; class `User I/O` or `System I/O` → `disk`; class `Network`
  → not a lifeline: `SQL*Net message to client` and `more data to client` become the return
  arrow's annotation (`net`); `between` waits → the gap (whatever the class: a between wait of a
  non-idle class is still a gap, say so in the tooltip); everything else in-call (Concurrency,
  Application, Commit, Configuration, Other, Idle inside a call such as `PL/SQL lock timer`) →
  `others`.
- Turns are the execution's own calls (`trace.calls`) in trace order; `trace.children` roll up
  into `recursive` of the call they belong to (`owner`); their waits roll up with them.
- Collapse: split the turns into maximal runs of equal `(kind, rows)`; in a run of at least
  `minRun` (3) turns compute the median `ela` and median `gapBefore`; a turn whose `ela` or
  `gapBefore` exceeds `outlierX` (10) × the median leaves the run as its own step (`outlier` set),
  the rest form a `Frame` (a run can become frame, turn, frame). Frames aggregate `sides`, `net`,
  `recursive` and `gapWaits` across their turns (sum of `n` and `us` per event). This rule is what
  keeps "the first iteration is different" visible (stmt 18's first EXEC, 483 µs against 28 µs)
  and is the first step toward the chapter-and-residual view discussed on 2026-11-01.
- Totals for the true-scale bar: `cpuUs` = Σ calls' `c`; `byRole` = in-call waits summed by
  `roleOfClass(event.class, event.idle)`; `gapUs` = Σ between waits; `untimedUs` = max(0,
  `wall.us` − cpu − waits − gaps).

### D2 Component: `web/src/lib/views/Dialogue.tsx` + `styles/dialogue.css`

`<Dialogue doc stmt exec />`: fetches with `useSourceQuery(source, 'trace:<stmt>:<cursor>:<execNo>',
…)` (the same key `ExecLoom.tsx` uses, so the cache is shared), then `dialogueOf`. One `<svg>` of
width = number of lifelines × 170 px (min 520, horizontal scroll when the pane is narrower):

- Lifeline headers (Client "SQL*Plus session" from `doc.contexts[ctx].clientDriver` if known,
  Server process, Disk, TEMP, Others) and dashed lifelines.
- A turn: the call arrow client → server labelled `FETCH · 173 µs`; the server activation bar of
  height `8 + 10·log10(1 + ela_us / 100)` px (min 8, labelled with the elapsed when ≥ 14 px);
  side arrows from the activation to each used lifeline labelled `event × n · dur` (temp writes
  warm, temp reads cool: the `--ev-temp-w` / `--ev-temp` hues `loom.css` already defines; disk
  `--c-userio`; others by role); recursive SQL as a small self-loop box `recursive SQL × n ·
  dur`; the return arrow server → client dashed, labelled `500 rows` for a FETCH, with the
  `more data` count when present; the gap before as a block on the client lifeline labelled with
  its duration (`--c-idle`).
- A frame: a rounded rectangle around one drawn turn (the run's median values) with the tab `loop
  × 200` and, right-aligned, `server 35.7 ms · client gaps 306 ms`; side arrows carry `× n in all`.
- Under the diagram, a true-scale bar: `ProfileBar` (`components/ProfileBar.tsx`) with segments
  CPU, each wait role, client gaps, untimed, over `wall.us`, and the facts line "time to first row
  2.45 s of 2.80 s · 202 round trips · 500 rows per trip".
- Hover on an arrow or bar: popover with the call's measures and a `LineRef` (`call.line`,
  `doc.fileOfCtx(call.ctx)`); on a side arrow: the events with counts and a `LineRef` to the
  first wait's line. `truncated` → a `Note`.

### D3 Integration: `StatementDetail.tsx` (≈ line 264, where one picked execution renders `Binds`)

Segmented control `Binds | Dialogue`, `usePersisted('exec.detail', 'binds')`. With two picked
executions `ExecCompare` stays as is (a side-by-side dialogue is v2). The `LinesAt` panel in the
Lines view is not touched.

### D4 Tests: `data/dialogue.test.ts`

Build `ExecTrace` values by hand (see `loom.test.ts` for how `TraceCall` / `TraceWait` objects are
made there): 200 alike fetches collapse into one frame; a first fetch with rows 1 stays a turn;
an iteration 20× the median leaves its run (`outlier: 'ela'`), the run around it becomes two
frames; between waits attach as `gapBefore` of the following turn; temp vs disk vs others
classification by event name and class; `net` annotations; recursive children roll up; totals and
`untimedUs` clamp; lifelines contain only used ones; `ttfrUs` null when no rows. A fixture pass:
`makeDoc()` with calls and waits (see `testdoc.ts`) through `new LocalSource(doc).executionTrace`
then `dialogueOf` never throws, and on an io_waits-derived doc (if one is checked in) stmt 21 gives
205 calls, one frame of 200, `ttfrUs` ≈ 2.45 s.

### D5 Verification

- io_waits.trc stmt 21: frame × 200 of 500 rows, FETCH #1 apart with `direct path write temp ×
  1,331 · 2.38 s` and 856 temp reads, time to first row 2.45 s of 2.80 s, gaps 307 ms; stmt 15:
  frame × 100 of 15 rows, gaps 7.5 ms against 5.2 ms of server time; stmt 13: two executions, each
  a two-turn dialogue.
- plsql_recursive.trc: the recursive-SQL box on the PL/SQL block's EXEC; errors.trc or lobs.trc:
  an Others lifeline (enqueue, LOB waits); multisession.trc: a dblink-style between wait inside a
  call keeps its class in the tooltip; parallel.trc: no crash on PX executions.
- Screenshots light and dark, desktop and standalone.

### D6 Docs

`ARCHITECTURE.md` "Dialogue" paragraph (attribution and collapse rules); `DESKTOP.md`; `DESIGN.md`;
HANDOFF.

Done when: D4 green, D5 screenshots, dist committed.

## 6. Package B: Blocks (engine + lib + desktop)

### B1 Model: which waits are block I/O

`internal/model/ref.go` next to `IsFileP1()` (line 50):

```go
// IsBlockIO reports whether the event's parameters are a file number and a block address:
// db file sequential/scattered/single read|write, direct path read|write[ temp], read by other
// session, buffer busy waits, gc cr/current block …; not db file parallel read (no address) and not
// Disk file operations I/O (no block).
func (e *Event) IsBlockIO() bool { return e.IsFileP1() && (e.P2Name == "block#" || e.P2Name == "first dba") }
// BlocksParam reports whether p3 is a block count (else one block).
func (e *Event) BlocksParam() bool { return e.P3Name == "blocks" || e.P3Name == "block cnt" }
```

Data-driven on the parameter names the trace itself carries (`Event.P1Name` … from the WAIT
lines), so unknown events classify themselves. Unit test with the event names above.

### B2 Analysis: `internal/analyze/iomap.go`

```go
type IOMapFile struct { File int64 `json:"file"`; Lo int64 `json:"lo"`; Hi int64 `json:"hi"`; N int `json:"n"` }
type IOMap struct {
	Total   int         `json:"total"`    // block I/O waits in scope
	Sampled bool        `json:"sampled"`  // every k-th kept, k = ceil(Total/limit)
	Cols    []string    `json:"cols"`     // tim, ela, event, file, block, blocks, obj, stmt, call, line, ctx, dep
	Rows    [][]int64   `json:"rows"`     // in trace order
	Files   []IOMapFile `json:"files"`    // over all matches, not only the kept rows; sorted by file
	Events  []model.ID  `json:"events"`   // the event ids that occurred, sorted
}
// IOMapOn lists the physical I/O waits with a block address in scope. isBlock[event] and
// countP3[event] come from the model's events (Event.IsBlockIO / BlocksParam).
func IOMapOn(ctx context.Context, src Facts, f Filter, isBlock, countP3 []bool, limit int) (*IOMap, error)
```

Two passes over `src.EachWait(ctx, f.Scan(), …)` with `f.Matcher().Wait(w)`: the first counts
matches (and fills `Files`, `Events`), the second keeps every k-th. No slice of all matches is
built (a 1 M-wait trace must not allocate 100 MB). `tim` is the wait's end as everywhere; `blocks`
= `P3` when `countP3[event]`, else 1; `obj` = `ObjID` (−1 none). Idle waits never match (block I/O
is never idle), so `IncludeIdle` is irrelevant; document that `idle=` is ignored.

Tests `iomap_test.go`: io_waits.trc gives `Total 8747`, files 10 / 12 / 203 with the ranges of
§ 1; `limit 100` → `Sampled`, `len(Rows) == ceil(8747/88)`, rows in order, `Files` unchanged;
`stmt=22` through `Filter.Statement` → 71 + 276 + 5,612; a window that holds nothing → `Total 0`,
empty `Rows`, `Files` empty. Shared case for the TS twin: write
`web/src/lib/data/testdata/iomap-case.json` the way `waitspans_test.go` handles
`waitspans-case.json` (look at how that file is produced and consumed; keep the case small: the
first 60 block I/O waits of io_waits.trc, `limit 20` to cover sampling).

### B3 Endpoint: `internal/slice/iomap.go`, `slice.go` `routes()`, the yaml, the tests

```go
func (s *Server) ioMap(ctx context.Context, q url.Values) (any, error) {
	f, err := s.filter(q, true)              // from, to, contexts, stmt, event (idle ignored)
	if err != nil { return nil, err }
	limit, err := intParam(q, "limit", 20000, 1, 200000)
	if err != nil { return nil, err }
	return analyze.IOMapOn(ctx, s.src, f, s.blockEvents, s.countP3, limit)   // the two []bool are computed once from s.m.Events in New()
}
```

Route `"/api/io/map": s.ioMap` (18 → 19 slice endpoints); the header comment of `slice.go`
lists it. `api/engine.openapi.yaml`: `/s/{id}/api/io/map`, `operationId: sliceIOMap`, parameters
`SessionID, From, To, Contexts, Stmt, Event` + `limit` (integer, default 20000, max 200000),
response `IOMap` under `components.schemas` with the exact JSON tags (add `IOMap` and `IOMapFile`
to the map of `TestContractSchemas`); `400` → `SliceBadRequest`. `TestContractRoutes` has a hard
count of session routes (`n != 30`): make it 31. `internal/slice/parity.go` `ParityQueries` gets
`/api/io/map?limit=500` and a scoped variant; `internal/engine/engine_test.go` `endpoints` /
`queries` get `io/map` so `TestParityWithServeSpill` covers the spill path byte for byte.
`internal/slice/slice_test.go`: `TestIOMap` compares against `m.Waits` directly and lists the
bad requests (`limit=0`, `limit=x`). Then `cd desktop && pnpm gen:api` and commit `api.d.ts`.

`ARCHITECTURE.md` endpoint table (≈ line 329): a row for `/api/io/map` with its columns, sampling
rule and the 20,000 default.

### B4 Lib data: `web/src/lib/data/iomap.ts`, `source.ts`

```ts
export interface IOMap { total: number; sampled: boolean; cols: string[]; rows: number[][]; files: { file: number; lo: number; hi: number; n: number }[]; events: ID[] }
export function isBlockIO(ev: Event): boolean          // twin of Event.IsBlockIO
export function blocksParam(ev: Event): boolean
export function ioMapOf(doc: TraceDoc, scope: Scope, limit: number, stmt?: ID, event?: ID): IOMap   // twin of IOMapOn over doc.waits columns (event, p1, p2, p3, obj, tim, ela, stmt, call, line, ctx, dep), same two-pass decimation
```

`DataSource.ioMap(scope, limit, stmt?, event?, signal?) => Maybe<IOMap>`; `LocalSource` calls
`ioMapOf` with `waitFilter(scope)`; `RemoteSource` gets `io/map` with `scopeParams(scope, false)`
+ `limit` (+ `stmt`, `event`). Test `iomap.test.ts`: the shared case, plus `makeDoc()` cases for
classification, sampling and the file ranges.

Derived helpers in the same module, unit-tested: `extentsOf(rows, obj)` (the union of
`[block, block + blocks)` per object, merged into runs: the faint bands), `rereadOf(rows)` (per
statement and per object: reads, writes, distinct blocks, reads per distinct block: the "20
passes" number), `orderToTime(rows, i0, i1)` (a brushed order range → `{startTim: tim - ela of the
first, endTim: tim of the last}`).

### B5 View: `web/src/lib/views/BlockMap.tsx` + `styles/blockmap.css`

Registration: `View` union in `state/store.ts:10` gets `'blocks'`; `baseViews` gets
`{ id: 'blocks', label: 'Blocks', render: (d) => <BlockMap doc={d} /> }` after `waits` (nav
order Overview, Trace, Statements, Waits, Blocks, Timeline, Sessions, Pivot), no `key` (§ 3);
`views.test.ts` list; `shell/viewPanes.ts` `FOLDED_VIEWS` adds `blocks` (the Files panel folded by
default: the figure wants the width), `showsInspector` stays false; `index.ts` exports `BlockMap`;
the URL hash accepts `view=blocks` automatically (`urlstate.ts` builds its whitelist from
`baseViews`); the desktop's `sessionViews` spreads `baseViews`, nothing to add there;
`.claude/skills/verify-mtkprof/features/analysis-views.md` gets the tab so `drive.mjs --view
Blocks` is documented.

Data: `const scope = useScope(doc, { withWindow: true })`;
`useSourceQuery(source, \`iomap:${scopeKey(scope)}:${limit}:${colorBy}:${stmtSel ?? ''}\`, (signal) =>
source.ioMap(scope, limit, stmtSel, undefined, signal), 'iomap')`. The window from the store
narrows the scope like every other view, so a brush re-queries at finer grain; the FilterBar chips
clear it.

Layout (all in `data/blocklayout.ts`, unit-tested): panels = files with `n > 0`, in file order,
each `height = clamp(60, 320, 40 + 40·log10(1 + hi - lo))` px; a shared x axis under the last
panel; `x` = order index (default) or `tim` (toggle); `y` = block number within `[lo, hi]`,
ticks by `ticks()` from `data/scale.ts`. Mark = rect from `y(block)` to `y(block + blocks)`
(min 1 px) and 1 px wide (2 px at ≤ 2,000 rows). Colour modes: event (the roles: `--c-userio` for
reads, writes a darker shade via `roleShade`, temp reads/writes the `--ev-temp` / `--ev-temp-w`
hues, concurrency-class block waits `--c-concurrency`), object (categorical over the objects
present, names from `doc.objects` when a reference bundle is applied, else `obj# N`; the extents
bands always use the object hue at low alpha), statement (categorical over the statements present,
`StmtLink` in the legend). Brackets over the top of the x axis mark the statements' stretches
(as in the mock-up) when there are ≤ 12; otherwise the phases (`doc.contexts` actions).

Drawing: one `<canvas>` per panel (`devicePixelRatio`-aware, `ResizeObserver`, redraw on
`useStore(s => s.theme)` like `Minimap.tsx`), colours via `resolveVar`; an SVG overlay per panel
for the brush rectangle, the hover crosshair and the brackets; the axes as DOM like `Lanes.tsx`.
`drawBlockMap(ctx2d, panel, rows, colors)` is a pure function in `blocklayout.ts` taking the
resolved colours, so the mark geometry is unit-testable without a canvas.

Interaction: hover → tooltip (event, file and block range, blocks, object, statement, elapsed,
`LineRef` to `line` with `doc.fileOfCtx(ctx)`); click → the tooltip pins (a popover with the
links), `Esc` or click elsewhere closes; horizontal brush → `actions.setWindow(orderToTime(rows,
i0, i1))` (both axis modes map to a time window; the view then re-queries inside it); double-click
→ `actions.setWindow(null)`. A right-hand facts column: per statement (`StmtLink`), reads / writes
/ distinct blocks / reads per block, sorted by elapsed; and the sampling note "showing 1 in k of
N" when `sampled`. Empty state: "No physical I/O waits in scope: every read was a buffer cache
hit" (+ the current scope chips).

Performance budget: 20,000 marks draw in one frame; `ioMapOf` over 1 M waits in a few tens of ms
(two linear passes over typed columns); `limit` is a toolbar choice (5,000 / 20,000 / 100,000),
persisted.

### B6 Tests

Go: B2, B3. TS: `iomap.test.ts`, `blocklayout.test.ts` (panel heights, mark geometry, min
sizes, `extentsOf` merging, `rereadOf` on a hand-made set where every block is read twice,
`orderToTime` on a brushed range, time-axis mapping), `views.test.ts`, `viewKeys.test.ts`.
`TestParityWithServeSpill` and `ParityQueries` for the spill path.

### B7 Verification

io_waits.trc: 8,747 marks (no sampling at the 20,000 default); file 12 shows four diagonals for
ORDERS (stmts 6, 10, 21, 22) and two for CUST (9, 22) over interleaved extent bands; tempfile 203
shows the sort's write stripe and read stripe over 639 blocks and the hash join's 20-pass
sawtooth over 276 blocks; the facts column reads 20.3 reads per block for stmt 22's temp reads;
file 10 shows three marks. `limit 5,000` → "showing 1 in 2 of 8,747". Brush over the sawtooth →
the window chip appears, the view re-queries, the Lines button of the WindowBar is not shown here
(this view has no WindowBar; the FilterBar chip is the handle). Also: `testdata/sets/workload`
(multi-file: panels per file across contexts, the Files panel scopes them), parallel.trc (PX
slaves' reads), a trace without physical I/O (level_1.trc: the empty state), a trace with a
reference bundle (`testdata/reference/bundle`: object and file names in the legend and tooltips).
Screenshots light and dark, desktop (`drive.mjs --open testdata/traces/19c/io_waits.trc --view
Blocks --name blocks`) and standalone.

### B8 Docs

`ARCHITECTURE.md`: endpoint row, a "Blocks view" section (classification, two-pass sampling,
order axis, layout module); `DESKTOP.md` § Views; `DESIGN.md`; HANDOFF; `site/docs.html` views
list if it has one.

Done when: B6 green including the parity tests, `scripts/ci-local.sh` green, B7 screenshots,
`api.d.ts` and the dist committed.

## 7. Order and commits

1. **R** Row flow: one commit (`Row flow: Sankey of a plan dump in the statement inspector`),
   dist included. Push.
2. **D** Dialogue: one commit. Push.
3. **B-engine** `io/map` endpoint: Go, yaml, contract and parity tests, `api.d.ts`. Push (the UI
   does not use it yet; the engine is releasable at every commit).
4. **B-ui** G + the Blocks view + docs: one commit, dist included. Push. Then `scripts/ci-local.sh`.

R before D before B: smallest and data-complete first; each is independently useful and
releasable. Record each milestone in `docs/HANDOFF.md` (a dated bullet under a "Three new views"
heading) and tick § 9.

## 8. Decisions taken here (copy into `docs/DESIGN.md` when implemented; change there if revisited)

- **Placement.** Blocks is a tab; Row flow and Dialogue are modes inside the statement inspector,
  not tabs: they are about one statement or one execution and belong next to the plan table and
  the execution list. The tab bar stays at nine.
- **No chord for Blocks.** Digits 0 to 9 are taken; renumbering breaks muscle memory and the
  assistant's `mtkprof:` links. `key` becomes optional.
- **Order axis by default, time as a toggle.** On a time axis the full scans of io_waits.trc
  (2 ms each) would be slivers next to the 2.96 s of checkpoint waits before them; the order axis
  keeps the diagonals, re-reads and stripes visible. Both modes brush into a time window.
- **Deterministic every-k-th sampling above `limit`**, like `waits/scatter`, with `Files` and
  `Total` computed over all matches. 2-D binning (order × block cells) is v2 if sampled pictures
  turn out to hide re-reads.
- **Classification by parameter names** (`file#` / `file number` + `block#` / `first dba`), not by
  an event-name list: unknown and RAC events classify themselves.
- **Self time of a plan line** = inclusive minus children, clamped at 0 with a note: row-source
  timings are sampled and a parent can report less than its children (stmt 22's SORT AGGREGATE).
- **sqrt band scale by default**, linear on request, both persisted.
- **Collapse rule**: maximal runs of equal `(kind, rows)`, minimum 3; outliers at 10× the run's
  median elapsed or gap are kept apart. The thresholds are options of `dialogueOf`.
- **No new dependencies**; SVG and canvas by hand, colours from the tokens.

## 9. Status

| package | state | commit | notes |
|---|---|---|---|
| G view without a chord | not started | | |
| R Row flow | not started | | |
| D Dialogue | not started | | |
| B-engine `io/map` | done | | `IOMapFile.hi` is exclusive (largest block + blocks: § 1's ranges); `analyze.BlockEvents` builds the two `[]bool`; gc cr/current block 2-way have no parameter names, so they do not classify (gc cr/current request do); shared case `iomap-case.json` = 84 waits up to the 60th block I/O wait, 3 queries |
| B-ui Blocks view | not started | | |

## 10. Later (not in this plan)

A whole-session Dialogue (needs an endpoint for the call sequence of a session, not one
execution); a side-by-side Dialogue of two executions in `ExecCompare`; the dotplot of the call
sequence and its motif table (the loop finder), which would also give Compare a cross-trace
alignment; the fingerprint wall; 2-D binning for the block map; a "chapters and residuals" view
of a whole trace, for which the Dialogue's collapse rule is the first building block.
