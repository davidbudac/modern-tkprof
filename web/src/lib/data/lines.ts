import type { ApiClient } from './client'
import { parseClockTim, type ClockDoc } from './clock'

/** Raw trace lines come from `mtkprof serve` (GET /api/lines); the standalone HTML has no server to ask. */

export const LINES_PAGE = 81 // ±40 around the target

/** One probe at load: does this origin answer /api/lines with plain text? (A dev server's SPA fallback answers text/html.) */
export async function probeLines(client: ApiClient): Promise<boolean> {
  if (client.base === '' && location.protocol === 'file:') return false
  try {
    const res = await client.fetch('/api/lines?from=1&n=1')
    return res.ok && (res.headers.get('content-type') ?? '').startsWith('text/plain')
  } catch { return false }
}

export interface LinePage { from: number; lines: string[]; total: number }

/** `side` picks the trace of a comparison served by `mtkprof serve a b -compare`; `file` the input file of a multi-file trace. */
export async function fetchLines(client: ApiClient, from: number, n: number, signal?: AbortSignal, side?: 'a' | 'b', file = 0): Promise<LinePage> {
  const res = await client.fetch(`/api/lines?from=${from}&n=${n}${side ? `&side=${side}` : ''}${file ? `&file=${file}` : ''}`, { signal })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  const text = await res.text()
  const lines = text === '' ? [] : text.replace(/\r?\n$/, '').split('\n').map((l) => l.replace(/\r$/, ''))
  return { from, lines, total: Number(res.headers.get('x-total-lines')) || 0 }
}

// ---- the lines API of the engine / `serve -spill` (api/lines?annot=1, lines/at, at, search) -------------

/** The parser's kind of a trace line (`trace.Kind.String()`; api/engine.openapi.yaml `LineKind`). */
export type LineKind =
  | 'unknown' | 'blank' | 'header' | 'separator' | 'marker' | 'parsing-in-cursor' | 'sql-text' | 'end-of-stmt' | 'call' | 'wait'
  | 'stat' | 'binds' | 'bind-line' | 'xctend' | 'error' | 'parse-error' | 'lob' | 'rpc'

/** One probe at load: does this origin answer /api/at with JSON? (A dev server's SPA fallback answers text/html.) */
export async function probeLinesApi(client: ApiClient): Promise<boolean> {
  if (client.base === '' && location.protocol === 'file:') return false
  try {
    const res = await client.fetch('/api/at?line=1')
    return res.ok && (res.headers.get('content-type') ?? '').includes('json')
  } catch { return false }
}

/** The lines API's page size: `api/lines` returns at most this many lines. */
export const ANNOT_PAGE = 2000

export interface AnnotLine { t: string; k: LineKind }
export interface AnnotPage { from: number; total: number; lines: AnnotLine[] }

async function failure(res: Response): Promise<Error> {
  const body = (await res.text().catch(() => '')).trim().slice(0, 300)
  return new Error(`${res.status} ${res.statusText}${body ? ': ' + body : ''}`)
}

/** `n` lines (≤ 2000) of input file `file` from 1-based line `from`, each with its kind. */
export async function fetchLinesAnnot(client: ApiClient, file: number, from: number, n: number, signal?: AbortSignal): Promise<AnnotPage> {
  const res = await client.fetch(`/api/lines?annot=1&file=${file}&from=${from}&n=${n}`, { signal })
  if (!res.ok) throw await failure(res)
  const r = (await res.json()) as Partial<AnnotPage>
  return { from: r.from ?? from, total: r.total ?? 0, lines: r.lines ?? [] }
}

/** The first line of `file` whose call or wait has tim >= `tim` (the last record's line past the end). */
export async function lineAt(client: ApiClient, file: number, tim: number, signal?: AbortSignal): Promise<number> {
  const res = await client.fetch(`/api/lines/at?file=${file}&tim=${Math.round(tim)}`, { signal })
  if (!res.ok) throw await failure(res)
  return ((await res.json()) as { line: number }).line
}

/** The model objects of a trace line; every id is -1 where there is no such object. */
export interface AtObjects { call: number; stmt: number; cursor: number; execNo: number; wait: number; bindSet: number; ctx: number; planLine: number; kind: LineKind }

export async function objectsAt(client: ApiClient, file: number, line: number, signal?: AbortSignal): Promise<AtObjects> {
  const res = await client.fetch(`/api/at?file=${file}&line=${line}`, { signal })
  if (!res.ok) throw await failure(res)
  const r = (await res.json()) as Partial<AtObjects>
  return { call: r.call ?? -1, stmt: r.stmt ?? -1, cursor: r.cursor ?? -1, execNo: r.execNo ?? -1, wait: r.wait ?? -1, bindSet: r.bindSet ?? -1, ctx: r.ctx ?? -1, planLine: r.planLine ?? -1, kind: r.kind ?? 'unknown' }
}

export interface SearchQuery { file: number; q: string; regex: boolean; caseSensitive: boolean; from: number; limit: number }
/** `col` is the 0-based byte offset of the first match, `text` the line cut to 400 bytes. */
export interface SearchHit { line: number; col: number; text: string }
/** `done` is false when the stream ended without the closing record (the server stopped early). */
export interface SearchEnd { scanned: number; truncated: boolean; done: boolean }

/**
 * Streams `api/search` (NDJSON): `onHit` runs for each hit as its line arrives, the promise resolves with the closing record.
 * Aborting `signal` rejects with an AbortError, the hits delivered so far stay valid.
 */
export async function search(client: ApiClient, q: SearchQuery, onHit: (h: SearchHit) => void, signal?: AbortSignal): Promise<SearchEnd> {
  const p = new URLSearchParams({ file: String(q.file), q: q.q, regex: q.regex ? '1' : '0', case: q.caseSensitive ? '1' : '0', from: String(q.from), limit: String(q.limit) })
  const res = await client.fetch(`/api/search?${p}`, { signal })
  if (!res.ok) throw await failure(res)
  let end: SearchEnd = { scanned: 0, truncated: false, done: false }
  await readNdjson(res, (rec) => {
    const r = rec as Partial<SearchHit & { done: boolean; scanned: number; truncated: boolean }>
    if (r.done) end = { scanned: r.scanned ?? 0, truncated: !!r.truncated, done: true }
    else if (typeof r.line === 'number') onHit({ line: r.line, col: r.col ?? 0, text: r.text ?? '' })
  }, signal)
  return end
}

/** Calls `onRecord` with each JSON line of a streamed response body, as soon as the line is complete. */
export async function readNdjson(res: Response, onRecord: (rec: unknown) => void, signal?: AbortSignal): Promise<void> {
  const emit = (line: string) => { if (line.trim() !== '') onRecord(JSON.parse(line)) }
  if (!res.body) { for (const l of (await res.text()).split('\n')) emit(l); return }
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  let buf = ''
  try {
    for (;;) {
      if (signal?.aborted) throw new DOMException('aborted', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) { emit(buf.slice(0, nl)); buf = buf.slice(nl + 1) }
    }
    buf += dec.decode()
    emit(buf)
  } finally {
    reader.cancel().catch(() => {})
  }
}

/** [start, end) of the match of a hit in its text, in UTF-16 units (the server's `col` is a byte offset); null when it cannot be told. */
export function matchSpan(h: SearchHit, q: string, regex: boolean, caseSensitive: boolean): [number, number] | null {
  let start = h.col
  // ASCII lines (nearly all of them) have byte offset = index; otherwise count the characters of the first `col` bytes
  if (/[^\x00-\x7f]/.test(h.text)) start = new TextDecoder().decode(new TextEncoder().encode(h.text).slice(0, h.col)).length
  if (start > h.text.length) return null
  if (!regex) return q === '' ? null : [start, Math.min(h.text.length, start + q.length)]
  try {
    const re = new RegExp(q, 'y' + (caseSensitive ? '' : 'i'))
    re.lastIndex = start
    const m = re.exec(h.text)
    if (m) return [start, start + Math.max(1, m[0].length)]
  } catch { /* RE2 syntax that JS rejects */ }
  return [start, Math.min(h.text.length, start + 1)]
}

/**
 * "Jump to time" input → a trace clock value (µs), or null when it is not one.
 * `1.5s`, `250ms`, `900us` are offsets from the start of the trace; a bare number at or above the first tim is an absolute tim, below it seconds.
 * With `clock` (the trace's wall-clock origin) a time of day `HH:MM:SS[.fff]` or `YYYY-MM-DD HH:MM:SS[.fff]` in the trace file's zone works too.
 */
export function parseJump(text: string, firstTim: number, clock?: ClockDoc): number | null {
  if (clock && text.includes(':')) return parseClockTim(text, clock)
  const m = /^\s*([+-]?\d+(?:\.\d+)?)\s*(s|ms|us|µs)?\s*$/i.exec(text)
  if (!m) return null
  const v = Number(m[1])
  switch (m[2]?.toLowerCase()) {
    case 's': return firstTim + v * 1e6
    case 'ms': return firstTim + v * 1e3
    case 'us': case 'µs': return firstTim + v
    default: return v >= firstTim ? v : firstTim + v * 1e6
  }
}

/** A line of text cut into runs, the matched ones flagged (the search-match highlight of a row). */
export interface TextRun { text: string; hit: boolean }

/**
 * Where a search's matches are in one line of text, for highlighting rows the hit list does not carry the text of (the viewer shows full lines).
 * Every match of the search in the line, in UTF-16 units; a regex that JS rejects (RE2-only syntax) yields none.
 */
export function matchSpans(text: string, q: string, regex: boolean, caseSensitive: boolean, max = 50): [number, number][] {
  if (q === '') return []
  const out: [number, number][] = []
  if (!regex) {
    const hay = caseSensitive ? text : text.toLowerCase(), needle = caseSensitive ? q : q.toLowerCase()
    if (hay.length !== text.length) return [] // case folding changed the length (rare): offsets would drift
    for (let i = hay.indexOf(needle); i >= 0 && out.length < max; i = hay.indexOf(needle, i + needle.length)) out.push([i, i + needle.length])
    return out
  }
  try {
    const re = new RegExp(q, 'g' + (caseSensitive ? '' : 'i'))
    for (let m = re.exec(text); m && out.length < max; m = re.exec(text)) {
      if (m[0] === '') { re.lastIndex++; continue }
      out.push([m.index, m.index + m[0].length])
    }
  } catch { /* RE2 syntax that JS rejects */ }
  return out
}

/** The text cut into plain and hit runs at ascending, non-overlapping `spans` (others are skipped). The runs concatenate to `text`. */
export function highlightRuns(text: string, spans: [number, number][]): TextRun[] {
  const runs: TextRun[] = []
  let at = 0
  for (const [a, b] of spans) {
    if (a < at || b <= a || a >= text.length) continue
    if (a > at) runs.push({ text: text.slice(at, a), hit: false })
    runs.push({ text: text.slice(a, Math.min(b, text.length)), hit: true })
    at = Math.min(b, text.length)
  }
  if (at < text.length || runs.length === 0) runs.push({ text: text.slice(at), hit: false })
  return runs
}

/**
 * The standalone app's deep link to a line of the Lines view: the current page (path and `?doc=` query) with
 * `#view=lines[&file=N][&line=N]`, the same hash the app writes while that view is open (app/urlstate.ts).
 */
export function linePermalink(loc: Pick<Location, 'origin' | 'pathname' | 'search'>, file: number, line: number): string {
  const p = new URLSearchParams({ view: 'lines' })
  if (file) p.set('file', String(file))
  if (line > 1) p.set('line', String(line))
  return `${loc.origin}${loc.pathname}${loc.search}#${p}`
}
