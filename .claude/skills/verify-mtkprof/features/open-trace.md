# Open a trace

A user opens one or more Oracle 10046 trace files (or a folder) from the start page; the engine indexes them and a session tab with the analysis views appears.

## Sub-features

- `open-paths` opens a single file typed into the Paths textarea.
- `open-set` opens several paths in one submit as one tab titled `<first> (+N)`.
- `open-bad` shows a failed state for a nonexistent path.
- `open-recent` lists the opened trace under `Recent` and reopens it from there.
- `open-close` closes a tab with its `×` and returns to the start page.

## How to get to it (user POV)

- Start page (shown with no tabs, or via the `+` tab `button[aria-label="Open a trace"]`): type absolute paths into `#open-path` and press `Open`.
- `Folder` input `#open-dir` (dev browser mode): the engine reads that folder.
- `Open files…` / `Open folder…` buttons and drag-drop (browser file picker only; in dev mode names resolve against `#open-dir`).
- `Recent` list item `.recent-open`.

## Driving it with Playwright (scripts/drive.mjs)

Preconditions:

- `launch.sh` and `doctor.sh` passed; the start page shows `Open a trace` with `Open files…` enabled.

- **Single file.** `node $S/drive.mjs --open $T/level_8.trc --name open1`. A `.session-tab-main` titled `level_8.trc` appears, `.session-nav .tabs button.tab` lists Overview..Lines, `open1.json` has `errors: []`. Screenshot `open1-03-end.png` shows the brand, the tab and the Overview.
- **Set.** `node $S/drive.mjs --open $T/level_8.trc,$T/level_4.trc --name open2`. One tab titled `level_8.trc (+1)` (verified).
- **Bad path.** Fill `#open-path` with `/nonexistent/x.trc` and submit (extend drive.mjs). Expect a `.tab-dot.bad` or `.tab-banner.bad[role=alert]`; capture it. (Not yet run by the author.)
- **Recent.** After an open, click `+`, expect `.recent-open` with the trace title under `Recent`. (Not yet run.)
- **Side effect.** `GET /engine/sessions` with the bearer token lists the opened session.

## Gotchas

- Relative paths fail with "no such file"; always absolute.
- Each drive.mjs call is a fresh context, so `Recent` is empty at the start of a run unless you do it in the same script.
- Submit is disabled until the engine is ready; drive.mjs waits for `button.primary:not([disabled])`.
- The follow/live option opens one file only and shows a `.badge-live` on the tab.
- Do not point at a huge folder; indexing time is unbounded by this skill.
