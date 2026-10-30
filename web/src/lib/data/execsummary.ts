import type { TraceDoc } from './doc'
import { ALL_SCOPE } from './lines'
import { sourceOf, type ExecDetail } from './source'
import type { Execution } from './derive'
import { CallKind, type ID } from './types'
import { fmtDur, fmtInt } from './format'

/** One execution of a statement in a few numbers: what the line inspector's EXECUTION section shows. */
export interface ExecSummary {
  execNo: number
  /** executions of the statement */
  total: number
  elapsedUs: number
  cpuUs: number
  rows: number
  fetches: number
  /** physical reads */
  disk: number
  /** consistent plus current gets */
  gets: number
  hardParse: boolean
  waits: { event: ID; count: number; us: number }[]
  waitUs: number
  plh: number
  /** trace line of the BINDS block (0 = none) */
  bindLine: number
}

/** The summary of an execution from its row and detail; `total` is the number of executions of the statement. */
export function execSummaryOf(detail: ExecDetail, row: Execution, total: number, hardParse = false): ExecSummary {
  return {
    execNo: row.execNo, total, elapsedUs: row.e, cpuUs: row.c, rows: row.r, fetches: row.fetches || detail.fetch.calls,
    disk: row.p, gets: row.cr + row.cu, hardParse,
    waits: detail.waits.map((w) => ({ event: w.event, count: w.count, us: w.us })), waitUs: detail.waits.reduce((a, w) => a + w.us, 0),
    plh: detail.plh, bindLine: detail.bindLine,
  }
}

/** The `n` waits with the most time, longest first. */
export function topWaits(s: Pick<ExecSummary, 'waits'>, n = 5): ExecSummary['waits'] {
  return [...s.waits].sort((a, b) => b.us - a.us || b.count - a.count).slice(0, n)
}

/** Whether the PARSE call before the execution was a library cache miss; false where the doc has no call columns (a served doc). */
function hardParseOf(doc: TraceDoc, stmt: ID, row: Execution): boolean {
  const c = doc.calls
  if (c.n === 0 || row.exec < 0 || row.exec >= c.n) return false
  const ids = doc.callsByStmt.get(stmt)
  for (let k = ids.indexOf(row.exec) - 1; k >= 0; k--) {
    const i = ids[k]
    if (c.cursor[i] !== row.cursor) continue
    return c.kind[i] === CallKind.parse && c.mis[i] > 0
  }
  return false
}

const CAP = 200
const cache = new WeakMap<TraceDoc, Map<string, ExecSummary | null>>()

/** Fetch and cache (per document, `${stmt}:${cursor}:${execNo}`, 200 entries) the summary; null when the execution is not listed. */
export async function loadExecSummary(doc: TraceDoc, stmt: number, cursor: number, execNo: number, signal?: AbortSignal): Promise<ExecSummary | null> {
  let m = cache.get(doc)
  if (!m) { m = new Map(); cache.set(doc, m) }
  const key = `${stmt}:${cursor}:${execNo}`
  if (m.has(key)) {
    const hit = m.get(key)!
    m.delete(key) // refresh the entry: the oldest is dropped first
    m.set(key, hit)
    return hit
  }
  const source = sourceOf(doc)
  const page = await source.executions(stmt, ALL_SCOPE, signal)
  const row = page.rows.find((r) => r.cursor === cursor && r.execNo === execNo)
  let out: ExecSummary | null = null
  if (row) {
    const detail = await source.executionDetail(stmt, row, signal)
    out = execSummaryOf(detail, row, page.total, hardParseOf(doc, stmt, row))
  }
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
  m.set(key, out)
  while (m.size > CAP) m.delete(m.keys().next().value as string)
  return out
}

/** The summary as lines of text (the inspector's Copy); `eventName` names a wait event id. */
export function execSummaryLines(s: ExecSummary, eventName: (id: ID) => string): string[] {
  const out = [`Execution ${s.execNo} of ${fmtInt(s.total)}${s.plh > 0 ? ` · plan hash ${s.plh}` : ''}${s.hardParse ? ' · hard parse' : ''}`]
  out.push(`Elapsed: ${fmtDur(s.elapsedUs)}`, `CPU: ${fmtDur(s.cpuUs)}`, `Rows: ${fmtInt(s.rows)}`, `Fetches: ${fmtInt(s.fetches)}`)
  out.push(`Disk reads: ${fmtInt(s.disk)}`, `Buffer gets: ${fmtInt(s.gets)}`, `Waits: ${fmtInt(s.waits.reduce((a, w) => a + w.count, 0))} · ${fmtDur(s.waitUs)}`)
  for (const w of topWaits(s)) out.push(`  ${eventName(w.event)} · ${fmtInt(w.count)} · ${fmtDur(w.us)}`)
  return out
}
