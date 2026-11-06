import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { parsePlanRows } from '@davidbudac/ora-plan-core'
import { alignEstimates, planFindings } from './advisor'
import { planRows, type PlanRow } from './planviz'
import { TraceDoc } from './doc'
import { rowFlow } from './rowflow'
import type { RawDocument } from './types'

const row = (id: number, parent: number | null, depth: number, operation: string, extra: PlanRow = {}): PlanRow =>
  ({ id, ...(parent === null ? {} : { parent_id: parent }), depth, operation, starts: 1, actual_rows: 10, actual_elapsed_time: 1000, ...extra })

describe('planFindings', () => {
  it('reports a cardinality misestimate on the node that has it', () => {
    const f = planFindings([
      row(0, null, 0, 'SELECT STATEMENT', { actual_rows: 5000 }),
      row(1, 0, 1, 'TABLE ACCESS FULL', { object_name: 'T1', cardinality: 1, actual_rows: 5000, cost: 3 }),
    ])
    expect(f.some((x) => x.ruleId === 'cardinality-mismatch' && x.nodeIds.includes(1))).toBe(true)
    expect(f.every((x) => x.title && ['info', 'warning', 'critical'].includes(x.severity))).toBe(true)
  })

  it('returns nothing for an empty or healthy plan', () => {
    expect(planFindings([])).toEqual([])
    expect(planFindings([
      row(0, null, 0, 'SELECT STATEMENT'),
      row(1, 0, 1, 'INDEX UNIQUE SCAN', { object_name: 'PK', cardinality: 10, actual_rows: 10 }),
    ])).toEqual([])
  })
})

// testdata/traces/19c/nasty_sql.trc, 57b0w2txwjvby (a 1,119-value IN list): INDEX UNIQUE SCAN MTK_CUST_PK under INLIST ITERATOR,
// str=1119 card=1119 cnt=1119. The card covers every iteration; E-Rows × starts (1,252,161) made the core report a 1,119×
// misestimate that Row flow does not show. The document is findings-nasty_sql.json.gz (internal/report TestFindingsDocsCurrent).
describe('planFindings follows Row flow\'s estimate (nasty_sql.trc)', async () => {
  const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
  const doc = await TraceDoc.fromRaw((JSON.parse(gunzipSync(readFileSync(dir + 'findings-nasty_sql.json.gz')).toString('utf8')) as { doc: RawDocument }).doc)
  const st = doc.statements.find((s) => s.sqlId === '57b0w2txwjvby')!
  const plan = doc.plansOf(st.id).find((p) => doc.planLines.slice(p.first, p.first + p.n).some((l) => l.op.startsWith('INLIST ITERATOR')))!

  it('reports no cardinality mismatch below the INLIST ITERATOR', () => {
    const rows = planRows(doc, plan)
    const scan = rows.find((r) => String(r.operation).startsWith('INDEX UNIQUE SCAN'))!
    expect([scan.starts, scan.cardinality, scan.actual_rows]).toEqual([1119, 1119, 1119])
    expect(planFindings(rows).filter((f) => f.ruleId === 'cardinality-mismatch')).toEqual([])
  })

  it('gives every node the estimate Row flow compares (E-Rows × starts, not below an iterator)', () => {
    const core = parsePlanRows(planRows(doc, plan))
    expect(core.allNodes.find((n) => n.operation.startsWith('INDEX UNIQUE SCAN'))!.estimatedRowsTotal).toBe(1119 * 1119) // the core alone
    alignEstimates(core)
    const flow = rowFlow(doc.planLines.slice(plan.first, plan.first + plan.n))
    for (const n of core.allNodes) {
      const x = flow.nodes.find((y) => y.index >= 0 && y.line.id === n.id)!
      expect(n.estimatedRowsTotal ?? -1, `id ${n.id} ${n.operation}`).toBe(x.estRows)
    }
  })

  it('still multiplies a nested loop\'s inner side by its starts', () => {
    const f = planFindings([
      row(1, null, 0, 'NESTED LOOPS', { cardinality: 5, actual_rows: 5 }),
      row(2, 1, 1, 'TABLE ACCESS FULL', { object_name: 'T', cardinality: 5, actual_rows: 5 }),
      row(3, 1, 1, 'INDEX UNIQUE SCAN', { object_name: 'T_PK', cardinality: 1, starts: 5000, actual_rows: 5000 }),
    ])
    expect(f.filter((x) => x.ruleId === 'cardinality-mismatch')).toEqual([])
  })
})
