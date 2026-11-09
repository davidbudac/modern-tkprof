# Import names (the names script and its pasted output)

The dialog that hands out the names script of the open trace and takes its pasted output (`web/src/lib/views/RefImport.tsx`,
docs/REF-BUNDLE.md § Paste). Nothing connects to a database: the real outputs of the script are in
`internal/ref/testdata/paste_io_waits_{sysdba,mtk}.txt` (io_waits.trc, run on the lab).

## Handles

| Thing | Handle |
| --- | --- |
| The links into it | `button.rfi-open` (the I/O map's Objects tab note, its Display tab › Object names, the statement inspector's waits); hidden until `GET api/ref` answered, absent once every object is named (Objects tab) |
| Connections entry | `button:has-text("Paste script output…")` in a db connection's Reference data section (add one with `+ Add` › `Oracle database`; `mock=db`) |
| Dialog / card | `.rfi-dialog[open]`, `.rfi-card`; coverage tiles `.rfi-cov` (text `Objects 5 of 7 …`) |
| Script | `button.rfi-primary:has-text("Copy script")` (grant `clipboard-read`/`clipboard-write` to read it back), `.rfi-script summary` (show), `.rfi-check input` (plans) |
| Paste | `textarea.rfi-paste`, the live note `.rfi-note`, `button.rfi-primary:has-text("Apply names")` |
| Result | `.rfi-result` (`.rfi-done` with a Done button, `.rfi-failed`), notes `details.rfi-notes` |

## Gotchas

- The engine is shared by the run's journeys: a kept bundle (per trace identity) shows in the next journey's coverage, and the
  finished ref jobs fill the Jobs dock, which covers buttons at the bottom right (`Clear finished` first).
- Apply starts a ref job: wait for `.rfi-done`, not a fixed sleep; the tab reloads its document (rev + 1) underneath and the
  dialog stays open.
- Save / Open saved output use the native dialogs in the app; in dev browser mode a download and a file input.
