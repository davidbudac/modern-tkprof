import { useMemo } from 'react'
import { ctxKey } from '../data/fileset'
import type { TraceDoc } from '../data/doc'
import type { EventAgg } from '../data/types'
import { fmtDur, fmtInt, fmtPct } from '../data/format'
import { scopeOf } from '../state/store'
import { useStore, useActions } from '../state/session'
import { sourceOf, useSourceQuery } from '../data/source'
import { DataTable, type Column } from '../components/DataTable'
import { roleOfClass } from '../components/colors'

export function Waits({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const state = useStore((s) => s)
  const sel = state.selection.event
  const source = sourceOf(doc)
  const scope = scopeOf(state)
  const profile = useSourceQuery(source, `profile:${scope.window ? `${scope.window.startTim}:${scope.window.endTim}` : ''}|${ctxKey(scope.contexts)}|${scope.includeIdle ? 1 : 0}`,
    (signal) => source.profile(scope, signal), 'profile')
  const rows = useMemo<EventAgg[]>(() => {
    if (!profile.data) return profile.loading ? [] : doc.stats.events
    return profile.data.events.map((a) => { const ev = doc.events[a.key]; return { event: a.key, name: ev.name, class: ev.class, idle: ev.idle, count: a.count, us: a.sum, minUs: a.min, maxUs: a.max } })
  }, [doc, profile.data, profile.loading])
  const total = rows.reduce((a, r) => a + r.us, 0)
  const cols: Column<EventAgg>[] = [
    { key: 'n', header: 'Event', render: (r) => <span className="evname" title={r.name}><i className="swatch" style={{ background: `var(--c-${roleOfClass(r.class, r.idle)})` }} /><span>{r.name}</span></span>, sort: (r) => r.name, className: 'clip', width: '22rem' },
    { key: 'cls', header: 'Class', render: (r) => <span className="dim">{r.class || '?'}</span>, sort: (r) => r.class },
    { key: 'us', header: 'Time', align: 'end', render: (r) => fmtDur(r.us), sort: (r) => r.us, bar: true },
    { key: 'pct', header: '%', align: 'end', title: 'share of all wait time', render: (r) => fmtPct(r.us, total), sort: (r) => r.us },
    { key: 'spct', header: '% span', align: 'end', title: 'share of the trace span', render: (r) => fmtPct(r.us, doc.spanUs()), sort: (r) => r.us },
    { key: 'c', header: 'Count', align: 'end', render: (r) => fmtInt(r.count), sort: (r) => r.count },
    { key: 'avg', header: 'Avg', align: 'end', render: (r) => fmtDur(r.us / r.count), sort: (r) => r.us / r.count },
    { key: 'min', header: 'Min', align: 'end', render: (r) => fmtDur(r.minUs), sort: (r) => r.minUs },
    { key: 'max', header: 'Max', align: 'end', render: (r) => fmtDur(r.maxUs), sort: (r) => r.maxUs },
  ]
  return (
    <section className="section">
      <header><h2>Wait events</h2><span className="hint">{rows.length} events · {fmtDur(total)} total</span>
        <span className="tools"><button aria-pressed={!state.includeIdle} onClick={() => actions.toggleIdle()}>hide idle</button></span></header>
      <DataTable label="Wait events by event" columns={cols} rows={rows} rowKey={(r) => r.event} defaultSort={{ key: 'us', dir: 'desc' }} maxHeight="calc(100dvh - 12rem)"
        selectedKey={sel} onRowClick={(r) => actions.selectEvent(r.event)} />
    </section>
  )
}
