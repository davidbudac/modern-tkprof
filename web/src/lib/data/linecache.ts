import { ANNOT_PAGE, type AnnotPage, type LineKind } from './lines'

/** A page of 2000 lines as the viewer holds it: texts and kind indexes (into `LINE_KINDS`) as parallel arrays. */
export interface CachedPage { from: number; texts: string[]; kinds: Uint8Array }

export const LINE_KINDS: readonly LineKind[] = [
  'unknown', 'blank', 'header', 'separator', 'marker', 'parsing-in-cursor', 'sql-text', 'end-of-stmt', 'call', 'wait',
  'stat', 'binds', 'bind-line', 'xctend', 'error', 'parse-error', 'lob', 'rpc',
]
const kindIndex = new Map<string, number>(LINE_KINDS.map((k, i) => [k, i]))

export function packPage(p: AnnotPage): CachedPage {
  const kinds = new Uint8Array(p.lines.length)
  const texts = new Array<string>(p.lines.length)
  for (let i = 0; i < p.lines.length; i++) { texts[i] = p.lines[i].t; kinds[i] = kindIndex.get(p.lines[i].k) ?? 0 }
  return { from: p.from, texts, kinds }
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

  constructor(
    private readonly fetchPage: (from: number, n: number, signal: AbortSignal) => Promise<AnnotPage>,
    readonly capacity = 20,
    readonly pageSize = ANNOT_PAGE,
  ) {}

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
    const p = this.fetchPage(page * this.pageSize + 1, this.pageSize, ac.signal).then((r) => {
      this.total = r.total || this.total
      const cp = packPage(r)
      this.pages.set(page, cp)
      while (this.pages.size > this.capacity) this.pages.delete(this.pages.keys().next().value as number)
      for (const fn of this.listeners) fn()
      return cp
    }).finally(() => { this.loading.delete(page); this.ctrls.delete(page) })
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

  /** Aborts every request on the way (the file or the server changed). */
  close(): void { for (const ac of this.ctrls.values()) ac.abort() }

  /** The text and kind of line `n` when its page is cached. */
  line(n: number): { text: string; kind: number } | undefined {
    const p = this.pages.get(this.pageOf(n))
    if (!p) return undefined
    const i = n - p.from
    return i >= 0 && i < p.texts.length ? { text: p.texts[i], kind: p.kinds[i] } : undefined
  }
}
