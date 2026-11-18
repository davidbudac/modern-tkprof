# Plan replay: implementation plan

Written 2026-11-18 from the prototype in `docs/viz-concepts/plan-replay/` (the user's idea of 2026-11-17, "animate a
walkthrough through the plan"; decisions taken in two rounds of questions, recorded in DESIGN § Plan replay). Read
`CLAUDE.md`, `docs/HANDOFF.md`, ARCHITECTURE § Dialogue and § Row flow first: Replay sits next to Dialogue and reuses
its data.

## 1. What is being built

**Replay** is a third mode of one picked execution in the statement inspector: `Binds | Dialogue | Replay`. It plays the
execution back on its STAT plan:

- **Stage**: the plan, with the client at its root. Small plans (at most 5 lines, depth at most 2, 3 leaves) are cards
  in a left-to-right graph, leaves left; larger ones are rows in DBMS_XPLAN order with tree guides. A line glows in the
  colour of the wait it is in, or in the CPU colour while it is on CPU (§ 3). Rows travel along the edges as dots;
  counters climb to the STAT totals. Block grids hold every block the execution touched (one grid for the datafiles, one
  for TEMP): a read flies from its block to the line that read it, a TEMP write flies down, a TEMP read up, and a block
  read again gets brighter. Fetches leave the root as packets to the client; during `SQL*Net message from client` the
  plan's borders turn dashed.
- **Lanes** under it, the static picture with a playhead: CPU, one lane per plan line (its waits), other waits,
  client (fetches and think time). Chapters (§ 3) are bands over the lanes. Click or drag to seek.
- **Controls**: play / pause (space), previous / next chapter (← / →), speed ¼× 1× 4× of "the whole execution in 22 s".
  A caption names the chapter and what each moment is (the wait with its event, file and block; or the lines on CPU).
- **Facts and inferences** are told apart: counters that are inferred carry `≈` until the end, and a note under the
  lanes says which parts are inferred.

It answers "what was the plan doing, when": which line read what, when TEMP filled and was read back, how long the client
held the cursor, where rows started to flow. The prototype's two io_waits executions are the acceptance cases (§ 6).

## 2. Data: no engine work

- **The execution**: `DataSource.executionTrace(stmt, exec)` (the Loom's and Dialogue's query, same key
  `loom:<stmt>:<cursor>:<execNo>`): own calls (PARSE, EXEC, FETCHes), recursive children, waits with `event`, `ela`,
  `tim`, `obj`, `p1..p3`, `between`, `dep`. `null` = not available (report without facts, old engine): the Dialogue's
  wording.
- **The plan**: `doc.plansOf(stmt)` and `doc.planLines`. The dump of this execution is the plan of the same cursor and
  plan hash (`plh` of the EXEC) whose STAT line comes after the EXEC and before the cursor's next EXEC. Without one, the
  nearest dump of the same plan hash gives the structure, and the view says the counts are from another execution
  (§ 4). Without any dump of the plan hash: "no row source statistics for this execution's plan" and only the lanes.
- **Events**: `doc.events[id]` with `p1Name..p3Name`; `isBlockIO`, `blocksParam`, `isTempEvent`, `isWriteEvent` from
  `data/iomap.ts`. `db file parallel read` names `blocks` in p2: blocks, no address.
- The clock starts at the EXEC (the PARSE before it is in the header, not the replay) and ends at the last FETCH.

## 3. The model (`web/src/lib/data/replay.ts`, pure, tested)

Twin of the prototype's `prepare()` for one session (`docs/viz-concepts/plan-replay/replay.src.html`).

- **Which line a wait belongs to** (in-call waits of the own calls, `dep` = the execution's): TEMP I/O → the line with
  the largest own `pw` (pw minus its children's), else the root (obj# of a TEMP wait repeats the last object read);
  block I/O with an obj# → the line with that `obj`; `PX Deq: Execute Reply` → the PX COORDINATOR line; `SQL*Net` →
  client; the rest are "other". Waits of recursive calls are "recursive" (their own lane rows, no line).
- **Segments** (what the process does at each moment, non-overlapping): a wait; CPU between waits inside a call, on the
  lines between the previous wait's line and the next one's (the root at the call's ends); a recursive call; client
  think time (between waits of `SQL*Net message from client`); nothing between calls. A call with no wait on a line
  spreads its CPU over the lines by their share of STAT self time (time minus the children's, ≥ 3 %).
- **Rows over time** (fractions of each line's STAT `rows`): the root follows the fetches (exact, a step at each FETCH's
  end); a line with reads of its own follows its blocks read; HASH JOIN follows its probe side's reads and its TEMP
  reads; a blocking line (`SORT …`, `HASH GROUP BY`, `HASH UNIQUE`, `BUFFER SORT`, `WINDOW SORT`) outputs after its
  inputs are done, following its TEMP reads after that, else at once; a pipelined line follows its first started child;
  a leaf without reads follows the fetches, or, under a blocking line, runs from the EXEC to just before the first row.
  Lines that never started (`starts` 0 and `rows` 0, an adaptive plan's other branch) show "not started".
- **Chapters**: runs of the same key over the waits in time order (`read:<line>` for a line's reads and the TEMP writes
  after them, `back:<line>` for TEMP reads), each starting where the previous ended; runs under 4 % of the execution
  merge into the one before. A label per chapter: blocks read per object, TEMP writes and reads (distinct blocks),
  fetches and rows; else the two longest events.
- **Block grids**: the distinct blocks of the block I/O waits, datafiles and TEMP apart, in (file, block) order with a
  gap between files; per block the object (colour) and its reads and writes over time.
- Layout numbers (card positions, tree rows, grid cells) are functions here too, tested; the component only draws.

## 4. Edge cases

- **STAT of another execution** (`plan_stat=first_execution`, the default, writes STAT once per cursor): structure and
  objects stay; rows are not inferred (no `≈` counters and no row dots except to the client); a note names the execution
  the counts are from.
- **STAT time does not reconcile** (nbstest3's nested loop: 1.27 s of row-source time in a 0.8 s execution): the replay
  never uses STAT time for the clock, only for the CPU spread of a call without waits.
- **No waits at all** (timed waits off, or all cached): CPU spread, fetch packets, no grids.
- **Truncated execution trace** (50 000 children / 200 000 waits): a note; the replay ends where the rows end.
- **Large executions**: lanes are drawn once into an offscreen canvas; at most 6 block flights per frame (the others
  update the grids only); dots per edge capped (240 per execution). Seeking replays the block states from the start
  (linear in waits).
- **PX**: out of this version (decided 2026-11-18). A coordinator replays its own waits (`PX Deq: Execute Reply` on the
  PX COORDINATOR line) with a note that the slaves are in other sessions. The prototype's PX scene shows the follow-up:
  slave traces of the set on one clock, a grid coloured by slave, per-slave lanes; it needs the slaves' rows of the same
  execution from the engine.

## 5. Drawing and motion (`web/src/lib/views/Replay.tsx`, `views/replayDraw.ts`, `styles/replay.css`)

- Canvas 2D, no dependency. Colours from tokens via `resolveVar()`, re-read on `State.theme` and
  `prefers-color-scheme`: CPU `--c-cpu`, TEMP write / read `--c-userio` / `--c-sysio` (first tried the Loom's
  `--ev-temp-w` / `--ev-temp`: two browns that cannot be told apart in the grid and the lanes), client think time
  `--c-idle`, fetch packets ink, other `--c-other`, objects `--ev-direct`, `--ev-scat`, `--c-commit`, `--c-concurrency`
  (then again).
- Motion is the content here, started by the user (opening Replay plays it); DESIGN § Motion's budget applies to the
  chrome, not to the playback. With reduced motion it does not play by itself, and playing moves the playhead and the
  counters without flying blocks, dots or glow pulses.
- The animation runs only while the canvas is on screen (IntersectionObserver) and the window is visible.
- Keyboard: the canvas wrapper is focusable; space, ← and → act when it has focus (not globally).

## 6. Tests and acceptance (io_waits.trc, `findings-io_waits.json.gz`)

| execution | expected |
|---|---|
| stmt 22 `7r10y07tqpg98` (hash join) | 3 chapters: 0–84.7 ms (MTK_CUST 1,204 blocks, 49 TEMP writes), 84.7–521.4 ms (MTK_ORDERS 496 blocks, 227 TEMP writes), 521.4 ms–end (5,612 TEMP reads of 276 blocks, 1 row) |
| | TEMP writes and reads on line 2 (HASH JOIN, own pw 276); reads on lines 3 and 4 by obj# |
| | rows at the end = STAT rows of every line; HASH JOIN's rows rise in chapters 2 and 3 only |
| stmt 21 `52nzchs09dgn1` (sort) | 1,331 TEMP writes and 1,331 TEMP reads on line 1; the first row at 2.45 s; 202 fetches |
| every execution of every findings document | the model builds; segments do not overlap; chapters cover the clock; fractions in [0, 1] and non-decreasing |

Plus unit cases on synthetic traces (`makeDoc`): STAT of another execution, a plan with an inactive branch, a call
without waits, a wait on an obj# no line has.

UI: screenshots of both io_waits executions in the CLI's `serve` UI and in the desktop (`verify-mtkprof`), light and
dark; reduced motion checked once.

## 7. Docs and commits

DESIGN § Plan replay (the decisions), ARCHITECTURE § Plan replay, DESKTOP § Replay (user guide), HANDOFF (state),
this plan's log; the prototype committed under `docs/viz-concepts/plan-replay/` (its build output ignored). `make web`
and the embedded UI in the same commit as the lib change; `pnpm -r typecheck`, `make test`.

## Log

- 2026-11-18: plan written; prototype v2 (five scenes) reviewed by the user.
- 2026-11-18: built. `data/replay.ts` (model + layout, 19 tests: the io_waits acceptance numbers above, every execution
  of every findings document, synthetic cases), `views/replayDraw.ts`, `views/Replay.tsx`, the `Replay` button in
  `StatementDetail.tsx`. Differences from this plan: TEMP colours (§ 5); the plan lookup also joins a dump the model
  split (`dumpLines`, found on opt_interleaved: HANDOFF § Plan replay has the model bug); the clock starts at the EXEC
  and the PARSE before it is a number in the bar. Verified by screenshot: io_waits stmts 22 and 21 and opt_interleaved
  8a01tvd45h89r in `mtkprof serve` (dark, light, reduced motion), io_waits stmt 22 in the desktop's dev browser mode.
