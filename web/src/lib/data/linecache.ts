import { ANNOT_PAGE, type AnnotPage, type LineKind } from './lines'

/**
 * A page of 2000 lines as the viewer holds it: texts and kind indexes (into `LINE_KINDS`) as parallel arrays, and the model ids of
 * each line (call, statement, cursor, exec number, wait; -1 where the line has none or the page came without ids).
 */
export interface CachedPage { from: number; texts: string[]; kinds: Uint8Array; calls: Int32Array; stmts: Int32Array; cursors: Int32Array; execs: Int32Array; waits: Int32Array }

/** A cached line: its text, kind index and model ids (-1 for none). */
export interface CachedLine { text: string; kind: number; call: number; stmt: number; cursor: number; execNo: number; wait: number }

export const LINE_KINDS: readonly LineKind[] = [
  'unknown', 'blank', 'header', 'separator', 'marker', 'parsing-in-cursor', 'sql-text', 'end-of-stmt', 'call', 'wait',
  'stat', 'binds', 'bind-line', 'xctend', 'error', 'parse-error', 'lob', 'rpc',
]
const kindIndex = new Map<string, number>(LINE_KINDS.map((k, i) => [k, i]))

export function packPage(p: AnnotPage): CachedPage {
  const kinds = new Uint8Array(p.lines.length)
  const texts = new Array<string>(p.lines.length)
  const ids = () => new Int32Array(p.lines.length).fill(-1)
  const calls = ids(), stmts = ids(), cursors = ids(), execs = ids(), waits = ids()
  for (let i = 0; i < p.lines.length; i++) {
    const l = p.lines[i]
    texts[i] = l.t; kinds[i] = kindIndex.get(l.k) ?? 0
    calls[i] = l.c ?? -1; stmts[i] = l.s ?? -1; cursors[i] = l.u ?? -1; execs[i] = l.x ?? -1; waits[i] = l.w ?? -1
  }
  return { from: p.from, texts, kinds, calls, stmts, cursors, execs, waits }
}

/**
 * Pages of `pageSize` lines of one file, least recently used evicted beyond `capacity`; a page being fetched is shared by every asker.
 * Page `p` holds lines `p*pageSize+1 .. (p+1)*pageSize`. `total` is learnt from the first answer.
 */
export class PageCache {
  total = 0
  private readonly pages = new Map<number, CachedPage>() // insertion order = recency
  private readonly loading = new Map<number, Promise<CachedPage>>()
  private readonly ctrls = new Map<number, AbortController>()
  private readonly listeners = new Set<() => void>()
  /** `refresh` count, and the first page it dropped: answers of an older count for those pages are not kept */
  private gen = 0
  private staleFrom = Infinity

  constructor(
    private readonly fetchPage: (from: number, n: number, signal: AbortSignal) => Promise<AnnotPage>,
    public capacity = 20,
    readonly pageSize = ANNOT_PAGE,
  ) {}

  /** The cache keeps at least `n` pages from now on (a view of far-apart rows, a statement filter's, holds a page for each of its rows; it never shrinks). */
  reserve(n: number): void { if (n > this.capacity) this.capacity = n }

  /** `fn` runs whenever a page arrives (the viewer repaints). */
  subscribe(fn: () => void): () => void { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }

  pageOf(line: number): number { return Math.floor((Math.max(1, line) - 1) / this.pageSize) }
  get pageCount(): number { return this.total > 0 ? Math.ceil(this.total / this.pageSize) : 0 }

  /** The cached page (becomes the most recent), or undefined. */
  peek(page: number): CachedPage | undefined {
    const p = this.pages.get(page)
    if (p) { this.pages.delete(page); this.pages.set(page, p) }
    return p
  }
  has(page: number): boolean { return this.pages.has(page) }
  get size(): number { return this.pages.size }

  /** Fetches a page unless it is cached or on its way. */
  load(page: number): Promise<CachedPage> {
    const hit = this.peek(page)
    if (hit) return Promise.resolve(hit)
    const run = this.loading.get(page)
    if (run) return run
    const ac = new AbortController()
    this.ctrls.set(page, ac)
    const gen = this.gen
    const p: Promise<CachedPage> = this.fetchPage(page * this.pageSize + 1, this.pageSize, ac.signal).then((r) => {
      const cp = packPage(r)
      if (gen !== this.gen && page >= this.staleFrom) return cp // asked before the file grew
      this.total = r.total || this.total
      this.pages.set(page, cp)
      while (this.pages.size > this.capacity) this.pages.delete(this.pages.keys().next().value as number)
      for (const fn of this.listeners) fn()
      return cp
    }).finally(() => { if (this.loading.get(page) === p) { this.loading.delete(page); this.ctrls.delete(page) } })
    this.loading.set(page, p)
    return p
  }

  /** `load` for the pages next to `page`, errors ignored. */
  prefetch(page: number): void {
    for (const q of [page + 1, page - 1]) {
      if (q < 0 || (this.pageCount > 0 && q >= this.pageCount) || this.pages.has(q) || this.loading.has(q)) continue
      this.load(q).catch(() => {})
    }
  }

  /** Aborts the requests on the way for pages outside `keep` (the user scrolled on while they were loading). */
  keepOnly(keep: ReadonlySet<number>): void {
    for (const [page, ac] of this.ctrls) if (!keep.has(page)) ac.abort()
  }

  /**
   * The file grew (a live session's next snapshot): the pages from the one holding the last known line on are dropped (it
   * may have been partial) and that one is fetched again, which learns the new `total`; the requests on the way for those
   * pages are aborted and their answers not kept.
   */
  refresh(): Promise<void> {
    if (this.total === 0) return Promise.resolve()
    const from = this.pageOf(this.total)
    this.gen++
    this.staleFrom = from
    for (const p of [...this.pages.keys()]) if (p >= from) this.pages.delete(p)
    for (const p of [...this.loading.keys()]) {
      if (p < from) continue
      this.ctrls.get(p)?.abort()
      this.loading.delete(p)
      this.ctrls.delete(p)
    }
    return this.load(from).then(() => undefined, () => undefined)
  }

  /** Aborts every request on the way (the file or the server changed). */
  close(): void { for (const ac of this.ctrls.values()) ac.abort() }

  /** The text, kind and model ids of line `n` when its page is cached (the ids are -1 when the page came without them). */
  line(n: number): CachedLine | undefined {
    const p = this.pages.get(this.pageOf(n))
    if (!p) return undefined
    const i = n - p.from
    return i >= 0 && i < p.texts.length
      ? { text: p.texts[i], kind: p.kinds[i], call: p.calls[i], stmt: p.stmts[i], cursor: p.cursors[i], execNo: p.execs[i], wait: p.waits[i] }
      : undefined
  }

  /**
   * The nearest line after (`dir` 1) or before (-1) `from` whose kind index is `kind`, looking only at cached pages: the scan stops
   * at the first line whose page is not loaded (or at the file's ends) and answers undefined.
   */
  nextOfKind(from: number, kind: number, dir: 1 | -1): number | undefined {
    for (let n = from + dir; n >= 1; n += dir) {
      const p = this.pages.get(this.pageOf(n))
      const i = p ? n - p.from : -1
      if (!p || i < 0 || i >= p.kinds.length) return undefined
      if (p.kinds[i] === kind) return n
    }
    return undefined
  }
}
