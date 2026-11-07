import { beforeEach, describe, expect, it } from 'vitest'
import { MAX_PRETTY_CHARS, prettyLines, prettyMemo, prettySql, tightCalls } from './sqlformat'

beforeEach(() => prettyMemo.clear())

describe('prettySql', () => {
  it('lays a statement out: one clause or column a line, 2-space indent, keyword case and binds as written', () => {
    expect(prettySql('select /* QOSD */ objn, sub_id from exp_head$ eh where exp_id = :1 and flags > :b_lo')).toBe(
      ['select', '  /* QOSD */', '  objn,', '  sub_id', 'from', '  exp_head$ eh', 'where', '  exp_id = :1', '  and flags > :b_lo'].join('\n'))
    expect(prettySql("INSERT INTO t (a, b) SELECT 'x', y FROM z WHERE y = 1")).toContain('\nSELECT\n  \'x\',\n  y\nFROM\n  z\nWHERE\n  y = 1')
  })
  it('a PL/SQL block is laid out too, its statements on lines of their own and no blank line between them', () => {
    expect(prettySql("BEGIN dbms_application_info.set_action('arraysize15'); END;")).toBe("BEGIN dbms_application_info.set_action('arraysize15');\nEND;")
    expect(prettySql('BEGIN :b_num := 1; :b_lo := 1; :b_hi := 1000; END;')).toBe('BEGIN :b_num := 1;\n:b_lo := 1;\n:b_hi := 1000;\nEND;')
  })
  it('falls back to the text as the trace has it when the formatter throws', () => {
    for (const bad of ["select ' unterminated from dual", 'select "never closed from dual']) expect(prettySql(bad)).toBe(bad)
  })
  it('falls back to the text as the trace has it over 20,000 characters, without formatting or remembering it', () => {
    const big = 'select ' + Array.from({ length: Math.ceil(MAX_PRETTY_CHARS / 4) }, (_, i) => `c${i}`).join(', ') + ' from t'
    expect(big.length).toBeGreaterThan(MAX_PRETTY_CHARS)
    expect(prettySql(big)).toBe(big)
    expect(prettyMemo.has(big)).toBe(false)
    const ok = big.slice(0, MAX_PRETTY_CHARS - 100).replace(/, [^,]*$/, '') + ' from t'
    expect(ok.length).toBeLessThanOrEqual(MAX_PRETTY_CHARS)
    expect(prettySql(ok)).not.toBe(ok) // just under the limit it is formatted
  })
  it('keeps the most recently used texts, a small LRU', () => {
    const q = (i: number) => `select ${i} from dual`
    for (let i = 0; i < prettyMemo.limit; i++) prettySql(q(i))
    expect(prettyMemo.size()).toBe(prettyMemo.limit)
    prettySql(q(0)) // used again: no longer the oldest
    prettySql(q(1000))
    expect(prettyMemo.size()).toBe(prettyMemo.limit)
    expect(prettyMemo.has(q(0))).toBe(true)
    expect(prettyMemo.has(q(1))).toBe(false)
    const a = prettySql(q(0))
    expect(prettySql(q(0))).toBe(a)
  })
})

describe('prettyLines', () => {
  it('the lines of the pretty text without a blank line at the end', () => {
    expect(prettyLines('select 1 from dual\n')).toEqual(['select', '  1', 'from', '  dual'])
  })
  it('a fallback text keeps its own lines, its trailing blank lines dropped', () => {
    expect(prettyLines("select ' unterminated\n  from dual\n\n")).toEqual(["select ' unterminated", '  from dual'])
    expect(prettyLines('')).toEqual([''])
  })
})

describe('tightCalls', () => {
  it('takes the space out between a name and its argument list, a package call too', () => {
    expect(tightCalls("BEGIN dbms_application_info.set_action ('x');")).toBe("BEGIN dbms_application_info.set_action('x');")
    expect(tightCalls('begin pkg.proc (:1, :2);\nx := my_func (a, b) + nvl(c, 0);')).toBe('begin pkg.proc(:1, :2);\nx := my_func(a, b) + nvl(c, 0);')
    expect(tightCalls('select\n  my_pkg.f (x)\nwhere a = g (b)')).toBe('select\n  my_pkg.f(x)\nwhere a = g(b)')
    expect(tightCalls('table (dbms_xplan.display_cursor (null, null))')).toBe('table (dbms_xplan.display_cursor(null, null))')
  })
  it('keeps the space after a keyword', () => {
    for (const s of ['x IN (1, 2)', 'a AND (b OR c)', 'where not (a = 1)', 'and exists (', 'values (1, 2)', 'x AS (select 1)', 'from (select 1)', 'if (x > 1) then', 'sum(x) over (partition by y)', 'union all (']) expect(tightCalls(s)).toBe(s)
  })
  it('keeps the space after the name of an object: a column list, a definition', () => {
    for (const s of ['INSERT INTO t (a, b)', 'INSERT INTO SQLG_PIVOT (\n  OBJECT_TYPE,', 'insert into s.t (a)', 'create table t (a number)', 'join d on (a = b)', 'with q (a, b) as (select 1, 2)']) expect(tightCalls(s)).toBe(s)
  })
  it('leaves literals, quoted identifiers and comments alone', () => {
    const s = "select 'set_action (x)', \"My Col (x)\", q'[f (y)]', 'it''s g (z)' /* h (1) */ from t -- k (2)\nwhere f (a) = 1"
    expect(tightCalls(s)).toBe("select 'set_action (x)', \"My Col (x)\", q'[f (y)]', 'it''s g (z)' /* h (1) */ from t -- k (2)\nwhere f(a) = 1")
  })
  it('is what prettySql does to a formatted PL/SQL call, and nothing else', () => {
    expect(prettySql("begin pkg.proc(:1, :2); x := my_func(a, b); end;")).toBe('begin pkg.proc(:1, :2);\nx := my_func(a, b);\nend;')
    expect(prettySql("insert into t (a,b) values (1,2)")).toBe('insert into\n  t (a, b)\nvalues\n  (1, 2)')
  })
})
