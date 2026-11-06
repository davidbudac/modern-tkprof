import { describe, expect, it } from 'vitest'
import {
  BAND_ALPHA, bandsOf, blockOfY, blockTicks, bracketsOf, colorRows, drawBlockMap, eventTones, hitTest, indexOfX, isTempEvent, isWriteEvent,
  labelRows, markRect, MIN_STRETCH_PX, orderScale, PANEL_PAD, panelHeight, panelsOf, phaseRuns, RULER_X, stmtRuns, timeScale, timOfX, xOfIndex, xOfTim,
  xTicks, yOfBlock, type Paint,
} from './blocklayout'
import { IO, type IOMap } from './iomap'
import type { Event } from './types'
import ioMapCase from './testdata/iomap-case.json'

const ev = (id: number, name: string, cls = 'User I/O'): Event => ({ id, name, class: cls, p1Name: 'file#', p2Name: 'block#', p3Name: 'blocks', idle: false })
const events = [ev(0, 'db file sequential read'), ev(1, 'direct path read'), ev(2, 'direct path write temp'), ev(3, 'direct path read temp'), ev(4, 'buffer busy waits', 'Concurrency'), ev(5, 'db file single write')]

// [tim, ela, event, file, block, blocks, obj, stmt, call, line, ctx, dep]
const row = (o: { tim?: number; ela?: number; event?: number; file?: number; block: number; blocks?: number; obj?: number; stmt?: number; ctx?: number; dep?: number; line?: number }) =>
  [o.tim ?? 0, o.ela ?? 1, o.event ?? 1, o.file ?? 12, o.block, o.blocks ?? 1, o.obj ?? 42, o.stmt ?? 0, -1, o.line ?? 1, o.ctx ?? 0, o.dep ?? 0]

const mapOf = (rows: number[][], total = rows.length): IOMap => {
  const files = new Map<number, { file: number; lo: number; hi: number; n: number }>()
  for (const r of rows) {
    const f = files.get(r[IO.file]) ?? { file: r[IO.file], lo: Infinity, hi: -Infinity, n: 0 }
    f.lo = Math.min(f.lo, r[IO.block]); f.hi = Math.max(f.hi, r[IO.block] + r[IO.blocks]); f.n++
    files.set(r[IO.file], f)
  }
  return { total, sampled: total > rows.length, cols: [], rows, files: [...files.values()].sort((a, b) => a.file - b.file), events: [...new Set(rows.map((r) => r[IO.event]))].sort((a, b) => a - b) }
}

describe('classification helpers', () => {
  it('tell temp and write waits by the event name', () => {
    expect(events.map(isTempEvent)).toEqual([false, false, true, true, false, false])
    expect(events.map(isWriteEvent)).toEqual([false, false, true, false, false, true])
  })
})

describe('panels', () => {
  it('are clamp(60, 320, 40 + 40·log10(1 + range)) px tall; a file of a few marks gets the smallest', () => {
    expect(panelHeight({ lo: 167795, hi: 172288, n: 194 })).toBe(186) // io_waits datafile 12
    expect(panelHeight({ lo: 756103, hi: 756743, n: 8550 })).toBe(152) // tempfile 203
    expect(panelHeight({ lo: 66397, hi: 80392, n: 3 })).toBe(60) // datafile 10: three reads
    expect(panelHeight({ lo: 0, hi: 1e12, n: 100 })).toBe(320)
    expect(panelHeight({ lo: 5, hi: 6, n: 100 })).toBe(60)
  })
  it('one per file with waits, in file order, with the rows of the file and whether it is a tempfile', () => {
    const rows = [row({ file: 203, block: 5, event: 2 }), row({ file: 12, block: 100 }), row({ file: 203, block: 6, event: 3 }), row({ file: 12, block: 90 })]
    const ps = panelsOf(mapOf(rows), events)
    expect(ps.map((p) => [p.file, p.lo, p.hi, p.n, p.temp, [...p.rows]])).toEqual([[12, 90, 101, 2, false, [1, 3]], [203, 5, 7, 2, true, [0, 2]]])
  })
  it('map block numbers to y with lo at the bottom, and round ticks inside the range', () => {
    const p = { lo: 1000, hi: 2000 }
    expect(yOfBlock(p, 108, 1000)).toBe(108 - PANEL_PAD) // the ends stay PANEL_PAD inside the panel
    expect(yOfBlock(p, 108, 2000)).toBe(PANEL_PAD)
    expect(yOfBlock(p, 108, 1500)).toBe(54)
    expect(blockOfY(p, 100, yOfBlock(p, 100, 1234))).toBeCloseTo(1234)
    const t = blockTicks({ lo: 167795, hi: 172288 }, 186)
    expect(t.map((x) => x.block)).toEqual([168000, 169000, 170000, 171000, 172000])
    expect(t.every((x) => x.y >= 0 && x.y <= 186)).toBe(true)
  })
})

describe('the order axis', () => {
  // the statement stretches of io_waits.trc: stmt 6 (26 reads), 9 (45 + the recursive read of stmt 7), 10 (26), 21, 22
  const runs = [{ i0: 0, i1: 26 }, { i0: 26, i1: 72 }, { i0: 72, i1: 98 }, { i0: 98, i1: 2787 }, { i0: 2787, i1: 8747 }]
  it('widens the short stretches to the minimum and keeps the rest linear', () => {
    const xs = orderScale(8747, 1000, runs)
    expect(xs.segs.map((s) => [s.i0, s.i1])).toEqual([[0, 26], [26, 72], [72, 98], [98, 8747]]) // the two long runs share one scale: one segment
    expect(xs.segs.slice(0, 3).map((s) => s.x1 - s.x0)).toEqual([MIN_STRETCH_PX, MIN_STRETCH_PX, MIN_STRETCH_PX])
    expect(xs.segs[3].x1).toBe(1000)
    expect(xs.stretch).toBeGreaterThan(20) // 26 rows of 8,747 on 1,000 px are 3 px: widened to 64
    for (const x of [0, 10, 63.9, 64, 150, 191.9, 192, 500, 999]) expect(xOfIndex(xs, indexOfX(xs, x))).toBeCloseTo(x)
    expect(xOfIndex(xs, 26)).toBeCloseTo(64)
    expect(indexOfX(xs, -5)).toBe(0)
    expect(indexOfX(xs, 5000)).toBe(8747)
  })
  it('stays linear when nothing is short, with one stretch, or when the short ones would take over half the width', () => {
    expect(orderScale(1000, 1000, [{ i0: 0, i1: 500 }, { i0: 500, i1: 1000 }]).segs).toHaveLength(1)
    expect(orderScale(8747, 1000, [{ i0: 0, i1: 8747 }]).stretch).toBe(1)
    const many = Array.from({ length: 10 }, (_, k) => ({ i0: k, i1: k + 1 })).concat([{ i0: 10, i1: 10000 }])
    const xs = orderScale(10000, 1000, many)
    expect(xs.segs).toEqual([{ i0: 0, i1: 10000, x0: 0, x1: 1000 }])
    expect(orderScale(0, 1000, runs).segs).toEqual([])
  })
  it('labels the ticks with the place among all waits (whole waits), times the sampling step', () => {
    expect(xTicks(orderScale(1, 1000), { total: 1, rows: [[]] }).map((t) => t.value)).toEqual([0])
    expect(xTicks(orderScale(3, 1000), { total: 3, rows: [[], [], []] }).map((t) => t.value)).toEqual([0, 1, 2])
    const xs = orderScale(100, 1000)
    const t = xTicks(xs, { total: 100, rows: Array.from({ length: 100 }, () => []) })
    expect(t.map((x) => x.value)).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90])
    const sampled = xTicks(xs, { total: 200, rows: Array.from({ length: 100 }, () => []) }) // 1 in 2: row i is the 2i-th wait
    expect(sampled.map((x) => x.value)).toEqual([0, 20, 40, 60, 80, 100, 120, 140, 160, 180])
    expect(sampled[1].x).toBeCloseTo(100)
  })
})

describe('marks', () => {
  const p = { lo: 0, hi: 1000 }
  it('are as tall as their blocks, at least 1 px (centred), 2 px wide at ≤ 2,000 rows and 1 px above', () => {
    const rows = [row({ block: 100, blocks: 100 }), row({ block: 500, blocks: 1 })]
    const xs = orderScale(2, 200)
    const r0 = markRect(xs, rows, 0, p, 108) // 100 px per row: as wide as the cap, centred in the slot; 100 blocks of 1000 on 100 px
    expect([r0.x, r0.w]).toEqual([48, 3])
    expect(r0.y).toBeCloseTo(84)
    expect(r0.h).toBeCloseTo(10)
    const m = markRect(xs, rows, 1, p, 108)
    expect(m.h).toBe(1)
    expect(m.y).toBeCloseTo(54 - 0.05 - 0.5)
    expect(markRect(xs, rows, 1, { ...p, n: 3 }, 100)).toMatchObject({ h: 5, w: 3 }) // a panel of a few marks draws them bigger
    expect(markRect(xs, rows, 1, { ...p, n: 100 }, 100).h).toBe(2) // a sparse one a little taller
    expect(markRect(xs, rows, 1, { ...p, n: 5000 }, 100).h).toBe(1)
    const many = Array.from({ length: 3000 }, (_, i) => row({ block: i % 1000 }))
    expect(markRect(orderScale(3000, 1000), many, 10, p, 100).w).toBe(1)
    expect(markRect(orderScale(1500, 300), many.slice(0, 1500), 10, p, 100).w).toBe(2)
  })
  it('sit on their [tim - ela, tim] interval on the time axis', () => {
    const rows = [row({ tim: 1100, ela: 100, block: 1 }), row({ tim: 2000, ela: 500, block: 2 }), row({ tim: 2000, ela: 0, block: 3 })]
    const xs = timeScale(rows, 1000)
    expect([xs.t0, xs.t1]).toEqual([1000, 2000])
    expect(xOfTim(xs, 1500)).toBe(500)
    expect(timOfX(xs, 250)).toBe(1250)
    expect(markRect(xs, rows, 1, p, 100)).toMatchObject({ x: 500, w: 500 })
    expect(markRect(xs, rows, 2, p, 100)).toMatchObject({ x: 1000, w: 2 }) // a zero-length wait still shows
    const ticks = xTicks(xs, mapOf(rows), { base: 0, minGapPx: 200 })
    expect(ticks.map((t) => t.value)).toEqual([1000, 1200, 1400, 1600, 1800, 2000])
  })
})

describe('brackets', () => {
  it('are the runs of one statement, with recursive waits joining the run they sit in', () => {
    const rows = [row({ stmt: 6, block: 1 }), row({ stmt: 6, block: 2 }), row({ stmt: 7, dep: 1, event: 0, block: 3 }), row({ stmt: 9, block: 4 }), row({ stmt: 6, block: 5, event: 2 })]
    const b = stmtRuns(rows)
    expect(b.map((x) => [x.key, x.i0, x.i1])).toEqual([[6, 0, 3], [9, 3, 4], [6, 4, 5]])
    expect([...b[0].byEvent]).toEqual([[1, 2]]) // the recursive read of statement 7 is in the run, not in its counts
  })
  it('start a run for a wait at the run\'s own depth or shallower, or in another context; deeper ones before a statement are its own', () => {
    const rows = [
      row({ stmt: 14, dep: 3, block: 1 }), row({ stmt: 15, dep: 3, block: 2 }), // same depth: two runs
      row({ stmt: 9, dep: 2, block: 3 }), row({ stmt: 4, dep: 1, block: 4 }), // shallower: runs of their own
      row({ stmt: 25, dep: 2, block: 5 }), // deeper than 4, same context: joins it
      row({ stmt: 26, dep: 2, ctx: 5, block: 6 }), // another context: its own run
    ]
    // 14 and 15 (depth 3) and 9 (depth 2) ran for 4 (depth 1): its run; 25 (depth 2) after it joins it; 26 is another session
    expect(stmtRuns(rows).map((x) => [x.key, x.i0, x.i1])).toEqual([[4, 0, 5], [26, 5, 6]])
    expect(stmtRuns(rows.slice(0, 2)).map((x) => [x.key, x.i0, x.i1])).toEqual([[14, 0, 1], [15, 1, 2]]) // one depth: two runs
  })
  it('give the recursive waits right before a statement to that statement (io_waits: the QOSD read before the sort)', () => {
    const rows = [row({ stmt: 10, ctx: 1, block: 1 }), row({ stmt: 7, dep: 1, ctx: 4, block: 2 }), row({ stmt: 21, ctx: 4, block: 3 }), row({ stmt: 21, ctx: 4, block: 4 })]
    const b = stmtRuns(rows)
    expect(b.map((x) => [x.key, x.i0, x.i1])).toEqual([[10, 0, 1], [21, 1, 4]])
    expect([...b[1].byEvent]).toEqual([[1, 2]])
  })
  it('fall back to the phases (named contexts) above twelve statement runs', () => {
    const label = (ctx: number) => ['', 'full_scan', 'sort_spill'][ctx] ?? ''
    const few = [row({ ctx: 0, block: 1 }), row({ ctx: 1, block: 2, stmt: 1 }), row({ ctx: 1, block: 3, stmt: 2 }), row({ ctx: 2, block: 4, stmt: 3 })]
    expect(phaseRuns(few, label).map((x) => [x.key, x.i0, x.i1])).toEqual([['', 0, 1], ['full_scan', 1, 3], ['sort_spill', 3, 4]])
    const b = bracketsOf(few, label)
    expect(b.stmts.map((x) => x.key)).toEqual([0, 1, 2, 3])
    expect(b.phases.map((x) => x.key)).toEqual(['', 'full_scan', 'sort_spill'])
    expect(b.runs).toBe(b.stmts)
    const many = Array.from({ length: 30 }, (_, i) => row({ stmt: i, ctx: i < 15 ? 1 : 2, block: i }))
    const m = bracketsOf(many, label)
    expect(m.stmts).toEqual([])
    expect(m.phases.map((x) => [x.key, x.i0, x.i1])).toEqual([['full_scan', 0, 15], ['sort_spill', 15, 30]])
    expect(bracketsOf(many, () => '').runs).toEqual([])
  })
  it('get label rows that do not overlap; no room is -1', () => {
    expect(labelRows([{ x0: 0, x1: 64, width: 150 }, { x0: 64, x1: 128, width: 150 }, { x0: 128, x1: 192, width: 150 }, { x0: 192, x1: 900, width: 200 }]))
      .toEqual([0, 1, 2, 0])
    expect(labelRows([{ x0: 0, x1: 64, width: 50 }, { x0: 64, x1: 128, width: 50 }])).toEqual([0, 0])
    expect(labelRows([{ x0: 0, x1: 1, width: 50 }, { x0: 1, x1: 2, width: 50 }, { x0: 2, x1: 3, width: 50 }], 2)).toEqual([0, 1, -1])
  })
})

describe('colours', () => {
  it('give each event a tone: temp reads and writes their hues, User I/O reads and writes, concurrency, shades within one token', () => {
    const t = eventTones([...events, ev(6, 'db file scattered read')], [0, 1, 2, 3, 4, 5, 6])
    expect([...t.values()].map((x) => `${x.token}:${x.shade}`)).toEqual([
      '--c-userio:0', '--c-userio:1', '--bm-temp-w:0', '--bm-temp-r:0', '--c-concurrency:0', '--bm-write:0', '--c-userio:2',
    ])
  })
  const rows = [
    row({ event: 1, obj: 100, blocks: 32, block: 0, stmt: 6 }), row({ event: 1, obj: 200, blocks: 8, block: 40, stmt: 9 }),
    row({ event: 2, obj: 100, file: 203, block: 1, stmt: 21 }), row({ event: 0, obj: -1, block: 60, stmt: 21 }), row({ event: 3, obj: 100, file: 203, block: 1, stmt: 21 }),
  ]
  it('by object: ranked by blocks, temp waits keep their event colour, no object is idle grey', () => {
    const c = colorRows(mapOf(rows), events, 'object')
    expect([...c.idx].map((i) => c.tones[i].token)).toEqual(['--c-cpu', '--c-network', '--bm-temp-w', '--c-idle', '--bm-temp-r'])
    expect(c.legend.map((l) => [l.kind, l.key, l.rows])).toEqual([['object', 100, 1], ['object', 200, 1], ['event', 2, 1], ['event', 3, 1], ['none', -1, 1]])
    expect([...c.objectTone.keys()]).toEqual([100, 200]) // the temp rows' obj# 100 does not count for the extents
  })
  it('by statement: ranked by rows; by event: one tone per event, legend in event order', () => {
    const s = colorRows(mapOf(rows), events, 'statement')
    expect(s.legend.map((l) => [l.key, l.rows, l.tone.token])).toEqual([[21, 3, '--c-cpu'], [6, 1, '--c-network'], [9, 1, '--c-userio']])
    const e = colorRows(mapOf(rows), events, 'event')
    expect(e.legend.map((l) => [l.key, l.rows])).toEqual([[0, 1], [1, 2], [2, 1], [3, 1]])
    expect(e.tones).toHaveLength(4)
  })
})

describe('hitTest', () => {
  it('finds the mark under the pointer, the nearest within the slop, nothing farther away', () => {
    const rows = [row({ block: 100, blocks: 100 }), row({ block: 500 }), row({ block: 900 }), row({ block: 120, file: 13 })]
    const panel = panelsOf(mapOf(rows), events)[0]
    expect([...panel.rows]).toEqual([0, 1, 2])
    const xs = orderScale(rows.length, 400) // 100 px per row
    const y = (b: number) => yOfBlock(panel, panel.height, b)
    expect(hitTest(xs, rows, panel, 49, y(150))).toBe(0) // the marks sit in the middle of their 100 px slots
    expect(hitTest(xs, rows, panel, 150, y(500) + 2)).toBe(1)
    expect(hitTest(xs, rows, panel, 150, y(700))).toBe(-1)
    expect(hitTest(xs, rows, panel, 100, y(150))).toBe(-1) // between the marks
    expect(hitTest(xs, rows, panel, 350, y(120))).toBe(-1) // row 3 is in another file
    const ts = timeScale(rows, 400)
    expect(hitTest(ts, rows, panel, 399, y(900))).toBe(2)
  })
})

describe('drawBlockMap', () => {
  const fake = () => {
    const calls: { style: unknown; alpha: number; x: number; y: number; w: number; h: number }[] = []
    const ctx: Paint & { calls: typeof calls } = {
      fillStyle: '', globalAlpha: 1, calls,
      fillRect(x, y, w, h) { calls.push({ style: this.fillStyle, alpha: this.globalAlpha, x, y, w, h }) },
    }
    return ctx
  }
  it('paints the grid, the bands with their ruler left of the plot, then every mark of the panel by colour', () => {
    const rows = [row({ block: 1000, blocks: 32, obj: 7 }), row({ block: 1500, event: 0, obj: 7 }), row({ block: 1800, blocks: 8, obj: 7 }), row({ block: 5, file: 13 })]
    const map = mapOf(rows)
    const panel = panelsOf(map, events)[0]
    const coloring = colorRows(map, events, 'event')
    const bands = bandsOf(map, events, panel, coloring.objectTone)
    expect(bands.map((b) => [b.obj, b.runs, b.blocks])).toEqual([[7, [{ lo: 1000, hi: 1032 }, { lo: 1500, hi: 1501 }, { lo: 1800, hi: 1808 }], 41]])
    const ctx = fake()
    const xs = orderScale(rows.length, 300)
    const n = drawBlockMap(ctx, panel, rows, xs, coloring.idx, { tones: coloring.tones.map((t) => `${t.token}:${t.shade}`), grid: 'grid', bands: bands.map((b) => ({ runs: b.runs, color: 'band' })) })
    expect(n).toBe(3)
    const marks = ctx.calls.filter((c) => c.style !== 'grid' && c.style !== 'band')
    // grouped by colour: the direct path reads (rows 0 and 2, the second User I/O event: shade 1), then the single block read
    expect(marks.map((m) => [m.style, m.x])).toEqual([['--c-userio:1', 36], ['--c-userio:1', 186], ['--c-userio:0', 111]]) // 4 rows on 300 px: 3 px marks in 75 px slots
    expect(ctx.calls.filter((c) => c.style === 'band' && c.alpha === BAND_ALPHA)).toHaveLength(3)
    expect(ctx.calls.filter((c) => c.style === 'band' && c.alpha !== BAND_ALPHA).every((c) => c.x === -RULER_X)).toBe(true)
    expect(ctx.calls.filter((c) => c.style === 'grid').length).toBeGreaterThan(0)
    expect(bandsOf(map, events, { file: 203, temp: true }, coloring.objectTone)).toEqual([])
  })
})

describe('the shared io_waits excerpt', () => {
  it('lays out its block I/O waits: two files, statement runs that cover the rows', () => {
    const map = ioMapCase.cases[0].expect // limit 20: 20 of the 77 rows
    // the datafile and the tempfile; not the control files (p1 file# 0 and 1 of the control file waits in the excerpt)
    expect(map.files.map((f) => f.file)).toEqual([12, 203])
    const evs = ioMapCase.events as Event[]
    const ps = panelsOf(map, evs)
    expect(ps.map((p) => [p.file, p.height, p.temp])).toEqual([[12, panelHeight(map.files[0]), false], [203, panelHeight(map.files[1]), false]])
    const b = bracketsOf(map.rows, () => '')
    expect(b.stmts.length).toBeGreaterThan(0)
    expect(b.runs.reduce((a, r) => a + r.i1 - r.i0, 0)).toBe(map.rows.length) // the runs cover the rows
  })
})
