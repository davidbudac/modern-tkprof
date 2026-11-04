import type { ApiClient } from './client'
import { parseClockTim, type ClockDoc } from './clock'
import type { TraceDoc } from './doc'
import type { Scope } from '../state/store'
import type { ID } from './types'
import type { BindKind, BindRow } from './derive'
import type { Fold } from './folds'

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

/** `c s u x w` (call, statement, cursor, exec number, wait id) come with `annot=2`, -1 or omitted where the line has none. */
export interface AnnotLine { t: string; k: LineKind; c?: number; s?: number; u?: number; x?: number; w?: number }
export interface AnnotPage { from: number; total: number; lines: AnnotLine[] }

async function failure(res: Response): Promise<Error> {
  const body = (await res.text().catch(() => '')).trim().slice(0, 300)
  return new Error(`${res.status} ${res.statusText}${body ? ': ' + body : ''}`)
}

/** `n` lines (≤ 2000) of input file `file` from 1-based line `from`, each with its kind (`rich`: and its model ids, `annot=2`; a server that does not know it answers like `annot=1`). */
export async function fetchLinesAnnot(client: ApiClient, file: number, from: number, n: number, signal?: AbortSignal, rich = false, side?: 'a' | 'b'): Promise<AnnotPage> {
  const res = await client.fetch(`/api/lines?annot=${rich ? 2 : 1}&file=${file}&from=${from}&n=${n}${side ? `&side=${side}` : ''}`, { signal })
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

/** Buckets the density strip asks for (`api/lines/profile` answers at most this many). */
export const PROFILE_BUCKETS = 2000

/**
 * The shape of a file in `buckets` slices (`api/lines/profile`): per bucket the counts of calls, waits, cursor parses, errors and commits.
 * Bucket i covers lines `[i*size+1, min(total, (i+1)*size)]`; a file without lines has no buckets.
 */
export interface LineProfile {
  total: number; buckets: number; size: number
  calls: number[]; waits: number[]; cursors: number[]; errors: number[]; commits: number[]
  maxCalls: number; maxWaits: number
}

export async function fetchLineProfile(client: ApiClient, file: number, buckets: number, signal?: AbortSignal): Promise<LineProfile> {
  const n = Math.min(PROFILE_BUCKETS, Math.max(1, Math.floor(buckets)))
  const res = await client.fetch(`/api/lines/profile?file=${file}&buckets=${n}`, { signal })
  if (!res.ok) throw await failure(res)
  const r = (await res.json()) as Partial<LineProfile>
  const b = r.buckets ?? 0
  const col = (a: number[] | undefined) => Array.from({ length: b }, (_, i) => a?.[i] ?? 0)
  return { total: r.total ?? 0, buckets: b, size: Math.max(1, r.size ?? 1), calls: col(r.calls), waits: col(r.waits), cursors: col(r.cursors), errors: col(r.errors), commits: col(r.commits), maxCalls: r.maxCalls ?? 0, maxWaits: r.maxWaits ?? 0 }
}

/**
 * The model objects of a trace line; every id is -1 where there is no such object.
 * `execFrom`/`execTo` span the line's execution (EXEC line .. its last line), `prevExec`/`nextExec` are the EXEC lines of the cursor's neighbouring
 * executions, `cursorLine`/`closeLine` the cursor's PARSING IN CURSOR and CLOSE lines; `object` is the name of the object a wait is on ('' unknown).
 */
export interface AtObjects {
  call: number; stmt: number; cursor: number; execNo: number; wait: number; bindSet: number; ctx: number; planLine: number; kind: LineKind
  execFrom: number; execTo: number; prevExec: number; nextExec: number; cursorLine: number; closeLine: number; object: string
  /** the `BINDS #` line of `bindSet` (-1 when none) and its values: what the engine knows without the facts tables */
  bindLine: number; binds?: BindRow[]
}

/** The `binds` rows of an `/api/at` answer (the engine's `BindRow`) as the document's `BindRow`s. */
interface WireBind { pos: number; type: string; value: string; isNull?: boolean; noDef?: boolean; dump?: boolean; mal?: number; kind?: string; typed?: string }

export async function objectsAt(client: ApiClient, file: number, line: number, signal?: AbortSignal): Promise<AtObjects> {
  const res = await client.fetch(`/api/at?file=${file}&line=${line}`, { signal })
  if (!res.ok) throw await failure(res)
  const r = (await res.json()) as Partial<Omit<AtObjects, 'binds'>> & { binds?: WireBind[] }
  return {
    call: r.call ?? -1, stmt: r.stmt ?? -1, cursor: r.cursor ?? -1, execNo: r.execNo ?? -1, wait: r.wait ?? -1, bindSet: r.bindSet ?? -1, ctx: r.ctx ?? -1, planLine: r.planLine ?? -1, kind: r.kind ?? 'unknown',
    execFrom: r.execFrom ?? -1, execTo: r.execTo ?? -1, prevExec: r.prevExec ?? -1, nextExec: r.nextExec ?? -1, cursorLine: r.cursorLine ?? -1, closeLine: r.closeLine ?? -1, object: r.object ?? '',
    bindLine: r.bindLine ?? -1,
    binds: r.binds?.map((b) => ({ pos: b.pos, type: b.type, value: b.value, isNull: !!b.isNull, noDef: !!b.noDef, dump: !!b.dump, mal: b.mal ?? 0, kind: b.kind as BindKind | undefined, typed: b.typed || undefined })),
  }
}

/** The structural elements `nextLine` steps over (api/engine.openapi.yaml `lines/next`). */
export type NextWhat = 'call' | 'wait' | 'cursor' | 'plan' | 'ctx' | 'error' | 'commit' | 'gap'

/** The first line strictly after (`dir` 1) or before (-1) `from` that holds `what`, or null when there is none in that direction. `min` (µs) is the least idle gap of `what` = 'gap'. */
export async function nextLine(client: ApiClient, file: number, from: number, what: NextWhat, dir: 1 | -1, signal?: AbortSignal, min?: number): Promise<number | null> {
  const res = await client.fetch(`/api/lines/next?file=${file}&from=${from}&what=${what}&dir=${dir}${min === undefined ? '' : `&min=${Math.round(min)}`}`, { signal })
  if (res.status === 404) return null
  if (!res.ok) throw await failure(res)
  const r = (await res.json()) as { line?: number }
  return typeof r.line === 'number' ? r.line : null
}

/** The calls and waits of a file that took at least `min` µs (`api/lines/hot`), in line order; `max` is the longest call or wait of the file. */
export interface HotLines { hot: { line: number; us: number; wait: boolean }[]; max: number; truncated: boolean }

export async function fetchHot(client: ApiClient, file: number, min: number, signal?: AbortSignal, limit = 5000): Promise<HotLines> {
  const res = await client.fetch(`/api/lines/hot?file=${file}&min=${Math.max(0, Math.round(min))}&limit=${limit}`, { signal })
  if (!res.ok) throw await failure(res)
  const r = (await res.json()) as Partial<HotLines>
  return { hot: r.hot ?? [], max: r.max ?? 0, truncated: !!r.truncated }
}

/** A run of repeats the readable view can fold (`api/lines/repeats`): identical waits, a long wait block, a loop of small fetches. */
export interface RepeatFold {
  from: number; to: number; kind: 'run' | 'block' | 'fetches'; n: number; us: number; max: number
  /** run: the event */
  event?: string
  /** block: the time per event, most first */
  by?: { event: string; n: number; us: number }[]
  /** fetches: rows, consistent gets, physical reads and the idle wait time between them */
  rows?: number; cr?: number; p?: number; idle?: number
}

/** The repeats of a file; `small` (µs) is the most a fetch of a folded loop may take. */
export async function fetchRepeats(client: ApiClient, file: number, small: number, signal?: AbortSignal): Promise<{ folds: RepeatFold[]; truncated: boolean }> {
  const res = await client.fetch(`/api/lines/repeats?file=${file}&small=${Math.max(1, Math.round(small))}`, { signal })
  if (!res.ok) throw await failure(res)
  const r = (await res.json()) as { folds?: RepeatFold[]; truncated?: boolean }
  return { folds: r.folds ?? [], truncated: !!r.truncated }
}

/** The blocks `linesBlocks` lists: BINDS blocks (the `BINDS #` line and its `bind` lines) or STAT dumps. */
export type BlockWhat = 'binds' | 'stat'

/** Every block of a kind in `file` (`api/lines/blocks`): `[from, to]` pairs (1-based, inclusive, sorted); `truncated` when the engine stopped at its limit (20,000). */
export async function linesBlocks(client: ApiClient, file: number, what: BlockWhat, signal?: AbortSignal): Promise<{ blocks: [number, number][]; truncated: boolean }> {
  const res = await client.fetch(`/api/lines/blocks?file=${file}&what=${what}`, { signal })
  if (!res.ok) throw await failure(res)
  const r = (await res.json()) as { blocks?: [number, number][]; truncated?: boolean }
  return { blocks: (r.blocks ?? []).filter((b) => b[0] >= 1 && b[1] >= b[0]), truncated: !!r.truncated }
}

/** The existing folds with the `added` ones that overlap none of them (nor each other), sorted by first line. */
export function mergeFolds(existing: readonly Fold[], added: readonly Fold[]): Fold[] {
  const out = [...existing].sort((a, b) => a.from - b.from)
  const hit = (f: Fold) => out.some((o) => f.from <= o.to && o.from <= f.to)
  for (const f of [...added].sort((a, b) => a.from - b.from)) if (!hit(f)) out.push(f)
  return out.sort((a, b) => a.from - b.from)
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
 * Time part of the "Go to" input → a trace clock value (µs), or null when it is not one.
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

/** What the Go to box asked for. */
export type GoTo =
  | { kind: 'line'; line: number }
  | { kind: 'cursor'; number: number }
  | { kind: 'sqlid'; sqlId: string; prefix: boolean; execNo?: number }
  | { kind: 'tim'; tim: number }

/**
 * "Go to" input → what it names, or null when it is nothing of these.
 * `12345`, `L12345`, `:12345` a line; `#140124363561040` a cursor number; a 13-character sql_id, or a prefix followed by `*`,
 * each with an optional `/N` execution; anything else is `parseJump`'s, except that a bare number (no unit) is a line, never a tim.
 */
export function parseGoTo(text: string, firstTim: number, clock?: ClockDoc): GoTo | null {
  const t = text.trim()
  let m = /^[Ll:]?(\d+)$/.exec(t)
  if (m) return { kind: 'line', line: Number(m[1]) }
  m = /^#(\d+)$/.exec(t)
  if (m) return { kind: 'cursor', number: Number(m[1]) }
  m = /^([0-9a-z]{13}|[0-9a-z]{1,12}\*)(?:\/(\d+))?$/i.exec(t)
  if (m) {
    const prefix = m[1].endsWith('*')
    return { kind: 'sqlid', sqlId: (prefix ? m[1].slice(0, -1) : m[1]).toLowerCase(), prefix, ...(m[2] !== undefined ? { execNo: Number(m[2]) } : {}) }
  }
  if (/^[+-]?\d+(?:\.\d+)?$/.test(t)) return null // a bare number is no longer a time
  const tim = parseJump(t, firstTim, clock)
  return tim === null ? null : { kind: 'tim', tim }
}

/** The scope that leaves nothing out (what a jump looks executions up in, whatever the views are filtered to). */
export const ALL_SCOPE: Scope = { window: null, files: null, contexts: null, includeIdle: true }

/** The PARSING IN CURSOR line of the cursor `number` in `file`: the nearest after `from`, wrapping to the first; undefined when the file has none. */
export function cursorLine(doc: Pick<TraceDoc, 'cursors' | 'fileOfCursor'>, file: number, number: number, from: number): number | undefined {
  const lines = doc.cursors.filter((c) => c.number === number && c.line > 0 && doc.fileOfCursor(c.id) === file).map((c) => c.line).sort((a, b) => a - b)
  return lines.find((l) => l > from) ?? lines[0]
}

/** The statements a sql_id (or prefix) names: one id's statements (distinct sql_ids are reported by `ids`, several means ambiguous). */
export function statementsOf(doc: Pick<TraceDoc, 'statements'>, sqlId: string, prefix: boolean): { ids: string[]; stmts: ID[] } {
  const hit = doc.statements.filter((s) => s.sqlId !== '' && (prefix ? s.sqlId.startsWith(sqlId) : s.sqlId === sqlId))
  return { ids: [...new Set(hit.map((s) => s.sqlId))], stmts: hit.map((s) => s.id) }
}

/** The first (lowest) line of a statement's cursors in `file`; undefined when none is there. */
export function stmtLineIn(doc: Pick<TraceDoc, 'statements' | 'cursors' | 'fileOfCursor'>, file: number, stmt: ID): number | undefined {
  let best: number | undefined
  for (const c of doc.statements[stmt]?.cursors ?? []) {
    const cur = doc.cursors[c]
    if (cur && cur.line > 0 && doc.fileOfCursor(c) === file && (best === undefined || cur.line < best)) best = cur.line
  }
  return best
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
 * `#view=lines[&file=N][&line=N]`, the same hash the app writes while that view is open (shell/urlstate.ts).
 */
export function linePermalink(loc: Pick<Location, 'origin' | 'pathname' | 'search'>, file: number, line: number): string {
  const p = new URLSearchParams({ view: 'lines' })
  if (file) p.set('file', String(file))
  if (line > 1) p.set('line', String(line))
  return `${loc.origin}${loc.pathname}${loc.search}#${p}`
}

// ---- search presets -----------------------------------------------------------------------------------------

/** Digits of `ms` milliseconds in µs: a number with at least that many digits is (about) `ms` or longer. */
const usDigits = (ms: number) => String(Math.max(1, Math.round(ms * 1000))).length

/** The regex for waits of `ms` milliseconds or more (`ela=` is in µs; the match is by digit count, so 25 ms matches from 10 ms). */
export const waitsOverRe = (ms: number) => `ela= \\d{${usDigits(ms)},}`
/** The regex for calls of `ms` milliseconds or more (`e=` is in µs; by digit count like `waitsOverRe`). */
export const callsOverRe = (ms: number) => `,e=\\d{${usDigits(ms)},}`

/** Searches that fill the box (regex on) and run. A function `re` takes a threshold in ms, asked of the user with `ms` as the default. */
export const SEARCH_PRESETS: { label: string; re: string | ((ms: number) => string); ms?: number }[] = [
  { label: 'Errors', re: '^(ERROR #|PARSE ERROR)' },
  { label: 'Hard parses', re: '^PARSE #.*mis=1' },
  { label: 'Waits over N ms', re: waitsOverRe, ms: 10 },
  { label: 'Long calls over N ms', re: callsOverRe, ms: 10 },
  { label: 'Commits', re: '^XCTEND' },
  { label: 'Session markers', re: '^\\*\\*\\* (SESSION|CLIENT|MODULE|ACTION)' },
  { label: 'Top-level parses', re: '^PARSING IN CURSOR.*dep=0' },
  { label: 'Plan dumps', re: '^STAT #.*id=1 ' },
]

/** What a search covers: the whole file, the lines of the time window, the lines between a marked statement's first and last mark. */
export type SearchScope = 'file' | 'window' | 'stmt'

/** A finished search kept for its chip: the query, where it looked and what it found. */
export interface RecentSearch { q: string; regex: boolean; caseSensitive: boolean; scope: SearchScope; hits: SearchHit[]; end: SearchEnd | null }
/** Two searches are the same entry when their queries match. */
export const sameSearch = (a: Pick<RecentSearch, 'q' | 'regex' | 'caseSensitive' | 'scope'>, b: Pick<RecentSearch, 'q' | 'regex' | 'caseSensitive' | 'scope'>) =>
  a.q === b.q && a.regex === b.regex && a.caseSensitive === b.caseSensitive && a.scope === b.scope

/** The group of the hits whose statement is not known yet (their page is not loaded); `-1` is the group of hits with no statement. */
export const GROUP_UNKNOWN = -2
/** The hits of one statement: `stmt` (`-1` none, `GROUP_UNKNOWN` not loaded yet), the first hit's line and the hits in line order. */
export interface HitGroup { stmt: number; first: number; hits: SearchHit[] }

/** Groups hits by the statement `stmtOf` tells (undefined: unknown yet; negative: none), biggest group first, ties by first hit. */
export function groupHits(hits: readonly SearchHit[], stmtOf: (line: number) => number | undefined): HitGroup[] {
  const groups = new Map<number, HitGroup>()
  for (const h of hits) {
    const s = stmtOf(h.line)
    const key = s === undefined ? GROUP_UNKNOWN : s < 0 ? -1 : s
    let g = groups.get(key)
    if (!g) groups.set(key, (g = { stmt: key, first: h.line, hits: [] }))
    g.hits.push(h)
    if (h.line < g.first) g.first = h.line
  }
  return [...groups.values()].sort((a, b) => b.hits.length - a.hits.length || a.first - b.first)
}
