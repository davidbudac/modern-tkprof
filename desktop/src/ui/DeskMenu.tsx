import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { ToolbarMenu } from '@lib/components/ToolbarMenu'

/**
 * The lib's `ToolbarMenu` (a button with a `▾` and a popover that closes on a click outside and on Escape) with the desktop's
 * look (`.deskmenu`, see app.css). Where a clipping ancestor would cut an absolute popover (the session top bar scrolls sideways,
 * the connections list column clips) `fixed` places it under the button instead. `current` marks the button as the page you are on.
 */
export function DeskMenu({ label, title, align = 'end', fixed, current, open, onOpenChange, className, children }: {
  label: string; title?: string; /** side of the button the popover lines up with */ align?: 'start' | 'end'; fixed?: boolean; current?: boolean
  open: boolean; onOpenChange: (open: boolean) => void; className?: string; children: ReactNode
}) {
  const root = useRef<HTMLSpanElement>(null)
  const [at, setAt] = useState({ top: 0, edge: 0 })
  useEffect(() => {
    const b = root.current?.querySelector(':scope > .tbmenu > button')
    if (!b) return
    if (current) b.setAttribute('aria-current', 'page')
    else b.removeAttribute('aria-current')
  }, [current, label])
  const change = (o: boolean) => {
    if (o && fixed && root.current) {
      const r = root.current.getBoundingClientRect()
      setAt({ top: r.bottom + 4, edge: align === 'end' ? window.innerWidth - r.right : r.left })
    }
    onOpenChange(o)
  }
  const style = fixed
    ? ({ '--pop-top': `${at.top}px`, [align === 'end' ? '--pop-right' : '--pop-left']: `${at.edge}px` } as Record<string, string> as CSSProperties)
    : undefined
  return (
    <span ref={root} className={'deskmenu-wrap' + (fixed ? ' fixed' : '') + (current ? ' current' : '')} style={style}>
      <ToolbarMenu label={label} title={title} className={'deskmenu tbmenu-sm' + (align === 'start' ? ' tbmenu-start' : '') + (className ? ' ' + className : '')} open={open} onOpenChange={change}>
        {/* a click on an entry does its work and closes the menu */}
        <div className="menu-items" onClick={(e) => { if ((e.target as HTMLElement).closest('button:not(:disabled)')) onOpenChange(false) }}>{children}</div>
      </ToolbarMenu>
    </span>
  )
}
