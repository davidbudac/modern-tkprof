// The I/O map's density layer, laid out (views/BlockMap.tsx; the engine's /api/io/density or its twin ioDensityOf bins the waits): the
// request built from the map's panels and x axis, so that a cell is about `cell` px square, and the answer's cells mapped back onto
// the panels as rectangles with an intensity. A cell is placed by the block and order (or time) ranges the answer says it covers, not
// by px, so an answer stays right while the layout changes under it (a resize, or a time zoom on the time axis).
import { DC, MAX_DENSITY_CELLS, MAX_DENSITY_PANELS, MAX_DENSITY_SEGS, MAX_DENSITY_XBINS, MAX_DENSITY_YBINS, type DensityReq, type IODensity } from './iodensity'
import { xOfIndex, xOfTim, ySpan, type Panel, type XScale } from './blocklayout'

/** The px a density cell is wide and tall, at least. */
export const CELL_PX = 4

/** What a cell's intensity counts: the waits that touched it, the blocks they moved in it, or their time. */
export type DensityMeasure = 'waits' | 'blocks' | 'us'
export const DENSITY_MEASURES: readonly DensityMeasure[] = ['waits', 'blocks', 'us']
/** How a count maps to an intensity: square root or logarithm of its share of the largest cell. */
export type DensityScale = 'sqrt' | 'log'
/** When the layer is drawn: while the marks are a sample (auto), always, or never. */
export type DensityMode = 'auto' | 'always' | 'off'

/**
 * The request for the map's layout: the x axis' segments (order: the rows' slots as match indices, × the sampling step `k`, cut at
 * `total`; time: the axis' domain, or with `extent` only a bin count, so the engine bins over the matches' own time extent) and each
 * panel's y segments, each with one bin per `cell` px. The cell grows until the grid is inside the engine's limits (cells, bins:
 * rounding each segment up to a bin can pass them); panels past the 64th get no density.
 */
export function densityRequest(panels: readonly Panel[], xs: XScale, k: number, total: number, cell = CELL_PX, extent = false): DensityReq {
  const ps = panels.slice(0, MAX_DENSITY_PANELS)
  const heights = ps.reduce((a, p) => a + p.ys.segs.reduce((b, s) => b + Math.max(1, s.y1 - s.y0), 0), 0)
  let c = Math.max(cell, Math.ceil(Math.sqrt((xs.width * heights) / MAX_DENSITY_CELLS)), Math.ceil(xs.width / MAX_DENSITY_XBINS))
  for (;;) {
    const req = build(ps, xs, k, total, c, extent)
    const xb = req.xsegs ? req.xsegs.reduce((a, s) => a + s[2], 0) : req.xbins ?? 0
    const yb = req.panels!.reduce((a, p) => a + p.segs.reduce((b, s) => b + s[3], 0), 0)
    if (xb * yb <= MAX_DENSITY_CELLS || c > 1e6) return req
    c = Math.ceil(c * 1.25)
  }
}

function build(ps: readonly Panel[], xs: XScale, k: number, total: number, c: number, extent: boolean): DensityReq {
  const bins = (px: number, max: number) => Math.max(1, Math.min(max, Math.round(px / c)))
  const panels = ps.filter((p) => p.ys.segs.length > 0).map((p) => {
    const segs = p.ys.segs.slice(0, MAX_DENSITY_SEGS)
    const per = Math.max(1, Math.floor(MAX_DENSITY_YBINS / segs.length))
    return { key: p.key, segs: segs.map((s) => [s.file, s.lo, Math.max(s.hi, s.lo + 1), bins(s.y1 - s.y0, per)] as [number, number, number, number]) }
  })
  if (xs.mode === 'time' && extent) return { x: 'time', xbins: bins(xs.width, MAX_DENSITY_XBINS), panels }
  let xsegs: [number, number, number][]
  if (xs.mode === 'order') {
    xsegs = []
    for (const s of xs.segs.slice(0, MAX_DENSITY_SEGS)) {
      const a = s.i0 * k, b = Math.min(s.i1 * k, total)
      if (b > a) xsegs.push([a, b, bins(s.x1 - s.x0, MAX_DENSITY_XBINS)])
    }
  } else {
    const a = Math.floor(xs.t0)
    xsegs = [[a, Math.max(a + 1, Math.ceil(xs.t1)), bins(xs.width, MAX_DENSITY_XBINS)]]
  }
  return { x: xs.mode, xsegs, panels }
}

/** One cell on a panel: its rectangle (px, panel coordinates), its count in the measure, its intensity (0..1) and its index in `cells`. */
export interface DensityRect { x: number; y: number; w: number; h: number; v: number; f: number; cell: number }

export interface DensityLayer {
  /** per panel of the map (same order), its cells */
  byPanel: DensityRect[][]
  /** the largest count of a cell (all panels share the scale) */
  max: number
}

/** A count's intensity: its share of the largest, as a square root or a logarithm. */
export const densityF = (v: number, max: number, scale: DensityScale): number =>
  max <= 0 || v <= 0 ? 0 : scale === 'log' ? Math.log1p(v) / Math.log1p(max) : Math.sqrt(v / max)

/** The x range of bin `b` of the answer's x axis in its units (order: match indices; time: tim). */
export function xRangeOf(d: Pick<IODensity, 'xsegs'>, b: number): [number, number] | null {
  let off = 0
  for (const [a, e, n] of d.xsegs) {
    if (b < off + n) { const j = b - off; return [a + (j * (e - a)) / n, a + ((j + 1) * (e - a)) / n] }
    off += n
  }
  return null
}

/** The block range `[lo, hi)` of bin `b` of a panel's y axis, and its file. */
export function yRangeOf(segs: readonly (readonly [number, number, number, number])[], b: number): { file: number; lo: number; hi: number } | null {
  let off = 0
  for (const [file, lo, hi, n] of segs) {
    if (b < off + n) {
      const j = b - off, span = hi - lo
      return { file, lo: lo + Math.ceil((j * span) / n), hi: lo + Math.ceil(((j + 1) * span) / n) }
    }
    off += n
  }
  return null
}

/**
 * The answer's cells on the map's panels (matched by key): each cell's x from its order or time range on `xs` (order positions are
 * match indices / `k`), its y from its block range on the panel's axis (cut to the segment that holds it; a cell off the axis is left
 * out), and its intensity in `measure` on `scale`, against the largest cell of every panel.
 */
export function densityLayer(d: IODensity, panels: readonly Panel[], xs: XScale, k: number, measure: DensityMeasure, scale: DensityScale): DensityLayer {
  const byPanel: DensityRect[][] = panels.map(() => [])
  const at = new Map(panels.map((p, i) => [p.key, i]))
  const col = measure === 'waits' ? DC.waits : measure === 'blocks' ? DC.blocks : DC.us
  if (d.x !== xs.mode) return { byPanel, max: 0 }
  // the left and right px of every x bin, once
  const px = (u: number) => (xs.mode === 'order' ? xOfIndex(xs, u / k) : xOfTim(xs, u))
  const left: number[] = [], right: number[] = []
  for (const [a, e, n] of d.xsegs) {
    for (let j = 0; j < n; j++) { left.push(px(a + (j * (e - a)) / n)); right.push(px(a + ((j + 1) * (e - a)) / n)) }
  }
  let max = 0
  d.cells.forEach((c, i) => {
    const pi = at.get(d.panels[c[DC.panel]]?.key)
    if (pi === undefined) return
    const yr = yRangeOf(d.panels[c[DC.panel]].segs, c[DC.y])
    if (!yr) return
    const sp = ySpan(panels[pi].ys, yr.file, yr.lo, yr.hi)
    if (!sp) return
    const x0 = Math.floor(left[c[DC.x]]), x1 = Math.floor(right[c[DC.x]])
    if (x1 < 0 || x0 > xs.width) return
    const y0 = Math.floor(sp.top), y1 = Math.ceil(sp.bottom)
    const v = c[col]
    max = Math.max(max, v)
    byPanel[pi].push({ x: Math.max(0, x0), y: y0, w: Math.max(1, Math.min(xs.width, x1) - Math.max(0, x0)), h: Math.max(1, y1 - y0), v, f: 0, cell: i })
  })
  for (const l of byPanel) for (const r of l) r.f = densityF(r.v, max, scale)
  return { byPanel, max }
}

/** The cell under (x, y) of a panel's layer: the last drawn that holds the point, or null. */
export function cellAt(rects: readonly DensityRect[], x: number, y: number): DensityRect | null {
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i]
    if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) return r
  }
  return null
}
