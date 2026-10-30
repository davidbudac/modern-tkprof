import { useEffect, useRef, type ReactNode } from 'react'

/** A toolbar button with a popover under it (closes on a click outside and on Escape); `open` is the caller's, so it can open the menu itself. */
export function ToolbarMenu({ label, badge, title, open, onOpenChange, children }: {
  label: string; badge?: string; title?: string; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode
}) {
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onOpenChange(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onOpenChange(false) } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open, onOpenChange])
  return (
    <span className="tbmenu" ref={root}>
      <button className="quiet" aria-expanded={open} aria-haspopup="true" aria-pressed={open} onClick={() => onOpenChange(!open)} title={title}>
        {label}{badge && <small> {badge}</small>}
      </button>
      {open && <div className="tbpop" role="group" aria-label={label}>{children}</div>}
    </span>
  )
}
