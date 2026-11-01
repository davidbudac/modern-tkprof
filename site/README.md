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
- `desktop-dark.webp`: the macOS smoke screenshot of mtkprof-desktop
  (`out-smoke/macos-arm64-ready.png`) with the menu bar cropped off.

Retake them when the UI changes visibly. The numbers in the hero figure and
the text-report excerpt on the landing page come from `io_waits.trc`; keep
them in step with `mtkprof report testdata/traces/19c/io_waits.trc`.

## Content

The docs page is a condensed user guide. Its sources of truth are
`README.md`, `docs/DESKTOP.md`, `docs/REMOTE.md` and `docs/REF-BUNDLE.md`;
when a command, flag or behaviour changes there, update `docs.html` too.

## Hosting

Any static host works. GitHub Pages can only publish the repository root or
`/docs` from a branch, so publish `site/` with a Pages workflow or copy it to
a `gh-pages` branch. Pages on a private repository needs a paid plan.
