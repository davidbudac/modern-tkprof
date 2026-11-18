import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { memoryDiagSource, type DiagFile, type DiagSource } from '../../../data/diag'
import { HAS_STACK_FIXTURE, loadStackFixtures, type StackFixture } from '../../../data/diagstackfixture'
import { OptLinksContext, type OptLinks } from '../../../shell/optlinks'
import { CallStackView, initCallStackUi } from './callstack'
import { initProcUi, ProcStateView } from './procstate'
import { readingUiOf } from '../../../data/diagheap'
import { readingView } from './index'

const file: DiagFile = { name: 'd.trc', lines: 40000, release: '', version: '19.27.0.0.0', tested: true, records10046: 0, sections: [], unplaced: 0, outline: [], outlineTotal: 0 }
const sourceWith = (text: boolean): DiagSource => memoryDiagSource(file, {}, text ? ['x'] : null)

function draw(View: typeof CallStackView, f: StackFixture, source: DiagSource = sourceWith(true), links?: OptLinks): string {
  const el = createElement(View, { node: f.node, reading: f.reading, source, goLine: () => {}, selectNode: () => {} })
  return renderToStaticMarkup(links ? createElement(OptLinksContext.Provider, { value: links }, el) : el)
}
const count = (h: string, re: RegExp) => (h.match(re) ?? []).length
const lnk = (n: number) => new RegExp(`<button type="button" class="rd-lnk"[^>]*>${n.toLocaleString('en-US')}</button>`)

describe.skipIf(!HAS_STACK_FIXTURE)('the call stack reading, from the engine\'s answers', () => {
  const fx = loadStackFixtures()

  it('is registered for the kinds callstack and procstate', () => {
    expect(readingView('callstack')).toBe(CallStackView)
    expect(readingView('procstate')).toBe(ProcStateView)
  })

  describe('a dump taken on request (diag_errorstack_l2)', () => {
    const f = fx.errorstack
    const h = draw(CallStackView, f)

    it('has the header: the kind of dump, its level, the start line as a link, the frames', () => {
      expect(h).toContain('>Call stack</h3>')
      expect(h).toContain('diagnostic dump, level 2')
      expect(h).toMatch(/line 32<\/button>/)
      expect(h).toContain('44 frames')
    })

    it('says in a plain sentence that the dump names no error, and keeps the error barrier quiet', () => {
      expect(h).toContain('The dump names no error')
      expect(h).toContain('It was taken on request (level 2), not on an error.')
      expect(h).toContain('class="rd-note rd-mono"')
      expect(h).toContain('&lt;error barrier&gt; at 0x7ffc237922d0 placed dbkda.c@298')
      expect(h).not.toContain('ORA-00')
    })

    it('has the statement with its sql_id, the line of its title and the text in a code block', () => {
      expect(h).toContain('Current SQL Statement for this session')
      expect(h).toContain('<span class="rd-mono rd-strong">86trfcf9m9n9f</span>')
      expect(h).toContain("<pre class=\"rd-code\">alter session set events &#x27;immediate trace name errorstack level 2&#x27;</pre>")
      expect(h).toMatch(lnk(35).source.replace('>35<', '>line 35<') ? /line 35<\/button>/ : /x/)
    })

    it('has the PL/SQL call stack as a table: object, line, handle and the line of its row', () => {
      expect(h).toContain('PL/SQL call stack')
      expect(h).toContain('procedure MTK.MTK_DIAG_INNER')
      expect(h).toContain('<td class="mono dim">0x7b3c9620</td>')
      expect(h).toMatch(lnk(46))
    })

    it('has the stack as one line without the dump\'s own frames, the Copy button, the checkbox and the frame count', () => {
      expect(h).toContain('The stack as one line')
      expect(h).toContain('kkyase()+15725&lt;-<wbr/>kksExecuteCommand()+10100')
      expect(h).not.toContain('ksedst1()+95&lt;')
      expect(h).toContain('>Copy</button>')
      expect(h).toContain('include the dump&#x27;s own frames')
      expect(h).toMatch(/<input type="checkbox"\/> include|<input type="checkbox"[^>]*\/> include/)
      expect(h).toContain('34 frames')
    })

    it('includes the dump\'s own frames in the line when asked (the kept state), 44 frames', () => {
      const s = sourceWith(true)
      readingUiOf(s).set(f.node.id, { ...initCallStackUi(), incOwn: true })
      const d = draw(CallStackView, f, s)
      expect(d).toContain('ksedst1()+95&lt;-<wbr/>')
      expect(d).toContain('44 frames')
      expect(d).toMatch(/<input type="checkbox" checked=""/)
    })

    it('folds the dump\'s own frames into one row that opens, then the process\'s frames innermost first, with offset, component and line', () => {
      expect(h).toContain('<b>10</b> frames of the dump itself')
      expect(h).toContain('ksedst1 … dbkdParseCmd')
      expect(h).toContain('aria-expanded="false"')
      expect(count(h, /<td class="num dim">\d+<\/td><td class="mono fn wrap">/g)).toBe(34)
      expect(h).toContain('>kkyase</td>'.replace('</td>', '<span class="rd-dim">()</span></td>') ? 'kkyase<span class="rd-dim">()</span>' : '')
      expect(h).toContain('+15,725')
      expect(h).toContain('from the binary stack dump&#x27;s frame headers')
      const s = sourceWith(true)
      readingUiOf(s).set(f.node.id, { ...initCallStackUi(), ownOpen: true })
      const open = draw(CallStackView, f, s)
      expect(count(open, /<td class="mono fn wrap">/g)).toBe(44)
      expect(open).toContain('aria-expanded="true"')
      expect(open).toContain('class="rd-own"')
    })

    it('lists the open cursors with sql_id, statement and bind count, and the binds of one that was opened: position, type, value as printed, line', () => {
      expect(h).toContain('Open cursors')
      expect(h).toContain('9zg9qd9bm4spu')
      expect(h).toContain('begin mtk_diag_outer(:ev, :cid); end;')
      const s = sourceWith(true)
      const cu = (f.reading as unknown as { cursors: { sqlId: string; from: number }[] }).cursors.find((c) => c.sqlId === 'f3j90cdzgg7d2')!
      readingUiOf(s).set(f.node.id, { ...initCallStackUi(), open: [String(cu.from)] })
      const d = draw(CallStackView, f, s)
      expect(d).toContain('<td class="mono dim">VARCHAR2<span class="rd-dim"> · avl 66</span></td>')
      expect(d).toContain('&quot;alter session set events &#x27;immediate trace name errorstack level 2&#x27;&quot;')
      expect(d).toMatch(lnk(7762))
    })

    it('links the nested process state by node', () => {
      expect(h).toContain('Dumps inside this one')
      expect(h).toContain('>Process state</button>')
      expect(h).toContain('process state · lines 5,046–8,732')
    })

    it('has no links into the text where the report has none (the numbers only)', () => {
      const d = draw(CallStackView, f, sourceWith(false))
      expect(d).toContain('class="rd-lnk off"')
      expect(d).not.toContain('<button type="button" class="rd-lnk"')
    })
  })

  describe('a dump written on an error (the diagnostic dump of diag_in_10046: ORA-00942)', () => {
    const h = draw(CallStackView, fx.in10046)
    it('names the signal the dump ends with, and no problem key', () => {
      expect(h).toContain('about to signal <span class="rd-mono rd-strong">ORA-00942</span>, name <span class="rd-mono">MTK_NO_SUCH_TABLE</span>')
      expect(h).toMatch(lnk(29752))
      expect(h).not.toContain('The dump names no error')
      expect(h).not.toContain('problem key')
    })
    it('has the statement that failed, and no PL/SQL stack', () => {
      expect(h).toContain('faaxujvpx61wd')
      expect(h).toContain('mtk_no_such_table')
      expect(h).not.toContain('PL/SQL call stack')
    })
    it('shows the "10046" link back on the statement when the shell offers one, and not otherwise', () => {
      expect(h).not.toContain('rd-10046')
      const links: OptLinks = { toTrace: { has: (by) => 'sqlId' in by && by.sqlId === 'faaxujvpx61wd', open: () => {} } }
      const d = draw(CallStackView, fx.in10046, sourceWith(true), links)
      expect(d).toContain('class="opt-mark rd-10046"')
      expect(count(d, /rd-10046/g)).toBeGreaterThanOrEqual(1)
    })
  })

  describe('an incident (the ORA-6544 incident file)', () => {
    const f = fx.incident
    const h = draw(CallStackView, f)
    it('names the ORA- lines, the incident and its problem key', () => {
      expect(h).toContain('incident dump, level 3')
      expect(h).toContain('ORA-6544 [pevm_peruws_callback-1] [27102]')
      expect(h).toContain('ORA-27102: out of memory')
      expect(h).toContain('Incident <span class="rd-mono">199651</span>, problem key <span class="rd-mono rd-strong">ORA 6544 [pevm_peruws_callback-1]</span>')
    })
    it('has two error barriers, the anonymous block as PL/SQL stack and "and N more" cursors from the totals', () => {
      expect(count(h, /class="rd-note rd-mono"/g)).toBe(2)
      expect(h).toContain('anonymous block')
      expect(h).toContain('Open cursors')
    })
    it('is the same reading on the "Dump for incident" part', () => {
      const d = draw(CallStackView, fx.incidentDump)
      expect(d).toContain('Incident <span class="rd-mono">199651</span>')
    })
  })

  it('says "and N more" for cursors and binds the reading does not list', () => {
    const r = JSON.parse(JSON.stringify(fx.errorstack.reading)) as { cursorsTotal: number; cursors: { bindCount: number; from: number; binds: unknown[] }[] }
    r.cursorsTotal = r.cursors.length + 7
    r.cursors[1].bindCount = r.cursors[1].binds.length + 5
    const f = { node: fx.errorstack.node, reading: r as never }
    const s = sourceWith(true)
    readingUiOf(s).set(f.node.id, { ...initCallStackUi(), open: [String(r.cursors[1].from)] })
    const d = draw(CallStackView, f, s)
    expect(d).toContain('and 7 more cursors the reading does not list')
    expect(d).toContain('and 5 more binds;')
  })

  it('cuts a long frame list and offers the rest', () => {
    const r = JSON.parse(JSON.stringify(fx.errorstack.reading)) as { frames: { n: number; function: string; line: number; text: string; callee: string }[]; own: number }
    const base = r.frames[r.frames.length - 1]
    for (let i = 0; i < 300; i++) r.frames.push({ ...base, n: base.n + 1 + i })
    const d = draw(CallStackView, { node: fx.errorstack.node, reading: r as never })
    expect(d).toContain('Show 200 more frames')
    expect(d).toContain('120 of 344 shown')
  })
})

describe.skipIf(!HAS_STACK_FIXTURE)('the process reading, from the engine\'s answers', () => {
  const fx = loadStackFixtures()

  describe('the process state nested in diag_errorstack_l2 (a session that is not in wait)', () => {
    const f = fx.errorstackProc
    const h = draw(ProcStateView, f)

    it('has the header: the process and the session, the state objects, the lines, the process and session lines as links', () => {
      expect(h).toContain('Process <span class="rd-mono">6</span> · session <span class="rd-mono">22.14058</span>')
      expect(h).toContain('53 state objects')
      expect(h).toMatch(lnk(5129))
    })

    it('says who: the session, user, container, program, machine, module and action, the process and its OS pids', () => {
      expect(h).toContain('MTK')
      expect(h).toContain('in PDB1')
      expect(h).toContain('sqlplus@ol9-19-dg1.localdomain (TNS V1-V3)')
      expect(h).toContain('on ol9-19-dg1.localdomain')
      expect(h).toContain('mtk_diag_errorstack_l2')
      expect(h).toContain('errorstack_2')
      expect(h).toContain('server OS pid <span class="rd-mono">13806</span>')
      expect(h).toContain('client OS pid 13804')
    })

    it('says what it runs: the command and the top-level call with its sql_id and text; the previous statement is named by its handle', () => {
      expect(h).toContain('PL/SQL EXECUTE')
      expect(h).toContain('<span class="rd-mono rd-strong">f3j90cdzgg7d2</span>')
      expect(h).toContain('begin mtk_diag_outer(:ev, :cid); end;')
      expect(h).toContain('library handle <span class="rd-mono">0x76fa22a8</span>')
    })

    it('says "Not in wait" with when the last wait ended, and has the wait history with its elapsed time', () => {
      expect(h).toContain('<b>Not in wait</b>')
      expect(h).toContain('last wait ended 58.2 ms ago')
      expect(h).toContain('Wait history')
      expect(h).toContain('SQL*Net message from client')
      expect(count(h, /<li><span class="num rd-dim">/g)).toBe(10)
    })

    it('has what it holds by type with the counts and details, the enqueue, the transaction, and the library object locks', () => {
      expect(h).toContain('LIBRARY OBJECT LOCK <span class="rd-dim">(118)</span>')
      expect(h).toContain('<td class="num">39</td>')
      expect(h).toContain('mode N × 30')
      expect(h).toContain('AE-00000086-ED94F66A-00000000-00000000')
      expect(h).toContain('0x0009.007.00005d4e')
      expect(h).toContain('Library object locks (39)')
      expect(h).toContain('PDB1.MTK.MTK_DIAG_INNER')
      expect(h).toContain('and 9 more library object locks')
    })

    it('does not list the process and the session among the held objects', () => {
      expect(h).not.toContain('process <span class="rd-dim">(2)</span>')
      expect(h).not.toContain('session <span class="rd-dim">(4)</span>')
    })
  })

  describe('a process of a system state that blocks a session (diag_sysstate_l1)', () => {
    const f = fx.sysBlocker
    const h = draw(ProcStateView, f)
    it('is in wait for an event, with its parameters and the time so far', () => {
      expect(h).toContain('<b>Waiting for</b> <span class="rd-mono">&#x27;PL/SQL lock timer&#x27;</span>')
      expect(h).toContain('6.003 s so far')
      expect(h).toContain('duration=0x0, =0x0, =0x0')
    })
    it('says whom it blocks: the count, the waiter the dump shows, its event, the row it waits for and how long', () => {
      expect(h).toContain('Blocks <b class="rd-strong">2</b> sessions')
      expect(h).toContain('45.12004')
      expect(h).toContain('waits for <span class="rd-mono">&#x27;enq: TX - row lock contention&#x27;</span>')
      expect(h).toContain('row 5 of block 169,252 in file 12')
      expect(h).toContain('blocked for at least 3 s')
      expect(h).toContain('The dump describes one waiter however many there are.')
    })
    it('names the process by its name when the system state does, and says that this dump prints no child objects of the session', () => {
      expect(h).toContain('Process <span class="rd-mono">6</span> · session <span class="rd-mono">52.41898</span>')
      expect(h).toContain('The dump holds no library object lock of the session on that handle')
    })
  })

  describe('a process that is blocked', () => {
    const f = fx.sysBlocked
    const h = draw(ProcStateView, f)
    it('names its direct blocker and the final blocker', () => {
      expect(h).toContain('Blocked by')
      expect(h).toContain('rd-sess')
      expect(h).toMatch(/final blocker|also the final blocker/)
    })
    it('shows the session as plain text where no process is known, and the "10046" link where the shell has the session', () => {
      const links: OptLinks = { toTrace: { has: (by) => 'session' in by, open: () => {} } }
      const d = draw(ProcStateView, f, sourceWith(true), links)
      expect(count(d, /opt-mark rd-10046/g)).toBeGreaterThanOrEqual(2)
    })
  })

  describe('a PROCESS STATE dump (diag_procstate: row locks)', () => {
    const f = fx.procstate
    const h = draw(ProcStateView, f)
    it('has transactions with their block list and DML locks with the lock mode named', () => {
      expect(h).toContain('Transactions')
      expect(h).toContain('0x0005.016.00005a54')
      expect(h).toContain('Block List')
      expect(h).toContain('2t77xc2qrk3fy')
      expect(h).toContain('DML locks')
      expect(h).toContain('<td class="mono">SX</td>')
      expect(h).toContain('<td class="num">108,609</td>')
    })
  })

  describe('a process state that prints a short stack', () => {
    // no fixture dump prints one in a process (the one of diag_sysstate_l1 is the system state caller's), so the fields are those the Go model gives, on a real reading
    const real = fx.procstate
    const r = { ...(real.reading as object), shortStack: 'ksedsts()+426<-ksdxfstk()+63<-__sighandler()<-read()+19<-ttcpip()+1219', shortStackNoOwn: 'read()+19<-ttcpip()+1219', shortStackOwn: 3, shortStackLine: 12 }
    const f = { node: real.node, reading: r as never }
    it('shows it without the handler\'s frames, with Copy, the checkbox and the count', () => {
      const h = draw(ProcStateView, f)
      expect(h).toContain('Short stack')
      expect(h).toContain('read()+19&lt;-<wbr/>ttcpip()+1219')
      expect(h).not.toContain('ksedsts()')
      expect(h).toContain('include the frames of the handler that took it (3)')
      expect(h).toContain('>Copy</button>')
      expect(h).toContain('2 frames')
    })
    it('shows all of it when asked', () => {
      const s = sourceWith(true)
      readingUiOf(s).set(real.node.id, { ...initProcUi(), incOwn: true })
      const h = draw(ProcStateView, f, s)
      expect(h).toContain('ksedsts()+426&lt;-<wbr/>ksdxfstk()+63')
      expect(h).toContain('5 frames')
    })
  })

  it('a process without a session says so', () => {
    const r = JSON.parse(JSON.stringify(fx.sysBlocker.reading)) as { sessions: unknown[]; sessionsTotal: number }
    r.sessions = []
    r.sessionsTotal = 0
    const d = draw(ProcStateView, { node: fx.sysBlocker.node, reading: r as never })
    expect(d).toContain('This process owns no session object in the dump.')
  })
})
