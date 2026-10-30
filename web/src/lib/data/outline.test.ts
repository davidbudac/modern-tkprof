import { describe, expect, it } from 'vitest'
import { cursorMatcher, outlineOf, rowAt, rowsOf, type ExecInfo, type OutlineDoc } from './outline'

/** Two sessions in file 0 (lines 10 and 100), one in file 1; cursors: #1 at 5 (before any session), #2 at 20 with a recursive #3 at 30, #4 at 120, and one in file 1. */
const ctx = (id: number, line: number, fileIdx: number, sessionId = '', module = '', action = '') => ({ id, line, sessionId, module, action, fileIdx })
const cur = (id: number, number: number, statement: number, line: number, depth: number, context: number, execs = 1) => ({ id, number, statement, line, depth, context, execs })
const fileOfCtx = (id: number) => [0, 0, 1][id] ?? 0
const cursors = [cur(0, 1, 0, 5, 0, 0), cur(1, 2, 1, 20, 0, 0), cur(2, 3, 0, 30, 1, 0), cur(3, 4, 1, 120, 0, 1), cur(4, 5, 0, 50, 0, 2)]
const doc = {
  contexts: [ctx(0, 10, 0, '42', 'SQL*Plus', ''), ctx(1, 100, 0, '', '', 'job'), ctx(2, 7, 1, '9')],
  cursors,
  statements: [{ id: 0, text: 'select 1 from dual', sqlId: 'aaaaaaaaaaaaa', kind: 0 }, { id: 1, text: 'UPDATE t SET x = 1', sqlId: 'bbbbbbbbbbbbb', kind: 0 }],
  stats: { statements: [{ elapsed: 1500 }, { elapsed: 2_000_000 }] },
  fileOfCtx,
  fileOfCursor: (id: number) => fileOfCtx(cursors[id].context),
  label: (s: { sqlId: string }) => s.sqlId,
} as unknown as OutlineDoc

describe('outlineOf', () => {
  const tree = outlineOf(doc, 0)
  it('lists the markers of the file by line, cursors before the first under "file start"', () => {
    expect(tree.map((g) => [g.line, g.label, g.cursors.map((c) => c.number)])).toEqual([
      [1, 'file start', [1]],
      [10, 'session 42 · SQL*Plus', [2]],
      [100, 'job', [4]],
    ])
  })
  it('nests a deeper cursor under the previous cursor of lower depth', () => {
    const c2 = tree[2 - 1].cursors[0]
    expect(c2.children.map((c) => c.number)).toEqual([3])
    expect(c2.descendants).toBe(1)
    expect(c2).toMatchObject({ sqlId: 'bbbbbbbbbbbbb', text: 'UPDATE t SET x = 1', execs: 1, elapsed: 2_000_000 })
  })
  it('leaves the cursors of other files out', () => { expect(outlineOf(doc, 1).map((g) => g.cursors.map((c) => c.number))).toEqual([[5]]) })
})

describe('rowsOf and rowAt', () => {
  const tree = outlineOf(doc, 0)
  const none = () => undefined
  it('folds the recursive cursors into a summary line until their parent opens', () => {
    const rows = rowsOf(tree, new Set(), null, none)
    expect(rows.map((r) => r.type)).toEqual(['ctx', 'cursor', 'ctx', 'cursor', 'more', 'ctx', 'cursor'])
    const open = rowsOf(tree, new Set(['c1']), null, (): ExecInfo => ({ status: 'ok', partial: false, rows: [{ execNo: 1, e: 250, line: 22 }] }))
    expect(open.map((r) => r.type)).toEqual(['ctx', 'cursor', 'ctx', 'cursor', 'exec', 'cursor', 'ctx', 'cursor'])
    expect(open.find((r) => r.type === 'exec')).toMatchObject({ depth: 2, line: 22, text: 'exec #1 · 250 µs · line 22' })
  })
  it('shows loading and error states as notes', () => {
    expect(rowsOf(tree, new Set(['c0']), null, none)[2]).toMatchObject({ type: 'note', text: 'loading executions…' })
    expect(rowsOf(tree, new Set(['c0']), null, () => ({ status: 'error', message: 'boom' }))[2].type).toBe('note')
  })
  it('finds the row of a line by binary search, an exact execution row winning', () => {
    const open = rowsOf(tree, new Set(['c1']), null, (): ExecInfo => ({ status: 'ok', partial: false, rows: [{ execNo: 1, e: 250, line: 22 }] }))
    const keyAt = (line: number) => open[rowAt(open, line)]?.key
    expect(rowAt(open, 0)).toBe(-1)
    expect(keyAt(3)).toBe('x-1')
    expect(keyAt(5)).toBe('c0')
    expect(keyAt(21)).toBe('c1')
    expect(keyAt(22)).toBe('c1:e1')
    expect(keyAt(31)).toBe('c2')
    const folded = rowsOf(tree, new Set(), null, none) // the recursive cursor is folded away under c1: c1 holds its lines
    expect(folded[rowAt(folded, 31)].key).toBe('c1')
    expect(keyAt(500)).toBe('c3')
  })
  it('filters by sql_id or text, flat, keeping only the markers with matches', () => {
    const rows = rowsOf(tree, new Set(), cursorMatcher(doc, 'UPDATE'), none)
    expect(rows.map((r) => (r.type === 'cursor' ? `#${r.node.number}` : r.type))).toEqual(['ctx', '#2', 'ctx', '#4'])
    expect(rowsOf(tree, new Set(), cursorMatcher(doc, 'AAAAAAAAAAAAA'), none).map((r) => r.type)).toEqual(['ctx', 'cursor', 'ctx', 'cursor'])
    expect(cursorMatcher(doc, '  ')).toBeNull()
  })
})
