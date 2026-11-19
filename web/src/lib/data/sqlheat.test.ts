import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from './doc'
import { formatSql } from './optsql'
import type { Plan, PlanLine, RawDocument } from './types'
import { LocalSource } from './source'
import { dumpExecutions, heatChildren, heatCoverOfTrace, heatDump, heatInput, heatTint, HEAT_MIN_SHARE, sqlHeat, type HeatChild, type HeatCover, type HeatOk, type SqlHeat } from './sqlheat'

const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
const load = (f: string) => TraceDoc.fromRaw((JSON.parse(gunzipSync(readFileSync(dir + f)).toString('utf8')) as { doc: RawDocument }).doc)

// Synthetic plan lines for the rules (a unit test of a pure function needs no trace file); names and numbers are invented.
const L = (id: number, parentId: number, op: string, extra: Partial<PlanLine> = {}): PlanLine => ({
  plan: 0, id, parentId, pos: 1, depth: 0, obj: 0, op, object: '', rows: 1, starts: 1, cr: 0, pr: 0, pw: 0, timeUs: 0,
  cost: -1, size: -1, card: -1, hasStats: true, ...extra,
})
const heat = (text: string, lines: PlanLine[], children: HeatChild[] = []): SqlHeat => sqlHeat({ text, lines, executions: 1, children })
const ok = (h: SqlHeat): HeatOk => {
  if (!h.ok) throw new Error(`fallback: ${h.note}`)
  return h
}
/** the group whose plan lines are `ids` */
const group = (h: HeatOk, ...ids: number[]) => {
  const g = h.groups.find((x) => x.parts.map((p) => p.id).join() === ids.join())
  if (!g) throw new Error(`no group of lines ${ids.join(', ')}: ${h.groups.map((x) => x.parts.map((p) => p.id).join('+')).join(' | ')}`)
  return g
}
/** the fragments of the text painted with the group of `ids`, trimmed */
const painted = (h: HeatOk, ...ids: number[]) => {
  const k = h.groups.indexOf(group(h, ...ids))
  return h.lines.flatMap((l) => l.filter((s) => s.group === k).map((s) => s.text.trim())).filter(Boolean)
}
/** every share: the groups, the plan lines not placed, recursive SQL outside the plan not in the text, the rest of the calls */
const sum = (h: HeatOk) => h.groups.reduce((a, g) => a + g.share, 0) + h.unplaced.share + (h.outside && h.outside.group < 0 ? h.outside.share : 0) + (h.rest?.share ?? 0)

describe('sqlHeat on io_waits.trc (the hash join that spills)', async () => {
  const doc = await load('findings-io_waits.json.gz')
  const st = doc.statements.find((s) => s.text.startsWith('select /*+ use_hash(c o) mtk_hash_spill */'))!
  const h = ok(sqlHeat(heatInput(doc, doc.plansOf(st.id)[0])))

  it('gives the join condition the HASH JOIN\'s self time: 99.1 %', () => {
    const j = group(h, 2)
    expect(j.what).toBe('join condition')
    expect(j.selfUs).toBe(604439)
    expect(j.share).toBeCloseTo(604439 / 609850, 6)
    expect(j.approx).toEqual([])
    expect(painted(h, 2)).toEqual(['join', 'on o.cust_id = c.id'])
    expect(h.groups[0]).toBe(j)
  })

  it('gives each table its scan, with self gets', () => {
    expect(painted(h, 3)).toEqual(['FROM mtk_cust c'])
    expect(group(h, 3).parts[0]).toMatchObject({ id: 3, selfUs: 3396, selfCr: 1210 })
    expect(painted(h, 4)).toEqual(['mtk_orders o'])
    expect(group(h, 4).parts[0]).toMatchObject({ id: 4, selfUs: 2015, selfCr: 498 })
  })

  it('gives SORT AGGREGATE the aggregates (0 µs: it reports less than its child) and adds up to 100 %', () => {
    expect(painted(h, 1)).toEqual(['count(*)', 'sum(o.amount * c.amount)'])
    expect(group(h, 1).selfUs).toBe(0)
    expect(h.unplaced.parts).toEqual([])
    expect(sum(h)).toBeCloseTo(1, 12)
    expect(h.totalUs).toBe(609850)
    expect(h.notes.some((n) => n.includes('SORT AGGREGATE (id 1)'))).toBe(true)
  })

  it('has no callout: its recursive statements are dictionary SQL, and it calls no function', () => {
    expect(heatChildren(doc, st.id)).toEqual([])
    expect(h.callouts).toEqual([])
  })
})

describe('sqlHeat on plsql_recursive.trc (a function that runs SQL)', async () => {
  const doc = await load('findings-plsql_recursive.json.gz')
  const st = doc.statements.find((s) => s.text.startsWith('select /* mtk_f_from_sql */'))!
  const child = doc.statements.find((s) => s.text.startsWith('SELECT NVL(MAX(AMOUNT), 0) FROM MTK_CUST'))!

  it('counts the recursive statement\'s executions under this one from the call facts (it runs under three)', () => {
    expect((doc.stats.statements[child.id].parents ?? []).length).toBe(3)
    expect(heatChildren(doc, st.id)).toEqual([{ statement: child.id, executions: 5, elapsedUs: 253, exact: true }])
  })

  it('puts a ≈ callout on the one function of the text that is not a built-in', () => {
    const h = ok(sqlHeat(heatInput(doc, doc.plansOf(st.id)[0])))
    expect(h.callouts).toHaveLength(1)
    const c = h.callouts[0]
    expect(c).toMatchObject({ fn: 'mtk_f', perExec: 5, others: 0, line: 0 })
    expect(c.child.statement).toBe(child.id)
    expect(h.lines[c.line].map((s) => s.text).join('').slice(c.col)).toMatch(/^mtk_f\(id\)/)
  })

  it('places an index read without its table by the name the index carries (≈)', () => {
    const h = ok(sqlHeat(heatInput(doc, doc.plansOf(st.id)[0])))
    expect(group(h, 1).approx).toEqual(['the index name MTK_CUST_PK contains the table name MTK_CUST'])
    expect(painted(h, 1)).toEqual(['FROM mtk_cust', 'WHERE id <= 5'])
  })

  // The plan's one line, the index range scan, reports 30 µs; the execution's EXEC and FETCH calls took 624 µs (19 + 313
  // + 292), of which 253 µs are mtk_f's recursive SQL, run as the select list hands rows to the client: in no plan line.
  it('compares the plan with the execution its dump covers, and gives recursive SQL outside the plan a share of its own', () => {
    const h = ok(sqlHeat(heatInput(doc, doc.plansOf(st.id)[0])))
    expect(h.cover).toEqual({ executions: 1, execNo: 1, elapsedUs: 624, recursiveUs: 253, exact: true })
    expect(h.basis).toBe('calls')
    expect(h.planUs).toBe(30)
    expect(h.totalUs).toBe(624)
    const r = h.groups[0]
    expect(r).toMatchObject({ what: 'outside the plan: recursive SQL', selfUs: 253, parts: [], recursive: { fn: 'mtk_f', statement: child.id } })
    expect(r.share).toBeCloseTo(253 / 624, 12)
    expect(r.approx[0]).toBe('the recursive SQL is taken to run in mtk_f, the one function of the text that is not an Oracle built-in')
    expect(h.lines[0].filter((s) => s.group === 0).map((s) => s.text)).toEqual(['mtk_f(id)'])
    expect(h.outside).toMatchObject({ us: 253, group: 0 })
    expect(group(h, 1).share).toBeCloseTo(30 / 624, 12)
    expect(h.rest).toEqual({ us: 341, share: 341 / 624 })
    expect(sum(h)).toBeCloseTo(1, 12)
    expect(h.account).toEqual([
      'The plan lines account for 30 µs of 624 µs, the EXEC and FETCH calls of the first execution, which this dump covers.',
      'Recursive SQL outside the plan lines takes 253 µs (≈, on mtk_f), and 341 µs are in neither. The shares are of the 624 µs of these calls.',
    ])
  })

  it('finds the same numbers in the execution\'s trace, which a document without call facts asks its source for', async () => {
    const src = new LocalSource(doc)
    const page = await src.executions(st.id, { window: null, files: null, contexts: null, includeIdle: true })
    const trace = await src.executionTrace(st.id, page.rows[0])
    expect(heatCoverOfTrace(trace!, [child.id])).toEqual({ executions: 1, execNo: 1, elapsedUs: 624, recursiveUs: 253, exact: true })
  })

  it('without call facts (the desktop): the statement\'s numbers, exact when the dump covers all its executions, else averages', async () => {
    const raw = (JSON.parse(gunzipSync(readFileSync(dir + 'findings-plsql_recursive.json.gz')).toString('utf8')) as { doc: RawDocument }).doc
    const bare = await TraceDoc.fromRaw({ ...raw, facts: undefined } as RawDocument)
    expect(bare.hasFacts).toBe(false)
    const h = ok(sqlHeat(heatInput(bare, bare.plansOf(st.id)[0])))
    expect(h.cover).toEqual({ executions: 1, execNo: 1, elapsedUs: 624, recursiveUs: 253, exact: true })
    expect(h.groups[0]).toMatchObject({ selfUs: 253, recursive: { fn: 'mtk_f' } })
    expect(h.rest?.us).toBe(341)
    const c = heatInput(bare, bare.plansOf(child.id)[0]).cover!
    expect(c).toMatchObject({ executions: 1, execNo: 0, exact: false })
    expect(c.elapsedUs).toBeCloseTo((bare.stats.statements[child.id].exec.elapsed + bare.stats.statements[child.id].fetch.elapsed) / 58, 9)
  })

  it('covers the first execution of a cursor whose dump follows it (58 executions)', () => {
    expect(doc.stats.statements[child.id].executions).toBe(58)
    const p = doc.plansOf(child.id)[0]
    expect(heatInput(doc, p).cover).toEqual({ executions: 1, execNo: 1, elapsedUs: 71, recursiveUs: 0, exact: true })
  })

  it('gives SEQUENCE the NEXTVAL and FAST DUAL the DUAL', () => {
    const s = doc.statements.find((x) => x.text.startsWith('SELECT MTK_SEQ.NEXTVAL'))!
    const h = ok(sqlHeat(heatInput(doc, doc.plansOf(s.id)[0])))
    expect(painted(h, 1)).toEqual(['MTK_SEQ.NEXTVAL'])
    expect(painted(h, 2)).toEqual(['FROM "SYS"."DUAL"'])
  })

  it('falls back to the table, with a note, for DML', () => {
    const s = doc.statements.find((x) => x.text.startsWith('insert into mtk_orders'))!
    const h = sqlHeat(heatInput(doc, doc.plansOf(s.id)[0]))
    expect(h.ok).toBe(false)
    if (!h.ok) {
      expect(h.why).toBe('dml')
      expect(h.note).toBe('SQL heat reads queries (SELECT and WITH); this statement is an INSERT, so the table shows instead.')
    }
  })
})

describe('sqlHeat on workload (FETCH FIRST)', async () => {
  const doc = await load('findings-workload.json.gz')
  const st = doc.statements.find((s) => s.text.startsWith('select /* mtk_wl_report_serial */'))!
  it('gives the VIEW and the WINDOW SORT PUSHED RANK a FETCH FIRST is run as to that clause', () => {
    const h = ok(sqlHeat(heatInput(doc, doc.plansOf(st.id)[0])))
    expect(group(h, 2, 3).what).toBe('FETCH FIRST')
    expect(painted(h, 2, 3)).toEqual(['fetch first 5 rows only'])
    expect(painted(h, 1)).toEqual(['ORDER BY 3 desc'])
    expect(painted(h, 4)).toEqual(['GROUP BY cust_id'])
    expect(h.unplaced.parts).toEqual([])
  })
})

describe('sqlHeat: a table read four times (pinx_worker.trc)', () => {
  // the text of testdata/traces/19c/pinx_worker.trc line 42; the trace has no STAT lines for it, so the plan is made up
  const text = readFileSync(new URL('../../../../testdata/traces/19c/pinx_worker.trc', import.meta.url), 'utf8').split('\n')[41]
  const T = (id: number, parentId: number, extra: Partial<PlanLine> = {}) => L(id, parentId, 'TABLE ACCESS FULL', { object: 'T', timeUs: 100, cr: 10, ...extra })
  const plan = (alias = false) => [
    L(1, 0, 'SORT AGGREGATE', { timeUs: 1000 }),
    L(2, 1, 'HASH JOIN', { timeUs: 990 }),
    L(3, 2, 'HASH JOIN', { timeUs: 700 }),
    L(4, 3, 'HASH JOIN', { timeUs: 400 }),
    T(5, 4, alias ? { alias: 'D@SEL$1' } : {}),
    T(6, 4, { pos: 2, ...(alias ? { alias: 'C@SEL$1' } : {}) }),
    T(7, 3, { pos: 2, ...(alias ? { alias: 'B@SEL$1' } : {}) }),
    T(8, 2, { pos: 2, ...(alias ? { alias: 'A@SEL$1' } : {}) }),
  ]

  it('reads the real text', () => expect(text).toMatch(/^SELECT \/\*\+ qb_name\(pinx\) \*\/ COUNT\(\*\) FROM T A, T B, T C, T D WHERE/))

  it('gives the four scans to the four FROM items in text order and marks them ≈', () => {
    const h = ok(heat(text, plan()))
    for (const id of [5, 6, 7, 8]) expect(group(h, id).approx).toEqual(['T appears 4 times in the text and the trace does not say which one this line reads'])
    expect(painted(h, 5)).toEqual(['FROM T A', 'WHERE A.ID < 1000', 'AND A.GRP = 7', 'AND PINX_PARSE_MARKER(A.ID) >= 0'])
    expect(painted(h, 6)).toEqual(['T B', 'AND B.ID < 1000'])
  })

  it('gives each join the WHERE predicates that name both its inputs (≈, the tables are inferred)', () => {
    const h = ok(heat(text, plan()))
    expect(painted(h, 4)).toEqual(['AND A.ID = B.ID'])
    expect(painted(h, 3)).toEqual(['AND B.ID = C.ID'])
    expect(painted(h, 2)).toEqual(['AND C.ID = D.ID'])
    expect(group(h, 4).approx).toEqual(['the tables it joins were matched by inference'])
    expect(group(h, 4).what).toBe('join predicate')
    expect(sum(h)).toBeCloseTo(1, 12)
  })

  it('is exact with the aliases of a ref bundle (DBMS_XPLAN): the alias decides', () => {
    const h = ok(heat(text, plan(true)))
    expect(h.groups.every((g) => g.approx.length === 0)).toBe(true)
    expect(painted(h, 5)).toEqual(['T D', 'AND D.ID < 1000'])
    expect(painted(h, 8)).toEqual(['FROM T A', 'WHERE A.ID < 1000', 'AND A.GRP = 7', 'AND PINX_PARSE_MARKER(A.ID) >= 0'])
    expect(painted(h, 4)).toEqual(['AND C.ID = D.ID'])
  })

  it('puts the recursive statement on the function, an annotation and not a share', () => {
    const child: HeatChild = { statement: 9, executions: 40, elapsedUs: 5000, exact: true }
    const h = ok(sqlHeat({ text, lines: plan(), executions: 4, children: [child, { statement: 10, executions: 1, elapsedUs: 10, exact: true }] }))
    expect(h.callouts).toEqual([{ line: 13, col: 6, fn: 'PINX_PARSE_MARKER', child, perExec: 10, others: 1 }])
    expect(h.lines[13].map((s) => s.text).join('')).toBe('  AND PINX_PARSE_MARKER(A.ID) >= 0')
    expect(sum(h)).toBeCloseTo(1, 12)
  })
})

describe('sqlHeat rules (hand-written cases)', () => {
  it('an inline view: the table and its WHERE, ORDER BY, the ROWNUM predicate, the aggregates, the parentheses', () => {
    const h = ok(heat("select max(amount) from (select * from orders_log where status = 'X' order by created desc) where rownum <= 5", [
      L(1, 0, 'SORT AGGREGATE', { timeUs: 1000 }),
      L(2, 1, 'COUNT STOPKEY', { timeUs: 990 }),
      L(3, 2, 'VIEW', { timeUs: 980 }),
      L(4, 3, 'SORT ORDER BY STOPKEY', { timeUs: 970 }),
      L(5, 4, 'TABLE ACCESS FULL', { object: 'ORDERS_LOG', timeUs: 600, cr: 50 }),
    ]))
    expect(painted(h, 5)).toEqual(['FROM orders_log', "WHERE status = 'X'"])
    expect(group(h, 5).share).toBeCloseTo(0.6, 9)
    expect(painted(h, 4)).toEqual(['ORDER BY created desc'])
    expect(group(h, 4).share).toBeCloseTo(0.37, 9)
    expect(painted(h, 2)).toEqual(['WHERE rownum <= 5'])
    expect(painted(h, 1)).toEqual(['max(amount)'])
    expect(painted(h, 3)).toEqual(['FROM (', ')'])
    expect(h.groups.every((g) => g.approx.length === 0)).toBe(true)
  })

  it('an index line: with the table access it feeds; below another index line it is a subquery key, matched by name (≈)', () => {
    const h = ok(heat('select id from parts where kind = :k and owner_id = (select id from owners where full_name(id) = :n)', [
      L(1, 0, 'TABLE ACCESS BY INDEX ROWID BATCHED', { object: 'PARTS', timeUs: 500, cr: 30 }),
      L(2, 1, 'INDEX RANGE SCAN', { object: 'PARTS_OWNER_IX', timeUs: 450, cr: 25 }),
      L(3, 2, 'INDEX FULL SCAN', { object: 'PK_OWNERS', timeUs: 440, cr: 24 }),
    ]))
    expect(group(h, 1, 2).approx).toEqual([])
    expect(group(h, 1, 2).parts.map((p) => p.selfCr)).toEqual([5, 1])
    expect(painted(h, 1, 2)).toEqual(['FROM parts', 'WHERE kind = :k', 'AND owner_id = (', ')'])
    expect(painted(h, 3)).toEqual(['FROM owners', 'WHERE full_name(id) = :n'])
    expect(group(h, 3).approx).toEqual(['the index name PK_OWNERS contains the table name OWNERS'])
    expect(group(h, 3).share).toBeCloseTo(0.88, 9)
  })

  it('a batched nested loop: the inner index goes with the table access above it, both loops with the join', () => {
    const h = ok(heat('select a.x from a_tab a join b_tab b on b.id = a.b_id', [
      L(1, 0, 'NESTED LOOPS', { timeUs: 100 }),
      L(2, 1, 'NESTED LOOPS', { timeUs: 80 }),
      L(3, 2, 'TABLE ACCESS FULL', { object: 'A_TAB', timeUs: 30 }),
      L(4, 2, 'INDEX UNIQUE SCAN', { object: 'SYS_C0012', pos: 2, timeUs: 20 }),
      L(5, 1, 'TABLE ACCESS BY INDEX ROWID', { object: 'B_TAB', pos: 2, timeUs: 10 }),
    ]))
    expect(painted(h, 4, 5)).toEqual(['b_tab b'])
    expect(painted(h, 1, 2)).toEqual(['join', 'on b.id = a.b_id'])
    expect(h.unplaced.parts).toEqual([])
  })

  it('GROUP BY, and HAVING for the FILTER above it', () => {
    const h = ok(heat('select dept, count(*) from emp_x group by dept having count(*) > 2', [
      L(1, 0, 'FILTER', { timeUs: 100 }),
      L(2, 1, 'HASH GROUP BY', { timeUs: 90 }),
      L(3, 2, 'TABLE ACCESS FULL', { object: 'EMP_X', timeUs: 40 }),
    ]))
    expect(painted(h, 2)).toEqual(['GROUP BY dept'])
    expect(painted(h, 1)).toEqual(['HAVING count(*) > 2'])
  })

  it('DISTINCT, CONNECT BY with START WITH (and its pump), analytic functions', () => {
    const d = ok(heat('select distinct kind from parts', [L(1, 0, 'HASH UNIQUE', { timeUs: 50 }), L(2, 1, 'TABLE ACCESS FULL', { object: 'PARTS', timeUs: 20 })]))
    expect(painted(d, 1)).toEqual(['distinct'])
    const c = ok(heat('select id from nodes start with id = :root connect by prior id = parent_id', [
      L(1, 0, 'CONNECT BY WITH FILTERING', { timeUs: 100 }),
      L(2, 1, 'TABLE ACCESS FULL', { object: 'NODES', timeUs: 20 }),
      L(3, 1, 'CONNECT BY PUMP', { pos: 2, timeUs: 10 }),
    ]))
    expect(painted(c, 1, 3)).toEqual(['START WITH id = :root', 'CONNECT BY prior id = parent_id'])
    const w = ok(heat('select id, rank() over (order by amount desc) r from orders_x', [L(1, 0, 'WINDOW SORT', { timeUs: 70 }), L(2, 1, 'TABLE ACCESS FULL', { object: 'ORDERS_X', timeUs: 20 })]))
    expect(painted(w, 1)).toEqual(['rank() over (order by amount desc)'])
  })

  it('FILTER with a subquery: the predicate that holds it; the subquery\'s correlated predicate stays with its table', () => {
    const h = ok(heat('select id from t1 where flag = 1 and exists (select 1 from t2 where t2.id = t1.id)', [
      L(1, 0, 'FILTER', { timeUs: 100 }),
      L(2, 1, 'TABLE ACCESS FULL', { object: 'T1', timeUs: 30 }),
      L(3, 1, 'TABLE ACCESS FULL', { object: 'T2', pos: 2, timeUs: 50 }),
    ]))
    expect(painted(h, 1)).toEqual(['AND exists (', ')'])
    expect(painted(h, 2)).toEqual(['FROM t1', 'WHERE flag = 1'])
    expect(painted(h, 3)).toEqual(['FROM t2', 'WHERE t2.id = t1.id'])
  })

  it('a semi join of an IN subquery takes that predicate; old-style outer joins name their tables', () => {
    const s = ok(heat('select id from t1 where id in (select t1_id from t2)', [
      L(1, 0, 'HASH JOIN SEMI', { timeUs: 100 }),
      L(2, 1, 'TABLE ACCESS FULL', { object: 'T1', timeUs: 30 }),
      L(3, 1, 'TABLE ACCESS FULL', { object: 'T2', pos: 2, timeUs: 20 }),
    ]))
    expect(painted(s, 1)).toEqual(['WHERE id in (', ')'])
    const o = ok(heat('select a.x from a_tab a, b_tab b where a.id = b.a_id(+) and a.x between 1 and 5', [
      L(1, 0, 'HASH JOIN OUTER', { timeUs: 100 }),
      L(2, 1, 'TABLE ACCESS FULL', { object: 'A_TAB', timeUs: 30 }),
      L(3, 1, 'TABLE ACCESS FULL', { object: 'B_TAB', pos: 2, timeUs: 20 }),
    ]))
    expect(painted(o, 1)).toEqual(['WHERE a.id = b.a_id(+)'])
    // formatSql breaks the line at BETWEEN's AND too; the parse does not split there, so both pieces are a's
    expect(painted(o, 2)).toEqual(['FROM a_tab a', 'AND a.x between 1', 'AND 5'])
  })

  it('a WITH query: its table where it is read; a VIEW of it gets its parentheses', () => {
    const text = 'with recent as (select id, amount from orders_x where d > :d) select sum(amount) from recent'
    const m = ok(heat(text, [L(1, 0, 'SORT AGGREGATE', { timeUs: 100 }), L(2, 1, 'TABLE ACCESS FULL', { object: 'ORDERS_X', timeUs: 60 })]))
    expect(painted(m, 2)).toEqual(['FROM orders_x', 'WHERE d > :d'])
    expect(painted(m, 1)).toEqual(['sum(amount)'])
    const v = ok(heat(text, [L(1, 0, 'SORT AGGREGATE', { timeUs: 100 }), L(2, 1, 'VIEW', { timeUs: 90 }), L(3, 2, 'TABLE ACCESS FULL', { object: 'ORDERS_X', timeUs: 60 })]))
    expect(group(v, 2).what).toBe('WITH query RECENT')
    expect(painted(v, 2)).toEqual(['(', ')'])
  })

  it('a merge join: its sorts and the FILTER of its inequality go with the join condition; a join USING', () => {
    const m = ok(heat('select a.x from a_tab a join b_tab b on b.k > a.k', [
      L(1, 0, 'MERGE JOIN', { timeUs: 100 }),
      L(2, 1, 'SORT JOIN', { timeUs: 40 }),
      L(3, 2, 'TABLE ACCESS FULL', { object: 'A_TAB', timeUs: 20 }),
      L(4, 1, 'FILTER', { pos: 2, timeUs: 30 }),
      L(5, 4, 'SORT JOIN', { timeUs: 25 }),
      L(6, 5, 'TABLE ACCESS FULL', { object: 'B_TAB', timeUs: 10 }),
    ]))
    expect(painted(m, 1, 2, 4, 5)).toEqual(['join', 'on b.k > a.k'])
    expect(m.unplaced.parts).toEqual([])
    const u = ok(heat('select x from a_tab join b_tab using (k)', [
      L(1, 0, 'HASH JOIN', { timeUs: 100 }),
      L(2, 1, 'TABLE ACCESS FULL', { object: 'A_TAB', timeUs: 30 }),
      L(3, 1, 'TABLE ACCESS FULL', { object: 'B_TAB', pos: 2, timeUs: 20 }),
    ]))
    expect(painted(u, 1)).toEqual(['join', 'using (k)'])
  })

  it('a column named like SQL syntax (YEAR) is a column of the one table', () => {
    const h = ok(heat('select x from cal_x where year = 2020', [L(1, 0, 'TABLE ACCESS FULL', { object: 'CAL_X', timeUs: 20 })]))
    expect(painted(h, 1)).toEqual(['FROM cal_x', 'WHERE year = 2020'])
  })

  it('the predicates of a ref bundle (access, filter) name the columns the text leaves unqualified', () => {
    const text = 'select x from a_tab, b_tab where a_id = b_id and flag = 1'
    const lines = [
      L(1, 0, 'HASH JOIN', { timeUs: 100 }),
      L(2, 1, 'TABLE ACCESS FULL', { object: 'A_TAB', timeUs: 30 }),
      L(3, 1, 'TABLE ACCESS FULL', { object: 'B_TAB', pos: 2, timeUs: 20 }),
    ]
    const bare = ok(heat(text, lines))
    expect(bare.unplaced.parts.map((p) => p.id)).toEqual([1])
    const x = ok(heat(text, [{ ...lines[0], access: '"A_TAB"."A_ID"="B_TAB"."B_ID"' }, { ...lines[1], filter: '"A_TAB"."FLAG"=1' }, lines[2]]))
    expect(painted(x, 1)).toEqual(['WHERE a_id = b_id'])
    expect(painted(x, 2)).toEqual(['FROM a_tab', 'AND flag = 1'])
    expect(x.groups.every((g) => g.approx.length === 0)).toBe(true)
    expect(x.unplaced.parts).toEqual([])
  })

  it('UNION ALL, and a line that fits nowhere is not placed', () => {
    const h = ok(heat('select a from t1 union all select a from t2', [
      L(1, 0, 'UNION-ALL', { timeUs: 100 }),
      L(2, 1, 'TABLE ACCESS FULL', { object: 'T1', timeUs: 30 }),
      L(3, 1, 'MAT_VIEW REWRITE ACCESS FULL', { object: 'MV_SUM', pos: 2, timeUs: 50 }),
    ]))
    expect(painted(h, 1)).toEqual(['UNION ALL'])
    expect(h.unplaced.parts.map((p) => p.id)).toEqual([3])
    expect(h.unplaced.share).toBeCloseTo(0.5, 9)
    expect(sum(h)).toBeCloseTo(1, 12)
  })

  it('a line without an obj# keeps its object in the operation; partition bounds are not the object', () => {
    const f = ok(heat('select statistic from v$pq_sesstat', [L(1, 0, 'FIXED TABLE FULL X$KXFPSST', { timeUs: 10 })]))
    expect(group(f, 1).approx).toEqual(['the statement reads one table or view, and the plan names X$KXFPSST'])
    const p = ok(heat('select x from sales_p where d > :d', [
      L(1, 0, 'PARTITION RANGE ITERATOR PARTITION: KEY 1048575', { timeUs: 10 }),
      L(2, 1, 'TABLE ACCESS FULL SALES_P PARTITION: KEY', { object: '1048575', timeUs: 9 }),
    ]))
    expect(painted(p, 1, 2)).toEqual(['FROM sales_p', 'WHERE d > :d'])
  })
})

describe('sqlHeat: recursive SQL inside or outside the plan lines', () => {
  // parts / owners, invented: line 3 evaluates full_name(id) for every index entry (the subquery is the key of line 2)
  const text = 'select id from parts where kind = :k and owner_id = (select id from owners where full_name(id) = :n)'
  const lines = [
    L(1, 0, 'TABLE ACCESS BY INDEX ROWID BATCHED', { object: 'PARTS', timeUs: 500, cr: 30 }),
    L(2, 1, 'INDEX RANGE SCAN', { object: 'PARTS_OWNER_IX', timeUs: 450, cr: 25 }),
    L(3, 2, 'INDEX FULL SCAN', { object: 'PK_OWNERS', timeUs: 440, cr: 24 }),
  ]
  const child: HeatChild = { statement: 9, executions: 40, elapsedUs: 3000, exact: true }
  const run = (cover: HeatCover | null) => ok(sqlHeat({ text, lines, executions: 1, children: [child], cover }))

  it('a function in a WHERE predicate a plan line evaluates: its recursive SQL is in that line, the shares stay of the plan', () => {
    const h = run({ executions: 1, execNo: 1, elapsedUs: 700, recursiveUs: 300, exact: true })
    expect(h.basis).toBe('plan')
    expect(h.totalUs).toBe(500)
    expect(h.outside).toBeNull()
    expect(h.rest).toBeNull()
    expect(group(h, 3).share).toBeCloseTo(0.88, 12)
    expect(h.account).toEqual([
      'The plan lines account for 500 µs of 700 µs, the EXEC and FETCH calls of the first execution, which this dump covers.',
      'The recursive SQL under these calls, 300 µs, runs in plan lines (full_name is called only in fragments plan lines evaluate) and is part of their time.',
      'The shares are of the plan lines\' 500 µs.',
    ])
    expect(h.callouts).toHaveLength(1)
  })

  it('more recursive SQL than the line that calls it holds: the excess is outside the plan, on the call', () => {
    const h = run({ executions: 1, execNo: 1, elapsedUs: 700, recursiveUs: 500, exact: true })
    expect(h.basis).toBe('calls')
    expect(h.outside).toMatchObject({ us: 60 })
    expect(h.totalUs).toBe(700)
    expect(h.rest?.us).toBe(140)
    const r = h.groups[h.outside!.group]
    expect(r.recursive).toEqual({ fn: 'full_name', statement: 9 })
    expect(h.lines.flatMap((l) => l.filter((s) => s.group === h.outside!.group).map((s) => s.text))).toEqual(['full_name(id)'])
    expect(group(h, 3).share).toBeCloseTo(440 / 700, 12)
    expect(sum(h)).toBeCloseTo(1, 12)
  })

  it('averages never claim more than the line holds, but a call in the select list is outside the plan with them too', () => {
    expect(run({ executions: 1, execNo: 0, elapsedUs: 700, recursiveUs: 500, exact: false }).basis).toBe('plan')
    const h = ok(sqlHeat({
      text: 'select id, price_of(id) from parts where kind = :k', executions: 1, children: [child],
      lines: [L(1, 0, 'TABLE ACCESS FULL', { object: 'PARTS', timeUs: 100 })],
      cover: { executions: 1, execNo: 0, elapsedUs: 1000, recursiveUs: 600, exact: false },
    }))
    expect(h.basis).toBe('calls')
    expect(painted(h, 1)).toEqual(['FROM parts', 'WHERE kind = :k'])
    expect(group(h, 1).share).toBeCloseTo(0.1, 12)
    expect(h.groups[0].share).toBeCloseTo(0.6, 12)
    expect(h.groups[0].approx).toContain('averaged over the statement\'s executions')
    expect(h.account[0]).toBe('The plan lines account for 100 µs; an execution of this statement takes 1.00 ms in its EXEC and FETCH calls on average (the document has no call facts for the execution this dump covers).')
  })

  it('several functions called outside the plan: their recursive SQL is outside it, listed but not tinted; in and out, the split is not known', () => {
    const scan = [L(1, 0, 'TABLE ACCESS FULL', { object: 'PARTS', timeUs: 100 })]
    const cover: HeatCover = { executions: 1, execNo: 1, elapsedUs: 1000, recursiveUs: 60, exact: true }
    const two = ok(sqlHeat({ text: 'select price_of(id), owner_of(id) from parts', lines: scan, executions: 1, children: [child], cover }))
    expect(two.basis).toBe('calls')
    expect(two.outside).toMatchObject({ us: 60, group: -1 })
    expect(two.groups.map((g) => g.what)).toEqual(['parts'])
    expect(two.callouts).toEqual([])
    expect(sum(two)).toBeCloseTo(1, 12)
    expect(two.account[1]).toBe('Recursive SQL outside the plan lines takes 60 µs (≈, from price_of, owner_of: not placed in the text), and 840 µs are in neither. The shares are of the 1.00 ms of these calls.')
    const mixed = ok(sqlHeat({ text: 'select price_of(id) from parts where price_of(id) > 0', lines: scan, executions: 1, children: [child], cover }))
    expect(mixed.basis).toBe('plan')
    expect(mixed.account[1]).toBe('The recursive SQL under these calls, 60 µs, may run partly outside the plan lines: price_of is called both in fragments plan lines evaluate and outside them, so the split is not known.')
  })

  it('without a cover the shares are of the plan, and the view says it cannot compare', () => {
    const h = run(null)
    expect(h.basis).toBe('plan')
    expect(h.account).toEqual(['The shares are of the plan lines\' self time, 500 µs; the executions this dump covers are not known, so it is not compared with the statement\'s time.'])
  })

  it('counts the executions a dump adds up by its main row source\'s starts', () => {
    expect(dumpExecutions(lines)).toBe(1)
    expect(dumpExecutions([L(1, 0, 'SORT AGGREGATE', { starts: 3 }), L(2, 1, 'TABLE ACCESS FULL', { starts: 3 })])).toBe(3)
    // a scalar subquery beside the main query starts once per row
    expect(dumpExecutions([L(1, 0, 'SORT AGGREGATE', { starts: 50 }), L(2, 1, 'INDEX UNIQUE SCAN', { starts: 50 }), L(3, 0, 'TABLE ACCESS FULL', { pos: 2, starts: 2 })])).toBe(2)
    expect(dumpExecutions([L(1, 0, 'PX COORDINATOR', { starts: 0 })])).toBe(1)
  })
})

describe('sqlHeat falls back to the table, with a note', () => {
  const scan = [L(1, 0, 'TABLE ACCESS FULL', { object: 'T', timeUs: 10 })]
  it('for a PL/SQL block, a DML, other statements and text it cannot read', () => {
    expect(heat("declare\n  v number;\nbegin\n  v := mtk_f(10);\nend;", scan)).toMatchObject({ ok: false, why: 'plsql' })
    expect(heat('update t set x = 1', scan)).toMatchObject({ ok: false, why: 'dml', note: 'SQL heat reads queries (SELECT and WITH); this statement is an UPDATE, so the table shows instead.' })
    expect(heat('alter session set x = 1', scan)).toMatchObject({ ok: false, why: 'other' })
    expect(heat('select (x from t', scan)).toMatchObject({ ok: false, why: 'parse' })
  })
  it('for a dump without statistics, without time, without lines', () => {
    expect(heat('select x from t', [L(1, 0, 'TABLE ACCESS FULL', { object: 'T', hasStats: false })])).toMatchObject({ ok: false, why: 'nostats' })
    expect(heat('select x from t', [L(1, 0, 'TABLE ACCESS FULL', { object: 'T' })])).toMatchObject({ ok: false, why: 'notime' })
    expect(heat('select x from t', [])).toMatchObject({ ok: false, why: 'empty' })
  })
})

describe('heatTint', () => {
  it('no tint below 1 %, then 8 % to 55 %', () => {
    expect(heatTint(HEAT_MIN_SHARE / 2)).toBe(0)
    expect(heatTint(0.01)).toBeCloseTo(8.47, 6)
    expect(heatTint(1)).toBe(55)
  })
})

describe('heatDump', () => {
  // a dump the model split in three (an interleaved 10053 trace), and the next dump of the same cursor
  const lines = [L(1, 0, 'A'), L(2, 1, 'B'), L(3, 2, 'C'), L(4, 3, 'D'), L(5, 1, 'E'), L(1, 0, 'A')]
  const plan = (id: number, first: number, n: number): Plan => ({ id, line: 100 + first, cursor: 0, statement: 0, planHash: 7, first, n })
  const plans = [plan(0, 0, 2), plan(1, 2, 2), plan(2, 4, 1), plan(3, 5, 1)]
  const doc = { plansOf: () => plans, planLines: lines } as unknown as TraceDoc
  it('joins the pieces, from the head or from any piece', () => {
    for (const p of plans.slice(0, 3)) expect(heatDump(doc, p).map((l) => l.op)).toEqual(['A', 'B', 'C', 'D', 'E'])
    expect(heatDump(doc, plans[3]).map((l) => l.op)).toEqual(['A'])
  })
})

// Every plan of every fixture document: never throws; the shares add up to 100 %; each plan line is in one group or
// not placed; the runs rebuild formatSql's lines.
describe('sqlHeat on every fixture plan', async () => {
  const files = readdirSync(dir).filter((f) => f.startsWith('findings-') && f.endsWith('.json.gz'))
  for (const f of files) {
    const doc = await load(f)
    it(f, () => {
      let heated = 0
      const switched: string[] = []
      for (const st of doc.statements) {
        for (const p of doc.plansOf(st.id)) {
          const input = heatInput(doc, p)
          const h = sqlHeat(input)
          if (!h.ok) { expect(h.note).toBeTruthy(); continue }
          heated++
          expect(sum(h), `${f} stmt ${st.id}`).toBeCloseTo(1, 9)
          // nothing outside the plan: the shares stay of the plan lines' self time
          if (h.basis === 'plan') expect(h.totalUs).toBe(h.planUs)
          else switched.push(st.text.slice(0, 40))
          const ids = [...h.groups.flatMap((g) => g.parts), ...h.unplaced.parts].map((x) => x.id).sort((a, b) => a - b)
          const lineIds = input.lines.map((l) => l.id).sort((a, b) => a - b)
          expect(ids, `${f} stmt ${st.id}`).toEqual(lineIds)
          expect(h.lines.map((l) => l.map((s) => s.text).join('')), `${f} stmt ${st.id}`).toEqual(formatSql(st.text).join('\n').split('\n'))
          for (const g of h.groups) expect(g.firstLine).toBeGreaterThanOrEqual(0)
        }
      }
      expect(heated).toBeGreaterThan(0)
      // the one statement of the fixtures whose recursive SQL runs outside the plan
      expect(switched).toEqual(f === 'findings-plsql_recursive.json.gz' ? ['select /* mtk_f_from_sql */ id, mtk_f(id'] : [])
    })
  }
})
