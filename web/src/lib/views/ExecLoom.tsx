import { useMemo, useState } from 'react'
import type { EChartsOption } from 'echarts'
import type { TraceDoc } from '../data/doc'
import type { Execution } from '../data/derive'
import type { ExecTrace, TraceWait } from '../data/exectrace'
import { sourceOf, useSourceQuery } from '../data/source'
import { buildLoom, objectCurve, objectWait, type Loom, type LoomObject, type PhaseSide } from '../data/loom'
import { callKindName } from '../data/types'
import { fmtDur, fmtInt } from '../data/format'
import { fmtDurDelta, worse } from '../data/delta'
import { Chart } from '../components/Chart'
import { chromeColors, resolveVar, roleOfClass } from '../components/colors'
import { LineRef } from '../components/LineRef'
import '../styles/loom.css'

// Execution Loom (docs/implementing-new-ideas.md): the two executions of the A/B comparison as threads over the same work
// checkpoints, the waits of each phase by object and event, and the call-level consistent / current gets.

const FIXED: Record<string, string> = {
  'db file sequential read': '--ev-seq',
  'db file scattered read': '--ev-scat',
  'db file parallel read': '--ev-par',
  'direct path read': '--ev-direct',
  'direct path read temp': '--ev-temp',
  'direct path write temp': '--ev-temp-w',
}

/** Stable colour of an event for the whole document: the read families get their own hue, other events a shade of their class. */
function eventColors(doc: TraceDoc): (id: number) => string {
  const memo = new Map<number, string>()
  const rank = new Map<string, number>()
  for (const e of doc.events) {
    if (FIXED[e.name]) { memo.set(e.id, `var(${FIXED[e.name]})`); continue }
    const role = roleOfClass(e.class, e.idle)
    // the read families take the full hues; other events of a class are lighter shades of it, in event-id order
    const k = rank.get(role) ?? 0
    rank.set(role, k + 1)
    memo.set(e.id, `color-mix(in oklch, var(--c-${role}) ${role === 'userio' ? 70 - 18 * (k % 3) : 100 - 18 * (k % 4)}%, var(--surface-raised))`)
  }
  return (id) => memo.get(id) ?? 'var(--c-other)'
}

const objLabel = (doc: TraceDoc, obj: number) => (obj < 0 ? 'no object recorded' : doc.objectName(obj) ?? `obj#${obj}`)
const pct = (x: number, t: number) => (t ? `${((100 * x) / t).toFixed(x && (100 * x) / t < 1 ? 2 : 1)}%` : '–')

type Side = 'a' | 'b'

export function ExecLoom({ doc, stmt, a, b }: { doc: TraceDoc; stmt: number; a: Execution; b: Execution }) {
  const source = sourceOf(doc)
  const qa = useSourceQuery(source, `loom:${stmt}:${a.cursor}:${a.execNo}`, (signal) => source.executionTrace(stmt, a, signal))
  const qb = useSourceQuery(source, `loom:${stmt}:${b.cursor}:${b.execNo}`, (signal) => source.executionTrace(stmt, b, signal))
  if (qa.error || qb.error) return <p className="small muted">Loom: {qa.error || qb.error}</p>
  if (qa.data === undefined || qb.data === undefined) return <p className="small muted">Loom: loading…</p>
  if (qa.data === null || qb.data === null) {
    return (
      <p className="small muted loom-na" role="status">
        {source.remote
          ? 'The Loom needs the engine route api/executions/trace, which this engine does not serve: update mtkprof.'
          : 'The Loom needs the calls and waits of the trace, which this report does not carry (written with -aggregate, or exported without facts).'}
      </p>
    )
  }
  return <LoomView doc={doc} a={a} b={b} ta={qa.data} tb={qb.data} />
}

function LoomView({ doc, a, b, ta, tb }: { doc: TraceDoc; a: Execution; b: Execution; ta: ExecTrace; tb: ExecTrace }) {
  const [baseB, setBaseB] = useState(false)
  const [includeParse, setIncludeParse] = useState(false)
  const [phase, setPhase] = useState<number | null>(null)
  const [objScope, setObjScope] = useState<'phase' | 'all'>('phase')
  const [obj, setObj] = useState<number | null>(null)
  const [hot, setHot] = useState<number | null>(null)
  const color = useMemo(() => eventColors(doc), [doc])

  const [xa, xb] = baseB ? [b, a] : [a, b]
  const loom = useMemo(() => (baseB ? buildLoom(tb, ta, { includeParse }) : buildLoom(ta, tb, { includeParse })), [ta, tb, baseB, includeParse])
  const la = baseB ? 'B' : 'A', lb = baseB ? 'A' : 'B'

  // default phase: where the most time was added
  const sel = useMemo(() => {
    if (phase !== null && phase < loom.phases.length) return phase
    let best = 0, bestV = -1
    loom.phases.forEach((p, k) => { const v = Math.abs(p.addedUs ?? 0); if (v > bestV) { bestV = v; best = k } })
    return best
  }, [phase, loom])
  const selPhase = loom.phases[sel]

  return (
    <div className="loom">
      <div className="loom-bar">
        <span className="loom-ctl" role="group" aria-label="Baseline">
          <span className="dim">Baseline</span>
          <span className="seg">
            <button type="button" aria-pressed={!baseB} onClick={() => setBaseB(false)}>A · #{a.execNo}</button>
            <button type="button" aria-pressed={baseB} onClick={() => setBaseB(true)}>B · #{b.execNo}</button>
          </span>
        </span>
        <label className="loom-ctl"><input type="checkbox" checked={includeParse} onChange={(e) => setIncludeParse(e.target.checked)} /> include PARSE</label>
        <span className="small muted">
          Basis: recorded elapsed of the execution's own {includeParse ? 'PARSE, ' : ''}EXEC and FETCH calls, recursive calls inside them (not added again).
          CLOSE, client time and between-call waits are left out. Whole execution: the file / time scope does not apply.
        </span>
      </div>

      {loom.shape.length > 0 && <ul className="loom-notes" role="status">{loom.shape.map((s) => <li key={s}>{s}</li>)}</ul>}

      <LoomChart loom={loom} sel={sel} la={la} lb={lb} xa={xa} xb={xb} onPick={setPhase} />

      <div className="loom-phases" role="toolbar" aria-label="Phase">
        {loom.phases.map((p, k) => (
          <button key={p.key} type="button" aria-pressed={k === sel} onClick={() => setPhase(k)}>
            <span>{p.label}</span>
            <span className={'delta ' + worse(p.addedUs ?? 0)}>{p.addedUs === null ? 'unmatched' : fmtDurDelta(p.addedUs)}</span>
          </button>
        ))}
      </div>

      <PhaseTable loom={loom} sel={sel} la={la} lb={lb} onPick={setPhase} />

      <h3>Waits by object · {objScope === 'phase' ? selPhase?.label : 'whole execution'}</h3>
      <div className="loom-bar">
        <span className="seg" role="group" aria-label="Object scope">
          <button type="button" aria-pressed={objScope === 'phase'} onClick={() => setObjScope('phase')}>selected phase</button>
          <button type="button" aria-pressed={objScope === 'all'} onClick={() => setObjScope('all')}>whole execution</button>
        </span>
        <span className="small muted">In-call waits of the call and its recursive calls, by the obj# on the WAIT line. Bars are grouped by event, not in time order.</span>
      </div>
      <EventLegend doc={doc} loom={loom} color={color} hot={hot} onHot={setHot} />
      <ObjectTable doc={doc} loom={loom} k={objScope === 'phase' ? sel : null} la={la} lb={lb} color={color} hot={hot} obj={obj} onObj={setObj} />

      <h3>Consistent and current gets</h3>
      <p className="small muted">Counts of the whole call (cr = consistent gets, cu = current gets), not of single waits or objects; physical reads (p) are a separate count. Current is an access mode, not a dirty read.</p>
      <ReadModes loom={loom} la={la} lb={lb} sel={sel} />

      <h3>Wait records · {selPhase?.label}{obj !== null ? ` · ${objLabel(doc, obj)}` : ''}</h3>
      <Evidence doc={doc} loom={loom} k={sel} obj={obj} la={la} lb={lb} color={color} fileA={doc.fileOfCursor(xa.cursor)} fileB={doc.fileOfCursor(xb.cursor)} />
    </div>
  )
}

function LoomChart({ loom, sel, la, lb, xa, xb, onPick }: { loom: Loom; sel: number; la: string; lb: string; xa: Execution; xb: Execution; onPick: (k: number) => void }) {
  const option = useMemo((): EChartsOption => {
    const c = chromeColors()
    const wash = resolveVar('--wash-strong')
    const xs = ['Start', ...loom.phases.map((p) => p.label)]
    const val = (v: number | null) => (v === null ? '-' : v)
    const delta = (k: number) => { const x = loom.cumA[k], y = loom.cumB[k]; return x === null || y === null ? null : y - x }
    return {
      grid: { left: 8, right: 96, top: 40, bottom: 24, containLabel: true },
      legend: { data: [`${la} · #${xa.execNo} (baseline)`, `${lb} · #${xb.execNo}`], left: 'auto', right: 0 },
      tooltip: {
        trigger: 'axis',
        formatter: (ps: unknown) => {
          const k = (ps as { dataIndex: number }[])[0]?.dataIndex ?? 0
          const ph = loom.phases[k - 1]
          const row = (l: string, cum: number | null, s?: PhaseSide) => `${l}: ${cum === null ? 'absent' : fmtDur(cum)}${s ? ` (phase ${fmtDur(s.e)})` : ''}`
          const d = delta(k)
          return [`<b>${xs[k]}</b>`, row(la, loom.cumA[k], ph?.a), row(lb, loom.cumB[k], ph?.b), d === null ? '' : `${lb} − ${la}: ${fmtDurDelta(d)}`].filter(Boolean).join('<br>')
        },
      },
      xAxis: { type: 'category', data: xs, boundaryGap: false },
      yAxis: { type: 'value', name: 'Cumulative call elapsed', nameGap: 14, nameTextStyle: { color: c.ink2, align: 'left' }, axisLabel: { formatter: (v: number) => fmtDur(v) } },
      series: [
        {
          name: `${la} · #${xa.execNo} (baseline)`, type: 'line', data: loom.cumA.map(val), connectNulls: true, symbolSize: 7,
          lineStyle: { color: c.ink, width: 2 }, itemStyle: { color: c.ink },
          endLabel: { show: true, color: c.ink, formatter: () => `${la} ${fmtDur(loom.totalA)}` },
          markArea: sel < loom.phases.length ? { silent: true, itemStyle: { color: wash }, data: [[{ xAxis: xs[sel] }, { xAxis: xs[sel + 1] }]] } : undefined,
        },
        {
          name: `${lb} · #${xb.execNo}`, type: 'line', data: loom.cumB.map(val), connectNulls: true, symbolSize: 7, symbol: 'emptyCircle',
          lineStyle: { color: c.ink2, width: 2, type: 'dashed' }, itemStyle: { color: c.ink2 },
          endLabel: { show: true, color: c.ink2, formatter: () => `${lb} ${fmtDur(loom.totalB)}` },
        },
      ],
    }
  }, [loom, sel, la, lb, xa, xb])
  const onEvents = useMemo(() => ({ click: (p: unknown) => { const k = (p as { dataIndex?: number }).dataIndex; if (k) onPick(k - 1) } }), [onPick])
  return <Chart option={option} onEvents={onEvents} className="loom-chart" />
}

function PhaseTable({ loom, sel, la, lb, onPick }: { loom: Loom; sel: number; la: string; lb: string; onPick: (k: number) => void }) {
  const cell = (s: PhaseSide | undefined, f: (s: PhaseSide) => React.ReactNode) => <td className="num">{s ? f(s) : <span className="dim">absent</span>}</td>
  const resid = (s: PhaseSide) => <span className={s.residual < 0 ? 'delta up' : undefined} title={s.residual < 0 ? 'CPU + waits exceed elapsed: the counters do not reconcile' : 'elapsed − CPU − in-call waits (not measured)'}>{fmtDur(s.residual)}</span>
  return (
    <div className="tbl-wrap"><table className="tbl loom-tbl">
      <thead>
        <tr><th>phase</th><th className="num">rows {la}/{lb}</th><th className="num">elapsed {la}</th><th className="num">elapsed {lb}</th><th className="num">added</th><th className="num">cumulative Δ</th>
          <th className="num">CPU {la}/{lb}</th><th className="num">waits {la}</th><th className="num">waits {lb}</th><th className="num">rest {la}/{lb}</th></tr>
      </thead>
      <tbody>{loom.phases.map((p, k) => {
        const ca = loom.cumA[k + 1], cb = loom.cumB[k + 1]
        return (
          <tr key={p.key} className={k === sel ? 'sel' : undefined} onClick={() => onPick(k)}>
            <td><button type="button" className="link" onClick={(e) => { e.stopPropagation(); onPick(k) }}>{p.label}</button>{p.rowsDiffer && <span className="dim" title="the calls returned different row counts"> rows differ</span>}</td>
            <td className="num">{p.a ? fmtInt(p.a.r) : '–'} / {p.b ? fmtInt(p.b.r) : '–'}</td>
            {cell(p.a, (s) => fmtDur(s.e))}
            {cell(p.b, (s) => fmtDur(s.e))}
            <td className="num">{p.addedUs === null ? <span className="dim">unmatched</span> : <span className={'delta ' + worse(p.addedUs)}>{fmtDurDelta(p.addedUs)}</span>}</td>
            <td className="num">{ca === null || cb === null ? '–' : <span className={'delta ' + worse(cb - ca)}>{fmtDurDelta(cb - ca)}</span>}</td>
            <td className="num">{p.a ? fmtDur(p.a.c) : '–'} / {p.b ? fmtDur(p.b.c) : '–'}</td>
            {cell(p.a, (s) => <>{fmtDur(s.waitUs)} <small className="dim">×{fmtInt(s.waitCount)}</small></>)}
            {cell(p.b, (s) => <>{fmtDur(s.waitUs)} <small className="dim">×{fmtInt(s.waitCount)}</small></>)}
            <td className="num">{p.a ? resid(p.a) : '–'} / {p.b ? resid(p.b) : '–'}</td>
          </tr>
        )
      })}</tbody>
    </table></div>
  )
}

function EventLegend({ doc, loom, color, hot, onHot }: { doc: TraceDoc; loom: Loom; color: (id: number) => string; hot: number | null; onHot: (e: number | null) => void }) {
  if (loom.events.length === 0) return <p className="small muted">No in-call waits recorded in either execution.</p>
  return (
    <div className="loom-legend" role="group" aria-label="Highlight an event">
      {loom.events.map((e) => (
        <button key={e.event} type="button" aria-pressed={hot === e.event} onClick={() => onHot(hot === e.event ? null : e.event)}>
          <i className="swatch" style={{ background: color(e.event) }} />{doc.events[e.event]?.name ?? `event ${e.event}`}
        </button>
      ))}
    </div>
  )
}

function EventBar({ ev, scale, color, hot, order }: { ev: Map<number, { us: number }>; scale: number; color: (id: number) => string; hot: number | null; order: number[] }) {
  return (
    <span className="loom-evbar">
      {order.map((id) => {
        const g = ev.get(id)
        if (!g || !g.us) return null
        return <i key={id} style={{ inlineSize: `${(100 * g.us) / scale}%`, background: color(id), opacity: hot === null || hot === id ? 1 : 0.22 }} title={`${fmtDur(g.us)}`} />
      })}
    </span>
  )
}

function Spark({ ca, cb, max }: { ca: (number | null)[]; cb: (number | null)[]; max: number }) {
  const w = 120, h = 26, n = Math.max(1, ca.length - 1)
  const pts = (c: (number | null)[]) => c.map((v, i) => (v === null ? null : `${((i / n) * w).toFixed(1)},${(h - 2 - ((h - 4) * v) / (max || 1)).toFixed(1)}`)).filter(Boolean).join(' ')
  return (
    <svg className="loom-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-hidden="true">
      <polyline points={pts(ca)} fill="none" stroke="var(--ink)" strokeWidth="1.5" />
      <polyline points={pts(cb)} fill="none" stroke="var(--ink-2)" strokeWidth="1.5" strokeDasharray="3 2" />
    </svg>
  )
}

function ObjectTable({ doc, loom, k, la, lb, color, hot, obj, onObj }: {
  doc: TraceDoc; loom: Loom; k: number | null; la: string; lb: string; color: (id: number) => string; hot: number | null; obj: number | null; onObj: (o: number | null) => void
}) {
  const rows = useMemo(() => loom.objects
    .map((o) => ({ o, a: objectWait(o, 'a', k), b: objectWait(o, 'b', k) }))
    .filter((r) => r.a.count + r.b.count > 0)
    .sort((x, y) => Math.abs(y.b.us - y.a.us) - Math.abs(x.b.us - x.a.us) || y.a.us + y.b.us - x.a.us - x.b.us || x.o.obj - y.o.obj), [loom, k])
  const scale = Math.max(1, ...rows.map((r) => Math.max(r.a.us, r.b.us)))
  const curves = useMemo(() => new Map(loom.objects.map((o) => [o.obj, [objectCurve(o, loom, 'a'), objectCurve(o, loom, 'b')] as const])), [loom])
  const sparkMax = Math.max(1, ...loom.objects.map((o) => Math.max(o.totalA, o.totalB)))
  const order = loom.events.map((e) => e.event)
  const merged = (o: LoomObject, side: Side) => {
    const out = new Map<number, { us: number }>()
    for (const m of k === null ? o[side] : [o[side][k]]) for (const [id, g] of m) out.set(id, { us: (out.get(id)?.us ?? 0) + g.us })
    return out
  }
  if (rows.length === 0) return <p className="small muted">No in-call waits in this {k === null ? 'execution' : 'phase'}.</p>
  return (
    <div className="tbl-wrap"><table className="tbl loom-tbl">
      <thead><tr><th>object</th><th className="num">{la}</th><th className="num">{lb}</th><th className="num">{lb} − {la}</th><th className="loom-barcol">by event ({la} over {lb}, one scale)</th><th>cumulative ({la} solid, {lb} dashed)</th></tr></thead>
      <tbody>{rows.map(({ o, a, b }) => {
        const [ca, cb] = curves.get(o.obj)!
        const on = obj === o.obj
        return (
          <tr key={o.obj} className={on ? 'sel' : undefined}>
            <td className="loom-obj">
              <button type="button" className="link" aria-pressed={on} onClick={() => onObj(on ? null : o.obj)} title={o.obj >= 0 ? `obj# ${o.obj}` : 'WAIT lines with obj#=-1 (no segment recorded)'}>{objLabel(doc, o.obj)}</button>
              {o.obj >= 0 && doc.objectName(o.obj) && <span className="dim"> #{o.obj}</span>}
            </td>
            <td className="num">{a.count ? <>{fmtDur(a.us)} <small className="dim">×{fmtInt(a.count)}</small></> : <span className="dim" title="no recorded attributed waits (not: not accessed)">none</span>}</td>
            <td className="num">{b.count ? <>{fmtDur(b.us)} <small className="dim">×{fmtInt(b.count)}</small></> : <span className="dim" title="no recorded attributed waits (not: not accessed)">none</span>}</td>
            <td className="num"><span className={'delta ' + worse(b.us - a.us)}>{fmtDurDelta(b.us - a.us)}</span></td>
            <td className="loom-barcol">
              <EventBar ev={merged(o, 'a')} scale={scale} color={color} hot={hot} order={order} />
              <EventBar ev={merged(o, 'b')} scale={scale} color={color} hot={hot} order={order} />
            </td>
            <td><Spark ca={ca} cb={cb} max={sparkMax} /></td>
          </tr>
        )
      })}</tbody>
    </table></div>
  )
}

function ModeBar({ s }: { s: PhaseSide | undefined }) {
  if (!s) return <><span className="loom-mode empty" /><span className="dim small">absent</span></>
  const t = s.cr + s.cu
  if (t === 0) return <><span className="loom-mode empty" /><span className="small">No logical gets{s.p ? ` · p ${fmtInt(s.p)}` : ''}</span></>
  return (
    <>
      <span className="loom-mode" role="img" aria-label={`consistent ${pct(s.cr, t)}, current ${pct(s.cu, t)}`}>
        <i className="cr" style={{ inlineSize: `${(100 * s.cr) / t}%` }} /><i className="cu" style={{ inlineSize: `${(100 * s.cu) / t}%` }} />
      </span>
      <span className="small num">cr {fmtInt(s.cr)} ({pct(s.cr, t)}) · cu {fmtInt(s.cu)} ({pct(s.cu, t)}) · p {fmtInt(s.p)}</span>
    </>
  )
}

function ReadModes({ loom, la, lb, sel }: { loom: Loom; la: string; lb: string; sel: number }) {
  return (
    <div className="loom-modes">
      <div className="loom-modes-key small"><span><i className="loom-key cr" /> consistent (cr)</span><span><i className="loom-key cu" /> current (cu)</span></div>
      {loom.phases.map((p, k) => (
        <div key={p.key} className={'loom-mode-row' + (k === sel ? ' sel' : '')}>
          <span className="loom-mode-ph">{p.label}</span>
          <span className="side-tag">{la}</span><ModeBar s={p.a} />
          <span className="side-tag">{lb}</span><ModeBar s={p.b} />
        </div>
      ))}
    </div>
  )
}

const MAX_ROWS = 300

function Evidence({ doc, loom, k, obj, la, lb, color, fileA, fileB }: {
  doc: TraceDoc; loom: Loom; k: number; obj: number | null; la: string; lb: string; color: (id: number) => string; fileA: number; fileB: number
}) {
  const p = loom.phases[k]
  if (!p) return null
  const pick = (s: PhaseSide | undefined) => (s ? s.waits.filter((w) => obj === null || (w.obj >= 0 ? w.obj : -1) === obj) : [])
  const rows: { side: string; w: TraceWait; file: number; own: number }[] = [
    ...pick(p.a).map((w) => ({ side: la, w, file: fileA, own: p.a!.call.id })),
    ...pick(p.b).map((w) => ({ side: lb, w, file: fileB, own: p.b!.call.id })),
  ]
  const callLine = (s: PhaseSide | undefined, side: string, file: number) => s && <span>{side}: {callKindName[s.call.kind]} at <LineRef line={s.call.line} file={file} />{s.children ? `, ${fmtInt(s.children)} recursive calls` : ''}</span>
  return (
    <>
      <p className="small loom-calls">{callLine(p.a, la, fileA)} {callLine(p.b, lb, fileB)}</p>
      {rows.length === 0 ? <p className="small muted">No in-call waits{obj !== null ? ' for this object' : ''} in this phase.</p> : (
        <div className="tbl-wrap"><table className="tbl loom-tbl">
          <thead><tr><th></th><th className="num">line</th><th>event</th><th className="num">ela</th><th>object</th><th className="num">p1</th><th className="num">p2</th><th className="num">p3</th><th>call</th></tr></thead>
          <tbody>{rows.slice(0, MAX_ROWS).map(({ side, w, file, own }) => {
            const ev = doc.events[w.event]
            return (
              <tr key={side + w.id}>
                <td><span className="side-tag">{side}</span></td>
                <td className="num"><LineRef line={w.line} file={file} bare /></td>
                <td><i className="swatch" style={{ background: color(w.event) }} /> {ev?.name ?? `event ${w.event}`}</td>
                <td className="num">{fmtDur(w.ela)}</td>
                <td>{objLabel(doc, w.obj)}</td>
                <td className="num" title={ev?.p1Name}>{w.p1}</td><td className="num" title={ev?.p2Name}>{w.p2}</td><td className="num" title={ev?.p3Name}>{w.p3}</td>
                <td className="dim">{w.call === own ? 'own call' : `recursive (dep ${w.dep})`}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
      )}
      {rows.length > MAX_ROWS && <p className="small muted">First {MAX_ROWS} of {fmtInt(rows.length)} wait records.</p>}
    </>
  )
}
