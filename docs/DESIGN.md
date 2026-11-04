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
  e.g. the PX slaves' lines in the coordinator's dump) has no ghost.
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
  themselves. Consequences: `control file sequential read` counts (its p1 is
  a control file number), gc cr/current block 2-way do not (no parameter
  names in V$EVENT_NAME).
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

## Readable Lines view (decided 2026-11-04, mock-up `docs/mockups/readable-lines/`)

- **Readable is a layout, not only values.** The `raw | readable` toggle of the
  Trace view (`v`) now parses every line into columns: line number (with a
  pin), the cursor's lane, what the line is (EXEC, WAIT, PLAN, Bind#3, …), its
  detail, a time bar, Δ and the wall clock on the right. It stays one row per
  trace line inside the same virtualised viewer, so line numbers, search,
  bookmarks, folds, the side panel and every key keep working; the detail is
  cut where it does not fit (the hover card and the Line tab have the rest).
- **Lanes.** Consecutive lines of one cursor are one lane: a band in the
  statement's colour, the sql_id on its first row and the SQL's start on the
  second. The real cursor# is only in the tooltip (a 10046 trace has no
  child number, so none is shown). Statements take the categorical colours
  (`blocklayout.CATEGORICAL`) by elapsed rank; recursive SYS SQL (uid 0 below
  the top level) and statements past the 14th are neutral. Framing lines
  (blank, `***`, `=====`) inside a stretch stay in its lane.
- **Time.** Δ is the time from the pinned line (`a`, or the pin in the line
  number), else from the line with a time before; the pin also anchors the raw
  view's delta column. Bars are linear on one scale per file (full = the
  file's longest call or wait); a call's CPU part is the solid end. A line of
  1 % of the file's traced time or more is a hot spot: tinted, marked on the
  density strip, `j` / `J` step through them (`api/lines/hot`).
- **`SQL*Net message from client` keeps its name** and counts like any wait
  (an earlier "client think time" label was rejected).
- **Fold repeats is a toggle, off by default** (`r`): runs of 3+ identical
  waits, wait blocks still longer than 10 items after that, loops of 6+ small
  fetches (each under 1 % of the time) fold into one line each, computed by
  the engine over the whole file (`api/lines/repeats`) so the scroll bar does
  not jump as pages load. A fold of repeats opens with its handle and stays
  open; the user's own folds win where they overlap.
- **As run.** A BINDS row offers the statement with the values in place of
  its placeholders (side panel tab "As run"): SQL placeholders pair with the
  `Bind#`s by occurrence, PL/SQL ones by distinct name (decided by the
  counts); a bind without a definition of its own repeats its name's first
  value; NULL, dumps and missing values are said; a value Oracle cut is
  marked "truncated in the trace" and never completed. Previous / next walk
  the statement's executions in the file, not only the cursor's.
- **Pulse while switching.** Toggling readable or Fold repeats pulses the rows
  (an opacity animation, which the compositor keeps running while the main
  thread works) until the new rows are painted or the folds arrive;
  reduced motion dims instead.

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
