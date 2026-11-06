// The views of the open trace in the frame's top row: history, the A|B side of a comparison, the view tabs (the lib's
// `ViewTabs`, as in the standalone shell's top bar) and the Tools menu. The views come from the `sessionViews` table.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import { flushSync } from 'react-dom'
import { useStore, useActions, useStoreApi, ViewTabs, isMac, viewKeyLabel, type SessionViewDef, type View } from '@lib'
import { sessionViews, shownViews } from './views'
import { navHistoryOf } from './navHistory'
import { DeskMenu } from '../../ui/DeskMenu'
import { useWorkspace, useWorkspaceState } from '../WorkspaceProvider'
import { BriefDialog } from './BriefDialog'
import { AssistantIcon, ChevronLeftIcon, ChevronRightIcon } from '../../ui/icons'

/** Opens and closes the active tab's assistant panel (⌘J, SessionShell.tsx); its state is the tab's (`Panes.assistantOpen`). */
function AssistantToggle() {
  const ws = useWorkspace()
  const { tabs, route } = useWorkspaceState()
  const tab = route.kind === 'tab' ? tabs.find((t) => t.key === route.key) : undefined
  if (!tab) return null
  const open = !!tab.panes?.assistantOpen
  const chord = isMac ? '⌘J' : 'Ctrl+J'
  return (
    <button className="tab assistant-toggle" aria-pressed={open} onClick={() => ws.setPanes(tab.key, { assistantOpen: !open })}
      aria-label="Assistant" title={`Ask an assistant about this trace (${chord})`} aria-keyshortcuts={isMac ? 'Meta+J' : 'Control+J'}>
      <AssistantIcon /><kbd className="key-hint" data-for="views" aria-hidden="true">{chord}</kbd>
    </button>
  )
}

/** Back and Forward through this tab's history of views and selections. */
function NavButtons() {
  const h = navHistoryOf(useStoreApi())
  const { canBack, canForward } = useSyncExternalStore(h.subscribe, h.getSnapshot)
  return (
    <span className="seg nav-hist" role="group" aria-label="History">
      <button onClick={() => h.back()} disabled={!canBack} aria-label="Back" title={`Back (${isMac ? '⌘[' : 'Alt+←'})`}><ChevronLeftIcon /></button>
      <button onClick={() => h.forward()} disabled={!canForward} aria-label="Forward" title={`Forward (${isMac ? '⌘]' : 'Alt+→'})`}><ChevronRightIcon /></button>
    </span>
  )
}

/** The chords of the rows that have a key (a row may have none: `SessionViewDef.key` is optional), or null when none has. */
function chordsOf(rows: SessionViewDef[]): string[] | null {
  const out = rows.filter((v) => v.key !== undefined).map((v) => viewKeyLabel(v.key, isMac))
  return out.length ? out : null
}

/** The key hint of the menu's rows: their chords, a run of three or more as a range (⌘5–9), so it stays about as wide as the button. */
export function menuHint(rows: SessionViewDef[], mac: boolean): string | null {
  const keys = rows.flatMap((v) => (v.key === undefined ? [] : [v.key]))
  const out: string[] = []
  for (let i = 0; i < keys.length;) {
    let j = i
    while (j + 1 < keys.length && keys[j + 1] === keys[j] + 1) j++
    if (j - i >= 2) out.push(`${viewKeyLabel(keys[i], mac)}–${keys[j]}`)
    else for (let k = i; k <= j; k++) out.push(viewKeyLabel(keys[k], mac))
    i = j + 1
  }
  return out.length ? out.join(' ') : null
}

/**
 * The views whose tabs do not fit the bar, in nav order. The bar wraps (app.css `.session-nav > .tabs`): a tab that went to a
 * second line is off the bar. The bar is then narrowed to the tabs left on it, so the room the wrapped one leaves goes back to
 * the row (the active tab's title) rather than staying a gap in the bar. Measured whenever an item of the row, the bar or a tab
 * changes size (window, fonts, tabs opened or closed, the views shown). `flushSync`: the hidden tabs and the menu change in the
 * frame that measured them, so a wrapped tab never shows below the row.
 */
function useOverflow(nav: RefObject<HTMLDivElement | null>, shown: string): View[] {
  const [over, setOver] = useState<View[]>([])
  useLayoutEffect(() => {
    const bar = nav.current?.querySelector<HTMLElement>(':scope > .tabs')
    const row = nav.current?.parentElement
    if (!bar || !row) return
    const tabs = () => Array.from(bar.querySelectorAll<HTMLElement>(':scope > .tab'))
    const measure = () => {
      bar.style.maxInlineSize = '' // as wide as the row lets it be
      const all = tabs()
      const top = all[0]?.offsetTop ?? 0
      const on = all.filter((t) => t.offsetTop <= top)
      const last = on[on.length - 1]
      if (last && on.length < all.length) bar.style.maxInlineSize = `${Math.ceil(last.offsetLeft + last.offsetWidth - all[0].offsetLeft)}px`
      const next = all.filter((t) => t.offsetTop > top).map((t) => t.dataset.view as View)
      setOver((was) => (was.join() === next.join() ? was : next))
    }
    measure()
    let first = true // observe() reports every target once at the start: measured above
    const ro = new ResizeObserver(() => { if (first) first = false; else flushSync(measure) })
    for (const el of [...row.children, ...tabs()]) ro.observe(el)
    return () => { ro.disconnect(); bar.style.maxInlineSize = '' }
  }, [nav, shown])
  return over
}

/**
 * `Tools ▾`: the views of the tab rather than of the trace (Notes, Reports), and `Copy brief…`, which opens the brief's dialog.
 * In a narrow window it also holds the views whose tabs do not fit the bar (`over`, on top) and reads `More ▾`.
 * When one of its views is on screen the button names it and is marked as the current page.
 */
function ToolsMenu({ over, tools, onBrief }: { over: SessionViewDef[]; tools: SessionViewDef[]; onBrief: () => void }) {
  const actions = useActions()
  const view = useStore((s) => s.view)
  const [open, setOpen] = useState(false)
  const current = [...over, ...tools].find((v) => v.id === view)
  const chords = chordsOf(tools)
  const row = (v: SessionViewDef) => (
    <button key={v.id} className={v.id === view ? 'menu-item-on' : undefined} onClick={() => actions.setView(v.id)}>{v.label}{v.key !== undefined && <> <kbd>{viewKeyLabel(v.key, isMac)}</kbd></>}</button>
  )
  const title = `${over.length ? `${over.map((v) => v.label).join(', ')} (no room on the bar); n` : 'N'}otes and reports of this trace${chords ? ` (${chords.join(', ')})` : ''}, and the brief for an LLM`
  return (
    <DeskMenu label={current?.label ?? (over.length ? 'More' : 'Tools')} title={title} fixed current={!!current} open={open} onOpenChange={setOpen}>
      {over.map(row)}
      {over.length > 0 && tools.length > 0 && <hr />}
      {tools.map(row)}
      <hr />
      <button onClick={onBrief} title="A Markdown summary of this trace, with your notes, to paste into an LLM">Copy brief…</button>
    </DeskMenu>
  )
}

/**
 * History, the side of a comparison, the views and the Tools menu of the active tab; with a hairline after them that sets them
 * apart from the app's pages. Inside the tab's SessionProvider; nothing until the document is in.
 */
export function SessionNav() {
  const actions = useActions()
  const store = useStoreApi()
  const state = useStore((s) => s)
  const [briefOpen, setBriefOpen] = useState(false)
  const nav = useRef<HTMLDivElement>(null)
  // another tab's session (a shortcut works under the dialog): its brief is not this one
  useEffect(() => setBriefOpen(false), [store])
  const doc = state.doc
  const shown = doc ? shownViews(doc, state) : []
  const overIds = useOverflow(nav, doc ? shown.map((v) => v.id).join() : '')
  if (!doc) return null
  const compare = state.compare
  const tools = shown.filter((v) => v.group === 'tools')
  const over = shown.filter((v) => overIds.includes(v.id))
  const menuChords = menuHint([...over, ...tools], isMac)
  return (
    <>
      <div className="session-nav" ref={nav}>
        <NavButtons />
        {compare && (
          <span className="seg side" role="group" aria-label="Trace shown by the views" title="trace shown in the views">
            {(['a', 'b'] as const).map((k) => (
              <button key={k} aria-pressed={state.side === k} onClick={() => actions.setSide(k)} title={(compare[k].file.traceFile || compare[k].file.path).split(/[\\/]/).pop()}>{k.toUpperCase()}</button>
            ))}
          </span>
        )}
        <ViewTabs views={sessionViews} overflow={new Set(overIds)} hint={(_, chord) => <kbd className="key-hint" data-for="views" aria-hidden="true">{chord}</kbd>} />
        {(tools.length > 0 || over.length > 0) && (
          <>
            <span className="tabs-divider" role="separator" />
            <span className="tools-slot">
              <ToolsMenu over={over} tools={tools} onBrief={() => setBriefOpen(true)} />
              {menuChords && <kbd className="key-hint" data-for="views" aria-hidden="true">{menuChords}</kbd>}
            </span>
          </>
        )}
        <AssistantToggle />
      </div>
      <span className="nav-divider" role="separator" aria-orientation="vertical" />
      <BriefDialog open={briefOpen} onClose={() => setBriefOpen(false)} />
    </>
  )
}
