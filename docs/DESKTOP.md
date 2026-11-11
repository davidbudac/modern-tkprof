# mtkprof desktop app: user guide

The desktop app opens Oracle 10046 trace files, one tab per trace, with the mtkprof engine running
next to it. It shows the same views as `mtkprof serve` (Overview, Statements, Waits, I/O map,
Timeline, Sessions, Pivot) plus the **Lines** viewer. A file of optimizer trace dumps (event 10053)
opens in a tab of its own with the **10053** view (see "The 10053 view"). A *Tools ▾* menu follows after a divider: **Notes** and
**Reports** are tools of the tab, not views of the trace; while one of them is on screen the menu
button names it (*Notes ▾*) and is marked as the current page. Saved Pivot configurations, an
**Assistant** chat and **Connections** for fetching traces from other machines complete it.

It is an Electron shell around the `mtkprof engine` process (`docs/ARCHITECTURE.md` § Engine mode); the
code is in `desktop/` (build, dev mode, CI: `desktop/README.md`). Internal team tool: builds are
unsigned; the app checks the releases page for updates (see "Updates").

## Install

Download the installer for your system from the
[releases page](https://github.com/davidbudac/modern-tkprof/releases) of this repository (from
v0.5.0, with the CLI binaries of the same `v*` tag; v0.3.1 and earlier on the archived
[mtkprof-desktop releases page](https://github.com/davidbudac/mtkprof-desktop/releases)), or make a
local build (`desktop/scripts/ci-local.sh`).

| System | File | Notes |
|---|---|---|
| Windows 10/11 x64 | `mtkprof_<version>_x64-setup.exe` | per-user install, no admin rights |
| macOS Apple Silicon | `mtkprof_<version>_arm64.dmg` (`_aarch64` up to v0.6.0) | drag to Applications |
| macOS Intel | `mtkprof_<version>_x64.dmg` | drag to Applications |
| Linux x64 | `mtkprof_<version>_*.AppImage` or `.deb` | |

The builds are not signed, so the first start needs one extra step:

- **Windows**: SmartScreen says "Windows protected your PC". Click *More info*, then *Run
  anyway*. Only the first start asks.
- **macOS**: Gatekeeper says "mtkprof.app" Not Opened ("Apple could not verify…"). Click
  *Done*, open System Settings → Privacy & Security, scroll to Security, click *Open Anyway*
  next to "mtkprof.app was blocked", then *Open Anyway* again and confirm with your password.
  Only the first start asks. (Right-click → *Open* no longer does this since macOS 15.) Or, in a
  terminal: `xattr -dr com.apple.quarantine /Applications/mtkprof.app`.
- **Linux**: AppImage: `chmod +x mtkprof_*.AppImage`, then run it. It needs FUSE 2
  (`sudo apt install libfuse2` on Ubuntu 22.04+). deb: `sudo apt install ./mtkprof_*.deb`.

Updates are installed by hand (see "Updates"). *Settings → About* shows the app version and opens
the releases page.

## First start

The app starts its engine (`mtkprof-engine`, the sidecar), which listens on `127.0.0.1` on a
free port with a random token per run. Nothing else on the machine can use it.

The **engine dot** at the top right of the window shows the engine state: green when *ready*,
amber while *starting…* or *restarting…*, red when *failed*. Clicking it opens a popover with the
state, the number of open traces, the index cache usage, the restarts since the app started and
the engine's uptime, plus *About* (goes to Settings, opens its About rollout and scrolls to it)
and, with dev tools, *Kill engine*. A one-line bar at the bottom of the window (*engine
starting…*, *restarting…* or *failed*, with *restarts N* after automatic restarts) appears only
while the engine is not ready.

Parsed traces are kept in the **index cache**, so the same file opens again in about a second
(see "Index cache").

## Opening traces

The **+** tab is the open screen. Its buttons and the paths box sit in a dashed drop zone (it
says *Waiting for the engine…* until the engine is ready).

- *Open files…* (one or more `.trc` files) or *Open folder…*. The files picked together open as one
  trace set in one tab, like `mtkprof report a.trc b.trc`; the engine follows `TRACE CONTINUES IN
  FILE` chains, so a set can hold more files than you picked. A folder is not opened at once: see
  "Choosing from a folder" below.
- Drop files or folders anywhere on the window (several at once: one set; a folder lists first). On this screen a drop
  opens with the **Options** shown below, exactly as the buttons and the paths box do; on any other
  screen (a tab, Settings, ...) it opens with the default options from Settings. The drop overlay
  says which ("Opens with the options above" / "Opens with the default options"). *Follow* is for
  one file: dropping several paths with follow on opens them as a plain set and a notice says so.
  The options on this screen start from the Settings defaults every time the screen is shown, and
  are not saved. Files handed to the app from outside, and the Connections page, always use the
  Settings defaults.
- *Or paths*: type or paste paths (one per line for several; a folder lists first).
- **Options** (a rollout under the drop zone, folded; its summary shows the choice, e.g.
  *Options · binds kept · follow*): bind values, a *keep · redact · none* button group: *keep*
  (default), *redact* (replaced by a salted hash; a *Salt* field appears, and the same salt gives
  the same hashes across opens) or *none* (dropped). *Follow as it grows* opens one file as a
  **live** session that updates while Oracle writes it.
- **Recent**: the last 20 trace sets with their options. Click to open again, × to forget. A
  single file shows `1 file · <its folder>`, a folder `N files in <folder>`, a set the file count;
  a folder is marked with a folder icon, and clicking it lists the folder again.

**Choosing from a folder.** A folder (from *Open folder…*, a drop, the paths box, Recent or from
outside the app) shows its trace files (`*.trc` directly in it, not in subfolders) in a table
instead of opening them, with what a quick read of each file found: *From* and *To* (the traced
time, in the trace's own time zone), *Traced* (the span), *Sessions* (`sid.serial#` and module; the
tooltip lists every session with module, action, client id and service), *Size*, and under the
name the instance, process id and version, plus tags for a chain (*continued from*, *continues
in*), *truncated* and *no SQL trace*. The quick read looks only at the header, the `***` lines and
the first and last `tim=`, at disk speed; rows say *reading…* until theirs is in. Nothing is opened
yet.

- Sort by a column header (newest first by default); filter by name, session, module, action,
  client id, service or instance; *Only SQL traces* (on) hides files without SQL trace lines, such
  as an ADR folder's background process traces. A file of optimizer (10053) dumps is not one of those: its
  row is tagged *10053* (*10046 + 10053* when one session wrote both events to it) with the number of dumps,
  and the tooltip lists their sql_ids; it has no traced time, because a dump carries no `tim=`. A 10053 file
  opens in its own tab, also when it is selected with 10046 files (*Open N as one trace set* leaves it out and
  says so), see "The 10053 view".
- Select with the checkboxes or a click on the row (Shift-click selects a range; the header box
  selects all shown). The bar at the bottom sums the selection (files, size, from – to).
- *Open N as one trace set* opens the selection in one tab (oldest file first), *Open each in a
  tab* one tab per file; a double-click on a row opens that file alone. The open **Options** of
  the screen apply; follow only when one file is opened.
- *← Open a trace* or Esc goes back (Esc first clears the filter). The folder goes into Recent.

Under the drop zone, with two ready, non-live traces open, a card *Compare two open traces* has
the *Compare tabs…* button (see "Tabs").

From outside the app (each request is one trace set in one tab, opened with the default bind
option from Settings; a set that is already open just gets its tab shown):

- **Double-click a `.trc` file** (the installers register the extension), *Open With → mtkprof*,
  or drop files on the Dock icon (macOS). Files selected together open as one set.
- **`mtkprof open a.trc b.trc` or `mtkprof open dir/`** from a terminal: starts the app if it is
  not running. The CLI finds it with `open -a mtkprof` on macOS,
  `%LOCALAPPDATA%\mtkprof\mtkprof-desktop.exe` (then `%ProgramFiles%`, then PATH) on Windows and
  `mtkprof-desktop` on PATH on Linux; `-app PATH` or `$MTKPROF_DESKTOP` names another one (an
  AppImage, say).
- Paths on the app's own command line (`mtkprof-desktop a.trc`), also when it is already running.
- Linux: the AppImage and .deb do not claim a MIME type for `.trc`, so double-click there needs
  *Open With → mtkprof* or `mtkprof open`.

While a trace opens, its tab shows the progress: the phase (cache lookup, parsing with bytes and
percentage, writing the index), lines and statements so far, and *Cancel*. A trace that was
opened before comes from the index cache at once.

## Making a trace

*Make a 10046 trace* (the book icon, top right; also *How to make a trace* under the open screen's
title) is a cheatsheet of the ways to switch SQL trace on, each with a *Copy* button for its SQL:

- **Common**: your own session (event 10046, `sql_trace`, `DBMS_SESSION`), another session by
  SID and serial# (`DBMS_MONITOR`), and a table of the levels and their named options.
- **Less common**: one SQL_ID in whichever session runs it (`alter system set events 'sql_trace
  [sql: …]'`), by client identifier, by service/module/action, a logon trigger for one user,
  oradebug on an OS process, and every session.
- **Afterwards**: finding the file, reading it over SQL (`V$DIAG_TRACE_FILE_CONTENTS`) without
  access to the server, merging with `trcsess`, and checking that no trace is left on.

Every command was run on Oracle 19.27 (sessions in a PDB) and its trace read back; the notes
record what that showed (privileges needed, what `V$SESSION.SQL_TRACE` shows, whether connected
sessions are picked up, what outlives a restart). The content is
`desktop/src/tracing/recipes.tsx`.

## Tabs

One tab per open trace, named after its file or folder (`name (+N)` for a set of several paths; a
folder icon marks a folder). The tooltip lists the paths and, when the engine opened more files
than you gave (folder expanded, continuation files followed), how many.

There is one header row: the tabs on the left and, on the right, the views of the open trace
(Back / Forward, Overview … Lines, Tools) and the app's pages. The active tab is the trace's
identity: after its name it shows the file count, the file's status (`cut by
max_dump_file_size`, `continues an earlier file`), the response time as a small colour strip and a
▾. Clicking the active tab again opens a popover with the trace's facts (Oracle version and
instance, session, module, wall-clock span, the response profile) and the Files panel toggle. A
banner such as the re-open notice shows as a dismissable amber row under the header.

Switching tabs keeps each trace's selection, filters, time window and Lines position. × (or a
middle click) closes a tab; the cache entry stays.

Right-click a tab (or press the context-menu key / Shift+F10 on it) for its menu: *Move left*,
*Move right*, *Compare with…* (the compare picker with this tab as baseline A), *Close* and
*Close others*; Escape or a click elsewhere closes it. With a tab's title focused,
Alt+Shift+Left / Right (⌥⇧← / ⌥⇧→ on macOS) moves it too; the active tab stays selected and the
trace tab order is saved.

**Compare tabs…** is on the open screen (the **+** tab), in a *Compare two open traces* card that
shows once two ready, non-live traces are open. Choose baseline A and trace B to create a fixed
snapshot of whole-trace SQL, CPU, elapsed time, waits and plan changes (deltas are B minus A).
Source filters are ignored when taking the snapshot. Statement links return to the original tab
and keep its filters; if its content changed or the tab closed, create a new comparison. Snapshot
tabs survive an engine restart but are not restored after quitting the app, and do not offer trace
Lines or report exports.

| Keys (⌘ on macOS, Ctrl elsewhere, unless noted) | Action |
|---|---|
| ⌘W | Close the tab; on a page (Settings, Connections, …) go back to the last tab |
| ⌘T | The open screen |
| ⌘1 … ⌘9 | The views of the trace (⌥⌘← / ⌥⌘→, Ctrl+PageUp / PageDown elsewhere, step through every view) |
| ⌘I | The I/O map (Ctrl+I elsewhere) |
| ⌃1 … ⌃8 on macOS, Alt+1 … Alt+8 elsewhere; ⌃9 / Alt+9 | The tab at that position; ⌃9 / Alt+9 the last tab |
| Ctrl+Tab, Ctrl+Shift+Tab; ⌘⇧] and ⌘⇧[ on macOS | Next / previous tab, wrapping around |
| Alt+← / Alt+→; ⌘[ / ⌘] on macOS; the mouse's back and forward buttons | Back / Forward in the tab's views |
| ⌘J | The assistant's chat panel |
| ⌘, | Settings |

Holding ⌘ (Ctrl) or ⌃ (Alt) for a moment shows each view's or tab's digit. The tab shortcuts do
nothing while the cursor is in a text field, except ⌘W on macOS, which is the app menu's *File →
Close Tab* (the window closes with *Window → Close Window*, ⇧⌘W, or the red button).

- A set of several files has a **Files panel** on the left (collapse it with the tab at its
  edge, or the Files toggle in the trace popover of the active tab). It starts open in Overview,
  Timeline, Sessions and Lines and folded to its edge tab in Statements, Waits, Pivot, Notes and
  Reports; the *▤ N files* chip in the filter row opens it anywhere, and your own open or close
  wins for that view until the tab is closed (that choice is not saved in `workspace.json`). It
  lists the files with their size, lines, contexts and share of time; click one to see only that
  file, Ctrl/⌘-click toggles, Shift-click selects a range. Every view, the statistics and the
  Pivot follow the selection, which shows as a *Files* chip in the filter row under the header (×
  selects all again). The selection is per tab and kept across restarts (`workspace.json`).
- **Active filters** show in a row under the header: the file selection, the selected sessions,
  the time window (and the lane block it came from) and hidden idle waits, a chip each. Click a
  chip's text to go to where it is set (the Files panel, Sessions, the Overview, Waits), × to
  remove that filter; *Clear all* appears with two or more. The row takes no room while nothing
  is filtered. On Overview and Timeline, the dedicated window bar holds the window's Lines, Zoom,
  Statement and clear actions, so the filter row does not repeat the window chip. Calls crossing a
  window boundary count whole; percentages use response time inside the window and can exceed
  100%. Recursive statement totals can overlap too. Pending scope queries show loading feedback
  instead of percentages from the previous selection.
- **Pane state is per tab** and kept across restarts (optional fields next to `files` in each
  `workspace.json` tab entry; older files load with the defaults: everything open): the Files
  panel (open or collapsed, dragged width), the wait-event **details pane** on the right (only in
  Waits and Timeline; leaving them hides it and coming back shows it again with the same event;
  collapse tab at its edge; collapsed, it stays collapsed for the next event until reopened, and
  the tab shows while an event is selected) and the Statements **context pane**. The lib keeps the
  context pane itself (a global localStorage flag), so `desktop/src/workspace/session/paneBridge.ts`
  applies the tab's saved state by pressing its own collapse tab when the pane first shows and
  records the change that follows a click. The Lines hits and bookmarks are not saved. There is no
  pane shortcut.
- A **live** tab (a followed file, *Follow as it grows*, or a remote *Follow*) shows a live badge
  beside its name: `live` and ❚❚/▶ (the snapshot number and its time are in the trace popover).
  The tab keeps one long request open on the engine (`api/doc?rev=N`, the same as the standalone
  `mtkprof serve` UI); each new snapshot (about once a second while the file grows) replaces the
  document, and the view, the selected statement or event, the filters, the time window and the
  Files selection stay. ❚❚ pauses: the tab asks for nothing and keeps showing its document until
  ▶. A tab in the background keeps following (it is current when you come back); closing the tab
  cancels the request. After a failed request the badge says *reconnecting* and retries with a
  growing delay. When the engine stops following (the file shrank or was replaced, the remote
  follow ended, the session was closed) the badge turns to *ended*, the last snapshot stays and
  the banner says why; *Open again* starts a new session.
- **Restore**: on the next start the app re-opens the tabs of the last run (instant, from the
  cache) unless *Settings → Start empty* is on. Live sessions are not re-opened. The tab you had
  open starts first and at most two traces are opened at a time; the others wait as *opening* until
  a slot frees (switching to a waiting tab moves it to the front, closing it cancels it). Opening a
  trace yourself is never queued.
- **Engine restart**: if the engine stops unexpectedly the app restarts it (toast "Engine
  restarted") and re-opens every tab from its paths, the active one first and two at a time; the
  views come back where they were.
- A crash in one tab's views shows an error card in that tab (*Reload*, *Copy details*); the
  other tabs and the frame keep working.

## Views

| View | |
|---|---|
| Overview, Statements, Waits, Timeline, Sessions, Pivot | as in `mtkprof serve`; the document is sliced by the engine, so a 2 GB trace stays light |
| **I/O map** (⌘I) | every physical I/O wait with a block address: one panel per datafile or tempfile, or per object (*Panels*), x = the n-th such wait (*I/O order*) or *Time*, y = the block number (*Display* › *Block axis*: linear, or packed with the empty block ranges collapsed), each mark as tall as the blocks it moved. *Colour* by event, object, object type, schema, tablespace, file, statement, session, latency, read size or *re-reads* (how often the mark's most read block was read in scope, counted over every wait); a click on a legend entry highlights its marks (⌘/Ctrl/Shift-click adds one). *Density* (auto, on, off) draws a layer under the marks that counts every wait in scope, not the sample, into cells of about 4 px: darker where more waits touched (*Display* › *Density*: count waits, blocks or time, square-root or log scale, and hide the marks to see it alone); *auto* shows it while the marks are a sample. Hover a cell where no mark is for its waits, blocks, time, main event and range. Objects are named from a reference bundle (owner, type, partition), else from the trace's own plans; *Import names…* (Objects and Display tabs) gets the bundle without a connection; *Display* chooses whether the schema, the PDB, the partition and the obj# show. Zoom: drag across the map (sideways: time, up or down: that panel's blocks, diagonal: both), ⌘ + wheel at the pointer, `+` / `−`, `0` for the whole range, ← → to pan, a double-click or *‹ Out* to go back; the strip on top shows the whole range with the zoom as a box you can drag. *Use as time window* makes the zoomed range every view's window. The side panel: per object (waits, time, blocks, re-reads per block, how sequential), *Hot blocks* (the blocks read over and over, as ranges of adjacent blocks with their reads per block, time, writes, first and last read and the statements that read them; a click zooms that panel to the range and highlights its marks; sort by re-reads, by the most reads of one block, or by time), per statement and file, latency histograms with p50 / p95 / p99 and blocks per wait per event. Objects, Hot blocks and Statements count every wait in scope ("Exact"), not the marks drawn; when a trace touches more blocks than the engine counts one by one, Hot blocks says so and how often a block it leaves out may have been read. Full scans are diagonals, a sort spill a write stripe then a read stripe, a multipass hash join a sawtooth of re-reads. Hover a mark for its wait, click to pin it (line and statement links); *Display* › *Marks* caps the rows (every k-th above it, "showing 1 in k"; a zoom asks again, so it needs fewer) |
| **Lines** | the raw trace file, paged. Kind colouring, gutter marks of the selected statement, the object at the clicked line, streaming search, jump to time, a file selector for sets |
| **Notes** (*Tools ▾*) | all notes of the trace |
| **Reports** (*Tools ▾*) | what the CLI writes, saved from the tab |

**"line N" links** ("show in trace") open the small **line drawer** at that line, which has *In
Lines tab*; Shift+click goes straight to the **Lines** tab at that line with the object there
highlighted. In Lines, *Bookmark* (or `b`, or a right-click on a line number) in the selected
line's *Actions* menu marks a line; bookmarks are kept per trace across restarts.

**From the timeline to the lines.** In the Overview lanes a click on a block makes its interval
the time window and selects its statement (double-click opens the statement, still filtered to
the block); drag sets any window. A *Window* row above the timeline (also in the Timeline tab)
shows the window and its block, with *Lines* (the Lines tab at the window's first line),
*Statement* and ×. In Lines the window's lines have a band in the gutter, *⇤ start* / *end ⇥*
jump to its ends, and the file picker marks the files that fall in the window. To drill into a
long trace, *Zoom* (in the Overview's window row) shows only the window in the lanes, with finer
blocks to click; a strip above them has *‹ Out* (the previous zoom) and *Reset*. Zooming is only a
view: the window and the filters stay as they are.

**Row flow.** In Statements, each plan has *Table | Flow*. *Flow* draws the plan as rows
flowing from the leaves (left) through each row source to the client (right): a band is as wide
as the rows the step handed up (√ rows by default, *linear* in the legend), its dashed outline is
the optimizer's estimate, and a step's colour is its own time (darker = more in light mode,
brighter in dark mode). Each step reads "self 604 ms · pr 5,612 · pw 276": its time and physical
I/O minus its children's. Hover a step for all its numbers and the link to its STAT line; click
it to light up its path to the client and everything under it (click again or Esc clears). The
choice of view and scale is kept. A plan dumped without row-source statistics stays a table.

**Dialogue.** In Statements, click one execution and switch its detail from *Binds* to *Dialogue*
(the choice is kept): the execution as a sequence diagram. The client's calls go to the server
process, the server's waits go to Disk, TEMP or Others (only the ones used are drawn), the rows go
back as a dashed reply, and the client's gap before each call stands on the client's line. Alike
round trips fold into a *loop × n* frame with its server time and client gaps; a call ten times
slower than its loop (or after a ten times longer gap) stays outside it. A bar under the figure
puts CPU, the waits, the client gaps and the untimed rest to scale, with the time to first row.
Hover a mark for its numbers, click it to pin them with the trace lines.

## The 10053 view

An optimizer trace (event 10053) is the optimizer's log of one hard parse: the statistics it read, the estimates it
derived, the transformations and join orders it weighed. The file holds one *dump* per optimized statement and no
times. A file that holds dumps and no 10046 record opens as a **10053 tab**: the tab, its view and its keys are those
of the file alone, never part of a trace set. The view is a reader: it makes the file navigable and says what its parts
are. It does not compute anything from the costs.

**What opens as 10053.** A file with at least one dump (from a `Registered qb: … (PARSER)` line to `END SQL Statement
Dump`) and no 10046 record. Dropped or opened together with 10046 files, it is left out of the set and a notice says
which file, to be opened on its own; of several 10053 files given together the first opens and the others are named in a
notice. A file with 10046 and 10053 written together by one session (an *interleaved* file) opens as a 10046 trace as
before; see "An interleaved file" below. The file is read with the 19c rules: for another version the header says so
(below).

**Making a 10053 trace.** The app does not turn the event on. Any of these writes the dumps to the session's trace
file (find it as for a 10046 trace, `v$diag_info` › Default Trace File); a statement that finds a shareable cursor
writes nothing, so a statement must be hard parsed (a comment that makes it unique does that):

```
alter session set events '10053 trace name context forever, level 1';
select /* my test */ ... ;                              -- a hard parse; explain plan for … is one too
alter session set events '10053 trace name context off';

alter session set events 'trace[rdbms.SQL_Optimizer.*]';  -- unified tracing, 11g+; same format; '… off' stops it

exec dbms_sqldiag.dump_trace(p_sql_id => '…', p_child_number => 0, p_component => 'Optimizer', p_file_id => 'mytest')
```

`DBMS_SQLDIAG.DUMP_TRACE` re-optimizes an existing cursor without running it; the environment comes from
`V$SQL_OPTIMIZER_ENV`, so the result may differ from the original parse. Event 10046 on in the same session writes one
interleaved file; switch it off for a file that opens as 10053.

**Layout.** An information bar on top (file name, release, version, number of dumps, lines), the toolbar, then three
columns: the **outline** with the Landmarks and Bookmarks tabs on the left, the **text** in the centre with the
where-am-I path above it and the line map beside its scroll bar, the **Guide** with the SQL tab on the right. A status
bar below the text. When the file is not 19c, the information bar says "read with the 19c rules; this file is 23.6"
and how many lines of the open dump are outside any known section; a dump the file ended inside says "this dump is
truncated: no end line".

**The text.** *Formatted | Raw* (`v`, kept across sessions). *Formatted* is the trace's own lines in file order,
dressed: banners are headings, landmark lines are tinted, noise is folded, the one-line `UNPARSED QUERY IS`
statements are pretty-printed, the plan table can show as a plan, terms from the trace's legend have a dotted
underline and a card on hover. Nothing is re-rendered as a table of numbers. *Raw* is the open dump's lines
untouched (dump 1's lines include the file prologue). Line numbers are the file's. Click a line to select it
(`↑` `↓` or `j` `k` move the selection; `g` and `Shift+G` go to the first and last line of the dump).

**Folds.** Closed by default, each showing its line count and reason: the parameters with default values, the optimizer
state dump (its fix controls are a fold inside it), the adaptive plan's re-costing, a costing run whose text repeats
an earlier one ("same as run 2"), the statement text repeated, a repeated `UNPARSED` statement. Click the ▸ or the row,
or press `z` on the selected line, to open or close one; `Shift+Z` or the *Unfold all* button opens every fold, and the
button then reads *Default folds* and brings the defaults back. The status bar says how many folds are closed and how
many lines they hide. A jump to a hidden line (a search hit, a landmark, a bookmark) opens the folds around it.

**The outline** (left, tab *Outline*; *All | Runs*). The dumps of the file are its top level: sql_id, *dump N* (and
*#2* when a sql_id appears twice), the first words of the statement, the tables, the line count and the plan hash; a
*truncated* tag; the number of search hits. One dump is open at a time; click another to open it. Under the open dump
are its sections in file order, full depth: phases (Environment, Transformations, Costing, Result), query
transformations, each cost-based search with its iterations, each **costing run**, then its tables, join orders and join
steps. Every row shows its line count (the tooltip adds the lines); a click goes to its first line and opens it; ▾ and
▸ fold the outline. A run shows its iteration's verdict ("GBP: Updated best state, Cost = 384.608830", green dot if kept,
grey if not), a **final plan** tag for the run costed after *Final query after transformations*, and **same as run N**
for a run whose text equals an earlier one, addresses and memory figures ignored (this compares text, not numbers). A
join order shows its tables and its own result from the trace (`cost: 453.647906` or `aborted`) and a **best** tag on
the one the run's *Best join order* names; a table shows its *Best:: AccessPath*, a join step its *Best:: JoinMethod*.
The outline is in file order, so the runs of one query block are not adjacent (a block is costed once per iteration
that holds it); *Runs* lists the runs alone, in file order. With a search on, each row shows its hit count.

**Where am I.** Above the text a path of links names the sections that hold the first visible line (or the selected
one): dump › Costing › SEL$1BA63A14 run 3 of 9 › Join order 7 › Now joining: MTK_CUST. Click a part to go to its start.
The line number is at the right end.

**The line map** beside the scroll bar draws the dump: phases as bands, landmarks as ticks at the left edge (green kept,
grey rejected, red problems), search hits at the right edge, bookmarks, and the visible range as a box. Click or drag on
it to go there.

**Landmarks** (left, tab *Landmarks*). Key lines in the trace's words: *Updated / Not update best state* and *Will not
…* (verdicts), *Final cost for query block*, *Best:: AccessPath*, *Hint with an error*, *Best:: JoinMethod*, *Join
order aborted* and *Bypassed or refused transformation*. Each kind has a switch with its count; the list below shows the
lines of the kinds that are on, grouped by kind, with the line number, the line and where it is. All are on except the
refusals (one line per transformation per query block, in the hundreds). A kind that is off is not tinted, not on the
line map and not stepped through. The switches are kept across sessions. `]` and `[` (or the *Landmark* arrows in the
toolbar, which also show "3 / 232") step to the next and previous landmark of the kinds that are on; `r` and
`Shift+R` step to the next and previous **costing run**.

**Search.** The box in the toolbar searches the open dump (literal; `.*` makes it a regular expression, `Aa` matches
case), shows "3 / 41", and tints the hits in the text, on the line map and in the outline's counts. `/` or `⌘F`
(`Ctrl+F`) focuses it, `Enter` or `F3` goes to the next hit, `Shift+Enter` or `Shift+F3` to the previous, `Esc` returns
to the text. An invalid expression says *invalid*. The whole dump is searched in the browser, hidden lines included.

**SQL** (right, tab *SQL*). Every `UNPARSED QUERY IS` statement of the dump, pretty-printed, in the order of the file,
each with its line, its label (what the trace calls it, for example *Final query after transformations*) and its size,
or "same as N" when it equals an earlier one. *Show in text* goes to its line. *Diff* shows it against the previous
statement of the dump (it is often another query block's text) as lines out and in; the *Against* menu picks another
earlier version. In the text, the header line of each statement has a *diff with line N* button that opens this tab on
the diff.

**The plan.** The dump's `Plan Table` shows as a plan in the text: the operations indented by depth with Rows, Bytes,
Cost and Time as the trace prints them (`96K`), the query block and object alias and the access and filter predicates
as rows under their operation. *Plan | Text* switches to the trace's own lines; *Open in plan viz ↗* opens the plan,
estimates only (a 10053 plan has no actual rows or times), in the plan visualizer.

**The Guide** (right, tab *Guide*). What the section and the line under the selection are (the first visible line when
nothing is selected): a fixed explanation per kind of section and per kind of line, and the terms on the line from the
trace's own legend. An explanation exists only where a named source backs it (the trace's legend, the format reference
`docs/trace-format-10053.md`); otherwise it says "No guide text for this kind of section". It says what a part is and
how to read it, never what happened in this trace.

**Bookmarks and notes.** `b` (or the bookmark button) bookmarks the selected line; the *Bookmarks* tab lists them with
the path to the line and a note box (Enter saves), × removes one. As in the Lines view they belong to the trace and
are listed in **Notes**; a note's link opens the 10053 tab at that line.

**Keys** (`?` lists them in the view):

| Key | Action |
|---|---|
| `v` | Formatted \| Raw |
| `/`, `⌘F` / `Ctrl+F` | Search |
| `Enter`, `Shift+Enter` in the box; `F3`, `Shift+F3` | Next, previous hit |
| `]`, `[` | Next, previous landmark |
| `r`, `Shift+R` | Next, previous costing run |
| `z`; `Shift+Z` | Open or close the fold at the line; unfold all, back to the defaults |
| `b` | Bookmark the line |
| `↑` `↓` or `k` `j` | Move the selection |
| `g`, `Shift+G` | First, last line of the dump |
| `d` | Next dump |
| `?`, `Esc` | The keys list; close it |

**The 10053 mark and the jump.** A statement of a 10046 tab shows a **10053** mark when another open tab holds a dump
with the same sql_id; clicking it switches to that tab, opens the dump and selects its first line. In the 10053 tab the
dump's row in the outline shows a **10046** link that switches back to the tab with the statement. Nothing is joined:
the two tabs keep their own numbers (a dump has no times; the statement's plan hash in the 10046 trace is the
`plan_hash` of the dump's other_xml section).

**An interleaved file.** A file in which one session wrote 10046 and 10053 together opens as a 10046 trace as before.
Its dumps are no longer counted as unknown lines, and the trace facts (the tab's popover) carry a note: "2 optimizer
(10053) dumps in this file, lines 54-18358 and 18734-27979; not shown as 10053 yet". To read the dumps, produce a file
with the 10053 event alone.

**What a 10053 tab does not have.** The 10046 views (Overview … Pivot, the I/O map, Lines), the Files panel, filters
and time window, Cut, Compare, saved pivots and the assistant: a dump has no calls, waits or times, and the assistant
and `mtkprof mcp` do not open 10053 files. The Reports page of the tab (Tools menu) writes the 10053 text digest and the
standalone HTML (below), not the 10046 reports.

**Reports.** `mtkprof report file.trc` (and the text report in the Reports view) prints the **digest**: the trace
without its noise, nothing computed. Per dump, the sql_id and the statement as typed, the altered parameters and fix
controls, the peeked binds, the outline with line numbers and line counts, the landmark lines verbatim with their line
numbers, each version of the transformed SQL pretty-printed, the final plan with its predicates and the hints with
their flags. `mtkprof html file.trc` (and *Open standalone HTML*) writes one HTML file with the same view fed with the
digest: the lines of the digest are in it and nothing else, so the text says "1,234 lines not in this report (lines
2032-3265)" where lines are missing, and search reads the lines in the report only. `-redact-binds` and `-binds none`
apply to the bind sections (*Bind Info*, *Peeked Binds*) as to 10046 binds; literals in the SQL text and in the
predicates stay. `mtkprof lint file.trc` lists the 10053 line kinds and the dumps (line range and sql_id).

## Notes and bookmarks

Notes belong to a trace's content (its identity), not to its file name: the same trace opened
from another path, re-fetched under another name or opened with other bind options shows the same
notes. They are stored in `annotations.json` in the data folder (see "Files").

Unsaved work survives switching tabs, visiting a page and collapsing the assistant: the text of an open note editor, an unsent chat message and the Statements list's search, sort and *no SYS* are kept in memory with the tab, and are never written to disk, so they are gone when the tab is closed or the app quits.

| Note on | How | Matched by |
|---|---|---|
| Statement | *✎ Add note* next to *Copy SQL* in a statement's detail; the note shows under the title (with a *✎ note* tag) and survives a re-parse | sql_id and SQL text |
| Execution | the ✎ column of the executions table (lit when the execution has a note) | cursor line and execution number |
| Time window | set a window (drag in the minimap or the timeline), then *✎ Annotate window* in the Timeline, with an optional label. Window notes are chips above the timeline; a click applies the window | start and end |
| Line | *Note…* in the selected line's *Actions* menu in Lines (also bookmarks the line); the side panel's *Bookmarks* tab shows the notes, the gutter marks noted lines with ✎ | file and line |
| Line of a 10053 file | `b` in the 10053 view bookmarks the selected line; the *Bookmarks* tab of its left panel has a note box per bookmark | file and line |

The **Notes** view of a tab lists them with links (statement → its detail, execution → its row,
window → the Timeline with the window applied, line → the Lines view), edit and delete.

- *Export ▾ → Markdown…*: a readable summary grouped by kind (trace name, identity, times).
- *Export ▾ → JSON…*: `{version: 1, identity, trace, annotations: [...]}`.
- *Import JSON…*: merges such a file into this trace's notes (same id: the newer one wins). A
  file written on another trace also works: statements match by sql_id and text, lines and
  windows by number.

## Reports

The **Reports** view of a tab saves what the mtkprof CLI writes for the trace, produced by the
engine: the text report (sort, top N, executions, bind sets, recursive SYS statements, width),
the JSON document, the CSV files (one zip) and the standalone HTML report. The text report's
settings are in an *Options* rollout under it (folded; its summary lists the current values, e.g.
*Options · sort elapsed · top 0 · 20 executions · 5 bind sets · width 120 · SYS on*; *Defaults*
resets them). *Save…* asks where (the downloads folder first, named after the trace); large files
are streamed to disk. *Open standalone HTML* writes the report to `reports/` in the app's cache
folder (see "Files") and opens it in the default browser. Errors show under the list.

A live session's model is the aggregate one: its text report has no executions tables ("bind
sets 0" in the Volume line) and its JSON/HTML documents have no fact tables. Use the CLI on the
file for those.

## Cut

The **Cut** view (Tools menu) writes a new trace file from a part of the trace: the calls in the
time window and the sessions or files selected (*Calls in the window*), or one statement's calls
(*One statement*). With several files and no window it joins them into one file, like `trcsess`
but keeping every header line and session marker.

A cut never splits a call: a window edge inside a call keeps the whole call (the time strip
hatches what that adds), and each call keeps its waits, binds and recursive SQL. What the kept
lines need from elsewhere comes with them: the file header, the session markers in force, the SQL
text of the cursors they use and their plans. The map shows where every block of the new file
comes from: the source on the left, the new file on the right, a band between them per block,
colored kept, borrowed from before the cut, borrowed from after it, or generated. Hover a block,
a band or a label to see its lines and why it is there; *Show in Trace* opens the source lines.

Drag on the time strip to set the window (it is the window every view shows; *whole trace*
clears it). Options: *Whole executions* widens to every call of a kept call's execution; *Bind
values* Keep, Mask (each value becomes a token of its type, length and a hash, equal values
keep equal tokens: for sending the file to someone) or None; a tab opened with redacted values
offers only Mask and None. *Plans from outside the cut* and *Provenance lines* (a few
`mtkprof cut:` lines in the header saying where the file comes from) can be turned off.

*One statement* picks from every statement with calls, longest first; type a sql_id or part of
the SQL text to find one. While a changed selection is planned, the map shows the previous plan
dimmed with *Planning…*, and *Save as…*, *Open as new tab* and the check wait for the new plan.
In a live tab every new snapshot is planned again the same way; a check you asked for (a big
cut) is not re-run by itself on the next snapshot.

The side panel's *Re-parse check* writes the file, parses it back and compares its calls, waits
and wall clock with the selection: a tick means the file holds exactly what the map shows. It
runs by itself for a new file under 256 MB; a bigger one is checked when you ask (the engine
refuses an unasked check over 1 GB). *Save as…* asks where; *Open as new tab* writes it to
`cuts/` in the app's cache folder and opens it.

**Cuts folder.** `cuts/` in the app's cache folder belongs to the app: every *Open as new tab*
writes a file of its own there, `<trace>-cut-<yyyymmdd-hhmmss>.trc` (`-2`, `-3` for a second
cut in the same second), so an earlier cut's tab keeps its file and its results; the file is
written whole under a temporary name first. On start the app deletes the files of the folder
that no open tab and no recent entry references and that are older than 7 days. Save a cut you
want to keep with *Save as…*.

## Saved pivots

Saved Pivot configurations, shared by all traces. In a tab's Pivot view, *Saved ▾ → Save current
as…* stores the fact table, dimensions, sort, row limit and the scope: the time window (as an
offset from the trace start), the session-context filter, the statement and event filters and
the idle toggle. Choosing a saved one in any tab applies it; what that trace does not have (a
session, a statement, an event, a window past its end) is left out and the Pivot view says so.

*Manage…* in the same menu renames (click the name), deletes, and offers *Export…*
(`mtkprof-library.json`, `{version: 1, pivots: [...]}`) and *Import…* (same id: the newer one
wins). The list (the library) is kept in `library.json` (see "Files"). The library is exported on
its own; the connections file does not include it, a backup (*Settings → Backup*) does.

## Assistant

The desktop app configures `mtkprof mcp` as a bridge to the open trace when
it launches a CLI assistant. No separate MCP registration is needed. To use
the tools from your own client without the desktop app, see the
[MCP guide](MCP.md).

*Settings → Assistant* sets up the model providers the assistant talks to, and shows the CLI
agents the engine can run.

- **OpenAI-compatible**: a `/chat/completions` endpoint (OpenAI, vLLM, Ollama, LM Studio,
  LiteLLM, ...). Base URL up to the version (`http://localhost:11434/v1`), a model, *API key* or
  *no key*, and extra headers (`Name: value` per line).
- **Claude Code**: the `claude` CLI with its own login. It runs in an empty temp directory with
  no tools but mtkprof's (through `mtkprof mcp`), none of your Claude settings, and writes no
  transcript. Model: empty for the CLI's default.
- **Codex** (*Experimental*): `codex exec` with your own Codex home; see "Codex notes" below.
  Sign-in: the CLI's own login, or an OpenAI API key asked like any key (passed to codex as
  `CODEX_API_KEY`).

*CLI agents* lists `claude` and `codex` as the engine finds them on its PATH: version, login
state and path, or *not found*. On macOS and Linux the app starts the engine with your login
shell's PATH (`$SHELL -l -i -c`, 3 s at most) plus `/opt/homebrew/bin`, `/usr/local/bin` and
`~/.local/bin`, so a CLI your terminal finds is found when the app was started from the Finder
or a launcher too.

*Test* runs one short conversation ("reply OK") on the open trace (the tab Settings was opened
from, else the first one) and ends it: it passes when the model answers. With no trace open it
is off. It asks for the key when none is held. A CLI test runs one turn of the CLI (codex: about
70 to 90k input tokens).

### The chat panel

**⌘J** (Ctrl+J elsewhere) or *Assistant* in the top row opens the chat beside the views of the
tab; it is per tab, closed by default, and its dragged width is kept with the tab's panes in
`workspace.json`. Pick a provider: those of Settings, then the `claude` and `codex` CLIs the
engine found (with their own login; Codex is marked experimental).

- The first message about a trace to a provider shows what leaves the machine and asks; nothing
  is sent before *Agree and send*. The answer is remembered per trace (content identity) and
  provider.
- Answers stream in. Each tool call is a row: its arguments and, opened, exactly the text the
  model was given. Under each answer: the tokens in, cached and out; the chat's total is above
  *Send*. *Stop* ends the turn and keeps what came so far.
- Answers are Markdown rendered by the app itself (no HTML: markup in an answer shows as text).
  Only `https:` links open (in the browser) and `mtkprof:` links become chips. A chip opens what
  it cites in the views (a statement, an execution, a wait event, a time window, sessions, a
  trace line) as a click in the views would, so Back returns; one this trace has nothing for
  shows as dashed text marked `?`.
- *Show me*: when you ask the assistant to show something, it calls the `show` tool and the app
  moves the tab's views there as a chip would, after it has kept the views as they were in the
  tab's history. The chat row says *Moved by the assistant* with **Back** (⌘[ too); Back is on
  the latest move only, while the views still stand where it left them. A Pivot is set from the
  intent (fact, dimensions, measure, the one statement or event). With *Settings → Assistant →
  Ask before moving the view* on, the row stays a chip (*Asked to show*) and the views move on
  your click. A place this trace does not have leaves the views alone and shows as *Could not
  show … Not in this trace: statement*. An intent moves only the tab the question was asked in,
  and only while that tab still shows the trace the chat is about.
- **Save as note** under an answer attaches it, as a note (with *From the assistant (provider)*
  on top and the links as their labels), to the statement, execution or time window its links
  name; a menu lists them when it names several, and it is off when it names none. A place that
  has a note gets the answer after it, and saving the same answer twice changes nothing. The
  notes are the ones of *Notes*: kept per trace in `annotations.json`.
- The chat of each trace is kept in `assist.json` (by content identity, the 30 most recently
  used traces), never in a backup. A live trace's chat lasts until the tab closes. *New chat*
  starts over. When the engine's conversation is gone (engine restart, idle session closed,
  another provider), the next message starts a new one carrying the earlier questions and
  answers.

### Privacy and security

- Nothing about a trace is sent to a provider until you agree, once per trace and provider.
  *Test* is a send you start yourself: the provider sees the trace's file names and may call the
  analysis tools on it.
- Bind values are masked by default (*Bind values sent to the assistant*: each value becomes its
  type, length and a hash salted per conversation; the same value matches within one
  conversation). *keep* sends them as traced. SQL text, literals included, is never masked.
- The model reads the trace only through mtkprof's analysis tools, and the chat shows every tool
  result it was given.
- A provider definition holds no secret. A header whose name looks like a credential (auth, key,
  token, secret, password, cookie) or whose value starts with `Bearer`/`Basic` is refused, and so
  is a base URL with a user, a query or a fragment: the key goes through the key prompt.
- The key prompt asks for a provider's API key on first use. In the app, *Remember in keychain*
  (on by default) stores it encrypted in the app's data folder (`secrets.json`), with the
  encryption key in the OS keychain (Keychain on macOS, DPAPI on Windows, the Secret Service or
  kwallet on Linux), account `assist:<provider id>`. The app's shell reads it there and answers the engine itself, so a
  stored key never reaches the web page, `settings.json`, a backup or a log. Unchecked, the key
  lives only in the engine's memory until the engine stops. With no keychain (Linux without a
  Secret Service) the prompt says so and the key is kept in the app's memory until it quits.
- *Forget key* drops the key from the engine and the keychain. A key the provider refuses during
  *Test* is forgotten; so is the key of a provider whose base URL, kind or sign-in changes, or
  that is removed.
- Provider ids are random, so a remembered key never answers for a new provider. A key is also
  bound to the endpoint it was typed for (the provider's kind and base URL): the shell reads the
  open prompt from the engine and answers only when its endpoint matches, else the prompt asks.
  The engine holds a typed key the same way.

### Codex notes

Codex runs with your own `~/.codex` (`CODEX_HOME`), so mtkprof confines it per run:

- It is labelled experimental.
- Every MCP server in your `config.toml` is switched off by name (the file is read, never
  written, before each run, so a server you add later is switched off too); plugins, hooks,
  `view_image`, image generation, multi-agent, web search and the shell are disabled; the
  sandbox is read-only and the approval policy is forced to *never*, so file writes are
  rejected. mtkprof's own server is the only one left.
- Your `~/.codex/AGENTS.md` instructions still apply to mtkprof's runs.
- mtkprof never reads, copies or links `auth.json`; codex uses its own login.
- `--ephemeral` keeps trace data out of `~/.codex/sessions`, so each turn resends the
  conversation so far.
- A codex turn costs about 70 to 90k input tokens before any trace data (claude: about 7k).

## Connections

*Connections* (the plug icon, top right) keeps ssh hosts and Oracle logins for fetching traces.
Its toolbar has *+ Add ▾* (*ssh host*, *Oracle database*, *Import from file…*), *Team file ▾* and
*Export…*; with none yet, the page also offers *ssh host*, *database* and *Import…* in the middle,
each explained. Details of the protocol, grants and what was verified:
[`docs/REMOTE.md`](REMOTE.md).

**No secrets at rest.** A definition has no password field. Passwords, key passphrases and
one-time codes are asked when a connection is used (a dialog; an unknown ssh host key shows its
fingerprint). A password or passphrase is asked once per connection per run and kept only in the
engine's memory until the app quits, the connection is deleted or you choose *Forget
credentials*. One-time codes and host-key answers are never kept. After an engine restart,
credentials are asked again. Nothing from a prompt is logged.

A prompt stays on screen until the engine has taken the answer. While it is being sent the card is
greyed (*Sending...*); if the answer could not be delivered (the engine is busy or gone, a network
error) the card stays with the error, the field kept, and offers *Retry* (the same answer) and
*Cancel*. If the prompt turns out to be gone already (answered elsewhere, timed out) it just closes.
An assistant API key is typed to the engine first and put in the keychain only once the engine
accepted it, so a failed delivery stores nothing.

### ssh

- *Test* runs `uname -sr`.
- The remote browser lists the trace directories it finds (`$ORACLE_BASE`, the homes in
  `oratab`) and any directory you type.
- Select files and *Fetch*: gzip in transit, resumes a partial local copy; *open when done*
  opens the result (a set as one tab). Files go to `remote/<connection>/` next to the index cache
  folder (see "Files").
- *Follow* one growing file: a **live** tab; closing the tab stops the follow.

| Transport | What |
|---|---|
| `auto` (default) | the system `ssh`/`sftp` (your `~/.ssh/config`, agent, bastions, ControlMaster); falls back to the built-in SSH for the rest of the run if `ssh` ignores askpass |
| `cli` | the system ssh only |
| `lib` | the built-in SSH only. Reads `Host`, `HostName`, `User`, `Port`, `IdentityFile` from `~/.ssh/config`; no `ProxyJump`, `Include`, `Match` |

**Windows**: Windows 11's `ssh.exe` is reported to ignore `SSH_ASKPASS`, so `auto` may switch to
the built-in SSH. This is implemented and tested with a fake ssh, not yet confirmed on a real
Windows 11 machine (`docs/REMOTE.md` § Open). On a Windows OpenSSH *server* only the built-in
SSH can list and fetch; diag and follow need a POSIX shell.

### db (Oracle login, no OS access needed)

- *Test* shows the version and ADR home.
- *Sessions* lists `V$SESSION` with *Trace on/off* (waits, binds, plan_stat) through
  `DBMS_MONITOR`.
- *Trace files* lists the ADR's files, with *Fetch*. The ADR view is slow (about 0.4–1 MB/s; a
  117 MB trace took 301 s on the lab): the job says when a fetch passes ~200 MB; fetch anything
  over that over ssh. A file listed but returning no lines belongs to a container the user cannot
  see.
- *Fetch reference data* runs the `refscript` queries for an open trace and applies the result
  to its tab (object, datafile and user names, plans). *Apply bundle from directory…* takes a
  bundle made by `mtkprof refscript` + SQL*Plus. *Paste script output…* needs no connection: the
  Import names dialog (below). The bundle is kept per trace identity, applied to every open tab of
  the trace and re-applied whenever the trace is opened.
- Username/password over TCP or TCPS. No sysdba, wallet or Kerberos. Grants needed:
  [`docs/REMOTE.md`](REMOTE.md) § Privileges. Without `SELECT_CATALOG_ROLE`, reference data falls
  back to the `ALL_` views for objects and users (the job message lists what was skipped).

### Import names (no connection)

Object, datafile and user names (and, if asked, plans) from a script you run yourself: the dialog
opens from the I/O map (*Import names…* in the Objects and Display tabs), the statement inspector
(an obj# without a name) and Connections › Reference data › *Paste script output…*.

1. *Copy script* or *Save names-<trace>.sql…* (*Execution plans too* adds DBMS_XPLAN). It is
   one read-only PL/SQL block; run it in SQL*Plus, SQLcl or SQL Developer (Run Script) as any
   user: without `SELECT_CATALOG_ROLE` it reads the `ALL_` views and says so.
2. Paste everything it printed (or *Open saved output…*); the dialog counts what it found and
   warns when the copy looks cut off. *Apply names* (⌘↩) sends it to the engine, which adds it to
   the trace's kept bundle (a pasted name replaces the kept one, the rest stays) and reloads the
   tab, and every other tab of the same trace. The tiles on top show how many of the trace's objects, datafiles, users and plans are
   named; the script's notes (what it could not read) are listed under the result.

The format: [`docs/REF-BUNDLE.md`](REF-BUNDLE.md) § Paste.

### Jobs, sharing, team file

- **Jobs** (bottom right of the Connections page): fetches, follows and reference-data runs, with
  progress, cancel and *Open*.
- **Export…** writes `mtkprof-connections.json` (`{"version": 1, "connections": [...]}`, no
  secrets). **Import…** adds a file's definitions (same id: replaced).
- **Team file** (the *Team file ▾* popover in the toolbar: its path or *none*, *Choose…*,
  *Clear*; e.g. a file in a shared repo checkout): re-read every 5 s and merged read-only (*team*
  badge). *Override locally* copies an entry so you can edit it; *Revert to team* drops the copy.
  Problems in the file are listed in the popover (the button shows a *!*); a broken file keeps the
  last good list.

## Settings

Sections, in this order, each with its actions inside it:

| Section | What it holds | Applies |
|---|---|---|
| Opening traces | the default bind values (keep · redact · none) and salt of the open options; *Start empty* (do not re-open last run's tabs) | next open; next start |
| Appearance | Theme: System, Light or Dark | at once |
| Assistant | bind values sent (mask · keep); *Ask before moving the view*; providers with *Test*, *Forget key*, *Edit*, *Remove*; the CLI agents found (see "Assistant") | at once |
| Engine | Cache location (*Change…* picks a folder, *Default* resets), cap (GiB) and plan visualizer URL (where *Open in plan viz* sends plans), *Restart engine*; then the facts: version and protocol (and the protocol the app speaks), binary, listening address, status, uptime | location, cap and URL after *Restart engine* |
| Index cache | usage bar, *Refresh*, *Wipe cache…*; a folded rollout with the entries and *Remove* (see "Index cache") | at once |
| Backup | export and import of connections and the library (below) | at once |
| About (a folded rollout) | app version, the data and log folders; *Check for updates on start*, *Check now* (or *Download*), the releases page | at once |

*Restart engine* restarts the engine with the new settings; open tabs re-open from the cache.

### Updates

From the first release after v0.5.0 the app asks the [releases page](https://github.com/davidbudac/modern-tkprof/releases)
for a newer version a few seconds after every start (turn it off in *Settings → About → Check for
updates on start*). When there is one, a note at the bottom right offers:

- **Download**: opens that release's page; install the installer for your system over the app
  (your tabs, settings, notes and connections stay). The app does not install updates itself.
- **Later**: hides it until the next start.
- **Skip this version**: never offers that version on start again (*Check now* still finds it).

*Settings → About → Check now* checks at any time and says what it found. The app needs to reach
github.com; a failed check is only written to the log. v0.5.0 and earlier have no updater:
install the next release by hand once.

**Coming from v0.6.0** (the last build of the old shell): its *Install and restart* moves you to
the new app once, on macOS and Linux; your tabs, settings, notes, connections and index cache
carry over. On Windows install v0.7.0 by hand: its installer removes the old app first (your data
stays). An API key the old app remembered is taken over on macOS the first time it is needed
(macOS asks you to allow mtkprof to use it); on Windows and Linux type it once more.

### Backup

*Settings → Backup* exports connections and the library together
(`mtkprof-desktop-backup.json`, `{"mtkprof-desktop": 1, "connections": [...], "library": [...]}`;
no passwords) and imports such a file with the same merge rules (connection: same id replaced;
saved pivot: same id, newer wins), then says how many came in.

The optional checkboxes apply to both export and import. Selecting any writes version 2:

- Notes and bookmarks for all trace identities; imports merge newer entries and update open tabs.
- Appearance and opening defaults: theme, bind mode and start-empty preference.
- Workspace path references. Imported references appear in Settings with an explicit
  **Open reference** button; they never open automatically and use the current bind defaults.

The default remains version 1 with just connections and pivots. Neither version includes raw
traces or credentials; optional settings exclude redaction salts, cache paths, engine URLs,
team-file paths and the assistant's providers (their URLs and headers). Notes and paths may
themselves contain sensitive information. References point to the original computer, so missing
files must be located there or copied separately.

## Index cache

Parsing a big trace takes time; the result (model, indexes, line index) is kept in the index
cache, so the same file opens again in about a second. An entry is keyed by the file contents
(size and the first MiB of each file) plus the open options, not by path, so a changed file is
parsed again.

| | |
|---|---|
| Default location | `<cache dir>/com.davidbudac.mtkprof/mtkprof`, i.e. Windows `%LOCALAPPDATA%\com.davidbudac.mtkprof\mtkprof`; macOS `~/Library/Caches/com.davidbudac.mtkprof/mtkprof`; Linux `~/.cache/com.davidbudac.mtkprof/mtkprof` |
| Size | about the size of the traces |
| Cap | 20 GiB by default; the least recently used entries are removed beyond it |
| Change | *Settings → Engine → Cache location* / *Cap*, then *Restart engine* |

*Settings → Index cache* shows the usage bar, *Refresh* and *Wipe cache…*, and under them a
rollout (*5 entries*, folded) that lists the entries (the first source file with its folder below,
`(+N)` for a set, the full list in the tooltip; size; last use as "3 h ago" with the exact time
in the tooltip; whether an open tab uses it), removes one, or wipes all (entries in use are
kept).

## Files

| What | Windows | macOS | Linux |
|---|---|---|---|
| settings, workspace, notes, library, connections, assistant chats (the data folder) | `%APPDATA%\com.davidbudac.mtkprof\` | `~/Library/Application Support/com.davidbudac.mtkprof/` | `~/.local/share/com.davidbudac.mtkprof/` |
| logs | `%LOCALAPPDATA%\com.davidbudac.mtkprof\logs\` | `~/Library/Logs/com.davidbudac.mtkprof/` | `~/.local/share/com.davidbudac.mtkprof/logs/` |
| standalone reports (`reports/`) | `%LOCALAPPDATA%\com.davidbudac.mtkprof\reports\` | `~/Library/Caches/com.davidbudac.mtkprof/reports/` | `~/.cache/com.davidbudac.mtkprof/reports/` |
| index cache; fetched traces (`remote/`) and reference bundles (`ref/`) in the folder above it | see "Index cache" | | |

In the data folder: `settings.json` (the settings above), `workspace.json` (open tabs and the
recent list), `annotations.json` (bookmarks and notes per trace, keyed by its content identity),
`assist.json` (the assistant's chat and consents per trace; never in a backup), `library.json`
(saved pivots), `connections.json` (connection definitions, the team file path, last test
results). Nothing in them is secret: a remembered assistant key is in the OS keychain (service
`com.davidbudac.mtkprof`), not here. Deleting them resets the app. *Settings → About* shows the
exact data and log folders, *Settings → Engine* the engine binary. `reports/` can be deleted at
any time.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Toast "Engine stopped, restarting…" then "Engine restarted" | The engine exited unexpectedly. The shell restarts it at once, after 1 s, after 5 s and re-opens the tabs. Credentials are asked again. The cause is in the log. |
| Blocking panel "The engine is not running" | Start failed (no ready line within 10 s), a protocol mismatch, or a fourth crash within a minute. The panel shows the error; *Retry* restarts. |
| `protocol mismatch (engine N, app 1)` | App and engine come from different builds. Reinstall one release; app and engine move together. |
| Linux: the app does not start or exits at once | The AppImage needs FUSE 2 (`sudo apt install libfuse2`). Without a Secret Service (GNOME Keyring, KWallet) the app runs, but a remembered assistant key lasts only until it quits. In a root shell or container Chromium's sandbox fails: run it with `--no-sandbox`. |
| Index cache full or suspect | *Settings → Index cache → Wipe cache…*, or delete the cache folder with the app closed. Everything is parsed again on the next open. |
| Fetch from a database is slow | ADR views read 0.4–1 MB/s. Use an ssh connection for files over ~200 MB. |
| ssh asks for the password again and again | The password was rejected (a wrong one is asked again up to three times), or the engine restarted. |
| Something else | *Settings → About* shows the log folder; the engine's stderr is in the log too. |
