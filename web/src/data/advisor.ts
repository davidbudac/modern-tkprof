import { parsePlanRows, runAdvisor, type Finding } from '@davidbudac/ora-plan-core'
import type { PlanRow } from './planviz'

export type { Finding }

/** The visualizer's plan advisor (shared core package) over one STAT plan's JSON rows, most severe first. Metadata-free rules only. */
export function planFindings(rows: PlanRow[]): Finding[] {
  if (rows.length === 0) return []
  try {
    return runAdvisor(parsePlanRows(rows), null).findings
  } catch {
    return [] // a plan the core cannot read just shows no advice
  }
}
