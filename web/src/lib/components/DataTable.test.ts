import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { DataTable, type Column } from './DataTable'
import { rowSelected } from './keyNav'

const cols: Column<{ n: number; t: string }>[] = [
  { key: 't', header: 'Text', sort: (r) => r.t, render: (r) => r.t },
  { key: 'n', header: 'Count', align: 'end', sort: (r) => r.n, render: (r) => String(r.n) },
  { key: 'x', header: 'Plain', render: () => '' },
]
const html = (props: object = {}) =>
  renderToStaticMarkup(createElement(DataTable<{ n: number; t: string }>, { columns: cols, rows: [], rowKey: (r) => r.t, ...props }))

describe('DataTable markup', () => {
  it('is a labelled grid, named after the first header unless the caller passes a label', () => {
    expect(html()).toContain('role="grid" aria-label="Text"')
    expect(html({ label: 'Waits by event' })).toContain('role="grid" aria-label="Waits by event"')
  })
  it('wraps sortable headers in a button and keeps aria-sort on the th', () => {
    const h = html({ defaultSort: { key: 'n', dir: 'desc' } })
    expect(h).toContain('aria-sort="none"><button type="button" class="tbl-sort">Text</button>')
    expect(h).toContain('aria-sort="descending"><button type="button" class="tbl-sort">Count</button>')
    expect(h).toMatch(/<th[^>]*>Plain<\/th>/)
    expect(h).not.toMatch(/<th[^>]*aria-sort[^>]*>Plain/)
  })
  it('keeps the scroll container a single labelled tab stop', () => {
    const h = html()
    expect(h).toContain('tabindex="0"')
    expect(h).toContain('role="region" aria-label="Text, scroll area"')
    expect(h.match(/tabindex=/g)).toHaveLength(1)
  })
  it('is a selection table only with both a click handler and a selectedKey (rows render in the browser, so the rule is the pure one)', () => {
    expect(rowSelected(true, 'b', 'b')).toBe('true')
    expect(rowSelected(true, 'b', 'a')).toBe('false')
    expect(rowSelected(true, null, 'a')).toBe('false')
    expect(rowSelected(false, undefined, 'a')).toBeUndefined()
  })
})
