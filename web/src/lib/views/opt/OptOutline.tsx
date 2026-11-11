import { memo, useEffect, useRef, type MouseEvent } from 'react'
import type { OptDumpInfo, OptFile, Opt10046Link } from '../../data/opt'
import type { DumpIndex, IxNode } from '../../data/optindex'
import { dumpLabel, nodeKey, ordinal, type OutlineMode } from '../../data/optoutline'
import { KIND_NAME } from '../../data/optguide'
import { hitsIn, type SearchResult } from '../../data/optsearch'
import { fmtInt } from '../../data/format'

interface Props {
  file: OptFile
  open: number
  ix: DumpIndex | null
  nodes: { n: IxNode; depth: number }[]
  exp: ReadonlySet<string>
  mode: OutlineMode
  curId: string | null
  search: SearchResult
  link10046?: Opt10046Link
  onDump(idx: number): void
  onNode(id: string): void
  onToggle(key: string): void
}

/** The outline: the dump list, and under the open dump its sections, full depth, in file order. */
export const OptOutline = memo(function OptOutline(p: Props) {
  const { file, open, ix, nodes, exp, mode, curId, search } = p
  const box = useRef<HTMLDivElement>(null)
  // the node holding the visible text stays in view
  useEffect(() => { box.current?.querySelector('.opt-ol-row.on')?.scrollIntoView({ block: 'nearest' }) }, [curId, ix])
  const sqlIds = new Map<string, number>()
  for (const d of file.dumps) sqlIds.set(d.sqlId, (sqlIds.get(d.sqlId) ?? 0) + 1)
  const hits = search.re ? search.hits : null

  const dumpRow = (d: OptDumpInfo) => {
    const isOpen = d.idx === open
    const h = isOpen && hits ? hitsIn(hits, d.viewFrom, d.viewTo) : 0
    const key = nodeKey(d.idx, ix?.root.id ?? 'n0')
    const showKids = isOpen && exp.has(key)
    const linked = p.link10046?.has(d.sqlId)
    return (
      <div key={`d${d.idx}`} className={'opt-ol-row opt-ol-dump' + (isOpen ? ' open' : '') + (isOpen && curId === null ? ' on' : '')} style={{ '--d': 0 } as React.CSSProperties}
        role="treeitem" aria-expanded={isOpen ? showKids : undefined} aria-selected={isOpen}
        onClick={() => p.onDump(d.idx)} title={`Dump ${d.idx + 1} of ${file.dumps.length}: lines ${fmtInt(d.viewFrom)}-${fmtInt(d.viewTo)}${d.truncated ? ' (truncated)' : ''}`}>
        <span className="opt-ol-x" onClick={(e: MouseEvent) => { if (isOpen) { e.stopPropagation(); p.onToggle(key) } }}>{isOpen ? (showKids ? '▾' : '▸') : '▸'}</span>
        <span className="opt-ol-main">
          <span className="opt-ol-l1">
            <span className="opt-ol-label">{d.sqlId || '(no sql_id)'}</span>
            <span className="opt-ol-k" title={sqlIds.get(d.sqlId)! > 1 ? `The ${ordinal(d.nth)} dump of this sql_id in the file` : undefined}>{dumpLabel(d, (sqlIds.get(d.sqlId) ?? 0) > 1)}</span>
            {d.truncated && <span className="opt-ol-tag" title="The file ended, or another dump began, before the dump's end line">truncated</span>}
            {h > 0 && <span className="opt-ol-hits" title={`${h} search ${h === 1 ? 'hit' : 'hits'}`}>{fmtInt(h)}</span>}
            <span className="opt-ol-n">{fmtInt(d.lineCount)}</span>
          </span>
          <span className="opt-ol-sql">{d.sqlStart.slice(0, 80)}</span>
          <span className="opt-ol-facts"><span className="opt-ol-facts-t">{d.tables.join(' · ')}{d.tables.length > 0 ? ' · ' : ''}{fmtInt(d.lineCount)} lines · plan hash {d.planHash || '—'}</span>
            {linked && <button type="button" className="link opt-ol-10046" title="This statement is in another open tab" onClick={(e) => { e.stopPropagation(); p.link10046?.open(d.sqlId) }}>10046</button>}
          </span>
        </span>
      </div>
    )
  }

  const nodeRow = ({ n, depth }: { n: IxNode; depth: number }) => {
    const has = n.kids.length > 0
    const key = nodeKey(ix!.dump.idx, n.id)
    const isOpen = exp.has(key)
    const h = hits ? hitsIn(hits, n.from, n.to) : 0
    const lines = n.to - n.from + 1
    const hitsEl = h > 0 && <span className="opt-ol-hits" title={`${h} search ${h === 1 ? 'hit' : 'hits'}`}>{fmtInt(h)}</span>
    const cnt = <span className="opt-ol-n" title={`${fmtInt(lines)} lines, ${fmtInt(n.from)}-${fmtInt(n.to)}`}>{fmtInt(lines)}</span>
    let l1: React.ReactNode
    let res: React.ReactNode = null
    let l2: React.ReactNode = null
    let l3: React.ReactNode = null
    let mono = false
    const dd = ix!
    if (n.kind === 'run') {
      const r = dd.runAt.get(n.id)
      l1 = <>
        <span className="opt-ol-label">{n.label}</span>
        {r?.final && <span className="opt-ol-tag final" title="Costed after “Final query after transformations”; the plan of the Result follows">final plan</span>}
        {!!r?.sameAs && <span className="opt-ol-tag same" title={`Its text equals run ${r.sameAs}'s, addresses and memory figures ignored; folded`}>same as run {r.sameAs}</span>}
      </>
      if (r?.verdict) l2 = <><span className={'opt-ol-dot ' + (r.verdict.kept ? 'kept' : 'rejected')} /><span className="mono" title={`${r.iter}: the verdict of the iteration it belongs to (line ${r.verdict.line})`}>{r.verdict.text}</span></>
      else if (r?.final) l2 = <span>after Final query after transformations, line {fmtInt(dd.finalQueryLine)}</span>
      if (mode === 'runs') l3 = <span>{r?.final && !r.iter ? `after Final query after transformations, line ${fmtInt(dd.finalQueryLine)}` : (n.iter && dd.byId.get(n.iter)?.label) || n.iterLabel || r?.iter || ''}</span>
    } else if (n.kind === 'iteration') {
      l1 = <span className="opt-ol-label">{n.label}</span>
      if (n.verdict) l2 = <><span className={'opt-ol-dot ' + (n.verdict.kept ? 'kept' : 'rejected')} /><span className="mono">{n.verdict.text.replace(/^\w+: /, '')}</span></>
    } else if (n.kind === 'join-order') {
      mono = true
      const aborted = n.result === 'aborted'
      l1 = <>
        <span className="opt-ol-label" title={n.label}>Join order[{n.n}]</span>
        {n.isBest && <span className="opt-ol-tag best" title={`The run's Final cost says: Best join order: ${n.n}`}>best</span>}
      </>
      res = <span className={'opt-ol-res' + (aborted ? ' rej' : '')}>{n.result}</span>
      l2 = <span className="mono" title={n.label}>{(n.tables ?? []).join('  ')}</span>
    } else if (n.kind === 'join-step' || n.kind === 'table') {
      mono = n.kind === 'join-step'
      l1 = <span className="opt-ol-label">{n.label}</span>
      if (n.result) res = <span className="opt-ol-res" title={`Best:: ${n.kind === 'table' ? 'AccessPath' : 'JoinMethod'}: ${n.result}`}>{n.result}</span>
    } else {
      l1 = <span className="opt-ol-label" title={n.label}>{n.label}</span>
    }
    const phase = n.kind.startsWith('phase-')
    return (
      <div key={n.id} className={'opt-ol-row' + (phase ? ' opt-ol-phase' : '') + (mono ? ' opt-ol-mono' : '') + (curId === n.id ? ' on' : '')} style={{ '--d': depth } as React.CSSProperties}
        role="treeitem" aria-level={depth + 1} aria-expanded={has ? isOpen : undefined} aria-selected={curId === n.id}
        onClick={() => { if (has && !isOpen) p.onToggle(key); p.onNode(n.id) }} title={`${KIND_NAME[n.kind] ?? n.kind}: lines ${fmtInt(n.from)}-${fmtInt(n.to)}`}>
        <span className="opt-ol-x" onClick={(e: MouseEvent) => { if (has) { e.stopPropagation(); p.onToggle(key) } }}>{has ? (isOpen ? '▾' : '▸') : ''}</span>
        <span className="opt-ol-main">
          <span className="opt-ol-l1">{l1}{hitsEl}{res}{cnt}</span>
          {l2 && <span className="opt-ol-l2">{l2}</span>}
          {l3 && <span className="opt-ol-l2 opt-ol-l3">{l3}</span>}
        </span>
      </div>
    )
  }

  const rows: React.ReactNode[] = []
  for (const d of file.dumps) {
    rows.push(dumpRow(d))
    if (d.idx === open) {
      if (!ix) rows.push(<div key="loading" className="opt-ol-note">Loading the dump…</div>)
      else if (exp.has(nodeKey(d.idx, ix.root.id))) for (const x of nodes) rows.push(nodeRow(x))
    }
  }
  return <div className="opt-ol" ref={box} role="tree" aria-label="Outline of the dumps">{rows}</div>
})
