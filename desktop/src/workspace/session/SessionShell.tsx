// The standalone shell's layout (engine/web/src/app/App.tsx, the reference consumer of the same hooks) inside one tab's
// SessionProvider; the panes, Esc and the view keys come from the lib's shell module (engine/web/src/lib/shell).
import { useEffect, useRef, type ReactNode } from 'react'
import {
  useStore, useStoreApi, FilesPane, FilterBar, Inspector, LineDrawer, PaneToggle, ResizeHandle,
  currentView, inTextField, isMac, useEscapeChain, useShellPanes, useViewKeys,
} from '@lib'
import { usePaneBridge } from './paneBridge'
import { sessionViews } from './views'
import { navHistoryOf } from './navHistory'
import type { Panes, PanesPatch } from '../panes'

/**
 * One session's views: filter row, the banner slot, the current view, the inspector and the line drawer. (The trace's popover and
 * the view tabs are in the frame's top row: TabStrip.tsx, TabTrace.tsx, SessionNav.tsx.) The assistant chord and Back / Forward
 * keys live here; the Files panel per view, the details pane, Esc and the view chords are the lib's (`useShellPanes`,
 * `useEscapeChain`, `useViewKeys`).
 * `banner` sits in its slot above the body.
 * `panes` is the tab's saved pane state (open or collapsed, widths) and `onPanes` records a change of it.
 */
export function SessionShell({ banner, panes, onPanes }: { banner?: ReactNode; panes?: Panes; onPanes: (patch: PanesPatch) => void }) {
  const store = useStoreApi()
  const state = useStore((s) => s)
  const doc = state.doc
  const lines = state.lineViewer !== null
  // collapsed, the details pane stays collapsed for the next event too (kept per tab); its tab is there while an event is selected
  const shell = useShellPanes({ inspectorOpen: panes?.inspectorOpen ?? true, inspectorW: panes?.inspectorW, filesW: panes?.filesW })
  usePaneBridge(shell.body, { contextOpen: panes?.contextOpen }, onPanes)
  useEscapeChain()
  useViewKeys(store, sessionViews)

  // ⌘J (Ctrl+J elsewhere) opens and closes the assistant beside the views, from a text field too. In the capture phase, so the
  // views' own `j` (the next statement) never sees it.
  const assistantOpen = useRef(!!panes?.assistantOpen)
  assistantOpen.current = !!panes?.assistantOpen
  const setPanes = useRef(onPanes)
  setPanes.current = onPanes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.repeat || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'j') return
      if (!(isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) return
      e.preventDefault()
      e.stopPropagation()
      setPanes.current({ assistantOpen: !assistantOpen.current })
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // Back / Forward: ⌘[ ⌘] (macOS), Alt+← Alt+→, the mouse's back and forward buttons; this shell is only mounted for the visible tab
  useEffect(() => {
    const nav = navHistoryOf(store)
    const onKey = (e: KeyboardEvent) => {
      if (inTextField(e.target)) return
      if (e.shiftKey) return
      let dir = 0
      if (isMac && e.metaKey && !e.altKey && !e.ctrlKey) dir = e.key === '[' ? -1 : e.key === ']' ? 1 : 0
      else if (e.altKey && !e.metaKey && !e.ctrlKey) dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0
      if (!dir) return
      e.preventDefault()
      if (dir < 0) nav.back(); else nav.forward()
    }
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return
      e.preventDefault()
      if (e.button === 3) nav.back(); else nav.forward()
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mouseup', onMouse)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mouseup', onMouse)
    }
  }, [store])

  if (!doc) return null
  const current = currentView(sessionViews, doc, state)
  return (
    <div className={'shell' + shell.shellClass + (lines ? ' has-lines' : '')}>
      <FilterBar doc={doc} />
      <div className="banner-slot">{banner}</div>
      <div className="body" ref={shell.body} style={shell.bodyStyle}>
        <FilesPane doc={doc} onWidth={(w) => onPanes({ filesW: w ?? undefined })} />
        <main className={'main' + (current.full ? ' full' : '')}>{current.render(doc, state)}</main>
        {shell.inspectorOpen && <Inspector doc={doc} />}
        {shell.inspectorOpen && <ResizeHandle anchor="end" className="resizer-inspector" label="Resize details pane" onChange={(w) => onPanes({ inspectorW: w ?? undefined })} />}
        {shell.eventView && <PaneToggle open={shell.inspectorOpen} onToggle={() => onPanes({ inspectorOpen: !shell.inspectorOpen })} label="details pane" className="inspector-toggle" />}
      </div>
      {lines && <LineDrawer />}
    </div>
  )
}
