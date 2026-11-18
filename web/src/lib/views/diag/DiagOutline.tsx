import { memo, useEffect, useRef, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react'
import type { DiagNode } from '../../data/diag'
import type { OutlineRow } from '../../data/diagoutline'
import { KIND_NAME } from '../../data/diagguide'
import { hitsIn } from '../../data/optsearch'
import { fmtInt } from '../../data/format'
import { focusRow, listKey } from '../opt/listKeys'

interface Props {
  rows: readonly OutlineRow[]
  /** the selected node */
  selected: string | null
  /** the nodes that hold the line the text shows, outermost first (their labels are set a little heavier) */
  path: ReadonlySet<string>
  /** the lines that match the search, ascending; null for no search */
  hits: ArrayLike<number> | null
  /** the standalone report: what is not in it is said, not asked for */
  digest: boolean
  onSelect(id: string): void
  onToggle(id: string): void
  onMore(parent: string): void
}

const ROWS = '.opt-ol-row'

/** The most a heap dump's depth indents its row. */
const MAX_HEAP_INDENT = 6

/**
 * A heap dump of the top level is indented by the depth its header gives ("dsx heap depth"), so the sub-heaps of a dump run read as children of their heap
 * (the dump lists them one after another, flat, as the file does). A nested node keeps the level its place in the tree gives it.
 */
export function heapIndent(n: DiagNode, depth: number): number {
  return depth === 0 && n.kind === 'heap' && n.depth ? Math.min(n.depth, MAX_HEAP_INDENT) : 0
}

/**
 * The outline: the nodes of the file in file order, the top level and what was opened below it, with their line counts and, while a search is on,
 * the hits inside each. The children of a node come when it is opened, in pages; a row at the end of a page that is not the last loads the next.
 * The keys are those of the 10053 outline: ArrowUp / ArrowDown move between the rows, ArrowRight opens, ArrowLeft closes or goes to the parent,
 * Enter selects.
 */
export const DiagOutline = memo(function DiagOutline(p: Props) {
  const { rows, selected, path, hits } = p
  const box = useRef<HTMLDivElement>(null)
  // the node holding the visible text stays in view
  useEffect(() => { box.current?.querySelector('.opt-ol-row.on')?.scrollIntoView({ block: 'nearest' }) }, [selected])

  const rowKeys = (e: KeyboardEvent<HTMLElement>, o: { activate(): void; isOpen?: boolean; has?: boolean; toggle?(): void; level: number }) => {
    if (listKey(e, { activate: o.activate, move: (step) => focusRow(box.current, ROWS, e.currentTarget, step) })) return
    if (e.target !== e.currentTarget || e.altKey || e.ctrlKey || e.metaKey) return
    if (e.key === 'ArrowRight' && o.has) {
      e.preventDefault()
      if (!o.isOpen) o.toggle?.(); else focusRow(box.current, ROWS, e.currentTarget, 1)
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault()
      if (o.has && o.isOpen) o.toggle?.()
      else { // to the parent: the nearest row above with a lower level
        const all = [...(box.current?.querySelectorAll<HTMLElement>(ROWS) ?? [])]
        for (let k = all.indexOf(e.currentTarget) - 1; k >= 0; k--) if (Number(all[k].getAttribute('aria-level')) < o.level) { all[k].focus(); break }
      }
    }
  }

  // one row is in the tab order: the selected node's, else the first
  const firstNode = rows.findIndex((r) => r.t === 'node')
  const tabbable = rows.findIndex((r) => r.t === 'node' && r.node.id === selected)
  const tabAt = tabbable >= 0 ? tabbable : firstNode

  const nodeRow = (r: Extract<OutlineRow, { t: 'node' }>, i: number) => {
    const n: DiagNode = r.node
    const on = n.id === selected
    const h = hits ? hitsIn(hits, n.from, n.to) : 0
    const has = n.hasChildren
    const title = `${KIND_NAME[n.kind] ?? n.kind}: lines ${fmtInt(n.from)}-${fmtInt(n.to)}${n.cut ? ' (no end line)' : ''}`
    const sub = n.kind === 'trace10046' ? `${fmtInt(n.records ?? 0)} records` : n.sub
    const level = r.depth + heapIndent(n, r.depth)
    return (
      <div key={n.id} className={'opt-ol-row' + (on ? ' on' : '') + (path.has(n.id) ? ' inpath' : '')} style={{ '--d': level } as CSSProperties}
        role="treeitem" aria-level={level + 1} aria-expanded={has ? r.open : undefined} aria-selected={on} tabIndex={i === tabAt ? 0 : -1} data-node={n.id}
        onKeyDown={(e) => rowKeys(e, { activate: () => p.onSelect(n.id), has, isOpen: r.open, toggle: () => p.onToggle(n.id), level: level + 1 })}
        onClick={() => p.onSelect(n.id)} title={title}>
        <span className="opt-ol-x" onClick={(e: MouseEvent) => { if (has) { e.stopPropagation(); p.onToggle(n.id) } }}>{has ? (r.open ? '▾' : '▸') : ''}</span>
        <span className="opt-ol-main">
          <span className="opt-ol-l1">
            <span className="opt-ol-label">{n.title}</span>
            {n.cut && <span className="opt-ol-tag" title="The file ended, or a line of another format came, before this dump's end line">no end line</span>}
            {h > 0 && <span className="opt-ol-hits" title={`${h} search ${h === 1 ? 'hit' : 'hits'}`}>{fmtInt(h)}</span>}
            <span className="opt-ol-n" title={`${fmtInt(n.lines)} lines, ${fmtInt(n.from)}-${fmtInt(n.to)}`}>{fmtInt(n.lines)}</span>
          </span>
          {sub && <span className="opt-ol-l2"><span>{sub}</span></span>}
        </span>
      </div>
    )
  }

  return (
    <div className="opt-ol dg-ol" ref={box} role="tree" aria-label="Outline of the file">
      {rows.map((r, i) => {
        if (r.t === 'node') return nodeRow(r, i)
        const style = { '--d': r.depth } as CSSProperties
        if (r.t === 'more') {
          return (
            <div key={`more:${r.parent}`} className="opt-ol-row dg-ol-more" style={style} role="treeitem" aria-level={r.depth + 1} tabIndex={-1} aria-selected={false}
              onClick={() => { if (!r.loading) p.onMore(r.parent) }} onKeyDown={(e) => listKey(e, { activate: () => p.onMore(r.parent), move: (step) => focusRow(box.current, ROWS, e.currentTarget, step) })}>
              <span className="opt-ol-x" />
              <span className="opt-ol-main">
                <span className="opt-ol-l1">
                  <span className={'opt-ol-label' + (r.error ? ' dg-err' : '')}>{r.loading ? 'Loading…' : r.error ? `${r.error} · try again` : `${fmtInt(r.shown)} of ${fmtInt(r.total)} shown · load more`}</span>
                </span>
              </span>
            </div>
          )
        }
        return (
          <div key={`note:${r.parent}`} className={'opt-ol-note' + (r.error ? ' dg-err' : '')} style={{ '--d': r.depth } as CSSProperties} role="none">{r.text}</div>
        )
      })}
    </div>
  )
})
