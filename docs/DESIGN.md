# Design decisions

Settled on 2026-10-22 in a design review. Each item is a decision, not a
guess; change this file when a decision changes.

## Purpose and audience

mtkprof analyzes Oracle SQL trace files (event 10046) for performance DBAs
and consultants. It must answer, in this order:

1. Where did the response time go (resource profile).
2. Which statement, and which execution of it.
3. Why that execution was slow: waits, plan step, bind values.
4. What the client did between calls: think time, network round trips,
   fetch sizes, commits.
5. The PL/SQL and recursive SQL hierarchy.
6. Trace-level findings (see below).

Comparison of two traces or two executions is v2.

## Inputs

- Oracle 19c and later, event 10046 / `sql_trace` / `DBMS_MONITOR` only.
  No 10053, ASH or AWR inputs. 19c, 21c (XE) and 23ai (Free) are tested
  with real fixtures and tkprof parity (`testdata/traces/{19c,21c,23ai}`; no
  PX traces on 21c/23ai, XE/Free have no parallel execution); 12.x is "should
  work, untested".
- A trace is a **set of files** forming one logical trace: several paths or a
  directory; `TRACE CONTINUES IN FILE` chains followed automatically; each
  file's process becomes a session-context dimension (as in `trcsess`
  output); PX slave traces attach to their query coordinator as child
  sessions, matched by time window and the coordinator's client id, module
  and action (done 2026-10-24, milestone 4: see ARCHITECTURE § Trace sets;
  slave work is shown per statement as `PX slaves: N sessions, X s` and kept
  out of the coordinator's response time).
- Size targets: a 1 GB trace produces the interactive HTML in under 15 s and
  under 4 GB RAM; a 10 GB trace produces the text report and HTML in
  minutes (`-aggregate` keeps no calls or waits: a 10 GB trace in ~0.5 GB;
  the report then lacks the executions tables, bind sections and fact
  tables). HTML reports are **always written in full** (no sampling);
  for traces whose fact tables are too big for a browser, `serve -facts=false`
  slices on the server (done 2026-10-24: the browser holds only the dimension
  tables and statistics; the Go server answers the Pivot, timeline, executions
  and event queries from the fact columns; see ARCHITECTURE § Server-side
  slicing).

## Outputs

Text and HTML are **equal in numbers, not in form**: every number reachable
in the UI is reachable from the CLI.

- Default command: `mtkprof <trace...>` (no subcommand) parses once and
  writes both reports next to the trace, named by appending to the first
  input: `trace.trc.txt` and `trace.trc.html` (the full file name is kept so
  an existing `trace.txt` is never overwritten). It takes the flags of
  `report` and `html`; the subcommands remain for stdout, `-o` and the rest.
- `report`: text report with resource profile, statements, call tables
  (tkprof-style exclusive numbers), executions with binds, plans, recursive
  links, sessions, time buckets, findings.
- `pivot` subcommand: `-fact calls|waits -by dim[,dim] -measure m` with the
  same dimensions and measures as the UI Pivot.
- `html`: self-contained interactive explorer (curated views: Overview,
  Statements, Waits, Timeline, Sessions; Pivot and CSV export as the escape
  hatch). `serve`: the same UI from a local server. The Overview answers
  "where did the time go" first: the statement concentration (top k = 80%),
  the response-time bar on a true
  time axis with a per-event ledger, the top statements on the same axis,
  then the session on wall-clock lanes (drag = time window; click a block = its interval as the window and its
  statement selected, double-click = open the statement; the window bar leads to the window's lines). A bucket chart
  (CPU plus waits per event, top 10, the rest folded; or per class) is the
  alternative time view. Statements is a workbench: ranked list, the
  statement's tkprof table/plan/executions in the centre, context on the
  right. Chrome is neutral (IBM Plex); hue is reserved for wait classes
  (and CPU). Call phases (PARSE / EXEC / FETCH / CLOSE / other) are shades
  of one neutral ramp, so a phase bar never reads as a wait class beside
  the wait strips.
  UI, findings and CLI text state facts only: numbers, names, terse fragments;
  no narration, no remedies or advice (plan advisor suggestions are not shown).
- `json` and `export` (CSV tables) for other tools.
- Bind values are kept by default; `-redact-binds` replaces them with type,
  length and a stable hash (`-redact-salt S` salts the hash); `-binds none`
  drops them.

## Correctness contract

- tkprof parity (call statistics, library cache misses, wait tables) is a
  hard golden test on every fixture in `testdata/traces/19c`.
- TVD$XTAT's feature list is the parity checklist.
- A wait inside a call's `[tim-e, tim]` belongs to the call whatever its
  class (an idle `PL/SQL lock timer` of `dbms_session.sleep` is in the call's
  elapsed and in-call waits); idle time is only what lies between calls
  (think time). Response time = elapsed + idle between calls never counts a
  wait twice; the wait class stays on the event for the ledger and the
  `idle` filter (decided 2026-10-25, tkprof's numbers are unaffected).
- The response time of a trace set, or of any scope of it (files, sessions,
  window), is the sum over its sessions of each session's response time
  (DB-time-like, decided 2026-10-25): a session is one server process of a
  file chain (its contexts and chain continuations); its response time is
  its span from the first call start to the last call or wait, between-call
  idle included, each context clipped to its file's time range and the
  session to the window. PX slaves attached to a coordinator in scope are
  left out (their work is the statement's `PX slaves`); unattached slaves and
  independent sessions each count. A single-session trace's response time is
  its span, so single-file numbers do not change. Every percentage of the
  response time (ledger, top bar, statement shares, findings severities, the
  Files panel's per-file share, the text report) is of this sum; the
  wall-clock span is shown beside it ("wall 3.849 s").
- Fixtures are generated on the dbmint lab (`testdata/gen`) whenever a
  scenario is missing.

## Plans

- The only plan data in a trace is the STAT block: row-source actuals with
  cost / size / card estimates. mtkprof keeps its own lightweight plan view
  centred on actual versus estimate per step (rows vs card, starts, time,
  buffer gets), one plan per plan hash, one per execution when
  `plan_stat=all_executions` is on.
- Integration with `davidbudac/ora-explain-plan-viz` is a **data contract
  plus deep links**, not code sharing: each STAT dump becomes the JSON row
  array the visualizer auto-detects (`id, parent_id, depth, operation,
  object_name, cardinality, bytes, cost, actual_rows, starts,
  actual_elapsed_time, cr_buffer_gets, physical_reads, physical_writes,
  sql_id, plan_hash_value`) plus the SQL text and execution number.
  "Open in plan viz" links the latest dump per plan hash (per-execution
  choice when several exist) to a configurable base URL (default the hosted
  site; CLI flag for `html`/`serve`, UI setting in localStorage); the plan
  travels only in the URL fragment.
- Plan-level findings (misestimates, spills, nested-loop volume, pruning)
  stay in the visualizer's advisor.
- Done (2026-10-24): the shared core package `@davidbudac/ora-plan-core`
  (types, parsers, analysis, advisor; no React/DOM) lives in
  `packages/ora-plan-core` of the visualizer repo and is **vendored** into
  `web/vendor/ora-plan-core` (synced by `web/scripts/sync-core.sh`, nothing
  is published). The Plans section of the statement detail shows the
  advisor's findings per STAT plan, inline (see ARCHITECTURE § Plan advisor).
  Still open: a LICENSE file in the visualizer repo (the README says MIT).
  Small changes in the visualizer repo are made as part of this project when
  the integration needs them.
- Done via a Go port (no code sharing): the visualizer's DBMS_XPLAN parser is
  ported to `internal/ref/xplan.go`, and `ApplyRef` overlays predicates,
  query block / alias and estimates from the ref bundle's `plans/<sql_id>.txt`
  onto the STAT lines of plans with the same plan hash, by operation id
  (see `docs/REF-BUNDLE.md`).

## Findings (v1)

Trace-level only, with fixed documented thresholds (overrides are a later
version), severity info / notable / serious, evidence rows, shown on the
Overview and in the text report. In the UI they follow the file / session /
window selection (computed over the rows in scope, severities against the
scope's response time); a finding about the whole set is tagged "whole set".

- Outlier executions: far slower than the statement's median (default:
  above 3x the median and above 100 ms), with their binds.
- Plan change within the trace: a statement with more than one plan hash.
- Parse and cursor churn: hard parses per execution, parse-to-execute ratio
  near 1 (default above 0.9 with more than 10 executions), hard closes
  (type=0) instead of cursor caching.
- Client-side time: think time dominating (default above 30% of response
  time), small fetch sizes (rows per fetch), commit per row, SQL*Net round
  trips per row.

## Enrichment (offline only)

`mtkprof refscript trace.trc > ref.sql` writes a SQL*Plus script tailored to
the trace (its obj#, file#, uid and sql_ids). The DBA runs it; it spools
objects, datafiles, users and DBMS_XPLAN output (DISPLAY_CURSOR with
DISPLAY_AWR fallback). Default uses DBA views and V$ (SELECT_CATALOG_ROLE);
`refscript -lite` emits an ALL_ views variant any schema can run.
`--ref dir` applies the bundle to every output. The analysis commands never
connect to a database; `mtkprof ref -db` / `trace` / `fetch -db` and the
desktop engine do (`internal/remote/db`, docs/REMOTE.md), and `ref -db`
runs the same queries (`report.RefQueries`, the values `RefScript` prints)
to fetch the bundle directly.

## Deferred to v2

Comparison mode; raw trace line viewer (serve mode only); DBMS_XPLAN overlay
via the shared package (the core's `dbmsXplanParser` is vendored, not wired up yet); configurable finding thresholds. (Server-side slicing
in `serve` is done: see Inputs.)

## Desktop app (decided 2026-10-25)

Plan, protocol and the full decision log: `docs/PLAN-DESKTOP.md`.

- Internal team tool for Windows, macOS and Linux (all first-class); private,
  unsigned GitHub releases; no updater. Traces of 1–2 GB are the ceiling.
- The Go core is the engine: `mtkprof engine` runs locally as a sidecar
  process, holds N open traces, always builds in aggregate + spill mode, and
  keeps the spill directory as a persistent index cache (user cache dir,
  20 GB LRU) keyed by trace content identity. No Rust rewrite of the parser
  or model; no remote-engine mode; no LOD tiles (a 1024-bucket minimap in the
  document instead).
- The shell is Tauri 2 (Rust) around the React/TS UI. Committed; GPUI is not
  revisited.
- One repository, two clients (2026-11-02; was a separate private repo
  `mtkprof-desktop` pinning this one as a git submodule): the engine and the
  CLI at the root, the CLI's UI and the shared lib in `web/`, the desktop app
  in `desktop/`. One pnpm workspace (catalog for the versions both use), one
  commit for a lib change and its desktop use, one version and one tag for
  the CLI binaries and the installers. Why: the pin, `check:deps`, `gen:api`
  follow-ups and edits made inside the submodule's checkout kept the two out
  of step; the desktop code went public with it (Apache-2.0 like the rest).
- Transport: loopback HTTP with a bearer token, SSE events (jobs, sessions,
  prompts), the existing `/api/*` handlers per session, OpenAPI contract in
  `api/engine.openapi.yaml` with a protocol version.
- Remote access lives in the engine and is also exposed as CLI subcommands
  (`fetch`, `follow`, `trace`, `ref -db`): SSH through the system `ssh`/`sftp`
  binaries with an `SSH_ASKPASS` bridge (Go library fallback), Oracle through
  a pure-Go thin driver with username/password over TCP/TCPS (ADR views, trace
  enable/disable, reference data). Live follow over SSH only. No secret is
  ever stored: every credential is prompted through one prompt mechanism.
  Connection definitions (no secrets) are an import/export file plus a
  watched team file.
- `web/` stays the single source of the views: split into `lib` (shared) and
  `app` (standalone shell); `mtkprof html` and `serve` keep working; views
  that need the engine (Lines, connections, annotations) are desktop-only.
- v1 = phases 1–5 of the plan (engine, shell, Lines, remote, report download
  + annotations + saved pivots); cross-trace compare is post-v1.
- Every engine answer equals the CLI's (`serve -spill` parity test); the
  golden test stays the correctness contract.

## Assistant (decided 2026-10-31)

Plan: `docs/PLAN-assistant.md` in the desktop repository. A DBA can hand what
mtkprof sees, with their notes and a case description, to an LLM agent.

- Views, findings and reports stay facts-only. Interpretation lives in a
  separate, labelled surface (the assistant), where every claim must cite
  something the trace shows.
- `mtkprof brief` and `POST /s/{id}/api/brief` render a scope-aware Markdown
  brief (`report.Brief`): the numbers mtkprof computes for a window and a set
  of session contexts, the DBA's notes next to what they annotate, the case
  text, and closing instructions for the agent. It adds no interpretation.
- Bind values are masked by default: type, length and a hash salted per brief
  (random unless given), so equal values match inside one brief and nowhere
  else. SQL text, which can carry literals, is never masked, and the brief
  says so.
- The engine stores no secret for the assistant. The analysis commands still
  never connect to a database or a model: `mtkprof brief` is offline, and the
  other parts of the assistant (the desktop engine's conversations, the tool
  bridge `mtkprof mcp` on loopback) run only on the user's say-so, per trace
  and provider.
- A conversation (`POST /engine/assist/conversations`, `internal/assist`)
  names its provider without a secret. The API key is asked for through the
  prompt mechanism (kind `apikey`, the provider id as the connection, the
  provider's kind and base URL as its `endpoint`) and held in engine memory
  per provider, bound to that endpoint, until `DELETE .../providers/{id}/key`
  or the engine exits. A key typed or remembered for one endpoint never
  answers for another under the same id. The agent loop runs in the engine: tool calls run in process
  on the session's trace, with the conversation's masking. A turn streams as
  NDJSON on its own request, never on `/engine/events`, whose buffer drops a
  slow subscriber.
- The `claude` and `codex` providers run the user's CLI with its own login,
  in an empty temp directory and its own process group (killed on cancel),
  with mtkprof's tools as the only tools: `mtkprof mcp`, whose calls come back
  to the engine and are the turn's tool events. The engine token reaches it
  through the environment only (claude expands `${MTKPROF_TOKEN}` in a 0600
  MCP config; codex forwards it by `env_vars`), never argv or a file. claude
  is one process per conversation with no settings, no transcript, no auto
  memory and no CLAUDE.md. codex is experimental: `exec --ephemeral` per turn
  with the conversation resent, a read-only sandbox with approvals `never`
  (an approving setup lets `apply_patch` write despite the sandbox), the
  user's MCP servers, hooks, plugins and shell switched off, and the engine
  stops a run that tries a shell command, a file change, a web search or
  another MCP server. The user's `~/.codex/AGENTS.md` still applies.
- `mtkprof mcp` without `MTKPROF_ENGINE` (2026-11-01) is a standalone MCP
  server for the user's own agent (Claude Code: `claude mcp add mtkprof --
  mtkprof mcp`): the same tools run in process on traces the agent opens with
  `open_trace` (one trace set at a time), without the desktop-only `notes`,
  `current_view` and `show`. Bind values are masked by default with a salt
  random per server (`-binds keep` to show them). It holds no secret and
  calls no model; its instructions (`internal/assist/mcp_instructions.md`, the
  initialize answer) ask for `file:line` citations instead of `mtkprof:` links.
  Setup, protocol flow, bridge variables and troubleshooting: [MCP.md](MCP.md).

## Three new views (decided 2026-11-03, `docs/PLAN-VIEWS.md` § 8)

- **Placement.** Blocks is a tab (after Waits); Row flow and Dialogue are
  modes inside the statement inspector, not tabs: they are about one
  statement or one execution and belong next to the plan table and the
  execution list. Row flow is a `Table | Flow` toggle on each plan section,
  one persisted choice for all; Dialogue a `Binds | Dialogue` toggle on one
  picked execution (persisted). A side-by-side Dialogue of two executions in
  `ExecCompare` is v2; a whole-session Dialogue needs an endpoint for a
  session's call sequence.
- **Entry points (2026-11-03, after first use: the modes were hard to find).**
  The statement inspector's action row has `Row flow`, `Dialogue` and
  `Blocks` buttons: Row flow switches the plans to Flow and scrolls to the
  first; Dialogue opens the slowest execution in Dialogue mode and scrolls to
  it; Blocks opens the Blocks view filtered to the statement. Each button is
  there only when it can show something (a plan; executions on a source with
  facts; block I/O events and waits). A statement of one execution opens it.
  Blocks' filter (statement, event) is store state (`State.blocks`,
  `showBlocks`), so other views link into it: the inspector's Waits list
  (`in Blocks` on a block-I/O event: statement and event) and the Waits
  view's event detail (the event).
- **No chord for Blocks**: digits 0 to 9 are taken and renumbering breaks
  muscle memory and the assistant's `mtkprof:` links, so
  `SessionViewDef.key` is optional; a row without a key has no chord and no
  hint, ⌥⌘← / ⌥⌘→ (Ctrl+PageUp / PageDown) still step through it.
- **Row flow: self time of a plan line** = inclusive minus its children's,
  clamped at 0 with a note (and a `*` on the node): row-source timings are
  sampled and a parent can report less than its children (io_waits.trc
  stmt 22's SORT AGGREGATE, 597 ms over a 610 ms join). Shares are of the sum
  of self times, so they add up to 100 %.
- **Row flow: sqrt band scale by default**, linear on request, both
  persisted. The thickest band grows with the decades of the largest flow
  (24 px + 16 px per decade, at most 120): a 5-row plan is not drawn as
  thick as a 100 k-row one; the numbers are written on the bands.
- **Row flow: the estimate ghost compares like with like.** A-Rows is a total
  over all starts, E-Rows per start, so the ghost is E-Rows × starts, except
  below an iterator (INLIST ITERATOR, PARTITION, PX BLOCK ITERATOR) whose
  card covers every iteration. A row source that never started (starts 0,
  e.g. the PX slaves' lines in the coordinator's dump) has no ghost. The plan
  advisor's cardinality rule uses the same estimate (2026-11-06: the
  vendored core multiplied below an INLIST ITERATOR too and reported nasty_sql's
  57b0w2txwjvby as a 1,119× misestimate): `advisor.ts` overwrites the core's
  `estimatedRowsTotal` with Row flow's `comparableEstimate` wherever the core
  has one, and keeps the core's "nothing to compare" cases (never started,
  early end below COUNT STOPKEY).
- **Dialogue: collapse rule.** Maximal runs of equal `(kind, rows)`, minimum 3; a turn above 10× the run's
  median elapsed or median gap is kept apart, so a run can become frame, turn, frame. The thresholds are
  options of `dialogueOf` (`minRun`, `outlierX`, plus `floorUs` = 10 µs: medians below it count as it, so
  timer noise on µs calls makes no outliers). Recursive calls are grouped by statement and call kind with the
  same 10× rule (the first EXEC of a PL/SQL loop's cursor).
- **Dialogue: the execution trace's calls, no CLOSE.** The turns are what `executions/trace` returns (the PARSE
  right before the EXEC, the EXEC, its FETCHes), as for the Loom; the CLOSE and the client gap before it are not
  drawn (io_waits stmt 21: 204 turns, § 1 counts 205 calls). Adding the CLOSE would change the engine route and
  the Loom for one arrow.
- **Dialogue: round trips from idle between waits.** Calls with no idle between wait between them went in one
  round trip (SQL*Plus: PARSE, EXEC, FETCH #1), so only the last one gets a reply arrow; a non-idle between
  wait is still a client gap (with its class in the popover) but no new round trip. Without WAIT lines the
  round trips are unknown and every call replies.
- **Dialogue: the wall clock is first call to last.** The client gap before the first call is outside it (a
  note, not a bar segment); untimed is clamped at 0 when CPU, waits and gaps overlap.
- **Blocks: deterministic every-k-th sampling above `limit`** (`/api/io/map`),
  like `waits/scatter`, with `files` and `total` computed over all matches:
  the 1st, the (k+1)-th, ... match in trace order, k = ceil(total/limit), two
  passes and no list of all matches. 2-D binning (order × block cells) is v2
  if sampled pictures turn out to hide re-reads.
- **Blocks: classification by parameter names** (`file#` / `file number` +
  `block#` / `first dba`; a block count in p3 when it is `blocks` /
  `block cnt`), not by an event-name list: unknown and RAC events classify
  themselves, with one exception by name: the control file events (`control
  file sequential read` / `single write` name p1 `file#`, but it is a control
  file's number, 0 or 1, which would share a "file N" panel and a file name
  with a datafile; 2026-11-06, `Event.IsFileP1` / `isFileP1`). gc cr/current
  block 2-way do not count either (no parameter names in V$EVENT_NAME).
- **Blocks: order axis by default, time as a toggle**; both brush into a time
  window (the view re-queries inside it, a double-click clears it). On a time
  axis the full scans of io_waits.trc (2 ms) are slivers next to the 2.96 s of
  checkpoint waits; on a linear order axis they are slivers too (98 of 8,747
  waits), so, as the mock-up's broken axis did, statement (or phase) runs
  narrower than 64 px are widened to 64 px and the rest stays linear; the
  caption names the largest factor and the axis marks the breaks.
- **Blocks: brackets are runs of one statement**; a recursive wait inside a
  run, or right before the shallower statement it ran for (same context),
  belongs to that run, so a dictionary lookup does not get a stretch of its
  own. Above 12 statement runs the phases (contexts' actions) are the
  brackets.
- **Blocks: own temp hues** (`--bm-temp-r` teal, `--bm-temp-w` magenta in
  `styles/blockmap.css`), not the Loom's `--ev-temp` / `--ev-temp-w` pair:
  a sort's write stripe and read stripe interleave in 1 px marks and the
  Loom's two browns cannot be told apart there.
- **Blocks: object ranges are what the waits touched**, not DBA_EXTENTS:
  overlapping block ranges merged, touching ones apart (that reproduces the
  extent counts of io_waits); temp waits never count for an object (their
  obj# is the statement's object). Re-reads are counted per statement and
  file (stmt 22's temp reads: 20.3 per block), and over the shown rows when
  the answer is sampled (the view says so).
- **No new dependencies**; SVG and canvas by hand, colours from the tokens
  (Row flow's self-time ramp is one blue hue, never a wait-class colour;
  Dialogue's TEMP in the Loom's `--ev-temp-w` / `--ev-temp`; the block map
  is canvas 2-D per panel with its own temp hues, above).

## Motion (decided 2026-11-03)

- **Motion says what changed or that the engine is working; it never
  decorates.** Adapted from transitions.dev (its snippets may ship in an
  app; the library itself may not be redistributed). One module for both
  clients: tokens, keyframes and primitive classes in
  `web/src/lib/styles/motion.css`, helpers in
  `web/src/lib/components/motion.tsx` (moved from `desktop/src/`, which
  already used them for modals, toasts and the shake). No dependency.
- **Where:** a sliding pill under the pressed button of every segmented
  control (`span.seg`) and the current view tab (`.tabs`), placed by
  `installSlidingPills`, which both clients call once (no call-site
  changes; without it the buttons keep their own fill); toolbar menus and
  the trace popover grow from their button and fade out (`useExit` keeps
  them mounted, inert, for the exit); values that change in place
  (live-follow snapshots, another scope: Overview ledger, profile legends,
  the live badge) cross-blur (`SoftText`), the response-time headline and
  the revision pop their changed digits (`PopText`), bar segments ease to
  their new widths; the statement detail enters from the side of the list
  the pick came from (j: from below; enter only, nothing stays mounted);
  stale lanes, wait stats and block maps pulse while the engine works
  (instead of a static dim) and the answer sharpens in (`useReveal`);
  loading lines shimmer; Copy → Copied morphs only the letters that differ;
  status notes rise in and blur out. The Overview keeps the last profile of
  the same scope while a newer snapshot's loads, so live values swap in
  place instead of flashing "Loading…".
- **Budget:** 150 to 500 ms, interruptible (a new change cuts the running
  one short; holding j never queues), and nothing with reduced motion: every
  rule sits in `prefers-reduced-motion: no-preference` and the helpers check
  it, so the end state shows at once.

## Formatted Lines view (decided 2026-11-04, mock-up `docs/mockups/readable-lines/`; round 2 decided 2026-11-06, mock-up `docs/mockups/formatted-v2/`; round 3 decided 2026-11-07, `docs/PLAN-TRACE-PANE-V3.md`)

Round 2 came from three design-review lenses on the round-1 view (visual, DBA
workflow, information design), ten changes mocked on the real rows of
`io_waits.trc` (NOW above PROPOSED, `docs/mockups/formatted-v2/index.html`) and
a list of twelve suspected bugs; `docs/PLAN-FORMATTED-V2.md` is the plan and its
Log the deviations. This section is the result as implemented (commits
636bd9d, a8a306f, cdb1133, 903ede1 and the docs commit after them). Where a
decision of round 1 changed, the text says what it is now and what it was.

- **Named Formatted** (renamed from "readable" the same day, at the user's
  request): the toggle reads `raw | formatted`. The pref keeps its key
  (`readable` in `mtk.lines.prefs`), so stored choices carry over.

- **Formatted is a layout, not only values.** The `raw | formatted` toggle of the
  Trace view (`v`) parses every line into columns: Δ · time, line number (with
  a pin), Statement (the cursor's lane, a 14 px band), Duration (with its bar),
  Operation (what the line is: PARSE, WAIT, PLAN, Bind#3, …), Detail and the
  wall clock on the right. It stays one row per trace line (a plan's head row,
  the sticky lane row and, with Wrap long lines, an SQL band, aside, below)
  inside the same virtualised viewer, so
  line numbers, search, bookmarks, folds, the side panel and every key keep
  working; the detail is cut where it does not fit (the hover card and the
  Line tab have the rest). The columns are resizable: dragging a header's edge
  (Clock from its start edge), double-click to reset, ← → with the grip
  focused; the grips show only while the pointer is over the header; widths are
  the `cols` pref (px), CSS variables `--w-<column>` on the viewer, set directly
  while dragging. The defaults are in digits of the rows' font (measured), so
  they fit their values at any font size. The Duration header is right-aligned
  over its numbers, to the pixel. Detail is one run of text, compact: a wait's
  event, object and parameters; a call's Detail is in groups (round 3, below).
  One colour rule everywhere: numbers in the ink, units and labels dimmed.

- **Lanes: a band column and one sticky row.** Consecutive lines of one cursor
  are one lane: a 14 px Statement column (a 6 px band in the statement's colour
  and a gutter) on every row of the lane. The lane's identity is not in the
  column but one **sticky lane row** at the top of the view while its lane
  scrolls, the mechanism of a plan's head row: the sql_id in the lane colour
  (never truncated), the SQL's start in `--ink-3` (cut at 48 ch) and `2.486 s
  here · exec 1 of 1` at the right. It covers only the top row, from the band
  column to the right edge (that row's Δ and line number stay visible), and
  is not shown over the selected line or a CURSOR row (that names itself).
  Each execution's first row (its BINDS if it has one, else the EXEC) carries
  an `exec N` tag in `--ink-3` at the start of Detail; the old label and `↳n`
  badge on rows are gone (`Lane.label/sub` stay in the data and the
  tooltips). The real cursor# is only in the tooltip (a 10046 trace has no
  child number, so none is shown). Statements take the categorical colours
  (`blocklayout.CATEGORICAL`) by elapsed rank; recursive SYS SQL (uid 0 below
  the top level) and statements past the 14th are neutral. Framing lines
  (blank, `***`, `=====`) inside a stretch stay in its lane.

- **The highlighted statement is a lane highlight, not a row tint.** The
  selected statement's lane (the app's selected statement, not the selected
  line's) shows in its own colour (`--hl`) in the Statement cell of every row of
  the lane (BINDS, PLAN and blank rows too, and the waits past the 1,000-wait
  mark cap) at 14 %, the band widens from 4 to 6 px, and the number cell keeps a
  3 px start bar on the calls and waits that carry a gutter mark. The rows
  themselves stay on the surface: only the selection and hot spots fill a row.
  The band keeps the colour the Colour menu gives it (the tint stays the
  statement's), and a selected row drops the lane tint (blue over amber read
  grey). A chip of the overview highlights its statement (and goes to it), `l`
  the selected line's (again: none), × none, all without leaving the Trace view.
  The raw view keeps its row tint. (Round 1 tinted the rows of the statement's
  marks at 10 % in its colour; rejected: a flat wash over every call and wait
  reads as a selection, the stripes where BINDS and PLAN rows are not filled
  read as noise, it hides the hot spot, it stops at the 1,000-wait cap while the
  calls go on, and the band mixed toward ink drew orange as maroon.)

- **Hot spots are the one red.** A call, wait or plan operation that takes 1 %
  of the traced time or more is a hot spot: the row fills with the critical
  colour (`--s-critical` at 16 %, 22 % in the dark theme), a 3 px start bar in
  it, and the Duration in 600 weight in it; a STAT row's A-Time cell gets the
  same fill (its own time, `hotUs`). Nothing else uses that hue (highlights
  were orange before, which read like hot spots). Idle waits are never drawn hot
  (waiting for the client is not where the time went); the engine's hot list
  (`api/lines/hot`, `j` / `J`, the density strip) still includes them. The
  selection is one amber fill, line-number cell included, and beats the hot
  fill (`j` must land on a row with a cursor); a selected hot row keeps the hot
  bar and the red Duration.

- **Calls loud, waits quiet.** The Operation column reads by weight, not by
  hue: PARSE, EXEC, FETCH, CLOSE, CURSOR (and COMMIT, ROLLBACK) are uppercase
  600 in the ink; a wait is a lowercase `wait` in `--ink-3` with a 6 px dot in
  its wait-class colour in front of the event name in Detail (a ring for
  idle); PLAN and BINDS are 500 in `--ink-2`; the marks (`***`, framing)
  `--ink-3`. `hard parse` is a tan pill (`--s-warning` at 18 %), not red text.
  (Round 1 gave every operation its own hue, which mixed WAIT to purple, PLAN
  green and BINDS teal: five hues in a column that is read for one thing.)
  The object of a wait is `--ink-2`.
- **A call says what it waited for.** When a call's elapsed minus its CPU is
  10 % of the elapsed and 100 µs or more, Detail ends with `· 631 ms waiting
  (99 %)` (`--ink-2`, the critical colour from 50 %): the FETCH of 637 ms no
  longer says nothing about the 26 reads above it. (`waitShare`.)

- **Time.** The bar lives with Duration: the number, then a 56 px track on a
  **log scale of the share of the file's traced time** (round 3: 0.01 % and
  below empty, 100 % full, four decades of 14 px). **1 % is the middle of the
  track and is marked on every track** (a 1 px tick in `--s-critical` at 38 %, 55 %
  in the dark theme, drawn over the fill; fainter ink ticks at 0.1 % and 10 %): a bar past the tick
  is a hot spot, so the hot rule (below) is on the screen, on every file. (The
  tick was at 75 %: down a run of rows the tracks stack into one red dashed line
  the length of the column in the light theme. It explains the rule, it does
  not point at a row, so it is quiet and still findable.) The
  Duration header says `1 %` over the tick (11 px `--ink-3`, centred on it) and
  its tooltip gives the traced time and the threshold (`bar: share of the traced
  time (78.0 s), log scale from 0.01 % to 100 %; red from 1 % (780 ms): a hot
  spot (idle waits never)`). A wait fills in its wait-class colour, a call in
  slate with its CPU part the solid, darker end; a track is drawn on every row
  with a duration so the numbers line up (the fold of repeats has one,
  `barFrac(fold.us, span)`; `span` is the file's traced time, `fileSpan` in
  `views/Lines.tsx`, the same number as the hot threshold's). The plan's A-Time
  bar (an operation's own time of the plan's) is another scale and stays. The Δ
  column is text only (the trace bar's Δ button and the palette hide it, pref
  `rdDelta`, on by default).
  **Δ is the unexplained gap** in the formatted view: where the line started
  (its `tim` minus its own time, the `ela` of a wait or the `e` of a call)
  minus where the line with a time before it ended, never negative, blank under
  50 µs, `--ink-3` by default and emphasised (`--s-warning`, 500) from 1 ms and
  twice the line before's duration; the tooltip keeps the `tim`-to-`tim`
  number. A call that follows the waits it covers has a blank Δ; the gap shows
  on the first wait after the previous call. **Pinned and raw are unchanged:**
  with a pin (`a`, or the pin in the line number) Δ is the time from the pinned
  line (the pin also anchors the raw view's delta column), the raw view's
  column is `tim`-to-`tim`, and so are the Δ filter and the colour-by-Δ mode,
  so a threshold means the same wherever the pin is. **A magnitude ramp** on
  the Duration and Δ numbers: µs in `--ink-2` 400, ms in the ink 500, s in the
  ink 650, units `--ink-3`; a 0 µs duration is `--ink-3`. `SQL*Net message from
  client` keeps its name and counts like any wait (an earlier "client think
  time" label was rejected).
  (Round 1 put a bar of the line's own time in the Δ column, linear on one
  scale per file, full = the file's longest call or wait: 1 to 3 px wide for
  almost every row, since the scale ran to 2.448 s, so 9 µs and 637 ms differed
  by two characters. Δ over that bar is rejected, and the linear scale is gone
  from the code, not kept dormant. Rounds 1 and 2's Duration bar was a log
  scale on absolute time, 1 µs empty to 10 s full, 8 px a decade: on a 78 s
  file 544 ms (not hot), 800 ms (red) and 5.6 s (red) were within 8 px of each
  other, and nothing showed where the 1 % line ran; rejected in round 3 for the
  share-of-the-file scale above, and gone from the code. Round 1's Δ was the `tim`-to-`tim`
  difference: +1.51 ms on an idle wait repeated the wait's own 1.49 ms, and a
  PARSE read −1 µs because its `tim` sits before its CURSOR line's.)
- **The clock shows what changes.** The whole stamp (`11:35:29.830999`) on the
  first visible row, on the selected row and wherever HH:MM:SS differs from the
  line before (a `***` line counts as a line with a time); every other row
  shows only the digits that change (`.828158`, right-aligned under the full
  one). The column is about 10 characters wide by default (the width saved goes
  to Detail), and Detail keeps 6 ch free at its end for the whole stamp, which
  reaches left into it. With folds or the Δ filter on, "the line before" is
  still the previous trace line, not the previous displayed row.

- **Row economy: framing lines and bind rows fold quietly.** The blank line,
  the `=====` rule and `END OF STMT` fold into the neighbouring row (`Fold.quiet`
  with `Fold.frame`): the rule becomes a full-width 1 px hairline on the next
  CURSOR row and `end of statement` disappears; a dotted gap mark on the number
  cell says lines are hidden there; `z` shows them. The list is the engine's
  (`api/lines/blocks?what=frame`: for each PARSING IN CURSOR of the file, the
  `=====` before it and its END OF STMT, each checked with `trace.Classifier`),
  because the folds must be global like every fold (a go-to far down lands on
  the wrong line if the folds above it load lazily with the pages), and a
  client guess from the cursor line is wrong on `nasty_sql.trc` (an END OF STMT
  inside the text). An older engine answers 400 and the view keeps those lines
  as rows. A rule whose line above is a table row or a repeat fold's last line
  stays a row. Blank lines are folded only where they already were (under a
  BINDS header): the few before a `***` timestamp and after a marker group are
  still rows, because finding them is a read of the whole raw file. `CLOSE`
  reads `cached` or `closed` in `--ink-3` (the old `hard close` /
  `already in the cursor cache` words are in the tooltip). SQL*Net's `1 byte`
  is dropped (it says nothing; `8,101 bytes` stays: the **1-byte rule**). The
  CURSOR row is one row, `c7ry5gr75qv4b  SELECT · user 165 · 99 chars`.

- **A BINDS block of up to four binds is chips on its header row.** `:B1 =
  8706` with the type dimmed after it (`NUMBER`) and `SQL with values →`; the
  `Bind#` lines and their attribute lines fold quietly (`Fold.inline`,
  `INLINE_BINDS`). The rule is by count, and chips are cut at 40 characters
  (the full value in the tooltip): the plan's "values of up to 24 characters"
  needs the values, which the engine's document does not have until each
  header is asked of `/api/at`, and the folds must be known up front. `z` on
  such a row, or a go-to or search into one of its lines, opens it as the
  table below. A block with more binds is a table: the BINDS line is the head
  (Variable, Value, Type, the `exec N` tag), each bind one row (its `Bind#N`
  line with the placeholder's name, the value as the trace has it (cut values
  marked) and the type), `SQL with values →` at the end of the last bind row
  (a row of its own would need a new kind of layout row). The attribute lines
  under a bind (type and length, character set, value length, the value as
  printed) fold quietly into its row (`Fold.quiet`: the handle line reads as
  itself, no ▸); the engine lists the `Bind#` lines of each block
  (`api/lines/blocks?what=binds`, `bindLines`). What they say is in the Line
  tab (`i`) under "Bind#N: type, length, value"; `z` on a bind row shows its
  lines in place, `z` on the BINDS line folds the whole block. (First built as
  a row per line, attribute lines decoded and indented: too long to read.)

- **Execution rules and `exec N` tags.** Each execution's first row (its BINDS
  if it has one, else the EXEC) starts under a 1 px `--ruling` rule and carries
  `exec N` in `--ink-3` (11 px) at the start of Detail, or, on a BINDS table's
  head row, as a cell of its own before Variable; the sticky lane row says
  `exec N of M`. A line in no execution (a CLOSE has none) gets neither tag nor
  count.

- **Runs of waits are columns; the first row says the event, the rest dittoed.**
  Three or more consecutive waits of one event and object (decided from the
  lines around a row: ±60, through waits, markers and blanks, until another
  kind of line) draw the rows after the first with the shared prefix (dot,
  event, object) in `--ink-3` at 60 % (the ditto), and, for the user I/O waits
  of exactly `file` / `block` / `blocks`, the varying fields as right-aligned
  micro-columns (`file 12 | block 171160 | 8 blocks`, no `·`), aligned down the
  run. An idle or network wait inside the run breaks the ditto, not the
  alignment. A micro-column row draws the class dot once, inside its prefix.
  Two runs of different events do not align with each other.

- **A call's waits are bracketed.** The non-idle waits under a call (the ones
  between the previous call and it) are indented 2 ch in Detail with a 1 px
  rule in the lane colour from the first such wait down to the call that
  closes them, hooking (└) into the call row; idle waits between calls get
  neither. The scan reaches ±300 lines; past that (or on an unloaded page) a
  wait is drawn inside and the rule is not cut.

- **A plan is one table.** Each plan dump (`api/lines/blocks?what=stat`) gets
  a head row of its own above its first STAT line (a `Fold` with `head`: it
  adds a visual row and hides none; the keys step over it), PLAN is said once,
  in that row, and the STAT lines are the table's rows under it, banded and
  ruled, in DBMS_XPLAN's columns (Id, Operation indented by depth, Name,
  Starts, E-Rows, A-Rows, Cost, A-Time, Buffers, Reads, Writes: the same
  columns for every plan, empty cells where a line has no value), numbers
  right-aligned in fixed-width columns. A plan line has no duration, Δ or
  clock, and those cells stay empty. A-Time has a 56 px bar track of the
  operation's own time of the plan's (`A-Time (bar: self)`); an estimate 10×
  or more off per start is in the error colour. While the plan's lines fill
  the top of the view the head row lies over the top row. A plan the user
  folds (`z`) is a fold like any other, without a head. The fold handle of a
  plan or BINDS table is `▾ PLAN` / `▾ BINDS` in the head row's Operation cell
  (other foldable lines, long SQL text, keep the handle column).
  **Tables sit on the sunken surface.** Plan and BINDS tables span from the
  Operation column to the right edge (through Clock) on `--surface-sunken` in
  a 1 px `--hairline` frame, headers 11 px `--ink-3` 500 under one hairline.
  **When the view is narrow, columns drop** in the order Cost, E-Rows, Starts,
  Writes, then Name (merged into Operation), never Operation, A-Rows, A-Time,
  Buffers or Reads, and the head row says `n columns hidden` (in Operation's
  cell; a cell too narrow for the word says only the count). The drop is
  decided in JS from the measured width (`data/planlayout.ts`, a
  ResizeObserver on the header cells), not in CSS, so the head row can say it.
  (First built as `·`-joined text, then as one PLAN row per line under a header
  shown only at the top; both rejected.)

- **Every line kind reads as prose, not as the trace's tokens.** Wait
  parameters are labelled (`file 12 · block 169947 · 5 blocks`, `8,103
  bytes`) and the ones that say nothing (`driver id`, zeros) left out; the
  object of a wait only on I/O and concurrency waits (Oracle leaves a stale
  obj# on the others); the attribute lines under a `Bind#` decoded and
  indented; `***` lines by name (SESSION, MODULE, ACTION, …) with their time
  in the clock column; SQL text with keywords, literals, binds and comments
  apart; the header's `Key: value` lines in two columns, the key column as
  wide as the longest key of its block; the `=====` line a thin rule. The raw
  text is in each piece's tooltip, the hover card and the Line tab.

- **The toolbar never wraps from 1100 px.** One row: the search shrinks first
  (down to 14 ch), then the labels fold to icons in four steps (the Go-to
  label, then the Colour label and mode, the Δ filter's mode and count and the
  window text, then Hot spot, Δ ≥ and Δ from, then the Raw / Formatted text),
  by container queries whose thresholds were measured with everything on
  (round 3's second Hot spot button fits inside them: no overflow measured from
  860 px up). It
  may wrap below 51 rem. Pressed toggles use the quiet style (ink on `--wash`);
  only Raw | Formatted keeps a solid segment.
- **The Highlighting chip is folded into the overview chip.** In the formatted
  view the `Highlighting ■ sql_id · N calls · M waits ×` chip is gone: the
  highlighted statement is always a chip in the overview bar (even when it is
  not among the 8 longest), outlined, with the count and the ×. The count is
  the real one (`StmtMarks.totalCalls` / `totalWaits`), and the tooltip says
  `first 1,000 waits marked` while the marks are capped. The raw view has no
  overview bar and keeps the chip.
- **The overview bar.** A 12 px track, a thin time axis under it (round
  wall-clock times; `+2 s` offsets for a trace without a wall clock) and a
  **viewport bracket** (two 1 px ticks and a 20 % wash) that follows the visible
  rows. The chips read `sql_id 2.486 s · 38 %` (seconds and share); the
  statements under 1 % fold into one `+4 under 1 %` chip that expands on click.
  A chip goes to the statement's first line in this file, a click on the track
  to the line at that time. (Round 2 labelled it `Where the time went · 6.46 s`
  in a 210 px slot at the left; round 3 dropped the words, which said nothing
  the bar does not: the span is in the track's `aria-label` and the axis. The
  track now takes the whole width; the statement picker of batch 3 brings the
  slot back.)

- **A selected line is never folded away.** A Fold repeats run that holds the
  selected line stands open and folds again when the selection leaves it; an
  opened run (by the user's ▸ or by a go-to) keeps a ▾ on its first line, and
  `z` or a click on it folds it again (a selection inside moves to the handle
  line). (A go-to into a run used to open its fold for good with no handle anywhere,
  which read as "Fold repeats does nothing": the cause of the 26 `direct path
  read` waits of io_waits lines 96–121 staying unfolded.) When the folds change
  (Fold repeats toggled, a fold opened above), the selected line keeps its place
  on the screen when it is in view. A go-to, `j` and the chips centre the target
  **on the row grid**: the scroll offset is a whole number of rows (20 px), so
  no sliver of the row above peeks out under the sticky lane row when the
  viewport's height is not a multiple of the row height.

- **Fold repeats is a toggle, off by default** (`r`): runs of 3+ identical
  waits, wait blocks still longer than 10 items after that, loops of 6+ small
  fetches (each under 1 % of the time) fold into one line each, computed by
  the engine over the whole file (`api/lines/repeats`) so the scroll bar does
  not jump as pages load. A fold of repeats opens with its handle and stays
  open; the user's own folds win where they overlap.
- **Fold repeats is an icon** (decided 2026-11-06, at the user's request): three
  rows gathered by a brace, pressed while on; the name is in its tooltip and
  aria-label. The text button took too much of the bar.
- **Colour the lanes by** (decided 2026-11-06): a menu right after `raw |
  formatted` (formatted view only, the lanes are its) picks what the lane band
  shows: Statement (the default, as before), Execution (the executions of a
  cursor in turn), Session (the context: session, module, action), Recursive
  depth, Operation (PARSE, EXEC, FETCH, CLOSE, WAIT, cursor parse, binds,
  commit, error), Wait class (calls are CPU), Duration and Δ from the line
  before (one orange ramp by decade: < 100 µs … ≥ 1 s), None. The menu has a
  key for every mode but Statement (the overview strip names those). The
  sql_id in the lane keeps its statement's colour whatever the band shows, and
  a line outside a lane (WAIT #0, a commit) gets a band of its own in the
  per-line modes. Pref `laneColor`.
- **Δ filter** (decided 2026-11-06): `Δ ≥ N ms` in the trace bar, both views,
  Off / Highlight / Filter. Δ here is always the time from the timed line
  before (a call, wait, cursor parse or commit: the line's own time plus any
  idle time before it), never from the pin and not the formatted view's gap,
  so the threshold means the same wherever the pin is. The engine lists the
  lines for the whole file (`api/lines/delta`, at most 100,000, the largest
  kept), so filtering does not depend on the loaded pages. Highlight tints the
  rows (violet, apart from hot spots' red and the selection's amber). Filter
  hides every other row: each kept row is a quiet fold over the lines up to the
  next one, with a dashed rule under it where lines are hidden (`z` on it shows
  them); the lines before the first kept row fold under line 1, which says how
  many; the filter's folds replace the user's, the repeats and the plan tables
  while it is on; each kept row carries its lane's sql_id. Prefs `deltaMs` (10
  by default) and `deltaMode`.
- **As run.** A BINDS row offers the statement with the values in place of
  its placeholders (side panel tab "As run"): SQL placeholders pair with the
  `Bind#`s by occurrence, PL/SQL ones by distinct name (decided by the
  counts); a bind without a definition of its own repeats its name's first
  value; NULL, dumps and missing values are said; a value Oracle cut is
  marked "truncated in the trace" and never completed. Previous / next walk
  the statement's executions in the file, not only the cursor's.
- **Pulse while switching.** Toggling formatted or Fold repeats pulses the rows
  (an opacity animation, which the compositor keeps running while the main
  thread works) until the new rows are painted or the folds arrive;
  reduced motion dims instead.

- **Round 3, batch 1 (decided 2026-11-07): the scale, Hot spot ↑ ↓, sql_id
  clicks, a call's Detail in groups.** The Duration scale is under Time above.
  - **Hot spot steps both ways.** The toolbar's `Hot spot ↓ 6` is `Hot spot ↑ ↓ 6`:
    two buttons (previous `J`, next `j`) and the count in one group, disabled
    with no hot spot, the label folding to icons at the same step as before
    (`hotStep` in `data/lines.ts`, the one rule for the keys and the buttons).
  - **A sql_id in the formatted rows opens its statement popup.** The CURSOR
    row's sql_id is a reference (`sqlid:…`, a `Seg.ref`, drawn as a `.lv-ref`
    link with `data-act="ref"`), so a click takes the path `refClickOf` takes
    for the raw view's links (`StmtPopover` at the click; Shift: the statement's
    PARSING IN CURSOR line in this file) whatever the `links` pref says (that
    pref is the raw view's underlining) and does not select the row. The sticky
    lane row's sql_id and the sql_id in the header over the raw rows
    (`lv-head-id`) do the same through `openStmt` in `views/Lines.tsx` (their
    Shift goes to the cursor's parse line); they used to go straight to the
    Statements view, which is now the popup's `Open in Statements`. (The Δ
    filter's `labelAll` still sets a lane label on every kept row but nothing
    draws it, so there is no other sql_id in a row to click.)
  - **A call's Detail is in groups.** `[exec N] [rows] [query · current · disk]
    [cpu] [notes]` (`callParts` in `data/readable.ts`, `CallDetail` in
    `LineViewer.tsx`). The rows are a slot of their own (the number right-aligned
    in 7 digits, then `row` / `rows` in `--ink-3`; always on a FETCH, on other
    calls when above 0; none without an r=) and the `exec N` tag has one (6 ch)
    on a call row that has any group, so the groups after them start at one
    x down consecutive calls (a PARSE, its EXEC, the FETCHes). The gets are
    tkprof's words, `query` (cr=), `current` (cu=), `disk` (p=), in one quiet
    box (`--surface-sunken`, 1 px `--hairline`, 3 px radius, 11 px type) that
    reads as a three-cell mini table, `query 498 │ current 0 │ disk 496`: each
    cell is its label, a gap of 0.4 digit and its number right-aligned in a
    fixed slot of 9 digits (1,234,567 does not move it; more pushes), the cells
    apart by a 1 px `--hairline` rule and 0.5 digit of padding either side (the
    first version had the labels and numbers evenly spread in one strip, so a
    number sat against the next label and `query 498 current 0` read as
    "498 current"; the rule and the padding make a number belong to its label).
    A 0 is in `--ink-3`; shown when any is above 0; the tooltip keeps `cr=498 cu=0
    p=496`. Then `cpu 5.17 ms` (only where it is not all of the duration) and
    the notes (`hard parse`, `cached` / `closed`, the waiting share) as before.
    The widths are what lets the hot FETCH of `io_waits.trc` (every group and the
    waiting share) fit a 1280 px window with the side panel closed. (Round 1
    and 2 had one run of text, `5.17 ms cpu · 1 row · 498 gets · 496 reads`, and
    said "fixed slots for them inside Detail were tried and rejected: they spread
    the row out and pushed the notes to the middle". That was one slot per value
    with the notes after them; the groups are three slots and one box, rows
    apart from the gets because the rows answer another question than the I/O,
    and the user asked for gets that read as a group and line up down a run of
    FETCH rows. `gets` (cr + cu) is gone: it hid whether the reads were current
    mode, and tkprof prints the three.)

- **Round 3, batch 2 (decided 2026-11-07): the SQL band.** The CURSOR row stays
  the head of a statement (`c7ry5gr75qv4b  SELECT · user 0 · 124 chars`); the SQL
  text lines under it are a band of the same family as a plan table: from the
  Operation column to the right edge (through Clock), inset 1 digit each side, on
  `--surface-sunken` in a 1 px `--hairline` frame (the first text line opens it,
  the last closes it), the Operation cell empty, the text where Detail starts, in
  the row font and size, with the keyword, literal, bind and comment colours as
  before (`.lv-tbl` / `TableBand` with `sql`; the plan's `.lv-tbl` rules are its
  rules). The top and bottom rules of the SQL band are inset shadows, not borders,
  so the band is exactly as tall as its lines and its first line is not pushed
  down. A band is known globally, like every fold: `api/lines/blocks?what=frame`
  also answers `texts`, `[first text line, last text line, statement id]` for each
  statement that ends with an END OF STMT line (`frameBlocks` in `lines_blocks.go`;
  a client guess from the frame ranges alone cannot tell a rule from an END OF
  STMT, and `nasty_sql.trc` has an END OF STMT inside a text: a statement whose
  model text is not those lines line for line is left out, so it keeps its rows),
  and the statement's whole text is `doc.statements[id].text`, so nothing is
  loaded to draw a band. An engine without `texts` leaves the lines as rows.
  - **Wrap off:** one row per trace line of the text, cut at the right edge
    (ellipsis), as before but in the band.
  - **Wrap on** (the View menu's "Wrap long lines", `prefs.wrap`, which the
    formatted view ignored until now; the raw view's wrap is unchanged): the text
    lines after the first fold quietly into the first, together with the END OF
    STMT line (`Fold.sql`, made by `frameFolds` when it is given the bands; a
    one-line text folds the END OF STMT line under it all the same), and that one
    row grows to the statement pretty-printed in full, a line longer than the band
    wrapping onto the next (`pre-wrap`, `overflow-wrap: anywhere`). Only the SQL
    band grows: every other formatted row stays one 20 px line. A go-to, search
    hit or `Shift` span into a folded text line lands on the band's row (the
    selection highlights the whole band) and does not open the fold; `z` on the
    band shows the trace's own lines as rows (each a row of the band, as with wrap
    off) and `z` on one of them folds it again; copy (`y`) reads the lines by
    number from the pages, so it copies the trace's own text, the folded lines
    included.
  - **Pretty-printing** is `sql-formatter` (`data/sqlformat.ts`: `formatDialect`
    with the `plsql` dialect only, so a bundler keeps just that dialect's tables;
    keyword case preserved, 2-space indent, no blank line between the statements
    of a PL/SQL block, which the default put between every `;`). It is a
    dependency of the shared lib (`web/package.json`; the desktop resolves it
    from the lib's own `node_modules`, as it does echarts). Why a library: a
    hand-made pretty printer is the kind of code that is wrong on one statement in
    fifty, and the formatter's plsql dialect reads Oracle's placeholders, hints
    and PL/SQL. On a throw (an unterminated literal) or for a text over 20,000
    characters the text is the trace's own, memoised per text in a 64-entry LRU.
    The CLI UI bundle grew by 68 kB (1,773.79 to 1,841.84 kB, 18 kB gzipped; see
    the plan's Log). Rejected: formatting the text of the trace's lines one by one
    (a statement is one thing); a scroll box inside a fixed-height row (the band
    would hide the statement it is there to show).
  - **A tall row among 20 px rows.** The viewer's arithmetic is a grid of equal
    rows (`ROW_H`): the scroll bar, the keys, a go-to and the folds count rows, and
    a band is one row among them, so none of that changed and the scroll bar does
    not jump with the width. Only the pixel position knows heights, and only while
    a tall row is among the rendered ones: the layer is placed from the rows'
    measured boxes (`offsetOf`, placed again after every commit, since a page
    arriving or a resize changes a band), the wheel moves by pixels (a band is read
    at the speed of the wheel, not flown past in one notch), a reveal worked out
    on the grid is checked against the real heights when a tall row lies between
    the top of the view and the target (`settle`: a row below a tall one is
    further down than its index says; a tall row is shown from its top; the top
    edge stays on a line's edge, so no sliver of a row shows under the sticky lane
    row), and at the end of the file the last band can be scrolled to its end
    (`tailTop`). A view without a tall row takes none of these paths: it is the
    grid, as before. The sticky lane row and the plan's head overlay are laid over
    the top 20 px whatever is under them. (The raw view's wrap mode has no such
    handling: its rows grow and the grid arithmetic is simply wrong below the
    first tall one; it was not a precedent to copy.) Rejected: a band as that many 20 px slots in the fold index (the
    number of lines depends on the width and on the formatter, for every statement
    of the file, before any of them is drawn).

- **Rejected in round 2** (so they are not tried again): a sticky three-line
  lane label box (sql_id, SQL start, time here) in the Statement column: it
  keeps a wide column that is empty on every row but the first two of a lane
  and lies over three rows of data, where one overlay row says the same; the
  row tint for the highlight (above); Δ over a linear bar (above); a client
  guess of the framing lines from the cursor line (the engine lists them);
  inline binds by value length (by count; see above); folding every blank line
  (a pass over the whole raw file for a handful of rows); the Highlighting chip
  beside the overview chip (two chips for one thing).

- **Rejected in round 3** (batch 1): the absolute log scale of the Duration bar
  (Time, above); a tick at 1 % only on the hot rows or only in the header (the
  tick on every track is what makes a bar read against the rule); `gets` as the
  sum of cr and cu (above).

## Project

- Repository `davidbudac/modern-tkprof` is private for now; pushed after each
  milestone; licence Apache-2.0 (`LICENSE`, added 2026-10-24); publishing is a
  separate decision.
- CI and releases run locally (`scripts/ci-local.sh`, `scripts/release-local.sh`);
  GitHub Actions is not used, by the owner's decision (cost). The scripts
  mirror the former workflow: vet, tests (golden and engine contract
  included), web build, embedded-UI check, `make release`; the release script
  needs a clean tree at the tag and uploads with `gh release create`.
- Release artifacts (decided 2026-10-25): one full binary per platform (with
  the pure-Go Oracle driver, ~27 MB) plus `mtkprof-lite-<os>-<arch>` built
  with `-tags nooracle` (~12 MB) for linux, aix and solaris, the database
  hosts where the trace files are local and the db commands are not needed.
  The desktop sidecar is always the full build.
- Every feature lands with unit or golden tests; UI work is verified with
  screenshots; commits go to main with concise messages. The user sets scope
  and priorities; implementation details are the implementer's, reported
  briefly.
- Milestone order: (1) text-report parity, findings, bind redaction;
  (2) plan JSON and "Open in plan viz"; (3) ref bundle; (4) file sets and PX
  merge; (5) memory and size work for 1 GB traces; (6) comparison.
