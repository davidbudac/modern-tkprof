import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent } from 'react'
import type { TraceDoc } from '../data/doc'
import { PageCache } from '../data/linecache'
import { fetchLinesAnnot, lineAt, linePermalink, objectsAt, parseJump, search, type AtObjects, type SearchEnd, type SearchHit } from '../data/lines'
import { fmtInt, fmtTz, preview } from '../data/format'
import { copyText } from '../data/clipboard'
import { sourceOf, useSourceQuery } from '../data/source'
import { StmtLink } from '../components/StmtLink'
import { LineViewer, type ViewerApi } from '../components/LineViewer'
import { PaneToggle } from '../components/PaneToggle'
import { lineToneLegend } from '../components/colors'
import { useActions, useClient, useStore, useStoreApi } from '../state/session'
import type { Store } from '../state/store'
import { BookmarkList, HitList } from './LinesPanel'
import { isSelected } from '../data/fileset'
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
  searched: { q: string; regex: boolean; caseSensitive: boolean }
  tab: 'hits' | 'bookmarks'
  panel: boolean
  wrap: boolean
  jump: string
}

const uis = new WeakMap<Store, Map<number, LinesUi>>()
function uiOf(store: Store, file: number): LinesUi {
  let m = uis.get(store)
  if (!m) uis.set(store, (m = new Map()))
  let u = m.get(file)
  if (!u) {
    m.set(file, (u = {
      top: 0, seqSeen: -1, jumpedFor: null, q: '', regex: false, caseSensitive: false, fromHere: false,
      hits: [], end: null, status: 'idle', error: null, searched: { q: '', regex: false, caseSensitive: false },
      tab: 'hits', panel: true, wrap: false, jump: '',
    }))
  }
  return u
}

const SEARCH_LIMIT = 10_000
const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/** Binary search in an ascending array: the first index with `a[i] > x`. */
function firstAbove(a: ArrayLike<number>, x: number): number {
  let lo = 0, hi = a.length
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid] > x) hi = mid; else lo = mid + 1 }
  return lo
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
  const allBookmarks = useStore((s) => s.bookmarks)
  const notesOn = useStore((s) => s.annotationsEnabled)
  const [noting, setNoting] = useState<number | null>(null) // the line whose note is being written
  const ui = uiOf(store, file)
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const set = useCallback((patch: Partial<LinesUi>) => { Object.assign(ui, patch); bump() }, [ui])

  const cache = useMemo(() => new PageCache((from, n, signal) => fetchLinesAnnot(client, file, from, n, signal)), [client, file])
  useEffect(() => cache.subscribe(bump), [cache])
  useEffect(() => () => cache.close(), [cache])

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

  const select = useCallback((line: number) => { actions.setLinesLine(file, line); resolveAt(line, true) }, [actions, file, resolveAt])
  const goTo = useCallback((line: number) => {
    apiRef.current?.reveal(line, 'center')
    select(line)
  }, [select])

  // a deep link or jump from elsewhere moves the view; coming back to the tab keeps the position
  useEffect(() => {
    if (lv.seq !== ui.seqSeen) { ui.seqSeen = lv.seq; goTo(lv.line); return }
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

  const stepMark = (dir: 1 | -1) => {
    if (markLines.length === 0) return
    const from = selected
    const i = firstAbove(markLines, from)
    const to = dir === 1 ? markLines[i] : markLines[(markLines[i - 1] === from ? i - 2 : i - 1)]
    if (to !== undefined && to !== from) goTo(to)
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
  const runSearch = () => {
    if (ui.q === '') return
    searchCtl.current?.abort()
    const ac = (searchCtl.current = new AbortController())
    const hits: SearchHit[] = []
    const from = ui.fromHere ? Math.min(Math.max(1, selected + 1), Math.max(1, cache.total || selected + 1)) : 1
    set({ hits, end: null, status: 'running', error: null, tab: 'hits', panel: true, searched: { q: ui.q, regex: ui.regex, caseSensitive: ui.caseSensitive } })
    let timer = 0
    const flush = () => { timer = 0; if (searchCtl.current === ac) bump() }
    const finish = (patch: Partial<LinesUi>) => { window.clearTimeout(timer); if (searchCtl.current === ac) set(patch) }
    search(client, { file, q: ui.q, regex: ui.regex, caseSensitive: ui.caseSensitive, from, limit: SEARCH_LIMIT }, (h) => {
      hits.push(h)
      if (hits.length === 1) { flush(); goTo(h.line) } else if (!timer) timer = window.setTimeout(flush, 100)
    }, ac.signal).then(
      (end) => finish({ end, status: 'done' }),
      (e: unknown) => finish(aborted(e) ? { status: 'cancelled' } : { status: 'error', error: e instanceof Error ? e.message : String(e) }),
    )
  }
  const cancelSearch = () => searchCtl.current?.abort()
  useEffect(() => () => searchCtl.current?.abort(), [])

  const stepHit = (dir: 1 | -1) => {
    const hs = ui.hits
    if (hs.length === 0) return
    const i = firstAbove(hs.map((h) => h.line), selected) // the hit list is in line order
    const to = dir === 1 ? hs[i] : hs[hs[i - 1]?.line === selected ? i - 2 : i - 1]
    if (to) goTo(to.line)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && ui.status === 'running') { e.stopPropagation(); cancelSearch() }
    else if (e.key === 'F3') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1) }
  }

  // ---- per-line actions: copy the text, copy a link that opens the line ---------------------------------------------------
  const copyTimer = useRef(0)
  useEffect(() => () => window.clearTimeout(copyTimer.current), [])
  const copyWhat = useCallback(async (what: string, text: string) => {
    const ok = await copyText(text)
    setCopied(ok ? `Copied ${what}` : `Could not copy ${what}`)
    window.clearTimeout(copyTimer.current)
    copyTimer.current = window.setTimeout(() => setCopied(null), 1500)
  }, [])
  const copyLine = useCallback((line: number) => {
    const text = cache.line(line)?.text
    if (text !== undefined) void copyWhat(`line ${fmtInt(line)}`, text)
  }, [cache, copyWhat])
  const copyLink = useCallback((line: number) => void copyWhat(`link to line ${fmtInt(line)}`, linePermalink(window.location, file, line)), [copyWhat, file])
  const canLink = useStore((s) => s.lineRefTarget !== 'view') // the desktop shell has no URL to link to
  const highlight = ui.status !== 'idle' && ui.searched.q !== '' ? ui.searched : null

  // ---- jump to time ----------------------------------------------------------------------------------------------------
  const jumpToTim = async (tim: number) => {
    try { setJumpError(null); goTo(await lineAt(client, file, tim)) } catch (e) { setJumpError(e instanceof Error ? e.message : String(e)) }
  }
  const runJump = () => {
    const tim = parseJump(ui.jump, doc.span.firstTim, doc.wallOffsetUs ? doc : undefined)
    if (tim === null) setJumpError(doc.wallOffsetUs ? 'use 1.5s, 250ms, 900us, a tim or a clock time 14:03:07.250' : 'use 1.5s, 250ms, 900us or an absolute tim')
    else void jumpToTim(tim)
  }

  const files = doc.file.files ?? []
  const selectedFiles = useStore((s) => s.files)
  const selStmt = at?.objs.stmt !== undefined && at.objs.stmt >= 0 ? doc.statements[at.objs.stmt] : undefined
  const o = at?.objs
  const planLine = o && o.planLine >= 0 ? doc.planLines[o.planLine] : undefined
  const waitEvent = (() => {
    if (!o || o.wait < 0 || !at) return undefined
    const name = /nam='([^']*)'/.exec(cache.line(at.line)?.text ?? '')?.[1]
    const id = name === undefined ? -1 : doc.events.findIndex((e) => e.name === name)
    return id >= 0 ? { id, name: name! } : name === undefined ? undefined : { id: -1, name }
  })()
  const running = ui.status === 'running'
  const nextHitDisabled = ui.hits.length === 0

  return (
    <section className="lines" aria-label="Trace lines" onKeyDown={onKeyDown}>
      <div className="lines-bar">
        {files.length > 1 && (
          <select value={file} onChange={(e) => actions.openLinesAt(Number(e.target.value), 1)} aria-label="Input file">
            {files.map((f, i) => (isSelected(selectedFiles, i) || i === file ? <option key={i} value={i}>{f.name}{isSelected(selectedFiles, i) ? '' : ' (not selected)'}</option> : null))}
          </select>
        )}
        <form className="lines-search" role="search" onSubmit={(e) => { e.preventDefault(); runSearch() }}>
          <input type="search" value={ui.q} placeholder="Search the trace text" aria-label="Search the trace text" onChange={(e) => set({ q: e.target.value })} />
          <span className="seg" role="group" aria-label="Search options">
            <button type="button" aria-pressed={ui.caseSensitive} onClick={() => set({ caseSensitive: !ui.caseSensitive })} title="match case">Aa</button>
            <button type="button" aria-pressed={ui.regex} onClick={() => set({ regex: !ui.regex })} title="regular expression (RE2)">.*</button>
            <button type="button" aria-pressed={ui.fromHere} onClick={() => set({ fromHere: !ui.fromHere })} title="search from the selected line instead of line 1">from here</button>
          </span>
          {running
            ? <button type="button" onClick={cancelSearch} title="Esc">Cancel</button>
            : <button type="submit" disabled={ui.q === ''}>Search</button>}
        </form>
        <form className="lines-jump" onSubmit={(e) => { e.preventDefault(); runJump() }}>
          <input type="text" value={ui.jump} placeholder={doc.wallOffsetUs ? 'Time: 1.5s, 14:03:07' : 'Time: 1.5s, 250ms, tim'} title={doc.wallOffsetUs ? `1.5s / 250ms / 900us from the start, a tim, or a clock time HH:MM:SS[.fff] or YYYY-MM-DD HH:MM:SS in the trace file's zone (${fmtTz(doc.tzOffsetMin)})` : '1.5s / 250ms / 900us from the start, or a tim'} aria-label="Jump to time" onChange={(e) => set({ jump: e.target.value })} />
          <button type="submit" disabled={ui.jump.trim() === ''}>Go</button>
          <button type="button" disabled={!win} onClick={() => win && void jumpToTim(win.startTim)} title="the first line of the time window set in the Timeline">Window start</button>
          {jumpError && <small className="lines-note" role="alert">{jumpError}</small>}
        </form>
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
          <button className="quiet" onClick={() => set({ panel: !ui.panel })} aria-pressed={ui.panel} title="hits and bookmarks">Panel</button>
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
      <div className="lines-at" aria-live="polite">
        {!at && <span className="muted">Click a line to see the statement, execution and wait it belongs to.</span>}
        {at && o && (
          <>
            <span className="mono">line {fmtInt(at.line)}</span>
            <span className={'lines-kind'}>{o.kind}</span>
            {selStmt && at.objs.stmt >= 0 && <><StmtLink doc={doc} id={at.objs.stmt} /><span className="muted lines-sql">{preview(selStmt.text, 90)}</span></>}
            {o.execNo >= 0 && <span>exec #{o.execNo}</span>}
            {o.cursor >= 0 && <span className="muted">cursor #{doc.cursors[o.cursor]?.number ?? o.cursor}</span>}
            {waitEvent && (waitEvent.id >= 0
              ? <button className="link" onClick={() => actions.selectEvent(waitEvent.id)} title="open this wait event">{waitEvent.name}</button>
              : <span>{waitEvent.name}</span>)}
            {o.bindSet >= 0 && <span>bind set #{o.bindSet}</span>}
            {planLine && <span title={planLine.object}>plan line {planLine.id}: {planLine.op}{planLine.object ? ` ${planLine.object}` : ''}</span>}
            {o.stmt < 0 && o.wait < 0 && o.bindSet < 0 && o.planLine < 0 && <span className="muted">no statement at this line</span>}
          </>
        )}
      </div>

      <div className={'lines-body' + (ui.panel ? ' has-panel' : '')}>
        <div className="lines-main">
          <LineViewer cache={cache} marks={marks} bookmarks={bmSet} notes={noteSet} selected={selected} wrap={ui.wrap} highlight={highlight} onCopy={copyLine} onLink={canLink ? copyLink : undefined} apiRef={apiRef} topRef={topRef}
            onSelect={select} onBookmark={toggleBookmark} onError={setLoadError} />
          {total === 0 && !loadError && <p className="lines-overlay muted">Loading trace lines…</p>}
          {loadError && <p className="lines-overlay lines-error" role="alert">Could not read the trace: {loadError}</p>}
        </div>
        <PaneToggle open={ui.panel} onToggle={() => set({ panel: !ui.panel })} label="hits and bookmarks" className="lines-toggle" />
        {ui.panel && (
          <aside className="lines-panel" aria-label="Hits and bookmarks">
            <div className="lines-panel-head">
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
                  {ui.status === 'done' && ui.end && `${fmtInt(ui.hits.length)} hits in ${fmtInt(ui.end.scanned)} lines${ui.end.truncated ? ` — stopped at the limit of ${fmtInt(SEARCH_LIMIT)} hits` : ''}`}
                  {ui.status === 'done' && ui.end && !ui.end.done && ' (the server ended early)'}
                  {ui.status === 'cancelled' && `Cancelled after ${fmtInt(ui.hits.length)} hits.`}
                  {ui.status === 'error' && <span className="lines-error">{ui.error}</span>}
                </p>
                {ui.status !== 'idle' && <HitList hits={ui.hits} count={ui.hits.length} selected={selected} q={ui.searched.q} regex={ui.searched.regex} caseSensitive={ui.searched.caseSensitive} onGo={goTo} />}
              </>
            )}
            {ui.tab === 'bookmarks' && (
              <BookmarkList bookmarks={allBookmarks} fileName={fileName}
                onGo={(b) => (b.file === file ? goTo(b.line) : actions.openLinesAt(b.file, b.line))}
                onLabel={(b, label) => actions.addBookmark(b.file, b.line, label)}
                onRemove={(b) => actions.removeBookmark(b.file, b.line)}
                onNote={notesOn ? (b) => { if (b.file !== file) actions.openLinesAt(b.file, b.line); else { goTo(b.line); setNoting(b.line) } } : undefined} />
            )}
          </aside>
        )}
      </div>

      <div className="lines-status-bar small">
        <span className="mono">{fmtInt(selected)} / {fmtInt(total)}</span>
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
