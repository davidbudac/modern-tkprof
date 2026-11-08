import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react'
import { clampPane, separatorValues } from './keyNav'

const STEP = 16

/**
 * Drag handle on the edge of a pane. It sits inside the pane's container
 * (position: relative) and measures the pane from the container's near edge:
 * `anchor="end"` is a pane docked to the container's inline-end edge (width =
 * container end − pointer), `"start"` one docked to the inline-start edge.
 * Arrow keys nudge, double-click resets (onChange(null) = the CSS default). `aria-valuenow/min/max` carry the
 * pane's current width and its limits in px, read back from the layout after every change.
 */
export function ResizeHandle({ anchor, onChange, min = 220, maxFrac = 0.6, label, className }: {
  anchor: 'start' | 'end'
  onChange: (px: number | null) => void
  min?: number
  maxFrac?: number
  label: string
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState(false)
  const [aria, setAria] = useState<{ now: number; min: number; max: number } | null>(null)
  const widthAt = (x: number): number => {
    const box = ref.current!.parentElement!.getBoundingClientRect()
    const raw = anchor === 'end' ? box.right - x : x - box.left
    return clampPane(raw, min, box.width, maxFrac)
  }
  const center = () => { const r = ref.current!.getBoundingClientRect(); return r.left + r.width / 2 }
  const measure = useCallback(() => {
    const el = ref.current
    const parent = el?.parentElement
    if (!el || !parent) return
    const r = el.getBoundingClientRect()
    const next = separatorValues(anchor, r.left + r.width / 2, parent.getBoundingClientRect(), min, maxFrac)
    setAria((a) => (a && a.now === next.now && a.min === next.min && a.max === next.max ? a : next))
  }, [anchor, min, maxFrac])
  // the handle moves when its pane is resized (here or by a stored width arriving) or the container changes
  useEffect(() => {
    measure()
    const parent = ref.current?.parentElement
    if (!parent || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(parent)
    return () => ro.disconnect()
  }, [measure])
  const change = (px: number | null) => {
    onChange(px)
    requestAnimationFrame(measure) // after the new width has been laid out
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag(true)
    e.preventDefault()
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => { if (drag) change(widthAt(e.clientX)) }
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    // the arrow moves the edge in its own direction, whichever side the pane is on
    if (e.key === 'ArrowLeft') change(widthAt(center() - STEP))
    else if (e.key === 'ArrowRight') change(widthAt(center() + STEP))
    else return
    e.preventDefault()
  }
  return (
    <div ref={ref} className={'resizer' + (drag ? ' drag' : '') + (className ? ' ' + className : '')} role="separator" aria-orientation="vertical" aria-label={label} aria-valuenow={aria?.now} aria-valuemin={aria?.min} aria-valuemax={aria?.max} tabIndex={0}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={() => setDrag(false)} onPointerCancel={() => setDrag(false)}
      onLostPointerCapture={() => setDrag(false)} onDoubleClick={() => change(null)} onKeyDown={onKey} onFocus={measure} />
  )
}
