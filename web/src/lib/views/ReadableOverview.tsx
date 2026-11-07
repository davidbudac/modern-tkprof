import { useEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject } from 'react'
import type { Tone } from '../data/blocklayout'
import type { TraceDoc } from '../data/doc'
import type { Span2 } from '../data/derive'
import { fmtDur } from '../data/format'
import { ALL_SCOPE } from '../data/lines'
import { axisTicks, bracketAt, shareText } from '../data/overview'
import { QUIET_TONE, toneColor } from '../data/readable'
import { sourceOf } from '../data/source'
import { StatementPicker, type StmtCounts } from './StatementPicker'

/** Statements on the track. */
const TOP = 8

/** The span of the track as its label says it: `6.46 s`. */
const spanText = (us: number) => (us >= 1e6 && us < 60e6 ? `${(us / 1e6).toFixed(2)} s` : fmtDur(us))

/**
 * The formatted view's overview row: the statement picker at its left (a button that opens the searchable list of the file's statements; see
 * `StatementPicker`) and a 12 px track of when the statements with the most time ran across the file's time span, with a thin time axis under it.
 * A segment of the track names its statement when hovered (sql_id, time, share); a click on the track goes to the line at that time. The highlighted
 * statement is on the track whether or not it is among the longest. The selected line is a tick on the track, the rows in view a bracket (two 1 px ticks
 * and a wash) that `viewBus` moves without a render.
 */
export function ReadableOverview({ doc, file, tones, from, to, at, current, counts, viewBus, lastView, pickerOpen, onPickerOpen, onStmt, onClear, onTim }: {
  doc: TraceDoc; tones: ReadonlyMap<number, Tone>
  /** the input file the view shows (the picker lists its statements) */
  file: number
  /** the file's first and last tim */
  from: number; to: number
  /** the tim of the selected line (a mark on the track), undefined for none */
  at?: number
  /** the highlighted statement, null for none */
  current?: number | null
  /** the highlighted statement's calls and waits in this file, on the picker's button */
  counts?: StmtCounts | null
  /** the owner calls this with the tim range of the rows in view (null: none); `lastView` is the last one it sent, for a bar that mounts later */
  viewBus: MutableRefObject<((tims: [number, number] | null) => void) | null>
  lastView: MutableRefObject<[number, number] | null>
  /** whether the picker's list is open (the owner's, so the palette and a key can open it) */
  pickerOpen: boolean
  onPickerOpen(open: boolean): void
  /** the picker's choice: highlight the statement and go to its first line in this file */
  onStmt(stmt: number): void
  /** the picker's `None` and ×: stop highlighting */
  onClear(): void
  onTim(tim: number): void
}) {
  const top = useMemo(() => [...tones.keys()]
    .map((id) => ({ id, e: doc.stats.statements[id]?.elapsed ?? 0 }))
    .filter((s) => s.e > 0)
    .sort((a, b) => b.e - a.e)
    .slice(0, TOP), [doc, tones])
  const span = Math.max(1, to - from)
  // the statements on the track: the longest, and the highlighted one on top of them (a statement picked from the list is often a small one)
  const trackIds = useMemo(() => {
    const ids = top.map((s) => s.id)
    return current != null && doc.statements[current] && !ids.includes(current) ? [...ids, current] : ids
  }, [top, current, doc])
  const [spans, setSpans] = useState<Map<number, Span2[]> | null>(null)
  useEffect(() => {
    if (trackIds.length === 0) return
    const ac = new AbortController()
    Promise.resolve(sourceOf(doc).stmtSpans(trackIds, span / 1000, ALL_SCOPE, ac.signal)).then(
      (m) => { if (!ac.signal.aborted) setSpans(m) },
      () => undefined, // no track without the spans
    )
    return () => ac.abort()
  }, [doc, trackIds, span])

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
  useEffect(() => place.current(lastView.current), [from, to, lastView, trackIds])

  const ticks = useMemo(() => axisTicks(from, to, doc.wallOffsetUs ? doc : null), [from, to, doc])

  if (doc.statements.length === 0) return null
  const x = (tim: number) => ((tim - from) / span) * 100
  const onTrackClick = (e: MouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    onTim(from + ((e.clientX - r.left) / Math.max(1, r.width)) * span)
  }
  return (
    <div className="rd-over" role="group" aria-label="Statements by time">
      <div className="time-bar">
        <StatementPicker doc={doc} file={file} tones={tones} span={span} current={current ?? null} counts={counts} open={pickerOpen} onOpenChange={onPickerOpen} onPick={onStmt} onClear={onClear} />
        <div className="tb-main">
          <div className="tb-track" onClick={onTrackClick} role="img" aria-label={`Where the time went, ${spanText(span)}: when the statements with the most time ran; hover a stretch for its statement, click to go to that time`}>
            {/* the biggest first: the smaller ones (often recursive, inside them) stay visible on top; the highlighted statement last */}
            {spans && trackIds.map((id) => {
              const st = doc.statements[id]
              const e = doc.stats.statements[id]?.elapsed ?? 0
              const title = `${doc.label(st)} · ${fmtDur(e)} · ${shareText(e, span)} of the traced time`
              return (spans.get(id) ?? []).map((p, i) => (
                <span key={`${id}:${i}`} className={'seg' + (id === current ? ' cur' : '')} title={title} style={{ left: `${x(p.start)}%`, width: `max(2px, ${x(p.end) - x(p.start)}%)`, background: toneColor(tones.get(id) ?? QUIET_TONE) }} />
              ))
            })}
            <span className="vbracket" ref={bracket} style={{ display: 'none' }} title="the rows in view" />
            {at !== undefined && at >= from && at <= to && <span className="at" style={{ left: `${x(at)}%` }} />}
          </div>
          <div className="tb-axis" aria-hidden="true">
            {ticks.map((t) => <span key={t.f} className="ax" style={{ left: `${(t.f * 100).toFixed(3)}%` }}><i />{t.label}</span>)}
          </div>
        </div>
      </div>
    </div>
  )
}
