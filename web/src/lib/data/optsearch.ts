// Search in the open dump: literal or regular expression, over the lines the text has. The hits are the lines that match, ascending; the
// outline's counts come from the nodes' line ranges by binary search, so a keystroke costs one pass over the text and nothing more.
import type { OptText } from './opt'

export interface SearchQuery { q: string; regex: boolean; caseSensitive: boolean }

export interface SearchResult {
  /** the pattern with the `g` flag (for the marks inside rows), null for an empty or invalid query */
  re: RegExp | null
  /** the regular expression does not parse */
  bad: boolean
  /** the lines that match, ascending */
  hits: Int32Array
  /** how many lines the search read: all of the dump's, or those a digest keeps */
  searched: number
  /** the text holds every line of the dump's view range (false: a digest, "searched the lines in the report only") */
  complete: boolean
}

export const NO_HITS: SearchResult = { re: null, bad: false, hits: new Int32Array(0), searched: 0, complete: true }

const ESCAPE = /[.*+?^${}()|[\]\\]/g

/** The pattern of a query: null for an empty one, `bad` when a regular expression does not parse. */
export function compileQuery(q: SearchQuery): { re: RegExp | null; bad: boolean } {
  if (!q.q) return { re: null, bad: false }
  try {
    return { re: new RegExp(q.regex ? q.q : q.q.replace(ESCAPE, '\\$&'), 'g' + (q.caseSensitive ? '' : 'i')), bad: false }
  } catch {
    return { re: null, bad: true }
  }
}

/** Searches the lines of a text (the dump's view range). */
export function searchText(text: OptText, q: SearchQuery): SearchResult {
  const { re, bad } = compileQuery(q)
  if (!re) return { ...NO_HITS, bad, complete: text.complete }
  const test = new RegExp(re.source, re.flags.replace('g', ''))
  let hits = new Int32Array(256)
  let n = 0
  let searched = 0
  for (let i = text.from; i <= text.to; i++) {
    const s = text.get(i)
    if (s === undefined) continue
    searched++
    if (test.test(s)) {
      if (n === hits.length) { const g = new Int32Array(hits.length * 2); g.set(hits); hits = g }
      hits[n++] = i
    }
  }
  return { re, bad: false, hits: hits.slice(0, n), searched, complete: text.complete }
}

/** The index of the first element of an ascending list that is >= `x`. */
function lowerBound(h: ArrayLike<number>, x: number): number {
  let lo = 0
  let hi = h.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (h[m] < x) lo = m + 1; else hi = m }
  return lo
}

/** How many hits lie in a..b (the lines of an outline node or a fold). */
export function hitsIn(hits: ArrayLike<number>, a: number, b: number): number {
  if (hits.length === 0) return 0
  const lo = lowerBound(hits, a)
  return lowerBound(hits, b + 1) - lo
}

export function hasHit(hits: ArrayLike<number>, line: number): boolean {
  const k = lowerBound(hits, line)
  return k < hits.length && hits[k] === line
}

/** The 1-based position of a hit line among the hits (0 when it is not one). */
export function hitIndex(hits: ArrayLike<number>, line: number): number {
  const k = lowerBound(hits, line)
  return k < hits.length && hits[k] === line ? k + 1 : 0
}

/** The wording of the search's count box. */
export function searchCount(r: SearchResult, cur: number): string {
  if (r.bad) return 'invalid'
  if (!r.re) return ''
  return `${cur ? hitIndex(r.hits, cur) : 0} / ${r.hits.length.toLocaleString('en-US')}`
}

/** What the search covered, in words, when it did not read the whole dump. */
export function searchNote(r: SearchResult): string {
  if (!r.re || r.complete) return ''
  return `searched the ${r.searched.toLocaleString('en-US')} lines in this report only`
}
