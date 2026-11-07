import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { LineKind } from './lines'
import { bindAttrSegs, callParts, describeLine, parseCall, describeMarker, parseStat, planDump, sqlSegs, statementTones, waitMicro, waitRun, waitShare, type Seg } from './readable'

// lines of testdata/traces/19c/io_waits.trc
const trc = readFileSync(new URL('../../../../testdata/traces/19c/io_waits.trc', import.meta.url), 'utf8').split('\n')
/** The pieces' text; a quantity, the event and its object between `|` (each piece apart). */
const piece = (s: Seg) => (typeof s === 'string' ? s : 'q' in s ? (s.n ? `|${s.n} ${s.unit}|` : '') : 'c' in s && (s.c === 'ev' || s.c === 'evobj') ? (s.t ? `|${s.t}|` : '') : s.t)
const text = (segs: Seg[]) => segs.map(piece).join('').replace(/\|+/g, '|').replace(/^\||\|$/g, '')

describe('describeLine', () => {
  it('a call: elapsed, CPU, rows, gets and a hard parse', () => {
    const v = describeLine('PARSE #139745604251096:c=92,e=907,p=0,cr=0,cu=0,mis=1,r=0,dep=0,og=1,plh=3570327658,tim=10804502774', 'call', 87)
    expect(v.label).toBe('PARSE')
    expect(text(v.parts)).toBe('hard parse') // the notes; the CPU is a group of the Detail's slots (`call`)
    expect(v.call?.cpu).toMatchObject({ n: '92', unit: 'µs' })
    expect(v.dur).toBe(907)
    expect(v.bar).toEqual({ us: 907, cpu: 92, role: 'cpu' })
  })
  it('the CPU only where it is not all of the duration (the duration column has that)', () => {
    const close = describeLine('CLOSE #139745604251096:c=2,e=2,dep=0,type=0,tim=10804503000', 'call', 1)
    expect(text(close.parts)).toBe('closed') // type=0; the exact word (hard close) is in the tooltip
    expect(close.call?.cpu).toBeUndefined()
    const fetch = describeLine('FETCH #139745604251096:c=28,e=28,p=0,cr=3,cu=0,mis=0,r=1,dep=0,og=1,plh=3570327658,tim=10804503100', 'call', 1)
    expect(fetch.call?.cpu).toBeUndefined()
    expect(fetch.call?.rows).toMatchObject({ n: '1', unit: 'row' })
    expect(text(fetch.parts)).toBe('')
  })
  it('a wait: its time, event, object and parameters', () => {
    const line = trc.find((l) => l.includes("nam='direct path read' ") && l.includes('obj#=108611'))!
    const v = describeLine(line, 'wait', 1, { objectName: (o) => (o === 108611 ? 'MTK_ORDERS' : undefined), eventOf: () => ({ class: 'User I/O', idle: false, role: 'userio' }) })
    expect(v.label).toBe('WAIT')
    expect(text(v.parts)).toMatch(/^direct path read\|MTK_ORDERS\|file \d+ · block \d+ · \d+ blocks?$/)
    expect(v.bar?.role).toBe('userio')
  })
  it('a STAT line: the operation, object, rows against the estimate', () => {
    const s = parseStat("STAT #139745604251096 id=2 cnt=100001 pid=1 pos=1 obj=108611 op='TABLE ACCESS FULL MTK_ORDERS (cr=498 pr=496 pw=0 str=1 time=634138 us cost=137 size=1300000 card=100000)'")!
    expect(s).toMatchObject({ id: 2, pid: 1, op: 'TABLE ACCESS FULL', name: 'MTK_ORDERS', cnt: 100001, card: 100000, time: 634138, cr: 498 })
  })
})

describe('planDump', () => {
  it('depth and own time of each plan line', () => {
    const at = trc.findIndex((l) => l.startsWith('STAT #139745604251096 id=1')) + 1
    const lineAt = (n: number) => ({ text: trc[n - 1], kind: (trc[n - 1].startsWith('STAT ') ? 'stat' : 'unknown') as LineKind })
    const d = planDump(lineAt, at + 1)
    expect(d.get(at)).toEqual({ depth: 0, self: 636589 - 634138, root: 636589 })
    expect(d.get(at + 1)).toEqual({ depth: 1, self: 634138, root: 636589 })
  })
})

describe('statementTones', () => {
  it('ranks by elapsed; recursive SYS SQL stays neutral', () => {
    const t = statementTones([{ id: 0, parsingUserId: 0, minDepth: 1 }, { id: 1, parsingUserId: 5, minDepth: 0 }, { id: 2, parsingUserId: 5, minDepth: 0 }], (id) => [900, 10, 20][id])
    expect(t.get(0)).toBeUndefined()
    expect(t.get(2)).toEqual({ token: '--c-cpu', shade: 0 })
    expect(t.get(1)).toEqual({ token: '--c-network', shade: 0 })
  })
})

describe('a STAT line as a plan row', () => {
  it('its columns, and an estimate 10× off flagged', () => {
    const at = trc.findIndex((l) => l.startsWith('STAT #139745604251096 id=2')) + 1
    const v = describeLine(trc[at - 1], 'stat', at, { planAt: () => ({ depth: 1, self: 634138, root: 636589 }) })
    expect(v.plan).toMatchObject({ id: 2, depth: 1, op: 'TABLE ACCESS FULL', name: 'MTK_ORDERS', starts: 1, eRows: 100000, aRows: 100001, cost: 137, time: 634138, cr: 498, pr: 496, pw: 0, off: false })
    const off = describeLine("STAT #1 id=3 cnt=1000 pid=2 pos=1 obj=5 op='INDEX RANGE SCAN T_PK (cr=70 pr=0 pw=0 str=1 time=644 us cost=3 size=0 card=50)'", 'stat', 1)
    expect(off.plan?.off).toBe(true)
  })
})

describe('the rest of the lines, readable', () => {
  it('wait parameters: labelled, the noise left out', () => {
    const dpr = describeLine("WAIT #139745604251096: nam='direct path read' ela= 39 file number=12 first dba=169947 block cnt=5 obj#=108611 tim=10805135198", 'wait', 1)
    expect(text(dpr.parts)).toBe('direct path read|obj# 108611|file 12 · block 169947 · 5 blocks')
    const net = describeLine("WAIT #139745605258360: nam='SQL*Net more data to client' ela= 38 driver id=1952673792 #bytes=8103 p3=0 obj#=-1 tim=10804499034", 'wait', 1)
    expect(text(net.parts)).toBe('SQL*Net more data to client|8,103 bytes')
  })
  it('bind attribute lines (testdata/traces/19c/basic_binds.trc lines 56-59)', () => {
    expect(text(bindAttrSegs('  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00'))).toBe('type NUMBER, up to 22 bytes')
    expect(text(bindAttrSegs('  oacflg=03 fl2=1400000 frm=00 csi=00 siz=72 off=0'))).toBe('no character set (not a character type)')
    expect(text(bindAttrSegs('  kxsbbbfp=7f713eea01f8  bln=22  avl=02  flg=05'))).toBe('value length 2 of a 22-byte buffer')
    expect(text(bindAttrSegs('  value=42'))).toBe('as printed: 42')
    expect(text(bindAttrSegs('  oacflg=10 fl2=0001 frm=01 csi=873 siz=32 off=0'))).toMatch(/^character set AL32UTF8 · /)
  })
  it('*** markers by name, timestamps as a clock time', () => {
    const m = describeMarker('*** MODULE NAME:(mtk_basic_binds) 2026-10-22T11:35:03.510108+00:00')
    expect([m.label, text(m.parts)]).toEqual(['MODULE', 'mtk_basic_binds'])
    expect(m.wall).toMatchObject({ clock: '11:35:03.510', micros: '108' })
    const t = describeMarker('*** 2026-10-22T11:35:03.510078+00:00 (PDB1(3))')
    expect([t.label, text(t.parts)]).toEqual(['TIME', '2026-10-22 UTC+00:00 · PDB1(3)'])
    expect(t.wall).toMatchObject({ clock: '11:35:03.510', micros: '078' })
  })
  it('SQL text: keywords, strings and binds apart', () => {
    const s = sqlSegs("select c.id from mtk_cust c where c.name = 'x' and c.id = :b1 -- note")
    expect(s.filter((x) => typeof x !== 'string').map((x) => typeof x === 'string' || 'q' in x ? '' : `${x.c}:${x.t}`))
      .toEqual(['kw:select', 'kw:from', 'kw:where', "str:'x'", 'kw:and', 'bind::b1', 'cmt:-- note'])
    expect(text(s)).toBe("select c.id from mtk_cust c where c.name = 'x' and c.id = :b1 -- note")
  })
})

describe('the wait share of a call', () => {
  it('e − c when it is 10 % of the call and 100 µs or more; critical from half of it', () => {
    expect(waitShare(1000, 1000)).toBeUndefined() // all CPU
    expect(waitShare(900, 1000)).toEqual({ us: 100, pct: 10, crit: false }) // exactly 10 % and 100 µs
    expect(waitShare(901, 1000)).toBeUndefined() // 99 µs
    expect(waitShare(9100, 10_000)).toBeUndefined() // 900 µs but 9 %
    expect(waitShare(8900, 10_000)).toEqual({ us: 1100, pct: 11, crit: false })
    expect(waitShare(500, 1000)).toEqual({ us: 500, pct: 50, crit: true })
    expect(waitShare(501, 1000)).toEqual({ us: 499, pct: 50, crit: false })
    expect(waitShare(0, 5000)).toEqual({ us: 5000, pct: 100, crit: true })
    expect(waitShare(undefined, 5000)).toBeUndefined()
    expect(waitShare(5000, undefined)).toBeUndefined()
    expect(waitShare(200, 100)).toBeUndefined() // CPU above the elapsed time (rounding): nothing waited
  })
  it('PARSE, EXEC and FETCH lines of io_waits.trc carry it', () => {
    const parse = describeLine(trc[87 - 1], 'call', 87)
    expect(parse.waited).toEqual({ us: 815, pct: 90, crit: true }) // c=92 e=907
    expect(text(parse.parts)).toBe('hard parse') // the share is not in the detail's pieces
    const fetch = describeLine(trc[122 - 1], 'call', 122)
    expect(fetch.waited).toEqual({ us: 631_420, pct: 99, crit: true }) // c=5167 e=636587
    expect(describeLine('EXEC #139745605242584:c=19,e=19,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=0,plh=0,tim=10804500070', 'call', 1).waited).toBeUndefined()
    expect(describeLine('FETCH #1:c=2000,e=2300,p=0,cr=3,cu=0,mis=0,r=1,dep=0,og=1,plh=1,tim=10804503100', 'call', 1).waited).toEqual({ us: 300, pct: 13, crit: false })
  })
})

describe('callParts: a call\'s Detail in groups', () => {
  const parts = (line: string) => callParts(parseCall(line)!)
  it('a FETCH of io_waits.trc: rows, then the gets in tkprof\'s words, then the CPU (it is not all of the duration)', () => {
    const { call, notes } = parts(trc[122 - 1])
    expect(call.rows).toMatchObject({ n: '1', unit: 'row' })
    expect(call.gets).toEqual({ query: '498', current: '0', disk: '496', zero: [false, true, false], title: expect.stringContaining('cr=498 cu=0 p=496') })
    expect(call.cpu).toMatchObject({ n: '5.17', unit: 'ms' })
    expect(notes).toEqual([])
  })
  it('the rows are always there on a FETCH (0 rows too), on the other calls only when there are some', () => {
    expect(parts('FETCH #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=1,tim=1').call.rows).toMatchObject({ n: '0', unit: 'rows' })
    expect(parts('EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=1,tim=1').call.rows).toBeUndefined()
    expect(parts('EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=3,dep=0,og=1,plh=1,tim=1').call.rows).toMatchObject({ n: '3', unit: 'rows' })
    expect(parts('FETCH #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=1,dep=0,og=1,plh=1,tim=1').call.rows?.unit).toBe('row')
    expect(parts('CLOSE #1:c=2,e=2,dep=0,type=0,tim=1').call.rows).toBeUndefined() // no r= at all: the slot stays empty
  })
  it('the gets box is there when any of cr, cu, p is above 0, with the counts grouped and the zeros marked', () => {
    expect(parts('EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=1,tim=1').call.gets).toBeUndefined()
    expect(parts('EXEC #1:c=1,e=1,p=0,cr=0,cu=7,mis=0,r=0,dep=0,og=1,plh=1,tim=1').call.gets).toMatchObject({ query: '0', current: '7', disk: '0', zero: [true, false, true] })
    expect(parts('FETCH #1:c=1,e=1,p=1234567,cr=2,cu=0,mis=0,r=1,dep=0,og=1,plh=1,tim=1').call.gets).toMatchObject({ query: '2', disk: '1,234,567' })
  })
  it('the notes are a hard parse and how a CLOSE closed the cursor', () => {
    expect(text(parts('PARSE #1:c=92,e=907,p=0,cr=0,cu=0,mis=1,r=0,dep=0,og=1,plh=1,tim=1').notes)).toBe('hard parse')
    expect(text(parts('CLOSE #1:c=2,e=2,dep=0,type=3,tim=1').notes)).toBe('cached')
  })
  it('the CURSOR row\'s sql_id is a reference that opens the statement', () => {
    const v = describeLine(trc[84 - 1], 'parsing-in-cursor', 84)
    expect(v.parts[0]).toEqual({ t: 'c7ry5gr75qv4b', c: 'name', ref: 'sqlid:c7ry5gr75qv4b' })
  })
})

describe('what the Operation cell says', () => {
  it('calls, waits, structures and markers; a wait carries the colour role of its dot', () => {
    expect(describeLine(trc[87 - 1], 'call', 87).op).toBe('call')
    expect(describeLine('CLOSE #1:c=2,e=2,dep=0,type=0,tim=10804503000', 'call', 1).op).toBe('call')
    const ev = (idle: boolean, role: 'idle' | 'network') => ({ eventOf: () => ({ class: idle ? 'Idle' : 'Network', idle, role }) })
    const net = "WAIT #1: nam='SQL*Net message from client' ela= 122 driver id=1 #bytes=1 p3=0 obj#=-1 tim=10804500200"
    expect(describeLine(net, 'wait', 1, ev(true, 'idle'))).toMatchObject({ op: 'wait', dot: 'idle' })
    expect(describeLine(net, 'wait', 1, ev(false, 'network'))).toMatchObject({ op: 'wait', dot: 'network' })
    expect(describeLine(net, 'wait', 1).dot).toBe('other') // an event the doc does not know
    expect(describeLine("STAT #1 id=1 cnt=1 pid=0 pos=1 obj=0 op='SORT AGGREGATE (cr=1 pr=0 pw=0 str=1 time=5 us)'", 'stat', 1).op).toBe('struct')
    expect(describeMarker('*** MODULE NAME:(m) 2026-10-22T11:35:03.510108+00:00').op).toBe('mark')
    expect(describeLine('  value=42', 'bind-line', 1).op).toBeUndefined()
  })
})

describe('structure: what the rows say', () => {
  it('the CURSOR row is one row: the sql_id, then the command, the user and the length of the text', () => {
    const v = describeLine(trc[84 - 1], 'parsing-in-cursor', 84)
    expect(v.label).toBe('CURSOR')
    expect(text(v.parts)).toBe('c7ry5gr75qv4bSELECT · user 165 · 99 chars')
    const rec = describeLine(trc.find((l) => l.startsWith('PARSING IN CURSOR') && l.includes('dep=1'))!, 'parsing-in-cursor', 1)
    expect(text(rec.parts)).toMatch(/^[0-9a-z]{13}SELECT · user 0 · depth 1 · \d+ chars$/) // a recursive one says its depth before the length
    expect(v.parts[1]).toEqual({ t: '', c: 'pgap' }) // a gap after the sql_id, no ·
  })
  it('CLOSE reads closed (type=0) or cached (1, 2 and 3); the exact word is in the tooltip', () => {
    const word = (type: number) => describeLine(`CLOSE #1:c=2,e=2,dep=0,type=${type},tim=10804503000`, 'call', 1).parts.find((x) => typeof x !== 'string' && 'c' in x && x.c === 'dim') as { t: string; title: string }
    expect(word(0)).toMatchObject({ t: 'closed', title: 'type=0: hard close' })
    expect(word(1).t).toBe('cached')
    expect(word(3)).toMatchObject({ t: 'cached', title: 'type=3: already in the cursor cache' })
  })
  it('the one byte of a SQL*Net message is left out; 8,101 bytes stays', () => {
    const net = (b: number) => describeLine(`WAIT #1: nam='SQL*Net message to client' ela= 0 driver id=1952673792 #bytes=${b} p3=0 obj#=-1 tim=10804501708`, 'wait', 1)
    expect(text(net(1).parts)).toBe('SQL*Net message to client')
    expect(text(net(8101).parts)).toBe('SQL*Net message to client|8,101 bytes')
  })
  it('a block read of a file, a block and a block count has micro-columns; nothing else does', () => {
    expect(waitMicro([{ label: 'file number', value: '12' }, { label: 'first dba', value: '171160' }, { label: 'block cnt', value: '8' }])).toEqual({ file: '12', block: '171160', blocks: 8 })
    expect(waitMicro([{ label: 'file#', value: '203' }, { label: 'block#', value: '756116' }, { label: 'blocks', value: '1' }])).toEqual({ file: '203', block: '756116', blocks: 1 })
    expect(waitMicro([{ label: 'driver id', value: '1952673792' }, { label: '#bytes', value: '8101' }, { label: 'p3', value: '0' }])).toBeUndefined() // SQL*Net
    expect(waitMicro([{ label: 'file#', value: '203' }, { label: 'block#', value: '0' }, { label: 'blocks', value: '1' }])).toBeUndefined() // a zero is left out: two fields
  })
  it('a wait run is keyed by its event and its object (the object only where it is the one waited on)', () => {
    const a = waitRun("WAIT #1: nam='direct path read' ela= 39 file number=12 first dba=169947 block cnt=5 obj#=108611 tim=10805135198", { objectName: () => 'MTK_ORDERS', eventOf: () => ({ class: 'User I/O', idle: false, role: 'userio' }) })
    expect(a).toMatchObject({ key: 'direct path read|MTK_ORDERS', role: 'userio', micro: { file: '12', block: '169947', blocks: 5 } })
    const n = waitRun("WAIT #1: nam='SQL*Net message to client' ela= 0 driver id=1 #bytes=1 p3=0 obj#=108611 tim=1", { objectName: () => 'MTK_ORDERS', eventOf: () => ({ class: 'Network', idle: false, role: 'network' }) })
    expect(n).toMatchObject({ key: 'SQL*Net message to client|', micro: undefined }) // a stale obj# on a network wait is not its object
    expect(waitRun('EXEC #1:c=1,e=1', {})).toBeUndefined()
  })
  it('the binds of a BINDS header as chips: the name, the value, the type', () => {
    const at = {
      header: true, pos: -1, sql: 'select 1 from dual where a = :b_lo and b = :b_hi',
      binds: [
        { pos: 0, type: 'NUMBER', value: '8706', isNull: false, noDef: false, dump: false, mal: 0 },
        { pos: 1, type: 'VARCHAR2(32)', value: 'x', isNull: true, noDef: false, dump: false, mal: 0 },
      ],
    }
    const v = describeLine('BINDS #1:', 'binds', 5, { bindsAt: () => at })
    expect(v.chips).toEqual([
      { name: ':b_lo', value: '8706', type: 'NUMBER', none: false, title: 'Bind#0 NUMBER: 8706' },
      { name: ':b_hi', value: 'NULL', type: 'VARCHAR2(32)', none: true, title: 'Bind#1 VARCHAR2(32): NULL' },
    ])
    expect(v.bindHead).toBe(true)
    expect(describeLine('BINDS #1:', 'binds', 5).chips).toBeUndefined() // values not known yet
  })
})
