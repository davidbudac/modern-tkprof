import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TraceDoc } from '../data/doc'
import type { ID } from '../data/types'
import { IO, isBlockIO, orderToTime, rereadOf, sampleStep, type IOMap } from '../data/iomap'
import {
  bandsOf, bracketsOf, colorByOf, colorRows, dragKind, hitTest, indexOfX, isTempEvent, isWriteEvent, labelRows, MIN_ZOOM_US, orderScale, panelsOf,
  panRange, rangesAt, rowsIn, RULER_X, scaleRange, timeExtent, timeScale, timOfX, xOfIndex, xOfTim, xTicks, yTicks, ySpan, drawBlockMap,
  type Bracket, type ColorBy, type ColorCtx, type Coloring, type LegendEntry, type Panel, type PanelsBy, type TimeRange, type Tone, type XScale,
} from '../data/blocklayout'
import { latBucketLo, latencyHists, LAT_BUCKETS, objectStats, sizeHists, SIZE_HIST_LABELS, type ObjStat } from '../data/iostats'
import { DEFAULT_NAME_OPTS, hasContainers, nameCounts, nameOptsOf, objInfo, objParts, objText, pdbOfCtx, type NameOpts } from '../data/objnames'
import { scopeKey, useScope } from '../data/scopedstmts'
import { sourceOf, useSourceQuery } from '../data/source'
import { activeFilters } from '../data/filters'
import { fmtDur, fmtInt, fmtWall } from '../data/format'
import { tickLabel, tickUnit } from '../data/scale'
import { inTextField } from '../shell/viewKeys'
import { useActions, useStore } from '../state/session'
import { usePersisted } from '../state/persist'
import type { IOZoom } from '../state/store'
import { resolveVar, tokenShade } from '../components/colors'
import { LineRef } from '../components/LineRef'
import { StmtLink } from '../components/StmtLink'
import { usePopover } from '../components/usePopover'
import { ImportNames } from './RefImport'
import { Shimmer, useReveal } from '../components/motion'
import {
  ChartColumnIcon, CloseIcon, DatabaseIcon, ListIcon, PanelRightIcon, ScanIcon, SlidersHorizontalIcon, UndoIcon, ZoomInIcon, ZoomOutIcon,
} from '../components/icons'
import '../styles/lines.css'
import '../styles/blockmap.css'

// The I/O map (view id `blocks`; docs/PLAN-IOMAP.md, docs/PLAN-VIEWS.md § 6): every physical I/O wait with a block address at
// (I/O order or time, block number), one panel per file or per object, marks as tall as the blocks they moved, coloured by what
// the toolbar says, the objects' block ranges as faint bands. A zoom of its own (a stack in the store: drag, wheel, keys, the
// navigator), a legend that highlights, a side panel with the objects, the statements, the distributions and the display
// settings. The layout is data/blocklayout.ts; this file measures, paints and handles the pointer.

const LIMITS = [5000, 20000, 100000] as const
const Y_AXIS = 78 // px left of the plot: the axis title and the block numbers
const PAD_R = 8
const BRACKET_ROW = 36 // px per row of statement brackets: the bracket line, under it the sql_id and the counts
const PHASE_ROW = 24
const TITLE_OBJECTS = 3 // objects named in a file panel's title, most blocks first
const NAV_H = 30
const NAV_LIMIT = 5000
const QUERY_DELAY_MS = 200 // a zoom is re-queried after this long without a change (wheel, pan)
const WHEEL_JOIN_MS = 700 // wheel steps closer than this are one zoom step (Out undoes them together)

type SideTab = 'objects' | 'statements' | 'dist' | 'display'
const SIDE_TABS: { tab: SideTab; label: string; title: string; icon: () => React.JSX.Element }[] = [
  { tab: 'objects', label: 'Objects', title: 'per object: waits, time, blocks, re-reads, how sequential; click one to highlight its marks', icon: DatabaseIcon },
  { tab: 'statements', label: 'Statements', title: 'per statement and file: reads, writes, distinct blocks and re-reads per block', icon: ListIcon },
  { tab: 'dist', label: 'Distributions', title: 'latency per event (a histogram and its percentiles) and blocks per wait', icon: ChartColumnIcon },
  { tab: 'display', label: 'Display', title: 'object names (schema, PDB, partition, obj#), the block axis, the extents, the marks', icon: SlidersHorizontalIcon },
]

/** The colour modes as the Colour select offers them, grouped. */
const COLOR_GROUPS: { label: string; modes: { by: ColorBy; label: string; title: string }[] }[] = [
  { label: 'What was read or written', modes: [
    { by: 'event', label: 'Event', title: 'the wait event: datafile reads and writes in the User I/O orange, temp reads teal, temp writes magenta' },
    { by: 'object', label: 'Object', title: 'the segment the blocks belong to (obj#, named from a reference bundle or the plans)' },
    { by: 'type', label: 'Object type', title: 'TABLE, INDEX, LOB, partitions… (a reference bundle; else TABLE / INDEX from the plans)' },
    { by: 'schema', label: 'Schema', title: 'the owner of the object (needs a reference bundle)' },
    { by: 'tablespace', label: 'Tablespace', title: 'the tablespace of the file (needs a reference bundle with datafiles)' },
    { by: 'file', label: 'File', title: 'the datafile or tempfile' },
  ] },
  { label: 'Who did it', modes: [
    { by: 'statement', label: 'Statement', title: 'the statement the wait belongs to' },
    { by: 'session', label: 'Session', title: 'the session (sid.serial) of the wait' },
  ] },
  { label: 'How it went', modes: [
    { by: 'latency', label: 'Latency', title: 'how long each wait took, on a ramp from fast (light) to slow (strong)' },
    { by: 'size', label: 'Read size', title: 'how many blocks each wait moved (single block, multiblock up to 65+)' },
  ] },
]
const colorLabel = (by: ColorBy) => COLOR_GROUPS.flatMap((g) => g.modes).find((m) => m.by === by)?.label ?? by

const toneColor = (t: Tone) => (t.shade === 0 ? resolveVar(t.token) : tokenShade(t.token, t.shade))

/** Redraw on a theme change: the store's toggle (standalone), `data-theme` (the desktop's setting) or the system scheme. */
function useThemeTick(): string {
  const theme = useStore((s) => s.theme)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const bump = () => setTick((n) => n + 1)
    const mq = matchMedia('(prefers-color-scheme: dark)')
    mq.addEventListener('change', bump)
    const mo = new MutationObserver(bump)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { mq.removeEventListener('change', bump); mo.disconnect() }
  }, [])
  return `${theme}:${tick}`
}

/** The width of an element, followed. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null)
  const [w, setW] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(() => setW(Math.floor(el.clientWidth)))
    ro.observe(el)
    setW(Math.floor(el.clientWidth))
    return () => ro.disconnect()
  }, [])
  return [ref, w]
}

/** `v`, `ms` after it last changed (the zoom's re-query waits for the wheel or a pan to rest); the first value and null (no zoom) at once. */
function useSettled<T>(v: T | null, ms: number): T | null {
  const [s, setS] = useState(v)
  useEffect(() => {
    if (s === v || v === null) return
    const t = setTimeout(() => setS(v), ms)
    return () => clearTimeout(t)
  }, [v, ms, s])
  return v === null ? null : s
}

const stmtLabel = (doc: TraceDoc, stmt: number) => { const s = doc.stmt(stmt); return s ? doc.label(s) : 'no statement' }

/** "datafile 12 · USERS · users01.dbf", "tempfile 203 · TEMP" (names from a reference bundle). */
function fileTitle(doc: TraceDoc, file: number, temp: boolean): string {
  const ref = doc.fileName(file)
  const kind = temp || ref?.type?.toUpperCase() === 'TEMP' ? 'tempfile' : ref ? 'datafile' : 'file'
  const parts = [`${kind} ${file}`]
  if (ref?.tablespace) parts.push(ref.tablespace)
  if (ref?.name) parts.push(ref.name.split(/[\\/]/).pop() ?? ref.name)
  return parts.join(' · ')
}

/** "26 reads · 1,331 temp writes": a stretch's waits by kind (× the sampling step, marked ≈). */
function kindCounts(doc: TraceDoc, byEvent: Map<ID, number>, k: number): string {
  const sums = new Map<string, number>()
  for (const [e, n] of byEvent) {
    const ev = doc.events[e]
    const w = `${isTempEvent(ev) ? 'temp ' : ''}${isWriteEvent(ev) ? 'writes' : 'reads'}`
    sums.set(w, (sums.get(w) ?? 0) + n * k)
  }
  const order = ['reads', 'writes', 'temp writes', 'temp reads']
  return [...sums].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0])).map(([w, n]) => `${k > 1 ? '≈' : ''}${fmtInt(n)} ${n === 1 ? w.slice(0, -1) : w}`).join(' · ')
}

/** The key of a row's object group (the panels by object and the Objects tab share it). */
const objKey = (doc: TraceDoc, r: number[]) => (isTempEvent(doc.events[r[IO.event]]) ? `t${r[IO.file]}` : r[IO.obj] >= 0 ? `o${r[IO.obj]}` : `n${r[IO.file]}`)

/** What a highlight keeps bright: legend entries of a colour mode (by `entryKey`: the legend's order changes with the rows), an object group, or a statement. */
type Focus = { kind: 'legend'; by: ColorBy; entries: string[] } | { kind: 'obj'; key: string } | { kind: 'stmt'; stmt: number } | null

/** A legend entry's identity across answers (its place in the legend is not). */
const entryKey = (l: LegendEntry) => `${l.kind}:${l.key}`

/** An object's name with its qualifiers greyed, and what is known about it in the tooltip. */
function ObjName({ doc, obj, opts, pdb }: { doc: TraceDoc; obj: number; opts: NameOpts; pdb?: string }) {
  const info = objInfo(doc, obj)
  const p = objParts(info, opts, pdb)
  const full = objText(info, { schema: true, pdb: true, sub: true, num: false }, pdb)
  const from = info.from === 'ref' ? 'named by the reference bundle' : info.from === 'plan' ? "named by the trace's plans (STAT lines; no owner)" : 'no plan line or reference bundle names it'
  const title = obj < 0 ? 'the waits carry no obj#' : `${full}${info.type ? ` · ${info.type}` : ''} · obj# ${obj} · ${from}`
  return (
    <span className={'iom-obj' + (p.known ? '' : ' unknown')} title={title}>
      {p.pdb && <span className="q">{p.pdb}/</span>}{p.owner && <span className="q">{p.owner}.</span>}<span className="n">{p.name}</span>
      {p.sub && <span className="q">.{p.sub}</span>}{p.num !== undefined && <span className="q"> #{p.num}</span>}
    </span>
  )
}

interface Settings {
  colorBy: ColorBy
  axis: 'order' | 'time'
  panelsBy: PanelsBy
  packed: boolean
  bands: boolean
  names: NameOpts
}

export function BlockMap({ doc }: { doc: TraceDoc }) {
  const source = sourceOf(doc)
  const actions = useActions()
  const [limitRaw, setLimit] = usePersisted<number>('mtkprof.blocks.limit', 20000)
  const [colorRaw, setColorBy] = usePersisted<string>('mtkprof.blocks.color', 'event')
  const [axisRaw, setAxis] = usePersisted<'order' | 'time'>('mtkprof.blocks.axis', 'order')
  const [panelsRaw, setPanelsBy] = usePersisted<string>('mtkprof.blocks.panels', 'file')
  const [packed, setPacked] = usePersisted<boolean>('mtkprof.blocks.packed', false)
  const [bands, setBands] = usePersisted<boolean>('mtkprof.blocks.bands', true)
  const [namesRaw, setNames] = usePersisted<NameOpts>('mtkprof.blocks.names', DEFAULT_NAME_OPTS)
  const [side, setSide] = usePersisted<boolean>('mtkprof.blocks.side', true)
  const [tabRaw, setTab] = usePersisted<string>('mtkprof.blocks.sideTab', 'objects')
  const limit = (LIMITS as readonly number[]).includes(limitRaw) ? limitRaw : 20000
  const colorBy = colorByOf(colorRaw)
  const axis = axisRaw === 'time' ? 'time' : 'order'
  const panelsBy: PanelsBy = panelsRaw === 'object' ? 'object' : 'file'
  const names = useMemo(() => nameOptsOf(namesRaw), [namesRaw])
  const tab: SideTab = SIDE_TABS.some((t) => t.tab === tabRaw) ? (tabRaw as SideTab) : 'objects'
  const settings: Settings = { colorBy, axis, panelsBy, packed: !!packed, bands: bands !== false, names }

  // the filter (statement, event) is in the store: the links into the I/O map set it (`showBlocks`); so is the zoom stack
  const { stmt: stmtSel, event: eventSel } = useStore((s) => s.blocks)
  const zoomStack = useStore((s) => s.ioZoom)
  const top: IOZoom | null = zoomStack[zoomStack.length - 1] ?? null
  const range = top?.range ?? null
  const qRange = useSettled(range, QUERY_DELAY_MS)
  const scope = useScope(doc, qRange ? { window: qRange } : {})
  const baseScope = useScope(doc)
  const filterKey = `${stmtSel ?? ''}:${eventSel ?? ''}`
  const q = useSourceQuery(source, `iomap:${scopeKey(scope)}:${limit}:${filterKey}`,
    (signal) => (source.ready ? source.ioMap(scope, limit, stmtSel ?? undefined, eventSel ?? undefined, signal) : null), 'iomap')
  // the navigator shows the unzoomed answer: the last one seen for this scope and filter, else (zoomed on arrival) a small one of its own
  const baseKey = `${scopeKey(baseScope)}:${filterKey}`
  const lastBase = useRef<{ key: string; map: IOMap } | null>(null)
  if (!qRange && q.data && !q.loading) lastBase.current = { key: baseKey, map: q.data }
  const needNav = !!qRange && lastBase.current?.key !== baseKey
  const navQ = useSourceQuery(source, needNav ? `iomap-nav:${baseKey}` : 'iomap-nav:none',
    (signal) => (needNav && source.ready ? source.ioMap(baseScope, NAV_LIMIT, stmtSel ?? undefined, eventSel ?? undefined, signal) : null), 'iomap-nav')
  const navMap = !qRange ? q.data ?? null : lastBase.current?.key === baseKey ? lastBase.current.map : navQ.data ?? null
  const full = useMemo(() => (navMap ? timeExtent(navMap.rows) : null), [navMap])

  // what is drawn: the answer's rows inside the zoom (the answer of the previous zoom while the new one is on its way)
  const map = q.data ?? null
  const view = useMemo(() => (map ? rowsIn(map, range) : null), [map, range])
  // the colour modes that need names a reference bundle gives (owners, tablespaces): the menu says so while there are none
  const named = useMemo(() => ({
    schema: !!view && view.rows.some((r) => r[IO.obj] >= 0 && !!objInfo(doc, r[IO.obj]).owner),
    tablespace: !!view && view.files.some((f) => !!doc.fileName(f.file)?.tablespace),
  }), [view, doc])

  // the highlight, shared by the legend, the Objects and Statements tabs
  const [focus, setFocus] = useState<Focus>(null)
  const [hoverEntry, setHoverEntry] = useState<string | null>(null)
  useEffect(() => { setFocus((f) => (f?.kind === 'legend' && f.by !== colorBy ? null : f)); setHoverEntry(null) }, [colorBy])

  // zoom actions (the toolbar, the zoom row, the keys, the figure, the navigator)
  const cur = (): TimeRange | null => range ?? full
  const zoomTo = (r: TimeRange | null, replace = false) => {
    if (!r) { if (top) actions.zoomIO({ range: null, blocks: top.blocks }, replace); return }
    actions.zoomIO({ range: r, blocks: top?.blocks ?? {} }, replace)
  }
  const zoomIn = () => { const c = cur(); if (c && full) { const r = scaleRange(c, (c.startTim + c.endTim) / 2, 0.5, full); if (r) zoomTo(r) } }
  const zoomOut = () => actions.zoomOutIO()
  const reset = () => actions.resetIOZoom()
  const pan = (frac: number) => { if (range && full) zoomTo(panRange(range, frac, full), true) }
  const keys = useRef({ zoomIn, zoomOut, reset, pan })
  keys.current = { zoomIn, zoomOut, reset, pan }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.metaKey || e.ctrlKey || e.altKey || inTextField(e.target)) return
      const k = keys.current
      if (e.key === '-' || e.key === '_') k.zoomOut()
      else if (e.key === '+' || e.key === '=') k.zoomIn()
      else if (e.key === '0') k.reset()
      else if (e.key === 'ArrowLeft') k.pan(-0.25)
      else if (e.key === 'ArrowRight') k.pan(0.25)
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const openTab = (t: SideTab) => { if (side && tab === t) setSide(false); else { setSide(true); setTab(t) } }
  const zoomed = zoomStack.length > 0
  const blockZooms = top ? Object.keys(top.blocks).length : 0
  const base = doc.span.firstTim
  const at = (tim: number, micros: boolean) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(tim), doc.tzOffsetMin, { micros }) : `+${fmtDur(tim - base)}`)

  const toolbar = (
    <div className="iom-bar">
      <div className="iom-row">
        <span className="seg iom-seg" role="group" aria-label="x axis">
          <button type="button" aria-pressed={axis === 'order'} onClick={() => setAxis('order')} title="x = the n-th physical I/O wait: scans, re-reads and spills stay visible however fast they were">I/O order</button>
          <button type="button" aria-pressed={axis === 'time'} onClick={() => setAxis('time')} title="x = the time of the wait: where the I/O time went">Time</button>
        </span>
        <label className="iom-ctl" title={COLOR_GROUPS.flatMap((g) => g.modes).find((m) => m.by === colorBy)?.title}>
          <span className="iom-lbl">Colour</span>
          <select value={colorBy} onChange={(e) => setColorBy(e.target.value)} aria-label="Colour the marks by">
            {COLOR_GROUPS.map((g) => (
              <optgroup key={g.label} label={g.label}>
                {g.modes.map((m) => <option key={m.by} value={m.by}>{m.label}{(m.by === 'schema' || m.by === 'tablespace') && !named[m.by] ? ' (no names)' : ''}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="iom-ctl" title="one panel per datafile / tempfile (y = the block number in the file), or one per object (y = its blocks, the empty ranges between them collapsed)">
          <span className="iom-lbl">Panels</span>
          <select value={panelsBy} onChange={(e) => { setPanelsBy(e.target.value); if (top && Object.keys(top.blocks).length) actions.zoomIO({ range: top.range, blocks: {} }) }} aria-label="One panel per">
            <option value="file">per file</option>
            <option value="object">per object</option>
          </select>
        </label>
        {stmtSel !== null && (
          <span className="chip iom-chip" title="only the waits of this statement">only {stmtLabel(doc, stmtSel)}<button type="button" className="quiet" aria-label="Show all statements" onClick={() => actions.setBlocks({ stmt: null })}>×</button></span>
        )}
        {eventSel !== null && doc.events[eventSel] && (
          <span className="chip iom-chip" title="only the waits of this event">only {doc.events[eventSel].name}<button type="button" className="quiet" aria-label="Show all events" onClick={() => actions.setBlocks({ event: null })}>×</button></span>
        )}
        <span className="iom-zoombtns" role="group" aria-label="Zoom">
          <button type="button" className="quiet icon-btn" onClick={zoomOut} disabled={!zoomed} aria-label="Zoom out" title="Zoom out: back to the previous zoom (− or a double-click on the map)"><ZoomOutIcon /></button>
          <button type="button" className="quiet icon-btn" onClick={zoomIn} disabled={!full} aria-label="Zoom in" title="Zoom in 2× on the middle (+); drag across the map to zoom on a stretch, ⌘/Ctrl + wheel at the pointer"><ZoomInIcon /></button>
          <button type="button" className="quiet" onClick={reset} disabled={!zoomed} aria-label="Reset the zoom" title="the whole range again (0)"><ScanIcon /><span className="iom-lbl"> Reset</span></button>
        </span>
        <button type="button" className="quiet tb-display" aria-pressed={side && tab === 'display'} onClick={() => openTab('display')} aria-label="Display"
          title="Display: object names (schema, PDB, partition, obj#), the block axis, the extents and the marks, in the side panel">
          <SlidersHorizontalIcon /><span className="iom-lbl"> Display</span>
        </button>
        <button type="button" className="quiet tb-panel icon-btn" aria-pressed={side && tab !== 'display'} onClick={() => (side ? setSide(false) : openTab(tab === 'display' ? 'objects' : tab))}
          aria-label="Side panel" title="the side panel: objects, statements, distributions"><PanelRightIcon /></button>
      </div>
    </div>
  )

  const m = view
  const k = map ? sampleStep(map) : 1
  const status = (
    <div className="iom-status">
      <span className="iom-counts" role="status">
        {m && m.total > 0 ? <>
          <b>{fmtInt(m.total)}</b> block I/O {m.total === 1 ? 'wait' : 'waits'} · {m.files.length} {m.files.length === 1 ? 'file' : 'files'}
          {map?.sampled && <> · <b className="bm-sampled" title="above the marks limit every k-th wait is drawn (Display › Marks raises it; zooming in needs fewer)">showing 1 in {fmtInt(k)}</b></>}
          {q.loading && <> · <Shimmer>loading…</Shimmer></>}
        </> : q.loading ? <Shimmer>loading…</Shimmer> : null}
      </span>
      {zoomed && (
        <span className="iom-zoom" role="group" aria-label="Zoom">
          <b>Zoom</b>
          {range ? <span>{at(range.startTim, range.endTim - range.startTim < 10_000)} → {at(range.endTim, range.endTim - range.startTim < 10_000)} · {fmtDur(range.endTim - range.startTim)}{full && <span className="muted"> of {fmtDur(full.endTim - full.startTim)}</span>}</span> : <span className="muted">whole time range</span>}
          {blockZooms > 0 && <span className="muted"> · blocks zoomed in {blockZooms} {blockZooms === 1 ? 'panel' : 'panels'}</span>}
          <button type="button" className="quiet" onClick={zoomOut} title="back to the previous zoom (−, double-click)"><UndoIcon /> Out</button>
          <button type="button" className="quiet" onClick={reset} title="the whole range (0)">Reset</button>
          {range && <button type="button" className="quiet" onClick={() => actions.setWindow({ startTim: range.startTim, endTim: range.endTim })}
            title="make this range the time window of every view (Statements, Waits, Timeline… then count only what happened in it)">Use as time window</button>}
        </span>
      )}
      <span className="iom-hint">
        <b>Drag</b> on the map to zoom: across = time, up or down = blocks, diagonal = both · <kbd>−</kbd> or double-click: back · <kbd>0</kbd> whole range · <kbd>⌘</kbd>/<kbd>Ctrl</kbd> + wheel{zoomed && range ? <> · <kbd>←</kbd> <kbd>→</kbd> pan</> : null}
      </span>
    </div>
  )

  let body: ReactNode
  if (!source.ready) body = <p className="muted small iom-msg" role="status">The I/O map needs the waits of the trace, which this report does not carry (written with -aggregate, or exported without facts).</p>
  else if (q.error) body = <p className="bm-error small iom-msg" role="alert">I/O map: {q.error}</p>
  else if (q.data === undefined) body = <p className="muted small iom-msg" role="status"><Shimmer>loading…</Shimmer></p>
  else if (q.data === null) body = <p className="muted small iom-msg" role="status">The I/O map needs the engine route api/io/map, which this engine does not serve: update mtkprof.</p>
  else if (q.data.total === 0 && !range) body = <BlockEmpty doc={doc} only={stmtSel} event={eventSel} />
  else body = (
    <Figure doc={doc} map={view!} full={full} navRows={navMap?.rows ?? null} range={range} top={top} settings={settings} loading={q.loading}
      focus={focus} hoverEntry={hoverEntry} onHoverEntry={setHoverEntry} onFocus={setFocus} onOnly={(s) => actions.setBlocks({ stmt: s })} />
  )

  return (
    <section className="iom" aria-label="I/O map">
      {toolbar}
      {status}
      <div className={'iom-body' + (side ? ' with-side' : '')}>
        <div className="iom-main">{body}</div>
        {side && (
          <aside className="lines-side iom-side" aria-label="Side panel">
            <SideHead tab={tab} onTab={setTab} onClose={() => setSide(false)} />
            <div className="iom-side-body" role="tabpanel">
              {tab === 'display'
                ? <DisplayTab doc={doc} settings={settings} limit={limit} setLimit={setLimit} setNames={setNames} setPacked={setPacked} setBands={setBands} />
                : !view || view.rows.length === 0
                  ? <p className="small muted">{q.loading ? 'loading…' : 'No block I/O in view.'}</p>
                  : tab === 'objects' ? <ObjectsTab doc={doc} map={view} k={k} names={names} focus={focus} onFocus={setFocus} />
                  : tab === 'statements' ? <StatementsTab doc={doc} map={view} k={k} only={stmtSel} focus={focus} onFocus={setFocus} onOnly={(s) => actions.setBlocks({ stmt: s })} />
                  : <DistTab doc={doc} map={view} k={k} />}
            </div>
          </aside>
        )}
      </div>
    </section>
  )
}

function SideHead({ tab, onTab, onClose }: { tab: SideTab; onTab(t: SideTab): void; onClose(): void }) {
  const active = SIDE_TABS.find((t) => t.tab === tab)
  const onKey = (e: React.KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    const i = SIDE_TABS.findIndex((t) => t.tab === tab)
    const to = SIDE_TABS[(i + (e.key === 'ArrowRight' ? 1 : SIDE_TABS.length - 1)) % SIDE_TABS.length]
    e.preventDefault()
    e.stopPropagation() // not a pan of the zoom
    const list = e.currentTarget // React clears currentTarget after the handler
    onTab(to.tab)
    queueMicrotask(() => list.querySelector<HTMLElement>(`[data-tab="${to.tab}"]`)?.focus())
  }
  return (
    <div className="lines-side-head">
      <span className="lines-tabs" role="tablist" aria-label="Side panel" onKeyDown={onKey}>
        {SIDE_TABS.map((t) => {
          const Icon = t.icon
          return (
            <button key={t.tab} type="button" role="tab" data-tab={t.tab} className="lines-tab" aria-selected={tab === t.tab} tabIndex={tab === t.tab ? 0 : -1}
              onClick={() => onTab(t.tab)} aria-label={t.label} title={`${t.label}: ${t.title}`}><Icon /></button>
          )
        })}
      </span>
      <h2 className="lines-side-title">{active?.label}</h2>
      <button type="button" className="quiet icon-btn" onClick={onClose} aria-label="Close the side panel" title="close the side panel"><CloseIcon /></button>
    </div>
  )
}

/** No block I/O in scope: why (no WAIT lines at all, no event with a block address, or all cache hits) and the scope it is about. */
function BlockEmpty({ doc, only, event }: { doc: TraceDoc; only: ID | null; event: ID | null }) {
  const state = useStore((s) => s)
  const chips = activeFilters(doc, state).filter((f) => f.kind !== 'idle' && f.kind !== 'statementCalls')
  const anyWaits = doc.events.length > 0 && doc.stats.events.length > 0
  const anyBlockEvent = doc.events.some(isBlockIO)
  return (
    <div className="bm-empty iom-msg" role="status">
      {!anyWaits ? (
        <p>This trace has no WAIT lines (traced without waits, level 1 or 4): there are no block addresses to show.</p>
      ) : !anyBlockEvent ? (
        <p>No wait event of this trace carries a file and block address: no physical I/O to show.</p>
      ) : (
        <p>No physical I/O waits in scope: every read was a buffer cache hit.</p>
      )}
      {anyWaits && (chips.length > 0 || only !== null || event !== null) && (
        <p className="small muted bm-scope">In scope: {chips.map((c) => <span key={c.kind} className="chip" title={c.title}>{c.label}: {c.text}</span>)}
          {only !== null && <span className="chip">only {stmtLabel(doc, only)}</span>}
          {event !== null && doc.events[event] && <span className="chip">only {doc.events[event].name}</span>}</p>
      )}
    </div>
  )
}

/** The hovered / pinned row is an index into `rows`: it only means something while the figure draws those rows (a zoom step replaces them). */
interface Hover { rows: number[][]; panel: number; row: number; x: number; y: number }
interface Pin { rows: number[][]; row: number; anchor: { x: number; y: number } }
interface Brush { pi: number; kind: 'x' | 'y' | 'xy'; x0: number; x1: number; y0: number; y1: number }

/** The figure: the navigator, the legend, brackets, one panel per file or object, the shared x axis; the tooltip and the pinned popover. */
function Figure({ doc, map, full, navRows, range, top, settings, loading, focus, hoverEntry, onHoverEntry, onFocus, onOnly }: {
  doc: TraceDoc; map: IOMap; full: TimeRange | null; navRows: number[][] | null; range: TimeRange | null; top: IOZoom | null; settings: Settings; loading: boolean
  focus: Focus; hoverEntry: string | null; onHoverEntry(e: string | null): void; onFocus(f: Focus): void; onOnly(s: ID | null): void
}) {
  const actions = useActions()
  const theme = useThemeTick()
  const [boxRef, boxW] = useWidth<HTMLDivElement>()
  useReveal(boxRef, loading) // the new map sharpens in where the stale one pulsed
  const plotW = Math.max(120, boxW - Y_AXIS - PAD_R)
  const k = sampleStep(map)
  const { colorBy, axis, names } = settings
  const rows = map.rows

  const cx = useMemo<ColorCtx>(() => ({
    objType: (o) => objInfo(doc, o).type,
    objOwner: (o) => objInfo(doc, o).owner,
    tablespace: (f) => doc.fileName(f)?.tablespace,
    session: (c) => doc.contexts[c]?.sessionId || undefined,
  }), [doc])
  const panels = useMemo(() => panelsOf(map, doc.events, { by: settings.panelsBy, packed: settings.packed, zoom: top?.blocks }), [map, doc, settings.panelsBy, settings.packed, top])
  const brackets = useMemo(() => bracketsOf(rows, (ctx) => doc.contexts[ctx]?.action ?? ''), [rows, doc])
  const xs = useMemo<XScale>(() => (axis === 'order' ? orderScale(rows.length, plotW, brackets.runs) : timeScale(rows, plotW, range)), [axis, rows, plotW, brackets, range])
  const coloring = useMemo(() => colorRows(map, doc.events, colorBy, cx), [map, doc, colorBy, cx])
  const bands = useMemo(() => panels.map((p) => (settings.bands ? bandsOf(map, doc.events, p, coloring.objectTone) : [])), [panels, map, doc, coloring, settings.bands])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resolved = useMemo(() => ({ tones: coloring.tones.map(toneColor), grid: resolveVar('--c-grid'), nav: resolveVar('--ink-3') }), [coloring, theme])
  const bandColors = useMemo(() => bands.map((bs) => bs.map((b) => ({ runs: b.runs, color: toneColor(b.tone) }))), [bands, resolved]) // eslint-disable-line react-hooks/exhaustive-deps
  /** the PDB of an object: the container of its first wait's session */
  const pdbOf = useMemo(() => {
    if (!names.pdb) return () => undefined
    const first = new Map<number, number>()
    for (const r of rows) if (!first.has(r[IO.obj])) first.set(r[IO.obj], r[IO.ctx])
    return (obj: number) => { const c = first.get(obj); return c === undefined ? undefined : pdbOfCtx(doc, c) }
  }, [rows, names.pdb, doc])

  // the highlight mask: the hovered legend entry, else the focus
  const mask = useMemo(() => {
    let test: ((i: number) => boolean) | null = null
    const at = (keys: string[]) => { const set = new Set(keys); const on = coloring.legend.map((l) => set.has(entryKey(l))); return (i: number) => on[coloring.entry[i]] }
    if (hoverEntry !== null) test = at([hoverEntry])
    else if (focus?.kind === 'legend' && focus.by === colorBy) test = at(focus.entries)
    else if (focus?.kind === 'obj') test = (i) => objKey(doc, rows[i]) === focus.key
    else if (focus?.kind === 'stmt') test = (i) => rows[i][IO.stmt] === focus.stmt
    if (!test) return null
    const m = new Uint8Array(rows.length)
    for (let i = 0; i < rows.length; i++) m[i] = test(i) ? 1 : 0
    return m
  }, [hoverEntry, focus, coloring, colorBy, rows, doc])

  const [hoverRaw, setHover] = useState<Hover | null>(null)
  const [pinRaw, setPin] = useState<Pin | null>(null)
  const hover = hoverRaw?.rows === rows ? hoverRaw : null
  const pin = pinRaw?.rows === rows && pinRaw.row < rows.length ? pinRaw : null
  const drag = useRef<{ pi: number; x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [brush, setBrush] = useState<Brush | null>(null)
  useEffect(() => { setPin(null); setHover(null) }, [map])

  // ⌘/Ctrl + wheel zooms the time at the pointer (a non-passive listener: the page must not scroll or zoom)
  const wheel = useRef({ xs, rows, full, range, top, at: 0 })
  wheel.current = { ...wheel.current, xs, rows, full, range, top }
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      const w = wheel.current
      if (!w.full) return
      e.preventDefault()
      const plot = el.querySelector<HTMLElement>('.bm-overlay')
      const left = plot ? plot.getBoundingClientRect().left : el.getBoundingClientRect().left + Y_AXIS
      const x = Math.max(0, Math.min(w.xs.width, e.clientX - left))
      const curR = w.range ?? w.full
      let pointer: number
      if (w.xs.mode === 'time') pointer = timOfX(w.xs, x)
      else { const i = Math.min(w.rows.length - 1, Math.max(0, Math.floor(indexOfX(w.xs, x)))); pointer = w.rows.length ? w.rows[i][IO.tim] : (curR.startTim + curR.endTim) / 2 }
      const factor = Math.max(0.5, Math.min(2, Math.exp(e.deltaY * 0.0025)))
      const next = scaleRange(curR, pointer, factor, w.full)
      const now = performance.now()
      const join = now - w.at < WHEEL_JOIN_MS && !!w.top
      w.at = now
      if (!next) { if (w.range) actions.zoomIO({ range: null, blocks: w.top?.blocks ?? {} }, join) ; return }
      actions.zoomIO({ range: next, blocks: w.top?.blocks ?? {} }, join)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [boxRef, actions])

  const localX = (e: RPointerEvent<Element>) => e.clientX - e.currentTarget.getBoundingClientRect().left
  const localY = (e: RPointerEvent<Element>) => e.clientY - e.currentTarget.getBoundingClientRect().top
  const onDown = (pi: number) => (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic events have no active pointer */ }
    const x = localX(e), y = localY(e)
    drag.current = { pi, x0: x, y0: y, x1: x, y1: y }
  }
  const onMove = (pi: number) => (e: RPointerEvent<SVGSVGElement>) => {
    const x = localX(e), y = localY(e)
    const d = drag.current
    if (d) {
      d.x1 = x; d.y1 = y
      const kind = dragKind(d.x1 - d.x0, d.y1 - d.y0)
      if (kind) { setBrush({ pi: d.pi, kind, x0: d.x0, x1: d.x1, y0: d.y0, y1: d.y1 }); setHover(null); return }
      setBrush(null) // back within the slop: a click again
    }
    const row = hitTest(xs, rows, panels[pi], x, y)
    setHover({ rows, panel: pi, row, x, y })
  }
  const onUp = (pi: number) => (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    drag.current = null
    setBrush(null)
    if (!d) return
    const kind = dragKind(d.x1 - d.x0, d.y1 - d.y0)
    if (kind) {
      const cur = top ?? { range: null, blocks: {} }
      let nextRange = cur.range
      if (kind !== 'y') {
        const a = Math.max(0, Math.min(d.x0, d.x1)), b = Math.min(xs.width, Math.max(d.x0, d.x1))
        const r = xs.mode === 'order'
          ? orderToTime(rows, Math.floor(indexOfX(xs, a)), Math.max(Math.floor(indexOfX(xs, a)), Math.ceil(indexOfX(xs, b)) - 1))
          : { startTim: timOfX(xs, a), endTim: timOfX(xs, b) }
        if (r) nextRange = r.endTim - r.startTim < MIN_ZOOM_US ? { startTim: (r.startTim + r.endTim - MIN_ZOOM_US) / 2, endTim: (r.startTim + r.endTim + MIN_ZOOM_US) / 2 } : r
      }
      let blocks = cur.blocks
      if (kind !== 'x') {
        const p = panels[d.pi]
        const rs = rangesAt(p.ys, d.y0, d.y1)
        if (rs.length) blocks = { ...cur.blocks, [p.key]: rs }
      }
      actions.zoomIO({ range: nextRange, blocks })
      return
    }
    const row = hitTest(xs, rows, panels[pi], localX(e), localY(e))
    setPin(row >= 0 ? { rows, row, anchor: { x: e.clientX, y: e.clientY } } : null)
  }

  const shown = hover && hover.row >= 0 && hover.row < rows.length && !pin ? hover.row : -1
  const crossX = hover ? hover.x : null

  // brackets over the figure: the phases on top, then the statements' stretches, each bracket right above its label, on up to three
  // rows so the labels of narrow stretches do not collide (a stretch with no room keeps an unlabelled bracket with a title)
  const span = (b: Bracket) => (xs.mode === 'order'
    ? { x0: xOfIndex(xs, b.i0), x1: xOfIndex(xs, b.i1) }
    : { x0: Math.max(0, xOfTim(xs, rows[b.i0][IO.tim] - rows[b.i0][IO.ela])), x1: Math.min(xs.width, xOfTim(xs, rows[b.i1 - 1][IO.tim])) })
  const stmtSpans = brackets.stmts.map((b) => {
    const s = span(b), label = stmtLabel(doc, b.key as number), counts = kindCounts(doc, b.byEvent, k)
    const width = Math.max(label.length * 7.4, counts.length * 6.1) + 6
    return { b, ...s, label, counts, width, lx: Math.max(0, Math.min(s.x0, xs.width - width)) } // a label near the right edge ends there
  })
  const rowsOf = labelRows(stmtSpans.map((s) => ({ x0: s.lx, x1: s.x1, width: s.width })))
  const nStmtRows = stmtSpans.length ? Math.max(1, ...rowsOf.map((r) => r + 1)) : 0
  const phaseSpans = brackets.phases.filter((b) => b.key !== '').map((b) => ({ b, ...span(b), width: String(b.key).length * 7 + 8 }))
  const phaseRow = labelRows(phaseSpans, 1)
  const phaseH = phaseSpans.length ? PHASE_ROW : 0
  const rowTop = (r: number) => phaseH + (r < 0 ? nStmtRows - 1 : r) * BRACKET_ROW
  const bracketH = phaseH + nStmtRows * BRACKET_ROW

  const ticks = useMemo(() => xTicks(xs, map, { base: doc.span.firstTim }), [xs, map, doc])
  const tStep = ticks.length > 1 ? ticks[1].value - ticks[0].value : 1

  return (
    <div className={'iom-figure-wrap' + (loading ? ' bm-stale' : '')}>
      <div className="bm-figure iom-figure" ref={boxRef}>
        {full && navRows && (
          <Navigator doc={doc} rows={navRows} full={full} range={range} width={plotW} color={resolved.nav}
            onRange={(r, replace) => actions.zoomIO({ range: r, blocks: top?.blocks ?? {} }, replace)} onReset={() => actions.resetIOZoom()} />
        )}
        <Legend doc={doc} coloring={coloring} by={colorBy} names={names} pdbOf={pdbOf} bands={settings.bands && bands.some((b) => b.length > 0)} theme={theme}
          focus={focus?.kind === 'legend' && focus.by === colorBy ? focus.entries : []} onHover={onHoverEntry}
          onToggle={(e, add) => {
            const cur = focus?.kind === 'legend' && focus.by === colorBy ? focus.entries : []
            const next = cur.includes(e) ? cur.filter((x) => x !== e) : add ? [...cur, e] : [e]
            onFocus(next.length ? { kind: 'legend', by: colorBy, entries: next } : null)
          }} />
        {focus?.kind === 'legend' && focus.by === colorBy && !coloring.legend.some((l) => focus.entries.includes(entryKey(l))) && (
          <p className="iom-focus small">What is highlighted has no waits in this range.
            <button type="button" className="quiet" onClick={() => onFocus(null)} aria-label="Stop highlighting" title="stop highlighting">×</button></p>
        )}
        {(colorBy === 'type' || colorBy === 'schema' || colorBy === 'tablespace') && coloring.legend.every((l) => l.kind === 'none' || l.kind === 'rest') && (
          <p className="iom-focus small muted">Nothing here is named by {colorBy === 'type' ? 'a plan or ' : ''}a reference bundle: the bundle names owners, types and tablespaces. <ImportNames doc={doc} /></p>
        )}
        {focus && focus.kind !== 'legend' && (
          <p className="iom-focus small">Highlighting {focus.kind === 'obj' ? 'one object' : <StmtLink doc={doc} id={focus.stmt} />}
            <button type="button" className="quiet" onClick={() => onFocus(null)} aria-label="Stop highlighting" title="stop highlighting">×</button></p>
        )}
        {rows.length === 0 && <p className="muted small">No block I/O in this range: zoom out (−) or reset (0).</p>}
        {bracketH > 0 && (
          <div className="bm-brackets" style={{ marginInlineStart: Y_AXIS, inlineSize: plotW, blockSize: bracketH }}>
            <svg width={plotW} height={bracketH} aria-hidden="true">
              {phaseSpans.map((p, i) => (
                <path key={`p${i}`} className="bm-bracket-phase" d={`M${p.x0 + 0.5},${PHASE_ROW - 3} V${PHASE_ROW - 8} H${Math.max(p.x0 + 2, p.x1 - 1.5)} V${PHASE_ROW - 3}`}><title>{`phase ${p.b.key}`}</title></path>
              ))}
              {stmtSpans.map((s, i) => {
                const y = rowTop(rowsOf[i]) + 3
                return <path key={i} className="bm-bracket" d={`M${s.x0 + 0.5},${y + 5} V${y} H${Math.max(s.x0 + 2, s.x1 - 1.5)} V${y + 5}`}><title>{`${s.label}: ${s.counts}`}</title></path>
              })}
            </svg>
            {phaseSpans.map((p, i) => phaseRow[i] >= 0 && <span key={`p${i}`} className="bm-phase mono" style={{ left: p.x0, top: 0 }} title={`phase ${p.b.key} (the context's action)`}>{p.b.key}</span>)}
            {stmtSpans.map((s, i) => rowsOf[i] >= 0 && (
              <span key={i} className="bm-stmt" style={{ left: s.lx, top: rowTop(rowsOf[i]) + 8 }}>
                {(s.b.key as number) >= 0 ? <StmtLink doc={doc} id={s.b.key as number} /> : <span className="muted">no statement</span>}
                <small>{s.counts}</small>
              </span>
            ))}
          </div>
        )}
        {panels.map((p, pi) => (
          <div className="bm-panel" key={p.key}>
            <div className="bm-title" style={{ marginInlineStart: Y_AXIS }}>
              <PanelTitle doc={doc} p={p} names={names} pdbOf={pdbOf} bands={bands[pi]} sampled={map.sampled} k={k} />
              {p.zoomed && (
                <button type="button" className="quiet iom-unzoom" title="all the blocks of this panel again"
                  onClick={() => { const b = { ...top!.blocks }; delete b[p.key]; actions.zoomIO({ range: top!.range, blocks: b }) }}>all blocks</button>
              )}
            </div>
            <div className="bm-plot" style={{ blockSize: p.height }}>
              <span className="iom-ytitle" style={{ height: p.height }} aria-hidden="true">block #</span>
              <div className="bm-yticks" style={{ inlineSize: Y_AXIS - RULER_X - 4 }} aria-hidden="true">
                {yTicks(p.ys).map((t, i) => (
                  <span key={`${t.file}:${t.block}:${i}`} style={{ top: t.y }} className={t.first && p.ys.packed && i > 0 ? 'iom-seam' : undefined}>
                    {p.files.length > 1 && t.first ? <small>{t.file}:</small> : null}{fmtInt(t.block)}
                  </span>
                ))}
              </div>
              <PanelCanvas panel={p} rows={rows} xs={xs} coloring={coloring} tones={resolved.tones} grid={resolved.grid} bands={bandColors[pi]} focus={mask} left={Y_AXIS - RULER_X} />
              <svg className="bm-overlay" style={{ left: Y_AXIS }} width={xs.width} height={p.height}
                role="img" aria-label={`${panelName(doc, p)}: ${fmtInt(p.n)} block I/O waits; drag to zoom (across: time, up or down: blocks), double-click to zoom out, click a mark for its line`}
                onPointerDown={onDown(pi)} onPointerMove={onMove(pi)} onPointerUp={onUp(pi)} onPointerLeave={() => setHover(null)}
                onPointerCancel={() => { drag.current = null; setBrush(null) }} onDoubleClick={() => { setPin(null); actions.zoomOutIO() }}>
                {brush && (brush.pi === pi || brush.kind !== 'y') && (() => {
                  const xa = Math.min(brush.x0, brush.x1), xb = Math.max(brush.x0, brush.x1), ya = Math.min(brush.y0, brush.y1), yb = Math.max(brush.y0, brush.y1)
                  if (brush.pi !== pi || brush.kind === 'x') return <rect className="bm-brush" x={xa} y={0} width={xb - xa} height={p.height} />
                  if (brush.kind === 'y') return <rect className="bm-brush" x={0} y={ya} width={xs.width} height={yb - ya} />
                  return <rect className="bm-brush" x={xa} y={ya} width={xb - xa} height={yb - ya} />
                })()}
                {crossX !== null && !brush && <line className="bm-cross" x1={crossX + 0.5} x2={crossX + 0.5} y1={0} y2={p.height} />}
                {hover && hover.panel === pi && !brush && <line className="bm-cross" x1={0} x2={xs.width} y1={hover.y + 0.5} y2={hover.y + 0.5} />}
                {(pin?.row ?? shown) >= 0 && p.rows.includes(pin?.row ?? shown) && (() => {
                  const i = pin?.row ?? shown
                  const r = rows[i]
                  const sp = ySpan(p.ys, r[IO.file], r[IO.block], r[IO.block] + r[IO.blocks])
                  if (!sp) return null
                  const x = xs.mode === 'order' ? xOfIndex(xs, i) : xOfTim(xs, r[IO.tim] - r[IO.ela])
                  return <rect className="bm-hit" x={Math.floor(x) - 2} y={Math.min(sp.top, sp.bottom - 1) - 2} width={5} height={Math.max(1, sp.bottom - sp.top) + 4} />
                })()}
              </svg>
            </div>
          </div>
        ))}
        <div className="bm-xaxis" style={{ marginInlineStart: Y_AXIS, inlineSize: xs.width }} aria-hidden="true">
          {xs.mode === 'order' && xs.segs.slice(1).map((s) => <i key={s.i0} className="bm-break" style={{ left: s.x0 }} />)}
          {ticks.map((t, i) => (
            <span key={`${t.value}:${i}`} style={{ left: t.x }}>{xs.mode === 'order' ? fmtInt(t.value) : tickLabel(t.value, tStep) + (i === 0 ? ` ${tickUnit(tStep)}` : '')}</span>
          ))}
        </div>
        <p className="iom-xtitle small" style={{ marginInlineStart: Y_AXIS, inlineSize: xs.width }}>
          {xs.mode === 'order'
            ? <><b>I/O order</b>: the n-th block I/O wait{range ? ' in the zoomed range' : ''}, of {fmtInt(map.total)}{xs.stretch > 1.05 && <> · short stretches widened up to {Math.round(xs.stretch)}× so their marks stay readable (breaks marked on the axis)</>}</>
            : <><b>Time</b> since the start of the trace ({tickUnit(tStep)}) · each mark spans its wait [tim − ela, tim]</>}
        </p>
      </div>
      {shown >= 0 && hover && <Tip doc={doc} row={rows[shown]} names={names} panelEl={boxRef.current} hover={hover} />}
      {pin && <PinPop doc={doc} row={rows[pin.row]} names={names} anchor={pin.anchor} onClose={() => setPin(null)} onOnly={onOnly} />}
    </div>
  )
}

const panelName = (doc: TraceDoc, p: Panel) => (p.kind === 'file' ? fileTitle(doc, p.file, p.temp) : p.kind === 'object' ? objText(objInfo(doc, p.obj), DEFAULT_NAME_OPTS)
  : p.kind === 'temp' ? `temp waits, ${fileTitle(doc, p.file, true)}` : p.kind === 'none' ? `no object, file ${p.file}` : 'other objects')

/** A panel's title: the file (with the objects it holds) or the object (with its type and files), and its counts. */
function PanelTitle({ doc, p, names, pdbOf, bands, sampled, k }: {
  doc: TraceDoc; p: Panel; names: NameOpts; pdbOf(obj: number): string | undefined; bands: { obj: number; runs: unknown[]; blocks: number; tone: Tone }[]; sampled: boolean; k: number
}) {
  const waits = <span className="muted"> · {k > 1 && p.kind !== 'file' ? '≈' : ''}{fmtInt(p.kind === 'file' ? p.n : p.n * k)} {p.n === 1 ? 'wait' : 'waits'}</span>
  if (p.kind === 'file') {
    return (
      <>
        <b>{fileTitle(doc, p.file, p.temp)}</b>{waits}
        <span className="muted"> · blocks {fmtInt(p.lo)} to {fmtInt(p.hi - 1)}</span>
        {[...bands].sort((a, b) => b.blocks - a.blocks || a.obj - b.obj).slice(0, TITLE_OBJECTS).map((b) => (
          <span key={b.obj} className="bm-obj"><i className="swatch" style={{ background: toneColor(b.tone) }} /><ObjName doc={doc} obj={b.obj} opts={names} pdb={pdbOf(b.obj)} />
            <span className="muted">{fmtInt(b.runs.length)} {b.runs.length === 1 ? 'range' : 'ranges'} · {fmtInt(b.blocks)} {b.blocks === 1 ? 'block' : 'blocks'}{sampled ? ' in the sample' : ''}</span></span>
        ))}
        {bands.length > TITLE_OBJECTS && <span className="muted">+{bands.length - TITLE_OBJECTS} more objects (Objects tab)</span>}
        {p.rows.length === 0 && <span className="muted"> · none of them in the sample</span>}
      </>
    )
  }
  const filesTxt = p.files.map((f) => `${f}`).join(', ')
  if (p.kind === 'object') {
    const info = objInfo(doc, p.obj)
    return <><b><ObjName doc={doc} obj={p.obj} opts={names} pdb={pdbOf(p.obj)} /></b>{info.type && <span className="iom-type">{info.type}</span>}{waits}<span className="muted"> · {p.files.length === 1 ? 'file' : 'files'} {filesTxt}</span></>
  }
  if (p.kind === 'temp') return <><b>temp segments</b>{waits}<span className="muted"> · {fileTitle(doc, p.file, true)}</span></>
  if (p.kind === 'none') return <><b>no object</b>{waits}<span className="muted"> · file {p.file}</span></>
  return <><b>other objects</b>{waits}<span className="muted"> · {p.files.length === 1 ? 'file' : 'files'} {filesTxt}</span></>
}

/** One panel's canvas: painted by `drawBlockMap` whenever the data, the size, the colours or the highlight change (not on hover). */
const PanelCanvas = memo(function PanelCanvas({ panel, rows, xs, coloring, tones, grid, bands, focus, left }: {
  panel: Panel; rows: number[][]; xs: XScale; coloring: Coloring; tones: string[]; grid: string; bands: { runs: { lo: number; hi: number }[]; color: string }[]; focus: Uint8Array | null; left: number
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const w = xs.width + RULER_X, h = panel.height
  useEffect(() => {
    const cv = ref.current
    if (!cv || w <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(w * dpr)
    cv.height = Math.round(h * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, RULER_X * dpr, 0)
    drawBlockMap(ctx, panel, rows, xs, coloring.idx, { tones, grid, bands }, focus)
  }, [panel, rows, xs, coloring, tones, grid, bands, focus, w, h])
  return <canvas ref={ref} className="bm-canvas" style={{ left, inlineSize: w, blockSize: h }} />
})

/**
 * The navigator: the I/O over the whole range (the unzoomed answer's waits per 2 px, square-root scale) with the zoomed range as a
 * box. Drag the box to pan, drag beside it for a new range, click to centre the box there, double-click for the whole range.
 */
function Navigator({ doc, rows, full, range, width, color, onRange, onReset }: {
  doc: TraceDoc; rows: number[][]; full: TimeRange; range: TimeRange | null; width: number; color: string
  onRange(r: TimeRange, replace: boolean): void; onReset(): void
}) {
  const ref = useRef<HTMLCanvasElement>(null)
  const xs = useMemo(() => timeScale([], width, full), [width, full])
  useEffect(() => {
    const cv = ref.current
    if (!cv || width <= 0) return
    const dpr = window.devicePixelRatio || 1
    cv.width = Math.round(width * dpr); cv.height = Math.round(NAV_H * dpr)
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, width, NAV_H)
    const bins = new Float64Array(Math.max(1, Math.ceil(width / 2)))
    for (const r of rows) { const b = Math.floor(xOfTim(xs, r[IO.tim] - r[IO.ela] / 2) / 2); if (b >= 0 && b < bins.length) bins[b] += 1 }
    let max = 0
    for (const v of bins) max = Math.max(max, v)
    ctx.fillStyle = color
    ctx.globalAlpha = 0.75
    for (let b = 0; b < bins.length; b++) if (bins[b] > 0) { const hh = Math.max(1, Math.sqrt(bins[b] / max) * (NAV_H - 4)); ctx.fillRect(b * 2, NAV_H - hh, 2, hh) }
  }, [rows, xs, width, color])
  const drag = useRef<{ mode: 'pan' | 'new'; x0: number; off: number; moved: boolean } | null>(null)
  const [sel, setSel] = useState<{ a: number; b: number } | null>(null)
  const box = range ? { a: Math.max(0, xOfTim(xs, range.startTim)), b: Math.min(width, xOfTim(xs, range.endTim)) } : null
  const lx = (e: RPointerEvent<Element>) => Math.max(0, Math.min(width, e.clientX - e.currentTarget.getBoundingClientRect().left))
  const len = range ? range.endTim - range.startTim : 0
  const centreAt = (x: number) => { const c = timOfX(xs, x); const a = Math.max(full.startTim, Math.min(full.endTim - len, c - len / 2)); return { startTim: a, endTim: a + len } }
  const ticks = xTicks(xs, { total: 0, rows: [] }, { base: doc.span.firstTim, minGapPx: 110 })
  const tStep = ticks.length > 1 ? ticks[1].value - ticks[0].value : 1
  return (
    <div className="iom-nav" style={{ marginInlineStart: Y_AXIS, inlineSize: width }}>
      <span className="iom-nav-lbl" style={{ inlineSize: Y_AXIS - 8, insetInlineStart: -Y_AXIS }} title="all the block I/O in scope over time; the box is the zoomed range: drag it to pan, drag beside it for a new range, double-click for the whole range">time, all</span>
      <canvas ref={ref} style={{ inlineSize: width, blockSize: NAV_H }} />
      <svg width={width} height={NAV_H} className="iom-nav-ov" role="slider" aria-label="Zoomed time range" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={box ? Math.round((box.a / Math.max(1, width)) * 100) : 0}
        onPointerDown={(e) => {
          if (e.button !== 0) return
          try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic */ }
          const x = lx(e)
          drag.current = box && x >= box.a - 3 && x <= box.b + 3 ? { mode: 'pan', x0: x, off: x - box.a, moved: false } : { mode: 'new', x0: x, off: 0, moved: false }
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d) return
          const x = lx(e)
          if (Math.abs(x - d.x0) >= 3) d.moved = true
          if (!d.moved) return
          if (d.mode === 'pan' && range) onRange(centreAt(x - d.off + (box!.b - box!.a) / 2), true)
          else if (d.mode === 'new') setSel({ a: Math.min(d.x0, x), b: Math.max(d.x0, x) })
        }}
        onPointerUp={(e) => {
          const d = drag.current
          drag.current = null
          setSel(null)
          if (!d) return
          const x = lx(e)
          if (d.mode === 'new' && d.moved) {
            const a = timOfX(xs, Math.min(d.x0, x)), b = timOfX(xs, Math.max(d.x0, x))
            if (b - a >= MIN_ZOOM_US && b - a < full.endTim - full.startTim) onRange({ startTim: a, endTim: b }, false)
          } else if (!d.moved && range && d.mode === 'new') onRange(centreAt(x), true)
        }}
        onDoubleClick={onReset}>
        {box && <>
          <rect className="iom-nav-dim" x={0} y={0} width={box.a} height={NAV_H} />
          <rect className="iom-nav-dim" x={box.b} y={0} width={Math.max(0, width - box.b)} height={NAV_H} />
          <rect className="iom-nav-box" x={box.a + 0.5} y={0.5} width={Math.max(2, box.b - box.a - 1)} height={NAV_H - 1} />
        </>}
        {sel && <rect className="bm-brush" x={sel.a} y={0} width={sel.b - sel.a} height={NAV_H} />}
      </svg>
      <div className="iom-nav-ticks" aria-hidden="true">
        {ticks.map((t, i) => <span key={i} style={{ left: t.x }}>{tickLabel(t.value, tStep)}{i === 0 ? ` ${tickUnit(tStep)}` : ''}</span>)}
      </div>
    </div>
  )
}

/** The legend: one button per colour (a click keeps only its marks bright, ⌘/Ctrl/Shift-click adds one; hovering previews). `theme` only repaints the swatches. */
const Legend = memo(function Legend({ doc, coloring, by, names, pdbOf, bands, focus, onHover, onToggle }: {
  doc: TraceDoc; coloring: Coloring; by: ColorBy; names: NameOpts; pdbOf(obj: number): string | undefined; bands: boolean; theme: string
  focus: string[]; onHover(e: string | null): void; onToggle(e: string, add: boolean): void
}) {
  const label = (l: LegendEntry): ReactNode => {
    switch (l.kind) {
      case 'event': return doc.events[l.key as number]?.name ?? `event ${l.key}`
      case 'object': return <ObjName doc={doc} obj={l.key as number} opts={names} pdb={pdbOf(l.key as number)} />
      case 'statement': return <span className="mono">{stmtLabel(doc, l.key as number)}</span>
      case 'file': return fileTitle(doc, l.key as number, false)
      case 'rest': return 'others'
      default: return l.label ?? String(l.key)
    }
  }
  return (
    <div className="bm-legend iom-legend small" role="group" aria-label={`Legend: colour by ${colorLabel(by).toLowerCase()}`} onMouseLeave={() => onHover(null)}>
      <span className="iom-legend-h">{colorLabel(by)}</span>
      {coloring.legend.map((l) => (
        <button key={entryKey(l)} type="button" className="k" aria-pressed={focus.includes(entryKey(l))} onMouseEnter={() => onHover(entryKey(l))} onFocus={() => onHover(entryKey(l))} onBlur={() => onHover(null)}
          onClick={(e) => onToggle(entryKey(l), e.shiftKey || e.metaKey || e.ctrlKey)} title="highlight these marks (⌘/Ctrl/Shift-click adds to the highlight; click again to stop)">
          <i className="swatch" style={{ background: toneColor(l.tone) }} />
          {label(l)}
          <span className="muted">{fmtInt(l.rows)}</span>
        </button>
      ))}
      {bands && <span className="k muted iom-bandkey"><i className="swatch bm-band-swatch" />bands and the ruler: the block ranges each object's reads touched</span>}
    </div>
  )
})

/** What one row is, for the tooltip and the popover. */
function RowFacts({ doc, row, names, links }: { doc: TraceDoc; row: number[]; names: NameOpts; links: boolean }) {
  const ev = doc.events[row[IO.event]]
  const b = row[IO.block], n = row[IO.blocks]
  const fname = doc.fileName(row[IO.file])?.name
  const pdb = pdbOfCtx(doc, row[IO.ctx])
  const info = objInfo(doc, row[IO.obj])
  return (
    <>
      <div className="bm-tip-h"><b>{ev?.name ?? `event ${row[IO.event]}`}</b> <span className="muted">{fmtDur(row[IO.ela])}</span></div>
      <div>file {row[IO.file]}{fname ? <span className="muted"> ({fname.split(/[\\/]/).pop()})</span> : null} · {n > 1 ? <>blocks {fmtInt(b)} to {fmtInt(b + n - 1)} ({fmtInt(n)})</> : <>block {fmtInt(b)}</>}</div>
      <div>{row[IO.obj] >= 0 ? <><ObjName doc={doc} obj={row[IO.obj]} opts={names} pdb={pdb} />{info.type && <span className="muted"> · {info.type}</span>}{isTempEvent(ev) && <span className="muted"> (the statement's object; temp blocks)</span>}</> : <span className="muted">no object</span>}</div>
      <div>{links && row[IO.stmt] >= 0 ? <StmtLink doc={doc} id={row[IO.stmt]} /> : <span className="mono">{stmtLabel(doc, row[IO.stmt])}</span>}{row[IO.dep] > 0 && <span className="muted"> · recursive, depth {row[IO.dep]}</span>}{pdb && <span className="muted"> · {pdb}</span>}</div>
      <div>{links ? <LineRef line={row[IO.line]} file={doc.fileOfCtx(row[IO.ctx])} /> : <span className="muted">line {fmtInt(row[IO.line])} · click to pin</span>}</div>
    </>
  )
}

function Tip({ doc, row, names, hover, panelEl }: { doc: TraceDoc; row: number[]; names: NameOpts; hover: Hover; panelEl: HTMLElement | null }) {
  const plot = panelEl?.querySelectorAll<HTMLElement>('.bm-plot')[hover.panel]
  if (!plot) return null
  const r = plot.getBoundingClientRect()
  const x = r.left + Y_AXIS + hover.x, y = r.top + hover.y
  const right = x + 300 > window.innerWidth
  return createPortal(
    <div className="bm-tip small" style={{ left: right ? x - 12 : x + 14, top: y + 14, translate: right ? '-100% 0' : undefined }} role="tooltip">
      <RowFacts doc={doc} row={row} names={names} links={false} />
    </div>,
    document.body,
  )
}

function PinPop({ doc, row, names, anchor, onClose, onOnly }: { doc: TraceDoc; row: number[]; names: NameOpts; anchor: { x: number; y: number }; onClose: () => void; onOnly: (s: ID | null) => void }) {
  const root = usePopover(anchor, onClose, [row])
  return createPortal(
    <div className="stmt-pop bm-pop small" ref={root} role="dialog" aria-label="Block I/O wait" onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className="quiet stmt-pop-x" data-first onClick={onClose} aria-label="Close" title="close (Esc)">×</button>
      <RowFacts doc={doc} row={row} names={names} links />
      {row[IO.stmt] >= 0 && <div className="bm-pop-acts"><button type="button" onClick={() => { onOnly(row[IO.stmt]); onClose() }}>Only this statement</button></div>}
    </div>,
    document.body,
  )
}

// ---- the side panel -------------------------------------------------------------------------------

/** "≈1,331" for a count of a sampled answer (× the step), else the count. */
const approx = (n: number, k: number) => `${k > 1 ? '≈' : ''}${fmtInt(n * k)}`

function SampleNote({ map, k }: { map: IOMap; k: number }) {
  return map.sampled ? <p className="bm-note small"><b>showing 1 in {fmtInt(k)}</b>: the numbers count the waits drawn (× {fmtInt(k)} where marked ≈).</p> : null
}

/** The Objects tab: per object (temp waits per file) what its waits did, most time first; a click highlights its marks. */
function ObjectsTab({ doc, map, k, names, focus, onFocus }: { doc: TraceDoc; map: IOMap; k: number; names: NameOpts; focus: Focus; onFocus(f: Focus): void }) {
  const stats = useMemo(() => objectStats(map.rows, (e) => isWriteEvent(doc.events[e]), (e) => isTempEvent(doc.events[e])), [map, doc])
  const counts = nameCounts(doc)
  const unnamed = stats.filter((s) => s.obj >= 0 && !objInfo(doc, s.obj).name).length
  const noOwner = stats.some((s) => s.obj >= 0 && objInfo(doc, s.obj).from === 'plan')
  const pdbOf = (s: ObjStat) => { if (!names.pdb) return undefined; const r = map.rows.find((x) => objKey(doc, x) === s.key); return r ? pdbOfCtx(doc, r[IO.ctx]) : undefined }
  const total = stats.reduce((a, s) => a + s.us, 0)
  return (
    <div className="iom-tab">
      <SampleNote map={map} k={k} />
      <p className="ld-note">
        Names: {counts.ref > 0 && <>{fmtInt(counts.ref)} from the reference bundle{counts.plan > 0 ? ', ' : ''}</>}{counts.plan > 0 && <>{fmtInt(counts.plan)} from the trace's plans</>}{counts.ref + counts.plan === 0 && 'none known'}.
        {(unnamed > 0 || noOwner) && <> {unnamed > 0 ? `${unnamed} ${unnamed === 1 ? 'object has' : 'objects have'} only an obj#` : 'Plan names have no owner or type detail'}: a reference bundle names them. <ImportNames doc={doc} /></>}
      </p>
      <ol className="iom-objs">
        {stats.map((s) => {
          const on = focus?.kind === 'obj' && focus.key === s.key
          const info = s.obj >= 0 ? objInfo(doc, s.obj) : null
          return (
            <li key={s.key}>
              <button type="button" className={'iom-objrow' + (on ? ' on' : '')} aria-pressed={on} onClick={() => onFocus(on ? null : { kind: 'obj', key: s.key })} title={on ? 'stop highlighting' : 'highlight its marks'}>
                <span className="iom-objrow-h">
                  {s.temp ? <b>temp segments <span className="muted">· {fileTitle(doc, s.files[0], true)}</span></b>
                    : s.obj < 0 ? <b>no object <span className="muted">· file {s.files.join(', ')}</span></b>
                    : <b><ObjName doc={doc} obj={s.obj} opts={names} pdb={pdbOf(s)} /></b>}
                  {info?.type && <span className="iom-type">{info.type}</span>}
                  <span className="iom-objrow-t">{fmtDur(s.us * k)}</span>
                </span>
                <span className="iom-share" aria-hidden="true"><i style={{ inlineSize: `${total > 0 ? (100 * s.us) / total : 0}%` }} /></span>
                <span className="iom-objrow-f muted">
                  {approx(s.waits, k)} {s.waits === 1 ? 'wait' : 'waits'}{s.writes > 0 && <> ({approx(s.writes, k)} {s.writes === 1 ? 'write' : 'writes'})</>}
                  {' · '}{approx(s.blocks, k)} blocks, {fmtInt(s.distinct)} distinct
                  {s.readsPerBlock >= 1.05 && <> · <b>{s.readsPerBlock.toFixed(1)}×</b> re-read</>}
                  {' · '}avg {fmtDur(s.us / s.waits)}
                  {!Number.isNaN(s.seq) && <> · <span title="the share of its waits that continue the previous one upward within 64 blocks: a full scan is near 100 %, single-block lookups near 0 %">{Math.round(s.seq * 100)} % sequential</span></>}
                  {' · '}{s.files.length === 1 ? 'file' : 'files'} {s.files.join(', ')}
                </span>
              </button>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** The Statements tab: per statement and file, reads and writes, the distinct blocks and how often each was read; a click highlights. */
function StatementsTab({ doc, map, k, only, focus, onFocus, onOnly }: { doc: TraceDoc; map: IOMap; k: number; only: ID | null; focus: Focus; onFocus(f: Focus): void; onOnly(s: ID | null): void }) {
  const rereads = useMemo(() => rereadOf(map.rows, (e) => isWriteEvent(doc.events[e])), [map, doc])
  const byStmt = new Map<number, typeof rereads>()
  for (const r of rereads) { const l = byStmt.get(r.key); if (l) l.push(r); else byStmt.set(r.key, [r]) }
  const stmts = [...byStmt.entries()].map(([s, l]) => ({ s, l, us: l.reduce((a, r) => a + r.us, 0) })).sort((a, b) => b.us - a.us || a.s - b.s)
  return (
    <div className="iom-tab bm-facts">
      <SampleNote map={map} k={k} />
      <p className="ld-note">Reads and writes per file; "× per block" is how often each distinct block was read (a multipass join reads its spill many times).</p>
      <ol>
        {stmts.map(({ s, l, us }) => {
          const on = focus?.kind === 'stmt' && focus.stmt === s
          return (
            <li key={s} className={on ? 'on' : undefined}>
              <div className="bm-facts-h">
                {s >= 0 ? <StmtLink doc={doc} id={s} /> : <span className="muted">no statement</span>}
                <span className="muted">{fmtDur(us * k)}</span>
                {s >= 0 && <button type="button" className="quiet bm-only" aria-pressed={on} onClick={() => onFocus(on ? null : { kind: 'stmt', stmt: s })} title="highlight its marks">highlight</button>}
                {s >= 0 && only === null && <button type="button" className="quiet" onClick={() => onOnly(s)} title="show only this statement's waits (a filter; × on its chip in the toolbar removes it)">only</button>}
              </div>
              {l.map((r) => (
                <div key={r.file} className="bm-facts-r">
                  <span className="muted">file {r.file}</span>
                  {r.reads > 0 && <span><b>{approx(r.reads, k)}</b> {r.reads === 1 ? 'read' : 'reads'} of {fmtInt(r.readDistinct)} {r.readDistinct === 1 ? 'block' : 'blocks'}{r.readsPerBlock >= 1.05 ? <>: <b>{r.readsPerBlock.toFixed(1)}×</b> per block</> : ''}</span>}
                  {r.writes > 0 && <span><b>{approx(r.writes, k)}</b> {r.writes === 1 ? 'write' : 'writes'} on {fmtInt(r.writeDistinct)} {r.writeDistinct === 1 ? 'block' : 'blocks'}</span>}
                </div>
              ))}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** The Distributions tab: per event a latency histogram (powers of two of µs) with p50 / p95 / p99, then blocks per wait. */
function DistTab({ doc, map, k }: { doc: TraceDoc; map: IOMap; k: number }) {
  const lat = useMemo(() => latencyHists(map.rows), [map])
  const sizes = useMemo(() => sizeHists(map.rows), [map])
  let lo = LAT_BUCKETS, hi = 0
  for (const h of lat) h.buckets.forEach((n, b) => { if (n > 0) { lo = Math.min(lo, b); hi = Math.max(hi, b) } })
  lo = Math.max(0, Math.min(lo, hi - 5)); hi = Math.max(hi, lo + 5)
  const span = hi - lo + 1
  const bucketTxt = (b: number) => fmtDur(latBucketLo(b))
  return (
    <div className="iom-tab">
      <SampleNote map={map} k={k} />
      <section className="ld-sec">
        <h4>Latency <span className="h4-note">· waits per bucket of time (×2 each), per event</span></h4>
        {lat.map((h) => {
          const max = Math.max(...h.buckets)
          return (
            <div key={h.event} className="iom-hist">
              <div className="iom-hist-h"><b>{doc.events[h.event]?.name ?? `event ${h.event}`}</b><span className="muted">{approx(h.n, k)} · {fmtDur(h.us * k)}</span></div>
              <div className="iom-bars" style={{ gridTemplateColumns: `repeat(${span}, 1fr)` }} role="img"
                aria-label={`latency of ${doc.events[h.event]?.name}: p50 ${fmtDur(h.p50)}, p95 ${fmtDur(h.p95)}, p99 ${fmtDur(h.p99)}, max ${fmtDur(h.max)}`}>
                {Array.from({ length: span }, (_, j) => {
                  const b = lo + j, n = h.buckets[b] ?? 0
                  return <i key={b} style={{ blockSize: `${n > 0 ? Math.max(6, (100 * n) / max) : 0}%` }} title={`${bucketTxt(b)} to ${bucketTxt(b + 1)}: ${approx(n, k)} ${n === 1 ? 'wait' : 'waits'}`} />
                })}
              </div>
              <div className="iom-hist-f muted">p50 <b>{fmtDur(h.p50)}</b> · p95 <b>{fmtDur(h.p95)}</b> · p99 <b>{fmtDur(h.p99)}</b> · max {fmtDur(h.max)}</div>
            </div>
          )
        })}
        <div className="iom-bars-axis" aria-hidden="true"><span>{bucketTxt(lo)}</span><span>{bucketTxt(lo + Math.floor(span / 2))}</span><span>{bucketTxt(hi + 1)}</span></div>
      </section>
      <section className="ld-sec">
        <h4>Blocks per wait <span className="h4-note">· multiblock reads against db_file_multiblock_read_count</span></h4>
        {sizes.map((h) => {
          const max = Math.max(...h.buckets)
          return (
            <div key={h.event} className="iom-hist">
              <div className="iom-hist-h"><b>{doc.events[h.event]?.name ?? `event ${h.event}`}</b><span className="muted">avg {(h.blocks / h.n).toFixed(1)} · max {fmtInt(h.max)}</span></div>
              <div className="iom-bars" style={{ gridTemplateColumns: `repeat(${h.buckets.length}, 1fr)` }} role="img" aria-label={`blocks per wait of ${doc.events[h.event]?.name}`}>
                {h.buckets.map((n, b) => <i key={b} style={{ blockSize: `${n > 0 ? Math.max(6, (100 * n) / max) : 0}%` }} title={`${SIZE_HIST_LABELS[b]} ${b === 0 ? 'block' : 'blocks'}: ${approx(n, k)} ${n === 1 ? 'wait' : 'waits'}`} />)}
              </div>
            </div>
          )
        })}
        <div className="iom-bars-axis" aria-hidden="true"><span>1</span><span>8</span><span>129+ blocks</span></div>
      </section>
    </div>
  )
}

/** The Display tab: object names, the block axis, the extents, the marks, and the keys. */
function DisplayTab({ doc, settings, limit, setLimit, setNames, setPacked, setBands }: {
  doc: TraceDoc; settings: Settings; limit: number; setLimit(n: number): void; setNames(n: NameOpts): void; setPacked(b: boolean): void; setBands(b: boolean): void
}) {
  const n = settings.names
  const cdb = hasContainers(doc)
  const counts = nameCounts(doc)
  const flag = (key: keyof NameOpts, label: string, note: string, disabled = false) => (
    <label className="ld-row" title={note}>
      <input type="checkbox" checked={n[key] && !disabled} disabled={disabled} onChange={(e) => setNames({ ...n, [key]: e.target.checked })} />
      <span className="ld-lbl">{label}</span><span />
      <p className="ld-note">{note}</p>
    </label>
  )
  return (
    <div className="iom-tab lines-side-display">
      <section className="ld-sec">
        <h4>Object names <span className="h4-note">· {counts.ref > 0 ? 'reference bundle' : counts.plan > 0 ? "the trace's plans" : 'obj# only'}</span></h4>
        {flag('schema', 'Schema', counts.ref > 0 ? 'the owner before the name: MTK.MTK_CUST' : 'the owner before the name (the plans do not say it: needs a reference bundle)')}
        {flag('pdb', 'PDB', cdb ? 'the container the waits ran in: PDB1/MTK.MTK_CUST' : 'the container: this trace names none (a non-CDB, or older than 12.2)', !cdb)}
        {flag('sub', 'Partition', 'the subobject (partition) after the name, from a reference bundle')}
        {flag('num', 'obj#', 'the object number after the name: MTK_CUST #108609')}
        <p className="ld-note">Owners, types, partitions, tablespaces and file names: <ImportNames doc={doc}>Import names from the database…</ImportNames></p>
      </section>
      <section className="ld-sec">
        <h4>Block axis <span className="h4-note">· panels per file</span></h4>
        <div role="radiogroup" aria-label="Block axis">
          <label className="ld-row"><input type="radio" name="iom-axis" checked={!settings.packed} onChange={() => setPacked(false)} /><span className="ld-lbl">Linear</span><span /><p className="ld-note">the file's block numbers to scale</p></label>
          <label className="ld-row"><input type="radio" name="iom-axis" checked={settings.packed} onChange={() => setPacked(true)} /><span className="ld-lbl">Packed</span><span /><p className="ld-note">the empty block ranges between the touched ones collapsed</p></label>
        </div>
        <p className="ld-note">Panels per object always pack their blocks.</p>
      </section>
      <section className="ld-sec">
        <h4>Show</h4>
        <label className="ld-row"><input type="checkbox" checked={settings.bands} onChange={(e) => setBands(e.target.checked)} /><span className="ld-lbl">Object extents</span><span />
          <p className="ld-note">faint bands and a ruler for the block ranges each object's reads touched (panels per file)</p></label>
        <label className="ld-inline">Marks at most
          <select aria-label="At most this many marks" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            {LIMITS.map((l) => <option key={l} value={l}>{fmtInt(l)}</option>)}
          </select>
        </label>
        <p className="ld-note">Above it every k-th wait is drawn; a zoom asks again for its range, so it needs fewer.</p>
      </section>
      <section className="ld-sec">
        <h4>Zoom and keys</h4>
        <table className="lines-keys small"><tbody>
          <tr><th>drag across</th><td>zoom the time</td></tr>
          <tr><th>drag up or down</th><td>zoom the blocks of that panel</td></tr>
          <tr><th>drag diagonally</th><td>both</td></tr>
          <tr><th><kbd>⌘</kbd>/<kbd>Ctrl</kbd> + wheel</th><td>zoom the time at the pointer</td></tr>
          <tr><th><kbd>+</kbd> <kbd>−</kbd></th><td>zoom in on the middle / back one step (double-click too)</td></tr>
          <tr><th><kbd>0</kbd></th><td>the whole range</td></tr>
          <tr><th><kbd>←</kbd> <kbd>→</kbd></th><td>pan a zoomed range (or drag its box in the strip on top)</td></tr>
          <tr><th>legend</th><td>click: highlight that colour; ⌘/Ctrl/Shift-click: add one</td></tr>
          <tr><th><kbd>⌘I</kbd> / <kbd>Ctrl+I</kbd></th><td>this view, from any other</td></tr>
        </tbody></table>
      </section>
    </div>
  )
}
