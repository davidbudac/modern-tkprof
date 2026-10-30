import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react'
import { placePopup, type PopAnchor } from './popoverPlace'

/**
 * The placement and closing rules of a popup on `document.body` under a clicked reference, shared by the statement, object and wait popovers:
 * the box goes under `anchor` (above it when the viewport ends first) through `--x` / `--y`; Esc, a pointer press outside it, a scroll or
 * a wheel outside it and a resize call `onClose`. Focus goes to the first `button[data-first]` and back to where it was.
 * `deps` re-places the box (the popup shown changed); the returned ref goes on the box.
 */
export function usePopover<T extends HTMLElement = HTMLDivElement>(anchor: PopAnchor, onClose: () => void, deps: readonly unknown[]): RefObject<T | null> {
  const root = useRef<T>(null)
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = root.current
    if (!el) return
    const p = placePopup(anchor, { w: el.offsetWidth, h: el.offsetHeight }, { w: window.innerWidth, h: window.innerHeight })
    el.style.setProperty('--x', `${p.left}px`)
    el.style.setProperty('--y', `${p.top}px`)
  }, deps)

  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    root.current?.querySelector<HTMLElement>('button[data-first]')?.focus({ preventScroll: true })
    const inside = (t: EventTarget | null) => t instanceof Node && !!root.current?.contains(t)
    const onDown = (e: PointerEvent) => { if (!inside(e.target)) closeRef.current() }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); closeRef.current() } }
    const onMove = (e: Event) => { if (!inside(e.target)) closeRef.current() }
    const onResize = () => closeRef.current()
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onMove, true)
    window.addEventListener('wheel', onMove, { capture: true, passive: true })
    window.addEventListener('resize', onResize)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onMove, true)
      window.removeEventListener('wheel', onMove, true)
      window.removeEventListener('resize', onResize)
      if (before && before.isConnected) before.focus({ preventScroll: true })
    }
  }, [])

  return root
}
