// Indexes over one dump, built once when it opens: the outline's nodes and parents, the lines that start things (folds, landmarks, SQL
// statements, runs), the chain of outline nodes holding a line, and the landmark kinds with their defaults.
import type { OptBanner, OptDump, OptFold, OptLandmark, OptNode, OptRun, OptSql } from './opt'

/** A node with the links the index adds (a parent and its depth in the tree). */
export interface IxNode extends OptNode { depth: number; parent: IxNode | null; kids: IxNode[] }

export interface DumpIndex {
  dump: OptDump
  root: IxNode
  nodes: IxNode[]
  byId: Map<string, IxNode>
  /** the outermost node that starts at a line */
  startAt: Map<number, IxNode>
  /** the folds starting at a line, outermost first */
  foldsAt: Map<number, OptFold[]>
  folds: OptFold[]
  foldById: Map<string, OptFold>
  lmAt: Map<number, OptLandmark>
  sqlAt: Map<number, OptSql>
  sqlHeadAt: Map<number, OptSql>
  runAt: Map<string, OptRun>
  banners: Map<number, OptBanner>
  phases: IxNode[]
  /** the lines of the statement as typed and its repeats (coloured as SQL) */
  sqlText: Set<number>
  /** the first line of the "Final query after transformations" node (0 when there is none) */
  finalQueryLine: number
  n: number
}

export function indexDump(dump: OptDump): DumpIndex {
  const nodes: IxNode[] = []
  const byId = new Map<string, IxNode>()
  const walk = (n: OptNode, depth: number, parent: IxNode | null): IxNode => {
    const x: IxNode = { ...n, depth, parent, kids: [] }
    nodes.push(x)
    byId.set(x.id, x)
    for (const c of n.children ?? []) x.kids.push(walk(c, depth + 1, x))
    return x
  }
  const root = walk(dump.tree, 0, null)
  const startAt = new Map<number, IxNode>()
  for (const n of nodes) if (!startAt.has(n.from)) startAt.set(n.from, n)
  const folds = [...dump.folds].sort((a, b) => a.from - b.from || b.to - a.to)
  const foldsAt = new Map<number, OptFold[]>()
  for (const f of folds) { const l = foldsAt.get(f.from); if (l) l.push(f); else foldsAt.set(f.from, [f]) }
  const sqlText = new Set<number>()
  for (let i = dump.stmtLine; i <= dump.stmtTo; i++) sqlText.add(i)
  for (const f of folds) if (f.kind === 'stmt-again') for (let i = f.from; i <= f.to; i++) sqlText.add(i)
  const fq = nodes.find((n) => n.kind === 'final-query')
  return {
    dump, root, nodes, byId, startAt, foldsAt, folds, foldById: new Map(folds.map((f) => [f.id, f])),
    lmAt: new Map(dump.landmarks.map((l) => [l.line, l])),
    sqlAt: new Map(dump.sql.map((v) => [v.line, v])),
    sqlHeadAt: new Map(dump.sql.map((v) => [v.head, v])),
    runAt: new Map(dump.runs.map((r) => [r.id, r])),
    banners: new Map(dump.banners.map((b) => [b.title, b])),
    phases: root.kids.filter((n) => n.kind.startsWith('phase-')),
    sqlText, finalQueryLine: fq ? fq.from : 0,
    n: dump.viewTo - dump.viewFrom + 1,
  }
}

/** The child of `n` holding `line` (children are in file order, apart), by binary search. */
function childAt(n: IxNode, line: number): IxNode | null {
  const k = n.kids
  let lo = 0
  let hi = k.length - 1
  while (lo <= hi) {
    const m = (lo + hi) >> 1
    if (k[m].to < line) lo = m + 1
    else if (k[m].from > line) hi = m - 1
    else return k[m]
  }
  return null
}

/** The chain of outline nodes holding a line, root first. */
export function pathOf(ix: DumpIndex, line: number): IxNode[] {
  const out = [ix.root]
  let n = ix.root
  for (;;) {
    const c = childAt(n, line)
    if (!c) break
    out.push(c)
    n = c
  }
  return out
}

/** The innermost fold holding a line past its first (or null). */
export function foldOf(ix: DumpIndex, line: number): OptFold | null {
  let best: OptFold | null = null
  for (const f of ix.folds) if (f.from <= line && line <= f.to && (!best || f.from >= best.from)) best = f
  return best
}

// ---- landmarks -----------------------------------------------------------------------------------------------------------------

export interface LmKind { k: string; label: string; short: string; tone: 'kept' | 'rejected' | 'problem' | 'mixed'; on: boolean }

/** The landmark kinds in the order the list shows them, with the defaults the user confirmed: on are the kinds that end a unit the outline shows and hint errors; the refusals are off. */
export const LM_KINDS: readonly LmKind[] = [
  { k: 'verdict', label: 'Updated / Not update best state, Will not …', short: 'Verdicts', tone: 'mixed', on: true },
  { k: 'final-cost', label: 'Final cost for query block', short: 'Final cost', tone: 'kept', on: true },
  { k: 'best-ap', label: 'Best:: AccessPath', short: 'Best access path', tone: 'kept', on: true },
  { k: 'hint-error', label: 'Hint with an error', short: 'Hint errors', tone: 'problem', on: true },
  { k: 'best-jm', label: 'Best:: JoinMethod', short: 'Best join method', tone: 'kept', on: true },
  { k: 'aborted', label: 'Join order aborted', short: 'Aborted join orders', tone: 'rejected', on: true },
  { k: 'refused', label: 'Bypassed or refused transformation', short: 'Refusals', tone: 'rejected', on: false },
]

export type LmOn = Readonly<Record<string, boolean>>

export const LM_DEFAULTS: LmOn = Object.freeze(Object.fromEntries(LM_KINDS.map((k) => [k.k, k.on])))

/** The switches with the stored ones laid over the defaults (a kind the store does not know keeps its default). */
export function lmSwitches(stored: Partial<Record<string, boolean>> | null | undefined): LmOn {
  const out: Record<string, boolean> = { ...LM_DEFAULTS }
  if (stored) for (const k of Object.keys(out)) if (typeof stored[k] === 'boolean') out[k] = stored[k] as boolean
  return out
}

/** The landmarks of the kinds that are on, in file order. A kind that is off is not tinted, not on the line map and not stepped through. */
export function enabledLandmarks(d: Pick<OptDump, 'landmarks'>, on: LmOn): OptLandmark[] {
  return d.landmarks.filter((l) => on[l.kind] === true)
}

/** The count of landmarks per kind. */
export function landmarkCounts(d: Pick<OptDump, 'landmarks'>): Record<string, number> {
  const c: Record<string, number> = {}
  for (const l of d.landmarks) c[l.kind] = (c[l.kind] ?? 0) + 1
  return c
}

/** The next (dir 1) or previous line of an ascending list, wrapping around; 0 for an empty list. `from`: the line the step starts at. */
export function stepLine(list: ArrayLike<number>, from: number, dir: 1 | -1): number {
  if (list.length === 0) return 0
  if (dir > 0) {
    let lo = 0
    let hi = list.length
    while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] <= from) lo = m + 1; else hi = m }
    return lo < list.length ? list[lo] : list[0]
  }
  let lo = 0
  let hi = list.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (list[m] < from) lo = m + 1; else hi = m }
  return lo > 0 ? list[lo - 1] : list[list.length - 1]
}
