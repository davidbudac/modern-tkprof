import { describe, expect, it } from 'vitest'
import { optPlanRows, planNumber, planParents } from './optplan'
import type { OptPlan } from './opt'

describe('planNumber', () => {
  it('expands the trace\'s rounded numbers', () => {
    expect([planNumber('385'), planNumber('96K'), planNumber('1149K'), planNumber('12M'), planNumber('1.5K'), planNumber(''), planNumber('00:00:05'), planNumber(' 7 ')]).toEqual([385, 96000, 1149000, 12000000, 1500, undefined, undefined, 7])
  })
})

const plan: OptPlan = {
  from: 1, head: 3, tableTo: 9, to: 12, cols: ['Id', 'Operation'], qbs: {}, preds: {},
  rows: [
    { line: 4, id: 0, depth: 0, op: 'SELECT STATEMENT', name: '', rows: '', bytes: '', cost: '385', time: '' },
    { line: 5, id: 1, depth: 1, op: 'HASH JOIN', name: '', rows: '1', bytes: '81', cost: '383', time: '00:00:05' },
    { line: 6, id: 2, depth: 2, op: 'TABLE ACCESS FULL', name: 'MTK_CUST', rows: '96K', bytes: '2M', cost: '245', time: '00:00:03' },
    { line: 7, id: 3, depth: 2, op: 'INDEX RANGE SCAN', name: 'IX', rows: '1', bytes: '', cost: '2', time: '00:00:01' },
  ],
}

describe('the plan for the visualizer', () => {
  it('finds the parent of each operation from the depths', () => {
    expect(planParents(plan.rows)).toEqual([undefined, 0, 1, 1])
  })
  it('is one object per operation, estimates only, in the visualizer\'s contract', () => {
    const rows = optPlanRows(plan, { sqlId: 'abc', planHash: '123', sql: 'select 1' })
    expect(rows).toHaveLength(4)
    expect(rows[0]).toEqual({ id: 0, depth: 0, operation: 'SELECT STATEMENT', cost: 385, sql_id: 'abc', plan_hash_value: '123', sql_text: 'select 1' })
    expect(rows[2]).toEqual({ id: 2, parent_id: 1, depth: 2, operation: 'TABLE ACCESS FULL', object_name: 'MTK_CUST', cardinality: 96000, bytes: 2000000, cost: 245, sql_id: 'abc', plan_hash_value: '123' })
    expect(rows[3].bytes).toBeUndefined()
    expect(rows.some((r) => 'actual_rows' in r || 'starts' in r)).toBe(false)
  })
})
