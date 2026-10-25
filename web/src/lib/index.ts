// The UI library shared by the standalone shell (src/app) and the desktop shell.
// Import styles separately: lib/styles/{fonts,tokens,base,app}.css.

// views
export { Overview } from './views/Overview'
export { Statements } from './views/Statements'
export { Waits } from './views/Waits'
export { Timeline } from './views/Timeline'
export { Sessions } from './views/Sessions'
export { Pivot } from './views/Pivot'
export { Compare } from './views/Compare'
export { EventDetail } from './views/EventDetail'
export { Findings } from './views/Findings'
export { Lines } from './views/Lines'

// components
export { ResizeHandle } from './components/ResizeHandle'
export { Minimap } from './components/Minimap'

// state: one store per open trace, provided through the context
export { createStore, scopeOf, callFilter, waitFilter } from './state/store'
export type { Store, Actions, State, View, Side, Selection, TimeWindow, Scope, Bookmark, LinesView } from './state/store'
export {
  SessionContext, SessionProvider, createSession, useSession, useStore, useStoreApi, useActions, useClient,
} from './state/session'
export type { Session } from './state/session'
export { usePersisted } from './state/persist'

// data
export { createClient, joinUrl } from './data/client'
export type { ApiClient } from './data/client'
export { TraceDoc } from './data/doc'
export { fromRaw, loadInitial, loadFile } from './data/load'
export type { Loaded, CompareData, Source } from './data/load'
export { probeLines, fetchLines, LINES_PAGE } from './data/lines'
export type { LinePage } from './data/lines'
// the Lines view's endpoints (api/lines?annot=1, lines/at, at, search)
export { probeLinesApi, fetchLinesAnnot, lineAt, objectsAt, search, parseJump, ANNOT_PAGE } from './data/lines'
export type { LineKind, AnnotPage, AtObjects, SearchQuery, SearchHit, SearchEnd } from './data/lines'
export { PageCache } from './data/linecache'
export { sourceOf, attachRemote, LocalSource, RemoteSource, useSourceQuery } from './data/source'
export type { DataSource, QueryState, StmtMarks } from './data/source'
export { traceSegmentsFrom } from './data/derive'
export { fmtInt, fmtCompact, fmtDur, fmtSecs, fmtMs, fmtPct, fmtBytes, fmtWall, fmtTz, preview, oraErr } from './data/format'
export type * from './data/types'
