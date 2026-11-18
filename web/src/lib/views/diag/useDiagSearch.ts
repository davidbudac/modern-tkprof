import { useCallback, useEffect, useRef, useState } from 'react'
import type { DiagText } from '../../data/diag'

/** The most hits one search keeps (the server's `limit`: the line map and the outline's counts show these; past it the search says it stopped). */
export const DIAG_SEARCH_LIMIT = 10_000

export interface DiagSearchState {
  q: string
  regex: boolean
  caseSensitive: boolean
}

export type DiagSearchStatus = 'idle' | 'running' | 'done' | 'error'

export interface DiagSearch {
  /** the query the hits are of (what the last `run` was given) */
  ran: DiagSearchState
  /** the lines that match, ascending */
  hits: number[]
  status: DiagSearchStatus
  /** lines the server read, when it finished */
  scanned: number
  /** the hits stopped at the limit */
  truncated: boolean
  error: string | null
}

const NONE: DiagSearch = { ran: { q: '', regex: false, caseSensitive: false }, hits: [], status: 'idle', scanned: 0, truncated: false, error: null }
const aborted = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * Search over the file's text (`api/search`, NDJSON): the hits arrive in line order and are shown as they come (the first one is reported at once so that
 * the view can go to it). `run` starts a search and cancels the one before; an empty query clears. `text` null (the standalone report) searches nothing.
 */
export function useDiagSearch(text: DiagText | null, onFirst: (line: number) => void): { search: DiagSearch; run(q: DiagSearchState): void; cancel(): void } {
  const [search, setSearch] = useState<DiagSearch>(NONE)
  const ctl = useRef<AbortController | null>(null)
  const first = useRef(onFirst)
  first.current = onFirst
  const cancel = useCallback(() => { ctl.current?.abort(); ctl.current = null }, [])
  useEffect(() => cancel, [cancel])
  // another text (another file) forgets the hits
  useEffect(() => { setSearch(NONE) }, [text])

  const run = useCallback((q: DiagSearchState) => {
    ctl.current?.abort()
    ctl.current = null
    if (!text || q.q === '') { setSearch(NONE); return }
    const ac = new AbortController()
    ctl.current = ac
    const hits: number[] = []
    let timer = 0
    const push = (patch: Partial<DiagSearch>) => { if (ctl.current === ac) setSearch((s) => ({ ...s, ran: q, hits: hits.slice(), ...patch })) }
    setSearch({ ran: q, hits: [], status: 'running', scanned: 0, truncated: false, error: null })
    text.search({ q: q.q, regex: q.regex, caseSensitive: q.caseSensitive, from: 1, limit: DIAG_SEARCH_LIMIT }, (h) => {
      hits.push(h.line)
      if (hits.length === 1) { window.clearTimeout(timer); timer = 0; push({}); first.current(h.line) } else if (!timer) timer = window.setTimeout(() => { timer = 0; push({}) }, 100)
    }, ac.signal).then(
      (end) => { window.clearTimeout(timer); push({ status: 'done', scanned: end.scanned, truncated: end.truncated }) },
      (e: unknown) => { window.clearTimeout(timer); if (!aborted(e)) push({ status: 'error', error: e instanceof Error ? e.message : String(e) }) },
    )
  }, [text])

  return { search, run, cancel }
}

/** The wording of the count box: `3 / 120`, `120 hits` while the line is none of them, `10,000+` at the limit, `searching…`. */
export function searchCountText(s: DiagSearch, cur: number, hitIndex: (line: number) => number): string {
  if (s.ran.q === '') return ''
  if (s.status === 'error') return 'error'
  const n = s.hits.length.toLocaleString('en-US')
  if (s.status === 'running') return s.hits.length ? `${cur ? hitIndex(cur) : 0} / ${n}…` : 'searching…'
  if (s.hits.length === 0) return '0 hits'
  return `${cur ? hitIndex(cur) : 0} / ${n}${s.truncated ? '+' : ''}`
}
