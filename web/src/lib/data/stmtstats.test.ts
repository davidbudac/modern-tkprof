import { describe, expect, it, vi } from 'vitest'
import { makeDoc, type CallSpec } from './testdoc'
import { scopedStatements } from './stmtstats'
import { LocalSource, RemoteSource } from './source'
import { effectiveContexts } from './fileset'
import type { Scope } from '../state/store'
import { CallKind } from './types'
import type { ApiClient } from './client'

const P = CallKind.parse, X = CallKind.exec, F = CallKind.fetch
// ctx 0,1: file 0 (the coordinator), ctx 2: file 1 (PX slave attached to ctx 0), ctx 3: file 2
const calls: CallSpec[] = [
  { ctx: 0, stmt: 0, kind: P, e: 10, c: 10, tim: 1100, mis: 1 },
  { ctx: 0, stmt: 0, kind: X, e: 100, c: 60, tim: 1200, selfE: 90, idleEla: 5 },
  { ctx: 0, stmt: 1, kind: X, e: 10, c: 5, tim: 1190, parent: 1, dep: 1 }, // recursive, inside the exec above
  { ctx: 0, stmt: 0, kind: F, e: 50, c: 30, tim: 1300, r: 7 },
  { ctx: 1, stmt: 1, kind: X, e: 200, c: 150, tim: 2000 },
  { ctx: 2, stmt: 0, kind: X, e: 500, c: 400, tim: 2500 }, // PX slave of ctx 0
  { ctx: 3, stmt: 1, kind: X, e: 300, c: 100, tim: 3000 },
]

const scope = (doc: Awaited<ReturnType<typeof makeDoc>>, files: number[] | null, window: Scope['window'] = null): Scope => {
  const f = files ? new Set(files) : null
  return { window, files: f, contexts: effectiveContexts(doc, f, null), includeIdle: true }
}

describe('scopedStatements (the in-browser api/statements)', () => {
  it('with no narrowing equals the sums over every call, PX slave work kept apart', async () => {
    const doc = await makeDoc(calls)
    const s = scopedStatements(doc, scope(doc, null))
    expect(s.map((x) => x.id)).toEqual([0, 1])
    const s0 = s[0]
    expect(s0.parse.count).toBe(1); expect(s0.hardParses).toBe(1)
    expect(s0.exec.count).toBe(1); expect(s0.executions).toBe(1)
    expect(s0.fetch.count).toBe(1); expect(s0.allCalls.rows).toBe(7)
    expect(s0.elapsed).toBe(160); expect(s0.selfElapsed).toBe(150) // 10 + 100(self 90) + 50
    expect(s0.idleUs).toBe(5)
    expect(s0.total.count).toBe(3)
    expect(s0.pxEla).toBe(500); expect(s0.pxCpu).toBe(400); expect(s0.pxSessions).toBe(1)
    expect(s0.firstTim).toBe(1090); expect(s0.lastTim).toBe(1300)
    expect(s0.topLevel).toBe(true)
    const s1 = s[1]
    expect(s1.executions).toBe(3); expect(s1.elapsed).toBe(510) // the recursive call counts in elapsed (not nested in the same statement)
    expect(s1.maxDepth).toBe(1); expect(s1.minDepth).toBe(0)
    expect(s0.children).toEqual([{ statement: 1, calls: 1, elapsed: 10 }]); expect(s0.childUs).toBe(10)
    expect(s1.parents).toEqual([{ statement: 0, calls: 1, elapsed: 10 }])
  })

  it('a file selection keeps only the calls of its contexts; statements with none show zeros', async () => {
    const doc = await makeDoc(calls)
    const f2 = scopedStatements(doc, scope(doc, [2]))
    expect(f2[0].allCalls.count).toBe(0); expect(f2[0].elapsed).toBe(0); expect(f2[0].pxEla).toBeUndefined()
    expect(f2[1].executions).toBe(1); expect(f2[1].elapsed).toBe(300)
    expect(f2[1].parents).toBeNull()
    // the slave's file alone: its calls are attached PX work, so they are not the statement's own numbers
    const f1 = scopedStatements(doc, scope(doc, [1]))
    expect(f1[0].allCalls.count).toBe(0); expect(f1[0].pxEla).toBe(500)
    const f01 = scopedStatements(doc, scope(doc, [0, 1]))
    expect(f01[0].elapsed).toBe(160); expect(f01[1].elapsed).toBe(210); expect(f01[0].pxSessions).toBe(1)
  })

  it('narrows by time window like the contexts filter (a call overlapping the window counts)', async () => {
    const doc = await makeDoc(calls)
    const w = scopedStatements(doc, scope(doc, null, { startTim: 1900, endTim: 2100 }))
    expect(w[0].allCalls.count).toBe(0)
    expect(w[1].executions).toBe(1); expect(w[1].elapsed).toBe(200)
  })

  it('counts errors in the scope contexts only', async () => {
    const doc = await makeDoc(calls)
    ;(doc.errors as unknown as unknown[]).push({ statement: 1, context: 3 }, { statement: 1, context: 1 })
    expect(scopedStatements(doc, scope(doc, null))[1].errors).toBe(2)
    expect(scopedStatements(doc, scope(doc, [2]))[1].errors).toBe(1)
  })

  it('cursors and plans are those of the cursors in scope', async () => {
    const doc = await makeDoc(calls)
    ;(doc.plans as unknown as unknown[]).push({ id: 0, line: 5, cursor: 0, statement: 0, planHash: 7, first: 0, n: 0 }, { id: 1, line: 6, cursor: 1, statement: 1, planHash: 9, first: 0, n: 0 })
    const f2 = scopedStatements(doc, scope(doc, [2])) // ctx 3 only: its calls are on cursor 1
    expect(f2[0].cursors).toBe(0); expect(f2[0].plans).toBeNull(); expect(f2[0].planHashes).toBeNull()
    expect(f2[1].cursors).toBe(1); expect(f2[1].plans).toEqual([1]); expect(f2[1].planHashes).toEqual([9])
    // both cursors are opened in ctx 0 (file 0): without a window every cursor of the contexts counts
    const f0 = scopedStatements(doc, scope(doc, [0]))
    expect(f0.map((x) => x.cursors)).toEqual([1, 1]); expect(f0[0].plans).toEqual([0]); expect(f0[1].planHashes).toEqual([9])
    // a window keeps only the cursors called in it (the PX slave call of stmt 0 counts, as in the engine)
    const w = scopedStatements(doc, scope(doc, null, { startTim: 1900, endTim: 2100 }))
    expect(w[0].cursors).toBe(1); expect(w[1].cursors).toBe(1); expect(w[1].plans).toEqual([1])
  })

  it('LocalSource lists follow the scope: executions, spans, roles', async () => {
    const doc = await makeDoc(calls)
    const src = new LocalSource(doc)
    expect(src.executions(1, scope(doc, null)).total).toBe(3)
    const one = src.executions(1, scope(doc, [2]))
    expect(one.total).toBe(1); expect(one.rows[0].e).toBe(300); expect(one.slowest?.e).toBe(300)
    expect(src.executions(1, { window: null, files: new Set(), contexts: new Set(), includeIdle: true }).total).toBe(0)
    expect(src.stmtSpans([1], 0, scope(doc, null)).get(1)!.length).toBe(3)
    expect(src.stmtSpans([1], 0, scope(doc, [2])).get(1)).toEqual([{ start: 2700, end: 3000 }])
    expect(src.stmtPhases([1], 0, scope(doc, [2])).get(1)).toEqual([{ start: 2700, end: 3000, kind: 'exec', us: [0, 300, 0, 0, 0] }])
    expect(src.stmtWaits([1], 5, scope(doc, [2])).get(1)).toEqual([])
    expect(src.stmtRoles(scope(doc, [2]))).toBeInstanceOf(Float64Array)
  })

  it('LocalSource.statements answers it (null without fact tables)', async () => {
    const doc = await makeDoc(calls)
    expect(new LocalSource(doc).statements(scope(doc, [2]))![1].elapsed).toBe(300)
    const bare = await makeDoc(calls)
    Object.defineProperty(bare, 'hasFacts', { value: false })
    expect(new LocalSource(bare).statements(scope(bare, null))).toBeNull()
  })
})

function fakeClient(answer: (url: string) => Response) {
  const fetch = vi.fn(async (url: string) => answer(url))
  return { client: { base: '', fetch } as unknown as ApiClient, fetch }
}

describe('RemoteSource.statements', () => {
  it('asks api/statements with the scope and returns the table', async () => {
    const doc = await makeDoc(calls)
    const table = [{ id: 0 }, { id: 1 }]
    const { client, fetch } = fakeClient(() => new Response(JSON.stringify({ statements: table })))
    const src = new RemoteSource(doc, client)
    const r = await src.statements({ window: { startTim: 5, endTim: 9 }, files: new Set([0]), contexts: new Set([1, 0]), includeIdle: false })
    expect(r).toEqual(table)
    expect(fetch.mock.calls[0][0]).toBe('/api/statements?from=5&to=9&contexts=0%2C1')
  })

  it('no context at all is `contexts=-`: an empty contexts list means "all" to the server', async () => {
    const doc = await makeDoc(calls)
    const { client, fetch } = fakeClient(() => new Response('{"statements":[]}'))
    await new RemoteSource(doc, client).statements({ window: null, files: new Set(), contexts: new Set(), includeIdle: true })
    expect(fetch.mock.calls[0][0]).toBe('/api/statements?contexts=-')
  })

  it('the per-statement lists carry the scope: contexts, window, `contexts=-` for none; the idle toggle only where it counts', async () => {
    const doc = await makeDoc(calls)
    const { client, fetch } = fakeClient(() => new Response(JSON.stringify({ total: 0, avgE: 0, slowest: null, rows: [], waits: {}, spans: {}, classes: [], rows2: [] })))
    const src = new RemoteSource(doc, client)
    const sc: Scope = { window: { startTim: 5, endTim: 9 }, files: new Set([0]), contexts: new Set([1, 0]), includeIdle: false }
    await src.executions(3, sc)
    await src.stmtWaits([3, 4], 6, sc)
    await src.stmtSpans([3], 100, sc)
    await src.stmtPhases([3], 100, sc)
    await src.stmtRoles({ ...sc, contexts: new Set() })
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      '/api/executions?stmt=3&limit=5000&sort=file&from=5&to=9&contexts=0%2C1',
      '/api/stmt/waits?stmt=3%2C4&max=6&from=5&to=9&contexts=0%2C1',
      '/api/stmt/spans?stmt=3&gap=100&from=5&to=9&contexts=0%2C1',
      '/api/stmt/spans?stmt=3&gap=100&phases=1&from=5&to=9&contexts=0%2C1',
      '/api/stmt/roles?from=5&to=9&contexts=-',
    ])
  })

  it('a 404 (an engine without the endpoint) is "not available", asked once', async () => {
    const doc = await makeDoc(calls)
    const { client, fetch } = fakeClient(() => new Response('not found', { status: 404 }))
    const src = new RemoteSource(doc, client)
    const sc = scope(doc, [0])
    expect(await src.statements(sc)).toBeNull()
    expect(await src.statements(scope(doc, [2]))).toBeNull()
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('other failures are errors', async () => {
    const doc = await makeDoc(calls)
    const { client } = fakeClient(() => new Response('boom', { status: 500 }))
    await expect(new RemoteSource(doc, client).statements(scope(doc, [0]))).rejects.toThrow(/boom/)
  })
})
