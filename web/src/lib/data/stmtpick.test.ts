import { describe, expect, it } from 'vitest'
import { filterRows, flatten, pickRows, sqlCut, type PickRow } from './stmtpick'

// four statements: 0 and 1 in file 0 (1 is the longer), 2 in file 1 only, 3 in file 0 with no time; 4 is a synthetic commit with no cursor
const stmt = (id: number, sqlId: string, text: string, cursors: number[], kind = 0) => ({ id, kind, sqlId, hashValue: id, text, cursors })
const doc = {
  statements: [
    stmt(0, 'aaaaaaaaaaaa1', 'select *\n  from emp\n where empno = :1', [0]),
    stmt(1, 'bbbbbbbbbbbb2', 'UPDATE dept SET dname = :1', [1]),
    stmt(2, 'cccccccccccc3', 'select 1 from dual', [2]),
    stmt(3, 'dddddddddddd4', 'begin null; end;', [3]),
    stmt(4, '', '', [], 2),
  ],
  cursors: [{ line: 40 }, { line: 10 }, { line: 5 }, { line: 90 }],
  fileOfCursor: (c: number) => (c === 2 ? 1 : 0),
  stats: { statements: [{ elapsed: 500_000, executions: 3 }, { elapsed: 2_000_000, executions: 1 }, { elapsed: 9_000_000, executions: 1 }, { elapsed: 0, executions: 1 }, { elapsed: 10, executions: 1 }] },
  label: (s: { kind: number; sqlId: string; hashValue: number }) => (s.kind === 2 ? 'commit' : s.sqlId || `hv:${s.hashValue}`),
} as unknown as Parameters<typeof pickRows>[0]

describe('the statement picker rows', () => {
  it('lists the statements with a cursor in the file, longest first, and the ones without time last', () => {
    expect(pickRows(doc, 0).map((r) => r.label)).toEqual(['bbbbbbbbbbbb2', 'aaaaaaaaaaaa1', 'dddddddddddd4'])
    expect(pickRows(doc, 1).map((r) => r.label)).toEqual(['cccccccccccc3'])
  })
  it('carries what a row shows: the time, the executions, the first line in the file and the SQL with its whitespace collapsed', () => {
    const r = pickRows(doc, 0).find((x) => x.id === 0)!
    expect(r).toMatchObject({ e: 500_000, executions: 3, line: 40, flat: 'select * from emp where empno = :1' })
  })
  it('says the numbers of the file when it is given them: a statement that ran in several files has less time in one', () => {
    const inFile = [{ elapsed: 100, executions: 1 }, { elapsed: 700_000, executions: 2 }, { elapsed: 0, executions: 0 }, { elapsed: 0, executions: 0 }, { elapsed: 0, executions: 0 }]
    const rows = pickRows(doc, 0, inFile)
    expect(rows.map((r) => [r.label, r.e, r.executions])).toEqual([['bbbbbbbbbbbb2', 700_000, 2], ['aaaaaaaaaaaa1', 100, 1], ['dddddddddddd4', 0, 0]])
    expect(pickRows(doc, 0).find((r) => r.id === 1)!.e).toBe(2_000_000) // without them: the whole set's
  })
  it('breaks a tie on time by the line in the file', () => {
    const tied = { ...doc, stats: { statements: [{ elapsed: 5, executions: 1 }, { elapsed: 5, executions: 1 }, { elapsed: 5, executions: 1 }, { elapsed: 5, executions: 1 }, { elapsed: 5, executions: 1 }] } } as unknown as Parameters<typeof pickRows>[0]
    expect(pickRows(tied, 0).map((r) => r.line)).toEqual([10, 40, 90])
  })
})

describe('the picker filter', () => {
  const rows = pickRows(doc, 0)
  it('matches the sql_id or the SQL text, case-insensitively', () => {
    expect(filterRows(rows, 'BBBB').map((r) => r.id)).toEqual([1])
    expect(filterRows(rows, 'update').map((r) => r.id)).toEqual([1])
    expect(filterRows(rows, 'EMPNO').map((r) => r.id)).toEqual([0])
  })
  it('a space in the query matches any whitespace of the text, a line break included', () => {
    expect(filterRows(rows, 'from  emp where').map((r) => r.id)).toEqual([0])
    expect(filterRows(rows, ' select ').map((r) => r.id)).toEqual([0])
  })
  it('an empty query lists everything in the same order; a query that matches nothing, nothing', () => {
    expect(filterRows(rows, '  ').map((r) => r.id)).toEqual(rows.map((r) => r.id))
    expect(filterRows(rows, 'zzz')).toEqual([])
  })
  it('keeps the order of the rows (by time)', () => {
    expect(filterRows(rows, 'e').map((r) => r.id)).toEqual([1, 0, 3]) // dept, emp, null
  })
})

describe('the SQL cut', () => {
  const row = (flat: string): Pick<PickRow, 'flat'> => ({ flat })
  const sql = 'select /*+ full(o) */ o.order_id, o.customer_id, c.name from orders o join customers c on c.id = o.customer_id where o.status = :1'
  it('is the start of the SQL, with an ellipsis when it is cut', () => {
    expect(sqlCut(row('select 1 from dual'), '', 40)).toEqual({ text: 'select 1 from dual' })
    const c = sqlCut(row(sql), '', 30)
    expect(c.text).toBe(sql.slice(0, 29) + '…')
    expect(c.mark).toBeUndefined()
  })
  it('marks the match when it is inside the start', () => {
    const c = sqlCut(row(sql), 'FULL(o)', 60)
    expect(c.text.slice(...c.mark!)).toBe('full(o)')
  })
  it('moves to the match when it lies beyond the start, with some context and ellipses', () => {
    const c = sqlCut(row(sql), 'o.status', 40)
    expect(c.text.startsWith('…')).toBe(true)
    expect(c.text.length).toBeLessThanOrEqual(40)
    expect(c.text.slice(...c.mark!)).toBe('o.status')
  })
  it('a match at the very end shows no trailing ellipsis', () => {
    const c = sqlCut(row(sql), ':1', 40)
    expect(c.text.endsWith('…')).toBe(false)
    expect(c.text.slice(...c.mark!)).toBe(':1')
  })
  it('flatten collapses whitespace runs and trims', () => {
    expect(flatten('  select\n\t*  from   t ')).toBe('select * from t')
  })
})
