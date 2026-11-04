import { describe, expect, it } from 'vitest'
import { bindNames, literalOf, placeholders, substitute } from './bindsql'
import type { BindRow } from './derive'

const bind = (pos: number, value: string, extra: Partial<BindRow> = {}): BindRow => ({ pos, type: 'NUMBER', value, isNull: false, noDef: false, dump: false, mal: 0, ...extra })

describe('placeholders', () => {
  it('finds names and positional binds in order', () => {
    expect(placeholders('select * from t where a = :a and b = :1 and c = :"Mixed"').map((p) => p.name)).toEqual(['a', '1', '"Mixed"'])
  })
  it('skips literals, quoted identifiers, comments and :=', () => {
    const sql = "begin x := ':no'; /* :no */ -- :no\n y := q'[:no]'; \"A:no\" := :yes; end;"
    expect(placeholders(sql).map((p) => p.name)).toEqual(['yes'])
  })
  it("keeps going past an escaped quote ''", () => {
    expect(placeholders("select 'it''s :no' from dual where x = :b1").map((p) => p.name)).toEqual(['b1'])
  })
})

describe('bindNames', () => {
  it('SQL: one bind per occurrence', () => {
    expect(bindNames('select :a, :b, :a from dual', 3)).toEqual({ names: ['a', 'b', 'a'], byName: false, exact: true })
  })
  it('PL/SQL: one bind per distinct name', () => {
    expect(bindNames('begin p(:a, :b, :a); end;', 2)).toEqual({ names: ['a', 'b'], byName: true, exact: true })
  })
  it('counts that fit neither are positional and not exact', () => {
    expect(bindNames('select :a from dual', 2).exact).toBe(false)
  })
})

describe('literalOf', () => {
  it('formats by kind', () => {
    expect(literalOf(bind(0, '42', { kind: 'number' })).sql).toBe('42')
    expect(literalOf(bind(0, '"O\'Hara"', { kind: 'string', type: 'VARCHAR2' })).sql).toBe("'O''Hara'")
    expect(literalOf(bind(0, '', { isNull: true })).sql).toBe('NULL')
    expect(literalOf(bind(0, '11/4/2026 10:3:45', { kind: 'date', typed: '2026-11-04T10:03:45' })).sql).toBe("TO_DATE('2026-11-04 10:03:45', 'YYYY-MM-DD HH24:MI:SS')")
    expect(literalOf(bind(0, 'x', { kind: 'timestamp', typed: '2026-11-04T10:03:45.123' })).sql).toBe("TO_TIMESTAMP('2026-11-04 10:03:45.123', 'YYYY-MM-DD HH24:MI:SS.FF')")
    expect(literalOf(bind(0, 'x', { kind: 'interval', typed: 'P3DT4H5M6.789S' })).sql).toBe("TO_DSINTERVAL('P3DT4H5M6.789S')")
  })
  it('marks a value the trace cut, without completing it', () => {
    const l = literalOf(bind(0, '"Long text, ong "...', { kind: 'string' }))
    expect(l.sql).toBe("'Long text, ong ' /* truncated in the trace */")
    expect(l.note).toMatch(/cut/)
  })
  it('a dump is not a value', () => {
    expect(literalOf(bind(0, '', { dump: true })).note).toMatch(/dump/)
  })
})

describe('substitute', () => {
  it('replaces each occurrence by its own bind', () => {
    const r = substitute('select * from t where a = :a and b = :b and c = :a', [bind(0, '1'), bind(1, '"x"', { kind: 'string' }), bind(2, '3')])
    expect(r.sql).toBe("select * from t where a = 1 and b = 'x' and c = 3")
    expect(r.exact).toBe(true)
  })
  it('a bind without a definition of its own repeats the first value of its name', () => {
    const r = substitute('select :a, :a from dual', [bind(0, '7'), bind(1, '', { noDef: true })])
    expect(r.sql).toBe('select 7, 7 from dual')
    expect(r.binds[1].note).toBe('same value as Bind#0')
  })
  it('PL/SQL names get their value wherever they appear', () => {
    expect(substitute('begin p(:a, :b, :a); end;', [bind(0, '1'), bind(1, '2')]).sql).toBe('begin p(1, 2, 1); end;')
  })
  it('a placeholder without a bind becomes NULL and says so', () => {
    const r = substitute('select :a, :b from dual', [bind(0, '1')])
    expect(r.sql).toBe('select 1, NULL from dual')
    expect(r.binds[1].missing).toBe(true)
    expect(r.exact).toBe(false)
  })
})
