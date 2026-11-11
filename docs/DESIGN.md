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

- Oracle 19c and later, event 10046 / `sql_trace` / `DBMS_MONITOR`. Optimizer
  traces (event 10053) are an input since 2026-11-11, read by the 10053
  reader (§ The 10053 reader, below); still no ASH or AWR inputs. 19c, 21c (XE) and 23ai (Free) are tested
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
  hatch). `serve`: the same UI from a local server. The Overview opens with a
  masthead (decided 2026-11-08): **Time in trace** (the scope's response time,
  below; named for what it is, since it includes the idle time between calls,
  not "response time", which reads as time a user waited), then When (the
  scope's wall clock in the trace's time zone; the window's when one is set),
  Database (name · PDB, release, instance on host, a role other than PRIMARY),
  Session (session id or count, client driver, service, PX slaves, client id)
  and Module (module or count, actions), all following the file / session /
  window scope (`web/src/lib/data/traceinfo.ts`). It then answers
  "where did the time go": the statement concentration (top k = 80%),
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
  One exception, decided 2026-11-11: the guide of the 10053 view (§ The 10053
  reader) holds fixed explanations of what a section or a line of an optimizer
  trace is, each backed by a named source; it has no sentence about the
  decisions of a particular trace.
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
  wall-clock span is shown beside it ("wall 3.849 s"). The Overview heading
  calls this number "Time in trace"; the ledger and the shares keep the term
  response time.
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

**Pasted names (decided 2026-11-08).** The spooling script needs `ref/` and
`ref/plans/` made beforehand and a directory handed back; a user who only
wants the objects named should not need that or a database connection.
`refscript -paste` writes a *names script*: one read-only PL/SQL block that
prints tagged CSV lines through DBMS_OUTPUT (any client: SQL*Plus, SQLcl, SQL
Developer), reads the ALL_ views by itself where the DBA_ views are not
readable (so there is no `-lite` for it) and leaves plans out unless asked
(`-plans`; they make the output long). The app's *Import names* dialog hands
out the script and takes the copied output; the reader ignores every
untagged line, so the whole output is pasted as it is. A paste is merged into
the trace's kept bundle rather than replacing it (names pasted later must not
drop plans fetched earlier); a directory or database fetch still replaces.
Parsing and applying stay in Go (the engine): one reader for the app, `-ref
file` and the tests; the browser only counts tagged lines to say what it
found. The CLI's `serve` and the standalone HTML do not take pastes; their
views point to `-ref`.

## Deferred to v2

Comparison mode; raw trace line viewer (serve mode only); DBMS_XPLAN overlay
via the shared package (the core's `dbmsXplanParser` is vendored, not wired up yet); configurable finding thresholds. (Server-side slicing
in `serve` is done: see Inputs.)

## Desktop app (decided 2026-10-25)

Plan, protocol and the full decision log: `docs/PLAN-DESKTOP.md`.

- Internal team tool for Windows, macOS and Linux (all first-class); private,
  unsigned GitHub releases. Traces of 1–2 GB are the ceiling.
- Updates (decided 2026-11-08, replacing "no updater"; narrowed 2026-11-09
  with the Electron shell): the app asks GitHub for the newest release on every
  start (setting, on by default) and, when it is newer, offers *Download*,
  which opens that release's page. It does not install in place: the Tauri
  updater's signed install (minisign, `latest.json`, `requireSignedVersion`)
  has no Electron replacement yet. electron-updater was not taken: on macOS it
  needs a code-signed app (Squirrel.Mac) and it checks hashes, not a signature
  of ours. An in-place install with the same guarantees (a signature over the
  artifact and its version, verified in the main process) is open. OS code
  signing stays out of scope.
- The Tauri bridge (2026-11-09): installs of v0.6.0 and older keep their own
  updater, which reads `latest.json` of the newest release. So every release
  also ships the Electron app in the shapes that updater installs, signed with
  the same minisign key and bound to the version (`scripts/tauri-bridge.mjs`;
  `release-local.sh` refuses without the key): the `.app.tar.gz` on macOS (it
  swaps the bundle and relaunches through LaunchServices; tried end to end from
  0.6.0 on arm64), the AppImage and the `.deb` (package `mtkprof` in both
  shells, so dpkg upgrades it). Windows only with `--with-windows` once tried
  there: its installer removes the Tauri install first (`build/installer.nsh`).
  Kept until no Tauri install is left to update; then `latest.json` goes.
- The Go core is the engine: `mtkprof engine` runs locally as a sidecar
  process, holds N open traces, always builds in aggregate + spill mode, and
  keeps the spill directory as a persistent index cache (user cache dir,
  20 GB LRU) keyed by trace content identity. No Rust rewrite of the parser
  or model; no remote-engine mode; no LOD tiles (a 1024-bucket minimap in the
  document instead).
- The shell is Electron (TypeScript main process) around the React/TS UI
  (2026-11-09, replacing Tauri 2; the last Tauri commit is tag `tauri-final`). Why: one language for the
  shell and the UI, the same Chromium on every platform instead of WKWebView,
  WebKitGTK and WebView2 (the Linux leg needed webkit workarounds, the macOS
  webview its own keyboard and accessibility checks), and a shell any
  contributor of the UI can change. Cost: ~100 MB more per installer and
  Chromium's memory. What stayed: the engine as a sidecar with its token in
  the environment, stdin held, the ready line, restart with backoff; the page
  has no Node (`contextIsolation`, `sandbox`, one `window.mtkprof` bridge);
  a remembered assistant key never enters the page (safeStorage in the main
  process, which answers the engine's prompt itself); the UI's origin is
  `mtkprof://app`, the engine's CORS allows exactly that; data, cache and log
  dirs keep the Tauri paths, so settings, tabs, notes, connections and the
  index cache carry over. Keys the Tauri app remembered in the macOS keychain
  are taken over once (macOS asks to allow it); on Windows and Linux they are
  asked for once more. GPUI is not revisited.
- The page is trusted less than the main process (it shows trace text and
  assistant replies), so the main process grants it least privilege (2026-11-09,
  after a review of the shell): it reads dialog picks and the team file (whose
  path the main process keeps); it writes save-dialog picks (once each) and the
  cache folders `reports` and `cuts`, by file type; it opens with the system
  only reports this run wrote; stores are an exact list of names; engine
  options are checked, and the engine deletes only names it creates in its
  cache. Packaged builds set Electron's fuses (no run-as-node, `NODE_OPTIONS`
  or inspector; the UI only from the integrity-checked `app.asar`), refuse
  remote debugging, grant only clipboard writes and keep a strict CSP.
- Electron is kept current: a Chromium security fix reaches users only through
  an Electron upgrade, and only the newest three majors get fixes (a major every
  eight weeks). `desktop/scripts/release-local.sh` refuses a release whose
  Electron major is older than that; upgrade, smoke, release.
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
- **No chord for Blocks** (superseded 2026-11-08: the I/O map is ⌘I, below):
  digits 0 to 9 are taken and renumbering breaks muscle memory and the
  assistant's `mtkprof:` links, so `SessionViewDef.key` is optional; a row
  without a key has no chord and no hint, ⌥⌘← / ⌥⌘→ (Ctrl+PageUp / PageDown)
  still step through it.
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
  if sampled pictures turn out to hide re-reads (built 2026-11-08: the density
  layer, § The I/O map: density and hot blocks).
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

## The I/O map (decided 2026-11-08, `docs/PLAN-IOMAP.md`)

The Blocks view, round 2, after the user's notes (axes, zoom, a name, a
shortcut, object names, colour modes, more ways to look).

- **Named "I/O map", reached with ⌘I** (Ctrl+I elsewhere). The view keeps its
  id `blocks` (links, `workspace.json`, the `mtkprof.blocks.*` settings).
  `SessionViewDef.key` is a digit or a lower-case letter; letters match
  `KeyboardEvent.code` (any keyboard layout) and never fire from a text field
  (⌘I can mean italic there). The digits stay as they were.
- **Full-bleed like the Trace pane**: one toolbar row (I/O order | Time,
  Colour, Panels, the filter chips, zoom out / in / Reset, Display, the side
  panel), a status row (counts, the zoom, how to zoom), the figure, and a side
  panel with the Trace pane's icon tabs (Objects, Statements, Distributions,
  Display).
- **The zoom is the view's own stack** (`State.ioZoom`, like `lanesZoom`): a
  time range plus block ranges per panel. A drag no longer sets the global
  time window; "Use as time window" does. The shape of a drag decides what it
  zooms (sideways: time; up or down: that panel's blocks; diagonal: both), as
  common chart tools do. Out: ‹ Out, `−`, a double-click; Reset: `0`; in: `+`,
  ⌘/Ctrl + wheel at the pointer; ← → pan. A navigator strip shows the whole
  range's I/O over time with the zoom as a box (drag to pan). A zoom is
  re-queried after 200 ms of rest; the previous answer's rows inside it are
  drawn meanwhile. A new global window, a link into the view or another trace
  clears the stack. No engine change: `/api/io/map` with the zoom as the
  window.
- **Axes are titled** ("block #" in each panel's gutter; the x title under the
  ticks says I/O order or time and what the numbers count).
- **Object names**: the reference bundle, else the trace's own STAT lines
  (`obj=` and the name in `op`, a type TABLE / INDEX / … read off the
  operation), else `obj# N` (`data/objnames.ts`). Options (persisted): schema,
  PDB (the container of the wait's session, named by the 12.2+ timestamp
  lines' `PDB1(3)`), partition, obj#. The qualifiers are grey.
- **Colour by** event, object, object type, schema, tablespace, file,
  statement, session, latency, read size. Latency and read size are six-step
  ramps (`--bm-lat-*`, `--bm-size-*`; the strong end is the slow or big one in
  both themes). The legend's entries are buttons: a click keeps only that
  colour bright (others at 12 %), ⌘/Ctrl/Shift-click adds one, hover previews.
- **Panels per file or per object**; a block axis is linear or **packed** (the
  touched runs, gaps under 1 % of the span closed, at most 40 runs, short runs
  raised to 6 px, a block never taller than 3 px; panels per object always
  pack). Temp waits get a panel per tempfile, waits without an object one per
  file, objects beyond the twelfth share "other objects".
- **Side panel numbers** count the rows drawn (≈ × k when sampled; superseded
  2026-11-08 for Objects and Statements, which count every wait when the engine's
  `/api/io/hot` answers, § The I/O map: density and hot blocks): per object
  waits, time, blocks, distinct blocks, re-reads per block, average latency
  and the share of waits that continue the previous one within 64 blocks
  ("sequential"); per statement the former facts column; latency histograms
  (powers of two of µs) with p50 / p95 / p99 and blocks per wait per event.
- **An aggregation-only model names what its waits named** (2026-11-08): the
  engine's sessions keep no waits, so `ApplyRef` and the reference queries
  only saw the plans' obj# and no datafile at all. `analyze.Accumulator`
  keeps the waits' obj# and file# (`RefIDs`, `model.RefIDSource`,
  `Model.WaitRefIDs`); agg format 4, `CacheIndexFormat` 6.

## The I/O map: density and hot blocks (decided 2026-11-08, `docs/PLAN-IOMAP-2.md`)

Above the marks limit the I/O map draws every k-th wait, and a sample hides what a
DBA looks for (blocks read over and over, bursts, the density of a scan); its side
panel counted the sample (distinct blocks of every k-th wait are not the trace's).

- **Three answers over every matching wait**, on the scope of `/api/io/map`:
  `/api/io/density` (the waits counted into the cells of the client's layout),
  `/api/io/hot` (block reads per block: the hottest runs, the exact per-object and
  per-statement numbers), and `/api/io/map?reads=1` (each row's reads, for a colour
  mode). Added routes and an optional field: no protocol bump, no cache format change.
- **The density follows the client's layout, not a grid of its own.** The request is
  the order axis' slots (match indices: row slots × the sampling step) or the time
  domain, and each panel's y segments (linear or packed), at about 4 px a cell; the
  panel key selects the waits as the view's panels do (`f`, `o`, `t`, `n`, `rest`).
  A wait counts in every y cell its blocks touch (waits, blocks in the cell, µs by that
  share of its blocks); x is its index or its midpoint (clamped). An answer places its
  cells by the block and order (or time) ranges it covers, so it stays right under a
  resize, and on the time axis across a zoom; on the order axis only for its own scope.
- **Drawn under the marks**, in each panel's canvas after the grid and the extent
  bands: one slate hue (`--bm-dens`), alpha = 0.1 + 0.78 f, f = √(v / max) (default) or
  log(1 + v) / log(1 + max) against the largest cell of every panel. Toolbar *Density*:
  auto (default: on while the marks are a sample), on, off; Display: what a cell counts
  (waits, blocks, time), the scale, and *Marks* off to see the density alone. A legend
  bar names the largest cell; where no mark is under the pointer the cell's tooltip says
  its waits, blocks, time, dominant event and share, block range and order or time range.
- **Counting blocks: exact while it fits, bounded always, honest when not.** A block's
  first read only marks it in a seen set of 65,536-block chunks (a sorted array of
  offsets up to 1,024, then an 8 KB bitmap: a scan costs about a bit per block); a block
  read again gets a counter; above 1,000,000 counters a Misra-Gries prune (subtract the
  (cap/2 + 1)-th largest from all, the sum `dec` bounds every count's error). The
  65,536 most read blocks become runs of adjacent blocks recounted exactly in a second
  pass, so every number shown is exact; `exact` is false and `bound` (a block in no run
  was read at most that often) is shown when the prune ran or more blocks were re-read
  than are recounted. The seen set (64 MB) and the objects' / statements' distinct sets
  (32 MB) have separate caps: the second only makes distinct counts approximate. A
  generated 214 M distinct blocks: exact, 0.4 s, 98 MB peak heap.
- **A wait moves at most 65,536 blocks** in these routes (`MaxWaitBlocks`): a larger p3
  is a corrupt line. Files below 0 or from 2^31 and blocks from 2^32 are not counted.
- **Runs rank by Σ re-reads** (the reads a big enough cache would have saved: a spill
  read 20 times outranks one hot index block), or by the most reads of one block, or by
  time. A run's time is each read's ela × its share of the read's blocks; objects come
  from non-temp reads only (a temp read's obj# is the statement's object).
- **Hot blocks is a side-panel tab**; a click highlights the run's marks (a `blocks`
  focus) and zooms that panel's blocks to the run with as much context again on each
  side (at least 8 blocks), keeping the time zoom, and scrolls the panel into view.
- **Objects and Statements use the exact numbers** when `/api/io/hot` answered for the
  same scope ("Exact"; distinct = blocks read), the sample's otherwise (≈ × k).
- **Colour by re-reads**: the reads of the mark's most read block in scope, six steps
  (once, 2, 3–4, 5–8, 9–16, 17+) on `--bm-rr-*` (once is a receding grey). The map is
  asked with `reads=1` only in this mode.
- **Twins**: `ioDensityOf`, `ioHotOf`, `ioMapOf(…, { reads })` and `BlockSet` /
  `BlockCounter` model the Go byte sizes exactly, so caps stop at the same wait; one
  shared case, `ioblocks-case.json`, includes pruned and capped answers.

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
  the top level) and statements past the 14th are neutral. (Round 3b, batch 4
  reversed that: in the Trace pane only a **highlighted** statement has a colour,
  see "The highlight set" below; every other lane band is a neutral grey.)
  Framing lines (blank, `***`, `=====`) inside a stretch stay in its lane.

- **The highlighted statement is a lane highlight, not a row tint** (round 2;
  round 3b below reverses the row-tint half of it). The highlighted statement's
  lane shows in its own colour (`--hl`) in the Statement cell of every row of the
  lane (BINDS, PLAN and blank rows too) at 14 %, the band widens from 4 to 6 px, and
  the number cell keeps a 3 px start bar on its calls and waits. The band keeps
  the colour the colour-by mode gives it (the tint stays the statement's), and a
  selected row drops the lane tint (blue over amber read grey). Round 2 left the
  rows themselves on the surface. (Round 1 tinted the rows of the statement's
  marks at 10 % in its colour; rejected in round 2: a flat wash over every call
  and wait reads as a selection, the stripes where BINDS and PLAN rows are not
  filled read as noise, it hides the hot spot, it stops at the 1,000-wait cap
  while the calls go on, and the band mixed toward ink drew orange as maroon.)

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
  column is text only (the Display tab's Δ column checkbox and the palette hide it, pref
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

- **The toolbar never wraps from 1100 px.** One row (round 3 shortened it: see
  "Round 3, batch 3" below for what it holds now): the search shrinks first (down
  to 14 ch, its Options button never breaks into letters), then the labels fold
  to icons in four steps by container queries (the Go-to label at 98 rem
  (1568 px); the window group's words and the Δ chip's mode and count at 89 rem;
  the Hot spot, Δ-from and Display labels at 73 rem; the Raw / Formatted text at
  67 rem). The thresholds are measured in the worst case, a formatted bar with
  everything on (the Δ chip with a count of 100,000+, the pin, the time window
  group, the file select at its least width, the search at 14 ch): 1538 px of
  bar with all labels, 1400 without the first step, 1140 without two, 1042
  without three, 909 without all four, plus 20 to 30 px each for longer counts;
  with only the Δ chip and the pin (one file, no window) 1133, 996, 894, 796,
  663, and with nothing on 947, 810, 810, 712, 579. So from 1100 px the row is one
  line whatever is on (the round-2 bar needed 1362 px with the same labels and
  no window or file select). It wraps below 51 rem (816 px), and below 58 rem
  (928 px) when the window group or the file select is there. Pressed toggles
  use the quiet style (ink on `--wash`); only Raw | Formatted keeps a solid
  segment.
- **The Highlighting chip is the statement picker.** The raw view has no overview
  bar and keeps its toolbar `Highlighting ■ sql_id · N calls · M waits ×` chip
  (a state chip, below); the formatted view's highlighted statement is the
  picker button of the overview row (round 3, below).
- **The overview row.** At its left the **statement picker** (round 3), then a
  12 px track, a thin time axis under it (round wall-clock times; `+2 s`
  offsets for a trace without a wall clock) and a **viewport bracket** (two
  1 px ticks and a 20 % wash) that follows the visible rows. The track shows
  when the 8 statements with the most time ran, and the highlighted statement
  on top of them even when it is a small one (a statement picked from a list of
  thousands usually is; its stretches get a 1 px ink outline); a stretch names
  its statement when hovered (`sql_id · 2.486 s · 38 % of the traced time in this
  file`), a click on the track goes to the line at that time. Batch 4: only the
  highlighted statements are in colour (each outlined); the others' stretches are
  two greys, alternating by rank, and the numbers are the file's. (Round 2 labelled the bar
  `Where the time went · 6.46 s` in a 210 px slot at the left and listed the
  statements as chips under it; round 3 dropped the words, which said nothing the
  bar does not: the span is in the track's `aria-label` and the axis, and then
  the chips, below.) The picker's column keeps one width, `clamp(14rem, 24 %,
  25rem)`, with or without a highlighted statement, so the track does not move
  under the pointer when one is picked (sized to the content, the track would
  jump by 200 px; the 210 px slot of round 2 was an empty hole beside the bar, a
  control that fills its column is not).

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
- **Fold repeats is a checkbox of the Display tab** (round 3). It was a text
  button, then an icon (2026-11-06, at the user's request: three rows gathered
  by a brace, the name in its tooltip), both in the toolbar; set once and left,
  it moved to the side panel with the other settings (batch 3, below). Its key
  and palette command are as they were.
- **Colour the lanes by** (decided 2026-11-06; since round 3 a radio list in the
  Display tab, formatted view only, the lanes are its) picks what the lane band
  shows: Statement (the default, as before), Execution (the executions of a
  cursor in turn), Session (the context: session, module, action), Recursive
  depth, Operation (PARSE, EXEC, FETCH, CLOSE, WAIT, cursor parse, binds,
  commit, error), Wait class (calls are CPU), Duration and Δ from the line
  before (one orange ramp by decade: < 100 µs … ≥ 1 s), None. The list has a
  key (what the colours mean) for every mode but Statement (the picker names
  those). The
  sql_id in the lane keeps its statement's colour whatever the band shows, and
  a line outside a lane (WAIT #0, a commit) gets a band of its own in the
  per-line modes. Pref `laneColor`.
- **Δ filter** (decided 2026-11-06; since round 3 in the Display tab, with a
  state chip in the toolbar while it is on): `Δ ≥ N ms`, both views,
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
  by default) and `deltaMode`. The chip is `Δ ≥ 10 ms · filter · 34` (the count
  of rows that reach the threshold once the engine has answered, `+` when the
  list is cut) with a × that turns it off; a click on it opens the Display tab.
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
  - **Wrap on** (the Display tab's "Wrap long lines", `prefs.wrap`, which the
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

- **Round 3, batch 3 (decided 2026-11-07): the controls of the pane.** The user's
  two notes: the row of sql_id chips "will get crowded very quickly on a large sql
  trace", and the pane "is extremely busy" (settings to a collapsible right-hand
  panel, judgement calls left to us).
  - **The rule for the toolbar.** It keeps what is used while reading (the view
    switch, finding, stepping, going to) and says which settings are on; a setting
    that is chosen once and left (how the lanes are coloured, whether repeats fold,
    which columns and extras show, the line colours, the Δ filter's threshold)
    lives in the side panel. What moved, and where it is now:

    | was in the toolbar | is now |
    |---|---|
    | Colour menu | Display tab, "Colour the lanes by" (radio list and its key) |
    | Fold repeats icon | Display tab, "Rows": a checkbox (`r`) |
    | Δ toggle | Display tab, "Rows": the Δ column checkbox |
    | Δ filter menu | Display tab, "Δ filter" (threshold, Off / Highlight / Filter, the count), and a state chip while it is on |
    | View menu | Display tab: "Show" (wrap, heat bars, line map (was: density strip), links, hints, clock, delta, gap ticks), "Line colours · tick to dim", "Folds"; a badge on the Display button |
    | (the legend lived in the Colour menu and in the tooltips) | Display tab, "Key": what a red row, the Duration bar, an amber Δ and the lane highlight mean, with this file's numbers (`780 ms` is 1 % of its traced time) |

    The toolbar after: Raw | Formatted, the search with its Options menu, Hot spot
    ↑ ↓, Step, Go to ⌘K, the input-file select (more than one file), the state
    chips, Display, Side panel. Each of those is either an act of reading (a
    move, a search, a jump, the view switch, which file) or the way into the
    settings; none of them is a preference to set and forget. Their keys and
    palette commands are unchanged (`h`, `n`, `r`, `l`, `z`, `Z`, `t`, `T`,
    "Colour the lanes by: …", "Δ filter: …", every View command); the panel's own
    tabs are palette commands too ("Side panel: Display").
  - **Display is a tab of the side panel, not another popover.** A settings pane
    is used while the rows change under it (tick Hints, look; pick a lane colour,
    look); a menu covers the rows or closes after each click. The panel already
    has a width, a resize handle and an open / closed preference, and the Line tab
    set the grammar: sections split by hairlines. The pane is a calm list of real
    form controls with their labels (checkboxes, radios, number inputs, a key at
    the end of a row that has one), not menu items (batch 5 made the on / off settings icon toggles: below); the formatted view's own
    settings (lanes, Fold repeats, the Δ column, the Key) are absent in the raw
    view. The sliders button of the toolbar opens the panel on Display and closes it
    when it is already there; the Side panel button closes an open panel and opens a
    closed one on the last tab that was not Display (`panelAfter` in
    `data/display.ts`, the one rule for the buttons, the keys and the palette), so
    the line, the hits and the bookmarks keep their button. Six tabs and a hit count
    (`Hits 8,744`) fit the 400 px panel because the tabs' padding is 6 px (12 before:
    the labels were cut to `Bookm…`; with 8 px a hit count still cut them). The badge on the Display button counts the Show settings, the gap ticks'
    threshold and the dimmed line groups that differ from the defaults; the Δ filter
    has its own chip, and the lane colours, Fold repeats and the Δ column show in
    the rows.
  - **State chips** appear in the toolbar only while the setting is not its default:
    the Δ filter (`Δ ≥ 10 ms · filter · 34`, a × that turns it off, a click that
    opens Display; the mode and count fold away first when the bar narrows), the pin
    (`Δ from line 118 ×`), the statement filter (batch 4: `Filter: 2 statements ×`), the time window group and, in the raw view, the
    Highlighting chip. A reader sees what is changing the rows without opening
    anything.
  - **The statement picker** replaces the chips row. One button in the overview
    row's left slot. With a statement highlighted it shows its swatch, the sql_id in
    the lane colour, `638 ms · 10 %`, the real counts `5 calls · 34 waits` and a ×
    that stops the highlight, outlined in the statement's colour as its chip was;
    with none it says `Highlight a statement` (muted) and ▾. It opens a popover: a
    filter box (sql_id or SQL text, case-insensitive, whitespace in what is typed
    matches any whitespace of the text, the match marked, and when it lies beyond the
    start of the SQL the row shows the text around it), the column names, and the
    file's statements by time here, longest first: swatch, sql_id, time, share,
    executions and the start of the SQL in `--ink-3`. `None` leads the list while a
    statement is highlighted. The list is virtualised (`@tanstack/react-virtual`, as
    the hit list is; a SQLT trace has 1,463 statements: 38 ms to open, 33 ms a
    keystroke with 26 rows in the DOM) and takes ↑ ↓ PgUp PgDn, Enter and Esc; the
    filter box has the focus and Esc or a choice gives it back to where it was.
    Picking a statement highlights it and goes to its first line in this file (what
    its chip did). It lists the statements that have a cursor in the open file,
    recursive SYS SQL and statements without time included (the chips listed the 8
    longest); "time here" is the statement's elapsed time as the lane row says it.
    `L` (Shift+l, next to `l`, which highlights the selected line's statement) and
    the palette command "Highlight a statement…" open it; both are formatted-view
    only (the raw view has no overview row and keeps its Highlighting chip, `l` and
    the palette's other commands). `L` was free in every key handler of the lib and
    the desktop shell. (Batch 4 made the picker multi-select and took the colours out of
    its rows: "Round 3b, batch 4" below. Picking a statement no longer goes to its
    line by itself; Enter does.)
  - **Rejected in batch 3.** The chips row: it does not scale past about 10
    statements (8 chips and `+n under 1 %`, about 170 px each, and the statement a
    reader wants on a large trace is a small one, among a thousand). A Display
    popover in place of the tab (above). Keeping the Colour menu, the Fold repeats
    icon, the Δ button and the Δ filter menu in the toolbar with their labels
    folded to icons: the state they showed is what the chips and the rows show
    better, and the bar still needed 1362 px. A picker column that takes the width
    of its content (the track would jump 200 px when a statement is picked), and the
    round-2 210 px label slot (an empty hole). The key for the Display tab as a menu
    key (`D`): the button and the palette reach it, and a letter is better kept free.

- **Round 3b, batch 4 (decided 2026-11-07): the highlight set, colour only for what is highlighted, the statement filter.** The user's notes after batches 1 to 3:
  the colour was assigned in the picker already, so there were not enough colours left; the picker should take several statements at once, by keys (Space to
  highlight, `f` to filter) and with a select / deselect all; and a highlight should cover every row of the statement, every cursor of it.
  - **The highlight set.** The Trace pane keeps an ordered set of highlighted statements, per input file (`LinesUi.hl`, `data/hlset.ts`), not the app's single
    `selection.stmt` (which the other views use and which a click on a line still sets). A statement joins the set when it is picked (the picker's row, `l` on the
    selected line, the palette) and when a different one arrives as the app's selection from another view (a deep link or the Statements view: the line clicks of
    this view do not count as an arrival, `ui.hlSeen`); it leaves it by the same toggles, by `None`-style select-all, or with the picker's ×. **Colours:** a
    statement takes the lowest free slot of `blocklayout.CATEGORICAL` (7 hues) when it is added and keeps it while it is in the set, so removing one recolours
    nobody; with more than 7 highlighted the slots repeat, the least used first (`freeSlot`). Only a highlighted statement has a colour: in the Statement lane mode
    every other lane band is a neutral grey (`NEUTRAL_LANE`, `--ink-3` at 38 %), its sql_id in the ink; the overview track draws the others' stretches in two greys
    (alternating by rank, so neighbours separate) and the highlighted ones in their colours (outlined); the picker has a swatch only on highlighted rows. The other
    lane modes (Execution, Session, …) colour the band as before. Scope: the Trace pane; the other views keep `statementTones`' colours.
  - **A highlight covers every line of every cursor.** Every line whose statement is in the set, by the per-line `stmt` id of the annotated pages (`annot=2`,
    `CachedLine.stmt`): the PARSING IN CURSOR block (text and END OF STMT), PARSE / EXEC / FETCH / CLOSE, `WAIT #n`, BINDS and its Bind lines, STAT, ERROR, whatever
    cursor number the lines went by (a statement parsed under several cursors is all of them). It does not depend on the bounded marks (the 5,000 longest calls, the
    first 1,000 waits). The **look**, in both views: a row tint in the statement's colour (8 %, 12 % in the dark theme; `--hl` is set on each row), the Statement
    cell of the formatted view's lane at 14 % over it, and the 3 px start bar in the number cell of its calls and waits. Hot spots, the Δ highlight and the
    selection beat the tint (the rules come later). **Round 2 rejected the row tint; this reverses it, for the reasons that no longer hold:** it stopped at the
    marks' cap while the calls went on (every line is covered now, by id), it left stripes where BINDS and PLAN rows were not filled (they are covered), and a flat
    wash over fourteen lane colours read as noise (only the highlighted statements have colour now, and one or two at a time is a statement, not a wash).
    The engine's `annot=2` ids gave a stmt to every kind of a cursor's lines already, except the text of a failed parse (`PARSE ERROR` line and the SQL under it),
    which took the call before it; fixed in `lines_annot2.go`. Lines that are in no cursor (a blank line, `=====`, `***`) take the previous call's statement, as
    before: in the raw view the `=====` rule above the next CURSOR line is tinted with the statement before it.
  - **The statement filter.** A set beside the highlight set (`LinesUi.filter`): while it is not empty only the lines of the filtered statements' cursors are shown
    and the rest is folded the way the Δ filter's Filter mode folds (a quiet fold under the last kept row with a dashed rule, the lines above the first run
    folded under line 1 with a count, `z` shows a fold). The lines come from the engine for the whole file (`api/lines/stmts`, `fetchStmtUnion`: the lines whose
    per-line statement is one of the ids, as runs), so the folds are global like every fold; the folds replaced the user's, the repeats and the plan tables while it
    was on, as the Δ filter's do (batch 5 composes them instead: "Round 3b, batch 5" below). With the Δ filter on in Filter mode too, the rows shown pass both (`linesInRuns`: the Δ lines inside the runs). A toolbar state chip
    says it (`Filter: 2 statements · 1,204 lines ×`, or the sql_id of one; the funnel icon; a click opens the picker in the formatted view; its pieces fold as the bar
    narrows: the lines at 89 rem, the word `Filter:` at 73 rem, the word `statements` at 67 rem); in the raw view the chip stays (× clears it) and the statement
    list is the formatted view's. **The cursor focus (`f`, dims the rows of the other cursors) and the filter:** they compose (focus dims inside the shown rows),
    and a filter that leaves the focused cursor's statement out clears the focus, since all of its rows would be folded away. An engine without the route answers
    404: the filter turns itself off and the status bar says so. A third key, `F`, toggles the selected line's statement in the filter (the palette: "Filter by the
    line's statement", "Stop filtering by statement").
  - **The picker, multi-select** (`views/StatementPicker.tsx`). Each row has the highlight switch (the statement's colour swatch when on, an empty ring when off) and
    the filter switch (a funnel), then sql_id, time, share, executions and the start of the SQL; the header has two tri-state boxes over those columns (none / some /
    all of the rows *listed*, after the text filter: a click switches all of them on, or all off when they all are on). A click on a row toggles its highlight, a click
    on its funnel its filter, a double-click goes to its first line. **Keys** (`data/pickkeys.ts` `pickerKey`, pure and tested; the filter box keeps the DOM focus the
    whole time and the list is an `aria-activedescendant` listbox, so `mode` says whom a key is for): in the box the keys type, except ↓ (into the list), PgUp / PgDn,
    Enter (go to the first line of the focused statement and close), Tab (kept inside) and Esc; in the list ↑ ↓ PgUp PgDn Home End move, **Space** toggles the
    highlight of the focused statement, **f** its filter, **a** highlights every listed statement (or none, when all are) and **A** (Shift+a) does the same for the filter,
    `/` goes back to the box without typing, any other printable key or Backspace goes back and types; a key footer names them. The popover has no `None` row any
    more (a / the header box / the × do that). The **closed button** says what is on: `Highlight a statement` with nothing; one highlighted statement: swatch, sql_id,
    `638 ms · 10 %`, the real counts `5 calls · 34 waits`; several: their swatches stacked and `3 highlighted`; `2 filtered` (a funnel and the count) beside either;
    the × clears both. It fits the picker's column at 1280 and 1100 px because the button is a container: the counts go to the title below 22 rem of button, the
    time and share below 17 rem, the word `filtered` below 12.5 rem, and nothing is cut. (Fixes batch 3's "looked off" 1.)
  - **A filtered view of far-apart rows.** The viewer loaded the run of pages from the first row in view to the last, and kept 40 pages; a statement filter's rows
    can lie in more pages than that (a statement that ran in every part of a SQLT trace), so the pages were evicted while their rows were on screen, fetched again,
    and the arrival repainted, forever (React's "maximum update depth", found with two filtered statements and the Δ filter at 1 µs on the SQLT trace). `ensurePages` now
    loads the pages that hold a rendered row (not the pages between them) and `PageCache.reserve` grows the cache to hold them (never shrinks); a view of neighbouring
    lines behaves as before (the pages next to it are kept and prefetched).
  - **Toolbar fit with the new chip.** The chip adds 222 px at the two widest label steps and 162, 127 and 64 px at the next ones (its words fold with `.tb-f2`,
    `.tb-f3`, `.tb-f4`), so while it is on the label steps come later (`.lines-row:has(.lines-sstate)`: 112, 103, 83 and 75 rem). Measured with everything on at once (the Δ
    filter's chip at 74,307, the pin, the window group, the file select, two filtered statements) the row is one line, with the search at its least width, at 1100, 1280,
    1440, 1600, 1800 and 2000 px. The cost is that with a filter on the Go-to label folds to `⌘K` below 1792 px and `Raw` / `Formatted` to icons below 1200 px.
  - **Time here is the file's.** The picker's time and share, the overview track's titles and the sticky lane row's `here` / `exec N of M` are the statement's numbers
    inside the open input file (`data/filestmts.ts` `useFileStmts`: the document's own table for a trace of one file, `api/statements` of the file's contexts for a set),
    over the file's own traced time. They used to be the whole set's elapsed time over one file's span, which could pass 100 %. (Fixes "looked off" 3.)
  - **Rejected in batch 4.** Colouring statements when the picker lists them (the palette ran out before the user had chosen anything); a highlight limited to the marks
    (bounded, and calls and waits only); one `None` row as the way to clear many (the header box, `a` and the × are); a separate focus model for the list (the
    box keeps the focus: moving it on ↓ and back on every letter is what loses typed characters).

- **Round 3b, batch 5 (decided 2026-11-07): the line map, icons in the side panel, the statement filter keeps the view's folds, the open list.**
  The user's notes: "the 'minimap' bar on the right side is a bit pointless now; please use it to show the highlighted sql_id lines (where they are)", "in the side
  panel please use icons instead of text for the buttons and options as much as it makes sense", and "address the issues you mentioned".
  - **The strip (the Display tab calls it "Line map") shows where the highlighted statements are.** It lost its density layer (calls and waits, and the error, cursor and
    commit ticks that came from the same `lines/profile` request: the plan did not ask to keep them, and one request fewer is the point). It now draws, over the whole
    file: each highlighted statement's lines in its colour (the centre 10 of its 16 px; two or more statements that have a line in the same pixel row share the width in
    stripes, the first ones of the set when more are present than stripes fit; every mark is 2 px tall so that a statement with one line in a 112,000-line file is still
    seen), the selected line (a 2 px amber bar across the width, the colour of the selected row), the visible range (a box) and the time window as before, and quiet ticks
    at the edges: bookmarks and hot spots at the start edge (3 px wide: a bookmark 3 px tall in the ink, a hot spot 1 px in `--s-critical`), search hits at the end edge
    (`--ink-2`). With nothing highlighted only the ticks and the boxes are there, and a click or drag still moves the view. **Cost:** one binned request
    (`api/lines/stmts?bins=2000`, `fetchStmtBins`) per change of the highlight set, input file or live snapshot, none while nothing is highlighted; the pixel rows
    are computed once per answer and height and kept across the repaints a scroll causes. A live session's next snapshot, a file change and a new set refetch; the old
    answer stays until the new one arrives (statements added since are drawn when it does). The strip is 16 px wide (was 14: the lanes for the ticks are 3 px each).
  - **`m` / `M`, the Step menu's first row and the search scope move to the highlight set.** They stepped between the *bounded marks* (the 5,000 longest calls and the
    first 1,000 waits) of the app's one selected statement. Now `m` / `M` go to the first line of the next / previous **run** of lines of any highlighted statement
    (`data/stmtfilter.ts` `hlStops`: each statement's runs from `api/lines/stmts`, merged, one stop per run start; `hotStep`'s rule, so from the middle of a run `M` goes
    to that run's start). Why runs and not the calls and waits of the set: the route gives them in one cached request however many statements are highlighted, they cover
    every line (BINDS, plan, errors) and are not bounded by a cap; calls and waits of a set would be `stmtMarks` for each statement (a request each, up to 25, each cut at
    5,000 and 1,000). A run is where the statement shows up (usually one execution); `]`, `w` and the other steps still go call by call. The Step menu's row reads
    `highlighted statement · 14 runs`; the palette's commands are "Next highlight" / "Previous highlight"; with nothing highlighted `m` says how to highlight. The search
    scope is "Highlighted statements": the lines between the first and the last line of any of them, and a hit whose page is loaded counts only if its own statement is in
    the set. "Mark its calls and waits" is gone from the line card's Actions menu (it set the app's selected statement); "Highlight its statement" (`l`) is in its first
    group. Opening the tab with a statement selected still starts at the statement, now at its first line in the file (`stmtLineIn`, what the picker's Enter does) and
    not at its first bounded mark. The raw view's Highlighting chip shows the set like the picker's button: the swatches stacked, `3 highlighted`, ×.
  - **Icons in the side panel.** The tabs are six icons (a text cursor, a tree, a magnifier, a bookmark, a play button, sliders), each with a tooltip (`Hits · 8,744: the hits
    of the search`) and an `aria-label`, the active tab in the ink fill every pressed control has; the active tab's **name is the panel's heading** beside them (it goes below
    22 rem of panel), and a count of hits or bookmarks is a small badge on its icon. Six 2 rem icons are 12.4 rem, so the tab strip cannot clip any more (it clipped at
    narrow panels and with a hit count; the 6 px padding of batch 3 was the workaround). In **Display** the Show toggles and the two formatted-view row settings (Fold
    repeats, the Δ column) are a grid of icon toggle buttons: pressed = filled, the name, description and key in the tooltip, and the name and key of the one under the
    pointer or focused in a caption under the grid (the descriptions are long; the caption keeps the grid from being a row of unlabelled glyphs). The Δ filter's Off /
    Highlight / Filter is an icon segmented control (a bar-through circle, a highlighter, the funnel), the bulk folds three icon buttons (a variable `(x)` for BINDS, a
    table for STAT, unfold arrows), the Line tab's Follow (a pointer) and Copy, the Hits tab's group-by (layers), previous / next (chevrons), the bookmarks' note
    (pencil) and remove (bin), As run's previous / next execution and Copy SQL, the recent searches' run again and the panel's close are icons too. **Staying text:**
    the lane colour modes ("Recursive depth", "Δ from the line before": no icon says them), the line colours list (a swatch and its tick), the Δ threshold and gap ticks
    inputs, the key. Every icon button has a tooltip and an `aria-label` (`icon-btn` of the existing style: lucide shapes, `currentColor`, 1.75 stroke, 1 em). Rejected:
    icons with captions under every one (the point was less text); a tooltip-only grid (a name is read one hover at a time, after a delay; the caption costs one line); an icon for each lane mode.
  - **The statement filter keeps the view's folds** (a regression of batch 4: with the filter on, the formatted view's quiet folds were gone inside the kept runs, and the
    END OF STMT rows, blank rows and the bind attribute lines under a BINDS table showed as rows again). The filter's folds replaced every other fold. `composeFilterFolds`
    (`data/folds.ts`) now lays them together by a linear merge: the view's folds that lie in a kept stretch stay as they are (framing, inline binds, bind attribute lines, plan
    tables, the SQL band in wrap mode, Fold repeats if on, the user's folds), the filter only adds the folds between the runs; where the two overlap (a view's fold hides the
    last kept line before a hidden stretch, or its handle is a hidden line and it reaches into the next kept run: the `=====` rule above a cursor, which belongs to the
    cursor's run but folds under the line before it) they are one fold with the filter fold's look, its dashed rule, and an `openKey` (the filter's own handle: opening
    it is remembered under that line, as before). A go-to into a fold of the filter that was opened also opens the view's fold over the line (a bind's attribute lines).
    **The Δ filter had the same problem** wherever one of its folds was opened (a go-to to line 80 of `cursor_cache.trc` showed the END OF STMT row, a blank and four attribute
    lines): it composes with the quiet folds too, and only those, because its kept rows are single lines the repeats' and the user's folds would hide (a wait with a big Δ
    inside a run of identical waits must stay visible).
  - **A call's Detail compacts before it cuts** (1280 px with the panel open left a hot FETCH `631 ms wa…`). The Detail cell of a call row is a container (`rdtx`): the groups
    (exec tag, rows, gets box, CPU) are one clipped block that gives way first and the notes after it (hard parse, the waiting share) are whole, so **the waiting share is cut
    last**. As the cell narrows the groups shrink in steps: below 108 ch the gets' labels are `q` / `cu` / `d` (the tooltip has the words and the trace tokens), below 98 ch
    `cpu` loses its label and the note is `631 ms wait 99 %`, below 88 ch the number slots shrink, below 74 ch the empty exec and rows slots take no width (the alignment down
    consecutive calls goes first), below 56 ch the CPU goes. Measured on `io_waits.trc` line 122: at 1280 px with the panel open the cell is 325 px and the row reads
    `1 row  q 498 cu 0 d 496 · 631 ms wait 99 %` (the CPU is out), whole. (Batch 1 and 2's fixes had got it to fit with the panel closed.)
  - **A tall wrapped SQL band keeps its line number and Operation cell in view.** The viewer's scroll is not the browser's (the layer moves under the view), so
    `position: sticky` has nothing to stick to: the viewer sets `--stick` on a tall row (the distance of the view's top edge, under the sticky lane row, from the row's top,
    at most the row's height less a line) after every placement, and the row's line-number cell and its band's Operation cell take it as top padding. While stuck the
    Operation cell shows a dim `SQL` tag (`--stuck`): the left columns are never blank beside the lines being read.
  - **PL/SQL spacing.** The formatter puts a space before the `(` of a name it does not know as a function (`dbms_application_info.set_action ('x')`). `tightCalls`
    (`data/sqlformat.ts`) takes it out after formatting: strings, quoted identifiers, `q'[…]'` literals and comments are skipped by a scanner and left as they are; a name
    that follows a keyword that makes it an object (`INSERT INTO t (a, b)`, `CREATE TABLE t (`, `JOIN t ON (`) or a keyword before its `(` (`IN (`, `VALUES (`, `AND (`,
    `EXISTS (`, `OVER (`) keeps the space. A list of words, not a parser: a call after one of those words would keep its space.
  - **State chips for Fold repeats and a lane colour other than Statement** (`Repeats folded ×`, `Lanes: Session ×`, each with an icon and a × that turns it off, a click
    opens Display): the settings had no sign with the panel closed. The words fold with the bar (`.tb-f1` for `Repeats folded`, `.tb-f3` for `Lanes`, `.tb-f2` for the
    mode name). The label steps now depend on the number of chips on (`.lines-row:has(.lines-state ~ .lines-state)`: two, three and four chips; measured, `styles/lines.css`):
    with all four on (Δ filter, Fold repeats, lanes, the statement filter) and the pin, the window group and a file select the row is one line with the search at 128 px or
    more from 1280 px, and at its least width (23 px) at 1100 px.
  - **The tint shows on the bands.** A highlighted statement's plan, BINDS and SQL bands are on a sunken ground that hid the row's tint; the band now carries it
    (13 % light, 17 % dark over the ground, a little stronger than the row's) in both themes.
  - **Smaller:** the lane-colour list's "Statement" tooltip no longer says statements are coloured by elapsed rank; the Display key's "marks of the selected statement" row
    went (the marks are not drawn since batch 4).
  - **Rejected in batch 5.** Keeping the density layer behind the highlighted lines (the user called it pointless: calls and waits are everywhere); error ticks from
    `lines/profile` (a second request for something the plan did not list; they can come back from it if wanted); `m` over the calls and waits of the set (above); sticky
    cells by `position: sticky` (no scroll container); composing every fold with the Δ filter (a Δ-kept wait inside a fold of repeats would disappear).

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
  sum of cr and cu (above). Batch 2: formatting the SQL text line by line, a
  scroll box in a fixed-height band (the SQL band, above). Batch 3: the chips row,
  a Display popover, a picker that sizes to its content (the picker, above). Batch 4: statement colours by rank in the pane, the marks-only highlight,
  a `None` row (round 3b, above). Batch 5: the density layer behind the line map, `m` over calls and waits of the set, `position: sticky` for the band's cells, every fold composed with the Δ filter (above).

## Cut (decided 2026-11-06, desktop only)

A new trace file cut from a part of a trace set: a time window, sessions or files, or one
statement; joining the files of a set is the same operation with nothing narrowed (what `trcsess`
does, without its losses). Engine `internal/cut`, routes `api/cut`, `api/cut/check`,
`api/cut/file`; the desktop's **Cut** view (Tools menu), designed from a mock-up drawn on the
real cut of io_waits.trc.

- **Never cut blind.** The unit kept is a call with everything rolled up under it (its recursive
  calls, waits and binds, which the trace writes before the call's own line): whole top-level
  calls overlapping the window in the selected contexts, or the statement's calls (with their
  recursive work; the callers are left out, the calls stay recursive SQL without a parent). A
  window edge inside a call widens to the whole call; *Whole executions* widens to every call of
  a kept call's execution. A unit is the lines after the last call of its process at the same or
  a smaller depth up to its own line; the lines after a process's last kept call go with it.
- **What the kept lines need comes with them**, labelled where it comes from: *borrowed from
  before the cut* (the file header, the session markers in force, the PARSING IN CURSOR block of
  every cursor the kept lines use, restated right before its first use including a BINDS block,
  with `tim=` set to the time of the lines after it so the span does not stretch back; a plan
  dumped earlier), *borrowed from after the cut* (the STAT lines of a cursor that closed after it,
  placed after its last kept call), *generated* (`mtkprof cut:` provenance lines in the header, a
  `***` timestamp wherever the wall-clock anchor would otherwise pair with the wrong `tim`, and
  trcsess's `*** [ Unix process pid: N ]` between processes). A cursor open before tracing started
  and adopted by a later parse is only restated when that parse is left out.
- **The model decides, the text is copied.** Kept calls and waits come from the model and its
  spill (a wait follows its call, not its position); the text pass copies lines and inserts the
  borrowed ones. Statement text is followed by `len=` as the parser does (a statement can hold
  trace-like lines). Preview and file are the same walk with another sink: the plan the view
  draws is what the file gets.
- **Checked before it is trusted.** `api/cut/check` writes the file, parses it back and compares
  calls (count and elapsed per statement and call kind), waits and the first call's wall clock
  with the selection, and counts statements that lost their SQL text. The view runs it on every
  plan under 256 MB. Tests run it on every fixture and set with whole, session, window,
  statement, executions, masked and dropped-bind selections; a cut of everything is the source
  byte for byte plus the provenance lines.
- **Bind values.** Keep, Mask (each value replaced by the redaction token, salted as the session)
  or None (BINDS blocks left out). A session opened with redacted or dropped values only cuts with
  masked or none: the trace text must not give back what the session hid.
- **Joining.** Processes follow one another (each with its switch line), not interleaved by time
  as trcsess does: each session stays readable top to bottom; the views order by `tim` anyway.
  The first file's header is kept; the others' are summarised in the provenance lines.
- **The view.** A time strip (busy time, the brushed window dashed, the kept extent and the part
  kept to finish a call hatched; dragging sets the shared window), the source files as columns of
  lines (labels per line from the plan's runs, density from `api/lines/profile`; a borrowed range
  too small to see gets 9 px in place, with its line numbers), the new file as a column of its
  blocks (kept lines at the source's scale, other blocks at least 15 px) with a band from where
  each comes, and a side panel: the hovered block (why it is there, its lines, Show in Trace), the
  new file (lines, bytes, the mix, the re-parse check), the selection and the options. Hue means
  provenance here (`--cut-*` tokens), not a resource class. Save as… (save dialog, streamed); in
  the app also *Open as new tab* (`cuts/` in the app cache folder).
- **One plan, one identity (2026-11-08, review F10–F13).** The plan, the check and the export are
  for the *current* query and document: a retained plan is drawn dimmed with a Planning… badge
  while the next loads, never exported or checked; a live snapshot re-plans. The statement is
  picked from a typed list of every statement (the picked one first), not a top-300 select.
  Every *Open as new tab* writes its own file (`<stem>-cut-<yyyymmdd-hhmmss>[-n].trc`, `.part`
  then rename), because a session reads its lines by path and the workspace reuses a tab per
  path; the `cuts/` folder is pruned on start of files no tab references and older than 7 days.
  The check is bounded on the engine too: an aggregation-only parse (a sink keeps what the
  comparison needs), cancellable at every read (`model.Options.Ctx`), refused over 1 GiB unless
  `force=1`, one in flight per session (a newer selection supersedes the older).

## Transitions and work preservation (decided 2026-11-08, `docs/REVIEW-DESKTOP-PERFORMANCE-UX-2026-11-08.md`)

- **Provenance of displayed numbers.** A source query knows when it shows another key's answer
  (`stale` in `QueryState`); numbers (wait profile, response bar, scoped findings) are never
  labelled with the current selection while another selection's answer is retained, and a failed
  scoped query says so in a callout instead of falling back to the whole trace silently. Decoration
  (statement roles, spans, highlight marks) may retain. Statement detail retains only across scopes
  of the same statement. Identical concurrent requests share one transport call (`RemoteSource`).
- **Drafts live in the tab, not the component.** The chat draft (per-tab chat store), the note
  drafts (session store, keyed `<kind>:<target>`) and the Statements list controls (session store)
  survive tab and page switches and die with the tab; nothing of them is written to disk.
- **Opening.** Drops on the open screen use the options shown there, drops elsewhere the Settings
  defaults, and the overlay says which; follow applies to a single file. A restored workspace and an
  engine restart open tabs through a bounded queue (the active tab first, two at a time).
- **Prompts** stay on screen while their answer is in flight and after a failure (Retry, Cancel);
  404 means answered elsewhere.
- **Keyboard** reaches the connections list (listbox), every table's sort and row selection (grid,
  caller-named, selection announced), the resize handles' values and the Cut pieces.

## Opening a folder (decided 2026-11-08, desktop)

- **A folder is listed, not opened.** Every way of opening on the desktop (*Open folder…*, a drop,
  the paths box, a recent folder entry, a folder handed to the app from outside) asks the engine to
  list the paths first (`POST /engine/files`); when one is a folder the open screen shows the
  **folder picker** instead of opening every `*.trc` in it as one set. Files given beside the folder
  start selected. The folder is kept in Recent (it lists again from there); what is opened from it
  becomes its own recent entry. Plain files open at once as before.
- **The picker's table comes from a peek, not a parse** (`internal/peek`, `POST /engine/peek`): one
  sequential pass per file that reads only the prologue, the `***` marker lines and the first and
  last `tim=` of a 10046 line (statement text skipped by its `len=`, as the parser does). It gives
  the traced time (from, to, span; anchored to the wall clock as the model anchors it, so the
  numbers equal the opened trace's: the test compares every fixture with the model), the sessions
  (`sid.serial#` with the first module, action, client id and service of each), instance, pid,
  version, chain markers, a dump size limit, and whether the file is a SQL trace at all (an ADR
  folder's background traces are not; *Only SQL and optimizer traces* hides the files that are neither, on by
  default). Since 2026-11-11 it also reports the file's kind (`10046`, `10053` or `both`) and counts the
  optimizer dumps with the sql_ids of the first hundred (§ The 10053 reader); the picker tags such a file *10053*
  or *10046 + 10053* with the number of dumps. A 10053 file has `From` and `To` from its `***` timestamp lines and no
  traced time. It runs at disk
  speed (270 MB in 87 ms from the page cache); the table fills in as the peeks come back, newest
  files first, three requests at a time, and the engine keeps the summaries per path, size and time.
  The peek lists every SESSION ID, also of a session with no calls (an rman session in a shared
  server trace), which the model leaves out.
- **Choosing.** Sort by any column (newest traced start first by default), filter by name, session,
  module, action, client id, service, instance or kind, select with the checkboxes (Shift extends), then
  *Open N as one trace set* (oldest first) or *Open each in a tab*; a double-click opens one file.
  The open options of the screen apply; follow only to a single file. A selection with 10053 files opens the
  10046 files as the set and each 10053 file as a tab of its own (the button says *Open A as one trace set, B on
  their own*). Esc clears the filter, then
  leaves the picker.
- **Next: cut from the picker** (the user's plan, not built): select a file and cut it before
  loading, for files too big to open whole, without reading the whole file into memory.

## The 10053 reader (decided 2026-11-11, `docs/PLAN-10053.md`)

Settled with the owner in a question-by-question review (33 questions) after the research in
`docs/trace-format-10053.md` (19.27 lab traces) and before the build; the look was agreed on a mock-up first
(`docs/mockups/10053-reader/`, on a real lab trace, light and dark). Code: ARCHITECTURE § The 10053 reader; user
guide: DESKTOP § The 10053 view.

**Scope**

- **A reader, named "10053"** in the UI (the view, the mark on a statement), the docs and the CLI. A 10053 trace is
  the optimizer's log of one hard parse: one dump per optimized statement, no `tim=` and no per-line time, a record
  of decisions, not of time. As it comes it is hard to read: 18,523 lines for a two-table statement with two
  subqueries, 93,620 for a ten-table join with no index, the same query block costed up to nine times, every
  parameter printed twice. The reader makes the file navigable and says what its parts are. **It computes nothing
  from the costs**: no summary per statement, no sentence about why a plan won, no comparison of numbers. The text
  stays the trace's own lines in file order; the view dresses it and never re-renders it as tables of numbers (the
  plan table is the one thing drawn as something else, with a switch back to the trace's text). Computed readings
  are candidates for later (below), to be chosen after the reader has been used on real traces.
- **Input: a file that holds only 10053 dumps**: at least one dump and no 10046 record (`opt.File.Pure()`,
  `trace.FileKind10053`). This is how the traces arrive: taken separately for one or a few statements after a 10046
  trace pointed at them. A dump runs from the first `Registered qb: … (PARSER)` line outside a dump to `END SQL
  Statement Dump`.
- **An interleaved file (10046 and 10053 on in one session) is not read as 10053 yet.** It opens as a 10046 trace as
  before. Two things change: the dumps' lines are no longer counted as unknown lines (line kind `optimizer`), and the
  trace facts carry a note ("2 optimizer (10053) dumps in this file, lines 54-18356 and 18684-28072; not shown as
  10053 yet"). A 10046 record inside a dump keeps its kind and its place in the 10046 model (the optimizer's own
  recursive SQL is written as complete `dep=1` records between its lines), and tkprof parity holds on the
  interleaved fixture like on every other (`opt_interleaved`, compared with tkprof's output, no exclusion).
- **19c is the tested version.** A file of another version opens best effort: the view's header says "read with the
  19c rules; this file is 23.6" and shows how many lines of the dump fell outside any known section (`Unplaced`), and the
  outline's row of the open dump shows the same count.
  21c and 23ai were not generated; the format reference holds only a 23.6 excerpt (the bind section unchanged).
- **Not in this version**: producing the trace from the app (turning the event on, `DBMS_SQLDIAG.DUMP_TRACE`); the
  assistant and `mtkprof mcp` (they do not open 10053 files); Compare and Cut on a 10053 tab.

**The view**

A view of its own, not a mode of the Lines view: the outline on the left, the text in the centre, the guide on the
right, the toolbar above.

- **Outline in file order, full depth**: dump → phase (Environment, Transformations, Costing, Result) → section →
  iteration of a cost-based search → costing run → table / join order → join step. A node shows its line count; a
  join order node shows the trace's own words for it (its tables, "aborted" or its cost). The outline follows the
  text, so a query block that is costed once per iteration that contains it has runs that are not adjacent; the
  plan's first idea, a level of query blocks above the runs, was replaced by iterations as a level with the query
  block named on the run, and an *All | Runs* switch that lists the runs alone, in file order, with their verdicts.
- **Several dumps in a file**: the outline's top level lists them (sql_id, the first words of the SQL, the tables,
  line count, plan hash); one is open at a time. Two dumps of one sql_id are two entries, numbered in file order.
- **Centre: Formatted, with a Raw toggle** (persisted). Formatted is the trace's own lines in file order, dressed:
  banners become headings, landmarks are tinted, noise is folded, one-line SQL is pretty-printed, the plan table can
  show as a plan. Raw is the open dump's lines untouched (the file prologue is part of dump 1's lines).
- **Noise folded by default**, each fold with its line count and reason: the parameters with default values, the
  optimizer state dump (the second parameter dump, with the fix controls as a fold inside it), the adaptive plan's
  re-costing, a costing run whose text repeats an earlier one, the statement text repeated, a repeated
  `UNPARSED QUERY IS` statement.
- **Landmarks**: key lines in the trace's words, tinted in the text and listed, with next / previous keys. Seven
  kinds: verdicts (`Updated best state`, `Not update best state`, `Will not use`, `Will not merge`), `Final cost for
  query block`, `Best:: AccessPath`, hints with an error, `Best:: JoinMethod`, `Join order aborted`, and
  bypassed or refused transformations. Each kind has a switch (persisted). On by default are the kinds that end a
  unit the outline shows (a verdict ends an iteration, Final cost a run, Best:: AccessPath a table, Best::
  JoinMethod a join step, Join order aborted a join order) and hint errors; the refusals are off (190 lines in the
  mock-up's trace, one per transformation per query block). A kind that is off is not tinted, not on the line map
  and not stepped through. Tints: kept green, rejected neutral, problem red; amber stays the selection and search.
- **Costing runs** show the verdict of the iteration they belong to, and the run that produced the final plan
  (costed after `Final query after transformations`) is labelled. A run whose text equals an earlier one, addresses
  and memory figures ignored, is marked "same as run N" and folded. This compares text; it does not read numbers.
- **SQL**: every `UNPARSED QUERY IS` statement pretty-printed, with a diff (a button, off when a tab opens) against the previous version. The
  previous version is the previous statement in the file, which is often another query block's text; a menu picks
  another to diff against. The pretty-printer is the reader's own (token and parenthesis based, not a parser),
  ported to Go as well so that the view and the text digest print the same lines; it is not the Trace pane's.
- **Final plan**: the dump's `Plan Table` as a plan (indented operations, query block names and predicates as
  sub-rows under their operation), with a *Plan | Text* switch and *Open in plan viz* (estimates only: a 10053 plan
  table has no actual rows or times).
- **Guide, "sourced or silent"**: fixed explanations per kind of section and per kind of line, and a glossary of
  terms as tooltips on the terms in the text. An entry exists only when a named source backs it: the trace's own
  Legend, `docs/trace-format-10053.md` (lab-verified; it cites Breitling, the Oracle Optimizer blog, Lewis, Pagano,
  Pachot and Oracle's reference), or the lab. A section or line kind without one shows "No guide text". Each
  entry keeps its source in the data; the sources are listed in the docs, not in the UI. Sentences about this
  trace's decisions, computed from its numbers, are not in this version.
- **Also**: literal and regular-expression search with the number of hits on each outline node; a where-am-I path
  above the text, each part a link (dump › Costing › SEL$1BA63A14 run 3 of 9 › Join order 7 › Now joining:
  MTK_CUST); a line map beside the scroll bar (phases as bands, landmarks and hits as ticks, the visible range);
  notes and bookmarks on lines (desktop, as in the Trace pane, listed in Annotations).
- **The dump is searched in the browser.** A dump is megabytes, so the client loads a dump's model and its whole
  text once and searches and dresses it itself, instead of a route per question (decided with the build contract,
  2026-11-11, which replaced the plan's routes for the outline, landmarks, pages of lines and search).

**Tabs and the link to a 10046 trace**

- A 10053 file is always its own tab (desktop) or its own `serve` / report run. Given inside a set of 10046 files it
  is left out of the set with a note; of a set made only of 10053 files the first is opened and the others are named
  in a note.
- **A jump only.** A statement of a 10046 tab (the Statements list and the statement's detail) shows a "10053" mark
  when another open tab holds a dump with the same sql_id; the mark switches to the most recently shown such tab and
  opens the first dump with that sql_id (no line is selected), and the dump's row links back ("10046": the Statements
  view of the most recently shown 10046 tab that has the statement). No data is joined. Desktop only (`serve` holds
  one session).
- **From the folder picker** a selection of 10046 and 10053 files opens as the 10046 set plus one tab for each 10053
  file. Files that arrive in one request without the picker open as the 10046 set; the note about the 10053 file left
  out has a button that opens it in a tab. Live follow of a 10053 file is refused by the engine.

**Clients**

| Client | What it has |
|---|---|
| Desktop, `mtkprof serve` | the view |
| Standalone HTML (`mtkprof html`, the default command) | the same view fed with the digest; where text is not included the centre says "1,234 lines not in this report (lines 2032-3265)" |
| Text (`mtkprof report`, the default command) | the digest |
| `mtkprof lint` | the 10053 line kinds and the dumps |

**The digest** is the trace without its noise, nothing computed. Per dump: sql_id and SQL, the altered parameters and
fix controls, the peeked binds, the outline with line numbers and line counts, the landmark lines verbatim with
their line numbers, each version of the transformed SQL pretty-printed, the final plan with its predicates, the
hints with their flags. It keeps about 5 to 8.5 % of a dump's lines on the fixtures. `-redact-binds` and `-binds
none` apply to the bind sections (`Bind Info`, `Peeked Binds`) as they do to 10046 binds; literals in the SQL text
and the predicates stay, as in the 10046 reports. A redacted value is the 10046 token (`<NUMBER len=2 h=4fc82b26>`);
`-binds none` empties the value (the text digest says "2 binds; values left out (-binds none)"). The redaction acts on
the text digest and on the document's digest (the standalone HTML, `mtkprof json`, the engine's exports). A server's
`api/opt/dump` and `api/opt/text` are the file as it is, so the view in the desktop and in `serve` shows the binds as
traced.

**Correctness contract**

- **Best effort on what Oracle writes.** The format is undocumented free text that changes with releases; an
  unrecognized line stays readable where it is and is counted, and nothing is guaranteed for traces not seen.
- **Our own output is pinned.** Every lab fixture has a committed outline, landmark list and text digest (a
  snapshot); a change of the scan that alters one shows in the diff. The scan also agrees with the approved
  mock-up's parser on its trace (deliberate differences are asserted with their reason). The 10046 golden tests do
  not change, for files with and without dumps.
- **Fixtures are real**, generated on the lab by `testdata/gen` (`sc_opt_*.sql`). The generator may create new
  objects in schema `MTK` (a partitioned table, a table without statistics): idempotent CREATE only, never DROP or
  TRUNCATE, as for the existing tables.

**Afterwards** — candidates without order or commitment, chosen after the reader has been used on real traces: a
computed summary per statement; decision views (transformation ledger, access paths per table, join order explorer);
the origin of a row estimate joined to the 10046 actual rows of the same plan; comparing two dumps; reading the dumps
of an interleaved file; a digest tool for the assistant and MCP; 21c and 23ai fixtures.

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
