import { parsePlanRows, runAdvisor, type Finding, type ParsedPlan } from '@davidbudac/ora-plan-core'
import type { PlanRow } from './planviz'
import { comparableEstimate, isIterator } from './rowflow'

export type { Finding }

/** The visualizer's plan advisor (shared core package) over one STAT plan's JSON rows, most severe first. Metadata-free rules only. */
export function planFindings(rows: PlanRow[]): Finding[] {
  if (rows.length === 0) return []
  try {
    const plan = parsePlanRows(rows)
    alignEstimates(plan)
    return runAdvisor(plan, null).findings
  } catch {
    return [] // a plan the core cannot read just shows no advice
  }
}

/**
 * Gives the core's nodes Row flow's estimate over all starts (`comparableEstimate` in rowflow.ts), so the advisor's cardinality
 * rule and Row flow's ghost compare A-Rows with the same number. The core multiplies E-Rows by the starts below an INLIST
 * ITERATOR too (nasty_sql.trc 57b0w2txwjvby: 1119 × 1119 against 1119 rows, a 1,119× "misestimate"), and by an index's starts for
 * a rowid fetch that ran once. Where the core has no comparable total (never started, inactive, early end below COUNT STOPKEY,
 * no estimate) it keeps none. The core is vendored (web/vendor/ora-plan-core, do not edit), so the rule is applied here.
 */
export function alignEstimates(plan: ParsedPlan): void {
  const byId = new Map(plan.allNodes.map((n) => [n.id, n]))
  for (const n of plan.allNodes) {
    if (n.estimatedRowsTotal === undefined || n.rows === undefined) continue
    let iterated = false
    for (let a = n.parentId === undefined ? undefined : byId.get(n.parentId), hops = 0; a && !iterated && hops <= plan.allNodes.length; hops++) {
      iterated = isIterator(a.operation)
      a = a.parentId === undefined ? undefined : byId.get(a.parentId)
    }
    n.estimatedRowsTotal = comparableEstimate(n.rows, n.starts ?? 1, iterated)
  }
}
