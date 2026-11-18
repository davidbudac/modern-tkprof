import { describe, expect, it } from 'vitest'
import { normalizeDeadlock, normalizeHang, normalizeSysState, type Deadlock, type SysProc, type SysState, type SysTreeNode } from './diagreadings'
import { chainTree, cycleLayout, flattenTree, hangModule, hex32, hiddenByDefault, initProcSort, inChain, nextProcSort, ospidNum, procView, sessionRoles, sysForest, treeKeys } from './diagsys'
import { HAS_SYS_FIXTURE, loadSysFixtures } from './diagsysfixture'

const proc = (o: Partial<SysProc>): SysProc => ({ pid: 1, name: 'PMON', kind: 'background', sid: 1, serial: 1, session: '1.1', line: 1, idle: true, background: true, blockedBy: [], body: true, inWait: true, blocks: 0, blocked: false, ...o })
const ref = (sid: number, serial: number) => ({ inst: 1, sid, serial, key: `${sid}.${serial}`, line: 1 })
const node = (session: string, children: SysTreeNode[] = [], o: Partial<SysTreeNode> = {}): SysTreeNode => {
  const [sid, serial] = session.split('.').map(Number)
  return { session, sid, serial, inWait: true, blocks: children.length, descendants: children.length, line: 1, children, ...o }
}
const sys = (processes: SysProc[], tree: SysTreeNode[] = []): Pick<SysState, 'processes' | 'tree'> => ({ processes, tree })

describe('the process table', () => {
  const idleBg = (pid: number, o: Partial<SysProc> = {}) => proc({ pid, name: `BG${pid}`, sid: pid, session: `${pid}.1`, ...o })

  it('hides the idle background processes by default and shows them with the switch', () => {
    const r = sys([idleBg(2), idleBg(3), proc({ pid: 6, name: 'USER', kind: 'foreground', background: false, idle: false, sid: 52, session: '52.9' })])
    const v = procView(r, false, initProcSort())
    expect(v.rows.map((p) => p.pid)).toEqual([6])
    expect(v.hidden).toBe(2)
    const all = procView(r, true, initProcSort())
    expect(all.rows.map((p) => p.pid)).toEqual([2, 3, 6])
    expect(all.hidden).toBe(0)
    expect(all.idleBackground).toBe(2)
  })

  it('never hides a blocked or blocking session, however idle its event is', () => {
    const tree = [node('9.1', [node('8.1')])]
    const rows = [
      idleBg(2),
      idleBg(3, { blocks: 2 }),
      idleBg(4, { blocked: true }),
      idleBg(5, { blockedBy: [ref(9, 1)] }),
      idleBg(6, { finalBlocker: ref(9, 1) }),
      idleBg(8, { sid: 8, session: '8.1' }), // in the tree only
      idleBg(7),
    ]
    const v = procView(sys(rows, tree), false, initProcSort())
    expect(v.rows.map((p) => p.pid)).toEqual([3, 4, 5, 6, 8])
    expect(v.hidden).toBe(2)
    expect([...v.chain].sort()).toEqual([3, 4, 5, 6, 8])
    expect(hiddenByDefault(rows[1], new Set())).toBe(false)
    expect(inChain(rows[0], new Set())).toBe(false)
  })

  it('keeps an idle foreground session and a busy background process whatever the switch says', () => {
    const fg = proc({ pid: 8, name: 'USER', kind: 'foreground', background: false, idle: true, session: '21.5' })
    const busy = idleBg(41, { idle: false, event: undefined, cmd: 'SELECT' })
    expect(procView(sys([fg, busy, idleBg(2)]), false, initProcSort()).rows.map((p) => p.pid)).toEqual([8, 41])
  })

  it('sorts by each column, the missing ones last either way, ties in the order of the summary', () => {
    const rows = [
      proc({ pid: 1, name: 'PSEUDO', kind: 'pseudo', background: false, ospid: undefined, session: undefined, sid: 0, serial: 0, waitSec: undefined, idle: false }),
      proc({ pid: 2, name: 'PMON', ospid: '2188', session: '1.13443', sid: 1, serial: 13443, event: 'pmon timer', waitSec: 0.5, idle: false }),
      proc({ pid: 10, name: 'GEN1', ospid: '2299_2300', session: '5.2712', sid: 5, serial: 2712, event: 'rdbms ipc message', waitSec: 3, idle: false }),
      proc({ pid: 6, name: 'USER', ospid: '13945', session: '52.41898', sid: 52, serial: 41898, event: 'PL/SQL lock timer', waitSec: 7.6, idle: false, blockedBy: [ref(45, 12004)] }),
    ]
    const by = (col: string, dir: 1 | -1) => procView(sys(rows), true, { col, dir }).rows.map((p) => p.pid)
    expect(by('pid', 1)).toEqual([1, 2, 6, 10])
    expect(by('pid', -1)).toEqual([10, 6, 2, 1])
    expect(by('name', 1)).toEqual([10, 2, 1, 6])
    expect(by('ospid', 1)).toEqual([2, 10, 6, 1])
    expect(by('ospid', -1)).toEqual([6, 10, 2, 1])
    expect(by('session', 1)).toEqual([2, 10, 6, 1])
    expect(by('event', 1)).toEqual([6, 2, 10, 1])
    expect(by('wait', -1)).toEqual([6, 10, 2, 1])
    expect(by('wait', 1)).toEqual([2, 10, 6, 1])
    expect(by('blockedBy', 1)).toEqual([6, 1, 2, 10])
  })

  it('starts a column in the way that makes sense and flips it on the second click', () => {
    let s = initProcSort()
    expect(s).toEqual({ col: 'pid', dir: 1 })
    s = nextProcSort(s, 'wait')
    expect(s).toEqual({ col: 'wait', dir: -1 })
    s = nextProcSort(s, 'wait')
    expect(s).toEqual({ col: 'wait', dir: 1 })
    expect(nextProcSort(s, 'name')).toEqual({ col: 'name', dir: 1 })
    expect(nextProcSort(initProcSort(), 'pid')).toEqual({ col: 'pid', dir: -1 })
  })

  it('reads the first number of an ospid, also of a thread of a multithreaded process', () => {
    expect(ospidNum('2188')).toBe(2188)
    expect(ospidNum('2299_2300')).toBe(2299)
    expect(ospidNum(undefined)).toBeUndefined()
    expect(ospidNum('')).toBeUndefined()
  })
})

describe('the blocker forest', () => {
  it('is flattened depth first with each node\'s depth and parent', () => {
    const forest = [node('1.1', [node('2.1', [node('4.1')]), node('3.1')]), node('9.1')]
    const flat = flattenTree(forest, (n) => n.children)
    expect(flat.map((f) => [f.node.session, f.depth, f.parent?.session])).toEqual([['1.1', 0, undefined], ['2.1', 1, '1.1'], ['4.1', 2, '2.1'], ['3.1', 1, '1.1'], ['9.1', 0, undefined]])
    expect([...treeKeys(forest)].sort()).toEqual(['1.1', '2.1', '3.1', '4.1', '9.1'])
    expect(flattenTree([], (n: SysTreeNode) => n.children)).toEqual([])
  })

  it('tags the final blocker of a tree, a session the dump does not have and a cut cycle, and nothing else', () => {
    const forest = sysForest(sys([], [
      node('1.1', [node('2.1', [], { foreign: true })]),
      node('5.1', [node('6.1')], { cycle: true }),
      node('7.1'),
    ]))
    expect(forest[0].card.tag).toBe('final')
    expect(forest[0].children[0].card.tag).toBe('foreign')
    expect(forest[1].card.tag).toBe('cycle')
    expect(forest[1].children[0].card.tag).toBeUndefined()
    expect(forest[2].card.tag).toBeUndefined() // a lone root blocks nobody: not a final blocker
  })

  it('puts the module and the action in the card and the handle of a level that prints no text', () => {
    const f = sysForest(sys([proc({ pid: 6, session: '52.9', sqlHandle: '0x797b5b90' })], [node('52.9', [], { user: 'MTK', module: 'm', action: 'a', pid: 6, node: 'p6' })]))
    expect(f[0].card).toMatchObject({ key: '52.9', user: 'MTK', where: 'm / a', sqlHandle: '0x797b5b90', procNode: 'p6', procPid: 6 })
  })
})

describe('a chain of a hang analysis', () => {
  const s = (key: string) => ({ key, line: 10, waiting: true, event: 'e', timeInWaitSec: 1, params: [], history: [], historyTotal: 0, position: 1, from: 1, to: 2, sid: 1, serial: 1 }) as never
  it('is drawn with the last session the dump prints, the head, on top and each earlier one below the one it waits for', () => {
    const t = chainTree({ sessions: [s('255.1'), s('52.1'), s('61.1')], sessionsTotal: 3 })!
    expect(t.card.key).toBe('61.1')
    expect(t.card.tag).toBe('final')
    expect(t.children[0].card.key).toBe('52.1')
    expect(t.children[0].card.tag).toBeUndefined()
    expect(t.children[0].children[0].card.key).toBe('255.1')
    expect(t.children[0].children[0].children).toEqual([])
    expect(flattenTree([t], (n) => n.children).map((f) => f.depth)).toEqual([0, 1, 2])
  })

  it('tags nothing for a chain of one session, nor for a long chain the reading lists the beginning of (its head is not there)', () => {
    expect(chainTree({ sessions: [s('3.1')], sessionsTotal: 1 })!.card.tag).toBeUndefined()
    expect(chainTree({ sessions: [s('3.1'), s('4.1')], sessionsTotal: 150 })!.card.tag).toBeUndefined()
    expect(chainTree({ sessions: [], sessionsTotal: 0 })).toBeUndefined()
  })

  it('says a session that waits for nothing is not in a wait, and strips the client\'s TNS from the module only', () => {
    const t = chainTree({ sessions: [{ ...(s('1.1') as object), waiting: false, event: undefined, pdb: 'PDB1', module: 'DBMS_SCHEDULERstack_l1aldomain (TNS V1-V3)' } as never], sessionsTotal: 1 })!
    expect(t.card.event).toBeUndefined()
    expect(t.card.inWait).toBe(false)
    expect(t.card.where).toBe('PDB1 · DBMS_SCHEDULERstack_l1aldomain')
    expect(hangModule('mtk_diag_chain-dg1.localdomain (TNS V1-V3)')).toBe('mtk_diag_chain-dg1.localdomain')
    expect(hangModule(undefined)).toBeUndefined()
  })

  it('shows the number of "current sql_id" in hex as the high half it is', () => {
    expect(hex32(3373088609)).toBe('0xc90d3f61')
    expect(hex32(2279214261)).toBe('0x87da0cb5')
    expect(hex32(5)).toBe('0x00000005')
  })
})

describe('the cycle of a deadlock', () => {
  const edge = (waiter: string, blocker: string, resource: string) => ({ waiter, blocker, resource, mode: 'X', line: 1 })
  const dl = (sessions: string[], closed = true, victim?: string): Pick<Deadlock, 'cycle' | 'sessions' | 'victim'> => ({
    cycle: { closed, sessions, edges: sessions.map((s, i) => edge(s, sessions[(i + 1) % sessions.length], `TX-${i}`)).slice(0, closed ? sessions.length : sessions.length - 1) },
    sessions: sessions.map((key) => ({ key, line: 1, from: 1, to: 2, number: 1, sid: 1, serial: 1, inGraph: true })),
    victim: victim ? { session: victim, line: 1, inGraph: true } : undefined,
  })

  it('draws two sessions in a row, each with the edge to the next and the last back to the first', () => {
    const l = cycleLayout(dl(['255.1', '61.1'], true, '255.1'))
    expect(l.mode).toBe('row')
    expect(l.closed).toBe(true)
    expect(l.items.map((i) => [i.key, i.victim, i.to, i.out?.resource])).toEqual([['255.1', true, '61.1', 'TX-0'], ['61.1', false, '255.1', 'TX-1']])
    expect(l.items[0].session?.key).toBe('255.1')
  })

  it('stacks a cycle of more than three sessions', () => {
    expect(cycleLayout(dl(['1.1', '2.1', '3.1'])).mode).toBe('row')
    const l = cycleLayout(dl(['1.1', '2.1', '3.1', '4.1']))
    expect(l.mode).toBe('stack')
    expect(l.items[3].to).toBe('1.1')
  })

  it('leaves the last session of an open chain without an arrow, and a graph with no cycle without items', () => {
    const l = cycleLayout(dl(['1.1', '2.1', '3.1'], false))
    expect(l.closed).toBe(false)
    expect(l.items.map((i) => i.to)).toEqual(['2.1', '3.1', undefined])
    expect(cycleLayout({ cycle: { closed: false, sessions: [], edges: [] }, sessions: [], victim: undefined }).items).toEqual([])
  })

  it('knows what a session holds and waits for, and who holds that', () => {
    const d = dl(['255.1', '61.1'])
    const roles = sessionRoles({ cycle: d.cycle, graph: { line: 1, header: [], rows: [], rowsTotal: 0 } }, { key: '255.1', heldResource: 'TX-1' })
    expect(roles).toEqual({ waitsFor: { resource: 'TX-0', mode: 'X' }, heldBy: '61.1', holds: 'TX-1' })
  })
})

describe.skipIf(!HAS_SYS_FIXTURE)('on the engine\'s readings of the lab files', () => {
  const fx = loadSysFixtures()

  it('hides the 73 idle background processes of a system state and keeps the three sessions of the chain', () => {
    const r = normalizeSysState(fx.sysL266.reading)
    expect(r.counts.idleBackground).toBe(73)
    const v = procView(r, false, initProcSort())
    expect(v.hidden).toBe(73)
    expect(v.rows).toHaveLength(r.processes.length - 73)
    expect(v.rows.map((p) => p.session)).toEqual(expect.arrayContaining(['52.41898', '45.12004', '255.62769']))
    expect(v.rows.every((p) => !(p.idle && p.background) || inChain(p, treeKeys(r.tree)))).toBe(true)
    expect(procView(r, true, initProcSort()).rows).toHaveLength(r.processes.length)
  })

  it('draws the blocker tree of level 266 with the statement of each session, and of level 1 with its library handle', () => {
    const f266 = sysForest(normalizeSysState(fx.sysL266.reading))
    expect(f266).toHaveLength(1)
    expect(f266[0].card).toMatchObject({ key: '52.41898', tag: 'final', sqlId: '3rqgu3kzyjz22', event: 'PL/SQL lock timer', blocks: 2 })
    expect(f266[0].children[0].card.key).toBe('45.12004')
    expect(f266[0].children[0].children[0].card.key).toBe('255.62769')
    const f1 = sysForest(normalizeSysState(fx.sysL1.reading))
    expect(f1[0].card.sqlText).toBeUndefined()
    expect(f1[0].card.sqlHandle).toMatch(/^0x[0-9a-f]+$/)
    expect(f1[0].card.cmd).toBe('PL/SQL EXECUTE')
  })

  it('shows a process whose body is in another event than its summary with both', () => {
    const r = normalizeSysState(fx.sysL266.reading)
    const p = r.processes.find((x) => x.bodyEvent)!
    expect(p.pid).toBe(60)
    expect(p.event).toBe('enq: JG - queue lock')
    expect(p.bodyEvent).toBe('rdbms ipc message')
  })

  it('draws the chains of the hang analysis head first', () => {
    const h = normalizeHang(fx.hang.reading)
    const t = chainTree(h.chains[0])!
    expect(t.card.key).toBe('61.26319')
    expect(t.card.tag).toBe('final')
    expect(t.children[0].card.key).toBe('52.55849')
    expect(t.children[0].children[0].card.key).toBe('255.22508')
    expect(chainTree(h.chains[1])!.card.tag).toBeUndefined()
    const e = normalizeHang(fx.hangEvent.reading)
    expect(e.chains).toHaveLength(3)
  })

  it('lays out the deadlock\'s cycle from the victim', () => {
    const d = normalizeDeadlock(fx.deadlock.reading)
    const l = cycleLayout(d)
    expect(l.items.map((i) => i.key)).toEqual(['255.52110', '61.27430'])
    expect(l.items[0]).toMatchObject({ victim: true, to: '61.27430' })
    expect(l.items[0].out?.resource).toBe('TX-00080010-000057D7-ED94F66A-00000000')
    expect(l.items[1].out?.resource).toBe('TX-000A0009-00004D46-ED94F66A-00000000')
  })
})
