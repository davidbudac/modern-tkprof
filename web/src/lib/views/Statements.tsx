import { useEffect, useMemo, useRef, useState } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TraceDoc } from '../data/doc'
import { StmtLink } from '../components/StmtLink'
import type { StmtStats } from '../data/types'
import { fmtDur, fmtInt, fmtPct, preview, fmtCompact } from '../data/format'
import { useStore, useActions } from '../state/session'
import { quickSegments } from '../data/derive'
import { sourceOf, useSourceQuery } from '../data/source'
import { StatementDetail } from './StatementDetail'
import { StatementContext } from './StatementContext'
import { ResizeHandle } from '../components/ResizeHandle'
import { PaneToggle } from '../components/PaneToggle'
import { usePersisted } from '../state/persist'
import type { CSSProperties } from 'react'

type SortKey = 'resp' | 'self' | 'cpu' | 'waits' | 'idle' | 'execs' | 'rows' | 'disk' | 'query' | 'hard' | 'errors'
const sorts: { id: SortKey; label: string; of: (s: StmtStats, inclusive: boolean) => number }[] = [
  { id: 'resp', label: 'response time', of: (s) => s.elapsed + s.idleUs },
  { id: 'self', label: 'self time', of: (s) => s.selfElapsed },
  { id: 'cpu', label: 'CPU', of: (s, inc) => (inc ? s.cpu : s.selfCpu) },
  { id: 'waits', label: 'wait time', of: (s) => s.waitUs },
  { id: 'idle', label: 'idle time', of: (s) => s.idleUs },
  { id: 'execs', label: 'executions', of: (s) => s.executions },
  { id: 'rows', label: 'rows', of: (s) => s.allCalls.rows },
  { id: 'disk', label: 'disk reads', of: (s, inc) => (inc ? s.allCalls.disk : s.allCalls.selfDisk) },
  { id: 'query', label: 'consistent gets', of: (s, inc) => (inc ? s.allCalls.query : s.allCalls.selfQuery) },
  { id: 'hard', label: 'hard parses', of: (s) => s.hardParses },
  { id: 'errors', label: 'errors', of: (s) => s.errors },
]
const ROW_H = 76

/** Three panes: ranked statement list, the selected statement, its context. */
export function Statements({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const sel = useStore((s) => s.selection.stmt)
  const inclusive = useStore((s) => s.inclusive)
  const [q, setQ] = useState('')
  const [hideSys, setHideSys] = useState(false)
  const [sortKey, setSortKey] = useState<SortKey>('resp')
  const [listW, setListW] = usePersisted<number | null>('mtkprof.listW', null)
  const [ctxW, setCtxW] = usePersisted<number | null>('mtkprof.contextW', null)
  const [ctxOpen, setCtxOpen] = usePersisted<boolean>('mtkprof.contextOpen', true)
  const totalUs = doc.spanUs()
  const source = sourceOf(doc)
  const roles = useSourceQuery(source, 'roles', (signal) => source.stmtRoles(signal)).data
  const sort = sorts.find((s) => s.id === sortKey)!
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase()
    const list = doc.stats.statements.filter((s) => {
      if (s.allCalls.count === 0 && s.errors === 0) return false
      const st = doc.statements[s.id]
      if (hideSys && st.parsingUserId === 0 && s.minDepth > 0) return false
      if (needle && !(st.sqlId.toLowerCase().includes(needle) || st.text.toLowerCase().includes(needle))) return false
      return true
    })
    return list.sort((a, b) => sort.of(b, inclusive) - sort.of(a, inclusive) || b.elapsed - a.elapsed)
  }, [doc, q, hideSys, sort, inclusive])
  const maxResp = rows.reduce((a, s) => Math.max(a, s.elapsed + s.idleUs), 0)
  const findingsOf = useMemo(() => { const m = new Map<number, number>(); for (const f of doc.stats.findings) if (f.statement >= 0) m.set(f.statement, (m.get(f.statement) ?? 0) + 1); return m }, [doc])

  useEffect(() => { if ((sel === null || !doc.stats.statements[sel]) && rows.length) actions.pickStmt(rows[0].id) }, [rows, sel, doc])

  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({ count: rows.length, getScrollElement: () => scrollRef.current, estimateSize: () => ROW_H, overscan: 10 })
  const move = (d: number) => {
    const i = rows.findIndex((r) => r.id === sel)
    const j = Math.min(rows.length - 1, Math.max(0, i + d))
    if (rows[j]) { actions.pickStmt(rows[j].id); virt.scrollToIndex(j) }
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT') return
      if (e.key === 'j' || e.key === 'ArrowDown') { move(1); e.preventDefault() }
      if (e.key === 'k' || e.key === 'ArrowUp') { move(-1); e.preventDefault() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  return (
    <div className={'wb' + (ctxOpen ? '' : ' ctx-closed')} style={{ ...(listW ? { '--list-w': `${listW}px` } : null), ...(ctxW ? { '--context-w': `${ctxW}px` } : null) } as CSSProperties}>
      <aside className="wb-list" aria-label="Statements">
        <div className="wb-head">
          <div className="t"><h2>Statements</h2><span className="dim">{rows.length === doc.statements.length ? rows.length : `${rows.length} of ${doc.statements.length}`}</span></div>
          <input type="search" placeholder="filter by sql_id or text" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="opts">
            <label>by <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)}>{sorts.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}</select></label>
            <span className="seg" role="group" aria-label="Statistics mode">
              <button aria-pressed={!inclusive} onClick={() => actions.setInclusive(false)} title="exclude recursive children, like tkprof">self</button>
              <button aria-pressed={inclusive} onClick={() => actions.setInclusive(true)} title="include recursive children">inclusive</button>
            </span>
            <button className={'quiet' + (hideSys ? ' on' : '')} aria-pressed={hideSys} onClick={() => setHideSys(!hideSys)} title="hide recursive statements parsed by SYS">no SYS</button>
          </div>
        </div>
        <div className="wb-scroll" ref={scrollRef}>
          <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
            {virt.getVirtualItems().map((vi) => {
              const st = rows[vi.index]
              const s = doc.statements[st.id]
              const resp = st.elapsed + st.idleUs
              const segs = quickSegments(doc, st, roles).filter((x) => x.us > 0)
              const segTotal = Math.max(resp, segs.reduce((a, x) => a + x.us, 0))
              const nf = findingsOf.get(st.id) ?? 0
              return (
                <div key={st.id} className={'item' + (sel === st.id ? ' on' : '')} style={{ position: 'absolute', top: vi.start, height: ROW_H, left: 0, right: 0 }}
                  onClick={() => actions.pickStmt(st.id)} role="button" tabIndex={-1}>
                  <div className="txt mono" title={preview(s.text, 300)}>{preview(s.text, 120)}</div>
                  <div className="bar" style={{ width: `${(100 * resp) / (maxResp || 1)}%` }}>{segs.map((x) => <i key={x.role} style={{ width: `${(100 * x.us) / segTotal}%`, background: `var(--c-${x.role})` }} />)}</div>
                  <div className="n">{sortKey === 'resp' || sortKey === 'self' || sortKey === 'cpu' || sortKey === 'waits' || sortKey === 'idle' ? fmtDur(sort.of(st, inclusive)) : fmtCompact(sort.of(st, inclusive))}<small>{sortKey === 'resp' ? fmtPct(resp, totalUs, 0) : fmtDur(resp)}</small></div>
                  <div className="id">
                    <StmtLink doc={doc} id={st.id} />
                    <span>{fmtInt(st.executions)} exec{st.executions === 1 ? '' : 's'}</span>
                    {st.allCalls.rows > 0 && <span>{fmtCompact(st.allCalls.rows)} row{st.allCalls.rows === 1 ? '' : 's'}</span>}
                    {st.minDepth > 0 && <span>depth {st.minDepth}</span>}
                    {st.errors > 0 && <span className="err">{st.errors} error{st.errors === 1 ? '' : 's'}</span>}
                    {nf > 0 && <span className="fl" title={`${nf} finding${nf === 1 ? '' : 's'}`}>ⓘ {nf}</span>}
                  </div>
                </div>
              )
            })}
          </div>
          {rows.length === 0 && <p className="muted small" style={{ padding: '1rem' }}>No match.</p>}
        </div>
      </aside>
      <section className="wb-detail">
        {sel !== null && doc.statements[sel] ? <StatementDetail doc={doc} id={sel} /> : <p className="muted">No statement selected.</p>}
      </section>
      {ctxOpen && <aside className="wb-ctx" aria-label="Context">
        {sel !== null && doc.statements[sel] && <StatementContext doc={doc} id={sel} />}
      </aside>}
      <ResizeHandle anchor="start" className="resizer-list" label="Resize statement list" min={240} maxFrac={0.4} onChange={setListW} />
      {ctxOpen && <ResizeHandle anchor="end" className="resizer-ctx" label="Resize context pane" min={240} maxFrac={0.4} onChange={setCtxW} />}
      <PaneToggle open={ctxOpen} onToggle={() => setCtxOpen(!ctxOpen)} label="context pane" className="ctx-toggle" />
    </div>
  )
}
