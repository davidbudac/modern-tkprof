// The Cut view's geometry: the source files as columns of lines, the new file as a column of its pieces, the labels
// beside it. Pure functions over the engine's plan (`GET api/cut`), so the drawing in CutView stays thin.
import type { components } from '../../../engine/api'

export type CutPlan = components['schemas']['CutPlan']
export type CutPiece = components['schemas']['CutPiece']
export type CutRun = components['schemas']['CutRun']
export type CutCheck = components['schemas']['CutCheck']

/** A label of the source map: K kept, E kept to finish a call, H header, B borrowed before the cut, A after, C caller left out, . left out. */
export type Label = 'K' | 'E' | 'H' | 'B' | 'A' | 'C' | '.'

/** Piece kinds by the label their lines carry in the source. */
export const pieceLabel = (p: CutPiece): Label | 'G' =>
  p.kind === 'kept' ? 'K' : p.kind === 'header' ? 'H' : p.kind === 'before' ? 'B' : p.kind === 'after' ? 'A' : 'G'

/** A source file's column: lines 1..lines from y0 down, piecewise linear (breakpoints `[line, y]`). */
export interface SourceColumn {
  file: number
  lines: number
  y0: number
  h: number
  bp: [number, number][]
  /** the stretched ranges (small borrowed pieces), in line order */
  focus: [number, number][]
}

/** Minimum height of a borrowed source range on the map: big enough to see and hover where it lives. */
export const FOCUS_PX = 9
/** Minimum height of a block of the new file that is not kept lines: room for a hover target. */
export const MIN_PIECE_PX = 15

/**
 * Lays the source files out top to bottom in `height` px (a `gap` between files). Ranges of borrowed lines too small
 * to see at the common scale get FOCUS_PX each, in place; the other lines share the rest evenly.
 */
export function layoutSources(plan: Pick<CutPlan, 'files' | 'pieces'>, top: number, height: number, gap = 34): { cols: SourceColumn[]; k: number } {
  const files = plan.files
  const total = files.reduce((a, f) => a + Math.max(1, f.lines), 0)
  const avail = height - gap * Math.max(0, files.length - 1)
  const k = avail / total
  const raw: [number, number][][] = files.map(() => [])
  for (const p of plan.pieces) {
    if (!p.from || p.kind === 'kept' || p.kind === 'generated') continue
    const f = files.findIndex((x) => x.idx === p.file)
    if (f < 0) continue
    if (p.lines?.length) for (const l of p.lines) raw[f].push([l, l])
    else raw[f].push([p.from, p.to ?? p.from])
  }
  const focus = raw.map((rs) => {
    rs.sort((a, b) => a[0] - b[0])
    const m: [number, number][] = []
    for (const [a, b] of rs) {
      const l = m[m.length - 1]
      if (l && a <= l[1] + 3) l[1] = Math.max(l[1], b)
      else m.push([a, b])
    }
    return m.filter(([a, b]) => (b - a + 1) * k < FOCUS_PX)
  })
  const nFoc = focus.reduce((a, f) => a + f.length, 0)
  const focLines = focus.reduce((a, f) => a + f.reduce((x, [p, q]) => x + q - p + 1, 0), 0)
  const kr = Math.max(0, avail - nFoc * FOCUS_PX) / Math.max(1, total - focLines)
  let y = top
  const cols = files.map((f, i) => {
    const bp: [number, number][] = [[1, 0]]
    let yy = 0
    let at = 1
    for (const [a, b] of focus[i]) {
      yy += (a - at) * kr
      bp.push([a, yy])
      yy += FOCUS_PX
      bp.push([b + 1, yy])
      at = b + 1
    }
    yy += (Math.max(1, f.lines) + 1 - at) * kr
    bp.push([Math.max(1, f.lines) + 1, yy])
    const c: SourceColumn = { file: f.idx, lines: f.lines, y0: y, h: yy, bp, focus: focus[i] }
    y += yy + gap
    return c
  })
  return { cols, k: kr }
}

/** The y of the top of `line` in a source column. */
export function lineY(c: SourceColumn, line: number): number {
  const bp = c.bp
  let lo = 0
  let hi = bp.length - 1
  if (line >= bp[hi][0]) return c.y0 + bp[hi][1]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (bp[mid][0] <= line) lo = mid
    else hi = mid
  }
  const [l0, y0] = bp[lo]
  const [l1, y1] = bp[hi]
  return c.y0 + y0 + ((line - l0) / (l1 - l0)) * (y1 - y0)
}

/** The output column: a [y0, y1] per piece (kept lines at the source's scale, other blocks at least MIN_PIECE_PX). */
export function layoutOutput(pieces: readonly CutPiece[], k: number, top: number, height: number): { y: [number, number][]; h: number; k: number } {
  let fixed = 0
  let scal = 0
  for (const p of pieces) {
    if (p.kind === 'kept' || p.n * k >= MIN_PIECE_PX) scal += p.n
    else fixed += MIN_PIECE_PX
  }
  const kk = Math.min(k, Math.max(0, height - fixed) / Math.max(1, scal))
  let y = top
  const out: [number, number][] = pieces.map((p) => {
    const h = p.kind === 'kept' || p.n * kk >= MIN_PIECE_PX ? Math.max(p.n * kk, 2) : MIN_PIECE_PX
    const r: [number, number] = [y, y + h]
    y += h
    return r
  })
  return { y: out, h: y - top, k: kk }
}

/** Label positions: as close to `want` as possible, at least `gap` apart, kept within [lo, hi] when there is room. */
export function placeLabels(want: readonly number[], gap: number, lo: number, hi: number): number[] {
  const out = want.map((w) => Math.max(w, lo))
  for (let i = 1; i < out.length; i++) out[i] = Math.max(out[i], out[i - 1] + gap)
  if (out.length && out[out.length - 1] > hi) {
    let lim = hi
    for (let i = out.length - 1; i >= 0; i--) {
      out[i] = Math.min(out[i], lim)
      lim = out[i] - gap
    }
  }
  return out
}

/**
 * The label of each pixel row of a source column between lines `from` and `to` drawn over `rows` px: the label
 * covering most of the row's lines (unlabelled lines count as left out).
 */
export function rowLabels(runs: readonly CutRun[], from: number, to: number, rows: number): Label[] {
  const out: Label[] = new Array(Math.max(0, rows)).fill('.')
  if (rows <= 0) return out
  const per = (to - from + 1) / rows
  let j = 0
  for (let r = 0; r < rows; r++) {
    const a = from + r * per
    const b = from + (r + 1) * per // [a, b)
    while (j < runs.length && runs[j].t + 1 <= a) j++
    let best: Label = '.'
    let bestN = 0
    let covered = 0
    for (let i = j; i < runs.length && runs[i].f < b; i++) {
      const n = Math.min(b, runs[i].t + 1) - Math.max(a, runs[i].f)
      if (n <= 0) continue
      covered += n
      if (n > bestN) {
        bestN = n
        best = runs[i].l as Label
      }
    }
    out[r] = bestN > 0 && (bestN >= (b - a) - covered || best === 'B' || best === 'A' || best === 'H') ? best : '.'
  }
  return out
}
