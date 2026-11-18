import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { memoryDiagSource, type DiagFile, type DiagSource } from '../../../data/diag'
import { readingUiOf } from '../../../data/diagheap'
import { normalizeSysState } from '../../../data/diagreadings'
import { HAS_SYS_FIXTURE, loadSysFixtures, type SysFixture } from '../../../data/diagsysfixture'
import type { DiagKey } from '../../../data/diagmarks'
import { OptLinksContext, type OptLinks } from '../../../shell/optlinks'
import { DeadlockView } from './deadlock'
import { HangView, initHangUi } from './hang'
import { initSysUi, SHOW_IDLE_KEY, SysStateView } from './sysstate'
import { readingView } from './index'

const file: DiagFile = { name: 'd.trc', lines: 90000, release: '', version: '19.27.0.0.0', tested: true, records10046: 0, sections: [], unplaced: 0, outline: [], outlineTotal: 0 }
const sourceWith = (text: boolean): DiagSource => memoryDiagSource(file, {}, text ? ['x'] : null)
/** The standalone report's kind of source: the engine's views can open any node, this one only those it holds. */
const digestSource = (): DiagSource => ({ ...sourceWith(false), digest: true, preloaded: new Map() })

function draw(View: typeof SysStateView, f: Pick<SysFixture, 'node'> & { reading: unknown }, source: DiagSource = sourceWith(true), links?: OptLinks): string {
  const el = createElement(View, { node: f.node, reading: f.reading as never, source, goLine: () => {}, selectNode: () => {} })
  return renderToStaticMarkup(links ? createElement(OptLinksContext.Provider, { value: links }, el) : el)
}
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length
const rows = (h: string) => count(h.slice(h.indexOf('<tbody>')), /<tr[ >]/g)
const lnk = (text: string) => new RegExp(`<button type="button" class="rd-lnk"[^>]*>${text}</button>`)

/** localStorage for the switch of the idle background processes, which the component keeps there. */
function stubStorage(v: Record<string, string>) {
  vi.stubGlobal('localStorage', { getItem: (k: string) => v[k] ?? null, setItem: () => {}, removeItem: () => {} })
}
afterEach(() => { vi.unstubAllGlobals() })

describe.skipIf(!HAS_SYS_FIXTURE)('the system state reading, from the engine\'s answers', () => {
  const fx = loadSysFixtures()

  it('is registered for the kinds sysstate, hang and deadlock', () => {
    expect(readingView('sysstate')).toBe(SysStateView)
    expect(readingView('hang')).toBe(HangView)
    expect(readingView('deadlock')).toBe(DeadlockView)
  })

  describe('level 266 (diag_sysstate_l266)', () => {
    const f = fx.sysL266
    const h = draw(SysStateView, f)

    it('has the header: the level, the oradebug command and the line of each, who wrote it, the caller\'s stack as a quiet line', () => {
      expect(h).toContain('>System state</h3>')
      expect(h).toContain('(level=10, with short stacks)')
      expect(h).toContain('85 processes')
      expect(h).toMatch(/line <button[^>]*>40<\/button>/)
      expect(h).toContain('oradebug dump systemstate 266')
      expect(h).toMatch(lnk('35'))
      expect(h).toContain('written by session')
      expect(h).toContain('61.58038')
      expect(h).toContain('class="rd-caller"')
      expect(h).toContain('Stack of the process that took the dump')
      expect(h).toContain('ksdxdocmdmultex()+5627&lt;-ksdxdocmdmult()+55')
      expect(h).not.toContain('ksedsts()+426&lt;-ksdxfstk()+63&lt;-ksdxdocmdmultex') // without the handler\'s own frames by default
    })

    it('has the blocker tree first, the final blocker on top and each session below the one it waits for, as nested lists of cards', () => {
      expect(h.indexOf('aria-label="Blocker tree"')).toBeLessThan(h.indexOf('aria-label="Processes"'))
      expect(h).toContain('2 sessions are blocked, behind 1 final blocker.')
      const a = h.indexOf('data-session="52.41898"'), b = h.indexOf('data-session="45.12004"'), c = h.indexOf('data-session="255.62769"')
      expect(a).toBeGreaterThan(0)
      expect(a).toBeLessThan(b)
      expect(b).toBeLessThan(c)
      expect(h).toMatch(/<li><div class="bt-n final" data-session="52\.41898">[\s\S]*<ul><li><div class="bt-n" data-session="45\.12004">[\s\S]*<ul><li><div class="bt-n" data-session="255\.62769">/)
      expect(count(h, /class="bt-tag acc"/g)).toBe(1)
      expect(h).toContain('>final blocker</span>')
    })

    it('has on each card the event, the time in wait, how many sessions it blocks, the user, module and action, and the statement with its sql_id', () => {
      expect(h).toContain('MTK · mtk_diag_chain / s1_holds_301')
      expect(h).toContain('waiting for <span class="rd-mono">&#x27;PL/SQL lock timer&#x27;</span><span class="rd-dim"> · 7.632 s</span>')
      expect(h).toContain('blocks 2 sessions')
      expect(h).toContain('blocks 1 session<')
      expect(h).toContain('<span class="rd-mono rd-strong bt-sqlid">3rqgu3kzyjz22</span>')
      expect(h).toContain('BEGIN dbms_session.sleep(30); END;')
      expect(h).toContain('select id from mtk_cust where id = 301 for update wait 60')
      expect(h).toContain('The final blocker is at the top; each session below it is blocked by the one above.')
    })

    it('has links on each card to the process\'s reading and to its line in the text', () => {
      expect(h).toMatch(/<button type="button" class="rd-lnk"[^>]*>process 6<\/button>/)
      expect(h).toMatch(/<button type="button" class="rd-lnk"[^>]*>process 68<\/button>/)
      expect(h).toMatch(/<button type="button" class="rd-lnk"[^>]*>line 3,822<\/button>/)
    })

    it('has the process table with the idle background processes hidden: 12 of 85 rows, how many are hidden and the switch', () => {
      expect(h).toContain('73 idle background processes hidden')
      expect(h).toMatch(/<input type="checkbox"[^>]*\/> show idle background processes/)
      expect(h).not.toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/> show idle background processes/)
      expect(rows(h)).toBe(12 + 1) // + the footer row
      expect(h).toContain('12 of 85 listed processes shown')
      expect(h).toContain('<b>85</b> processes: 8 user, 76 background, 1 pseudo')
      expect(h).toContain('79 idle, 11 with no session')
      expect(h).not.toContain('PMON')
    })

    it('has the columns with the sort on the pid, the numbers right-aligned', () => {
      for (const col of ['Pid', 'Name', 'Ospid', 'Sid.serial', 'Waiting for', 'Time in wait', 'Blocked by']) expect(h).toMatch(new RegExp(`<button type="button">${col}<span`))
      expect(h).toMatch(/aria-sort="ascending"[^>]*><button type="button">Pid/)
      expect(h).toContain('<td class="num">6</td>')
      expect(h).toContain('<td class="num mono">52.41898</td>')
    })

    it('shows the wait class quietly, the time in wait of every process and dims the idle ones', () => {
      expect(h).toContain('SQL*Net message from client<span class="rd-dim cls" title="wait class Idle"> · Idle</span>')
      expect(h).toContain('PL/SQL lock timer<span class="rd-dim cls" title="wait class Idle"> · Idle</span>')
      expect(h).toContain('<td class="num">7.632 s</td>')
      expect(count(h, /<tr class="[^"]*rd-idle/g)).toBeGreaterThan(0)
      expect(h).toMatch(/<tr class="rd-sel rd-chain" tabindex="0" data-pid="6"/) // idle by its event, but the final blocker: not dimmed
    })

    it('marks the rows of the sessions of the tree with a rule and says who blocks whom', () => {
      expect(count(h, /rd-chain/g)).toBe(3)
      expect(h).toMatch(/<tr class="rd-sel rd-chain" tabindex="0" data-pid="68"/)
      expect(h).toContain('<td class="num mono">45.12004</td></tr>')
      expect(h).toContain('<td class="num mono">52.41898</td></tr>')
    })

    it('says a process that moved on between the summary and its body is in another event now', () => {
      expect(h).toContain('enq: JG - queue lock')
      expect(h).toContain('in its body: <span class="rd-mono">rdbms ipc message</span>')
      expect(h).toContain('1 processes wait for another event in their bodies than in the summary')
    })

    it('opens a row as that process\'s reading: the row is a link where the node can be opened', () => {
      expect(count(h, /class="rd-sel/g)).toBe(12)
      expect(h).toContain('title="Show the reading of process 6"')
    })

    it('has the 10046 link on the sessions and the statements, where a SQL trace holds them', () => {
      const links: OptLinks = { toTrace: { has: (by: DiagKey) => ('session' in by ? by.session === '45.12004' : by.sqlId === '3rqgu3kzyjz22'), open: () => {} } } as never
      const m = draw(SysStateView, f, sourceWith(true), links)
      expect(count(m, /class="opt-mark rd-10046"/g)).toBe(3) // the card and the row of the session, the card of the statement
      expect(m).toContain('aria-label="Show session 45.12004 in the SQL trace"')
      expect(m).toContain('aria-label="Show statement 3rqgu3kzyjz22 in the SQL trace"')
      expect(h).not.toContain('rd-10046')
    })
  })

  describe('with the switch on', () => {
    it('shows every process with the idle background ones dimmed, and the count', () => {
      stubStorage({ [SHOW_IDLE_KEY]: 'true' })
      const h = draw(SysStateView, fx.sysL266)
      expect(rows(h)).toBe(85 + 1)
      expect(h).toContain('73 idle background processes shown')
      expect(h).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/> show idle background processes/)
      expect(h).toContain('PMON')
      expect(count(h, /<tr class="[^"]*rd-idle/g)).toBe(78) // the 79 idle ones, but the final blocker, whose event is idle, is part of the tree and not dimmed
      expect(h).toContain('85 of 85 listed processes shown')
    })
  })

  describe('kept sort', () => {
    it('is the one the reading kept for the node: by time in wait descending', () => {
      const s = sourceWith(true)
      readingUiOf(s).set(fx.sysL266.node.id, { ...initSysUi(), sort: { col: 'wait', dir: -1 } })
      const h = draw(SysStateView, fx.sysL266, s)
      expect(h).toMatch(/aria-sort="descending"[^>]*><button type="button">Time in wait/)
      const first = /<tbody><tr[^>]*data-pid="(\d+)"/.exec(h)![1]
      const r = normalizeSysState(fx.sysL266.reading)
      const shown = r.processes.filter((p) => !(p.idle && p.background) || p.blocked || p.blocks > 0)
      const top = [...shown].sort((a, b) => (b.waitSec ?? -1) - (a.waitSec ?? -1))[0]
      expect(Number(first)).toBe(top.pid)
    })
  })

  describe('level 1 (diag_sysstate_l1): a statement is only the address of its library handle', () => {
    const h = draw(SysStateView, fx.sysL1)
    it('says so on the card, with the command', () => {
      expect(h).toContain('oradebug dump systemstate 1')
      expect(h).toContain('(level=1)')
      expect(h).toContain('PL/SQL EXECUTE')
      expect(h).toMatch(/statement at library handle <span class="rd-mono">0x[0-9a-f]+<\/span>; this level prints the handle, not the text/)
      expect(h).toContain('level 1 prints the process and its sessions only')
      expect(h).not.toContain('bt-sqlid')
    })
    it('hides its 73 idle background processes of 82', () => {
      expect(h).toContain('73 idle background processes hidden')
      expect(h).toContain('9 of 82 listed processes shown')
    })
  })

  describe('with nothing blocked', () => {
    it('says so in one sentence and draws no tree', () => {
      const h = draw(SysStateView, { node: fx.sysL1.node, reading: { ...fx.sysL1.reading, tree: [], blocked: 0, roots: 0, treeNodes: 0 } })
      expect(h).toContain('No session is blocked in this dump')
      expect(h).not.toContain('class="bt"')
      expect(h).not.toContain('blocked, behind')
    })
  })

  describe('a foreign session, a cycle and a bounded tree', () => {
    const base = fx.sysL1.reading as unknown as Record<string, unknown>
    const n = (session: string, o: Record<string, unknown> = {}) => ({ session, sid: Number(session.split('.')[0]), serial: Number(session.split('.')[1]), inWait: true, blocks: 0, descendants: 0, line: 5, children: [], ...o })
    const h = draw(SysStateView, { node: fx.sysL1.node, reading: { ...base, treeOmitted: 7, treeNodes: 3, tree: [n('1.1', { blocks: 1, children: [n('9.9', { foreign: true, inst: 2 })] }), n('5.5', { cycle: true, alsoBlockedBy: ['7.7'], blocks: 1, children: [n('6.6')] })] } })
    it('says what each is', () => {
      expect(h).toContain('>not in this dump</span>')
      expect(h).toContain('>blocks itself</span>')
      expect(h).toContain('also blocked by <span class="rd-mono">7.7</span>')
      expect(h).toContain('and 7 more sessions the reading does not list (10 in all).')
      expect(h).toContain('bt-n foreign')
    })
  })

  describe('in the standalone report (no text, a digest of the outline)', () => {
    it('has the line numbers as plain numbers and no link to a process the report does not hold', () => {
      const h = draw(SysStateView, fx.sysL266, digestSource())
      expect(h).toContain('class="rd-lnk off"')
      expect(h).not.toMatch(/<button type="button" class="rd-lnk"[^>]*>process 6<\/button>/)
      expect(h).toContain('The reading of this process is not in this report')
      expect(h).not.toContain('class="rd-sel')
    })
  })
})

describe.skipIf(!HAS_SYS_FIXTURE)('the hang analysis reading, from the engine\'s answers', () => {
  const fx = loadSysFixtures()
  const f = fx.hang
  const h = draw(HangView, f)

  it('has the header facts: level, chains, sessions, who initiated it, the instance', () => {
    expect(h).toContain('>Hang analysis</h3>')
    expect(h).toContain('level 3 · 2 chains · 4 sessions')
    expect(h).toContain('<dt>Initiated by</dt><dd><span class="rd-mono">oradebug</span></dd>')
    expect(h).toContain('cdb1.cdb1')
    expect(h).toContain('oradebug_node_dump_level: 3')
    expect(h).toContain('OS thread scheduling delay history')
  })

  it('lists the chains most likely to have caused the hang with their signatures, hashes and lines', () => {
    expect(h).toContain('Chains most likely to have caused the hang')
    expect(h).toContain('[a] <button')
    expect(h).toContain('&#x27;PL/SQL lock timer&#x27;&lt;=&#x27;enq: TX - row lock contention&#x27;&lt;=&#x27;enq: TX - row lock contention&#x27;')
    expect(h).toContain('0x5e4fa8d6')
    expect(h).toContain('&#x27;Streams AQ: waiting for messages in the queue&#x27;')
    expect(h).toMatch(lnk('56'))
  })

  it('draws chain 1 with the head, the last session the dump prints, on top and labelled, and each waiter under the one it waits for', () => {
    const a = h.indexOf('data-session="61.26319"'), b = h.indexOf('data-session="52.55849"'), c = h.indexOf('data-session="255.22508"')
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(b)
    expect(b).toBeLessThan(c)
    expect(h).toMatch(/<div class="bt-n final" data-session="61\.26319">/)
    expect(count(h, />final blocker</g)).toBe(1)
    expect(h).toContain('In the dump&#x27;s order the waiter comes first: <span class="rd-mono">255.22508</span>, blocked by <span class="rd-mono">52.55849</span>, blocked by <span class="rd-mono">61.26319</span>. The last one is the head of the chain')
    expect(h).toContain('Chain 1')
    expect(h).toContain('listed as [a]')
    expect(h).toContain('non-intersecting chains')
  })

  it('has on each card the event, the time in wait, the timeout, how many it blocks and the statement', () => {
    expect(h).toContain('waiting for <span class="rd-mono">&#x27;enq: TX - row lock contention&#x27;</span><span class="rd-dim"> · 4.029 s</span>')
    expect(h).toContain('times out in 55.97 s')
    expect(h).toContain('blocks 1 session<')
    expect(h).toContain('PDB1 · mtk_diag_chain-dg1.localdomain')
    expect(h).toContain('select id from mtk_cust where id = 302 for update wait 60')
    expect(h).not.toContain('bt-sqlid') // no sql_id: the dump prints a number
  })

  it('shows the "current sql_id" as what it is: the high half of the sql_id, with a tooltip, never as a sql_id', () => {
    expect(h).toContain('<dt title="The dump prints a number here, not the 13-character sql_id')
    expect(h).toContain('<span class="rd-mono">3373088609</span> <span class="rd-mono rd-dim">0xc90d3f61</span>')
    expect(h).toContain('high half of the sql_id, not the sql_id itself')
    expect(h).toContain('so it cannot be matched to the hv= of a SQL trace')
  })

  it('has the details closed on every card, with the parameters, the short stack and the wait history inside', () => {
    expect(count(h, /<details class="bt-more">/g)).toBe(4)
    expect(h).not.toMatch(/<details class="bt-more" open/)
    expect(h).toContain('Wait parameters, short stack and wait history')
    expect(h).toContain('p1: &#x27;name|mode&#x27;=0x54580006')
    expect(h).toContain('semtimedop&lt;-<wbr/>sskgpwwait')
    expect(h).not.toContain('ksedsts&lt;-ksdxfstk&lt;-ksdxcb') // without the handler\'s own frames
    expect(h).toContain('include the frames of the handler that took it (5)')
    expect(h).toContain('SQL*Net message from client')
  })

  it('has "State of ALL nodes" closed, with the blockers resolved to their sessions', () => {
    expect(h).toContain('State of ALL nodes (4)')
    expect(h).not.toMatch(/<details class="rd-details" open/)
    expect(h).toContain('SINGLE_NODE')
    expect(h).toContain('<span title="session 61.26319"> (61.26319)</span>')
  })

  it('has a chain of one session without the label, and the lines as links', () => {
    expect(h).toContain('data-chain="2"')
    expect(h).toContain('DECLARE job BINARY_INTEGER')
    expect(h).toMatch(/lines <button[^>]*>65<\/button>–<button[^>]*>188<\/button>/)
  })

  it('keeps the details a reader opened', () => {
    const s = sourceWith(true)
    readingUiOf(s).set(f.node.id, { ...initHangUi(), open: ['1:52.55849'], nodes: true })
    const o = draw(HangView, f, s)
    expect(count(o, /<details class="bt-more" open/g)).toBe(1)
    expect(o).toMatch(/<details class="rd-details" open/)
  })

  describe('the event form (diag_hang_event): no "initiated by" line, three chains, a process with no statement', () => {
    const e = draw(HangView, fx.hangEvent)
    it('says what it does not print', () => {
      expect(e).toContain('not said (the event form of the dump prints no &quot;analysis initiated by&quot; line)')
      expect(e).toContain('level 3 · 3 chains')
      expect(e).toContain('Redo Transport Attach')
      expect(e).toContain('0: no statement')
      expect(e).toContain('the dump does not say what initiated the analysis')
    })
  })

  describe('a chain whose reading is cut', () => {
    it('does not label a head it does not have', () => {
      const r = JSON.parse(JSON.stringify(f.reading)) as { chains: { sessionsTotal: number }[] }
      r.chains[0].sessionsTotal = 150
      const c = draw(HangView, { node: f.node, reading: r })
      expect(c).not.toContain('>final blocker<')
      expect(c).toContain('the head of the chain, the last one the dump prints, is not among them')
    })
  })
})

describe.skipIf(!HAS_SYS_FIXTURE)('the deadlock reading, from the engine\'s answer for diag_deadlock', () => {
  const fx = loadSysFixtures()
  const f = fx.deadlock
  const h = draw(DeadlockView, f)

  it('has the headline: ORA-00060, its type, the session that wrote the trace', () => {
    expect(h).toContain('Deadlock detected <span class="rd-mono">ORA-00060</span>')
    expect(h).toContain('Transaction Deadlock')
    expect(h).toContain('2 resources in the graph')
    expect(h).toContain('The trace was written by session')
    expect(h).toContain('255.52110')
    expect(h).toContain('the session in which ORA-00060 was raised')
  })

  it('draws the cycle: both sessions as cards, the victim marked, the arrows with the resource and who holds it, the way back', () => {
    expect(h).toContain('aria-label="The cycle"')
    expect(h).toContain('<div class="dl-ring row"')
    expect(h).toMatch(/<div class="bt-n victim" data-session="255\.52110">/)
    expect(h).toMatch(/<div class="bt-n" data-session="61\.27430">/)
    expect(h).toContain('aria-label="255.52110 waits for TX-00080010-000057D7-ED94F66A-00000000, held by 61.27430"')
    expect(h).toContain('aria-label="61.27430 waits for TX-000A0009-00004D46-ED94F66A-00000000, held by 255.52110"')
    expect(h).toContain('class="dl-back"')
    expect(h).toContain('held by 255.52110, the first session of the cycle')
    expect(h).toContain('2 sessions, each waits for a resource the next one holds')
    expect(h).toContain('select id from mtk_cust where id = 202 for update wait 30')
    expect(h).toContain('holds <span class="rd-mono">TX</span>, acquired 5.000 s ago')
    expect(count(h, /class="bt-tag acc"/g)).toBe(2) // in the ring and in the session's block
  })

  it('has the graph as the dump\'s own table: resource, blocker and waiter with process, session, holds, waits and serial', () => {
    expect(h).toContain('>Blocker(s)</th>')
    expect(h).toContain('>Waiter(s)</th>')
    expect(h).toContain('<td class="mono wrap">TX-000A0009-00004D46-ED94F66A-00000000</td><td class="num mono">61</td><td class="num mono">255</td><td class="mono ctr">X</td><td class="mono ctr"></td><td class="num mono">52110</td><td class="num mono">6</td><td class="num mono">61</td><td class="mono ctr"></td><td class="mono ctr">X</td><td class="num mono">27430</td>')
    expect(h).toMatch(lnk('46'))
  })

  it('has each waiting session\'s block: user, container, program, module and action, what it holds and waits for, its SQL', () => {
    expect(h).toContain('<b>Session 255</b>')
    expect(h).toContain('<dt>User</dt><dd>MTK<span class="rd-dim"> · id 165</span></dd>')
    expect(h).toContain('<dt>Container</dt><dd>3/PDB1</dd>')
    expect(h).toContain('sqlplus@ol9-19-dg1.localdomain (TNS V1-V3)')
    expect(h).toContain('mtk_diag_deadlock_a <span class="rd-dim">/</span> a_asks_202')
    expect(h).toContain('<dt>Holds</dt><dd><span class="rd-mono">TX-000A0009-00004D46-ED94F66A-00000000</span><span class="rd-dim"> · acquired 5 seconds ago</span></dd>')
    expect(h).toContain('<dt>Waits for</dt><dd><span class="rd-mono">TX-00080010-000057D7-ED94F66A-00000000</span><span class="rd-dim"> · mode X · held by 61.27430</span></dd>')
    expect(h).toContain('<pre class="rd-code">select id from mtk_cust where id = 201 for update wait 30</pre>')
  })

  it('has the rows waited on, and the link to the diagnostic dump that follows', () => {
    expect(h).toContain('Rows waited on')
    expect(h).toContain('AAAahBAAMAAApUZAAD')
    expect(h).toContain('108,609')
    expect(h).toContain('Diagnostic dump (level 1)')
    expect(h).toContain('>Show its call stack reading</button>')
    expect(draw(DeadlockView, f, digestSource())).toContain('Its reading is not in this report.')
  })

  it('draws a cycle of four sessions stacked, and says an open chain is no cycle', () => {
    const r = JSON.parse(JSON.stringify(f.reading)) as { cycle: { closed: boolean; sessions: string[]; edges: unknown[] } }
    r.cycle = { closed: true, sessions: ['1.1', '2.1', '3.1', '4.1'], edges: ['1.1', '2.1', '3.1', '4.1'].map((w, i, a) => ({ waiter: w, blocker: a[(i + 1) % 4], resource: `TX-${i}`, mode: 'X', line: 46 })) }
    const s = draw(DeadlockView, { node: f.node, reading: r })
    expect(s).toContain('<div class="dl-ring stack"')
    expect(s).toContain('4 sessions, each waits')
    expect(s).toContain('the first session of the cycle')
    r.cycle = { closed: false, sessions: ['1.1', '2.1'], edges: [{ waiter: '1.1', blocker: '2.1', resource: 'TX-0', mode: 'X', line: 46 }] }
    const o = draw(DeadlockView, { node: f.node, reading: r })
    expect(o).toContain('do not close into a cycle')
    expect(o).not.toContain('class="dl-back"')
  })

  it('says when the file has no session marker, so the victim is not known', () => {
    const r = JSON.parse(JSON.stringify(f.reading)) as { victim?: unknown }
    delete r.victim
    const v = draw(DeadlockView, { node: f.node, reading: r })
    expect(v).toContain('so the session that wrote the trace is not known')
    expect(v).not.toContain('>victim<')
  })
})
