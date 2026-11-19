// The Search map of the 10053 view: one costing run's search of join orders, as the points to draw. A pure builder over the run's node of the outline
// (data/opt.ts); the numbers it carries are the ones the trace prints, kept as the printed strings. A string is read as a number only to place
// a dot on the cost axis (`plot`); nothing is added, compared for a verdict or divided: the best-so-far line carries the printed cost of the last
// completed order forward, and the two shapes of an aborted order (no join step printed at all, a step that printed no cost) stay apart.
import type { OptNode, OptRun } from './opt'

/** What the map needs of an outline node: the fields of OptNode, with `children` (an index node has them too). */
type N = OptNode

// ---- the table of runs -------------------------------------------------------------------------------------------------------------------------

/** One row of the table of all the costing runs of a dump. */
export interface SmRunRow {
  run: OptRun
  /** the run's node in the outline */
  id: string
  /** join orders the run tried, in all its join searches */
  orders: number
  /** how many of them the trace says were aborted */
  aborted: number
  /** the run's `Final cost for query block` cost as printed ('' when it has none) */
  finalCost: string
  /** the number of the join order the final cost names (0 none) */
  bestJo: number
}

function walk(n: N, f: (x: N) => void): void {
  f(n)
  if (n.children) for (const c of n.children) walk(c, f)
}

/** The run nodes of an outline, in file order. */
export function runNodes(root: N): N[] {
  const out: N[] = []
  walk(root, (n) => { if (n.kind === 'run') out.push(n) })
  return out
}

/** The join-order nodes of a node (a run, or one of its join searches), in file order. */
function joinOrders(n: N): N[] {
  const out: N[] = []
  walk(n, (x) => { if (x.kind === 'join-order') out.push(x) })
  return out
}

/** One row per run of the dump, in file order. */
export function runRows(runs: readonly OptRun[], root: N): SmRunRow[] {
  const byId = new Map(runNodes(root).map((n) => [n.id, n]))
  return runs.map((run) => {
    const node = byId.get(run.id)
    const jos = node ? joinOrders(node) : []
    return { run, id: run.id, orders: jos.length, aborted: jos.filter((j) => j.result === 'aborted').length, finalCost: run.finalCost ?? '', bestJo: run.bestJo }
  })
}

// ---- the map of one run ------------------------------------------------------------------------------------------------------------------------

/** Why an order has no completed cost. */
export type SmAbort =
  /** the trace printed no join step for the order (it was abandoned after its first table) */
  | 'no-step'
  /** the last join step printed no cost (the order was abandoned inside it) */
  | 'in-step'
  /** every join step printed a cost, and the order was abandoned after the last one */
  | 'after-step'

/** A cost the trace printed for one position of an order. */
export interface SmPoint {
  /** the position in the order, 0 the first table */
  pos: number
  /** as printed */
  text: string
  /** the value placed on the log axis; null when the text is not a positive number (the dot is left out, the text stays) */
  v: number | null
  /** where it comes from: the first table's access path, a join step's method, the order's `Best so far` block */
  from: 'access' | 'step' | 'best-so-far'
}

export interface SmOrder {
  /** the join-order node's id (the key: join order numbers restart in a run that has more than one search) */
  id: string
  /** 0-based place in the order tried */
  index: number
  /** the trace's join order number */
  n: number
  /** the join order's first line in the file */
  line: number
  /** the tables as printed, "MTK_CUST[C]#0" */
  tables: string[]
  /** a short name per position: the alias, else the table name */
  labels: string[]
  /** the colour slot of each position's table (0..PALETTE-1), the same table the same slot in every order */
  slot: number[]
  /** the costs the trace printed, in position order */
  points: SmPoint[]
  done: boolean
  /** a completed order: the cost of its last `Best so far` line, as printed */
  cost: string
  /** an aborted order: which of the two shapes */
  abort: SmAbort | null
  /** an aborted order: the position it was abandoned at (the table of its last join step, 0 when no step was printed) */
  abortAt: number
  isBest: boolean
  /** the printed cost of the last completed order up to and including this one: the best complete plan so far; '' before the first */
  bestText: string
  bestV: number | null
}

export interface SmLegend { slot: number; label: string; table: string }

export interface SearchMap {
  /** the run's node id */
  run: string
  /** how many join searches the run has (an or-expansion costs a branch each), and which one the map shows (0-based) */
  searches: number
  search: number
  orders: SmOrder[]
  /** the winner's index in `orders` (the order the run's `Best join order` names); -1 none */
  winner: number
  legend: SmLegend[]
  /** the axis: the low and high of the cost axis, and the tick values */
  axis: { lo: number; hi: number; ticks: number[] } | null
  /** the best-so-far step line: from which order it holds, the printed text and the value */
  steps: { index: number; text: string; v: number }[]
}

/** The colour slots of the permutation strip; a block of more tables reuses them. */
export const PALETTE = 10

const hash = /#(\d+)$/

/** The short name of "MTK_ORDERS[O]#1": the alias; "MTK_ORDERS[MTK_ORDERS]#3" and "T#0" give the table name. */
export function shortName(printed: string): string {
  const base = printed.replace(hash, '')
  const m = /^(.*?)\[(.*)\]$/.exec(base)
  if (!m) return base
  return m[2] || m[1]
}

/** "MTK_ORDERS[O]#1" -> "MTK_ORDERS[O]": the key a table section is found by. */
export const tableRef = (printed: string): string => printed.replace(hash, '')

/** A printed cost read as a number for the axis only; null for what is not a positive finite number. */
export function plot(text: string): number | null {
  const v = Number.parseFloat(text)
  return Number.isFinite(v) && v > 0 ? v : null
}

/** The tick values of a log axis from lo to hi: 1, 3 and 10 of each decade, thinned to at most about `max`. */
export function logTicks(lo: number, hi: number, max = 7): number[] {
  if (!(lo > 0) || !(hi >= lo)) return []
  const all: number[] = []
  const d0 = Math.floor(Math.log10(lo))
  const d1 = Math.ceil(Math.log10(hi))
  for (let d = d0; d <= d1; d++) for (const m of [1, 3]) { const t = m * 10 ** d; if (t >= lo * 0.999 && t <= hi * 1.001) all.push(t) }
  if (all.length <= max) return all
  const only1 = all.filter((t) => Math.abs(Math.log10(t) - Math.round(Math.log10(t))) < 1e-9)
  return only1.length >= 2 ? only1 : all
}

/** The table sections of a run in file order, for finding a first table's access cost. */
interface TableSec { ref: string; to: number; cost: string }

function tableSections(run: N): TableSec[] {
  const out: TableSec[] = []
  walk(run, (n) => { if (n.kind === 'table' && n.ref && n.accCost) out.push({ ref: n.ref, to: n.to, cost: n.accCost }) })
  return out
}

/**
 * The map of one run. `search` picks one of the run's join searches (0-based; the last when omitted or out of range): a run costed for an
 * or-expansion has one per branch, each with its own join order numbers.
 */
export function buildSearchMap(run: N, search?: number): SearchMap {
  const searches: N[] = []
  walk(run, (n) => { if (n.kind === 'join-search') searches.push(n) })
  const s = searches.length === 0 ? -1 : search !== undefined && search >= 0 && search < searches.length ? search : searches.length - 1
  const nodes = s < 0 ? joinOrders(run) : joinOrders(searches[s])
  const secs = tableSections(run)

  // a table section is the one costed before the order: a one-table block is costed again after its search, with another access path
  const accessOf = (ref: string, before: number): string => {
    for (let i = secs.length - 1; i >= 0; i--) if (secs[i].ref === ref && secs[i].to < before) return secs[i].cost
    return ''
  }

  // the colour slot of a table: its `#n`, which is unique in a run (the alias is not: a table can be in a block twice)
  const slotOf = new Map<string, number>()
  const legendBy = new Map<number, SmLegend>()
  let seen = 0
  const slot = (printed: string): number => {
    const m = hash.exec(printed)
    const key = m ? m[1] : `first${seen}`
    let k = slotOf.get(key)
    if (k === undefined) {
      k = (m ? Number(m[1]) : seen) % PALETTE
      slotOf.set(key, k)
      seen++
    }
    if (!legendBy.has(k)) legendBy.set(k, { slot: k, label: shortName(printed), table: printed })
    return k
  }

  const orders: SmOrder[] = []
  const steps: SearchMap['steps'] = []
  let bestText = ''
  let bestV: number | null = null
  let winner = -1
  let lo = Infinity
  let hi = 0
  const see = (v: number | null) => { if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v } }

  nodes.forEach((jo, index) => {
    const tables = jo.tables ?? []
    const kids = jo.children ?? []
    const stepNodes = kids.filter((c) => c.kind === 'join-step')
    const done = !!jo.cost && jo.result !== 'aborted'
    const points: SmPoint[] = []
    const point = (pos: number, text: string, from: SmPoint['from']) => { const v = plot(text); points.push({ pos, text, v, from }); see(v) }
    let abort: SmAbort | null = null
    let abortAt = 0
    if (done) {
      // every position has its cost in the `Best so far` block
      ;(jo.posCosts ?? []).forEach((t, pos) => point(pos, t, 'best-so-far'))
    } else {
      // the first table's access cost, then each step that printed one, placed by the table the step names (a step shared with the order before it is not printed again)
      if (tables.length > 0) { const c = accessOf(tableRef(tables[0]), jo.from); if (c) point(0, c, 'access') }
      let prev = 0
      for (const st of stepNodes) {
        let pos = tables.indexOf(st.table ?? '')
        if (pos < 0) pos = prev + 1
        prev = pos
        abortAt = pos
        if (st.stepCost) point(pos, st.stepCost, 'step')
      }
      if (jo.result === 'aborted') abort = stepNodes.length === 0 ? 'no-step' : stepNodes[stepNodes.length - 1].stepCost ? 'after-step' : 'in-step'
    }
    if (done) {
      bestText = jo.cost ?? ''
      bestV = plot(bestText)
      if (bestV !== null) steps.push({ index, text: bestText, v: bestV })
    }
    const isBest = !!jo.isBest
    if (isBest) winner = index
    orders.push({
      id: jo.id, index, n: jo.n ?? index + 1, line: jo.from, tables, labels: tables.map(shortName), slot: tables.map(slot), points, done,
      cost: done ? jo.cost ?? '' : '', abort, abortAt, isBest, bestText, bestV,
    })
  })
  see(bestV)
  // the aborted orders sit just above the best-so-far line, so the axis takes in the line's values too
  const axis = hi > 0 && lo < Infinity ? { lo: lo / 1.25, hi: hi * 1.25, ticks: logTicks(lo / 1.25, hi * 1.25) } : null
  return { run: run.id, searches: searches.length, search: s < 0 ? 0 : s, orders, winner, legend: [...legendBy.values()].sort((a, b) => a.slot - b.slot), axis, steps }
}

// ---- finding the run -----------------------------------------------------------------------------------------------------------------------------

/** The id of the run node that holds `line`, from the chain of outline nodes holding it (data/optindex.ts `pathOf`); '' when the line is in no run. */
export function runIdOf(path: readonly { id: string; kind: string }[]): string {
  for (let i = path.length - 1; i >= 0; i--) if (path[i].kind === 'run') return path[i].id
  return ''
}

/** The label of a run in the picker and the table: "Run 3 of 9 · SEL$1BA63A14 (#1)". */
export const runLabel = (r: Pick<OptRun, 'n' | 'of' | 'qb' | 'qbn'>): string => `Run ${r.n} of ${r.of} · ${r.qb} (#${r.qbn})`
