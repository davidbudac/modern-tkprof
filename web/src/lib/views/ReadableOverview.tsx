import { useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { Tone } from '../data/blocklayout'
import type { TraceDoc } from '../data/doc'
import type { Span2 } from '../data/derive'
import { fmtDur, fmtPct, preview } from '../data/format'
import { ALL_SCOPE } from '../data/lines'
import { toneColor } from '../data/readable'
import { sourceOf } from '../data/source'

/** Statements in the key and on the track. */
const TOP = 8

/**
 * The readable view's key: the statements that took the most time, each in its lane colour, and a track of when they ran across the
 * file's time span. A chip goes to the statement's first line in this file, a click on the track to the line at that time; the
 * selected line is marked on the track.
 */
export function ReadableOverview({ doc, tones, from, to, at, onStmt, onTim }: {
  doc: TraceDoc; tones: ReadonlyMap<number, Tone>
  /** the file's first and last tim */
  from: number; to: number
  /** the tim of the selected line (a mark on the track), undefined for none */
  at?: number
  onStmt(stmt: number): void
  onTim(tim: number): void
}) {
  const top = useMemo(() => [...tones.keys()]
    .map((id) => ({ id, e: doc.stats.statements[id]?.elapsed ?? 0 }))
    .filter((s) => s.e > 0)
    .sort((a, b) => b.e - a.e)
    .slice(0, TOP), [doc, tones])
  const span = Math.max(1, to - from)
  const [spans, setSpans] = useState<Map<number, Span2[]> | null>(null)
  useEffect(() => {
    if (top.length === 0) return
    const ac = new AbortController()
    Promise.resolve(sourceOf(doc).stmtSpans(top.map((s) => s.id), span / 1000, ALL_SCOPE, ac.signal)).then(
      (m) => { if (!ac.signal.aborted) setSpans(m) },
      () => undefined, // no track without the spans
    )
    return () => ac.abort()
  }, [doc, top, span])

  if (top.length === 0) return null
  const x = (tim: number) => ((tim - from) / span) * 1000
  const onTrack = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onTim(from + ((e.clientX - r.left) / Math.max(1, r.width)) * span)
  }
  return (
    <div className="rd-over" role="group" aria-label="Statements by time">
      <svg className="rd-track" viewBox="0 0 1000 10" preserveAspectRatio="none" onClick={onTrack} role="img" aria-label="When the statements with the most time ran; click to go to that time">
        {/* the biggest first: the smaller ones (often recursive, inside them) stay visible on top */}
        {spans && top.map((s) => (spans.get(s.id) ?? []).map((p, i) => (
          <rect key={`${s.id}:${i}`} x={x(p.start)} y={0} width={Math.max(0.6, x(p.end) - x(p.start))} height={10} style={{ fill: toneColor(tones.get(s.id)!) }} />
        )))}
        {at !== undefined && at >= from && at <= to && <rect className="rd-track-at" x={x(at) - 0.75} y={0} width={1.5} height={10} />}
      </svg>
      <div className="rd-chips">
        {top.map((s) => {
          const st = doc.statements[s.id]
          return (
            <button key={s.id} type="button" className="rd-chip-st quiet" onClick={() => onStmt(s.id)} title={`${preview(st.text, 200)}\n${fmtDur(s.e)} elapsed: go to its first line in this file`}>
              <i style={{ background: toneColor(tones.get(s.id)!) }} />
              <span className="mono">{doc.label(st)}</span>
              <small>{fmtPct(s.e, span, 0)}</small>
            </button>
          )
        })}
      </div>
    </div>
  )
}
