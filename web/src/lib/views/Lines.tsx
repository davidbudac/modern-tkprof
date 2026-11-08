import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import type { TraceDoc } from '../data/doc'
import { LINE_KINDS, PageCache, type CachedPage } from '../data/linecache'
import { blockAt, composeFilterFolds, filterFolds, foldAt, foldHiding, indexFolds, standingFolds, startsBlock, toggleFold, type Fold } from '../data/folds'
import { ALL_SCOPE, PROFILE_BUCKETS, cursorLine, fetchDelta, fetchHot, fetchStmtBins, fetchStmtRuns, fetchStmtUnion, firstAbove, hotStep, fetchLinesAnnot, fetchRepeats, lineAt, linePermalink, linesBlocks, bindFolds, frameFolds, INLINE_BINDS, mergeFolds, nextLine, objectsAt, parseGoTo, sameSearch, search, SEARCH_PRESETS, statementsOf, stmtLineIn, type AtObjects, type NextWhat, type RecentSearch, type RepeatFold, type SearchEnd, type SearchHit, type SearchScope, type SqlBand, type StmtBins } from '../data/lines'
import { fmtCompact, fmtDur, fmtInt, fmtTz, preview } from '../data/format'
import { copyText } from '../data/clipboard'
import { describeRange, summarizeLines } from '../data/rangesum'
import { describeLines, lineCount, type LineSet } from '../data/lineset'
import { sourceOf, useSourceQuery } from '../data/source'
import { LineViewer, type ViewerApi } from '../components/LineViewer'
import { LineStrip, type StripLayer } from '../components/LineStrip'
import { LINES_PREFS_DEFAULTS, useLinesPrefs } from '../state/linesPrefs'
import { LANE_COLORS, laneLegend } from '../data/lanecolor'
import { MenuItem, ToolbarMenu } from '../components/ToolbarMenu'
import { CommandPalette, type Command } from '../components/CommandPalette'
import { inlaysOf } from '../data/inlays'
import { gapBefore } from '../data/gaps'
import { HOT_SHARE, anchorOf, lineTim, lineTimesOf, type TimeAnchor } from '../data/linetime'
import { viewSpan } from '../data/overview'
import { toneColor } from '../data/readable'
import { NO_HL, addHl, hlTones, setHl, slotTone, toggleHl, type HlSet } from '../data/hlset'
import { filterChipParts, filterChipText, hlStops, linesInRuns, runFolds, type HlStops } from '../data/stmtfilter'
import { useFileStmts } from '../data/filestmts'
import { ChevronDownIcon, ChevronUpIcon, FunnelIcon, LanesIcon, LayersIcon, RepeatIcon } from '../components/icons'
import { readableRowsOf, type Pin } from './readableRows'
import { AsRun } from './AsRun'
import { ReadableOverview } from './ReadableOverview'
import type { StmtCounts } from './StatementPicker'
import { LinesDisplay } from './LinesDisplay'
import { DELTA_MODES, MUTE_GROUPS, PANEL_TABS, SHOW_TOGGLES, deltaChipParts, displayBadge, fmtMs, panelAfter, type PanelTab } from '../data/display'
import { FormattedHead, columnVars } from '../components/FormattedHead'
import { useActions, useClient, useStore, useStoreApi } from '../state/session'
import { activeBlock, type Store } from '../state/store'
import { BookmarkList, HitList, KeyMap, PanelHead, RecentSearches } from './LinesPanel'
import { LinesOutline, type OutlineState } from './LinesOutline'
import { LinesAt, type LineAct } from './LinesAt'
import { LineInspector, type InspectRefKind } from './LineInspector'
import { ResizeHandle } from '../components/ResizeHandle'
import { bindAtOf, rememberBinds } from '../data/bindat'
import { LinePopover, type LinePopup } from '../components/LinePopover'
import { cachedAt, decodeContextOf, lineCardOf, refClickOf, refTitleOf, useLineAt } from './linesShared'
import { isSelected } from '../data/fileset'
import { fileInWindow, windowLineRange, type LineRange } from '../data/windowlines'
import { NoteEditor } from '../components/Note'
import { EXIT_MS, Shimmer, useExit } from '../components/motion'
import '../styles/lines.css'

type SearchStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error'

/** What the view keeps while another tab is shown (the component itself unmounts). One per store and input file. */
interface LinesUi {
  top: number
  seqSeen: number
  /** the statement the view last moved to the first mark of */
  jumpedFor: number | null
  q: string; regex: boolean; caseSensitive: boolean; fromHere: boolean
  hits: SearchHit[]; end: SearchEnd | null; status: SearchStatus; error: string | null
  /** what the hits were searched with (highlighting must not follow edits of the box) */
  searched: { q: string; regex: boolean; caseSensitive: boolean; scope: SearchScope }
  /** where the next search looks (a scope that is not available falls back to the file) */
  scope: SearchScope
  /** the last finished searches, newest first (chips above the hits) */
  recent: RecentSearch[]
  /** the search box's menu: match options, scope, ready-made searches */
  optionsMenu: boolean
  /** the Step menu */
  stepMenu: boolean
  /** the key map popover (under the command button) */
  keys: boolean
  /** the overview row's statement picker */
  picker: boolean
  /** the command palette */
  palette: boolean
  /** the cursor id whose rows stay bright (the others are dimmed), null for none */
  focus: number | null
  /** the highlighted statements, in the order they were added, each with its colour slot (the pane's own set, not the app's single selected statement) */
  hl: HlSet
  /** the statements the view is filtered to (only their lines are shown), none for no filter */
  filter: readonly number[]
  /** the app's selected statement as this view last saw it: a different one arrives from another view and joins the highlighted statements */
  hlSeen: number | null | undefined
  /** the lines selected with Shift+click, Shift+arrows or ⌘/Ctrl+click (summed in the status bar, `y` copies them), null for none */
  lines: LineRange[] | null
  /** the side panel's tab (whether the panel is open is the global `inspect` pref) */
  tab: PanelTab
  /** the last tab that was not Display: the side panel button opens it, as the Display button opens Display */
  lastTab: Exclude<PanelTab, 'display'>
  /** the hits listed by statement (the Hits tab), and the statements whose group is open (-1 none, -2 not loaded yet) */
  groupHits: boolean
  openGroups: Set<number>
  /** the outline tab: open nodes and filter */
  outline: OutlineState
  /** the folded blocks (BINDS, STAT dump, long SQL text), sorted by their first line */
  folds: Fold[]
  /** the lines the jumps left, newest last (capped) */
  back: number[]
  /** the selected line as this view last set it (the line a jump leaves) */
  cur: number
  /** the line Δ is measured from (readable mode, and the raw mode's delta column), null for none */
  pin: Pin | null
  /** the folds of repeats the user opened (their first lines) */
  openRepeats: Set<number>
  /** the Δ filter's folds the user opened (their kept lines), for the filter answer `key` */
  openFilter: { key: string; lines: Set<number> }
  /** the line whose execution the As run tab shows (0: the selected line) */
  asRunLine: number
}

const uis = new WeakMap<Store, Map<number, LinesUi>>()
function uiOf(store: Store, file: number): LinesUi {
  let m = uis.get(store)
  if (!m) uis.set(store, (m = new Map()))
  let u = m.get(file)
  if (!u) {
    m.set(file, (u = {
      top: 0, seqSeen: -1, jumpedFor: null, q: '', regex: false, caseSensitive: false, fromHere: false,
      hits: [], end: null, status: 'idle', error: null, searched: { q: '', regex: false, caseSensitive: false, scope: 'file' }, scope: 'file', recent: [],
      optionsMenu: false, stepMenu: false, keys: false, picker: false, palette: false, focus: null, hl: NO_HL, filter: [], hlSeen: undefined, lines: null,
      tab: 'line', lastTab: 'line', groupHits: false, openGroups: new Set(), outline: { open: new Set(), filter: '' }, folds: [], back: [], cur: 0, pin: null, openRepeats: new Set(), asRunLine: 0,
      openFilter: { key: '', lines: new Set() },
    }))
  }
  return u
}

/** The kinds the Step menu steps over (`lines/next`): what, its name in messages and the keys (next, previous). */
const STEPS: [NextWhat, string, [string, string]][] = [
  ['call', 'call', [']', '[']],
  ['wait', 'wait', ['w', 'W']],
  ['cursor', 'cursor parse', ['c', 'C']],
  ['plan', 'STAT dump', ['p', 'P']],
  ['ctx', 'session marker', ['s', 'S']],
  ['error', 'error', ['e', 'E']],
  ['commit', 'commit', ['x', 'X']],
]

/** The modifier the platform's command key is shown with. */
const MOD = typeof navigator !== 'undefined' && navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+'
const SEARCH_LIMIT = 10_000
const BACK_LIMIT = 50
const RECENT_LIMIT = 5
/** pages of annotated lines kept for the viewer and for the statements of the hits */
const CACHE_PAGES = 40
/** pages loaded at once to learn the statements of the hits in view */
const NEED_INFLIGHT = 4
/** the most pages *Copy block* loads (a block longer than this is not copied) */
const COPY_PAGES = 4
/** the view's first line is rounded down to this many lines to find the blocks that can be folded (a scroll re-renders once per step) */
const FOLD_STEP = 20
/** lines after the rounded first line that are searched for blocks that can be folded (covers a tall view) */
const FOLD_SPAN = 240

const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'
const NO_HOT: ReadonlyMap<number, number> = new Map()
const NO_FOLDS: Fold[] = []

/** A fold of repeats as the viewer shows it: its label, summary and the time it covers. */
function repeatFold(r: RepeatFold): Fold {
  const lines = `lines ${fmtInt(r.from)}–${fmtInt(r.to)}`
  let label: string, summary: string
  if (r.kind === 'run') {
    label = `${fmtInt(r.n)}×`
    summary = `${fmtInt(r.n)} × ${r.event ?? 'wait'} · max ${fmtDur(r.max)} · ${lines}`
  } else if (r.kind === 'block') {
    label = 'WAITS'
    const by = (r.by ?? []).slice(0, 3).map((b) => `${b.event} ${fmtInt(b.n)}× ${fmtDur(b.us)}`).join(', ')
    summary = `${fmtInt(r.n)} waits${by ? ` · ${by}${(r.by?.length ?? 0) > 3 ? ', …' : ''}` : ''} · ${lines}`
  } else {
    label = `FETCH×${fmtCompact(r.n)}`
    summary = `${fmtInt(r.n)} fetches · ${fmtInt(r.rows ?? 0)} rows${r.cr ? ` · ${fmtInt(r.cr)} gets` : ''}${r.p ? ` · ${fmtInt(r.p)} reads` : ''}${r.idle ? ` · ${fmtDur(r.idle)} idle between them` : ''} · max ${fmtDur(r.max)} · ${lines}`
  }
  return { from: r.from, to: r.to, summary, label, us: r.us, auto: true }
}

/** The Display button's icon: two sliders. */
const SlidersIcon = () => (
  <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" className="tb-ico"><path d="M1 3h12M1 9h12" stroke="currentColor" strokeWidth="1.2" fill="none" /><circle cx="9" cy="3" r="1.9" fill="var(--surface-raised)" stroke="currentColor" strokeWidth="1.2" /><circle cx="4.5" cy="9" r="1.9" fill="var(--surface-raised)" stroke="currentColor" strokeWidth="1.2" /></svg>
)

/** The side panel's icon: a window with a column at its end. */
const PanelIcon = () => (
  <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true" className="tb-ico"><rect x="0.5" y="0.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" /><line x1="8.5" y1="1" x2="8.5" y2="11" stroke="currentColor" /></svg>
)

/** The strip with the visible range of the viewer as its own state: a scroll re-renders this, not the whole view. */
type StripProps = Omit<Parameters<typeof LineStrip>[0], 'view'>
function StripHost({ bus, last, ...props }: StripProps & { bus: React.MutableRefObject<((top: number, rows: number) => void) | null>; last: React.MutableRefObject<{ top: number; rows: number }> }) {
  const [view, setView] = useState(last.current)
  useEffect(() => {
    bus.current = (top, rows) => setView((v) => (v.top === top && v.rows === rows ? v : { top, rows }))
    return () => { bus.current = null }
  }, [bus])
  return <LineStrip {...props} view={view} />
}

interface WindowLines { range: LineRange | null; failed: boolean }

/** The lines of input file `file` that the time window covers: null while there is no window or the lookup is on its way (a live session's next snapshot keeps the old answer until the new one arrives). */
function useWindowLines(doc: TraceDoc, file: number): WindowLines | null {
  const client = useClient()
  const win = useStore((s) => s.window)
  const rev = useStore((s) => s.rev)
  const key = win ? `${win.startTim}:${win.endTim}` : ''
  const [found, setFound] = useState<(WindowLines & { key: string }) | null>(null)
  useEffect(() => {
    if (!win) return
    const ac = new AbortController()
    windowLineRange(client, doc, file, win, ac.signal).then(
      (range) => { if (!ac.signal.aborted) setFound({ key, range, failed: false }) },
      (e: unknown) => { if (!aborted(e)) setFound({ key, range: null, failed: true }) },
    )
    return () => ac.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, doc, file, key, rev])
  return found && found.key === key ? found : null
}

/**
 * The raw trace as a full tab: every line of the input file (a virtualized viewer over pages of 2000 lines from `api/lines`),
 * coloured by line kind, with gutter marks for the selected statement, "what is at this line", text search, jump to time and bookmarks.
 * Needs the engine / `serve -spill` (the `linesApi` state, probed once).
 */
export function Lines({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const file = useStore((s) => s.linesView.file)
  const fresh = useStore((s) => s.linesView.seq === 0)
  const selected = useStore((s) => s.files)
  // the file picker follows the Files panel: a file outside the selection gives way to the first selected one when the selection
  // changes (and when the view was never moved before); a deep link or bookmark to another file is left alone
  const prev = useRef<{ files: Set<number> | null; mounted: boolean }>({ files: selected, mounted: false })
  useEffect(() => {
    const changed = prev.current.files !== selected, first = !prev.current.mounted
    prev.current = { files: selected, mounted: true }
    if (selected && selected.size > 0 && !selected.has(file) && (changed || (first && fresh))) actions.openLinesAt(Math.min(...selected), 1)
  }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps
  return <LinesOfFile key={file} doc={doc} file={file} />
}

function LinesOfFile({ doc, file }: { doc: TraceDoc; file: number }) {
  const store = useStoreApi()
  const actions = useActions()
  const client = useClient()
  const lv = useStore((s) => s.linesView)
  const stmt = useStore((s) => s.selection.stmt)
  const win = useStore((s) => s.window)
  const block = useStore(activeBlock) // a picked lane block keeps its statement selected while moving through its window
  const winLines = useWindowLines(doc, file)
  const winRange = winLines?.range ?? null
  const allBookmarks = useStore((s) => s.bookmarks)
  const notesOn = useStore((s) => s.annotationsEnabled)
  const [noting, setNoting] = useState<number | null>(null) // the line whose note is being written
  const ui = uiOf(store, file)
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const set = useCallback((patch: Partial<LinesUi>) => {
    Object.assign(ui, patch)
    if (patch.tab && patch.tab !== 'display') ui.lastTab = patch.tab
    bump()
  }, [ui])
  const [prefs, setPrefs] = useLinesPrefs() // the display toggles are global, not per file
  const muteSet = useMemo(() => new Set(prefs.mute), [prefs.mute])

  const cache = useMemo(() => new PageCache((from, n, signal) => fetchLinesAnnot(client, file, from, n, signal, true), CACHE_PAGES), [client, file])
  useEffect(() => cache.subscribe(bump), [cache])
  const [pages, setPages] = useState(0) // a page arrived: the blocks that can be folded are looked for again
  useEffect(() => cache.subscribe(() => setPages((n) => n + 1)), [cache])
  useEffect(() => () => cache.close(), [cache])
  // a live session's next snapshot: the file has more lines
  const rev = useStore((s) => s.rev)
  const shownRev = useRef(rev)
  useEffect(() => {
    if (rev === shownRev.current) return
    shownRev.current = rev
    void cache.refresh()
  }, [cache, rev])

  // the line strip's highlighted lines: one binned request per change of the highlighted statements, input file and snapshot (the strip down-samples it to its height); the old
  // answer stays until the new one arrives. Nothing highlighted: no request, the strip has only its ticks
  const hlKey = `${file}:${rev}:${ui.hl.ids.join(',')}`
  const [bins, setBins] = useState<StmtBins | null>(null)
  useEffect(() => {
    if (!prefs.strip || ui.hl.ids.length === 0) { setBins(null); return }
    const ac = new AbortController()
    fetchStmtBins(client, file, ui.hl.ids, PROFILE_BUCKETS, ac.signal).then(
      (b) => { if (!ac.signal.aborted) setBins(b) },
      (e: unknown) => { if (!aborted(e)) setBins(null) }, // an engine without the route: no highlighted lines in the strip
    )
    return () => ac.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, hlKey, prefs.strip])

  const apiRef = useRef<ViewerApi | null>(null)
  const viewBus = useRef<((top: number, rows: number) => void) | null>(null)
  const lastView = useRef({ top: 1, rows: 0 }) // what a strip that mounts later (the profile arrives after the first move) starts from
  const [foldTop, setFoldTop] = useState(0) // the first visible line rounded down: where blocks that can be folded are looked for
  // the deltas' anchor: the selected line when it is in view, else the first timed line in view; looked for again on every move
  const [anchor, setAnchor] = useState<TimeAnchor | null>(null)
  const anchorArgs = useRef({ on: prefs.delta, selected: lv.line, pin: ui.pin })
  anchorArgs.current = { on: prefs.delta, selected: lv.line, pin: ui.pin }
  const refreshAnchor = useCallback(() => {
    const { on, selected, pin } = anchorArgs.current
    const a = on ? pin ?? anchorOf(cache, lastView.current.top, lastView.current.rows, selected) : null
    setAnchor((cur) => (cur?.line === a?.line && cur?.tim === a?.tim ? cur : a))
  }, [cache])
  useEffect(refreshAnchor, [refreshAnchor, prefs.delta, lv.line, pages, ui.pin])
  const times = useMemo(() => lineTimesOf(doc, { clock: prefs.clock, delta: prefs.delta }, anchor), [doc, prefs.clock, prefs.delta, anchor])
  // the overview bar's bracket: the times of the rows in view, sent to the bar without a render
  const overviewBus = useRef<((tims: [number, number] | null) => void) | null>(null)
  const overviewView = useRef<[number, number] | null>(null)
  const sendOverview = useCallback(() => {
    const t = viewSpan(cache, lastView.current.top, lastView.current.rows)
    if (t?.[0] === overviewView.current?.[0] && t?.[1] === overviewView.current?.[1]) return
    overviewView.current = t
    overviewBus.current?.(t)
  }, [cache])
  const onViewChange = useCallback((top: number, rows: number) => {
    lastView.current = { top, rows }; viewBus.current?.(top, rows)
    refreshAnchor()
    sendOverview()
    setFoldTop(Math.floor(Math.max(0, top - 1) / FOLD_STEP) * FOLD_STEP)
  }, [refreshAnchor, sendOverview])
  useEffect(sendOverview, [sendOverview, pages]) // (a page arrived: the rows in view may have a time now)
  const topRef = useRef(ui.top)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [at, setAt] = useState<{ line: number; objs: AtObjects } | null>(null)
  const [popup, setPopup] = useState<LinePopup | null>(null) // the statement popup of a clicked reference
  const [copied, setCopied] = useState<{ msg: string; bad: boolean } | null>(null) // the status bar's note
  const copiedNote = useExit(copied, EXIT_MS.fast) // rises in, and blurs out when it times out (.flash-note)
  const selected = lv.line
  const total = cache.total

  // ---- readable mode: the hot spots, the folds of repeats, the pin ---------------------------------------------------------
  const readable = prefs.readable
  /** the traced time of this file: 1 % of it makes a hot spot, and caps a fetch of a folded fetch loop */
  const fileSpan = useMemo(() => { const f = doc.file.files?.[file]; return f && f.lastTim > f.firstTim ? f.lastTim - f.firstTim : doc.spanUs() }, [doc, file])
  const hotUs = Math.max(1, fileSpan * HOT_SHARE)
  const [hot, setHot] = useState<{ map: ReadonlyMap<number, number>; lines: number[] } | null>(null)
  useEffect(() => {
    if (!readable) return
    const ac = new AbortController()
    fetchHot(client, file, hotUs, ac.signal).then(
      (h) => { if (!ac.signal.aborted) setHot({ map: new Map(h.hot.map((x) => [x.line, x.us])), lines: h.hot.map((x) => x.line) }) },
      (e: unknown) => { if (!aborted(e)) setHot({ map: NO_HOT, lines: [] }) }, // an engine without the route: no hot spots
    )
    return () => ac.abort()
  }, [client, file, hotUs, readable, rev])
  const wantRepeats = readable && prefs.foldRepeats
  const [repeats, setRepeats] = useState<{ folds: RepeatFold[]; key: string } | null>(null)
  const repeatsKey = `${file}:${rev}`
  useEffect(() => {
    if (!wantRepeats) return
    const ac = new AbortController()
    fetchRepeats(client, file, hotUs, ac.signal).then(
      (r) => { if (!ac.signal.aborted) setRepeats({ folds: r.folds, key: repeatsKey }) },
      (e: unknown) => { if (!aborted(e)) setRepeats({ folds: [], key: repeatsKey }) },
    )
    return () => ac.abort()
  }, [client, file, hotUs, wantRepeats, repeatsKey])
  const repeatsLoading = wantRepeats && repeats?.key !== repeatsKey
  // the plan dumps of the file: each is laid out as one table under a head row of its own
  const [planTables, setPlanTables] = useState<{ blocks: [number, number][]; key: string } | null>(null)
  useEffect(() => {
    if (!readable) return
    const ac = new AbortController()
    linesBlocks(client, file, 'stat', ac.signal).then(
      (r) => { if (!ac.signal.aborted) setPlanTables({ blocks: r.blocks, key: repeatsKey }) },
      (e: unknown) => { if (!aborted(e)) setPlanTables({ blocks: [], key: repeatsKey }) }, // no tables: a plan's lines are rows of their own
    )
    return () => ac.abort()
  }, [client, file, readable, repeatsKey])
  const tables = planTables?.key === repeatsKey ? planTables.blocks : undefined
  // the BINDS blocks: each bind one row of a table, its attribute lines folded under it (the Line tab reads them)
  const [bindBlocks, setBindBlocks] = useState<{ folds: Fold[]; table(from: number): Fold[]; key: string } | null>(null)
  useEffect(() => {
    if (!readable) return
    const ac = new AbortController()
    linesBlocks(client, file, 'binds', ac.signal).then(
      (r) => {
        if (ac.signal.aborted) return
        const folds = bindFolds(r.blocks, r.bindLines, INLINE_BINDS)
        // an inline block the user opens (z) reads as a table: its attribute lines fold under each bind as in any other
        const table = (from: number) => { const i = r.blocks.findIndex((b) => b[0] === from); return i < 0 ? [] : bindFolds([r.blocks[i]], [r.bindLines[i]]) }
        setBindBlocks({ folds, table, key: repeatsKey })
      },
      (e: unknown) => { if (!aborted(e)) setBindBlocks({ folds: [], table: () => [], key: repeatsKey }) },
    )
    return () => ac.abort()
  }, [client, file, readable, repeatsKey])
  // the framing lines (the `=====` rule before a cursor, END OF STMT): they fold quietly under the line above them; with them the SQL texts of the statements (the SQL bands)
  const [frameBlocks, setFrameBlocks] = useState<{ ranges: [number, number][]; texts: [number, number, number][]; key: string } | null>(null)
  useEffect(() => {
    if (!readable) return
    const ac = new AbortController()
    linesBlocks(client, file, 'frame', ac.signal).then(
      (r) => { if (!ac.signal.aborted) setFrameBlocks({ ranges: r.blocks, texts: r.texts, key: repeatsKey }) },
      (e: unknown) => { if (!aborted(e)) setFrameBlocks({ ranges: [], texts: [], key: repeatsKey }) }, // an engine without the kind: the lines stay rows
    )
    return () => ac.abort()
  }, [client, file, readable, repeatsKey])
  /** The SQL band of each statement text of the file: its lines and the statement's text in the document (a statement the document does not have is no band). */
  const sqlBands = useMemo((): readonly SqlBand[] | undefined => {
    if (!readable || frameBlocks?.key !== repeatsKey || frameBlocks.texts.length === 0) return undefined
    const out: SqlBand[] = []
    for (const [from, to, stmt] of frameBlocks.texts) { const text = doc.statements[stmt]?.text; if (text) out.push({ from, to, text }) }
    return out
  }, [readable, frameBlocks, repeatsKey, doc])
  const wrapSql = readable && prefs.wrap // the formatted view's Wrap long lines: an SQL band is one row holding the whole statement
  const quietFolds = useMemo(() => {
    if (!readable) return null
    const binds = bindBlocks?.key === repeatsKey ? bindBlocks.folds : []
    // a fold that starts in a plan's table would take its head row away: the framing line under a plan's last row stays a row
    const inTable = (line: number) => {
      let lo = 0, hi = tables!.length // the last table that starts at or before the line (the tables are sorted and apart)
      while (lo < hi) { const mid = (lo + hi) >> 1; if (tables![mid][0] <= line) lo = mid + 1; else hi = mid }
      return lo > 0 && line <= tables![lo - 1][1]
    }
    const frame = frameBlocks?.key === repeatsKey ? frameFolds(frameBlocks.ranges, tables && tables.length > 0 ? inTable : undefined, wrapSql ? sqlBands : undefined) : []
    return binds.length === 0 && frame.length === 0 ? null : mergeFolds(binds, frame)
  }, [readable, bindBlocks, frameBlocks, repeatsKey, tables, wrapSql, sqlBands])
  const bindTable = bindBlocks?.table
  const repeatFolds = useMemo(() => (wantRepeats && repeats ? repeats.folds.map((r) => repeatFold(r)) : null), [wantRepeats, repeats])
  // the selection is never folded away (bug 11): a run that holds the selected line shows open, and folds again when the selection leaves it
  const repeatIndex = useMemo(() => (repeatFolds ? indexFolds(repeatFolds) : null), [repeatFolds])
  const selFold = useMemo(() => (repeatIndex ? foldHiding(selected, repeatIndex) : undefined), [repeatIndex, selected])
  // ---- the Δ filter: the lines whose time from the timed line before reaches the threshold, asked of the engine for the whole file ----
  const deltaMode = prefs.deltaMode
  const deltaUs = Math.max(0, Math.round(prefs.deltaMs * 1000))
  const deltaKey = `${file}:${rev}:${deltaUs}`
  const [deltaAns, setDeltaAns] = useState<{ key: string; lines: [number, number][]; truncated: boolean; error?: string } | null>(null)
  useEffect(() => {
    if (deltaMode === 'off') return
    const ac = new AbortController()
    fetchDelta(client, file, deltaUs, ac.signal).then(
      (r) => { if (!ac.signal.aborted) setDeltaAns({ key: deltaKey, ...r }) },
      (e: unknown) => { if (!aborted(e)) setDeltaAns({ key: deltaKey, lines: [], truncated: false, error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => ac.abort()
  }, [client, file, deltaUs, deltaMode, deltaKey])
  const delta = deltaMode !== 'off' && deltaAns?.key === deltaKey ? deltaAns : null
  const deltaLoading = deltaMode !== 'off' && !delta
  const deltaWhat = `Δ ≥ ${fmtMs(prefs.deltaMs)}`
  /** highlight: the lines that reach the threshold and their Δ */
  const deltaHits = useMemo(() => (deltaMode === 'highlight' && delta && !delta.error ? new Map(delta.lines) : undefined), [deltaMode, delta])
  // ---- the statement filter: the lines of the filtered statements' cursors, asked of the engine for the whole file (`api/lines/stmts`) ----
  const filterIds = ui.filter
  const filterKey = `${file}:${rev}:${filterIds.join(',')}`
  const [stmtAns, setStmtAns] = useState<{ key: string; runs: [number, number][]; lines: number; truncated: boolean } | null>(null)
  useEffect(() => {
    if (filterIds.length === 0) return
    const ac = new AbortController()
    fetchStmtUnion(client, file, filterIds, ac.signal).then(
      (r) => { if (!ac.signal.aborted) setStmtAns({ key: filterKey, runs: r.runs, lines: r.lines, truncated: r.truncated }) },
      (e: unknown) => { if (!aborted(e)) { set({ filter: [] }); flash(`cannot filter by statement: ${e instanceof Error ? e.message : String(e)}`, true) } }, // an engine without the route
    )
    return () => ac.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, file, filterKey])
  const stmtFilter = filterIds.length > 0 && stmtAns?.key === filterKey ? stmtAns : null
  const stmtLoading = filterIds.length > 0 && !stmtFilter
  if (ui.openFilter.key !== `${deltaKey}|${filterIds.join(',')}`) ui.openFilter = { key: `${deltaKey}|${filterIds.join(',')}`, lines: new Set() } // a new answer: every fold closed again
  const deltaFiltering = deltaMode === 'filter' && !!delta && !delta.error
  const filtering = deltaFiltering || !!stmtFilter
  // both filters on: a row shown passes both
  const filterFoldList = useMemo(() => {
    if (stmtFilter) {
      const keep = deltaFiltering && delta ? linesInRuns(stmtFilter.runs, delta.lines.map((x) => x[0])) : stmtFilter.runs
      return runFolds(keep, total, deltaFiltering ? 'line that is both' : 'statement', stmtFilter.truncated).filter((f) => !ui.openFilter.lines.has(f.from))
    }
    return deltaFiltering && delta ? filterFolds(delta.lines.map((x) => x[0]), total, deltaWhat).filter((f) => !ui.openFilter.lines.has(f.from)) : null
  }, [stmtFilter, deltaFiltering, delta, total, deltaWhat, ui.openFilter, ui.openFilter.lines.size]) // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * the user's folds and the view's own (with Fold repeats, the repeats; the framing, the inline binds, the binds' attribute lines, the SQL bands) that the user has not opened (the
   * user's win where they overlap). The statement filter keeps them inside its kept runs (`composeFilterFolds`: the filter only adds the folds between the runs). The Δ filter's
   * kept rows are single lines the view's own folds would hide (a wait inside a fold of repeats), so only the quiet ones (the framing, the binds' lines, the SQL bands) are kept
   * with it, for the lines of a fold of the filter that is opened; the repeats and the user's folds give way to it.
   */
  const composed = !!stmtFilter && !deltaFiltering
  const ownFolds = useMemo(() => {
    if (!repeatFolds && !quietFolds) return ui.folds
    const own = [...standingFolds(repeatFolds ?? [], ui.openRepeats, selFold), ...(quietFolds ?? []).filter((f) => !ui.openRepeats.has(f.from))]
    // the inline BINDS blocks that were opened: the table's own quiet folds instead
    if (quietFolds && bindTable) for (const f of quietFolds) if (f.inline && ui.openRepeats.has(f.from)) own.push(...bindTable(f.from))
    return mergeFolds(ui.folds, own)
  }, [repeatFolds, selFold, quietFolds, bindTable, ui.folds, ui.openRepeats])
  const quietOwn = useMemo(() => {
    if (!quietFolds) return NO_FOLDS
    const own = quietFolds.filter((f) => !ui.openRepeats.has(f.from))
    if (bindTable) for (const f of quietFolds) if (f.inline && ui.openRepeats.has(f.from)) own.push(...bindTable(f.from))
    return mergeFolds([], own)
  }, [quietFolds, bindTable, ui.openRepeats])
  const allFolds = useMemo(() => (filterFoldList ? composeFilterFolds(composed ? ownFolds : quietOwn, filterFoldList) : ownFolds), [filterFoldList, composed, ownFolds, quietOwn])
  /** Opens a fold, or folds a block again: a fold of repeats or of the Δ filter is opened by remembering it, a user's fold by dropping it. */
  const toggleAnyFold = useCallback((f: Fold) => {
    if (f.filter) { ui.openFilter.lines.add(f.openKey ?? f.from); set({ openFilter: { ...ui.openFilter } }) }
    else if (f.auto) set({ openRepeats: new Set([...ui.openRepeats, f.from]) }); else set({ folds: toggleFold(ui.folds, f) })
  }, [ui, set])

  // the view pulses while it switches: the toggle's new render waits a frame, so the pulse is painted before the work starts
  const [switching, setSwitching] = useState<'readable' | 'repeats' | null>(null)
  const switchPrefs = (what: 'readable' | 'repeats', patch: Partial<typeof prefs>) => {
    if (Object.entries(patch).every(([k, v]) => prefs[k as keyof typeof prefs] === v)) return
    setSwitching(what)
    requestAnimationFrame(() => window.setTimeout(() => setPrefs(patch), 0))
  }
  useEffect(() => {
    let r2 = 0
    const r1 = requestAnimationFrame(() => { r2 = requestAnimationFrame(() => setSwitching(null)) })
    return () => { cancelAnimationFrame(r1); cancelAnimationFrame(r2) }
  }, [prefs.readable, prefs.foldRepeats])
  const busy = switching !== null || repeatsLoading || (deltaMode === 'filter' && deltaLoading) || stmtLoading
  const toggleRepeats = () => (readable ? switchPrefs('repeats', { foldRepeats: !prefs.foldRepeats }) : flash('Fold repeats works in the formatted view (v)'))

  // ---- folding: the handles of the blocks around the view, and the blocks themselves -----------------------------------
  // the open runs of Fold repeats (opened by the user, or holding the selected line) keep a ▾ on their first line, to fold them again
  const openRuns = useMemo(() => {
    const out = new Map<number, Fold>()
    if (!repeatFolds || (filterFoldList && !composed)) return out // (the Δ filter's folds replace them)
    for (const f of repeatFolds) if (ui.openRepeats.has(f.from)) out.set(f.from, f)
    if (selFold) out.set(selFold.from, selFold)
    return out
  }, [repeatFolds, filterFoldList, composed, selFold, ui.openRepeats])
  const foldable = useMemo(() => {
    const out = new Set<number>(openRuns.keys())
    for (let n = Math.max(1, foldTop + 1 - FOLD_STEP), end = foldTop + FOLD_SPAN; n <= end; n++) {
      const l = cache.line(n)
      if (l && startsBlock(l.kind) && blockAt(cache, n)) out.add(n)
    }
    return out
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, foldTop, pages, openRuns])

  // ---- what is at a line ------------------------------------------------------------------------------------------
  const atTimer = useRef(0)
  const atCtl = useRef<AbortController | null>(null)
  /** Moves the rest of the app to what the line is at: its statement, execution and wait event. */
  const dispatchAt = useCallback((o: { stmt: number; cursor: number; execNo: number; wait: number }, text: string) => {
    const sel = store.getState().selection
    if (o.stmt >= 0 && o.stmt !== sel.stmt) { ui.jumpedFor = o.stmt; ui.hlSeen = o.stmt; actions.pickStmt(o.stmt) } // (a statement this view selects itself is no arrival: it does not join the highlighted ones)
    if (o.stmt >= 0 && o.cursor >= 0 && o.execNo >= 0) actions.selectExec({ cursor: o.cursor, execNo: o.execNo })
    if (o.wait >= 0) {
      const name = /nam='([^']*)'/.exec(text)?.[1] // the line's text names a wait's event
      const ev = name === undefined ? -1 : doc.events.findIndex((e) => e.name === name)
      if (ev >= 0) actions.selectEvent(ev)
    }
  }, [store, actions, doc, ui])
  const resolveAt = useCallback((line: number, dispatch: boolean) => {
    window.clearTimeout(atTimer.current)
    atCtl.current?.abort()
    // a cached line with ids (`annot=2`) answers at once; the request below fills in ctx, bindSet and planLine
    const objs0 = cachedAt(cache, line)
    const known = !!objs0
    if (objs0) {
      setAt({ line, objs: objs0 })
      if (dispatch) dispatchAt(objs0, cache.line(line)?.text ?? '')
    }
    atTimer.current = window.setTimeout(async () => {
      atCtl.current?.abort()
      const ac = (atCtl.current = new AbortController())
      try {
        const page = await cache.load(cache.pageOf(line))
        const objs = await objectsAt(client, file, line, ac.signal)
        rememberBinds(doc, file, objs)
        if (ac.signal.aborted) return
        setAt({ line, objs })
        if (dispatch && !known) dispatchAt(objs, page.texts[line - page.from] ?? '')
      } catch (e) { if (!aborted(e) && !known) setAt(null) }
    }, 60)
  }, [cache, client, doc, file, dispatchAt])
  useEffect(() => () => { window.clearTimeout(atTimer.current); atCtl.current?.abort() }, [])

  const select = useCallback((line: number, dispatch = true) => { ui.cur = line; actions.setLinesLine(file, line); resolveAt(line, dispatch) }, [actions, file, resolveAt, ui])
  const revealAfter = useRef(0) // a line to reveal once the viewer has the new folds
  const goTo = useCallback((line: number, dispatch = true) => {
    const hidden = foldHiding(line, allFolds)
    if (hidden?.sql) apiRef.current?.reveal(line, 'center') // a text line folded into its SQL band (wrap mode): the band's row is the line's row, the fold stays
    else if (hidden) { // a line inside a fold: open it first (a run of Fold repeats opens by itself while the selection is inside it)
      revealAfter.current = line
      if (!(hidden.auto && !hidden.quiet && !hidden.filter)) toggleAnyFold(hidden)
      // a fold of a filter that was opened: the view's own fold that hides the line under it (the bind's attribute lines, a block folded by the user) opens with it
      if (hidden.filter) {
        const own = foldHiding(line, composed ? ownFolds : quietOwn)
        if (own && !(own.auto && !own.quiet)) toggleAnyFold(own)
      }
    }
    else apiRef.current?.reveal(line, 'center')
    select(line, dispatch)
  }, [select, allFolds, toggleAnyFold, composed, ownFolds, quietOwn])
  // the viewer maps the new folds in its own effect (a child's effect runs first), then the reveal can find the row
  useEffect(() => {
    if (revealAfter.current > 0) { apiRef.current?.reveal(revealAfter.current, 'center'); revealAfter.current = 0 }
  }, [allFolds])
  /** A jump (a search hit, a mark, a bookmark, Go to, a line card action, a deep link): `goTo` that remembers the line it left for Back. */
  const jump = useCallback((line: number, dispatch = true) => {
    if (ui.lines) set({ lines: null })
    const left = ui.cur
    if (left > 0 && left !== line && ui.back[ui.back.length - 1] !== left) { ui.back.push(left); if (ui.back.length > BACK_LIMIT) ui.back.shift(); bump() }
    goTo(line, dispatch)
  }, [ui, goTo, set])
  const goBack = useCallback(() => {
    const line = ui.back.pop()
    if (line === undefined) return
    bump()
    goTo(line)
  }, [ui, goTo])

  // a deep link or jump from elsewhere moves the view (`keep`: without picking the line's statement); coming back to the tab keeps the position
  useEffect(() => {
    if (lv.seq !== ui.seqSeen) { ui.seqSeen = lv.seq; jump(lv.line, !lv.keep); return }
    ui.cur = lv.line
    resolveAt(lv.line, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lv.seq])
  useEffect(() => () => { ui.top = topRef.current; ui.picker = false }, [ui]) // (the statement picker does not come back open with the tab)

  // ---- the highlighted statements: where they show up (m / M step between the starts of their runs; the search scope "highlighted statements" reads the lines between the first and
  // the last), asked of the engine once per change of the set (the strip's binned request is the other; both are answers of `api/lines/stmts`) --------------------------------------
  const source = sourceOf(doc)
  const hl = ui.hl
  const [stopsAns, setStopsAns] = useState<{ key: string; stops: HlStops } | null>(null)
  useEffect(() => {
    if (hl.ids.length === 0) { setStopsAns(null); return }
    const ac = new AbortController()
    fetchStmtRuns(client, file, hl.ids, ac.signal).then(
      (r) => { if (!ac.signal.aborted) setStopsAns({ key: hlKey, stops: hlStops(r.stmts, r.truncated) }) },
      (e: unknown) => { if (!aborted(e)) setStopsAns({ key: hlKey, stops: hlStops([]) }) }, // an engine without the route: nothing to step between
    )
    return () => ac.abort()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, hlKey])
  /** The stops of the highlighted statements as they are now; null while the engine has not answered for this set. */
  const stops = hl.ids.length > 0 && stopsAns?.key === hlKey ? stopsAns.stops : null
  // the calls and waits of the one highlighted statement, for the picker's button and the raw view's chip: the real counts (the marks are bounded: the 5,000 longest
  // calls and the first 1,000 waits, which the tooltip says)
  const lone = hl.ids.length === 1 ? hl.ids[0] : null
  const loneQ = useSourceQuery(source, `hlmarks:${lone}`, (signal) => (lone !== null && source.ready ? source.stmtMarks(lone, signal) : null), 'hlmarks')
  const counts = useMemo((): StmtCounts | null => {
    const d = loneQ.data
    if (!d || lone === null) return null
    const nc = d.calls.filter((c) => c.file === file && c.line > 0).length, nw = d.waits.filter((w) => w.file === file && w.line > 0).length
    const cut = (what: string, shown: number, all: number) => (all > shown ? `first ${fmtInt(shown)} ${what} marked` : '')
    const note = [cut('calls', d.calls.length, d.totalCalls), cut('waits', d.waits.length, d.totalWaits)].filter(Boolean).join(', ')
    return { calls: d.totalCalls > d.calls.length ? d.totalCalls : nc, waits: d.totalWaits > d.waits.length ? d.totalWaits : nw, note: note || undefined }
  }, [loneQ.data, lone, file])

  // opening the tab with a statement selected: start at its first line in this file (not after a click on a line, which selected the statement itself)
  useEffect(() => {
    if (stmt === null || ui.jumpedFor === stmt || lv.seq !== ui.seqSeen) return
    const first = stmtLineIn(doc, file, stmt)
    if (first === undefined) return
    ui.jumpedFor = stmt
    if (topRef.current < 1 && lv.line <= 1) goTo(first)
  }, [stmt, ui, lv.seq, lv.line, goTo, doc, file])

  const mutedKinds = useMemo(() => new Set(MUTE_GROUPS.filter((g) => muteSet.has(g.name)).flatMap((g) => g.kinds.map((k) => LINE_KINDS.indexOf(k)))), [muteSet])
  /** this file's PARSING IN CURSOR lines and error lines, ascending */

  /** The next / previous place a highlighted statement shows up: the first line of its next (previous) run of lines, whichever statement of the set it is. */
  const stepMark = (dir: 1 | -1) => {
    if (hl.ids.length === 0) { flash("nothing is highlighted: l highlights the selected line's statement, L chooses statements from the list"); return }
    if (!stops) { flash('looking up the highlighted statements…'); return }
    const to = hotStep(stops.starts, selected, dir)
    if (to !== undefined) jump(to)
    else flash(`no ${dir === 1 ? 'more' : 'earlier'} highlighted lines ${dir === 1 ? 'after' : 'before'} line ${fmtInt(selected)}${stops.truncated && dir === 1 ? ' in the part of the list the engine sent (it is cut)' : ''}`)
  }

  // ---- bookmarks -------------------------------------------------------------------------------------------------------
  const bookmarks = useMemo(() => allBookmarks.filter((b) => b.file === file), [allBookmarks, file])
  const stripHits = useMemo(() => (ui.status === 'idle' ? [] : ui.hits.map((h) => h.line)), [ui.hits, ui.hits.length, ui.status]) // eslint-disable-line react-hooks/exhaustive-deps
  const scrubTo = useCallback((line: number) => apiRef.current?.reveal(line, 'center'), [])
  /** the highlighted statements' lines for the strip, each in its colour (a statement the engine has not answered for yet has none) */
  const stripLayers = useMemo((): StripLayer[] => {
    if (!bins) return []
    const by = new Map(bins.stmts.map((b) => [b.id, b.counts]))
    return hl.ids.flatMap((id) => { const counts = by.get(id); return counts ? [{ id, token: slotTone(hl.slots.get(id)!).token, counts }] : [] })
  }, [bins, hl])
  const stripShape = useMemo(() => (bins ? { total: bins.total, size: bins.size, buckets: bins.buckets } : null), [bins])
  const bmSet = useMemo(() => new Set(bookmarks.map((b) => b.line)), [bookmarks])
  const noteSet = useMemo(() => new Map(bookmarks.filter((b) => b.note).map((b) => [b.line, b.note!])), [bookmarks])
  const toggleBookmark = useCallback((line: number) => {
    if (store.getState().bookmarks.some((b) => b.file === file && b.line === line)) actions.removeBookmark(file, line)
    else actions.addBookmark(file, line, preview(cache.line(line)?.text ?? '', 80).trim())
  }, [store, actions, file, cache])
  const fileName = useCallback((f: number) => doc.traceFileName(f), [doc])

  // ---- search ----------------------------------------------------------------------------------------------------------
  const searchCtl = useRef<AbortController | null>(null)
  /** The scope that can be searched now: the window needs its lines, the highlighted statements their lines in this file. */
  const hasStops = !!stops && stops.starts.length > 0
  const scopeOf = (want: SearchScope): SearchScope => (want === 'window' && winRange ? 'window' : want === 'stmt' && hasStops ? 'stmt' : 'file')
  const scope = scopeOf(ui.scope)
  const runSearch = () => {
    if (ui.q === '') return
    searchCtl.current?.abort()
    const ac = (searchCtl.current = new AbortController())
    const hits: SearchHit[] = []
    const { q, regex, caseSensitive } = ui
    const sc = scopeOf(ui.scope)
    const span: LineRange | null = sc === 'window' ? winRange : sc === 'stmt' && stops ? { from: stops.first, to: stops.last } : null
    const here = ui.fromHere ? Math.min(Math.max(1, selected + 1), Math.max(1, cache.total || selected + 1)) : 1
    const from = span ? (ui.fromHere && here >= span.from && here <= span.to ? here : span.from) : here
    set({ hits, end: null, status: 'running', error: null, tab: 'hits', searched: { q, regex, caseSensitive, scope: sc } })
    setPrefs({ inspect: true }) // the side panel, at its Hits tab
    let timer = 0
    let clipped = false // the stream was cut at the first hit past the scope's last line
    const flush = () => { timer = 0; if (searchCtl.current === ac) bump() }
    const finish = (patch: Partial<LinesUi>) => { window.clearTimeout(timer); if (searchCtl.current === ac) set(patch) }
    const complete = (end: SearchEnd) => finish({ end, status: 'done', recent: [{ q, regex, caseSensitive, scope: sc, hits, end }, ...ui.recent.filter((r) => !sameSearch(r, { q, regex, caseSensitive, scope: sc }))].slice(0, RECENT_LIMIT) })
    search(client, { file, q, regex, caseSensitive, from, limit: SEARCH_LIMIT }, (h) => {
      if (clipped) return
      if (span && h.line > span.to) { clipped = true; ac.abort(); return }
      // the statement scope is the stream window between the first and the last line of the highlighted statements (cheap, a superset); where the hit's page is loaded
      // the line's owner is exact, so lines of other statements inside the window are dropped; hits on pages not loaded stay
      if (sc === 'stmt') { const own = cache.line(h.line); if (own && !hl.slots.has(own.stmt)) return }
      hits.push(h)
      if (hits.length === 1) { flush(); jump(h.line) } else if (!timer) timer = window.setTimeout(flush, 100)
    }, ac.signal).then(
      complete,
      (e: unknown) => {
        if (aborted(e) && clipped) complete({ scanned: 0, truncated: false, done: true })
        else finish(aborted(e) ? { status: 'cancelled' } : { status: 'error', error: e instanceof Error ? e.message : String(e) })
      },
    )
  }
  const cancelSearch = () => searchCtl.current?.abort()

  // ---- the statement of each hit: from the page cache, the pages of the hits in view loaded lazily ------------------------
  const need = useMemo(() => ({ queue: [] as number[], queued: new Set<number>(), failed: new Set<number>(), busy: 0 }), [cache])
  /** The statement at a hit's line: undefined while its page is not loaded, -1 when the line has none. */
  const stmtOfHit = useCallback((line: number): number | undefined => cache.line(line)?.stmt, [cache])
  const pumpNeed = useCallback(() => {
    while (need.busy < NEED_INFLIGHT && need.queue.length > 0) {
      const page = need.queue.shift()!
      need.busy++
      cache.load(page).catch(() => need.failed.add(page)).finally(() => { need.busy--; need.queued.delete(page); pumpNeed() })
    }
  }, [cache, need])
  /** Loads the page of a hit whose statement is unknown (once per page, at most `NEED_INFLIGHT` at a time); the arrival repaints through the cache subscription. */
  const needStmt = useCallback((line: number) => {
    const page = cache.pageOf(line)
    if (cache.has(page) || need.queued.has(page) || need.failed.has(page)) return
    need.queued.add(page); need.queue.push(page)
    pumpNeed()
  }, [cache, need, pumpNeed])
  const toggleGroup = (g: number) => { const o = new Set(ui.openGroups); if (!o.delete(g)) o.add(g); set({ openGroups: o }) }
  useEffect(() => () => searchCtl.current?.abort(), [])

  /** A recent search's hits and status back at once, without a request. */
  const restoreSearch = (r: RecentSearch) => {
    const c = searchCtl.current
    searchCtl.current = null // a running search must not overwrite what is restored
    c?.abort()
    set({ q: r.q, regex: r.regex, caseSensitive: r.caseSensitive, scope: r.scope, hits: r.hits, end: r.end, status: 'done', error: null, tab: 'hits', searched: { q: r.q, regex: r.regex, caseSensitive: r.caseSensitive, scope: r.scope } })
  }
  const rerunSearch = (r: RecentSearch) => { set({ q: r.q, regex: r.regex, caseSensitive: r.caseSensitive, scope: r.scope }); runSearch() }
  /** A preset fills the box, switches regex on and runs; the threshold ones ask for the milliseconds. */
  const runPreset = (p: (typeof SEARCH_PRESETS)[number]) => {
    let re: string
    if (typeof p.re === 'string') re = p.re
    else {
      if (!(prefs.threshold > 0)) { flash('the threshold must be a number of milliseconds above 0'); return }
      re = p.re(prefs.threshold)
    }
    set({ q: re, regex: true, optionsMenu: false })
    runSearch()
  }

  const stepHit = (dir: 1 | -1) => {
    const hs = ui.hits
    if (hs.length === 0) return
    const i = firstAbove(hs.map((h) => h.line), selected) // the hit list is in line order
    const to = dir === 1 ? hs[i] : hs[hs[i - 1]?.line === selected ? i - 2 : i - 1]
    if (to) jump(to.line)
  }

  /** The next / previous line of a kind, asked of the engine (every step is a binary search over the whole file). A new step cancels the one still on its way. */
  const stepCtl = useRef<AbortController | null>(null)
  useEffect(() => () => stepCtl.current?.abort(), [])
  const stepNext = (what: NextWhat, label: string, dir: 1 | -1, min?: number) => {
    stepCtl.current?.abort()
    const ac = (stepCtl.current = new AbortController())
    const from = selected
    nextLine(client, file, from, what, dir, ac.signal, min).then(
      (to) => { if (ac.signal.aborted) return; if (to !== null) jump(to); else flash(`no ${label} ${dir === 1 ? 'after' : 'before'} line ${fmtInt(from)}`) },
      (e) => { if (!aborted(e)) flash(e instanceof Error ? e.message : String(e)) },
    )
  }
  /** The next / previous idle gap of at least `prefs.gapMs` ms. */
  const stepGap = (dir: 1 | -1) => {
    if (!(prefs.gapMs > 0)) { flash('set the gap threshold above 0 ms in the Display tab'); return }
    stepNext('gap', `gap of ${fmtInt(prefs.gapMs)} ms or more`, dir, prefs.gapMs * 1000)
  }
  /** The next / previous execution of the selected line's cursor, from the line card's answer. */
  const stepExec = (dir: 1 | -1) => {
    const to = at && at.line === selected ? (dir === 1 ? at.objs.nextExec : at.objs.prevExec) : -1
    if (to >= 0 && to !== selected) jump(to); else flash(`no ${dir === 1 ? 'next' : 'previous'} execution of this cursor`)
  }
  /** Focus the selected line's cursor (dims the rows of the others), or clear the focus when it is already that cursor. */
  const toggleFocus = () => {
    const cur = cache.line(selected)?.cursor ?? -1
    if (cur < 0) flash(`no cursor at line ${fmtInt(selected)}`)
    else set({ focus: ui.focus === cur ? null : cur })
  }
  /** The statement of the selected line, -1 for none (a line outside any statement, or one whose page has not arrived). */
  const lineStmt = (): number => {
    const l = cache.line(selected)
    const st = l && l.stmt >= 0 ? l.stmt : at && at.line === selected ? at.objs.stmt : -1
    return st >= 0 && doc.statements[st] ? st : -1
  }
  const nameOf = (id: number) => (doc.statements[id] ? doc.label(doc.statements[id]) : `statement ${id}`)
  /** Highlights the selected line's statement (every line of its cursors tinted in a colour of its own), or stops when it already is. */
  const highlightLine = () => {
    const st = lineStmt()
    if (st < 0) { flash(`no statement at line ${fmtInt(selected)}`); return }
    const on = !hl.slots.has(st)
    set({ hl: toggleHl(hl, st) })
    flash(on ? `highlighting ${nameOf(st)}` : `no longer highlighting ${nameOf(st)}`)
  }
  /** Filters the view to the selected line's statement (again: stops), next to the ones it is already filtered to. */
  const filterLine = () => {
    const st = lineStmt()
    if (st < 0) { flash(`no statement at line ${fmtInt(selected)}`); return }
    toggleFilter(st)
  }
  /** Adds the statement to the filter or takes it out. The cursor focus gives way when the filter leaves its statement out (its rows would all be folded away or dimmed). */
  const setFilter = (ids: readonly number[]) => {
    const patch: Partial<LinesUi> = { filter: ids }
    const f = ui.focus !== null ? doc.cursors[ui.focus] : undefined
    if (ids.length > 0 && f && !ids.includes(f.statement)) patch.focus = null
    set(patch)
  }
  const toggleFilter = (id: number) => setFilter(ui.filter.includes(id) ? ui.filter.filter((x) => x !== id) : [...ui.filter, id])
  const setFiltered = (ids: readonly number[], on: boolean) => setFilter(on ? [...ui.filter, ...ids.filter((id) => !ui.filter.includes(id))] : ui.filter.filter((id) => !ids.includes(id)))
  /** Goes to the statement's first line in this file. */
  const goToStmt = (id: number) => { const l = stmtLineIn(doc, file, id); if (l !== undefined) jump(l); else flash(`${nameOf(id)} has no cursor in this file`) }
  // a statement selected elsewhere (another view, a deep link) arrives and joins the highlighted ones; the line clicks of this view do not (see dispatchAt)
  useEffect(() => {
    if (stmt === ui.hlSeen) return
    ui.hlSeen = stmt
    if (stmt !== null && doc.statements[stmt] && stmtLineIn(doc, file, stmt) !== undefined && !ui.hl.slots.has(stmt)) set({ hl: addHl(ui.hl, [stmt]) })
  }, [stmt]) // eslint-disable-line react-hooks/exhaustive-deps
  /** Opens the overview row's statement picker (the formatted view's; the raw view has the Highlighting chip and no list). */
  const openPicker = () => {
    if (!readable) { flash('the statement list is in the formatted view (v); in the raw view l highlights and F filters by the selected line\'s statement'); return }
    set({ picker: true, keys: false })
  }
  const openStatement = () => {
    if (at && at.line === selected && at.objs.stmt >= 0) actions.selectStmt(at.objs.stmt)
    else flash(`no statement at line ${fmtInt(selected)}`)
  }
  /** The side panel as `panelAfter` says: at `want`, or closed when it already shows it; no tab is the panel button. */
  const togglePanel = (want?: PanelTab) => {
    const next = panelAfter({ open: prefs.inspect, tab: ui.tab, last: ui.lastTab }, want)
    if (next.tab !== ui.tab) set({ tab: next.tab })
    if (next.open !== prefs.inspect) setPrefs({ inspect: next.open })
  }
  const displayOpen = prefs.inspect && ui.tab === 'display'
  /** Shows the Display tab (a click on a state chip: it stays open when it is already there). */
  const openDisplay = () => { if (!displayOpen) togglePanel('display') }
  const searchRef = useRef<HTMLInputElement>(null)
  /** The viewer's letter keys (no modifier but Shift, viewer focused, not in a text field). */
  const onViewerKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target as HTMLElement
    if (!t.closest('.lv') || t.closest('input, textarea, select, button')) return
    const focus = (el: HTMLInputElement | null) => { el?.focus(); el?.select() }
    switch (e.key) {
      case '/': focus(searchRef.current); break
      case 'g': set({ palette: true, keys: false, picker: false }); break
      case 'Enter': openStatement(); break
      case 'm': stepMark(1); break
      case 'M': stepMark(-1); break
      case 'h': setPrefs({ heat: !prefs.heat }); break
      case 'z': onFold(selected); break
      case 'Z': set({ folds: [] }); break
      case 'n': setPrefs({ hints: !prefs.hints }); break
      case 'v': switchPrefs('readable', { readable: !prefs.readable }); break
      case 'a': togglePin(selected); break
      case 'r': toggleRepeats(); break
      case 'j': stepHot(1); break
      case 'J': stepHot(-1); break
      case 't': stepGap(1); break
      case 'T': stepGap(-1); break
      case 'f': toggleFocus(); break
      case 'l': highlightLine(); break
      case 'L': openPicker(); break
      case 'F': filterLine(); break
      case 'i': togglePanel('line'); break
      case 'y': copySelLines(); break
      case ']': stepNext('call', 'call', 1); break
      case '[': stepNext('call', 'call', -1); break
      case 'w': stepNext('wait', 'wait', 1); break
      case 'W': stepNext('wait', 'wait', -1); break
      case 'x': stepNext('commit', 'commit', 1); break
      case 'X': stepNext('commit', 'commit', -1); break
      case 'c': stepNext('cursor', 'cursor parse', 1); break
      case 'C': stepNext('cursor', 'cursor parse', -1); break
      case 'e': stepNext('error', 'error', 1); break
      case 'E': stepNext('error', 'error', -1); break
      case 'p': stepNext('plan', 'STAT dump', 1); break
      case 'P': stepNext('plan', 'STAT dump', -1); break
      case 's': stepNext('ctx', 'session marker', 1); break
      case 'S': stepNext('ctx', 'session marker', -1); break
      case 'd': stepExec(1); break
      case 'D': stepExec(-1); break
      case '?': set({ keys: !ui.keys }); break
      default: return
    }
    e.preventDefault()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.altKey) { e.preventDefault(); set({ palette: !ui.palette, picker: false }) } // also in the boxes
    else if (e.key === 'Escape' && popup) { e.stopPropagation(); setPopup(null) }
    else if (e.key === 'Escape' && ui.status === 'running') { e.stopPropagation(); cancelSearch() }
    else if (e.key === 'Escape' && ui.lines) { e.stopPropagation(); set({ lines: null }) }
    else if (e.key === 'Escape' && ui.focus !== null && (e.target as HTMLElement).closest('.lv')) { e.stopPropagation(); set({ focus: null }) }
    else if (e.key === 'F3') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && ui.back.length > 0) {
      const t = e.target as HTMLElement
      if (t.closest('.lv') && !t.closest('input, textarea, select')) { e.preventDefault(); goBack() }
    } else onViewerKey(e)
  }

  // ---- per-line actions: copy the text, copy a link that opens the line ---------------------------------------------------
  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
  /** A short note in the status bar (`bad`: in the error colour). */
  const flash = useCallback((msg: string, bad = false) => {
    setCopied({ msg, bad })
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 2500)
  }, [])
  const copyWhat = useCallback(async (what: string, text: string) => {
    const ok = await copyText(text)
    flash(ok ? `Copied ${what}` : `Could not copy ${what}`, !ok)
  }, [flash])
  const copyLine = useCallback((line: number) => {
    const text = cache.line(line)?.text
    if (text !== undefined) void copyWhat(`line ${fmtInt(line)}`, text)
  }, [cache, copyWhat])
  const copyLink = useCallback((line: number) => void copyWhat(`link to line ${fmtInt(line)}`, linePermalink(window.location, file, line)), [copyWhat, file])
  /** Folds the block that starts at `line`, or unfolds the fold that has its handle there or hides it. */
  const onFold = useCallback((line: number) => {
    const b = blockAt(cache, line)
    const at = foldAt(line, allFolds)
    // a quiet fold on a block's first line (the blank lines under a BINDS header) does not stop the block from folding
    const open = at && !(at.quiet && b && !at.inline) ? at : foldHiding(line, allFolds)
    if (open) { toggleAnyFold(open); return }
    // an SQL band opened with z (wrap mode): fold it into its row again
    const band = quietFolds?.find((f) => f.sql && line >= f.from && line <= f.to && ui.openRepeats.has(f.from))
    if (band) { const next = new Set(ui.openRepeats); next.delete(band.from); set({ openRepeats: next }); if (selected > band.from && selected <= band.to) select(band.from); return }
    // an open run of Fold repeats: fold it again (a selection inside it moves to its handle line, which stays)
    let run = openRuns.get(line)
    if (!run) for (const f of openRuns.values()) if (line > f.from && line <= f.to) { run = f; break }
    if (run) {
      if (ui.openRepeats.has(run.from)) { const next = new Set(ui.openRepeats); next.delete(run.from); set({ openRepeats: next }) }
      if (selected > run.from && selected <= run.to) select(run.from)
      return
    }
    if (b) set({ folds: toggleFold(ui.folds, b) }); else flash(`nothing to fold at line ${fmtInt(line)}`)
  }, [ui, set, cache, flash, allFolds, quietFolds, toggleAnyFold, openRuns, selected, select])
  /** Folds every BINDS block or STAT dump of the file (the engine lists them), next to the folds there already are. */
  const foldAll = useCallback(async (what: 'binds' | 'stat') => {
    const name = what === 'binds' ? 'BINDS block' : 'STAT dump'
    try {
      const { blocks, truncated } = await linesBlocks(client, file, what)
      const added: Fold[] = blocks.filter(([from, to]) => to > from).map(([from, to]) => ({ from, to, summary: blockAt(cache, from)?.summary ?? `${name} · ${fmtInt(to - from + 1)} lines` }))
      const folds = mergeFolds(ui.folds, added)
      const n = folds.length - ui.folds.length
      set({ folds })
      flash(n > 0 ? `Folded ${fmtInt(n)} ${name}${n === 1 ? '' : 's'}${truncated ? ' (the first of a longer list)' : ''}` : `no ${name}s to fold`)
    } catch (e) { if (!aborted(e)) flash(e instanceof Error ? e.message : String(e)) }
  }, [client, file, cache, ui, set, flash])
  /** The pages that hold `set`'s lines, null when there are more than `COPY_PAGES`. */
  const pagesOf = useCallback((set: LineSet): number[] | null => {
    const ps = new Set<number>()
    for (const r of set) for (let p = cache.pageOf(r.from); p <= cache.pageOf(r.to); p++) { ps.add(p); if (ps.size > COPY_PAGES) return null }
    return [...ps].sort((x, y) => x - y)
  }, [cache])
  /** Copies the lines of `set` (their pages are loaded first; at most `COPY_PAGES`). `as` words the note: a block (the line card's) or the selected lines. */
  const copyLines = useCallback(async (set: LineSet, as: 'block' | 'selection' = 'block') => {
    const want = pagesOf(set)
    if (!want) { flash(`${as} too large to copy (${fmtInt(lineCount(set))} lines)`); return }
    let loaded: CachedPage[]
    try { loaded = await Promise.all(want.map((p) => cache.load(p))) } catch (e) { if (!aborted(e)) flash(e instanceof Error ? e.message : String(e)); return }
    const byPage = new Map(want.map((p, i) => [p, loaded[i]]))
    const texts: string[] = []
    for (const r of set) {
      for (let n = r.from; n <= r.to; n++) {
        const pg = byPage.get(cache.pageOf(n))
        const t = pg?.texts[n - pg.from]
        if (t === undefined) break
        texts.push(t)
      }
    }
    const one = set.length === 1 ? set[0] : null
    void copyWhat(as === 'selection' || !one ? `${fmtInt(texts.length)} ${texts.length === 1 ? 'line' : 'lines'}` : `block lines ${fmtInt(one.from)}–${fmtInt(one.from + texts.length - 1)}`, texts.join('\n'))
  }, [cache, copyWhat, flash, pagesOf])
  const copyRange = useCallback((from: number, to: number) => copyLines([{ from: Math.min(from, to), to: Math.max(from, to) }]), [copyLines])
  /** Copies the selected lines (`y`). */
  const copySelLines = useCallback(() => {
    if (ui.lines) void copyLines(ui.lines, 'selection'); else flash(`no lines selected (Shift+click, Shift+arrows or ${MOD}click)`)
  }, [ui, copyLines, flash])
  // the selection's summary for the status bar; a selection on at most COPY_PAGES pages gets its missing pages loaded (a page's arrival re-renders)
  const selSum = useMemo(() => (ui.lines ? summarizeLines(cache, ui.lines) : null), [ui.lines, cache, pages]) // eslint-disable-line react-hooks/exhaustive-deps
  const selLines = ui.lines
  useEffect(() => {
    if (!selLines) return
    for (const p of pagesOf(selLines) ?? []) if (!cache.has(p)) cache.load(p).catch(() => undefined)
  }, [cache, selLines, pagesOf])
  /** The block of the line card's line, when it is the handle of one (the card offers to copy it). */
  const atBlock = useMemo(() => (at ? blockAt(cache, at.line) : null), [at, cache, pages]) // eslint-disable-line react-hooks/exhaustive-deps
  const canLink = useStore((s) => s.lineRefTarget !== 'view') // the desktop shell has no URL to link to
  // ---- hover cards: the line decoded with what the trace knows (events, objects, clock) ------------------------------------
  const bindAt = useMemo(() => bindAtOf(doc, file, cache), [doc, file, cache])
  const decodeCtx = useMemo(() => decodeContextOf(doc, bindAt, (line) => gapBefore(cache, line) ?? undefined), [doc, bindAt, cache])
  // the idle gap before a line when it reaches the threshold (0 for none): the gutter tick and the gap hint; asked again when a page arrives
  const gapOf = useCallback((line: number) => {
    if (!(prefs.gapMs > 0)) return 0
    const us = gapBefore(cache, line)?.us ?? 0
    return us >= prefs.gapMs * 1000 ? us : 0
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cache, pages, prefs.gapMs])
  // hints add bind values and gaps; readable values replace the raw numbers they read (with the Clock column on, tim= stays: the column says it)
  const inlays = useMemo(() => (prefs.hints || prefs.readable
    ? (line: number, text: string, kind: number) => inlaysOf(text, LINE_KINDS[kind], line, decodeCtx, gapOf(line))
      .filter((i) => (i.from === undefined ? prefs.hints : prefs.readable && !(prefs.clock && i.kind === 'clock')))
    : undefined), [prefs.hints, prefs.readable, prefs.clock, decodeCtx, gapOf])
  const lineCard = useMemo(() => lineCardOf(decodeCtx), [decodeCtx])

  // ---- readable rows ---------------------------------------------------------------------------------------------------------
  // only a highlighted statement has a colour (its slot's); every other statement is neutral in the pane
  const tones = useMemo(() => hlTones(hl), [hl])
  const hlColors = useMemo(() => new Map([...tones].map(([id, t]) => [id, toneColor(t)])), [tones])
  const filtered = useMemo(() => new Set(filterIds), [filterIds])
  /** the statements' numbers in this file: the picker's time and share, the track, the lane row's `here` */
  const fstats = useFileStmts(doc, file)
  /** what the lane colours mean in the chosen mode (the Display tab's key) */
  const laneKey = useMemo(() => laneLegend(prefs.laneColor, doc.contexts.map((c) => [c.sessionId && `session ${c.sessionId}`, c.module, c.action].filter(Boolean).join(' · ') || `context ${c.id}`)), [prefs.laneColor, doc])
  /** Pins a line (Δ is measured from it), or unpins it. */
  const togglePin = useCallback((line: number) => {
    if (ui.pin?.line === line) { set({ pin: null }); return }
    const l = cache.line(line)
    const tim = l ? lineTim(l.text, LINE_KINDS[l.kind] ?? 'unknown') : undefined
    if (tim === undefined) { flash(`line ${fmtInt(line)} has no time to measure from (a call, wait, commit or cursor parse has)`); return }
    set({ pin: { line, tim } })
  }, [ui, set, cache, flash])
  // the values of the BINDS blocks in view: an engine session's document has no bind tables, so each header is asked of /api/at once
  const [bindsTick, bumpBinds] = useReducer((x: number) => x + 1, 0)
  const bindQ = useMemo(() => ({ asked: new Set<number>(), queue: [] as number[], busy: 0 }), [cache]) // eslint-disable-line react-hooks/exhaustive-deps
  const missingBinds = useCallback((line: number) => {
    if (bindQ.asked.has(line)) return
    bindQ.asked.add(line); bindQ.queue.push(line)
    const pump = () => {
      while (bindQ.busy < 3 && bindQ.queue.length > 0) {
        const n = bindQ.queue.shift()!
        bindQ.busy++
        objectsAt(client, file, n).then((o) => { rememberBinds(doc, file, o); bumpBinds() }, () => undefined).finally(() => { bindQ.busy--; pump() })
      }
    }
    queueMicrotask(pump)
  }, [bindQ, client, doc, file])
  const readableRows = useMemo(() => (readable
    ? readableRowsOf({ doc, line: (n) => cache.line(n), tones, pin: ui.pin, hot: hot?.map ?? NO_HOT, hotUs, spanUs: fileSpan, bindAt, missingBinds, colorBy: prefs.laneColor, labelAll: filtering })
    : undefined
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [readable, doc, cache, tones, ui.pin, hot, hotUs, fileSpan, bindAt, missingBinds, pages, bindsTick, prefs.laneColor, filtering])
  /** The next / previous hot spot from the selected line. */
  const hasHot = !!hot && hot.lines.length > 0
  const stepHot = (dir: 1 | -1) => {
    const hs = hot?.lines ?? []
    if (hs.length === 0) { flash(readable ? 'no line takes 1 % of the traced time or more' : 'hot spots are shown in the formatted view (v)'); return }
    const to = hotStep(hs, selected, dir)
    if (to !== undefined) jump(to); else flash(`no hot spot ${dir === 1 ? 'after' : 'before'} line ${fmtInt(selected)}`)
  }
  const highlight = ui.status !== 'idle' && ui.searched.q !== '' ? ui.searched : null

  // ---- references in the rows: a click on a cursor, sql_id, obj# or plan hash; the tooltip of each -------------------------
  const onRef = useMemo(() => refClickOf(doc, file, decodeCtx, actions, jump, flash, setPopup), [doc, file, decodeCtx, actions, jump, flash])
  const refTitle = useMemo(() => refTitleOf(doc, decodeCtx), [doc, decodeCtx])
  /** A readable row's own controls: the pin, the BINDS row's SQL with its values, the lane's sql_id (the statement popup). */
  const onAct = useCallback((line: number, act: 'pin' | 'asrun' | 'lane', el: HTMLElement) => {
    if (act === 'pin') togglePin(line)
    else if (act === 'asrun') { set({ asRunLine: line, tab: 'asrun' }); setPrefs({ inspect: true }) }
    else {
      const l = cache.line(line)
      const st = l && readableRows ? readableRows(line, l).lane?.stmt ?? -1 : -1
      const r = el.getBoundingClientRect()
      if (st >= 0 && doc.statements[st]) setPopup({ kind: 'stmt', stmt: st, anchor: { x: r.left, y: r.bottom, rect: r }, line })
    }
  }, [togglePin, set, setPrefs, cache, readableRows, doc])

  // ---- the inspector (the panel's Line tab): the selected line, or with Follow the line under the pointer -------------------
  const [hover, setHover] = useState<number | null>(null)
  const inspecting = prefs.inspect && ui.tab === 'line'
  const following = inspecting && prefs.follow
  useEffect(() => { if (!following) setHover(null) }, [following])
  const inspectedLine = following && hover !== null ? hover : selected
  const hoverAt = useLineAt(client, doc, file, cache, inspectedLine === selected ? null : inspectedLine) // the selected line's answer is `at`
  const inspAt = inspectedLine === selected ? at : hoverAt && hoverAt.line === inspectedLine ? hoverAt : null
  /** A click on a reference value in the inspector opens the same popup as the row links, for the inspected line. */
  const onInspectRef = (kind: InspectRefKind, value: string, e: { shiftKey: boolean; x: number; y: number; anchor?: DOMRect }) =>
    onRef(inspectedLine, kind, value, cache.line(inspectedLine), { shiftKey: e.shiftKey, metaKey: false, ctrlKey: false, x: e.x, y: e.y, anchor: e.anchor })

  // ---- the header over the top rows: the statement (and the BINDS or STAT block) at the top of the view, when it is not the ---
  // ---- selected line's (the breadcrumb says that one) ------------------------------------------------------------------------
  const selStmt = cache.line(selected)?.stmt ?? (at && at.line === selected ? at.objs.stmt : -1)
  /** A click on a sql_id outside the rows (the sticky lane row, the header over the raw rows): the statement popup at the click, as a click on one in a row; Shift goes to the cursor's PARSING IN CURSOR line. */
  const openStmt = useCallback((stmt: number, cursor: number, line: number, e: MouseEvent<HTMLElement>) => {
    const c = cursor >= 0 ? doc.cursors[cursor] : undefined
    if (e.shiftKey) {
      const at = c && c.line > 0 && doc.fileOfCursor(c.id) === file ? c.line : stmtLineIn(doc, file, stmt)
      if (at !== undefined) { jump(at); return }
    }
    const r = e.currentTarget.getBoundingClientRect()
    setPopup({ kind: 'stmt', stmt, cursor: c?.id, anchor: { x: e.clientX, y: e.clientY, rect: r }, line })
  }, [doc, file, jump])
  const head = useCallback((top: number) => {
    const l = cache.line(top)
    if (readableRows) { // formatted: the lane's identity, one sticky row while its lane scrolls (the cursor's own row names itself)
      const lane = l && l.kind >= 0 && top !== selected && LINE_KINDS[l.kind] !== 'parsing-in-cursor' ? readableRows(top, l).lane : null
      const lst = lane && lane.stmt >= 0 ? doc.statements[lane.stmt] : undefined
      if (!l || !lane || !lst) return null
      const stats = fstats[lst.id]
      const facts = `${stats ? `${fmtDur(stats.elapsed)} here` : ''}${l.execNo > 0 && stats ? ` · exec ${l.execNo} of ${fmtInt(stats.executions)}` : l.execNo > 0 ? `exec ${l.execNo}` : ''}`
      return {
        key: `${lst.id}|${l.execNo}|${lane.color ?? ''}|${lane.depth}`,
        lane: lane.color ?? (lane.ink || 'var(--c-idle)'),
        node: (
          <>
            {lane.depth > 0 && <span className="lv-lane-dep" title={`recursive SQL, depth ${lane.depth}`}>↳{lane.depth}</span>}
            <button type="button" className="lv-slane-id" style={{ '--lane-ink': lane.ink || undefined } as React.CSSProperties} title="peek at this statement (Shift: go to its PARSING IN CURSOR line)"
              onClick={(e) => openStmt(lst.id, l.cursor, top, e)}>{doc.label(lst)}</button>
            <span className="lv-slane-sql" title={preview(lst.text, 300)}>{lst.text ? preview(lst.text, 48) : 'no SQL text'}</span>
            <span className="lv-slane-facts">{facts}</span>
          </>
        ),
      }
    }
    const st = l && l.stmt >= 0 ? doc.statements[l.stmt] : undefined
    if (!l || !st || top === selected || l.stmt === selStmt) return null
    const family = (kind: number) => { const k = LINE_KINDS[kind]; return k === 'binds' || k === 'bind-line' ? 'binds' : k === 'stat' ? 'stat' : '' }
    const fam = family(l.kind)
    let start: number | undefined
    if (fam) { // the block's first line: walk up the cached lines while they stay in the block (bounded, and unknown past an unloaded page)
      let n = top, steps = 0
      for (; n > 1 && steps < 2000; steps++) {
        const p = cache.line(n - 1)
        if (!p || family(p.kind) !== fam) break
        n--
      }
      if (steps < 2000 && (n === 1 || cache.line(n - 1))) start = n
    }
    const cur = l.cursor >= 0 ? doc.cursors[l.cursor] : undefined
    const what = fam === 'binds' ? (l.execNo >= 0 ? `BINDS of exec #${l.execNo}` : 'BINDS') : 'STAT dump'
    const key = `${l.stmt}|${l.cursor}|${l.execNo}|${fam}|${start ?? ''}`
    return {
      key,
      node: (
        <>
          <span className="lv-head-up" aria-hidden="true" title="the statement of the top line">↥</span>
          <button type="button" className="link mono sqlid lv-head-id" title={cur && cur.line > 0 ? 'peek at this statement (Shift: go to its PARSING IN CURSOR line)' : 'peek at this statement'}
            onClick={(e) => openStmt(st.id, l.cursor, top, e)}>{doc.label(st)}</button>
          <span className="lv-head-sql" title={preview(st.text, 300)}>{preview(st.text, 60)}</span>
          {l.execNo >= 0 && <span className="lv-head-blk">exec #{l.execNo}</span>}
          {fam && (
            <span className="lv-head-blk">
              {what}
              {start !== undefined && <> · <button type="button" className="link" title="go to the first line of the block" onClick={() => jump(start)}>line {fmtInt(start)}</button></>}
            </span>
          )}
        </>
      ),
    }
  }, [cache, doc, openStmt, jump, selected, selStmt, readableRows, fstats])

  // ---- go to: a line, a cursor, a sql_id (and execution), a time --------------------------------------------------------
  const goToHelp = doc.wallOffsetUs
    ? `a line (12345, L12345, :12345), a cursor (#140124363561040), a sql_id (9h8pw1x9xgbsj, 9h8*) with an execution (9h8pw1x9xgbsj/3), or a time: 1.5s / 250ms / 900us from the start, or a clock time HH:MM:SS[.fff] or YYYY-MM-DD HH:MM:SS in the trace file's zone (${fmtTz(doc.tzOffsetMin)}). A bare number is a line, a time needs its unit.`
    : 'a line (12345, L12345, :12345), a cursor (#140124363561040), a sql_id (9h8pw1x9xgbsj, 9h8*) with an execution (9h8pw1x9xgbsj/3), or a time: 1.5s / 250ms / 900us from the start. A bare number is a line, a time needs its unit.'
  const goToSqlId = async (g: { sqlId: string; prefix: boolean; execNo?: number }) => {
    const { ids, stmts } = statementsOf(doc, g.sqlId, g.prefix)
    if (ids.length === 0) return `no statement ${g.sqlId}${g.prefix ? '*' : ''}`
    if (ids.length > 1) return `${g.sqlId}* is ambiguous: ${ids.slice(0, 3).join(', ')}${ids.length > 3 ? `, … (${ids.length})` : ''}`
    const name = ids[0]
    if (g.execNo === undefined) {
      const lines = stmts.map((s) => stmtLineIn(doc, file, s)).filter((l): l is number => l !== undefined)
      if (lines.length > 0) { jump(Math.min(...lines)); return null }
      const c = doc.statements[stmts[0]]?.cursors[0]
      const f = c === undefined ? -1 : doc.fileOfCursor(c)
      return f >= 0 && f !== file && doc.traceFileName(f) ? `${name} is not in this file (it is in ${doc.traceFileName(f)})` : `${name} has no cursor in this file`
    }
    const source = sourceOf(doc)
    const rows: { line: number; file: number }[] = []
    let total = 0, partial = false
    for (const s of stmts) {
      const page = await source.executions(s, ALL_SCOPE)
      total += page.total; partial ||= page.partial
      for (const r of page.rows) if (r.execNo === g.execNo && r.line > 0) rows.push({ line: r.line, file: doc.fileOfCtx(r.ctx) })
    }
    const row = rows.find((r) => r.file === file) ?? rows[0]
    if (!row) return `no execution ${g.execNo} of ${name} (${fmtInt(total)} ${total === 1 ? 'execution' : 'executions'}${partial ? ', the slowest listed' : ''})`
    if (row.file === file) jump(row.line)
    else actions.openLinesAt(row.file, row.line)
    return null
  }
  /** Go to what the palette parsed; what cannot be reached is said in the status bar. */
  const runGoTo = async (text: string) => {
    const setJumpError = (msg: string) => flash(msg, true)
    const g = parseGoTo(text, doc.span.firstTim, doc.wallOffsetUs ? doc : undefined)
    if (!g) { setJumpError(doc.wallOffsetUs ? 'use a line, #cursor, sql_id[/N], 1.5s, 250ms, 900us or 14:03:07.250' : 'use a line, #cursor, sql_id[/N], 1.5s, 250ms or 900us'); return }
    try {
      switch (g.kind) {
        case 'line':
          if (total > 0 && g.line > total) setJumpError(`line ${fmtInt(g.line)} is past the end (${fmtInt(total)} lines)`)
          else jump(Math.max(1, g.line))
          break
        case 'cursor': {
          const line = cursorLine(doc, file, g.number, selected)
          if (line === undefined) setJumpError(`no cursor #${g.number} in this file`)
          else jump(line)
          break
        }
        case 'sqlid': { const err = await goToSqlId(g); if (err) setJumpError(err); break }
        case 'tim': jump(await lineAt(client, file, g.tim)); break
      }
    } catch (e) { if (!aborted(e)) setJumpError(e instanceof Error ? e.message : String(e)) }
  }

  const files = doc.file.files ?? []
  const selectedFiles = useStore((s) => s.files)
  const running = ui.status === 'running'
  const nextHitDisabled = ui.hits.length === 0

  /** the search options away from their defaults; the Show and dim settings away from theirs (the Display button's badge) */
  const optionCount = Number(ui.caseSensitive) + Number(ui.regex) + Number(ui.fromHere) + Number(scope !== 'file')
  const displayCount = displayBadge(prefs, LINES_PREFS_DEFAULTS)
  const deltaParts = deltaChipParts(deltaMode === 'off' ? 'highlight' : deltaMode, prefs.deltaMs, delta && !delta.error ? delta.lines.length : undefined, delta?.truncated)
  const deltaChip = deltaParts.what + deltaParts.doing
  const laneName = LANE_COLORS.find((c) => c.id === prefs.laneColor)?.label ?? prefs.laneColor
  const filterChip = filterChipParts(filterIds.map(nameOf), stmtFilter ? stmtFilter.lines : undefined, stmtFilter?.truncated)
  const toggleMute = (name: string) => setPrefs({ mute: muteSet.has(name) ? prefs.mute.filter((m) => m !== name) : [...prefs.mute, name] })

  /** The Actions menu's first group: what the owner does with the selected line itself. */
  const lineActs: LineAct[] = [
    { label: 'Bookmark', kbd: 'b', on: bmSet.has(selected), keepOpen: true, run: () => toggleBookmark(selected), title: 'bookmark this line (b; a right-click on a line number does it too)' },
    ...(notesOn ? [{ label: 'Note…', on: noting === selected, run: () => setNoting(noting === selected ? null : selected), title: 'a note on this line (bookmarks it)' }] : []),
    { label: 'Highlight its statement', kbd: 'l', on: lineStmt() >= 0 && hl.slots.has(lineStmt()), keepOpen: true, run: highlightLine, title: "tint every line of this statement's cursors in a colour of its own (l; again: stop). m / M step between the runs of the highlighted statements" },
    { label: 'Focus on its cursor', kbd: 'f', on: ui.focus !== null, keepOpen: true, run: toggleFocus, title: "dim the rows outside this line's cursor (f); Esc clears" },
    { label: 'Copy line', run: () => copyLine(selected), title: "copy the line's text" },
    ...(canLink ? [{ label: 'Copy link to line', run: () => copyLink(selected), title: 'copy a link that opens this line' }] : []),
    { label: 'Inspect', kbd: 'i', on: inspecting, run: () => togglePanel('line'), title: 'the side panel with this line translated: every field named, with its unit and meaning (i)' },
  ]

  // ---- the command palette ----------------------------------------------------------------------------------------------
  const commands = (): Command[] => {
    const out: Command[] = []
    const add = (group: string, id: string, label: string, run: () => void, more: Partial<Command> = {}) => out.push({ id, label, group, run, ...more })
    for (const [what, label, keys] of STEPS) {
      add('Step', `step:${what}:next`, `Next ${label}`, () => stepNext(what, label, 1), { keys: keys[0] })
      add('Step', `step:${what}:prev`, `Previous ${label}`, () => stepNext(what, label, -1), { keys: keys[1] })
    }
    const gapOff = prefs.gapMs <= 0
    add('Step', 'step:gap:next', `Next gap ≥ ${fmtInt(prefs.gapMs)} ms`, () => stepGap(1), { keys: 't', disabled: gapOff, hint: gapOff ? 'off: set the threshold in Display' : undefined })
    add('Step', 'step:gap:prev', 'Previous gap', () => stepGap(-1), { keys: 'T', disabled: gapOff })
    add('Step', 'step:mark:next', 'Next highlight', () => stepMark(1), { keys: 'm', disabled: !hasStops, hint: hl.ids.length === 0 ? 'highlight a statement first (l, L)' : 'the next run of lines of a highlighted statement' })
    add('Step', 'step:mark:prev', 'Previous highlight', () => stepMark(-1), { keys: 'M', disabled: !hasStops, hint: 'the previous run of lines of a highlighted statement' })
    add('Step', 'step:hit:next', 'Next hit', () => stepHit(1), { keys: 'F3', disabled: nextHitDisabled })
    add('Step', 'step:hit:prev', 'Previous hit', () => stepHit(-1), { keys: 'Shift+F3', disabled: nextHitDisabled })
    add('Step', 'step:hot:next', 'Next hot spot', () => stepHot(1), { keys: 'j', hint: 'a line of 1 % of the traced time or more (formatted view)' })
    add('Step', 'step:hot:prev', 'Previous hot spot', () => stepHot(-1), { keys: 'J' })
    add('Step', 'step:exec:next', 'Next execution', () => stepExec(1), { keys: 'd' })
    add('Step', 'step:exec:prev', 'Previous execution', () => stepExec(-1), { keys: 'D' })

    for (const p of SEARCH_PRESETS) add('Search', `preset:${p.label}`, `Preset: ${p.label.replace('N ms', `${prefs.threshold} ms`)}`, () => runPreset(p))
    add('Search', 'search:focus', 'Focus the search box', () => { searchRef.current?.focus(); searchRef.current?.select() }, { keys: '/' })

    for (const t of PANEL_TABS) add('Panel', `panel:${t.tab}`, `Side panel: ${t.label}`, () => togglePanel(t.tab), { checked: prefs.inspect && ui.tab === t.tab, keys: t.tab === 'line' ? 'i' : undefined })
    add('Panel', 'view:follow', 'Follow the pointer in the Line tab', () => setPrefs({ follow: !prefs.follow }), { checked: prefs.follow })

    for (const t of SHOW_TOGGLES) add('View', `view:${t.key}`, t.label, () => setPrefs({ [t.key]: !prefs[t.key] }), { checked: prefs[t.key], keys: t.keys })
    for (const g of MUTE_GROUPS) add('View', `mute:${g.name}`, `Dim ${g.label}`, () => toggleMute(g.name), { checked: muteSet.has(g.name) })
    add('View', 'view:highlight', "Highlight the line's statement", highlightLine, { keys: 'l', hint: 'every line of its cursors tinted in a colour of its own (again: stop)', checked: lineStmt() >= 0 && hl.slots.has(lineStmt()) })
    add('View', 'view:picker', 'Highlight or filter statements…', openPicker, { keys: 'L', disabled: !prefs.readable, hint: prefs.readable ? "choose from the file's statements (several at once)" : 'formatted view' })
    add('View', 'view:filterline', "Filter by the line's statement", filterLine, { keys: 'F', hint: 'show only the lines of its cursors (again: stop)', checked: lineStmt() >= 0 && filtered.has(lineStmt()) })
    add('View', 'view:clearhl', 'Stop highlighting', () => set({ hl: NO_HL }), { disabled: hl.ids.length === 0, hint: hl.ids.length > 0 ? `${fmtInt(hl.ids.length)} highlighted` : undefined })
    add('View', 'view:clearfilter', 'Stop filtering by statement', () => setFilter([]), { disabled: filterIds.length === 0, hint: filterIds.length > 0 ? `${fmtInt(filterIds.length)} ${filterIds.length === 1 ? 'statement' : 'statements'}` : undefined })
    add('View', 'view:readable', 'Formatted view', () => switchPrefs('readable', { readable: !prefs.readable }), { checked: prefs.readable, keys: 'v' })
    add('View', 'view:rddelta', 'Δ column (formatted)', () => setPrefs({ rdDelta: !prefs.rdDelta }), { checked: prefs.rdDelta, disabled: !prefs.readable, hint: 'the time from the pin or the line before' })
    for (const c of LANE_COLORS) add('View', `colour:${c.id}`, `Colour the lanes by: ${c.label}`, () => setPrefs({ laneColor: c.id }), { checked: prefs.laneColor === c.id, disabled: !prefs.readable, hint: 'formatted view' })
    for (const m of DELTA_MODES) add('View', `delta:${m.mode}`, `Δ filter: ${m.label}`, () => setPrefs({ deltaMode: m.mode }), { checked: deltaMode === m.mode, hint: m.mode === 'off' ? undefined : `rows with Δ ≥ ${fmtMs(prefs.deltaMs)}` })
    add('View', 'view:repeats', 'Fold repeats', toggleRepeats, { checked: prefs.foldRepeats, keys: 'r', disabled: !prefs.readable, hint: 'identical waits, long wait blocks, fetch loops' })
    add('Line', 'line:pin', ui.pin?.line === selected ? 'Unpin line' : 'Pin line (Δ from it)', () => togglePin(selected), { keys: 'a', checked: ui.pin?.line === selected })
    if (ui.pin) add('Line', 'line:unpin', `Unpin line ${fmtInt(ui.pin.line)}`, () => set({ pin: null }))
    add('View', 'view:focus', 'Focus cursor', toggleFocus, { checked: ui.focus !== null, keys: 'f', hint: "dims the other cursors' rows" })
    add('View', 'view:keys', 'Keyboard shortcuts', () => set({ keys: true }), { keys: '?' })

    add('Folds', 'fold:this', 'Fold this block', () => onFold(selected), { keys: 'z' })
    add('Folds', 'fold:none', 'Unfold all', () => set({ folds: [] }), { keys: 'Z', disabled: ui.folds.length === 0 })
    add('Folds', 'fold:binds', 'Fold all BINDS blocks', () => void foldAll('binds'))
    add('Folds', 'fold:stat', 'Fold all STAT dumps', () => void foldAll('stat'))

    add('Line', 'line:bookmark', 'Bookmark', () => toggleBookmark(selected), { keys: 'b', checked: bmSet.has(selected) })
    if (notesOn) add('Line', 'line:note', 'Note', () => setNoting(selected))
    add('Line', 'line:copy', 'Copy line', () => copyLine(selected))
    if (canLink) add('Line', 'line:link', 'Copy permalink', () => copyLink(selected))
    add('Line', 'line:open', 'Open statement', openStatement, { keys: 'Enter' })
    add('Line', 'line:copyrange', 'Copy selected lines', copySelLines, { keys: 'y', disabled: !ui.lines, hint: ui.lines ? undefined : `Shift+click or Shift+arrows select a range, ${MOD}click adds a line` })
    add('Line', 'line:clearrange', 'Clear selected lines', () => set({ lines: null }), { keys: 'Esc', disabled: !ui.lines })
    if (ui.back.length > 0) add('Line', 'line:back', `Back to line ${fmtInt(ui.back[ui.back.length - 1])}`, goBack, { keys: 'Backspace' })
    return out
  }
  /** Go to commands for what is typed in the palette: a line, a cursor, a statement or a time. */
  const goToCommands = (q: string): Command[] => {
    const text = q.trim()
    const g = parseGoTo(text, doc.span.firstTim, doc.wallOffsetUs ? doc : undefined)
    if (!g) return []
    const label = g.kind === 'line' ? `Go to line ${g.line}` : g.kind === 'cursor' ? `Go to cursor #${g.number}`
      : g.kind === 'sqlid' ? `Go to statement ${g.sqlId}${g.prefix ? '*' : ''}${g.execNo !== undefined ? ` execution ${g.execNo}` : ''}` : `Go to time ${text}`
    return [{ id: `goto:${text}`, label, group: 'Go to', run: () => void runGoTo(text) }]
  }

  // ---- the side panel's tabs ------------------------------------------------------------------------------------------------
  const tabCount = (t: PanelTab) => (t === 'hits' && ui.status !== 'idle' ? ui.hits.length : t === 'bookmarks' ? bookmarks.length : 0)
  const hitsTab = (
    <>
      <div className="lines-side-tools">
        <p className="small muted lines-status" aria-live="polite">
          {ui.status === 'idle' && 'Type in the search box and press Enter.'}
          {running && `Searching… ${fmtInt(ui.hits.length)} hits`}
          {ui.status === 'done' && ui.end && ui.searched.scope !== 'file' && `${fmtInt(ui.hits.length)} hits ${ui.searched.scope === 'window' ? "in the window's lines" : "within the highlighted statements' lines"}${ui.end.truncated ? ` — stopped at the limit of ${fmtInt(SEARCH_LIMIT)} hits` : ''}`}
          {ui.status === 'done' && ui.end && ui.searched.scope === 'file' && `${fmtInt(ui.hits.length)} hits in ${fmtInt(ui.end.scanned)} lines${ui.end.truncated ? ` — stopped at the limit of ${fmtInt(SEARCH_LIMIT)} hits` : ''}`}
          {ui.status === 'done' && ui.end && !ui.end.done && ' (the server ended early)'}
          {ui.status === 'cancelled' && `Cancelled after ${fmtInt(ui.hits.length)} hits.`}
          {ui.status === 'error' && <span className="lines-error">{ui.error}</span>}
        </p>
        <span className="lines-tools">
          <button className="quiet icon-btn" onClick={() => set({ groupHits: !ui.groupHits })} aria-pressed={ui.groupHits} aria-label="Group the hits by statement" title="list the hits by statement: the biggest group first, a click opens its hits"><LayersIcon /></button>
          <button className="quiet icon-btn" onClick={() => stepHit(-1)} disabled={nextHitDisabled} aria-label="Previous hit" title="previous hit (Shift+F3)"><ChevronUpIcon /></button>
          <button className="quiet icon-btn" onClick={() => stepHit(1)} disabled={nextHitDisabled} aria-label="Next hit" title="next hit (F3)"><ChevronDownIcon /></button>
        </span>
      </div>
      <RecentSearches recent={ui.recent} active={ui.status === 'idle' ? null : ui.searched} onPick={restoreSearch} onRerun={rerunSearch} />
      {ui.status !== 'idle' && <HitList doc={doc} hits={ui.hits} count={ui.hits.length} selected={selected} q={ui.searched.q} regex={ui.searched.regex} caseSensitive={ui.searched.caseSensitive}
        stmtOf={stmtOfHit} onNeed={needStmt} group={ui.groupHits} open={ui.openGroups} onToggle={toggleGroup} onGo={jump} />}
    </>
  )

  return (
    <section className="lines" aria-label="Trace lines" onKeyDown={onKeyDown}>
      <div className="lines-bar">
        <div className="lines-row">
          {/* the first control of the bar: how the rows read (the formatted view's own controls follow it) */}
          <span className="lines-mode" role="radiogroup" aria-label="How the rows read" title="raw: the trace as written; formatted: every line parsed into columns (what it is, its detail, a time bar, Δ, the clock) with each cursor's lines in a lane of its statement's colour; the raw text is in the tooltips and the hover card (v switches)">
            <button type="button" role="radio" className={switching === 'readable' && prefs.readable ? 'busy-src' : undefined} aria-checked={!prefs.readable} aria-pressed={!prefs.readable} onClick={() => switchPrefs('readable', { readable: false })} aria-label="Raw" title="Raw: the trace as written (v)">
              <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M1 2h12M1 6h9M1 10h11" stroke="currentColor" strokeWidth="1.4" fill="none" /></svg><span className="tb-label tb-f4">Raw</span>
            </button>
            <button type="button" role="radio" className={switching === 'readable' && !prefs.readable ? 'busy-src' : undefined} aria-checked={prefs.readable} aria-pressed={prefs.readable} onClick={() => switchPrefs('readable', { readable: true })} aria-label="Formatted" title="Formatted: every line parsed into columns (v)">
              <svg width="14" height="12" viewBox="0 0 14 12" aria-hidden="true"><path d="M1 1v10" stroke="currentColor" strokeWidth="2.2" /><path d="M4.5 2h3M9.5 2h3.5M4.5 6h3M9.5 6h2M4.5 10h3M9.5 10h3" stroke="currentColor" strokeWidth="1.4" fill="none" /></svg><span className="tb-label tb-f4">Formatted</span>
            </button>
            <kbd className="tb-f4" aria-hidden="true">v</kbd>
          </span>
          {/* the search: Enter runs it, the box's × clears it; the options, the scope and the ready-made searches are in its menu */}
          <form className="lines-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch() }}>
            <input type="search" ref={searchRef} value={ui.q} placeholder="Search the trace text" aria-label="Search the trace text" title="Enter searches (/ from the viewer)" onChange={(e) => set({ q: e.target.value })} />
            {running && <button type="button" className="quiet" onClick={cancelSearch} title="cancel the search (Esc)">Cancel</button>}
            <ToolbarMenu label="Options" badge={optionCount > 0 ? String(optionCount) : undefined} title="how the search matches, where it looks, and ready-made searches" className="tbmenu-sm tbmenu-start" open={ui.optionsMenu} onOpenChange={(optionsMenu) => set({ optionsMenu })}>
              <div className="lines-view">
                <h4>Match</h4>
                <div className="tb-items">
                  <MenuItem on={ui.caseSensitive} onClick={() => set({ caseSensitive: !ui.caseSensitive })} title="match case">Case sensitive</MenuItem>
                  <MenuItem on={ui.regex} onClick={() => set({ regex: !ui.regex })} title="regular expression (RE2)">Regular expression</MenuItem>
                  <MenuItem on={ui.fromHere} onClick={() => set({ fromHere: !ui.fromHere })} title="search from the selected line instead of line 1">From the selected line</MenuItem>
                </div>
                <h4>Scope</h4>
                <div className="tb-items" role="radiogroup" aria-label="Scope">
                  <MenuItem on={scope === 'file'} onClick={() => set({ scope: 'file' })} title="search the whole file">Whole file</MenuItem>
                  <MenuItem on={scope === 'window'} disabled={!winRange} onClick={() => set({ scope: 'window' })} title={winRange ? `search only the lines of the time window (${fmtInt(winRange.from)}–${fmtInt(winRange.to)})` : 'needs a time window with lines in this file (set one in the Timeline)'}>
                    Time window <small className="muted">{winRange ? `lines ${fmtInt(winRange.from)}–${fmtInt(winRange.to)}` : '(none)'}</small>
                  </MenuItem>
                  <MenuItem on={scope === 'stmt'} disabled={!hasStops} onClick={() => set({ scope: 'stmt' })} title={hasStops ? `search only the lines between the first and the last line of the highlighted statements (${fmtInt(stops!.first)}–${fmtInt(stops!.last)}), and only the lines of those statements` : 'needs highlighted statements with lines in this file (l highlights the selected line\'s statement, L chooses from the list)'}>
                    Highlighted statements <small className="muted">{hl.ids.length === 0 ? '(none)' : hl.ids.length === 1 ? nameOf(hl.ids[0]) : `${fmtInt(hl.ids.length)} statements`}</small>
                  </MenuItem>
                </div>
                <h4>Ready-made searches</h4>
                <div className="tb-items">
                  {SEARCH_PRESETS.map((p) => <MenuItem key={p.label} onClick={() => runPreset(p)} title="fill the box with its regular expression and search">{p.label.replace('N ms', `${prefs.threshold} ms`)}</MenuItem>)}
                </div>
                <label className="lines-view-row lines-view-gap" title="the threshold of the slow waits and calls searches">
                  <span>Threshold</span>
                  <input type="number" min={0.001} step={1} value={prefs.threshold} aria-label="Threshold in milliseconds for the slow waits and calls searches" onChange={(e) => setPrefs({ threshold: Number(e.target.value) })} />
                  <span>ms</span>
                </label>
              </div>
            </ToolbarMenu>
          </form>
          {readable && (
            <span className="lines-hot" role="group" aria-label="Hot spots">
            <span className="tb-label tb-f3" title={`a line that took 1 % of the traced time (${fmtDur(hotUs)}) or more`}>Hot spot</span>
            <button type="button" className="quiet" onClick={() => stepHot(-1)} disabled={!hasHot} aria-label="Previous hot spot"
              title={hasHot ? `the previous line that took 1 % of the traced time (${fmtDur(hotUs)}) or more (J)` : 'no line takes 1 % of the traced time or more'}>↑</button>
            <button type="button" className="quiet" onClick={() => stepHot(1)} disabled={!hasHot} aria-label="Next hot spot"
              title={hasHot ? `the next line that took 1 % of the traced time (${fmtDur(hotUs)}) or more: ${fmtInt(hot!.lines.length)} in this file (j)` : 'no line takes 1 % of the traced time or more'}>↓</button>
            {hasHot && <small title={`${fmtInt(hot!.lines.length)} lines in this file took 1 % of the traced time or more`}>{fmtInt(hot!.lines.length)}</small>}
          </span>
          )}
          <ToolbarMenu label="Step" title="the next or previous run of a highlighted statement, call, wait, cursor parse, STAT dump, session marker, error, commit, idle gap or search hit (the letter keys)" className="tbmenu-sm tbmenu-start" open={ui.stepMenu} onOpenChange={(stepMenu) => set({ stepMenu })}>
            <ul className="lines-steps">
              <li title="the first line of the next (previous) run of lines of a highlighted statement: every line of its cursors, whichever statement of the set it is">
                <button type="button" className="quiet" onClick={() => stepMark(-1)} disabled={!hasStops} aria-label="Previous highlight" title="the previous run of lines of a highlighted statement (M)">‹</button>
                <span>highlighted statement<small className="muted">{hl.ids.length === 0 ? 'highlight one with l or L' : !stops ? 'looking up…' : stops.starts.length === 0 ? 'nothing in this file' : `${hl.ids.length === 1 ? nameOf(hl.ids[0]) : `${fmtInt(hl.ids.length)} statements`} · ${fmtInt(stops.starts.length)}${stops.truncated ? '+' : ''} ${stops.starts.length === 1 ? 'run' : 'runs'}`}</small></span>
                <button type="button" className="quiet" onClick={() => stepMark(1)} disabled={!hasStops} aria-label="Next highlight" title="the next run of lines of a highlighted statement (m)">›</button>
              </li>
              <li className="sep" role="separator" />
              {STEPS.map(([what, label, keys]) => (
                <li key={what}>
                  <button type="button" className="quiet" onClick={() => stepNext(what, label, -1)} aria-label={`Previous ${label}`} title={`previous ${label} (${keys[1]})`}>‹</button>
                  <span>{label}</span>
                  <button type="button" className="quiet" onClick={() => stepNext(what, label, 1)} aria-label={`Next ${label}`} title={`next ${label} (${keys[0]})`}>›</button>
                </li>
              ))}
              <li>
                <button type="button" className="quiet" onClick={() => stepGap(-1)} disabled={prefs.gapMs <= 0} aria-label="Previous idle gap" title="previous idle gap (T); the threshold is in the Display tab">‹</button>
                <span>{prefs.gapMs > 0 ? `gap ≥ ${fmtInt(prefs.gapMs)} ms` : 'gap (off)'}</span>
                <button type="button" className="quiet" onClick={() => stepGap(1)} disabled={prefs.gapMs <= 0} aria-label="Next idle gap" title="next idle gap (t); the threshold is in the Display tab">›</button>
              </li>
              <li>
                <button type="button" className="quiet" onClick={() => stepHit(-1)} disabled={nextHitDisabled} aria-label="Previous search hit" title="previous search hit (Shift+F3)">‹</button>
                <span>search hit</span>
                <button type="button" className="quiet" onClick={() => stepHit(1)} disabled={nextHitDisabled} aria-label="Next search hit" title="next search hit (F3)">›</button>
              </li>
            </ul>
          </ToolbarMenu>
          <ToolbarMenu label="Keyboard shortcuts" className="tbmenu-sm tb-cmd" open={ui.keys} onOpenChange={(keys) => set({ keys })} onButton={() => set({ palette: true, keys: false })}
            title={`Go to ${goToHelp}\n\nOr run any command of the view. ? lists the keys.`}
            button={<><span className="tb-label tb-f1">Go to or run a command</span><kbd>{MOD}K</kbd></>}>
            <KeyMap />
          </ToolbarMenu>
          {files.length > 1 && (
            <select value={file} onChange={(e) => actions.openLinesAt(Number(e.target.value), 1)} aria-label="Input file">
              {files.map((f, i) => (isSelected(selectedFiles, i) || i === file ? <option key={i} value={i}>{f.name}{isSelected(selectedFiles, i) ? '' : ' (not selected)'}{win && fileInWindow(f, win) ? ' · in window' : ''}</option> : null))}
            </select>
          )}
          {/* state chips: only when not the default; the Δ filter's says what it is doing and turns it off, a click opens the Display tab where it is set */}
          {deltaMode !== 'off' && (
            <span className={'lines-state lines-dstate' + (deltaLoading ? ' busy-src' : '')}>
              <button type="button" className="lines-state-main" onClick={openDisplay} aria-label={`Δ filter: ${deltaChip}`}
                title={`${deltaChip}: the rows whose time from the timed line before (a call, wait, cursor parse or commit) is ${fmtMs(prefs.deltaMs)} or more are ${deltaMode === 'highlight' ? 'tinted' : 'the only ones shown'}; click to change it in the Display tab`}>
                {deltaParts.what}<span className="tb-f2">{deltaParts.doing}</span>
              </button>
              <button type="button" className="lines-state-x" onClick={() => setPrefs({ deltaMode: 'off' })} aria-label="Turn the Δ filter off" title="turn the Δ filter off">×</button>
            </span>
          )}
          {readable && prefs.foldRepeats && (
            <span className={'lines-state lines-rstate' + (switching === 'repeats' || repeatsLoading ? ' busy-src' : '')}>
              <button type="button" className="lines-state-main" onClick={openDisplay} aria-label="Fold repeats is on"
                title="Fold repeats is on: runs of identical waits, long wait blocks and loops of small fetches are folded into one line each (r); click to change it in the Display tab">
                <RepeatIcon /><span className="tb-f1">Repeats folded</span>
              </button>
              <button type="button" className="lines-state-x" onClick={toggleRepeats} aria-label="Turn Fold repeats off" title="turn Fold repeats off (r)">×</button>
            </span>
          )}
          {readable && prefs.laneColor !== 'stmt' && (
            <span className="lines-state lines-lstate">
              <button type="button" className="lines-state-main" onClick={openDisplay} aria-label={`The lanes are coloured by ${laneName}`}
                title={`The lanes are coloured by ${laneName} (not by statement): ${LANE_COLORS.find((c) => c.id === prefs.laneColor)?.title ?? ''}. Click to change it in the Display tab`}>
                <LanesIcon /><span className="tb-f3">Lanes</span><span className="tb-f2">{`: ${laneName}`}</span>
              </button>
              <button type="button" className="lines-state-x" onClick={() => setPrefs({ laneColor: LINES_PREFS_DEFAULTS.laneColor })} aria-label="Colour the lanes by statement again" title="colour the lanes by statement again">×</button>
            </span>
          )}
          {filterIds.length > 0 && (
            <span className={'lines-state lines-sstate' + (stmtLoading ? ' busy-src' : '')}>
              <button type="button" className="lines-state-main" onClick={() => (readable ? set({ picker: true, keys: false }) : flash('the statement list is in the formatted view (v); the filter stays on'))}
                aria-label={filterChipText(filterChip)}
                title={`${filterChipText(filterChip)}: only the lines of ${filterIds.length === 1 ? "this statement's" : "these statements'"} cursors are shown, the rest folded (z shows them). ${readable ? 'Click to change the statements' : 'The statement list is in the formatted view'} (L)`}>
                <FunnelIcon /><span className="tb-f3">{filterChip.word}</span>{filterChip.name}<span className="tb-f4">{filterChip.unit}</span><span className="tb-f2">{filterChip.doing}</span>
              </button>
              <button type="button" className="lines-state-x" onClick={() => setFilter([])} aria-label="Stop filtering by statement" title="stop filtering by statement">×</button>
            </span>
          )}
          {ui.pin && (
            <span className="lines-pin" title="Δ is measured from the pinned line (a pins the selected line)">
              <span className="tb-label tb-f3">Δ from </span><button type="button" className="link" onClick={() => jump(ui.pin!.line)}><b>line {fmtInt(ui.pin.line)}</b></button>
              <button type="button" className="quiet" onClick={() => set({ pin: null })} aria-label="Unpin" title="unpin: Δ from the line before again">×</button>
            </span>
          )}
          {win && (
            <span className="lines-win" role="group" aria-label="Time window">
              <b className="tb-label tb-f2">Window</b>
              <button type="button" className="quiet" disabled={!winRange} onClick={() => winRange && jump(winRange.from, !block)} aria-label="Go to the first line of the time window" title="the first line of the time window set in the Timeline">⇤ start</button>
              <button type="button" className="quiet" disabled={!winRange} onClick={() => winRange && jump(winRange.to, !block)} aria-label="Go to the last line of the time window" title="the last line of the time window set in the Timeline">end ⇥</button>
              <small className={'tb-label tb-f2 ' + (winLines?.failed ? 'lines-error' : 'muted')} aria-live="polite" title={winRange ? `${fmtInt(winRange.to - winRange.from + 1)} lines` : undefined}>
                {winLines === null ? '…' : winLines.failed ? 'window lines unavailable' : winRange ? `lines ${fmtInt(winRange.from)}–${fmtInt(winRange.to)}` : 'no lines of the window in this file'}
              </small>
            </span>
          )}
          {/* the raw view has no overview row: its highlight chip stays (the formatted view's is the statement picker's button) */}
          {!readable && hl.ids.length > 0 && (
            <span className={'lines-hl' + (lone === null ? ' many' : '')} style={{ '--hl': lone !== null ? hlColors.get(lone) : 'var(--ink-3)' } as React.CSSProperties}
              title={`the lines of ${lone !== null ? 'this statement\'s' : 'these statements\''} cursors are tinted${lone !== null ? ' in its colour' : `, each in a colour of its own (${hl.ids.slice(0, 12).map(nameOf).join(', ')}${hl.ids.length > 12 ? ', …' : ''})`}, with a bar at the start edge of their calls and waits; l highlights (or stops highlighting) the selected line's statement, m / M step between the runs of their lines${counts?.note ? `; ${counts.note}` : ''}`}>
              {lone !== null
                ? <i aria-hidden="true" />
                : <span className="sp-sws" aria-hidden="true">{hl.ids.slice(0, 4).map((id) => <i key={id} style={{ background: hlColors.get(id) }} />)}</span>}
              {lone !== null ? (
                <>
                  Highlighting
                  <button type="button" className="link mono" onClick={() => goToStmt(lone)} title="go to its first line in this file">{nameOf(lone)}</button>
                  {counts && <small>{counts.calls + counts.waits === 0 ? 'nothing in this file' : `${fmtInt(counts.calls)} ${counts.calls === 1 ? 'call' : 'calls'} · ${fmtInt(counts.waits)} ${counts.waits === 1 ? 'wait' : 'waits'}`}</small>}
                </>
              ) : <b>{fmtInt(hl.ids.length)} highlighted</b>}
              <button type="button" className="quiet" onClick={() => set({ hl: NO_HL })} aria-label="Stop highlighting" title="stop highlighting">×</button>
            </span>
          )}
          {/* the Display button: the settings that are set once and left live in the side panel's Display tab; the badge says Show / dim settings are off their defaults */}
          <button type="button" className="quiet tb-display" aria-pressed={displayOpen} onClick={() => togglePanel('display')} aria-label="Display"
            title={`Display: ${readable ? 'colour the lanes, Fold repeats, the Δ column, ' : ''}the Δ filter, what the rows show, the line colours, the bulk folds${readable ? ' and the key to the formatted rows' : ''}, in the side panel${displayCount > 0 ? `\n${displayCount} ${displayCount === 1 ? 'setting differs' : 'settings differ'} from the defaults (Show and dim)` : ''}`}>
            <SlidersIcon /><span className="tb-label tb-f3">Display</span>{displayCount > 0 && <small>{displayCount}</small>}
          </button>
          <button type="button" className="quiet tb-panel" aria-pressed={prefs.inspect && ui.tab !== 'display'} onClick={() => togglePanel()} aria-label="Side panel" title="the side panel: the selected line translated, the outline of the file, the search hits and the bookmarks (i opens it at the line)">
            <PanelIcon />{!prefs.inspect && ui.status !== 'idle' && ui.hits.length > 0 && <small>{fmtInt(ui.hits.length)}</small>}
          </button>
        </div>
      </div>

      {noting !== null && (() => {
        const bm = bookmarks.find((b) => b.line === noting)
        return (
          <NoteEditor key={noting} draftKey={`line:${file}:${noting}`} label={`Note on line ${noting}`} title={`Note on line ${fmtInt(noting)}${bm?.label ? `: ${bm.label}` : ''}`} text={bm?.note}
            onSave={(t) => { actions.setBookmarkNote(file, noting, t, preview(cache.line(noting)?.text ?? '', 80).trim()); setNoting(null); set({ tab: 'bookmarks' }); setPrefs({ inspect: true }) }}
            onCancel={() => setNoting(null)}
            onDelete={bm?.note ? () => { actions.setBookmarkNote(file, noting, ''); setNoting(null) } : undefined} />
        )
      })()}
      <LinesAt doc={doc} file={file} at={at} text={at ? cache.line(at.line)?.text ?? '' : ''} goTo={jump} note={flash} block={atBlock} onCopyRange={copyRange} lineActs={lineActs} />

      {readable && (() => {
        const f = doc.file.files?.[file]
        const [from, to] = f && f.lastTim > f.firstTim ? [f.firstTim, f.lastTim] : [doc.span.firstTim, doc.span.lastTim]
        const sl = cache.line(selected)
        return (
          <ReadableOverview doc={doc} file={file} stats={fstats} from={from} to={to} at={sl ? lineTim(sl.text, LINE_KINDS[sl.kind] ?? 'unknown') : undefined} hl={hl} colors={hlColors} filtered={filtered} counts={counts}
            viewBus={overviewBus} lastView={overviewView} pickerOpen={ui.picker} onPickerOpen={(picker) => set({ picker })}
            onToggleHl={(id) => set({ hl: toggleHl(hl, id) })} onToggleFilter={toggleFilter}
            onSetHl={(ids, on) => set({ hl: setHl(hl, ids, on) })} onSetFilter={setFiltered}
            onGo={(id) => { set({ picker: false }); goToStmt(id) }} onClear={() => { set({ hl: NO_HL, filter: [] }) }}
            onTim={(tim) => { lineAt(client, file, tim).then((l) => jump(l), (e: unknown) => flash(e instanceof Error ? e.message : String(e), true)) }} />
        )
      })()}
      <div className={'lines-body' + (prefs.inspect ? ' with-inspect' : '')} style={prefs.inspect ? ({ '--w': `${prefs.inspectW}px` } as React.CSSProperties) : undefined}>
        <div className={'lines-main' + (busy ? ' busy' : '') + (readable && prefs.laneColor !== 'stmt' ? ' lanes-by-line' : '')} aria-busy={busy || undefined} style={readable ? columnVars(prefs.cols) as React.CSSProperties : undefined}>
          <LineViewer cache={cache} readable={readableRows} hlColors={hlColors} tables={tables} bands={sqlBands} deltaCol={prefs.rdDelta} spanUs={fileSpan} onAct={onAct} top={readable ? <FormattedHead cols={prefs.cols} delta={prefs.rdDelta} spanUs={fileSpan} onCols={(cols) => setPrefs({ cols })} /> : undefined} bookmarks={bmSet} notes={noteSet} selected={selected} wrap={prefs.wrap} heat={prefs.heat} times={times} gap={gapOf} inlays={inlays} mutedKinds={mutedKinds} focusCursor={ui.focus ?? undefined} links={prefs.links} onRef={onRef} refTitle={refTitle} head={head} card={inspecting ? undefined : lineCard} folds={allFolds} deltaHits={deltaHits} foldable={foldable} onFold={onFold} highlight={highlight} range={winRange} selLines={ui.lines} onLines={(l) => set({ lines: l })} onHover={following ? setHover : undefined} apiRef={apiRef} topRef={topRef}
            onViewChange={onViewChange} side={prefs.strip && total > 0 ? <StripHost bus={viewBus} last={lastView} total={total} layers={stripLayers} shape={stripShape} selected={selected} hits={stripHits} bookmarks={bmSet} range={winRange} hot={readable ? hot?.lines : undefined} onJump={jump} onScrub={scrubTo} /> : undefined}
            onSelect={select} onBookmark={toggleBookmark} onError={setLoadError} />
          {total === 0 && !loadError && <p className="lines-overlay muted"><Shimmer>Loading trace lines…</Shimmer></p>}
          {loadError && <p className="lines-overlay lines-error" role="alert">Could not read the trace: {loadError}</p>}
        </div>
        {prefs.inspect && <>
          <ResizeHandle anchor="end" className="resizer-lines-inspect" label="Resize the side panel" min={256} maxFrac={0.5} onChange={(px) => setPrefs({ inspectW: px ?? 400 })} />
          <aside className="lines-side" aria-label="Side panel">
            <PanelHead tab={ui.tab} counts={{ hits: tabCount('hits'), bookmarks: tabCount('bookmarks') }} onTab={(tab) => set({ tab })} onClose={() => setPrefs({ inspect: false })} />
            <div className={`lines-side-body lines-side-${ui.tab}`} role="tabpanel">
              {ui.tab === 'line' && <LineInspector doc={doc} cache={cache} line={inspectedLine} at={inspAt} decodeCtx={decodeCtx} note={flash} onRef={onInspectRef} follow={prefs.follow} onFollow={(v) => setPrefs({ follow: v })} />}
              {ui.tab === 'display' && (
                <LinesDisplay readable={readable} prefs={prefs} setPrefs={setPrefs} laneKey={laneKey} onFoldRepeats={toggleRepeats} repeatsBusy={switching === 'repeats' || repeatsLoading}
                  delta={{ loading: deltaLoading, count: delta?.lines.length, truncated: delta?.truncated, error: delta?.error, what: deltaWhat }}
                  mute={muteSet} onMute={toggleMute} onFoldAll={(what) => void foldAll(what)} onUnfoldAll={() => set({ folds: [] })} canUnfold={ui.folds.length > 0} hotUs={hotUs} spanUs={fileSpan} />
              )}
              {ui.tab === 'hits' && hitsTab}
              {ui.tab === 'asrun' && <AsRun doc={doc} client={client} file={file} line={ui.asRunLine || selected} onGo={(l) => { set({ asRunLine: l }); jump(l) }} note={flash} />}
              {ui.tab === 'outline' && <LinesOutline doc={doc} file={file} selected={selected} state={ui.outline} onState={(outline) => set({ outline })} onGo={jump} />}
              {ui.tab === 'bookmarks' && (
                <BookmarkList bookmarks={allBookmarks} fileName={fileName}
                  onGo={(b) => (b.file === file ? jump(b.line) : actions.openLinesAt(b.file, b.line))}
                  onLabel={(b, label) => actions.addBookmark(b.file, b.line, label)}
                  onRemove={(b) => actions.removeBookmark(b.file, b.line)}
                  onNote={notesOn ? (b) => { if (b.file !== file) actions.openLinesAt(b.file, b.line); else { jump(b.line); setNoting(b.line) } } : undefined} />
              )}
            </div>
          </aside>
        </>}
      </div>

      <CommandPalette open={ui.palette} commands={ui.palette ? commands() : []} dynamic={goToCommands} onClose={() => set({ palette: false })} placeholder="Go to a line, #cursor, sql_id or time, or type a command" />

      {popup && <LinePopover doc={doc} file={file} popup={popup} ctx={decodeCtx} actions={actions} onClose={() => setPopup(null)} goTo={jump} />}

      <div className="lines-status-bar small">
        <span className="mono">{fmtInt(selected)} / {fmtInt(total)}</span>
        {ui.back.length > 0 && <button type="button" className="link" onClick={goBack} title="back to the line before the last jump (Backspace in the viewer)">← back to line {fmtInt(ui.back[ui.back.length - 1])}</button>}
        {ui.focus !== null && (
          <span className="lines-focus">
            {(() => {
              const c = doc.cursors[ui.focus]
              const s = c ? doc.statements[c.statement] : undefined
              return `focus: cursor ${c ? `#${c.number}` : `id ${ui.focus}`}${s ? ` of ${doc.label(s)}` : ''} · Esc clears`
            })()}
            <button type="button" className="quiet" onClick={() => set({ focus: null })} aria-label="Clear the cursor focus" title="clear the cursor focus">×</button>
          </span>
        )}
        {ui.lines && selSum && (
          <span className="lines-range">
            <span>{ui.lines.length === 1 && ui.lines[0].from === ui.lines[0].to ? 'line' : 'lines'} <b className="mono">{describeLines(ui.lines, fmtInt)}</b> · {describeRange(selSum)}</span>
            <button type="button" className="quiet" onClick={copySelLines} title="copy the selected lines (y)">Copy</button>
            <button type="button" className="quiet" onClick={() => set({ lines: null })} aria-label="Clear the selected lines" title="clear the selected lines (Esc)">×</button>
          </span>
        )}
        {ui.folds.length > 0 && (
          <span className="muted">
            {fmtInt(ui.folds.length)} folded <button type="button" className="link" onClick={() => set({ folds: [] })} title="show the lines of every folded block (Z)">unfold all</button>
          </span>
        )}
        {copiedNote.shown && <span key={copiedNote.shown.msg} role="status" aria-live="polite" className={(copiedNote.shown.bad ? 'lines-error' : 'lines-copied') + ' flash-note' + (copiedNote.closing ? ' closing' : '')}>{copiedNote.shown.msg}</span>}
        {files.length > 1 && <span className="muted lines-file">{doc.traceFileName(file)}</span>}
      </div>
    </section>
  )
}
