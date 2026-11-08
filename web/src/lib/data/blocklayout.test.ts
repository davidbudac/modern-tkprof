import { describe, expect, it } from 'vitest'
import {
  BAND_ALPHA, bandsOf, blockAtY, blockOfY, blockTicks, bracketsOf, bucketOf, colorByOf, colorRows, DIM_ALPHA, drawBlockMap, eventTones, hitTest, indexOfX, isTempEvent, isWriteEvent,
  LATENCY_BOUNDS, labelRows, linearY, markRect, MIN_SEG_PX, MIN_STRETCH_PX, orderScale, packedY, PANEL_MIN, PANEL_PAD, panelHeight, panelsOf, phaseRuns, rangesAt, RULER_X,
  SEG_GAP_PX, segsThatFit, SIZE_BOUNDS, stmtRuns, timeScale, scaleRange, panRange, dragKind, rowsIn, timeExtent, timOfX, touchedRuns, xOfIndex, xOfTim, xTicks, yOf, yOfBlock, ySpan, yTicks, type Paint,
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

describe('the colour modes of round 2', () => {
  const rows = [
    row({ event: 1, obj: 100, blocks: 32, block: 0, stmt: 6, ela: 30, ctx: 0 }), row({ event: 1, obj: 200, blocks: 8, block: 40, stmt: 9, ela: 600, ctx: 1 }),
    row({ event: 2, obj: 100, file: 203, block: 1, stmt: 21, ela: 25000, ctx: 1 }), row({ event: 0, obj: -1, block: 60, stmt: 21, ela: 3000, ctx: 0 }),
    row({ event: 0, obj: 300, block: 70, stmt: 21, ela: 150, ctx: 0 }),
  ]
  const cx = {
    objType: (o: number) => ({ 100: 'TABLE', 200: 'INDEX' } as Record<number, string>)[o],
    objOwner: (o: number) => ({ 100: 'MTK', 200: 'MTK', 300: 'SYS' } as Record<number, string>)[o],
    tablespace: (f: number) => (f === 12 ? 'USERS' : undefined),
    session: (c: number) => ['51.14688', '52.1'][c],
  }
  it('by type and schema: names ranked by rows, temp waits their own entry, the unknown ones grey', () => {
    const t = colorRows(mapOf(rows), events, 'type', cx)
    expect(t.legend.map((l) => [l.kind, l.key, l.rows])).toEqual([['type', 'INDEX', 1], ['type', 'TABLE', 1], ['none', 'temp', 1], ['none', -1, 2]])
    expect(t.legend[3].label).toBe('unknown type')
    expect([...t.entry]).toEqual([1, 0, 2, 3, 3])
    const s = colorRows(mapOf(rows), events, 'schema', cx)
    expect(s.legend.map((l) => [l.key, l.rows])).toEqual([['MTK', 2], ['SYS', 1], ['temp', 1], [-1, 1]])
  })
  it('by tablespace, file and session', () => {
    expect(colorRows(mapOf(rows), events, 'tablespace', cx).legend.map((l) => [l.key, l.rows])).toEqual([['USERS', 4], [-1, 1]])
    const f = colorRows(mapOf(rows), events, 'file', cx)
    expect(f.legend.map((l) => [l.kind, l.key, l.rows, l.tone.token])).toEqual([['file', 12, 4, '--c-cpu'], ['file', 203, 1, '--c-network']])
    expect(colorRows(mapOf(rows), events, 'session', cx).legend.map((l) => [l.key, l.rows])).toEqual([['51.14688', 3], ['52.1', 2]])
  })
  it('by latency and read size: six buckets on a ramp, in bucket order', () => {
    const l = colorRows(mapOf(rows), events, 'latency')
    expect(l.legend.map((e) => [e.key, e.label, e.rows, e.tone.token])).toEqual([
      [0, '< 50 µs', 1, '--bm-lat-0'], [1, '50–200 µs', 1, '--bm-lat-1'], [2, '0.2–1 ms', 1, '--bm-lat-2'], [3, '1–5 ms', 1, '--bm-lat-3'], [5, '≥ 20 ms', 1, '--bm-lat-5'],
    ])
    const z = colorRows(mapOf(rows), events, 'size')
    expect(z.legend.map((e) => [e.key, e.rows])).toEqual([[0, 3], [1, 1], [3, 1]])
    expect(bucketOf(1, SIZE_BOUNDS, true)).toBe(0)
    expect(bucketOf(128, SIZE_BOUNDS, true)).toBe(5)
    expect(bucketOf(50, LATENCY_BOUNDS)).toBe(1)
  })
  it('reads a persisted mode back, an unknown one as event', () => {
    expect(colorByOf('latency')).toBe('latency')
    expect(colorByOf('bogus')).toBe('event')
  })
})

describe('the block axis: linear and packed', () => {
  it('linear is yOfBlock, and extends past its range; a range of a few blocks is widened', () => {
    const ys = linearY({ file: 12, lo: 1000, hi: 2000 }, 108)
    expect(yOf(ys, 12, 1500)).toBe(yOfBlock({ lo: 1000, hi: 2000 }, 108, 1500))
    expect(yOf(ys, 12, 3000)).toBeLessThan(0)
    expect(yOf(ys, 13, 1500)).toBeNaN()
    const one = linearY({ file: 10, lo: 80385, hi: 80386 }, 60) // one block in a 60 px panel: 18 blocks at 3 px
    expect([one.segs[0].lo, one.segs[0].hi]).toEqual([80376, 80394])
  })
  it('does not stretch a few short runs over the panel: they sit in its middle', () => {
    const ys = packedY([{ file: 10, lo: 66397, hi: 66398 }, { file: 10, lo: 70000, hi: 70001 }, { file: 10, lo: 80385, hi: 80386 }], 60)
    expect(ys.segs.map((s) => s.y1 - s.y0)).toEqual([MIN_SEG_PX, MIN_SEG_PX, MIN_SEG_PX])
    const top = ys.segs[2].y0, bottom = ys.segs[0].y1
    expect(top - PANEL_PAD).toBeCloseTo(60 - PANEL_PAD - bottom)
  })
  it('packs the touched runs: small gaps closed, short runs raised to the minimum, from the bottom up', () => {
    const rows = [row({ block: 100, blocks: 8 }), row({ block: 110, blocks: 8 }), row({ block: 50000, blocks: 1 }), row({ block: 90000, blocks: 1000 }), row({ block: 7, file: 13 })]
    const runs = touchedRuns(rows, [0, 1, 2, 3, 4])
    expect(runs).toEqual([{ file: 12, lo: 100, hi: 118 }, { file: 12, lo: 50000, hi: 50001 }, { file: 12, lo: 90000, hi: 91000 }, { file: 13, lo: 7, hi: 8 }])
    const ys = packedY(runs, 200)
    // the 1,000-block run takes what the three short ones (18, 1 and 1 block: raised to the minimum) and the gaps leave
    expect(ys.segs.map((s) => Math.round(s.y1 - s.y0))).toEqual([MIN_SEG_PX, MIN_SEG_PX, 200 - 2 * PANEL_PAD - 3 * SEG_GAP_PX - 3 * MIN_SEG_PX, MIN_SEG_PX])
    expect(ys.segs[0].y1).toBe(200 - PANEL_PAD) // the lowest run at the bottom
    expect(ys.segs[1].y1).toBeCloseTo(ys.segs[0].y0 - SEG_GAP_PX)
    expect(yOf(ys, 12, 70000)).toBeNaN() // between two runs: no y
    expect(ySpan(ys, 12, 90000, 90500)!.bottom).toBeCloseTo(ys.segs[2].y1)
    expect(ySpan(ys, 12, 60000, 60001)).toBeNull()
    expect(touchedRuns(rows, [0, 1, 2, 3], undefined, 2).length).toBeLessThanOrEqual(2) // at most 2 runs: the gap grows
    expect(touchedRuns(rows, [0, 1, 3], [{ file: 12, lo: 105, hi: 90010 }])).toEqual([{ file: 12, lo: 105, hi: 118 }, { file: 12, lo: 90000, hi: 90010 }]) // clipped to a zoom
  })
  it('turns a drag up or down into block ranges, and reads a block off a y', () => {
    const ys = packedY([{ file: 12, lo: 0, hi: 100 }, { file: 12, lo: 1000, hi: 1100 }], 2 * PANEL_PAD + SEG_GAP_PX + 200)
    const [a, b] = ys.segs
    expect(rangesAt(ys, b.y0, a.y1)).toEqual([{ file: 12, lo: 0, hi: 100 }, { file: 12, lo: 1000, hi: 1100 }])
    expect(rangesAt(ys, a.y0 + (a.y1 - a.y0) / 2, a.y1)).toEqual([{ file: 12, lo: 0, hi: 50 }])
    expect(blockAtY(ys, a.y1)).toEqual({ file: 12, block: 0 })
    expect(blockAtY(ys, a.y0 - SEG_GAP_PX / 2)).toBeNull()
    expect(yTicks(ys).map((t) => t.block)).toEqual([0, 50, 100, 1050, 1100]) // 1,000 sits 5 px over 100: left out
    expect(yTicks(ys, 0).map((t) => t.block)).toEqual([0, 50, 100, 1000, 1050, 1100])
  })
})

describe('a packed axis of many scattered runs', () => {
  it('keeps every segment inside the panel: an object panel grows for its runs, then the runs merge until they fit', () => {
    const scattered = (n: number, spread: number) => Array.from({ length: n }, (_, i) => row({ obj: 5, block: Math.round((i * spread) / n) }))
    for (const [n, spread] of [[40, 1_000_000], [15, 100_000], [200, 10_000_000]] as const) {
      const rows = scattered(n, spread)
      for (const p of [...panelsOf(mapOf(rows), events, { by: 'object' }), ...panelsOf(mapOf(rows), events, { packed: true })]) {
        expect(p.ys.segs.length).toBeLessThanOrEqual(segsThatFit(p.height))
        for (const s of p.ys.segs) { expect(s.y0).toBeGreaterThanOrEqual(0); expect(s.y1).toBeLessThanOrEqual(p.height) }
        const xs = orderScale(rows.length, 400)
        expect(p.rows.every((i) => markRect(xs, rows, i, p, p.height).h > 0)).toBe(true) // every mark is on the axis
      }
    }
  })
})

describe('panels by object and zoomed panels', () => {
  const rows = [
    row({ obj: 7, block: 100, blocks: 8 }), row({ obj: 8, block: 5000 }), row({ obj: 7, block: 108, blocks: 8 }), row({ obj: 9, block: 9000 }),
    row({ event: 2, obj: 7, file: 203, block: 1 }), row({ obj: -1, block: 40 }), row({ obj: 7, block: 116, blocks: 8 }),
  ]
  it('gives the objects with the most rows a panel each, then the temp and no-object waits per file, then the rest', () => {
    const ps = panelsOf(mapOf(rows), events, { by: 'object', maxObjects: 1 })
    expect(ps.map((p) => [p.key, p.kind, [...p.rows], p.ys.packed])).toEqual([
      ['o7', 'object', [0, 2, 6], true], ['t203', 'temp', [4], true], ['n12', 'none', [5], true], ['rest', 'rest', [1, 3], true],
    ])
    expect(ps[0].ys.segs).toHaveLength(1) // three adjacent reads: one run
    expect(ps[0].height).toBe(PANEL_MIN)
  })
  it('a file panel takes the zoom\'s block range (linear) or packs within it', () => {
    const map = mapOf(rows)
    const zoom = { f12: [{ file: 12, lo: 90, hi: 200 }] }
    const lin = panelsOf(map, events, { zoom })[0]
    expect([lin.zoomed, lin.ys.segs[0].lo, lin.ys.segs[0].hi]).toEqual([true, 90, 200])
    const m = markRect(orderScale(rows.length, 700), rows, 1, lin, lin.height) // obj 8 at block 5000: outside the zoom
    expect(m.h).toBe(0)
    const packed = panelsOf(map, events, { zoom, packed: true })[0]
    expect(packed.ys.segs.map((s) => [s.lo, s.hi])).toEqual([[100, 124]])
    expect(panelsOf(map, events, { packed: true })[0].ys.packed).toBe(true)
  })
})

describe('drawBlockMap with a highlight', () => {
  it('paints the others first and faint, then the highlighted rows', () => {
    const rows = [row({ block: 1 }), row({ block: 2, event: 0 }), row({ block: 3 })]
    const map = mapOf(rows)
    const panel = panelsOf(map, events)[0]
    const c = colorRows(map, events, 'event')
    const calls: { alpha: number; x: number }[] = []
    const ctx: Paint = { fillStyle: '', globalAlpha: 1, fillRect(x) { if (this.fillStyle !== 'grid') calls.push({ alpha: this.globalAlpha, x }) } }
    const n = drawBlockMap(ctx, panel, rows, orderScale(3, 300), c.idx, { tones: c.tones.map(() => 'mark'), grid: 'grid', bands: [] }, Uint8Array.from([0, 1, 0]))
    expect(n).toBe(3)
    expect(calls.map((k) => k.alpha)).toEqual([DIM_ALPHA, DIM_ALPHA, 1])
  })
  it('a time axis can take its domain from the zoom', () => {
    const xs = timeScale([row({ tim: 5000, ela: 10, block: 1 })], 100, { startTim: 1000, endTim: 2000 })
    expect([xs.t0, xs.t1]).toEqual([1000, 2000])
  })
})

describe('zoom ranges', () => {
  const full = { startTim: 0, endTim: 1000 }
  it('scale around a point that keeps its place, inside the whole range; out to the whole range is no zoom', () => {
    expect(scaleRange(full, 250, 0.5, full)).toEqual({ startTim: 125, endTim: 625 })
    expect(scaleRange({ startTim: 900, endTim: 1000 }, 1000, 0.5, full)).toEqual({ startTim: 950, endTim: 1000 })
    expect(scaleRange({ startTim: 0, endTim: 600 }, 300, 2, full)).toBeNull()
    expect(scaleRange({ startTim: 0, endTim: 30 }, 0, 0.1, full)).toEqual({ startTim: 0, endTim: 20 }) // the shortest range
  })
  it('pan by a share of the length, stopping at the ends', () => {
    expect(panRange({ startTim: 100, endTim: 200 }, 0.25, full)).toEqual({ startTim: 125, endTim: 225 })
    expect(panRange({ startTim: 100, endTim: 200 }, -2, full)).toEqual({ startTim: 0, endTim: 100 })
  })
  it('tell a drag by its shape; a little jitter is a click', () => {
    expect(dragKind(2, 1)).toBeNull()
    expect(dragKind(1, 6)).toBeNull()
    expect(dragKind(0, 9)).toBeNull()
    expect(dragKind(80, 6)).toBe('x')
    expect(dragKind(3, 40)).toBe('y')
    expect(dragKind(60, 40)).toBe('xy')
  })
  it('keep the rows that overlap a range, with their files', () => {
    const rows = [row({ tim: 100, ela: 10, block: 5 }), row({ tim: 200, ela: 150, block: 9, file: 13 }), row({ tim: 300, ela: 5, block: 1 })]
    const map = mapOf(rows)
    expect(rowsIn(map, null)).toBe(map)
    expect(rowsIn(map, { startTim: 0, endTim: 400 })).toBe(map)
    const m = rowsIn(map, { startTim: 60, endTim: 120 }) // the first, and the second that started at 50
    expect(m.rows).toHaveLength(2)
    expect(m.files.map((f) => [f.file, f.n])).toEqual([[12, 1], [13, 1]])
    expect(timeExtent(rows)).toEqual({ startTim: 50, endTim: 300 })
  })
})
