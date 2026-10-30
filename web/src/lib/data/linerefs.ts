import type { LineKind } from './lines'

/** What a reference run names: a cursor number, a sql_id, an obj# and a plan hash value. */
export type RefKind = 'cursor' | 'sqlid' | 'obj' | 'plh'

/** A piece of one line's text: plain, or a reference to something the model knows, and/or a search hit. */
export interface RefRun { text: string; ref?: { kind: RefKind; value: string }; hit?: boolean }

/** The kinds whose first `#N` is the cursor number (`CALL #N:`, `WAIT #N:`, `STAT #N`, `BINDS #N:`, `ERROR #N:`, `PARSING IN CURSOR #N`, LOB and RPC lines). */
const CURSOR_KINDS: ReadonlySet<LineKind> = new Set(['call', 'wait', 'stat', 'binds', 'error', 'parse-error', 'parsing-in-cursor', 'lob', 'rpc'])

const cursorRe = /(^|\s)#(\d+)/
const sqlidRe = /\bsqlid='([0-9a-z]{13})'/g
const objRe = /\bobj#?=(\d+)/g
const plhRe = /\bplh=(\d+)/g

interface Found { a: number; b: number; kind: RefKind; value: string }

/**
 * One line of the trace cut into plain runs and reference runs, which concatenate to `text`:
 * the cursor `#N` (on the kinds that start with it), the 13 characters of `sqlid='…'`, `obj#=N` / `obj=N` and `plh=N` (N above 0).
 */
export function refRuns(text: string, kind: LineKind): RefRun[] {
  if (text === '') return []
  const found: Found[] = []
  if (CURSOR_KINDS.has(kind)) {
    const m = cursorRe.exec(text)
    if (m) found.push({ a: m.index + m[1].length, b: m.index + m[0].length, kind: 'cursor', value: m[2] })
  }
  for (const m of text.matchAll(sqlidRe)) found.push({ a: m.index + m[0].length - 14, b: m.index + m[0].length - 1, kind: 'sqlid', value: m[1] })
  for (const m of text.matchAll(objRe)) if (Number(m[1]) > 0) found.push({ a: m.index, b: m.index + m[0].length, kind: 'obj', value: m[1] })
  for (const m of text.matchAll(plhRe)) if (Number(m[1]) > 0) found.push({ a: m.index, b: m.index + m[0].length, kind: 'plh', value: m[1] })
  if (found.length === 0) return [{ text }]
  found.sort((x, y) => x.a - y.a)
  const runs: RefRun[] = []
  let at = 0
  for (const f of found) {
    if (f.a < at) continue // overlapping candidates: the first wins
    if (f.a > at) runs.push({ text: text.slice(at, f.a) })
    runs.push({ text: text.slice(f.a, f.b), ref: { kind: f.kind, value: f.value } })
    at = f.b
  }
  if (at < text.length) runs.push({ text: text.slice(at) })
  return runs
}

/**
 * The search matches (`spans`: ascending, non-overlapping, UTF-16 offsets into the concatenated runs) laid over the runs: a run is split
 * where a match starts or ends, the pieces inside a match get `hit`, and the pieces of a reference run keep its `ref`.
 */
export function mergeHits(runs: RefRun[], spans: [number, number][]): RefRun[] {
  if (spans.length === 0) return runs
  const out: RefRun[] = []
  let at = 0 // offset of the current run's start
  let s = 0
  for (const run of runs) {
    const end = at + run.text.length
    let pos = at
    while (s < spans.length && spans[s][1] <= pos) s++
    for (let i = s; i < spans.length && spans[i][0] < end; i++) {
      const [a, b] = spans[i]
      if (b <= a) continue
      const from = Math.max(a, pos), to = Math.min(b, end)
      if (from > pos) out.push(piece(run, pos - at, from - at, false))
      if (to > from) out.push(piece(run, from - at, to - at, true))
      pos = Math.max(pos, to)
    }
    if (pos < end) out.push(piece(run, pos - at, end - at, false))
    else if (run.text === '') out.push(run)
    at = end
  }
  return out
}

function piece(run: RefRun, from: number, to: number, hit: boolean): RefRun {
  const r: RefRun = { text: run.text.slice(from, to) }
  if (run.ref) r.ref = run.ref
  if (hit) r.hit = true
  return r
}
