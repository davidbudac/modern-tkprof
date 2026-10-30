import { useMemo, useRef, useState, type PointerEvent } from 'react'
import { ctxKey } from '../data/fileset'
import type { TraceDoc } from '../data/doc'
import type { StmtStats } from '../data/types'
import { fmtDur, fmtWall, preview } from '../data/format'
import { activeBlock, scopeOf } from '../state/store'
import { scopeKey, useAxis, useScope, useScopedStatements } from '../data/scopedstmts'
import { responseUs } from '../data/response'
import { useStore, useActions, useStoreApi } from '../state/session'
import { sourceOf, useSourceQuery } from '../data/source'
import { StmtLink } from '../components/StmtLink'
import { dominantRole, foldTimeline, type PhaseSpan2, type Span2, type WaitSpan2 } from '../data/derive'
import { kindGroups, groupIndex } from '../data/callkinds'
import { ticks, zoomedAxis } from '../data/scale'
import { roleLabel, roleOfClass, roleOrder, type Role } from '../components/colors'
import '../styles/timeline.css'

const MAX_LANES = 12
const LANE_H = 30
const LANE_H_WAITS = 38 // room for the wait strip along the bottom of a lane
const STRIP_H = 26
const AXIS_H = 20
const LABEL_W = 230
const BUCKETS = 240
const MAX_BUCKETS = 20000 // the engine refuses a timeline of more than 100000 buckets

/** What the lane bars are colored by: the call phase (PARSE / EXEC / FETCH / ...) or the statement's dominant resource role. */
export type LaneColor = 'phase' | 'resource'

/** A bar under the pointer: its statement and interval (`data-stmt` / `data-start` / `data-end`). */
interface LaneBar { stmt: number; start: number; end: number }

/** The pointer is down at `x0`, now at `x1`; `bar` is what it went down on. */
interface LaneDrag { x0: number; x1: number; bar: LaneBar | null }

const barOf = (t: EventTarget | null): LaneBar | null => {
  const d = (t as HTMLElement | null)?.closest<HTMLElement>('[data-stmt]')?.dataset
  return d?.stmt === undefined ? null : { stmt: Number(d.stmt), start: Number(d.start), end: Number(d.end) }
}

const BAR_HINT = ' · click: select · double-click: open statement'

interface Lane { st: StmtStats; label: string; text: string; role: Role; spans: Span2[]; phases: PhaseSpan2[] | null; waits: WaitSpan2[] | null }

/** `FETCH 82% · EXEC 15% · PARSE 3%`: the nonzero groups of a segment, biggest first. */
function phaseBreakdown(p: PhaseSpan2): string {
  const total = p.us.reduce((a, b) => a + b, 0)
  const own = kindGroups[groupIndex[p.kind]].label
  if (total <= 0) return own
  return kindGroups.map((g, i) => ({ g, v: p.us[i] })).filter((x) => x.v > 0).sort((a, b) => b.v - a.v)
    .map((x) => { const pc = (100 * x.v) / total; return `${x.g.label} ${pc < 1 ? '<1' : Math.round(pc)}%` }).join(' · ')
}

/**
 * The session on wall-clock time: one lane per top statement (ordered by first call),
 * then a strip of waits by class and a strip of CPU. Drag to set the global window; click a block to make its interval the
 * window and select its statement, double-click to open the statement (the window stays). With a zoom (`State.lanesZoom`) the axis
 * is the zoomed range and the rows and bars are queried over it.
 */
export function Lanes({ doc, colorBy = 'phase', showWaits = false }: { doc: TraceDoc; colorBy?: LaneColor; showWaits?: boolean }) {
  const actions = useActions()
  const store = useStoreApi()
  const state = useStore((s) => s)
  const win = state.window
  const picked = activeBlock(state)
  const full = useAxis(doc) // the selected files' / sessions' range, else the whole trace
  // the zoomed range (null: unzoomed, or the zoom misses the axis after a file / session selection: the stack stays)
  const zoomTop = state.lanesZoom[state.lanesZoom.length - 1]
  const zoom = useMemo(() => zoomedAxis(full, zoomTop), [full, zoomTop])
  const zoomWin = useMemo(() => (zoom ? { startTim: zoom.base, endTim: zoom.base + zoom.span } : null), [zoom])
  const { base, span } = zoom ?? full // the axis shown
  const ref = useRef<HTMLDivElement>(null)
  // the drag lives in a ref (pointer events can arrive before React re-renders); state only triggers a repaint
  const dragRef = useRef<LaneDrag | null>(null)
  const clickRef = useRef<LaneBar | null>(null) // the block the last click picked, for the double-click that follows
  const [, repaint] = useState(0)
  const drag = dragRef.current
  const setDrag = (d: LaneDrag | null) => { dragRef.current = d; repaint((n) => n + 1) }

  const source = sourceOf(doc)
  // the rows and bars are picked over the files / contexts, and over the zoomed range; a window dragged inside it changes nothing
  const ss = useScopedStatements(doc, { withWindow: false, window: zoomWin })
  const laneScope = useScope(doc, { withWindow: false, window: zoomWin })
  // only statements with calls in the scope get a lane (none while the scope's table is on its way; a zoom keeps the previous rows until the zoomed table arrives)
  const lastTop = useRef<StmtStats[]>([])
  const top = useMemo(() => {
    if (ss.pending) return zoom ? lastTop.current : []
    return (lastTop.current = ss.stats.filter((s) => s.allCalls.count > 0 && s.firstTim > 0)
      .sort((a, b) => responseUs(b) - responseUs(a)).slice(0, MAX_LANES)
      .sort((a, b) => a.firstTim - b.firstTim))
  }, [ss.stats, ss.pending, zoom])
  const topIds = top.map((s) => s.id)
  const gap = span / 600
  const spansQ = useSourceQuery(source, `spans:${topIds.join(',')}:${gap}:${scopeKey(laneScope)}`, (signal) => (source.ready ? source.stmtSpans(topIds, gap, laneScope, signal) : null), 'spans')
  // the phase segments; until they arrive the lanes show the plain spans (kept across refreshes, never blank)
  const phaseQ = useSourceQuery(source, `phases:${colorBy}:${topIds.join(',')}:${gap}:${scopeKey(laneScope)}`,
    (signal) => (colorBy === 'phase' && source.ready ? source.stmtPhases(topIds, gap, laneScope, signal) : null), 'phases')
  // the wait strips: fetched only while they are on
  const waitQ = useSourceQuery(source, `waitspans:${showWaits ? topIds.join(',') : ''}:${gap}:${scopeKey(laneScope)}:${laneScope.includeIdle ? 1 : 0}`,
    (signal) => (showWaits && source.ready ? source.stmtWaitSpans(topIds, gap, laneScope, signal) : null), 'waitspans')
  const roles = useSourceQuery(source, `roles:${scopeKey(laneScope)}`, (signal) => source.stmtRoles(laneScope, signal), 'roles').data
  const lanes = useMemo<Lane[]>(() => top.map((st) => {
    const s = doc.statements[st.id]
    const spans = spansQ.data?.get(st.id) ?? [{ start: st.firstTim, end: st.lastTim }]
    const phases = colorBy === 'phase' ? phaseQ.data?.get(st.id) : undefined
    return { st, label: doc.label(s), text: preview(s.text, 60), role: dominantRole(doc, st, roles), spans, phases: phases && phases.length > 0 ? phases : null, waits: showWaits ? waitQ.data?.get(st.id) ?? null : null }
  }), [doc, top, spansQ.data, roles, colorBy, phaseQ.data, showWaits, waitQ.data])
  const laneH = showWaits ? LANE_H_WAITS : LANE_H
  const waitRole = (ev: number): Role => { const e = doc.events[ev]; return roleOfClass(e?.class ?? '', e?.idle ?? false) }
  const waitName = (ev: number) => doc.events[ev]?.name ?? `event ${ev}`
  // the wait classes on screen, for the legend
  const waitRoles = useMemo(() => {
    const seen = new Set<Role>()
    if (showWaits) for (const l of lanes) for (const w of l.waits ?? []) seen.add(waitRole(w.event))
    return roleOrder.filter((r) => seen.has(r))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showWaits, lanes, doc])
  /** `db file sequential read 70% · direct path read 25% · other 5%` */
  const waitBreakdown = (w: WaitSpan2) => {
    const total = w.top.reduce((a, e) => a + e[1], 0) + w.restUs
    if (total <= 0) return waitName(w.event)
    const pc = (us: number) => { const p = (100 * us) / total; return p < 1 ? '<1' : String(Math.round(p)) }
    return [...w.top.filter((e) => e[1] > 0).map((e) => `${waitName(e[0])} ${pc(e[1])}%`), ...(w.restUs > 0 ? [`other ${pc(w.restUs)}%`] : [])].join(' · ')
  }

  const scope = scopeOf(state)
  // buckets are counted from the trace's start, so a short selection of a long trace needs a coarser bucket than span / BUCKETS
  const bucketUs = Math.max(1, Math.ceil(span / BUCKETS), Math.ceil(doc.spanUs() / MAX_BUCKETS))
  const stripsQ = useSourceQuery(source, `strips:${bucketUs}:${ctxKey(scope.contexts)}:${scope.includeIdle ? 1 : 0}`,
    (signal) => (source.ready && span > 0 ? source.timeline(bucketUs, { ...scope, window: null }, signal) : null), 'strips')
  const strips = useMemo(() => {
    if (!stripsQ.data) return null
    return { bucketUs, ...foldTimeline(doc, stripsQ.data, 'class') }
  }, [doc, stripsQ.data, bucketUs])

  const tk = useMemo(() => ticks(span, 8), [span])
  const x = (tim: number) => `${(100 * (tim - base)) / span}%`
  // a bar cut to the axis (a call that straddles its edge comes back whole); `data-start` / `data-end` keep the real interval
  const inAxis = (s: Span2) => s.end >= base && s.start <= base + span
  const clip = (s: Span2) => ({ left: x(Math.max(s.start, base)), width: `max(2px, ${(100 * (Math.min(s.end, base + span) - Math.max(s.start, base))) / span}%)` })
  // ticks under a millisecond apart need microseconds in their labels, or neighbours read the same
  const fine = tk.step < 1000
  // offsets count from the start of the whole axis, zoomed or not (as the window bar's)
  const offset = (tim: number) => (zoom ? `+${((tim - full.base) / 1e6).toFixed(fine ? 6 : 3)} s` : `+${fmtDur(tim - base)}`)
  const wall = (tim: number, opts?: { date?: boolean }) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(tim), doc.tzOffsetMin, { ...opts, micros: fine }) : offset(tim))
  const tickText = (t: number, i: number) => {
    if (!doc.wallOffsetUs) return zoom ? offset(base + t) : i === 0 ? '+0' : fmtDur(t)
    const s = fmtWall(doc.wallOf(base + t), doc.tzOffsetMin, { micros: fine })
    return i === 0 ? s : tk.step >= 1e6 ? s.slice(0, 8) : s
  }

  const timAt = (clientX: number) => {
    const el = ref.current
    if (!el) return base
    const r = el.getBoundingClientRect()
    return base + Math.min(1, Math.max(0, (clientX - r.left) / r.width)) * span
  }
  const onDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    // the bar is taken now: with the pointer captured, the target of the pointer-up is the plot
    const bar = barOf(e.target)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic events have no active pointer */ }
    setDrag({ x0: e.clientX, x1: e.clientX, bar })
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => { const d = dragRef.current; if (d) setDrag({ ...d, x1: e.clientX }) }
  const onUp = () => {
    const drag = dragRef.current
    if (!drag) return
    const a = timAt(Math.min(drag.x0, drag.x1)), b = timAt(Math.max(drag.x0, drag.x1))
    setDrag(null)
    clickRef.current = null
    if (Math.abs(drag.x1 - drag.x0) < 4) {
      const bar = drag.bar
      if (bar) { clickRef.current = bar; actions.pickBlock(bar.stmt, bar.start, bar.end) }
      else if (store.getState().window) actions.setWindow(null) // a click on empty space clears the window
      return
    }
    // a drag across the whole axis: no window, or (zoomed) the visible range
    actions.setWindow(b - a < span * 0.999 ? { startTim: a, endTim: b } : zoomWin)
  }

  const onDouble = () => { const bar = clickRef.current; clickRef.current = null; if (bar) actions.selectStmt(bar.stmt) }
  // the picked block's bars: the block itself, or (zoomed, another gap) the bars the new merge made of it, whose ends can move by
  // a few µs: a bar of its statement mostly inside it (neighbours only touch it)
  const isPicked = (stmt: number, start: number, end: number) => {
    if (!picked || picked.stmt !== stmt) return false
    if (end <= start) return start >= picked.startTim && start <= picked.endTim
    return Math.min(end, picked.endTim) - Math.max(start, picked.startTim) >= 0.5 * (end - start)
  }

  const zoomStrip = zoom && (
    <div className="lanes-zoom" role="group" aria-label="Zoom">
      <span className="lanes-zoom-range"><b>Zoom</b> {wall(base)} → {wall(base + span)} · {fmtDur(span)} <span className="muted">of {fmtDur(full.span)}</span></span>
      <span className="lanes-zoom-acts">
        <button onClick={() => actions.zoomOutLanes()} title="back to the previous zoom, or the whole range">‹ Out</button>
        <button className="quiet" onClick={() => actions.resetLanesZoom()} title="the whole range">Reset</button>
      </span>
    </div>
  )
  if (span <= 0) return <p className="muted small">No time information.</p>
  if (lanes.length === 0) return zoomStrip ? <>{zoomStrip}<p className="muted small">{ss.pending ? 'Loading…' : 'No statements with calls in this range.'}</p></> : <p className="muted small">No time information.</p>
  const dragRect = drag && ref.current ? (() => {
    const r = ref.current!.getBoundingClientRect()
    const l = Math.max(0, Math.min(drag.x0, drag.x1) - r.left), w = Math.min(r.width, Math.abs(drag.x1 - drag.x0))
    return { left: l, width: w }
  })() : null
  const sel = state.selection.stmt
  const height = AXIS_H + lanes.length * laneH + (strips ? 2 * STRIP_H : 0)

  return (
    <>
    {colorBy === 'phase' && (
      <div className="lane-legend lanes-legend" role="list" aria-label="Call kinds">
        {kindGroups.map((g) => (
          <span className="k" role="listitem" key={g.id}><i className="swatch" style={{ background: `var(${g.token})` }} />{g.label}</span>
        ))}
      </div>
    )}
    {showWaits && waitRoles.length > 0 && (
      <div className="lane-legend lanes-legend" role="list" aria-label="Wait classes">
        <span className="dim">waits (strip under each lane)</span>
        {waitRoles.map((r) => (
          <span className="k" role="listitem" key={r}><i className="swatch" style={{ background: `var(--c-${r})` }} />{roleLabel[r]}</span>
        ))}
      </div>
    )}
    {zoomStrip}
    <div className={'lanes' + (showWaits ? ' with-waits' : '')} style={{ gridTemplateColumns: `${LABEL_W}px minmax(0, 1fr)` }}>
      <div className="lanes-labels">
        <div className="lanes-axis-pad" style={{ height: AXIS_H }} />
        {lanes.map((l) => (
          <div key={l.st.id} className={'lane-label' + (sel === l.st.id ? ' on' : '')} style={{ height: laneH }} title={`${l.label} ${l.text}`}>
            <StmtLink doc={doc} id={l.st.id} /><span className="t">{l.text}</span>
          </div>
        ))}
        {strips && <><div className="lane-label strip" style={{ height: STRIP_H }}><span className="dim">waits by class</span></div><div className="lane-label strip" style={{ height: STRIP_H }}><span className="dim">CPU</span></div></>}
      </div>
      <div className={'lanes-plot' + (spansQ.loading ? ' stale' : '')} ref={ref} style={{ height }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)} onDoubleClick={onDouble}>
        <div className="lanes-axis" style={{ height: AXIS_H }}>
          {tk.at.filter((t) => t < span * 0.93).map((t, i) => <span key={t} style={{ left: x(base + t) }} className={i === 0 ? 'first' : undefined}>{tickText(t, i)}</span>)}
          <span className="last">{wall(base + span)}</span>
        </div>
        <div className="lanes-grid" style={{ backgroundSize: `${(100 * tk.step) / span}% 100%` }} />
        {lanes.map((l) => (
          <div key={l.st.id} className="lane" style={{ height: laneH }}>
            {l.phases
              ? l.phases.filter(inAxis).map((s, i) => (
                <i key={i} className={'span' + (isPicked(l.st.id, s.start, s.end) ? ' on' : '')} data-stmt={l.st.id} data-start={s.start} data-end={s.end} style={{ ...clip(s), background: `var(${kindGroups[groupIndex[s.kind]].token})` }}
                  title={`${l.label} · ${phaseBreakdown(s)} · ${wall(s.start)} → ${wall(s.end)} · ${fmtDur(s.end - s.start)}${BAR_HINT}`} />
              ))
              : l.spans.filter(inAxis).map((s, i) => (
                <i key={i} className={'span' + (isPicked(l.st.id, s.start, s.end) ? ' on' : '')} data-stmt={l.st.id} data-start={s.start} data-end={s.end} style={{ ...clip(s), background: `var(--c-${l.role})` }}
                  title={`${l.label} · ${wall(s.start)} → ${wall(s.end)} · ${fmtDur(s.end - s.start)}${BAR_HINT}`} />
              ))}
            {l.waits?.filter(inAxis).map((w, i) => (
              <i key={`w${i}`} className={'wspan' + (isPicked(l.st.id, w.start, w.end) ? ' on' : '')} data-stmt={l.st.id} data-start={w.start} data-end={w.end} style={{ ...clip(w), background: `var(--c-${waitRole(w.event)})` }}
                title={`${l.label} · ${waitBreakdown(w)} · ${wall(w.start)} → ${wall(w.end)} · ${fmtDur(w.end - w.start)}${BAR_HINT}`} />
            ))}
          </div>
        ))}
        {strips && <Strips strips={strips} span={span} base={base} />}
        {win && !drag && win.endTim > base && win.startTim < base + span && (
          <div className="brush" style={{ left: x(Math.max(base, win.startTim)), width: `${(100 * (Math.min(base + span, win.endTim) - Math.max(base, win.startTim))) / span}%` }}>
            <b>window {fmtDur(win.endTim - win.startTim)}</b>
          </div>
        )}
        {dragRect && dragRect.width > 3 && <div className="brush dragging" style={dragRect} />}
      </div>
    </div>
    </>
  )
}

function Strips({ strips, span, base }: { strips: { bucketUs: number; starts: number[]; series: { role: Role; values: Float64Array }[] }; span: number; base: number }) {
  const n = strips.starts.length
  const w = (100 * strips.bucketUs) / span // a bucket's share of the axis (the buckets run from the trace start, past the axis)
  const waits = strips.series.filter((s) => s.role !== 'cpu')
  const cpu = strips.series.find((s) => s.role === 'cpu')
  const out = (b: number) => strips.starts[b] + strips.bucketUs <= base || strips.starts[b] >= base + span // outside the axis
  const order = [...waits].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role))
  return (
    <>
      <svg className="strip" shapeRendering="crispEdges" style={{ height: STRIP_H }} viewBox={`0 0 100 ${STRIP_H}`} preserveAspectRatio="none" aria-label="waits by class over time">
        {Array.from({ length: n }, (_, b) => {
          if (out(b)) return null
          let y = STRIP_H - 2
          return order.map((s) => {
            const v = Math.min(1, s.values[b] / strips.bucketUs)
            if (v <= 0) return null
            const h = v * (STRIP_H - 4)
            y -= h
            return <rect key={s.role} x={(100 * (strips.starts[b] - base)) / span} y={y} width={w} height={h} fill={`var(--c-${s.role})`} />
          })
        })}
      </svg>
      <svg className="strip" shapeRendering="crispEdges" style={{ height: STRIP_H }} viewBox={`0 0 100 ${STRIP_H}`} preserveAspectRatio="none" aria-label="CPU over time">
        {cpu && Array.from({ length: n }, (_, b) => {
          if (out(b)) return null
          const v = Math.min(1, cpu.values[b] / strips.bucketUs)
          if (v <= 0) return null
          const h = v * (STRIP_H - 4)
          return <rect key={b} x={(100 * (strips.starts[b] - base)) / span} y={STRIP_H - 2 - h} width={w} height={h} fill="var(--c-cpu)" />
        })}
      </svg>
    </>
  )
}
