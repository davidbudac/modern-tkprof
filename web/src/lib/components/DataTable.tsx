import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { ariaSort, rowSelected, tableKeyTarget, toggleSort } from './keyNav'

export interface Column<T> {
  key: string
  header: string
  title?: string
  align?: 'start' | 'end'
  className?: string
  sort?: (row: T) => number | string
  render: (row: T) => ReactNode
  /** show an in-cell bar scaled to the max of this column (uses sort value) */
  bar?: boolean
  width?: string
}

export interface TableProps<T> {
  columns: Column<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  onRowClick?: (row: T, e?: React.MouseEvent) => void
  selectedKey?: string | number | null
  defaultSort?: { key: string; dir: 'asc' | 'desc' }
  rowHeight?: number
  maxHeight?: string
  footer?: ReactNode
  empty?: string
  className?: string
  /** accessible name of the grid (callers pass one); defaults to the first column's header */
  label?: string
}

/**
 * Sortable, virtualized table (an ARIA grid). Keyboard: Tab reaches the scroll area; on a table with a selection model
 * (`onRowClick` and `selectedKey`) Up/Down move the selection (unselected, they start at the first/last visible row) and
 * the new row is read out through a live region; a table whose click is an action (no `selectedKey`) just scrolls.
 * Each sortable header holds a button that toggles the sort.
 */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, selectedKey, defaultSort, rowHeight = 30, maxHeight = '60dvh', footer, empty = 'Nothing to show', className, label }: TableProps<T>) {
  const [sort, setSort] = useState(defaultSort ?? null)
  const sorted = useMemo(() => {
    if (!sort) return rows
    const col = columns.find((c) => c.key === sort.key)
    if (!col?.sort) return rows
    const f = col.sort
    const dir = sort.dir === 'asc' ? 1 : -1
    return [...rows].sort((a, b) => {
      const va = f(a), vb = f(b)
      if (va === vb) return 0
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * dir
      return String(va).localeCompare(String(vb)) * dir
    })
  }, [rows, sort, columns])
  const maxes = useMemo(() => {
    const m: Record<string, number> = {}
    for (const c of columns) if (c.bar && c.sort) m[c.key] = rows.reduce((acc, r) => Math.max(acc, Number(c.sort!(r)) || 0), 0)
    return m
  }, [rows, columns])
  const name = label ?? columns[0]?.header
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({ count: sorted.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 12 })
  const items = virt.getVirtualItems()
  const padTop = items.length ? items[0].start : 0
  const padBottom = items.length ? virt.getTotalSize() - items[items.length - 1].end : 0
  const toggle = (c: Column<T>) => {
    if (!c.sort) return
    setSort((s) => toggleSort(s, c.key, c.align))
  }
  const selectable = !!onRowClick && selectedKey !== undefined
  const live = useRef(false)
  const [said, setSaid] = useState('')
  const onKey = (e: React.KeyboardEvent) => {
    const t = e.target as HTMLElement
    const i = selectedKey == null ? -1 : sorted.findIndex((r) => rowKey(r) === selectedKey)
    const r = virt.range
    const to = tableKeyTarget({
      selectable, key: e.key, modified: e.altKey || e.ctrlKey || e.metaKey, defaultPrevented: e.defaultPrevented,
      target: { tagName: t.tagName, isContentEditable: t.isContentEditable, inHeader: !!t.closest?.('thead') },
      current: i, count: sorted.length, visible: r ? { start: r.startIndex, end: r.endIndex } : null,
    })
    if (to == null) return
    e.preventDefault()
    live.current = true
    onRowClick!(sorted[to])
    virt.scrollToIndex(to)
  }
  // focus stays on the scroll area, so a keyboard selection change is announced through a polite live region
  useEffect(() => {
    if (!live.current) return
    live.current = false
    const tr = scrollRef.current?.querySelector<HTMLTableRowElement>('tbody tr[aria-selected="true"]')
    if (!tr) return
    const n = Number(tr.getAttribute('aria-rowindex')) - 1
    setSaid(`Row ${n} of ${sorted.length}: ${Array.from(tr.cells, (c) => c.textContent?.trim()).filter(Boolean).join(', ')}`)
  }, [selectedKey, sorted.length])
  return (
    <div className={'tbl-wrap ' + (className ?? '')}>
      <div className="tbl-scroll" ref={scrollRef} style={{ maxBlockSize: maxHeight }} tabIndex={0} role="region" aria-label={name + ', scroll area'} onKeyDown={onKey}>
        <table className="tbl" role="grid" aria-label={name} aria-rowcount={sorted.length + 1}>
          <thead>
            <tr role="row" aria-rowindex={1}>
              {columns.map((c) => (
                <th key={c.key} className={[c.align === 'end' ? 'num' : '', c.className?.includes('mono') ? 'mono' : '', c.bar || /\b(clip|text)\b/.test(c.className ?? '') ? 'grow' : ''].join(' ').trim() || undefined} style={{ inlineSize: c.width }} title={c.title}
                  aria-sort={ariaSort(sort, c.key, !!c.sort)}
                  onClick={() => toggle(c)}>{c.sort ? <button type="button" className="tbl-sort">{c.header}</button> : c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && <tr style={{ height: padTop }} aria-hidden="true"><td colSpan={columns.length} style={{ padding: 0 }} /></tr>}
            {items.map((vi) => {
              const row = sorted[vi.index]
              const k = rowKey(row)
              return (
                <tr key={k} role="row" aria-rowindex={vi.index + 2} className={onRowClick ? 'row-click' : undefined} aria-selected={rowSelected(selectable, selectedKey, k)}
                  onClick={onRowClick ? (e) => onRowClick(row, e) : undefined} style={{ height: rowHeight }}>
                  {columns.map((c) => {
                    const cls = [c.align === 'end' ? 'num' : '', c.className ?? '', c.bar ? 'bar' : ''].join(' ').trim()
                    const v = c.bar && c.sort ? Number(c.sort(row)) || 0 : 0
                    return (
                      <td key={c.key} className={cls || undefined}>
                        {c.bar && maxes[c.key] > 0 && <i style={{ inlineSize: `${(100 * v) / maxes[c.key]}%` }} />}
                        {c.bar ? <span>{c.render(row)}</span> : c.render(row)}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            {padBottom > 0 && <tr style={{ height: padBottom }} aria-hidden="true"><td colSpan={columns.length} style={{ padding: 0 }} /></tr>}
          </tbody>
        </table>
        {sorted.length === 0 && <div className="tbl-empty">{empty}</div>}
        <div className="sr-only" role="status" aria-live="polite">{said}</div>
      </div>
      {footer && <div className="tbl-foot">{footer}</div>}
    </div>
  )
}
