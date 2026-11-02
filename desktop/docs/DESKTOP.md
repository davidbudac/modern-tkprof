# mtkprof desktop: user notes

The desktop app opens Oracle 10046 trace files with the mtkprof engine running next to it
and shows the same views as `mtkprof serve` (Overview, Statements, Waits, Timeline, Sessions,
Pivot, Lines), one tab per open trace. A *Tools ▾* menu follows after a divider: *Notes* and
*Reports* are tools of the tab, not views of the trace. While one of them is on screen the menu
button names it (*Notes ▾*) and is marked as the current page.

## Install

Download the installer for your system from the
[releases page](https://github.com/davidbudac/modern-tkprof/releases) (from v0.5.0; earlier ones on
the archived [mtkprof-desktop releases page](https://github.com/davidbudac/mtkprof-desktop/releases)):

| System | File | Notes |
|---|---|---|
| Windows 10/11 x64 | `mtkprof_<version>_x64-setup.exe` | per-user install, no admin rights |
| macOS Apple Silicon | `mtkprof_<version>_aarch64.dmg` | drag to Applications |
| macOS Intel | `mtkprof_<version>_x64.dmg` | drag to Applications |
| Linux x64 | `mtkprof_<version>_amd64.AppImage` or `.deb` | |

The builds are not signed, so the first start needs one extra step:

- **Windows**: SmartScreen says "Windows protected your PC": click *More info*, then
  *Run anyway*. Only the first start asks.
- **macOS**: Gatekeeper says "mtkprof.app" Not Opened ("Apple could not verify…"): click
  *Done*, open System Settings → Privacy & Security, scroll to Security, click *Open Anyway*
  next to "mtkprof.app was blocked", then *Open Anyway* again and confirm with your password.
  Only the first start asks. (Right-click → *Open* no longer does this since macOS 15.) Or,
  in a terminal: `xattr -dr com.apple.quarantine /Applications/mtkprof.app`.
- **Linux**: `chmod +x mtkprof_*.AppImage` and run it, or `sudo apt install ./mtkprof_*.deb`.
  The AppImage needs FUSE 2 (`sudo apt install libfuse2` on Ubuntu 22.04+).

There is no automatic update: *Settings → About* shows the version and opens the releases page.

## Opening traces

The **+** tab is the open screen:

- *Open files…* (one or more `.trc` files) or *Open folder…* (every trace file in it). The
  files picked together open as one trace set in one tab, like `mtkprof report a.trc b.trc`.
  A folder is passed as it is; the engine expands it (its `*.trc` files, not its subfolders) and
  follows `TRACE CONTINUES IN FILE` chains, so a set can hold more files than you picked.
The buttons and the paths box sit in a dashed drop zone (it says *Waiting for the engine…* until
the engine is ready).

- Drop files or folders anywhere on the window (several at once: one set).
- *Or paths*: type or paste paths (one per line for several; a folder works too).
- **Options** (a rollout under the drop zone, folded; its summary shows the choice, e.g.
  *Options · binds kept · follow*): bind values, a *keep · redact · none* button group: *keep*
  (default), *redact* (replaced by a salted hash; a *Salt* field appears, give one to get the
  same hashes across opens) or *none* (dropped); *Follow as it grows* opens one file as a
  **live** session that updates while Oracle writes it.
- **Recent**: the last 20 trace sets with their options; click to open again, × to forget.
  A single file shows `1 file · <its folder>`, a folder `N files in <folder>`, a set the file
  count; a folder is marked 📁.

Under the drop zone, with two ready, non-live traces open, a card *Compare two open traces* has
the *Compare tabs…* button (see Tabs).

While a trace opens, its tab shows the progress: the phase (cache lookup, parsing with bytes
and percentage, writing the index), lines and statements so far, and *Cancel*. A trace that
was opened before comes from the index cache at once.

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
record what that showed (privileges needed, what `V$SESSION.SQL_TRACE` shows, whether
connected sessions are picked up, what outlives a restart). The content is `src/tracing/recipes.tsx`.

## Tabs

One tab per open trace, named after its file or folder (`name (+N)` for a set of several paths;
📁 marks a folder). The tooltip lists the paths and, when the engine opened more files than you
gave (folder expanded, continuation files followed), how many. There is one header row: the tabs
on the left and, on the right, the views of the open trace (Back / Forward, Overview … Lines, Tools)
and the app's pages. The active tab is the trace's identity: after its name it shows the file count,
the file's status (`cut by max_dump_file_size`, `continues an earlier file`), the response time as a
small colour strip and a ▾; clicking the active tab again opens a popover with the trace's facts
(Oracle version and instance, session, module, wall-clock span, the response profile) and the Files
panel toggle. A banner such as the re-open notice shows as a dismissable amber row under the
header. Switching tabs keeps each
trace's selection, filters, time window and Lines position. × (or a middle click) closes a
tab; the cache entry stays.

Right-click a tab (or press the context-menu key / Shift+F10 on it) for its menu: *Move left*,
*Move right*, *Compare with…* (the compare picker with this tab as baseline A), *Close* and
*Close others*; Escape or a click elsewhere closes it. With a tab's title focused,
Alt+Shift+Left / Right moves it too; the active tab stays selected and trace tab order is saved.

**Compare tabs…** is on the open screen (the **+** tab), in a *Compare two open traces* card that
shows once two ready, non-live traces are open. Choose baseline A and
trace B to create a fixed snapshot of whole-trace SQL, CPU, elapsed time, waits and plan changes
(deltas are B minus A). Source filters are ignored when taking the snapshot. Statement links
return to the original tab and keep its filters; if its content changed or the tab closed,
create a new comparison. Snapshot tabs survive an engine restart but are not restored after
quitting the app, and do not offer trace Lines or report exports.

| Keys (⌘ on macOS, Ctrl elsewhere) | Action |
|---|---|
| ⌘W | Close the tab; on a page (Settings, Connections, …) go back to the last tab |
| ⌘T | The open screen |
| ⌘1 … ⌘8, ⌘9 | The tab at that position; ⌘9 the last tab |
| Ctrl+Tab, Ctrl+Shift+Tab; ⌘⇧] and ⌘⇧[ on macOS | Next / previous tab, wrapping around |
| ⌘, | Settings |

The shortcuts do nothing while the cursor is in a text field, except ⌘W on macOS, which is the
app menu's *File → Close Tab* (the window closes with *Window → Close Window*, ⇧⌘W, or the red button).

- A set of several files has a **Files panel** on the left (collapse it with the tab at its
  edge, or the Files toggle in the trace popover of the active tab). It starts open in Overview,
  Timeline, Sessions and Lines and folded to its edge tab in Statements, Waits, Pivot, Notes and
  Reports; the *▤ N files* chip in the filter row opens it anywhere, and your own open or close
  wins for that view until the tab is closed (the choice is not saved in `workspace.json`). It lists the files with their size, lines,
  contexts and share of time; click one to see only that file, Ctrl/⌘-click toggles, Shift-click
  selects a range. Every view, the statistics and the Pivot follow the selection, which shows as
  a *Files* chip in the filter row under the header (× selects all again). The selection is per
  tab and kept across restarts (`workspace.json`).
- **Active filters** show in a row under the header: the file selection, the selected sessions,
  the time window (and the lane block it came from) and hidden idle waits, a chip each. Click a
  chip's text to go to where it is set (the Files panel, Sessions, the Overview, Waits), × to
  remove that filter; *Clear all* appears with two or more. The row takes no room while nothing
  is filtered.
  On Overview and Timeline, the dedicated window bar holds the window's Lines, Zoom,
  Statement and clear actions, so the filter row does not repeat the window chip.
  Calls crossing a window boundary count whole; percentages use response time inside the
  window and can exceed 100%. Recursive statement totals can overlap too. Pending scope
  queries show loading feedback instead of percentages from the previous selection.
- **Pane state is per tab** and kept across restarts (optional fields next to `files` in each
  `workspace.json` tab entry; older files load with the defaults: everything open). The Files
  panel (open or collapsed, dragged width), the wait-event **details pane** on the right (only in
  Waits and Timeline; leaving them hides it and coming back shows it again with the same event;
  collapse tab at its edge, the lib's `PaneToggle` as in the standalone shell; collapsed, it stays
  collapsed for the next event until reopened, and the tab shows while an event is selected), the Statements
  **context pane**. The lib keeps the context pane itself (a global localStorage flag), so
  `session/paneBridge.ts` applies the tab's saved state by pressing its own collapse tab when the
  pane first shows and records the class change that follows a click (the Lines hits and
  bookmarks are a toolbar menu, not a pane, and are not saved); the standalone shell has no pane shortcut, so
  there is none here.
- A **live** tab (a followed file, *Follow as it grows*, or a remote *Follow*) shows the lib's live
  badge beside its name in the tab: `live` and ❚❚/▶ (the snapshot number and its time are in the trace popover). The tab keeps one long
  request open on the engine (`api/doc?rev=N`, the same as the standalone `mtkprof serve` UI);
  each new snapshot (about once a second while the file grows) replaces the document, and the
  view, the selected statement or event, the filters, the time window and the Files selection
  stay. ❚❚ pauses: the tab asks for nothing and keeps showing its document until ▶. A tab in the
  background keeps following (it is current when you come back); closing the tab cancels the
  request. After a failed request the badge says *reconnecting* and retries with a growing delay.
  When the engine stops following (the file shrank or was replaced, the remote follow ended, the
  session was closed) the badge turns to *ended*, the last snapshot stays and the banner says
  why; *Open again* starts a new session.
- **"line N" links** ("show in trace") open the small **line drawer** at that line, which has *Open
  in Lines* (Shift+click goes straight to the **Lines** tab at that line with the object there
  highlighted). In Lines, *Bookmark*
  (or `b`) marks a line; bookmarks are kept per trace across restarts.
- **From the timeline to the lines.** In the Overview lanes a click on a block makes its interval the time
  window and selects its statement (double-click opens the statement, still filtered to the block); drag
  sets any window. A *Window* row above the timeline (also in the Timeline tab) shows the window and its
  block, with *Lines* (the Lines tab at the window's first line), *Statement* and ×. In Lines the window's
  lines have a band in the gutter, *⇤ start* / *end ⇥* jump to its ends, and the file picker marks the
  files that fall in the window. To drill into a long trace, *Zoom* (in the Overview's window row) shows
  only the window in the lanes, with finer blocks to click; a strip above them has *‹ Out* (the previous
  zoom) and *Reset*. Zooming is only a view: the window and the filters stay as they are.
- On the next start the app re-opens the tabs of the last run (instant, from the cache)
  unless *Settings → Start empty* is on. Live sessions are not re-opened.
- If the engine stops unexpectedly the app restarts it (a notice says so) and re-opens every
  tab; the views come back where they were.

## Connections

*Connections* (the plug icon, top right) keeps ssh hosts and Oracle logins for fetching traces. Its toolbar has
*+ Add ▾* (*ssh host*, *Oracle database*, *Import from file…*), *Team file ▾* and *Export…*;
with none yet, the page also offers *+ ssh*, *+ db* and *Import…* in the middle, each explained. A definition
has no password field: passwords, key passphrases and one-time codes are asked when the
connection is used (a dialog; unknown ssh host keys show their fingerprint) and kept only in the
engine's memory until the app quits or *Forget credentials*. After an engine restart they are
asked again.

- **ssh**: *Test* runs `uname`; the browser lists the trace directories it finds (oratab,
  ORACLE_BASE) and any directory you type. Select files and *Fetch* (gzip in transit; *open
  when done* opens them as one tab), or *Follow* one growing file as a live tab (closing the tab
  stops it). Transport *auto* uses the system ssh (your `~/.ssh/config`, agent, bastions) and
  falls back to the built-in SSH if ssh.exe ignores askpass (reported for Windows 11's ssh.exe).
- **db**: *Test* shows the version and ADR home; *Sessions* lists `V$SESSION` with *Trace on/off*
  (waits, binds, plan_stat); *Trace files* lists the ADR's files with *Fetch*. The ADR view is
  slow (about 0.4–1 MB/s): fetch anything over ~200 MB over ssh. *Fetch reference data* runs the
  refscript queries for an open trace and refreshes its tab; *Apply bundle from directory* takes
  a bundle made by `mtkprof refscript`. Grants: `docs/REMOTE.md` in the engine repo.
- **Jobs** (bottom right): fetches, follows and reference-data runs with progress, cancel and *Open*.
- **Sharing**: *Export…* writes `mtkprof-connections.json` (`{"version": 1, "connections": [...]}`,
  no secrets); *Import…* adds a file's definitions (same id = replaced). A **team file** (the
  *Team file ▾* popover in the toolbar: its path or *none*, *Choose…*, *Clear*; e.g. a file in a
  shared repo checkout) is re-read every 5 s and merged read-only (*team* badge);
  *Override locally* copies an entry to edit it, *Revert to team* drops the copy. Problems in the
  team file are listed in the popover (the button shows a *!*); a broken file keeps the last good list.

## Notes

Notes belong to a trace's content (its identity), not to its file name: the same trace opened
from another path, re-fetched under another name or opened with other bind options shows the
same notes.

- **Statement**: *✎ Add note* next to *Copy SQL* in a statement's detail; the note shows under the
  title (with a *✎ note* tag) and survives a re-parse (it is matched by sql_id and SQL text).
- **Execution**: the ✎ column of the executions table (lit when the execution has a note).
- **Time window**: set a window (drag in the minimap or the timeline), then *✎ Annotate window*
  in the Timeline, with an optional label. The window notes are chips above the timeline; a
  click applies the window.
- **Line**: *✎ Note* in the Lines toolbar notes the selected line (and bookmarks it); the
  bookmarks panel shows the notes, the gutter marks noted lines with ✎.
- The **Notes** view of a tab lists all of them with links (statement → its detail, execution →
  its row, window → the Timeline with the window applied, line → the Lines view), edit and
  delete. *Export ▾ → Markdown…* writes a readable summary grouped by kind (trace name, identity,
  times); *Export ▾ → JSON…* writes `{version: 1, identity, trace, annotations: [...]}`; *Import
  JSON…* merges such a file into this trace's notes (same id: the newer one wins), also one
  written on another trace (statements match by sql_id and text, lines and windows by number).

## Reports

The **Reports** view of a tab saves what the mtkprof CLI writes for the trace, produced by the
engine: the text report (sort, top N, executions, bind sets, recursive SYS statements, width),
the JSON document, the CSV files (one zip) and the standalone HTML report. The text report's
settings are in an *Options* rollout under it (folded; its summary lists the current values, e.g.
*Options · sort elapsed · top 0 · 20 executions · 5 bind sets · width 120 · SYS on*; *Defaults*
resets them). *Save…* asks where
(the downloads folder first, named after the trace); large files are streamed to disk.
*Open standalone HTML* writes the report to the app cache folder (`reports/`) and opens it in
the default browser. Errors show under the list.

## Saved pivots

Saved Pivot configurations, for every trace. In a tab's Pivot view, *Saved ▾ → Save current
as…* stores the fact table, dimensions, sort, row limit and the scope: the time window (as an
offset from the trace start), the session-context filter, the statement and event filters and
the idle toggle. Choosing a saved one in any tab applies it; what that trace does not have (a
session, a statement, an event, a window past its end) is left out and the Pivot view says so.
*Manage…* in the same menu renames (click the name), deletes, and offers *Export…*
(`mtkprof-library.json`, `{version: 1, pivots: [...]}`) and *Import…* (same id: the newer one
wins). The list is kept in `library.json` (see "Where the app keeps its files").

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
team-file paths and the assistant's providers (their URLs and headers). Notes and paths may themselves contain sensitive information. References
point to the original computer, so missing files must be located there or copied separately.

A crash in one tab's views shows an error card in that tab (*Reload*, *Copy details*); the
other tabs and the frame keep working.

## Assistant

*Settings → Assistant* sets up the model providers the assistant talks to, and shows the CLI
agents the engine can run.

- **OpenAI-compatible**: a `/chat/completions` endpoint (OpenAI, vLLM, Ollama, LM Studio,
  LiteLLM, ...). Base URL up to the version (`http://localhost:11434/v1`), a model, *API key* or
  *no key*, and extra headers (`Name: value` per line).
- **Claude Code**: the `claude` CLI with its own login. It runs in an empty temp directory with
  no tools but mtkprof's (through `mtkprof mcp`), none of your Claude settings, and writes no
  transcript. Model: empty for the CLI's default.
- **Codex** (*Experimental*): `codex exec` with your own Codex home; see the notes below.
  Sign-in: the CLI's own login, or an OpenAI API key asked like any key (passed to codex as
  `CODEX_API_KEY`).

*CLI agents* lists `claude` and `codex` as the engine finds them on its PATH: version, login
state and path, or *not found*. On macOS and Linux the app starts the engine with your login
shell's PATH (`$SHELL -l -i -c`, 3 s at most) plus `/opt/homebrew/bin`, `/usr/local/bin` and
`~/.local/bin`, so a CLI your terminal finds is found when the app was started from the Finder
or a launcher too.

*Test* runs one short conversation ("reply OK") on the open trace (the tab Settings was opened
from, else the first one) and ends it: it passes when the model answers. With no trace open it
is off. It asks for the key when none is held. A CLI test runs one turn of the CLI (codex:
about 70 to 90k input tokens).

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
  it cites in the views (a statement, an execution, a wait event, a time window, sessions, a trace
  line) as a click in the views would, so Back returns; one this trace has nothing for shows as
  dashed text marked `?`.
- *Show me*: when you ask the assistant to show something, it calls the `show` tool and the app
  moves the tab's views there as a chip would, after it has kept the views as they were in the
  tab's history. The chat row says *Moved by the assistant* with **Back** (⌘[ too); Back is on the
  latest move only, while the views still stand where it left them. A Pivot is set from the
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
- The chat of each trace is kept in `assist.json` (by content identity, the 30 most recently used
  traces), never in a backup. A live trace's chat lasts until the tab closes. *New chat* starts
  over. When the engine's conversation is gone (engine restart, idle session closed, another
  provider), the next message starts a new one carrying the earlier questions and answers.

### Privacy and security

- Nothing about a trace is sent to a provider until you agree, once per trace and provider. *Test*
  is a send you start yourself: the provider sees the trace's file names and may call the
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
  (on by default) stores it in the OS keychain: Keychain on macOS, Credential Manager on Windows,
  the Secret Service on Linux, under the service `com.davidbudac.mtkprof`, account
  `assist:<provider id>`. The app's shell reads it there and answers the engine itself, so a
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

## Index cache

Parsing a big trace takes time; the result (model, indexes, line index) is kept in the index
cache, so the same file opens again in about a second. An entry is keyed by the file contents
(size and first MiB of each file) and the open options, so a changed file is parsed again.

- Default location: `<cache dir>/com.davidbudac.mtkprof/mtkprof`, i.e.
  `%LOCALAPPDATA%\com.davidbudac.mtkprof\mtkprof` on Windows,
  `~/Library/Caches/com.davidbudac.mtkprof/mtkprof` on macOS,
  `~/.cache/com.davidbudac.mtkprof/mtkprof` on Linux.
- Default cap 20 GiB; the least recently used entries are removed beyond it.
- *Settings → Index cache* shows the usage bar, *Refresh* and *Wipe cache…*, and under them a
  rollout (*5 entries*, folded) that lists the entries (the first source file with its folder below, `(+N)`
  for a set, the full list in the tooltip; size; last use as "3 h ago" with the exact time in the
  tooltip; whether an open tab uses it), removes one, or wipes all (entries in use are kept).

## Settings

Sections, in this order, each with its actions inside it:

| Section | What it holds | Applies |
|---|---|---|
| Opening traces | Bind values (keep · redact · none), salt; *Start empty* (do not re-open last run's tabs) | next open; next start |
| Appearance | Theme: System, Light or Dark | at once |
| Assistant | bind values sent (mask · keep); *Ask before moving the view*; providers with *Test*, *Forget key*, *Edit*, *Remove*; the CLI agents found (see "Assistant") | at once |
| Engine | Cache location (*Change…* picks a folder, *Default* resets), cap (GiB) and plan visualizer URL (where *Open in plan viz* sends plans), *Restart engine*; then the facts: version and protocol, binary, listening address, status, uptime | location, cap and URL after *Restart engine* |
| Index cache | usage bar, *Refresh*, *Wipe cache…*; a folded rollout with the entries and *Remove* | at once |
| Backup | export and import of connections and the library (below) | at once |
| About (a folded rollout) | app version, the folders, the releases page | |

*Restart engine* restarts the engine with the new settings; open tabs re-open from the cache.

The **engine dot** at the top right of the window shows the engine state: green when *ready*,
amber while *starting…* or *restarting…*, red when *failed*. Clicking it opens a popover with the
state, the number of open traces, the index cache usage, the restarts since the app started and
the engine's uptime, plus *About* (goes to Settings, opens its About rollout and scrolls to it) and, with dev tools, *Kill engine*. A one-line
bar at the bottom of the window (*engine starting…*, *restarting…* or *failed*, with *restarts N*
after automatic restarts) appears only while the engine is not ready.

## Where the app keeps its files

| What | Windows | macOS | Linux |
|---|---|---|---|
| settings, workspace, annotations | `%APPDATA%\com.davidbudac.mtkprof\` | `~/Library/Application Support/com.davidbudac.mtkprof/` | `~/.local/share/com.davidbudac.mtkprof/` |
| logs | `%LOCALAPPDATA%\com.davidbudac.mtkprof\logs\` | `~/Library/Logs/com.davidbudac.mtkprof/` | `~/.local/share/com.davidbudac.mtkprof/logs/` |
| index cache | see above | | |

In the data folder: `settings.json` (the settings above), `workspace.json` (open tabs and the
recent list), `annotations.json` (bookmarks and notes per trace, keyed by its content
identity), `assist.json` (the assistant's chat and consents per trace; never in a backup),
`library.json` (saved pivots), `connections.json` (connection definitions, the team
file path, last test results). Deleting them resets the app; nothing in them is secret: a
remembered assistant key is in the OS keychain (service `com.davidbudac.mtkprof`), not here. *Settings → About*
shows the exact folders. *Open standalone HTML* writes to `reports/` in the cache folder
(`%LOCALAPPDATA%\com.davidbudac.mtkprof\reports`, `~/Library/Caches/…`,
`~/.cache/com.davidbudac.mtkprof/reports`); it can be deleted at any time.
