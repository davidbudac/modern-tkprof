import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from './doc'
import type { RawDocument } from './types'
import { IO, ioMapOf, sampleStep } from './iomap'
import { ioDensityOf, MAX_DENSITY_CELLS, MAX_DENSITY_PANELS, DC } from './iodensity'
import { bracketsOf, colorRows, drawBlockMap, markRect, orderScale, panelsOf, rowsIn, timeScale, xOfIndex, xOfTim, type Paint } from './blocklayout'
import { cellAt, CELL_PX, densityF, densityLayer, densityRequest, xRangeOf, yRangeOf } from './densitylayout'

// The density layer on the real document of testdata/traces/19c/io_waits.trc (findings-io_waits.json.gz).
describe('the density layer on io_waits.trc', async () => {
  const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
  const d = await TraceDoc.fromRaw((JSON.parse(gunzipSync(readFileSync(dir + 'findings-io_waits.json.gz')).toString('utf8')) as { doc: RawDocument }).doc)
  const all = { window: null, contexts: null }

  for (const [axis, limit, by] of [['order', 20000, 'file'], ['order', 500, 'file'], ['time', 500, 'file'], ['order', 500, 'object']] as const) {
    it(`places every wait's mark on a cell that counts it (${axis}, limit ${limit}, panels per ${by})`, () => {
      const map = ioMapOf(d, all, limit)
      const k = sampleStep(map)
      const panels = panelsOf(map, d.events, { by, packed: by === 'object' })
      const xs = axis === 'order' ? orderScale(map.rows.length, 900, bracketsOf(map.rows, () => '').runs) : timeScale(map.rows, 900)
      const req = densityRequest(panels, xs, k, map.total)
      expect(req.panels!.map((p) => p.key)).toEqual(panels.map((p) => p.key))
      for (const [i, p] of req.panels!.entries()) expect(p.segs.map((s) => [s[0], s[1], s[2]])).toEqual(panels[i].ys.segs.map((s) => [s.file, s.lo, Math.max(s.hi, s.lo + 1)]))
      const dens = ioDensityOf(d, all, req)
      expect(dens.total).toBe(map.total)
      // every wait is counted: in a file panel each wait once per y cell it touches
      if (by === 'file') {
        for (const [pi, p] of dens.panels.entries()) expect(p.waits + p.out).toBe(map.files.find((f) => `f${f.file}` === p.key)!.n * 1 + 0 * pi)
      }
      const layer = densityLayer(dens, panels, xs, k, 'waits', 'sqrt')
      expect(layer.max).toBe(Math.max(...dens.cells.map((c) => c[DC.waits])))
      // the marks drawn sit on cells: the mark of row i stands for matches [i·k, (i+1)·k) and is centred in their slot; the first of them,
      // the one it shows, is at the slot's start (order) or its wait's midpoint (time)
      let checked = 0
      panels.forEach((p, pi) => {
        for (const i of p.rows) {
          const m = markRect(xs, map.rows, i, p, p.height)
          if (!(m.h > 0)) continue
          const r = map.rows[i]
          const cx = xs.mode === 'order' ? xOfIndex(xs, i) + 0.5 : xOfTim(xs, r[IO.tim] - r[IO.ela] / 2), cy = m.y + m.h / 2
          const near = layer.byPanel[pi].some((r) => cx >= r.x - 1.5 && cx <= r.x + r.w + 1.5 && cy >= r.y - 1.5 && cy <= r.y + r.h + 1.5)
          expect(near, `row ${i} of panel ${p.key} at ${cx},${cy}`).toBe(true)
          checked++
        }
      })
      expect(checked).toBeGreaterThan(Math.min(400, map.rows.length / 2))
      for (const l of layer.byPanel) for (const r of l) { expect(r.f).toBeGreaterThan(0); expect(r.f).toBeLessThanOrEqual(1) }
    })
  }

  it('a sampled map: the density holds the waits the sample leaves out', () => {
    const map = ioMapOf(d, all, 300)
    const panels = panelsOf(map, d.events)
    const xs = orderScale(map.rows.length, 900)
    const dens = ioDensityOf(d, all, densityRequest(panels, xs, sampleStep(map), map.total))
    const counted = dens.cells.reduce((a, c) => a + c[DC.waits], 0)
    expect(map.rows.length).toBeLessThan(400)
    expect(counted).toBeGreaterThanOrEqual(map.total) // a wait over two y cells counts in both
  })

  it('keeps within the engine\'s limits however wide and tall', () => {
    const map = ioMapOf(d, all, 20000)
    const panels = panelsOf(map, d.events)
    const many = Array.from({ length: 80 }, (_, i) => ({ ...panels[i % panels.length], key: `f${i}` }))
    const req = densityRequest(many, orderScale(map.rows.length, 20000), 1, map.total)
    const xb = req.xsegs!.reduce((a, s) => a + s[2], 0), yb = req.panels!.reduce((a, p) => a + p.segs.reduce((b, s) => b + s[3], 0), 0)
    expect(req.panels!.length).toBe(MAX_DENSITY_PANELS)
    expect(xb * yb).toBeLessThanOrEqual(MAX_DENSITY_CELLS)
    expect(xb).toBeLessThanOrEqual(4000)
  })

  it('stays inside the cells limit when rounding each packed segment up would pass it (the review\'s 64 × 17 runs)', () => {
    const map = ioMapOf(d, all, 20000)
    const p0 = panelsOf(map, d.events, { packed: true })[1]
    const runs = Array.from({ length: 17 }, (_, j) => ({ file: 12, lo: 1000 * j, hi: 1000 * j + 10, y0: 4 + 14 * j, y1: 4 + 14 * j + 9 }))
    const many = Array.from({ length: 64 }, (_, i) => ({ ...p0, key: `f${i}`, height: 240, ys: { packed: true, segs: runs } }))
    for (const w of [2600, 1970]) {
      const req = densityRequest(many, orderScale(map.rows.length, w), 1, map.total)
      const xb = req.xsegs!.reduce((a, s) => a + s[2], 0), yb = req.panels!.reduce((a, p) => a + p.segs.reduce((b, s) => b + s[3], 0), 0)
      expect(xb * yb).toBeLessThanOrEqual(MAX_DENSITY_CELLS)
    }
  })

  it('an unzoomed time axis asks for bins only: the engine bins over the matches\' own extent', () => {
    const map = ioMapOf(d, all, 500)
    const panels = panelsOf(map, d.events)
    const xs = timeScale(map.rows, 900)
    const req = densityRequest(panels, xs, sampleStep(map), map.total, undefined, true)
    expect(req.xsegs).toBeUndefined()
    expect(req.xbins).toBe(225)
    const dens = ioDensityOf(d, all, req)
    expect(dens.xsegs[0][0]).toBeLessThanOrEqual(xs.t0)
    expect(dens.cells.reduce((a, c) => a + c[DC.waits], 0)).toBeGreaterThanOrEqual(map.total)
  })

  it('draws under the marks, and without them', () => {
    const map = ioMapOf(d, all, 2000)
    const panels = panelsOf(map, d.events)
    const xs = orderScale(map.rows.length, 600)
    const layer = densityLayer(ioDensityOf(d, all, densityRequest(panels, xs, sampleStep(map), map.total)), panels, xs, sampleStep(map), 'blocks', 'log')
    const coloring = colorRows(map, d.events, 'event')
    const calls: string[] = []
    const ctx: Paint = { fillStyle: '', globalAlpha: 1, fillRect() { calls.push(`${this.fillStyle}`) } }
    const p = panels.findIndex((x) => x.rows.length > 0)
    const n = drawBlockMap(ctx, panels[p], map.rows, xs, coloring.idx, { tones: coloring.tones.map(() => 'mark'), grid: 'grid', bands: [] }, null, { density: { rects: layer.byPanel[p], color: 'dens' } })
    const firstMark = calls.indexOf('mark'), lastDens = calls.lastIndexOf('dens')
    expect(lastDens).toBeGreaterThan(-1)
    expect(lastDens).toBeLessThan(firstMark)
    expect(n).toBeGreaterThan(0)
    calls.length = 0
    expect(drawBlockMap(ctx, panels[p], map.rows, xs, coloring.idx, { tones: coloring.tones.map(() => 'mark'), grid: 'grid', bands: [] }, null, { density: { rects: layer.byPanel[p], color: 'dens' }, marks: false })).toBe(0)
    expect(calls.includes('mark')).toBe(false)
  })
})

describe('review fixes', async () => {
  const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
  const d = await TraceDoc.fromRaw((JSON.parse(gunzipSync(readFileSync(dir + 'findings-io_waits.json.gz')).toString('utf8')) as { doc: RawDocument }).doc)
  const map = ioMapOf(d, { window: null, contexts: null }, 20000)
  it('an object panel zoomed where the sample has no row shows the zoom\'s blocks, not the whole object', () => {
    const p = panelsOf(map, d.events, { by: 'object' }).find((x) => x.kind === 'object')!
    const zoom = { [p.key]: [{ file: p.file, lo: p.hi + 1000, hi: p.hi + 1100 }] }
    const z = panelsOf(map, d.events, { by: 'object', zoom }).find((x) => x.key === p.key)!
    expect(z.zoomed).toBe(true)
    expect(z.ys.segs[0].lo).toBe(p.hi + 1000)
    expect(z.ys.segs[0].hi).toBe(p.hi + 1100)
  })
  it('re-reads: a row whose blocks no read touched is "not read in scope", not "read once"', () => {
    const rows = map.rows.slice(0, 3)
    const c = colorRows({ rows, events: map.events, reads: [0, 1, 5] }, d.events, 'reread')
    expect(c.legend.map((l) => l.label)).toEqual(['read once', '5–8', 'not read in scope'])
  })
})

describe('density helpers', () => {
  it('bin ranges, the intensity, the cell under a point', () => {
    expect(xRangeOf({ xsegs: [[0, 10, 5], [10, 40, 3]] }, 6)).toEqual([20, 30])
    expect(xRangeOf({ xsegs: [[0, 10, 5]] }, 5)).toBeNull()
    expect(yRangeOf([[12, 100, 110, 3], [12, 200, 210, 2]], 0)).toEqual({ file: 12, lo: 100, hi: 104 })
    expect(yRangeOf([[12, 100, 110, 3], [12, 200, 210, 2]], 2)).toEqual({ file: 12, lo: 107, hi: 110 })
    expect(yRangeOf([[12, 100, 110, 3], [12, 200, 210, 2]], 4)).toEqual({ file: 12, lo: 205, hi: 210 })
    expect(densityF(25, 100, 'sqrt')).toBeCloseTo(0.5)
    expect(densityF(0, 100, 'sqrt')).toBe(0)
    expect(densityF(100, 100, 'log')).toBe(1)
    const rects = [{ x: 0, y: 0, w: 4, h: 4, v: 1, f: 1, cell: 0 }, { x: 4, y: 0, w: 4, h: 4, v: 2, f: 1, cell: 1 }]
    expect(cellAt(rects, 5, 2)?.cell).toBe(1)
    expect(cellAt(rects, 9, 2)).toBeNull()
    expect(CELL_PX).toBe(4)
  })
  it('rowsIn keeps the reads with their rows', () => {
    const map = { total: 3, sampled: false, cols: [], files: [], events: [0], rows: [[10, 1, 0, 1, 5, 1, -1, 0, 0, 1, 0, 0], [20, 1, 0, 1, 6, 1, -1, 0, 0, 2, 0, 0], [30, 1, 0, 1, 7, 1, -1, 0, 0, 3, 0, 0]], reads: [1, 2, 3] }
    const r = rowsIn(map, { startTim: 15, endTim: 25 })
    expect(r.rows.map((x) => x[IO.block])).toEqual([6])
    expect(r.reads).toEqual([2])
  })
})
