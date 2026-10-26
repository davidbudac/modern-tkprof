import { useMemo, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import { sourceOf } from '../data/source'
import type { Context, ID } from '../data/types'
import { fmtDur, fmtInt, fmtCompact, fmtWall } from '../data/format'
import { useStore, useActions } from '../state/session'
import { DataTable, type Column } from '../components/DataTable'
import { LineRef } from '../components/LineRef'
import { fileTree, isSelected, sessionLabel, toggleFile } from '../data/fileset'
import { contextStats, emptyStats, type CtxStats } from '../data/ctxstats'

interface CtxRow {
  ctx: Context
  id: ID
  stats: CtxStats
  order: number // position with PX slave contexts listed under their coordinator
  child: boolean // attached PX slave
}

type Dim = 'session' | 'module' | 'action' | 'client' | 'service' | 'moduleAction'

const dimLabel: Record<Dim, string> = {
  session: 'session', module: 'module', action: 'action', client: 'client id', service: 'service', moduleAction: 'module + action',
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

export function Sessions({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  // per-context numbers come from the document (stats.contexts) when a server stands behind it, else from the fact columns
  const hasStats = sourceOf(doc).ready
  const checked = useStore((s) => s.contexts)
  const filesSel = useStore((s) => s.files)
  const [dim, setDim] = useState<Dim>('module')
  const stats = useMemo(() => contextStats(doc), [doc])
  const rows = useMemo<CtxRow[]>(() => {
    const kids = new Map<number, number[]>()
    doc.contexts.forEach((c, i) => {
      if (c.px && c.parent != null && c.parent >= 0) kids.set(c.parent, [...(kids.get(c.parent) ?? []), i])
    })
    const out: CtxRow[] = []
    const add = (i: number, child: boolean) => {
      const ctx = doc.contexts[i]
      out.push({ ctx, id: ctx.id ?? i, stats: stats[i], order: out.length, child })
      for (const k of kids.get(i) ?? []) add(k, true)
    }
    doc.contexts.forEach((c, i) => { if (!(c.px && c.parent != null && c.parent >= 0)) add(i, false) })
    return out
  }, [doc, stats])
  const multiFile = doc.multiFile
  const fileOf = (r: CtxRow) => r.ctx.fileIdx ?? 0
  const inSel = (r: CtxRow) => isSelected(filesSel, fileOf(r))
  const selectable = useMemo(() => rows.filter(inSel), [rows, filesSel]) // eslint-disable-line react-hooks/exhaustive-deps
  const tree = useMemo(() => fileTree(doc), [doc])
  const byFile = useMemo(() => {
    const m = new Map<number, CtxRow[]>()
    for (const r of rows) { const f = r.ctx.fileIdx ?? 0; const l = m.get(f); if (l) l.push(r); else m.set(f, [r]) }
    return m
  }, [rows])

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
      <input type="checkbox" checked={isChecked(r.id)} aria-label={`include context from line ${r.ctx.line}`} disabled={!inSel(r)} title={inSel(r) ? undefined : 'its file is not selected'}
        onClick={(e) => e.stopPropagation()} onChange={() => toggle(r.id)} />
    ),
  }
  const identityCols: Column<CtxRow>[] = [
    { key: 'line', header: multiFile ? 'File:line' : 'Line', align: 'end', render: (r) => (multiFile ? <>{r.ctx.fileIdx ?? 0}:<LineRef line={r.ctx.line} file={r.ctx.fileIdx ?? 0} bare /></> : <LineRef line={r.ctx.line} bare />), sort: (r) => r.order },
    { key: 'sess', header: 'Session', className: 'mono', render: (r) => (
      <>{r.child && <span className="dim" title="PX slave of the coordinator above">↳ </span>}{sessionLabel(r.ctx)}{r.ctx.px && <span className="chip-q" style={{ marginLeft: '0.4rem' }}>PX</span>}</>
    ), sort: (r) => sessionLabel(r.ctx) },
    { key: 'mod', header: 'Module', className: 'clip', render: (r) => r.ctx.module || <span className="dim">–</span>, sort: (r) => r.ctx.module },
    { key: 'act', header: 'Action', className: 'clip', render: (r) => r.ctx.action || <span className="dim">–</span>, sort: (r) => r.ctx.action },
    { key: 'cid', header: 'Client id', className: 'clip', render: (r) => r.ctx.clientId || <span className="dim">–</span>, sort: (r) => r.ctx.clientId },
    { key: 'svc', header: 'Service', render: (r) => r.ctx.service || <span className="dim">–</span>, sort: (r) => r.ctx.service },
    { key: 'con', header: 'Container', align: 'end', render: (r) => r.ctx.containerId || <span className="dim">–</span>, sort: (r) => r.ctx.containerId },
    { key: 'drv', header: 'Driver', render: (r) => r.ctx.clientDriver || <span className="dim">–</span>, sort: (r) => r.ctx.clientDriver },
  ]
  const statCols = (get: (r: CtxRow) => CtxStats): Column<CtxRow>[] => [
    { key: 'calls', header: 'Calls', align: 'end', render: (r) => fmtInt(get(r).calls), sort: (r) => get(r).calls },
    { key: 'resp', header: 'Response', title: 'elapsed of top-level calls', align: 'end', render: (r) => fmtDur(get(r).elapsed), sort: (r) => get(r).elapsed, bar: true },
    { key: 'cpu', header: 'CPU', align: 'end', render: (r) => fmtDur(get(r).cpu), sort: (r) => get(r).cpu },
    { key: 'wait', header: 'Waits', title: 'non-idle wait time', align: 'end', render: (r) => fmtDur(get(r).waitUs), sort: (r) => get(r).waitUs },
    { key: 'idle', header: 'Idle', align: 'end', render: (r) => fmtDur(get(r).idleUs), sort: (r) => get(r).idleUs },
    { key: 'rows', header: 'Rows', align: 'end', render: (r) => fmtCompact(get(r).rows), sort: (r) => get(r).rows },
    { key: 'first', header: 'First', render: (r) => (get(r).firstTim ? time(get(r).firstTim) : <span className="dim">–</span>), sort: (r) => get(r).firstTim },
    { key: 'last', header: 'Last', render: (r) => (get(r).lastTim ? time(get(r).lastTim) : <span className="dim">–</span>), sort: (r) => get(r).lastTim },
  ]
  const ctxCols: Column<CtxRow>[] = [checkCol, ...identityCols, ...(hasStats ? statCols((r) => r.stats) : [])]

  // roll-ups by the chosen dimension
  interface GroupRow { key: string; ids: ID[]; stats: CtxStats }
  const groups = useMemo<GroupRow[]>(() => {
    const m = new Map<string, GroupRow>()
    for (const r of selectable) {
      const k = dimKey(r.ctx, dim)
      let g = m.get(k)
      if (!g) { g = { key: k, ids: [], stats: emptyStats() }; m.set(k, g) }
      g.ids.push(r.id)
      addStats(g.stats, r.stats)
    }
    return [...m.values()]
  }, [selectable, dim])
  const groupCols: Column<GroupRow>[] = [
    { key: 'k', header: dimLabel[dim], className: 'mono', render: (g) => g.key, sort: (g) => g.key },
    { key: 'n', header: 'Contexts', align: 'end', render: (g) => fmtInt(g.ids.length), sort: (g) => g.ids.length },
    ...(hasStats ? (statCols((r) => r.stats) as unknown as Column<GroupRow>[]) : []),
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
            {doc.contexts.length} context{doc.contexts.length === 1 ? '' : 's'} · row per change of session, module, action, client id, service or process
            {selectedCount > 0 ? ` · ${selectedCount} selected, all views filtered` : ' · tick to filter all views'}
          </span>
          <span className="tools">
            <button onClick={() => setChecked(new Set(selectable.map((r) => r.id)))} disabled={selectable.length === 0}>select all</button>
            <button onClick={() => actions.setContexts(null)} disabled={selectedCount === 0}>none</button>
          </span>
        </header>
        {!hasStats && <p className="callout">No fact tables: per-context statistics unavailable.</p>}
        {multiFile ? (
          <div className="file-groups">
            {tree.map((n) => {
              const list = byFile.get(n.idx) ?? []
              const f = doc.file.files?.[n.idx]
              const on = isSelected(filesSel, n.idx)
              return (
                <div key={n.idx} className={'file-group' + (on ? '' : ' off')} style={{ marginInlineStart: `${n.depth * 1.25}rem` }}>
                  <div className="file-group-head">
                    <input type="checkbox" checked={on} aria-label={`show file ${f?.name ?? n.idx}`} onChange={() => actions.setFiles(toggleFile(doc, filesSel, n.idx))} />
                    <b className="mono">{n.depth > 0 && <span className="dim">↳ </span>}{f?.name ?? `file ${n.idx}`}</b>
                    {f?.px && <span className="chip-q">PX</span>}
                    <span className="dim">{list.length} context{list.length === 1 ? '' : 's'}{on ? '' : ' · file not selected'}</span>
                  </div>
                  <DataTable columns={ctxCols} rows={list} rowKey={(r) => r.id} defaultSort={{ key: 'line', dir: 'asc' }} maxHeight="16rem"
                    onRowClick={(r) => { if (inSel(r)) toggle(r.id) }} empty="No session context markers." />
                </div>
              )
            })}
          </div>
        ) : (
          <DataTable columns={ctxCols} rows={rows} rowKey={(r) => r.id} defaultSort={{ key: 'line', dir: 'asc' }} maxHeight="45dvh"
            onRowClick={(r) => toggle(r.id)} empty="No session context markers." />
        )}
      </section>

      <section className="section">
        <header>
          <h2>By {dimLabel[dim]}</h2>
          <span className="hint">click: filter all views</span>
          <span className="tools">
            <select value={dim} onChange={(e) => setDim(e.target.value as Dim)} aria-label="Roll-up dimension">
              {(Object.keys(dimLabel) as Dim[]).map((d) => <option key={d} value={d}>{dimLabel[d]}</option>)}
            </select>
          </span>
        </header>
        <DataTable columns={groupCols} rows={groups} rowKey={(g) => g.key} defaultSort={hasStats ? { key: 'resp', dir: 'desc' } : { key: 'k', dir: 'asc' }} maxHeight="40dvh"
          selectedKey={groupSelectedKey} onRowClick={(g) => setChecked(new Set(g.ids))} />
      </section>
    </>
  )
}
