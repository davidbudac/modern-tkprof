import { useEffect, useRef, useState, type PointerEvent } from 'react'
import type { TraceDoc } from '../data/doc'
import { reduceMinimap, minimapSpanUs } from '../data/minimap'
import { useStore, useActions } from '../state/session'
import { cssColor } from './colors'

/**
 * The whole trace in a strip: CPU and wait classes stacked per bucket, the current time window shaded.
 * Drag sets the window; a click inside the window re-centres it, a click outside clears it. Renders nothing for documents without `stats.minimap`.
 */
export function Minimap({ doc, height = 28 }: { doc: TraceDoc; height?: number }) {
  const mm = doc.stats.minimap
  const actions = useActions()
  const win = useStore((s) => s.window)
  const idle = useStore((s) => s.includeIdle)
  const theme = useStore((s) => s.theme)
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [width, setWidth] = useState(0)
  // the drag lives in a ref (pointer events can arrive before React re-renders); state only triggers a repaint
  const dragRef = useRef<{ x0: number; x1: number } | null>(null)
  const [, repaint] = useState(0)
  const setDrag = (d: { x0: number; x1: number } | null) => { dragRef.current = d; repaint((n) => n + 1) }

  useEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(Math.floor(el.clientWidth)))
    ro.observe(el)
    setWidth(Math.floor(el.clientWidth))
    return () => ro.disconnect()
  }, [mm])

  useEffect(() => {
    const cv = canvas.current
    if (!cv || !mm || width <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(width * dpr)
    cv.height = Math.round(height * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.scale(dpr, dpr)
    const series = reduceMinimap(mm, width, idle)
    const top = new Float64Array(width) // stack height so far, 0..1
    for (const s of series) {
      ctx.fillStyle = cssColor(s.role)
      for (let x = 0; x < width; x++) {
        const v = s.values[x]
        if (v <= 0) continue
        const y1 = height * (1 - top[x]), y0 = height * (1 - Math.min(1, top[x] + v))
        ctx.fillRect(x, y0, 1, Math.max(y1 - y0, 0.5))
        top[x] += v
      }
    }
  }, [mm, width, height, idle, theme])

  if (!mm || mm.cpu.length === 0) return null

  const base = doc.span.firstTim
  const spanUs = Math.min(doc.spanUs(), minimapSpanUs(mm)) || minimapSpanUs(mm)
  const timAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect()
    return base + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * minimapSpanUs(mm)
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic events have no active pointer */ }
    setDrag({ x0: e.clientX, x1: e.clientX })
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => { const d = dragRef.current; if (d) setDrag({ x0: d.x0, x1: e.clientX }) }
  const onUp = () => {
    const d = dragRef.current
    if (!d) return
    setDrag(null)
    if (Math.abs(d.x1 - d.x0) < 4) {
      if (!win) return
      const t = timAt(d.x1)
      if (t < win.startTim || t > win.endTim) { actions.setWindow(null); return }
      const half = (win.endTim - win.startTim) / 2
      const mid = Math.min(base + spanUs - half, Math.max(base + half, t))
      actions.setWindow({ startTim: mid - half, endTim: mid + half })
      return
    }
    const a = timAt(Math.min(d.x0, d.x1)), b = Math.min(timAt(Math.max(d.x0, d.x1)), base + spanUs)
    actions.setWindow(b - a < spanUs * 0.999 ? { startTim: a, endTim: b } : null)
  }

  const drag = dragRef.current
  const frac = (tim: number) => (100 * (tim - base)) / minimapSpanUs(mm)
  const shade = drag && box.current
    ? (() => {
        const r = box.current!.getBoundingClientRect()
        const l = Math.max(0, Math.min(drag.x0, drag.x1) - r.left)
        return { left: `${l}px`, width: `${Math.min(r.width - l, Math.abs(drag.x1 - drag.x0))}px` }
      })()
    : win ? { left: `${frac(win.startTim)}%`, width: `${frac(win.endTim) - frac(win.startTim)}%` } : null
  return (
    <div className="minimap" ref={box} style={{ blockSize: height }} role="img" aria-label="Trace activity overview; drag to set the time window"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
      <canvas ref={canvas} style={{ inlineSize: width, blockSize: height }} />
      {shade && <div className="minimap-window" style={shade} />}
    </div>
  )
}
