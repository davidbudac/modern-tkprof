import { useEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject } from 'react'
import type { Tone } from '../data/blocklayout'
import type { TraceDoc } from '../data/doc'
import type { Span2 } from '../data/derive'
import { fmtDur, fmtInt, preview } from '../data/format'
import { ALL_SCOPE } from '../data/lines'
import { axisTicks, bracketAt, shareText, splitChips } from '../data/overview'
import { QUIET_TONE, toneColor } from '../data/readable'
import { sourceOf } from '../data/source'

/** Statements in the key and on the track. */
const TOP = 8

/** What the highlighted statement has in this file: its calls and waits (the real counts), and what is said when the marks are bounded. */
export interface StmtCounts { calls: number; waits: number; note?: string }

/** The span of the track as the label says it: `6.46 s`. */
const spanText = (us: number) => (us >= 1e6 && us < 60e6 ? `${(us / 1e6).toFixed(2)} s` : fmtDur(us))

/**
 * The readable view's key: "Where the time went", a 12 px track of when the statements with the most time ran across the file's time span with a thin
 * time axis under it, and the statements that took the most time as chips (`sql_id 2.486 s · 38 %`), each in its lane colour; those under 1 % are one
 * `+n under 1 %` chip that opens on a click. A chip goes to the statement's first line in this file, a click on the track to the line at that time. The
 * selected line is a tick on the track, the rows in view a bracket (two 1 px ticks and a wash) that `viewBus` moves without a render. The outlined chip
 * of the highlighted statement carries its count of calls and waits and the × that stops the highlight.
 */
export function ReadableOverview({ doc, tones, from, to, at, current, counts, viewBus, lastView, onStmt, onClear, onTim }: {
  doc: TraceDoc; tones: ReadonlyMap<number, Tone>
  /** the file's first and last tim */
  from: number; to: number
  /** the tim of the selected line (a mark on the track), undefined for none */
  at?: number
  /** the highlighted statement (its chip is outlined), null for none */
  current?: number | null
  /** the highlighted statement's calls and waits in this file, on its chip */
  counts?: StmtCounts | null
  /** the owner calls this with the tim range of the rows in view (null: none); `lastView` is the last one it sent, for a bar that mounts later */
  viewBus: MutableRefObject<((tims: [number, number] | null) => void) | null>
  lastView: MutableRefObject<[number, number] | null>
  /** a chip: highlight the statement and go to its first line in this file */
  onStmt(stmt: number): void
  /** the chip's ×: stop highlighting */
  onClear(): void
  onTim(tim: number): void
}) {
  const top = useMemo(() => [...tones.keys()]
    .map((id) => ({ id, e: doc.stats.statements[id]?.elapsed ?? 0 }))
    .filter((s) => s.e > 0)
    .sort((a, b) => b.e - a.e)
    .slice(0, TOP), [doc, tones])
  const span = Math.max(1, to - from)
  // the highlighted statement is always a chip (the outlined one carries its count and the ×), even when it is not among the longest
  const chips = useMemo(() => {
    if (current == null || top.some((s) => s.id === current) || !doc.statements[current]) return top
    return [...top, { id: current, e: doc.stats.statements[current]?.elapsed ?? 0 }]
  }, [top, current, doc])
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

  // the bracket of the rows in view: its style is set here, from the owner's calls (no render per scroll step)
  const bracket = useRef<HTMLSpanElement>(null)
  const place = useRef<(tims: [number, number] | null) => void>(() => undefined)
  place.current = (tims) => {
    const el = bracket.current
    if (!el) return
    const b = bracketAt(tims, from, to)
    el.style.display = b ? '' : 'none'
    if (b) { el.style.left = `${(b.left * 100).toFixed(3)}%`; el.style.width = `max(6px, ${(b.width * 100).toFixed(3)}%)` }
  }
  useEffect(() => {
    viewBus.current = (t) => place.current(t)
    place.current(lastView.current)
    return () => { viewBus.current = null }
  }, [viewBus, lastView])
  useEffect(() => place.current(lastView.current), [from, to, lastView, top])

  const [more, setMore] = useState(false)
  const { shown, folded } = useMemo(() => splitChips(chips, span, current ?? null), [chips, span, current])
  const ticks = useMemo(() => axisTicks(from, to, doc.wallOffsetUs ? doc : null), [from, to, doc])

  if (top.length === 0) return null
  const x = (tim: number) => ((tim - from) / span) * 100
  const onTrack = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onTim(from + ((e.clientX - r.left) / Math.max(1, r.width)) * span)
  }
  const chip = (s: { id: number; e: number }) => {
    const st = doc.statements[s.id]
    const on = current === s.id
    const color = toneColor(tones.get(s.id) ?? QUIET_TONE)
    return (
      <span key={s.id} className={'chip chip-stmt' + (on ? ' on' : '')} style={{ '--chip': color } as React.CSSProperties}>
        <button type="button" className="chip-main" aria-pressed={on} onClick={() => onStmt(s.id)} title={`${preview(st.text, 200)}\n${fmtDur(s.e)} elapsed: highlight its calls and waits and go to its first line in this file`}>
          <i style={{ background: color }} />
          <span className="mono">{doc.label(st)}</span>
          <small>{fmtDur(s.e)} · {shareText(s.e, span)}</small>
        </button>
        {on && counts && (
          <small className="cnt" title={`the rows of this statement's calls and waits are tinted in its colour, with a bar at their start edge (l highlights the selected line's statement instead, Enter opens it)${counts.note ? `\n${counts.note}` : ''}`}>
            {counts.calls + counts.waits === 0 ? 'nothing in this file' : `${fmtInt(counts.calls)} ${counts.calls === 1 ? 'call' : 'calls'} · ${fmtInt(counts.waits)} ${counts.waits === 1 ? 'wait' : 'waits'}`}
          </small>
        )}
        {on && <button type="button" className="x" onClick={onClear} aria-label="Stop highlighting" title="stop highlighting this statement">×</button>}
      </span>
    )
  }
  return (
    <div className="rd-over" role="group" aria-label="Statements by time">
      <div className="time-bar">
        <span className="tb-label">Where the time went · {spanText(span)}</span>
        <div className="tb-main">
          <div className="tb-track" onClick={onTrack} role="img" aria-label="When the statements with the most time ran; click to go to that time">
            {/* the biggest first: the smaller ones (often recursive, inside them) stay visible on top */}
            {spans && top.map((s) => (spans.get(s.id) ?? []).map((p, i) => (
              <span key={`${s.id}:${i}`} className="seg" style={{ left: `${x(p.start)}%`, width: `max(2px, ${x(p.end) - x(p.start)}%)`, background: toneColor(tones.get(s.id)!) }} />
            )))}
            <span className="vbracket" ref={bracket} style={{ display: 'none' }} title="the rows in view" />
            {at !== undefined && at >= from && at <= to && <span className="at" style={{ left: `${x(at)}%` }} />}
          </div>
          <div className="tb-axis" aria-hidden="true">
            {ticks.map((t) => <span key={t.f} className="ax" style={{ left: `${(t.f * 100).toFixed(3)}%` }}><i />{t.label}</span>)}
          </div>
        </div>
      </div>
      <div className="rd-chips">
        {shown.map(chip)}
        {folded.length > 0 && (
          <button type="button" className="chip chip-fold" aria-expanded={more} onClick={() => setMore(!more)}
            title={`${folded.length} ${folded.length === 1 ? 'statement' : 'statements'} among the ${TOP} longest took under 1 % of the traced time each: click to ${more ? 'fold them again' : 'show them'}`}>
            <small>{more ? `− ${folded.length} under 1 %` : `+${folded.length} under 1 %`}</small>
          </button>
        )}
        {more && folded.map(chip)}
      </div>
    </div>
  )
}
