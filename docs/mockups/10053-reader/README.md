# The 10053 reader: mock-up

`index.html` is one self-contained page (inline CSS, JS, the trace and its model; IBM Plex from `web/src/lib/fonts/` by relative
path, system fonts otherwise). Open it from disk. It is the proposal for the view of `docs/PLAN-10053.md` § Decisions, "The view",
working on a real 19.27 lab trace, `data/two.trc` (27,780 lines, two dumps: `4a6t4jr44yb2d`, the join with an IN and an EXISTS
subquery, and `171f4k9c0yhrg`, the hinted statement with a bad hint). Everything the page shows is read from that file by
`tools/parse.mjs`; the only hand-written content is the guide text (`src/guide.js`), each entry with its source.

Layout: the outline (with Landmarks and Bookmarks tabs) on the left, the text in the centre with the where-am-I path above and the
line map beside the scroll bar, the guide (with an SQL tab) on the right; the toolbar row above, the app's top bar and info bar on top.
Light by default, dark by `prefers-color-scheme`; the Theme button cycles auto / light / dark (`data-theme` on `<html>`; `?theme=dark`
in the URL also works).

## Rebuild

    node build.mjs        # data/two.trc + src/ -> index.html (and data/model.json, the parser's output, for reading)

Screenshots and checks need Playwright, which is not a dependency of the repository; point `PLAYWRIGHT` at an installed package:

    PLAYWRIGHT=…/node_modules/playwright node tools/shots.cjs [overview,costing,runs,search,sql,plan,hints,raw]
    PLAYWRIGHT=…/node_modules/playwright node tools/check.cjs      # 43 checks: keys, folds, search, map, dumps, theme …

## Layout of the folder

- `data/two.trc`: the trace (a copy of the lab probe). `data/model.json`: what the parser made of it (written by the build).
- `tools/parse.mjs`: the throwaway parser: banners, dumps, the outline (a stack of open sections), landmarks, folds, costing runs and
  their verdicts and identical text, the `UNPARSED QUERY IS` versions, the plan table, the legend. `tools/shots.cjs`, `tools/check.cjs`.
- `src/tokens.css`, `src/base.css`: the app's, verbatim. `src/page.css`: the shell (top bar, info bar, toolbar row, side panels with
  icon tabs, path row, status bar; the rules copied from `app.css` / `lines.css` are marked). `src/view.css`: the viewer, landmarks,
  folds, SQL band, plan band, outline, landmark list, guide, SQL panel.
- `src/guide.js` (guide and glossary, with sources), `src/sqlfmt.js` (pretty-printer and line diff), `src/model.js` (indices over the
  model), `src/paint.js` (rows and their HTML), `src/panels.js` (the side panels), `src/app.js` (state, viewer, line map, keys).
- `shots/`: 1680 x 1050.

## What is real and what is mocked

Real (read from the file, working on all of it): the outline and its line counts, the dump list, the folds, the banner headings,
landmarks and their kinds, the costing runs, their verdicts and the "same as run N" comparison, the SQL versions, the plan, the legend
(glossary), search, the line map. The text is virtualised (20 px rows; 11,862 formatted rows for the 18,523 lines of dump 1).

Mocked: bookmarks and notes live in memory only; the hover card for glossary terms is a page element, not the app's; "Theme" is the
mock-up's toggle, not the app's setting; there is no engine (the parse runs at build time). The guide's text is written by hand from
the two sources allowed for the mock-up (the trace's Legend and `docs/trace-format-10053.md`); a section or line kind without such a
source shows "No guide text".

## Counts the build found

- 27,780 lines; 2 dumps: `4a6t4jr44yb2d` lines 1-18,523 (dump 32-18,278, the AP execution lines after it), `171f4k9c0yhrg` 18,524-27,780.
- 527 outline nodes.
- Landmarks (both dumps): Best:: AccessPath 40, Best:: JoinMethod 80, Final cost 21, Join order aborted 76, verdicts 12
  (6 Updated, 4 Not update, `JPPD: Will not use`, `CVM: Will not merge`), hint errors 3, refusals 190. On by default: all but the
  refusals (232 of 422).
- Costing runs: 9 in dump 1 (none identical), 14 in dump 2 (runs 5, 6, 11, 12 identical to 1, 2, 7, 8, folded); 3 runs after
  `Final query after transformations` labelled "final plan".
- Folds (63, closed by default): parameters with default values 2 (1,228 lines), the optimizer state dump 2 (4,700; the fix controls
  inside it 2 x 1,736 as inner folds), adaptive plan re-costing 3 (3,702), identical runs 4 (1,571), the statement text repeated 16
  (78), a repeated `UNPARSED` statement 34 (34). Dump 1 shows 6,254 lines hidden by 33 closed folds.
- 47 `UNPARSED QUERY IS` statements (31 + 16); 47 legend terms; plans of 22 and 16 operations.

## Class vocabulary (for the implementation)

Viewer: `.lv`, `.lv-row` with `.lv-ln` (number cell, sticky), `.lv-fh` (fold slot, `.lv-fold` button), `.lv-tx`; states `.lv-sel`,
`.lv-bm`, `.lv-note`; landmarks `.lm` + `.lm-kept` / `.lm-rejected` / `.lm-problem` (a 3 px bar in the number cell in `--lm`, a faint
fill; Raw keeps the bar only); dress `.x-h1` (a banner opening a section of level 3 or less: sunken band), `.x-h2` (other banners,
upper-case headings), `.x-h3` (`----- X -----`), `.x-rule` (a lone separator line as a hairline), `.x-pfx` (the `GBP:` prefix),
`.x-best`, `.gl` (glossary term, dotted underline on hover / selection), `.x-fold` + `.fold-sum` (a closed fold: first line, count,
reason, hits inside), `.x-sql` / `.x-sql-first` / `.x-sql-last` (a pretty-printed statement as a band), `.x-sqlhead` + `.x-act`
(the `UNPARSED` header and its diff link), `.x-planhead` + `.x-seg` (Plan | Text), `.lv-tbl` with `.pc-id .pc-op .pc-name .pc-n
.pc-time .pc-pred` (the plan band; `--opw`, `--nmw` measured per plan). Line map `.lv-strip` (canvas). Outline `.ol-row` (`--d` depth)
`.ol-x .ol-main .ol-l1 .ol-l2 .ol-label .ol-res .ol-n .ol-hits .ol-tag(.final .same .best) .ol-dot(.kept .rejected)`, `.ol-dump`,
`.ol-phase`. Landmark list `.lmk-row .lmk-sw .lml-h .lml-i`. Guide `.g-sec .g-k .g-t .g-p .g-none .g-terms`. SQL panel `.sqlv-i
.sqlv-pre .d-add .d-del`.

## Proposals the user should confirm

- **Landmark defaults**: on are the kinds that end a unit the outline shows (verdict: iteration; Final cost: run; Best:: AccessPath:
  table; Best:: JoinMethod: join step; Join order aborted: join order) and hint errors; off are the refusals (190, one per
  transformation per query block). A kind that is off is not tinted, not on the map and not stepped through.
- **Tints**: kept `--s-good`, rejected neutral (`--wash`, `--ink-3` bar), problem `--s-critical`. Amber stays the selection and search.
- **The landmark list** is a tab of the left panel (beside the outline), grouped by kind with switches.
- **Outline order**: file order, with iterations as a level (`… › GBP iteration 2 › SEL$9108899D run 2 of 9 › …`); the query block is
  named on the run. The plan's "query block → costing run" level is replaced by this; an "All | Runs" switch lists the runs alone.
- **Raw** shows the open dump's lines (the file header is in dump 1's range), not the whole file.
- **Plan**: query block names and predicates are sub-rows under their operation (a column did not fit beside the numbers).
- **SQL diff**: against the previous `UNPARSED` statement by default (it is often another query block's text); a menu picks another.
