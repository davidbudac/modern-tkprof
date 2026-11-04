import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { TraceDoc } from '../data/doc'
import type { Execution } from '../data/derive'
import type { ExecTrace, TraceCall } from '../data/exectrace'
import type { ID } from '../data/types'
import { CallKind, callKindName } from '../data/types'
import { sourceOf, useSourceQuery } from '../data/source'
import { fmtDur, fmtInt } from '../data/format'
import {
  dialogueOf, dialogueLayout, HEAD_H, MAX_STEPS, REC_OUTLIER_LINES, REC_X, arrowWidth,
  type Dialogue as DialogueData, type Layout, type Lifeline, type Recursive, type SideLine, type SideRow, type StepBox, type Traffic, type Turn,
} from '../data/dialogue'
import { ProfileBar, type Segment } from '../components/ProfileBar'
import { LineRef } from '../components/LineRef'
import { StmtLink } from '../components/StmtLink'
import { roleLabel, roleOfClass, roleOrder, type Role } from '../components/colors'
import { usePopover } from '../components/usePopover'
import type { PopAnchor } from '../components/popoverPlace'
import { Shimmer } from '../components/motion'
import '../styles/loom.css' // --ev-temp, --ev-temp-w
import '../styles/dialogue.css'

// The Dialogue (docs/ARCHITECTURE.md § "Dialogue"): one execution as a sequence diagram. The data and the layout are
// data/dialogue.ts; this draws them as SVG and adds the popovers (hover shows, click or Enter pins) with the trace lines.

/** One picked execution of the statement inspector as a sequence diagram (over `executions/trace`, like the Loom). */
export function Dialogue({ doc, stmt, exec }: { doc: TraceDoc; stmt: ID; exec: Execution }) {
  const source = sourceOf(doc)
  // the Loom's key: one execution trace answer for both views
  const q = useSourceQuery(source, `loom:${stmt}:${exec.cursor}:${exec.execNo}`, (signal) => source.executionTrace(stmt, exec, signal))
  if (q.error) return <p className="callout">Dialogue: {q.error}</p>
  if (q.data === undefined) return <p className="small muted"><Shimmer>Dialogue: loading…</Shimmer></p>
  if (q.data === null) {
    return (
      <p className="small muted dlg-na" role="status">
        {source.remote
          ? 'The Dialogue needs the engine route api/executions/trace, which this engine does not serve: update mtkprof.'
          : 'The Dialogue needs the calls and waits of the trace, which this report does not carry (written with -aggregate, or exported without facts).'}
      </p>
    )
  }
  if (q.data.calls.length === 0) return <p className="small muted dlg-na" role="status">No calls of this execution in the trace.</p>
  return <DialogueView doc={doc} trace={q.data} execNo={exec.execNo} />
}

// ---- names and colours -----------------------------------------------------------------------------------------

const kindOf = (k: number) => callKindName[k] ?? `call ${k}`
/** the phase shade of a server activation (the --c-phase-* ramp) */
const phaseOf = (k: number) => (k === CallKind.parse ? 'parse' : k === CallKind.exec ? 'exec' : k === CallKind.fetch ? 'fetch' : 'other')
const evName = (doc: TraceDoc, id: ID) => doc.events[id]?.name ?? `event ${id}`
const plural = (n: number, one: string, many = one + 's') => `${fmtInt(n)} ${n === 1 ? one : many}`

/** The colour of an event's arrow: TEMP writes and reads in the Loom's hues, disk by its class, the others by role. */
function eventColor(doc: TraceDoc, id: ID, line: SideLine): string {
  const ev = doc.events[id]
  if (line === 'temp') return ev && /write/i.test(ev.name) ? 'var(--ev-temp-w)' : 'var(--ev-temp)'
  if (!ev) return 'var(--c-other)'
  return `var(--c-${roleOfClass(ev.class, ev.idle)})`
}
const laneColor: Record<SideLine, string> = { disk: 'var(--c-userio)', temp: 'var(--ev-temp)', others: 'var(--c-other)' }

function laneTitle(doc: TraceDoc, d: DialogueData, line: Lifeline, ctx: ID): [string, string] {
  const c = doc.contexts[ctx]
  switch (line) {
    case 'client': {
      if (c?.px) return ['Client', 'query coordinator']
      const drv = c?.clientDriver ? (c.clientDriver === 'SQL*PLUS' ? 'SQL*Plus' : c.clientDriver) : ''
      return ['Client', drv ? `${drv} session` : 'application']
    }
    case 'server': return ['Server process', c?.sessionId ? `session ${c.sessionId}` : c?.process ? `process ${c.process}` : '']
    case 'disk':
    case 'temp': {
      const files = d.lanes[line]?.files ?? []
      const sub = files.length === 0 ? '' : files.length <= 3 ? `file${files.length > 1 ? 's' : ''} ${files.join(', ')}` : `${files.length} files`
      return [line === 'disk' ? 'Disk' : 'TEMP', sub || (line === 'disk' ? 'datafiles' : 'temp segments')]
    }
    case 'others': {
      const cls = d.lanes.others?.classes ?? []
      return ['Others', cls.length <= 2 ? cls.join(', ') : `${cls.length} wait classes`]
    }
  }
}

function callLabel(t: Turn): string {
  return `${kindOf(t.kind)}${t.kind === CallKind.fetch ? ` #${t.ordinal}` : ''}`
}

function rowsLabel(kind: number, rows: number, each: boolean): string {
  if (kind === CallKind.fetch) return `${plural(rows, 'row')}${each ? ' each' : ''}`
  return rows > 0 ? `${plural(rows, 'row')} processed${each ? ' each' : ''}` : ''
}

// ---- popovers ----------------------------------------------------------------------------------------------------

type Pop =
  | { kind: 'call'; box: StepBox }
  | { kind: 'side'; box: StepBox; row: SideRow }
  | { kind: 'gap'; box: StepBox }
  | { kind: 'rec'; box: StepBox }
  | { kind: 'ret'; box: StepBox }

interface PopState { key: string; pop: Pop; anchor: PopAnchor; pinned: boolean }

function DialogueView({ doc, trace, execNo }: { doc: TraceDoc; trace: ExecTrace; execNo: number }) {
  const d = useMemo(() => dialogueOf(doc, trace), [doc, trace])
  const lay = useMemo(() => dialogueLayout(d, (e) => doc.events[e]?.name ?? ''), [d, doc])
  const ctx = trace.calls[0].ctx
  const file = doc.fileOfCtx(ctx)
  const [pop, setPop] = useState<PopState | null>(null)
  const timer = useRef(0)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => setPop(null), [d])

  const anchorOf = (el: Element): PopAnchor => {
    const r = el.getBoundingClientRect()
    return { x: r.left, y: r.bottom, rect: { left: r.left, top: r.top, bottom: r.bottom } }
  }
  const later = (f: () => void, ms: number) => { window.clearTimeout(timer.current); timer.current = window.setTimeout(f, ms) }
  /** the props of one interactive mark: hover shows its popover, a click or Enter pins it */
  const mark: Mark = (key, p, label) => ({
    tabIndex: 0, role: 'button', 'aria-label': label, 'aria-haspopup': 'dialog', className: 'dlg-hit' + (pop?.key === key ? ' on' : ''),
    onMouseEnter: (e) => { const el = e.currentTarget; if (!pop?.pinned) later(() => setPop({ key, pop: p, anchor: anchorOf(el), pinned: false }), 120) },
    onMouseLeave: () => { if (!pop?.pinned) later(() => setPop(null), 220) },
    onClick: (e) => { window.clearTimeout(timer.current); setPop({ key, pop: p, anchor: anchorOf(e.currentTarget), pinned: true }) },
    onKeyDown: (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return
      e.preventDefault(); window.clearTimeout(timer.current); setPop({ key, pop: p, anchor: anchorOf(e.currentTarget), pinned: true })
    },
  })

  const inCalls = d.steps.reduce((a, s) => a + (s.type === 'turn' ? s.turn.ela : s.frame.serverUs), 0)
  const waitUs = Object.values(d.totals.byRole).reduce((a, v) => a + (v ?? 0), 0)
  const over = d.totals.cpuUs + waitUs + d.totals.gapUs - d.wall.us
  const segments: Segment[] = [
    { role: 'cpu', label: 'CPU', us: d.totals.cpuUs },
    ...roleOrder.filter((r) => r !== 'cpu' && r !== 'unaccounted' && (d.totals.byRole[r] ?? 0) > 0)
      .map((r): Segment => ({ role: r, label: r === 'idle' ? 'Idle in calls' : roleLabel[r], us: d.totals.byRole[r] ?? 0 })),
    { role: 'idle', label: 'client gaps', us: d.totals.gapUs },
    { role: 'unaccounted', label: 'untimed', us: d.totals.untimedUs },
  ]
  const facts = [
    d.ttfrUs !== null ? `time to first row ${fmtDur(d.ttfrUs)} of ${fmtDur(d.wall.us)}` : `${fmtDur(d.wall.us)} first call to last, no rows fetched`,
    d.trips !== null ? plural(d.trips, 'round trip') : `${plural(d.calls, 'call')} (no WAIT lines: round trips unknown)`,
    d.rowsPerTrip !== null ? `${plural(d.rowsPerTrip, 'row')} per fetch` : '',
    `in calls ${fmtDur(inCalls)} · client gaps ${fmtDur(d.totals.gapUs)}`,
  ].filter(Boolean)

  return (
    <div className="dlg">
      <Legend doc={doc} d={d} />
      {d.truncated && (
        <p className="small muted dlg-na" role="status">
          The engine cut this execution's rows at its limit (50,000 recursive calls, 200,000 waits): the diagram and the totals are of the rows that arrived.
        </p>
      )}
      <div className="dlg-scroll">
        <svg className="dlg-svg" width={lay.width} height={lay.height} viewBox={`0 0 ${lay.width} ${lay.height}`} role="group" aria-label={`Sequence diagram of execution #${execNo}: ${facts.join(', ')}`}>
          <Lanes doc={doc} d={d} lay={lay} ctx={ctx} />
          {lay.ttfr && d.ttfrUs !== null && <Ttfr y1={lay.ttfr.y1} y2={lay.ttfr.y2} us={d.ttfrUs} />}
          {lay.boxes.map((b, k) => <Box key={k} k={k} doc={doc} lay={lay} box={b} mark={mark} />)}
        </svg>
      </div>
      {lay.hidden > 0 && <p className="small muted" role="status">First {fmtInt(MAX_STEPS)} of {fmtInt(lay.boxes.length + lay.hidden)} steps drawn; the totals below are of all {plural(d.calls, 'call')}.</p>}
      <div className="dlg-scale">
        <h4>Wall clock, first call to last, to scale: {fmtDur(d.wall.us)}</h4>
        <ProfileBar segments={segments} totalUs={d.wall.us} compact />
        <p className="small dlg-facts">{facts.join(' · ')}</p>
        {over > 0 && d.wall.us > 0 && <p className="small muted">CPU, in-call waits and gaps add up to {fmtDur(over)} more than the wall clock: the call counters overlap (CPU spent inside waits), so nothing is left untimed.</p>}
        {d.totals.leadGapUs > 0 && <p className="small muted">Client gap before the first call: {fmtDur(d.totals.leadGapUs)} (before this execution started; not in the wall clock).</p>}
      </div>
      {pop && (
        <DialoguePopover key={pop.key + (pop.pinned ? ':pin' : '')} doc={doc} file={file} st={pop}
          onEnter={() => window.clearTimeout(timer.current)}
          onLeave={() => { if (!pop.pinned) later(() => setPop(null), 220) }}
          onClose={() => { window.clearTimeout(timer.current); setPop(null) }} />
      )}
    </div>
  )
}

/** The props that make an SVG group an interactive mark (see `mark` in DialogueView). */
interface MarkProps {
  tabIndex: number; role: string; 'aria-label': string; 'aria-haspopup': 'dialog'; className: string
  onMouseEnter(e: React.MouseEvent<SVGGElement>): void; onMouseLeave(): void; onClick(e: React.MouseEvent<SVGGElement>): void; onKeyDown(e: React.KeyboardEvent<SVGGElement>): void
}
type Mark = (key: string, p: Pop, label: string) => MarkProps

function Legend({ doc, d }: { doc: TraceDoc; d: DialogueData }) {
  const seen = new Map<string, { color: string; label: string }>()
  for (const s of d.steps) {
    const sides = s.type === 'turn' ? s.turn.sides : s.frame.sides
    for (const [l, ts] of Object.entries(sides) as [SideLine, Traffic[]][]) {
      for (const t of ts) {
        const color = eventColor(doc, t.event, l)
        // TEMP by event (the two hues), the rest by wait class role, as in the bar under the figure
        const label = l === 'temp' ? evName(doc, t.event) : roleLabel[roleOfClass(doc.events[t.event]?.class ?? '', doc.events[t.event]?.idle ?? false)]
        if (!seen.has(label)) seen.set(label, { color, label })
      }
    }
  }
  return (
    <div className="dlg-legend small" aria-label="Legend">
      <span><i className="dlg-key line" /> call</span>
      <span><i className="dlg-key dash" /> reply to the client</span>
      <span><i className="dlg-key act parse" /><i className="dlg-key act exec" /><i className="dlg-key act fetch" /> server busy in PARSE, EXEC, FETCH (log height)</span>
      <span><i className="dlg-key gap" /> client gap (between calls)</span>
      {[...seen.values()].map((s) => <span key={s.label}><i className="dlg-key sw" style={{ background: s.color }} /> {s.label}</span>)}
      <span className="muted">hover or click a mark for its trace lines</span>
    </div>
  )
}

function Lanes({ doc, d, lay, ctx }: { doc: TraceDoc; d: DialogueData; lay: Layout; ctx: ID }) {
  return (
    <g className="dlg-lanes">
      {lay.lanes.map(({ line, x }) => {
        const [t, sub] = laneTitle(doc, d, line, ctx)
        return (
          <g key={line}>
            <line className="dlg-life" x1={x} x2={x} y1={HEAD_H} y2={lay.height - 6} />
            <rect className="dlg-head" x={x - 70} y={6} width={140} height={HEAD_H - 12} rx={6} />
            <text className="dlg-head-t" x={x} y={24} textAnchor="middle">{t}</text>
            {sub && <text className="dlg-head-s" x={x} y={38} textAnchor="middle">{sub.length > 24 ? sub.slice(0, 23) + '…' : sub}<title>{sub}</title></text>}
          </g>
        )
      })}
    </g>
  )
}

function Ttfr({ y1, y2, us }: { y1: number; y2: number; us: number }) {
  const x = 12, mid = (y1 + y2) / 2
  return (
    <g className="dlg-ttfr" aria-label={`time to first row ${fmtDur(us)}`}>
      <path d={`M${x + 6},${y1} H${x} V${y2} H${x + 6}`} />
      <text x={x + 10} y={mid - 10}>time to</text>
      <text x={x + 10} y={mid + 3}>first row</text>
      <text x={x + 10} y={mid + 17} className="b">{fmtDur(us)}</text>
    </g>
  )
}

/** An arrowhead at (x, y) pointing right (dir 1) or left (-1). */
function Head({ x, y, dir, size = 7, color }: { x: number; y: number; dir: 1 | -1; size?: number; color?: string }) {
  return <path className="dlg-arrowhead" d={`M${x},${y} L${x - dir * size},${y - size / 2} L${x - dir * size},${y + size / 2} Z`} style={color ? { fill: color } : undefined} />
}

/** Text drawn over a light halo, so it stays readable across lifelines. */
function T({ x, y, children, anchor = 'middle', className }: { x: number; y: number; children: ReactNode; anchor?: 'start' | 'middle' | 'end'; className?: string }) {
  return <text className={'dlg-t' + (className ? ' ' + className : '')} x={x} y={y} textAnchor={anchor}>{children}</text>
}

function Box({ k, doc, lay, box, mark }: { k: number; doc: TraceDoc; lay: Layout; box: StepBox; mark: Mark }) {
  const { x } = lay
  const xc = x.client, xs = x.server
  const fr = box.step.type === 'frame' ? box.step.frame : null
  const t = box.turn
  const kind = kindOf(t.kind)
  const rows = fr ? fr.rows : t.rows
  const ela = fr ? fr.medianEla : t.ela
  const lastOrd = fr ? fr.turns[fr.turns.length - 1].ordinal : t.ordinal
  const callText = fr
    ? `${kind}${t.kind === CallKind.fetch ? ` #${t.ordinal}–#${lastOrd}` : ''} · median ${fmtDur(ela)}`
    : `${callLabel(t)} · ${fmtDur(ela)}`
  const net = fr ? fr.net : t.net
  const rec = fr ? fr.recursive : t.recursive
  const outlier = !fr && t.outlier && t.runMedian
    ? t.outlier === 'ela' ? `kept apart: ${Math.round(t.ela / Math.max(1, t.runMedian.ela))}× the run's median elapsed (${fmtDur(t.runMedian.ela)})`
      : `kept apart: gap ${Math.round(t.gapBefore / Math.max(1, t.runMedian.gap))}× the run's median (${fmtDur(t.runMedian.gap)})`
    : ''
  const firstLead = k === 0 && !fr
  return (
    <g className={'dlg-step' + (fr ? ' frame' : '') + (t.outlier ? ' outlier' : '')}>
      {box.frame && fr && <FrameBox f={box.frame} n={fr.n} note={`server ${fmtDur(fr.serverUs)} · client gaps ${fmtDur(fr.gapUs)}`} />}
      {box.gap && (
        <g {...mark(`g${k}`, { kind: 'gap', box }, `client gap ${fmtDur(box.gap.us)} before ${callLabel(t)}`)}>
          <rect className="dlg-hitbox" x={xc - 95} y={box.gap.y - 4} width={100} height={Math.max(box.gap.h, 20) + 8} />
          <rect className="dlg-gap" x={xc - 4} y={box.gap.y} width={8} height={box.gap.h} rx={1.5} />
          <T x={xc - 10} y={box.gap.y + Math.max(box.gap.h, 20) / 2 - 2} anchor="end" className="sub">{fr ? 'gap median' : firstLead ? 'gap before' : 'client gap'}</T>
          <T x={xc - 10} y={box.gap.y + Math.max(box.gap.h, 20) / 2 + 11} anchor="end" className="num">{fmtDur(box.gap.us)}</T>
        </g>
      )}
      <g {...mark(`c${k}`, { kind: 'call', box }, `${callText}${fr ? `, loop of ${fr.n}` : ''}`)}>
        <rect className="dlg-hitbox" x={xc} y={box.callY - 16} width={xs - xc + 8} height={Math.max(box.act.h, 8) + 18} />
        <line className="dlg-call" x1={xc} x2={xs - 13} y1={box.callY} y2={box.callY} />
        <Head x={xs - 6} y={box.callY} dir={1} />
        <T x={(xc + xs) / 2} y={box.callY - 5} className={'num' + (t.outlier ? ' hot' : '')}>{callText}</T>
        <rect className={'dlg-act ' + phaseOf(t.kind)} x={xs - 6} y={box.act.y} width={12} height={box.act.h} rx={1.5} />
        {box.act.h >= 14 && <T x={xs - 10} y={box.act.y + box.act.h - 3} anchor="end" className="sub num">CPU {fmtDur(fr ? fr.cpuUs / fr.n : t.cpu)}</T>}
        {outlier && <T x={xs - 10} y={box.callY + 13} anchor="end" className="sub hot">{outlier}</T>}
      </g>
      {box.sides.map((row, i) => <Side key={i} doc={doc} lay={lay} row={row} inAll={!!fr} mark={mark(`s${k}:${i}`, { kind: 'side', box, row }, sideText(doc, row, !!fr).join(' '))} />)}
      {box.rec && (
        <g {...mark(`r${k}`, { kind: 'rec', box }, `recursive SQL × ${fmtInt(rec.n)}, ${fmtDur(rec.us)}`)}>
          <rect className="dlg-hitbox" x={xs + 4} y={box.rec.y - 10} width={REC_X + 230} height={14 * box.rec.lines + 12} />
          <path className="dlg-self" d={`M${xs + 6},${box.rec.y - 5} h20 v12 h-12`} />
          <Head x={xs + 7} y={box.rec.y + 7} dir={-1} size={6} />
          {recText(doc, rec, !!fr).map((s, i) => <T key={i} x={xs + REC_X} y={box.rec!.y + 4 + 14 * i} anchor="start" className={i ? 'sub hot' : 'num'}>{s}</T>)}
        </g>
      )}
      {box.retY !== null && (
        <g {...mark(`t${k}`, { kind: 'ret', box }, `reply ${rowsLabel(t.kind, rows, !!fr) || 'to the client'}`)}>
          <rect className="dlg-hitbox" x={xc} y={box.retY - 16} width={xs - xc} height={22} />
          <line className="dlg-ret" x1={xs - 7} x2={xc + 8} y1={box.retY} y2={box.retY} />
          <Head x={xc + 2} y={box.retY} dir={-1} />
          {rowsLabel(t.kind, rows, !!fr) && <T x={(xc + xs) / 2} y={box.retY - 5} className="num">{rowsLabel(t.kind, rows, !!fr)}</T>}
          {net.moreData && <>
            <rect className="dlg-net" x={xs - 14} y={box.retY - 4} width={8} height={8} rx={1.5} />
            <T x={xs + 10} y={box.retY + 4} anchor="start" className="sub num">more data to client × {fmtInt(net.moreData.n)}{fr ? ' in all' : ''} · {fmtDur(net.moreData.us)}</T>
          </>}
        </g>
      )}
    </g>
  )
}

function FrameBox({ f, n, note }: { f: NonNullable<StepBox['frame']>; n: number; note: string }) {
  const tag = `loop × ${fmtInt(n)}`
  const tw = 16 + tag.length * 7
  return (
    <g className="dlg-frame">
      <rect x={f.x1} y={f.y1} width={f.x2 - f.x1} height={f.y2 - f.y1} rx={8} />
      <path className="tab" d={`M${f.x1 + 8},${f.y1} H${f.x1 + tw} V${f.y1 + 14} L${f.x1 + tw - 6},${f.y1 + 20} H${f.x1} V${f.y1 + 8} Q${f.x1},${f.y1} ${f.x1 + 8},${f.y1} Z`} />
      <text className="dlg-frame-t" x={f.x1 + 7} y={f.y1 + 14.5}>{tag}</text>
      <T x={f.x2 - 8} y={f.y1 + 15} anchor="end" className="num">{note}</T>
    </g>
  )
}

function sideText(doc: TraceDoc, row: SideRow, inAll: boolean): [string, string] {
  const n = row.traffic.reduce((a, t) => a + t.n, 0), us = row.traffic.reduce((a, t) => a + t.us, 0)
  const name = row.traffic.length === 1 ? evName(doc, row.traffic[0].event) : `${row.traffic.length} more events`
  return [name, `× ${fmtInt(n)}${inAll ? ' in all' : ''} · ${fmtDur(us)}`]
}

function Side({ doc, lay, row, inAll, mark }: { doc: TraceDoc; lay: Layout; row: SideRow; inAll: boolean; mark: MarkProps }) {
  const xs = lay.x.server, xl = lay.x[row.line]
  const us = row.traffic.reduce((a, t) => a + t.us, 0)
  const color = row.traffic.length === 1 ? eventColor(doc, row.traffic[0].event, row.line) : laneColor[row.line]
  const w = arrowWidth(us)
  const [l1, l2] = sideText(doc, row, inAll)
  const size = 6 + w
  return (
    <g {...mark}>
      <rect className="dlg-hitbox" x={xs + 6} y={row.y - 30} width={xl - xs} height={36} />
      {row.read ? <>
        <line className="dlg-side" x1={xl - 4} x2={xs + 7 + size} y1={row.y} y2={row.y} style={{ stroke: color, strokeWidth: w }} />
        <Head x={xs + 7} y={row.y} dir={-1} size={size} color={color} />
      </> : <>
        <line className="dlg-side" x1={xs + 7} x2={xl - 4 - size} y1={row.y} y2={row.y} style={{ stroke: color, strokeWidth: w }} />
        <Head x={xl - 4} y={row.y} dir={1} size={size} color={color} />
      </>}
      <rect className="dlg-tick" x={xl - 3} y={row.y - 7} width={6} height={14} rx={1.5} style={{ fill: color }} />
      <T x={(xs + xl) / 2} y={row.y - 18}>{l1}</T>
      <T x={(xs + xl) / 2} y={row.y - 6} className="num">{l2}</T>
    </g>
  )
}

function recText(doc: TraceDoc, r: Recursive, inAll: boolean): string[] {
  const out = [`recursive SQL × ${fmtInt(r.n)}${inAll ? ' in all' : ''} · ${fmtDur(r.us)}`]
  for (const g of r.groups.filter((x) => x.outliers.length).slice(0, REC_OUTLIER_LINES)) {
    const st = doc.statements[g.stmt]
    const o = g.outliers[0]
    out.push(`${st ? doc.label(st) : `stmt ${g.stmt}`} ${kindOf(g.kind)} × ${fmtInt(g.n)}: median ${fmtDur(g.medianEla)}, ${g.outliers.length === 1 ? 'one at' : `${g.outliers.length} above 10×, first`} ${fmtDur(o.e)}`)
  }
  return out
}

// ---- the popover -------------------------------------------------------------------------------------------------

function DialoguePopover({ doc, file, st, onEnter, onLeave, onClose }: { doc: TraceDoc; file: number; st: PopState; onEnter(): void; onLeave(): void; onClose(): void }) {
  const root = usePopover(st.anchor, onClose, [st.key])
  const { pop } = st
  const box = pop.box
  const fr = box.step.type === 'frame' ? box.step.frame : null
  const t = box.turn
  const turns = fr ? fr.turns : [t]
  const lr = (line: number) => <LineRef line={line} file={file} />
  let title: ReactNode = null
  let body: ReactNode = null
  switch (pop.kind) {
    case 'call': {
      if (fr) {
        const last = fr.turns[fr.turns.length - 1]
        title = <>loop × {fmtInt(fr.n)} · {callLabel(t)} to {callLabel(last)}</>
        body = <>
          <Facts rows={[
            ['rows each', fmtInt(fr.rows)], ['rows in all', fmtInt(fr.rows * fr.n)],
            ['server (elapsed)', fmtDur(fr.serverUs)], ['CPU', fmtDur(fr.cpuUs)],
            ['median elapsed', fmtDur(fr.medianEla)], ['client gaps', fmtDur(fr.gapUs)], ['median gap', fmtDur(fr.medianGap)],
            ['disk reads (p)', fmtInt(sum(turns, (x) => x.call.p))], ['query (cr)', fmtInt(sum(turns, (x) => x.call.cr))], ['current (cu)', fmtInt(sum(turns, (x) => x.call.cu))],
          ]} />
          <p className="small">First {lr(t.call.line)}, last {lr(last.call.line)}. Turns more than 10× the run's median elapsed or gap are drawn apart, outside the loop.</p>
        </>
      } else {
        const inCall = sum(Object.values(t.sides).flat() as Traffic[], (x) => x.us) + (t.net.toClient?.us ?? 0) + (t.net.moreData?.us ?? 0)
        title = <>{callLabel(t)} {lr(t.call.line)}</>
        body = <>
          <Facts rows={[
            ['elapsed', fmtDur(t.ela)], ['CPU', fmtDur(t.cpu)], ['rows', fmtInt(t.rows)], ['in-call waits', fmtDur(inCall)],
            ['disk reads (p)', fmtInt(t.call.p)], ['query (cr)', fmtInt(t.call.cr)], ['current (cu)', fmtInt(t.call.cu)],
            ['recursive calls', t.recursive.n ? `${fmtInt(t.recursive.n)} · ${fmtDur(t.recursive.us)}` : 'none'],
            ['gap before', fmtDur(t.gapBefore)], ['round trip', fmtInt(t.trip + 1)],
          ]} />
          {t.outlier && t.runMedian && <p className="small">Kept out of its loop: {t.outlier === 'ela' ? `elapsed ${fmtDur(t.ela)} against the run's median ${fmtDur(t.runMedian.ela)}` : `gap before ${fmtDur(t.gapBefore)} against the run's median ${fmtDur(t.runMedian.gap)}`}.</p>}
          <p className="small muted">Counters as recorded: inclusive of the recursive calls inside the call.</p>
        </>
      }
      break
    }
    case 'side': {
      const lane = pop.row.line
      title = <>{lane === 'disk' ? 'Disk' : lane === 'temp' ? 'TEMP' : 'Others'} · in {fr ? `the loop's ${fmtInt(fr.n)} calls` : callLabel(t)}</>
      body = <TrafficTable doc={doc} ts={pop.row.traffic} lr={lr} lane={lane} />
      break
    }
    case 'gap': {
      const ws = fr ? fr.gapWaits : t.gapWaits
      const nonIdle = ws.filter((w) => !doc.events[w.event]?.idle)
      title = <>client gap {fr ? `· median ${fmtDur(fr.medianGap)}, ${fmtDur(fr.gapUs)} in all` : `· ${fmtDur(t.gapBefore)} before ${callLabel(t)}`}</>
      body = <>
        <TrafficTable doc={doc} ts={ws} lr={lr} />
        <p className="small muted">WAIT lines outside the call's own time window: the server between calls, mostly waiting for the client.</p>
        {nonIdle.length > 0 && <p className="small">{nonIdle.map((w) => evName(doc, w.event)).join(', ')}: {nonIdle.length === 1 ? 'a wait of class' : 'waits of class'} {[...new Set(nonIdle.map((w) => doc.events[w.event]?.class))].join(', ')}, not idle, yet logged between the calls: counted in the gap, not in a call.</p>}
      </>
      break
    }
    case 'rec': {
      const r = fr ? fr.recursive : t.recursive
      title = <>recursive SQL · {fmtInt(r.n)} calls · {fmtDur(r.us)}</>
      body = <>
        <div className="tbl-wrap"><table className="tbl dlg-tbl">
          <thead><tr><th>statement</th><th>call</th><th className="num">×</th><th className="num">total</th><th className="num">median</th><th>outliers (above 10× the median)</th></tr></thead>
          <tbody>{r.groups.slice(0, 12).map((g) => (
            <tr key={`${g.stmt}:${g.kind}`}>
              <td><StmtLink doc={doc} id={g.stmt} /></td><td>{kindOf(g.kind)}</td><td className="num">{fmtInt(g.n)}</td><td className="num">{fmtDur(g.us)}</td><td className="num">{fmtDur(g.medianEla)}</td>
              <td>{g.outliers.length === 0 ? <span className="dim">none</span> : g.outliers.slice(0, 3).map((c: TraceCall, i) => <span key={c.id}>{i ? ', ' : ''}{fmtDur(c.e)} at {lr(c.line)}</span>)}{g.outliers.length > 3 && ` +${g.outliers.length - 3}`}</td>
            </tr>
          ))}</tbody>
        </table></div>
        {r.groups.length > 12 && <p className="small muted">{r.groups.length - 12} more statement and call kinds.</p>}
        <p className="small muted">Calls one level down (dep + 1); their own recursive calls and their waits are inside them. The waits of all of them are drawn with the call's side arrows.</p>
      </>
      break
    }
    case 'ret': {
      const net = fr ? fr.net : t.net
      title = <>reply · {rowsLabel(t.kind, fr ? fr.rows : t.rows, !!fr) || `after ${callLabel(t)}`}</>
      const ts = [net.toClient, net.moreData].filter((x): x is Traffic => !!x)
      body = ts.length ? <TrafficTable doc={doc} ts={ts} lr={lr} /> : <p className="small muted">No SQL*Net waits to the client recorded in {fr ? 'these calls' : 'this call'}.</p>
      break
    }
  }
  return createPortal(
    <div className="dlg-pop" ref={root} role="dialog" aria-label="Dialogue detail" onMouseEnter={onEnter} onMouseLeave={onLeave} onKeyDown={(e) => e.stopPropagation()}>
      <div className="dlg-pop-h">
        <b>{title}</b>
        <button type="button" className="quiet dlg-pop-x" data-first={st.pinned || undefined} onClick={onClose} aria-label="Close" title="close (Esc)">×</button>
      </div>
      {body}
    </div>,
    document.body,
  )
}

const sum = <T,>(xs: T[], f: (x: T) => number) => xs.reduce((a, x) => a + f(x), 0)

function Facts({ rows }: { rows: [string, string][] }) {
  return <dl className="dlg-facts-grid">{rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
}

/** The waits of a mark by event; `lane`: a side arrow's, so the swatches take the arrows' colours (else the wait classes'). */
function TrafficTable({ doc, ts, lr, lane }: { doc: TraceDoc; ts: Traffic[]; lr: (line: number) => ReactNode; lane?: SideLine }) {
  if (ts.length === 0) return <p className="small muted">No WAIT lines.</p>
  return (
    <div className="tbl-wrap"><table className="tbl dlg-tbl">
      <thead><tr><th>event</th><th>class</th><th className="num">×</th><th className="num">total</th><th className="num">mean</th><th className="num">first</th></tr></thead>
      <tbody>{ts.map((x) => {
        const ev = doc.events[x.event]
        const role: Role = ev ? roleOfClass(ev.class, ev.idle) : 'other'
        return (
          <tr key={x.event}>
            <td><i className="swatch" style={{ background: lane ? eventColor(doc, x.event, lane) : `var(--c-${role})` }} /> {evName(doc, x.event)}</td><td className="dim">{ev?.class ?? '?'}</td>
            <td className="num">{fmtInt(x.n)}</td><td className="num">{fmtDur(x.us)}</td><td className="num">{fmtDur(x.us / Math.max(1, x.n))}</td><td className="num">{lr(x.line)}</td>
          </tr>
        )
      })}</tbody>
    </table></div>
  )
}
