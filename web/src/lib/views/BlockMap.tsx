import { memo, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TraceDoc } from '../data/doc'
import type { ID } from '../data/types'
import { IO, isBlockIO, orderToTime, rereadOf, sampleStep, type IOMap, type Reread } from '../data/iomap'
import {
  bandsOf, blockTicks, bracketsOf, colorRows, hitTest, indexOfX, isTempEvent, isWriteEvent, labelRows, orderScale, panelsOf, RULER_X,
  timeScale, timOfX, xOfIndex, xOfTim, xTicks, yOfBlock, drawBlockMap, type Bracket, type ColorBy, type Coloring, type Panel, type Tone, type XScale,
} from '../data/blocklayout'
import { scopeKey, useScope } from '../data/scopedstmts'
import { sourceOf, useSourceQuery } from '../data/source'
import { activeFilters } from '../data/filters'
import { fmtDur, fmtInt } from '../data/format'
import { tickLabel, tickUnit } from '../data/scale'
import { useActions, useStore } from '../state/session'
import { usePersisted } from '../state/persist'
import { resolveVar, tokenShade } from '../components/colors'
import { LineRef } from '../components/LineRef'
import { StmtLink } from '../components/StmtLink'
import { usePopover } from '../components/usePopover'
import '../styles/blockmap.css'

// The Blocks view (docs/PLAN-VIEWS.md § 6): every physical I/O wait with a block address at (I/O order or time, block number),
// one panel per file, marks as tall as the blocks they moved, coloured by event, object or statement, the objects' block ranges
// as faint bands. The layout is data/blocklayout.ts; this file measures, paints and handles the pointer.

const LIMITS = [5000, 20000, 100000] as const
const Y_AXIS = 64 // px left of the plot: the block numbers
const PAD_R = 6
const BRACKET_ROW = 36 // px per row of statement brackets: the bracket line, under it the sql_id and the counts
const PHASE_ROW = 24
const TITLE_OBJECTS = 4 // objects named in a panel's title, most blocks first

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

const objLabel = (doc: TraceDoc, obj: number) => (obj < 0 ? 'no object' : doc.objectName(obj) ?? `obj# ${obj}`)
const stmtLabel = (doc: TraceDoc, stmt: number) => { const s = doc.stmt(stmt); return s ? doc.label(s) : 'no statement' }

/** "file 12", "tempfile 203 · TEMP · temp01.dbf" (names from a reference bundle). */
function fileTitle(doc: TraceDoc, p: Panel): string {
  const ref = doc.fileName(p.file)
  const kind = p.temp || ref?.type?.toUpperCase() === 'TEMP' ? 'tempfile' : ref ? 'datafile' : 'file'
  const parts = [`${kind} ${p.file}`]
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

interface Hover { panel: number; row: number; x: number; y: number }
interface Pin { row: number; anchor: { x: number; y: number } }

export function BlockMap({ doc }: { doc: TraceDoc }) {
  const source = sourceOf(doc)
  const scope = useScope(doc)
  const [limitRaw, setLimit] = usePersisted<number>('mtkprof.blocks.limit', 20000)
  const [colorRaw, setColorBy] = usePersisted<ColorBy>('mtkprof.blocks.color', 'event')
  const [axisRaw, setAxis] = usePersisted<'order' | 'time'>('mtkprof.blocks.axis', 'order')
  const limit = (LIMITS as readonly number[]).includes(limitRaw) ? limitRaw : 20000
  const colorBy: ColorBy = colorRaw === 'object' || colorRaw === 'statement' ? colorRaw : 'event'
  const axis = axisRaw === 'time' ? 'time' : 'order'
  // the filter is in the store: the links into Blocks (statement inspector, Waits) set it (`showBlocks`)
  const actions = useActions()
  const { stmt: stmtSel, event: eventSel } = useStore((s) => s.blocks)
  const setStmtSel = (stmt: ID | null) => actions.setBlocks({ stmt })
  const q = useSourceQuery(source, `iomap:${scopeKey(scope)}:${limit}:${stmtSel ?? ''}:${eventSel ?? ''}`,
    (signal) => (source.ready ? source.ioMap(scope, limit, stmtSel ?? undefined, eventSel ?? undefined, signal) : null), 'iomap')

  const tools = (
    <span className="tools bm-tools">
      {stmtSel !== null && (
        <span className="chip" title="only the waits of this statement">only {stmtLabel(doc, stmtSel)}<button className="quiet" aria-label="Show all statements" onClick={() => setStmtSel(null)}>×</button></span>
      )}
      {eventSel !== null && doc.events[eventSel] && (
        <span className="chip" title="only the waits of this event">only {doc.events[eventSel].name}<button className="quiet" aria-label="Show all events" onClick={() => actions.setBlocks({ event: null })}>×</button></span>
      )}
      <span className="bm-ctl">colour
        <span className="seg" role="group" aria-label="Colour the marks by">
          {(['event', 'object', 'statement'] as const).map((c) => <button key={c} aria-pressed={colorBy === c} onClick={() => setColorBy(c)}>{c}</button>)}
        </span>
      </span>
      <span className="bm-ctl">x
        <span className="seg" role="group" aria-label="x axis">
          <button aria-pressed={axis === 'order'} onClick={() => setAxis('order')} title="the n-th physical I/O wait: scans, re-reads and spills stay visible">I/O order</button>
          <button aria-pressed={axis === 'time'} onClick={() => setAxis('time')} title="the waits on the clock">time</button>
        </span>
      </span>
      <label className="bm-ctl">marks
        <select aria-label="At most this many marks" value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
          {LIMITS.map((l) => <option key={l} value={l}>{fmtInt(l)}</option>)}
        </select>
      </label>
    </span>
  )

  let body: ReactNode
  if (!source.ready) body = <p className="muted small" role="status">The Blocks view needs the waits of the trace, which this report does not carry (written with -aggregate, or exported without facts).</p>
  else if (q.error) body = <p className="bm-error small" role="alert">Blocks: {q.error}</p>
  else if (q.data === undefined) body = <p className="muted small" role="status">loading…</p>
  else if (q.data === null) body = <p className="muted small" role="status">The Blocks view needs the engine route api/io/map, which this engine does not serve: update mtkprof.</p>
  else if (q.data.total === 0) body = <BlockEmpty doc={doc} only={stmtSel} event={eventSel} />
  else body = <BlockFigure doc={doc} map={q.data} axis={axis} colorBy={colorBy} loading={q.loading} onOnly={setStmtSel} only={stmtSel} />

  const m = q.data
  const k = m ? sampleStep(m) : 1
  return (
    <section className="section blockmap">
      <header>
        <h2>Blocks</h2>
        {m && m.total > 0 && (
          <span className="hint">
            {fmtInt(m.total)} block I/O {m.total === 1 ? 'wait' : 'waits'} · {m.files.length} {m.files.length === 1 ? 'file' : 'files'}
            {m.sampled && <> · <b className="bm-sampled">showing 1 in {fmtInt(k)} of {fmtInt(m.total)}</b></>}
            {q.loading && ' · loading…'}
          </span>
        )}
        {tools}
      </header>
      {body}
    </section>
  )
}

/** No block I/O in scope: why (no WAIT lines at all, no event with a block address, or all cache hits) and the scope it is about. */
function BlockEmpty({ doc, only, event }: { doc: TraceDoc; only: ID | null; event: ID | null }) {
  const state = useStore((s) => s)
  const chips = activeFilters(doc, state).filter((f) => f.kind !== 'idle' && f.kind !== 'statementCalls')
  const anyWaits = doc.events.length > 0 && doc.stats.events.length > 0
  const anyBlockEvent = doc.events.some(isBlockIO)
  return (
    <div className="bm-empty" role="status">
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

/** The figure: brackets, one panel per file, the shared x axis, the legend, the facts column; the tooltip and the pinned popover. */
function BlockFigure({ doc, map, axis, colorBy, loading, only, onOnly }: {
  doc: TraceDoc; map: IOMap; axis: 'order' | 'time'; colorBy: ColorBy; loading: boolean; only: ID | null; onOnly: (s: ID | null) => void
}) {
  const actions = useActions()
  const theme = useThemeTick()
  const [boxRef, boxW] = useWidth<HTMLDivElement>()
  const plotW = Math.max(120, boxW - Y_AXIS - PAD_R)
  const k = sampleStep(map)
  const panels = useMemo(() => panelsOf(map, doc.events), [map, doc])
  const brackets = useMemo(() => bracketsOf(map.rows, (ctx) => doc.contexts[ctx]?.action ?? ''), [map, doc])
  const xs = useMemo<XScale>(() => (axis === 'order' ? orderScale(map.rows.length, plotW, brackets.runs) : timeScale(map.rows, plotW)), [axis, map, plotW, brackets])
  const coloring = useMemo(() => colorRows(map, doc.events, colorBy), [map, doc, colorBy])
  const bands = useMemo(() => panels.map((p) => bandsOf(map, doc.events, p, coloring.objectTone)), [panels, map, doc, coloring])
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const resolved = useMemo(() => ({ tones: coloring.tones.map(toneColor), grid: resolveVar('--c-grid') }), [coloring, theme])
  const bandColors = useMemo(() => bands.map((bs) => bs.map((b) => ({ runs: b.runs, color: toneColor(b.tone) }))), [bands, resolved]) // eslint-disable-line react-hooks/exhaustive-deps

  const [hover, setHover] = useState<Hover | null>(null)
  const [pin, setPin] = useState<Pin | null>(null)
  const drag = useRef<{ x0: number; x1: number } | null>(null)
  const [brush, setBrush] = useState<{ a: number; b: number } | null>(null)
  useEffect(() => { setPin(null); setHover(null) }, [map])

  const localX = (e: RPointerEvent<Element>) => e.clientX - e.currentTarget.getBoundingClientRect().left
  const localY = (e: RPointerEvent<Element>) => e.clientY - e.currentTarget.getBoundingClientRect().top
  const onDown = (e: RPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic events have no active pointer */ }
    const x = localX(e)
    drag.current = { x0: x, x1: x }
  }
  const onMove = (pi: number) => (e: RPointerEvent<SVGSVGElement>) => {
    const x = localX(e), y = localY(e)
    const d = drag.current
    if (d) {
      d.x1 = x
      if (Math.abs(d.x1 - d.x0) >= 4) { setBrush({ a: Math.min(d.x0, d.x1), b: Math.max(d.x0, d.x1) }); setHover(null); return }
    }
    const row = hitTest(xs, map.rows, panels[pi], x, y)
    setHover({ panel: pi, row, x, y })
  }
  const onUp = (pi: number) => (e: RPointerEvent<SVGSVGElement>) => {
    const d = drag.current
    drag.current = null
    if (!d) return
    if (Math.abs(d.x1 - d.x0) >= 4) {
      setBrush(null)
      const a = Math.max(0, Math.min(d.x0, d.x1)), b = Math.min(xs.width, Math.max(d.x0, d.x1))
      const win = xs.mode === 'order'
        ? orderToTime(map.rows, Math.floor(indexOfX(xs, a)), Math.max(Math.floor(indexOfX(xs, a)), Math.ceil(indexOfX(xs, b)) - 1))
        : { startTim: timOfX(xs, a), endTim: timOfX(xs, b) }
      if (win) actions.setWindow(win)
      return
    }
    const row = hitTest(xs, map.rows, panels[pi], localX(e), localY(e))
    setPin(row >= 0 ? { row, anchor: { x: e.clientX, y: e.clientY } } : null)
  }

  const shown = hover && hover.row >= 0 && !pin ? hover.row : -1
  const crossX = hover ? hover.x : null

  // brackets over the figure: the phases on top, then the statements' stretches, each bracket right above its label, on up to three
  // rows so the labels of narrow stretches do not collide (a stretch with no room keeps an unlabelled bracket with a title)
  const span = (b: Bracket) => (xs.mode === 'order'
    ? { x0: xOfIndex(xs, b.i0), x1: xOfIndex(xs, b.i1) }
    : { x0: xOfTim(xs, map.rows[b.i0][IO.tim] - map.rows[b.i0][IO.ela]), x1: xOfTim(xs, map.rows[b.i1 - 1][IO.tim]) })
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
  const rereads = useMemo(() => rereadOf(map.rows, (e) => isWriteEvent(doc.events[e])), [map, doc])

  return (
    <div className={'bm-body' + (loading ? ' bm-stale' : '')}>
      <div className="bm-figure" ref={boxRef}>
        <Legend doc={doc} coloring={coloring} bands={bands.some((b) => b.length > 0)} theme={theme} />
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
          <div className="bm-panel" key={p.file}>
            <div className="bm-title" style={{ marginInlineStart: Y_AXIS }}>
              <b>{fileTitle(doc, p)}</b>
              <span className="muted"> · {fmtInt(p.n)} {p.n === 1 ? 'wait' : 'waits'} · blocks {fmtInt(p.lo)} to {fmtInt(p.hi - 1)}</span>
              {[...bands[pi]].sort((a, b) => b.blocks - a.blocks || a.obj - b.obj).slice(0, TITLE_OBJECTS).map((b) => (
                <span key={b.obj} className="bm-obj"><i className="swatch" style={{ background: toneColor(b.tone) }} />{objLabel(doc, b.obj)} <span className="muted">{fmtInt(b.runs.length)} {b.runs.length === 1 ? 'range' : 'ranges'} · {fmtInt(b.blocks)} {b.blocks === 1 ? 'block' : 'blocks'}{map.sampled ? ' in the sample' : ''}</span></span>
              ))}
              {bands[pi].length > TITLE_OBJECTS && <span className="muted">+{bands[pi].length - TITLE_OBJECTS} more objects (colour by object for all)</span>}
              {p.rows.length === 0 && <span className="muted"> · none of them in the sample</span>}
            </div>
            <div className="bm-plot" style={{ blockSize: p.height }}>
              <div className="bm-yticks" style={{ inlineSize: Y_AXIS - RULER_X - 4 }} aria-hidden="true">
                {blockTicks(p, p.height).map((t) => <span key={t.block} style={{ top: t.y }}>{fmtInt(t.block)}</span>)}
              </div>
              <PanelCanvas panel={p} rows={map.rows} xs={xs} coloring={coloring} tones={resolved.tones} grid={resolved.grid} bands={bandColors[pi]} left={Y_AXIS - RULER_X} />
              <svg className="bm-overlay" style={{ left: Y_AXIS }} width={xs.width} height={p.height}
                role="img" aria-label={`${fileTitle(doc, p)}: ${fmtInt(p.n)} block I/O waits; drag to set the time window, double-click to clear it, click a mark for its line`}
                onPointerDown={onDown} onPointerMove={onMove(pi)} onPointerUp={onUp(pi)} onPointerLeave={() => setHover(null)}
                onPointerCancel={() => { drag.current = null; setBrush(null) }} onDoubleClick={() => { setPin(null); actions.setWindow(null) }}>
                {brush && <rect className="bm-brush" x={brush.a} y={0} width={brush.b - brush.a} height={p.height} />}
                {crossX !== null && !brush && <line className="bm-cross" x1={crossX + 0.5} x2={crossX + 0.5} y1={0} y2={p.height} />}
                {hover && hover.panel === pi && !brush && <line className="bm-cross" x1={0} x2={xs.width} y1={hover.y + 0.5} y2={hover.y + 0.5} />}
                {(pin?.row ?? shown) >= 0 && map.rows[pin?.row ?? shown][IO.file] === p.file && (() => {
                  const r = map.rows[pin?.row ?? shown]
                  const y0 = yOfBlock(p, p.height, r[IO.block] + r[IO.blocks]), y1 = yOfBlock(p, p.height, r[IO.block])
                  const x = xs.mode === 'order' ? xOfIndex(xs, pin?.row ?? shown) : xOfTim(xs, r[IO.tim] - r[IO.ela])
                  return <rect className="bm-hit" x={Math.floor(x) - 2} y={Math.min(y0, y1 - 1) - 2} width={5} height={Math.max(1, y1 - y0) + 4} />
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
        <p className="bm-caption small muted" style={{ marginInlineStart: Y_AXIS }}>
          {xs.mode === 'order'
            ? <>I/O order: the n-th physical I/O wait of {fmtInt(map.total)}{xs.stretch > 1.05 && <>; stretches of few waits widened (up to {Math.round(xs.stretch)}×) so their marks stay readable, the rest linear (breaks marked on the axis)</>}.</>
            : <>Time since the start of the trace; each mark spans its wait ([tim − ela, tim], at least {xs.n <= 2000 ? 2 : 1} px).</>}
          {' '}y = block number; a mark is as tall as the blocks it moved. Drag across the figure to make that stretch the time window (the view re-queries inside it), double-click to clear it.
        </p>
      </div>
      <Facts doc={doc} map={map} rereads={rereads} k={k} only={only} onOnly={onOnly} />
      {shown >= 0 && hover && <Tip doc={doc} row={map.rows[shown]} panelEl={boxRef.current} hover={hover} />}
      {pin && <PinPop doc={doc} row={map.rows[pin.row]} anchor={pin.anchor} onClose={() => setPin(null)} onOnly={onOnly} />}
    </div>
  )
}

/** One panel's canvas: painted by `drawBlockMap` whenever the data, the size or the resolved colours change (not on hover). */
const PanelCanvas = memo(function PanelCanvas({ panel, rows, xs, coloring, tones, grid, bands, left }: {
  panel: Panel; rows: number[][]; xs: XScale; coloring: Coloring; tones: string[]; grid: string; bands: { runs: { lo: number; hi: number }[]; color: string }[]; left: number
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
    drawBlockMap(ctx, panel, rows, xs, coloring.idx, { tones, grid, bands })
  }, [panel, rows, xs, coloring, tones, grid, bands, w, h])
  return <canvas ref={ref} className="bm-canvas" style={{ left, inlineSize: w, blockSize: h }} />
})

/** `theme` is only there to repaint the swatches (resolved colours) on a theme change. */
const Legend = memo(function Legend({ doc, coloring, bands }: { doc: TraceDoc; coloring: Coloring; bands: boolean; theme: string }) {
  return (
    <div className="bm-legend small" aria-label="Legend">
      {coloring.legend.map((l) => (
        <span key={`${l.kind}:${l.key}`} className="k">
          <i className="swatch" style={{ background: toneColor(l.tone) }} />
          {l.kind === 'event' ? doc.events[l.key]?.name ?? `event ${l.key}`
            : l.kind === 'object' ? objLabel(doc, l.key)
            : l.kind === 'statement' ? <StmtLink doc={doc} id={l.key} />
            : l.kind === 'none' ? 'no object' : 'others'}
          <span className="muted">{fmtInt(l.rows)}</span>
        </span>
      ))}
      {bands && <span className="k muted"><i className="swatch bm-band-swatch" />faint bands and the ruler at the left: the block ranges each object's reads touched</span>}
    </div>
  )
})

/** What one row is, for the tooltip and the popover. */
function RowFacts({ doc, row, links }: { doc: TraceDoc; row: number[]; links: boolean }) {
  const ev = doc.events[row[IO.event]]
  const b = row[IO.block], n = row[IO.blocks]
  const fname = doc.fileName(row[IO.file])?.name
  return (
    <>
      <div className="bm-tip-h"><b>{ev?.name ?? `event ${row[IO.event]}`}</b> <span className="muted">{fmtDur(row[IO.ela])}</span></div>
      <div>file {row[IO.file]}{fname ? <span className="muted"> ({fname.split(/[\\/]/).pop()})</span> : null} · {n > 1 ? <>blocks {fmtInt(b)} to {fmtInt(b + n - 1)} ({fmtInt(n)})</> : <>block {fmtInt(b)}</>}</div>
      <div>{row[IO.obj] >= 0 ? <>{objLabel(doc, row[IO.obj])}{isTempEvent(ev) && <span className="muted"> (the statement's object; temp blocks)</span>}</> : <span className="muted">no object</span>}</div>
      <div>{links && row[IO.stmt] >= 0 ? <StmtLink doc={doc} id={row[IO.stmt]} /> : <span className="mono">{stmtLabel(doc, row[IO.stmt])}</span>}{row[IO.dep] > 0 && <span className="muted"> · recursive, depth {row[IO.dep]}</span>}</div>
      <div>{links ? <LineRef line={row[IO.line]} file={doc.fileOfCtx(row[IO.ctx])} /> : <span className="muted">line {fmtInt(row[IO.line])} · click to pin</span>}</div>
    </>
  )
}

function Tip({ doc, row, hover, panelEl }: { doc: TraceDoc; row: number[]; hover: Hover; panelEl: HTMLElement | null }) {
  const plot = panelEl?.querySelectorAll<HTMLElement>('.bm-plot')[hover.panel]
  if (!plot) return null
  const r = plot.getBoundingClientRect()
  const x = r.left + Y_AXIS + hover.x, y = r.top + hover.y
  const right = x + 300 > window.innerWidth
  return createPortal(
    <div className="bm-tip small" style={{ left: right ? x - 12 : x + 14, top: y + 14, translate: right ? '-100% 0' : undefined }} role="tooltip">
      <RowFacts doc={doc} row={row} links={false} />
    </div>,
    document.body,
  )
}

function PinPop({ doc, row, anchor, onClose, onOnly }: { doc: TraceDoc; row: number[]; anchor: { x: number; y: number }; onClose: () => void; onOnly: (s: ID | null) => void }) {
  const root = usePopover(anchor, onClose, [row])
  return createPortal(
    <div className="stmt-pop bm-pop small" ref={root} role="dialog" aria-label="Block I/O wait" onKeyDown={(e) => e.stopPropagation()}>
      <button type="button" className="quiet stmt-pop-x" data-first onClick={onClose} aria-label="Close" title="close (Esc)">×</button>
      <RowFacts doc={doc} row={row} links />
      {row[IO.stmt] >= 0 && <div className="bm-pop-acts"><button type="button" onClick={() => { onOnly(row[IO.stmt]); onClose() }}>Only this statement</button></div>}
    </div>,
    document.body,
  )
}

/** The facts column: per statement and file, reads and writes, the distinct blocks and how often each was read. */
const Facts = memo(function Facts({ doc, map, rereads, k, only, onOnly }: { doc: TraceDoc; map: IOMap; rereads: Reread[]; k: number; only: ID | null; onOnly: (s: ID | null) => void }) {
  const byStmt = new Map<number, Reread[]>()
  for (const r of rereads) { const l = byStmt.get(r.key); if (l) l.push(r); else byStmt.set(r.key, [r]) }
  const stmts = [...byStmt.entries()].map(([s, l]) => ({ s, l, us: l.reduce((a, r) => a + r.us, 0) })).sort((a, b) => b.us - a.us || a.s - b.s)
  return (
    <aside className="bm-facts" aria-label="Re-reads by statement">
      <h3>By statement</h3>
      {map.sampled && <p className="bm-note small"><b>showing 1 in {fmtInt(k)} of {fmtInt(map.total)}</b>: the numbers below count the waits shown.</p>}
      <p className="small muted">Reads and writes per file; "× per block" is how often each distinct block was read (a multipass join reads its spill many times).</p>
      <ol>
        {stmts.map(({ s, l, us }) => (
          <li key={s}>
            <div className="bm-facts-h">
              {s >= 0 ? <StmtLink doc={doc} id={s} /> : <span className="muted">no statement</span>}
              <span className="muted">{fmtDur(us)}</span>
              {s >= 0 && only === null && <button className="quiet bm-only" onClick={() => onOnly(s)} title="show only this statement's waits">only</button>}
            </div>
            {l.map((r) => (
              <div key={r.file} className="bm-facts-r">
                <span className="muted">file {r.file}</span>
                {r.reads > 0 && <span><b>{fmtInt(r.reads)}</b> {r.reads === 1 ? 'read' : 'reads'} of {fmtInt(r.readDistinct)} {r.readDistinct === 1 ? 'block' : 'blocks'}{r.readsPerBlock >= 1.05 ? <>: <b>{r.readsPerBlock.toFixed(1)}×</b> per block</> : ''}</span>}
                {r.writes > 0 && <span><b>{fmtInt(r.writes)}</b> {r.writes === 1 ? 'write' : 'writes'} on {fmtInt(r.writeDistinct)} {r.writeDistinct === 1 ? 'block' : 'blocks'}</span>}
              </div>
            ))}
          </li>
        ))}
      </ol>
    </aside>
  )
})
