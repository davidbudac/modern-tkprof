import { useMemo, useState } from 'react'
import type { TraceDoc } from '../data/doc'
import type { StmtStats } from '../data/types'
import { fmtDur, fmtInt, fmtPct, preview, fmtCompact } from '../data/format'
import { useStore, actions } from '../app/store'
import { DataTable, type Column } from '../components/DataTable'

export function Statements({ doc }: { doc: TraceDoc }) {
  const sel = useStore((s) => s.selection.stmt)
  const inclusive = useStore((s) => s.inclusive)
  const [q, setQ] = useState('')
  const [hideSys, setHideSys] = useState(false)
  const totalUs = doc.spanUs()
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    return doc.stats.statements.filter((s) => {
      if (s.allCalls.count === 0 && s.errors === 0) return false
      const st = doc.statements[s.id]
      if (hideSys && st.parsingUserId === 0 && s.minDepth > 0) return false
      if (needle && !(st.sqlId.toLowerCase().includes(needle) || st.text.toLowerCase().includes(needle))) return false
      return true
    })
  }, [doc, q, hideSys])
  const pick = (s: StmtStats, inc: keyof StmtStats['allCalls'], self: keyof StmtStats['allCalls']) => (inclusive ? s.allCalls[inc] : s.allCalls[self]) as number
  const cols: Column<StmtStats>[] = [
    { key: 'id', header: 'SQL ID', className: 'mono', render: (s) => doc.label(doc.statements[s.id]), sort: (s) => doc.label(doc.statements[s.id]) },
    { key: 'txt', header: 'Statement', className: 'clip', render: (s) => preview(doc.statements[s.id].text, 90), sort: (s) => doc.statements[s.id].text },
    { key: 'resp', header: 'Response', title: 'elapsed of the statement\'s calls plus idle time between them; recursive children included', align: 'end', render: (s) => fmtDur(s.elapsed + s.idleUs), sort: (s) => s.elapsed + s.idleUs, bar: true },
    { key: 'pct', header: '%', align: 'end', render: (s) => fmtPct(s.elapsed + s.idleUs, totalUs), sort: (s) => s.elapsed + s.idleUs },
    { key: 'self', header: 'Self', title: 'elapsed excluding recursive children and idle', align: 'end', render: (s) => fmtDur(s.selfElapsed), sort: (s) => s.selfElapsed },
    { key: 'cpu', header: 'CPU', align: 'end', render: (s) => fmtDur(inclusive ? s.cpu : s.selfCpu), sort: (s) => (inclusive ? s.cpu : s.selfCpu) },
    { key: 'wait', header: 'Waits', title: 'non-idle waits inside the calls', align: 'end', render: (s) => fmtDur(s.waitUs), sort: (s) => s.waitUs },
    { key: 'idle', header: 'Idle', title: 'SQL*Net message from client and other idle waits between the calls', align: 'end', render: (s) => fmtDur(s.idleUs), sort: (s) => s.idleUs },
    { key: 'x', header: 'Execs', align: 'end', render: (s) => fmtInt(s.executions), sort: (s) => s.executions },
    { key: 'rows', header: 'Rows', align: 'end', render: (s) => fmtCompact(s.allCalls.rows), sort: (s) => s.allCalls.rows },
    { key: 'disk', header: 'Disk', align: 'end', render: (s) => fmtCompact(pick(s, 'disk', 'selfDisk')), sort: (s) => pick(s, 'disk', 'selfDisk') },
    { key: 'cr', header: 'Query', align: 'end', render: (s) => fmtCompact(pick(s, 'query', 'selfQuery')), sort: (s) => pick(s, 'query', 'selfQuery') },
    { key: 'cu', header: 'Current', align: 'end', render: (s) => fmtCompact(pick(s, 'current', 'selfCurrent')), sort: (s) => pick(s, 'current', 'selfCurrent') },
    { key: 'mis', header: 'Hard', title: 'library cache misses during parse', align: 'end', render: (s) => (s.hardParses ? fmtInt(s.hardParses) : ''), sort: (s) => s.hardParses },
    { key: 'dep', header: 'Dep', align: 'end', render: (s) => (s.minDepth === s.maxDepth ? s.minDepth : `${s.minDepth}–${s.maxDepth}`), sort: (s) => s.minDepth },
    { key: 'err', header: 'Err', align: 'end', render: (s) => (s.errors ? s.errors : ''), sort: (s) => s.errors },
  ]
  const tot = rows.reduce((a, s) => ({ e: a.e + s.elapsed + s.idleUs, x: a.x + s.executions, r: a.r + s.allCalls.rows }), { e: 0, x: 0, r: 0 })
  return (
    <section className="section">
      <header>
        <h2>Statements</h2>
        <span className="hint">{rows.length} of {doc.statements.length}; click a row for details</span>
        <span className="tools">
          <input type="search" placeholder="filter sql_id or text" value={q} onChange={(e) => setQ(e.target.value)} />
          <button aria-pressed={hideSys} onClick={() => setHideSys(!hideSys)} title="hide recursive statements parsed by SYS">hide SYS recursive</button>
          <span className="seg" role="group" aria-label="Statistics mode">
            <button aria-pressed={!inclusive} onClick={() => actions.setInclusive(false)} title="exclude recursive children, like tkprof">self</button>
            <button aria-pressed={inclusive} onClick={() => actions.setInclusive(true)} title="include recursive children, as in the raw trace lines">inclusive</button>
          </span>
        </span>
      </header>
      <DataTable columns={cols} rows={rows} rowKey={(s) => s.id} defaultSort={{ key: 'resp', dir: 'desc' }} maxHeight="calc(100dvh - 12rem)"
        selectedKey={sel} onRowClick={(s) => actions.selectStmt(s.id)}
        footer={<><span>response {fmtDur(tot.e)}</span><span>executions {fmtInt(tot.x)}</span><span>rows {fmtInt(tot.r)}</span></>} />
    </section>
  )
}
