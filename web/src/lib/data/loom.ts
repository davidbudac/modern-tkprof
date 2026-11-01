// Execution Loom: two executions of one statement aligned by work checkpoints (PARSE?, EXEC, FETCH 1..n) instead of
// clock time. Pure: the raw rows come from DataSource.executionTrace (data/exectrace.ts), the view is views/ExecLoom.tsx.
//
// Rules (docs/implementing-new-ideas.md § 6-7):
// - The curve is the cumulative recorded (inclusive) elapsed of the execution's own calls; recursive children are inside it
//   and never added again. PARSE only when asked; CLOSE never; between-call waits never.
// - Phases align by key (parse, exec, fetch i). A phase one side lacks is unmatched: absent, not zero.
// - Waits per object and event are in-call waits of the own call and its recursive children, each counted once.
// - cr / cu / p are call-level counts: never allocated to objects or waits.

import type { ExecTrace, TraceCall, TraceWait } from './exectrace'
import { CallKind } from './types'

export interface LoomOptions {
  includeParse: boolean
}

/** One side's numbers for one phase. */
export interface PhaseSide {
  call: TraceCall
  e: number
  c: number
  p: number
  cr: number
  cu: number
  r: number
  /** in-call waits of the call and its recursive children */
  waitUs: number
  waitCount: number
  /** e − c − waitUs: not a measured component (negative = the counters do not reconcile) */
  residual: number
  /** recursive calls under the call */
  children: number
  waits: TraceWait[]
}

export interface LoomPhase {
  key: string
  label: string
  a?: PhaseSide
  b?: PhaseSide
  /** B − A elapsed of this phase (both present) */
  addedUs: number | null
  /** the sides returned different row counts in this call */
  rowsDiffer: boolean
}

export interface EvAgg { us: number; count: number }

/** Waits of one object (obj# from the WAIT lines; −1 = none recorded) per phase and event. */
export interface LoomObject {
  obj: number
  /** per phase index: event id → wait time and count, for each side */
  a: Map<number, EvAgg>[]
  b: Map<number, EvAgg>[]
  totalA: number
  totalB: number
}

export interface Loom {
  phases: LoomPhase[]
  /** cumulative elapsed at checkpoints 0..phases.length (null = the side has no such phase: absent, not zero) */
  cumA: (number | null)[]
  cumB: (number | null)[]
  objects: LoomObject[]
  /** event ids with any in-call wait, most total time first */
  events: { event: number; a: number; b: number }[]
  /** human notes on where the two shapes differ */
  shape: string[]
  totalA: number
  totalB: number
}

function sideOf(t: ExecTrace, call: TraceCall): PhaseSide {
  const waits = t.waits.filter((w) => w.owner === call.id && !w.between)
  let waitUs = 0
  for (const w of waits) waitUs += w.ela
  const children = t.children.reduce((n, ch) => n + (ch.owner === call.id ? 1 : 0), 0)
  return { call, e: call.e, c: call.c, p: call.p, cr: call.cr, cu: call.cu, r: call.r, waitUs, waitCount: waits.length, residual: call.e - call.c - waitUs, children, waits }
}

function phasesOf(t: ExecTrace, o: LoomOptions): { key: string; label: string; side: PhaseSide }[] {
  const out: { key: string; label: string; side: PhaseSide }[] = []
  let fetch = 0
  for (const c of t.calls) {
    if (c.kind === CallKind.parse) { if (o.includeParse) out.push({ key: 'parse', label: 'Parse', side: sideOf(t, c) }) }
    else if (c.kind === CallKind.exec) out.push({ key: 'exec', label: 'Execute', side: sideOf(t, c) })
    else if (c.kind === CallKind.fetch) { fetch++; out.push({ key: `fetch${fetch}`, label: `Fetch ${fetch}`, side: sideOf(t, c) }) }
  }
  return out
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 'es'}`

export function buildLoom(a: ExecTrace, b: ExecTrace, o: LoomOptions): Loom {
  const pa = phasesOf(a, o), pb = phasesOf(b, o)
  // keys are parse?, exec, fetch1..n on both sides: merge in that order
  const keys: { key: string; label: string }[] = []
  const seen = new Set<string>()
  const order = (k: string) => (k === 'parse' ? -2 : k === 'exec' ? -1 : Number(k.slice(5)))
  for (const p of [...pa, ...pb]) if (!seen.has(p.key)) { seen.add(p.key); keys.push({ key: p.key, label: p.label }) }
  keys.sort((x, y) => order(x.key) - order(y.key))
  const ma = new Map(pa.map((p) => [p.key, p.side])), mb = new Map(pb.map((p) => [p.key, p.side]))

  const phases: LoomPhase[] = keys.map(({ key, label }) => {
    const x = ma.get(key), y = mb.get(key)
    return { key, label, a: x, b: y, addedUs: x && y ? y.e - x.e : null, rowsDiffer: !!x && !!y && x.r !== y.r }
  })

  const cum = (side: 'a' | 'b') => {
    const out: (number | null)[] = [0]
    let s = 0
    for (const ph of phases) {
      const v = ph[side]
      if (v) { s += v.e; out.push(s) } else out.push(null)
    }
    return out
  }
  const cumA = cum('a'), cumB = cum('b')

  const shape: string[] = []
  const fa = pa.filter((p) => p.key.startsWith('fetch')).length, fb = pb.filter((p) => p.key.startsWith('fetch')).length
  if (fa !== fb) shape.push(`A has ${plural(fa, 'fetch')}, B ${plural(fb, 'fetch')}: phases past Fetch ${Math.min(fa, fb)} are unmatched.`)
  const differ = phases.filter((p) => p.rowsDiffer).map((p) => p.label)
  if (differ.length) shape.push(`Rows per call differ in ${differ.slice(0, 4).join(', ')}${differ.length > 4 ? ` and ${differ.length - 4} more` : ''}: the calls did different amounts of work.`)
  if (o.includeParse && ma.has('parse') !== mb.has('parse')) shape.push(`Only ${ma.has('parse') ? 'A' : 'B'} has a PARSE right before its EXEC.`)
  if (a.truncated || b.truncated) shape.push('The wait rows were cut at the server limit: object and event numbers are incomplete.')

  // objects × phases × events, each in-call wait once
  const objs = new Map<number, LoomObject>()
  const evTot = new Map<number, { event: number; a: number; b: number }>()
  phases.forEach((ph, k) => {
    for (const side of ['a', 'b'] as const) {
      const v = ph[side]
      if (!v) continue
      for (const w of v.waits) {
        const key = w.obj >= 0 ? w.obj : -1
        let ob = objs.get(key)
        if (!ob) { ob = { obj: key, a: phases.map(() => new Map()), b: phases.map(() => new Map()), totalA: 0, totalB: 0 }; objs.set(key, ob) }
        const m = ob[side][k]
        const g = m.get(w.event) ?? { us: 0, count: 0 }
        g.us += w.ela; g.count++
        m.set(w.event, g)
        if (side === 'a') ob.totalA += w.ela; else ob.totalB += w.ela
        const e = evTot.get(w.event) ?? { event: w.event, a: 0, b: 0 }
        e[side] += w.ela
        evTot.set(w.event, e)
      }
    }
  })
  const objects = [...objs.values()].sort((x, y) => Math.abs(y.totalB - y.totalA) - Math.abs(x.totalB - x.totalA) || y.totalB + y.totalA - x.totalB - x.totalA || x.obj - y.obj)
  const events = [...evTot.values()].sort((x, y) => y.a + y.b - x.a - x.b || x.event - y.event)

  const last = (c: (number | null)[]) => { for (let i = c.length - 1; i >= 0; i--) if (c[i] !== null) return c[i]!; return 0 }
  return { phases, cumA, cumB, objects, events, shape, totalA: last(cumA), totalB: last(cumB) }
}

/** Sum of an object's waits over phase k (or all phases when k is null) on one side. */
export function objectWait(ob: LoomObject, side: 'a' | 'b', k: number | null): EvAgg {
  const out = { us: 0, count: 0 }
  const maps = k === null ? ob[side] : [ob[side][k]]
  for (const m of maps) for (const g of m.values()) { out.us += g.us; out.count += g.count }
  return out
}

/** Cumulative wait of an object at checkpoints 0..n on one side (null where the side lacks the phase). */
export function objectCurve(ob: LoomObject, loom: Loom, side: 'a' | 'b'): (number | null)[] {
  const out: (number | null)[] = [0]
  let s = 0
  loom.phases.forEach((ph, k) => {
    if (!ph[side]) { out.push(null); return }
    for (const g of ob[side][k].values()) s += g.us
    out.push(s)
  })
  return out
}

/** Swap the sides (baseline = B). */
export function swapTraces<T>(a: T, b: T, baselineB: boolean): [T, T] { return baselineB ? [b, a] : [a, b] }
