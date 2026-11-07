import { useEffect, useMemo, useRef, useState, type MouseEvent, type MutableRefObject } from 'react'
import type { TraceDoc } from '../data/doc'
import type { Span2 } from '../data/derive'
import { fmtDur } from '../data/format'
import { ALL_SCOPE } from '../data/lines'
import type { HlSet } from '../data/hlset'
import { axisTicks, bracketAt, shareText } from '../data/overview'
import { sourceOf } from '../data/source'
import type { FileStmtStats } from '../data/stmtpick'
import { StatementPicker, type StmtCounts } from './StatementPicker'

/** Statements on the track. */
const TOP = 8

/** The span of the track as its label says it: `6.46 s`. */
const spanText = (us: number) => (us >= 1e6 && us < 60e6 ? `${(us / 1e6).toFixed(2)} s` : fmtDur(us))

/**
 * The formatted view's overview row: the statement picker at its left (a button that opens the searchable, multi-select list of the file's statements; see
 * `StatementPicker`) and a 12 px track of when the statements with the most time ran across the file's time span, with a thin time axis under it. Only the highlighted
 * statements have a colour: the stretches of the others are two neutral greys, alternating so neighbours separate. A stretch names its statement when hovered (sql_id,
 * time in this file, share); a click on the track goes to the line at that time. The highlighted statements are on the track whether or not they are among the longest. The
 * selected line is a tick on the track, the rows in view a bracket (two 1 px ticks and a wash) that `viewBus` moves without a render.
 */
export function ReadableOverview({ doc, file, stats, from, to, at, hl, colors, filtered, counts, viewBus, lastView, pickerOpen, onPickerOpen, onToggleHl, onToggleFilter, onSetHl, onSetFilter, onGo, onClear, onTim }: {
  doc: TraceDoc
  /** the input file the view shows (the picker lists its statements) */
  file: number
  /** the statements' numbers in this file, by statement id */
  stats: readonly FileStmtStats[]
  /** the file's first and last tim */
  from: number; to: number
  /** the tim of the selected line (a mark on the track), undefined for none */
  at?: number
  /** the highlighted statements and their colours; the filtered ones */
  hl: HlSet
  colors: ReadonlyMap<number, string>
  filtered: ReadonlySet<number>
  /** the calls and waits of the highlighted statement when exactly one is, on the picker's button */
  counts?: StmtCounts | null
  /** the owner calls this with the tim range of the rows in view (null: none); `lastView` is the last one it sent, for a bar that mounts later */
  viewBus: MutableRefObject<((tims: [number, number] | null) => void) | null>
  lastView: MutableRefObject<[number, number] | null>
  /** whether the picker's list is open (the owner's, so the palette and a key can open it) */
  pickerOpen: boolean
  onPickerOpen(open: boolean): void
  onToggleHl(stmt: number): void
  onToggleFilter(stmt: number): void
  onSetHl(stmts: readonly number[], on: boolean): void
  onSetFilter(stmts: readonly number[], on: boolean): void
  /** go to the statement's first line in this file */
  onGo(stmt: number): void
  /** the picker's ×: stop highlighting and filtering */
  onClear(): void
  onTim(tim: number): void
}) {
  // the statements with the most time in this file (recursive SYS SQL below the top level is inside its parents' time and stays off the track)
  const top = useMemo(() => doc.statements
    .filter((s) => !(s.parsingUserId === 0 && s.minDepth > 0))
    .map((s) => ({ id: s.id, e: stats[s.id]?.elapsed ?? 0 }))
    .filter((s) => s.e > 0)
    .sort((a, b) => b.e - a.e || a.id - b.id)
    .slice(0, TOP), [doc, stats])
  const span = Math.max(1, to - from)
  // the statements on the track: the longest, and the highlighted ones on top of them (a statement picked from the list is often a small one)
  const trackIds = useMemo(() => {
    const ids = top.map((s) => s.id)
    return [...ids, ...hl.ids.filter((id) => doc.statements[id] && !ids.includes(id))]
  }, [top, hl, doc])
  const rank = useMemo(() => new Map(top.map((s, k) => [s.id, k])), [top])
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
        <StatementPicker doc={doc} file={file} stats={stats} span={span} hl={hl} colors={colors} filtered={filtered} counts={counts} open={pickerOpen} onOpenChange={onPickerOpen}
          onToggleHl={onToggleHl} onToggleFilter={onToggleFilter} onSetHl={onSetHl} onSetFilter={onSetFilter} onGo={onGo} onClear={onClear} />
        <div className="tb-main">
          <div className="tb-track" onClick={onTrackClick} role="img" aria-label={`Where the time went, ${spanText(span)}: when the statements with the most time ran; hover a stretch for its statement, click to go to that time`}>
            {/* the biggest first: the smaller ones (often recursive, inside them) stay visible on top; the highlighted statements last, in their colours, the others in two greys */}
            {spans && trackIds.map((id) => {
              const st = doc.statements[id]
              const e = stats[id]?.elapsed ?? 0
              const title = `${doc.label(st)} · ${fmtDur(e)} · ${shareText(e, span)} of the traced time in this file`
              const color = colors.get(id)
              return (spans.get(id) ?? []).map((p, i) => (
                <span key={`${id}:${i}`} className={'seg' + (color ? ' cur' : ` n${(rank.get(id) ?? 0) % 2}`)} title={title} style={{ left: `${x(p.start)}%`, width: `max(2px, ${x(p.end) - x(p.start)}%)`, background: color }} />
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
