import { useMemo, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import type { Context, ID } from '../data/types'
import { fmtDur, fmtInt, fmtCompact, fmtWall } from '../data/format'
import { useStore, actions } from '../app/store'
import { DataTable, type Column } from '../components/DataTable'
import { LineRef } from '../components/LineRef'

/** Per-context statistics computed in one pass over the fact columns. */
interface CtxStats {
  calls: number
  elapsed: number // Σ e of top-level calls
  cpu: number // Σ c of top-level calls
  waitUs: number // non-idle waits
  idleUs: number // idle waits
  rows: number
  firstTim: number
  lastTim: number
}

interface CtxRow {
  ctx: Context
  id: ID
  stats: CtxStats
}

type Dim = 'session' | 'module' | 'action' | 'client' | 'service' | 'moduleAction'

const dimLabel: Record<Dim, string> = {
  session: 'session', module: 'module', action: 'action', client: 'client id', service: 'service', moduleAction: 'module + action',
}

function sessionLabel(c: Context): string {
  if (c.sessionId) return c.sessionId
  if (c.process) return `pid ${c.process}`
  return '–'
}

function dimKey(c: Context, dim: Dim): string {
  switch (dim) {
    case 'session': return sessionLabel(c)
    case 'module': return c.module || '–'
    case 'action': return c.action || '–'
    case 'client': return c.clientId || '–'
    case 'service': return c.service || '–'
    case 'moduleAction': return `${c.module || '–'} / ${c.action || '–'}`
  }
}

function emptyStats(): CtxStats {
  return { calls: 0, elapsed: 0, cpu: 0, waitUs: 0, idleUs: 0, rows: 0, firstTim: 0, lastTim: 0 }
}

function addStats(a: CtxStats, b: CtxStats): void {
  a.calls += b.calls
  a.elapsed += b.elapsed
  a.cpu += b.cpu
  a.waitUs += b.waitUs
  a.idleUs += b.idleUs
  a.rows += b.rows
  if (b.firstTim && (!a.firstTim || b.firstTim < a.firstTim)) a.firstTim = b.firstTim
  if (b.lastTim > a.lastTim) a.lastTim = b.lastTim
}

function computeStats(doc: TraceDoc): CtxStats[] {
  const n = doc.contexts.length
  const out: CtxStats[] = Array.from({ length: n }, emptyStats)
  if (!doc.hasFacts) return out
  const c = doc.calls
  for (let i = 0; i < c.n; i++) {
    const k = c.ctx[i]
    if (k < 0 || k >= n) continue
    const s = out[k]
    s.calls++
    s.rows += c.r[i]
    if (c.parent[i] === -1) {
      s.elapsed += c.e[i]
      s.cpu += c.c[i]
    }
    const tim = c.tim[i]
    if (tim) {
      const start = tim - c.e[i]
      if (!s.firstTim || start < s.firstTim) s.firstTim = start
      if (tim > s.lastTim) s.lastTim = tim
    }
  }
  const w = doc.waits
  for (let i = 0; i < w.n; i++) {
    const k = w.ctx[i]
    if (k < 0 || k >= n) continue
    const s = out[k]
    if (w.flags[i] & 2) s.idleUs += w.ela[i]
    else s.waitUs += w.ela[i]
    const tim = w.tim[i]
    if (tim) {
      if (!s.firstTim || tim < s.firstTim) s.firstTim = tim
      if (tim > s.lastTim) s.lastTim = tim
    }
  }
  return out
}

export function Sessions({ doc }: { doc: TraceDoc }) {
  const checked = useStore((s) => s.contexts)
  const [dim, setDim] = useState<Dim>('module')
  const stats = useMemo(() => computeStats(doc), [doc])
  const rows = useMemo<CtxRow[]>(() => doc.contexts.map((ctx, i) => ({ ctx, id: ctx.id ?? i, stats: stats[i] })), [doc, stats])

  const isChecked = (id: ID) => checked?.has(id) ?? false
  const setChecked = (next: Set<ID>) => actions.setContexts(next.size === 0 ? null : next)
  const toggle = (id: ID) => {
    const next = new Set(checked ?? [])
    if (next.has(id)) next.delete(id); else next.add(id)
    setChecked(next)
  }

  const time = (tim: number) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(tim), doc.tzOffsetMin) : `+${fmtDur(tim - doc.span.firstTim)}`)

  const checkCol: Column<CtxRow> = {
    key: 'sel', header: '', width: '2rem',
    render: (r) => (
      <input type="checkbox" checked={isChecked(r.id)} aria-label={`include context from line ${r.ctx.line}`}
        onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} />
    ),
  }
  const identityCols: Column<CtxRow>[] = [
    { key: 'line', header: 'Line', align: 'end', render: (r) => <LineRef line={r.ctx.line} bare />, sort: (r) => r.ctx.line },
    { key: 'sess', header: 'Session', className: 'mono', render: (r) => sessionLabel(r.ctx), sort: (r) => sessionLabel(r.ctx) },
    { key: 'mod', header: 'Module', className: 'clip', render: (r) => r.ctx.module || <span className="dim">–</span>, sort: (r) => r.ctx.module },
    { key: 'act', header: 'Action', className: 'clip', render: (r) => r.ctx.action || <span className="dim">–</span>, sort: (r) => r.ctx.action },
    { key: 'cid', header: 'Client id', className: 'clip', render: (r) => r.ctx.clientId || <span className="dim">–</span>, sort: (r) => r.ctx.clientId },
    { key: 'svc', header: 'Service', render: (r) => r.ctx.service || <span className="dim">–</span>, sort: (r) => r.ctx.service },
    { key: 'con', header: 'Container', align: 'end', render: (r) => r.ctx.containerId || <span className="dim">–</span>, sort: (r) => r.ctx.containerId },
    { key: 'drv', header: 'Driver', render: (r) => r.ctx.clientDriver || <span className="dim">–</span>, sort: (r) => r.ctx.clientDriver },
  ]
  const statCols = (get: (r: CtxRow) => CtxStats): Column<CtxRow>[] => [
    { key: 'calls', header: 'Calls', align: 'end', render: (r) => fmtInt(get(r).calls), sort: (r) => get(r).calls },
    { key: 'resp', header: 'Response', title: 'elapsed of top-level calls in this context', align: 'end', render: (r) => fmtDur(get(r).elapsed), sort: (r) => get(r).elapsed, bar: true },
    { key: 'cpu', header: 'CPU', align: 'end', render: (r) => fmtDur(get(r).cpu), sort: (r) => get(r).cpu },
    { key: 'wait', header: 'Waits', title: 'non-idle wait time', align: 'end', render: (r) => fmtDur(get(r).waitUs), sort: (r) => get(r).waitUs },
    { key: 'idle', header: 'Idle', align: 'end', render: (r) => fmtDur(get(r).idleUs), sort: (r) => get(r).idleUs },
    { key: 'rows', header: 'Rows', align: 'end', render: (r) => fmtCompact(get(r).rows), sort: (r) => get(r).rows },
    { key: 'first', header: 'First', render: (r) => (get(r).firstTim ? time(get(r).firstTim) : <span className="dim">–</span>), sort: (r) => get(r).firstTim },
    { key: 'last', header: 'Last', render: (r) => (get(r).lastTim ? time(get(r).lastTim) : <span className="dim">–</span>), sort: (r) => get(r).lastTim },
  ]
  const ctxCols: Column<CtxRow>[] = [checkCol, ...identityCols, ...(doc.hasFacts ? statCols((r) => r.stats) : [])]

  // roll-ups by the chosen dimension
  interface GroupRow { key: string; ids: ID[]; stats: CtxStats }
  const groups = useMemo<GroupRow[]>(() => {
    const m = new Map<string, GroupRow>()
    for (const r of rows) {
      const k = dimKey(r.ctx, dim)
      let g = m.get(k)
      if (!g) { g = { key: k, ids: [], stats: emptyStats() }; m.set(k, g) }
      g.ids.push(r.id)
      addStats(g.stats, r.stats)
    }
    return [...m.values()]
  }, [rows, dim])
  const groupCols: Column<GroupRow>[] = [
    { key: 'k', header: dimLabel[dim], className: 'mono', render: (g) => g.key, sort: (g) => g.key },
    { key: 'n', header: 'Contexts', align: 'end', render: (g) => fmtInt(g.ids.length), sort: (g) => g.ids.length },
    ...(doc.hasFacts ? (statCols((r) => r.stats) as unknown as Column<GroupRow>[]) : []),
  ]
  const groupSelectedKey = useMemo(() => {
    if (!checked) return null
    const g = groups.find((g) => g.ids.length === checked.size && g.ids.every((id) => checked.has(id)))
    return g ? g.key : null
  }, [groups, checked])

  const selectedCount = checked?.size ?? 0
  return (
    <>
      <section className="section">
        <header>
          <h2>Session contexts</h2>
          <span className="hint">
            {doc.contexts.length} context{doc.contexts.length === 1 ? '' : 's'}; one row per change of session, module, action, client id, service or process.
            {selectedCount > 0 ? ` ${selectedCount} selected: every view shows only their calls and waits.` : ' Tick rows to filter every view to them.'}
          </span>
          <span className="tools">
            <button onClick={() => setChecked(new Set(rows.map((r) => r.id)))} disabled={rows.length === 0}>select all</button>
            <button onClick={() => actions.setContexts(null)} disabled={selectedCount === 0}>none</button>
          </span>
        </header>
        {!doc.hasFacts && <p className="callout">This document was written without fact tables, so per-context statistics are not available.</p>}
        <DataTable columns={ctxCols} rows={rows} rowKey={(r) => r.id} defaultSort={{ key: 'line', dir: 'asc' }} maxHeight="45dvh"
          onRowClick={(r) => toggle(r.id)} empty="No session context markers in this trace." />
      </section>

      <section className="section">
        <header>
          <h2>By {dimLabel[dim]}</h2>
          <span className="hint">contexts rolled up; click a row to filter every view to that {dimLabel[dim]}</span>
          <span className="tools">
            <select value={dim} onChange={(e) => setDim(e.target.value as Dim)} aria-label="Roll-up dimension">
              {(Object.keys(dimLabel) as Dim[]).map((d) => <option key={d} value={d}>{dimLabel[d]}</option>)}
            </select>
          </span>
        </header>
        <DataTable columns={groupCols} rows={groups} rowKey={(g) => g.key} defaultSort={doc.hasFacts ? { key: 'resp', dir: 'desc' } : { key: 'k', dir: 'asc' }} maxHeight="40dvh"
          selectedKey={groupSelectedKey} onRowClick={(g) => setChecked(new Set(g.ids))} />
      </section>
    </>
  )
}
