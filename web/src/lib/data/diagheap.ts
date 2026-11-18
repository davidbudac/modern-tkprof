// The data side of the dump reader's readings (docs/PLAN-DIAG.md § The readings): sorting and shares for the tables, the heap tree (the selected heap with its
// ancestors, siblings and children), the stepper over the chunk lines of a selected row (paged with `after`), the free-list histogram, and what a reading keeps
// while another node or tab is shown. Plain data and a subscription, so the tests need no browser.
import type { DiagSource } from './diag'
import type { HeapBucket, HeapCheck, HeapComment, HeapLines, HeapReading, HeapRun, HeapSub, HeapType } from './diagreadings'

// ---- sorting ---------------------------------------------------------------------------------------------------------------------------------

export interface Sort { col: string; dir: 1 | -1 }

/** The sort after a click on a column header: the same column flips, another starts with `first` (text ascending, numbers descending). */
export function toggleSort(s: Sort, col: string, first: 1 | -1 = -1): Sort {
  return s.col === col ? { col, dir: s.dir === 1 ? -1 : 1 } : { col, dir: first }
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' })

/**
 * `rows` sorted by the column `sort.col` (`get` knows the columns: a number or a string each), ties in the order the rows came in. Missing values (undefined) come
 * last whichever way it is sorted. A new array; `rows` is not changed.
 */
export function sortRows<T>(rows: readonly T[], sort: Sort, get: Readonly<Record<string, (r: T) => number | string | undefined>>): T[] {
  const f = get[sort.col]
  if (!f) return rows.slice()
  const keyed = rows.map((r, i) => ({ r, i, v: f(r) }))
  keyed.sort((a, b) => {
    const x = a.v, y = b.v
    if (x === undefined || y === undefined) return x === y ? a.i - b.i : x === undefined ? 1 : -1
    const c = typeof x === 'string' || typeof y === 'string' ? collator.compare(String(x), String(y)) : x - y
    return c * sort.dir || a.i - b.i
  })
  return keyed.map((k) => k.r)
}

/** A share of a whole as the tables print it: one decimal from 0.1 %, two from 0.001 %, "<0.1%" below that. */
export function shareText(x: number): string {
  if (!(x > 0)) return '0%'
  if (x >= 0.1) return (x * 100).toFixed(1) + '%'
  if (x >= 0.001) return (x * 100).toFixed(2) + '%'
  return '<0.1%'
}

/** `part` of `whole` as a fraction, 0 for an empty whole. */
export const shareOf = (part: number, whole: number): number => (whole > 0 ? Math.max(0, Math.min(1, part / whole)) : 0)

// ---- the rows of the heap tables --------------------------------------------------------------------------------------------------------------

export interface CommentRow { key: string; comment: string; types: HeapComment['types']; chunks: number; bytes: number; share: number; line: number; suffixes?: number }

/** The comment table's rows (the reading's list, bounded by the engine), with each one's share of the chunks' bytes. */
export function commentRows(h: HeapReading): CommentRow[] {
  return h.byComment.map((c) => ({ key: c.comment, comment: c.comment, types: c.types, chunks: c.chunks, bytes: c.bytes, share: shareOf(c.bytes, h.bytes), line: c.line, suffixes: c.suffixes }))
}

export interface TypeRow { key: string; type: string; chunks: number; bytes: number; share: number; variants?: { type: string; chunks: number; bytes: number; share: number }[] }

export function typeRows(h: HeapReading): TypeRow[] {
  return h.byType.map((t: HeapType) => ({
    key: t.type, type: t.type, chunks: t.chunks, bytes: t.bytes, share: shareOf(t.bytes, h.bytes),
    ...(t.variants?.length ? { variants: t.variants.map((v) => ({ type: v.type, chunks: v.chunks, bytes: v.bytes, share: shareOf(v.bytes, h.bytes) })) } : null),
  }))
}

export interface SubRow { key: string; desc: string; name: string; size?: number; held: number; chunks: number; extents?: number; line: number; node?: string; share: number }

export function subRows(h: HeapReading): SubRow[] {
  return h.subheaps.map((s: HeapSub) => ({ key: s.desc, desc: s.desc, name: s.name, size: s.size, held: s.held, chunks: s.chunks, extents: s.extents, line: s.line, node: s.node, share: shareOf(s.held, h.bytes) }))
}

/** A comment's types as one cell: the biggest and how many more ("freeable +1"); the full list is the tooltip. */
export function typesText(types: readonly { type: string; chunks: number; bytes: number }[]): { text: string; title: string } {
  if (types.length === 0) return { text: '', title: '' }
  return { text: types.length === 1 ? types[0].type : `${types[0].type} +${types.length - 1}`, title: types.map((t) => `${t.type}: ${t.chunks.toLocaleString('en-US')} chunks, ${t.bytes.toLocaleString('en-US')} bytes`).join('\n') }
}

// ---- the check ------------------------------------------------------------------------------------------------------------------------------

export type CheckTone = 'ok' | 'bad' | 'none'

/**
 * The tone of the whole check block: `bad` when any check differs, `ok` when the checks that could be made all match (and at least one was), else neutral. The
 * only place of the reader that is green or red.
 */
export function checkTone(checks: readonly HeapCheck[]): CheckTone {
  if (checks.some((c) => c.state === 'differ')) return 'bad'
  return checks.some((c) => c.state === 'match') ? 'ok' : 'none'
}

/** The words of a check: what is summed and which line of the dump it is compared with (a check the engine adds later falls back to the engine's own `what`). */
const CHECK_WORDS: Record<string, { sum: string; total: string }> = {
  heap: { sum: 'Chunks', total: 'Total heap size' },
  free: { sum: 'Free-list chunks', total: 'Total free space' },
  perm: { sum: 'Permanent chunks', total: 'Permanent space' },
  reserved: { sum: 'Reserved free-list chunks', total: 'Total of all reserved free space' },
}

export interface CheckText {
  state: HeapCheck['state']
  /** the sentence, before the number: "Chunks sum to" */
  head: string
  /** the number the chunks sum to (bytes), absent for a check that was not made */
  sum?: number
  /** the rest of the sentence */
  tail: string
  line?: number
}

/** `sameReason`: the check before this one was not made either, for the same reason: it is not said again. */
export function checkText(c: HeapCheck, fmt: (n: number) => string, sameReason = false): CheckText {
  const w = CHECK_WORDS[c.name]
  const sum = w?.sum ?? c.what
  const total = w?.total ?? 'the dump\'s total'
  if (c.state === 'match') return { state: c.state, head: `${sum} sum to`, sum: c.computed, tail: ` bytes: matches the dump's ${total}.`, line: c.line }
  if (c.state === 'differ') {
    const d = c.diff ?? c.computed - (c.printed ?? 0)
    return { state: c.state, head: `${sum} sum to`, sum: c.computed, tail: ` bytes: the dump's ${total} says ${fmt(c.printed ?? 0)}, a difference of ${d > 0 ? '+' : ''}${fmt(d)}.`, line: c.line }
  }
  return { state: c.state, head: `${sum} against ${total}:`, tail: ` not checked${sameReason ? ', for the same reason' : c.reason ? `: ${c.reason}` : ''}.`, line: c.line }
}

/** The flags that change how to read the numbers, as sentences for a quiet note. */
export function flagNotes(h: HeapReading, fmt: (n: number) => string): string[] {
  const f = h.flags
  const out: string[] = []
  if (f.noExtents) out.push('The header is followed by no extent: the dump lists no chunks and prints no totals.')
  if (f.pdbFiltered !== undefined) out.push(`The dump was taken inside PDB ${f.pdbFiltered} and leaves out the chunks of other containers, so these sums are those of that PDB's chunks only and are not compared with the totals.`)
  if (f.sampled) out.push(`The heap has a significant amount of free memory${f.sampledPercent ? ` (${f.sampledPercent} percent)` : ''}: the dump lists sample extents only, so the sums are a sample of the heap and have no totals to check.`)
  if (f.contents) out.push(`The dump holds memory contents (${fmt(f.contents.blocks)} ${f.contents.blocks === 1 ? 'block' : 'blocks'}, ${fmt(f.contents.lines)} lines): they are skipped and not counted in the sums.`)
  if (f.cut) out.push('The dump stops before its end line: the sums are those of the part that is in the file.')
  return out
}

// ---- the heap tree ----------------------------------------------------------------------------------------------------------------------------

export interface TreeRow { run: HeapRun; depth: number; role: 'ancestor' | 'self' | 'sibling' | 'child' }

/**
 * The rows of the heap tree for the heap `node`: its ancestors (the root first, one level deeper each), its siblings (the heaps with the same parent, itself among
 * them, in file order) and, under itself, its children. Not the whole run: a dump run has hundreds of heaps. Empty when the node is not in the run (the run is
 * bounded; `HeapReading.runMore`).
 */
export function heapTree(run: readonly HeapRun[], node: string): TreeRow[] {
  const by = new Map<string, HeapRun>()
  const kids = new Map<string, HeapRun[]>()
  for (const r of run) {
    by.set(r.node, r)
    const p = r.parent && r.parent !== r.node ? r.parent : ''
    const l = kids.get(p)
    if (l) l.push(r); else kids.set(p, [r])
  }
  const self = by.get(node)
  if (!self) return []
  const chain: HeapRun[] = []
  const seen = new Set<string>([self.node])
  for (let p = self.parent ? by.get(self.parent) : undefined; p && !seen.has(p.node); p = p.parent ? by.get(p.parent) : undefined) { chain.unshift(p); seen.add(p.node) }
  const rows: TreeRow[] = chain.map((r, i) => ({ run: r, depth: i, role: 'ancestor' as const }))
  const k = chain.length
  const sibs = kids.get(chain.length ? chain[chain.length - 1].node : '') ?? [self]
  for (const s of sibs) {
    if (s.node === self.node) {
      rows.push({ run: s, depth: k, role: 'self' })
      for (const c of kids.get(s.node) ?? []) if (!seen.has(c.node)) rows.push({ run: c, depth: k + 1, role: 'child' })
    } else rows.push({ run: s, depth: k, role: 'sibling' })
  }
  return rows
}

// ---- from a row to its chunks ------------------------------------------------------------------------------------------------------------------

/** The selected row of a heap table and the chunk lines loaded for it. */
export interface ChunkSel {
  /** "c:<comment>" or "t:<type>": the row */
  key: string
  /** what is shown beside the count: the comment, or the type */
  label: string
  comment?: string
  type?: string
  /** the chunk lines loaded so far, ascending */
  lines: number[]
  /** how many chunk lines match in all */
  total: number
  /** how many follow those loaded */
  more: number
  /** the `after` of the next page */
  next: number
  /** the chunk the stepper is at (an index of `lines`) */
  i: number
  loading: boolean
  error: string | null
}

export const commentKey = (c: string): string => `c:${c}`
export const typeKey = (t: string): string => `t:${t}`

export function newSel(spec: { key: string; label: string; comment?: string; type?: string }): ChunkSel {
  return { ...spec, lines: [], total: 0, more: 0, next: 0, i: 0, loading: true, error: null }
}

/** The selection after a page of chunk lines came (`append`: the next page, after those already there). */
export function applyPage(s: ChunkSel, page: HeapLines, append: boolean): ChunkSel {
  const lines = append ? [...s.lines, ...page.lines] : page.lines
  const last = lines[lines.length - 1] ?? 0
  return { ...s, lines, total: page.total, more: page.more, next: page.more > 0 ? page.next ?? last : 0, loading: false, error: null }
}

/** What a step does: move within the loaded lines, load the next page first, or nothing (the ends). */
export function stepKind(s: ChunkSel, dir: 1 | -1): 'step' | 'load' | 'none' {
  if (s.lines.length === 0 || s.loading) return 'none'
  if (dir === -1) return s.i > 0 ? 'step' : 'none'
  if (s.i < s.lines.length - 1) return 'step'
  return s.more > 0 ? 'load' : 'none'
}

export const stepTo = (s: ChunkSel, dir: 1 | -1): ChunkSel => (stepKind(s, dir) === 'step' ? { ...s, i: s.i + dir } : s)

/** The line the stepper is at (0 for none). */
export const selLine = (s: ChunkSel): number => s.lines[s.i] ?? 0

/** "1 / 160 · line 46". */
export function stepperText(s: ChunkSel, fmt: (n: number) => string): string {
  if (s.lines.length === 0) return ''
  return `${fmt(s.i + 1)} / ${fmt(s.total)} · line ${fmt(selLine(s))}`
}

/** What a heap reading's UI keeps: the selected row and what the stepper loaded for it go through `SelHost`. */
export interface SelHost { sel(): ChunkSel | null; set(s: ChunkSel | null): void }

/** Selects a row: asks for its first page of chunk lines. A second ask for the same row clears the selection. The answer of a selection that was replaced meanwhile is dropped. */
export async function selectRow(source: DiagSource, node: string, host: SelHost, spec: { key: string; label: string; comment?: string; type?: string }): Promise<void> {
  if (host.sel()?.key === spec.key) { host.set(null); return }
  const mine = newSel(spec)
  host.set(mine)
  const same = () => host.sel()?.key === spec.key
  try {
    const page = await source.readingLines(node, { ...(spec.comment !== undefined ? { comment: spec.comment } : null), ...(spec.type !== undefined ? { type: spec.type } : null) })
    if (same()) host.set(applyPage(host.sel()!, page, false))
  } catch (e) {
    if (same()) host.set({ ...host.sel()!, loading: false, error: e instanceof Error ? e.message : String(e) })
  }
}

/** Loads the next page of the selected row's chunk lines (`after` the last one loaded) and, with `stepOn`, moves to its first line. */
export async function loadMoreChunks(source: DiagSource, node: string, host: SelHost, stepOn = false): Promise<void> {
  const cur = host.sel()
  if (!cur || cur.loading || cur.more === 0) return
  const key = cur.key
  host.set({ ...cur, loading: true, error: null })
  const same = () => host.sel()?.key === key
  try {
    const page = await source.readingLines(node, { ...(cur.comment !== undefined ? { comment: cur.comment } : null), ...(cur.type !== undefined ? { type: cur.type } : null), after: cur.next })
    if (!same()) return
    const next = applyPage(host.sel()!, page, true)
    host.set(stepOn && next.lines.length > cur.lines.length ? { ...next, i: cur.lines.length } : next)
  } catch (e) {
    if (same()) host.set({ ...host.sel()!, loading: false, error: e instanceof Error ? e.message : String(e) })
  }
}

// ---- the free-list histogram -------------------------------------------------------------------------------------------------------------------

export interface HistBar { b: HeapBucket; x: number; h: number; /** a size label under this bar */ label: string; /** the chunk count is written under it */ count: boolean }

export interface Hist { width: number; height: number; bw: number; bars: HistBar[] }

/** "56", "1k", "1.5k", "16m": a bucket size as a label (one decimal below 10). */
export function sizeLabel(n: number): string {
  const unit = (v: number, u: string) => `${v < 10 ? Math.round(v * 10) / 10 : Math.round(v)}${u}`
  if (n >= 1048576) return unit(n / 1048576, 'm')
  if (n >= 1024) return unit(n / 1024, 'k')
  return String(n)
}

/**
 * The histogram of a list of buckets: one bar per bucket (bytes, to the largest), the chunk count under it while the bars are wide enough, and the bucket size under
 * every few bars. The drawing is `width` wide in its own units and scaled to its box.
 */
export function histLayout(buckets: readonly HeapBucket[], width = 480, height = 54): Hist {
  const n = Math.max(1, buckets.length)
  const bw = Math.max(3, Math.min(22, width / n))
  const max = Math.max(1, ...buckets.map((b) => b.bytes))
  const every = Math.max(1, Math.ceil(36 / bw))
  return {
    width: bw * n, height, bw,
    bars: buckets.map((b, k) => ({ b, x: k * bw, h: b.bytes > 0 ? Math.max(1.5, (b.bytes / max) * height) : 0, label: k % every === 0 ? sizeLabel(b.size) : '', count: bw >= 14 })),
  }
}

// ---- what a reading keeps ----------------------------------------------------------------------------------------------------------------------

/**
 * What the readings of one source keep while another node or tab is shown (the reading component unmounts): its tab, sorts, expanded rows and selected row, by
 * node id, and the chunk lines marked in the text. One per source (`readingUiOf`).
 */
export class ReadingUi {
  private readonly st = new Map<string, unknown>()
  private readonly lines = new Map<string, readonly number[]>()
  private readonly listeners = new Set<() => void>()
  private ver = 0

  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getVersion = (): number => this.ver
  private bump() { this.ver++; for (const fn of this.listeners) fn() }

  /** The state kept for a node; `init` makes it the first time. The same object is returned until `set` replaces it. */
  get<T>(node: string, init: () => T): T {
    if (!this.st.has(node)) this.st.set(node, init())
    return this.st.get(node) as T
  }
  set<T>(node: string, v: T): void { this.st.set(node, v); this.bump() }

  /** The chunk lines marked in the text for a node's selected row (ascending), or null. */
  marksOf(node: string | null): readonly number[] | null { return node ? this.lines.get(node) ?? null : null }
  setMarks(node: string, lines: readonly number[] | null): void {
    const had = this.lines.get(node)
    if (lines === null || lines.length === 0) { if (had) { this.lines.delete(node); this.bump() } return }
    if (had === lines) return
    this.lines.set(node, lines)
    this.bump()
  }
}

const uis = new WeakMap<object, ReadingUi>()

/** The readings' kept state of a source (made on first use, kept as long as the source is). */
export function readingUiOf(source: object): ReadingUi {
  let u = uis.get(source)
  if (!u) { u = new ReadingUi(); uis.set(source, u) }
  return u
}
