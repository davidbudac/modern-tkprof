// What an obj# is called, for the I/O map (views/BlockMap.tsx) and anything else that shows objects.
//
// A trace has numbers, not names. Names come, in this order, from the reference bundle (docs/REF-BUNDLE.md: owner, name,
// subobject, type), else from the trace's own plans (a STAT line's `obj=` and the object name in its `op`, with a type read off
// the operation: TABLE ACCESS → TABLE, INDEX … → INDEX), else the obj# stays a number. The PDB of a wait is the container of
// its session context: the CONTAINER ID line gives the number, the timestamp lines of 12.2+ (`*** 2026-… (PDB1(3))`) its name.
import type { TraceDoc } from './doc'
import type { Marker, PlanLine, RefObject } from './types'

/** Where a name came from. */
export type NameSource = 'ref' | 'plan' | 'none'

export interface ObjInfo {
  obj: number
  /** OBJECT_NAME (bundle) or the name in the plan's operation */
  name?: string
  /** OWNER: the bundle only (a plan line does not say) */
  owner?: string
  /** SUBOBJECT_NAME (a partition): the bundle only */
  sub?: string
  /** OBJECT_TYPE (bundle), else TABLE / INDEX / … from the plan's operation */
  type?: string
  from: NameSource
}

/** What an object's label shows besides its name (persisted by the I/O map). */
export interface NameOpts {
  /** the owner: `MTK.MTK_CUST` */
  schema: boolean
  /** the PDB the waits ran in: `PDB1/MTK.MTK_CUST` */
  pdb: boolean
  /** the partition: `MTK.SALES.P2026Q1` */
  sub: boolean
  /** the obj# after the name: `MTK.MTK_CUST #108609` */
  num: boolean
}

export const DEFAULT_NAME_OPTS: NameOpts = { schema: true, pdb: false, sub: true, num: false }

/** A persisted value read back as name options: every flag a boolean, the default for what is missing. */
export function nameOptsOf(v: unknown): NameOpts {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>
  const flag = (k: keyof NameOpts) => (typeof o[k] === 'boolean' ? (o[k] as boolean) : DEFAULT_NAME_OPTS[k])
  return { schema: flag('schema'), pdb: flag('pdb'), sub: flag('sub'), num: flag('num') }
}

/** The object type an operation of a plan line reads (`TABLE ACCESS FULL` → TABLE), or undefined when it does not say. */
export function typeOfOp(op: string): string | undefined {
  const o = op.trim().toUpperCase()
  if (o.startsWith('INDEX') || o.startsWith('BITMAP INDEX') || o.startsWith('DOMAIN INDEX')) return 'INDEX'
  if (o.startsWith('TABLE ACCESS') || o.startsWith('LOAD TABLE') || o.startsWith('LOAD AS SELECT') || o.startsWith('EXTERNAL TABLE ACCESS')) return 'TABLE'
  if (o.startsWith('MAT_VIEW') || o.startsWith('MAT_VIEW REWRITE')) return 'MATERIALIZED VIEW'
  if (o.startsWith('CLUSTER')) return 'CLUSTER'
  if (o.startsWith('SEQUENCE')) return 'SEQUENCE'
  return undefined
}

/**
 * The names of the objects: every bundle row, then every plan line whose obj# the bundle does not name (the first plan line of
 * an obj# with a name wins; a later one fills in a type the first could not tell).
 */
export function objectNames(refs: Iterable<RefObject>, planLines: readonly PlanLine[]): Map<number, ObjInfo> {
  const out = new Map<number, ObjInfo>()
  for (const r of refs) out.set(r.id, { obj: r.id, name: r.name, owner: r.owner || undefined, sub: r.subobject || undefined, type: r.type || undefined, from: 'ref' })
  for (const l of planLines) {
    if (!(l.obj > 0) || !l.object) continue
    const have = out.get(l.obj)
    if (have?.from === 'ref') continue
    const type = typeOfOp(l.op)
    if (!have) out.set(l.obj, { obj: l.obj, name: l.object, type, from: 'plan' })
    else if (!have.type && type) have.type = type
  }
  return out
}

/** Container number → name from the timestamp markers (`PDB1(3)`, `CDB$ROOT(1)`); empty for a non-CDB or a trace before 12.2. */
export function containerNames(markers: readonly Marker[]): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of markers) {
    if (m.kind !== 1 || !m.text) continue // MarkerTimestamp: text is the container, without the outer parentheses
    const g = /^(.+)\((\d+)\)$/.exec(m.text.trim())
    if (g && !out.has(g[2])) out.set(g[2], g[1])
  }
  return out
}

interface DocNames { objs: Map<number, ObjInfo>; pdbs: Map<string, string>; refCount: number; planCount: number }
const cache = new WeakMap<TraceDoc, DocNames>()

function namesOf(doc: TraceDoc): DocNames {
  let n = cache.get(doc)
  if (!n) {
    // the document carries only the bundle rows of the objects the trace names (model.ApplyRef), waits or plans
    const objs = objectNames(doc.refObjects(), doc.planLines)
    let refCount = 0, planCount = 0
    for (const o of objs.values()) if (o.from === 'ref') refCount++; else planCount++
    cache.set(doc, (n = { objs, pdbs: containerNames(doc.markers), refCount, planCount }))
  }
  return n
}

/** What the document knows about an obj#: its bundle row, else its plan lines' name, else nothing (`from: 'none'`). */
export function objInfo(doc: TraceDoc, obj: number): ObjInfo {
  const n = namesOf(doc)
  let o = n.objs.get(obj)
  if (!o) {
    const r = obj >= 0 ? doc.refObject(obj) : undefined
    o = r ? { obj, name: r.name, owner: r.owner || undefined, sub: r.subobject || undefined, type: r.type || undefined, from: 'ref' } : { obj, from: 'none' }
    n.objs.set(obj, o)
  }
  return o
}

/** The PDB name of a session context (its CONTAINER ID through the timestamp lines), else undefined (a non-CDB, CDB$ROOT is named too). */
export function pdbOfCtx(doc: TraceDoc, ctx: number): string | undefined {
  const id = doc.contexts[ctx]?.containerId
  return id ? namesOf(doc).pdbs.get(id) ?? `CON_ID ${id}` : undefined
}

/** The trace names containers (a CDB trace from 12.2 on): the PDB option means something. */
export const hasContainers = (doc: TraceDoc): boolean => namesOf(doc).pdbs.size > 0 || doc.contexts.some((c) => !!c.containerId)

/** How many objects got a name from the bundle and how many from the plans (of those the plans and the waits mention). */
export function nameCounts(doc: TraceDoc): { ref: number; plan: number } {
  const n = namesOf(doc)
  return { ref: n.refCount, plan: n.planCount }
}

/** An object's label in parts, for a DOM label that greys the qualifiers. `name` is `obj# N` when the object has none. */
export interface ObjParts { pdb?: string; owner?: string; name: string; sub?: string; num?: number; known: boolean }

/** The parts the options ask for. `pdb`: the container the object's waits ran in (the caller knows it from a row's context). */
export function objParts(info: ObjInfo, opts: NameOpts, pdb?: string): ObjParts {
  if (info.obj < 0) return { name: 'no object', known: false }
  if (!info.name) return { name: `obj# ${info.obj}`, known: false, ...(opts.pdb && pdb ? { pdb } : {}) }
  return {
    name: info.name, known: true,
    ...(opts.pdb && pdb ? { pdb } : {}),
    ...(opts.schema && info.owner ? { owner: info.owner } : {}),
    ...(opts.sub && info.sub ? { sub: info.sub } : {}),
    ...(opts.num ? { num: info.obj } : {}),
  }
}

/** The label as text: `PDB1/MTK.MTK_CUST.P1 #108609`, `obj# 108609`, `no object`. */
export function objText(info: ObjInfo, opts: NameOpts, pdb?: string): string {
  const p = objParts(info, opts, pdb)
  return `${p.pdb ? `${p.pdb}/` : ''}${p.owner ? `${p.owner}.` : ''}${p.name}${p.sub ? `.${p.sub}` : ''}${p.num !== undefined ? ` #${p.num}` : ''}`
}
