import { describe, expect, it } from 'vitest'
import { planFindings } from './advisor'
import type { PlanRow } from './planviz'

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
