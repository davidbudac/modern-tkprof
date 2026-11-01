// The raw facts of one execution, in trace order: what the Execution Loom (data/loom.ts) is computed from.
// LocalSource builds it from the document's fact columns (executionTraceOf), RemoteSource reads the same shape from
// `api/executions/trace` (internal/slice/exectrace.go). No derived numbers here, so the two only have to agree on rows.

import type { TraceDoc } from './doc'
import type { ID } from './types'
import { CallKind } from './types'

/** One call (counters inclusive of its recursive children, as recorded). */
export interface TraceCall {
  id: ID
  /** the execution's own call this one rolls up to (itself for an own call) */
  owner: ID
  parent: ID
  line: number
  ctx: ID
  kind: number
  cursor: ID
  stmt: ID
  dep: number
  execNo: number
  c: number
  e: number
  p: number
  cr: number
  cu: number
  r: number
  tim: number
  selfE: number
  plh: number
}

/** One WAIT line attached to an own call or to one of its recursive children. */
export interface TraceWait {
  id: ID
  /** the call the wait is attached to */
  call: ID
  owner: ID
  line: number
  ctx: ID
  event: ID
  ela: number
  p1: number
  p2: number
  p3: number
  obj: number
  tim: number
  dep: number
  /** outside the call (think time before it): not part of the call's elapsed */
  between: boolean
}

export interface ExecTrace {
  /** the execution's own calls in trace order: the PARSE right before the EXEC (if any), the EXEC, its FETCHes */
  calls: TraceCall[]
  /** recursive calls under the own calls, in trace order */
  children: TraceCall[]
  /** waits of the own calls and their children, in trace order */
  waits: TraceWait[]
  /** the row lists were cut at a limit: curves from them are not complete */
  truncated: boolean
}

/** The own calls of execution (cursor, execNo) whose EXEC is call `exec` (same rule as LocalSource.executionDetail). */
export function ownCallsOf(doc: TraceDoc, exec: ID): number[] {
  const c = doc.calls
  const ids = doc.callsByStmt.get(c.stmt[exec])
  const cursor = c.cursor[exec], execNo = c.execNo[exec]
  const out: number[] = []
  const at = ids.indexOf(exec)
  for (let k = at - 1; k >= 0; k--) {
    const i = ids[k]
    if (c.cursor[i] !== cursor) continue
    if (c.kind[i] === CallKind.parse) out.push(i)
    break
  }
  out.push(exec)
  for (let k = at + 1; k < ids.length; k++) {
    const i = ids[k]
    if (c.cursor[i] !== cursor) continue
    if (c.kind[i] !== CallKind.fetch || c.execNo[i] !== execNo) { if (c.kind[i] === CallKind.exec || c.kind[i] === CallKind.close || c.kind[i] === CallKind.parse) break; continue }
    out.push(i)
  }
  return out
}

function callOf(doc: TraceDoc, i: number, owner: ID): TraceCall {
  const c = doc.calls
  return {
    id: i, owner, parent: c.parent[i], line: c.line[i], ctx: c.ctx[i], kind: c.kind[i], cursor: c.cursor[i], stmt: c.stmt[i], dep: c.dep[i], execNo: c.execNo[i],
    c: c.c[i], e: c.e[i], p: c.p[i], cr: c.cr[i], cu: c.cu[i], r: c.r[i], tim: c.tim[i], selfE: c.selfE[i], plh: c.plh[i],
  }
}

/** The execution trace from the document's fact columns. */
export function executionTraceOf(doc: TraceDoc, exec: ID): ExecTrace {
  const own = ownCallsOf(doc, exec)
  const calls = own.map((i) => callOf(doc, i, i))
  const children: TraceCall[] = []
  const waitIds: { w: number; owner: ID }[] = []
  for (const o of own) {
    const stack = [o]
    while (stack.length) {
      const i = stack.pop()!
      for (const w of doc.waitsByCall.get(i)) waitIds.push({ w, owner: o })
      for (const ch of doc.childCalls.get(i)) { children.push(callOf(doc, ch, o)); stack.push(ch) }
    }
  }
  children.sort((a, b) => a.id - b.id)
  waitIds.sort((a, b) => a.w - b.w)
  const w = doc.waits
  const waits = waitIds.map(({ w: i, owner }): TraceWait => ({
    id: i, call: w.call[i], owner, line: w.line[i], ctx: w.ctx[i], event: w.event[i], ela: w.ela[i], p1: w.p1[i], p2: w.p2[i], p3: w.p3[i],
    obj: w.obj[i], tim: w.tim[i], dep: w.dep[i], between: (w.flags[i] & 1) !== 0,
  }))
  return { calls, children, waits, truncated: false }
}
