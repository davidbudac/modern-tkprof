import { useEffect, useMemo, useReducer, useRef, type CSSProperties, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TraceDoc } from '../data/doc'
import { fmtDur, fmtInt } from '../data/format'
import { ALL_SCOPE } from '../data/lines'
import { cursorMatcher, outlineOf, rowAt, rowsOf, type ExecInfo, type OutlineCursor, type OutlineRow } from '../data/outline'
import { sourceOf } from '../data/source'
import type { ID } from '../data/types'

const ROW_H = 22

/** What the outline keeps while the popover is closed: the keys of the open nodes and the filter text. */
export interface OutlineState { open: Set<string>; filter: string }

/** The executions of a statement as fetched once: every row, to be narrowed per cursor. */
type Fetched = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ok'; partial: boolean; rows: { cursor: ID; execNo: number; e: number; line: number }[] }

/**
 * The tree of the open file: session markers → the cursors parsed under them (recursive ones folded under their parent) → the
 * executions of a cursor, fetched when its node opens. A click on a node goes to its line; the node holding `selected` is highlighted.
 */
export function LinesOutline({ doc, file, selected, state, onState, onGo }: {
  doc: TraceDoc; file: number; selected: number; state: OutlineState; onState(s: OutlineState): void; onGo(line: number): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const [, bump] = useReducer((x: number) => x + 1, 0)
  const tree = useMemo(() => outlineOf(doc, file), [doc, file])
  const fetched = useMemo(() => new Map<ID, Fetched>(), [doc])
  const match = useMemo(() => cursorMatcher(doc, state.filter), [doc, state.filter])
  const execsOf = (c: OutlineCursor): ExecInfo | undefined => {
    const f = fetched.get(c.stmt)
    if (!f || f.status !== 'ok') return f
    return { status: 'ok', partial: f.partial, rows: f.rows.filter((r) => r.cursor === c.id).sort((a, b) => a.execNo - b.execNo) }
  }
  const rows = rowsOf(tree, state.open, match, execsOf)

  // fetch the executions of each open cursor's statement once (also for nodes that were left open before the menu closed)
  useEffect(() => {
    const source = sourceOf(doc)
    for (const r of rows) {
      if (r.type !== 'cursor' || !r.open || fetched.has(r.node.stmt)) continue
      const stmt = r.node.stmt
      fetched.set(stmt, { status: 'loading' })
      Promise.resolve(source.executions(stmt, ALL_SCOPE)).then(
        (page) => { fetched.set(stmt, { status: 'ok', partial: page.partial, rows: page.rows.map((x) => ({ cursor: x.cursor, execNo: x.execNo, e: x.e, line: x.line })) }); bump() },
        (e: unknown) => { fetched.set(stmt, { status: 'error', message: e instanceof Error ? e.message : String(e) }); bump() },
      )
    }
  })

  const v = useVirtualizer({ count: rows.length, getScrollElement: () => box.current, estimateSize: () => ROW_H, overscan: 12 })
  const on = rowAt(rows, selected)
  // keep the highlighted node in view as the selection moves
  useEffect(() => { if (on >= 0) v.scrollToIndex(on, { align: 'auto' }) }, [selected]) // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (key: string) => {
    const open = new Set(state.open)
    if (!open.delete(key)) open.add(key)
    onState({ ...state, open })
  }
  const key = (e: KeyboardEvent, go: () => void) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); go() } }

  const row = (r: OutlineRow) => {
    if (r.type === 'note') return <span className="muted">{r.text}</span>
    if (r.type === 'ctx') return <><b className="ol-text">{r.text}</b><span className="ol-line">{fmtInt(r.line)}</span></>
    if (r.type === 'exec') return <><span className="ol-text">{r.text}</span><span className="ol-line">{fmtInt(r.line)}</span></>
    if (r.type === 'more') return <><span className="ol-x">▸</span><span className="muted">{r.n} recursive cursor{r.n === 1 ? '' : 's'}</span></>
    const c = r.node
    return (
      <>
        {r.expandable
          ? <button type="button" className="quiet ol-x" aria-label={r.open ? 'Collapse' : 'Expand'} aria-expanded={r.open} onClick={(e) => { e.stopPropagation(); toggle(r.key) }}>{r.open ? '▾' : '▸'}</button>
          : <span className="ol-x" />}
        <span className="ol-cur">#{c.number}</span>
        <small className="muted ol-dep">dep {c.depth}</small>
        <span className="mono ol-id" title={`cursor #${c.number} · depth ${c.depth}`}>{c.sqlId}</span>
        <span className="ol-text muted" title={c.text}>{c.text}</span>
        <small className="muted ol-n">{fmtInt(c.execs)}×</small>
        <small className="muted ol-n">{fmtDur(c.elapsed)}</small>
        <span className="ol-line">{fmtInt(r.line)}</span>
      </>
    )
  }

  return (
    <div className="lines-outline">
      <input type="search" className="ol-filter" value={state.filter} placeholder="Filter cursors by sql_id or text" aria-label="Filter the outline"
        onChange={(e) => onState({ ...state, filter: e.target.value })} />
      {rows.length === 0
        ? <p className="small muted lines-empty">{match ? 'No cursor matches.' : 'No session markers or cursors with a line in this file.'}</p>
        : (
          <div className="lines-ol" ref={box} role="tree" aria-label="Outline of the file">
            <div style={{ blockSize: v.getTotalSize(), position: 'relative' }}>
              {v.getVirtualItems().map((it) => {
                const r = rows[it.index]
                if (!r) return null
                const go = r.type === 'note' ? undefined : r.type === 'more' ? () => toggle(r.of) : () => onGo(r.line)
                return (
                  <div key={r.key} role={r.type === 'note' ? 'none' : 'treeitem'} aria-level={r.depth + 1} aria-selected={it.index === on}
                    aria-expanded={r.type === 'cursor' && r.expandable ? r.open : undefined} tabIndex={go ? 0 : undefined}
                    className={'ol-row ol-' + r.type + (it.index === on ? ' on' : '')}
                    style={{ position: 'absolute', insetBlockStart: 0, insetInline: 0, blockSize: ROW_H, transform: `translateY(${it.start}px)`, '--d': r.depth } as CSSProperties}
                    onClick={go} onKeyDown={go ? (e) => key(e, go) : undefined}>
                    {row(r)}
                  </div>
                )
              })}
            </div>
          </div>
        )}
    </div>
  )
}
