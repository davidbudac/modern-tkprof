// What the outline shows: the key a node is kept open under, the nodes in file order down the open ones, the node that holds a line, the dump list's wording.
import type { OptDumpInfo } from './opt'
import { pathOf, type DumpIndex, type IxNode } from './optindex'

/** The key an outline node is kept open under: node ids are unique in a dump only. */
export const nodeKey = (dump: number, id: string) => `${dump}/${id}`

export type OutlineMode = 'all' | 'runs'

/** The nodes the outline shows for the open dump, in file order with their depth (the dump's own row is not in the list). */
export function outlineNodes(ix: DumpIndex, exp: ReadonlySet<string>, mode: OutlineMode): { n: IxNode; depth: number }[] {
  const out: { n: IxNode; depth: number }[] = []
  const idx = ix.dump.idx
  const push = (n: IxNode, depth: number) => {
    out.push({ n, depth })
    if (exp.has(nodeKey(idx, n.id))) for (const c of n.kids) push(c, depth + 1)
  }
  if (mode === 'runs') { for (const n of ix.nodes) if (n.kind === 'run') push(n, 1) }
  else for (const c of ix.root.kids) push(c, 1)
  return out
}

/** The deepest node of the chain holding `line` that the outline shows (null when the dump's own row is the deepest). */
export function currentNode(ix: DumpIndex, shown: ReadonlySet<string>, line: number): string | null {
  let cur: string | null = null
  for (const n of pathOf(ix, line)) if (shown.has(n.id)) cur = n.id
  return cur
}

/** The wording of a dump's number in the list: "dump 3", and "#2" when its sql_id repeats. */
export function dumpLabel(d: Pick<OptDumpInfo, 'idx' | 'nth' | 'sqlId'>, repeated: boolean): string {
  return `dump ${d.idx + 1}` + (repeated ? ` · #${d.nth}` : '')
}


export function ordinal(n: number): string {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])
}
