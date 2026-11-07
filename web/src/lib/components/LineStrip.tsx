import { useEffect, useRef, type PointerEvent } from 'react'
import { lineAtY, stmtRows, stripMarks, stripeSpans, type BinShape } from '../data/linestrip'
import { resolveVar } from './colors'

/** Width of the strip in CSS pixels. */
export const STRIP_W = 16
/** The edge lanes of the quiet ticks (bookmarks and hot spots at the start edge, search hits at the end edge); the highlighted statements have the width between them. */
const LANE = 3

/** The lines of the time window (1-based, inclusive). */
interface Range { from: number; to: number }

/** A highlighted statement's lines per bucket of the file, and the colour token it is drawn in (`--c-cpu`: the strip resolves it per theme). */
export interface StripLayer { id: number; token: string; counts: readonly number[] }

interface Props {
  total: number
  /** the highlighted statements' lines (the engine's binned answer), in the order the statements were highlighted; empty: nothing is highlighted */
  layers: readonly StripLayer[]
  /** the layout of the buckets of `layers`; null until the first answer */
  shape: BinShape | null
  /** the selected line */
  selected: number
  /** search hits: line numbers, ascending */
  hits: number[]
  bookmarks: ReadonlySet<number>
  /** the lines of the time window */
  range: Range | null
  /** the hot spots of the readable view (lines of 1 % of the traced time or more): a quiet tick at the start edge */
  hot?: readonly number[]
  /** the visible range: first line (1-based) and the lines that fit */
  view: { top: number; rows: number }
  /** a click, and the end of a drag: the line under the pointer */
  onJump(line: number): void
  /** the view follows the pointer while it is down (the viewer scrolls, nothing is selected yet) */
  onScrub?(line: number): void
}

/**
 * The whole file in a strip beside the viewer's scroll bar: the lines of the highlighted statements, each in its colour (where in the file they are; statements that share a pixel
 * row share the strip's width in stripes), the selected line, the visible range (a box) and the time window, and quiet ticks at the edges for what the client knows: bookmarks and hot
 * spots at the start edge, search hits at the end edge. With nothing highlighted only those are drawn. A click jumps to the line at that height, a drag scrubs. Painted on a canvas, at
 * most once per frame.
 */
export function LineStrip(props: Props) {
  const cv = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props
  const frame = useRef(0)
  const dragging = useRef<number | null>(null) // the last line scrubbed to, while the pointer is down
  // the pixel rows of one answer at one height, kept across the repaints a scroll causes
  const rows = useRef<{ layers: readonly StripLayer[]; shape: BinShape | null; h: number; by: Uint8Array[] } | null>(null)

  const paint = useRef(() => {
    frame.current = 0
    const el = cv.current
    if (!el) return
    const h = Math.floor(el.clientHeight)
    if (h <= 0) return
    const dpr = window.devicePixelRatio || 1
    const pw = Math.round(STRIP_W * dpr), ph = Math.round(h * dpr)
    if (el.width !== pw || el.height !== ph) { el.width = pw; el.height = ph }
    const ctx = el.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, STRIP_W, h)
    const { total: n, layers, shape, selected, hits, bookmarks, range, view, hot } = latest.current
    const ink = resolveVar('--ink'), ink2 = resolveVar('--ink-2'), crit = resolveVar('--s-critical'), amber = resolveVar('--c-commit')

    if (n > 0 && shape && layers.length > 0) {
      let r = rows.current
      if (!r || r.layers !== layers || r.shape !== shape || r.h !== h) r = rows.current = { layers, shape, h, by: stmtRows(layers.map((l) => l.counts), shape, h) }
      const colors = layers.map((l) => resolveVar(l.token))
      const mid = STRIP_W - 2 * LANE
      const present: number[] = []
      for (let y = 0; y < h; y++) {
        present.length = 0
        for (let k = 0; k < r.by.length; k++) if (r.by[k][y]) present.push(k)
        for (const s of stripeSpans(present, mid)) { ctx.fillStyle = colors[s.k]; ctx.fillRect(LANE + s.x, y, s.w, 2) } // (2 px: a statement with one line in a long file is still seen)
      }
    }

    if (n > 0) {
      if (hot?.length) {
        ctx.fillStyle = crit
        for (const y of stripMarks(hot, n, h)) ctx.fillRect(0, y, LANE, 1)
      }
      ctx.fillStyle = ink
      for (const y of stripMarks(bookmarks, n, h)) ctx.fillRect(0, Math.max(0, y - 1), LANE, 3)
      ctx.fillStyle = ink2
      for (const y of stripMarks(hits, n, h)) ctx.fillRect(STRIP_W - LANE, y, LANE, 1)
      if (range) {
        const y0 = ((range.from - 1) / n) * h, y1 = (range.to / n) * h
        ctx.globalAlpha = 0.2
        ctx.fillStyle = ink
        ctx.fillRect(0, y0, STRIP_W, Math.max(1, y1 - y0))
        ctx.globalAlpha = 1
      }
      if (selected >= 1 && selected <= n) { // the selected line: a bar across the whole width, in the colour of the selected row
        const y = Math.min(h - 2, Math.floor(((selected - 1) * h) / n))
        ctx.fillStyle = amber
        ctx.fillRect(0, y, STRIP_W, 2)
      }
      if (view.rows > 0) {
        const bh = Math.min(h, Math.max(5, (view.rows / n) * h))
        const y = Math.min(h - bh, Math.max(0, ((view.top - 1) / n) * h))
        ctx.globalAlpha = 0.1
        ctx.fillStyle = ink
        ctx.fillRect(0, y, STRIP_W, bh)
        ctx.globalAlpha = 1
        ctx.strokeStyle = ink
        ctx.lineWidth = 1
        ctx.strokeRect(0.5, y + 0.5, STRIP_W - 1, bh - 1)
      }
    }
  })

  const schedule = useRef(() => { if (!frame.current) frame.current = requestAnimationFrame(paint.current) })

  // repaint (once per frame) after every render that brought other props
  const { total, layers, shape, selected, hits, bookmarks, range, view, hot } = props
  useEffect(() => schedule.current(), [total, layers, shape, selected, hits, bookmarks, range, view.top, view.rows, hot])

  // the size, and the theme (the colours are tokens that change with it)
  useEffect(() => {
    const el = cv.current!
    const again = () => schedule.current()
    const ro = new ResizeObserver(again)
    ro.observe(el)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', again)
    const mo = new MutationObserver(again)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { ro.disconnect(); mq.removeEventListener('change', again); mo.disconnect(); cancelAnimationFrame(frame.current); frame.current = 0 }
  }, [])

  const lineOf = (e: PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return lineAtY(e.clientY - r.top, r.height, latest.current.total)
  }
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !latest.current.total) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic events have no active pointer */ }
    const line = lineOf(e)
    dragging.current = line
    latest.current.onScrub?.(line)
  }
  const onMove = (e: PointerEvent<HTMLCanvasElement>) => {
    if (dragging.current === null) return
    const line = lineOf(e)
    if (line === dragging.current) return
    dragging.current = line
    latest.current.onScrub?.(line)
  }
  const onUp = (e: PointerEvent<HTMLCanvasElement>) => {
    if (dragging.current === null) return
    dragging.current = null
    latest.current.onJump(lineOf(e))
  }

  return <canvas ref={cv} className="lv-strip" aria-hidden="true" onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => { dragging.current = null }} />
}
