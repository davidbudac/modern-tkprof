import { useMemo } from 'react'
import { fmtDur, fmtWall, fmtTz, fmtBytes, fmtPct, useStore, useActions, scopeOf, traceSegmentsFrom, sourceOf, useSourceQuery, type TraceDoc, type View } from '@lib'

const tabs: { id: View; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'statements', label: 'Statements' },
  { id: 'waits', label: 'Waits' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'pivot', label: 'Pivot' },
]

const compareTab = { id: 'compare' as View, label: 'Compare' }
const linesTab = { id: 'lines' as View, label: 'Lines' }

const themeNext = { auto: 'light', light: 'dark', dark: 'auto' } as const
const themeGlyph = { auto: '◐', light: '○', dark: '●' } as const

/** File, the whole-trace profile in miniature, the views, filters and theme. */
export function TopBar({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const state = useStore((s) => s)
  const compare = state.compare
  const hasLines = !!doc.slice && state.linesApi
  const shownTabs = [...(compare ? [compareTab] : []), ...tabs, ...(hasLines ? [linesTab] : [])]
  const name = (doc.file.traceFile || doc.file.path).split(/[\\/]/).pop()
  const totalUs = doc.spanUs()
  const source = sourceOf(doc)
  const scope = { ...scopeOf(state), window: null }
  const profile = useSourceQuery(source, `top:${scope.contexts ? [...scope.contexts].sort((a, b) => a - b).join(',') : ''}:${scope.includeIdle ? 1 : 0}`, (signal) => source.profile(scope, signal), 'top')
  const segs = useMemo(() => traceSegmentsFrom(doc, profile.data ?? null, totalUs).filter((s) => s.us > 0), [doc, profile.data, totalUs])
  const top = [...segs].filter((s) => s.role !== 'unaccounted').sort((a, b) => b.us - a.us).slice(0, 3)
  const counts: Partial<Record<View, number>> = { statements: doc.statements.length, waits: doc.events.length, sessions: doc.contexts.length }
  const win = state.window
  return (
    <header className={'topbar' + (compare ? ' cmp' : '')}>
      <span className="brand">mtkprof</span>
      {compare && (
        <span className="seg side" role="group" aria-label="Trace shown by the views" title="trace shown in the views">
          {(['a', 'b'] as const).map((k) => (
            <button key={k} aria-pressed={state.side === k} onClick={() => actions.setSide(k)} title={(compare[k].file.traceFile || compare[k].file.path).split(/[\\/]/).pop()}>{k.toUpperCase()}</button>
          ))}
        </span>
      )}
      <span className="file mono" title={doc.file.traceFile || doc.file.path}>{name}<span className="dim"> · {fmtBytes(doc.diag.bytes)}</span></span>
      <span className="mini" title="whole-trace response time by class">
        <b>{fmtDur(totalUs)}</b>
        <span className="mini-track" role="img" aria-label={segs.map((s) => `${s.label} ${fmtPct(s.us, totalUs, 0)}`).join(', ')}>
          {segs.map((s) => <i key={s.role} className={s.role === 'unaccounted' ? 'unaccounted' : undefined} style={{ flex: `${s.us} 1 0`, background: s.role === 'unaccounted' ? undefined : `var(--c-${s.role})` }} />)}
        </span>
        <span className="dim">{top.map((s) => `${fmtPct(s.us, totalUs, 0)} ${s.label}`).join(' · ')}</span>
      </span>
      <nav className="tabs" aria-label="Views">
        {shownTabs.map((t) => (
          <button key={t.id} className="tab" aria-current={state.view === t.id ? 'page' : undefined} onClick={() => actions.setView(t.id)}>
            {t.label}{counts[t.id] !== undefined && <small>{counts[t.id]}</small>}
          </button>
        ))}
      </nav>
      <span className="chips">
        {win && <span className="chip">window {fmtDur(win.endTim - win.startTim)} <button onClick={() => actions.setWindow(null)} aria-label="Clear time window">×</button></span>}
        {state.contexts && <span className="chip">{state.contexts.size} session context{state.contexts.size === 1 ? '' : 's'} <button onClick={() => actions.setContexts(null)} aria-label="Clear context filter">×</button></span>}
      </span>
      <button className="quiet theme" onClick={() => actions.setTheme(themeNext[state.theme])} title={`theme: ${state.theme}`} aria-label={`Theme ${state.theme}`}>{themeGlyph[state.theme]}</button>
    </header>
  )
}

/** Where the trace came from: database, session, module, time span. */
export function SubBar({ doc }: { doc: TraceDoc }) {
  const c0 = doc.contexts[0]
  const switches = Math.max(0, doc.contexts.length - 1)
  return (
    <div className="subbar">
      {doc.file.version && <span>Oracle <b>{doc.file.version.replace(/\.0\.0\.0$/, '')}</b>{doc.file.instance && <> · instance <b>{doc.file.instance}</b>{doc.file.node && <> on {doc.file.node.split('.')[0]}</>}</>}</span>}
      {c0?.sessionId && <span>session <b>{c0.sessionId}</b>{c0.service && <> · service {c0.service}</>}{c0.clientDriver && <> · {c0.clientDriver}</>}</span>}
      {c0?.module && <span>module <b>{c0.module}</b>{switches > 0 && <> · {switches} context switch{switches === 1 ? '' : 'es'}</>}</span>}
      <span>
        {doc.span.firstWallUs
          ? <><b>{fmtWall(doc.span.firstWallUs, doc.tzOffsetMin, { date: true }).slice(0, 10)}</b> {fmtWall(doc.span.firstWallUs, doc.tzOffsetMin)} → {fmtWall(doc.span.lastWallUs, doc.tzOffsetMin)} {fmtTz(doc.tzOffsetMin)}</>
          : <>no wall clock</>}
      </span>
      {doc.file.truncated && <span className="warn">cut by max_dump_file_size</span>}
      {doc.file.continuedFrom?.length ? <span className="warn">continues an earlier file</span> : null}
    </div>
  )
}
