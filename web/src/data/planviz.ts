import type { Plan } from './types'
import type { TraceDoc } from './doc'

/** Hosted visualizer (davidbudac/ora-explain-plan-viz) used when nothing overrides it. */
export const DEFAULT_PLAN_VIZ = 'https://davidbudac.github.io/ora-explain-plan-viz/'
export const PLAN_VIZ_KEY = 'mtkprof.planVizUrl'
/** Links longer than this are not offered; the plan is copied as JSON instead. */
export const MAX_LINK_CHARS = 100000

export type PlanRow = Record<string, string | number>

/** One object per plan line, in the visualizer's JSON contract (see docs/DESIGN.md § Plans). `execution` is the 1-based ordinal of this dump among the statement's dumps with the same plan hash. */
export function planRows(doc: TraceDoc, plan: Plan): PlanRow[] {
  const st = doc.statements[plan.statement]
  const sameHash = doc.plansOf(plan.statement).filter((p) => p.planHash === plan.planHash)
  const execution = Math.max(1, sameHash.findIndex((p) => p.id === plan.id) + 1)
  const lines = doc.planLines.slice(plan.first, plan.first + plan.n)
  return lines.map((l, i) => {
    const r: PlanRow = { id: l.id }
    if (!(l.parentId === 0 || (i === 0 && l.depth === 0))) r.parent_id = l.parentId
    r.depth = l.depth
    r.operation = l.op
    if (l.object) r.object_name = l.object
    if (l.obj > 0) r.object_id = l.obj
    if (l.card >= 0) r.cardinality = l.card
    if (l.size >= 0) r.bytes = l.size
    if (l.cost >= 0) r.cost = l.cost
    r.actual_rows = l.rows
    r.starts = l.starts
    r.actual_elapsed_time = l.timeUs
    r.cr_buffer_gets = l.cr
    r.physical_reads = l.pr
    r.physical_writes = l.pw
    r.sql_id = st?.sqlId ?? ''
    r.plan_hash_value = String(plan.planHash)
    if (i === 0) { r.sql_text = st?.text ?? ''; r.execution = execution; r.trace_line = plan.line }
    return r
  })
}

/** Base URL precedence: localStorage override > document `planViz` > hosted default. */
export function planVizBase(doc: TraceDoc): string {
  return planVizOverride() || doc.planViz || DEFAULT_PLAN_VIZ
}

export function planVizOverride(): string {
  try { return localStorage.getItem(PLAN_VIZ_KEY)?.trim() ?? '' } catch { return '' }
}

export function setPlanVizOverride(url: string): void {
  try {
    const v = url.trim()
    if (v) localStorage.setItem(PLAN_VIZ_KEY, v); else localStorage.removeItem(PLAN_VIZ_KEY)
  } catch { /* storage unavailable */ }
}

export const canGzip = typeof CompressionStream !== 'undefined'

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** `${base}#gz=<base64url(gzip(json))>`; the plan travels only in the fragment. Throws when CompressionStream is missing. */
export async function planVizUrl(base: string, rows: PlanRow[]): Promise<string> {
  if (!canGzip) throw new Error('CompressionStream is not available')
  const payload = JSON.stringify({ plans: [{ rawInput: JSON.stringify(rows) }], viewMode: 'hierarchical' })
  return `${base.replace(/#.*$/, '')}#gz=${base64url(await gzip(payload))}`
}
