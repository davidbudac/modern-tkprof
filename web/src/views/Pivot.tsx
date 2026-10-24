import { useMemo, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import { StmtLink } from '../components/StmtLink'
import { fmtInt } from '../data/format'
import { useStore, actions, scopeOf, type State } from '../app/store'
import { DataTable, type Column } from '../components/DataTable'
import { ColumnChooser } from '../components/ColumnChooser'
import { usePersisted } from '../app/persist'
import { pivotDims, pivotMeasures, type Fact } from '../data/pivot'
import { sourceOf, useSourceQuery, type PivotRowData } from '../data/source'
import '../styles/pivot.css'

const CAP = 1000

function scopeHint(state: State, fact: Fact): string {
  const parts: string[] = []
  if (state.window) parts.push('window')
  if (state.contexts) parts.push(`${state.contexts.size} context${state.contexts.size === 1 ? '' : 's'}`)
  if (fact === 'waits' && !state.includeIdle) parts.push('idle hidden')
  return parts.join(' · ')
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
  const source = sourceOf(doc)
  const [fact, setFact] = useState<Fact>('calls')
  const [d1Id, setD1] = useState('stmt')
  const [d2Id, setD2] = useState('')
  const [hiddenCols, setHiddenCols] = usePersisted<Record<Fact, string[]>>('mtkprof.cols.pivot', { calls: [], waits: [] })
  const [sortId, setSortId] = useState<{ calls: string; waits: string }>({ calls: 'e', waits: 'ela' })

  // dimension metadata; with a remote source the fact columns are empty and only ids, labels and click targets are read
  const dims = useMemo(() => pivotDims(doc, fact), [doc, fact])
  const measures = pivotMeasures(fact)
  const d1 = dims.find((d) => d.id === d1Id) ?? dims[0]
  const d2 = d2Id && d2Id !== d1.id ? dims.find((d) => d.id === d2Id) ?? null : null
  const sortM = measures.find((m) => m.id === sortId[fact]) ?? measures[1]

  const scope = scopeOf(state)
  const scopeKey = `${scope.window ? `${scope.window.startTim}:${scope.window.endTim}` : ''}|${scope.contexts ? [...scope.contexts].sort((a, b) => a - b).join(',') : ''}|${fact === 'waits' && scope.includeIdle ? 1 : 0}`
  const shape = `${fact}:${d1.id}:${d2?.id ?? ''}`
  const query = useSourceQuery(source, `${shape}:${sortM.id}:${scopeKey}`,
    (signal) => (source.ready ? source.pivot({ fact, by: d2 ? [d1.id, d2.id] : [d1.id], scope, sort: sortM.id, limit: CAP }, signal) : null),
    shape)
  const result = query.data

  if (!source.ready) {
    return (
      <section className="section">
        <header><h2>Pivot</h2></header>
        <p className="callout">No fact tables (<code>-facts=false</code>) and no server. Regenerate with facts or open with <code>mtkprof serve -facts=false</code>.</p>
      </section>
    )
  }
  if (!result) {
    return (
      <section className="section">
        <header><h2>Pivot</h2><span className="hint">{query.error ? `failed: ${query.error}` : 'loading…'}</span></header>
        {query.error && <p className="callout">{query.error}</p>}
      </section>
    )
  }
  const total = result.total
  const rows = result.rows
  const keyOf = (g: PivotRowData) => g.keys.join(':')

  const onFact = (f: Fact) => {
    if (f === fact) return
    setFact(f)
    setD1(f === 'calls' ? 'stmt' : 'event')
    setD2('')
  }

  const cols: Column<PivotRowData>[] = [
    { key: 'd1', header: d1.label, className: d1.mono ? 'mono clip' : 'clip', render: (g) => d1.id === 'stmt' && doc.statements[g.keys[0]] ? <StmtLink doc={doc} id={g.keys[0]} /> : g.labels[0], sort: (g) => g.labels[0] },
  ]
  if (d1.extra) cols.push({ key: 'd1x', header: d1.extra.header, className: 'clip', render: (g) => g.extra[0], sort: (g) => g.extra[0] })
  if (d2) {
    cols.push({ key: 'd2', header: d2.label, className: d2.mono ? 'mono clip' : 'clip', render: (g) => d2.id === 'stmt' && doc.statements[g.keys[1]] ? <StmtLink doc={doc} id={g.keys[1]} /> : g.labels[1], sort: (g) => g.labels[1] })
    if (d2.extra) cols.push({ key: 'd2x', header: d2.extra.header, className: 'clip', render: (g) => g.extra[1], sort: (g) => g.extra[1] })
  }
  const hiddenM = hiddenCols[fact] ?? []
  const shownMeasures = measures.filter((m) => !hiddenM.includes(m.id))
  for (const m of shownMeasures) {
    const k = measures.indexOf(m)
    cols.push({ key: m.id, header: m.label, title: m.title, align: 'end', render: (g) => m.fmt(g.values[k]), sort: (g) => g.values[k], bar: m.id === sortM.id })
  }

  const onRow = (g: PivotRowData) => {
    if (d1.click === 'stmt' && g.keys[0] >= 0) actions.selectStmt(g.keys[0])
    else if (d1.click === 'event' && g.keys[0] >= 0) actions.selectEvent(g.keys[0])
  }
  const selectedKey = d1.click === 'stmt' && state.selection.stmt !== null ? rows.find((g) => g.keys[0] === state.selection.stmt)?.keys.join(':') ?? null
    : d1.click === 'event' && state.selection.event !== null ? rows.find((g) => g.keys[0] === state.selection.event)?.keys.join(':') ?? null
    : null

  const exportCsv = async () => {
    // every group, not just the rows on screen
    const all = result.groups > rows.length ? await Promise.resolve(source.pivot({ fact, by: d2 ? [d1.id, d2.id] : [d1.id], scope, sort: sortM.id, limit: Infinity })) : result
    const header = [d1.label, ...(d1.extra ? [d1.extra.header] : []), ...(d2 ? [d2.label, ...(d2.extra ? [d2.extra.header] : [])] : []), ...measures.map((m) => m.label)]
    const lines = [header.map(csvCell).join(',')]
    for (const g of all.rows) {
      const cells: (string | number)[] = [g.labels[0]]
      if (d1.extra) cells.push(g.extra[0])
      if (d2) { cells.push(g.labels[1]); if (d2.extra) cells.push(g.extra[1]) }
      for (let k = 0; k < measures.length; k++) cells.push(g.values[k])
      lines.push(cells.map(csvCell).join(','))
    }
    download('mtkprof-pivot.csv', '\ufeff' + lines.join('\n') + '\n')
  }

  const hint = scopeHint(state, fact)
  const capped = result.groups > rows.length
  return (
    <section className="section">
      <header>
        <h2>Pivot</h2>
        <span className="hint">
          {fmtInt(result.facts)} {fact} in {fmtInt(result.groups)} group{result.groups === 1 ? '' : 's'}
          {hint ? ` · ${hint}` : ''}
          {capped ? ` · top ${fmtInt(rows.length)} shown` : ''}
          {source.remote ? ' · server' : ''}
          {query.loading ? ' · loading…' : ''}
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
        <span className="pv-push"><ColumnChooser all={measures.map((m) => ({ key: m.id, label: m.label }))} hidden={hiddenM} onChange={(h) => setHiddenCols({ ...hiddenCols, [fact]: h })} /></span>
        <button onClick={exportCsv} disabled={result.groups === 0}>Download CSV</button>
      </div>
      <DataTable
        key={`${fact}:${d1.id}:${d2?.id ?? ''}:${sortM.id}:${hiddenM.join(',')}`}
        columns={cols}
        rows={rows}
        rowKey={keyOf}
        defaultSort={{ key: sortM.id, dir: 'desc' }}
        maxHeight="calc(100dvh - 15rem)"
        selectedKey={selectedKey}
        onRowClick={d1.click ? onRow : undefined}
        empty="No rows in scope"
        footer={<>
          <span>total</span>
          {shownMeasures.map((m) => <span key={m.id}>{m.label} {m.id === 'share' ? '100%' : m.fmt(total[measures.indexOf(m)])}</span>)}
        </>}
      />
    </section>
  )
}
