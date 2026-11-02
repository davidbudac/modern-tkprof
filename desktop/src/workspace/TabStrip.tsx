import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { LiveBadge, SessionProvider, isMac, type Session } from '@lib'
import { pages } from '../pages'
import { BrandIcon } from '../branding/BrandIcon'
import { useEngine } from '../engine'
import { EngineMenu } from '../EngineMenu'
import { useWorkspace, useWorkspaceState } from './WorkspaceProvider'
import { setTooltip } from './traceSet'
import { canCompare, leaveRoute, type Tab } from './workspace'
import { CompareTabsDialog, type CompareRequest } from './CompareTabs'
import { tabKeyLabel } from './shortcuts'
import { FolderIcon } from '../ui/FolderIcon'
import { CloseIcon, PlusIcon } from '../ui/icons'
import { TabTraceExtras, TabTracePop } from './session/TabTrace'
import { SessionNav } from './session/SessionNav'

const stateMark = (t: Tab) =>
  t.state === 'opening' ? <i className="tab-dot busy" aria-label="opening" /> : t.state === 'failed' ? <i className="tab-dot bad" aria-label="failed" /> : null

/** Whether the session's store has its document (a tab that is still opening, failed to open or compares two traces has none to show). */
function useHasDoc(session: Session | null): boolean {
  const subscribe = useCallback((l: () => void) => session?.store.subscribe(l) ?? (() => {}), [session])
  return useSyncExternalStore(subscribe, () => !!session?.store.getState().doc)
}

/**
 * The frame's one top row: brand, one tab per session, "+" (the open screen), then on the right the views of the open trace
 * (`SessionNav`), the desktop pages and the engine dot. (Compare tabs… is on the open screen.)
 * The active session tab is the trace's identity: it also carries the trace's status and opens the trace popover.
 */
export function TabStrip() {
  const ws = useWorkspace()
  const { tabs, route, origin } = useWorkspaceState()
  const { status } = useEngine()
  const [menu, setMenu] = useState<{ key: string; x: number; y: number } | null>(null)
  const [compare, setCompare] = useState<CompareRequest | null>(null)
  const busy = status === 'starting' || status === 'restarting' || tabs.some((t) => t.state === 'opening')
  const active = route.kind === 'tab' ? tabs.find((t) => t.key === route.key) : undefined
  // the views of the trace belong to the active session tab; a comparison tab has its own body and no such views
  const navSession = active && active.origin !== 'comparison' ? active.session : null
  return (
    <header className="frame-top">
      <button type="button" className="brand" aria-label="Go to Overview" title="Go to Overview" onClick={() => {
        const to = route.kind === 'page' ? leaveRoute(tabs, origin) : route
        const tab = to.kind === 'tab' ? tabs.find((t) => t.key === to.key) : undefined
        if (tab && tab.origin !== 'comparison') {
          tab.session?.store.actions.setView('overview')
          ws.go({ kind: 'tab', key: tab.key })
        } else ws.go({ kind: 'open' })
      }}><BrandIcon motion={busy ? 'loop' : undefined} /><span className="brand-name">mtkprof</span></button>
      <nav className="session-tabs" aria-label="Open traces" role="tablist">
        {tabs.map((t, index) => (
          <SessionTab key={t.key} tab={t} index={index} on={route.kind === 'tab' && route.key === t.key} onMenu={setMenu} />
        ))}
        <button
          role="tab"
          aria-selected={route.kind === 'open'}
          className={'session-tab plus' + (route.kind === 'open' ? ' on' : '')}
          onClick={() => ws.go({ kind: 'open' })}
          aria-label="Open a trace"
          title="Open a trace"
        >
          <PlusIcon />
        </button>
      </nav>
      <span className="spacer" />
      {navSession && <SessionProvider session={navSession}><SessionNav /></SessionProvider>}
      <nav className="page-links" aria-label="App">
        {pages.filter((p) => !p.hidden).map((p) => (
          <button
            key={p.id}
            className="quiet"
            aria-current={route.kind === 'page' && route.id === p.id ? 'page' : undefined}
            onClick={() => ws.go({ kind: 'page', id: p.id })}
            aria-label={p.label}
            title={p.label}
          >
            {p.icon}
          </button>
        ))}
        <EngineMenu />
      </nav>
      {menu && <TabMenu at={menu} onClose={() => setMenu(null)} onCompare={(a) => setCompare({ a })} />}
      <CompareTabsDialog request={compare} onClose={() => setCompare(null)} />
    </header>
  )
}

/**
 * One session tab. The active one with a document is the trace's identity: after the title its button shows the trace's status
 * (files, live, file status, response sparkline, a `▾`), and a click on it opens the trace popover under the tab.
 */
function SessionTab({ tab: t, index, on, onMenu }: { tab: Tab; index: number; on: boolean; onMenu: (at: { key: string; x: number; y: number }) => void }) {
  const ws = useWorkspace()
  const { tabs } = useWorkspaceState()
  // ⌃1 to ⌃8 by position, ⌃9 the last one
  const digit = index === tabs.length - 1 ? 9 : index < 8 ? index + 1 : null
  const session = t.origin === 'comparison' ? null : t.session
  const hasDoc = useHasDoc(session)
  const trace = on && hasDoc ? session : null
  // the popover is fixed under the button (the row clips sideways, which would cut an absolute one); null = closed
  const [at, setAt] = useState<{ top: number; left: number } | null>(null)
  const root = useRef<HTMLSpanElement>(null)
  const open = trace !== null && at !== null
  useEffect(() => {
    if (!trace) setAt(null) // another tab or page, or the trace is gone
  }, [trace])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setAt(null) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); setAt(null) } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  return (
    <span
      ref={root}
      className={'session-tab' + (on ? ' on' : '')}
      onAuxClick={(e) => e.button === 1 && ws.close(t.key)}
      onContextMenu={(e) => {
        e.preventDefault()
        // from the keyboard (the context-menu key, Shift+F10) the event has no pointer: the menu opens under the tab
        const r = e.currentTarget.getBoundingClientRect()
        const kb = e.clientX === 0 && e.clientY === 0
        onMenu({ key: t.key, x: kb ? r.left : e.clientX, y: kb ? r.bottom + 2 : e.clientY })
      }}
    >
      <button
        role="tab"
        aria-selected={on}
        aria-haspopup={trace ? 'dialog' : undefined}
        aria-expanded={trace ? open : undefined}
        className="session-tab-main"
        onClick={(e) => {
          if (!on) return ws.go({ kind: 'tab', key: t.key })
          if (!trace) return
          const r = e.currentTarget.getBoundingClientRect()
          setAt(open ? null : { top: r.bottom + 4, left: r.left })
        }}
        title={setTooltip(t.set.paths, t.files) + (digit ? `\n${tabKeyLabel(digit, isMac)}` : '')}
        onKeyDown={(e) => {
          if (e.altKey && e.shiftKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
            e.preventDefault()
            ws.move(t.key, index + (e.key === 'ArrowLeft' ? -1 : 1))
          }
        }}
      >
        {stateMark(t)}
        {t.dirs.length > 0 && <FolderIcon className="folder-mark" />}
        <span className="mono">{t.title}</span>
        {trace ? <SessionProvider session={trace}><TabTraceExtras files={t.files} live={t.live} /></SessionProvider> : t.live && <span className="badge-live">live</span>}
        {digit && <kbd className="key-hint" data-for="tabs" aria-hidden="true">{tabKeyLabel(digit, isMac)}</kbd>}
      </button>
      {/* beside the button, not in it: the badge has its own pause / resume button */}
      {trace && <SessionProvider session={trace}><LiveBadge /></SessionProvider>}
      <button className="session-tab-close" onClick={() => ws.close(t.key)} aria-label={`Close ${t.title}`} title="Close"><CloseIcon /></button>
      {trace && at && <SessionProvider session={trace}><TabTracePop files={t.files} at={at} /></SessionProvider>}
    </span>
  )
}

/** The right-click menu of a tab: where it sits, close, compare. A small popover at the pointer; Escape, a click outside or a choice closes it. */
function TabMenu({ at, onClose, onCompare }: { at: { key: string; x: number; y: number }; onClose: () => void; onCompare: (a: string) => void }) {
  const ws = useWorkspace()
  const { tabs } = useWorkspaceState()
  const root = useRef<HTMLDivElement>(null)
  const index = tabs.findIndex((t) => t.key === at.key)
  const tab = tabs[index]
  const canCmp = !!tab && canCompare(tab) && tabs.filter(canCompare).length >= 2
  useEffect(() => { root.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus() }, [])
  useEffect(() => {
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) onClose() }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); onClose(); return }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
      e.preventDefault()
      const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
      const cur = items.indexOf(document.activeElement as HTMLButtonElement)
      items[(cur + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus()
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('blur', onClose)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true); window.removeEventListener('blur', onClose) }
  }, [onClose])
  if (!tab) return null
  const mod = isMac ? '⌥⇧' : 'Alt+Shift+'
  const act = (f: () => void) => () => { onClose(); f() }
  return (
    <div ref={root} className="pop ctx-menu" role="menu" aria-label={`Tab ${tab.title}`} style={{ insetBlockStart: Math.min(at.y, window.innerHeight - 180), insetInlineStart: Math.min(at.x, window.innerWidth - 220) }}>
      <button role="menuitem" disabled={index === 0} onClick={act(() => ws.move(tab.key, index - 1))}>Move left <kbd>{mod}←</kbd></button>
      <button role="menuitem" disabled={index === tabs.length - 1} onClick={act(() => ws.move(tab.key, index + 1))}>Move right <kbd>{mod}→</kbd></button>
      <hr />
      <button role="menuitem" disabled={!canCmp} onClick={act(() => onCompare(tab.key))} title={canCmp ? 'Compare this trace with another open one' : 'Needs two ready, non-live traces'}>Compare with…</button>
      <hr />
      <button role="menuitem" onClick={act(() => ws.close(tab.key))}>Close <kbd>{isMac ? '⌘W' : 'Ctrl+W'}</kbd></button>
      <button role="menuitem" disabled={tabs.length < 2} onClick={act(() => { ws.go({ kind: 'tab', key: tab.key }); tabs.filter((t) => t.key !== tab.key).forEach((t) => ws.close(t.key)) })}>Close others</button>
    </div>
  )
}
