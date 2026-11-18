# The dump reader: mock-up

A throwaway, interactive mock-up of the view of `docs/PLAN-DIAG.md` § "The reader" and § "The readings (level 2)", working on **real lab
traces**, so the owner can approve or correct the look before the real UI is built. Plain HTML, CSS and JavaScript: no build step, no
framework, no dependency. It is a sibling of `docs/mockups/10053-reader/` (same tokens, shell, viewer, outline, guide; `tokens.css` and
`base.css` are the app's, byte for byte).

## Open it

Open `index.html` from disk (`file://` works; IBM Plex is loaded from `web/src/lib/fonts/` by relative path, system fonts otherwise).
Light by default per the system; the **Theme** button cycles auto / light / dark.

| URL parameter | Values | Meaning |
|---|---|---|
| `file` | `errorstack` (default), `process`, `heap`, `sysstate`, `hang` | the example; `process` is the error stack file with its session selected |
| `variant` | `a` (default), `b` | where a reading lives (see below); the **Layout A / B** switch in the top bar does the same |
| `theme` | `auto`, `light`, `dark` | |
| `mode` | `reading`, `text` | variant A: what the centre shows |
| `heap` | `h1` … `h80` | heap file: the heap selected (`h1` pga heap, `h30` the session heap with a hash join and a sort) |
| `tab` | `comment`, `type`, `subs` | heap file: the table |
| `chunk` | `0`, `1`, … | heap file: select the n-th row of the comment table, so its chunks are marked in the text |
| `node` | an outline id (`n12`, `sg3`, …) | select a node |
| `q` | text | search |
| `hideidle` | any | system state: hide idle background processes |

Example: `index.html?file=heap&variant=b&theme=dark&heap=h30&chunk=0`.

## The two variants (the choice the owner has to make)

- **A**: the centre has a **Reading | Text** switch for a section that has a reading (disabled for one that has none); the right panel is
  the **guide and details** (what the node is, lines, folds, hits, the guide text with its source). Selecting an outline node switches to
  the reading when there is one; a link in a reading ("line 755", "In text") switches to the text.
- **B**: the centre is **always the text**; the reading is in the **right panel**, wider by default (`clamp(26rem, 36vw, 40rem)`) and
  **resizable** (drag its left edge, or focus it and use the arrow keys; the width is kept in `localStorage`). The guide is under the
  reading, in "About this section".

## What it shows

1. **Error stack** (`diag_errorstack_l2.trc`, 36,651 lines, the whole file is loaded): outline in file order (file header, the diagnostic
   dump, its sections, the call stack with the binary stack dump's 44 frames as children, the process state with the state object tree
   process, session, then runs of library object locks, enqueue, calls, pins; the cursor dumps; the pinned buffer history), each node
   with its line count. Text with line numbers, section titles dressed as headings, 27 closed folds with a count and a reason (the binary
   stack dump, the argument and register dump, the process map, `Dump of memory` blocks, runs of mutex operation logs, the block dumps),
   where-am-I path, line map, search. Reading: the call stack (statement and sql_id, PL/SQL call stack, frames with the dump's own frames
   folded, the stack as one copyable line).
2. **Process**: the session of the same file: who, what it runs (the top-level call, and what the dump's Current SQL Statement says), its
   wait or "Not in wait", the wait history, what it holds by type (library object locks by mode, pins with their object names,
   enqueue, transaction, calls ...).
3. **Heap** (`diag_heap_sub.trc`, 80 heaps in three dumps): heap tree, the check line (chunks, free lists and permanent chunks against
   the dump's own totals), a sortable table with thin bars (by comment, by type, sub-heaps), the free lists as a histogram, and from a row
   to its chunks in the text (marked lines, a stepper, the chunk lines on the line map).
4. **System state** (`diag_sysstate_l266.trc`, 83,386 lines, 4.9 MB, not in git): the blocker tree of the three chained sessions as the
   dump names them, the process table of the 85 processes (sortable; idle background processes dimmed in the outline and filterable), each
   process opening its process reading. The text holds 7,281 of the 83,386 lines (the header and the process summary, the three sessions'
   processes, the end); the rest is a row "N lines not loaded in this mock-up".
5. **Hang analysis** (`diag_hang.trc`): the two chains drawn as the blocker tree, the node states.

## Rebuild the data

    node tools/parse.mjs        # fixtures -> data/<key>.json, data/<key>.js (the same, loadable from file://), data/<key>.txt.js (the text), data/stats.json

`tools/parse.mjs` (Node, no dependency) reads `testdata/diag/19c/diag_errorstack_l2.trc`, `diag_heap_sub.trc`, `diag_hang.trc` and
`testdata/big/diag/diag_sysstate_l266.trc`. If the last one is missing the data already written is kept. The parser is not the product's:
it knows these four files. Every number on the page comes from it.

Screenshots and checks need Playwright, which is not a dependency of the repository; point `PLAYWRIGHT` at an installed package (and
`CHROMIUM` at a matching `chrome-headless-shell` if the browsers of that version are not installed):

    PLAYWRIGHT=…/node_modules/playwright node tools/shots.cjs [name,name,…]   # shots/*.png, 1440 x 900
    PLAYWRIGHT=…/node_modules/playwright node tools/check.cjs                  # 52 checks of the interactions

## Layout of the folder

- `index.html`, `css/` (`tokens.css`, `base.css`, `page.css`, `view.css` from the 10053 reader; `diag.css` is this view's), `js/`
  (`app.js` state, viewer, outline, line map, search, the two variants; `readings.js` the five readings; `guide.js` the guide, each entry
  with its source; `util.js`).
- `data/` (generated), `tools/` (`parse.mjs`, `shots.cjs`, `check.cjs`, `pw.cjs`), `shots/` (1440 x 900).

## What is real, and what is faked, simplified or left out

**Real, read from the files by `parse.mjs`**: the outline and its line counts; the state object tree and its runs (consecutive objects of
one type with three or more are grouped); the frames (from the binary stack dump's frame headers); the statement, the PL/SQL stack; the
process readings (who, wait, wait history, holds, statements found by the handle the session points at); every heap's chunks by comment and
type, its free-list buckets, its sub-heaps (size and extents from the parent's `ds` line) and the **check** (computed, not copied: sums
of the chunk lines against the `Total heap size`, `Total free space`, `Permanent space` lines); the process summary, the blocker words, the
time in wait from each session's `Current Wait Stack` (`total=`); the hang chains; the fold ranges and their counts; search over the loaded
text.

**Faked, simplified or left out**
- Folds: which noise is folded (the rules in `parse.mjs`) and the reason texts are mine; the heap's `FREE LISTS:` and `PERMANENT CHUNKS:`
  blocks are folded because they list chunks again. Nothing else is hidden.
- "The dump's own frames" (`ksedst1`, `ksedst`, `dbkedDefDump`, `ksedmp`, `dbkdaKsdActDriver`, `dbgda*`, `dbgdRunActions`, `dbgdParseCmd`,
  `dbkdParseCmd`) is a list I chose; the format reference does not give one.
- "Idle background process" is a regular expression of mine over the wait event (`idle`, `timer`, `rdbms ipc message`, `slave wait`,
  `Streams AQ`, `Data Guard` ...) or `sid 0`; the dump does not print Oracle's wait class. A foreground process is never idle here.
- The blocker tree is built from the summary's `Blocked by` / `Final Blocker` lines; the three sessions are not hard-coded.
- The hang analysis is **not** the same run as the system state: its sessions are 255.22508, 52.55849, 61.26319 and 3.37475; the system
  state's chain is 255.62769, 45.12004, 52.41898. Both come from the same three-session scenario.
- Only literal, case-insensitive search, over the loaded text. No regular expression, no notes or bookmarks, no jump to a 10046 tab, no
  digest, no paging from a server (the text of two files is loaded whole; the system state's is a slice).
- The system state's other processes open their reading (computed from the whole file) but their text is not loaded, and their state
  object trees are not in the outline (the product would load them on open); only the three sessions' processes have trees.
- Line numbers in the readings link to the text only where the text is loaded; elsewhere they are shown dimmed.
- Level 3 errorstack (`Fixed Areas Dump`), PGA summary and detail, deadlock graph, incident files: not in the mock-up.
- The guide text is written from `docs/trace-format-diag.md` only; a node kind without such a source says "No guide text".

## Points the mock-up cannot decide (for the owner)

- A or B (above).
- **Time in wait** is the `total=` of the session's current wait stack entry. For a timer-like wait it restarts at every timeout (PMON shows
  0.0007 s on a `pmon timer`), so it only means something for the waits that block (the lock waits, 6 to 7 s here). Show it for every row,
  or only outside the idle events?
- **Idle**: the dump prints no wait class, so "idle background" is a list of mine. Is a dimmed row plus a filter enough, or should idle
  processes be folded into one summary row?
- **Folds closed by default** (27 in the error stack, hiding 32,777 lines): the owner may prefer fewer. The heap's two "listed again"
  blocks are folded too.
- **What drives the reading**: here only a selection (an outline node, a click on a line); scrolling the text moves the path above it but
  not the reading. The 10053 view's path follows the scroll; should the reading?
- **Heap tree**: the whole dump run is listed (up to 40 heaps), with the selected heap scrolled into view. Run 3 dumps the session heap
  twice (alone, then as a sub-heap of the top uga heap) and the tree shows both.
