import { useEffect, useRef, type PointerEvent } from 'react'
import type { LineProfile } from '../data/lines'
import { bucketRows, densityRows, lineAtY, stripMarks } from '../data/linestrip'
import { resolveVar } from './colors'

/** Width of the strip in CSS pixels. */
export const STRIP_W = 14

/** The lines of the time window (1-based, inclusive). */
interface Range { from: number; to: number }

interface Props {
  /** the shape of the file; null while it is not loaded (nothing is painted but the overlays) */
  profile: LineProfile | null
  total: number
  /** search hits: line numbers, ascending */
  hits: number[]
  bookmarks: ReadonlySet<number>
  /** line → 1 (a call of the selected statement), 2 (a wait), 3 (both) */
  marks: ReadonlyMap<number, number>
  /** the lines of the time window */
  range: Range | null
  /** the visible range: first line (1-based) and the lines that fit */
  view: { top: number; rows: number }
  /** a click, and the end of a drag: the line under the pointer */
  onJump(line: number): void
  /** the view follows the pointer while it is down (the viewer scrolls, nothing is selected yet) */
  onScrub?(line: number): void
}

/**
 * The whole file in a strip beside the viewer's scroll bar: calls on the left and waits on the right as density, ticks for errors,
 * cursor parses and commits, then what the client knows: the hits of the search, bookmarks, the marks of the selected statement,
 * the time window and the visible range. A click jumps to the line at that height, a drag scrubs. Painted on a canvas, at most once per frame.
 */
export function LineStrip(props: Props) {
  const cv = useRef<HTMLCanvasElement>(null)
  const latest = useRef(props)
  latest.current = props
  const frame = useRef(0)
  const dragging = useRef<number | null>(null) // the last line scrubbed to, while the pointer is down
  // the density rows of one profile at one height, kept across the repaints a scroll causes
  const rows = useRef<{ profile: LineProfile; h: number; calls: Float64Array; waits: Float64Array; cursors: Float64Array; errors: Float64Array; commits: Float64Array } | null>(null)

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
    const { profile: p, total: t, hits, bookmarks, marks, range, view } = latest.current
    const cpu = resolveVar('--c-cpu'), wait = resolveVar('--c-userio'), commit = resolveVar('--c-commit'), crit = resolveVar('--s-critical')
    const ink = resolveVar('--ink'), ink3 = resolveVar('--ink-3')
    const n = t || p?.total || 0

    if (p && p.buckets > 0 && p.total > 0) {
      let r = rows.current
      if (!r || r.profile !== p || r.h !== h) {
        const d = densityRows(p, h)
        r = rows.current = { profile: p, h, calls: d.calls, waits: d.waits, cursors: bucketRows(p.cursors, p, h), errors: bucketRows(p.errors, p, h), commits: bucketRows(p.commits, p, h) }
      }
      const half = (STRIP_W - 2) / 2
      for (let y = 0; y < h; y++) {
        // the square root keeps a thin trickle visible next to a burst
        if (r.calls[y] > 0) { ctx.fillStyle = cpu; ctx.fillRect(0, y, Math.max(1, Math.round(Math.sqrt(r.calls[y]) * half)), 1) }
        if (r.waits[y] > 0) { const w = Math.max(1, Math.round(Math.sqrt(r.waits[y]) * half)); ctx.fillStyle = wait; ctx.fillRect(STRIP_W - w, y, w, 1) }
      }
      ctx.globalAlpha = 0.35
      ctx.fillStyle = ink3
      for (let y = 0; y < h; y++) if (r.cursors[y] > 0) ctx.fillRect(0, y, STRIP_W, 1)
      ctx.globalAlpha = 1
      ctx.fillStyle = commit
      for (let y = 0; y < h; y++) if (r.commits[y] > 0) ctx.fillRect(4, y, STRIP_W - 8, 1)
      ctx.fillStyle = crit
      for (let y = 0; y < h; y++) if (r.errors[y] > 0) ctx.fillRect(0, y, STRIP_W, 1)
    }

    if (n > 0) {
      ctx.fillStyle = ink
      for (const y of stripMarks(marks.keys(), n, h)) ctx.fillRect(5, y, 4, 1)
      ctx.fillStyle = commit
      for (const y of stripMarks(hits, n, h)) ctx.fillRect(STRIP_W - 5, y, 5, 2)
      ctx.fillStyle = ink
      for (const y of stripMarks(bookmarks, n, h)) ctx.fillRect(0, Math.max(0, y - 1), 3, 3)
      if (range) {
        const y0 = ((range.from - 1) / n) * h, y1 = (range.to / n) * h
        ctx.globalAlpha = 0.2
        ctx.fillStyle = ink
        ctx.fillRect(0, y0, STRIP_W, Math.max(1, y1 - y0))
        ctx.globalAlpha = 1
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
  const { profile, total, hits, bookmarks, marks, range, view } = props
  useEffect(() => schedule.current(), [profile, total, hits, bookmarks, marks, range, view.top, view.rows])

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
    const p = latest.current
    return lineAtY(e.clientY - r.top, r.height, p.total || p.profile?.total || 0)
  }
  const onDown = (e: PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !(latest.current.total || latest.current.profile?.total)) return
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
