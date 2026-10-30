import { useEffect, useRef, type ReactNode } from 'react'

/** A toolbar button with a popover under it (closes on a click outside and on Escape); `open` is the caller's, so it can open the menu itself. */
export function ToolbarMenu({ label, badge, title, className, wide, open, onOpenChange, children }: {
  label: string; badge?: string; title?: string; /** extra class on the menu (`tbmenu-sm`: a popover that fits its content) */ className?: string; /** a wider popover (the outline) */ wide?: boolean; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode
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
    <span className={className ? `tbmenu ${className}` : 'tbmenu'} ref={root}>
      <button type="button" className="quiet" aria-expanded={open} aria-haspopup="true" aria-pressed={open} onClick={() => onOpenChange(!open)} title={title}>
        {label}{badge && <small> {badge}</small>}<span className="cue" aria-hidden="true">▾</span>
      </button>
      {open && <div className={wide ? 'tbpop wide' : 'tbpop'} role="group" aria-label={label}>{children}</div>}
    </span>
  )
}
