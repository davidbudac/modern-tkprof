// The Search map's geometry: a SearchMap (data/searchmap.ts) and the room it has, as the SVG path strings the panel draws. Pure, so the same
// code is tested with a run of four orders and with two thousand. Positions are pixel positions of printed costs on a log axis; no cost is
// combined with another (the ✕ of an aborted order sits a fixed number of pixels above the best-so-far line).
import type { SearchMap } from './searchmap'

export const PAD_T = 12
/** headroom above the highest cost on the axis for the ✕ of an aborted order that sits above the best-so-far line, in px */
export const HEAD = 17
export const MIN_COL = 3
export const MAX_COL = 56
/** pixels from the best-so-far line up to the ✕ of an aborted order */
export const X_LIFT = 9
export const STRIP_ROW = 6
export const AXIS_H = 18

export interface SmLayout {
  colW: number
  plotW: number
  plotH: number
  /** the strip of positions: its top, and its height */
  stripTop: number
  stripH: number
  svgH: number
  /** the y of a cost on the log axis; null when there is no axis */
  y(v: number): number
  grid: { y: number; v: number }[]
  xTicks: { x: number; label: string }[]
  /** the paths, in the order they are drawn */
  best: string
  ladderOk: string
  ladderWin: string
  ladderAb: string
  dash: string
  dotsOk: string
  dotsWin: string
  dotsAb: string
  endsOk: string
  endsWin: string
  crosses: string
  /** one path per colour slot: the squares of the permutation strip */
  strip: { slot: number; d: string }[]
  /** the winner's column band */
  band: { x: number; w: number } | null
  /** the dot radius in px (0: the ladders have no dots, only their ends) */
  dotR: number
}

const f = (n: number): string => (Math.round(n * 10) / 10).toString()

/** The width of a column when `avail` px are there for `n` orders: all of them fit when they can, else the narrowest column and the chart scrolls. */
export function columnWidth(avail: number, n: number): number {
  if (n <= 0) return MAX_COL
  return Math.max(MIN_COL, Math.min(MAX_COL, Math.floor(avail / n)))
}

export function dotRadius(colW: number): number {
  if (colW >= 20) return 3.5
  if (colW >= 12) return 3
  if (colW >= 7) return 2.2
  if (colW >= 4) return 1.5
  return 0
}

export function layoutMap(m: SearchMap, o: { avail: number; plotH: number }): SmLayout {
  const n = m.orders.length
  const colW = columnWidth(o.avail, n)
  const plotW = n * colW
  const plotH = o.plotH
  const maxPos = m.orders.reduce((k, x) => Math.max(k, x.tables.length), 0)
  const stripTop = PAD_T + plotH + AXIS_H
  const stripH = maxPos * STRIP_ROW
  const dotR = dotRadius(colW)
  const ax = m.axis
  const l0 = ax ? Math.log(ax.lo) : 0
  const span = ax ? Math.log(ax.hi) - l0 : 1
  const y = (v: number): number => PAD_T + HEAD + (plotH - HEAD) * (1 - (Math.log(v) - l0) / span)
  const cx = (i: number): number => (i + 0.5) * colW

  const ladderOk: string[] = []
  const ladderWin: string[] = []
  const ladderAb: string[] = []
  const dash: string[] = []
  const dotsOk: string[] = []
  const dotsWin: string[] = []
  const dotsAb: string[] = []
  const endsOk: string[] = []
  const endsWin: string[] = []
  const crosses: string[] = []
  const strip = new Map<number, string[]>()

  if (ax) {
    for (const o2 of m.orders) {
      const x = cx(o2.index)
      const pts = o2.points.filter((p) => p.v !== null).map((p) => y(p.v as number))
      const win = o2.isBest
      const lad = pts.length > 1 ? `M${f(x)} ${f(pts[0])}${pts.slice(1).map((py) => `L${f(x)} ${f(py)}`).join('')}` : ''
      const target = o2.done ? (win ? ladderWin : ladderOk) : ladderAb
      if (lad) target.push(lad)
      if (dotR > 0) {
        const dots = pts.map((py) => `M${f(x)} ${f(py)}h0`).join('')
        if (dots) (o2.done ? (win ? dotsWin : dotsOk) : dotsAb).push(dots)
      }
      if (o2.done) {
        if (pts.length > 0) (win ? endsWin : endsOk).push(`M${f(x)} ${f(pts[pts.length - 1])}h0`)
      } else {
        const last = pts.length > 0 ? pts[pts.length - 1] : null
        const yx = o2.bestV !== null ? Math.max(PAD_T + 4, y(o2.bestV) - X_LIFT) : last !== null ? Math.max(PAD_T + 4, last - X_LIFT) : PAD_T + 8
        if (last !== null && yx < last - 2) dash.push(`M${f(x)} ${f(last)}V${f(yx)}`)
        const s = Math.min(3, Math.max(1.5, colW / 3))
        crosses.push(`M${f(x - s)} ${f(yx - s)}l${f(2 * s)} ${f(2 * s)}m${f(-2 * s)} 0l${f(2 * s)} ${f(-2 * s)}`)
      }
    }
  }
  // the permutation strip: a square per position, one path per colour
  const w = Math.max(1, colW - 1)
  for (const o2 of m.orders) {
    const x0 = o2.index * colW + (colW - w) / 2
    o2.slot.forEach((s, p) => {
      let a = strip.get(s)
      if (!a) strip.set(s, (a = []))
      a.push(`M${f(x0)} ${f(stripTop + p * STRIP_ROW)}h${f(w)}v${STRIP_ROW - 1}h${f(-w)}z`)
    })
  }

  // the best-so-far line: each printed best holds from its order to the next one's
  let best = ''
  if (ax) {
    m.steps.forEach((s, k) => {
      const x0 = s.index * colW
      const x1 = (k + 1 < m.steps.length ? m.steps[k + 1].index : n) * colW
      best += (k === 0 ? `M${f(x0)} ${f(y(s.v))}` : `V${f(y(s.v))}`) + `H${f(x1)}`
    })
  }

  const every = Math.max(1, Math.ceil(34 / colW))
  const xTicks = m.orders.filter((x) => x.index % every === 0).map((x) => ({ x: cx(x.index), label: String(x.n) }))
  const grid = ax ? ax.ticks.map((v) => ({ y: y(v), v })) : []
  return {
    colW, plotW, plotH, stripTop, stripH, svgH: stripTop + stripH + 4, y, grid, xTicks,
    best, ladderOk: ladderOk.join(''), ladderWin: ladderWin.join(''), ladderAb: ladderAb.join(''), dash: dash.join(''),
    dotsOk: dotsOk.join(''), dotsWin: dotsWin.join(''), dotsAb: dotsAb.join(''), endsOk: endsOk.join(''), endsWin: endsWin.join(''), crosses: crosses.join(''),
    strip: [...strip.entries()].sort((a, b) => a[0] - b[0]).map(([slot, d]) => ({ slot, d: d.join('') })),
    band: m.winner >= 0 ? { x: m.winner * colW, w: colW } : null,
    dotR,
  }
}

/** The index of the order under an x (px from the left of the plot), or -1 outside it. */
export function orderAt(x: number, colW: number, n: number): number {
  const i = Math.floor(x / colW)
  return i >= 0 && i < n ? i : -1
}
