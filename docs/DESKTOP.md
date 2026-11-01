# mtkprof desktop app: user guide

The desktop app opens Oracle 10046 trace files, one tab per trace, with the same views as
`mtkprof serve` (Overview, Statements, Waits, Timeline, Sessions, Pivot) plus the **Lines**
viewer, **Notes**, **Reports**, a **Library** of saved pivots and **Connections** for fetching
traces from other machines. It is a Tauri shell around the `mtkprof engine` process
(`docs/ARCHITECTURE.md` § Engine mode); the code is in the private repo `mtkprof-desktop`
(build, dev mode, CI: its README). Internal team tool: builds are unsigned, no updater.

## Install

Installers come from the releases page of `mtkprof-desktop` (a prerelease per `v*` tag) or from
a local build (`scripts/ci-local.sh` in that repo).

| System | File | Notes |
|---|---|---|
| Windows 10/11 x64 | `mtkprof_<version>_x64-setup.exe` | per user, no admin rights |
| macOS Apple Silicon | `mtkprof_<version>_aarch64.dmg` | drag to Applications |
| macOS Intel | `mtkprof_<version>_x64.dmg` | drag to Applications |
| Linux x64 | `mtkprof_<version>_amd64.AppImage` or `.deb` | |

The builds are not signed. The first start needs one extra step:

- **Windows**: SmartScreen says "Windows protected your PC". Click *More info*, then *Run
  anyway*. Only the first start asks.
- **macOS**: Gatekeeper says "mtkprof.app" Not Opened ("Apple could not verify…"). Click
  *Done*, open System Settings → Privacy & Security, scroll to Security and click *Open
  Anyway* next to "mtkprof.app was blocked", then confirm. Only the first start asks.
  (Right-click → *Open* no longer does this since macOS 15.) Or in a terminal:
  `xattr -dr com.apple.quarantine /Applications/mtkprof.app`.
- **Linux**: AppImage: `chmod +x mtkprof_*.AppImage`, then run it. It needs FUSE 2
  (`sudo apt install libfuse2` on Ubuntu 22.04+). deb: `sudo apt install ./mtkprof_*.deb`.

*About* shows the app, engine and protocol versions and opens the releases page. New versions
are installed by hand.

## First start

The app starts its engine (`mtkprof-engine`, the sidecar), which listens on `127.0.0.1` on a
free port with a random token per run. Nothing else on the machine can use it. The status bar
shows the engine state.

The **index cache** is where parsed traces are kept, so the same file opens again in about a
second. An entry is keyed by file content (size and the first MiB of each file) plus the open
options, not by path; a changed file is parsed again.

| | |
|---|---|
| Default location | Windows `%LOCALAPPDATA%\com.davidbudac.mtkprof\mtkprof`; macOS `~/Library/Caches/com.davidbudac.mtkprof/mtkprof`; Linux `~/.cache/com.davidbudac.mtkprof/mtkprof` |
| Size | about the size of the traces |
| Cap | 20 GiB; least recently used entries are removed beyond it |
| Change | *Settings → Index cache location* / *Cap*, then *Restart engine* |

## Workspace

The **+** tab is the open screen:

- *Open files…* (one or more) or *Open folder…* (every trace file in it). Files picked together
  open as one trace set in one tab, like `mtkprof report a.trc b.trc`.
- Drop files or folders anywhere on the window.
- *Or a path*: type or paste a path (one per line for several).
- **Options**: bind values *keep* (default), *redact* (salted hash; the same salt gives the same
  hashes across opens) or *none* (dropped). *Follow as it grows* opens one file as a **live**
  session.
- **Recent**: the last 20 trace sets with their options. Click to open again, × to forget.

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

While a trace opens its tab shows the phase (cache lookup, parsing with bytes and percent,
writing the index), lines and statements so far, and *Cancel*. A trace opened before comes from
the cache at once.

One tab per open trace, named after its file (`+N` for a set). Switching tabs keeps each trace's
selection, filters, time window and Lines position. × or a middle click closes a tab; the cache
entry stays. Tabs cannot be reordered.

- **live** badge: the session follows a growing file. It refreshes on its own when the engine
  has a new snapshot (about once a second while the file grows); view, selected statement and
  filters stay.
- **Restore**: on the next start the app re-opens the tabs of the last run (from the cache)
  unless *Settings → Start empty* is on. Live sessions are not re-opened.
- **Engine restart**: if the engine dies the app restarts it (toast "Engine restarted") and
  re-opens every tab from its paths; the views come back where they were.

## Views

| View | |
|---|---|
| Overview, Statements, Waits, Timeline, Sessions, Pivot | as in `mtkprof serve`; the document is sliced by the engine, so a 2 GB trace stays light |
| **Lines** | the raw trace file, paged. Kind colouring, gutter marks of the selected statement, the object at the clicked line, streaming search, jump to time, a file selector for sets |
| **Notes** | all notes of the trace |
| **Reports** | what the CLI writes, saved from the tab |

"line N" links ("show in trace") open **Lines** at that line with the object highlighted (Shift+click
opens the small line drawer). *Bookmark* (or `b`) marks a line; bookmarks are kept per trace
across restarts.

From the timeline to the lines: a click on a block of the Overview lanes makes its interval the time window and
selects its statement (double-click opens the statement, still filtered to the block). The *Window* row above
the timeline (and in the Timeline tab) has *Lines*, which opens **Lines** at the window's first line; there the
window's lines have a band in the gutter and *⇤ start* / *end ⇥* jump to its ends.

### Notes and bookmarks

Notes belong to a trace's content identity, not to its file name: the same trace opened from
another path, re-fetched under another name or opened with other bind options shows the same
notes. They are stored in `annotations.json` in the data folder (see "Files").

| Note on | How | Matched by |
|---|---|---|
| Statement | *✎ Add note* next to *Copy SQL* in the detail | sql_id and SQL text |
| Execution | ✎ column of the executions table | cursor line and execution number |
| Time window | set a window (drag in the minimap or Timeline), then *✎ Annotate window* with an optional label; window notes are chips above the Timeline, a click applies the window | start and end |
| Line | *✎ Note* in the Lines toolbar (also bookmarks the line); the gutter shows ✎ | file and line |

The **Notes** view lists them with links (statement → its detail, execution → its row, window →
the Timeline with the window applied, line → Lines), edit and delete.

- *Export Markdown…*: a readable summary grouped by kind (trace name, identity, times).
- *Export JSON…*: `{version: 1, identity, trace, annotations: [...]}`.
- *Import JSON…*: merges such a file into this trace's notes (same id: the newer one wins). A
  file written on another trace also works: statements match by sql_id and text, lines and
  windows by number.

### Reports

The **Reports** view saves the outputs of the CLI, produced by the engine: the text report
(sort, top N, executions, bind sets, recursive SYS statements, width), the JSON document, the
CSV files (one zip) and the standalone HTML report. *Save…* asks where (downloads folder first,
named after the trace); large files are streamed to disk. *Open standalone HTML* writes the
report to `reports/` in the cache folder and opens it in the default browser.

A session's model is the aggregate one: its text report has no executions tables ("bind sets 0"
in the Volume line) and its JSON/HTML documents have no fact tables. Use the CLI on the file for
those.

## Library

Saved Pivot configurations, shared by all traces. In a tab's Pivot view, *Saved → Save current
as…* stores the fact table, dimensions, sort, row limit and the scope: the time window (as an
offset from the trace start), the session-context filter, the statement and event filters and
the idle toggle. Choosing a saved one in any tab applies it. What that trace does not have (a
session, a statement, an event, a window past its end) is left out and the Pivot view says so.

*Library* (top right) lists them: rename, delete, *Export…* (`mtkprof-library.json`,
`{version: 1, pivots: [...]}`) and *Import…* (same id: the newer one wins). Stored in
`library.json`. The library is exported on its own; the connections file does not include it.

## Connections

*Connections* (top right) keeps ssh hosts and Oracle logins for fetching traces. Details of the
protocol, grants and what was verified: [`docs/REMOTE.md`](REMOTE.md).

**No secrets at rest.** A definition has no password field. Passwords, key passphrases and
one-time codes are asked when a connection is used (a dialog; an unknown ssh host key shows its
fingerprint). A password or passphrase is asked once per connection per run and kept only in the
engine's memory until the app quits, the connection is deleted or you choose *Forget
credentials*. One-time codes and host-key answers are never kept. After an engine restart,
credentials are asked again. Nothing from a prompt is logged.

### ssh

- *Test* runs `uname -sr`.
- The remote browser lists the trace directories it finds (`$ORACLE_BASE`, the homes in
  `oratab`) and any directory you type.
- Select files and *Fetch*: gzip in transit, resumes a partial local copy; *open when done*
  opens the result (a set as one tab). Files go to `<cache>/remote/<connection>/`.
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
  117 MB trace took 301 s on the lab): the job says when a fetch passes ~200 MB; use ssh above
  that. A file listed but returning no lines belongs to a container the user cannot see.
- *Fetch reference data* runs the `refscript` queries for an open trace and applies the result
  to its tab (object, datafile and user names, plans). *Apply bundle from directory…* takes a
  bundle made by `mtkprof refscript` + SQL*Plus. The bundle is kept per trace identity and
  re-applied whenever the trace is opened.
- Username/password over TCP or TCPS. No sysdba, wallet or Kerberos. Grants needed:
  [`docs/REMOTE.md`](REMOTE.md) § Privileges. Without `SELECT_CATALOG_ROLE`, reference data falls
  back to the `ALL_` views for objects and users (the job message lists what was skipped).

### Jobs, sharing, team file

- **Jobs** (bottom right of the Connections page): fetches, follows and reference-data runs, with
  progress, cancel and *Open*.
- **Export** writes `mtkprof-connections.json` (`{"version": 1, "connections": [...]}`, no
  secrets). **Import** adds a file's definitions (same id: replaced).
- **Team file** (bottom left, e.g. in a shared repo checkout): re-read every 5 s and merged
  read-only (*team* badge). *Override locally* copies an entry so you can edit it; *Revert to
  team* drops the copy. Problems in the file are listed under it; a broken file keeps the last
  good list.

## Settings and About

| Setting | What it does | Applies |
|---|---|---|
| Cache location | where the index cache lives (*Change…* picks a folder, *Default* resets) | after *Restart engine* |
| Cap (GiB) | index cache size limit | after *Restart engine* |
| Plan visualizer URL | where *Open in plan viz* sends plans | after *Restart engine* |
| Bind values, salt | defaults of the open options | next open |
| Start empty | do not re-open last run's tabs | next start |
| Theme | system, light or dark | at once |

*Restart engine* restarts the engine with the new settings; open tabs re-open from the cache.
*Settings → Engine* shows the engine version, protocol, binary and address. *Settings → Index
cache* lists the entries (source paths, size, last use, whether an open tab uses it), removes
one, or wipes all (entries in use are kept). *About* shows the versions, the exact data, log
and engine paths, and the releases link.

## Files

| What | Windows | macOS | Linux |
|---|---|---|---|
| settings, workspace, notes, library, connections | `%APPDATA%\com.davidbudac.mtkprof\` | `~/Library/Application Support/com.davidbudac.mtkprof/` | `~/.local/share/com.davidbudac.mtkprof/` |
| logs | `%LOCALAPPDATA%\com.davidbudac.mtkprof\logs\` | `~/Library/Logs/com.davidbudac.mtkprof/` | `~/.local/share/com.davidbudac.mtkprof/logs/` |
| index cache, fetched traces (`remote/`), reference bundles (`ref/`), standalone reports (`reports/`) | see First start | | |

In the data folder: `settings.json`, `workspace.json` (open tabs, recent list), `annotations.json`
(bookmarks and notes per trace identity), `library.json` (saved pivots), `connections.json`
(definitions, team file path, last test results). Nothing in them is secret; deleting them
resets the app. `reports/` can be deleted at any time.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Toast "Engine stopped, restarting…" then "Engine restarted" | The engine exited unexpectedly. The shell restarts it at once, after 1 s, after 5 s and re-opens the tabs. Credentials are asked again. The cause is in the log. |
| Blocking panel "The engine is not running" | Start failed (no ready line within 10 s), a protocol mismatch, or a fourth crash within a minute. The panel shows the error; *Retry* restarts. |
| `protocol mismatch (engine N, app 1)` | App and engine come from different builds. Reinstall one release; app and engine move together. |
| Linux: the app does not start or exits at once | It needs a D-Bus session bus (single-instance). Over plain ssh or a bare window manager, run `dbus-run-session -- ./mtkprof_*.AppImage`. The AppImage also needs FUSE 2. |
| Index cache full or suspect | *Settings → Index cache → Wipe*, or delete the cache folder with the app closed. Everything is parsed again on the next open. |
| Fetch from a database is slow | ADR views read 0.4–1 MB/s. Use an ssh connection for files over ~200 MB. |
| ssh asks for the password again and again | The password was rejected (a wrong one is asked again up to three times), or the engine restarted. |
| Something else | *About* shows the log folder; the engine's stderr is in the log too. |
