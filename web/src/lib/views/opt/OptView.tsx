import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { Opt10046Link, OptAnnotations, OptFold, OptSource, OptText } from '../../data/opt'
import { enabledLandmarks, foldOf, indexDump, lmSwitches, pathOf, stepLine, type DumpIndex, type LmOn } from '../../data/optindex'
import { glossaryOf, glossaryRegex } from '../../data/optguide'
import { buildRows, hiddenByFolds, type OptRow } from '../../data/optrows'
import { NO_HITS, searchCount, searchNote, searchText, type SearchResult } from '../../data/optsearch'
import { optPlanRows } from '../../data/optplan'
import { DEFAULT_PLAN_VIZ, MAX_LINK_CHARS, canGzip, planVizOverride, planVizUrl, type PlanRow } from '../../data/planviz'
import { fmtInt } from '../../data/format'
import { inTextField } from '../../shell/viewKeys'
import { usePersisted } from '../../state/persist'
import { LineStrip } from '../../components/LineStrip'
import { ToolbarMenu } from '../../components/ToolbarMenu'
import { BookOpenIcon, BookmarkIcon, ChevronDownIcon, ChevronUpIcon, CodeIcon, FlagIcon, ListTreeIcon } from '../../components/icons'
import { Shimmer } from '../../components/motion'
import { OptViewer, type OptViewerApi, type PlanLink } from './OptViewer'
import { OptOutline } from './OptOutline'
import { currentNode, nodeKey, outlineNodes, type OutlineMode } from '../../data/optoutline'
import { BookmarkPanel, GuidePanel, LandmarkPanel, SqlPanel, type SqlUi } from './OptPanels'
import '../../styles/lines.css'
import '../../styles/opt.css'

export interface OptViewProps {
  /** where the dumps and their text come from (HTTP in the apps, the report's document in the standalone page, memory in tests) */
  source: OptSource
  /** bookmarks and notes on lines; omitted, the view keeps its own in memory */
  annotations?: OptAnnotations
  /** "Open in plan viz": the visualizer's base URL (the lib's default when omitted) and, when the shell opens links itself, the handler that gets the finished link and the rows */
  planViz?: { base?: string; open?(url: string, rows: PlanRow[]): void }
  /** a link to a 10046 statement: the dump list shows a "10046" link on a dump whose sql_id is in another open tab */
  link10046?: Opt10046Link
  /**
   * Open this dump and, with `line`, that line of the file (a jump from a 10046 tab, from the annotations list, from a link). A new request is one with another
   * `seq` (or another dump or line); the view starts at the first one when it is given at mount.
   */
  goTo?: { dump: number; line?: number; seq?: number }
  /** the open dump changed (the user chose another) */
  onDump?(idx: number): void
}

type LTab = 'outline' | 'landmarks' | 'bookmarks'
type RTab = 'guide' | 'sql'

interface Ui {
  dump: number
  sel: number
  foldOv: ReadonlyMap<string, boolean>
  planText: ReadonlySet<number>
  q: string; re: boolean; cs: boolean
  hitCur: number
  lmCur: number
  exp: ReadonlySet<string>
  expSeen: ReadonlySet<number>
  olMode: OutlineMode
  ltab: LTab
  rtab: RTab
  sql: SqlUi
  keys: boolean
  top: number
}

type Patch = Partial<Ui> | ((s: Ui) => Partial<Ui>)

const reduce = (s: Ui, p: Patch): Ui => ({ ...s, ...(typeof p === 'function' ? p(s) : p) })

/** What a view keeps while another tab is shown (the component unmounts): one per source. */
const kept = new WeakMap<OptSource, Ui>()

const freshUi = (dump: number): Ui => ({
  dump, sel: 0, foldOv: new Map(), planText: new Set(), q: '', re: false, cs: false, hitCur: 0, lmCur: 0, exp: new Set(), expSeen: new Set(),
  olMode: 'all', ltab: 'outline', rtab: 'guide', sql: { sel: 0, against: 0, diff: false }, keys: false, top: 0,
})

interface Loaded { idx: number; ix: DumpIndex; text: OptText; gloss: { gloss: ReturnType<typeof glossaryOf>; re: RegExp | null } }

const NO_NOTES: ReadonlyMap<number, string> = new Map()

/** Bookmarks and notes in memory, for a view that is not given an adapter. */
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
  ['Formatted | Raw', k('v')], ['Search', k('/')], ['Next, previous hit', <>{k('Enter', 'Shift+Enter')} in the box, {k('F3', 'Shift+F3')}</>],
  ['Next, previous landmark', k(']', '[')], ['Next, previous costing run', k('r', 'Shift+R')], ['Open or close the fold at the line', k('z')],
  ['Unfold all, back to the defaults', k('Shift+Z')], ['Bookmark the line', k('b')], ['Move the selection', k('↑', '↓', 'k', 'j')],
  ['First, last line of the dump', k('g', 'Shift+G')], ['Next dump', k('d')], ['This list', k('?')],
]

export function OptView(props: OptViewProps) {
  const { source } = props
  const file = source.file
  const [ui, set] = useReducer(reduce, props.source, (s) => (props.goTo ? freshUi(props.goTo.dump) : kept.get(s) ?? freshUi(0)))
  const uiRef = useRef(ui)
  uiRef.current = ui
  const topRef = useRef(0)
  const restore = useRef(!props.goTo && kept.get(source) ? { dump: kept.get(source)!.dump, top: kept.get(source)!.top } : null)
  useEffect(() => () => { kept.set(source, { ...uiRef.current, top: topRef.current }) }, [source])
  const onDumpRef = useRef(props.onDump)
  onDumpRef.current = props.onDump
  const mem = useMemoryAnnotations()
  const notes = props.annotations ?? mem

  // persisted settings: the landmark switches and Formatted | Raw
  const [lmStored, setLmStored] = usePersisted<Partial<Record<string, boolean>> | null>('mtkprof.opt.landmarks', null)
  const [modeStored, setModeStored] = usePersisted<'fmt' | 'raw'>('mtkprof.opt.mode', 'fmt')
  const lm: LmOn = useMemo(() => lmSwitches(lmStored), [lmStored])
  const mode: 'fmt' | 'raw' = modeStored === 'raw' ? 'raw' : 'fmt'

  // the open dump: its model and its text (kept per dump, so a switch back is at once)
  const cache = useRef(new Map<number, Promise<Loaded>>())
  useEffect(() => { cache.current = new Map() }, [source])
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    const idx = ui.dump
    let p = cache.current.get(idx)
    if (!p) {
      p = Promise.all([source.dump(idx), source.text(idx)]).then(([dump, text]) => {
        const gloss = glossaryOf(dump, file)
        return { idx, ix: indexDump(dump), text, gloss: { gloss, re: glossaryRegex(gloss) } }
      })
      cache.current.set(idx, p)
    }
    setLoadError(null)
    p.then((l) => { if (live) setLoaded(l) }, (e) => { cache.current.delete(idx); if (live) setLoadError(String(e?.message ?? e)) })
    return () => { live = false }
  }, [source, file, ui.dump])
  const cur = loaded && loaded.idx === ui.dump ? loaded : null
  const ix = cur?.ix ?? null
  const text = cur?.text ?? null

  // a requested dump and line
  const goKey = props.goTo ? `${props.goTo.dump}:${props.goTo.line ?? 0}:${props.goTo.seq ?? 0}` : ''
  const seenGo = useRef(goKey)
  const goRef = useRef<{ dump: number; line: number } | null>(props.goTo?.line ? { dump: props.goTo.dump, line: props.goTo.line } : null)
  useEffect(() => {
    if (!props.goTo || goKey === seenGo.current) return
    seenGo.current = goKey
    const { dump, line } = props.goTo
    if (dump < 0 || dump >= file.dumps.length) return
    restore.current = null
    goRef.current = line ? { dump, line } : null
    set((s) => (s.dump === dump ? {} : { dump, sel: 0, hitCur: 0, lmCur: 0 }))
  }, [goKey, props.goTo, file.dumps.length])

  // the outline starts with the dump and its phases open (once per dump)
  useEffect(() => {
    if (!ix || ui.expSeen.has(ix.dump.idx)) return
    set((s) => {
      const e = new Set(s.exp)
      e.add(nodeKey(ix.dump.idx, ix.root.id))
      for (const p of ix.phases) e.add(nodeKey(ix.dump.idx, p.id))
      return { exp: e, expSeen: new Set(s.expSeen).add(ix.dump.idx) }
    })
  }, [ix, ui.expSeen])

  // ---- search ----
  const [search, setSearch] = useState<SearchResult>(NO_HITS)
  useEffect(() => {
    if (!text) { setSearch(NO_HITS); return }
    const run = () => setSearch(searchText(text, { q: ui.q, regex: ui.re, caseSensitive: ui.cs }))
    if (!ui.q) { run(); return }
    const t = window.setTimeout(run, 120)
    return () => window.clearTimeout(t)
  }, [text, ui.q, ui.re, ui.cs])
  useEffect(() => { if (ui.hitCur && !search.hits.includes(ui.hitCur)) set({ hitCur: 0 }) }, [search, ui.hitCur])

  // ---- rows ----
  const closedOf = useCallback((f: OptFold) => { const v = ui.foldOv.get(`${ui.dump}:${f.id}`); return v === undefined ? f.closed : v }, [ui.foldOv, ui.dump])
  const planText = ui.planText.has(ui.dump)
  const rows = useMemo(() => (ix && text ? buildRows(ix, text, { mode, closed: closedOf, planText }) : null), [ix, text, mode, closedOf, planText])
  const hidden = useMemo(() => (rows && mode === 'fmt' ? hiddenByFolds(rows) : null), [rows, mode])

  // ---- the viewer ----
  const viewer = useRef<OptViewerApi>(null)
  const [view, setView] = useState({ top: 0, bottom: 0 })
  const onView = useCallback((top: number, bottom: number) => { topRef.current = top; setView({ top, bottom }) }, [])
  const modeRef = useRef(mode); modeRef.current = mode
  const closedRef = useRef(closedOf); closedRef.current = closedOf
  const pending = useRef<{ line: number; how: 'center' | 'top' | 'near' } | null>(null)
  useLayoutEffect(() => {
    if (pending.current && viewer.current && rows) { const p = pending.current; pending.current = null; viewer.current.reveal(p.line, p.how) }
  }, [rows])

  /** Bring a line into view: open the folds that hide it, then scroll. */
  const go = useCallback((line: number, how: 'center' | 'top' | 'near' = 'center') => {
    const x = cur?.ix
    if (!x) return
    const u = uiRef.current
    const hiding = modeRef.current === 'fmt' ? x.folds.filter((f) => f.from < line && line <= f.to && closedRef.current(f)) : []
    if (hiding.length > 0) {
      pending.current = { line, how }
      set((s) => { const m = new Map(s.foldOv); for (const f of hiding) m.set(`${u.dump}:${f.id}`, false); return { foldOv: m } })
    } else viewer.current?.reveal(line, how)
  }, [cur])
  const select = useCallback((line: number, how: 'center' | 'top' | 'near' = 'center') => { set({ sel: line }); go(line, how) }, [go])

  useEffect(() => {
    const g = goRef.current
    if (!g || !cur || cur.idx !== g.dump) return
    goRef.current = null
    if (g.line >= cur.ix.dump.viewFrom && g.line <= cur.ix.dump.viewTo) select(g.line, 'center')
  }, [cur, select, goKey])

  // ---- the lines the context follows: the selection when it is in view, else the first visible line ----
  const dumpFrom = ix?.dump.viewFrom ?? 0
  const dumpTo = ix?.dump.viewTo ?? 0
  const selVisible = !!rows && ui.sel > 0 && rows.rowOf(ui.sel) >= rows.rowOf(view.top) && rows.rowOf(ui.sel) <= rows.rowOf(view.bottom) && ui.sel >= dumpFrom && ui.sel <= dumpTo
  const focus = selVisible ? ui.sel : view.top || dumpFrom

  // ---- the outline ----
  const nodes = useMemo(() => (ix ? outlineNodes(ix, ui.exp, ui.olMode) : []), [ix, ui.exp, ui.olMode])
  const curId = useMemo(() => (ix ? currentNode(ix, new Set(nodes.map((x) => x.n.id)), focus) : null), [ix, nodes, focus])

  // ---- landmarks, runs, hits to step through ----
  const lmLines = useMemo(() => (ix ? enabledLandmarks(ix.dump, lm).map((l) => l.line) : []), [ix, lm])
  const runStarts = useMemo(() => (ix ? ix.dump.runs.map((r) => r.from) : []), [ix])
  const stepFrom = ui.sel || focus
  const stepHit = (dir: 1 | -1) => { if (search.hits.length === 0) return; const l = stepLine(search.hits, ui.sel || ui.hitCur || focus, dir); set({ hitCur: l }); select(l) }
  const stepLm = (dir: 1 | -1) => { const l = stepLine(lmLines, stepFrom, dir); if (l) { set({ lmCur: l }); select(l) } }
  const stepRun = (dir: 1 | -1) => { const l = stepLine(runStarts, ui.sel, dir); if (l) select(l, 'top') }

  // ---- folds ----
  const toggleFold = useCallback((f: OptFold) => {
    const u = uiRef.current
    const k = `${u.dump}:${f.id}`
    const nowClosed = !closedRef.current(f)
    set((s) => ({ foldOv: new Map(s.foldOv).set(k, nowClosed), sel: nowClosed ? f.from : s.sel }))
    pending.current = { line: nowClosed ? f.from : u.sel || f.from, how: 'center' }
  }, [])
  const toggleFoldAt = (line: number) => {
    if (!ix || !rows || mode !== 'fmt') return
    const r = rows.at(rows.rowOf(line))
    const f = r?.t === 'fold' ? r.fold : foldOf(ix, line)
    if (f) toggleFold(f)
  }
  const anyClosed = !!ix && ix.folds.some(closedOf)
  const toggleAllFolds = () => {
    if (!ix) return
    const dump = ix.dump.idx
    set((s) => {
      const m = new Map(s.foldOv)
      if (ix.folds.some((f) => { const v = m.get(`${dump}:${f.id}`); return v === undefined ? f.closed : v })) for (const f of ix.folds) m.set(`${dump}:${f.id}`, false)
      else for (const f of ix.folds) m.delete(`${dump}:${f.id}`)
      return { foldOv: m }
    })
  }

  // ---- dumps, modes ----
  const openDump = useCallback((k: number) => {
    const u = uiRef.current
    if (k === u.dump) { viewer.current?.reveal(cur?.ix.dump.viewFrom ?? 1, 'top'); set({ sel: cur?.ix.dump.viewFrom ?? 0 }); return }
    restore.current = null
    set({ dump: k, sel: 0, hitCur: 0, lmCur: 0, sql: { sel: 0, against: 0, diff: false } })
    onDumpRef.current?.(k)
  }, [cur])
  const setMode = (m: 'fmt' | 'raw') => { if (m !== mode) { setModeStored(m); if (ui.sel) pending.current = { line: ui.sel, how: 'near' } } }
  const goNode = useCallback((id: string) => { const n = cur?.ix.byId.get(id); if (n) select(n.from, 'top') }, [cur, select])

  // ---- the plan ----
  const plan = ix?.dump.plan ?? null
  const [viz, setViz] = useState<{ state: 'none' | 'pending' | 'ok' | 'big' | 'nogzip'; url?: string; rows?: PlanRow[] }>({ state: 'none' })
  const planViz = props.planViz
  useEffect(() => {
    if (!ix || !plan) { setViz({ state: 'none' }); return }
    const rowsOut = optPlanRows(plan, { sqlId: ix.dump.sqlId, planHash: ix.dump.planHash, sql: ix.dump.stmtText })
    if (!canGzip) { setViz({ state: 'nogzip' }); return }
    let live = true
    setViz({ state: 'pending' })
    planVizUrl(planViz?.base || planVizOverride() || DEFAULT_PLAN_VIZ, rowsOut).then(
      (url) => { if (live) setViz(url.length > MAX_LINK_CHARS ? { state: 'big' } : { state: 'ok', url, rows: rowsOut }) },
      () => { if (live) setViz({ state: 'nogzip' }) },
    )
    return () => { live = false }
  }, [ix, plan, planViz?.base])
  const openViz = planViz?.open
  const planLink: PlanLink = useMemo(() => ({
    href: viz.state === 'ok' ? viz.url : undefined,
    note: viz.state === 'big' ? 'plan too large for a link' : viz.state === 'nogzip' ? 'no CompressionStream' : viz.state === 'pending' ? 'encoding…' : undefined,
    onOpen: openViz && viz.url && viz.rows ? () => openViz(viz.url!, viz.rows!) : undefined,
  }), [viz, openViz])

  // ---- stable handlers for the viewer ----
  const onRow = useCallback((_r: OptRow, line: number) => { set({ sel: line }); viewer.current?.focus() }, [])
  const onFold = useCallback((r: OptRow, f: OptFold) => { if (f) { set({ sel: r.line }); toggleFold(f) } }, [toggleFold])
  const onPlan = useCallback((v: 'plan' | 'text') => set((s) => { const p = new Set(s.planText); if (v === 'text') p.add(s.dump); else p.delete(s.dump); return { planText: p } }), [])
  const onDiff = useCallback((line: number, r: OptRow) => set({ rtab: 'sql', sql: { sel: line, against: 0, diff: true }, sel: r.line }), [])

  // ---- the keys ----
  const qBox = useRef<HTMLInputElement>(null)
  const move = (dir: 1 | -1) => {
    if (!rows) return
    const visible = ui.sel > 0 && viewer.current?.visible(ui.sel)
    const base = visible ? ui.sel : dir > 0 ? view.top : view.bottom
    let r = rows.rowOf(base) + (visible ? dir : 0)
    while (r >= 0 && r < rows.count && rows.at(r).line === base && dir && visible) r += dir
    const row = rows.at(Math.min(rows.count - 1, Math.max(0, r)))
    if (row) { set({ sel: row.line }); go(row.line, 'near') }
  }
  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing || e.defaultPrevented) return
    if (e.key === 'F3') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); return }
    if ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); qBox.current?.focus(); qBox.current?.select(); return }
    if (inTextField(e.target) || e.metaKey || e.ctrlKey || e.altKey || !ix) return
    switch (e.key) {
      case 'v': setMode(mode === 'fmt' ? 'raw' : 'fmt'); break
      case '/': e.preventDefault(); qBox.current?.focus(); qBox.current?.select(); break
      case ']': stepLm(1); break
      case '[': stepLm(-1); break
      case 'r': stepRun(1); break
      case 'R': stepRun(-1); break
      case 'z': if (ui.sel) toggleFoldAt(ui.sel); break
      case 'Z': toggleAllFolds(); break
      case 'b': if (ui.sel) notes.toggle(ui.sel); break
      case 'd': if (file.dumps.length > 1) openDump((ui.dump + 1) % file.dumps.length); break
      case 'g': select(ix.dump.viewFrom, 'top'); break
      case 'G': select(ix.dump.viewTo); break
      case 'j': case 'ArrowDown': e.preventDefault(); move(1); break
      case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break
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
  // ---- the line map ----
  const off = dumpFrom - 1
  const strip = useMemo(() => {
    if (!ix) return null
    const alpha: Record<string, number> = { 'phase-env': 0.07, 'phase-trans': 0.16, 'phase-cost': 0.27, 'phase-result': 0.1 }
    const bands = ix.phases.map((p) => ({ from: p.from - off, to: p.to - off, alpha: alpha[p.kind] ?? 0.05 }))
    const marks = enabledLandmarks(ix.dump, lm).map((l) => ({ line: l.line - off, token: l.tone === 'kept' ? '--s-good' : l.tone === 'problem' ? '--s-critical' : '--ink-3', w: l.tone === 'problem' ? 6 : 3, h: l.tone === 'problem' ? 3 : 1 }))
    return { bands, marks }
  }, [ix, lm, off])
  const stripHits = useMemo(() => Array.from(search.hits, (h) => h - off), [search, off])
  const stripBms = useMemo(() => new Set([...notes.bookmarks.keys()].filter((l) => l >= dumpFrom && l <= dumpTo).map((l) => l - off)), [notes.bookmarks, dumpFrom, dumpTo, off])

  // ---- text ----
  const bad = search.bad
  // the landmark the panel and the counter point at: the selected line when it is one, else the last one stepped to
  const lmCur = ui.sel > 0 && ix?.lmAt.has(ui.sel) && lm[ix.lmAt.get(ui.sel)!.kind] ? ui.sel : ui.lmCur
  const lmK = lmLines.indexOf(lmCur)
  const total = file.dumps.length
  const dInfo = file.dumps[ui.dump]
  const info = (
    <div className="opt-info" aria-label="The file">
      <span><b>{file.name}</b></span>
      {file.release && <span>{file.release.replace(/ - Production$/, '')}</span>}
      {file.version && <span>Version <b>{file.version}</b></span>}
      <span><b>{total}</b> optimizer (10053) {total === 1 ? 'dump' : 'dumps'}</span>
      <span><b>{fmtInt(file.lines)}</b> lines</span>
      {!file.tested && <span className="opt-warn" title="The rules were written for 19c; another version is read best effort">read with the 19c rules; this file is {file.version || 'of no version the prologue names'}</span>}
      {!file.tested && dInfo && <span className="opt-warn" title="Lines of the dump that sit directly under a phase or the dump, in no known section">{fmtInt(dInfo.unplaced)} {dInfo.unplaced === 1 ? 'line' : 'lines'} outside any known section</span>}
      {dInfo?.truncated && <span className="opt-warn" title="The file ended, or another dump began, before END SQL Statement Dump">this dump is truncated: no end line</span>}
    </div>
  )

  const showLeft = (t: LTab, title: string, tip: string, icon: React.ReactNode, badge?: number) => (
    <button key={t} type="button" role="tab" className="lines-tab" aria-selected={ui.ltab === t} title={`${title}: ${tip}`} aria-label={title} onClick={() => set({ ltab: t })}>{icon}{badge ? <small>{badge}</small> : null}</button>
  )
  const showRight = (t: RTab, title: string, tip: string, icon: React.ReactNode) => (
    <button key={t} type="button" role="tab" className="lines-tab" aria-selected={ui.rtab === t} title={`${title}: ${tip}`} aria-label={title} onClick={() => set({ rtab: t })}>{icon}</button>
  )
  const bmCount = ix ? [...notes.bookmarks.keys()].filter((l) => l >= dumpFrom && l <= dumpTo).length : 0
  const lmCount = lmLines.length
  const ltitle = ui.ltab === 'outline' ? 'Outline' : ui.ltab === 'landmarks' ? 'Landmarks' : 'Bookmarks'
  const lsmall = ui.ltab === 'outline' ? `${total} ${total === 1 ? 'dump' : 'dumps'}` : ui.ltab === 'landmarks' ? `${fmtInt(lmCount)} on` : `${bmCount}`
  const rtitle = ui.rtab === 'guide' ? 'Guide' : 'SQL'
  const rsmall = ui.rtab === 'sql' && ix ? `${ix.dump.sql.length} versions` : ''

  const digest = !!text && !text.complete
  const present = useMemo(() => (text && !text.complete ? digestCount(text) : 0), [text])

  return (
    <section className="opt" aria-label="Optimizer trace (10053)" ref={root}>
      {info}
      <div className="lines-bar"><div className="lines-row" role="toolbar" aria-label="The text">
        <div className="lines-mode" role="radiogroup" aria-label="Text">
          <button type="button" role="radio" aria-checked={mode === 'fmt'} onClick={() => setMode('fmt')} title="Formatted: the trace's lines dressed, noise folded  (v)">Formatted</button>
          <button type="button" role="radio" aria-checked={mode === 'raw'} onClick={() => setMode('raw')} title="Raw: the dump's lines untouched  (v)">Raw</button>
        </div>
        <form className="lines-search" role="search" onSubmit={(e) => { e.preventDefault() }}>
          <input ref={qBox} type="search" placeholder="Search the dump" aria-label="Search the open dump" className={bad ? 'bad' : undefined} value={ui.q} autoComplete="off" spellCheck={false}
            title={`Search the open dump: literal, or a regular expression with .*  (/ to focus; Enter, Shift+Enter or F3 for the next and previous hit)${digest ? '\nThis report holds some of the lines only: the search reads those' : ''}`}
            onChange={(e) => set({ q: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); const r = text ? searchText(text, { q: ui.q, regex: ui.re, caseSensitive: ui.cs }) : NO_HITS; setSearch(r); if (r.hits.length) { const l = stepLine(r.hits, ui.sel || ui.hitCur || focus, e.shiftKey ? -1 : 1); set({ hitCur: l }); select(l) } }
              else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); viewer.current?.focus() }
            }} />
          <button type="button" className="quiet" aria-pressed={ui.re} onClick={() => set({ re: !ui.re })} title="Regular expression">.*</button>
          <button type="button" className="quiet" aria-pressed={ui.cs} onClick={() => set({ cs: !ui.cs })} title="Match case">Aa</button>
          <span className="count" aria-live="polite" title={searchNote(search) || undefined}>{searchCount(search, ui.hitCur)}</span>
          <button type="button" className="quiet icon-btn" onClick={() => stepHit(-1)} disabled={search.hits.length === 0} title="Previous hit  (Shift+Enter, Shift+F3)" aria-label="Previous hit"><ChevronUpIcon /></button>
          <button type="button" className="quiet icon-btn" onClick={() => stepHit(1)} disabled={search.hits.length === 0} title="Next hit  (Enter, F3)" aria-label="Next hit"><ChevronDownIcon /></button>
        </form>
        <span className="tb-sep" />
        <div className="tb-group" role="group" aria-label="Landmarks">
          <span className="tb-label">Landmark</span>
          <button type="button" className="quiet icon-btn" onClick={() => stepLm(-1)} disabled={lmLines.length === 0} title="Previous landmark  ([)" aria-label="Previous landmark"><ChevronUpIcon /></button>
          <button type="button" className="quiet icon-btn" onClick={() => stepLm(1)} disabled={lmLines.length === 0} title="Next landmark  (])" aria-label="Next landmark"><ChevronDownIcon /></button>
          <small>{lmK >= 0 ? lmK + 1 : '–'} / {fmtInt(lmLines.length)}</small>
        </div>
        <div className="tb-group" role="group" aria-label="Costing runs">
          <span className="tb-label">Run</span>
          <button type="button" className="quiet icon-btn" onClick={() => stepRun(-1)} disabled={runStarts.length === 0} title="Previous costing run  (Shift+R)" aria-label="Previous costing run"><ChevronUpIcon /></button>
          <button type="button" className="quiet icon-btn" onClick={() => stepRun(1)} disabled={runStarts.length === 0} title="Next costing run  (r)" aria-label="Next costing run"><ChevronDownIcon /></button>
        </div>
        <span className="tb-sep" />
        <button type="button" className="quiet" onClick={toggleAllFolds} disabled={!ix || ix.folds.length === 0 || mode !== 'fmt'} title="Open every fold, or back to the default folds  (Shift+Z; z opens or closes the fold at the selected line)">{anyClosed ? 'Unfold all' : 'Default folds'}</button>
        <button type="button" className="quiet icon-btn" aria-pressed={ui.sel > 0 && notes.bookmarks.has(ui.sel)} disabled={!ui.sel} onClick={() => ui.sel && notes.toggle(ui.sel)} title="Bookmark the selected line  (b)" aria-label="Bookmark the selected line"><BookmarkIcon /></button>
        <ToolbarMenu label="Keys" className="tb-cmd" open={ui.keys} onOpenChange={(o) => set({ keys: o })} title="The keys of this view  (?)" button={<>Keys <kbd>?</kbd></>}>
          <table className="lines-keys"><caption>Keys</caption><tbody>{KEY_ROWS.map(([name, keys]) => <tr key={name}><th>{name}</th><td>{keys}</td></tr>)}</tbody></table>
        </ToolbarMenu>
      </div></div>

      <div className="opt-work">
        <aside className="opt-side opt-side-l" aria-label="Outline">
          <div className="opt-side-head">
            <div className="lines-tabs" role="tablist" aria-label="Left panel">
              {showLeft('outline', 'Outline', 'The dumps and their sections, with line counts and search hits', <ListTreeIcon />)}
              {showLeft('landmarks', 'Landmarks', 'Key lines by kind; [ and ] step through the kinds that are on', <FlagIcon />)}
              {showLeft('bookmarks', 'Bookmarks', 'Bookmarked lines and their notes (b on a line)', <BookmarkIcon />, bmCount)}
            </div>
            <h2 className="lines-side-title">{ltitle}<small>{lsmall}</small></h2>
            {ui.ltab === 'outline' && (
              <span className="opt-seg" role="radiogroup" aria-label="Outline">
                <button type="button" role="radio" aria-checked={ui.olMode === 'all'} aria-pressed={ui.olMode === 'all'} onClick={() => set({ olMode: 'all' })} title="Every section, full depth">All</button>
                <button type="button" role="radio" aria-checked={ui.olMode === 'runs'} aria-pressed={ui.olMode === 'runs'} onClick={() => set({ olMode: 'runs' })} title="The costing runs only, in file order, with their verdicts">Runs</button>
              </span>
            )}
          </div>
          <div className="opt-side-body">
            {ui.ltab === 'outline' && (
              <OptOutline file={file} open={ui.dump} ix={ix} nodes={nodes} exp={ui.exp} mode={ui.olMode} curId={curId} search={search} link10046={props.link10046}
                onDump={openDump} onNode={goNode} onToggle={(k) => set((s) => { const e = new Set(s.exp); if (e.has(k)) e.delete(k); else e.add(k); return { exp: e } })} />
            )}
            {ui.ltab === 'landmarks' && (ix
              ? <LandmarkPanel ix={ix} lm={lm} cur={lmCur} onSwitch={(k, on) => setLmStored({ ...lm, [k]: on })} onGo={(l) => { set({ lmCur: l }); select(l) }} />
              : null)}
            {ui.ltab === 'bookmarks' && ix && text && <BookmarkPanel ix={ix} text={text} bookmarks={notes.bookmarks} onGo={(l) => select(l)} onNote={notes.setNote} onRemove={notes.remove} />}
          </div>
        </aside>

        <section className="opt-centre" aria-label="Text">
          <div className="lines-at">
            <nav className="lines-crumbs" aria-label="Where the text is">
              {ix && (() => {
                const path = pathOf(ix, focus).filter((n) => n.kind !== 'cbqt' && n.kind !== 'join-search')
                return path.map((n, k) => (
                  <Fragment key={n.id}>
                    {k > 0 && <span className="crumb-sep">›</span>}
                    <button type="button" className={'link' + (k === 0 ? ' crumb-id' : '') + (k === path.length - 1 ? ' crumb-last' : '')} title={`${n.label}: lines ${fmtInt(n.from)}-${fmtInt(n.to)}`} onClick={() => goNode(n.id)}>{n.crumb}</button>
                  </Fragment>
                ))
              })()}
            </nav>
            <span className="at-line">{focus ? `line ${fmtInt(focus)}` : ''}</span>
          </div>
          <div className="opt-lv-box">
            {cur && rows && text && ix
              ? <OptViewer key={cur.idx} ref={viewer} ix={ix} text={text} rows={rows} mode={mode} gloss={cur.gloss} sel={ui.sel} lm={lm} bookmarks={notes.bookmarks} search={search} hitCur={ui.hitCur}
                  planText={planText} planLink={planLink} initialTop={restore.current && restore.current.dump === cur.idx && restore.current.top > 0 ? restore.current.top : undefined}
                  onRow={onRow} onFold={onFold} onPlan={onPlan} onDiff={onDiff} onView={onView} />
              : <div className="opt-lv opt-lv-empty">{loadError ? <p className="opt-error" role="alert">Could not read the dump: {loadError}</p> : <p className="opt-overlay"><Shimmer>Loading the dump…</Shimmer></p>}</div>}
            {ix && strip && (
              <LineStrip total={ix.n} layers={[]} shape={null} selected={ui.sel > 0 ? ui.sel - off : 0} hits={stripHits} bookmarks={stripBms} range={null}
                bands={strip.bands} marks={strip.marks} view={{ top: Math.max(1, view.top - off), rows: Math.max(1, view.bottom - view.top + 1) }}
                title="The dump: phases as bands, landmarks (left edge) and search hits (right edge) as ticks, the visible range as a box. Click or drag to go there."
                onScrub={(l) => go(l + off, 'top')} onJump={(l) => go(l + off, 'top')} />
            )}
          </div>
          <div className="lines-status-bar" role="status">
            {ix && <span>Lines <b>{fmtInt(view.top)}-{fmtInt(view.bottom)}</b> of {fmtInt(ix.dump.viewFrom)}-{fmtInt(ix.dump.viewTo)}</span>}
            <span>Dump <b>{ui.dump + 1}</b> of {total}</span>
            {mode === 'fmt' ? (hidden ? <span>{hidden.folds} {hidden.folds === 1 ? 'fold' : 'folds'} closed, <b>{fmtInt(hidden.lines)}</b> lines hidden</span> : null) : <span>Raw: the file as it is</span>}
            {digest && text && <span title="The standalone report keeps the lines of the digest only">Digest: <b>{fmtInt(present)}</b> of {fmtInt(text.to - text.from + 1)} lines in this report</span>}
            {searchNote(search) && <span className="end">Search: {searchNote(search)}</span>}
          </div>
        </section>

        <aside className="opt-side opt-side-r" aria-label="Guide">
          <div className="opt-side-head">
            <div className="lines-tabs" role="tablist" aria-label="Right panel">
              {showRight('guide', 'Guide', 'What the section and the line under the selection are', <BookOpenIcon />)}
              {showRight('sql', 'SQL', 'Every UNPARSED QUERY IS statement of the dump, pretty-printed, with a diff against the previous one', <CodeIcon />)}
            </div>
            <h2 className="lines-side-title">{rtitle}<small>{rsmall}</small></h2>
          </div>
          <div className="opt-side-body">
            {ix && text && ui.rtab === 'guide' && <GuidePanel ix={ix} text={text} gloss={cur!.gloss} line={focus} selected={selVisible} />}
            {ix && ui.rtab === 'sql' && <SqlPanel ix={ix} line={focus} ui={ui.sql} onUi={(p) => set((s) => ({ sql: { ...s.sql, ...p } }))} onShow={(l) => select(l, 'top')} />}
          </div>
        </aside>
      </div>
    </section>
  )
}

/** How many lines a digest text holds. */
function digestCount(t: OptText): number {
  let n = 0
  for (let i = t.from; i <= t.to; i++) if (t.get(i) !== undefined) n++
  return n
}
