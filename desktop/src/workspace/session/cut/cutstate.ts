// The decisions of the Cut view that do not need React: which answer belongs to which request (useJSON), whether the plan on
// screen is the current query's, when the re-parse check runs, and the statements the picker offers.
import { filterRows, flatten, type PickRow, type TraceDoc } from '@lib'
import type { CutPlan } from './cutlayout'

/**
 * The last settled answer of a `useJSON`: the path it answered, the document it answered for (`epoch`: the same path of a
 * live session's next snapshot is another question) and its data or error.
 */
export interface JSONState<T> { path: string | null; epoch?: unknown; data?: T; error?: string }

/** A settled request: its data or its error. */
export type JSONResult<T> = { data: T } | { error: string }

/**
 * The state after the request for `path` settled. An aborted request never lands: its path is no longer wanted (the effect
 * was cleaned up) and a late answer must not replace the one of a newer request, however the fetch and the abort raced.
 */
export function jsonSettle<T>(st: JSONState<T>, path: string, r: JSONResult<T>, aborted: boolean, epoch?: unknown): JSONState<T> {
  if (aborted) return st
  return 'error' in r ? { path, epoch, error: r.error } : { path, epoch, data: r.data }
}

/** What a `useJSON` returns: the data it holds, the path that data answers (`null`: none), loading and the error of `path`. */
export interface JSONView<T> { data?: T; path: string | null; loading: boolean; error?: string }

/**
 * The view of `st` for the wanted `path` of the document `epoch`: while another path (or the same path of an earlier
 * document) loads, the previous answer's data is kept (so the layout does not jump) and `path` says whose it is (null when it
 * answers an earlier document); `currentOf` tells the caller whether that is the answer to what it asked for.
 */
export function jsonView<T>(st: JSONState<T>, path: string | null, epoch?: unknown): JSONView<T> {
  if (!path) return { path: null, loading: false }
  const same = st.epoch === epoch
  const loading = st.path !== path || !same
  return { data: st.data, path: st.data !== undefined && same ? st.path : null, loading, error: loading ? undefined : st.error }
}

/** The data of `v` when it answers `path`, else undefined (a retained answer to another request is not current). */
export const currentOf = <T>(v: JSONView<T>, path: string | null): T | undefined => (path !== null && v.path === path && !v.loading ? v.data : undefined)

/** Cuts up to this size are checked without asking (the engine refuses more than `MAX_CHECK_BYTES` without `force=1`). */
export const AUTO_CHECK_BYTES = 256 << 20
/** The engine's limit of a check (`/api/cut/check`, `maxCheckBytes`): a bigger cut is checked only when asked, with `force=1`. */
export const MAX_CHECK_BYTES = 1 << 30

/** Whether the current plan is checked without asking: there is one, it keeps something, and it is small. */
export const autoCheckOf = (current: Pick<CutPlan, 'lines' | 'bytes'> | undefined): boolean => !!current && current.lines > 0 && current.bytes < AUTO_CHECK_BYTES

/**
 * The check request for the current plan, or null: none without a current plan (a retained plan's size says nothing about the
 * query), automatic for a small cut, else only once the user asked for this very query (`wanted`). A cut over the engine's limit
 * is asked for with `force=1` (the user asked: the engine's limit guards against what nobody asked for).
 */
export function checkPath(current: Pick<CutPlan, 'lines' | 'bytes'> | undefined, query: string, wanted: string | null): string | null {
  if (!current || current.lines === 0) return null
  if (!autoCheckOf(current) && wanted !== query) return null
  return `/api/cut/check?${query}${current.bytes > MAX_CHECK_BYTES ? (query ? '&' : '') + 'force=1' : ''}`
}

/** A statement the Cut view's picker offers (the lib's statement picker row, over the whole trace). */
export type StmtChoice = Pick<PickRow, 'id' | 'label' | 'e' | 'executions' | 'flat' | 'hay'>

/** Every statement with calls, longest first (ties: by id): what "One statement" can cut. */
export function stmtChoices(doc: Pick<TraceDoc, 'statements' | 'stats' | 'label'>): StmtChoice[] {
  const out: StmtChoice[] = []
  for (const s of doc.stats.statements) {
    const st = doc.statements[s.id]
    if (!st || s.allCalls.count === 0) continue
    const label = doc.label(st)
    const flat = flatten(st.text ?? '')
    out.push({ id: s.id, label, e: s.elapsed, executions: s.executions, flat, hay: `${label}\n${flat}`.toLowerCase() })
  }
  return out.sort((a, b) => b.e - a.e || a.id - b.id)
}

/**
 * The statement a "One statement" cut is of: the one picked here, else the one selected elsewhere, else the longest; only a
 * statement this document has with calls (a pick made on an earlier live snapshot, or a selection of a statement without
 * calls, falls through). Null when the trace has none.
 */
export function pickOf(choices: readonly StmtChoice[], picked: number | null, selected: number | null): number | null {
  const has = (id: number | null): id is number => id !== null && choices.some((c) => c.id === id)
  if (has(picked)) return picked
  if (has(selected)) return selected
  return choices[0]?.id ?? null
}

/** The rows the picker lists for a filter: the picked statement first when it matches, then the others in their order. */
export function pickerRows(choices: readonly StmtChoice[], pick: number | null, query: string): StmtChoice[] {
  const rows: StmtChoice[] = filterRows(choices as readonly PickRow[], query)
  const at = pick === null ? -1 : rows.findIndex((r) => r.id === pick)
  if (at > 0) rows.unshift(...rows.splice(at, 1))
  return rows
}
