import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from './doc'
import { blocksParam, extentsOf, IO, IOMAP_COLS, ioMapOf, isBlockIO, isFileP1, mergeRuns, normalizeIOMap, orderToTime, rereadOf, sampleStep, type IOMap } from './iomap'
import { makeDoc, type WaitSpec } from './testdoc'
import type { Event, RawDocument } from './types'
import ioMapCase from './testdata/iomap-case.json'

const ev = (id: number, name: string, p1Name: string, p2Name: string, p3Name: string, cls = 'User I/O', idle = false): Event => ({ id, name, class: cls, p1Name, p2Name, p3Name, idle })

// Same file as TestIOMapSharedCase in internal/analyze/iomap_test.go: the two implementations must give the same answers.
describe('ioMapOf on the shared case', () => {
  const w = ioMapCase.waits
  const waits: WaitSpec[] = Array.from({ length: w.n }, (_, i) => ({
    ctx: w.ctx[i], stmt: w.stmt[i], event: w.event[i], ela: w.ela[i], tim: w.tim[i], line: w.line[i], call: w.call[i],
    p1: w.p1[i], p2: w.p2[i], p3: w.p3[i], obj: w.obj[i], dep: w.dep[i], flags: w.flags[i],
  }))
  it.each(ioMapCase.cases.map((c, k) => [k, c] as const))('case %d gives the engine\'s answer', async (_, c) => {
    const doc = await makeDoc([], { waits, events: ioMapCase.events as Event[] })
    const q = c as { limit: number; stmt?: number; from?: number; to?: number }
    const window = q.from || q.to ? { startTim: q.from || -Infinity, endTim: q.to || Infinity } : null
    expect(ioMapOf(doc, { window, contexts: null }, q.limit, q.stmt)).toEqual(c.expect)
  })
})

describe('isBlockIO / blocksParam', () => {
  it('classify by the parameter names', () => {
    const block = [
      ev(0, 'db file sequential read', 'file#', 'block#', 'blocks'),
      ev(1, 'direct path read', 'file number', 'first dba', 'block cnt'),
      ev(2, 'direct path write temp', 'file number', 'first dba', 'block cnt'),
      ev(3, 'gc current request', 'file#', 'block#', 'id#', 'Cluster'),
      ev(4, 'some future read', 'file#', 'block#', 'blocks'),
    ]
    const not = [
      ev(6, 'db file parallel read', 'files', 'blocks', 'requests'),
      ev(7, 'Disk file operations I/O', 'FileOperation', 'fileno', 'filetype'),
      ev(8, 'gc cr block 2-way', '', '', '', 'Cluster'),
      ev(9, 'SQL*Net message from client', 'driver id', '#bytes', '', 'Idle', true),
      // p1 is a control file's number, not a datafile's
      ev(10, 'control file sequential read', 'file#', 'block#', 'blocks', 'System I/O'),
      ev(11, 'control file single write', 'file#', 'block#', 'blocks', 'System I/O'),
      ev(12, 'control file parallel write', 'files', 'block#', 'requests', 'System I/O'),
    ]
    expect(block.map(isBlockIO)).toEqual(block.map(() => true))
    expect(not.map(isBlockIO)).toEqual(not.map(() => false))
    expect(block.map(blocksParam)).toEqual([true, true, true, false, true])
    expect(not.slice(-3).map(isFileP1)).toEqual([false, false, false])
  })
})

describe('ioMapOf', () => {
  const events = [
    ev(0, 'db file sequential read', 'file#', 'block#', 'blocks'),
    ev(1, 'direct path read', 'file number', 'first dba', 'block cnt'),
    ev(2, 'SQL*Net message from client', 'driver id', '#bytes', '', 'Idle', true),
    ev(3, 'gc current request', 'file#', 'block#', 'id#', 'Cluster'),
  ]
  const wait = (i: number, o: Partial<WaitSpec>): WaitSpec => ({ ctx: 0, stmt: 0, event: 1, ela: 10, tim: 1000 + 100 * i, p1: 7, p2: 100 + 8 * i, p3: 8, obj: 42, ...o })

  it('keeps every k-th match above the limit, files and events over all of them', async () => {
    const waits = Array.from({ length: 10 }, (_, i) => wait(i, {}))
    waits.splice(3, 0, { ctx: 0, stmt: 0, event: 2, ela: 5, tim: 1350, idle: true }) // not block I/O: never counted
    const doc = await makeDoc([], { waits, events })
    const m = ioMapOf(doc, { window: null, contexts: null }, 3)
    expect(m.total).toBe(10)
    expect(m.sampled).toBe(true) // k = ceil(10 / 3) = 4: matches 0, 4, 8
    expect(m.rows.map((r) => r[IO.block])).toEqual([100, 132, 164])
    expect(m.files).toEqual([{ file: 7, lo: 100, hi: 100 + 8 * 9 + 8, n: 10 }])
    expect(m.events).toEqual([1])
    expect(m.cols).toEqual([...IOMAP_COLS])
    expect(sampleStep(m)).toBe(4)
    const all = ioMapOf(doc, { window: null, contexts: null }, 20000)
    expect(all.sampled).toBe(false)
    expect(all.rows).toHaveLength(10)
    expect(sampleStep(all)).toBe(1)
    expect(all.rows[0]).toEqual([1000, 10, 1, 7, 100, 8, 42, 0, -1, 1, 0, 0])
  })

  it('counts p3 as blocks only for a block-count parameter that is positive, and sorts the files', async () => {
    const doc = await makeDoc([], { events, waits: [
      wait(0, { event: 0, p1: 12, p2: 500, p3: 1 }),
      wait(1, { event: 3, p1: 3, p2: 900, p3: 77 }), // gc current request: p3 is an id, one block
      wait(2, { event: 1, p1: 12, p2: 400, p3: 0 }), // a zero count: one block
      wait(3, { event: 1, p1: 12, p2: 600, p3: 32 }),
    ] })
    const m = ioMapOf(doc, { window: null, contexts: null }, 100)
    expect(m.rows.map((r) => r[IO.blocks])).toEqual([1, 1, 1, 32])
    expect(m.files).toEqual([{ file: 3, lo: 900, hi: 901, n: 1 }, { file: 12, lo: 400, hi: 632, n: 3 }])
    expect(m.events).toEqual([0, 1, 3])
  })

  it('follows the window (overlap of [tim-ela, tim]), the contexts, the statement and the event; idle flags never match', async () => {
    const doc = await makeDoc([], { events, waits: [
      wait(0, { tim: 1000, ela: 100 }), // [900, 1000]
      wait(1, { tim: 2000, ela: 100, ctx: 1, stmt: 1 }),
      wait(2, { tim: 3000, ela: 100, event: 0 }),
      wait(3, { tim: 3500, ela: 10, flags: 2 }), // flagged idle: not block I/O whatever its event
    ] })
    const all = { window: null, contexts: null }
    expect(ioMapOf(doc, all, 100).total).toBe(3)
    expect(ioMapOf(doc, { window: { startTim: 950, endTim: 1950 }, contexts: null }, 100).rows.map((r) => r[IO.tim])).toEqual([1000, 2000])
    expect(ioMapOf(doc, { window: { startTim: 1001, endTim: 1899 }, contexts: null }, 100).total).toBe(0)
    expect(ioMapOf(doc, { window: null, contexts: new Set([1]) }, 100).rows.map((r) => r[IO.tim])).toEqual([2000])
    const none = ioMapOf(doc, { window: null, contexts: new Set() }, 100)
    expect(none).toEqual({ total: 0, sampled: false, cols: [...IOMAP_COLS], rows: [], files: [], events: [] })
    expect(ioMapOf(doc, all, 100, 1).total).toBe(1)
    expect(ioMapOf(doc, all, 100, undefined, 0).rows.map((r) => r[IO.tim])).toEqual([3000])
  })

  it('reorders the rows of an answer with other columns', () => {
    const m: IOMap = { total: 1, sampled: false, cols: ['ela', 'tim', 'event', 'file', 'block', 'blocks', 'obj', 'stmt', 'call', 'line', 'ctx', 'dep', 'extra'], rows: [[5, 100, 1, 7, 9, 1, -1, 0, -1, 3, 0, 0, 99]], files: [], events: [1] }
    expect(normalizeIOMap(m).rows).toEqual([[100, 5, 1, 7, 9, 1, -1, 0, -1, 3, 0, 0]])
    const same: IOMap = { ...m, cols: [...IOMAP_COLS], rows: [] }
    expect(normalizeIOMap(same)).toBe(same)
  })
})

// rows: [tim, ela, event, file, block, blocks, obj, stmt, call, line, ctx, dep]
const row = (o: { tim?: number; ela?: number; event?: number; file?: number; block: number; blocks?: number; obj?: number; stmt?: number }) =>
  [o.tim ?? 0, o.ela ?? 1, o.event ?? 0, o.file ?? 12, o.block, o.blocks ?? 1, o.obj ?? 42, o.stmt ?? 0, -1, 1, 0, 0]

describe('extentsOf', () => {
  it('merges the overlapping ranges of one object in one file, keeps touching ones apart', () => {
    const rows = [
      row({ block: 100, blocks: 8 }), row({ block: 104, blocks: 8 }), // overlap: [100, 112)
      row({ block: 112, blocks: 8 }), // touches: its own run
      row({ block: 200, blocks: 4 }), row({ block: 200, blocks: 4 }), // read twice: once
      row({ block: 50, blocks: 8, obj: 7 }), row({ block: 300, file: 13 }), row({ block: 400, event: 9 }),
    ]
    expect(extentsOf(rows, 42, 12, (r) => r[IO.event] !== 9)).toEqual([{ lo: 100, hi: 112 }, { lo: 112, hi: 120 }, { lo: 200, hi: 204 }])
    expect(extentsOf(rows, 7, 12)).toEqual([{ lo: 50, hi: 58 }])
    expect(extentsOf(rows, 99, 12)).toEqual([])
    expect(mergeRuns([{ lo: 5, hi: 9 }, { lo: 1, hi: 20 }, { lo: 30, hi: 31 }])).toEqual([{ lo: 1, hi: 20 }, { lo: 30, hi: 31 }])
  })
})

describe('rereadOf', () => {
  it('counts reads, writes, distinct blocks and reads per block per statement and file', () => {
    const WRITE = 1
    // statement 1 writes blocks 10..19 of file 203 once and reads each of them twice; statement 2 reads 8 blocks once in file 12
    const rows: number[][] = []
    for (let b = 10; b < 20; b++) rows.push(row({ stmt: 1, file: 203, block: b, event: WRITE, ela: 3 }))
    for (let pass = 0; pass < 2; pass++) for (let b = 10; b < 20; b++) rows.push(row({ stmt: 1, file: 203, block: b, ela: 1 }))
    rows.push(row({ stmt: 2, file: 12, block: 100, blocks: 8, ela: 2 }))
    rows.push(row({ stmt: 1, file: 12, block: 100, blocks: 8, ela: 2 }))
    const rr = rereadOf(rows, (e) => e === WRITE)
    expect(rr.map((r) => [r.key, r.file])).toEqual([[1, 203], [1, 12], [2, 12]]) // largest time first
    expect(rr[0]).toEqual({ key: 1, file: 203, reads: 20, readBlocks: 20, readDistinct: 10, writes: 10, writeBlocks: 10, writeDistinct: 10, readsPerBlock: 2, us: 50 })
    expect(rr[2]).toMatchObject({ reads: 1, readBlocks: 8, readDistinct: 8, readsPerBlock: 1, writes: 0 })
    const byObj = rereadOf(rows, (e) => e === WRITE, 'obj')
    expect(byObj.map((r) => [r.key, r.file, r.reads])).toEqual([[42, 203, 20], [42, 12, 2]])
    expect(byObj[1].readsPerBlock).toBe(2)
  })
})

describe('orderToTime', () => {
  const rows = [row({ tim: 1000, ela: 50, block: 1 }), row({ tim: 2000, ela: 10, block: 2 }), row({ tim: 1900, ela: 500, block: 3 }), row({ tim: 4000, ela: 100, block: 4 })]
  it('spans from the start of the first wait to the end of the last of the brushed rows', () => {
    expect(orderToTime(rows, 0, 1)).toEqual({ startTim: 950, endTim: 2000 })
    expect(orderToTime(rows, 3, 1)).toEqual({ startTim: 1400, endTim: 4000 }) // either order; the extremes (row 2 starts before row 1)
    expect(orderToTime(rows, -5, 99)).toEqual({ startTim: 950, endTim: 4000 })
    expect(orderToTime(rows, 1.4, 1.6)).toEqual({ startTim: 1400, endTim: 2000 })
    expect(orderToTime([], 0, 3)).toBeNull()
  })
})

// § 1 of docs/PLAN-VIEWS.md on the real document of testdata/traces/19c/io_waits.trc (findings-io_waits.json.gz, written by
// internal/report TestFindingsDocsCurrent): the numbers the Blocks view must reproduce.
describe('ioMapOf on io_waits.trc', async () => {
  const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
  const d = await TraceDoc.fromRaw((JSON.parse(gunzipSync(readFileSync(dir + 'findings-io_waits.json.gz')).toString('utf8')) as { doc: RawDocument }).doc)
  const all = { window: null, contexts: null }
  const m = ioMapOf(d, all, 20000)
  const stmtOf = (sqlId: string) => d.statements.find((s) => s.sqlId === sqlId)!.id
  const temp = (e: number) => /\btemp\b/.test(d.events[e].name)
  const write = (e: number) => /\bwrites?\b/.test(d.events[e].name)
  /** direct reads / temp writes / temp reads of one statement */
  const kinds = (stmt: number) => {
    const rows = ioMapOf(d, all, 20000, stmt).rows
    return [rows.filter((r) => !temp(r[IO.event])).length, rows.filter((r) => temp(r[IO.event]) && write(r[IO.event])).length, rows.filter((r) => temp(r[IO.event]) && !write(r[IO.event])).length]
  }

  it('has 8,747 block I/O waits in files 10, 12 and tempfile 203, unsampled at the default limit', () => {
    expect(m.total).toBe(8747)
    expect(m.sampled).toBe(false)
    expect(m.rows).toHaveLength(8747)
    expect(m.files.map((f) => [f.file, f.n])).toEqual([[10, 3], [12, 194], [203, 8550]])
    expect(m.files.slice(1).map((f) => [f.lo, f.hi])).toEqual([[167795, 172288], [756103, 756743]])
  })

  it('splits the hash join and the sort into direct reads, temp writes and temp reads', () => {
    expect(kinds(stmtOf('7r10y07tqpg98'))).toEqual([71, 276, 5612])
    expect(kinds(stmtOf('52nzchs09dgn1'))).toEqual([26, 1331, 1331])
  })

  it('gives the extents of MTK_ORDERS and MTK_CUST, the 639 temp blocks of the sort and the 20.3 reads per block of the join', () => {
    const notTemp = (r: number[]) => !temp(r[IO.event])
    const orders = extentsOf(m.rows, 108611, 12, notTemp), cust = extentsOf(m.rows, 108609, 12, notTemp)
    expect([orders.length, orders.reduce((a, r) => a + r.hi - r.lo, 0)]).toEqual([26, 496])
    expect([cust.length, cust.reduce((a, r) => a + r.hi - r.lo, 0)]).toEqual([45, 1204])
    const rr = rereadOf(m.rows, write)
    const sort = rr.find((r) => r.key === stmtOf('52nzchs09dgn1') && r.file === 203)!
    expect([sort.writes, sort.writeDistinct]).toEqual([1331, 639])
    const join = rr.find((r) => r.key === stmtOf('7r10y07tqpg98') && r.file === 203)!
    expect([join.reads, join.readDistinct, join.readsPerBlock.toFixed(1)]).toEqual([5612, 276, '20.3'])
  })

  it('shows 1 in 2 at a limit of 5,000', () => {
    const s = ioMapOf(d, all, 5000)
    expect([s.total, s.sampled, sampleStep(s), s.rows.length]).toEqual([8747, true, 2, 4374])
    expect(s.files).toEqual(m.files)
  })
})
