import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'

/** A toolbar button with a popover under it (closes on a click outside and on Escape); `open` is the caller's, so it can open the menu itself. */
export function ToolbarMenu({ label, badge, title, className, wide, disabled, open, onOpenChange, button, onButton, children }: {
  label: string; /** the button is off (an open menu closes) */ disabled?: boolean; badge?: string; title?: string; /** extra class on the menu (`tbmenu-sm`: a popover that fits its content) */ className?: string; /** a wider popover (the outline) */ wide?: boolean; open: boolean; onOpenChange: (open: boolean) => void
  /** the button's content instead of the label, badge and cue */ button?: ReactNode
  /** the button runs this instead of toggling the popover (the owner opens the popover some other way, e.g. a key) */ onButton?: () => void
  children: ReactNode
}) {
  const root = useRef<HTMLSpanElement>(null)
  const pop = useRef<HTMLDivElement>(null)
  // the popover hangs from the button's edge; a button near a window edge would put it off screen, so it is shifted back in (8px margin)
  useLayoutEffect(() => {
    const el = pop.current
    if (!open || !el) return
    const place = () => {
      el.style.translate = ''
      const r = el.getBoundingClientRect()
      const pad = 8
      let dx = 0
      if (r.left < pad) dx = pad - r.left
      else if (r.right > window.innerWidth - pad) dx = Math.max(window.innerWidth - pad - r.right, pad - r.left)
      if (dx) el.style.translate = `${dx}px 0`
      const room = window.innerHeight - r.top - pad
      el.style.maxBlockSize = room > 160 ? `${room}px` : ''
    }
    place()
    const ro = new ResizeObserver(place)
    ro.observe(el)
    window.addEventListener('resize', place)
    return () => { ro.disconnect(); window.removeEventListener('resize', place) }
  }, [open, wide])
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
      <button type="button" className="quiet" aria-expanded={onButton ? undefined : open} aria-haspopup={onButton ? undefined : 'true'} aria-pressed={onButton ? undefined : open} onClick={() => (onButton ? onButton() : onOpenChange(!open))} title={title} disabled={disabled}>
        {button ?? <>{label}{badge && <small> {badge}</small>}<span className="cue" aria-hidden="true">▾</span></>}
      </button>
      {open && !disabled && <div className={wide ? 'tbpop wide' : 'tbpop'} role="group" aria-label={label} ref={pop}>{children}</div>}
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
