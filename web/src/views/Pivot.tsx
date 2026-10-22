import { useMemo, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import type { NumCol } from '../data/columns'
import type { Context } from '../data/types'
import { callKindName, CallKind } from '../data/types'
import { fmtDur, fmtInt, fmtCompact, fmtWall, preview } from '../data/format'
import { useStore, actions, callFilter, waitFilter, type State } from '../app/store'
import { DataTable, type Column } from '../components/DataTable'
import { pickBucket } from '../data/derive'
import '../styles/pivot.css'

type Fact = 'calls' | 'waits'
type RowFilter = ((i: number) => boolean) | undefined

/** A dimension: an integer key per fact row (negative = "none"), resolved to a label after grouping. */
interface Dim {
  id: string
  label: string
  mono?: boolean
  click?: 'stmt' | 'event'
  raw: (i: number) => number
  name: (raw: number) => string
  extra?: { header: string; get: (raw: number) => string }
}

/** A measure over the per-group accumulator; `total` is the accumulator over every row in scope. */
interface Measure {
  id: string
  label: string
  title?: string
  value: (acc: Float64Array, total: Float64Array) => number
  fmt: (v: number) => string
}

interface Group { key: number; k1: number; k2: number; acc: Float64Array }

const CAP = 1000
const K2_SPAN = 2 ** 21

// ---- accumulator layouts -----------------------------------------------------

const CM = { count: 0, e: 1, selfE: 2, c: 3, selfC: 4, p: 5, cr: 6, cu: 7, r: 8, mis: 9, wait: 10, idle: 11, maxE: 12, n: 13 } as const
const WM = { count: 0, ela: 1, min: 2, max: 3, n: 4 } as const

const callMeasures: Measure[] = [
  { id: 'count', label: 'Calls', value: (a) => a[CM.count], fmt: fmtInt },
  { id: 'e', label: 'Elapsed', title: 'Σ e= (includes recursive children)', value: (a) => a[CM.e], fmt: fmtDur },
  { id: 'selfE', label: 'Self elapsed', title: 'Σ elapsed minus recursive children', value: (a) => a[CM.selfE], fmt: fmtDur },
  { id: 'c', label: 'CPU', value: (a) => a[CM.c], fmt: fmtDur },
  { id: 'selfC', label: 'Self CPU', value: (a) => a[CM.selfC], fmt: fmtDur },
  { id: 'p', label: 'Disk', title: 'Σ p= physical reads', value: (a) => a[CM.p], fmt: fmtCompact },
  { id: 'cr', label: 'Query', title: 'Σ cr= consistent gets', value: (a) => a[CM.cr], fmt: fmtCompact },
  { id: 'cu', label: 'Current', title: 'Σ cu= current gets', value: (a) => a[CM.cu], fmt: fmtCompact },
  { id: 'r', label: 'Rows', value: (a) => a[CM.r], fmt: fmtCompact },
  { id: 'mis', label: 'Misses', title: 'Σ mis= library cache misses', value: (a) => a[CM.mis], fmt: fmtInt },
  { id: 'wait', label: 'In-call waits', value: (a) => a[CM.wait], fmt: fmtDur },
  { id: 'idle', label: 'Idle', title: 'waits between calls attributed to these calls', value: (a) => a[CM.idle], fmt: fmtDur },
  { id: 'avgE', label: 'Avg elapsed', value: (a) => (a[CM.count] ? a[CM.e] / a[CM.count] : 0), fmt: fmtDur },
  { id: 'maxE', label: 'Max elapsed', value: (a) => a[CM.maxE], fmt: fmtDur },
]

const waitMeasures: Measure[] = [
  { id: 'count', label: 'Waits', value: (a) => a[WM.count], fmt: fmtInt },
  { id: 'ela', label: 'Time', value: (a) => a[WM.ela], fmt: fmtDur },
  { id: 'avg', label: 'Avg', value: (a) => (a[WM.count] ? a[WM.ela] / a[WM.count] : 0), fmt: fmtDur },
  { id: 'min', label: 'Min', value: (a) => (a[WM.count] ? a[WM.min] : 0), fmt: fmtDur },
  { id: 'max', label: 'Max', value: (a) => a[WM.max], fmt: fmtDur },
  { id: 'share', label: 'Share', title: 'share of all wait time in scope', value: (a, t) => (t[WM.ela] ? (100 * a[WM.ela]) / t[WM.ela] : 0), fmt: (v) => `${v.toFixed(1)}%` },
]

// ---- dimension builders ------------------------------------------------------

/** Dense ids for raw numeric keys (plan hashes, object ids, ...). */
class Interner {
  private map = new Map<number, number>()
  readonly keys: number[] = []
  id(raw: number): number {
    let k = this.map.get(raw)
    if (k === undefined) { k = this.keys.length; this.keys.push(raw); this.map.set(raw, k) }
    return k
  }
}

/** Dense ids for (a, b) pairs, e.g. (event, p1 value). */
class PairInterner {
  private map = new Map<number, Map<number, number>>()
  readonly pairs: [number, number][] = []
  id(a: number, b: number): number {
    let inner = this.map.get(a)
    if (!inner) { inner = new Map(); this.map.set(a, inner) }
    let k = inner.get(b)
    if (k === undefined) { k = this.pairs.length; this.pairs.push([a, b]); inner.set(b, k) }
    return k
  }
}

function ctxDim(doc: TraceDoc, ctxCol: NumCol, id: string, label: string, get: (c: Context) => string, none: string): Dim {
  const names: string[] = []
  const idx = new Map<string, number>()
  const keyOf = new Int32Array(doc.contexts.length)
  doc.contexts.forEach((c, i) => {
    const v = get(c)
    let k = idx.get(v)
    if (k === undefined) { k = names.length; names.push(v); idx.set(v, k) }
    keyOf[i] = k
  })
  return {
    id, label,
    raw: (i) => { const c = ctxCol[i]; return c >= 0 && c < keyOf.length ? keyOf[c] : -1 },
    name: (k) => (k < 0 ? none : names[k] || none),
  }
}

function sessionName(c: Context): string {
  if (c.sessionId) return c.sessionId
  if (c.process) return `pid ${c.process}`
  return '(unknown session)'
}

function timeDim(doc: TraceDoc, timCol: NumCol): Dim {
  const bucket = pickBucket(doc.spanUs())
  const base = doc.span.firstTim
  return {
    id: 'time', label: `Time (${fmtDur(bucket)} buckets)`, mono: true,
    raw: (i) => { const t = timCol[i]; return t > 0 && bucket > 0 ? Math.floor((t - base) / bucket) : -1 },
    name: (k) => {
      if (k < 0) return '(no time)'
      const t = base + k * bucket
      return doc.wallOffsetUs ? fmtWall(doc.wallOf(t), doc.tzOffsetMin) : `+${fmtDur(t - base)}`
    },
  }
}

function stmtDim(doc: TraceDoc, stmtCol: NumCol, none: string): Dim {
  return {
    id: 'stmt', label: 'Statement', mono: true, click: 'stmt',
    raw: (i) => stmtCol[i],
    name: (k) => { const s = doc.statements[k]; return s ? doc.label(s) : none },
    extra: { header: 'Text', get: (k) => { const s = doc.statements[k]; return s ? preview(s.text, 70) : '' } },
  }
}

const closeTypeName: Record<number, string> = { 0: 'hard close', 1: 'cached (new)', 2: 'cached (replaced)', 3: 'cached (again)' }
const ogName: Record<number, string> = { 1: 'ALL_ROWS', 2: 'FIRST_ROWS', 3: 'RULE', 4: 'CHOOSE' }

function callDims(doc: TraceDoc): Dim[] {
  const c = doc.calls
  const plh = new Interner()
  return [
    stmtDim(doc, c.stmt, '(no statement)'),
    { id: 'kind', label: 'Call kind', raw: (i) => c.kind[i], name: (k) => callKindName[k] ?? `kind ${k}` },
    { id: 'dep', label: 'Recursive depth', raw: (i) => c.dep[i], name: (k) => `dep ${k}` },
    ctxDim(doc, c.ctx, 'session', 'Session', sessionName, '(no session)'),
    ctxDim(doc, c.ctx, 'module', 'Module', (x) => x.module || '(no module)', '(no module)'),
    ctxDim(doc, c.ctx, 'action', 'Action', (x) => x.action || '(no action)', '(no action)'),
    ctxDim(doc, c.ctx, 'client', 'Client id', (x) => x.clientId || '(no client id)', '(no client id)'),
    ctxDim(doc, c.ctx, 'service', 'Service', (x) => x.service || '(no service)', '(no service)'),
    { id: 'plh', label: 'Plan hash', mono: true, raw: (i) => plh.id(c.plh[i]), name: (k) => { const v = plh.keys[k]; return v ? String(v) : '(no plan)' } },
    { id: 'execNo', label: 'Execution #', raw: (i) => c.execNo[i], name: (k) => (k > 0 ? `exec ${k}` : '(not an execution)') },
    { id: 'cursor', label: 'Cursor', mono: true, raw: (i) => c.cursor[i], name: (k) => { const cu = doc.cursors[k]; return cu ? `#${cu.number || k} (line ${fmtInt(cu.line)})` : '(no cursor)' } },
    { id: 'closeType', label: 'Close type', raw: (i) => (c.kind[i] === CallKind.close ? c.type[i] : -1), name: (k) => (k < 0 ? '(not a close)' : closeTypeName[k] ?? `type ${k}`) },
    timeDim(doc, c.tim),
    { id: 'og', label: 'Optimizer goal', raw: (i) => c.og[i], name: (k) => ogName[k] ?? (k === 0 ? '(none)' : `og ${k}`) },
  ]
}

function waitDims(doc: TraceDoc): Dim[] {
  const w = doc.waits
  const classes: string[] = []
  const classIdx = new Map<string, number>()
  const classOfEvent = new Int32Array(doc.events.length)
  doc.events.forEach((ev, i) => {
    const v = ev.idle ? 'Idle' : ev.class || 'unknown'
    let k = classIdx.get(v)
    if (k === undefined) { k = classes.length; classes.push(v); classIdx.set(v, k) }
    classOfEvent[i] = k
  })
  const objs = new Interner()
  const p1 = new PairInterner()
  const p2 = new PairInterner()
  const paramName = (pair: [number, number], which: 'p1Name' | 'p2Name', fallback: string) => {
    const ev = doc.events[pair[0]]
    return `${ev?.[which] || fallback}=${fmtIntKey(pair[1])}`
  }
  return [
    { id: 'event', label: 'Event', click: 'event', raw: (i) => w.event[i], name: (k) => doc.events[k]?.name ?? `event ${k}`, extra: { header: 'Class', get: (k) => { const ev = doc.events[k]; return ev ? (ev.idle ? 'Idle' : ev.class || 'unknown') : '' } } },
    { id: 'class', label: 'Wait class', raw: (i) => { const e = w.event[i]; return e >= 0 && e < classOfEvent.length ? classOfEvent[e] : -1 }, name: (k) => (k < 0 ? 'unknown' : classes[k]) },
    stmtDim(doc, w.stmt, '(no cursor)'),
    { id: 'obj', label: 'Object', mono: true, raw: (i) => { const o = w.obj[i]; return o > 0 ? objs.id(o) : -1 }, name: (k) => (k < 0 ? '(none)' : `obj# ${objs.keys[k]}`) },
    { id: 'p1', label: 'p1 (by event)', mono: true, raw: (i) => p1.id(w.event[i], w.p1[i]), name: (k) => paramName(p1.pairs[k], 'p1Name', 'p1') },
    { id: 'p2', label: 'p2 (by event)', mono: true, raw: (i) => p2.id(w.event[i], w.p2[i]), name: (k) => paramName(p2.pairs[k], 'p2Name', 'p2') },
    { id: 'between', label: 'Inside / between calls', raw: (i) => w.flags[i] & 1, name: (k) => (k ? 'between calls' : 'inside a call') },
    { id: 'idle', label: 'Idle / non-idle', raw: (i) => (w.flags[i] >> 1) & 1, name: (k) => (k ? 'idle' : 'non-idle') },
    { id: 'dep', label: 'Recursive depth', raw: (i) => w.dep[i], name: (k) => `dep ${k}` },
    ctxDim(doc, w.ctx, 'session', 'Session', sessionName, '(no session)'),
    ctxDim(doc, w.ctx, 'module', 'Module', (x) => x.module || '(no module)', '(no module)'),
    ctxDim(doc, w.ctx, 'action', 'Action', (x) => x.action || '(no action)', '(no action)'),
    ctxDim(doc, w.ctx, 'client', 'Client id', (x) => x.clientId || '(no client id)', '(no client id)'),
    ctxDim(doc, w.ctx, 'service', 'Service', (x) => x.service || '(no service)', '(no service)'),
    { id: 'callKind', label: 'Call kind (attributed call)', raw: (i) => { const call = w.call[i]; return call >= 0 ? doc.calls.kind[call] : -1 }, name: (k) => (k < 0 ? 'unattributed' : callKindName[k] ?? `kind ${k}`) },
    timeDim(doc, w.tim),
  ]
}

function fmtIntKey(v: number): string { return Number.isInteger(v) ? String(v) : v.toString() }

// ---- grouping ----------------------------------------------------------------

interface PivotResult { groups: Group[]; total: Float64Array; rows: number }

function runPivot(doc: TraceDoc, fact: Fact, filter: RowFilter, d1: Dim, d2: Dim | null): PivotResult {
  const nAcc = fact === 'calls' ? CM.n : WM.n
  const init = (a: Float64Array) => { if (fact === 'waits') a[WM.min] = Infinity }
  const total = new Float64Array(nAcc)
  init(total)
  const groups = new Map<number, Group>()
  const i1 = new Interner(), i2 = new Interner()
  const c = doc.calls, w = doc.waits
  const n = fact === 'calls' ? c.n : w.n
  let rows = 0
  for (let i = 0; i < n; i++) {
    if (filter && !filter(i)) continue
    rows++
    const k1 = i1.id(d1.raw(i))
    const k2 = d2 ? i2.id(d2.raw(i)) : 0
    const key = k1 * K2_SPAN + k2
    let g = groups.get(key)
    if (!g) { g = { key, k1, k2, acc: new Float64Array(nAcc) }; init(g.acc); groups.set(key, g) }
    const a = g.acc
    if (fact === 'calls') {
      const e = c.e[i]
      a[CM.count]++; total[CM.count]++
      a[CM.e] += e; total[CM.e] += e
      a[CM.selfE] += c.selfE[i]; total[CM.selfE] += c.selfE[i]
      a[CM.c] += c.c[i]; total[CM.c] += c.c[i]
      a[CM.selfC] += c.selfC[i]; total[CM.selfC] += c.selfC[i]
      a[CM.p] += c.p[i]; total[CM.p] += c.p[i]
      a[CM.cr] += c.cr[i]; total[CM.cr] += c.cr[i]
      a[CM.cu] += c.cu[i]; total[CM.cu] += c.cu[i]
      a[CM.r] += c.r[i]; total[CM.r] += c.r[i]
      a[CM.mis] += c.mis[i]; total[CM.mis] += c.mis[i]
      a[CM.wait] += c.waitEla[i]; total[CM.wait] += c.waitEla[i]
      a[CM.idle] += c.idleEla[i]; total[CM.idle] += c.idleEla[i]
      if (e > a[CM.maxE]) a[CM.maxE] = e
      if (e > total[CM.maxE]) total[CM.maxE] = e
    } else {
      const ela = w.ela[i]
      a[WM.count]++; total[WM.count]++
      a[WM.ela] += ela; total[WM.ela] += ela
      if (ela < a[WM.min]) a[WM.min] = ela
      if (ela < total[WM.min]) total[WM.min] = ela
      if (ela > a[WM.max]) a[WM.max] = ela
      if (ela > total[WM.max]) total[WM.max] = ela
    }
  }
  // dense ids back to raw keys so labels can be resolved
  const out: Group[] = []
  for (const g of groups.values()) out.push({ key: g.key, k1: i1.keys[g.k1], k2: d2 ? i2.keys[g.k2] : 0, acc: g.acc })
  return { groups: out, total, rows }
}

function scopeHint(state: State, fact: Fact): string {
  const parts: string[] = []
  if (state.window) parts.push('in the selected time window')
  if (state.contexts) parts.push(`in ${state.contexts.size} selected session context${state.contexts.size === 1 ? '' : 's'}`)
  if (fact === 'waits' && !state.includeIdle) parts.push('idle events hidden')
  return parts.join(', ')
}

function csvCell(v: string | number): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(3)
  return `"${v.replace(/"/g, '""')}"`
}

function download(name: string, text: string) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

// ---- view --------------------------------------------------------------------

export function Pivot({ doc }: { doc: TraceDoc }) {
  const state = useStore((s) => s)
  const [fact, setFact] = useState<Fact>('calls')
  const [d1Id, setD1] = useState('stmt')
  const [d2Id, setD2] = useState('')
  const [sortId, setSortId] = useState<{ calls: string; waits: string }>({ calls: 'e', waits: 'ela' })

  const dims = useMemo(() => (fact === 'calls' ? callDims(doc) : waitDims(doc)), [doc, fact])
  const measures = fact === 'calls' ? callMeasures : waitMeasures
  const d1 = dims.find((d) => d.id === d1Id) ?? dims[0]
  const d2 = d2Id && d2Id !== d1.id ? dims.find((d) => d.id === d2Id) ?? null : null
  const sortM = measures.find((m) => m.id === sortId[fact]) ?? measures[1]

  const filter = fact === 'calls' ? callFilter(state) : waitFilter(state)
  const result = useMemo(
    () => (doc.hasFacts ? runPivot(doc, fact, filter, d1, d2) : null),
    [doc, fact, d1, d2, state.window, state.contexts, state.includeIdle],
  )

  const sorted = useMemo(() => {
    if (!result) return []
    const t = result.total
    return [...result.groups].sort((a, b) => sortM.value(b.acc, t) - sortM.value(a.acc, t)).slice(0, CAP)
  }, [result, sortM])

  if (!doc.hasFacts) {
    return (
      <section className="section">
        <header><h2>Pivot</h2></header>
        <p className="callout">This document was generated without fact tables (<code>-facts=false</code>), so there is nothing to slice. Regenerate it with the facts included.</p>
      </section>
    )
  }
  if (!result) return null
  const total = result.total

  const onFact = (f: Fact) => {
    if (f === fact) return
    setFact(f)
    setD1(f === 'calls' ? 'stmt' : 'event')
    setD2('')
  }

  const cols: Column<Group>[] = [
    { key: 'd1', header: d1.label, className: d1.mono ? 'mono clip' : 'clip', render: (g) => d1.name(g.k1), sort: (g) => d1.name(g.k1) },
  ]
  if (d1.extra) cols.push({ key: 'd1x', header: d1.extra.header, className: 'clip', render: (g) => d1.extra!.get(g.k1), sort: (g) => d1.extra!.get(g.k1) })
  if (d2) {
    cols.push({ key: 'd2', header: d2.label, className: d2.mono ? 'mono clip' : 'clip', render: (g) => d2.name(g.k2), sort: (g) => d2.name(g.k2) })
    if (d2.extra) cols.push({ key: 'd2x', header: d2.extra.header, className: 'clip', render: (g) => d2.extra!.get(g.k2), sort: (g) => d2.extra!.get(g.k2) })
  }
  for (const m of measures) {
    cols.push({ key: m.id, header: m.label, title: m.title, align: 'end', render: (g) => m.fmt(m.value(g.acc, total)), sort: (g) => m.value(g.acc, total), bar: m.id === sortM.id })
  }

  const onRow = (g: Group) => {
    if (d1.click === 'stmt' && g.k1 >= 0) actions.selectStmt(g.k1)
    else if (d1.click === 'event' && g.k1 >= 0) actions.selectEvent(g.k1)
  }
  const selectedKey = d1.click === 'stmt' && state.selection.stmt !== null ? sorted.find((g) => g.k1 === state.selection.stmt)?.key ?? null
    : d1.click === 'event' && state.selection.event !== null ? sorted.find((g) => g.k1 === state.selection.event)?.key ?? null
    : null

  const exportCsv = () => {
    const header = [d1.label, ...(d1.extra ? [d1.extra.header] : []), ...(d2 ? [d2.label, ...(d2.extra ? [d2.extra.header] : [])] : []), ...measures.map((m) => m.label)]
    const lines = [header.map(csvCell).join(',')]
    const all = [...result.groups].sort((a, b) => sortM.value(b.acc, total) - sortM.value(a.acc, total))
    for (const g of all) {
      const cells: (string | number)[] = [d1.name(g.k1)]
      if (d1.extra) cells.push(d1.extra.get(g.k1))
      if (d2) { cells.push(d2.name(g.k2)); if (d2.extra) cells.push(d2.extra.get(g.k2)) }
      for (const m of measures) cells.push(m.value(g.acc, total))
      lines.push(cells.map(csvCell).join(','))
    }
    download('mtkprof-pivot.csv', '﻿' + lines.join('\n') + '\n')
  }

  const scope = scopeHint(state, fact)
  const capped = result.groups.length > CAP
  return (
    <section className="section">
      <header>
        <h2>Pivot</h2>
        <span className="hint">
          {fmtInt(result.rows)} {fact} in {fmtInt(result.groups.length)} group{result.groups.length === 1 ? '' : 's'}
          {scope ? ` · ${scope}` : ''}
          {capped ? ` · showing the top ${fmtInt(CAP)} of ${fmtInt(result.groups.length)} groups` : ''}
        </span>
      </header>
      <div className="pv-controls" role="group" aria-label="Pivot controls">
        <span className="seg" role="group" aria-label="Fact table">
          <button aria-pressed={fact === 'calls'} onClick={() => onFact('calls')}>calls</button>
          <button aria-pressed={fact === 'waits'} onClick={() => onFact('waits')}>waits</button>
        </span>
        <label className="pv-ctl">Rows by
          <select value={d1.id} onChange={(e) => { setD1(e.target.value); if (e.target.value === d2Id) setD2('') }}>
            {dims.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
        <label className="pv-ctl">then by
          <select value={d2?.id ?? ''} onChange={(e) => setD2(e.target.value)}>
            <option value="">none</option>
            {dims.filter((d) => d.id !== d1.id).map((d) => <option key={d.id} value={d.id}>{d.label}</option>)}
          </select>
        </label>
        <label className="pv-ctl">Sort by
          <select value={sortM.id} onChange={(e) => setSortId({ ...sortId, [fact]: e.target.value })}>
            {measures.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
          </select>
        </label>
        <button className="pv-push" onClick={exportCsv} disabled={result.groups.length === 0}>Download CSV</button>
      </div>
      <DataTable
        key={`${fact}:${d1.id}:${d2?.id ?? ''}:${sortM.id}`}
        columns={cols}
        rows={sorted}
        rowKey={(g) => g.key}
        defaultSort={{ key: sortM.id, dir: 'desc' }}
        maxHeight="calc(100dvh - 15rem)"
        selectedKey={selectedKey}
        onRowClick={d1.click ? onRow : undefined}
        empty="No rows in scope"
        footer={<>
          <span>total</span>
          {measures.map((m) => <span key={m.id}>{m.label} {m.id === 'share' ? '100%' : m.fmt(m.value(total, total))}</span>)}
        </>}
      />
    </section>
  )
}
