import { useMemo } from 'react'
import type { TraceDoc } from '../data/doc'
import { CallKind, NONE } from '../data/types'
import { fmtDur, fmtInt, fmtCompact } from '../data/format'
import { fmtDurDelta, fmtIntDelta, worse } from '../data/delta'
import { bindsOf, type BindRow, type Execution } from '../data/derive'
import { LineRef } from '../components/LineRef'
import '../styles/compare.css'

/** Resources of one call kind within one execution. */
interface Part { calls: number; c: number; e: number; p: number; cr: number; cu: number; r: number }
const zero = (): Part => ({ calls: 0, c: 0, e: 0, p: 0, cr: 0, cu: 0, r: 0 })

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

function add(part: Part, doc: TraceDoc, i: number) {
  const c = doc.calls
  part.calls++; part.c += c.c[i]; part.e += c.e[i]; part.p += c.p[i]; part.cr += c.cr[i]; part.cu += c.cu[i]; part.r += c.r[i]
}

/** The calls of one execution: the PARSE just before its EXEC on the same cursor, the EXEC, and its FETCHes. */
function factsOf(doc: TraceDoc, ex: Execution): Facts {
  const c = doc.calls
  const ids = doc.callsByStmt.get(c.stmt[ex.exec])
  const calls: number[] = []
  const at = ids.indexOf(ex.exec)
  for (let k = at - 1; k >= 0; k--) {
    const i = ids[k]
    if (c.cursor[i] !== ex.cursor) continue
    if (c.kind[i] === CallKind.parse) calls.push(i)
    break // the nearest earlier call of this cursor: a parse belongs to this execution, anything else to the previous one
  }
  calls.push(ex.exec)
  for (let k = at + 1; k < ids.length; k++) {
    const i = ids[k]
    if (c.cursor[i] !== ex.cursor) continue
    if (c.kind[i] !== CallKind.fetch || c.execNo[i] !== ex.execNo) { if (c.kind[i] === CallKind.exec || c.kind[i] === CallKind.close || c.kind[i] === CallKind.parse) break; continue }
    calls.push(i)
  }
  const f: Facts = { ex, parse: zero(), exec: zero(), fetch: zero(), total: zero(), waits: new Map(), binds: bindsOf(doc, ex.bindSet), plh: c.plh[ex.exec] }
  for (const i of calls) {
    const part = c.kind[i] === CallKind.parse ? f.parse : c.kind[i] === CallKind.exec ? f.exec : f.fetch
    add(part, doc, i)
    add(f.total, doc, i)
    for (const w of doc.waitsByCall.get(i)) {
      const a = f.waits.get(doc.waits.event[w]) ?? { count: 0, us: 0 }
      a.count++; a.us += doc.waits.ela[w]
      f.waits.set(doc.waits.event[w], a)
    }
  }
  return f
}

const bindText = (b: BindRow | undefined): string => (!b ? '' : b.noDef ? '(same as an earlier bind)' : b.isNull ? 'NULL' : b.dump ? '(memory dump)' : b.value)
const bindKey = (b: BindRow | undefined): string => (!b ? 'absent' : b.noDef ? 'nodef' : b.isNull ? 'null' : (b.dump ? 'dump:' : 'val:') + b.value)

/** Two executions of one statement side by side: call statistics, waits by event, binds, plan hash. */
export function ExecCompare({ doc, a, b, onClear }: { doc: TraceDoc; a: Execution; b: Execution; onClear: () => void }) {
  const fa = useMemo(() => factsOf(doc, a), [doc, a])
  const fb = useMemo(() => factsOf(doc, b), [doc, b])
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
