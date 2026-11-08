// The decisions of the Cut view that do not need React: which answer belongs to which request (useJSON), whether the plan on
// screen is the current query's, when the re-parse check runs, and the statements the picker offers.
import type { CutPlan } from './cutlayout'

/** The last settled answer of a `useJSON`: the path it answered and its data or error. */
export interface JSONState<T> { path: string | null; data?: T; error?: string }

/** A settled request: its data or its error. */
export type JSONResult<T> = { data: T } | { error: string }

/**
 * The state after the request for `path` settled. An aborted request never lands: its path is no longer wanted (the effect
 * was cleaned up) and a late answer must not replace the one of a newer request, however the fetch and the abort raced.
 */
export function jsonSettle<T>(st: JSONState<T>, path: string, r: JSONResult<T>, aborted: boolean): JSONState<T> {
  if (aborted) return st
  return 'error' in r ? { path, error: r.error } : { path, data: r.data }
}

/** What a `useJSON` returns: the data it holds, the path that data answers (`null`: none), loading and the error of `path`. */
export interface JSONView<T> { data?: T; path: string | null; loading: boolean; error?: string }

/**
 * The view of `st` for the wanted `path`: while another path loads, the previous answer's data is kept (so the layout does
 * not jump) and `path` says whose it is; `current` tells the caller whether that is the answer to what it asked for.
 */
export function jsonView<T>(st: JSONState<T>, path: string | null): JSONView<T> {
  if (!path) return { path: null, loading: false }
  const loading = st.path !== path
  return { data: st.data, path: st.data !== undefined ? st.path : null, loading, error: loading ? undefined : st.error }
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
