import { describe, expect, it } from 'vitest'
import { diffLines, formatSql, formatSqlMemo, splitTop, sqlSpans, sqlTokens } from './optsql'

describe('formatSql', () => {
  it('puts the clauses on lines of their own', () => {
    expect(formatSql('select a, b from t where x = 1 group by a order by b')).toEqual(['SELECT a, b', 'FROM t', 'WHERE x = 1', 'GROUP BY a', 'ORDER BY b'])
  })

  it('keeps the case of what the text has and upper-cases only the clauses it breaks at', () => {
    const out = formatSql('select c.name from mtk_cust c where c.id = 1')
    expect(out).toEqual(['SELECT c.name', 'FROM mtk_cust c', 'WHERE c.id = 1'])
  })

  it('breaks the AND and OR of a WHERE onto their own lines, indented', () => {
    expect(formatSql('select 1 from t where a = 1 and b = 2 or c = 3')).toEqual(['SELECT 1', 'FROM t', 'WHERE a = 1', '  AND b = 2', '  OR c = 3'])
  })

  it('indents a subquery and puts its clauses at its own level', () => {
    expect(formatSql('select 1 from t where x in (select y from u where z = 1)')).toEqual(['SELECT 1', 'FROM t', 'WHERE x in (', '    SELECT y', '    FROM u', '    WHERE z = 1)'])
    expect(formatSql('select 1 from t where exists (select 1 from a where a.x = t.id) and y = 2')).toEqual([
      'SELECT 1', 'FROM t', 'WHERE exists (', '    SELECT 1', '    FROM a', '    WHERE a.x = t.id)', '  AND y = 2',
    ])
  })

  it('does not break inside a string, a quoted name or a comment', () => {
    const out = formatSql(`select 'a from b', "FROM" /* where x */ from t`)
    expect(out).toEqual([`SELECT 'a from b', "FROM" /* where x */`, 'FROM t'])
  })

  it('breaks the table list of a FROM at its commas', () => {
    expect(formatSql('select 1 from a, b, c where 1 = 1')).toEqual(['SELECT 1', 'FROM a,', '  b,', '  c', 'WHERE 1 = 1'])
  })

  it('breaks a long SELECT list one item per line', () => {
    const cols = Array.from({ length: 12 }, (_, i) => `t.column_${i}`).join(', ')
    const out = formatSql(`select ${cols} from t`)
    expect(out[0]).toBe('SELECT t.column_0,')
    expect(out[1]).toBe('       t.column_1,')
    expect(out.at(-2)).toBe('       t.column_11')
    expect(out.at(-1)).toBe('FROM t')
  })

  it('reads binds, numbers and unterminated strings without losing text', () => {
    const sql = "select :b1, 1.5e3, 'open from t"
    expect(formatSql(sql).join(' ').replace(/\s+/g, ' ')).toBe("SELECT :b1, 1.5e3, 'open from t")
  })

  it('keeps every token of the statement (only white space changes)', () => {
    const sql = 'select /*+ index(o ix) */ "C"."ID", sum(o.amount) from mtk_cust c join mtk_orders o on o.cust_id = c.id where c.id between :cid and :cid + 50 and exists (select 1 from a where a.x = o.id) group by c.name'
    const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase()
    expect(squash(formatSql(sql).join(' '))).toBe(squash(sql))
  })
})

describe('formatSqlMemo', () => {
  it('gives the same lines for the same text', () => {
    expect(formatSqlMemo('select 1 from t')).toBe(formatSqlMemo('select 1 from t'))
  })
})

describe('splitTop', () => {
  it('cuts at the commas outside parentheses and quotes', () => {
    expect(splitTop(`a, f(b, c), 'x,y', "p,q", d`)).toEqual(['a', 'f(b, c)', `'x,y'`, '"p,q"', 'd'])
  })
})

describe('tokens and spans', () => {
  it('classifies keywords, strings, binds and comments', () => {
    expect(sqlTokens("select 'x' :b /* c */ y").filter((t) => t.t !== 'ws').map((t) => t.t)).toEqual(['kw', 'str', 'bind', 'cmt', 'word'])
    expect(sqlSpans("select :b from t").map((s) => s.cls).filter(Boolean)).toEqual(['opt-kw', 'opt-bind', 'opt-kw'])
  })
})

describe('diffLines', () => {
  it('marks the lines taken out and put in, keeping the order', () => {
    expect(diffLines(['a', 'b', 'c'], ['a', 'x', 'c', 'd'])).toEqual([
      { op: ' ', text: 'a' }, { op: '-', text: 'b' }, { op: '+', text: 'x' }, { op: ' ', text: 'c' }, { op: '+', text: 'd' },
    ])
  })
  it('is all kept for equal texts and handles empty sides', () => {
    expect(diffLines(['a'], ['a'])).toEqual([{ op: ' ', text: 'a' }])
    expect(diffLines([], ['a'])).toEqual([{ op: '+', text: 'a' }])
    expect(diffLines(['a'], [])).toEqual([{ op: '-', text: 'a' }])
    expect(diffLines([], [])).toEqual([])
  })
})
