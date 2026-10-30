import { useEffect, useRef, type ReactNode } from 'react'

/** A toolbar button with a popover under it (closes on a click outside and on Escape); `open` is the caller's, so it can open the menu itself. */
export function ToolbarMenu({ label, badge, title, className, wide, disabled, open, onOpenChange, children }: {
  label: string; /** the button is off (an open menu closes) */ disabled?: boolean; badge?: string; title?: string; /** extra class on the menu (`tbmenu-sm`: a popover that fits its content) */ className?: string; /** a wider popover (the outline) */ wide?: boolean; open: boolean; onOpenChange: (open: boolean) => void; children: ReactNode
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
      <button type="button" className="quiet" aria-expanded={open} aria-haspopup="true" aria-pressed={open} onClick={() => onOpenChange(!open)} title={title} disabled={disabled}>
        {label}{badge && <small> {badge}</small>}<span className="cue" aria-hidden="true">▾</span>
      </button>
      {open && !disabled && <div className={wide ? 'tbpop wide' : 'tbpop'} role="group" aria-label={label}>{children}</div>}
    </span>
  )
}

/** One entry of a toolbar menu: a check or radio row (`on` shows a leading tick and sets `aria-pressed`), with an optional shortcut at the end. The menu stays open on a click; close it in `onClick` for an action. */
export function MenuItem({ on, kbd, title, disabled, onClick, children }: {
  /** the state of a toggle entry; leave out for a plain action */ on?: boolean; /** the shortcut, shown at the end */ kbd?: string; title?: string; disabled?: boolean; onClick: () => void; children: ReactNode
}) {
  return (
    <button type="button" className={on ? 'quiet tb-item on' : 'quiet tb-item'} aria-pressed={on} disabled={disabled} title={title} aria-keyshortcuts={kbd && kbd.length === 1 ? kbd : undefined} onClick={onClick}>
      <span className="tb-tick" aria-hidden="true">{on ? '✓' : ''}</span><span>{children}</span>{kbd ? <kbd>{kbd}</kbd> : <span />}
    </button>
  )
}
