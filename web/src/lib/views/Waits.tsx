import { useMemo } from 'react'
import { ctxKey } from '../data/fileset'
import type { TraceDoc } from '../data/doc'
import type { EventAgg } from '../data/types'
import type { ScopeProfile } from '../data/derive'
import { fmtDur, fmtInt, fmtPct } from '../data/format'
import { scopeNarrows, scopeOf } from '../state/store'
import { useStore, useActions } from '../state/session'
import { sourceOf, useSourceQuery, type QueryState } from '../data/source'
import { DataTable, type Column } from '../components/DataTable'
import { roleOfClass } from '../components/colors'

export function Waits({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const state = useStore((s) => s)
  const sel = state.selection.event
  const source = sourceOf(doc)
  const scope = scopeOf(state)
  // no `keep`: another selection's numbers are never shown as this one's (a live refresh of the same key still keeps them)
  const profile = useSourceQuery(source, `profile:${scope.window ? `${scope.window.startTim}:${scope.window.endTim}` : ''}|${ctxKey(scope.contexts)}|${scope.includeIdle ? 1 : 0}`,
    (signal) => source.profile(scope, signal))
  const view = waitsView(scopeNarrows(scope), profile)
  const rows = useMemo<EventAgg[]>(() => {
    if (!view.profile) return view.loading ? [] : doc.stats.events
    return view.profile.events.map((a) => { const ev = doc.events[a.key]; return { event: a.key, name: ev.name, class: ev.class, idle: ev.idle, count: a.count, us: a.sum, minUs: a.min, maxUs: a.max } })
  }, [doc, view.profile, view.loading])
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
  const hint = view.loading ? "the selection's wait profile is on its way"
    : `${rows.length} events · ${fmtDur(total)} total${view.notice ? ' · whole trace' : ''}`
  return (
    <section className="section" aria-busy={view.loading}>
      <header><h2>Wait events</h2><span className="hint">{hint}</span>
        <span className="tools"><button aria-pressed={!state.includeIdle} onClick={() => actions.toggleIdle()}>hide idle</button></span></header>
      {view.notice && <p className="callout">{view.notice}</p>}
      <DataTable columns={cols} rows={rows} rowKey={(r) => r.event} defaultSort={{ key: 'us', dir: 'desc' }} maxHeight="calc(100dvh - 12rem)"
        selectedKey={sel} onRowClick={(r) => actions.selectEvent(r.event)} empty={view.loading ? 'Loading the wait profile of the selection…' : undefined} />
    </section>
  )
}

export interface WaitsView {
  /** the profile of the current scope; undefined = none (loading, failed, or not available: the table shows the whole trace) */
  profile: ScopeProfile | undefined
  /** the scope's profile is on its way: the table is empty meanwhile, never another scope's or the whole trace's numbers */
  loading: boolean
  /** why the whole trace's waits are shown although the scope narrows it (null = they are not, or nothing narrows) */
  notice: string | null
}

/**
 * What the Waits table shows for its profile query (pure): the profile of the current key; an empty, pending table while it
 * loads (another scope's profile, `stale`, is never shown); when it failed or the source has none, the whole trace's events,
 * with a notice saying so when the scope narrows the trace (never a silent fallback).
 */
export function waitsView(narrows: boolean, q: QueryState<ScopeProfile | null>): WaitsView {
  if (q.data && !q.stale) return { profile: q.data, loading: false, notice: null }
  if (q.loading) return { profile: undefined, loading: true, notice: null }
  const notice = !narrows ? null
    : q.error ? `Wait profile of the selection unavailable (${q.error}): showing the whole trace.`
    : 'The waits of the selection are not available for this trace: showing the whole trace.'
  return { profile: undefined, loading: false, notice }
}
