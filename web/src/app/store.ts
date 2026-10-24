import { useSyncExternalStore } from 'react'
import type { TraceDoc } from '../data/doc'
import type { ID } from '../data/types'

export type View = 'overview' | 'statements' | 'waits' | 'timeline' | 'sessions' | 'pivot' | 'events' | 'raw'

export interface TimeWindow { startTim: number; endTim: number }

export interface Selection {
  stmt: ID | null
  event: ID | null
  call: ID | null
  exec: { cursor: ID; execNo: number } | null
}

export interface State {
  doc: TraceDoc | null
  loading: boolean
  error: string | null
  view: View
  selection: Selection
  window: TimeWindow | null
  contexts: Set<ID> | null // context filter; null = all
  includeIdle: boolean
  inclusive: boolean // call statistics: inclusive of recursive children (true) or self (false)
  theme: 'auto' | 'light' | 'dark'
  /** `mtkprof serve` is answering GET /api/lines (the standalone HTML has no server). */
  linesAvailable: boolean
  /** Raw trace line viewer: `target` is highlighted, `center` is the middle of the page shown. */
  lineViewer: { target: number; center: number } | null
}

const initial: State = {
  doc: null, loading: true, error: null, view: 'overview',
  selection: { stmt: null, event: null, call: null, exec: null },
  window: null, contexts: null, includeIdle: true, inclusive: false, theme: 'auto',
  linesAvailable: false, lineViewer: null,
}

let state: State = initial
const listeners = new Set<() => void>()

export function getState(): State { return state }
export function setState(patch: Partial<State> | ((s: State) => Partial<State>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch
  state = { ...state, ...p }
  for (const l of listeners) l()
}
function subscribe(l: () => void): () => void { listeners.add(l); return () => listeners.delete(l) }
export const subscribeStore = subscribe

export function useStore<T>(selector: (s: State) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state))
}

export const actions = {
  setView(view: View) { setState({ view }) },
  /** Select a statement; selecting one opens it in the Statements workbench. */
  selectStmt(stmt: ID | null) { setState((s) => ({ view: stmt === null ? s.view : 'statements', selection: { ...s.selection, stmt, event: stmt === null ? s.selection.event : null, call: null, exec: null } })) },
  /** Select a statement without leaving the current view (list navigation inside the workbench). */
  pickStmt(stmt: ID) { setState((s) => ({ selection: { ...s.selection, stmt, event: null, call: null, exec: null } })) },
  selectEvent(event: ID | null) { setState((s) => ({ selection: { ...s.selection, event } })) }, // keeps the statement: the Statements view re-picks one when it is null, which closed the inspector at once
  selectExec(exec: Selection['exec']) { setState((s) => ({ selection: { ...s.selection, exec } })) },
  setWindow(window: TimeWindow | null) { setState({ window }) },
  setContexts(contexts: Set<ID> | null) { setState({ contexts }) },
  toggleIdle() { setState((s) => ({ includeIdle: !s.includeIdle })) },
  setInclusive(inclusive: boolean) { setState({ inclusive }) },
  openLines(line: number) { setState({ lineViewer: { target: line, center: line } }) },
  pageLines(center: number) { setState((s) => (s.lineViewer ? { lineViewer: { ...s.lineViewer, center: Math.max(1, center) } } : {})) },
  closeLines() { setState({ lineViewer: null }) },
  setTheme(theme: State['theme']) {
    setState({ theme })
    const root = document.documentElement
    if (theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme)
  },
}

/** Row predicate for the current filters (time window + context). */
export function callFilter(s: State): ((i: number) => boolean) | undefined {
  const d = s.doc
  if (!d || (!s.window && !s.contexts)) return undefined
  const { tim, e, ctx } = d.calls
  const w = s.window, c = s.contexts
  return (i) => {
    if (w && (tim[i] - e[i] > w.endTim || tim[i] < w.startTim)) return false
    if (c && !c.has(ctx[i])) return false
    return true
  }
}

export function waitFilter(s: State): ((i: number) => boolean) | undefined {
  const d = s.doc
  if (!d || (!s.window && !s.contexts && s.includeIdle)) return undefined
  const { tim, ela, ctx, flags } = d.waits
  const w = s.window, c = s.contexts, idle = s.includeIdle
  return (i) => {
    if (!idle && flags[i] & 2) return false
    if (w && (tim[i] - ela[i] > w.endTim || tim[i] < w.startTim)) return false
    if (c && !c.has(ctx[i])) return false
    return true
  }
}
