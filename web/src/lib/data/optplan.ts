// The final plan of a dump as the rows of the plan visualizer (the lib's `data/planviz.ts` builds the link from them). Estimates only: a 10053
// plan table holds what the optimizer expected, no actual rows or times. The numbers are the trace's own words ("96K"); the visualizer's
// contract wants numbers, so a value that is a plain count is sent as one, and a rounded one ("96K", "1149K") is expanded.
import type { OptPlan, OptPlanRow } from './opt'
import type { PlanRow } from './planviz'

/** "96K" -> 96000, "1149K" -> 1149000, "12M" -> 12000000, "385" -> 385; undefined for an empty or unreadable value. */
export function planNumber(s: string): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?)\s*([KMGT]?)\s*$/i.exec(s)
  if (!m) return undefined
  const mult = { '': 1, K: 1e3, M: 1e6, G: 1e9, T: 1e12 }[m[2].toUpperCase() as '' | 'K' | 'M' | 'G' | 'T']
  return Math.round(Number(m[1]) * mult)
}

/** The "parent" of each operation: the nearest operation above with a smaller depth. */
export function planParents(rows: readonly OptPlanRow[]): (number | undefined)[] {
  const stack: OptPlanRow[] = []
  return rows.map((r) => {
    while (stack.length > 0 && stack[stack.length - 1].depth >= r.depth) stack.pop()
    const p = stack[stack.length - 1]
    stack.push(r)
    return p?.id
  })
}

/** One object per plan operation, in the visualizer's JSON contract. `sqlId` and `sql` go on the first row. */
export function optPlanRows(plan: OptPlan, meta: { sqlId?: string; planHash?: string; sql?: string } = {}): PlanRow[] {
  const parents = planParents(plan.rows)
  return plan.rows.map((o, i) => {
    const r: PlanRow = { id: o.id }
    if (parents[i] !== undefined) r.parent_id = parents[i] as number
    r.depth = o.depth
    r.operation = o.op
    if (o.name) r.object_name = o.name
    const card = planNumber(o.rows)
    if (card !== undefined) r.cardinality = card
    const bytes = planNumber(o.bytes)
    if (bytes !== undefined) r.bytes = bytes
    const cost = planNumber(o.cost)
    if (cost !== undefined) r.cost = cost
    if (meta.sqlId) r.sql_id = meta.sqlId
    if (meta.planHash) r.plan_hash_value = meta.planHash
    if (i === 0 && meta.sql) r.sql_text = meta.sql
    return r
  })
}
