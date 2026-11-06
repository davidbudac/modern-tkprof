import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from './doc'
import { LocalSource } from './source'
import type { ExecTrace, TraceCall, TraceWait } from './exectrace'
import { CallKind, type Event, type RawDocument } from './types'
import { makeDoc } from './testdoc'
import {
  actHeight, dialogueLayout, dialogueOf, lifelineOf, median, GUTTER, LANE_W, MAX_ARROWS, MAX_STEPS, MIN_W, REC_LABEL_W, REC_X, readsFrom,
  type Dialogue, type Frame, type Turn,
} from './dialogue'

const { parse, exec, fetch } = CallKind

// Synthetic executions (rows for the pure transform, not a trace file): the events as Oracle 19c names and classes them.
const EV = { fromClient: 0, toClient: 1, moreData: 2, tempW: 3, tempR: 4, seq: 5, enq: 6, logSync: 7, ctlRead: 8, lockTimer: 9, latch: 10, dblink: 11 }
const events: Event[] = ([
  ['SQL*Net message from client', 'Idle', true, 'driver id'],
  ['SQL*Net message to client', 'Network', false, 'driver id'],
  ['SQL*Net more data to client', 'Network', false, 'driver id'],
  ['direct path write temp', 'User I/O', false, 'file number'],
  ['direct path read temp', 'User I/O', false, 'file number'],
  ['db file sequential read', 'User I/O', false, 'file#'],
  ['enq: TX - row lock contention', 'Application', false, 'name|mode'],
  ['log file sync', 'Commit', false, 'buffer#'],
  ['control file sequential read', 'System I/O', false, 'file#'],
  ['PL/SQL lock timer', 'Idle', true, 'duration'],
  ['latch: shared pool', 'Concurrency', false, 'address'],
  ['SQL*Net message from dblink', 'Network', false, 'driver id'],
] as const).map(([name, cls, idle, p1Name], id) => ({ id, name, class: cls, idle, p1Name, p2Name: '', p3Name: '' }))
const doc = { events }

interface WSpec { ev: number; ela: number; p1?: number }
interface ChildSpec {
  stmt: number; kind: number; e: number; c?: number; dep?: number; waits?: WSpec[]
  /** between waits of the child inside the own call's time (part of the call, not a gap) */
  betweenIn?: WSpec[]
  /** between waits of the child before the own call started (a gap) */
  betweenOut?: WSpec[]
}
interface CSpec {
  kind: number; e: number; c?: number; r?: number
  /** the between waits before the call: a number is one SQL*Net message from client of that many µs */
  gap?: number | WSpec[]
  /** in-call waits */
  waits?: WSpec[]
  children?: ChildSpec[]
}

/** An execution trace on a clock: each call starts after the gap before it and ends e µs later; waits sit inside or before. */
function trace(spec: CSpec[], t0 = 1_000_000): ExecTrace {
  const calls: TraceCall[] = [], children: TraceCall[] = [], waits: TraceWait[] = []
  let line = 100, t = t0, wid = 0, chid = 5000
  const base = { parent: -1, ctx: 0, cursor: 1, stmt: 0, dep: 0, execNo: 1, c: 0, p: 0, cr: 0, cu: 0, r: 0, plh: 1 }
  const wait = (w: WSpec, call: number, owner: number, tim: number, between: boolean, dep = 0) => {
    waits.push({ id: wid++, call, owner, line: line++, ctx: 0, event: w.ev, ela: w.ela, p1: w.p1 ?? -1, p2: 0, p3: 0, obj: -1, tim, dep, between })
  }
  spec.forEach((s, k) => {
    const id = 1000 + k
    const gaps = typeof s.gap === 'number' ? [{ ev: EV.fromClient, ela: s.gap }] : s.gap ?? []
    for (const g of gaps) { t += g.ela; wait(g, id, id, t, true) }
    const start = t, tim = t + s.e
    for (const ch of s.children ?? []) {
      const cid = chid++
      for (const w of ch.betweenOut ?? []) wait(w, cid, id, start, true, 1) // tim = start: not inside (start, tim]
      for (const w of ch.betweenIn ?? []) wait(w, cid, id, start + 2, true, 1)
      for (const w of ch.waits ?? []) wait(w, cid, id, start + 1, false, 1)
      children.push({ ...base, id: cid, owner: id, parent: id, line: line++, kind: ch.kind, stmt: ch.stmt, dep: ch.dep ?? 1, c: ch.c ?? 0, e: ch.e, tim: start + 3, selfE: ch.e })
    }
    for (const w of s.waits ?? []) wait(w, id, id, start + 1, false)
    calls.push({ ...base, id, owner: id, line: line++, kind: s.kind, c: s.c ?? 0, e: s.e, r: s.r ?? 0, tim, selfE: s.e })
    t = tim
  })
  return { calls, children, waits, truncated: false }
}

const turnsOf = (d: Dialogue): Turn[] => d.steps.flatMap((s) => (s.type === 'turn' ? [s.turn] : s.frame.turns))
const frameAt = (d: Dialogue, k: number): Frame => {
  const s = d.steps[k]
  if (s.type !== 'frame') throw new Error(`step ${k} is a ${s.type}`)
  return s.frame
}
const turnAt = (d: Dialogue, k: number): Turn => {
  const s = d.steps[k]
  if (s.type !== 'turn') throw new Error(`step ${k} is a ${s.type}`)
  return s.turn
}
const sum = (xs: number[]) => xs.reduce((a, x) => a + x, 0)

describe('dialogueOf: collapse', () => {
  it('200 alike fetches collapse into one frame; the first fetch (1 row) and the last (0 rows) stay turns', () => {
    const es = Array.from({ length: 200 }, (_, i) => 170 + (i % 7))
    const gs = Array.from({ length: 200 }, (_, i) => 1500 + (i % 5) * 10)
    const d = dialogueOf(doc, trace([
      { kind: parse, e: 1350, c: 900 },
      { kind: exec, e: 13, c: 13 },
      { kind: fetch, e: 2_448_000, c: 115_000, r: 1, waits: [{ ev: EV.tempW, ela: 2_000_000, p1: 201 }] },
      ...es.map((e, i): CSpec => ({ kind: fetch, e, c: 100, r: 500, gap: gs[i], waits: [{ ev: EV.moreData, ela: 30 }] })),
      { kind: fetch, e: 43, c: 40, r: 0, gap: 1490 },
    ]))
    expect(d.steps.map((s) => s.type)).toEqual(['turn', 'turn', 'turn', 'frame', 'turn'])
    expect(turnAt(d, 2)).toMatchObject({ kind: fetch, rows: 1, ordinal: 1, outlier: null })
    const f = frameAt(d, 3)
    expect(f).toMatchObject({ n: 200, kind: fetch, rows: 500, serverUs: sum(es), gapUs: sum(gs), cpuUs: 200 * 100, medianEla: median(es), medianGap: median(gs) })
    expect(f.turns.map((t) => t.ordinal)).toEqual(Array.from({ length: 200 }, (_, i) => i + 2))
    expect(f.turns.every((t) => t.outlier === null)).toBe(true)
    expect(f.net.moreData).toMatchObject({ event: EV.moreData, n: 200, us: 6000 })
    expect(f.gapWaits).toMatchObject([{ event: EV.fromClient, n: 200, us: sum(gs) }])
    expect(turnAt(d, 4)).toMatchObject({ rows: 0, ordinal: 202, gapBefore: 1490 })
    // PARSE, EXEC and FETCH #1 go in one round trip (no client gap between them), then one per fetch
    expect(d.trips).toBe(202)
    expect(turnsOf(d).slice(0, 3).map((t) => t.endsTrip)).toEqual([false, false, true])
    expect(d.rowsPerTrip).toBe(500)
    expect(d.rows).toBe(100_001)
    expect(d.calls).toBe(204)
    expect(d.ttfrUs).toBe(1350 + 13 + 2_448_000)
  })

  it('an iteration 20× the median elapsed leaves its run, which becomes frame, turn, frame', () => {
    const d = dialogueOf(doc, trace(Array.from({ length: 41 }, (_, i): CSpec => ({ kind: fetch, e: i === 20 ? 2000 : 100, r: 15, gap: 60 }))))
    expect(d.steps.map((s) => s.type)).toEqual(['frame', 'turn', 'frame'])
    expect(frameAt(d, 0).n).toBe(20)
    expect(turnAt(d, 1)).toMatchObject({ ela: 2000, outlier: 'ela', runMedian: { ela: 100, gap: 60 }, ordinal: 21 })
    expect(frameAt(d, 2).n).toBe(20)
    // every turn is in exactly one step, in trace order
    expect(turnsOf(d).map((t) => t.ordinal)).toEqual(Array.from({ length: 41 }, (_, i) => i + 1))
  })

  it('a gap 10× the median gap leaves the run too (outlier "gap")', () => {
    const d = dialogueOf(doc, trace(Array.from({ length: 10 }, (_, i): CSpec => ({ kind: fetch, e: 50, r: 15, gap: i === 9 ? 5000 : 70 }))))
    expect(d.steps.map((s) => s.type)).toEqual(['frame', 'turn'])
    expect(turnAt(d, 1)).toMatchObject({ outlier: 'gap', gapBefore: 5000 })
  })

  it('pieces of a run shorter than minRun stay turns; runs of unequal rows do not merge', () => {
    const d = dialogueOf(doc, trace([100, 5000, 100, 100, 100].map((e): CSpec => ({ kind: fetch, e, r: 10, gap: 50 }))))
    expect(d.steps.map((s) => (s.type === 'turn' ? s.turn.outlier ?? 'turn' : `frame ${s.frame.n}`))).toEqual(['turn', 'ela', 'frame 3'])
    const alt = dialogueOf(doc, trace(Array.from({ length: 9 }, (_, i): CSpec => ({ kind: fetch, e: 100, r: i % 2 ? 10 : 20, gap: 50 }))))
    expect(alt.steps.every((s) => s.type === 'turn')).toBe(true)
    const two = dialogueOf(doc, trace([{ kind: fetch, e: 10, r: 5 }, { kind: fetch, e: 10, r: 5 }]))
    expect(two.steps.map((s) => s.type)).toEqual(['turn', 'turn'])
  })

  it('the thresholds are options; medians below floorUs count as floorUs', () => {
    const t = trace(Array.from({ length: 41 }, (_, i): CSpec => ({ kind: fetch, e: i === 20 ? 2000 : 100, r: 15, gap: 60 })))
    expect(dialogueOf(doc, t, { minRun: 50 }).steps.every((s) => s.type === 'turn' && s.turn.outlier === null)).toBe(true)
    expect(dialogueOf(doc, t, { outlierX: 30 }).steps.map((s) => s.type)).toEqual(['frame'])
    // 2 µs calls with one of 60 µs: timer noise, not an outlier (60 < 10 × 10 µs)
    const tiny = trace(Array.from({ length: 6 }, (_, i): CSpec => ({ kind: fetch, e: i === 3 ? 60 : 2, r: 1, gap: 20 })))
    expect(dialogueOf(doc, tiny).steps.map((s) => s.type)).toEqual(['frame'])
    expect(dialogueOf(doc, tiny, { floorUs: 1 }).steps.map((s) => s.type)).toEqual(['frame', 'turn', 'turn', 'turn'])
  })
})

describe('dialogueOf: attribution', () => {
  it('between waits are the client gap before the following turn; the first turn\'s gap is before the wall clock', () => {
    const d = dialogueOf(doc, trace([
      { kind: parse, e: 100, gap: 4000 },
      { kind: exec, e: 50 },
      { kind: fetch, e: 30, r: 10, gap: [{ ev: EV.fromClient, ela: 800 }, { ev: EV.fromClient, ela: 200 }] },
      { kind: fetch, e: 20, r: 0, gap: [{ ev: EV.latch, ela: 70 }] }, // a non-idle between wait: still a gap, no new round trip
    ]))
    const ts = turnsOf(d)
    expect(ts.map((t) => t.gapBefore)).toEqual([4000, 0, 1000, 70])
    expect(ts[2].gapWaits).toMatchObject([{ event: EV.fromClient, n: 2, us: 1000, line: ts[2].gapWaits[0].line }])
    expect(ts[3].gapWaits.map((w) => w.event)).toEqual([EV.latch])
    expect(ts.map((t) => t.trip)).toEqual([0, 0, 1, 1])
    expect(ts.map((t) => t.endsTrip)).toEqual([false, true, false, true])
    expect(d.trips).toBe(2)
    expect(d.totals.leadGapUs).toBe(4000)
    expect(d.totals.gapUs).toBe(1070)
    expect(d.wall.us).toBe(100 + 50 + 1000 + 30 + 70 + 20)
    expect(d.totals.untimedUs).toBe(200)
    // the gap's waits are not in-call waits
    expect(d.totals.byRole).toEqual({})
  })

  it('classifies in-call waits: TEMP by name, Disk by class, the replies to the client as the return arrow, the rest Others', () => {
    const cases: [Partial<Event> | undefined, string][] = [
      [events[EV.tempW], 'temp'], [events[EV.tempR], 'temp'], [{ name: 'direct path read temp', class: 'Other' }, 'temp'],
      [events[EV.seq], 'disk'], [events[EV.ctlRead], 'disk'],
      [events[EV.enq], 'others'], [events[EV.logSync], 'others'], [events[EV.lockTimer], 'others'], [events[EV.latch], 'others'], [events[EV.dblink], 'others'],
      [events[EV.fromClient], 'others'], // an idle wait inside a call (a dblink fetch) is part of the call
      [events[EV.toClient], 'net'], [events[EV.moreData], 'net'], [undefined, 'others'],
    ]
    for (const [ev, want] of cases) expect(lifelineOf(ev as Event | undefined), ev?.name).toBe(want)
    // reads point back at the server; a word match ("oracle thread bootstrap" is not a read)
    expect(['db file sequential read', 'direct path read temp', 'read by other session', 'direct path write temp', 'oracle thread bootstrap', 'Disk file operations I/O'].map(readsFrom))
      .toEqual([true, true, true, false, false, false])

    const d = dialogueOf(doc, trace([{
      kind: exec, e: 10_000, c: 1000, waits: [
        { ev: EV.tempW, ela: 900, p1: 201 }, { ev: EV.tempR, ela: 400, p1: 201 }, { ev: EV.tempR, ela: 100, p1: 201 },
        { ev: EV.seq, ela: 300, p1: 7 }, { ev: EV.ctlRead, ela: 50, p1: 0 },
        { ev: EV.enq, ela: 2000 }, { ev: EV.logSync, ela: 600 }, { ev: EV.lockTimer, ela: 1000 },
      ],
    }]))
    expect(d.lifelines).toEqual(['client', 'server', 'disk', 'temp', 'others'])
    const t = turnAt(d, 0)
    expect(t.sides.temp).toMatchObject([{ event: EV.tempW, n: 1, us: 900 }, { event: EV.tempR, n: 2, us: 500 }])
    expect(t.sides.disk?.map((x) => x.event)).toEqual([EV.seq, EV.ctlRead])
    expect(t.sides.others?.map((x) => x.event)).toEqual([EV.enq, EV.lockTimer, EV.logSync])
    expect(d.lanes.disk).toEqual({ files: [7], classes: ['System I/O', 'User I/O'] }) // not 0: the control file read's p1 is a control file
    expect(d.lanes.temp?.files).toEqual([201])
    expect(d.lanes.others?.classes).toEqual(['Application', 'Commit', 'Idle'])
    expect(d.totals.byRole).toEqual({ userio: 1700, sysio: 50, other: 2000, commit: 600, idle: 1000 })
    expect(d.totals.untimedUs).toBe(10_000 - 1000 - 5350)
  })

  it('SQL*Net to the client annotates the return arrow and adds no lifeline', () => {
    const d = dialogueOf(doc, trace([{ kind: fetch, e: 200, r: 500, waits: [{ ev: EV.toClient, ela: 2 }, { ev: EV.moreData, ela: 10 }, { ev: EV.moreData, ela: 12 }, { ev: EV.moreData, ela: 8 }] }]))
    expect(d.lifelines).toEqual(['client', 'server'])
    expect(turnAt(d, 0).net).toMatchObject({ toClient: { event: EV.toClient, n: 1, us: 2 }, moreData: { event: EV.moreData, n: 3, us: 30 } })
    expect(d.totals.byRole).toEqual({ network: 32 })
  })

  it('recursive children roll up into their own call: one level down counted, their waits drawn with the call', () => {
    const d = dialogueOf(doc, trace([
      { kind: parse, e: 100 },
      {
        kind: exec, e: 5000, c: 2000, children: [
          { stmt: 5, kind: exec, e: 400, c: 300, waits: [{ ev: EV.seq, ela: 250, p1: 4 }] },
          { stmt: 5, kind: exec, e: 30 }, { stmt: 5, kind: exec, e: 30 }, { stmt: 5, kind: exec, e: 30 }, { stmt: 5, kind: exec, e: 30 },
          { stmt: 7, kind: fetch, e: 20, dep: 2 }, // inside the next one: in its e, not counted again
          { stmt: 6, kind: fetch, e: 50, betweenIn: [{ ev: EV.latch, ela: 15 }], betweenOut: [{ ev: EV.fromClient, ela: 700 }] },
        ],
      },
    ]))
    const t = turnsOf(d)[1]
    expect(t.recursive.n).toBe(6)
    expect(t.recursive.us).toBe(400 + 4 * 30 + 50)
    const g5 = t.recursive.groups.find((g) => g.stmt === 5)!, g6 = t.recursive.groups.find((g) => g.stmt === 6)!
    expect(t.recursive.groups[0]).toBe(g5)
    expect(g5).toMatchObject({ n: 5, us: 520, medianEla: 30 })
    expect(g5.outliers.map((c) => c.e)).toEqual([400])
    expect(g6).toMatchObject({ n: 1, outliers: [] })
    expect(t.sides.disk).toMatchObject([{ event: EV.seq, n: 1, us: 250 }])
    // a child's between wait inside the own call is part of the call; one before it is the gap before the turn
    expect(t.sides.others).toMatchObject([{ event: EV.latch, n: 1, us: 15 }])
    expect(t.gapBefore).toBe(700)
    expect(turnsOf(d)[0].recursive).toEqual({ n: 0, us: 0, groups: [] })
    // counters are inclusive: the children's CPU is not added again
    expect(d.totals.cpuUs).toBe(2000)
  })
})

describe('dialogueOf: totals', () => {
  it('untimed is what the wall clock has beyond CPU, in-call waits and gaps, clamped at 0', () => {
    const d = dialogueOf(doc, trace([{ kind: fetch, e: 1000, c: 300, r: 1, waits: [{ ev: EV.seq, ela: 200 }] }]))
    expect(d.wall.us).toBe(1000)
    expect(d.totals).toMatchObject({ cpuUs: 300, byRole: { userio: 200 }, gapUs: 0, untimedUs: 500 })
    // CPU counted inside the waits too (the counters overlap): nothing left, not a negative rest
    const over = dialogueOf(doc, trace([{ kind: fetch, e: 1000, c: 900, r: 1, waits: [{ ev: EV.seq, ela: 400 }] }]))
    expect(over.totals.untimedUs).toBe(0)
  })

  it('lifelines are only the used ones, in the order client, server, disk, temp, others', () => {
    expect(dialogueOf(doc, trace([{ kind: exec, e: 10, c: 10 }])).lifelines).toEqual(['client', 'server'])
    expect(dialogueOf(doc, trace([{ kind: fetch, e: 10, r: 1, waits: [{ ev: EV.tempR, ela: 1 }, { ev: EV.enq, ela: 1 }] }])).lifelines).toEqual(['client', 'server', 'temp', 'others'])
  })

  it('time to first row: the end of the first FETCH with rows; null when nothing was fetched', () => {
    expect(dialogueOf(doc, trace([{ kind: exec, e: 300, r: 5 }, { kind: fetch, e: 20, r: 0 }])).ttfrUs).toBeNull()
    expect(dialogueOf(doc, trace([{ kind: exec, e: 300 }, { kind: fetch, e: 20, r: 0 }, { kind: fetch, e: 40, r: 3, gap: 500 }])).ttfrUs).toBe(300 + 20 + 500 + 40)
    expect(dialogueOf(doc, trace([])).ttfrUs).toBeNull()
  })

  it('without any WAIT lines the round trips are unknown: every call replies', () => {
    const d = dialogueOf({ events: [] }, trace([{ kind: parse, e: 10 }, { kind: exec, e: 10 }, { kind: fetch, e: 10, r: 1 }]))
    expect(d.trips).toBeNull()
    expect(turnsOf(d).every((t) => t.endsTrip)).toBe(true)
  })

  it('an empty execution gives an empty dialogue', () => {
    const d = dialogueOf(doc, { calls: [], children: [], waits: [], truncated: true })
    expect(d).toMatchObject({ steps: [], lifelines: ['client', 'server'], wall: { us: 0 }, calls: 0, truncated: true })
    expect(dialogueLayout(d).boxes).toEqual([])
  })
})

describe('dialogueLayout', () => {
  const nameOf = (e: number) => events[e]?.name ?? ''

  it('lanes: 170 px each after the gutter, at least 520 px', () => {
    const two = dialogueLayout(dialogueOf(doc, trace([{ kind: exec, e: 10 }])))
    expect(two.width).toBe(MIN_W)
    expect(two.x.client).toBeLessThan(two.x.server)
    const five = dialogueLayout(dialogueOf(doc, trace([{ kind: exec, e: 10, waits: [{ ev: EV.seq, ela: 1 }, { ev: EV.tempR, ela: 1 }, { ev: EV.enq, ela: 1 }] }])))
    expect(five.width).toBe(GUTTER + 5 * LANE_W)
    expect(five.lanes.map((l) => l.line)).toEqual(['client', 'server', 'disk', 'temp', 'others'])
    expect(five.lanes.map((l) => l.x)).toEqual([...five.lanes.map((l) => l.x)].sort((a, b) => a - b))
    // the recursive-SQL label right of the server lifeline gets room when no lifeline is there
    const rec = dialogueLayout(dialogueOf(doc, trace([{ kind: exec, e: 900, children: [{ stmt: 3, kind: exec, e: 40 }] }])))
    expect(rec.width).toBe(rec.x.server + REC_X + REC_LABEL_W)
    expect(rec.x).toEqual(two.x)
  })

  it('activation height 8 + 10·log10(1 + ela / 100 µs)', () => {
    expect(actHeight(0)).toBe(8)
    expect(actHeight(900)).toBeCloseTo(18)
    expect(actHeight(99_900)).toBeCloseTo(38)
    expect(actHeight(-5)).toBe(8)
  })

  it('steps stack without overlap; frames enclose what they draw; the ttfr bracket ends at the first rows', () => {
    const d = dialogueOf(doc, trace([
      { kind: parse, e: 1000 }, { kind: exec, e: 13 },
      { kind: fetch, e: 2_000_000, r: 1, waits: [{ ev: EV.tempW, ela: 1_900_000 }, { ev: EV.tempR, ela: 2000 }], children: [{ stmt: 3, kind: exec, e: 50 }] },
      ...Array.from({ length: 50 }, (): CSpec => ({ kind: fetch, e: 170, r: 500, gap: 1500, waits: [{ ev: EV.tempR, ela: 5 }, { ev: EV.moreData, ela: 30 }] })),
      { kind: fetch, e: 43, r: 0, gap: 1490 },
    ]))
    const lay = dialogueLayout(d, nameOf)
    expect(lay.boxes).toHaveLength(d.steps.length)
    expect(lay.hidden).toBe(0)
    for (let k = 1; k < lay.boxes.length; k++) expect(lay.boxes[k].y).toBeGreaterThanOrEqual(lay.boxes[k - 1].y + lay.boxes[k - 1].h)
    const last = lay.boxes[lay.boxes.length - 1]
    expect(lay.height).toBeGreaterThanOrEqual(last.y + last.h)
    for (const b of lay.boxes) {
      expect(b.h).toBeGreaterThan(0)
      expect(b.act.h).toBeGreaterThanOrEqual(8)
      if (b.gap) expect(b.gap.y + b.gap.h).toBeLessThanOrEqual(b.callY)
      for (const s of b.sides) expect(s.y).toBeGreaterThan(b.callY)
      if (b.retY !== null) expect(b.retY).toBeGreaterThan(b.callY)
    }
    // PARSE and EXEC go in the round trip of FETCH #1: no reply arrow after them
    expect(lay.boxes.map((b) => b.retY !== null)).toEqual([false, false, true, true, true])
    const fb = lay.boxes[3]
    expect(fb.step.type).toBe('frame')
    expect(fb.frame).not.toBeNull()
    expect(fb.frame!.y1).toBeLessThan(fb.gap!.y)
    expect(fb.frame!.y2).toBeGreaterThan(fb.retY!)
    expect(fb.frame!.x2).toBeLessThanOrEqual(lay.width)
    // FETCH #1: the TEMP write goes to TEMP, the read comes back; the recursive box under them
    const f1 = lay.boxes[2]
    expect(f1.sides.map((s) => [s.line, s.read])).toEqual([['temp', false], ['temp', true]])
    expect(f1.rec).not.toBeNull()
    expect(f1.rec!.y).toBeGreaterThan(f1.sides[1].y)
    expect(lay.ttfr).toEqual({ y1: lay.boxes[0].callY, y2: f1.retY })
  })

  it(`at most ${MAX_ARROWS} side arrows per lifeline (the rest merged into one); at most ${MAX_STEPS} steps`, () => {
    const many = dialogueOf(doc, trace([{ kind: exec, e: 100, waits: [EV.enq, EV.logSync, EV.lockTimer, EV.latch, EV.dblink].map((ev, i) => ({ ev, ela: 50 - i })) }]))
    const rows = dialogueLayout(many, nameOf).boxes[0].sides
    expect(rows).toHaveLength(MAX_ARROWS)
    expect(rows.map((r) => r.traffic.length)).toEqual([1, 1, 3])
    const long = dialogueOf(doc, trace(Array.from({ length: MAX_STEPS + 50 }, (_, i): CSpec => ({ kind: fetch, e: 10, r: (i % 2) + 1, gap: 30 }))))
    const lay = dialogueLayout(long, nameOf)
    expect(lay.boxes).toHaveLength(MAX_STEPS)
    expect(lay.hidden).toBe(50)
  })
})

// ---- fixtures: documents of real traces through LocalSource.executionTrace -------------------------------------------

const scope = { window: null, files: null, contexts: null, includeIdle: true }
const dir = fileURLToPath(new URL('./testdata/', import.meta.url))
const fixtures = readdirSync(dir).filter((f) => f.startsWith('findings-') && f.endsWith('.json.gz'))
const loadDoc = (f: string) => TraceDoc.fromRaw((JSON.parse(gunzipSync(readFileSync(dir + f)).toString('utf8')) as { doc: RawDocument }).doc)

/** Every execution of every statement of the document as a dialogue, checking what must hold for any of them. */
function everyDialogue(d: TraceDoc): number {
  const src = new LocalSource(d)
  let n = 0
  for (const st of d.statements) {
    for (const ex of src.executions(st.id, scope).rows) {
      const tr = src.executionTrace(st.id, ex)
      expect(tr, `stmt ${st.id} exec ${ex.execNo}`).not.toBeNull()
      const dl = dialogueOf(d, tr!)
      const lay = dialogueLayout(dl, (e) => d.events[e]?.name ?? '')
      expect(turnsOf(dl).map((t) => t.call.id)).toEqual(tr!.calls.map((c) => c.id))
      for (const s of dl.steps) if (s.type === 'frame') expect(s.frame.turns.every((t) => t.kind === s.frame.kind && t.rows === s.frame.rows) && s.frame.n >= 3).toBe(true)
      expect(dl.lifelines.slice(0, 2)).toEqual(['client', 'server'])
      for (const v of [dl.wall.us, dl.totals.cpuUs, dl.totals.gapUs, dl.totals.untimedUs, dl.totals.leadGapUs, ...Object.values(dl.totals.byRole)]) expect(v).toBeGreaterThanOrEqual(0)
      expect(lay.boxes.length + lay.hidden).toBe(dl.steps.length)
      expect(Number.isFinite(lay.height)).toBe(true)
      n++
    }
  }
  return n
}

describe('dialogueOf on documents', () => {
  it('a makeDoc execution through LocalSource.executionTrace', async () => {
    const d = await makeDoc([
      { ctx: 0, stmt: 0, kind: parse, e: 50, tim: 1100 },
      { ctx: 0, stmt: 0, kind: exec, e: 80, tim: 1200 },
      { ctx: 0, stmt: 0, kind: fetch, e: 30, r: 10, tim: 1300 },
      { ctx: 0, stmt: 0, kind: fetch, e: 30, r: 10, tim: 1400 },
      { ctx: 0, stmt: 0, kind: fetch, e: 30, r: 10, tim: 1500 },
      { ctx: 0, stmt: 0, kind: fetch, e: 5, r: 2, tim: 1600 },
    ], { waits: [{ ctx: 0, stmt: 0, event: 0, ela: 40, tim: 1250 }] })
    expect(everyDialogue(d)).toBeGreaterThan(0)
  })

  for (const f of fixtures) {
    it(`${f}: every execution gives a dialogue`, async () => {
      expect(everyDialogue(await loadDoc(f))).toBeGreaterThan(0)
    })
  }
})

// § 1 of docs/PLAN-VIEWS.md, on findings-io_waits.json.gz (internal/report TestFindingsDocsCurrent writes it from
// testdata/traces/19c/io_waits.trc). The execution trace stops before the CLOSE (executions/trace: the PARSE, the EXEC,
// its FETCHes), so stmt 21 has 204 turns, not the 205 calls of § 1, and the gap before the CLOSE is not in the gaps.
describe('dialogueOf on io_waits.trc', async () => {
  const d = await loadDoc('findings-io_waits.json.gz')
  const src = new LocalSource(d)
  const dialogues = (sqlId: string) => {
    const st = d.statements.find((s) => s.sqlId === sqlId)!
    return src.executions(st.id, scope).rows.map((ex) => dialogueOf(d, src.executionTrace(st.id, ex)!))
  }
  const s = (us: number, digits = 2) => (us / 1e6).toFixed(digits)
  const ms = (us: number, digits = 0) => (us / 1e3).toFixed(digits)
  const evNamed = (name: string) => d.events.findIndex((e) => e.name === name)

  it('stmt 21 (52nzchs09dgn1, ORDER BY): PARSE, EXEC, FETCH #1 apart, a loop × 200 of 500 rows, the last FETCH', () => {
    expect(d.statements[21].sqlId).toBe('52nzchs09dgn1')
    const [dl] = dialogues('52nzchs09dgn1')
    expect(dl.calls).toBe(204)
    expect(dl.steps.map((x) => (x.type === 'turn' ? `${x.turn.kind}:${x.turn.rows}` : `frame ${x.frame.n} × ${x.frame.rows}`))).toEqual([`${parse}:0`, `${exec}:0`, `${fetch}:1`, 'frame 200 × 500', `${fetch}:0`])
    const f1 = turnAt(dl, 2)
    const w = f1.sides.temp!.find((t) => t.event === evNamed('direct path write temp'))!
    const r = f1.sides.temp!.find((t) => t.event === evNamed('direct path read temp'))!
    expect([w.n, s(w.us)]).toEqual([1331, '2.38'])
    expect(r.n).toBe(856)
    expect(frameAt(dl, 3).sides.temp!.find((t) => t.event === r.event)!.n).toBe(1331 - 856)
    expect([s(dl.ttfrUs!), s(dl.wall.us)]).toEqual(['2.45', '2.80'])
    expect(ms(dl.totals.gapUs)).toBe('307')
    expect(ms(frameAt(dl, 3).medianGap, 2)).toBe('1.52')
    expect(dl.trips).toBe(202)
    expect(dl.rowsPerTrip).toBe(500)
    expect(dl.lifelines).toEqual(['client', 'server', 'disk', 'temp'])
  })

  it('stmt 15 (64y0jakbjfvm9): a loop × 100 of 15 rows; the client gaps outweigh the server time', () => {
    const [dl] = dialogues('64y0jakbjfvm9')
    const f = dl.steps.find((x) => x.type === 'frame')
    expect(f?.type === 'frame' && [f.frame.n, f.frame.rows]).toEqual([100, 15])
    expect(dl.rows).toBe(1505)
    expect(dl.trips).toBe(102)
    const inCalls = sum(turnsOf(dl).map((t) => t.ela))
    expect([ms(dl.totals.gapUs, 1), ms(inCalls, 1)]).toEqual(['7.4', '5.2']) // § 1's 7.5 ms includes the gap before the CLOSE
  })

  it('stmt 13: two executions, each two round trips', () => {
    const st = d.statements[13]
    const ds = dialogues(st.sqlId)
    expect(ds).toHaveLength(2)
    for (const dl of ds) expect([dl.calls, dl.trips]).toEqual([4, 2])
  })

  it('the PL/SQL block: the first EXEC of stmts 18 and 19 is an outlier against its run', () => {
    const block = d.calls.stmt[d.calls.parent[d.callsByStmt.get(18)[0]]]
    const [dl] = dialogues(d.statements[block].sqlId)
    const ex = turnsOf(dl).find((t) => t.kind === exec)!
    const g18 = ex.recursive.groups.find((g) => g.stmt === 18 && g.kind === exec)!
    const g19 = ex.recursive.groups.find((g) => g.stmt === 19 && g.kind === exec)!
    expect([g18.medianEla, g18.outliers[0].e, g18.outliers[0].id]).toEqual([28, 483, g18.first.id])
    expect([g19.medianEla, g19.outliers[0].e, g19.outliers[0].id]).toEqual([28, 380, g19.first.id])
  })
})
