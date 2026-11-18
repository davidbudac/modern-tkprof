// What the dump reader's outline holds: the top level from the file's facts and, of every node that was opened, its children, asked for when it
// was (a system state has millions of state objects; nothing is held that was not asked for). A node's children come in pages of at most 2,000
// (`after`), a page is asked for by the row "N of M shown · load more". The store keeps what was opened, so a tab that is shown again finds its outline
// as it left it. It is plain data and a subscription, so the tests need no browser.
import { PathUnavailable, ROOT, type DiagChildren, type DiagNode, type DiagSource, type PathBy } from './diag'

/** The children of one node, as far as they are loaded. */
export interface Kids {
  nodes: DiagNode[]
  /** children that follow those loaded */
  more: number
  /** the `after` of the next page */
  next: number
  /** children the source cannot give (the standalone report's digest lists some of them only) */
  unlisted: number
  loading: boolean
  error: string | null
}

/** A row of the outline as drawn. `depth` is 0 for the top level. */
export type OutlineRow =
  | { t: 'node'; node: DiagNode; depth: number; open: boolean; loading: boolean }
  | { t: 'more'; parent: string; depth: number; shown: number; total: number; loading: boolean; error: string | null }
  | { t: 'note'; parent: string; depth: number; text: string; error: boolean }

/** How far "Expand" opens the loaded nodes (levels, the top level being the first). */
export const EXPAND_DEPTH = 3

export class DiagOutlineStore {
  private readonly kids = new Map<string, Kids>()
  private readonly open = new Set<string>()
  private readonly nodes = new Map<string, DiagNode>()
  private readonly parent = new Map<string, string>()
  private readonly listeners = new Set<() => void>()
  private ver = 0
  private cache: { ver: number; rows: OutlineRow[] } | null = null
  private headCache: { ver: number; map: Map<number, number> } | null = null
  /** a node's top-level load that is in flight, so two askers share it */
  private readonly inflight = new Map<string, Promise<void>>()
  private closed = false

  constructor(readonly source: DiagSource) {
    const f = source.file
    this.setKids(ROOT, { nodes: f.outline, more: Math.max(0, f.outlineTotal - f.outline.length), next: f.outline.length, unlisted: 0, loading: false, error: null })
    for (const [id, o] of source.preloaded ?? []) this.setKids(id, kidsOf(o, 0))
  }

  // ---- the subscription ----
  subscribe = (fn: () => void): (() => void) => { this.listeners.add(fn); return () => { this.listeners.delete(fn) } }
  getVersion = (): number => this.ver
  private bump() { this.ver++; for (const fn of this.listeners) fn() }
  /** Stops the answers in flight from changing the store (the tab was closed). */
  dispose() { this.closed = true }

  private setKids(id: string, k: Kids) {
    this.kids.set(id, k)
    for (const n of k.nodes) { this.nodes.set(n.id, n); this.parent.set(n.id, id) }
  }

  // ---- reading ----
  node(id: string): DiagNode | undefined { return this.nodes.get(id) }
  parentOf(id: string): string | undefined { const p = this.parent.get(id); return p === ROOT ? undefined : p }
  kidsOf(id: string): Kids | undefined { return this.kids.get(id) }
  isOpen(id: string): boolean { return this.open.has(id) }
  /** How many nodes are loaded (the top level and everything opened). */
  get loaded(): number { return this.nodes.size }

  /** The rows to draw: the open nodes with their loaded children, a "load more" row where a page is not all there, a note where a node's children are on their way or failed. */
  rows(): OutlineRow[] {
    if (this.cache?.ver === this.ver) return this.cache.rows
    const out: OutlineRow[] = []
    const walk = (id: string, depth: number) => {
      const k = this.kids.get(id)
      if (!k) return
      for (const n of k.nodes) {
        const open = this.open.has(n.id)
        const kk = this.kids.get(n.id)
        out.push({ t: 'node', node: n, depth, open, loading: !!kk?.loading })
        if (open && n.hasChildren) {
          if (kk?.error && kk.nodes.length === 0) out.push({ t: 'note', parent: n.id, depth: depth + 1, text: kk.error, error: true })
          else if (!kk || (kk.loading && kk.nodes.length === 0)) out.push({ t: 'note', parent: n.id, depth: depth + 1, text: 'Loading…', error: false })
          else walk(n.id, depth + 1)
        }
      }
      if (k.more > 0 && (id === ROOT || this.open.has(id))) out.push({ t: 'more', parent: id, depth, shown: k.nodes.length, total: k.nodes.length + k.more, loading: k.loading, error: k.error })
      else if (k.unlisted > 0 && (id === ROOT || this.open.has(id))) out.push({ t: 'note', parent: id, depth, text: `${k.unlisted.toLocaleString('en-US')} more not in this report`, error: false })
    }
    walk(ROOT, 0)
    this.cache = { ver: this.ver, rows: out }
    return out
  }

  // ---- loading ----

  /** Loads the first page of a node's children (once; a failure is tried again by the next ask). */
  load(id: string): Promise<void> {
    const have = this.kids.get(id)
    if (have && !have.error && (have.nodes.length > 0 || have.more === 0)) return Promise.resolve()
    const run = this.inflight.get(id)
    if (run) return run
    this.patchKids(id, { loading: true, error: null })
    const p = this.source.outline(id, 0).then(
      (o) => { if (!this.closed) { this.setKids(id, kidsOf(o, 0)); this.bump() } },
      (e: unknown) => { if (!this.closed) { this.patchKids(id, { loading: false, error: errMsg(e) }); this.bump() } },
    ).finally(() => { this.inflight.delete(id) })
    this.inflight.set(id, p)
    this.bump()
    return p
  }

  /** Loads the next page of a node's children. */
  loadMore(id: string): Promise<void> {
    const k = this.kids.get(id)
    if (!k || k.loading || k.more === 0) return Promise.resolve()
    this.patchKids(id, { loading: true, error: null })
    this.bump()
    return this.source.outline(id, k.next).then(
      (o) => {
        if (this.closed) return
        const cur = this.kids.get(id) ?? k
        this.setKids(id, { nodes: [...cur.nodes, ...o.children], more: o.more, next: o.next ?? cur.next + o.children.length, unlisted: o.unlisted ?? 0, loading: false, error: null })
        this.bump()
      },
      (e: unknown) => { if (!this.closed) { this.patchKids(id, { loading: false, error: errMsg(e) }); this.bump() } },
    )
  }

  private patchKids(id: string, p: Partial<Kids>) {
    const k = this.kids.get(id) ?? { nodes: [], more: 0, next: 0, unlisted: 0, loading: false, error: null }
    this.kids.set(id, { ...k, ...p })
  }

  // ---- opening and closing ----

  /** Opens a node (loading its children); a node without children stays as it is. */
  openNode(id: string): Promise<void> {
    const n = this.nodes.get(id)
    if (!n?.hasChildren) return Promise.resolve()
    if (!this.open.has(id)) { this.open.add(id); this.bump() }
    return this.load(id)
  }
  closeNode(id: string) { if (this.open.delete(id)) this.bump() }
  toggle(id: string): Promise<void> {
    if (this.open.has(id)) { this.closeNode(id); return Promise.resolve() }
    return this.openNode(id)
  }

  /** Opens the nodes that hold `id` (not `id` itself), so its row is drawn. */
  revealNode(id: string): void {
    let changed = false
    for (let p = this.parent.get(id); p && p !== ROOT; p = this.parent.get(p)) if (!this.open.has(p)) { this.open.add(p); changed = true }
    if (changed) this.bump()
  }

  /** "Expand": opens the loaded nodes down to `depth` levels (the top level is the first), asking for the children of the ones that are not loaded yet. */
  async expand(depth = EXPAND_DEPTH): Promise<void> {
    const todo: Promise<void>[] = []
    const walk = (id: string, level: number) => {
      const k = this.kids.get(id)
      if (!k) return
      for (const n of k.nodes) {
        if (level >= depth || !n.hasChildren) continue
        if (!this.open.has(n.id)) this.open.add(n.id)
        const kk = this.kids.get(n.id)
        if (!kk) todo.push(this.load(n.id).then(() => walk(n.id, level + 1)))
        else walk(n.id, level + 1)
      }
    }
    walk(ROOT, 1)
    this.bump()
    await Promise.all(todo)
  }

  /** "Collapse": back to the top level and the way down to `keep` (the selected node). */
  collapse(keep?: string) {
    this.open.clear()
    if (keep) for (let p = this.parent.get(keep); p && p !== ROOT; p = this.parent.get(p)) this.open.add(p)
    this.bump()
  }

  /**
   * The outline at first sight: the top-level nodes that have parts are opened when there are only a few of them (a file with one diagnostic
   * dump shows its sections at once; one with eighty heap dumps shows the eighty).
   */
  openFirst(max = 3): Promise<void> {
    const k = this.kids.get(ROOT)
    if (!k) return Promise.resolve()
    const withKids = k.nodes.filter((n) => n.hasChildren)
    if (withKids.length === 0 || withKids.length > max) return Promise.resolve()
    return Promise.all(withKids.map((n) => this.openNode(n.id))).then(() => undefined)
  }

  // ---- where a line is ----

  /** The nodes that hold `line`, outermost first, as far as they are loaded: the where-am-I path. */
  pathAt(line: number): DiagNode[] {
    const path: DiagNode[] = []
    let id = ROOT
    for (;;) {
      const k = this.kids.get(id)
      if (!k) break
      const n = nodeIn(k.nodes, line)
      if (!n) break
      path.push(n)
      id = n.id
    }
    return path
  }

  /** The nodes from the top level down to `id`, outermost first (empty for a node that is not loaded). */
  pathTo(id: string): DiagNode[] {
    const out: DiagNode[] = []
    for (let n = this.nodes.get(id); n; n = this.parent.has(n.id) && this.parent.get(n.id) !== ROOT ? this.nodes.get(this.parent.get(n.id)!) : undefined) out.unshift(n)
    return out
  }

  /** The deepest loaded node that holds `line`. */
  nodeAt(line: number): DiagNode | undefined { return this.pathAt(line).at(-1) }

  /** The first line of every loaded node, with its depth (the top level is 0): what the text dresses as headings. The shallowest wins where nodes start on one line. */
  headings(): ReadonlyMap<number, number> {
    if (this.headCache?.ver === this.ver) return this.headCache.map
    const map = new Map<number, number>()
    const walk = (id: string, depth: number) => {
      const k = this.kids.get(id)
      if (!k) return
      for (const n of k.nodes) {
        if (!map.has(n.from)) map.set(n.from, depth)
        walk(n.id, depth + 1)
      }
    }
    walk(ROOT, 0)
    this.headCache = { ver: this.ver, map }
    return map
  }

  // ---- nodes that are not loaded (api/diag/path) ----

  /** The deeper chains the source has told, for the where-am-I path of a line inside a part whose children are not loaded: the last 64. */
  private readonly deep: DiagNode[][] = []
  private readonly deepAsked = new Map<number, Promise<void>>()
  /** Set once the source said it cannot locate (`PathUnavailable`): nothing is asked again. */
  private noPath = false

  /** Whether a line lies in a part whose children the outline has not loaded, so that `pathAt` stops above where the line really is. */
  needsDeep(line: number): boolean {
    if (this.noPath) return false
    const last = this.pathAt(line).at(-1)
    return !!last && last.hasChildren && !this.kids.has(last.id) && !this.deep.some((c) => { const n = c.at(-1)!; return line >= n.from && line <= n.to })
  }

  /**
   * The where-am-I path of a line: the loaded nodes that hold it and, below them, the chain `api/diag/path` told for a part that was not loaded (`fetchDeep`
   * asks for it). Only chains that start with the loaded path count: the outline may have changed since.
   */
  pathAtDeep(line: number): DiagNode[] {
    const loaded = this.pathAt(line)
    for (const c of this.deep) {
      const n = c.at(-1)!
      if (line < n.from || line > n.to || c.length <= loaded.length) continue
      if (loaded.every((x, i) => c[i]?.id === x.id)) return c
    }
    return loaded
  }

  /** Asks the source for the chain of a line that is in an unloaded part (once per line at a time); the store changes when it arrives. */
  fetchDeep(line: number): Promise<void> {
    if (!this.needsDeep(line)) return Promise.resolve()
    const run = this.deepAsked.get(line)
    if (run) return run
    const p = this.source.path({ line }).then(
      (chain) => {
        if (this.closed || chain.length === 0) return
        this.deep.push(chain)
        if (this.deep.length > 64) this.deep.shift()
        this.bump()
      },
      (e: unknown) => { if (e instanceof PathUnavailable) this.noPath = true },
    ).finally(() => { this.deepAsked.delete(line) })
    this.deepAsked.set(line, p)
    return p
  }

  /**
   * Loads the nodes of a chain (`source.path`) into the outline, a page of children at a time where a node is not in the first, and opens it down to its parent:
   * the node of the chain's end is then a row of the outline. Resolves to that node, or undefined when the source cannot tell, has none, or a parent does not list it.
   */
  async locate(by: PathBy): Promise<DiagNode | undefined> {
    const known = 'node' in by ? this.nodes.get(by.node) : undefined
    if (known) { this.revealNode(known.id); return known }
    let chain: DiagNode[]
    try { chain = await this.source.path(by) } catch (e) { if (e instanceof PathUnavailable) this.noPath = true; return undefined }
    if (this.closed || chain.length === 0) return undefined
    let parent = ROOT
    for (const n of chain) {
      if (!this.nodes.has(n.id)) {
        await this.load(parent)
        for (let guard = 0; !this.nodes.has(n.id) && guard < 50; guard++) {
          const k = this.kids.get(parent)
          if (!k || k.more === 0 || k.error) break
          await this.loadMore(parent)
        }
        if (!this.nodes.has(n.id)) return undefined
      }
      parent = n.id
    }
    const end = this.nodes.get(chain[chain.length - 1].id)
    if (end) this.revealNode(end.id)
    return end
  }

  /** The loaded nodes that have a fold reason (`DiagNode.fold`), in file order, outermost first where one holds another. */
  folded(): DiagNode[] {
    if (this.foldCache?.ver === this.ver) return this.foldCache.list
    const out: DiagNode[] = []
    const walk = (id: string) => {
      const k = this.kids.get(id)
      if (!k) return
      for (const n of k.nodes) { if (n.fold) out.push(n); walk(n.id) }
    }
    walk(ROOT)
    out.sort((a, b) => a.from - b.from || b.to - a.to)
    this.foldCache = { ver: this.ver, list: out }
    return out
  }
  private foldCache: { ver: number; list: DiagNode[] } | null = null

  /** The top-level nodes, with where each is: the line map's bands. */
  top(): readonly DiagNode[] { return this.kids.get(ROOT)?.nodes ?? [] }
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e))

function kidsOf(o: DiagChildren, after: number): Kids {
  return { nodes: o.children, more: o.more, next: o.next ?? after + o.children.length, unlisted: o.unlisted ?? 0, loading: false, error: null }
}

/** The node of a list in file order whose lines hold `line` (binary search; the list does not overlap). */
export function nodeIn(nodes: readonly DiagNode[], line: number): DiagNode | undefined {
  let lo = 0
  let hi = nodes.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const n = nodes[mid]
    if (line < n.from) hi = mid - 1
    else if (line > n.to) lo = mid + 1
    else return n
  }
  return undefined
}

/** What a view keeps per source while another tab is shown: the store of the outline. */
const stores = new WeakMap<DiagSource, DiagOutlineStore>()
export function outlineStoreOf(source: DiagSource): DiagOutlineStore {
  let s = stores.get(source)
  if (!s) { s = new DiagOutlineStore(source); stores.set(source, s) }
  return s
}
