import { describe, expect, it } from 'vitest'
import { followLive } from './live'
import { createStore } from '../state/store'
import type { ApiClient } from './client'
import type { TraceDoc } from './doc'

/** A document with `n` statements (all `carryOver` reads). */
const fakeDoc = (n: number) => ({ statements: new Array(n).fill(null), events: [], cursors: [], contexts: [], file: {} }) as unknown as TraceDoc

type Answer = { status?: number; rev?: number; live?: string; body?: unknown } | 'hang' | Error

/** A client whose `api/doc` answers come from `answers` in turn ('hang': a long poll that only ends when aborted). */
function mockClient(answers: Answer[]) {
  const calls: string[] = []
  const client: ApiClient = {
    base: '',
    fetch(path, init) {
      calls.push(path)
      const a = answers.shift() ?? 'hang'
      if (a instanceof Error) return Promise.reject(a)
      if (a === 'hang') {
        return new Promise((_, reject) => {
          const sig = init?.signal
          const abort = () => reject(new DOMException('aborted', 'AbortError'))
          if (sig?.aborted) abort(); else sig?.addEventListener('abort', abort)
        })
      }
      const headers = new Headers()
      if (a.rev !== undefined) headers.set('X-Rev', String(a.rev))
      if (a.live !== undefined) headers.set('X-Live', a.live)
      return Promise.resolve(new Response(JSON.stringify(a.body ?? { n: 1 }), { status: a.status ?? 200, headers }))
    },
  }
  return { client, calls }
}

async function until(cond: () => boolean, what: string) {
  for (let i = 0; i < 200; i++) {
    if (cond()) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const loadOf = (raw: unknown) => Promise.resolve({ doc: fakeDoc((raw as { n: number }).n), compare: null })

describe('followLive', () => {
  it('swaps in each newer revision, asks with the revision shown, and keeps the selection', async () => {
    const store = createStore()
    store.setLoaded({ doc: fakeDoc(2), compare: null })
    store.actions.selectStmt(1)
    const { client, calls } = mockClient([{ rev: 2, live: 'live', body: { n: 3 } }, { rev: 3, live: 'live', body: { n: 4 } }, 'hang'])
    const f = followLive({ store, client }, 1, { load: loadOf })
    await until(() => store.getState().live?.rev === 3, 'rev 3')
    expect(calls).toEqual(['/api/doc?rev=1', '/api/doc?rev=2', '/api/doc?rev=3'])
    const s = store.getState()
    expect(s.doc?.statements.length).toBe(4)
    expect(s.rev).toBe(3) // setLoaded + two swaps
    expect(s.selection.stmt).toBe(1)
    expect(s.view).toBe('statements')
    expect(s.live).toMatchObject({ state: 'live', paused: false, error: null })
    f.stop()
    await f.done
    expect(calls.length).toBe(3)
  })

  it('answers of the same revision (the server waited) change nothing and ask again', async () => {
    const store = createStore()
    store.setLoaded({ doc: fakeDoc(1), compare: null })
    const doc = store.getState().doc
    const { client, calls } = mockClient([{ rev: 1, live: 'live' }, 'hang'])
    const f = followLive({ store, client }, 1, { load: loadOf, minGapMs: 0 })
    await until(() => calls.length === 2, 'the second request')
    expect(store.getState().doc).toBe(doc)
    expect(calls).toEqual(['/api/doc?rev=1', '/api/doc?rev=1'])
    f.stop()
    await f.done
  })

  it('pause aborts the request on its way and asks nothing until resumed', async () => {
    const store = createStore()
    store.setLoaded({ doc: fakeDoc(1), compare: null })
    const { client, calls } = mockClient(['hang', { rev: 2, live: 'live', body: { n: 2 } }, 'hang'])
    const f = followLive({ store, client }, 1, { load: loadOf })
    await until(() => calls.length === 1, 'the first request')
    store.actions.setLivePaused(true)
    await new Promise((r) => setTimeout(r, 50))
    expect(calls.length).toBe(1)
    expect(store.getState().live).toMatchObject({ paused: true, rev: 1 })
    store.actions.setLivePaused(false)
    await until(() => store.getState().live?.rev === 2, 'rev 2 after resume')
    expect(calls).toEqual(['/api/doc?rev=1', '/api/doc?rev=1', '/api/doc?rev=2'])
    f.stop()
    await f.done
  })

  it('backs off after errors and is live again after an answer', async () => {
    const store = createStore()
    store.setLoaded({ doc: fakeDoc(1), compare: null })
    const { client, calls } = mockClient([new TypeError('network down'), { status: 502 }, { rev: 2, live: 'live', body: { n: 2 } }, 'hang'])
    const times: number[] = []
    const t0 = Date.now()
    const wrapped: ApiClient = { ...client, fetch: (p, i) => { times.push(Date.now() - t0); return client.fetch(p, i) } }
    const f = followLive({ store, client: wrapped }, 1, { load: loadOf, backoffMs: [40, 80] })
    await until(() => store.getState().live?.state === 'error', 'the error state')
    expect(store.getState().live?.error).toContain('network down')
    expect(store.getState().live?.retryAt).not.toBeNull()
    await until(() => store.getState().live?.rev === 2, 'rev 2 after the retries')
    expect(store.getState().live).toMatchObject({ state: 'live', error: null, retryAt: null })
    expect(times[1] - times[0]).toBeGreaterThanOrEqual(35) // first wait 40 ms
    expect(times[2] - times[1]).toBeGreaterThanOrEqual(75) // then 80 ms
    expect(calls.length).toBe(4)
    f.stop()
    await f.done
  })

  it('stops when the session leaves live (X-Live), and on 404 or a document without X-Rev', async () => {
    for (const end of [{ rev: 4, live: 'failed', body: { n: 5 } }, { status: 404 }, {}] as Answer[]) {
      const store = createStore()
      store.setLoaded({ doc: fakeDoc(1), compare: null })
      const { client, calls } = mockClient([end, 'hang'])
      const f = followLive({ store, client }, 3, { load: loadOf })
      await f.done
      expect(calls.length).toBe(1)
      expect(store.getState().live?.state).toBe('ended')
      if (typeof end === 'object' && !(end instanceof Error) && end.rev === 4) { // the last snapshot is shown
        expect(store.getState().live?.rev).toBe(4)
        expect(store.getState().doc?.statements.length).toBe(5)
      }
    }
  })
})
