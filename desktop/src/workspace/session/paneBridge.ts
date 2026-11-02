import { useEffect, useRef, type RefObject } from 'react'
import type { Panes } from '../panes'

type Bridged = Pick<Panes, 'contextOpen'>

/** A pane the lib owns: where it is in the DOM, the class that says it is open, and its collapse tab. */
const PANES: { field: keyof Bridged; root: string; openWhen: (el: Element) => boolean; toggle: string }[] = [
  { field: 'contextOpen', root: '.wb', openWhen: (el) => !el.classList.contains('ctx-closed'), toggle: '.ctx-toggle' },
]

/**
 * Per-tab state for the Statements context pane. The lib keeps it in one global localStorage flag,
 * so the desktop cannot hand it its own state; instead it watches `root` for the pane (its class says
 * open or closed), applies the tab's saved state the first time a pane shows up (by pressing the
 * lib's own collapse tab) and reports every later change. `want` is the tab's saved state.
 */
export function usePaneBridge(root: RefObject<HTMLElement | null>, want: Bridged, onChange: (p: Bridged) => void) {
  const latest = useRef({ want, onChange })
  latest.current = { want, onChange }
  useEffect(() => {
    const host = root.current
    if (!host) return
    const seen = new WeakSet<Element>()
    const sync = () => {
      for (const p of PANES) {
        const el = host.querySelector(p.root)
        if (!el) continue
        const open = p.openWhen(el)
        if (!seen.has(el)) {
          seen.add(el)
          const wanted = latest.current.want[p.field] ?? true
          if (wanted !== open) host.querySelector<HTMLElement>(p.toggle)?.click() // the class change comes back through here
          continue
        }
        if (open !== (latest.current.want[p.field] ?? true)) latest.current.onChange({ [p.field]: open })
      }
    }
    const mo = new MutationObserver(sync)
    mo.observe(host, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] })
    sync()
    return () => mo.disconnect()
  }, [root])
}
