import type { TraceDoc } from '../data/doc'
import type { CompareData } from '../data/load'
import type { ID } from '../data/types'
import type { Fact } from '../data/pivot'
import type { Annotation } from '../data/annotations'
import { pivotConfigOf, resolvePivotConfig, type PivotConfig } from '../data/pivotconfig'
import { contextsWithin, effectiveContexts, normalizeFiles } from '../data/fileset'

export type View = 'overview' | 'statements' | 'waits' | 'timeline' | 'sessions' | 'pivot' | 'events' | 'raw' | 'lines' | 'compare'
  | 'annotations' | 'reports' // desktop shell views

export interface TimeWindow { startTim: number; endTim: number }

export type Side = 'a' | 'b'

export interface Selection {
  stmt: ID | null
  event: ID | null
  call: ID | null
  exec: { cursor: ID; execNo: number } | null
}

/** A bookmarked trace line (kept in the store; the desktop shell persists them as annotations). */
export interface Bookmark {
  file: number; line: number; label: string
  /** a note on the line (an annotation of kind `line`) and when it was last edited (ms since the epoch) */
  note?: string; updated?: number
}

/** The Pivot view's configuration (the scope is the store's window, contexts and idle flag). */
export interface PivotState {
  fact: Fact
  /** one or two dimension ids */
  by: string[]
  /** measure id the rows are sorted by, per fact */
  sort: Record<Fact, string>
  limit: number
  /** only the rows of this statement / (waits) event */
  stmt: ID | null
  event: ID | null
  /** shown above the table: what an applied saved configuration could not resolve */
  notice: string | null
}

/** The Lines view's position: `seq` changes when something outside asks it to move to `line` (a deep link, a jump), clicks inside only update `line`. */
export interface LinesView { file: number; line: number; seq: number }

export interface State {
  /** the document the views show: with `compare`, the active side */
  doc: TraceDoc | null
  /** both traces of a comparison (`-compare`); null for a single trace */
  compare: CompareData | null
  side: Side
  loading: boolean
  error: string | null
  view: View
  selection: Selection
  window: TimeWindow | null
  contexts: Set<ID> | null // explicit context selection (Sessions view); null = all
  /** input files whose traces the views show (Files panel); null = all. The server filter is `scopeOf(state).contexts`. */
  files: Set<number> | null
  /** the Files panel is open (null = the default: open for a document of several files) */
  filesOpen: boolean | null
  includeIdle: boolean
  inclusive: boolean // call statistics: inclusive of recursive children (true) or self (false)
  theme: 'auto' | 'light' | 'dark'
  /** `mtkprof serve` is answering GET /api/lines (the standalone HTML has no server). */
  linesAvailable: boolean
  /** Raw trace line viewer: `target` is highlighted, `center` is the middle of the page shown. */
  lineViewer: { target: number; center: number; file: number } | null
  /** the engine / `serve -spill` answers the Lines view's endpoints (api/at probed once) */
  linesApi: boolean
  /** where "show in trace" (`LineRef`) opens: the bottom drawer, or (desktop shell) the Lines tab */
  lineRefTarget: 'drawer' | 'view'
  linesView: LinesView
  bookmarks: Bookmark[]
  /** notes on statements, executions and time windows (lines: `bookmarks`); kept for the page lifetime unless a shell persists them */
  annotations: Annotation[]
  /** show the add-note affordances (the desktop shell persists the notes) */
  annotationsEnabled: boolean
  /** show the Pivot view's "Saved" menu (the desktop shell provides `Session.library`) */
  libraryEnabled: boolean
  pivot: PivotState
}

const initial: State = {
  doc: null, compare: null, side: 'a', loading: true, error: null, view: 'overview',
  selection: { stmt: null, event: null, call: null, exec: null },
  window: null, contexts: null, files: null, filesOpen: null, includeIdle: true, inclusive: false, theme: 'auto',
  linesAvailable: false, lineViewer: null,
  linesApi: false, lineRefTarget: 'drawer', linesView: { file: 0, line: 1, seq: 0 }, bookmarks: [],
  annotations: [], annotationsEnabled: false, libraryEnabled: false,
  pivot: { fact: 'calls', by: ['stmt'], sort: { calls: 'e', waits: 'ela' }, limit: 1000, stmt: null, event: null, notice: null },
}

/** The statement of the other side that matches `stmt` of side `from` (via the Go diff), else null. */
function counterpart(c: CompareData, from: Side, stmt: ID | null): ID | null {
  if (stmt === null) return null
  const to: Side = from === 'a' ? 'b' : 'a'
  for (const d of c.diff.statements) if (d[from]?.id === stmt) return d[to]?.id ?? null
  return null
}

export type Actions = ReturnType<typeof makeActions>
export interface Store {
  getState(): State
  setState(patch: Partial<State> | ((s: State) => Partial<State>)): void
  subscribe(l: () => void): () => void
  /** Opens a loaded document (a comparison starts on side A). */
  setLoaded(l: { doc: TraceDoc; compare: CompareData | null }): void
  /** The Pivot view's configuration with stable keys (to save it). */
  /** `clock`: also record the window as wall-clock times (applies by time of day to another trace); `files`: also the Files panel's selection, by file name */
  getPivotConfig(opts?: { clock?: boolean; files?: boolean }): PivotConfig
  /** Shows a saved configuration in the Pivot view; returns the parts the document does not have (also shown as a notice). */
  applyPivotConfig(cfg: PivotConfig): { dropped: string[] }
  actions: Actions
}

/** One store per open trace: the standalone app creates one, the desktop shell one per session tab. */
export function createStore(): Store {
  let state: State = initial
  const listeners = new Set<() => void>()
  const getState = () => state
  const setState: Store['setState'] = (patch) => {
    const p = typeof patch === 'function' ? patch(state) : patch
    state = { ...state, ...p }
    for (const l of listeners) l()
  }
  const subscribe: Store['subscribe'] = (l) => { listeners.add(l); return () => listeners.delete(l) }
  const setLoaded: Store['setLoaded'] = (l) => {
    setState({ doc: l.doc, compare: l.compare, side: 'a', view: 'overview', files: null, loading: false, error: null, bookmarks: [], annotations: [], linesView: { file: 0, line: 1, seq: 0 } })
  }
  const getPivotConfig = (opts?: { clock?: boolean; files?: boolean }) => pivotConfigOf(state, opts)
  const applyPivotConfig = (cfg: PivotConfig) => {
    if (!state.doc) return { dropped: ['no document'] }
    const r = resolvePivotConfig(state.doc, cfg, state.pivot, state.files)
    setState(r.patch)
    return { dropped: r.dropped }
  }
  return { getState, setState, subscribe, setLoaded, getPivotConfig, applyPivotConfig, actions: makeActions(setState) }
}

function makeActions(setState: Store['setState']) {
  return {
    setView(view: View) { setState({ view }) },
    /** Select a statement; selecting one opens it in the Statements workbench. */
    selectStmt(stmt: ID | null) { setState((s) => ({ view: stmt === null ? s.view : 'statements', selection: { ...s.selection, stmt, event: stmt === null ? s.selection.event : null, call: null, exec: null } })) },
    /** Select a statement without leaving the current view (list navigation inside the workbench). */
    pickStmt(stmt: ID) { setState((s) => ({ selection: { ...s.selection, stmt, event: null, call: null, exec: null } })) },
    selectEvent(event: ID | null) { setState((s) => ({ selection: { ...s.selection, event } })) }, // keeps the statement: the Statements view re-picks one when it is null, which closed the inspector at once
    selectExec(exec: Selection['exec']) { setState((s) => ({ selection: { ...s.selection, exec } })) },
    /** Switch the document the views show between the two traces of a comparison; the selected statement follows by sql_id. */
    setSide(side: Side) {
      setState((s) => {
        if (!s.compare || s.side === side) return {}
        return { side, doc: s.compare[side], window: null, contexts: null, files: null, lineViewer: null, bookmarks: [], selection: { stmt: counterpart(s.compare, s.side, s.selection.stmt), event: null, call: null, exec: null } }
      })
    },
    /** Open a statement of side `side` in the Statements workbench. */
    openStmtOn(side: Side, stmt: ID) {
      setState((s) => {
        if (!s.compare) return { view: 'statements', selection: { stmt, event: null, call: null, exec: null } }
        return { side, doc: s.compare[side], view: 'statements', window: null, contexts: null, files: null, lineViewer: null, selection: { stmt, event: null, call: null, exec: null } }
      })
    },
    setWindow(window: TimeWindow | null) { setState({ window }) },
    setContexts(contexts: Set<ID> | null) { setState({ contexts }) },
    setFilesOpen(filesOpen: boolean) { setState({ filesOpen }) },
    /**
     * Show only the traces of these input files (null = all; a set holding every file is the same as null). A context selection
     * outside the files is dropped. An empty set shows nothing.
     */
    setFiles(files: Set<number> | null) {
      setState((s) => {
        const f = normalizeFiles(s.doc, files)
        return { files: f, contexts: contextsWithin(s.doc, s.contexts, f) }
      })
    },
    toggleIdle() { setState((s) => ({ includeIdle: !s.includeIdle })) },
    setInclusive(inclusive: boolean) { setState({ inclusive }) },
    openLines(line: number, file = 0) { setState({ lineViewer: { target: line, center: line, file } }) },
    pageLines(center: number) { setState((s) => (s.lineViewer ? { lineViewer: { ...s.lineViewer, center: Math.max(1, center) } } : {})) },
    closeLines() { setState({ lineViewer: null }) },
    /** Open the Lines view at a line of an input file (the object there is resolved and highlighted by the view). */
    openLinesAt(file: number, line: number) {
      setState((s) => ({ view: 'lines', lineViewer: null, linesView: { file, line: Math.max(1, line), seq: s.linesView.seq + 1 } }))
    },
    /** The line selected in the Lines view (no scrolling). */
    setLinesLine(file: number, line: number) { setState((s) => ({ linesView: { file, line, seq: s.linesView.seq } })) },
    /** Add a bookmark (or relabel the one on that line). */
    addBookmark(file: number, line: number, label: string) {
      setState((s) => {
        const old = s.bookmarks.find((b) => b.file === file && b.line === line)
        const b: Bookmark = old?.note ? { ...old, label } : { file, line, label }
        return { bookmarks: [...s.bookmarks.filter((x) => x !== old), b].sort((a, b) => a.file - b.file || a.line - b.line) }
      })
    },
    /** Set the note of a line's bookmark (bookmarking the line with `label` if it is not); an empty note removes the note, not the bookmark. */
    setBookmarkNote(file: number, line: number, note: string, label = '') {
      setState((s) => {
        const old = s.bookmarks.find((b) => b.file === file && b.line === line)
        const b: Bookmark = { file, line, label: old?.label ?? label, updated: Date.now() }
        if (note) b.note = note
        return { bookmarks: [...s.bookmarks.filter((x) => x !== old), b].sort((a, b) => a.file - b.file || a.line - b.line) }
      })
    },
    removeBookmark(file: number, line: number) { setState((s) => ({ bookmarks: s.bookmarks.filter((b) => b.file !== file || b.line !== line) })) },
    setBookmarks(bookmarks: Bookmark[]) { setState({ bookmarks }) },
    setAnnotations(annotations: Annotation[]) { setState({ annotations }) },
    /** Add a note (an existing id is replaced). */
    addAnnotation(a: Annotation) { setState((s) => ({ annotations: [...s.annotations.filter((x) => x.id !== a.id), a] })) },
    /** Edit a note; `updated` becomes now. */
    updateAnnotation(id: string, patch: Partial<Omit<Annotation, 'id' | 'kind' | 'created'>>) {
      setState((s) => ({ annotations: s.annotations.map((a) => (a.id === id ? { ...a, ...patch, updated: Math.max(Date.now(), a.updated + 1) } : a)) }))
    },
    removeAnnotation(id: string) { setState((s) => ({ annotations: s.annotations.filter((a) => a.id !== id) })) },
    /** Change the Pivot view's configuration (clears an applied configuration's notice). */
    setPivot(patch: Partial<PivotState>) { setState((s) => ({ pivot: { ...s.pivot, notice: null, ...patch } })) },
    setTheme(theme: State['theme']) {
      setState({ theme })
      const root = document.documentElement
      if (theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', theme)
    },
  }
}
/**
 * What narrows the fact rows: the time window, the session contexts and (waits) the idle toggle. `contexts` is the effective
 * context filter (explicit selection and the contexts of the selected `files`, see `effectiveContexts`), so every consumer
 * that filters or queries by contexts follows the file selection; `files` is carried for the views that show it.
 */
export interface Scope { window: TimeWindow | null; files: Set<number> | null; contexts: Set<ID> | null; includeIdle: boolean }

let lastEffective: { doc: TraceDoc | null; files: Set<number> | null; contexts: Set<ID> | null; out: Set<ID> | null } | null = null

export function scopeOf(s: Pick<State, 'doc' | 'window' | 'files' | 'contexts' | 'includeIdle'>): Scope {
  // memoised on identity: the same state gives the same Set (views key effects on it)
  const m = lastEffective
  let contexts: Set<ID> | null
  if (m && m.doc === s.doc && m.files === s.files && m.contexts === s.contexts) contexts = m.out
  else {
    contexts = effectiveContexts(s.doc, s.files, s.contexts)
    lastEffective = { doc: s.doc, files: s.files, contexts: s.contexts, out: contexts }
  }
  return { window: s.window, files: s.files, contexts, includeIdle: s.includeIdle }
}

/** The scope narrows the fact rows to less than the whole trace (a time window, or contexts: a selection of sessions or of files). */
export const scopeNarrows = (sc: Pick<Scope, 'window' | 'contexts'>): boolean => !!(sc.window || sc.contexts)

/** Row predicate for the current filters (time window + context). */
export function callFilter(s: Pick<State, 'doc' | 'window' | 'contexts'>): ((i: number) => boolean) | undefined {
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

export function waitFilter(s: Pick<State, 'doc' | 'window' | 'contexts' | 'includeIdle'>): ((i: number) => boolean) | undefined {
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

/** Whether the Files panel is shown: the user's choice, else open for a document of several files (none for a single file). */
export function filesPanelOpen(s: Pick<State, 'doc' | 'filesOpen'>): boolean {
  return !!s.doc?.multiFile && (s.filesOpen ?? true)
}
