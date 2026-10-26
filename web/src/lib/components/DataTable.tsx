import { useMemo, useRef, useState, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'

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
}

/** Sortable, virtualized table. Keyboard: Up/Down move the selection. */
export function DataTable<T>({ columns, rows, rowKey, onRowClick, selectedKey, defaultSort, rowHeight = 30, maxHeight = '60dvh', footer, empty = 'Nothing to show', className }: TableProps<T>) {
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const virt = useVirtualizer({ count: sorted.length, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 12 })
  const items = virt.getVirtualItems()
  const padTop = items.length ? items[0].start : 0
  const padBottom = items.length ? virt.getTotalSize() - items[items.length - 1].end : 0
  const toggle = (c: Column<T>) => {
    if (!c.sort) return
    setSort((s) => (s && s.key === c.key ? { key: c.key, dir: s.dir === 'desc' ? 'asc' : 'desc' } : { key: c.key, dir: c.align === 'end' ? 'desc' : 'asc' }))
  }
  const onKey = (e: React.KeyboardEvent) => {
    if (!onRowClick || selectedKey == null) return
    const i = sorted.findIndex((r) => rowKey(r) === selectedKey)
    if (e.key === 'ArrowDown' && i < sorted.length - 1) { onRowClick(sorted[i + 1]); e.preventDefault(); virt.scrollToIndex(i + 1) }
    if (e.key === 'ArrowUp' && i > 0) { onRowClick(sorted[i - 1]); e.preventDefault(); virt.scrollToIndex(i - 1) }
  }
  return (
    <div className={'tbl-wrap ' + (className ?? '')}>
      <div className="tbl-scroll" ref={scrollRef} style={{ maxBlockSize: maxHeight }} tabIndex={0} onKeyDown={onKey}>
        <table className="tbl">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={[c.align === 'end' ? 'num' : '', c.className?.includes('mono') ? 'mono' : '', c.bar || /\b(clip|text)\b/.test(c.className ?? '') ? 'grow' : ''].join(' ').trim() || undefined} style={{ inlineSize: c.width }} title={c.title}
                  aria-sort={sort?.key === c.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}
                  onClick={() => toggle(c)}>{c.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {padTop > 0 && <tr style={{ height: padTop }} aria-hidden="true"><td colSpan={columns.length} style={{ padding: 0 }} /></tr>}
            {items.map((vi) => {
              const row = sorted[vi.index]
              const k = rowKey(row)
              return (
                <tr key={k} className={onRowClick ? 'row-click' : undefined} aria-selected={selectedKey === k ? 'true' : undefined}
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
      </div>
      {footer && <div className="tbl-foot">{footer}</div>}
    </div>
  )
}
