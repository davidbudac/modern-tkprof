# Visualisation concepts (2026-11-01)

A design study: five ways to look at one trace, each drawn from real numbers of
`testdata/traces/19c/io_waits.trc`. Three of them are being implemented; the plan is
`docs/PLAN-VIEWS.md`. The other two (dotplot of the call sequence, statement fingerprint wall)
are not planned.

| mock-up section | concept | status |
|---|---|---|
| 1 | Block map: the I/O address space (`block-map.png`) | planned: the **Blocks** view |
| 2 | Row-flow Sankey of the plan (`row-flow.png`) | planned: **Row flow** in the statement inspector |
| 3 | Dotplot of the call sequence (loop finder) | not planned |
| 4 | The trace as a sequence diagram (`dialogue.png`) | planned: **Dialogue** in the statement inspector |
| 5 | Statement fingerprint wall | not planned |

## Rebuilding the page

```
mtkprof export -o /tmp/io_waits.csv testdata/traces/19c/io_waits.trc
python3 -I docs/viz-concepts/extract.py /tmp/io_waits.csv docs/viz-concepts/data.json
node docs/viz-concepts/build.mjs            # -> docs/viz-concepts/concepts.html (self-contained, open in a browser)
```

`data.json` and `concepts.html` are generated and not committed. `template.html` holds the drawing
code (vanilla JS, SVG and canvas, no dependencies): `fig1()` is the block map, `fig2()` the Sankey,
`fig4()` the sequence diagram. The callout placement, the broken order axis, the self-time
subtraction and the loop-frame collapse there are the reference for the product views; the
product does not reuse the code.

The PNGs are the rendered sections at the time of the study (fallback fonts: headless Chromium
had no Inter or SF).
