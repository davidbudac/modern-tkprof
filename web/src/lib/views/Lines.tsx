import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import type { TraceDoc } from '../data/doc'
import { LINE_KINDS, PageCache } from '../data/linecache'
import { ALL_SCOPE, cursorLine, fetchLinesAnnot, lineAt, linePermalink, objectsAt, parseGoTo, sameSearch, search, SEARCH_PRESETS, statementsOf, stmtLineIn, type AtObjects, type LineKind, type RecentSearch, type SearchEnd, type SearchHit, type SearchScope } from '../data/lines'
import { fmtInt, fmtTz, fmtWall, preview } from '../data/format'
import { decodeLine, type DecodeContext, type LineDecode } from '../data/linefields'
import { copyText } from '../data/clipboard'
import { sourceOf, useSourceQuery } from '../data/source'
import { LineViewer, type ViewerApi } from '../components/LineViewer'
import { ToolbarMenu } from '../components/ToolbarMenu'
import { lineToneLegend } from '../components/colors'
import { useActions, useClient, useStore, useStoreApi } from '../state/session'
import { activeBlock, type Store } from '../state/store'
import { BookmarkList, HitList, KeyMap, RecentSearches } from './LinesPanel'
import { LinesAt } from './LinesAt'
import { isSelected } from '../data/fileset'
import { fileInWindow, windowLineRange, type LineRange } from '../data/windowlines'
import { NoteEditor } from '../components/Note'
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
  presets: boolean
  /** the Presets menu's threshold for the slow waits and calls (ms) */
  threshold: number
  /** the key map popover */
  keys: boolean
  /** the Mute popover, and the kind groups (`MUTE_GROUPS`) it dims */
  muteMenu: boolean
  mute: Set<string>
  tab: 'hits' | 'bookmarks'
  panel: boolean
  wrap: boolean
  /** the elapsed-time bars in the gutter */
  heat: boolean
  jump: string
  /** the lines the jumps left, newest last (capped) */
  back: number[]
  /** the selected line as this view last set it (the line a jump leaves) */
  cur: number
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
      presets: false, threshold: 10, keys: false, muteMenu: false, mute: new Set(),
      tab: 'hits', panel: false, wrap: false, heat: true, jump: '', back: [], cur: 0,
    }))
  }
  return u
}

const SEARCH_LIMIT = 10_000
const BACK_LIMIT = 50
const RECENT_LIMIT = 5

/** The Mute menu's groups: the line kinds each one dims. */
const MUTE_GROUPS: { name: string; label: string; kinds: LineKind[] }[] = [
  { name: 'framing', label: 'Framing (blank, header, separator)', kinds: ['blank', 'header', 'separator'] },
  { name: 'binds', label: 'Binds', kinds: ['binds', 'bind-line'] },
  { name: 'stat', label: 'STAT lines', kinds: ['stat'] },
  { name: 'markers', label: 'Markers (***)', kinds: ['marker'] },
  { name: 'waits', label: 'Waits', kinds: ['wait'] },
]
const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** Binary search in an ascending array: the first index with `a[i] > x`. */
function firstAbove(a: ArrayLike<number>, x: number): number {
  let lo = 0, hi = a.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] > x) hi = mid; else lo = mid + 1 }
  return lo
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
  const set = useCallback((patch: Partial<LinesUi>) => { Object.assign(ui, patch); bump() }, [ui])

  const cache = useMemo(() => new PageCache((from, n, signal) => fetchLinesAnnot(client, file, from, n, signal)), [client, file])
  useEffect(() => cache.subscribe(bump), [cache])
  useEffect(() => () => cache.close(), [cache])
  // a live session's next snapshot: the file has more lines
  const rev = useStore((s) => s.rev)
  const shownRev = useRef(rev)
  useEffect(() => {
    if (rev === shownRev.current) return
    shownRev.current = rev
    void cache.refresh()
  }, [cache, rev])

  const apiRef = useRef<ViewerApi | null>(null)
  const topRef = useRef(ui.top)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [at, setAt] = useState<{ line: number; objs: AtObjects } | null>(null)
  const [jumpError, setJumpError] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  const selected = lv.line
  const total = cache.total

  // ---- what is at a line ------------------------------------------------------------------------------------------
  const atTimer = useRef(0)
  const atCtl = useRef<AbortController | null>(null)
  const resolveAt = useCallback((line: number, dispatch: boolean) => {
    window.clearTimeout(atTimer.current)
    atTimer.current = window.setTimeout(async () => {
      atCtl.current?.abort()
      const ac = (atCtl.current = new AbortController())
      try {
        const page = await cache.load(cache.pageOf(line)) // the line's text names a wait's event
        const objs = await objectsAt(client, file, line, ac.signal)
        if (ac.signal.aborted) return
        setAt({ line, objs })
        if (!dispatch) return
        const sel = store.getState().selection
        if (objs.stmt >= 0 && objs.stmt !== sel.stmt) { ui.jumpedFor = objs.stmt; actions.pickStmt(objs.stmt) }
        if (objs.stmt >= 0 && objs.cursor >= 0 && objs.execNo >= 0) actions.selectExec({ cursor: objs.cursor, execNo: objs.execNo })
        if (objs.wait >= 0) {
          const text = page.texts[line - page.from] ?? ''
          const name = /nam='([^']*)'/.exec(text)?.[1]
          const ev = name === undefined ? -1 : doc.events.findIndex((e) => e.name === name)
          if (ev >= 0) actions.selectEvent(ev)
        }
      } catch (e) { if (!aborted(e)) setAt(null) }
    }, 60)
  }, [cache, client, file, store, actions, doc, ui])
  useEffect(() => () => { window.clearTimeout(atTimer.current); atCtl.current?.abort() }, [])

  const select = useCallback((line: number, dispatch = true) => { ui.cur = line; actions.setLinesLine(file, line); resolveAt(line, dispatch) }, [actions, file, resolveAt, ui])
  const goTo = useCallback((line: number, dispatch = true) => {
    apiRef.current?.reveal(line, 'center')
    select(line, dispatch)
  }, [select])
  /** A jump (a search hit, a mark, a bookmark, Go to, a line card action, a deep link): `goTo` that remembers the line it left for Back. */
  const jump = useCallback((line: number, dispatch = true) => {
    const left = ui.cur
    if (left > 0 && left !== line && ui.back[ui.back.length - 1] !== left) { ui.back.push(left); if (ui.back.length > BACK_LIMIT) ui.back.shift(); bump() }
    goTo(line, dispatch)
  }, [ui, goTo])
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
  useEffect(() => () => { ui.top = topRef.current }, [ui])

  // ---- gutter marks of the selected statement ----------------------------------------------------------------------
  const source = sourceOf(doc)
  const marksQ = useSourceQuery(source, `marks:${stmt}`, (signal) => (stmt !== null && source.ready ? source.stmtMarks(stmt, signal) : null), 'marks')
  const { marks, markLines, nCalls, nWaits, partial } = useMemo(() => {
    const m = new Map<number, number>()
    const d = marksQ.data
    if (!d || stmt === null) return { marks: m, markLines: [] as number[], nCalls: 0, nWaits: 0, partial: false }
    let nc = 0, nw = 0
    for (const c of d.calls) if (c.file === file && c.line > 0) { m.set(c.line, (m.get(c.line) ?? 0) | 1); nc++ }
    for (const w of d.waits) if (w.file === file && w.line > 0) { m.set(w.line, (m.get(w.line) ?? 0) | 2); nw++ }
    return { marks: m, markLines: [...m.keys()].sort((a, b) => a - b), nCalls: nc, nWaits: nw, partial: d.partial }
  }, [marksQ.data, stmt, file])

  // opening the tab with a statement selected: start at its first call (not after a click on a line, which selected the statement itself)
  useEffect(() => {
    if (stmt === null || markLines.length === 0 || ui.jumpedFor === stmt || lv.seq !== ui.seqSeen) return
    ui.jumpedFor = stmt
    if (topRef.current < 1 && lv.line <= 1) goTo(markLines[0])
  }, [stmt, markLines, ui, lv.seq, lv.line, goTo])

  const mutedKinds = useMemo(() => new Set(MUTE_GROUPS.filter((g) => ui.mute.has(g.name)).flatMap((g) => g.kinds.map((k) => LINE_KINDS.indexOf(k)))), [ui.mute])
  /** this file's PARSING IN CURSOR lines and error lines, ascending */
  const cursorLines = useMemo(() => doc.cursors.filter((c) => c.line > 0 && doc.fileOfCursor(c.id) === file).map((c) => c.line).sort((a, b) => a - b), [doc, file])
  const errorLines = useMemo(() => doc.errors.filter((e) => e.line > 0 && doc.fileOfCtx(e.context) === file).map((e) => e.line).sort((a, b) => a - b), [doc, file])

  const stepMark = (dir: 1 | -1) => {
    if (markLines.length === 0) return
    const from = selected
    const i = firstAbove(markLines, from)
    const to = dir === 1 ? markLines[i] : markLines[(markLines[i - 1] === from ? i - 2 : i - 1)]
    if (to !== undefined && to !== from) jump(to)
  }

  // ---- bookmarks -------------------------------------------------------------------------------------------------------
  const bookmarks = useMemo(() => allBookmarks.filter((b) => b.file === file), [allBookmarks, file])
  const bmSet = useMemo(() => new Set(bookmarks.map((b) => b.line)), [bookmarks])
  const noteSet = useMemo(() => new Map(bookmarks.filter((b) => b.note).map((b) => [b.line, b.note!])), [bookmarks])
  const toggleBookmark = useCallback((line: number) => {
    if (store.getState().bookmarks.some((b) => b.file === file && b.line === line)) actions.removeBookmark(file, line)
    else actions.addBookmark(file, line, preview(cache.line(line)?.text ?? '', 80).trim())
  }, [store, actions, file, cache])
  const fileName = useCallback((f: number) => doc.traceFileName(f), [doc])

  // ---- search ----------------------------------------------------------------------------------------------------------
  const searchCtl = useRef<AbortController | null>(null)
  /** The scope that can be searched now: the window needs its lines, the statement its marks. */
  const scopeOf = (want: SearchScope): SearchScope => (want === 'window' && winRange ? 'window' : want === 'stmt' && markLines.length > 0 ? 'stmt' : 'file')
  const scope = scopeOf(ui.scope)
  const runSearch = () => {
    if (ui.q === '') return
    searchCtl.current?.abort()
    const ac = (searchCtl.current = new AbortController())
    const hits: SearchHit[] = []
    const { q, regex, caseSensitive } = ui
    const sc = scopeOf(ui.scope)
    const span: LineRange | null = sc === 'window' ? winRange : sc === 'stmt' ? { from: markLines[0], to: markLines[markLines.length - 1] } : null
    const here = ui.fromHere ? Math.min(Math.max(1, selected + 1), Math.max(1, cache.total || selected + 1)) : 1
    const from = span ? (ui.fromHere && here >= span.from && here <= span.to ? here : span.from) : here
    set({ hits, end: null, status: 'running', error: null, tab: 'hits', panel: true, searched: { q, regex, caseSensitive, scope: sc } })
    let timer = 0
    let clipped = false // the stream was cut at the first hit past the scope's last line
    const flush = () => { timer = 0; if (searchCtl.current === ac) bump() }
    const finish = (patch: Partial<LinesUi>) => { window.clearTimeout(timer); if (searchCtl.current === ac) set(patch) }
    const complete = (end: SearchEnd) => finish({ end, status: 'done', recent: [{ q, regex, caseSensitive, scope: sc, hits, end }, ...ui.recent.filter((r) => !sameSearch(r, { q, regex, caseSensitive, scope: sc }))].slice(0, RECENT_LIMIT) })
    search(client, { file, q, regex, caseSensitive, from, limit: SEARCH_LIMIT }, (h) => {
      if (clipped) return
      if (span && h.line > span.to) { clipped = true; ac.abort(); return }
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
      if (!(ui.threshold > 0)) { flash('the threshold must be a number of milliseconds above 0'); return }
      re = p.re(ui.threshold)
    }
    set({ q: re, regex: true, presets: false })
    runSearch()
  }

  const stepHit = (dir: 1 | -1) => {
    const hs = ui.hits
    if (hs.length === 0) return
    const i = firstAbove(hs.map((h) => h.line), selected) // the hit list is in line order
    const to = dir === 1 ? hs[i] : hs[hs[i - 1]?.line === selected ? i - 2 : i - 1]
    if (to) jump(to.line)
  }

  /** The next / previous line of a sorted list (cursors, errors) after the selected one. */
  const stepSorted = (a: number[], dir: 1 | -1, what: string) => {
    const to = dir === 1 ? a[firstAbove(a, selected)] : a[firstAbove(a, selected - 1) - 1]
    if (to !== undefined) jump(to); else flash(`no ${what} ${dir === 1 ? 'after' : 'before'} line ${fmtInt(selected)}`)
  }
  /** The next / previous line of a kind within the loaded pages (until the engine can answer for the whole file). */
  const stepKind = (kind: LineKind, what: string, dir: 1 | -1) => {
    const to = cache.nextOfKind(selected, LINE_KINDS.indexOf(kind), dir)
    if (to !== undefined) jump(to); else flash(`no ${what} ${dir === 1 ? 'after' : 'before'} line ${fmtInt(selected)} in the loaded pages`)
  }
  const searchRef = useRef<HTMLInputElement>(null)
  const goToRef = useRef<HTMLInputElement>(null)
  /** The viewer's letter keys (no modifier but Shift, viewer focused, not in a text field). */
  const onViewerKey = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    const t = e.target as HTMLElement
    if (!t.closest('.lv') || t.closest('input, textarea, select, button')) return
    const focus = (el: HTMLInputElement | null) => { el?.focus(); el?.select() }
    switch (e.key) {
      case '/': focus(searchRef.current); break
      case 'g': focus(goToRef.current); break
      case 'Enter':
        if (at && at.line === selected && at.objs.stmt >= 0) actions.selectStmt(at.objs.stmt)
        else flash(`no statement at line ${fmtInt(selected)}`)
        break
      case 'm': stepMark(1); break
      case 'M': stepMark(-1); break
      case 'h': set({ heat: !ui.heat }); break
      case ']': stepKind('call', 'call', 1); break
      case '[': stepKind('call', 'call', -1); break
      case 'w': stepKind('wait', 'wait', 1); break
      case 'W': stepKind('wait', 'wait', -1); break
      case 'x': stepKind('xctend', 'commit', 1); break
      case 'X': stepKind('xctend', 'commit', -1); break
      case 'c': stepSorted(cursorLines, 1, 'cursor parse'); break
      case 'C': stepSorted(cursorLines, -1, 'cursor parse'); break
      case 'e': stepSorted(errorLines, 1, 'error'); break
      case 'E': stepSorted(errorLines, -1, 'error'); break
      case '?': set({ keys: !ui.keys }); break
      default: return
    }
    e.preventDefault()
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && ui.status === 'running') { e.stopPropagation(); cancelSearch() }
    else if (e.key === 'F3') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1) }
    else if (e.key === 'Backspace' && !e.ctrlKey && !e.metaKey && !e.altKey && ui.back.length > 0) {
      const t = e.target as HTMLElement
      if (t.closest('.lv') && !t.closest('input, textarea, select')) { e.preventDefault(); goBack() }
    } else onViewerKey(e)
  }

  // ---- per-line actions: copy the text, copy a link that opens the line ---------------------------------------------------
  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
  /** A short note in the status bar. */
  const flash = useCallback((msg: string) => {
    setCopied(msg)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 2500)
  }, [])
  const copyWhat = useCallback(async (what: string, text: string) => {
    const ok = await copyText(text)
    flash(ok ? `Copied ${what}` : `Could not copy ${what}`)
  }, [flash])
  const copyLine = useCallback((line: number) => {
    const text = cache.line(line)?.text
    if (text !== undefined) void copyWhat(`line ${fmtInt(line)}`, text)
  }, [cache, copyWhat])
  const copyLink = useCallback((line: number) => void copyWhat(`link to line ${fmtInt(line)}`, linePermalink(window.location, file, line)), [copyWhat, file])
  const canLink = useStore((s) => s.lineRefTarget !== 'view') // the desktop shell has no URL to link to
  // ---- hover cards: the line decoded with what the trace knows (events, objects, clock) ------------------------------------
  const decodeCtx = useMemo<DecodeContext>(() => {
    const events = new Map(doc.events.map((e) => [e.name, e]))
    let planObjs: Map<number, string> | undefined // obj → object of the plan lines, for traces without a reference bundle
    return {
      eventOf: (name) => events.get(name),
      objectName: (obj) => {
        const named = doc.objectName(obj)
        if (named) return named
        if (!planObjs) planObjs = new Map(doc.planLines.filter((p) => p.obj > 0 && p.object).map((p) => [p.obj, p.object]))
        return planObjs.get(obj)
      },
      clock: (tim) => (doc.wallOffsetUs ? fmtWall(tim + doc.wallOffsetUs, doc.tzOffsetMin, { micros: true }) : undefined),
      firstTim: doc.span.firstTim,
    }
  }, [doc])
  const lineCard = useCallback((_line: number, text: string, kind: number): LineDecode | null => decodeLine(text, LINE_KINDS[kind], decodeCtx), [decodeCtx])
  const highlight = ui.status !== 'idle' && ui.searched.q !== '' ? ui.searched : null

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
  const runGoTo = async () => {
    const g = parseGoTo(ui.jump, doc.span.firstTim, doc.wallOffsetUs ? doc : undefined)
    setJumpError(null)
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

  const panelBody = (
    <>
      <div className="tbpop-head">
        <span className="seg" role="tablist">
          <button role="tab" aria-selected={ui.tab === 'hits'} aria-pressed={ui.tab === 'hits'} onClick={() => set({ tab: 'hits' })}>Hits{ui.hits.length > 0 && ` ${fmtInt(ui.hits.length)}`}</button>
          <button role="tab" aria-selected={ui.tab === 'bookmarks'} aria-pressed={ui.tab === 'bookmarks'} onClick={() => set({ tab: 'bookmarks' })}>Bookmarks{bookmarks.length > 0 && ` ${bookmarks.length}`}</button>
        </span>
        {ui.tab === 'hits' && (
          <span className="lines-tools">
            <button className="quiet" onClick={() => stepHit(-1)} disabled={nextHitDisabled} aria-label="Previous hit" title="previous hit (Shift+F3)">‹</button>
            <button className="quiet" onClick={() => stepHit(1)} disabled={nextHitDisabled} aria-label="Next hit" title="next hit (F3)">›</button>
          </span>
        )}
      </div>
      {ui.tab === 'hits' && (
        <>
          <p className="small muted lines-status" aria-live="polite">
            {ui.status === 'idle' && 'Enter runs a search.'}
            {running && `Searching… ${fmtInt(ui.hits.length)} hits`}
            {ui.status === 'done' && ui.end && ui.searched.scope !== 'file' && `${fmtInt(ui.hits.length)} hits ${ui.searched.scope === 'window' ? "in the window's lines" : "within the marked statement's lines"}${ui.end.truncated ? ` — stopped at the limit of ${fmtInt(SEARCH_LIMIT)} hits` : ''}`}
            {ui.status === 'done' && ui.end && ui.searched.scope === 'file' && `${fmtInt(ui.hits.length)} hits in ${fmtInt(ui.end.scanned)} lines${ui.end.truncated ? ` — stopped at the limit of ${fmtInt(SEARCH_LIMIT)} hits` : ''}`}
            {ui.status === 'done' && ui.end && !ui.end.done && ' (the server ended early)'}
            {ui.status === 'cancelled' && `Cancelled after ${fmtInt(ui.hits.length)} hits.`}
            {ui.status === 'error' && <span className="lines-error">{ui.error}</span>}
          </p>
          <RecentSearches recent={ui.recent} active={ui.status === 'idle' ? null : ui.searched} onPick={restoreSearch} onRerun={rerunSearch} />
          {ui.status !== 'idle' && <HitList hits={ui.hits} count={ui.hits.length} selected={selected} q={ui.searched.q} regex={ui.searched.regex} caseSensitive={ui.searched.caseSensitive} onGo={jump} />}
        </>
      )}
      {ui.tab === 'bookmarks' && (
        <BookmarkList bookmarks={allBookmarks} fileName={fileName}
          onGo={(b) => (b.file === file ? jump(b.line) : actions.openLinesAt(b.file, b.line))}
          onLabel={(b, label) => actions.addBookmark(b.file, b.line, label)}
          onRemove={(b) => actions.removeBookmark(b.file, b.line)}
          onNote={notesOn ? (b) => { if (b.file !== file) actions.openLinesAt(b.file, b.line); else { jump(b.line); setNoting(b.line) } } : undefined} />
      )}
    </>
  )

  return (
    <section className="lines" aria-label="Trace lines" onKeyDown={onKeyDown}>
      <div className="lines-bar">
        {files.length > 1 && (
          <select value={file} onChange={(e) => actions.openLinesAt(Number(e.target.value), 1)} aria-label="Input file">
            {files.map((f, i) => (isSelected(selectedFiles, i) || i === file ? <option key={i} value={i}>{f.name}{isSelected(selectedFiles, i) ? '' : ' (not selected)'}{win && fileInWindow(f, win) ? ' · in window' : ''}</option> : null))}
          </select>
        )}
        <form className="lines-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch() }}>
          <input type="search" ref={searchRef} value={ui.q} placeholder="Search the trace text" aria-label="Search the trace text" onChange={(e) => set({ q: e.target.value })} />
          <span className="seg" role="group" aria-label="Search options">
            <button type="button" aria-pressed={ui.caseSensitive} onClick={() => set({ caseSensitive: !ui.caseSensitive })} title="match case">Aa</button>
            <button type="button" aria-pressed={ui.regex} onClick={() => set({ regex: !ui.regex })} title="regular expression (RE2)">.*</button>
            <button type="button" aria-pressed={ui.fromHere} onClick={() => set({ fromHere: !ui.fromHere })} title="search from the selected line instead of line 1">from here</button>
          </span>
          <span className="seg" role="group" aria-label="Scope">
            <button type="button" aria-pressed={scope === 'file'} onClick={() => set({ scope: 'file' })} title="search the whole file">File</button>
            <button type="button" aria-pressed={scope === 'window'} disabled={!winRange} onClick={() => set({ scope: 'window' })} title={winRange ? `search only the lines of the time window (${fmtInt(winRange.from)}–${fmtInt(winRange.to)})` : 'needs a time window with lines in this file'}>Window</button>
            <button type="button" aria-pressed={scope === 'stmt'} disabled={markLines.length === 0} onClick={() => set({ scope: 'stmt' })} title={markLines.length > 0 ? `search only the lines between the selected statement's first and last mark (${fmtInt(markLines[0])}–${fmtInt(markLines[markLines.length - 1])})` : 'needs a selected statement with marks in this file'}>Statement</button>
          </span>
          {running
            ? <button type="button" onClick={cancelSearch} title="Esc">Cancel</button>
            : <button type="submit" disabled={ui.q === ''}>Search</button>}
        </form>
        <ToolbarMenu label="Presets" title="ready-made searches: errors, hard parses, slow waits and calls, commits, session markers" className="tbmenu-sm tbmenu-start" open={ui.presets} onOpenChange={(presets) => set({ presets })}>
          <ul className="lines-presets">
            {SEARCH_PRESETS.map((p) => (<li key={p.label}><button type="button" className="quiet" onClick={() => runPreset(p)}>{p.label.replace('N ms', `${ui.threshold} ms`)}</button></li>))}
          </ul>
          <label className="lines-threshold small">Threshold <input type="number" min={0.001} step={1} value={ui.threshold} aria-label="Threshold in milliseconds for the slow waits and calls presets" onChange={(e) => set({ threshold: Number(e.target.value) })} /> ms</label>
        </ToolbarMenu>
        <form className="lines-jump" onSubmit={(e) => { e.preventDefault(); void runGoTo() }}>
          <input type="text" ref={goToRef} value={ui.jump} placeholder={doc.wallOffsetUs ? 'Go to: line, #cursor, sql_id, 1.5s, 14:03:07' : 'Go to: line, #cursor, sql_id, 1.5s'} title={goToHelp} aria-label="Go to" onChange={(e) => set({ jump: e.target.value })} />
          <button type="submit" disabled={ui.jump.trim() === ''}>Go</button>
          {jumpError && <small className="lines-note" role="alert">{jumpError}</small>}
        </form>
        {win ? (
          <span className="lines-win" role="group" aria-label="Time window">
            <b>Window</b>
            <button type="button" disabled={!winRange} onClick={() => winRange && jump(winRange.from, !block)} aria-label="Go to the first line of the time window" title="the first line of the time window set in the Timeline">⇤ start</button>
            <button type="button" disabled={!winRange} onClick={() => winRange && jump(winRange.to, !block)} aria-label="Go to the last line of the time window" title="the last line of the time window set in the Timeline">end ⇥</button>
            <small className={winLines?.failed ? 'lines-error' : 'muted'} aria-live="polite" title={winRange ? `${fmtInt(winRange.to - winRange.from + 1)} lines` : undefined}>
              {winLines === null ? '…' : winLines.failed ? 'window lines unavailable' : winRange ? `lines ${fmtInt(winRange.from)}–${fmtInt(winRange.to)}` : 'no lines of the window in this file'}
            </small>
          </span>
        ) : <button type="button" disabled title="the first line of the time window set in the Timeline">Window start</button>}
        <span className="lines-marks" role="group" aria-label="Statement marks">
          <button onClick={() => stepMark(-1)} disabled={markLines.length === 0} title="previous call or wait of the selected statement" aria-label="Previous mark">▲</button>
          <button onClick={() => stepMark(1)} disabled={markLines.length === 0} title="next call or wait of the selected statement" aria-label="Next mark">▼</button>
          <small className="muted" title={partial ? 'the marks are bounded: the 5,000 longest calls and the first 1,000 waits of the statement' : undefined}>
            {stmt === null ? 'select a statement for marks' : `${fmtInt(nCalls)} calls · ${fmtInt(nWaits)} waits${partial ? ' (bounded)' : ''}`}
          </small>
        </span>
        <span className="lines-tools">
          <button className="quiet" onClick={() => toggleBookmark(selected)} aria-pressed={bmSet.has(selected)} title="bookmark the selected line (b)">◆ Bookmark</button>
          {notesOn && <button className="quiet" onClick={() => setNoting(noting === selected ? null : selected)} aria-pressed={noting === selected} title="a note on the selected line (bookmarks it)">✎ Note</button>}
          <button className="quiet" onClick={() => set({ wrap: !ui.wrap })} aria-pressed={ui.wrap} title="wrap long lines">Wrap</button>
          <button className="quiet" onClick={() => set({ heat: !ui.heat })} aria-pressed={ui.heat} title="a bar in the right gutter for the elapsed time of calls and waits">Heat</button>
          <ToolbarMenu label="Mute" badge={ui.mute.size > 0 ? String(ui.mute.size) : undefined} title="dim the rows of some line kinds (line counts and scrolling stay)" className="tbmenu-sm" open={ui.muteMenu} onOpenChange={(muteMenu) => set({ muteMenu })}>
            <div className="lines-mute">
              {MUTE_GROUPS.map((g) => (
                <label key={g.name}><input type="checkbox" checked={ui.mute.has(g.name)} onChange={() => { const m = new Set(ui.mute); if (!m.delete(g.name)) m.add(g.name); set({ mute: m }) }} /> {g.label}</label>
              ))}
            </div>
          </ToolbarMenu>
          <ToolbarMenu label="Keys" title="keyboard shortcuts (?)" className="tbmenu-sm" open={ui.keys} onOpenChange={(keys) => set({ keys })}>
            <KeyMap />
          </ToolbarMenu>
          <ToolbarMenu label="Hits & bookmarks" badge={ui.hits.length + bookmarks.length > 0 ? `${fmtInt(ui.hits.length)} · ${bookmarks.length}` : undefined}
            title="the search hits and the bookmarks" open={ui.panel} onOpenChange={(panel) => set({ panel })}>
            {panelBody}
          </ToolbarMenu>
        </span>
      </div>

      {noting !== null && (() => {
        const bm = bookmarks.find((b) => b.line === noting)
        return (
          <NoteEditor key={noting} label={`Note on line ${noting}`} title={`Note on line ${fmtInt(noting)}${bm?.label ? `: ${bm.label}` : ''}`} text={bm?.note}
            onSave={(t) => { actions.setBookmarkNote(file, noting, t, preview(cache.line(noting)?.text ?? '', 80).trim()); setNoting(null); set({ panel: true, tab: 'bookmarks' }) }}
            onCancel={() => setNoting(null)}
            onDelete={bm?.note ? () => { actions.setBookmarkNote(file, noting, ''); setNoting(null) } : undefined} />
        )
      })()}
      <LinesAt doc={doc} file={file} at={at} text={at ? cache.line(at.line)?.text ?? '' : ''} goTo={jump} note={flash} />

      <div className="lines-body">
        <div className="lines-main">
          <LineViewer cache={cache} marks={marks} bookmarks={bmSet} notes={noteSet} selected={selected} wrap={ui.wrap} heat={ui.heat} mutedKinds={mutedKinds} card={lineCard} highlight={highlight} range={winRange} onCopy={copyLine} onLink={canLink ? copyLink : undefined} apiRef={apiRef} topRef={topRef}
            onSelect={select} onBookmark={toggleBookmark} onError={setLoadError} />
          {total === 0 && !loadError && <p className="lines-overlay muted">Loading trace lines…</p>}
          {loadError && <p className="lines-overlay lines-error" role="alert">Could not read the trace: {loadError}</p>}
        </div>
      </div>

      <div className="lines-status-bar small">
        <span className="mono">{fmtInt(selected)} / {fmtInt(total)}</span>
        {ui.back.length > 0 && <button type="button" className="link" onClick={goBack} title="back to the line before the last jump (Backspace in the viewer)">← back to line {fmtInt(ui.back[ui.back.length - 1])}</button>}
        {copied && <span role="status" aria-live="polite" className="lines-copied">{copied}</span>}
        {files.length > 1 && <span className="muted">{doc.traceFileName(file)}</span>}
        <span className="lines-legend" aria-label="Line colours">
          {lineToneLegend.map((l) => <span key={l.tone}><i style={{ background: `var(${l.token})` }} />{l.label}</span>)}
          {nCalls + nWaits > 0 && <span><i className="mk" />marks of the selected statement</span>}
        </span>
      </div>
    </section>
  )
}
