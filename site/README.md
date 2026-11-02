# Website

Static site for mtkprof and the desktop app: `index.html` (landing page) and
`docs.html` (documentation), one stylesheet, no build step. Fonts are the
product UI's IBM Plex files; the logo is the desktop app's mark (inlined in
`style.css` as a mask, so it follows the text color).

Preview:

```
python3 -m http.server 8811 -d site     # http://127.0.0.1:8811/
```

Opening the files directly (`file://`) also works.

## Screenshots

`img/*.webp` are real screenshots, not mockups:

- the standalone UI: `mtkprof html testdata/traces/19c/io_waits.trc` and
  `mtkprof html testdata/sets/workload`, captured with headless Chromium at
  1440×900, device scale 2, then `cwebp -q 82 -resize 2000 0`;
- `desktop-dark.webp`: the macOS smoke screenshot of the desktop app
  (`desktop/out-smoke/macos-arm64-ready.png`, from `desktop/scripts/smoke.sh`)
  with the menu bar cropped off.

Retake them when the UI changes visibly. The hero window on the landing page
shows lines 6878–6891 of `testdata/traces/19c/io_waits.trc` verbatim (the
cursor id is hidden on phones) and the resource profile of that trace; the
numbers there and in the text-report excerpt must stay in step with
`mtkprof report testdata/traces/19c/io_waits.trc`.

Design direction: exact, forensic, unhurried. The product's own ink ramp,
IBM Plex and the wait-class colors; color appears only in data. The one
signature is the small wait-class swatch, used only where it marks a wait
class. Weights 400–500 (600 for the wordmark), spacing on a 4px grid.

## Content

The docs page is a condensed user guide. Its sources of truth are
`README.md`, `docs/DESKTOP.md`, `docs/REMOTE.md`, `docs/REF-BUNDLE.md` and
`desktop/README.md` (building the app);
when a command, flag or behaviour changes there, update `docs.html` too.

## Publishing

Live at https://davidbudac.github.io/modern-tkprof/, served by GitHub Pages
from the `gh-pages` branch, which is the history of `site/` (no GitHub
Actions). After committing a change to `site/`:

```
scripts/publish-site.sh            # git subtree split of site/ -> push gh-pages
scripts/publish-site.sh --dry-run  # show what would be published
```

`.nojekyll` makes Pages serve the files as they are.
