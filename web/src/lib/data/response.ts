// A statement's share of the response time: one definition for the Statements list, the statement detail, the Overview
// statement ledger and its lede, so the same number reads the same everywhere.
import { scopeSpanUs, type FileSetDoc } from './fileset'
import type { StmtStats } from './types'

/**
 * A statement's response time: the elapsed time of its calls not nested in another call of the same statement (recursive
 * children of other statements included) plus the between-call waits attributed to it (`StmtStats.idleUs`, think time).
 */
export const responseUs = (s: Pick<StmtStats, 'elapsed' | 'idleUs'>): number => s.elapsed + s.idleUs

/**
 * What the share is measured against: the scope's response time as the Overview heading and ledger have it (`scopeSpanUs`:
 * the time window, else the wall-clock span of the selected files, else of the trace). `narrowed` false means the numbers
 * are the whole trace's (no scope, or an engine that cannot answer statistics of one), so the base is the whole trace's too.
 */
export function responseBaseUs(doc: Pick<FileSetDoc, 'file'> & { spanUs(): number }, window: { startTim: number; endTim: number } | null, files: ReadonlySet<number> | null, narrowed: boolean): number {
  return narrowed ? scopeSpanUs(doc, window, files) : doc.spanUs()
}

/**
 * Share of the base, 0..1 and beyond. Not capped: the statement's time is summed over the sessions of the scope (two sessions
 * running it at once count twice against the wall clock), so a statement can exceed 100 % of its scope; `shareNote` says so.
 * An idle wait inside a call (PL/SQL lock timer of a sleep) is in the call's elapsed time only, not in `idleUs`.
 */
export function responseShare(s: Pick<StmtStats, 'elapsed' | 'idleUs'>, baseUs: number): number {
  return baseUs > 0 ? responseUs(s) / baseUs : 0
}

/** Tooltip for a share above 100 %. */
export function shareNote(share: number): string | undefined {
  return share > 1 ? 'above 100 %: the time of sessions running at once is summed' : undefined
}
