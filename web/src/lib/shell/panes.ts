// The side panes of a shell's body (Files panel, view, details pane) and the Esc chain over them; shared by the standalone
// shell (web/src/app/App.tsx) and the desktop's SessionShell, so the two cannot drift apart.
import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'
import { filesPanelOpen } from '../state/store'
import { useActions, useStore, useStoreApi } from '../state/session'
import { filesNeedRoom, inShellFilesWrite, lengthVar, markFilesFolded, shellFilesWrite } from './filesRoom'
import { filesChoicesOf, showsInspector } from './viewPanes'

export interface ShellPanesInput {
  /** the details pane's own open flag: false = collapsed by the user (for the next event too); default open */
  inspectorOpen?: boolean
  /** the dragged widths in px; absent = the CSS default */
  inspectorW?: number | null
  filesW?: number | null
}

export interface ShellPanes {
  /** to put on the `.body` element: the fold measures it */
  body: RefObject<HTMLDivElement | null>
  /** the `.body` element's width custom properties */
  bodyStyle: CSSProperties
  /** the Files panel is open (a multi-file trace whose panel is not folded) */
  filesOpen: boolean
  /** an event is selected in a view that shows the details pane: its PaneToggle is there */
  eventView: boolean
  /** the details pane is on screen */
  inspectorOpen: boolean
  /** ` has-files`, ` has-inspector` for the `.shell` element */
  shellClass: string
}

/**
 * The body's panes inside a SessionProvider:
 * - the details pane only on the views about wait events (`showsInspector`), when an event is selected and the pane is not collapsed;
 * - the Files panel per view: open in Overview, Timeline, Sessions and Lines, folded in the others (viewPanes.ts); the user's own
 *   open/close of it wins for that view as long as the store lives. The shell's own writes (this default, the fold below) are not choices;
 * - Files panel, view and details pane side by side need room: when the body is too narrow for all three, the Files panel folds away
 *   while the pane is open (the same store flag as the "▤ N files" chip) and comes back when the pane closes or the window grows,
 *   and on unmount (the store never keeps the shell's fold).
 */
export function useShellPanes({ inspectorOpen: inspectorPref = true, inspectorW, filesW }: ShellPanesInput): ShellPanes {
  const store = useStoreApi()
  const actions = useActions()
  const view = useStore((s) => s.view)
  const event = useStore((s) => s.selection.event)
  const filesOpen = useStore((s) => filesPanelOpen(s))
  const hasDoc = useStore((s) => s.doc !== null)
  const body = useRef<HTMLDivElement>(null)
  // the selection stays in the store, so the pane is back on return to Waits or Timeline
  const eventView = event !== null && showsInspector(view)
  const inspectorOpen = eventView && inspectorPref

  useEffect(() => {
    const choices = filesChoicesOf(store, view, store.getState().filesOpen)
    const want = choices.wanted(view)
    if ((store.getState().filesOpen ?? true) !== want) shellFilesWrite(store, () => actions.setFilesOpen(want))
  }, [store, actions, view])
  useEffect(() => {
    let prev = store.getState().filesOpen
    return store.subscribe(() => {
      const s = store.getState()
      if (s.filesOpen === prev) return
      prev = s.filesOpen
      if (s.filesOpen !== null && !inShellFilesWrite(store)) filesChoicesOf(store, s.view, null).record(s.view, s.filesOpen)
    })
  }, [store])

  const [tight, setTight] = useState(false)
  const folded = useRef(false) // the shell closed the panel; a user who opens it again meanwhile takes it over
  useEffect(() => {
    const host = body.current
    if (!host) return
    const stacked = window.matchMedia('(width < 64rem)') // the lib stacks the panes below this (styles/app.css)
    const measure = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize)
      setTight(filesNeedRoom(host.clientWidth, lengthVar(host, '--files-w'), lengthVar(host, '--inspector-w'), rem, stacked.matches))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    stacked.addEventListener('change', measure)
    measure()
    return () => {
      ro.disconnect()
      stacked.removeEventListener('change', measure)
    }
  }, [hasDoc, filesW, inspectorW])
  useEffect(() => {
    const fold = inspectorOpen && tight
    if (fold && filesOpen && !folded.current) {
      folded.current = true
      markFilesFolded(store, true) // before the write: a shell that saves the flag must not take this `false` for the user's choice
      shellFilesWrite(store, () => actions.setFilesOpen(false))
    } else if (folded.current && (!fold || filesOpen)) {
      folded.current = false
      markFilesFolded(store, false)
      // back to what the view wants (a folded-by-default view stays folded)
      if (!filesOpen && filesChoicesOf(store, view, null).wanted(view)) shellFilesWrite(store, () => actions.setFilesOpen(true))
    }
  }, [store, actions, view, inspectorOpen, tight, filesOpen])
  // leaving (the desktop's other tab, a closed tab) puts the panel back, so the store never keeps the shell's choice
  useEffect(() => () => {
    if (!folded.current) return
    folded.current = false
    markFilesFolded(store, false)
    const v = store.getState().view
    shellFilesWrite(store, () => actions.setFilesOpen(filesChoicesOf(store, v, null).wanted(v)))
  }, [store, actions])

  const bodyStyle = { ...(inspectorW ? { '--inspector-w': `${inspectorW}px` } : null), ...(filesW ? { '--files-w': `${filesW}px` } : null) } as CSSProperties
  return { body, bodyStyle, filesOpen, eventView, inspectorOpen, shellClass: (filesOpen ? ' has-files' : '') + (inspectorOpen ? ' has-inspector' : '') }
}

/** Esc closes the line viewer first, then the details pane (on a view that shows it), then clears the time window. */
export function useEscapeChain(): void {
  const store = useStoreApi()
  const actions = useActions()
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const s = store.getState()
      if (s.lineViewer) actions.closeLines()
      else if (s.selection.event !== null && showsInspector(s.view)) actions.selectEvent(null)
      else if (s.window) actions.setWindow(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store, actions])
}
