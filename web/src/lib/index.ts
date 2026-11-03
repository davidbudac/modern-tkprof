// The UI library shared by the standalone shell (src/app) and the desktop shell.
// Import styles separately: lib/styles/{fonts,tokens,base,app}.css.

// views
export { Overview } from './views/Overview'
export { Statements } from './views/Statements'
export { Waits } from './views/Waits'
export { BlockMap } from './views/BlockMap'
export { Timeline } from './views/Timeline'
export { Sessions } from './views/Sessions'
export { Pivot } from './views/Pivot'
export { Compare } from './views/Compare'
export { EventDetail } from './views/EventDetail'
export { Findings } from './views/Findings'
export { Lines } from './views/Lines'
export { FilesPanel, FilesPane, FilesToggle } from './views/FilesPanel'

// components
export { FileStatus } from './components/FileStatus'
export { ResizeHandle } from './components/ResizeHandle'
export { PaneToggle } from './components/PaneToggle'
export { Minimap } from './components/Minimap'
export { LiveBadge } from './components/LiveBadge'
export { WindowBar } from './components/WindowBar'
export { ResponseMini, responseSummary, useScopeResponse, type ResponseSummary } from './components/ResponseMini'
export { FilterBar } from './components/FilterBar'

// the shell both front ends share (the standalone's src/app and the desktop's session shell): the view table and its
// tabs and chords, the side panes, the Esc chain, the details pane, the URL hash, the views' error boundary
export { baseViews, shownViews, currentView, type SessionViewDef } from './shell/views'
export { ViewTabs } from './shell/ViewTabs'
export { viewKeyOf, viewOfKey, viewKeyLabel, viewKeyAria, digitOf, inTextField, useViewKeys } from './shell/viewKeys'
export type { KeyLike, ViewKeyAction } from './shell/viewKeys'
export { isMac, macPlatform } from './shell/platform'
export { showsInspector, filesDefaultOpen, FilesChoices, filesChoicesOf } from './shell/viewPanes'
export { MIN_VIEW_REM, filesNeedRoom, lengthVar, markFilesFolded, filesFolded, shellFilesWrite, inShellFilesWrite } from './shell/filesRoom'
export { useShellPanes, useEscapeChain } from './shell/panes'
export type { ShellPanes, ShellPanesInput } from './shell/panes'
export { Inspector } from './shell/Inspector'
export { hashOf, apply, unresolved, startUrlSync } from './shell/urlstate'
export { ViewErrorBoundary, errorDetails } from './shell/ViewErrorBoundary'

// state: one store per open trace, provided through the context
export { createStore, carryOver, scopeOf, scopeNarrows, callFilter, waitFilter, filesPanelOpen, activeBlock } from './state/store'
export type { Store, Actions, State, View, Side, Selection, TimeWindow, LaneBlock, Scope, Bookmark, LinesView, PivotState, LiveStatus } from './state/store'
export {
  SessionContext, SessionProvider, createSession, useSession, useStore, useStoreApi, useActions, useClient, useLibrary,
} from './state/session'
export type { Session, PivotLibrary } from './state/session'
export { usePersisted } from './state/persist'

// data
export { createClient, joinUrl } from './data/client'
export type { ApiClient } from './data/client'
export { TraceDoc } from './data/doc'
export { fromRaw, loadInitial, loadFile } from './data/load'
// a live session: the document follows the server's snapshots (api/doc?rev= long poll)
export { followLive, LIVE_BACKOFF_MS } from './data/live'
export type { LiveFollow, LiveOptions } from './data/live'
export type { Loaded, CompareData, Source } from './data/load'
export { probeLines, fetchLines, LINES_PAGE } from './data/lines'
export type { LinePage } from './data/lines'
// the Lines view's endpoints (api/lines?annot=1, lines/at, at, search)
export { probeLinesApi, fetchLinesAnnot, lineAt, objectsAt, search, parseJump, ANNOT_PAGE } from './data/lines'
export type { LineKind, AnnotPage, AtObjects, SearchQuery, SearchHit, SearchEnd } from './data/lines'
// the global filters in force, as the chips of the filter row
export { activeFilters } from './data/filters'
export type { ActiveFilter, FilterKind, FilterState } from './data/filters'
// a time window as lines of the input files
export { windowFiles, windowLineRange, windowStartLine, fileInWindow } from './data/windowlines'
export type { LineRange } from './data/windowlines'
export { PageCache } from './data/linecache'
// the bottom drawer with the raw trace lines around a line (both shells mount it)
export { LineDrawer } from './components/LineDrawer'
// the Overview lanes' zoomed axis
export { zoomedAxis } from './data/scale'
export { sourceOf, attachRemote, LocalSource, RemoteSource, useSourceQuery } from './data/source'
export type { DataSource, QueryState, StmtMarks } from './data/source'
export { traceSegmentsFrom } from './data/derive'
export { responseOf, scopeResponse, type ScopeResponse } from './data/response'
export { ctxKey, fileHeading, selectionInfo, effectiveContexts, contextsWithin, contextsOfFiles, fileTree, normalizeFiles, formatFilesParam, parseFilesParam } from './data/fileset'
export { useScopedStatements } from './data/scopedstmts'
export type { ScopedStatements } from './data/scopedstmts'
export { fmtInt, fmtCompact, fmtDur, fmtSecs, fmtMs, fmtPct, fmtBytes, fmtWall, fmtTz, preview, oraErr } from './data/format'
export type * from './data/types'
// annotations (notes on statements, executions, windows, lines) and saved Pivot configurations
export {
  textHash, stmtRef, resolveStmt, resolveExec, stmtNote, execNotes, execKey, makeAnnotation, newAnnotationId, bookmarkToAnnotation, annotationToBookmark,
  mergeAnnotations, mergeBookmarks, annotationsFile, parseAnnotationsFile, annotationsMarkdown,
} from './data/annotations'
export type { Annotation, AnnotationKind, StmtRef, AnnotationsFile, MarkdownOptions } from './data/annotations'
export { pivotConfigOf, resolvePivotConfig, libraryFile, parseLibraryFile, mergeLibrary, describePivotConfig } from './data/pivotconfig'
export type { PivotConfig, ContextKey, SavedPivot, LibraryFile } from './data/pivotconfig'
export { NoteEditor, NoteBox } from './components/Note'
