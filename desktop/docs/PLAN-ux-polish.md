# UX and visual polish: implementation plan

> Written before the 2026-11-02 merge, when this app was the repository `mtkprof-desktop` and pinned the engine as the submodule `engine/`: read `engine/X` as `X` at the repository root (`web/src/lib`, `internal/`, `api/`, `testdata/`); the pin, `git submodule` and `check:deps` steps no longer exist.

From a walkthrough of the app on 2026-10-27 (dev browser mode, engine v0.4.0-9-g9c00d37, a
three-file set `multisession_a.trc` + `multisession_b.trc` + `basic_binds.trc`, every view and
page, light and dark, 1440 and 1024 px wide). Items are ordered by impact; each says where the
code is, what to change, and how to check it. "Lib" marks work that lives in the engine
submodule (`engine/web/src/lib`), which this repo only pins; everything else is desktop code.

Reproduce any item with the dev browser recipe in the README ("Dev browser mode"): the sidecar
must keep stdin open (`… engine -listen … < <(sleep 7200)`), then `pnpm dev` and
`http://127.0.0.1:5173/?engine=127.0.0.1:47011&token=<token>`; paths from
`engine/testdata/traces/19c/` go into the open screen's Paths box, one per line.

## Status (2026-10-27)

Phases 1, 2 and 4 are merged on `main` (Phase 4 merge `ab4ccbf`). The Phase 3 window items
are implemented in the 2026-10-29 follow-up described below. Each earlier item has a
**Done** line with what was built and where it differs from the plan.

| Commit | Items |
|---|---|
| `c215086` | 1.1, 1.2 |
| `71bd220` | 1.3 |
| `2c24ba5` | 2.2 |
| `afd843e` | 2.1, 2.3, 2.4, 2.5, 2.6 |

The four were built on separate branches and merged into `main` together, not as the four PRs
"Order and verification" asks for, so the before and after screenshots for 1.1 and 1.2 were not
taken. `pnpm typecheck`, `pnpm test` (121 tests) and `pnpm build` pass on the merge. A debug app
build of it was reviewed by hand, but the per-item **Check** steps (the 960, 1024 and 1440 px widths,
light and dark, ⌘W in the macOS app) were not each run; do them on the next pass through the app.

## Phase 1: defects (one short PR)

### 1.1 Unscoped `.bar` rules paint every table value solid blue

**Where:** `src/connections/connections.css` lines 233 and 234:

```css
.bar { block-size: 4px; border-radius: 2px; background: var(--wash-strong); overflow: clip; }
.bar > span { display: block; block-size: 100%; background: var(--c-cpu); }
```

**What happens:** the lib's tables mark value cells `td.num.bar` with an `<i>` meter (width = the
value, `opacity: 0.16`) and a `<span>` label on top (`engine/web/src/lib/styles/app.css:336-338`).
The desktop rule above gives that span a solid `--c-cpu` background, so Statements (Elapsed),
Waits (Time), Sessions (Response) and Pivot (Elapsed) show white-on-blue numbers and the meter is
invisible. The first rule also puts a grey track, clipping and a 4px min height under the lib's
`.srow .bar`, `.item .bar` and `.files-list .share .bar`.

**Change:** scope both rules to the jobs dock, the only desktop user of the class
(`src/connections/JobsPanel.tsx`): `.jobs .bar`, `.jobs .bar > span`, and the two motion rules
below them (`.bar > span` transition, `.bar.indeterminate > span` animation). Grep `className="bar"`
in `src/` to confirm nothing else uses it.

**Check:** Waits view: the Time column shows a faint tinted bar whose width follows the value, dark
text. Jobs dock (fetch a file over ssh, or `&mock=db` + a db trace job): the progress bar still
animates.

**Done** (`c215086`): as planned. The five rules are `.jobs .bar …` (`connections.css:224-229`); the
dock's root is `<section className="jobs">` and nothing else in `src/` uses `bar`.

### 1.2 Session top bar overflows below about 1130 px

**Where:** `src/workspace/session/TopBar.tsx`, `src/app.css` (`.frame-main .topbar …` rules),
lib breakpoint at `engine/web/src/lib/styles/app.css:76` (`@media (width < 64rem)` hides
`.topbar .mini`).

**What happens:** the desktop adds Notes and Reports, so the Views nav alone is 659 px; with Back
and Forward, the file name, the response mini-bar and the Files chip the bar needs ~1130 px. The
lib's `.topbar` is `overflow: auto`, so on a 1024 px window it scrolls horizontally: Reports and the
"3 files" chip are off-screen and the file name shrinks to `cdb1_o…` (measured: scrollWidth 1130,
clientWidth 1009).

**Change** (desktop CSS, in `src/app.css`, so the lib stays as it is):

1. Below 72rem hide the view count badges (`.frame-main .tabs .tab small { display: none }`) and
   the response mini-bar's text (`.frame-main .topbar .mini > .dim`), keep the track.
2. Below 66rem hide `.frame-main .topbar .mini` entirely and tighten `.tab` padding-inline to
   0.45rem.
3. Keep `.frame-main .topbar > .file` at `min-inline-size: 8ch` but let it shrink first
   (`flex: 0 1 auto; max-inline-size: 28ch`) and give the nav `flex: none` so the tabs never
   ellipsize or wrap.
4. If the bar still overflows at 1024 px after 1 to 3, move Notes and Reports into a small
   "More ▾" button at the end of the nav below 66rem (a `<details>` with the two buttons; keep
   `aria-current` on the summary when one of them is the current view). Only do this if needed.

**Check:** resize the window to 1024 and 960 px with the three-file set: all nine views and the
Files chip visible, no horizontal scrollbar in the top bar, the file name still readable; at 1440
nothing changes.

**Done** (`c215086`): steps 1 to 3 in `src/app.css` (after the `.frame-main .topbar` rules). Step 4
(the "More ▾" menu) was skipped: by estimate, below 66rem the bar needs about 700 px of the 1009 px it
has at 1024 px. Those savings were estimated, not measured; if the Check shows overflow at 1024 or
960 px, step 4 is the fix. The file name's cap is now 28ch on desktop, so the lib's 14ch below
64rem does not apply there.

### 1.3 Files panel and details pane together leave no room for the view

**Where:** `src/workspace/session/SessionShell.tsx` (`inspectorOpen`, `onPanes`),
`src/workspace/panes.ts`; lib grid rules `engine/web/src/lib/styles/app.css:10-21` (side by side
down to 64rem, stacked below).

**What happens:** at 1024 to 1100 px with the Files panel open, selecting a wait event opens the
details pane and the view column drops to ~350 px: the Waits table shows two columns and a
horizontal scrollbar.

**Change:** when the details pane opens and the body is narrower than `--files-w` + 40rem +
`--inspector-w` (measure `body.current.clientWidth` in `SessionShell`), collapse the Files panel
for the duration (the lib store's `actions.setFilesOpen(false)`, the same action the "▤ N files"
chip uses; `filesPanelOpen(state)` reads it) and remember that it was auto-collapsed in a ref; restore it
when the pane closes or the window grows past the threshold (a `ResizeObserver` on the body).
A user who re-opens the panel by hand while the inspector is up clears the auto flag. Do not
persist the auto-collapse in `workspace.json`.

**Check:** 1024 px, Files panel open, click a wait row: the Files panel collapses to its edge tab,
the table keeps its columns; close the pane: the panel comes back. At 1440 nothing auto-collapses.

**Done** (`71bd220`):
- **Threshold:** the pure `filesNeedRoom` in `src/workspace/session/filesRoom.ts`, with tests in
  `filesRoom.test.ts` (since 2026-11-01 in the lib: `engine/web/src/lib/shell/filesRoom.ts`, used through `useShellPanes`).
- **Widths:** `--files-w` and `--inspector-w` are `clamp()` expressions, so `lengthVar` measures a
  hidden probe element. This also picks up a dragged width.
- **Stacked layout:** below 64rem (`matchMedia`) the panes stack and nothing folds.
- **Restoring:** besides the pane closing and the window growing, the panel also comes back when the
  shell unmounts (another tab), so the store never keeps the fold.
- **Not saved:** `workspace.ts` saves every `filesOpen` change, so a per-store mark
  (`markFilesFolded` / `filesFolded`) makes the save step skip the folded `false`.
- **Not tested:** the `SessionShell` effects themselves.

## Phase 2: desktop chrome

### 2.1 Status bar: user-facing content only

**Where:** `src/StatusBar.tsx`, `src/settings/AboutView.tsx`.

**Change:** the bar shows the dot, `engine ready` (or `starting…`, `restarting…`, `failed`),
`restarts N` when > 0, and on the right `N open traces` (the workspace's tab count, from
`useWorkspaceState().tabs`, not the engine's session count, which counts other windows and dev
tabs) and the cache usage. Drop the version, the commit hash and `protocol N` from the bar: About
already has them; add the engine's uptime to About's `kv` list. Keep `Kill engine` for dev tools.

**Check:** bar reads `● engine ready … 3 open traces · cache 723 KB / 20 GB`; About shows version,
protocol and uptime.

**Done** (`afd843e`): as planned. The workspace's `tabs` holds only traces (pages are routes), so the
count is `tabs.length`. About's uptime is the engine's `health.uptime`, with the formatter moved
there from the status bar.

### 2.2 Keyboard shortcuts for tabs

**Where:** new `src/workspace/shortcuts.ts` mounted once in `App.tsx` (next to `DropTarget`);
`WorkspaceProvider` already exposes `go`, `close`; `isMac` from `src/platform.ts`.

**Change:** a window `keydown` listener (ignore when the target is an input, textarea, select or
contentEditable, same guard as `SessionShell`):

| Keys | Action |
|---|---|
| ⌘W / Ctrl+W | close the current tab (a page: go to the last tab) |
| ⌘T / Ctrl+T | the open screen |
| ⌘1…⌘8 / Ctrl+1…8 | tab by position; ⌘9 the last tab |
| Ctrl+Tab, Ctrl+Shift+Tab, ⌘⇧] / ⌘⇧[ | next / previous tab (wrap) |
| ⌘, / Ctrl+, | Settings |

On macOS the Tauri window menu may already own ⌘W (it closes the window): in `src-tauri` add the
shortcut to the app menu as "Close Tab" with the `CmdOrCtrl+W` accelerator emitting an event the
listener handles, so the window does not close. List the shortcuts in `docs/DESKTOP.md` (Tabs).
Unit-test the key-to-action mapping in `shortcuts.test.ts` (vitest, like `panes.test.ts`).

**Check:** with three tabs, ⌘2 switches, ⌘W closes and the neighbour becomes current, ⌘T opens
the open screen, Ctrl+Tab cycles; in a text field the keys type.

**Done** (`2c24ba5`):
- **Code:** the mapping, its resolution against the tabs, and the hook are in
  `src/workspace/shortcuts.ts`, tested in `shortcuts.test.ts`. The text-field guard `inTextField` is
  shared with `SessionShell`.
- **⌘W on macOS:** Tauri's default menu did own ⌘W. `src-tauri/src/menu.rs` rebuilds the macOS menu
  with File → "Close Tab" (⌘W), which emits `menu://close-tab`, and moves Close Window to ⇧⌘W. In the
  macOS app the keydown ignores ⌘W, so a tab can't close twice. Windows and Linux keep the default
  menu.
- **Behaviours chosen beyond the plan:**
  - ⌘W on the open screen does nothing; on a page it goes to the last tab, or to the open screen if
    there are none.
  - Ctrl+Tab from a page goes to the first tab.
  - Held W and T don't repeat.
  - ⌘⇧ with a digit is left to macOS (screenshots).
- **Keeping the menu current:** the menu is now built by hand, so items Tauri adds to its default
  menu later must be added in `menu.rs`.
- **Dev browser:** the browser keeps Ctrl+W and Ctrl+Tab.
- **Not run:** the Rust was only compiled (`cargo check`), never run in the app.

### 2.3 Page links: one treatment

**Where:** `src/pages.tsx` (`icon` on Settings only), `src/workspace/TabStrip.tsx`.

**Change:** drop the `⚙` (and the `icon` field, if nothing else needs it); the four links are
text. Alternative, if an icon is wanted for all: one glyph each from the fonts the UI ships (the
comment in `pages.tsx` notes ⓘ is missing on Linux), but text only is the smaller change.

**Done** (`afd843e`): text only; the `icon` field is gone.

### 2.4 Open screen

**Where:** `src/workspace/OpenScreen.tsx`, `src/workspace/traceSet.ts` (`setSummary`), `src/app.css`.

- **Recent summary:** `setSummary` prints `1 file in /…/plan_change.trc` for a single file. Return
  the directory for one path (`1 file · /…/19c`) and keep `N files in <first path>` for sets; add
  a case to `traceSet.test.ts`.
- **Bind values control:** replace the native `<select>` with the `seg` button group the Theme
  setting uses (`keep · redact · none`), both here and in `SettingsView` ("Opening traces"); the
  Salt field stays conditional on `redact`.
- **Drop zone:** give `.open-main` a dashed border region around the two buttons and the path box
  (`border: 2px dashed var(--hairline-strong)`), with the "drop them on the window" sentence
  inside it; the existing full-window `.drop-overlay` stays for the drag itself.
- **"Waiting for the engine…"** already exists; show it inside the drop zone so the disabled
  buttons have a reason next to them.

**Check:** Recent reads `plan_change.trc · 1 file · /…/19c · 36 h ago`; bind values is a three-way
segmented control; the open area is visibly a drop target in light and dark.

**Done** (`afd843e`):
- **Recent summary:** `dirOf` sits next to `baseName` in `traceSet.ts`. One file reads
  `1 file · <dir>` and a folder reads `N files in <folder>`. A set of several paths keeps the
  existing `N files`, not `N files in <first path>`.
- **Bind values:** one shared component, `src/settings/BindSeg.tsx`, used on the open screen and in
  Settings.
- **Drop zone:** `.drop-zone` in `src/app.css`.

### 2.5 Settings page

**Where:** `src/settings/SettingsView.tsx` (`CacheEntries`), `src/app.css` (`.cache-table`, `.cache-paths`).

- **Cache table paths:** every row in a project shows the same prefix. Render the first path as
  basename in `mono` plus `(+N)` for sets, with the directory muted on a second line
  (`titleOf` from `traceSet.ts` and a new `dirOf` next to `baseName` there; 2.4 needs it too),
  the full list stays in the `title` tooltip.
- **Last used:** `toLocaleString()` gives `10/27/2026, 7:43:23 PM`; use the open screen's `ago()`
  (move it to a shared `src/time.ts`) with the exact time in a `title`.
- **Apply row:** move "Restart engine" and the pending-changes note out of the middle of the
  Index cache section into one row under the three fields, before the usage line, and give the
  section a short note "Location, cap and plan URL apply on restart" in place of the paragraph.
- **Theme:** capitalize the segment labels (`System · Light · Dark`).

**Done** (`afd843e`): as planned, with `ago()` now in `src/time.ts`. The apply row was already under
the three fields and before the usage line (which is inside `CacheEntries`), so only the note
changed. A last-used time that doesn't parse shows as the raw string.

### 2.6 Connections empty state

**Where:** `src/connections/ConnectionsView.tsx` (the `Select a connection, or add one.` panel).

**Change:** when there are no connections, the main panel shows the three ways in (`+ ssh`,
`+ db`, `Import…`) as buttons with one line each, like the sidebar text says; with connections but
none selected it keeps the one-line hint.

**Done** (`afd843e`): as planned, shown once the connections have loaded, with the same handlers as
the sidebar.

## Phase 3: smaller notes

Implemented in the 2026-10-29 follow-up (shared library plus desktop integration).

- **Window shown twice** (the lib's `WindowBar` above the lanes and the filter row's Window chip,
  both with ×): lib. Raise upstream; the desktop could hide the `WindowBar` when the filter row
  shows a Window chip, but the bar also carries Lines, Statement and Zoom, so leave it until the
  lib decides.
- **`top 1 statement: 112%` after windowing:** lib (`Overview.tsx` divides the statement's whole
  response by the window's). Raise upstream.

  **Resolved:** the documented accounting counts calls crossing the window whole, while
  response time is clipped to the window; recursive statements also overlap. Tests reproduce
  112% boundary overlap and 126% recursive overlap. Keep those values and explain them;
  avoid cross-scope query retention and suppress percentages until matching data is ready.
  Overview/Timeline retain the dedicated window action bar; the global window chip remains
  on other views and the lanes brush no longer repeats the clear control.
- **Three stacked bars** (top bar, filter row, subbar) before the content: fold the subbar's
  static facts (Oracle version, instance, session, module, span) into a tooltip or a popover on
  the file name in the top bar, keep only the `cut by max_dump_file_size` and `continues an
  earlier file` warnings as a row. Desktop (`SubBar` in `TopBar.tsx`, `.shell` rows in `app.css`
  via `.shell.has-banner` style overrides). Do this last; it changes every screenshot in the docs.

  **Done** as part of Phase 4 (the trace popover and the warning row).
- **Dark mode:** no changes needed.

## Phase 4: chrome diet (2026-10-29)

Mockups in `docs/mockups/ux-clean.html`. Five chrome bands before the content (frame top, top
bar, filter row, subbar, status bar) become two plus the filter row when filters are active;
nothing is removed, the static facts move one click away. All desktop code; the lib is untouched.

| What | Where | Done |
|---|---|---|
| **File button + trace popover.** The file name in the top bar is a button (`name ▤ N ▾`); its popover carries the subbar's facts (Oracle version, instance, session, module, wall-clock span), the full response track with a legend of every class, the Files panel toggle and the response total. | `src/workspace/session/TopBar.tsx` (`FileButton`, `TracePop`), `.file-btn` / `.pop.trace-pop` in `src/app.css` | The popover is `position: fixed`, placed from the button's rect, because the lib's `.topbar` scrolls sideways (`overflow-x: auto`) and would clip an absolute one. `SubBar` is gone. |
| **Warning row.** `cut by max_dump_file_size` and `continues an earlier file` are an amber row under the filter row, dismissable; the dismissal is per tab (a `WeakMap` on the store, like `navHistory`). | `WarnRow` in `TopBar.tsx`, `.warnrow` | The row is always rendered (empty collapses to 0) so the shell's six grid rows stay fixed: top bar, filter row, warn row, banner slot, body, line drawer. `.shell.has-banner` is gone; `.frame-main .shell` sets the rows. |
| **Sparkline.** The lib's `ResponseMini` (11rem track + text) is a 56px track with the numbers in its tooltip and in the popover. | `ResponseSpark` in `TopBar.tsx`, `.mini-spark` | Hidden below 66rem like the mini-bar was. |
| **View tabs lose their counts.** Statements, Waits and Sessions headers already carry them. | `views.tsx` (`count` field removed), `TopBar.tsx` | |
| **Engine dot.** The status bar's content moves to a dot at the end of the top row (green ready, amber starting / restarting, red failed) with a popover: state, open traces, cache usage, restarts, uptime, About, Kill engine (dev tools). About leaves the page nav (`hidden` on the page). | new `src/EngineMenu.tsx`, `TabStrip.tsx`, `pages.tsx`, `fmtUptime` moved to `src/time.ts` | |
| **Status bar only in trouble.** `StatusBar` returns null when ready; while starting, restarting or failed it is the one-line bar it was (state, restarts). | `src/StatusBar.tsx` | The smoke script's screenshot comments and README were updated; nothing asserted on the bar's text. |
| **Tab strip.** Boxed browser tabs become quiet raised pills (radius 6px, 1px ring on the active one); the frame top loses its bottom border, the top bar's hairline is the one line under the chrome. | `.frame-top`, `.session-tab*` in `app.css` | Frame top row is 2.5rem. |
| **Filter row** keeps its slot, drops the blue wash; chips carry a `--c-cpu` tinted border. | `.frame-main .filterbar` overrides | |
| **Open screen.** One dashed zone holds the buttons, "or drop them anywhere on the window" (or "Waiting for the engine…"), the path form and a single bind-values line (seg, salt when redacting, follow checkbox at the end); the options fieldset is gone. Recent entries: name strong, summary muted (`--ink-3`), age and × in their own columns. | `OpenScreen.tsx`, `.drop-zone` / `.opt-row` / `.recent*` | Button labels stay "Open files…" / "Open folder…" (the docs name them). |

Checked in the dev browser at 1440 and 1024 px, light and dark, with the three-file set: both
popovers, the Waits view, the open screen. `pnpm typecheck`, `pnpm test` (121) and `pnpm build`
pass. Not run: the Tauri app (the engine menu's Kill engine needs dev tools), a truncated trace
(the warning row was checked only by reading the code).

## Order and verification

1. Phase 1.1 and 1.2 first (CSS only, one PR); screenshot Waits and the 1024 px top bar before and
   after and put them in the PR.
2. Phase 1.3 and 2.2 (behaviour, tests), one PR each.
3. Phase 2.1, 2.3 to 2.6 (chrome), one PR; update `docs/DESKTOP.md` where copy changes
   (status bar, shortcuts, open screen).
4. Phase 3 after the lib questions are answered upstream.

Each PR: `pnpm typecheck`, `pnpm test`, `pnpm build`, and a look at the three screens the change
touches in the dev browser at 1440 and 1024 px, light and dark.

Steps 1 to 3 shipped together straight to `main` rather than as separate PRs (see Status at the top).
