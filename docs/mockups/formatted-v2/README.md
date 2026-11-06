# Formatted Trace view, round 2: mock-up

`index.html` is a single self-contained page (inline CSS, JS and data; it opens from disk, no server). It lays out ten proposed
changes to the Formatted view of the Trace tab. Each change is shown as **NOW** (what the app draws today, re-rendered with the
app's own rules from `web/src/lib/styles/lines.css`) above **PROPOSED**, on the same real rows of
`testdata/traces/19c/io_waits.trc` (19c, session 51.14688), with a one-to-three-sentence caption under each. Section 0 holds two
full-pane composites at 1560 px (NOW versus all ten changes); the last box lists things that look like bugs rather than design.

Light by default; dark follows `prefers-color-scheme`, and the top-right **Theme** button cycles auto / light / dark (`data-theme`
on `<html>`). Fonts are IBM Plex from Google Fonts with system fallbacks (the page works offline).

## Rebuild

    node build.mjs                      # src/ + data/ -> index.html

    node tools/extract-extra.mjs > data/extra.json    # only if the extra lines change (reads the real trace)

## Layout

- `data/rows.json`: the spec's four excerpts (lines 23-60, 95-140, 2960-3010, 10355-10401), unchanged.
- `data/extra.json`: the lines of the same trace those excerpts stop short of (84-94, 141-200, 3011-3014, 10402-10443, the SQL text of
  dk21j71dpu26c and 52nzchs09dgn1), the execution number of every EXEC, the time of the line before each excerpt, the file's time
  span and per-statement elapsed time (chips). Same row shapes as `rows.json`.
- `src/tokens.css`: the app's `tokens.css`, verbatim. `page.css` the page shell, `rows.css` the pane (A: NOW = the app's rules; B: one
  block per proposal, switched by a flag class `.p1` ... `.p9`, `.p3gap` on the pane), `chrome.css` toolbar / breadcrumb / bar / chips
  (NOW, and `.p10`).
- `src/fmt.js`, `model.js` (rows, lanes, Δ, binds), `present.js` (rows -> display items, the proposals that change which rows are
  shown), `render.js` (display items -> DOM), `chrome.js`, `sections.js` (the page and its captions), `page.js` (boot, theme, table of
  contents).
- `shots/`: Playwright screenshots (1680 x 1050, light and dark, full page and one per section).

## Class vocabulary (for the implementation)

`.row` with `.c-delta .c-ln .c-lane .c-fh .c-dur .c-op .c-detail .c-clock`; state classes `.mk` (call or wait of the highlighted
statement), `.hlane` (any row of that lane), `.hot`, `.sel`, `.br-first/.br-in/.br-end` (bracket), `.indent`, `.exec-first`,
`.rule-top`; `.bar` (Δ bar, NOW), `.trk` (Duration track), `.dot`, `.pill-hp`, `.share`, `.chip`, `.chip-bind`, `.pre.ditto` and `.mc`
(micro-columns), `.tbl-plan`, `.tbl-binds`, `.c-tbl` (a table spanning Operation to Clock), `.sticky-lane`.

## Things worth knowing

- Clocks in `rows.json` sit 619 µs before the app's (checked against `io_waits-plan-light.png`: row 99 is 11:35:29.828061 there);
  `CLOCK_FIX_US` in `src/model.js` corrects every one.
- The `sqlid` field of non-CURSOR rows in `rows.json` is the *last* statement that used the cursor number, not the one in force
  (cursor 139745604251096 is reused six times); lanes follow the CURSOR rows instead.
- Lane colours are the app's real assignment (the top 8 statements by elapsed time take the categorical slots in order, everything
  else is `--c-idle`), which differs from the brief for 4w3wvjbkvq24v (`--c-network`), dcxgz5g2j9ts2 (`--c-sysio`) and the recursive SYS
  statements (`--c-idle`, not `--ink-3`).
