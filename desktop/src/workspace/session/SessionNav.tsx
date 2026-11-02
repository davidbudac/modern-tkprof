// The views of the open trace in the frame's top row: history, the A|B side of a comparison, the view tabs (the lib's
// `ViewTabs`, as in the standalone shell's top bar) and the Tools menu. The views come from the `sessionViews` table.
import { useEffect, useState, useSyncExternalStore } from 'react'
import { useStore, useActions, useStoreApi, ViewTabs, isMac, viewKeyLabel, type SessionViewDef } from '@lib'
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

/**
 * `Tools ▾`: the views of the tab rather than of the trace (Notes, Reports), and `Copy brief…`, which opens the brief's dialog.
 * When a view is on screen the button names it and is marked as the current page.
 */
function ToolsMenu({ tools, onBrief }: { tools: SessionViewDef[]; onBrief: () => void }) {
  const actions = useActions()
  const view = useStore((s) => s.view)
  const [open, setOpen] = useState(false)
  const current = tools.find((v) => v.id === view)
  return (
    <DeskMenu label={current?.label ?? 'Tools'} title={`Notes and reports of this trace (${tools.map((v) => viewKeyLabel(v.key, isMac)).join(', ')}), and the brief for an LLM`} fixed current={!!current} open={open} onOpenChange={setOpen}>
      {tools.map((v) => (
        <button key={v.id} className={v.id === view ? 'menu-item-on' : undefined} onClick={() => actions.setView(v.id)}>{v.label} <kbd>{viewKeyLabel(v.key, isMac)}</kbd></button>
      ))}
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
  // another tab's session (a shortcut works under the dialog): its brief is not this one
  useEffect(() => setBriefOpen(false), [store])
  const doc = state.doc
  if (!doc) return null
  const compare = state.compare
  const tools = shownViews(doc, state).filter((v) => v.group === 'tools')
  return (
    <>
      <div className="session-nav">
        <NavButtons />
        {compare && (
          <span className="seg side" role="group" aria-label="Trace shown by the views" title="trace shown in the views">
            {(['a', 'b'] as const).map((k) => (
              <button key={k} aria-pressed={state.side === k} onClick={() => actions.setSide(k)} title={(compare[k].file.traceFile || compare[k].file.path).split(/[\\/]/).pop()}>{k.toUpperCase()}</button>
            ))}
          </span>
        )}
        <ViewTabs views={sessionViews} hint={(_, chord) => <kbd className="key-hint" data-for="views" aria-hidden="true">{chord}</kbd>}>
          {tools.length > 0 && (
            <>
              <span className="tabs-divider" role="separator" />
              <ToolsMenu tools={tools} onBrief={() => setBriefOpen(true)} />
              <kbd className="key-hint" data-for="views" aria-hidden="true">{tools.map((v) => viewKeyLabel(v.key, isMac)).join(' ')}</kbd>
            </>
          )}
        </ViewTabs>
        <AssistantToggle />
      </div>
      <span className="nav-divider" role="separator" aria-orientation="vertical" />
      <BriefDialog open={briefOpen} onClose={() => setBriefOpen(false)} />
    </>
  )
}
