# App pages: Settings and Connections

The desktop frame has two pages at the top right, reachable with or without a trace open: Settings (opening defaults, theme, engine cache, backup) and Connections (ssh hosts and Oracle databases for remote trace browsing).

## Sub-features

- `page-settings` Settings shows the `Opening traces`, `Appearance`, `Engine`, `Index cache`, `Backup` and `About` sections.
- `page-theme` the `Theme` group (`System`, `Light`, `Dark`) changes the look.
- `page-connections` Connections shows the toolbar (`+ Add`, `Export…`) and the connection list `[role=listbox][aria-label="Connections"]`.

## How to get to it (user POV)

- Click the gear (`Settings`) or plug (`Connections`) icon in the top-right `nav[aria-label="App"]` (`.page-links button[aria-label="Settings"]`).

## Driving it with Playwright (scripts/drive.mjs)

Preconditions:

- The URL has `mock=db` (launch.sh adds it) so database connection routes are mocked.

- **Settings.** `node $S/drive.mjs --page Settings --name settings`. Screenshot shows the `Settings` heading and the sections above (page link driven; both pages render with `errors: []`).
- **Theme.** Add `--click 'button:has-text("Dark")'` to the Settings run; `html`/`body` background darkens in the screenshot.
- **Connections.** `node $S/drive.mjs --page Connections --name connections`. Toolbar visible; the list is empty in a fresh context.

## Gotchas

- Dev browser mode has no Tauri store or keychain; stored connections and settings live in browser localStorage of that fresh context and vanish after the drive.
- The `+ Add > Oracle database` flow only works against the `mock=db` routes, not a real database.
- Backup/Export use native file dialogs in Tauri and are not reachable here.
