import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TraceDoc } from '@lib'
import { pickOf, pickerRows, stmtChoices } from './cutstate'
import { StmtPicker } from './StmtPicker'

// a document of n statements, statement i taking (n - i) ms; every tenth has no sql_id (an anonymous block), statement 7 has no calls
function doc(n: number) {
  const statements = Array.from({ length: n }, (_, id) => ({ id, kind: 0, sqlId: id % 10 === 3 ? '' : `sql${String(id).padStart(4, '0')}`, hashValue: 1000 + id, text: `select  ${id}\n from t${id}` }))
  const stats = Array.from({ length: n }, (_, id) => ({ id, elapsed: (n - id) * 1000, executions: id, allCalls: { count: id === 7 ? 0 : 2 } }))
  const label = (s: { kind: number; sqlId: string; hashValue: number }) => s.sqlId || `hv:${s.hashValue}`
  return { statements, stats: { statements: stats }, label } as unknown as Pick<TraceDoc, 'statements' | 'stats' | 'label'>
}

describe('the Cut statement picker (F12)', () => {
  const d = doc(500)
  const choices = stmtChoices(d)

  it('offers every statement with calls, longest first, labels for those without a sql_id', () => {
    expect(choices).toHaveLength(499)
    expect(choices.some((c) => c.id === 7)).toBe(false)
    expect(choices[0].id).toBe(0)
    expect(choices.find((c) => c.id === 13)?.label).toBe('hv:1013')
    expect(choices.find((c) => c.id === 450)?.flat).toBe('select 450 from t450')
  })

  it('a statement below rank 300 is the pick, listed first and named on the button', () => {
    expect(pickOf(choices, null, 450)).toBe(450)
    const rows = pickerRows(choices, 450, '')
    expect(rows[0].id).toBe(450)
    expect(rows).toHaveLength(499)
    expect(new Set(rows.map((r) => r.id)).size).toBe(499)
    const html = renderToStaticMarkup(createElement(StmtPicker, { choices, pick: 450, onPick: () => {} }))
    expect(html).toContain('sql0450')
    expect(html).toContain('select 450 from t450')
  })

  it('the pick made here wins over the selection; a pick the document does not have falls through', () => {
    expect(pickOf(choices, 12, 450)).toBe(12)
    expect(pickOf(choices, 9999, 450)).toBe(450) // an earlier live snapshot's statement
    expect(pickOf(choices, 9999, 7)).toBe(0) // a selected statement without calls: the longest
    expect(pickOf([], 3, 4)).toBeNull()
  })

  it('every statement is reachable by typing: sql_id, SQL text, the anonymous ones by hv', () => {
    expect(pickerRows(choices, 450, 'sql0499').map((r) => r.id)).toEqual([499])
    expect(pickerRows(choices, 450, 'FROM   t498').map((r) => r.id)).toEqual([498])
    expect(pickerRows(choices, 450, 'hv:1493').map((r) => r.id)).toEqual([493])
    // the pick goes first only among the matches
    expect(pickerRows(choices, 450, 't45').map((r) => r.id)).toEqual([450, 45, 451, 452, 453, 454, 455, 456, 457, 458, 459])
    expect(pickerRows(choices, 450, 'sql0001').map((r) => r.id)).toEqual([1])
  })

  it('an empty trace: nothing to pick, the button says so', () => {
    const none = stmtChoices(doc(0))
    expect(none).toEqual([])
    expect(pickOf(none, null, null)).toBeNull()
    expect(renderToStaticMarkup(createElement(StmtPicker, { choices: none, pick: null, onPick: () => {} }))).toContain('No statement with calls')
  })
})
