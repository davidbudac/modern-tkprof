// The statement picker of the formatted view's overview row: the statements of one input file by the time they took, filtered by what the user types.
import type { TraceDoc } from './doc'
import { stmtLineIn } from './lines'

/** A statement as the picker lists it. */
export interface PickRow {
  id: number
  /** the sql_id (or the synthetic label: `hv:123`, `commit`, …) */
  label: string
  /** elapsed µs (the statement's, as the overview and the sticky lane row say it) */
  e: number
  executions: number
  /** the SQL with its whitespace runs collapsed to one space (what the row shows and the filter matches) */
  flat: string
  /** `flat` and the label in lower case, for the filter */
  hay: string
  /** the statement's first line in this file */
  line: number
}

/** A text with every run of whitespace as one space, trimmed. */
export const flatten = (s: string) => s.replace(/\s+/g, ' ').trim()

/**
 * The statements that have a cursor in `file`, longest first (ties: the one that comes first in the file). The picker lists these: the overview's
 * chips covered the 8 longest, this covers the file, thousands of statements on a SQLT trace; recursive SYS SQL and statements without time are in it.
 */
export function pickRows(doc: Pick<TraceDoc, 'statements' | 'cursors' | 'fileOfCursor' | 'stats' | 'label'>, file: number): PickRow[] {
  const out: PickRow[] = []
  for (const s of doc.statements) {
    const line = stmtLineIn(doc, file, s.id)
    if (line === undefined) continue
    const st = doc.stats.statements[s.id]
    const label = doc.label(s)
    const flat = flatten(s.text)
    out.push({ id: s.id, label, e: st?.elapsed ?? 0, executions: st?.executions ?? 0, flat, hay: `${label}\n${flat}`.toLowerCase(), line })
  }
  return out.sort((a, b) => b.e - a.e || a.line - b.line || a.id - b.id)
}

/** The rows whose sql_id or SQL text contains the query (case-insensitive, whitespace in the query matches any whitespace of the text); the order is kept. */
export function filterRows(rows: readonly PickRow[], query: string): PickRow[] {
  const q = flatten(query).toLowerCase()
  return q === '' ? rows.slice() : rows.filter((r) => r.hay.includes(q))
}

/** A cut of a row's SQL: the text to show and, when the filter matched inside it, the matched span of that text. */
export interface SqlCut { text: string; mark?: [number, number] }

/**
 * The SQL of a row cut to `width` characters: its start, as the plan and the lane row show it. When the filter matches the text but beyond the cut,
 * the cut moves to the match (`…` before it), so a text filter shows why the statement is listed.
 */
export function sqlCut(row: Pick<PickRow, 'flat'>, query: string, width: number): SqlCut {
  const { flat } = row
  const q = flatten(query).toLowerCase()
  const lower = flat.toLowerCase()
  const at = q === '' || lower.length !== flat.length ? -1 : lower.indexOf(q) // (a case fold that changes the length would shift the offsets)
  const head = flat.length > width ? width - 1 : flat.length // the characters the start shows (the last place of a longer text is the ellipsis)
  if (at < 0 || at + q.length <= head) {
    const text = flat.length > width ? flat.slice(0, head) + '…' : flat
    return at >= 0 ? { text, mark: [at, at + q.length] } : { text }
  }
  // the match lies beyond the start: show the text around it, a little context before
  const from = Math.max(0, Math.min(at - 12, flat.length - (width - 2)))
  const body = flat.slice(from, from + width - 2)
  const end = from + body.length
  return { text: `…${body}${end < flat.length ? '…' : ''}`, mark: [1 + at - from, 1 + Math.min(at + q.length, end) - from] }
}
