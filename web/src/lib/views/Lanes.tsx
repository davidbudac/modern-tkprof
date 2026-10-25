import { useMemo, useRef, useState, type PointerEvent } from 'react'
import { ctxKey } from '../data/fileset'
import type { TraceDoc } from '../data/doc'
import type { StmtStats } from '../data/types'
import { fmtDur, fmtWall, preview } from '../data/format'
import { scopeOf } from '../state/store'
import { scopeKey, useScope, useScopedStatements } from '../data/scopedstmts'
import { responseUs } from '../data/response'
import { useStore, useActions, useStoreApi } from '../state/session'
import { sourceOf, useSourceQuery } from '../data/source'
import { StmtLink } from '../components/StmtLink'
import { dominantRole, foldTimeline, type Span2 } from '../data/derive'
import { ticks } from '../data/scale'
import { roleOrder, type Role } from '../components/colors'

const MAX_LANES = 12
const LANE_H = 30
const STRIP_H = 26
const AXIS_H = 20
const LABEL_W = 230
const BUCKETS = 240

interface Lane { st: StmtStats; label: string; text: string; role: Role; spans: Span2[] }

/**
 * The session on wall-clock time: one lane per top statement (ordered by first call),
 * then a strip of waits by class and a strip of CPU. Drag to set the global window.
 */
export function Lanes({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const store = useStoreApi()
  const state = useStore((s) => s)
  const win = state.window
  const base = doc.span.firstTim
  const span = doc.spanUs()
  const ref = useRef<HTMLDivElement>(null)
  // the drag lives in a ref (pointer events can arrive before React re-renders); state only triggers a repaint
  const dragRef = useRef<{ x0: number; x1: number } | null>(null)
  const [, repaint] = useState(0)
  const drag = dragRef.current
  const setDrag = (d: { x0: number; x1: number } | null) => { dragRef.current = d; repaint((n) => n + 1) }

  const source = sourceOf(doc)
  const ss = useScopedStatements(doc, { withWindow: false })
  const laneScope = useScope(doc, { withWindow: false }) // the lanes keep their rows when a window is dragged
  // only statements with calls in the scope get a lane (none while the scope's table is on its way)
  const top = useMemo(() => (ss.pending ? [] : ss.stats.filter((s) => s.allCalls.count > 0 && s.firstTim > 0)
    .sort((a, b) => responseUs(b) - responseUs(a)).slice(0, MAX_LANES)
    .sort((a, b) => a.firstTim - b.firstTim)), [ss.stats, ss.pending])
  const topIds = top.map((s) => s.id)
  const gap = span / 600
  const spansQ = useSourceQuery(source, `spans:${topIds.join(',')}:${gap}:${scopeKey(laneScope)}`, (signal) => (source.ready ? source.stmtSpans(topIds, gap, laneScope, signal) : null), 'spans')
  const roles = useSourceQuery(source, `roles:${scopeKey(laneScope)}`, (signal) => source.stmtRoles(laneScope, signal), 'roles').data
  const lanes = useMemo<Lane[]>(() => top.map((st) => {
    const s = doc.statements[st.id]
    const spans = spansQ.data?.get(st.id) ?? [{ start: st.firstTim, end: st.lastTim }]
    return { st, label: doc.label(s), text: preview(s.text, 60), role: dominantRole(doc, st, roles), spans }
  }), [doc, top, spansQ.data, roles])

  const scope = scopeOf(state)
  const bucketUs = Math.max(1, Math.ceil(span / BUCKETS))
  const stripsQ = useSourceQuery(source, `strips:${bucketUs}:${ctxKey(scope.contexts)}:${scope.includeIdle ? 1 : 0}`,
    (signal) => (source.ready && span > 0 ? source.timeline(bucketUs, { ...scope, window: null }, signal) : null), 'strips')
  const strips = useMemo(() => {
    if (!stripsQ.data) return null
    return { bucketUs, ...foldTimeline(doc, stripsQ.data, 'class') }
  }, [doc, stripsQ.data, bucketUs])

  const tk = useMemo(() => ticks(span, 8), [span])
  const x = (tim: number) => `${(100 * (tim - base)) / span}%`
  const wall = (tim: number, opts?: { date?: boolean }) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(tim), doc.tzOffsetMin, opts) : `+${fmtDur(tim - base)}`)
  const tickText = (t: number, i: number) => {
    if (!doc.wallOffsetUs) return i === 0 ? '+0' : fmtDur(t)
    const s = fmtWall(doc.wallOf(base + t), doc.tzOffsetMin)
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
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch { /* synthetic events have no active pointer */ }
    setDrag({ x0: e.clientX, x1: e.clientX })
  }
  const onMove = (e: PointerEvent<HTMLDivElement>) => { const d = dragRef.current; if (d) setDrag({ x0: d.x0, x1: e.clientX }) }
  const onUp = (e: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag) return
    const a = timAt(Math.min(drag.x0, drag.x1)), b = timAt(Math.max(drag.x0, drag.x1))
    setDrag(null)
    if (Math.abs(drag.x1 - drag.x0) < 4) {
      const t = e.target as HTMLElement
      const id = t.closest<HTMLElement>('[data-stmt]')?.dataset.stmt
      if (id !== undefined) actions.selectStmt(Number(id))
      else if (store.getState().window) actions.setWindow(null) // a click on empty space clears the window
      return
    }
    actions.setWindow(b - a < span * 0.999 ? { startTim: a, endTim: b } : null)
  }

  if (span <= 0 || lanes.length === 0) return <p className="muted small">No time information.</p>
  const dragRect = drag && ref.current ? (() => {
    const r = ref.current!.getBoundingClientRect()
    const l = Math.max(0, Math.min(drag.x0, drag.x1) - r.left), w = Math.min(r.width, Math.abs(drag.x1 - drag.x0))
    return { left: l, width: w }
  })() : null
  const sel = state.selection.stmt
  const height = AXIS_H + lanes.length * LANE_H + (strips ? 2 * STRIP_H : 0)

  return (
    <div className="lanes" style={{ gridTemplateColumns: `${LABEL_W}px minmax(0, 1fr)` }}>
      <div className="lanes-labels">
        <div className="lanes-axis-pad" style={{ height: AXIS_H }} />
        {lanes.map((l) => (
          <div key={l.st.id} className={'lane-label' + (sel === l.st.id ? ' on' : '')} style={{ height: LANE_H }} title={`${l.label} ${l.text}`}>
            <StmtLink doc={doc} id={l.st.id} /><span className="t">{l.text}</span>
          </div>
        ))}
        {strips && <><div className="lane-label strip" style={{ height: STRIP_H }}><span className="dim">waits by class</span></div><div className="lane-label strip" style={{ height: STRIP_H }}><span className="dim">CPU</span></div></>}
      </div>
      <div className="lanes-plot" ref={ref} style={{ height }} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={() => setDrag(null)}>
        <div className="lanes-axis" style={{ height: AXIS_H }}>
          {tk.at.filter((t) => t < span * 0.93).map((t, i) => <span key={t} style={{ left: x(base + t) }} className={i === 0 ? 'first' : undefined}>{tickText(t, i)}</span>)}
          <span className="last">{wall(base + span)}</span>
        </div>
        <div className="lanes-grid" style={{ backgroundSize: `${(100 * tk.step) / span}% 100%` }} />
        {lanes.map((l) => (
          <div key={l.st.id} className="lane" style={{ height: LANE_H }}>
            {l.spans.map((s, i) => (
              <i key={i} className="span" data-stmt={l.st.id} style={{ left: x(s.start), width: `max(2px, ${(100 * (s.end - s.start)) / span}%)`, background: `var(--c-${l.role})` }}
                title={`${l.label} · ${wall(s.start)} → ${wall(s.end)} · ${fmtDur(s.end - s.start)}`} />
            ))}
          </div>
        ))}
        {strips && <Strips strips={strips} span={span} base={base} />}
        {win && !drag && (
          <div className="brush" style={{ left: x(win.startTim), width: `${(100 * (win.endTim - win.startTim)) / span}%` }}>
            <b>window {fmtDur(win.endTim - win.startTim)} · {wall(win.startTim)} → {wall(win.endTim)}
              <button className="brush-clear" onPointerDown={(e) => e.stopPropagation()} onClick={() => actions.setWindow(null)} aria-label="Clear time window" title="clear (Esc)">×</button></b>
          </div>
        )}
        {dragRect && dragRect.width > 3 && <div className="brush dragging" style={dragRect} />}
      </div>
    </div>
  )
}

function Strips({ strips, span, base }: { strips: { bucketUs: number; starts: number[]; series: { role: Role; values: Float64Array }[] }; span: number; base: number }) {
  const n = strips.starts.length
  const w = 100 / n
  const waits = strips.series.filter((s) => s.role !== 'cpu')
  const cpu = strips.series.find((s) => s.role === 'cpu')
  const order = [...waits].sort((a, b) => roleOrder.indexOf(a.role) - roleOrder.indexOf(b.role))
  return (
    <>
      <svg className="strip" style={{ height: STRIP_H }} viewBox={`0 0 100 ${STRIP_H}`} preserveAspectRatio="none" aria-label="waits by class over time">
        {Array.from({ length: n }, (_, b) => {
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
      <svg className="strip" style={{ height: STRIP_H }} viewBox={`0 0 100 ${STRIP_H}`} preserveAspectRatio="none" aria-label="CPU over time">
        {cpu && Array.from({ length: n }, (_, b) => {
          const v = Math.min(1, cpu.values[b] / strips.bucketUs)
          if (v <= 0) return null
          const h = v * (STRIP_H - 4)
          return <rect key={b} x={(100 * (strips.starts[b] - base)) / span} y={STRIP_H - 2 - h} width={w} height={h} fill="var(--c-cpu)" />
        })}
      </svg>
    </>
  )
}
