import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { TraceDoc } from '../data/doc'
import { LINE_KINDS, type CachedLine } from '../data/linecache'
import type { LineKind } from '../data/lines'
import { readableRowsOf } from './readableRows'

// lines of testdata/traces/19c/io_waits.trc (around line 40; the tims are adjusted to give round deltas), with the cursor ids the engine
// gives them: two cursors, 0 and 1
const LINES: [string, LineKind, number][] = [
  ['EXEC #139745605242584:c=19,e=19,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=0,plh=0,tim=10804500070', 'call', 0],
  ["WAIT #139745605242584: nam='SQL*Net message to client' ela= 0 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=10804500079", 'wait', 0],
  ['', 'blank', -1],
  ["WAIT #139745605242584: nam='SQL*Net message from client' ela= 122 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=10804500200", 'wait', 0],
  ['', 'blank', -1],
  ['EXEC #139745605240912:c=81,e=81,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=0,plh=0,tim=10804500410', 'call', 1],
]
const line = (n: number): CachedLine | undefined => {
  const l = LINES[n - 1]
  return l && { text: l[0], kind: LINE_KINDS.indexOf(l[1]), call: -1, stmt: l[2], cursor: l[2], execNo: -1, wait: -1 }
}
const doc = {
  events: [], planLines: [], wallOffsetUs: 0, tzOffsetMin: 0, span: { firstTim: 10804500000 },
  cursors: [{ id: 0, number: 139745605242584, statement: 0, depth: 0 }, { id: 1, number: 139745605240912, statement: 1, depth: 0 }],
  statements: [{ id: 0, kind: 0, sqlId: 'aaaaaaaaaaaaa', text: 'select 1 from dual' }, { id: 1, kind: 0, sqlId: 'bbbbbbbbbbbbb', text: 'select 2 from dual' }],
  label: (s: { sqlId: string }) => s.sqlId,
  objectName: () => undefined, userName: () => undefined,
} as unknown as TraceDoc

const rows = (pin: { line: number; tim: number } | null = null, spanUs = 1_000_000) => {
  const f = readableRowsOf({ doc, line, tones: new Map(), pin, hot: new Map([[4, 122]]), spanUs })
  return (n: number) => f(n, line(n)!)
}

describe('readableRowsOf', () => {
  it('a cursor stretch is one lane: the sql_id on its first row, the SQL on its second; a blank line between its lines stays in it', () => {
    const r = rows()
    expect(r(1).lane).toMatchObject({ label: 'aaaaaaaaaaaaa', stmt: 0, title: expect.stringContaining('cursor #139745605242584') })
    expect(r(2).lane).toMatchObject({ label: undefined, sub: 'select 1 from dual' })
    expect(r(3).lane?.stmt).toBe(0)
    expect(r(5).lane).toBeNull() // between two cursors: no lane
    expect(r(6).lane).toMatchObject({ label: 'bbbbbbbbbbbbb' })
  })
  it('Δ from the pin is the time from there (tim to tim, as it always was)', () => {
    const p = rows({ line: 1, tim: 10804500070 })
    expect(p(1)).toMatchObject({ pinned: true, delta: '', fromPin: true })
    expect(p(4)).toMatchObject({ delta: '+130 µs', fromPin: true, deltaUs: 130, deltaEmph: false })
    expect(p(6)).toMatchObject({ delta: '+340 µs', deltaTitle: '+340 µs from the pinned line (1)' })
    const before = rows({ line: 6, tim: 10804500410 })
    expect(before(4)).toMatchObject({ delta: '−210 µs', deltaUs: 210 }) // before the pin: negative, as it was
  })
  it('without a pin Δ is the unexplained gap: where the line started (tim − own time) after where the line with a time before it ended', () => {
    const r = rows()
    // line 6: EXEC e=81 started at 10804500329; the line with a time before it (4) ended at ...200: 129 µs nobody explains (tim to tim: 210)
    expect(r(6)).toMatchObject({ delta: '+129 µs', fromPin: false, deltaUs: 129, deltaEmph: false })
    expect(r(6).deltaTitle).toBe('129 µs unexplained: this line started (its tim minus its own 81 µs) that long after line 4 ended\n+210 µs tim to tim, from line 4')
    expect(r(1).delta).toBe('') // the first line with a time: nothing before it
  })
  it('never negative: the gap of a line that started before the one above ended is blank, whatever its tim to tim says', () => {
    const r = rows()
    // line 4: ela=122 started at ...078, a µs before line 2 ended (...079): tim to tim +121, gap −1
    expect(r(4)).toMatchObject({ delta: '', deltaUs: undefined, deltaEmph: false, deltaTitle: undefined })
  })
  it('blank under 50 µs', () => {
    expect(rows()(2).delta).toBe('') // line 2 started 9 µs after line 1 ended
  })
  it('hot spots, and the Duration bars on the log scale', () => {
    const r = rows()
    expect(r(4).hot).toBe(true)
    // the bar is the log of the line's share of the traced time (1 s here), 0.01 % to 100 % over four decades
    expect(r(4).trackW).toBeCloseTo(Math.log10(122e-6 / 1e-4) / 4, 10) // a wait of 122 µs: 0.0122 %
    expect(r(4).trackCpuW).toBeUndefined()
    expect(r(1).trackW).toBeCloseTo(0, 10) // a call of 19 µs: under 0.01 %, an empty track
    expect(r(1).trackCpuW).toBeCloseTo(0, 10)
    expect(r(2).trackW).toBe(0) // 0 µs: an empty track
    expect(r(3).trackW).toBeUndefined() // a blank line has no time
    expect(r(2).hot).toBe(false)
  })
  it('the same wait is a longer bar on a shorter file, and 1 % of the traced time is the middle of the track', () => {
    expect(rows(null, 100_000)(4).trackW).toBeGreaterThan(rows(null, 1_000_000)(4).trackW!)
    expect(rows(null, 12_200)(4).trackW).toBeCloseTo(0.5, 10) // 122 µs of 12.2 ms: exactly 1 %
    expect(rows(null, 0)(4).trackW).toBe(0) // no span: empty tracks
  })
})

// a trace with a wall clock: tim 10804500070 is 2026-10-22 11:35:29.195404 UTC
const T0 = 10804500070
const WALL0 = Date.UTC(2026, 9, 22, 11, 35, 29, 195) * 1000 + 404
const CLOCK_LINES: [string, LineKind][] = [
  [`EXEC #139745605242584:c=19,e=19,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=0,plh=0,tim=${T0}`, 'call'], // 11:35:29.195404
  [`WAIT #139745605242584: nam='SQL*Net message to client' ela= 0 driver id=1 #bytes=1 p3=0 obj#=-1 tim=${T0 + 14}`, 'wait'], // .195418
  ['', 'blank'],
  [`WAIT #139745605242584: nam='SQL*Net message from client' ela= 122 driver id=1 #bytes=1 p3=0 obj#=-1 tim=${T0 + 804_600}`, 'wait'], // 11:35:30.000004
  [`WAIT #139745605242584: nam='SQL*Net message to client' ela= 1 driver id=1 #bytes=1 p3=0 obj#=-1 tim=${T0 + 804_700}`, 'wait'], // .000104
  ['*** 2026-10-22T11:35:30.000500+00:00 (PDB1(3))', 'marker'], // the same second
  ['*** 2026-10-22T11:35:31.000700+00:00 (PDB1(3))', 'marker'], // the next one
  [`FETCH #139745605242584:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=0,plh=0,tim=${T0 + 1_804_800}`, 'call'], // 11:35:31.000204: the same second as the marker
]
const clockLine = (n: number): CachedLine | undefined => {
  const l = CLOCK_LINES[n - 1]
  return l && { text: l[0], kind: LINE_KINDS.indexOf(l[1]), call: -1, stmt: 0, cursor: 0, execNo: -1, wait: -1 }
}
const clockDoc = { ...doc, wallOffsetUs: WALL0 - T0 } as unknown as TraceDoc
const clockRows = (d: TraceDoc = clockDoc, line = clockLine) => {
  const f = readableRowsOf({ doc: d, line, tones: new Map(), pin: null, hot: new Map() })
  return (n: number) => f(n, line(n)!)
}

describe('the clock of a row: the whole stamp where it changes, else the digits that change', () => {
  it('the first row with a time is in full, the next ones of the same second show the digits after it', () => {
    const r = clockRows()
    expect(r(1)).toMatchObject({ clock: '11:35:29.195', micros: '404', clockFull: true, clockShort: '.195404' })
    expect(r(2)).toMatchObject({ clock: '11:35:29.195', micros: '418', clockFull: false, clockShort: '.195418' })
  })
  it('HH:MM:SS changing brings the whole stamp back; the row before is the previous one with a clock (a blank in between is skipped)', () => {
    const r = clockRows()
    expect(r(4)).toMatchObject({ clock: '11:35:30.000', micros: '004', clockFull: true })
    expect(r(5)).toMatchObject({ micros: '104', clockFull: false, clockShort: '.000104' })
    expect(r(3)).toMatchObject({ clock: '', clockFull: true, clockShort: '' }) // no time: nothing to show
  })
  it('a *** line prints its own time and follows the same rule, against the row with a clock before it', () => {
    const r = clockRows()
    expect(r(6)).toMatchObject({ clock: '11:35:30.000', micros: '500', clockFull: false, clockShort: '.000500' })
    expect(r(7)).toMatchObject({ clock: '11:35:31.000', micros: '700', clockFull: true })
    // the line before is the marker (31 s): the same second
    expect(r(8)).toMatchObject({ clock: '11:35:31.000', micros: '204', clockFull: false, clockShort: '.000204' })
  })
  it('a line whose page is not loaded yet has no previous line: the whole stamp', () => {
    const r = clockRows(clockDoc, (n) => (n >= 2 ? clockLine(n) : undefined))
    expect(r(2).clockFull).toBe(true)
    expect(r(5).clockFull).toBe(false)
  })
  it('a trace without a wall clock reads +S.mmm s: always whole', () => {
    const r = clockRows(doc as unknown as TraceDoc)
    expect(r(1)).toMatchObject({ clock: '+0.000 s', micros: '', clockFull: true, clockShort: '' })
    expect(r(2)).toMatchObject({ clockFull: true, clockShort: '' })
  })
})

describe('hot spots', () => {
  it('a call or wait of 1 % is hot, an idle wait (think time) is not; a plan operation is hot by its own time', () => {
    const lines: [string, LineKind][] = [
      [`WAIT #1: nam='SQL*Net message from client' ela= 5000000 driver id=1 #bytes=1 p3=0 obj#=-1 tim=${T0}`, 'wait'],
      [`WAIT #1: nam='db file sequential read' ela= 70000 file#=1 block#=2 blocks=1 obj#=-1 tim=${T0 + 1}`, 'wait'],
      ["STAT #1 id=1 cnt=1 pid=0 pos=1 obj=0 op='SORT AGGREGATE (cr=498 pr=496 pw=0 str=1 time=636589 us)'", 'stat'],
      ["STAT #1 id=2 cnt=100001 pid=1 pos=1 obj=108611 op='TABLE ACCESS FULL MTK_ORDERS (cr=498 pr=496 pw=0 str=1 time=634138 us cost=137 size=1300000 card=100000)'", 'stat'],
    ]
    const at = (n: number): CachedLine | undefined => { const l = lines[n - 1]; return l && { text: l[0], kind: LINE_KINDS.indexOf(l[1]), call: -1, stmt: 0, cursor: 0, execNo: -1, wait: -1 } }
    const d = { ...doc, events: [{ name: 'SQL*Net message from client', class: 'Idle', idle: true }, { name: 'db file sequential read', class: 'User I/O', idle: false }] } as unknown as TraceDoc
    const f = readableRowsOf({ doc: d, line: at, tones: new Map(), pin: null, hot: new Map([[1, 5_000_000], [2, 70_000]]), hotUs: 6000 })
    expect(f(1, at(1)!).hot).toBe(false)
    expect(f(2, at(2)!).hot).toBe(true)
    expect(f(3, at(3)!).plan?.hot).toBeUndefined() // SORT AGGREGATE: 2.451 ms of its own
    expect(f(4, at(4)!).plan?.hot).toBe(true) // 634 ms of its own
    const g = readableRowsOf({ doc: d, line: at, tones: new Map(), pin: null, hot: new Map() })
    expect(g(4, at(4)!).plan?.hot).toBeUndefined() // no threshold: none
  })
})

describe('Δ as the unexplained gap, and its emphasis', () => {
  const T = 1_000_000
  const call = (op: string, e: number, tim: number): [string, LineKind] => [`${op} #1:c=${e},e=${e},p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=${tim}`, 'call']
  const wait = (ela: number, tim: number): [string, LineKind] => [`WAIT #1: nam='db file sequential read' ela= ${ela} file#=1 block#=2 blocks=1 obj#=-1 tim=${tim}`, 'wait']
  const gapRows = (lines: [string, LineKind][], pin: { line: number; tim: number } | null = null) => {
    const at = (n: number): CachedLine | undefined => { const l = lines[n - 1]; return l && { text: l[0], kind: LINE_KINDS.indexOf(l[1]), call: -1, stmt: 0, cursor: 0, execNo: -1, wait: -1 } }
    const f = readableRowsOf({ doc, line: at, tones: new Map(), pin, hot: new Map() })
    return (n: number) => f(n, at(n)!)
  }
  // each wait starts `gap` after the line above ended (its tim = the previous tim + gap + its own ela)
  const lines: [string, LineKind][] = [
    call('EXEC', 100, T), // 1
    wait(40, T + 100), // 2: started T+60, the call ended T: 60 µs
    wait(10, T + 149), // 3: started T+139, line 2 ended T+100: 39 µs, under 50
    wait(10, T + 2160), // 4: 2001 µs after line 3 ended; line 3 took 10 µs: emphasised
    wait(3000, T + 5160), // 5: started T+2160, exactly when line 4 ended: no gap
    wait(10, T + 7170), // 6: 2000 µs after line 5 (3000 µs long): 1 ms or more, but under twice it
    wait(10, T + 13180), // 7: 6000 µs after line 6 (10 µs long): emphasised
    wait(2_000_000, T + 13_180 + 2_000_000 + 4_000_000), // 8: a gap of 4 s after a 10 µs line: emphasised, in seconds
  ]
  it('under 50 µs: blank; from 50 µs: the gap, not emphasised below 1 ms', () => {
    const r = gapRows(lines)
    expect(r(2)).toMatchObject({ delta: '+60 µs', deltaUs: 60, deltaEmph: false })
    expect(r(3)).toMatchObject({ delta: '', deltaUs: undefined, deltaEmph: false })
  })
  it('emphasised from 1 ms and twice the duration of the line before', () => {
    const r = gapRows(lines)
    expect(r(4)).toMatchObject({ delta: '+2.00 ms', deltaUs: 2001, deltaEmph: true })
    expect(r(5)).toMatchObject({ delta: '', deltaEmph: false }) // started the moment line 4 ended
    expect(r(6)).toMatchObject({ delta: '+2.00 ms', deltaEmph: false }) // 3 ms line before: a gap of 2 ms is no more than it
    expect(r(7)).toMatchObject({ delta: '+6.00 ms', deltaEmph: true })
    expect(r(8)).toMatchObject({ delta: '+4.000 s', deltaUs: 4_000_000, deltaEmph: true })
  })
  it('a PARSE whose tim sits before the CURSOR line before it has a blank Δ, not −1 µs (io_waits line 39); the CURSOR line keeps its own gap', () => {
    const ls: [string, LineKind][] = [
      wait(10, T), // 1
      [`PARSING IN CURSOR #1 len=34 dep=0 uid=165 oct=42 lid=165 tim=${T + 146 + 10} hv=1 ad='0' sqlid='1h7h96h7gnvbj'`, 'parsing-in-cursor'], // 2: no time of its own: tim to tim, 156 µs
      call('PARSE', 121, T + 156 - 1), // 3: tim 1 µs before line 2's, e=121
    ]
    const r = gapRows(ls)
    expect(r(2)).toMatchObject({ delta: '+156 µs', deltaEmph: false })
    expect(r(3).delta).toBe('')
  })
  it('the tooltip keeps the tim-to-tim number, and the colour-by-Δ step is still tim to tim', () => {
    const r = gapRows(lines)
    expect(r(4).deltaTitle).toBe('2,001 µs unexplained: this line started (its tim minus its own 10 µs) that long after line 3 ended\n+2,011 µs tim to tim, from line 3')
  })
  it('a pin turns the column back into the time from it, with no emphasis', () => {
    const r = gapRows(lines, { line: 1, tim: T })
    expect(r(4)).toMatchObject({ delta: '+2.16 ms', fromPin: true, deltaEmph: false })
    expect(r(8).deltaEmph).toBe(false)
  })
})

// ---- structure: runs of waits, the bracket of a call's waits, the first row of an execution (real lines of testdata/traces/19c/io_waits.trc) ----
const trc = readFileSync(new URL('../../../../testdata/traces/19c/io_waits.trc', import.meta.url), 'utf8').split('\n')
const kindOfLine = (t: string, inSql: boolean): LineKind => {
  if (inSql) return t === 'END OF STMT' ? 'end-of-stmt' : 'sql-text'
  if (t === '') return 'blank'
  if (t.startsWith('=====')) return 'separator'
  if (t.startsWith('PARSING IN CURSOR')) return 'parsing-in-cursor'
  if (t.startsWith('WAIT ')) return 'wait'
  if (/^(PARSE|EXEC|FETCH|CLOSE) /.test(t)) return 'call'
  if (t.startsWith('STAT ')) return 'stat'
  if (t.startsWith('BINDS ')) return 'binds'
  if (t.startsWith(' Bind#') || t.startsWith('  oac') || t.startsWith('  kxs')) return 'bind-line'
  if (t.startsWith('***')) return 'marker'
  return 'unknown'
}
/** The rows of lines `from..to` of the fixture (the statement state starts outside SQL text: pick a range that starts at a call or a wait). */
function io(from: number, to: number) {
  const nums: string[] = []
  const at = new Map<number, CachedLine>()
  let inSql = false
  for (let n = from; n <= to; n++) {
    const t = trc[n - 1]
    const k = kindOfLine(t, inSql)
    inSql = k === 'parsing-in-cursor' || (inSql && k !== 'end-of-stmt')
    const c = /^(?:\w+) #(\d+)/.exec(t)?.[1]
    if (c && c !== '0' && !nums.includes(c)) nums.push(c)
    at.set(n, { text: t, kind: LINE_KINDS.indexOf(k), call: -1, stmt: 0, cursor: c && c !== '0' ? nums.indexOf(c) : -1, execNo: k === 'binds' || t.startsWith('EXEC ') ? 7 : -1, wait: -1 })
  }
  const d = {
    events: [
      { name: 'direct path read', class: 'User I/O', idle: false }, { name: 'direct path read temp', class: 'User I/O', idle: false },
      { name: 'SQL*Net message from client', class: 'Idle', idle: true }, { name: 'SQL*Net message to client', class: 'Network', idle: false },
      { name: 'SQL*Net more data to client', class: 'Network', idle: false }, { name: 'reliable message', class: 'Other', idle: false },
    ],
    planLines: [], wallOffsetUs: 0, tzOffsetMin: 0, span: { firstTim: 0 },
    cursors: nums.map((number, id) => ({ id, number, statement: 0, depth: 0 })),
    statements: [{ id: 0, kind: 0, sqlId: 'c7ry5gr75qv4b', text: 'select 1 from dual' }],
    label: (s: { sqlId: string }) => s.sqlId, objectName: (o: number) => (o === 108611 ? 'MTK_ORDERS' : undefined), userName: () => undefined,
  } as unknown as TraceDoc
  const f = readableRowsOf({ doc: d, line: (n) => at.get(n), tones: new Map(), pin: null, hot: new Map() })
  return (n: number) => f(n, at.get(n)!)
}

describe('runs of waits: a ditto and micro-columns', () => {
  const r = io(80, 140)
  it('3 or more waits of one event and object: micro-columns on all; the repeated prefix is a ditto from the second row on', () => {
    expect(r(96)).toMatchObject({ micro: { file: '12', block: '169947', blocks: 5 }, ditto: false }) // the first of the 26 direct path reads
    expect(r(97)).toMatchObject({ micro: { file: '12', block: '169968', blocks: 8 }, ditto: true })
    expect(r(121).ditto).toBe(true)
  })
  it('another event above is not a ditto, and a wait that is not a block read has no columns', () => {
    expect(r(95).micro).toBeUndefined() // Disk file operations I/O: another event, no file / block / blocks
    expect(r(89).micro).toBeUndefined() // a network wait
    expect(r(90).micro).toBeUndefined()
  })
  it('fewer than 3 of the event in the stretch: no run', () => {
    const two = io(95, 98) // lines 96, 97, 98: three reads
    expect(two(96).micro).toBeDefined()
    const lone = io(94, 97) // 95 is another event; 96, 97 are two reads
    expect(lone(96).micro).toBeUndefined()
    expect(lone(97).micro).toBeUndefined()
  })
  it('a network or idle wait inside the run breaks the ditto, not the columns (lines 10359-10371 of the file)', () => {
    const t = io(10357, 10372)
    expect(t(10359)).toMatchObject({ ditto: false }) // the first read of the stretch
    expect(t(10360).ditto).toBe(true)
    expect(t(10361).micro).toBeUndefined() // SQL*Net message to client: not a read, no columns
    expect(t(10362)).toMatchObject({ micro: { file: '203', block: '756547', blocks: 1 }, ditto: false }) // columns, but the line above is the network wait: a full prefix
    expect(t(10363).ditto).toBe(true)
  })
})

describe('the bracket of what a call waited for', () => {
  const r = io(80, 140)
  it('the non-idle waits from the first one after the call before down to the call that closes them: the rule in the lane, the waits indented, the call hooked', () => {
    expect(r(88).br).toBeUndefined() // the EXEC above: no waits before it
    expect(r(89)).toMatchObject({ br: 'first', brIndent: true }) // SQL*Net message to client, after EXEC
    expect(r(90)).toMatchObject({ br: 'in', brIndent: true })
    expect(r(92)).toMatchObject({ br: 'in', brIndent: false }) // the *** TIME line inside: ruled, not indented
    expect(r(93)).toMatchObject({ br: 'in', brIndent: true }) // the 632 ms enqueue
    expect(r(121)).toMatchObject({ br: 'in', brIndent: true })
    expect(r(122).br).toBe('end') // the FETCH they were waiting in
  })
  it('idle waits between calls get neither the rule nor the indent', () => {
    expect(r(125)).toMatchObject({ br: undefined, brIndent: false }) // SQL*Net message from client between the FETCHes: nothing before it is a wait
    expect(r(126).br).toBeUndefined() // the FETCH it leads to: no bracket to close
  })
  it('an idle wait after the first non-idle one is inside the bracket (ruled, not indented)', () => {
    expect(r(127)).toMatchObject({ br: 'first', brIndent: true }) // SQL*Net message to client
    expect(r(128)).toMatchObject({ br: 'in', brIndent: false }) // message from client, idle
    expect(r(129).br).toBe('end') // the CLOSE
  })
  it('a WAIT #0 after a CLOSE belongs to no call', () => {
    expect(r(130).br).toBeUndefined()
  })
})

describe('the first row of an execution', () => {
  const r = io(80, 160)
  it('a BINDS header, else the EXEC, carries the exec number; an EXEC under its BINDS block does not', () => {
    expect(r(88)).toMatchObject({ execFirst: true, execNo: 7 }) // EXEC with no BINDS before it
    expect(r(136)).toMatchObject({ execFirst: true, execNo: 7 }) // BINDS #...
    const exec = trc.findIndex((l, i) => i > 136 && l.startsWith('EXEC ')) + 1
    expect(r(exec).execFirst).toBe(false) // under the BINDS block
    expect(r(89).execFirst).toBe(false) // a wait is never one
  })
})

describe('the trace header\'s key column (formatted-v2 bug 7)', () => {
  const HEAD: [string, LineKind][] = [
    ['Trace file /u01/app/oracle/diag/rdbms/cdb1/cdb1/trace/cdb1_ora_133382_mtk_io_waits.trc', 'header'],
    ['Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production', 'header'],
    ['Database name: cdb1 ', 'header'],
    ['Redo thread mounted by this instance: 1', 'header'],
    ['Oracle process number: 68', 'header'],
    ['', 'blank'],
    ['*** 2026-10-22T11:35:29.191626+00:00 (PDB1(3))', 'marker'],
    ['Foo: bar', 'header'],
  ]
  const hl = (n: number): CachedLine | undefined => {
    const l = HEAD[n - 1]
    return l && { text: l[0], kind: LINE_KINDS.indexOf(l[1]), call: -1, stmt: -1, cursor: -1, execNo: -1, wait: -1 }
  }
  const f = readableRowsOf({ doc, line: hl, tones: new Map(), pin: null, hot: new Map() })
  const row = (n: number) => f(n, hl(n)!)
  it('every keyed line of the block is as wide as the longest key of it, so the long key pushes no value over', () => {
    const w = 'Redo thread mounted by this instance'.length
    for (const n of [3, 4, 5]) expect(row(n).keyW).toBe(w)
  })
  it('a line without a key has no width, and a header line after the block starts its own', () => {
    expect(row(1).keyW).toBeUndefined()
    expect(row(2).keyW).toBeUndefined()
    expect(row(8).keyW).toBe('Foo'.length)
  })
})
