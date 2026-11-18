# Diagnostic dumps: plan

Written 2026-11-17. Built on 2026-11-17 and 18 (stages 1 to 7, see the Log), on the branch
`t3/oracle-trace-dump-support`, unreleased. The owner set the frame on 2026-11-17: 10046 and 10053 stay the primary
formats, everything here is a best-effort add-on; computed views are allowed (unlike the 10053 reader); there
are no real incident or systemstate files to work from, so the lab and public samples are the only sources.

"Diagnostic dump" (short: **diag**) is the name used here for what Oracle writes to a trace file besides 10046
records and 10053 dumps: heap dumps, PGA memory summaries, call stacks, process state, system state, hang
analysis, deadlock graphs. The code already uses "dump" for a 10053 dump (`trace.Dump`, `opt.Dump`,
`api/opt/dump`), so the new code says `diag` and `Section`.

**The formats are in `docs/trace-format-diag.md`**, read off lab traces on 2026-11-17 (stage 1). This plan was
written from memory before that and corrected afterwards; where the two differ the format reference is right.

## Why

- A trace directory holds more than SQL traces. Today a file with neither 10046 records nor 10053 dumps opens as
  an empty 10046 trace whose lines are all unknown, and a dump inside a 10046 trace (an errorstack, a deadlock
  graph) counts as unknown lines.
- These dumps are unreadable at their size: a heap dump is one line per chunk, a system state one tree of state
  objects per process. The existing tools are awk scripts (`heapdump_analyzer` by Tanel Poder, Oracle Support's
  `ass109.awk`).
- Most of what a reader needs exists: the line index and paged lines, search, the outline and line map of the
  10053 view, notes and bookmarks, the folder picker, the ADR fetch.

## Decisions

### Scope

- **An add-on.** DESIGN § Purpose keeps its six questions. Diag files are a third input, read best effort.
  Nothing here may cost the primary formats anything (see "Guard rails").
- **Three levels of reading**, so that every file gets something and only a few kinds get a lot:

  | Level | What it gives | Which files |
  |---|---|---|
  | 0 | opens in the reader: outline from markers and banners, paged text, search, line map, notes | any trace file |
  | 1 | typed sections in the outline, with their own nodes, folds and landmarks | the kinds below |
  | 2 | a computed summary of a section, checked against the dump's own totals where it prints any | heap, PGA, process state, hang analysis, deadlock, system state |

- **Section kinds in this plan**, in build order: heap dump; PGA memory dumps (`pga_summary`, whose blocks are
  the memory part of an out-of-memory trace, and `pga_detail_dump`); the diagnostic dump an errorstack, a
  deadlock or an incident writes (call stack, current SQL, cursors); process state; hang analysis; deadlock
  graph; system state; the table of contents of an incident file.
- **Not in this plan**: block, redo, controlfile, buffer cache and library cache dumps; other event traces
  (10032, 10104, …); ORA-4031 analysis beyond the heap grammar; RAC-wide dumps (the lab has one instance);
  taking a dump from the app (an `oradebug` on a production system is not something a viewer should start);
  the assistant and `mtkprof mcp`; Compare, Cut and live follow on a diag tab. A section of a kind not listed
  is read at level 0.
- **19c is the tested version**, as for 10053: another version opens with "read with the 19c rules" and a
  count of lines outside any known part.

### A file is a sequence of sections

Today a file has one kind (`trace.FileKind`: none, 10046, 10053, both). That stays for the primary formats;
sections are added beside it.

- **`trace.Section`** (`Kind`, `First`, `Last`, `Cut`): a range of lines of one diag kind. The parser gets a
  `sectionTracker` beside `optTracker`, called under the same condition (the line matched no record, or the
  tracker is inside a section). Its lines are a new line kind `KindDiag` ("diagnostic") and no longer unknown.
  Precedence: cursor text and `BINDS` state, then an optimizer dump, then a section. A valid 10046 record
  inside a section keeps its kind, as inside an optimizer dump.
- **The parser only finds where sections start and end.** Reading them is `internal/diag`, as reading a 10053
  dump is `internal/opt`.
- **A file opens by its kind, and can be opened another way.** A session takes an option `view`: `10046`,
  `10053` or `diag`; the default follows the file (10046 records: `10046`; only optimizer dumps: `10053`;
  otherwise `diag`). A 10046 trace that holds sections stays a 10046 trace with a note under the trace facts
  ("1 call stack and 1 process state in this file, lines 812-4410") and a button that opens the same file in a
  diag tab.
- **The same option opens the dumps of an interleaved file** as a 10053 tab (the `opt` scan already skips the
  10046 records, `TestInterleaved`). This closes the item deferred in DESIGN § The 10053 reader.
- **Sets**: a diag-only file in a set of 10046 files is left out with a note, as a 10053 file is
  (`model.DropOptFiles` generalised).

### The reader

One view for every diag file, `web/src/lib/views/diag`, a tab kind of its own in the desktop.

- **Left: the outline**, in file order: file header, sections, and inside a typed section its own nodes (a
  heap's extents and sub-heaps, a process's state objects, a system state's processes). Only the top levels are
  held; the children of a node are asked for when it is opened (a system state has millions of state objects).
- **Centre: the file's text, paged.** These files reach gigabytes, so the 10053 view's "whole text in the
  browser" does not carry over. The viewer is new, built on the Lines view's data layer (`data/linecache.ts`,
  `data/scrollmap.ts`, `api/lines`, `api/search`) with the row rendering of `OptViewer` as its pattern;
  `views/Lines.tsx` (1,600 lines, tied to the 10046 model) is not taken apart. Folds and landmarks come with
  the typed sections.
- **A reading is shown in the centre, behind a *Reading | Text* switch** (layout A of the mock-up, chosen by
  the owner on 2026-11-18); the switch shows only for a node that has a reading. The right panel is the guide:
  the selected node's facts and the sourced text about its kind.
- **The selection decides which reading is shown** (an outline node, a link); scrolling the text moves the
  where-am-I path and leaves the reading alone (owner, 2026-11-18).
- **Also**: search with hit counts per outline node where the node is loaded, the where-am-I path, the line map,
  notes and bookmarks (desktop), as in the 10053 view.
- **A jump to the primary formats, no joined data**: a section that names a sql_id or a session (sid.serial#)
  shows a mark when another open tab holds that statement or session, and the 10046 side marks back. Desktop
  only, the mechanism of the "10053" mark (`optSqlIds`).
- **The guide stays "sourced or silent"**: an entry only where the format reference backs it.
- **A mock-up on real lab files comes before the UI is built** (one page: the reader on an errorstack file, the
  heap reading, the process reading), light and dark, approved or corrected by the owner.

### The readings (level 2)

- **Heap dump.** One pass over the chunk lines gives, per heap: chunks and bytes by type (free, freeable, perm,
  recreate, …) and by comment, the sub-heaps with their parent chunk, the free-list buckets. Shown as a sortable
  table with bars (by comment, by type, sub-heaps), the heap tree (heap, sub-heap, comment), and a jump from a
  row to its chunks in the text. **Self-check**: the sums are compared with the dump's own `Total heap size`,
  `Total free space` and `Permanent space` lines and the reading says "matches the dump's totals" or by how much
  it differs. This is the parity test of this reader. A second reference where it can be run: the output of
  `heapdump_analyzer` on the same file, committed beside the fixture as tkprof's output is.
- **PGA memory dumps**: the dump's own tables read as tables (top uses of the process, the heap summary by
  depth, memory per Oracle process, estimated uses for all processes; `pga_detail_dump` with exact bytes),
  beside the readings of the heap dumps in the same file. The summary's figures are rounded, so it has no
  total to check.
- **Call stack, error stack, current SQL**: the frames as a list with the dump's own frames folded, the stack
  as one copyable line (the form `oradebug short_stack` prints), the error, the statement and its sql_id, the
  PL/SQL stack. No interpretation of function names.
- **Process state**: the tree of state objects by owner; for the kinds the lab shows to be regular (process,
  session, call, enqueue, library object lock and pin, cursor) one line each: who the session is, what it runs,
  what it waits for and since when, what it holds.
- **Hang analysis and deadlock graph**: the chains and the graph as Oracle printed them, as a table and a small
  node-and-arrow drawing; the sessions and statements named in them.
- **System state**: one row per process from the dump's own `Process Summary` (pid, name, ospid, session,
  waiting for), completed from each session's wait stack (time in wait) and from the blockers the dump names
  itself (`Dumping 1 direct blocker(s)`, `Dumping final blocker`, `There are N sessions blocked by this
  session`), drawn as the blocker tree. **Idle background processes are hidden by default**, with their count
  and a switch; blocked and blocking sessions always show (owner, 2026-11-18). A process opens with the process state reading, on demand. A resource
  table of holders and waiters per enqueue, library object or latch is not built: the dump's blocker lines make
  it unnecessary for sessions, and the lab shows no latch or mutex wait to build it from (a candidate for
  later).

### Clients

| Client | What it has |
|---|---|
| Desktop, `mtkprof serve` | the reader |
| Standalone HTML (`mtkprof html`, the default command) | the reader fed with the digest: outline, readings, no text beyond the digest's lines |
| Text (`mtkprof report`, the default command) | the digest |
| `mtkprof lint` | the diag line kind and the sections |

**The digest**: the file header, the outline with line numbers, and every reading as text (a heap's tables with
its check, a process's lines, the chains). Text and UI stay equal in numbers. Commands with nothing to show
(`pivot`, `export`, `plan`, `compare`, …) refuse with one line, as for 10053.

### Correctness and privacy

- **Best effort on what Oracle writes; our own output is pinned**: a snapshot per fixture (outline, readings,
  digest), invariants on every fixture, prefix and mutation tests, as for `internal/opt`.
- **Where a dump prints a total, the reading must equal it** on every fixture (a test, not a display). Checked
  by hand in stage 1 on 87 heaps: chunks against `Total heap size`, the free lists against `Total free space`,
  the perm chunks against `Permanent space`. A PDB-filtered dump, a sampled heap and a header without extents
  have nothing to check, and the reading says so.
- **Fixtures are real**: lab scenarios `sc_diag_*.sql` (`testdata/diag/19c/`, the ones over 3 MB in the
  ignored `testdata/big/diag/`). No public sample of another version can be committed (stage 1 found a few
  10.2 and 11.2 files, none with a licence), so **only 19c is tested**.
- **Redaction**: `-redact-binds` and `-binds none` act on the bind values a cursor dump prints, with the 10046
  token. Memory contents (a heap dump taken with contents) are never in a digest.

### Guard rails for the primary formats

- The 10046 golden tests and the `internal/opt` snapshots do not change.
- Every existing fixture has zero sections and the same unknown-line count as today (a test); a section
  start must not be matched inside 10046 or 10053 content.
- Parser throughput on a trace without sections stays within 2 % (`internal/trace` benchmark).
- Each stage leaves the branch releasable; no stage is a condition of a release.

## Sequence

Built on the branch `t3/oracle-trace-dump-support`, merged to `main` after the 10053 release is tagged, so that
release holds no half-built reader. Each stage ends with `scripts/ci-local.sh --strict` green and a short report.

| Stage | What | Needs the owner |
|---|---|---|
| 0 | Release the 10053 reader (HANDOFF § Needs you) | version, tag, the Mac |
| 1 | Research on the lab, the format reference, this plan corrected | start the lab VMs; one OK for the ORA-4030 run |
| 2 | Sections in the parser, `internal/diag` at level 0, the `view` option, the reader at level 0 | the mock-up |
| 3 | Heap dumps and the PGA summary | |
| 4 | Call stack, error stack, process state; the jump to a 10046 tab | |
| 5 | Hang analysis and deadlock graph | |
| 6 | System state | |
| 7 | Documents, site pages, release notes draft | publishing the site, the release |

Stages 3 to 6 are independent of each other after stage 2; the order is by value for the work. Stopping after
any of them leaves a working reader.

### Stage 1: research

- **Generate on dbmint (19.27)**, session-level events and immediate dumps only, in schema `MTK` or as SYSDBA
  where a dump needs it; nothing that changes an instance parameter, no DROP or TRUNCATE:

  | Scenario | What it produces |
  |---|---|
  | `diag_heap_pga`, `diag_heap_uga` | heap dump summaries of a session that built a PL/SQL collection and sorted |
  | `diag_heap_sub` | the same with the largest sub-heaps dumped (the levels with the high bits, to confirm) |
  | `diag_heap_contents` | a small dump with contents, to learn the lines a reading must skip |
  | `diag_heap_large` | the large pool (a small SGA heap); the shared pool dump goes to the uncommitted big set |
  | `diag_errorstack` | errorstack level 3 from inside PL/SQL with open cursors and binds |
  | `diag_procstate` | process state of a session holding a row lock |
  | `diag_in_10046` | a 10046 trace with an errorstack written on an ORA-00942, with tkprof output |
  | `diag_deadlock` | ORA-00060 between two sessions |
  | `diag_hang`, `diag_sysstate` | hang analysis and system state taken while three sessions wait in a chain |
  | `diag_ora4030` | the incident file of a real ORA-4030 (a local SYSDBA session under a memory limit); **not obtained**, see the Log |

- **`diag_ora4030` is asked for separately**: it writes an incident to the lab's ADR and an alert log entry.
- **Find out and write down** in `docs/trace-format-diag.md`, per kind: how it is produced, the lines that start
  and end it, its line grammar, which totals it prints, sizes, and what an incident file's own table of contents
  looks like. Then look for public samples of 11.2 and 12.x and record their licences.
- **Exit**: the format reference and the fixtures committed; every "to confirm" in this plan resolved; the
  section kinds whose start or end cannot be found reliably are moved to level 0 and said so.

### Stage 2: sections and the reader at level 0

- **Parser** (`internal/trace/section.go`, `kind.go`, `classify.go`): `Section`, `sectionTracker`, `KindDiag`,
  `Stats.Sections`; `lint` lists them; a fuzz target for the tracker.
- **Model** (`internal/model`): `FileEntry.Sections`, the note, `DropOptFiles` generalised.
  **Cache**: a new line kind and a persisted field, so `model.PersistVersion` 4, `engine.CacheIndexFormat` 9,
  `TestCacheIndexFormatCoversParts` updated.
- **`internal/diag`**: `ScanFile` / `ScanReader`, one streaming pass, memory by the model: `diag.File`
  (header, sections, top-level outline, lines outside any known part) and `Children(node)`, which scans one
  node's line range through the line index. The banner detection of `internal/opt` (rule, title, rule; a title
  over an underline) is moved to a small shared package if the opt snapshots stay byte-identical, else copied.
- **Peek** (`internal/peek`): `Kind` gains `"diag"`; `Sections` lists the kinds with counts for the folder
  picker's tags. The picker's default filter keeps hiding files that are neither SQL nor optimizer traces.
- **Engine and `serve`** (`internal/slice/diag.go`, `internal/engine`): the build contract below; the `view`
  option on `POST /engine/sessions` and on `serve`; OpenAPI, the contract test, `pnpm gen:api`. Additive:
  `engine.Protocol` stays 1.
- **CLI** (`cmd/mtkprof`): `report`, `html`, `json`, the default command and `serve` read a diag file;
  the one-line refusals.
- **UI**: `data/diag.ts` (the mirror of `model.go`, with the drift test), `DiagSource` (HTTP, document, memory),
  the view, the tab kind, the note's button, the harness `web/dev/diag.html`.
- **Tests**: snapshots, invariants (sections do not overlap, nodes nest, children lie inside their node),
  prefixes, mutations, the guard-rail tests, tkprof parity with zero unknown lines on `diag_in_10046`,
  throughput.

### Stages 3 to 6: one kind at a time

Each adds, for its kinds: the start and end rules in the tracker, a reader in `internal/diag` (`heap.go`,
`stack.go`, `procstate.go`, `hang.go`, `deadlock.go`, `sysstate.go`) with its part of `model.go`, its folds and
landmarks, its text in the digest, the panel in the view, guide entries with sources, snapshots and a screenshot.
Particular to a stage:

- **3**: the totals test; the output of `heapdump_analyzer` (Apache 2.0, `tanelpoder/tpt-oracle`
  `tools/unix/heapdump_analyzer`) on each heap fixture committed beside it as a second reference; a bound on
  distinct comments (the rest summed as "other", said so). The shared pool dump (32.7 MB) is the throughput test.
- **4**: `diagSqlIds` and `diagSessions` on the session object, the marks in the Statements and Sessions views.
- **6**: the level-266 fixture is 4.9 MB, over the limit: it is committed as an exception if the reader is
  built (level 1 has processes and sessions only); a top-level cache part for the scan **only if** a fresh open
  of a 1 GB file measures over 5 s (a new persisted struct, its own version, the format bump).

### Stage 7: documents

DESIGN (§ Inputs and a new § Diagnostic dumps), ARCHITECTURE, DESKTOP, HANDOFF (state, the budgets measured),
ROADMAP, README, the site's pages (not published), a release notes draft, this file's log.

## Build contract (as built, 2026-11-18)

- **The model**: `internal/diag/model.go` (`diag.File`, `diag.Node`, `diag.Outline`); `TestJSONShape` pins it. A
  node's `id` (`heap:32-923:1:200`: kind, lines, heading lines, rule set) is stable across scans.
- **The document** of a diag session is the document of an empty 10046 model plus **`dump`**: `file` always, and
  `digest` in a document made for a client without a server. The member is `dump`, not `diag`: `doc.diag` already
  holds the parser's diagnostics. A shell that sees `doc.dump` shows the reader and none of the 10046 views.
- **Routes** of a diag session, beside `api/lines` and `api/search` which it serves as any session does:
  - `GET api/diag/file` → `diag.File` (facts, the parser's sections, the top-level outline, which tiles the file).
  - `GET api/diag/outline?node=ID[&after=N]` → `{node, children, more, next}`; `node=root` is the top level; at
    most 2,000 children per answer.
  - `GET api/diag/reading?node=ID` → the reading of a node, `{kind, …}`; a node that has one says so
    (`Node.reading`, the reading's kind). Readings are addressed by node, not by section number, because a heap
    dump or a process state can sit inside another section. (Stage 2 shipped the seam as `api/diag/section?i=N`;
    stage 3 replaced it.)
  - `GET api/diag/reading/lines?node=ID&comment=TEXT[&type=T][&after=N]` → `{node, lines, more, next, total}`: the
    numbers of the chunk lines of a heap reading's extents with that comment group (and type), ascending after
    line N, at most 2,000 per answer (`next` is the `after` of the next page).
  - The digest (`dump.digest`) carries the readings of its nodes (the top-level nodes and their listed
    children) as `readings`, by node id: at most 200, 8 MB of JSON; `readingsOmitted` counts the rest.
- **`view`** on `POST /engine/sessions` and as `-view` on `report`, `html`, `json`, the default command and
  `serve`: `10046`, `10053`, `diag`. Default: 10046 records → `10046`; only optimizer dumps → `10053`; else one
  file → `diag`. `diag` opens any single file (its 10046 records are "SQL trace (10046) lines" runs); `10053`
  opens an interleaved file. Refused with one line: a view on a set, live follow, `10053` on a file without a dump.
- **The session object** carries `view`, and for a diag session once it is ready `diagSqlIds` and `diagSessions` (stage
  4): the statements and the `sid.serial` sessions the file names, first-seen order, at most 300 each, collected in
  the scan pass (`internal/diag/marks.go`, which lists the lines it reads), parallel to `optSqlIds`.
- **Readings of stage 4**: `callstack` on a node of kind `diagdump` (top-level or nested, so also the one in a
  deadlock), on an `incident` node and on its "Dump for incident" part (kind `toc`); `procstate` on a node of kind
  `procstate` (a PROCESS STATE dump, also the one nested in a diagnostic dump) and on a `process` node of a system
  state. Fields: `internal/diag/stack.go` and `procstate.go`; the OpenAPI schemas are `DiagCallStack` and
  `DiagProcState`. Both are computed on demand from the node's own lines (13 ms for 115,000 lines).
- **Readings of stages 5 and 6**: `sysstate` on a node of kind `sysstate` (`internal/diag/sysstate.go`, `DiagSysState`: the
  process table from the summary completed from each `PROCESS` body by the process state parser, the counts with the idle
  flags from the event reference, the blocker tree; bounded: 3,000 rows and the rows of blocked and blocking sessions beyond
  them, 300 tree nodes), `hang` on a node of kind `hang` (`hang.go`, `DiagHangReading`: header, the list of likely chains, each
  chain's sessions in "is blocked by" order, the node tables, the dumps block) and `deadlock` on a node of kind `deadlock`
  (`deadlock.go`, `DiagDeadlock`: graph rows with empty cells absent, the cycle, the sessions' blocks, the victim, the rows
  waited on, the node of the nested dump). All three computed on demand from the node's lines; the text of each is in
  `blocktext.go` and in the digest.
- **`GET api/diag/path?line=N`** (or `node=ID`) → `{nodes: [...]}`: the chain of nodes from the top level down to the deepest
  node that holds line N (or down to that node), at most 16, read from the lines of the nodes on the way and cached
  (`internal/diag/path.go`); 400 without `line` or `node` or with a bad number, 404 for a line outside the file and an id
  that is not a node.
- **Also added** (stage 5/6, add-only): `HeapReading.runLabel` (the oradebug command before the run, when the file has one:
  no fixture does, an event or alter session dump prints nothing about its level, and the `*** ACTION NAME` marker is a
  habit of the lab scripts); the `session` of a `processes.top` row of a PGA summary (the same as its `all` row's).
- **`Node.fold`**: a short reason, set on a child part whose lines are noise by default (the table `foldTable` in
  `internal/diag/rules.go`, with the fixture lines that show each part to be bulk); never on a section.
- **Bind redaction** (`-redact-binds`, `-binds none`, the engine's bind mode for documents) acts on the values of the
  cursor dumps in the text digest and in the readings of `dump.digest`, with the 10046 token (`model.RedactToken`);
  `diag.TextOptions`, `report.DiagBindText`. The live routes serve the file as it is.
- **Refused for a diag session**: the assistant, the brief, Compare, the CSV export, `mtkprof mcp`, and the CLI
  commands with nothing to show.

## Budgets to measure

| | target |
|---|---|
| diag scan | 200 MB/s or more |
| memory held by the scan | under 64 MB for a 2 GB file |
| fresh open of a 1 GB system state | under 5 s |
| children of a 100,000-line node | under 50 ms |
| 10046 parse of a trace without sections | within 2 % of today |

## Known weak points

- **System state is the least supported kind.** A lab instance has a few dozen processes; the format's variety
  shows on busy production systems, of which there is no sample. It ships marked "tested on a small lab system".
- **Start and end of a section** are the main risk to the primary formats. A heap dump, a process state, a
  system state, a hang analysis and a PGA detail dump have an end line. A diagnostic dump (errorstack), a PGA
  summary, a deadlock trace and an incident have none: they run to the next valid 10046 record or the end of
  the file, a rule seen inside a 10046 trace on one fixture (`diag_in_10046`).
- **No real ORA-04030 trace.** The lab host fails the allocation with ORA-27102 (an ORA-06544 incident) under
  any memory limit tried; the memory blocks are read from `pga_summary`, and that an ORA-04030 trace prints
  the same blocks is not shown by a fixture.
- **Other versions** are read with the 19c rules; only public samples say how well.
- **No reference tool for system state** can be committed (`ass109.awk` is Oracle Support's); snapshots only.

## Decided here for the owner (say if any should differ)

1. The work stays on the branch until the 10053 release is tagged.
2. The name is "diag" in the code and "dump" in the UI.
3. A file can be opened in another view (`view`), which also opens the 10053 dumps of an interleaved file.
4. The centre text is paged from the server, not held whole in the browser.
5. One mock-up for the whole reader, not one per kind.
6. The scan is not cached until a measurement asks for it.
7. Hang analysis and deadlock graphs are in; ORA-4031, RAC dumps and taking dumps from the app are out.
8. The assistant and `mtkprof mcp` do not read diag files in this version.

## Log

### 2026-11-17: plan

Written after the owner's three answers (an add-on; computed views allowed; no real samples) and "follow your
recommendation".

### 2026-11-17: stage 1, research

- **Lab**: the dbmint VMs were already up. `testdata/gen/run_gen.sh diag` and 19 scenarios `sc_diag_*.sql`
  (helpers `_diag_*.sql`; `01_schema.sql` gained the package `mtk_diag_mem` and two procedures, CREATE OR REPLACE
  only). 16 fixtures in `testdata/diag/19c/` (`testdata/diag/README.md`), seven larger files in
  `testdata/big/diag/`.
- **Format reference**: `docs/trace-format-diag.md`.
- **What the lab changed in this plan**: a heap dump's totals check holds on every heap tried; the PGA dumps
  are `pga_summary` and `pga_detail_dump`, not an ORA-04030 trace; a system state names its blockers, so the
  resource table went; an incident file carries its own table of contents; an errorstack and a process state
  have no end line; hang analysis prints a numeric `current sql_id`.
- **ORA-04030 was not obtained.** About ten attempts as SYSDBA under `ulimit -d` / `-v` and with event 10261
  left **five ORA-06544 incidents** in the lab's ADR (48 to 53); nothing was deleted. The scenario is `diag_oom`.
- **Public samples**: none committable (10.2 XE and 11.2 RAC files without a licence, kept out of the
  repository).
- **A latent mismatch in the 10046 code**, found by `diag_in_10046`: `trace.Classify` takes 211 lines of the dump
  after a `BINDS` block for bind lines and the parser does not (`TestClassifyMatchesParser`). The fixture waits
  in `testdata/diag/19c/` until stage 2 fixes it with the section tracker.

### 2026-11-18: stage 2, the parser's sections

- **Built**: `internal/trace/section.go` (`Section`, nine kinds, `sectionTracker`, the line kind `diagnostic`,
  `FileKindDiag`, sniff), `trace.MarkSections` for the page classifier, `model.FileEntry.Sections` with the note
  under the trace facts, the set exclusion of a diag-only file, `peek` (`Kind` "diag", `Sections`), `lint`, the
  line annotation and the Lines view's neutral tone for the new kind. Cache: `model.PersistVersion` 4,
  `engine.CacheIndexFormat` 9. The API change is additive (`LineKind`, `TracePeek.sections`), protocol 1.
- **Guard rails held**: the lint output of all 116 earlier fixtures is identical before and after
  (`internal/trace/testdata/fixture_kinds_before.txt`, `TestFixtureKindsUnchanged`); golden and 10053 snapshots
  unchanged; `BenchmarkParseFile` on 1.2 GB of 10046 traces 668-671 MB/s before and after, interleaved runs.
- **`diag_in_10046` is in `testdata/traces/19c/`**: compared with tkprof without exclusion, zero unknown lines
  (29,371 before), `TestClassifyMatchesParser` passes.
- **Corrections to the format reference**: `END OF PROCESS STATE` does exist in 19.27 (the first reading missed
  it); the `*` rules between heaps are shared, so a run of heaps is partitioned at them.
- **Peek**: searching every file for section starts halved the peek's speed on 10046 traces (5.9 to 2.65
  GB/s), so the search stops at the first 10046 record or optimizer dump and `Sections` is set for diag-only
  files; a 10046 trace's sections are found when it is parsed.
- **A fix in Cut** (`internal/cut/text.go`), needed by the new fixture and not by sections: a blank line after
  a separator was dropped as a record continuation, which left a gap and an extra generated timestamp.
- **Left unknown on purpose**: oradebug's wrapper lines, the caller's short stack before a system state, the
  `ksqdld_hdr_dump()` line before a deadlock, the latch directory before the first shared pool heap.
- A diag-only file still opens as an empty 10046 model; the reader is the next step.

### 2026-11-18: the mock-up

`docs/mockups/diag-reader/` (plain HTML, a throwaway parser `tools/parse.mjs` on the lab files, eleven
screenshots in `shots/`): the error stack, process, heap, system state and hang analysis readings, light and
dark, and two layouts for the owner to choose from (A: a *Reading | Text* switch in the centre; B: the text in
the centre and the reading in the right panel). Its parser found the totals check true on all 80 heaps of
`diag_heap_sub`. Not approved yet.

### 2026-11-18: stage 2, the Go side of the reader at level 0

- **Built**: `internal/diag` (scan, top-level outline that tiles the file, children on demand, text digest), `internal/slice/diag.go` (`api/diag/file`, `outline`, `section`), the `view` option (`model.ResolveView`, engine session, `serve -view`, `-view` on report, html, json and the default command), `report.DiagInput` and the document member **`dump`** (the key `diag` is taken: it is the parser's diagnostics), refusals, OpenAPI (additive, protocol 1), `pnpm gen:api`.
- **Scan** is `trace.SniffReader` with a new optional per-line hook (`SniffOptions.Line`): the sections are the parser's, the titles come from the same pass. Not cached.
- **Measured** (Apple M4): scan 1.0 to 2.1 GB/s on every fixture including the 32.7 MB shared pool dump, 0.3 MB allocated; children of a 357,000-line node 28 ms, of a 100,000-line node 2 ms.

### 2026-11-18: the owner on the mock-up

Layout A (a *Reading | Text* switch in the centre); the selection alone decides which reading is shown; idle
background processes of a system state are hidden by default. Decided without asking, to be corrected on the
real view: time in wait is shown for every process and dimmed with the idle ones; the heap tree shows the
selected heap's ancestors, siblings and children, not the whole dump run.

### 2026-11-18: stage 3, heap and PGA readings (Go side)

- **Built**: `internal/diag/heap.go` (the heap reading, `Reader.Reading`, `Reader.HeapLines`), `pga.go` (`pga-summary`
  and `pga-detail`), `reading.go`, `readingtext.go` (the text of the readings for the digest); `Node.reading`;
  routes `api/diag/reading` and `api/diag/reading/lines` (the seam `api/diag/section` is gone); OpenAPI (additive,
  protocol 1); `pnpm gen:api`. No cache format changed: readings are computed on demand and kept 8 at a time.
- **Totals**: on the 100 heaps of the committed fixtures 288 of 300 checks match and 12 say why they cannot be
  made; no differ. The shared pool dump: 8 match, 9 none (headers without extents). The reading also makes a
  fourth check, of the reserved free lists, where the dump prints them.
- **heapdump_analyzer** agrees with the reading on every (heap, type, comment) group of every heap fixture and on
  the shared pool dump (`testdata/diag/README.md`).
- **Nested heaps**: a sampled heap of a PGA summary is a node under the part it stands in (the outline of
  `diag_pga_summary` changed; so did the ids of that file's nodes); a heap nested in another section has a
  reading too, and its run is itself. The digest holds only the readings of top-level nodes and their children.
- **Measured** (Apple M4): the reading of the 357,000-line heap of the shared pool dump 43 ms, `reading/lines` for a
  comment of 26,000 chunks 33 ms, the largest committed heap (17,000 lines) 1 ms.

### 2026-11-18: stage 4, the call stack and process state readings (Go side)

- **Built**: `internal/diag/stack.go` (reading `callstack`), `procstate.go` (reading `procstate`), `stackrules.go` (the
  dump's own frames), `marks.go`, `redact.go`, the text of both readings (`stacktext.go`), `Node.fold`; the session
  object's `diagSqlIds` and `diagSessions`; OpenAPI (additive, protocol 1), `pnpm gen:api`. No cache format changed.
- **Frames**: both sources are always read, the list is the binary stack dump's frame headers and the table's
  (wrapped names joined) where the dump has none; they agree on every fixture (the table has a `*** timestamp` marker
  in its middle on `diag_in_10046`, which the first reading took for a wrapped name: `TestCallStackFixtures`).
- **The dump's own frames** are the leading frames named ksedst*, ksedmp, dbk* or dbg* (`stackrules.go` has the
  fixture evidence per prefix). `ksqdld_hdr_dump`, which asked for the deadlock dump, stays the process's.
- **Process state**: read by its state object lines and `owner:` links; the tree ends at the first `=====` rule or titled
  `----- X -----` line (the cursor dumps that follow a process state are not part of it). A session's `sql:` is the
  address of a library handle; the session holds a lock on it whose text prints the `SqlId=` and the statement, so
  the sql_id is known when the dump prints child state objects and is not when it does not (a system state of level
  1). `psql:` is the previous statement (fixture evidence in `ProcSession`).
- **Measured** (Apple M4): call stack reading of 115,000 lines 13 ms, of a process state 7,000 lines 1 ms; the scan
  with the marks 1.3 to 1.9 GB/s on the big fixtures (as before).
- **Not done**: the reading of a hang analysis, a deadlock graph and a system state's process summary (stages 5, 6);
  the heaps inside a process state are not nodes of the outline, so a call stack reading links the process state and
  the heaps that are direct children of the dump only.

### 2026-11-18: stages 5 and 6, hang analysis, deadlock graph and system state (Go side)

- **Built**: `internal/diag/{hang,deadlock,sysstate,blocktext,path}.go`; readings `hang`, `deadlock`, `sysstate`; route
  `api/diag/path`; `HeapReading.runLabel`; the top-row sessions of `PGAProc`; OpenAPI (additive, protocol 1), `pnpm gen:api`;
  the contract test lists 5 diag routes. `Scan.SessionMarks` (the `*** SESSION ID` markers, for the victim of a deadlock and
  the caller of a system state). No cache format changed.
- **`current sql_id` of a hang analysis is not the 10046 `hv=`**: it is the high 32 bits of the sql_id's 64-bit number (bytes
  9 to 12 of the statement's `FullHashValue`); the hash value is the low 32 bits. Evidence in `docs/trace-format-diag.md` §
  Hang analysis and `TestHangSqlIDHigh` (3 statements in the hang fixture, 386 handles in the level 266 dump). The field is
  `sqlIdHigh`; there is no `diagSqlHashes` on the session object (the number is no hash value; a sql_id can be matched to it
  with `diag.SQLIDParts`).
- **System state**: every level (1, 2, 258, 266) prints the summary's `Blocked by` / `Final Blocker` lines and the bodies'
  direct blocker lines; the tree is built from both. The summary and the bodies are written at different moments (a
  process can move on between them: `bodyEvent`). A process is idle by the event reference's class, or has no session.
- **Measured** (Apple M4): the reading of the level 266 dump (83,000 lines) 16 ms, of 5,000 synthetic processes (45,000 lines)
  14 ms, of 40,000 (360,000 lines) 46 ms; the path of a line 24,000 lines read for the first 10 processes of a 20,000-process
  dump whose summary is 20,000 lines.
- **Not done**: a resource table of holders and waiters (decided out); hang analysis of a RAC system (no sample), a session
  not in a wait in a hang chain (the reader keeps the line's text, no fixture shows one); the UI side of all of this.

### 2026-11-18: the reading screens, the documents, the end of the build

- **Screens**: heap, PGA summary and detail, call stack, process, system state, hang analysis and deadlock
  readings (`web/src/lib/views/diag/readings/`), folds in the text for nodes with `fold`, the "dump" and "10046"
  jump marks in the desktop, `path()` to locate a part the outline has not loaded. Each was looked at on the
  lab files in `mtkprof serve`, the standalone report and the desktop's dev browser mode, light and dark.
- **The deadlock cycle drawing is not in the mock-up**; it was designed during the build and is the screen the
  owner has not seen.
- **Documents** (stage 7): DESIGN § Diagnostic dumps, ARCHITECTURE § The dump reader, DESKTOP § The dump
  reader, HANDOFF, ROADMAP, MCP, README, the site's pages (not published), `docs/releases/next-diag.md`.
- **CI**: `scripts/ci-local.sh --strict` passes on the branch.
- **Left open** (also in HANDOFF § Open): the note of an interleaved file still ends "not shown as 10053 yet"
  although *Open as 10053* stands beside it (the wording is pinned by a dozen tests on both sides); the
  level-266 system state fixture (4.9 MB) is not committed, so the statements in the blocker tree are tested
  only where `testdata/big/diag/` exists; `DeadlockSession` has no sql_id, so a deadlock's statement has no
  jump to a 10046 tab; the real Electron window, Windows and Linux were not tried; no version but 19c.

