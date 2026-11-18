import { Fragment, type CSSProperties, useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import type { DiagNode, DiagSource } from '../../data/diag'
import { outlineStoreOf } from '../../data/diagoutline'
import { LINE_KINDS, PageCache } from '../../data/linecache'
import type { OptAnnotations } from '../../data/opt'
import { stepLine } from '../../data/optindex'
import { hitIndex, hitsIn } from '../../data/optsearch'
import { fmtInt } from '../../data/format'
import { inTextField } from '../../shell/viewKeys'
import { usePersisted } from '../../state/persist'
import { LineViewer, type RowHighlight, type ViewerApi } from '../../components/LineViewer'
import { LineStrip, type StripBand } from '../../components/LineStrip'
import { ResizeHandle } from '../../components/ResizeHandle'
import { PaneToggle } from '../../components/PaneToggle'
import { ToolbarMenu } from '../../components/ToolbarMenu'
import { BookOpenIcon, BookmarkIcon, ChevronDownIcon, ChevronUpIcon, ListTreeIcon } from '../../components/icons'
import { DiagOutline } from './DiagOutline'
import { DiagGuide } from './DiagGuide'
import { DiagFacts } from './DiagFacts'
import { DiagBookmarks } from './DiagBookmarks'
import { ReadingHost } from './ReadingHost'
import { searchCountText, useDiagSearch, type DiagSearchState } from './useDiagSearch'
import { readingView } from './readings'
import '../../styles/lines.css'
import '../../styles/opt.css'
import '../../styles/diag.css'

export interface DiagViewProps {
  /** where the file's facts, outline, readings and text come from (HTTP in the apps, the report's document in the standalone page, memory in tests) */
  source: DiagSource
  /** bookmarks and notes on lines; omitted, the view keeps its own in memory */
  annotations?: OptAnnotations
  /**
   * Show this node and/or that line of the file (a jump from the annotations list, from a link). A new request is one with another `seq` (or another
   * node or line); the view takes the first one when it is given at mount.
   */
  goTo?: { node?: string; line?: number; seq?: number }
  /** "Open as SQL trace" (the desktop): offered beside the note that the file holds 10046 records */
  onOpenAs10046?(): void
}

type LTab = 'outline' | 'bookmarks'
type Mode = 'reading' | 'text'

/** The side panels: dragged widths in px (null = the CSS default) and whether each is shown; persisted for every dump file. */
interface Panes { lw: number | null; rw: number | null; l: boolean; r: boolean }
const PANES: Panes = { lw: null, rw: null, l: true, r: true }

interface Ui {
  /** the selected line (0 none) */
  sel: number
  /** the selected node: what the guide and the reading are about. Only a selection changes it; scrolling does not */
  node: string | null
  mode: Mode
  q: string
  re: boolean
  cs: boolean
  hitCur: number
  ltab: LTab
  keys: boolean
  goText: string
  top: number
}
type Patch = Partial<Ui> | ((s: Ui) => Partial<Ui>)
const reduce = (s: Ui, p: Patch): Ui => ({ ...s, ...(typeof p === 'function' ? p(s) : p) })
const freshUi = (): Ui => ({ sel: 0, node: null, mode: 'text', q: '', re: false, cs: false, hitCur: 0, ltab: 'outline', keys: false, goText: '', top: 0 })

/** What a view keeps while another tab is shown (the component unmounts): one per source. The outline store is kept beside it (`outlineStoreOf`). */
const kept = new WeakMap<DiagSource, Ui>()
/** Sources whose first outline levels were opened already. */
const started = new WeakSet<DiagSource>()

const CACHE_PAGES = 40
const NO_NOTES: ReadonlyMap<number, string> = new Map()
const EMPTY_Q: DiagSearchState = { q: '', regex: false, caseSensitive: false }

function useMemoryAnnotations(): OptAnnotations {
  const [m, setM] = useState<ReadonlyMap<number, string>>(NO_NOTES)
  return useMemo<OptAnnotations>(() => ({
    bookmarks: m,
    toggle: (l) => setM((o) => { const n = new Map(o); if (n.has(l)) n.delete(l); else n.set(l, ''); return n }),
    setNote: (l, t) => setM((o) => new Map(o).set(l, t)),
    remove: (l) => setM((o) => { const n = new Map(o); n.delete(l); return n }),
  }), [m])
}

const k = (...a: string[]) => <>{a.map((x) => <kbd key={x}>{x}</kbd>)}</>
const KEY_ROWS: [string, React.ReactNode][] = [
  ['Search', k('/')], ['Next, previous hit', <>{k('Enter', 'Shift+Enter')} in the box, {k('F3', 'Shift+F3')}</>], ['Go to a line', k('g')],
  ['Bookmark the line', k('b')], ['Move the selection', <>{k('↑', '↓')}, {k('PageUp', 'PageDown')}, {k('Home', 'End')} in the text</>],
  ['Reading | Text', k('v')], ['This list', k('?')],
]

/** The line map's bands: the top-level nodes, each in a shade of its kind (a section darker than the lines between). */
function bandsOf(nodes: readonly DiagNode[]): StripBand[] {
  let k = 0
  return nodes.map((n) => {
    const plain = n.kind === 'header' || n.kind === 'other' || n.kind === 'trace10046'
    return { from: n.from, to: n.to, alpha: plain ? (n.kind === 'trace10046' ? 0.1 : 0.04) : k++ % 2 ? 0.1 : 0.2 }
  })
}

const PLAIN = new Set([LINE_KINDS.indexOf('diagnostic')])

/**
 * The dump reader (docs/PLAN-DIAG.md § The reader), level 0: the outline of the file on the left (the top level, the children of a node when it is
 * opened), the file's text in the middle (paged from the server, so a file of millions of lines is never held whole), the guide of the selected
 * node on the right. A node that has a computed reading shows it in the middle behind a Reading | Text switch. The selection, not the scroll, decides
 * what the guide and the reading are about; the path above the text follows the scroll.
 */
export function DiagView(props: DiagViewProps) {
  const { source } = props
  const file = source.file
  const text = source.text
  const store = useMemo(() => outlineStoreOf(source), [source])
  useSyncExternalStore(store.subscribe, store.getVersion)
  const [ui, set] = useReducer(reduce, source, (s) => kept.get(s) ?? freshUi())
  const uiRef = useRef(ui)
  uiRef.current = ui
  const topRef = useRef(ui.top)
  useEffect(() => () => { kept.set(source, { ...uiRef.current, top: topRef.current }) }, [source])
  const mem = useMemoryAnnotations()
  const notes = props.annotations ?? mem

  const [panesStored, setPanes] = usePersisted<Panes>('mtkprof.diag.panes', PANES)
  const panes: Panes = { ...PANES, ...panesStored }
  const setPane = (p: Partial<Panes>) => setPanes({ ...panes, ...p })
  const workStyle = {
    ...(panes.lw ? { '--opt-left': `${panes.lw}px` } : null), ...(panes.rw ? { '--opt-right': `${panes.rw}px` } : null),
    ...(panes.l ? null : { '--opt-left-w': '0px' }), ...(panes.r ? null : { '--opt-right-w': '0px' }),
  } as CSSProperties

  // the outline starts with the sections of a file that has few of them open (once per source)
  useEffect(() => { if (!started.has(source)) { started.add(source); void store.openFirst() } }, [source, store])

  // ---- the text: pages from the source, through the line cache ----
  const cache = useMemo(() => {
    if (!text) return null
    const c = new PageCache((from, n, signal) => text.page(from, n, signal), CACHE_PAGES)
    c.total = file.lines
    return c
  }, [text, file.lines])
  useEffect(() => () => cache?.close(), [cache])
  const viewer = useRef<ViewerApi | null>(null)
  const [view, setView] = useState({ top: 1, rows: 1 })
  const onView = useCallback((top: number, rows: number) => setView((v) => (v.top === top && v.rows === rows ? v : { top, rows })), [])
  const [loadError, setLoadError] = useState<string | null>(null)
  const goBox = useRef<HTMLInputElement>(null)
  const qBox = useRef<HTMLInputElement>(null)

  // ---- selecting: a node, a line ----
  const modeFor = (n: DiagNode | undefined): Mode => (n?.reading && readingView(n.reading) ? 'reading' : 'text')
  const selectNode = useCallback((id: string) => {
    const n = store.node(id)
    if (!n) return
    store.revealNode(id)
    const mode = modeFor(n)
    set({ node: id, sel: n.from, mode })
    if (cache) viewer.current?.reveal(n.from, 'top')
  }, [store, cache])
  /**
   * Select a line: the node that holds it becomes the selected node (as far as the outline is loaded) and the text shows the line. `keepNode`: the node stays
   * (a link inside a reading shows a line of the text and the reading's node stays the selection, so Reading is one click away); `keepMode`: the centre stays as it is.
   */
  const selectLine = useCallback((line: number, how: 'center' | 'nearest' | 'top' = 'nearest', keepMode = false, keepNode = false) => {
    const n = store.nodeAt(line)
    if (n && !keepNode) store.revealNode(n.id)
    set((s) => ({ sel: line, node: keepNode ? s.node : n ? n.id : null, mode: keepMode ? s.mode : 'text' }))
    viewer.current?.reveal(line, how)
  }, [store])
  const goLine = useCallback((line: number) => selectLine(Math.min(Math.max(1, line), Math.max(1, file.lines)), 'center'), [selectLine, file.lines])
  const readingGo = useCallback((line: number) => selectLine(Math.min(Math.max(1, line), Math.max(1, file.lines)), 'center', false, true), [selectLine, file.lines])

  // a requested node and line (a jump from outside)
  const goKey = props.goTo ? `${props.goTo.node ?? ''}:${props.goTo.line ?? 0}:${props.goTo.seq ?? 0}` : ''
  const seenGo = useRef(goKey)
  const pendingGo = useRef<{ node?: string; line?: number } | null>(props.goTo && (props.goTo.node || props.goTo.line) ? { node: props.goTo.node, line: props.goTo.line } : null)
  useEffect(() => {
    if (!props.goTo || goKey === seenGo.current) return
    seenGo.current = goKey
    pendingGo.current = { node: props.goTo.node, line: props.goTo.line }
    set({})
  }, [goKey, props.goTo])
  useEffect(() => {
    const g = pendingGo.current
    if (!g) return
    pendingGo.current = null
    if (g.node && store.node(g.node)) { selectNode(g.node); if (g.line) goLine(g.line) } else if (g.line) goLine(g.line)
  })

  // ---- where the text is: the selected line when it is in view, else the first visible line ----
  const bottom = view.top + Math.max(0, view.rows - 1)
  const selVisible = ui.sel > 0 && ui.sel >= view.top && ui.sel <= bottom
  const focus = selVisible ? ui.sel : view.top
  // the path above the centre: in Reading it is the selected node's (the text behind is not shown), and so it is where there is no text (the standalone report); in Text it follows the scroll
  const selNode = ui.node ? store.node(ui.node) : undefined
  const reading = selNode?.reading
  const readingOk = !!reading
  const effMode: Mode = readingOk && ui.mode === 'reading' ? 'reading' : 'text'
  const path = (effMode === 'reading' || !text) && selNode ? store.pathTo(selNode.id) : text ? store.pathAt(focus) : []
  const pathKey = path.map((n) => n.id).join('|')
  const pathSet = useMemo(() => new Set(pathKey ? pathKey.split('|') : []), [pathKey])

  // the node the guide is about: the selected one, else the deepest the text shows
  const guideNode = selNode ?? path.at(-1) ?? null

  // ---- search ----
  const stepFromRef = useRef(0)
  const onFirst = useCallback((line: number) => { set({ hitCur: line }); selectLine(line, 'center') }, [selectLine])
  const { search, run } = useDiagSearch(text, onFirst)
  useEffect(() => {
    if (!text) return
    if (!ui.q) { run(EMPTY_Q); return }
    const t = window.setTimeout(() => run({ q: ui.q, regex: ui.re, caseSensitive: ui.cs }), 300)
    return () => window.clearTimeout(t)
  }, [text, run, ui.q, ui.re, ui.cs])
  const hits = search.hits
  const hasSearch = !!search.ran.q && search.status !== 'error'
  const highlight = useMemo<RowHighlight | null>(() => (hasSearch ? { q: search.ran.q, regex: search.ran.regex, caseSensitive: search.ran.caseSensitive } : null), [hasSearch, search.ran.q, search.ran.regex, search.ran.caseSensitive])
  const stepHit = (dir: 1 | -1) => {
    if (hits.length === 0) return
    stepFromRef.current = ui.sel || ui.hitCur || focus
    const l = stepLine(hits, stepFromRef.current, dir)
    set({ hitCur: l })
    selectLine(l, 'center')
  }

  // ---- the line map and the bookmarks ----
  const top = store.top()
  const stripBands = useMemo(() => bandsOf(top), [top])
  const bmSet = useMemo<ReadonlySet<number>>(() => new Set(notes.bookmarks.keys()), [notes.bookmarks])
  const noteMap = useMemo(() => { const m = new Map<number, string>(); for (const [l, t] of notes.bookmarks) if (t) m.set(l, t); return m }, [notes.bookmarks])
  const scrub = useCallback((line: number) => viewer.current?.reveal(line, 'center'), [])
  const bandTop = Math.max(1, view.top)
  const headings = store.headings()

  // ---- keys ----
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return
    if (e.key === 'F3') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); return }
    if ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) { if (!text) return; e.preventDefault(); qBox.current?.focus(); qBox.current?.select(); return }
    if (inTextField(e.target) || e.metaKey || e.ctrlKey || e.altKey) return
    switch (e.key) {
      case '/': if (!text) return; e.preventDefault(); qBox.current?.focus(); qBox.current?.select(); break
      case 'g': if (!text) return; e.preventDefault(); goBox.current?.focus(); goBox.current?.select(); break
      case 'b': if (ui.sel) notes.toggle(ui.sel); break
      case 'v': if (selNode?.reading) set((s) => ({ mode: s.mode === 'reading' ? 'text' : 'reading' })); break
      case '?': set((s) => ({ keys: !s.keys })); break
      case 'Escape': if (ui.keys) set({ keys: false }); break
      default: return
    }
  }
  const onKeyRef = useRef(onKey)
  onKeyRef.current = onKey
  const root = useRef<HTMLElement>(null)
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (root.current && root.current.offsetParent !== null) onKeyRef.current(e) }
    window.addEventListener('keydown', h)
    return () => window.removeEventListener('keydown', h)
  }, [])

  // back to the text: show the selected line
  const setMode = (m: Mode) => {
    if (m === ui.mode) return
    set({ mode: m })
    if (m === 'text' && ui.sel) viewer.current?.reveal(ui.sel, 'center')
  }

  const rows = store.rows()
  const bmCount = notes.bookmarks.size
  const ltitle = ui.ltab === 'outline' ? 'Outline' : 'Bookmarks'
  const rootKids = store.kidsOf('root')
  const lsmall = ui.ltab === 'outline' ? (rootKids?.more ? `${fmtInt(rootKids.nodes.length)} of ${fmtInt(file.outlineTotal)} parts` : `${fmtInt(store.loaded)} ${store.loaded === 1 ? 'part' : 'parts'}`) : `${bmCount}`
  const onToggleNode = useCallback((id: string) => { void store.toggle(id) }, [store])
  const onMore = useCallback((id: string) => { void store.loadMore(id) }, [store])
  const nodeHits = guideNode && hasSearch ? hitsIn(hits, guideNode.from, guideNode.to) : null

  const tab = (t: LTab, title: string, tip: string, icon: React.ReactNode, badge?: number) => (
    <button key={t} type="button" role="tab" className="lines-tab" aria-selected={ui.ltab === t} title={`${title}: ${tip}`} aria-label={title} onClick={() => set({ ltab: t })}>{icon}{badge ? <small>{badge}</small> : null}</button>
  )

  return (
    <section className="opt dg" aria-label="Dump reader" ref={root}>
      <DiagFacts file={file} onOpenAs10046={props.onOpenAs10046} />
      <div className="lines-bar"><div className="lines-row" role="toolbar" aria-label="The text">
        {readingOk && (
          <div className="lines-mode" role="radiogroup" aria-label="Centre">
            <button type="button" role="radio" aria-checked={effMode === 'reading'} onClick={() => setMode('reading')} title={`The reading of the selected part: ${reading}  (v)`}>Reading</button>
            <button type="button" role="radio" aria-checked={effMode === 'text'} onClick={() => setMode('text')} title="The file's own text  (v)">Text</button>
          </div>
        )}
        <form className="lines-search" role="search" onSubmit={(e) => { e.preventDefault() }}>
          <input ref={qBox} type="search" placeholder={text ? 'Search the file' : 'The text is not in this report'} aria-label="Search the file" disabled={!text} className={search.status === 'error' ? 'bad' : undefined} value={ui.q} autoComplete="off" spellCheck={false}
            title={text ? 'Search the file: literal, or a regular expression with .*  (/ to focus; Enter, Shift+Enter or F3 for the next and previous hit)' : 'This report holds the outline only: open the file with mtkprof serve or the desktop app to search it'}
            onChange={(e) => set({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                const q = { q: ui.q, regex: ui.re, caseSensitive: ui.cs }
                if (q.q !== search.ran.q || q.regex !== search.ran.regex || q.caseSensitive !== search.ran.caseSensitive || search.status === 'error') run(q)
                else stepHit(e.shiftKey ? -1 : 1)
              } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); viewer.current?.focus() }
            }} />
          <button type="button" className="quiet" aria-pressed={ui.re} disabled={!text} onClick={() => set({ re: !ui.re })} title="Regular expression">.*</button>
          <button type="button" className="quiet" aria-pressed={ui.cs} disabled={!text} onClick={() => set({ cs: !ui.cs })} title="Match case">Aa</button>
          <span className="count" aria-live="polite" title={search.status === 'error' ? search.error ?? undefined : search.truncated ? `Stopped at the limit of ${fmtInt(hits.length)} hits` : undefined}>{searchCountText(search, ui.hitCur, (l) => hitIndex(hits, l))}</span>
          <button type="button" className="quiet icon-btn" onClick={() => stepHit(-1)} disabled={hits.length === 0} title="Previous hit  (Shift+Enter, Shift+F3)" aria-label="Previous hit"><ChevronUpIcon /></button>
          <button type="button" className="quiet icon-btn" onClick={() => stepHit(1)} disabled={hits.length === 0} title="Next hit  (Enter, F3)" aria-label="Next hit"><ChevronDownIcon /></button>
        </form>
        <span className="tb-sep" />
        <form className="dg-goto" onSubmit={(e) => {
          e.preventDefault()
          const n = Number(ui.goText.replace(/[\s,_]/g, ''))
          if (Number.isFinite(n) && n >= 1) goLine(Math.floor(n))
        }}>
          <input ref={goBox} type="text" inputMode="numeric" placeholder="Go to line" aria-label="Go to line" disabled={!text} value={ui.goText} autoComplete="off" spellCheck={false}
            title={`Go to a line of the file, 1 to ${fmtInt(file.lines)}  (g to focus, Enter to go)`} onChange={(e) => set({ goText: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); viewer.current?.focus() } }} />
        </form>
        <button type="button" className="quiet icon-btn" aria-pressed={ui.sel > 0 && notes.bookmarks.has(ui.sel)} disabled={!ui.sel} onClick={() => ui.sel && notes.toggle(ui.sel)} title="Bookmark the selected line  (b)" aria-label="Bookmark the selected line"><BookmarkIcon /></button>
        <ToolbarMenu label="Keys" className="tb-cmd" open={ui.keys} onOpenChange={(o) => set({ keys: o })} title="The keys of this view  (?)" button={<>Keys <kbd>?</kbd></>}>
          <table className="lines-keys"><caption>Keys</caption><tbody>{KEY_ROWS.map(([name, keys]) => <tr key={name}><th>{name}</th><td>{keys}</td></tr>)}</tbody></table>
        </ToolbarMenu>
      </div></div>

      <div className="opt-work" style={workStyle}>
        <aside className="opt-side opt-side-l" aria-label="Outline" hidden={!panes.l}>
          <div className="opt-side-head">
            <div className="lines-tabs" role="tablist" aria-label="Left panel">
              {tab('outline', 'Outline', 'The parts of the file, with line counts and search hits', <ListTreeIcon />)}
              {tab('bookmarks', 'Bookmarks', 'Bookmarked lines and their notes (b on a line)', <BookmarkIcon />, bmCount)}
            </div>
            <h2 className="lines-side-title">{ltitle}<small>{lsmall}</small></h2>
            {ui.ltab === 'outline' && (
              <span className="dg-ol-btns">
                <button type="button" className="quiet sm" onClick={() => { void store.expand() }} title="Open the parts down to three levels (asks for the ones not loaded yet)">Expand</button>
                <button type="button" className="quiet sm" onClick={() => store.collapse(ui.node ?? undefined)} title="Back to the first level and the way to the selection">Collapse</button>
              </span>
            )}
          </div>
          <div className="opt-side-body">
            {ui.ltab === 'outline' && (
              <DiagOutline rows={rows} selected={ui.node} path={pathSet} hits={hasSearch ? hits : null} digest={source.digest} onSelect={selectNode} onToggle={onToggleNode} onMore={onMore} />
            )}
            {ui.ltab === 'bookmarks' && (
              <DiagBookmarks bookmarks={notes.bookmarks} textOf={(l) => cache?.line(l)?.text} pathOf={(l) => store.pathAt(l)} onGo={(l) => goLine(l)} onNote={notes.setNote} onRemove={notes.remove} />
            )}
          </div>
        </aside>

        <section className="opt-centre" aria-label={effMode === 'reading' ? 'Reading' : 'Text'}>
          <div className="lines-at">
            <nav className="lines-crumbs" aria-label="Where the text is">
              <button type="button" className="link crumb-id" title="The top of the file" onClick={() => { if (text) goLine(1) }}>{file.name}</button>
              {path.map((n, i) => (
                <Fragment key={n.id}>
                  <span className="crumb-sep">›</span>
                  <button type="button" className={'link' + (i === path.length - 1 ? ' crumb-last' : '')} title={`${n.title}: lines ${fmtInt(n.from)}-${fmtInt(n.to)}`} onClick={() => selectNode(n.id)}>{n.title}</button>
                </Fragment>
              ))}
            </nav>
            <span className="at-line">{effMode === 'reading' && selNode ? `lines ${fmtInt(selNode.from)}-${fmtInt(selNode.to)}` : text && focus ? `line ${fmtInt(focus)}` : ''}</span>
          </div>
          {cache ? (
            <div className="dg-lv" hidden={effMode === 'reading'}>
              <LineViewer cache={cache} bookmarks={bmSet} notes={noteMap} selected={ui.sel} wrap={false} highlight={highlight} plainKinds={PLAIN} dress={headings} rules
                apiRef={viewer} topRef={topRef} onViewChange={onView} onSelect={(l) => selectLine(l, 'nearest', true)} onBookmark={(l) => notes.toggle(l)} onError={setLoadError}
                side={file.lines > 0 ? (
                  <LineStrip total={file.lines} layers={[]} shape={null} selected={ui.sel} hits={hasSearch ? hits : EMPTY_HITS} bookmarks={bmSet} range={null} bands={stripBands}
                    view={{ top: bandTop, rows: Math.max(1, view.rows) }}
                    title="The file: the parts as bands, search hits at the right edge, bookmarks at the left, the visible range as a box. Click or drag to go there."
                    onScrub={scrub} onJump={goLine} />
                ) : undefined} />
              {loadError && <p className="opt-error dg-load-error" role="alert">Could not read the text: {loadError}</p>}
            </div>
          ) : (
            <div className="dg-notext" hidden={effMode === 'reading'}>
              <p className="dg-notext-t">The text is not in this report.</p>
              <p>This standalone report holds the outline of the file to two levels, not the file&apos;s lines. Open the file with <code>mtkprof serve</code> or the desktop app to read it and search it.</p>
            </div>
          )}
          {effMode === 'reading' && selNode && (
            <div className="dg-reading">
              <ReadingHost key={selNode.id} node={selNode} source={source} goLine={readingGo} selectNode={selectNode} />
            </div>
          )}
          <div className="lines-status-bar" role="status">
            {effMode === 'reading' && selNode
              ? <span>Reading of lines <b>{fmtInt(selNode.from)}-{fmtInt(selNode.to)}</b> of {fmtInt(file.lines)}</span>
              : text
              ? <span>Lines <b>{fmtInt(view.top)}-{fmtInt(Math.min(file.lines, bottom))}</b> of {fmtInt(file.lines)}</span>
              : <span><b>{fmtInt(file.lines)}</b> lines in the file; the text is not in this report</span>}
            {selNode && <span>Selected <b>{selNode.title}</b></span>}
            {search.status === 'running' && <span>Searching…</span>}
            {search.status === 'done' && search.truncated && <span className="end">Search: stopped at {fmtInt(hits.length)} hits</span>}
            {search.status === 'error' && <span className="end dg-err">Search: {search.error}</span>}
          </div>
        </section>

        <aside className="opt-side opt-side-r" aria-label="Guide" hidden={!panes.r}>
          <div className="opt-side-head">
            <div className="lines-tabs" role="tablist" aria-label="Right panel">
              <button type="button" role="tab" className="lines-tab" aria-selected="true" title="Guide: what the selected part is" aria-label="Guide"><BookOpenIcon /></button>
            </div>
            <h2 className="lines-side-title">Guide<small>{guideNode?.title ?? ''}</small></h2>
          </div>
          <div className="opt-side-body">
            <DiagGuide node={guideNode} selected={!!selNode} hits={nodeHits} q={hasSearch ? search.ran.q : ''} digest={!text} onGo={goLine} />
          </div>
        </aside>

        {panes.l && <ResizeHandle anchor="start" className="resizer-opt-l" label="Resize the left panel" min={220} maxFrac={0.4} onChange={(px) => setPane({ lw: px })} />}
        <PaneToggle side="start" open={panes.l} onToggle={() => setPane({ l: !panes.l })} label={`the left panel (${ltitle})`} className="opt-toggle-l" />
        {panes.r && <ResizeHandle anchor="end" className="resizer-opt-r" label="Resize the right panel" min={220} maxFrac={0.4} onChange={(px) => setPane({ rw: px })} />}
        <PaneToggle open={panes.r} onToggle={() => setPane({ r: !panes.r })} label="the right panel (Guide)" className="opt-toggle-r" />
      </div>
    </section>
  )
}

const EMPTY_HITS: number[] = []
