// The Statements list's rows: the filter (empty calls, hide-SYS, the search text) and the ranking, as pure functions so the
// cost of a keystroke can be timed and the semantics tested without React.
import type { TraceDoc } from './doc'
import type { StmtStats } from './types'
import type { StmtSortKey } from '../state/store'
import { responseUs } from './response'

export const stmtSorts: { id: StmtSortKey; label: string; of: (s: StmtStats, inclusive: boolean) => number }[] = [
  { id: 'resp', label: 'response time', of: (s) => responseUs(s) },
  // earliest first, as in the Overview timeline lanes; statements never called sort last
  { id: 'first', label: 'first call', of: (s) => (s.firstTim > 0 ? -s.firstTim : -Infinity) },
  { id: 'self', label: 'self time', of: (s) => s.selfElapsed },
  { id: 'cpu', label: 'CPU', of: (s, inc) => (inc ? s.cpu : s.selfCpu) },
  { id: 'waits', label: 'wait time', of: (s) => s.waitUs },
  { id: 'idle', label: 'idle time', of: (s) => s.idleUs },
  { id: 'execs', label: 'executions', of: (s) => s.executions },
  { id: 'rows', label: 'rows', of: (s) => s.allCalls.rows },
  { id: 'disk', label: 'disk reads', of: (s, inc) => (inc ? s.allCalls.disk : s.allCalls.selfDisk) },
  { id: 'query', label: 'consistent gets', of: (s, inc) => (inc ? s.allCalls.query : s.allCalls.selfQuery) },
  { id: 'hard', label: 'hard parses', of: (s) => s.hardParses },
  { id: 'errors', label: 'errors', of: (s) => s.errors },
]

export interface StmtFilterOpts {
  /** the statistics are a scope's (a statement with no call in scope is left out even if it has errors) */
  narrowed: boolean
  hideSys: boolean
  /** the filter text as typed */
  q: string
}

export interface StmtRowsOpts extends StmtFilterOpts {
  sort: StmtSortKey
  inclusive: boolean
}

/** Joins a statement's two searched fields; a character a search box cannot hold, so a needle never matches across it. */
const SEP = '\u0000'
const indexes = new WeakMap<TraceDoc, string[]>()

/**
 * The lowercased `sqlId` and text of every statement of `doc` (by statement id), built on first use and dropped with the
 * document (a live session's next snapshot is another `TraceDoc`, a closed trace's goes away with it).
 */
export function searchIndex(doc: TraceDoc): string[] {
  let ix = indexes.get(doc)
  if (!ix) indexes.set(doc, (ix = doc.statements.map((st) => st.sqlId.toLowerCase() + SEP + st.text.toLowerCase())))
  return ix
}

/** `stats` ranked by `sort` (a copy; ties by elapsed time, then in `stats` order). It does not depend on the filters, so a keystroke does not redo it. */
export function rankStatements(stats: StmtStats[], sortKey: StmtSortKey, inclusive: boolean): StmtStats[] {
  const sort = stmtSorts.find((s) => s.id === sortKey)!
  return stats.slice().sort((a, b) => sort.of(b, inclusive) - sort.of(a, inclusive) || b.elapsed - a.elapsed)
}

/** The rows of `ranked` that pass the filters, in the same order (a stable filter of a ranked list is the ranked filtered list). */
export function filterStatements(doc: TraceDoc, ranked: StmtStats[], o: StmtFilterOpts): StmtStats[] {
  const needle = o.q.trim().toLowerCase()
  const ix = needle ? searchIndex(doc) : null
  return ranked.filter((s) => {
    if (s.allCalls.count === 0 && (o.narrowed || s.errors === 0)) return false
    if (o.hideSys) {
      const st = doc.statements[s.id]
      if (st.parsingUserId === 0 && s.minDepth > 0) return false
    }
    return !ix || ix[s.id].includes(needle)
  })
}

/** The rows of the Statements list: the statements that pass the filters, ranked by `sort` (ties by elapsed time). */
export function statementRows(doc: TraceDoc, stats: StmtStats[], o: StmtRowsOpts): StmtStats[] {
  return filterStatements(doc, rankStatements(stats, o.sort, o.inclusive), o)
}
