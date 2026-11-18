// The canvas side of the Plan replay (views/Replay.tsx): the animation state (block flights, row dots, fetch packets, the
// blocks' heat) and the drawing of the stage and the lanes. The model and every position come from data/replay.ts.

import { resolveVar } from '../components/colors'
import { fmtDur } from '../data/format'
import {
  cellCenter, cellOfWait, edgePoint, lanesLayout, stageLayout,
  type Grid, type GridBox, type LanesLayout, type Pt, type Replay, type RLine, type RWait, type Seg, type StageLayout,
} from '../data/replay'
import { CallKind } from '../data/types'

/** Colour tokens of the objects' blocks, in slot order (then again): none of the CPU, TEMP or client hues. */
export const OBJECT_TOKENS = ['--ev-direct', '--ev-scat', '--c-commit', '--c-concurrency'] as const
/** TEMP writes and reads: two hues told apart at a glance in a grid of small cells (the Loom's two browns are not). */
export const TEMP_WRITE = '--c-userio', TEMP_READ = '--c-sysio'

export interface Palette {
  ink: string; ink2: string; ink3: string; hairline: string; panel: string; wash: string
  cpu: string; twrite: string; tread: string; client: string; net: string; other: string
  objects: string[]
  ui: string; mono: string
}

export function readPalette(): Palette {
  const css = getComputedStyle(document.documentElement)
  return {
    ink: resolveVar('--ink'), ink2: resolveVar('--ink-2'), ink3: resolveVar('--ink-3'), hairline: resolveVar('--hairline-strong'),
    panel: resolveVar('--surface-raised'), wash: resolveVar('--surface-sunken'),
    cpu: resolveVar('--c-cpu'), twrite: resolveVar(TEMP_WRITE), tread: resolveVar(TEMP_READ), client: resolveVar('--c-idle'),
    net: resolveVar('--ink-2'), other: resolveVar('--c-other'), objects: OBJECT_TOKENS.map(resolveVar),
    ui: css.getPropertyValue('--font-ui').trim() || 'sans-serif', mono: css.getPropertyValue('--font-mono').trim() || 'monospace',
  }
}

/** Seconds the whole execution takes at 1×. */
export const FIT_SECONDS = 22
/** At most this many block flights start per frame; the other waits of the frame only light their blocks. */
const FLIGHTS_PER_FRAME = 6
/** Row dots per edge over the whole execution. */
const DOTS_PER_EDGE = 240

interface CellState { r: Float32Array; w: Float32Array; last: Float64Array; kind: Int8Array }
interface Dot { l: RLine; t0: number; dur: number; j: number }
interface Flight { t0: number; dur: number; a: Pt; b: Pt; col: string; size: number; arc: number }
interface Packet { t0: number; rows: number }

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))
const lerp = (a: number, b: number, t: number) => a + (b - a) * t
const int = (n: number) => Math.round(n).toLocaleString('en-US')

export class ReplayScene {
  lay!: StageLayout
  lanes!: LanesLayout
  private lanesImg: HTMLCanvasElement | null = null
  T = 0
  private lastT = 0
  private dots: Dot[] = []
  private flights: Flight[] = []
  private packets: Packet[] = []
  private cells = new Map<Grid, CellState>()
  private waitAt = 0
  private fetchAt = 0
  private emit = new Map<RLine, number>()
  private readonly waitsByStart: RWait[]
  /** fetches with rows (packets) and every FETCH's end (the client's count) */
  private readonly fetches: { end: number; rows: number }[]
  private readonly fetchEnds: number[]

  constructor(readonly r: Replay, readonly pal: Palette, readonly motion: boolean, readonly dpr: number) {
    this.waitsByStart = r.waits.filter((w) => w.blocks > 0 && w.kind !== 'recursive').sort((a, b) => a.start - b.start)
    this.fetches = r.calls.filter((c) => c.kind === CallKind.fetch && c.rows > 0).map((c) => ({ end: c.end, rows: c.rows }))
    this.fetchEnds = r.calls.filter((c) => c.kind === CallKind.fetch).map((c) => c.end)
  }

  setWidth(width: number) {
    this.lay = stageLayout(this.r, width)
    this.lanes = lanesLayout(this.r, width)
    this.lanesImg = null
    this.seek(this.T)
  }

  /** Jump to t: the blocks' state is replayed from the start without motion. */
  seek(t: number) {
    this.T = clamp(t, 0, this.r.D)
    this.dots = []; this.flights = []; this.packets = []; this.emit = new Map()
    this.cells = new Map()
    for (const g of [this.r.data, this.r.temp]) if (g) this.cells.set(g, { r: new Float32Array(g.n), w: new Float32Array(g.n), last: new Float64Array(g.n).fill(-1e12), kind: new Int8Array(g.n) })
    this.waitAt = 0; this.fetchAt = 0
    this.apply(this.T, false, 0)
    this.lastT = this.T
  }

  /** Move the clock to t (later than now), with motion for what happens on the way. */
  advance(t: number, now: number) {
    this.lastT = this.T
    this.T = clamp(t, 0, this.r.D)
    this.apply(this.T, this.motion, now)
  }

  private gridOf(w: RWait): Grid | null {
    return w.kind === 'twrite' || w.kind === 'tread' ? this.r.temp : this.r.data
  }

  private apply(t: number, animate: boolean, now: number) {
    const ws = this.waitsByStart, started: RWait[] = []
    while (this.waitAt < ws.length && ws[this.waitAt].start <= t) {
      const w = ws[this.waitAt++]
      const g = this.gridOf(w), st = g && this.cells.get(g)
      if (g && st && w.file > 0) {
        for (let k = 0; k < w.blocks; k++) {
          const c = cellOfWait(g, w, k)
          if (c === undefined) continue
          if (w.kind === 'twrite' || w.kind === 'write') st.w[c] += 1; else st.r[c] += 1
          st.last[c] = animate ? now : -1e12
          st.kind[c] = w.kind === 'twrite' || w.kind === 'write' ? 1 : w.kind === 'tread' ? 2 : 0
        }
      }
      if (animate) started.push(w)
    }
    if (animate && started.length) {
      const every = Math.max(1, Math.ceil(started.length / FLIGHTS_PER_FRAME))
      for (let i = 0; i < started.length; i += every) this.fly(started[i], now, Math.min(every, started.length - i))
    }
    while (this.fetchAt < this.fetches.length && this.fetches[this.fetchAt].end <= t) {
      const f = this.fetches[this.fetchAt++]
      if (!animate) continue
      const last = this.packets[this.packets.length - 1]
      if (last && now - last.t0 < 160) last.rows += f.rows; else this.packets.push({ t0: now, rows: f.rows })
    }
  }

  private fly(w: RWait, now: number, weight: number) {
    const n = w.line && this.lay.nodes.get(w.line)
    if (!n) return
    let from: Pt | null = null
    const g = this.gridOf(w), box = g && this.lay.grids.find((b) => b.grid === g)
    if (box && g) {
      if (w.file > 0) { const c = cellOfWait(g, w); if (c !== undefined) from = cellCenter(box, c) }
      else if (w.line) {
        // no block address (db file parallel read): a block of the object
        const cs: number[] = []
        for (let i = 0; i < g.n; i++) if (g.owner[i] === w.line.objSlot) cs.push(i)
        if (cs.length) from = cellCenter(box, cs[Math.floor(Math.random() * cs.length)])
      }
    }
    if (!from) return
    const tree = this.lay.mode === 'tree'
    const at: Pt = tree ? [n.dock[0] - 4, n.dock[1] + (Math.random() - 0.5) * 6] : [n.x + n.w * (0.25 + 0.5 * Math.random()), n.y + n.h]
    const down = w.kind === 'twrite' || w.kind === 'write'
    this.flights.push({ t0: now, dur: 700 + Math.random() * 250, a: down ? at : from, b: down ? from : at, col: this.waitColor(w), size: clamp(2 + Math.sqrt(w.blocks * weight) * 0.9, 2.5, 7), arc: tree ? 10 : 18 })
  }

  objColor(slot: number): string {
    return slot >= 0 ? this.pal.objects[slot % this.pal.objects.length] : this.pal.ink3
  }

  waitColor(w: RWait): string {
    switch (w.kind) {
      case 'read': case 'write': return w.line ? this.objColor(w.line.objSlot) : this.pal.other
      case 'twrite': return this.pal.twrite
      case 'tread': return this.pal.tread
      case 'client': return this.pal.client
      case 'net': return this.pal.net
      default: return this.pal.other
    }
  }

  /** Each line's state at the clock: the colour of the wait it is in, or CPU (weighted when spread by self time). */
  stateAt(seg: Seg | null): Map<RLine, { col: string; wait: boolean; weight: number }> {
    const m = new Map<RLine, { col: string; wait: boolean; weight: number }>()
    if (!seg) return m
    if (seg.type === 'cpu') for (const [l, v] of seg.lines) m.set(l, { col: this.pal.cpu, wait: false, weight: v })
    if (seg.type === 'wait' && seg.w.line) m.set(seg.w.line, { col: this.waitColor(seg.w), wait: true, weight: 1 })
    return m
  }

  // ---------------------------------------------------------------- the stage

  drawStage(g: CanvasRenderingContext2D, now: number, playing: boolean) {
    const { r, lay, pal } = this
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    g.clearRect(0, 0, lay.width, lay.height)
    const seg = r.segAt(this.T)
    const active = this.stateAt(seg)
    const clientTime = seg?.type === 'client'
    const ended = this.T >= r.D - 1
    const pulse = this.motion ? 0.5 + 0.5 * Math.sin(now / 180) : 0.6
    g.textBaseline = 'alphabetic'

    for (const b of lay.grids) this.drawGrid(g, b, now)

    // edges and row dots
    for (const l of r.lines) {
      if (!l.parent) continue
      const on = active.has(l) && active.has(l.parent)
      g.strokeStyle = on ? pal.cpu : pal.hairline
      g.globalAlpha = l.inactive ? 0.35 : on ? 0.7 : 1
      g.lineWidth = on ? 1.6 : 1
      this.strokeEdge(g, l, l.parent)
      g.globalAlpha = 1; g.lineWidth = 1
      if (l.inactive || !r.rowsKnown) continue
      const rows = r.rowsAt(l, this.T), before = r.rowsAt(l, this.lastT)
      if (playing && this.motion && rows > before) {
        const per = Math.max(1, l.rows / DOTS_PER_EDGE)
        let acc = (this.emit.get(l) ?? 0) + (rows - before) / per, k = 0
        while (acc >= 1 && k < 40) { acc -= 1; k++; this.dots.push({ l, t0: now - Math.random() * 60, dur: 900 + Math.random() * 300, j: (Math.random() - 0.5) * 5 }) }
        this.emit.set(l, acc)
      }
      if (lay.mode === 'cards' && rows >= 1) {
        const [x0, y0] = lay.nodes.get(l)!.out
        g.fillStyle = pal.ink2; g.font = `11px ${pal.mono}`
        g.fillText(`${ended ? '' : '≈'}${int(rows)}`, x0 + 6, y0 - 6)
      }
    }
    this.dots = this.dots.filter((d) => now - d.t0 < d.dur)
    g.fillStyle = pal.ink
    for (const d of this.dots) {
      const k = (now - d.t0) / d.dur
      const [x, y] = edgePoint(lay, d.l, d.l.parent!, k)
      g.globalAlpha = Math.sin(Math.PI * k) * 0.9
      g.beginPath(); g.arc(x + (lay.mode === 'tree' ? d.j * 0.3 : 0), y + (lay.mode === 'cards' ? d.j * Math.sin(Math.PI * k) : 0), 1.6, 0, Math.PI * 2); g.fill()
    }
    g.globalAlpha = 1

    // the root's way to the client
    g.strokeStyle = pal.hairline; g.setLineDash([4, 4])
    g.beginPath(); g.moveTo(...lay.rootOut); g.lineTo(...lay.client.in); g.stroke(); g.setLineDash([])

    // block flights
    this.flights = this.flights.filter((f) => now - f.t0 < f.dur)
    for (const f of this.flights) {
      const k = (now - f.t0) / f.dur, e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2
      const x = lerp(f.a[0], f.b[0], e), y = lerp(f.a[1], f.b[1], e) - Math.sin(Math.PI * e) * f.arc
      g.fillStyle = f.col; g.globalAlpha = 0.95 - k * 0.3
      g.fillRect(x - f.size / 2, y - f.size / 2, f.size, f.size)
      g.globalAlpha *= 0.22; g.fillRect(x - f.size, y - f.size, f.size * 2, f.size * 2)
    }
    g.globalAlpha = 1

    for (const l of r.lines) this.drawNode(g, l, active.get(l), seg, clientTime, ended, pulse)
    this.drawClient(g, clientTime, pulse)

    // fetch packets, on top
    this.packets = this.packets.filter((p) => now - p.t0 < 900)
    for (const p of this.packets) {
      const k = clamp((now - p.t0) / 900, 0, 1), e = 1 - Math.pow(1 - k, 3)
      const [x0, y0] = lay.rootOut, [x1, y1] = lay.client.in
      const x = lerp(x0, x1, e), y = lerp(y0, y1, e)
      const len = clamp(6 + Math.log10(p.rows) * 5, 6, 26)
      g.globalAlpha = 1 - Math.max(0, k - 0.75) * 4
      g.fillStyle = pal.ink
      g.beginPath()
      if (lay.mode === 'tree') g.roundRect(x - 4, y - len / 2, 8, len, 4); else g.roundRect(x - len / 2, y - 4, len, 8, 4)
      g.fill()
      if (p === this.packets[this.packets.length - 1]) {
        g.font = `10.5px ${pal.mono}`
        const t = p.rows === 1 ? '1 row' : '+' + int(p.rows)
        if (lay.mode === 'tree') g.fillText(t, x + 8, y + 4)
        else { g.textAlign = 'center'; g.fillText(t, x, y - 9); g.textAlign = 'left' }
      }
      g.globalAlpha = 1
    }
  }

  private strokeEdge(g: CanvasRenderingContext2D, child: RLine, parent: RLine) {
    const a = this.lay.nodes.get(child)!.out, b = this.lay.nodes.get(parent)!.in
    g.beginPath(); g.moveTo(a[0], a[1])
    if (this.lay.mode === 'cards') g.bezierCurveTo((a[0] + b[0]) / 2, a[1], (a[0] + b[0]) / 2, b[1], b[0], b[1])
    else { g.lineTo(b[0], a[1]); g.lineTo(b[0], b[1]) }
    g.stroke()
  }

  private drawGrid(g: CanvasRenderingContext2D, b: GridBox, now: number) {
    const { pal } = this, gr = b.grid, st = this.cells.get(gr)
    if (!st) return
    const files = gr.files
    const title = gr.temp ? `TEMP · file${files.length > 1 ? 's' : ''} ${files.join(', ')}` : files.length > 3 ? `${files.length} datafiles` : `datafile${files.length > 1 ? 's' : ''} ${files.join(', ')}`
    g.font = `11px ${pal.ui}`; g.fillStyle = pal.ink2
    g.fillText(fit(g, `${title} · ${int(gr.distinct)} block${gr.distinct === 1 ? '' : 's'} touched`, b.w), b.x, b.y - 5)
    const c = b.cell, pad = c > 3 ? 1 : 0
    for (let i = 0; i < gr.n; i++) {
      const o = gr.owner[i]
      if (o === -2) continue
      const x = b.x + (i % b.cols) * c, y = b.y + Math.floor(i / b.cols) * c
      if (y + c > b.y + b.h + 1) break
      const hit = st.r[i] + st.w[i]
      if (gr.temp) { g.fillStyle = st.w[i] ? pal.twrite : pal.hairline; g.globalAlpha = st.w[i] ? clamp(0.3 + Math.log2(1 + st.r[i]) * 0.11, 0.3, 0.95) : 0.35 }
      else { g.fillStyle = this.objColor(o); g.globalAlpha = hit ? 0.65 : 0.12 }
      g.fillRect(x, y, c - pad, c - pad)
      const age = (now - st.last[i]) / 900
      if (age < 1) {
        g.globalAlpha = (1 - age) * 0.95
        g.fillStyle = st.kind[i] === 2 ? pal.tread : st.kind[i] === 1 ? pal.twrite : pal.ink
        g.fillRect(x - 0.5, y - 0.5, c - pad + 1, c - pad + 1)
      }
      g.globalAlpha = 1
    }
  }

  private drawNode(g: CanvasRenderingContext2D, l: RLine, a: { col: string; wait: boolean; weight: number } | undefined, seg: Seg | null, clientTime: boolean, ended: boolean, pulse: number) {
    const { r, pal, lay } = this
    const n = lay.nodes.get(l)!
    const tree = lay.mode === 'tree'
    const frac = r.fracAt(l, this.T)
    const done = !l.inactive && frac >= 0.999 && this.T > r.doneAt(l) && !a
    const dim = l.inactive ? 0.4 : 1
    g.save()
    g.globalAlpha = dim
    if (a && this.motion) { g.shadowColor = a.col; g.shadowBlur = (a.wait ? 12 + 9 * pulse : 13) * (0.35 + 0.65 * a.weight) }
    g.fillStyle = pal.panel; g.beginPath(); g.roundRect(n.x, n.y, n.w, n.h, tree ? 5 : 8); g.fill()
    g.restore()
    g.globalAlpha = dim
    g.strokeStyle = a ? a.col : pal.hairline; g.lineWidth = a ? 1 + 0.7 * a.weight : 1
    if (clientTime) g.setLineDash([3, 3])
    g.beginPath(); g.roundRect(n.x + 0.5, n.y + 0.5, n.w - 1, n.h - 1, tree ? 5 : 8); g.stroke()
    g.setLineDash([]); g.lineWidth = 1
    const objCol = this.objColor(l.objSlot)
    if (r.rowsKnown) { g.fillStyle = l.objSlot >= 0 ? objCol : pal.ink2; g.globalAlpha = dim * 0.85; g.fillRect(n.x + 6, n.y + n.h - 3, Math.max(0, (n.w - 12) * frac), 1.5) }
    g.globalAlpha = dim
    const rows = r.rowsAt(l, this.T)
    const exact = (l === r.root && r.fetchRows > 0) || ended
    const rowTxt = Number.isNaN(rows) ? '—' : `${exact || rows === 0 ? '' : '≈'}${int(rows)}`
    let blk = 0
    for (const w of l.reads) if (w.start <= this.T) blk += w.blocks
    let tw = 0, tr = 0
    for (const w of l.twrites) if (w.start <= this.T) tw++
    for (const w of l.treads) if (w.start <= this.T) tr++
    const sub = l.twrites.length || l.treads.length ? `TEMP ↓${int(tw)} ↑${int(tr)}` : l.reads.length ? `${int(blk)} blk` : ''
    if (tree) {
      g.textBaseline = 'middle'
      const cy = n.y + n.h / 2
      g.font = `10.5px ${pal.ui}`; g.fillStyle = pal.ink2; g.fillText(String(l.id), n.x + 6, cy)
      const idw = g.measureText(String(l.id)).width + 11
      g.font = `11px ${pal.mono}`; g.textAlign = 'right'
      const right = l.inactive ? 'not started' : `${rowTxt}${done ? ' ✓' : ''}`
      g.fillStyle = l.inactive ? pal.ink2 : pal.ink; g.fillText(right, n.x + n.w - 8, cy)
      let used = g.measureText(right).width + 16
      const extra = (t: string) => { const sw = g.measureText(t).width; if (n.w - idw - used - sw - 70 > 0) { g.fillStyle = pal.ink2; g.fillText(t, n.x + n.w - 8 - used, cy); used += sw + 10 } }
      if (sub) extra(sub)
      if (l.starts > 1) extra(`×${int(l.starts)}`)
      g.textAlign = 'left'
      g.font = `600 11px ${pal.ui}`; g.fillStyle = pal.ink
      const room = n.w - idw - used - 6
      const title = fit(g, l.op, Math.max(30, room * (l.object ? 0.62 : 1)))
      g.fillText(title, n.x + idw, cy)
      if (l.object) { const tw2 = g.measureText(title).width + 6; g.font = `11px ${pal.ui}`; g.fillStyle = objCol; g.fillText(fit(g, l.object, room - tw2), n.x + idw + tw2, cy) }
      g.textBaseline = 'alphabetic'
    } else {
      g.fillStyle = pal.ink2; g.font = `10.5px ${pal.ui}`; g.fillText(String(l.id), n.x + 8, n.y + 15)
      g.fillStyle = pal.ink; g.font = `600 11.5px ${pal.ui}`; g.fillText(fit(g, l.op, n.w - 30), n.x + 22, n.y + 15)
      if (l.object) { g.font = `11px ${pal.ui}`; g.fillStyle = objCol; g.fillText(fit(g, l.object, n.w - 30), n.x + 22, n.y + 29) }
      g.font = `11px ${pal.mono}`; g.fillStyle = pal.ink
      const ry = n.y + (l.object ? 45 : 31)
      g.fillText(l.inactive ? 'not started' : `${rowTxt} rows`, n.x + 8, ry)
      if (done) { g.fillStyle = pal.ink2; g.fillText('done', n.x + n.w - 8 - g.measureText('done').width, ry) }
      g.fillStyle = pal.ink2
      const sub2 = sub.replace(' blk', ' blocks read') + (l.starts > 1 ? `${sub ? ' · ' : ''}${int(l.starts)} starts` : '')
      if (sub2) g.fillText(fit(g, sub2, n.w - 16), n.x + 8, ry + 13)
      if (a) {
        const tag = a.wait && seg?.type === 'wait' ? seg.w.name : 'on CPU'
        g.font = `10.5px ${pal.ui}`
        const w = Math.min(g.measureText(tag).width + 12, lay.width - n.x - 2)
        g.fillStyle = pal.panel; g.beginPath(); g.roundRect(n.x, n.y + n.h + 4, w, 15, 7); g.fill()
        g.fillStyle = a.col; g.globalAlpha = 0.18; g.beginPath(); g.roundRect(n.x, n.y + n.h + 4, w, 15, 7); g.fill(); g.globalAlpha = 1
        g.fillStyle = a.col; g.fillText(fit(g, tag, w - 12), n.x + 6, n.y + n.h + 15)
      }
    }
    g.globalAlpha = 1
  }

  private drawClient(g: CanvasRenderingContext2D, clientTime: boolean, pulse: number) {
    const { pal, lay } = this
    const n = lay.client
    let rows = 0, fetches = 0
    for (const f of this.fetches) if (f.end <= this.T) rows += f.rows
    for (const e of this.fetchEnds) if (e <= this.T) fetches++
    const tree = lay.mode === 'tree'
    g.save()
    if (clientTime && this.motion) { g.shadowColor = pal.client; g.shadowBlur = 12 + 8 * pulse }
    g.fillStyle = pal.panel; g.beginPath(); g.roundRect(n.x, n.y, n.w, n.h, tree ? 5 : 8); g.fill()
    g.restore()
    g.strokeStyle = clientTime ? pal.client : pal.hairline; g.lineWidth = clientTime ? 1.6 : 1
    g.beginPath(); g.roundRect(n.x + 0.5, n.y + 0.5, n.w - 1, n.h - 1, tree ? 5 : 8); g.stroke(); g.lineWidth = 1
    const counts = `${int(rows)} row${rows === 1 ? '' : 's'} · ${int(fetches)} fetch${fetches === 1 ? '' : 'es'}`
    if (tree) {
      g.textBaseline = 'middle'
      const cy = n.y + n.h / 2
      g.font = `600 11px ${pal.ui}`; g.fillStyle = pal.ink; g.fillText('client', n.x + 8, cy)
      if (clientTime) { g.font = `11px ${pal.ui}`; g.fillStyle = pal.ink2; g.fillText('SQL*Net message from client', n.x + 52, cy) }
      g.font = `11px ${pal.mono}`; g.fillStyle = pal.ink; g.textAlign = 'right'; g.fillText(counts, n.x + n.w - 8, cy)
      g.textAlign = 'left'; g.textBaseline = 'alphabetic'
    } else {
      g.fillStyle = pal.ink; g.font = `600 11.5px ${pal.ui}`; g.fillText('client', n.x + 8, n.y + 16)
      g.font = `11px ${pal.mono}`; g.fillText(`${int(rows)} row${rows === 1 ? '' : 's'}`, n.x + 8, n.y + 32)
      g.fillStyle = pal.ink2; g.fillText(`${int(fetches)} fetch${fetches === 1 ? '' : 'es'}`, n.x + 8, n.y + 47)
      if (clientTime) {
        g.font = `10.5px ${pal.ui}`
        const tag = 'SQL*Net message from client', w = g.measureText(tag).width + 12, x = Math.min(n.x, lay.width - w - 2)
        g.fillStyle = pal.client; g.globalAlpha = 0.25; g.beginPath(); g.roundRect(x, n.y + n.h + 4, w, 15, 7); g.fill(); g.globalAlpha = 1
        g.fillStyle = pal.ink2; g.fillText(tag, x + 6, n.y + n.h + 15)
      }
    }
  }

  // ---------------------------------------------------------------- the lanes

  drawLanes(g: CanvasRenderingContext2D) {
    const { lanes } = this
    if (!this.lanesImg) this.lanesImg = this.paintLanes()
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, g.canvas.width, g.canvas.height)
    g.drawImage(this.lanesImg, 0, 0)
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0)
    const { rows, lh, head, gx, w } = lanes
    const X = (t: number) => gx + (t / this.r.D) * w
    const ch = this.r.chapterAt(this.T)
    const bottom = head + rows.length * lh
    g.strokeStyle = this.pal.cpu; g.globalAlpha = 0.7; g.strokeRect(X(ch.a) + 0.5, 0.5, X(ch.b) - X(ch.a) - 1, bottom - 1)
    g.fillStyle = this.pal.ink; g.globalAlpha = 0.08; g.fillRect(gx, head, X(this.T) - gx, rows.length * lh); g.globalAlpha = 1
    g.strokeStyle = this.pal.ink; g.lineWidth = 1.5; g.beginPath(); g.moveTo(X(this.T), 2); g.lineTo(X(this.T), bottom); g.stroke(); g.lineWidth = 1
  }

  private paintLanes(): HTMLCanvasElement {
    const { r, pal, lanes } = this
    const cv = document.createElement('canvas')
    cv.width = Math.round(this.lay.width * this.dpr); cv.height = Math.round(lanes.height * this.dpr)
    const g = cv.getContext('2d')!
    g.scale(this.dpr, this.dpr)
    const { rows, lh, head, gx, w } = lanes
    const X = (t: number) => gx + (t / r.D) * w
    const bottom = head + rows.length * lh
    g.font = `11px ${pal.ui}`; g.textBaseline = 'middle'
    r.chapters.forEach((c, i) => {
      g.fillStyle = pal.ink; g.globalAlpha = i % 2 ? 0.03 : 0.07
      g.fillRect(X(c.a), 0, X(c.b) - X(c.a), bottom)
      g.globalAlpha = 1; g.fillStyle = pal.ink2; g.fillText(String(i + 1), X(c.a) + 5, head / 2)
    })
    g.fillStyle = pal.ink2; g.fillText('chapters', 4, head / 2)
    for (const row of rows) {
      g.strokeStyle = pal.hairline; g.globalAlpha = 0.5; g.beginPath(); g.moveTo(0, row.y + 0.5); g.lineTo(this.lay.width, row.y + 0.5); g.stroke(); g.globalAlpha = 1
      const ind = 4 + (row.kind === 'line' ? Math.min(row.line.depth, 8) * 7 : 0)
      g.fillStyle = row.kind === 'line' ? (row.line.inactive ? pal.ink3 : pal.ink) : pal.ink2
      g.font = `${lh < 18 ? 10 : 11}px ${pal.ui}`
      g.fillText(fit(g, row.label, gx - ind - 10), ind, row.y + lh / 2)
    }
    const lineRow = new Map(rows.flatMap((x) => (x.kind === 'line' ? [[x.line, x] as const] : [])))
    const rowOf = (k: string) => rows.find((x) => x.kind === k)
    const box = (y: number | undefined, a: number, b: number, col: string, alpha = 1) => {
      if (y === undefined) return
      const ins = Math.min(4, lh / 4)
      g.fillStyle = col; g.globalAlpha = alpha
      const x = X(a); g.fillRect(x, y + ins, Math.max(X(b), x + 1) - x, lh - ins * 2); g.globalAlpha = 1
    }
    const cpu = rowOf('cpu')?.y, rec = rowOf('recursive')?.y, other = rowOf('other')?.y, client = rowOf('client')?.y
    for (const s of r.segs) {
      if (s.type === 'cpu') box(cpu, s.a, s.b, pal.cpu, 0.75)
      else if (s.type === 'recursive') box(rec, s.a, s.b, pal.other, 0.6)
      else if (s.type === 'between') box(other, s.a, s.b, pal.other, 0.5)
    }
    for (const wt of r.waits) {
      if (wt.kind === 'recursive') continue
      if (wt.kind === 'client' || wt.kind === 'net') box(client, wt.start, wt.end, wt.kind === 'client' ? pal.client : pal.net, 0.9)
      else if (wt.line) box(lineRow.get(wt.line)?.y, wt.start, wt.end, this.waitColor(wt), wt.kind === 'pxwait' ? 0.45 : 0.95)
      else box(other, wt.start, wt.end, wt.kind === 'read' ? pal.ink3 : pal.other, 0.9)
    }
    if (client !== undefined) for (const f of this.fetches) { g.fillStyle = pal.ink; g.globalAlpha = 0.9; g.fillRect(X(f.end) - 0.5, client + 2, 1.5, lh - 4); g.globalAlpha = 1 }
    g.fillStyle = pal.ink2; g.font = `11px ${pal.ui}`
    for (let i = 0; i <= 5; i++) {
      const t = (r.D * i) / 5
      g.textAlign = i === 0 ? 'left' : i === 5 ? 'right' : 'center'
      g.fillText(i === 0 ? '0' : fmtDur(t), X(t), bottom + 10)
    }
    g.textAlign = 'left'
    if (r.firstRow !== null && client !== undefined) {
      const x = X(r.firstRow)
      g.strokeStyle = pal.ink2; g.setLineDash([3, 3]); g.beginPath(); g.moveTo(x + 0.5, head); g.lineTo(x + 0.5, bottom); g.stroke(); g.setLineDash([])
      g.fillStyle = pal.ink2; g.textAlign = 'right'; g.fillText('first row', x - 5, client + lh / 2); g.textAlign = 'left'
    }
    return cv
  }

  /** The lanes' time at an x of the lanes canvas (CSS pixels). */
  timeAtX(x: number): number {
    return clamp(((x - this.lanes.gx) / this.lanes.w) * this.r.D, 0, this.r.D)
  }
}

function fit(g: CanvasRenderingContext2D, s: string, w: number): string {
  if (w <= 0) return ''
  if (g.measureText(s).width <= w) return s
  let lo = 0, hi = s.length
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (g.measureText(s.slice(0, m) + '…').width <= w) lo = m; else hi = m - 1 }
  return lo ? s.slice(0, lo) + '…' : ''
}

/** What the process does at a moment, for the caption. */
export function describeSeg(r: Replay, seg: Seg | null, t: number): string {
  if (!seg) return t >= r.D - 1 ? 'end of the execution' : 'between calls'
  switch (seg.type) {
    case 'wait': {
      const w = seg.w
      const where = w.file > 0 ? ` · file ${w.file} block ${int(w.block)}${w.blocks > 1 ? ` +${int(w.blocks - 1)}` : ''}` : w.blocks > 1 ? ` · ${int(w.blocks)} blocks` : ''
      return `${w.line ? `${w.line.id} ${w.line.op}${w.line.object ? ' ' + w.line.object : ''} · ` : ''}${w.name} · ${fmtDur(w.ela)}${where}`
    }
    case 'cpu': {
      const ids = [...seg.lines.keys()].map((l) => l.id)
      return `on CPU in ${seg.call.kind === CallKind.exec ? 'EXEC' : 'FETCH'}${ids.length ? ` · ≈ line${ids.length > 1 ? 's' : ''} ${ids.join(' ')}${seg.spread ? ' (by self time)' : ''}` : ''}`
    }
    case 'recursive': return 'recursive SQL'
    case 'client': return `client · ${seg.w.name} · ${fmtDur(seg.w.ela)}`
    case 'between': return `${seg.w.name} · ${fmtDur(seg.w.ela)}`
  }
}
