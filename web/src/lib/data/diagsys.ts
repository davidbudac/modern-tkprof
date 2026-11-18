// What the system state, hang analysis and deadlock readings compute from their answers (docs/PLAN-DIAG.md § The readings): the process table of a system state
// (sorted, with the idle background processes hidden and never a blocked or blocking session), the blocker forest and the chains of a hang analysis as the same
// tree of session cards (the final blocker on top), and the cycle of a deadlock laid out as a ring. Plain functions: the views draw what these return.
import { toggleSort, sortRows, type Sort } from './diagheap'
import type { Deadlock, DeadlockEdge, DeadlockSession, HangChain, HangSession, SysProc, SysState, SysTreeNode } from './diagreadings'

// ---- the process table ------------------------------------------------------------------------------------------------------------------------------

export type ProcCol = 'pid' | 'name' | 'ospid' | 'session' | 'event' | 'wait' | 'blockedBy'

/** The first number of an ospid as printed ("2188", "2299_2300" for a thread of a multithreaded process). */
export const ospidNum = (o: string | undefined): number | undefined => {
  const m = o ? /^\d+/.exec(o) : null
  return m ? Number(m[0]) : undefined
}

const sessionNum = (sid: number, serial: number): number => sid * 1e8 + serial

/** What each column sorts by: a number or a string; undefined (no ospid, no session, no wait) comes last whichever way it is sorted. */
export const PROC_SORT: Readonly<Record<ProcCol, (p: SysProc) => number | string | undefined>> = {
  pid: (p) => p.pid,
  name: (p) => p.name,
  ospid: (p) => ospidNum(p.ospid),
  session: (p) => (p.session ? sessionNum(p.sid, p.serial) : undefined),
  event: (p) => p.event || undefined,
  wait: (p) => p.waitSec,
  blockedBy: (p) => (p.blockedBy.length > 0 ? sessionNum(p.blockedBy[0].sid, p.blockedBy[0].serial) : undefined),
}

/** A column starts descending for the numbers that mean "more is worse" (time in wait) and ascending for the rest. */
export const PROC_FIRST: Readonly<Record<ProcCol, 1 | -1>> = { pid: 1, name: 1, ospid: 1, session: 1, event: 1, wait: -1, blockedBy: 1 }

export const initProcSort = (): Sort => ({ col: 'pid', dir: 1 })
export const nextProcSort = (s: Sort, col: string): Sort => toggleSort(s, col, PROC_FIRST[col as ProcCol] ?? 1)

/** The sessions of the blocker tree ("sid.serial" of every node, listed ones only). */
export function treeKeys(tree: readonly SysTreeNode[]): Set<string> {
  return new Set(flattenTree(tree, (n) => n.children).map((f) => f.node.session))
}

/**
 * A process that is part of a blocking relation: blocked, blocking, named in a blocker line or a node of the tree. Such a row is never hidden, whatever the switch
 * says and however idle its event is (owner's decision, 2026-11-18).
 */
export function inChain(p: SysProc, inTree: ReadonlySet<string>): boolean {
  return p.blocked || p.blocks > 0 || p.blockedBy.length > 0 || !!p.finalBlocker || (!!p.session && inTree.has(p.session))
}

/** Whether the default view hides the row: an idle background process that is in no blocking relation. */
export const hiddenByDefault = (p: SysProc, inTree: ReadonlySet<string>): boolean => p.idle && p.background && !inChain(p, inTree)

export interface ProcView {
  rows: SysProc[]
  /** the idle background processes left out (0 when the switch shows them) */
  hidden: number
  /** the idle background processes there are (listed rows only) */
  idleBackground: number
  /** the rows of the table that are in a blocking relation (the left rule) */
  chain: Set<number>
}

/** The rows of the process table: the listed processes, the hidden ones left out unless `showIdle`, sorted. */
export function procView(r: Pick<SysState, 'processes' | 'tree'>, showIdle: boolean, sort: Sort): ProcView {
  const inTree = treeKeys(r.tree)
  const idleBg = r.processes.filter((p) => hiddenByDefault(p, inTree))
  const rows = showIdle ? r.processes : r.processes.filter((p) => !hiddenByDefault(p, inTree))
  const chain = new Set<number>()
  for (const p of r.processes) if (inChain(p, inTree)) chain.add(p.pid)
  return { rows: sortRows(rows, sort, PROC_SORT), hidden: showIdle ? 0 : idleBg.length, idleBackground: idleBg.length, chain }
}

// ---- trees of session cards ----------------------------------------------------------------------------------------------------------------------------

/** What a session card says. */
export interface BlockCard {
  /** "sid.serial" */
  key: string
  user?: string
  /** module / action */
  where?: string
  tag?: 'final' | 'cycle' | 'foreign' | 'victim'
  /** the card says nothing about a wait (a deadlock's sessions hold and wait on resources, they are not in an event) */
  noWait?: boolean
  event?: string
  inWait?: boolean
  waitSec?: number
  blocks?: number
  alsoBlockedBy?: string[]
  sqlId?: string
  sqlText?: string
  sqlHandle?: string
  cmd?: string
  procNode?: string
  procPid?: number
  line?: number
}

export interface BlockTree<R> { card: BlockCard; ref: R; children: BlockTree<R>[] }

/** A forest in depth-first order with each node's depth and parent (the tests and the counts; the views recurse). */
export function flattenTree<T>(forest: readonly T[], kids: (n: T) => readonly T[]): { node: T; depth: number; parent?: T }[] {
  const out: { node: T; depth: number; parent?: T }[] = []
  const go = (n: T, depth: number, parent?: T) => {
    out.push({ node: n, depth, parent })
    for (const c of kids(n)) go(c, depth + 1, n)
  }
  for (const n of forest) go(n, 0)
  return out
}

const whereOf = (module?: string, action?: string): string | undefined => {
  const w = [module, action].filter(Boolean).join(' / ')
  return w || undefined
}

/** The blocker forest of a system state as cards: the roots are the final blockers; a statement known only by its library handle gets the handle from the process table. */
export function sysForest(r: Pick<SysState, 'tree' | 'processes'>): BlockTree<SysTreeNode>[] {
  const bySession = new Map<string, SysProc>()
  for (const p of r.processes) if (p.session && !bySession.has(p.session)) bySession.set(p.session, p)
  const go = (n: SysTreeNode, root: boolean): BlockTree<SysTreeNode> => {
    const p = bySession.get(n.session)
    const card: BlockCard = {
      key: n.session,
      user: n.user,
      where: whereOf(n.module, n.action),
      tag: n.foreign ? 'foreign' : n.cycle ? 'cycle' : root && n.children.length > 0 ? 'final' : undefined,
      event: n.event,
      inWait: n.inWait,
      waitSec: n.waitSec,
      blocks: n.blocks,
      alsoBlockedBy: n.alsoBlockedBy,
      sqlId: n.sqlId,
      sqlText: n.sqlText,
      sqlHandle: p?.sqlHandle,
      cmd: n.cmd,
      procNode: n.node,
      procPid: n.pid,
      line: n.line,
    }
    return { card, ref: n, children: n.children.map((c) => go(c, false)) }
  }
  return r.tree.map((n) => go(n, true))
}

/** The module as a hang analysis prints it, without the client's " (TNS V1-V3)" it is followed by; the rest is as printed (the dump joins the module with what follows it). */
export const hangModule = (m: string | undefined): string | undefined => (m ? m.replace(/ \(TNS [^)]*\)$/, '') : undefined)

/** The high 32 bits of a sql_id as the dump prints them, in hex ("3373088609" is 0xc90d3f61). */
export const hex32 = (n: number): string => `0x${n.toString(16).padStart(8, '0')}`

/**
 * A chain of a hang analysis as a tree of cards with the head on top: the dump prints the waiter first and each next session is the one that blocks the one before,
 * so the last session of the chain is the root and each earlier one is its child. Where the reading lists only the first sessions of a very long chain, the head is
 * not among them and nothing is tagged final.
 */
export function chainTree(c: Pick<HangChain, 'sessions' | 'sessionsTotal'>): BlockTree<HangSession> | undefined {
  const ss = c.sessions
  if (ss.length === 0) return undefined
  const whole = c.sessionsTotal <= ss.length
  let tree: BlockTree<HangSession> | undefined
  for (let i = 0; i < ss.length; i++) {
    const s = ss[i]
    const card: BlockCard = {
      key: s.key,
      where: [s.pdb, hangModule(s.module)].filter(Boolean).join(' · ') || undefined,
      tag: whole && i === ss.length - 1 && ss.length > 1 ? 'final' : undefined,
      event: s.waiting ? s.event : undefined,
      inWait: s.waiting,
      waitSec: s.timeInWaitSec,
      blocks: s.blocking,
      sqlText: s.sqlText,
      line: s.line,
    }
    tree = { card, ref: s, children: tree ? [tree] : [] }
  }
  return tree
}

// ---- the cycle of a deadlock ----------------------------------------------------------------------------------------------------------------------------

export interface CycleItem {
  key: string
  /** the session that wrote the trace */
  victim: boolean
  /** the session's block of "Information for waiting sessions", when the dump has one */
  session?: DeadlockSession
  /** the edge from this session to the next: it waits for `resource`, which the next one holds; absent for the last of an open chain */
  out?: DeadlockEdge
  /** the key of the session the edge leads to */
  to?: string
}

export interface CycleLayout {
  closed: boolean
  items: CycleItem[]
  /** `row`: the sessions side by side with the arrows between and the way back under them; `stack`: one under the other (more than three, or too narrow) */
  mode: 'row' | 'stack'
}

/** How many sessions are drawn in a row; more than that are stacked. */
export const RING_ROW_MAX = 3

/** The sessions of the cycle in the order of the edges (each waits for the next, the last for the first), with the edge each draws and the session block it has. */
export function cycleLayout(d: Pick<Deadlock, 'cycle' | 'sessions' | 'victim'>): CycleLayout {
  const byKey = new Map(d.sessions.map((s) => [s.key, s] as const))
  const edgeOf = new Map(d.cycle.edges.map((e) => [e.waiter, e] as const))
  const items: CycleItem[] = d.cycle.sessions.map((key, i, all) => {
    const out = edgeOf.get(key)
    const next = all[i + 1] ?? (d.cycle.closed ? all[0] : undefined)
    return { key, victim: d.victim?.session === key, session: byKey.get(key), ...(out && next ? { out, to: next } : null) }
  })
  return { closed: d.cycle.closed, items, mode: items.length <= RING_ROW_MAX ? 'row' : 'stack' }
}

/** What a session of the deadlock waits for: the edge where it is the waiter (the resource and the mode), and the one it holds, from its own block or the edge that names it as blocker. */
export function sessionRoles(d: Pick<Deadlock, 'cycle' | 'graph'>, s: Pick<DeadlockSession, 'key' | 'heldResource'>): { waitsFor?: { resource: string; mode?: string }; heldBy?: string; holds?: string } {
  const e = d.cycle.edges.find((x) => x.waiter === s.key)
  const row = d.graph.rows.find((r) => r.waiter.key === s.key)
  const holder = d.cycle.edges.find((x) => x.resource === (e?.resource ?? row?.resource))?.blocker
  return {
    waitsFor: e ? { resource: e.resource, mode: e.mode } : row ? { resource: row.resource, mode: row.waiter.waits } : undefined,
    heldBy: holder,
    holds: s.heldResource ?? d.cycle.edges.find((x) => x.blocker === s.key)?.resource,
  }
}
