import { describe, expect, it } from 'vitest'
import { LINE_KINDS } from './linecache'
import { blockAt, composeFilterFolds, filterFolds, foldAt, foldHiding, headAtRow, indexFolds, lineOfRow, rowOfLine, tableOf, standingFolds, toggleFold, visibleCount, withHeads, type Fold, type LineSource } from './folds'
import type { LineKind } from './lines'

/** A cache of the given lines (kind names), all loaded; `holes` lists lines that are not. */
function fake(lines: [LineKind, string][], holes: number[] = []): LineSource {
  return { total: lines.length, line: (n) => (n >= 1 && n <= lines.length && !holes.includes(n) ? { text: lines[n - 1][1], kind: LINE_KINDS.indexOf(lines[n - 1][0]) } : undefined) }
}

// lines of testdata/traces/19c/basic_binds.trc (the BINDS block of line 150, the STAT dump of line 407, the SQL text of line 75)
const PARSE_LINE = "PARSING IN CURSOR #140124363561040 len=296 dep=0 uid=165 oct=3 lid=165 tim=10778820802 hv=3361819554 ad='8652bd60' sqlid='f6jyzt7462kx2'"
const SQL: [LineKind, string][] = [
  ['sql-text', 'select /* mtk_basic_binds */ c.id, c.name, c.amount, c.created,'],
  ['sql-text', '       :b_num as n, :b_vc2 as v, :b_chr as ch, :b_dbl as d, :b_flt as f,'],
  ['sql-text', '       :b_null as nul, length(:b_long) as lng'],
  ['sql-text', '  from mtk_cust c'],
  ['sql-text', ' where c.id between :b_lo and :b_hi'],
  ['sql-text', '   and (:b_null is null or c.name = :b_null)'],
  ['sql-text', ' order by c.id'],
]
const BINDS: [LineKind, string][] = [
  ['binds', 'BINDS #140124363561040:'],
  ['blank', ''],
  ['bind-line', ' Bind#0'],
  ['bind-line', '  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00'],
  ['bind-line', '  oacflg=03 fl2=1000000 frm=00 csi=00 siz=2280 off=0'],
  ['bind-line', '  kxsbbbfp=7f713ee9f958  bln=22  avl=02  flg=05'],
  ['bind-line', '  value=1'],
  ['bind-line', ' Bind#1'],
  ['bind-line', '  oacdty=01 mxl=128(50) mxlc=00 mal=00 scl=00 pre=00'],
  ['bind-line', '  oacflg=03 fl2=1000000 frm=01 csi=873 siz=0 off=24'],
  ['bind-line', '  kxsbbbfp=7f713ee9f970  bln=128  avl=11  flg=01'],
  ['bind-line', '  value="Customer 42"'],
  ['bind-line', ' Bind#2'],
  ['bind-line', '  No oacdef for this bind.'],
]
const EXEC: [LineKind, string] = ['call', 'EXEC #140124363561040:c=3510,e=4693,p=0,cr=3,cu=7,mis=1,r=0,dep=0,og=1,plh=2403330195,tim=10778825533']
const STAT: [LineKind, string][] = [
  ['stat', "STAT #140124363561040 id=1 cnt=1000 pid=0 pos=1 obj=0 op='FILTER  (cr=191 pr=0 pw=0 str=1 time=1315 us)'"],
  ['stat', "STAT #140124363561040 id=2 cnt=1000 pid=1 pos=1 obj=108609 op='TABLE ACCESS BY INDEX ROWID MTK_CUST (cr=191 pr=0 pw=0 str=1 time=1171 us cost=62 size=2750 card=50)'"],
  ['stat', "STAT #140124363561040 id=3 cnt=1000 pid=2 pos=1 obj=108610 op='INDEX RANGE SCAN MTK_CUST_PK (cr=70 pr=0 pw=0 str=1 time=644 us cost=3 size=0 card=1000)'"],
]
const FILE: [LineKind, string][] = [
  ['separator', '====================='],
  ['parsing-in-cursor', PARSE_LINE], ...SQL, ['end-of-stmt', 'END OF STMT'], // PARSING at 2, SQL 3..9, END OF STMT at 10
  ...BINDS, EXEC, // BINDS at 11..24, EXEC at 25
  ['wait', "WAIT #140124363561040: nam='SQL*Net message from client' ela= 261 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=10778848370"],
  ...STAT, // 27..29
  ['call', 'CLOSE #140124363561040:c=2,e=2,dep=0,type=0,tim=10778848548'],
]

describe('blockAt', () => {
  const c = fake(FILE)
  it('folds a BINDS block over its bind lines and counts the binds', () => {
    expect(blockAt(c, 11)).toEqual({ from: 11, to: 24, summary: 'BINDS: 3 binds' })
  })
  it('folds a STAT dump of consecutive STAT lines', () => {
    expect(blockAt(c, 27)).toEqual({ from: 27, to: 29, summary: 'STAT: 3 plan lines' })
    expect(blockAt(c, 28)).toBeNull() // not the first line of the dump
  })
  it('leaves a short SQL text alone and folds a long one', () => {
    expect(blockAt(c, 2)).toBeNull() // 7 lines
    const long: [LineKind, string][] = [['parsing-in-cursor', PARSE_LINE]]
    for (let i = 0; i < 13; i++) long.push(...SQL.slice(0, 1))
    long.push(['end-of-stmt', 'END OF STMT'], EXEC)
    expect(blockAt(fake(long), 1)).toEqual({ from: 1, to: 14, summary: 'SQL text: 13 lines' })
    const twelve = long.slice(0, 13).concat([['end-of-stmt', 'END OF STMT']])
    expect(blockAt(fake(twelve), 1)).toBeNull() // exactly 12 lines is not "more than 12"
  })
  it('is null on other lines, on a block that is too short and when a line of the block is not loaded', () => {
    expect(blockAt(c, 25)).toBeNull()
    expect(blockAt(fake([['stat', STAT[0][1]], EXEC]), 1)).toBeNull()
    expect(blockAt(fake([['binds', 'BINDS #1:'], EXEC]), 1)).toBeNull()
    expect(blockAt(fake(FILE, [16]), 11)).toBeNull()
    expect(blockAt(fake(FILE, [28]), 27)).toBeNull()
    expect(blockAt(fake(FILE, [11]), 11)).toBeNull()
  })
  it('ends a BINDS block at the end of the file', () => {
    expect(blockAt(fake(BINDS), 1)).toEqual({ from: 1, to: BINDS.length, summary: 'BINDS: 3 binds' })
  })
})

describe('fold mapping', () => {
  const f = (from: number, to: number): Fold => ({ from, to, summary: `${from}-${to}` })
  const folds = [f(10, 20), f(30, 31), f(50, 100)] // hide 10 + 1 + 50 = 61 lines

  it('counts the visible rows', () => {
    expect(visibleCount(1000, [])).toBe(1000)
    expect(visibleCount(1000, folds)).toBe(939)
    expect(visibleCount(1000, indexFolds(folds))).toBe(939)
  })

  it('is the identity without folds', () => {
    for (const r of [0, 1, 99, 12345]) { expect(lineOfRow(r, [])).toBe(r + 1); expect(rowOfLine(r + 1, [])).toBe(r) }
  })

  it('maps rows to lines across several folds', () => {
    const x = indexFolds(folds)
    const lines = [0, 1, 8, 9, 10, 11, 18, 19, 20, 21, 22].map((r) => lineOfRow(r, x))
    // rows 0..8 are lines 1..9, row 9 the handle 10, then 21, 22, ...
    expect(lines).toEqual([1, 2, 9, 10, 21, 22, 29, 30, 32, 33, 34])
    expect(lineOfRow(0, x)).toBe(1)
    // the handle of the last fold: line 50 is row 50-1-11 = 38; the next row is line 101
    expect(lineOfRow(38, x)).toBe(50)
    expect(lineOfRow(39, x)).toBe(101)
    expect(lineOfRow(938, x)).toBe(1000)
  })

  it('maps lines to rows, a hidden line to its handle', () => {
    const x = indexFolds(folds)
    expect(rowOfLine(9, x)).toBe(8)
    expect(rowOfLine(10, x)).toBe(9)
    expect(rowOfLine(15, x)).toBe(9)
    expect(rowOfLine(20, x)).toBe(9)
    expect(rowOfLine(21, x)).toBe(10)
    expect(rowOfLine(30, x)).toBe(19)
    expect(rowOfLine(31, x)).toBe(19)
    expect(rowOfLine(32, x)).toBe(20)
    expect(rowOfLine(75, x)).toBe(38)
    expect(rowOfLine(101, x)).toBe(39)
    expect(rowOfLine(1000, x)).toBe(938)
  })

  it('round-trips every visible row', () => {
    const x = indexFolds(folds)
    for (let r = 0; r < visibleCount(1000, x); r++) expect(rowOfLine(lineOfRow(r, x), x)).toBe(r)
  })

  it('finds the fold of a handle and the fold that hides a line', () => {
    expect(foldAt(30, folds)).toBe(folds[1])
    expect(foldAt(31, folds)).toBeUndefined()
    expect(foldAt(5, [])).toBeUndefined()
    expect(foldHiding(31, folds)).toBe(folds[1])
    expect(foldHiding(30, folds)).toBeUndefined()
    expect(foldHiding(101, folds)).toBeUndefined()
    expect(foldHiding(60, folds)).toBe(folds[2])
  })

  it('adds, removes and keeps the folds sorted and apart', () => {
    let fs: Fold[] = []
    fs = toggleFold(fs, f(30, 31))
    fs = toggleFold(fs, f(10, 20))
    fs = toggleFold(fs, f(50, 100))
    expect(fs.map((x) => x.from)).toEqual([10, 30, 50])
    expect(toggleFold(fs, f(30, 31)).map((x) => x.from)).toEqual([10, 50])
    expect(toggleFold(fs, f(60, 70))).toHaveLength(3) // inside a fold: replaces it
    expect(toggleFold(fs, f(60, 70)).map((x) => x.from)).toEqual([10, 30, 60])
    expect(fs).toHaveLength(3) // the input is not changed
  })
})

describe('table heads', () => {
  // a fold of 3..5 (handle 3) and a table of 8..10 with a head row above line 8
  const folds = withHeads([{ from: 3, to: 5, summary: 'f' }], [[8, 10], [4, 6]])
  it('a table that a fold overlaps gets no head', () => {
    expect(folds.map((f) => [f.from, f.to, !!f.head])).toEqual([[3, 5, false], [8, 10, true]])
  })
  it('the head is a row of its own above the first line; the lines below it move down one row', () => {
    // rows: 0:1 1:2 2:3(fold) 3:6 4:7 5:head 6:8 7:9 8:10 9:11
    expect([0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map((r) => lineOfRow(r, folds))).toEqual([1, 2, 3, 6, 7, 8, 8, 9, 10, 11])
    expect([1, 2, 3, 4, 6, 7, 8, 9, 10, 11].map((l) => rowOfLine(l, folds))).toEqual([0, 1, 2, 2, 3, 4, 6, 7, 8, 9])
    expect(visibleCount(12, folds)).toBe(11)
    expect(headAtRow(5, folds)?.from).toBe(8)
    expect(headAtRow(6, folds)).toBeUndefined()
  })
  it('a head is not a fold', () => {
    expect(foldAt(8, folds)).toBeUndefined()
    expect(foldHiding(9, folds)).toBeUndefined()
    expect(tableOf(9, folds)?.from).toBe(8)
    expect(tableOf(4, folds)).toBeUndefined()
    expect(tableOf(11, folds)).toBeUndefined()
  })
})

describe('filterFolds', () => {
  it('leaves only the kept lines (and line 1, which says what it hides)', () => {
    const f = filterFolds([5, 6, 10], 20, 'Δ ≥ 1 ms')
    expect(f.map(({ from, to, quiet }) => [from, to, !!quiet])).toEqual([[1, 4, false], [6, 9, true], [10, 20, true]])
    expect(f[0].summary).toBe('4 lines before the first Δ ≥ 1 ms')
    // rows: line 1 (the summary), 5, 6, 10
    expect(visibleCount(20, f)).toBe(4)
    expect([0, 1, 2, 3].map((r) => lineOfRow(r, f))).toEqual([1, 5, 6, 10])
    expect(rowOfLine(8, f)).toBe(2) // a hidden line maps to the kept line above it
  })
  it('keeps line 1 as itself when it is kept, and says when nothing is', () => {
    const f = filterFolds([1, 3], 3, 'x')
    expect(visibleCount(3, f)).toBe(2)
    expect(f.every((x) => x.quiet && x.filter && x.auto)).toBe(true)
    const none = filterFolds([], 7, 'Δ ≥ 5 s')
    expect(none).toEqual([{ from: 1, to: 7, summary: 'no Δ ≥ 5 s in this file', auto: true, filter: true }])
    expect(visibleCount(7, none)).toBe(1)
    expect(filterFolds([2], 2, 'x')[0].summary).toBe('1 line before the first x')
  })
})

// the run of 26 `direct path read` waits at io_waits.trc lines 96-121 (bug 11: a go-to to line 118 opened it for good, with no handle to fold it again)
describe('standingFolds: the selection is never folded away', () => {
  const run: Fold = { from: 96, to: 121, summary: '26 × direct path read', label: '26×', auto: true }
  const other: Fold = { from: 264, to: 308, summary: '45 × direct path read', label: '45×', auto: true }
  const own = [run, other]
  it('with the selection outside every fold, all stand (the same array: nothing changed)', () => {
    expect(standingFolds(own, new Set(), undefined)).toBe(own)
    expect(standingFolds(own, new Set(), foldHiding(95, own))).toBe(own)
  })
  it('the handle line of a run is not hidden by it: line 96 selected, the run stays folded into its one handle row', () => {
    expect(foldHiding(96, own)).toBeUndefined()
    expect(standingFolds(own, new Set(), foldHiding(96, own))).toEqual([run, other])
  })
  it('a line inside the run (118) opens that run only, and leaving it folds it again', () => {
    expect(standingFolds(own, new Set(), foldHiding(118, own))).toEqual([other])
    expect(standingFolds(own, new Set(), foldHiding(122, own))).toEqual([run, other])
  })
  it('a fold the user opened stays open whatever is selected', () => {
    expect(standingFolds(own, new Set([264]), foldHiding(118, own))).toEqual([])
    expect(standingFolds(own, new Set([264]), undefined)).toEqual([run])
  })
  it('the folds that stand lay out as one handle row for the run, the rest of the lines after it', () => {
    const stand = standingFolds(own, new Set(), foldHiding(96, own))
    expect(lineOfRow(95, stand)).toBe(96) // the handle
    expect(lineOfRow(96, stand)).toBe(122)
    expect(rowOfLine(96, stand)).toBe(95)
    expect(rowOfLine(122, stand)).toBe(96) // the line after the run follows its handle at once
    expect(visibleCount(1000, stand)).toBe(1000 - 25 - 44)
  })
})

describe('composeFilterFolds: a line filter keeps the view\'s own folds', () => {
  const quiet = (from: number, to: number, more: Partial<Fold> = {}): Fold => ({ from, to, summary: '', auto: true, quiet: true, ...more })
  const cut = (from: number, to: number, more: Partial<Fold> = {}): Fold => ({ from, to, summary: '', auto: true, filter: true, quiet: true, ...more })

  it('keeps a fold of the view inside a kept stretch as it is, between the filter\'s own', () => {
    const framing = quiet(75, 76, { frame: true }) // END OF STMT (76) under the SQL text
    const attrs = quiet(80, 84)
    const out = composeFilterFolds([framing, attrs], [{ ...cut(1, 72), summary: '72 lines before the first statement', quiet: false }, cut(95, 117)])
    expect(out.map((f) => [f.from, f.to])).toEqual([[1, 72], [75, 76], [80, 84], [95, 117]])
    expect(out[1]).toBe(framing)
    expect(out[2]).toBe(attrs)
  })

  it('takes the rule above a cursor (a fold whose handle is a hidden line) into the filter\'s fold, which keeps its own handle and key', () => {
    // the filter hides 96..117 under line 95; the frame fold of the rule at 118 has its handle at 117
    const out = composeFilterFolds([quiet(117, 118, { frame: true })], [cut(95, 117)])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ from: 95, to: 118, filter: true, quiet: true })
    expect(out[0].openKey).toBeUndefined() // the handle is the filter's: opening it is remembered under 95 as before
  })

  it('joins a fold that hides the last kept line before a hidden stretch: its handle stays, the key is the filter fold\'s', () => {
    // the last attribute line of a bind (94) is kept, the filter hides 95..117 under it; the bind row 92 hides 93..94
    const out = composeFilterFolds([quiet(92, 94)], [cut(94, 117)])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ from: 92, to: 117, filter: true, openKey: 94 })
  })

  it('leaves a fold of the view that lies inside a hidden stretch out of the way (nothing shows there)', () => {
    const out = composeFilterFolds([quiet(100, 102), quiet(110, 111)], [cut(95, 117)])
    expect(out.map((f) => [f.from, f.to])).toEqual([[95, 117]])
  })

  it('joins a chain: the rule, then the folds after it', () => {
    const out = composeFilterFolds([quiet(117, 118), quiet(118, 120, { sql: true })], [cut(95, 117)])
    expect(out.map((f) => [f.from, f.to])).toEqual([[95, 120]])
  })

  it('is a linear merge of the two lists in line order', () => {
    const out = composeFilterFolds([quiet(5, 6), quiet(50, 51)], [cut(10, 20), cut(30, 40)])
    expect(out.map((f) => f.from)).toEqual([5, 10, 30, 50])
  })

  it('an empty side is the other side', () => {
    const base = [quiet(5, 6)]
    expect(composeFilterFolds(base, [])).toEqual(base)
    expect(composeFilterFolds([], [cut(1, 9)])).toEqual([cut(1, 9)])
  })
})
