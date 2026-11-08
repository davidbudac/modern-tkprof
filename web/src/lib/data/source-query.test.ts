import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocalSource, RemoteSource, queryView, startQuery, useSourceQuery, type DataSource, type QuerySlot, type QueryState } from './source'
import { makeDoc } from './testdoc'
import type { ApiClient } from './client'
import type { ScopeProfile } from './derive'
import type { Finding } from './types'
import type { Scope } from '../state/store'
import { scopedFindingsView } from './scopedfindings'
import { waitsView } from '../views/Waits'

describe('source query readiness', () => {
  it('marks a remote query pending before its first answer, rather than treating the initial key as answered', async () => {
    const doc = await makeDoc([])
    const source = new RemoteSource(doc, {} as ApiClient)
    let ran = false
    function Probe() {
      const q = useSourceQuery(source, 'profile:window', () => { ran = true; return Promise.resolve(12) })
      return createElement('output', null, JSON.stringify(q))
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain('&quot;loading&quot;:true')
    expect(ran).toBe(false) // remote work starts in the effect, after the render
  })

  it('answers a local query in the render without a pending state', async () => {
    const doc = await makeDoc([])
    function Probe() {
      const q = useSourceQuery(new LocalSource(doc), 'local', () => 12)
      return createElement('output', null, JSON.stringify(q))
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain('&quot;data&quot;:12,&quot;loading&quot;:false')
  })
})

// A source as queryView sees it: an identity and a lineage.
const src = (lineage?: unknown) => ({ remote: true, lineage }) as unknown as DataSource

describe('queryView: what a query shows for its key (F01, F14)', () => {
  const a = src('server')
  it('shows the settled answer of the same key and source', () => {
    const st: QuerySlot<number> = { source: a, key: 'k1', keep: 'p', data: 1, settled: true }
    expect(queryView(st, a, 'k1', 'p')).toEqual({ data: 1, loading: false, error: null, stale: false })
  })
  it("retains another key's answer under the same keep, flagged stale, while the new key loads", () => {
    const st: QuerySlot<number> = { source: a, key: 'profile:A', keep: 'p', data: 1, settled: true }
    expect(queryView(st, a, 'profile:B', 'p')).toEqual({ data: 1, loading: true, error: null, stale: true })
  })
  it('shows nothing while another key loads without a keep (numbers of a scope)', () => {
    const st: QuerySlot<number> = { source: a, key: 'profile:A', data: 1, settled: true }
    expect(queryView(st, a, 'profile:B')).toEqual({ data: undefined, loading: true, error: null, stale: false })
  })
  it("drops another statement's answer when the keep names the statement, keeps the same statement's across scopes", () => {
    const st: QuerySlot<number> = { source: a, key: 'executions:1:all', keep: 'executions:1', data: 1, settled: true }
    expect(queryView(st, a, 'executions:2:all', 'executions:2')).toEqual({ data: undefined, loading: true, error: null, stale: false })
    expect(queryView(st, a, 'executions:1:w', 'executions:1')).toEqual({ data: 1, loading: true, error: null, stale: true })
  })
  it("keeps the same key's answer across a new source of the same lineage (live refresh), not stale", () => {
    const st: QuerySlot<number> = { source: a, key: 'k1', data: 1, settled: true }
    expect(queryView(st, src('server'), 'k1')).toEqual({ data: 1, loading: true, error: null, stale: false })
    // same lineage, another key with the same keep: retained but stale
    expect(queryView({ ...st, keep: 'p' }, src('server'), 'k2', 'p')).toEqual({ data: 1, loading: true, error: null, stale: true })
    // another lineage (another trace) keeps nothing
    expect(queryView(st, src('other'), 'k1')).toMatchObject({ data: undefined, loading: true, stale: false })
    // no lineage: no relation
    expect(queryView({ ...st, source: src() }, src(), 'k1')).toMatchObject({ data: undefined, loading: true, stale: false })
  })
  it("shows the error of the same key, and nothing while the next key loads after another key's error", () => {
    const st: QuerySlot<number> = { source: a, key: 'k1', keep: 'p', error: 'boom', settled: true }
    expect(queryView(st, a, 'k1', 'p')).toEqual({ data: undefined, loading: false, error: 'boom', stale: false })
    expect(queryView(st, a, 'k2', 'p')).toEqual({ data: undefined, loading: true, error: null, stale: false })
  })
  it('is pending, not answered, on the initial slot of a mount', () => {
    expect(queryView({ source: a, key: 'k1' }, a, 'k1', 'p')).toEqual({ data: undefined, loading: true, error: null, stale: false })
  })
})

const tick = () => new Promise((r) => setTimeout(r, 0))

describe('startQuery: a cancelled key never lands (F01)', () => {
  it('drops the late answer of an aborted key and lands the current one', async () => {
    const a = src('server')
    const landed: QuerySlot<string>[] = []
    let resolveA!: (v: string) => void
    let signalA!: AbortSignal
    const cancelA = startQuery(a, 'A', 'p', (signal) => { signalA = signal; return new Promise<string>((r) => { resolveA = r }) }, (st) => landed.push(st))
    cancelA() // the key changed to B
    expect(signalA.aborted).toBe(true)
    startQuery(a, 'B', 'p', () => Promise.resolve('b'), (st) => landed.push(st))
    resolveA('a') // A answers late
    await tick()
    expect(landed).toEqual([{ source: a, key: 'B', keep: 'p', data: 'b', settled: true }])
  })
  it('lands a failure as an error, but not an abort', async () => {
    const a = src()
    const landed: QuerySlot<string>[] = []
    startQuery(a, 'A', undefined, () => Promise.reject(new Error('500 boom')), (st) => landed.push(st))
    startQuery(a, 'B', undefined, () => Promise.reject(new DOMException('aborted', 'AbortError')), (st) => landed.push(st))
    await tick()
    expect(landed).toEqual([{ source: a, key: 'A', keep: undefined, error: '500 boom', settled: true }])
  })
})

const q = <T,>(over: Partial<QueryState<T>>): QueryState<T> => ({ data: undefined, loading: false, error: null, stale: false, ...over })
const prof = (cpuUs: number) => ({ cpuUs, events: [], responseUs: 0, wallUs: 0, sessions: 1 }) as unknown as ScopeProfile

describe('waitsView: the Waits table never shows another scope or a silent whole-trace fallback (F01)', () => {
  it("shows this scope's profile", () => {
    const p = prof(1)
    expect(waitsView(true, q({ data: p }))).toEqual({ profile: p, loading: false, notice: null })
    // a live refresh of the same key keeps it while the next answer loads
    expect(waitsView(true, q({ data: p, loading: true }))).toEqual({ profile: p, loading: false, notice: null })
  })
  it("shows an empty pending table, not another scope's profile, while the scope's loads", () => {
    expect(waitsView(true, q({ data: prof(1), loading: true, stale: true }))).toEqual({ profile: undefined, loading: true, notice: null })
    expect(waitsView(true, q({ loading: true }))).toEqual({ profile: undefined, loading: true, notice: null })
  })
  it('names the whole-trace fallback when the scoped profile fails or is not available', () => {
    expect(waitsView(true, q<ScopeProfile | null>({ error: 'profile: 500' })).notice).toMatch(/unavailable \(profile: 500\): showing the whole trace/)
    expect(waitsView(true, q<ScopeProfile | null>({ data: null })).notice).toMatch(/showing the whole trace/)
    // nothing narrows: the whole trace is what was asked for
    expect(waitsView(false, q<ScopeProfile | null>({ error: 'boom' })).notice).toBeNull()
  })
})

describe('scopedFindingsView: narrowed only for this scope (F01; Statements counts from .findings)', () => {
  const all = [{ rule: 'all' }] as unknown as Finding[]
  const mine = [{ rule: 'mine' }] as unknown as Finding[]
  it("labels this scope's findings as narrowed", () => {
    expect(scopedFindingsView(all, true, q({ data: mine }))).toEqual({ findings: mine, narrowed: true, loading: false, notice: null })
  })
  it("shows the whole set, loading, while another scope's findings are retained", () => {
    expect(scopedFindingsView(all, true, q({ data: mine, loading: true, stale: true }))).toEqual({ findings: all, narrowed: false, loading: true, notice: null })
  })
  it('names the whole-set fallback on failure and on an engine without the route', () => {
    expect(scopedFindingsView(all, true, q<Finding[] | null>({ error: 'boom' }))).toMatchObject({ findings: all, narrowed: false, loading: false, notice: expect.stringMatching(/unavailable \(boom\)/) })
    expect(scopedFindingsView(all, true, q<Finding[] | null>({ data: null }))).toMatchObject({ findings: all, narrowed: false, notice: expect.stringMatching(/does not answer/) })
  })
  it('is the whole trace when nothing narrows', () => {
    expect(scopedFindingsView(all, false, q({ data: mine }))).toEqual({ findings: all, narrowed: false, loading: false, notice: null })
  })
})

/** A client whose answers the test releases: each fetch is recorded with its signal; an abort rejects it as fetch does. */
function heldClient() {
  const calls: { path: string; signal: AbortSignal; answer(status: number, body: unknown): void }[] = []
  const client: ApiClient = {
    base: '',
    fetch: (path, init) => new Promise<Response>((resolve, reject) => {
      const signal = init!.signal!
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      calls.push({ path, signal, answer: (status, body) => resolve(new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })) })
    }),
  }
  return { client, calls }
}

const wholeScope: Scope = { window: null, files: null, contexts: null, includeIdle: false }
const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

describe('RemoteSource: concurrent identical requests share one transport call (F05)', () => {
  const findingsOf = (n: number) => ({ findings: Array.from({ length: n }, (_, i) => ({ rule: `r${i}` })) })

  it('makes one fetch for two concurrent identical calls, both resolve; a third after settlement is answered by the cache', async () => {
    const { client, calls } = heldClient()
    const source = new RemoteSource(await makeDoc([]), client)
    const a = source.findings(wholeScope, new AbortController().signal)
    const b = source.findings(wholeScope, new AbortController().signal)
    await tick()
    expect(calls).toHaveLength(1)
    calls[0].answer(200, findingsOf(2))
    const [ra, rb] = await Promise.all([a, b])
    expect(ra).toHaveLength(2)
    expect(rb).toBe(ra)
    expect(await source.findings(wholeScope)).toBe(ra)
    expect(calls).toHaveLength(1)
  })

  it('keeps different parameters apart', async () => {
    const { client, calls } = heldClient()
    const source = new RemoteSource(await makeDoc([]), client)
    void source.findings(wholeScope)
    void source.findings({ ...wholeScope, contexts: new Set([1]) })
    await tick()
    expect(calls.map((c) => c.path)).toEqual(['/api/findings', '/api/findings?contexts=1'])
  })

  it('goes on when one of two callers aborts, and the other gets the answer', async () => {
    const { client, calls } = heldClient()
    const source = new RemoteSource(await makeDoc([]), client)
    const acA = new AbortController()
    const a = source.findings(wholeScope, acA.signal)
    const b = source.findings(wholeScope, new AbortController().signal)
    await tick()
    acA.abort()
    await expect(a).rejects.toSatisfy(isAbort)
    expect(calls[0].signal.aborted).toBe(false)
    calls[0].answer(200, findingsOf(1))
    expect(await b).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('aborts the shared request when every caller aborts, and a later call starts a new one', async () => {
    const { client, calls } = heldClient()
    const source = new RemoteSource(await makeDoc([]), client)
    const acA = new AbortController(), acB = new AbortController()
    const a = source.findings(wholeScope, acA.signal)
    const b = source.findings(wholeScope, acB.signal)
    await tick()
    acA.abort(); acB.abort()
    await expect(a).rejects.toSatisfy(isAbort)
    await expect(b).rejects.toSatisfy(isAbort)
    expect(calls[0].signal.aborted).toBe(true)
    const c = source.findings(wholeScope)
    await tick()
    expect(calls).toHaveLength(2)
    calls[1].answer(200, findingsOf(3))
    expect(await c).toHaveLength(3)
  })

  it('does not hand a failure to the next caller: it fetches again', async () => {
    const { client, calls } = heldClient()
    const source = new RemoteSource(await makeDoc([]), client)
    const a = source.findings(wholeScope)
    const b = source.findings(wholeScope)
    await tick()
    calls[0].answer(500, 'engine busy')
    await expect(a).rejects.toThrow(/engine busy/)
    await expect(b).rejects.toThrow(/engine busy/)
    const c = source.findings(wholeScope)
    await tick()
    expect(calls).toHaveLength(2)
    calls[1].answer(200, findingsOf(1))
    expect(await c).toHaveLength(1)
  })

  it('keeps the bounded completed cache: the oldest answer is evicted past 200 URLs', async () => {
    const { client, calls } = heldClient()
    const source = new RemoteSource(await makeDoc([]), client)
    for (let i = 0; i <= 200; i++) {
      const p = source.findings({ ...wholeScope, contexts: new Set([i]) })
      await tick()
      calls[calls.length - 1].answer(200, findingsOf(0))
      await p
    }
    expect(calls).toHaveLength(201)
    await source.findings({ ...wholeScope, contexts: new Set([200]) }) // still cached
    expect(calls).toHaveLength(201)
    const first = source.findings({ ...wholeScope, contexts: new Set([0]) }) // evicted: asked again
    await tick()
    expect(calls).toHaveLength(202)
    calls[201].answer(200, findingsOf(0))
    await first
  })
})
