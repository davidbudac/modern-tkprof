// The I/O map's density layer: every block I/O wait in scope (not a sample) counted into the cells of the map's panels. The answer of
// /api/io/density and its twin over the document's fact columns: ioDensityOf is the twin of analyze.IODensityOn
// (internal/analyze/iodensity.go), kept equal by the shared case web/src/lib/data/testdata/ioblocks-case.json. x is the I/O order
// (the wait's index among the matches, in trace order) or the time (the wait's midpoint, clamped into the domain); y is the block, per
// panel over its segments; a wait counts in every y cell its blocks touch (waits + 1, its blocks in the cell, ela × that share).
import type { TraceDoc } from './doc'
import type { ID } from './types'
import type { Scope } from '../state/store'
import { ioScan } from './iomap'

/** The columns of `IODensity.cells` (`analyze.IODensityCols`). */
export const DENSITY_COLS = ['panel', 'x', 'y', 'waits', 'blocks', 'us', 'event', 'eventWaits'] as const
/** Index of each column in a cell. */
export const DC = { panel: 0, x: 1, y: 2, waits: 3, blocks: 4, us: 5, event: 6, eventWaits: 7 } as const

/** One panel of a request: its key (`f12`, `o108609`, `t203`, `n12`, `rest`, as the I/O map's panels) and y segments `[file, lo, hi, bins]`. */
export interface DensityPanelReq { key: string; segs: [number, number, number, number][] }

/** The question (`analyze.IODensityReq`): the axis, its x segments `[a, b, bins]` (order: match indices; time: tim µs), the panels. */
export interface DensityReq {
  x?: 'order' | 'time'
  xsegs?: [number, number, number][]
  xbins?: number
  panels?: DensityPanelReq[]
  ybins?: number
}

export interface DensityPanel { key: string; segs: [number, number, number, number][]; waits: number; out: number }

export interface IODensity {
  total: number
  x: 'order' | 'time'
  /** the x bins as binned, numbered across the segments in order */
  xsegs: [number, number, number][]
  panels: DensityPanel[]
  cols: string[]
  /** `[panel, x, y, waits, blocks, us, event, eventWaits]`, the cells with waits, by panel, x, y */
  cells: number[][]
  events: ID[]
}

export const DEFAULT_DENSITY_XBINS = 200
export const DEFAULT_DENSITY_YBINS = 64
export const MAX_DENSITY_XBINS = 4000
export const MAX_DENSITY_YBINS = 2000
export const MAX_DENSITY_SEGS = 64
export const MAX_DENSITY_PANELS = 64
export const MAX_DENSITY_CELLS = 2 ** 20

/** The query parameters of a request (`x`, `xs`, `xbins`, `p` repeated, `ybins`) as /api/io/density reads them. */
export function densityParams(q: DensityReq): [string, string][] {
  const p: [string, string][] = []
  if (q.x) p.push(['x', q.x])
  if (q.xsegs?.length) p.push(['xs', q.xsegs.map((s) => s.join('.')).join(',')])
  if (q.xbins) p.push(['xbins', String(q.xbins)])
  for (const pn of q.panels ?? []) p.push(['p', `${pn.key}:${pn.segs.map((s) => s.join('.')).join(',')}`])
  if (q.ybins) p.push(['ybins', String(q.ybins)])
  return p
}

interface Cell { waits: number; blocks: number; us: number; ev: number[] }

/** The cells of the block I/O waits in scope (the twin of `analyze.IODensityOn`; the request is the view's, not checked here beyond its shape). */
export function ioDensityOf(doc: TraceDoc, scope: Pick<Scope, 'window' | 'contexts'>, q: DensityReq, stmt?: ID, event?: ID): IODensity {
  const w = doc.waits
  const sc = ioScan(doc, scope, stmt, event)
  const mode = q.x ?? 'order'
  const out: IODensity = { total: 0, x: mode, xsegs: [], panels: [], cols: [...DENSITY_COLS], cells: [], events: [] }
  let xsegs = q.xsegs?.length ? q.xsegs.map((s) => [...s] as [number, number, number]) : null
  let preqs = q.panels?.length ? q.panels : null
  if (!xsegs || !preqs) {
    let total = 0, t0 = Infinity, t1 = -Infinity
    const files = new Map<number, [number, number]>()
    for (let i = 0; i < w.n; i++) {
      if (!sc.match(i)) continue
      total++
      t0 = Math.min(t0, w.tim[i] - w.ela[i]); t1 = Math.max(t1, w.tim[i])
      const lo = w.p2[i], hi = lo + sc.blocks(i)
      const r = files.get(w.p1[i])
      files.set(w.p1[i], r ? [Math.min(r[0], lo), Math.max(r[1], hi)] : [lo, hi])
    }
    if (!xsegs) {
      const bins = q.xbins && q.xbins >= 1 ? q.xbins : DEFAULT_DENSITY_XBINS
      xsegs = mode === 'order' ? [[0, Math.max(total, 1), bins]] : total > 0 ? [[t0, Math.max(t1, t0 + 1), bins]] : [[0, 1, bins]]
    }
    if (!preqs) {
      // one panel per file (the first 64 by number), with fewer y bins when the grid would pass the cells limit
      const keys = [...files.keys()].sort((a, b) => a - b).slice(0, MAX_DENSITY_PANELS)
      const xb = xsegs.reduce((a, s) => a + s[2], 0)
      let bins = q.ybins && q.ybins >= 1 ? q.ybins : DEFAULT_DENSITY_YBINS
      if (keys.length * xb > 0) bins = Math.max(1, Math.min(bins, Math.floor(MAX_DENSITY_CELLS / (keys.length * xb))))
      preqs = keys.map((f) => {
        const [lo, hi] = files.get(f)!
        const l = Math.max(lo, 0)
        return { key: `f${f}`, segs: [[f, l, Math.max(hi, l + 1), bins]] }
      })
    }
  }
  if (mode === 'order') for (const s of xsegs) s[2] = Math.min(s[2], s[1] - s[0])
  const xoff = [0]
  for (const s of xsegs) xoff.push(xoff[xoff.length - 1] + s[2])
  const xtot = xoff[xsegs.length]
  interface P { key: string; segs: [number, number, number, number][]; off: number[]; order: number[]; waits: number; out: number }
  const panels: P[] = []
  const objPanel = new Set<number>()
  const byKind = new Map<string, number[]>()
  let ymax = 1
  preqs.forEach((p, pi) => {
    const segs = p.segs.map((s) => [s[0], s[1], s[2], Math.min(s[3], s[2] - s[1])] as [number, number, number, number])
    const off = [0]
    for (const s of segs) off.push(off[off.length - 1] + s[3])
    const order = segs.map((_, j) => j).sort((a, b) => segs[a][0] - segs[b][0] || segs[a][1] - segs[b][1] || a - b)
    ymax = Math.max(ymax, off[segs.length])
    panels.push({ key: p.key, segs, off, order, waits: 0, out: 0 })
    const sel = p.key === 'rest' ? 'r' : p.key[0] + String(Number(p.key.slice(1))) // f012 is file 12, as the engine parses it
    if (sel[0] === 'o') objPanel.add(Number(sel.slice(1)))
    const l = byKind.get(sel)
    if (l) l.push(pi); else byKind.set(sel, [pi])
  })
  const cells = new Map<number, Cell>()
  const seen = new Uint8Array(doc.events.length)
  let idx = -1
  for (let i = 0; i < w.n; i++) {
    if (!sc.match(i)) continue
    idx++
    out.total++
    seen[w.event[i]] = 1
    const file = w.p1[i], obj = w.obj[i]
    const hits = [...(byKind.get(`f${file}`) ?? [])]
    if (sc.temp(i)) hits.push(...(byKind.get(`t${file}`) ?? []))
    else if (obj >= 0) { hits.push(...(byKind.get(`o${obj}`) ?? [])); if (!objPanel.has(obj)) hits.push(...(byKind.get('r') ?? [])) }
    else hits.push(...(byKind.get(`n${file}`) ?? []))
    if (hits.length === 0) continue
    const pos = mode === 'order' ? idx : w.tim[i] - w.ela[i] / 2
    const xb = xBin(xsegs, xoff, mode === 'time', pos)
    const n = sc.blocks(i), lo = w.p2[i], hi = lo + n, ela = w.ela[i]
    for (const pi of hits) {
      const dp = panels[pi]
      if (xb < 0) { dp.out++; continue }
      let binned = false
      for (const j of dp.order) {
        const s = dp.segs[j]
        if (s[0] !== file || s[2] <= lo || s[1] >= hi) continue
        binned = true
        const span = s[2] - s[1], bins = s[3]
        const a = Math.max(lo, s[1]), b = Math.min(hi, s[2])
        for (let y = Math.floor((a - s[1]) * bins / span); y < bins; y++) {
          const ylo = s[1] + Math.floor((y * span + bins - 1) / bins), yhi = s[1] + Math.floor(((y + 1) * span + bins - 1) / bins)
          if (ylo >= b) break
          const ov = Math.min(b, yhi) - Math.max(a, ylo)
          if (ov <= 0) continue
          const key = (pi * xtot + xb) * ymax + dp.off[j] + y
          let c = cells.get(key)
          if (!c) cells.set(key, (c = { waits: 0, blocks: 0, us: 0, ev: [] }))
          c.waits++
          c.blocks += ov
          c.us += ela * ov / n
          const e = w.event[i]
          let k = 0
          while (k < c.ev.length && c.ev[k] !== e) k += 2
          if (k < c.ev.length) c.ev[k + 1]++; else c.ev.push(e, 1)
        }
      }
      if (binned) dp.waits++; else dp.out++
    }
  }
  for (let e = 0; e < seen.length; e++) if (seen[e]) out.events.push(e)
  out.xsegs = xsegs
  out.panels = panels.map((p) => ({ key: p.key, segs: p.segs, waits: p.waits, out: p.out }))
  const per = xtot * ymax
  for (const k of [...cells.keys()].sort((a, b) => a - b)) {
    const c = cells.get(k)!
    let be = -1, bn = 0
    for (let j = 0; j < c.ev.length; j += 2) if (c.ev[j + 1] > bn || (c.ev[j + 1] === bn && c.ev[j] < be)) { be = c.ev[j]; bn = c.ev[j + 1] }
    const pi = Math.floor(k / per), rest = k - pi * per
    out.cells.push([pi, Math.floor(rest / ymax), rest % ymax, c.waits, c.blocks, Math.round(c.us), be, bn])
  }
  return out
}

/** The x bin of a position (twin of `xBin`): the bin of the segment holding it; outside, -1 (order) or the nearest bin after it, the last past the end (time). */
export function xBin(segs: readonly (readonly [number, number, number])[], off: readonly number[], clamp: boolean, pos: number): number {
  let i = 0, j = segs.length
  while (i < j) { const m = (i + j) >> 1; if (segs[m][1] > pos) j = m; else i = m + 1 }
  if (i === segs.length) return !clamp || segs.length === 0 ? -1 : off[segs.length] - 1
  const s = segs[i]
  if (pos < s[0]) return clamp ? off[i] : -1
  const b = Math.floor((pos - s[0]) * s[2] / (s[1] - s[0]))
  return off[i] + Math.min(Math.max(b, 0), s[2] - 1)
}
