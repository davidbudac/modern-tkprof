import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from './doc'
import { LocalSource } from './source'
import type { ExecTrace, TraceCall, TraceWait } from './exectrace'
import { CallKind, type Event, type Plan, type PlanLine, type RawDocument } from './types'
import {
  buildReplay, cellCenter, chaptersOf, dumpLines, edgePoint, lanesLayout, replayOf, stageLayout,
  type Replay, type RLine,
} from './replay'

const { exec, fetch } = CallKind
const scope = { window: null, files: null, contexts: null, includeIdle: true }
const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
const fixtures = readdirSync(dir).filter((f) => f.startsWith('findings-') && f.endsWith('.json.gz'))
const loadDoc = (f: string) => TraceDoc.fromRaw((JSON.parse(gunzipSync(readFileSync(dir + f)).toString('utf8')) as { doc: RawDocument }).doc)

/** What must hold for any replay. */
function invariants(r: Replay, what: string) {
  for (let i = 1; i < r.segs.length; i++) expect(r.segs[i].a, `${what}: segment ${i} overlaps`).toBeGreaterThanOrEqual(r.segs[i - 1].b - 1)
  expect(r.chapters[0].a).toBe(0)
  expect(r.chapters[r.chapters.length - 1].b).toBe(r.D)
  for (let i = 1; i < r.chapters.length; i++) expect(r.chapters[i].a).toBe(r.chapters[i - 1].b)
  const ts = [0, r.D * 0.25, r.D * 0.5, r.D * 0.75, r.D]
  for (const l of r.lines) {
    let prev = -1
    for (const t of ts) {
      const f = r.fracAt(l, t)
      expect(f, `${what}: line ${l.id} at ${t}`).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(1 + 1e-9)
      expect(f).toBeGreaterThanOrEqual(prev - 1e-9)
      prev = f
    }
  }
  for (const w of r.waits) if (w.line) expect(r.lines).toContain(w.line)
  const lay = stageLayout(r, 720)
  for (const l of r.lines) expect(lay.nodes.get(l)).toBeDefined()
  expect(Number.isFinite(lay.height)).toBe(true)
  expect(lanesLayout(r, 720).rows.length).toBeGreaterThanOrEqual(2)
}

describe('replayOf on io_waits.trc', async () => {
  const d = await loadDoc('findings-io_waits.json.gz')
  const src = new LocalSource(d)
  const replays = (sqlId: string) => {
    const st = d.statements.find((s) => s.sqlId === sqlId)!
    return src.executions(st.id, scope).rows.map((ex) => replayOf(d, st.id, src.executionTrace(st.id, ex)!))
  }
  const ms = (us: number) => (us / 1e3).toFixed(1)
  const line = (r: Replay, id: number) => r.lines.find((l) => l.id === id)!

  it('stmt 22 (7r10y07tqpg98, hash join): three chapters, TEMP on the HASH JOIN, reads by obj#', () => {
    const [r] = replays('7r10y07tqpg98')
    expect(r.match.exact).toBe(true)
    expect(r.lines.map((l) => `${l.id} ${l.op}${l.object ? ' ' + l.object : ''}`)).toEqual(['1 SORT AGGREGATE', '2 HASH JOIN', '3 TABLE ACCESS FULL MTK_CUST', '4 TABLE ACCESS FULL MTK_ORDERS'])
    const hj = line(r, 2)
    expect(hj.selfPw).toBe(276)
    expect([hj.twrites.length, hj.treads.length]).toEqual([276, 5612])
    expect(new Set(hj.treads.map((w) => w.block)).size).toBe(276)
    expect(line(r, 3).reads.reduce((s, w) => s + w.blocks, 0)).toBe(1204)
    expect(line(r, 4).reads.reduce((s, w) => s + w.blocks, 0)).toBe(496)
    expect(r.chapters.map((c) => [ms(c.a), ms(c.b)])).toEqual([['0.0', '84.7'], ['84.7', '521.4'], ['521.4', ms(r.D)]])
    expect(r.chapters[0].label).toBe('MTK_CUST 1,204 blocks read · HASH JOIN 49 TEMP writes (77.9 ms)')
    expect(r.chapters[1].label).toMatch(/^MTK_ORDERS 496 blocks read · HASH JOIN 227 TEMP writes/)
    expect(r.chapters[2].label).toMatch(/^HASH JOIN 5,612 TEMP reads of 276 blocks/)
    for (const l of r.lines) expect(r.rowsAt(l, r.D)).toBeCloseTo(l.rows, 6)
    // the join's rows come in chapters 2 and 3 only (its probe side and its TEMP reads)
    expect(r.rowsAt(hj, r.chapters[1].a)).toBe(0)
    expect(r.rowsAt(hj, r.chapters[2].a)).toBeGreaterThan(0)
    expect(r.rowsAt(hj, r.chapters[2].a)).toBeLessThan(hj.rows)
    expect(r.rowsAt(r.root!, r.D - 1000)).toBe(0) // the one row arrives with the FETCH
    expect(r.data!.distinct).toBe(1700)
    expect(r.temp!.distinct).toBe(276)
    invariants(r, 'stmt 22')
  })

  it('stmt 21 (52nzchs09dgn1, sort): TEMP on SORT ORDER BY, the first row at 2.45 s, 202 fetches', () => {
    const [r] = replays('52nzchs09dgn1')
    const sort = line(r, 1)
    expect([sort.twrites.length, sort.treads.length]).toEqual([1331, 1331])
    expect((r.firstRow! / 1e6).toFixed(2)).toBe('2.45')
    expect(r.calls.filter((c) => c.kind === fetch)).toHaveLength(202)
    expect(r.fetchRows).toBe(100001)
    expect(r.segs.filter((s) => s.type === 'client')).toHaveLength(201)
    expect(r.rowsAt(line(r, 2), r.firstRow! - 1)).toBeCloseTo(100001, 0) // the scan is done before the first row
    invariants(r, 'stmt 21')
  })
})

describe('replayOf on every execution of the findings documents', () => {
  for (const f of fixtures) {
    it(f, async () => {
      const d = await loadDoc(f)
      const src = new LocalSource(d)
      let n = 0
      for (const st of d.statements) {
        for (const ex of src.executions(st.id, scope).rows) {
          const tr = src.executionTrace(st.id, ex)
          if (!tr || !tr.calls.length) continue
          invariants(replayOf(d, st.id, tr), `${f} stmt ${st.id} exec ${ex.execNo}`)
          n++
        }
      }
      expect(n).toBeGreaterThan(0)
    })
  }
})

// ---- synthetic executions: a plan and a trace built here ------------------------------------------------------------

const events: Event[] = ([
  ['SQL*Net message from client', 'Idle', true, 'driver id', '#bytes', ''],
  ['db file sequential read', 'User I/O', false, 'file#', 'block#', 'blocks'],
  ['direct path write temp', 'User I/O', false, 'file number', 'first dba', 'block cnt'],
  ['direct path read temp', 'User I/O', false, 'file number', 'first dba', 'block cnt'],
  ['enq: TX - row lock contention', 'Application', false, 'name|mode', 'usn<<16 | slot', 'sequence'],
] as const).map(([name, cls, idle, p1Name, p2Name, p3Name], id) => ({ id, name, class: cls, idle, p1Name, p2Name, p3Name }))
const EV = { client: 0, seq: 1, tempW: 2, tempR: 3, enq: 4 }

const pl = (id: number, parentId: number, op: string, extra: Partial<PlanLine> = {}): PlanLine => ({
  plan: 0, id, parentId, pos: 1, depth: 0, obj: 0, op, object: '', rows: 10, starts: 1, cr: 0, pr: 0, pw: 0, timeUs: 0, cost: 0, size: 0, card: 0, hasStats: true, ...extra,
})
const call = (id: number, kind: number, tim: number, e: number, r = 0): TraceCall => ({
  id, owner: id, parent: -1, line: id, ctx: 0, kind, cursor: 1, stmt: 0, dep: 0, execNo: 1, c: 0, e, p: 0, cr: 0, cu: 0, r, tim, selfE: e, plh: 1,
})
let wid = 0
const wait = (owner: number, event: number, tim: number, ela: number, o: Partial<TraceWait> = {}): TraceWait => ({
  id: wid++, call: owner, owner, line: 1000 + wid, ctx: 0, event, ela, p1: 0, p2: 0, p3: 0, obj: -1, tim, dep: 0, between: false, ...o,
})
const exact = { plan: null, lines: [], exact: true, fromExecNo: 1 }

describe('buildReplay on synthetic executions', () => {
  // SORT ORDER BY (1) ← TABLE ACCESS BY INDEX ROWID T (2, obj 50) ← INDEX RANGE SCAN I (3, obj 51); a FETCH of 10 rows
  const plan = [
    pl(1, 0, 'SORT ORDER BY', { pw: 1 }),
    pl(2, 1, 'TABLE ACCESS BY INDEX ROWID T', { obj: 50, object: 'T', pw: 0 }),
    pl(3, 2, 'INDEX RANGE SCAN I', { obj: 51, object: 'I' }),
  ]
  const trace: ExecTrace = {
    calls: [call(1, exec, 1_000, 100), call(2, fetch, 3_000, 1_900, 10)],
    children: [],
    waits: [
      wait(2, EV.seq, 1_300, 100, { p1: 4, p2: 10, p3: 1, obj: 51 }),
      wait(2, EV.seq, 1_500, 100, { p1: 4, p2: 20, p3: 1, obj: 50 }),
      wait(2, EV.seq, 1_700, 100, { p1: 4, p2: 21, p3: 1, obj: 50 }),
      wait(2, EV.tempW, 2_000, 100, { p1: 201, p2: 5, p3: 1, obj: 50 }),
      wait(2, EV.tempR, 2_400, 100, { p1: 201, p2: 5, p3: 1, obj: 50 }),
      wait(2, EV.seq, 2_600, 50, { p1: 4, p2: 99, p3: 1, obj: 77 }),
    ],
    truncated: false,
  }

  it('lines by obj#, TEMP on the line that wrote it, a read of an unknown obj# only in the grid', () => {
    const r = buildReplay({ events, trace, lines: plan, match: exact })
    const [sort, tab, ix] = r.lines
    expect(r.lines.map((l) => [l.op, l.object, l.depth])).toEqual([['SORT ORDER BY', '', 0], ['TABLE ACCESS BY INDEX ROWID', 'T', 1], ['INDEX RANGE SCAN', 'I', 2]])
    expect([ix.reads.length, tab.reads.length, sort.twrites.length, sort.treads.length]).toEqual([1, 2, 1, 1])
    const unknown = r.waits.find((w) => w.obj === 77)!
    expect([unknown.kind, unknown.line]).toEqual(['read', null])
    expect(r.data!.distinct).toBe(4)
    expect(r.data!.files).toEqual([4])
    expect(r.temp!.distinct).toBe(1)
    // the clock starts at the EXEC: 900 µs before the EXEC's end at tim 1000
    expect(r.t0).toBe(900)
    expect(r.D).toBe(2_100)
    // CPU between the index read and the table read is on the path between them
    const seg = r.segAt(1_300 - 900 + 50)
    expect(seg?.type).toBe('cpu')
    expect(seg?.type === 'cpu' && [...seg.lines.keys()].map((l) => l.id)).toEqual([3, 2])
    // the sort's rows come after its input is done; the root follows the fetch
    expect(r.rowsAt(sort, r.D - 2)).toBe(0)
    expect(r.rowsAt(sort, r.D)).toBe(10)
    expect(r.doneAt(tab)).toBeCloseTo(1_700 - 900, 0)
  })

  it('STAT of another execution: no rows inferred below the root', () => {
    const r = buildReplay({ events, trace, lines: plan, match: { plan: null, lines: [], exact: false, fromExecNo: 1 } })
    expect(r.rowsKnown).toBe(false)
    expect(r.rowsAt(r.lines[1], r.D)).toBeNaN()
    expect(r.rowsAt(r.root!, r.D)).toBe(10)
  })

  it('a call without waits spreads its CPU by self time; a branch that never started stays at 0', () => {
    const lines = [
      pl(1, 0, 'HASH JOIN', { timeUs: 1000, rows: 5 }),
      pl(2, 1, 'TABLE ACCESS FULL A', { obj: 1, object: 'A', timeUs: 600 }),
      pl(3, 1, 'TABLE ACCESS FULL B', { obj: 2, object: 'B', timeUs: 100 }),
      pl(4, 1, 'INDEX RANGE SCAN C', { obj: 3, object: 'C', starts: 0, rows: 0 }),
    ]
    const tr: ExecTrace = { calls: [call(1, exec, 100, 10), call(2, fetch, 600, 400, 5)], children: [], waits: [], truncated: false }
    const r = buildReplay({ events, trace: tr, lines, match: exact })
    const seg = r.segAt(300)
    expect(seg?.type).toBe('cpu')
    if (seg?.type !== 'cpu') return
    expect(seg.spread).toBe(true)
    expect([...seg.lines].map(([l, v]) => [l.id, +v.toFixed(2)])).toEqual([[1, 0.5], [2, 1], [3, 0.17]])
    expect(r.lines[3].inactive).toBe(true)
    expect(r.fracAt(r.lines[3], r.D)).toBe(0)
    expect(stageLayout(r, 720).mode).toBe('cards')
  })

  it('client think time between fetches is a client segment; an enqueue is an other wait', () => {
    const tr: ExecTrace = {
      calls: [call(1, exec, 1_000, 100), call(2, fetch, 1_200, 100, 5), call(3, fetch, 2_000, 100, 5)],
      children: [],
      waits: [wait(1, EV.enq, 1_000, 50), wait(3, EV.client, 1_890, 680, { between: true })],
      truncated: false,
    }
    const r = buildReplay({ events, trace: tr, lines: plan, match: exact })
    expect(r.waits.map((w) => w.kind)).toEqual(['other', 'client'])
    expect(r.segAt(1_500 - 900)?.type).toBe('client')
    expect(r.chapters).toHaveLength(1)
    expect(r.chapters[0].label).toBe('enq: TX - row lock contention ×1 (50 µs) · 2 fetches, 10 rows')
  })

  it('no plan: an empty stage, the lanes still', () => {
    const r = buildReplay({ events, trace, lines: [], match: { plan: null, lines: [], exact: false, fromExecNo: 0 } })
    expect(r.root).toBeNull()
    expect(r.waits.filter((w) => w.kind === 'read').every((w) => w.line === null)).toBe(true)
    expect(lanesLayout(r, 600).rows.map((x) => x.kind)).toEqual(['cpu', 'client'])
  })
})

describe('layout', () => {
  const mk = (n: number): RLine[] => {
    const lines = Array.from({ length: n }, (_, i) => pl(i + 1, i, i === n - 1 ? 'TABLE ACCESS FULL T' : 'NESTED LOOPS', i === n - 1 ? { obj: 9, object: 'T' } : {}))
    return buildReplay({ events, trace: { calls: [call(1, exec, 10, 5)], children: [], waits: [], truncated: false }, lines, match: exact }).lines
  }
  it('a deep plan is a tree of rows in dump order; rows leave a child to the left and climb to the parent', () => {
    const lines = mk(6)
    const lay = stageLayout({ lines, root: lines[0], data: null, temp: null }, 720)
    expect(lay.mode).toBe('tree')
    const ys = lines.map((l) => lay.nodes.get(l)!.y)
    expect(ys).toEqual([...ys].sort((a, b) => a - b))
    const [x0, y0] = edgePoint(lay, lines[1], lines[0], 0), [x1, y1] = edgePoint(lay, lines[1], lines[0], 1)
    expect(x1).toBeLessThan(x0)
    expect(y1).toBeLessThan(y0)
    expect(lay.nodes.get(lines[0])!.w).toBe(720 - 16) // no grids: the tree takes the width
  })
  it('cells fill a grid row by row', () => {
    const b = { grid: null as never, x: 10, y: 20, w: 100, h: 40, cell: 10, cols: 10 }
    expect(cellCenter(b, 0)).toEqual([15, 25])
    expect(cellCenter(b, 11)).toEqual([25, 35])
  })
  it('a dump the model split (optimizer lines between its STAT lines) is joined; the next dump is not', () => {
    // opt_interleaved.trc, 8a01tvd45h89r: STAT id=1 / kkeCostToTime… / id=2 / … / id=3..5: plans of 1, 1 and 3 lines
    const lines = [pl(1, 0, 'HASH GROUP BY'), pl(2, 1, 'HASH JOIN'), pl(3, 2, 'NESTED LOOPS'), pl(4, 3, 'NESTED LOOPS'), pl(5, 4, 'STATISTICS COLLECTOR'), pl(1, 0, 'HASH GROUP BY')]
    const plan = (id: number, line: number, first: number, n: number, cursor = 4): Plan => ({ id, line, cursor, statement: 4, planHash: 9, first, n })
    const plans = [plan(0, 100, 0, 1), plan(1, 104, 1, 1), plan(2, 108, 2, 3), plan(3, 300, 5, 1)]
    expect(dumpLines(plans, lines, plans[0]).map((l) => l.id)).toEqual([1, 2, 3, 4, 5])
    expect(dumpLines(plans, lines, plans[3]).map((l) => l.id)).toEqual([1])
    expect(dumpLines([plan(0, 100, 0, 1), plan(1, 104, 1, 1, 5)], lines, plan(0, 100, 0, 1)).map((l) => l.id)).toEqual([1]) // another cursor
  })
  it('chapters: one when nothing is on a line', () => {
    expect(chaptersOf([], [], 500)).toEqual([{ i: 0, a: 0, b: 500, key: 'all', label: 'CPU' }])
  })
})
