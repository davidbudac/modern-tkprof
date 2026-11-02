# UI cleanup: buttons vs facts, grouping, fewer screen jumps

> Written before the 2026-11-02 merge, when this app was the repository `mtkprof-desktop` and pinned the engine as the submodule `engine/`: read `engine/X` as `X` at the repository root (`web/src/lib`, `internal/`, `api/`, `testdata/`); the pin, `git submodule` and `check:deps` steps no longer exist.

From a walkthrough on 2026-10-30 (dev browser mode, engine v0.4.0-27-ge54fd67, the three-file set
`multisession_a.trc` + `multisession_b.trc` + `basic_binds.trc` and `io_waits.trc` in a second tab,
every view and page, 1440 and 1024 px). Screenshots of the walkthrough are in `/tmp/mtk-shots/`
(not committed). "Lib" marks work in the engine submodule's shared UI (`engine/web/src/lib`),
committed in `modern-tkprof` and pinned here; "Desk" is this repo.

The brief: make it obvious what is a button and what is a fact, put things that belong together
in one place, and stop sending the user to another screen for a look at something.

## Status (2026-10-30)

All of sections 2 and 3 landed on `ui/cleanup` in both repos (lib: `modern-tkprof` branch
`ui/cleanup`, pinned here). Checked in the dev browser at 1440 and 1024 px, light and dark, with
the three-file set and `io_waits.trc`: `pnpm typecheck`, `pnpm test` (143), `pnpm build` here;
`pnpm typecheck`, `pnpm test` (422) in `engine/web`.

Where it differs from the plan:

- The statement detail's `Lines ▾` menu holds "parsed at line N" and the plans' STAT lines; there
  is no separate `Plan` action in the row (the "Open in plan viz" link is per plan dump and stays
  in each plan's header). First-exec line numbers are not in the statement stats, so they are not
  in the menu.
- The Lines toolbar's window group (`⇤ start` / `end ⇥`) sits in row 2 next to the marks, not in
  row 1: with the Files panel open row 1 had no room for it at 1440. At 1024 with the panel open
  the two rows still wrap to four; folding the panel (its edge tab) gives two.
- `StmtPopover` without a Lines context hides `Mark` and `Parsed at line`; `Open in Statements`
  and `Copy SQL` always show.
- The `Columns` chooser trigger is labelled `Columns ▾` (was `columns`) in Pivot and the statement
  detail alike.
- Settings: `Remove` in the cache table is a quiet button; `Default`, `Refresh`, `Keep` are plain
  bordered buttons; `Wipe cache…` keeps `danger`.
- Connections: the `Team file ▾` button shows `!` while the team file has problems.
- The Files panel default per view is remembered per tab only (not in `workspace.json`); a
  `filesOpen` restored from `workspace.json` counts as the user's choice for the view the tab
  starts on.

Not run: the Tauri app (the file dialogs behind `Export…` / `Import…` in the Pivot's Manage panel
and the Connections toolbar were exercised only through the dev-mode mocks), a live session, a
comparison tab.

### Second pass: menus and rollouts (2026-10-30)

Follow-up to "a lot of the buttons could just be put into menus or rollouts". Every function
and shortcut stays; the visible controls shrink:

| Place | Before | After |
|---|---|---|
| Tab strip | `‹ › ×` per tab | `×`; right-click menu: Move left / right, Compare with…, Close, Close others |
| Session top bar | Notes, Reports tabs | `Tools ▾` (reads `Notes ▾` / `Reports ▾` while current) |
| Lines toolbar | 26 controls, 2 rows | 18: `Options ▾` (Aa, regex, from here), `Line ▾` (Bookmark, Note, Focus, Inspect), `Keys ▾` opens with "Command palette… ⌘K"; still 2 rows at 1440 with the Files panel open, 3 at 1024 |
| Files panel header | All · None · Invert + hint line | `Select ▾` |
| Overview timeline | 3 segments (6 buttons) | `lanes │ by event │ by class` + `Show ▾` (colour by phase / resource, wait strips) |
| Database calls | 5 checkboxes | `Calls ▾`, label says what is selected |
| Sessions | select all · none | `Select ▾` |
| Notes view | Export Markdown…, Export JSON…, Import JSON… | `Export ▾`, Import JSON… |
| Reports | Text options always shown | `Options · sort … · width 120 · SYS on` rollout |
| Connections toolbar | + ssh, + db, Team file, Export, Import | `+ Add ▾` (ssh, db, Import from file…), `Team file ▾`, Export… |
| Open screen | bind seg, salt, follow line | `Options · binds kept` rollout |
| Settings | cache table with Remove per row; About section | `N entries` rollout; `About · mtkprof 0.4.0` rollout (the engine dot's About opens it) |

Lib: `MenuItem` in `ToolbarMenu.tsx` (tick, label, `<kbd>`), `.tb-items` styles in `lines.css`;
`internal/ui/dist/index.html` rebuilt with `make web` so `mtkprof serve` matches. Desk: `src/ui/DeskMenu.tsx`
wraps the lib menu with fixed positioning for the top bar and pages.

## 1. What is wrong today

### 1.1 Buttons and facts wear each other's clothes

The root cause is two CSS rules that invert the grammar:

| Rule | Looks like | Is |
|---|---|---|
| `.chip-q` (`lib/styles/app.css:282`): 1px border, 3px radius, muted text | a small button | a fact: `PL/SQL EXECUTE`, `depth 0`, `hv 4238…`, `plan 123`, `PX`, `Chain 2`, `Truncated` |
| `button.quiet` (`app.css:77`): transparent border, muted text | a label | a button: every Lines toolbar menu (`Presets`, `Step`, `Focus`, `Inspect`, `View`, `Keys`, `Navigate`, `Commands ⌘K`), `◆ Bookmark`, `✎ Note`, the frame's page links, `By statement` |

So on the statement detail the three fact chips sit directly above the two real buttons (`✎ Add
note`, `Copy SQL`) with the same silhouette, and the Lines toolbar reads as a row of words. The
same confusion in smaller places:

- Settings: `Default`, `Refresh`, `Remove` are grey text (`.link`-ish); `Restart engine`, `Wipe
  cache…` are bordered. Same page, two button styles for the same weight of action.
- Lines line header (`LinesAt`): `Open`, `Parsed at`, `Open`, `Binds`, `EXEC line`, `Plan` are
  links inline between facts (`4 execs · 4.001 s`, `cursor #1405…`, `dep 0`).
- Frame top right: `Connections`, `Library`, `Settings` are destinations, `Compare tabs…` is an
  action that opens a dialog, the green dot is a button that looks like an indicator. All four
  are styled alike.
- Statements list: `no SYS` (a toggle) sits unmarked next to the `self | inclusive` segment.
- Menus have no `▾`, so a menu button and a toggle button look the same (`View` vs `Focus`).

### 1.2 Things that belong together are apart

- **Trace facts in four places:** the Files panel (per file), the file-name popover (Oracle,
  session, module, span, response split), the Sessions view (contexts), the Overview heading.
- **Engine facts in three places:** the engine dot popover, Settings → Engine, the About page.
- **Pivot's saved configurations** are saved in the Pivot view but managed on the Library page
  (rename, delete, export, import) at the other end of the window.
- **Compare** is a tab-pair operation but lives next to the app pages in the frame.
- **Statement detail** is two columns (the statement; "Context" with waits), so with the wait
  inspector still open from the Waits view, Statements shows four columns at 1440 px
  (`/tmp/mtk-shots/13-statements-selected.png`).
- **The wait-event inspector** is a shell-level pane: selected in Waits, it stays open in
  Overview, Statements, Pivot… where it has nothing to do with the view (`18-overview-1024.png`:
  the Overview at 1024 px gets 560 px).
- **The Files panel** is open in every view, including Notes and Reports where files are
  irrelevant (300 px of the width for nothing).
- **Connections** page: `+ ssh`, `+ db`, `Import` twice (toolbar and empty state), `Team file`
  alone at the bottom left, `Export` next to `Import` in the toolbar.
- **Pivot toolbar**: one row mixes the shape (calls/waits, rows by, then by, sort by, statement
  only) with the actions (Saved, columns, Download CSV).
- **Settings** order: Index cache (engine flags, then the cache table) → Opening → Appearance →
  Engine (facts) → Backup. The engine flags and the engine facts are 600 px apart.

### 1.3 Jumps to another screen

| Click | Today | Why it is a jump |
|---|---|---|
| any `line 220` / `File:line` / `Parsed at` / `EXEC line` | switches to the Lines view (`lineRefTarget: 'view'`, set by the desktop in `workspace.ts:286`; the lib's own default is the drawer) | the user loses the table they were reading |
| a sql_id anywhere (`StmtLink`) | switches to Statements and selects it (`selectStmt`) | fine as a destination, but there is no way to glance first; `StmtPopover` exists and is used only inside Lines |
| Pivot → Saved | the Library page | leaves the trace |
| engine dot → About | the About page | a page for five facts |
| `Compare tabs…` | dialog, then a new tab | fine; only its placement is wrong |
| Notes view links | each goes to its view | this is an index; keep |

## 2. The target

### 2.1 One visual grammar (Lib + Desk, CSS first)

| Thing | Treatment |
|---|---|
| **Action** | bordered button, ink text; **primary** filled; **destructive** red border |
| **Menu** | bordered button ending in `▾`; while open, pressed |
| **Toggle** | segmented control, pressed segment filled (`self │ inclusive`, `keep │ redact │ none`); a lone toggle is a bordered button with the pressed state |
| **Quiet action** (toolbar chrome) | muted text **with a visible wash on hover and a border at rest at 40% alpha**, never fully borderless; icon-only buttons get a tooltip |
| **Fact** | no border: plain `dim` text, mono where it is an identifier (`hv 4238191347`, `depth 0`); a status fact (`Truncated`, `live`, `PX`) is a tinted pill without a border and without hover |
| **Link to a thing** | underlined mono (sql_id, line numbers): unchanged |

Concretely: `.chip-q` loses its border (becomes a tinted pill), `button.quiet` gains a faint
resting border, `ToolbarMenu` appends `▾`, `button.link` in Settings becomes a quiet button.

### 2.2 Grouping

**Frame top (Desk).** Brand · tabs · `+` ‖ `Connections` · `Settings` · engine dot. `Library`
and `About` leave the nav (see below); `Compare tabs…` moves to the open screen as a card
("Compare two open traces", shown when two ready tabs exist) and to the tab's context menu.

**Session top bar (Desk).** `‹ ›` · file `▾` · spark ‖ **Overview Statements Waits Timeline
Sessions Pivot Lines** · divider · **Notes Reports**. Notes and Reports are tools of the tab, not
views of the trace; the divider and a lighter weight say so.

**Files panel (Desk, `SessionShell`).** Shown by default in Overview, Timeline, Sessions, Lines;
collapsed to its edge tab in Statements, Waits, Pivot, Notes, Reports (the filter row's `▤ N
files` chip opens it anywhere). The user's manual open/close still wins per view.

**Wait-event inspector (Desk, `SessionShell`).** Only in Waits and Timeline. Leaving them hides
the pane; coming back shows it again with the same event (the selection stays in the store).

**Statement detail (Lib, `StatementDetail` + `StatementContext`).** One column: title, fact line
(`PL/SQL EXECUTE · depth 0 · hv 4238191347 · plan 2893…`), **one action row** (`✎ Add note`,
`Copy SQL`, `Lines ▾` with parse / first exec / line, `Plan`), SQL text, response time, then
`Context` and `Waits` as sections, then `Database calls`. The right-hand context column goes.

**Lines toolbar (Lib, `Lines.tsx`).** Two rows instead of three:

1. file ▾ · search [Aa · .* · from here] · scope [File │ Window │ Statement] · `Presets ▾` ‖
   Go to · `⇤ start` `end ⇥`
2. selection: `▲ ▼` · `◆ Bookmark` · `✎ Note` · `Focus` · `Inspect` ‖ `Step ▾` · `Navigate ▾`
   ‖ `View ▾` · `Keys` · `⌘K`

Groups separated by hairlines, menus with `▾`, the line header's links (`Open`, `Binds`, `EXEC
line`, `Plan`) gathered into one `Actions ▾` at the end of the header.

**Pivot (Lib, `Pivot.tsx`).** Row 1 the shape (`calls │ waits` · Rows by · then by · Sort by ·
Statement only); row 2 right-aligned actions: `Saved ▾` (Save current as…, the list, Manage…),
`Columns ▾`, `Download CSV`. `Manage…` opens an inline panel with rename, delete, export, import,
which replaces the **Library page** (Desk: `LibraryView` becomes `LibraryPanel`, mounted by the
Pivot's Saved menu through the existing `library.ts` store; the page and its nav entry go).

**Settings (Desk).** Sections in this order, each with its actions in the section:
Opening (bind default, start empty) · Appearance (theme) · Engine (location, cap, plan URL,
`Restart engine`; version, binary, listening, status, uptime) · Index cache (usage bar,
`Refresh`, `Wipe…`, the table) · Backup · About (version, folders, releases link). The About page
goes; the engine dot's `About` button scrolls Settings to that section. All text links become
quiet buttons.

**Connections (Desk).** Toolbar: `+ ssh` · `+ db` ‖ `Team file ▾` (path, Choose…, status) ‖
`Import…` `Export…`. The empty state keeps its three explained buttons; the toolbar's duplicates
of `+ ssh` / `+ db` stay (they are the primary way in once the list is full) but `Import` leaves
the toolbar for the empty state only when the list is empty.

### 2.3 Fewer jumps

- **Line references open the drawer** (Desk: `lineRefTarget: 'drawer'`; Shift+click still goes to
  the Lines view). The drawer already has `Open in Lines`. One-line change with the largest
  effect.
- **sql_id links show the statement popover first** (Lib: `StmtLink` opens `StmtPopover` on
  click, with `Open in Statements`; ⌘/Ctrl-click goes straight there). The popover already
  exists for Lines.
- **Saved pivots** are managed inside Pivot (above).
- **About** is a Settings section (above).

## 3. Order

1. **Grammar (CSS).** Lib: `.chip-q`, `button.quiet`, `ToolbarMenu ▾`. Desk: Settings/Connections
   link buttons, frame page links. Screenshots before/after of the statement detail, the Lines
   toolbar, Settings.
2. **Desk-only structure.** `lineRefTarget: 'drawer'`; inspector and Files panel scoped per view;
   top bar divider; Compare to the open screen; About into Settings; Settings regrouped;
   Connections toolbar.
3. **Lib structure.** Statement detail one column with an action row; Lines toolbar two rows and
   the `Actions ▾` header; Pivot two rows with `Saved ▾ → Manage…`; `StmtLink` popover.
4. **Library page removed** once 3 lands (Desk, depends on the Pivot's Saved menu).

Each step: `pnpm typecheck`, `pnpm test`, `pnpm build`; lib steps also `cd engine/web && pnpm
typecheck` and the pin. Check the three-file set and `io_waits.trc` at 1440 and 1024 px, light and
dark; update `docs/DESKTOP.md` where names move (Library, About, Compare tabs, line links).

## 4. Open questions

- Lib work means commits in `modern-tkprof` (the submodule) and a pin here: allowed in this pass,
  or desktop-only first?
- The Library page: fold into Pivot (proposed) or keep as a page with the Pivot's Saved menu
  linking to it?
- Line references: drawer by default for every view (proposed), or keep the Lines view for the
  Sessions table's `File:line` column, where the user is navigating rather than glancing?
