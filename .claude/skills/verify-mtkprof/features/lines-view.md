# Lines view

The Lines view is a virtualised raw-text viewer of the trace with line numbers, a minimap of calls, waits, binds and errors on the right edge, search, go-to, and a toolbar of display options. It is shown only when the engine offers the lines API for the session.

## Sub-features

- `lines-show` the view button `Trace` exists and the raw header lines (`Trace file ...`, `Oracle Database 19c ...`) render with line numbers.
- `lines-search` searching the trace text lists hits.
- `lines-goto` the go-to box jumps to `line`, `#cursor` or a sql id.
- `lines-prefs` display options persist in `localStorage['mtk.lines.prefs']`.

## How to get to it (user POV)

- Open a trace, then choose `Trace` in the views bar (or ⌘2) (`.session-nav .tabs button.tab`, in the header next to the tabs).

## Driving it with Playwright (scripts/drive.mjs)

Preconditions:

- A trace is open (use `$T/level_8.trc`, 143 lines).

- **Show.** `node $S/drive.mjs --open $T/level_8.trc --view Trace --name lines`. `Trace` is `aria-current=page`; the screenshot shows line 1 `Trace file /u01/app/oracle/...cdb1_ora_133455_mtk_level_8.trc` and the footer `1 / 143` (verified).
- **Search.** After the view is open, fill `input[aria-label="Search the trace text"]` with `WAIT` and press Enter / the `Search` button; expect a `[role=listbox][aria-label="Search hits"]` (selectors read from source, not yet driven).
- **Prefs.** `node $S/drive.mjs --open $T/level_8.trc --view Lines --prefs '{"wrap":true}' --name prefs`. `prefs.json` `linesPrefs` shows the stored JSON and the view renders wrapped (compare to the unwrapped screenshot). Default shape is in `engine/web/src/lib/state/linesPrefs.ts`.

## Gotchas

- The `Lines` button is absent when the session has no slice or lines API; `drive.mjs --view Lines` then fails listing the available views, which is the correct report.
- Fresh contexts have no stored prefs (`linesPrefs: null` until the app writes them).
- Keyboard shortcuts act only with the viewer focused; click a line first.
- The UI source of this view is the submodule `engine/web/src/lib/views/Lines.tsx`, not `src/`.
