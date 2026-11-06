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

const rows = (pin: { line: number; tim: number } | null = null) => {
  const f = readableRowsOf({ doc, line, tones: new Map(), pin, hot: new Map([[4, 122]]) })
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
    expect(r(4).trackW).toBeCloseTo(Math.log10(122) / 7, 10) // a wait of 122 µs
    expect(r(4).trackCpuW).toBeUndefined()
    expect(r(1).trackW).toBeCloseTo(Math.log10(19) / 7, 10) // a call: its time, and its CPU part
    expect(r(1).trackCpuW).toBeCloseTo(Math.log10(19) / 7, 10)
    expect(r(2).trackW).toBe(0) // 0 µs: an empty track
    expect(r(3).trackW).toBeUndefined() // a blank line has no time
    expect(r(2).hot).toBe(false)
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
