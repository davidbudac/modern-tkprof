import { useMemo } from 'react'
import type { TraceDoc } from '../data/doc'
import { NONE } from '../data/types'
import { fmtDur, fmtInt, fmtCompact } from '../data/format'
import { fmtDurDelta, fmtIntDelta, worse } from '../data/delta'
import type { BindRow, Execution } from '../data/derive'
import { LineRef } from '../components/LineRef'
import '../styles/compare.css'

import { sourceOf, useSourceQuery, type CallPart, type ExecDetail } from '../data/source'

type Part = CallPart

interface Facts {
  ex: Execution
  parse: Part
  exec: Part
  fetch: Part
  total: Part
  /** event id → count, µs over the waits attached to the parse, exec and fetch calls */
  waits: Map<number, { count: number; us: number }>
  binds: BindRow[]
  plh: number
}

function factsFrom(ex: Execution, d: ExecDetail): Facts {
  return { ex, parse: d.parse, exec: d.exec, fetch: d.fetch, total: d.total, waits: new Map(d.waits.map((w) => [w.event, { count: w.count, us: w.us }])), binds: d.binds, plh: d.plh }
}

const bindText = (b: BindRow | undefined): string => (!b ? '' : b.noDef ? '(same as an earlier bind)' : b.isNull ? 'NULL' : b.dump ? '(memory dump)' : b.value)
const bindKey = (b: BindRow | undefined): string => (!b ? 'absent' : b.noDef ? 'nodef' : b.isNull ? 'null' : (b.dump ? 'dump:' : 'val:') + b.value)

/** Two executions of one statement side by side: call statistics, waits by event, binds, plan hash. */
export function ExecCompare({ doc, stmt, a, b, onClear }: { doc: TraceDoc; stmt: number; a: Execution; b: Execution; onClear: () => void }) {
  const source = sourceOf(doc)
  const qa = useSourceQuery(source, `cmp:${stmt}:${a.cursor}:${a.execNo}`, (signal) => source.executionDetail(stmt, a, signal))
  const qb = useSourceQuery(source, `cmp:${stmt}:${b.cursor}:${b.execNo}`, (signal) => source.executionDetail(stmt, b, signal))
  const fa = useMemo(() => (qa.data ? factsFrom(a, qa.data) : null), [a, qa.data])
  const fb = useMemo(() => (qb.data ? factsFrom(b, qb.data) : null), [b, qb.data])
  if (!fa || !fb) {
    return (
      <section className="section exec-cmp" aria-label="Execution A vs B">
        <header><h2>Execution A vs B</h2><span className="hint">{qa.error || qb.error || 'loading…'}</span><span className="tools"><button onClick={onClear}>Clear</button></span></header>
      </section>
    )
  }
  return <ExecCompareView doc={doc} a={a} b={b} fa={fa} fb={fb} onClear={onClear} />
}

function ExecCompareView({ doc, a, b, fa, fb, onClear }: { doc: TraceDoc; a: Execution; b: Execution; fa: Facts; fb: Facts; onClear: () => void }) {
  const all: { name: string; get: (f: Facts) => Part }[] = [
    { name: 'Parse', get: (f) => f.parse }, { name: 'Execute', get: (f) => f.exec }, { name: 'Fetch', get: (f) => f.fetch }, { name: 'Total', get: (f) => f.total },
  ]
  const kinds = all.filter((k) => k.name === 'Total' || k.get(fa).calls + k.get(fb).calls > 0)

  const events = useMemo(() => {
    const ids = new Set([...fa.waits.keys(), ...fb.waits.keys()])
    return [...ids].map((id) => ({ id, a: fa.waits.get(id), b: fb.waits.get(id) }))
      .sort((x, y) => Math.abs((y.b?.us ?? 0) - (y.a?.us ?? 0)) - Math.abs((x.b?.us ?? 0) - (x.a?.us ?? 0)) || (y.a?.us ?? 0) + (y.b?.us ?? 0) - (x.a?.us ?? 0) - (x.b?.us ?? 0))
  }, [fa, fb])

  const positions = useMemo(() => [...new Set([...fa.binds.map((x) => x.pos), ...fb.binds.map((x) => x.pos)])].sort((x, y) => x - y), [fa, fb])
  const differing = positions.filter((p) => bindKey(fa.binds.find((x) => x.pos === p)) !== bindKey(fb.binds.find((x) => x.pos === p))).length
  const samePlan = fa.plh === fb.plh
  const tag = (f: Facts, k: 'A' | 'B') => <>{k} · #{f.ex.execNo}</>

  return (
    <section className="section exec-cmp" aria-label="Execution A vs B">
      <header>
        <h2>Execution A vs B</h2>
        <span className="hint">
          <b className="side-tag">A</b> #{a.execNo} at <LineRef line={a.line} /> · <b className="side-tag">B</b> #{b.execNo} at <LineRef line={b.line} />
        </span>
        <span className="tools"><button onClick={onClear}>Clear</button></span>
      </header>

      <div className="exec-cmp-sum">
        <span>elapsed <b>{fmtDur(a.e)}</b> → <b>{fmtDur(b.e)}</b> <span className={'delta ' + worse(b.e - a.e)}>{fmtDurDelta(b.e - a.e)}</span></span>
        <span>plan {fa.plh || fb.plh ? <><b className="mono">{fa.plh || '–'}</b> {samePlan ? '= same' : <>→ <b className="mono delta up">{fb.plh || '–'}</b> changed</>}</> : 'hash not in the trace'}</span>
        <span>{positions.length === 0 ? 'no bind values' : differing === 0 ? 'identical binds' : `${differing} of ${positions.length} binds differ`}</span>
      </div>

      <div className="tbl-wrap"><table className="tbl">
        <thead><tr><th>call</th><th></th><th className="num">calls</th><th className="num">cpu</th><th className="num">elapsed</th><th className="num">disk</th><th className="num">query</th><th className="num">current</th><th className="num">rows</th></tr></thead>
        <tbody>
          {kinds.flatMap((k) => {
            const pa = k.get(fa), pb = k.get(fb)
            const tot = k.name === 'Total'
            const row = (side: 'A' | 'B', p: Part, f: Facts) => (
              <tr key={k.name + side} className={tot ? 'tot' : undefined}>
                <td>{side === 'A' ? k.name : ''}</td><td>{tag(f, side)}</td>
                <td className="num">{fmtInt(p.calls)}</td><td className="num">{fmtDur(p.c)}</td><td className="num">{fmtDur(p.e)}</td>
                <td className="num">{fmtCompact(p.p)}</td><td className="num">{fmtCompact(p.cr)}</td><td className="num">{fmtCompact(p.cu)}</td><td className="num">{fmtCompact(p.r)}</td>
              </tr>
            )
            const d = (v: number, time: boolean) => <span className={'delta ' + worse(v)}>{time ? fmtDurDelta(v) : fmtIntDelta(v)}</span>
            return [
              row('A', pa, fa), row('B', pb, fb),
              <tr key={k.name + 'd'} className="dlt">
                <td></td><td className="dim">B − A</td>
                <td className="num">{d(pb.calls - pa.calls, false)}</td><td className="num">{d(pb.c - pa.c, true)}</td><td className="num">{d(pb.e - pa.e, true)}</td>
                <td className="num">{d(pb.p - pa.p, false)}</td><td className="num">{d(pb.cr - pa.cr, false)}</td><td className="num">{d(pb.cu - pa.cu, false)}</td><td className="num">{d(pb.r - pa.r, false)}</td>
              </tr>,
            ]
          })}
        </tbody>
      </table></div>

      <h3>Waits by event</h3>
      {events.length === 0 ? <p className="small muted">No waits were attached to these executions.</p> : (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th>event</th><th className="num">A waits</th><th className="num">A time</th><th className="num">B waits</th><th className="num">B time</th><th className="num">B − A</th></tr></thead>
          <tbody>{events.map((e) => {
            const dv = (e.b?.us ?? 0) - (e.a?.us ?? 0)
            const ev = doc.events[e.id]
            return (
              <tr key={e.id}>
                <td>{ev?.name ?? `event ${e.id}`}{ev?.idle && <span className="dim"> (idle)</span>}</td>
                <td className="num">{e.a ? fmtInt(e.a.count) : ''}</td><td className="num">{e.a ? fmtDur(e.a.us) : ''}</td>
                <td className="num">{e.b ? fmtInt(e.b.count) : ''}</td><td className="num">{e.b ? fmtDur(e.b.us) : ''}</td>
                <td className="num"><span className={'delta ' + (ev?.idle ? '' : worse(dv))}>{fmtDurDelta(dv)}</span></td>
              </tr>
            )
          })}</tbody>
        </table></div>
      )}

      <h3>Binds</h3>
      {positions.length === 0 ? <p className="small muted">No bind values were captured for these executions.</p> : (
        <div className="tbl-wrap"><table className="tbl">
          <thead><tr><th className="num">pos</th><th>type</th><th>A · #{a.execNo}</th><th>B · #{b.execNo}</th></tr></thead>
          <tbody>{positions.map((p) => {
            const x = fa.binds.find((v) => v.pos === p), y = fb.binds.find((v) => v.pos === p)
            const diff = bindKey(x) !== bindKey(y)
            return (
              <tr key={p} className={diff ? 'differs' : undefined}>
                <td className="num">{p}</td><td className="dim">{(x ?? y)?.type}</td>
                <td className="mono text">{bindText(x)}</td><td className="mono text">{bindText(y)}{diff && <span className="sr-only"> (differs)</span>}</td>
              </tr>
            )
          })}</tbody>
        </table></div>
      )}
      {a.bindSet === NONE && b.bindSet === NONE ? null : <p className="small muted">Rows with a differing value are highlighted.</p>}
    </section>
  )
}
