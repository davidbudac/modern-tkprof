import { describe, expect, it } from 'vitest'
import { createStore, followLive, type TraceDoc } from '@lib'
import type { ApiClient } from '@lib/data/client'
import { LiveFollower } from './liveFollow'

const fakeDoc = (n: number) => ({ statements: new Array(n).fill(null), events: [], cursors: [], contexts: [], file: {} }) as unknown as TraceDoc
const loadOf = (raw: unknown) => Promise.resolve({ doc: fakeDoc((raw as { n: number }).n), compare: null })

type Answer = { rev: number; live?: string; n: number } | 'hang'

/** A client whose `api/doc` answers come from `answers` in turn; 'hang' is a long poll that ends only when aborted. */
function mockClient(answers: Answer[]) {
  const calls: { path: string; signal?: AbortSignal | null }[] = []
  const client: ApiClient = {
    base: '',
    fetch(path, init) {
      calls.push({ path, signal: init?.signal })
      const a = answers.shift() ?? 'hang'
      if (a === 'hang') {
        return new Promise((_, reject) => {
          const abort = () => reject(new DOMException('aborted', 'AbortError'))
          if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort)
        })
      }
      const headers = new Headers({ 'X-Rev': String(a.rev), 'X-Live': a.live ?? 'live' })
      return Promise.resolve(new Response(JSON.stringify({ n: a.n }), { headers }))
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

function tab(answers: Answer[]) {
  const store = createStore()
  store.setLoaded({ doc: fakeDoc(2), compare: null })
  const { client, calls } = mockClient(answers)
  const follower = new LiveFollower((s, rev) => followLive(s, rev, { load: loadOf, minGapMs: 0 }))
  return { store, client, calls, follower }
}

describe('LiveFollower', () => {
  it('follows a tab: one long poll, snapshots swapped in with the selection kept, revision reported', async () => {
    const t = tab([{ rev: 2, n: 3 }, 'hang'])
    t.store.actions.selectStmt(1)
    const revs: number[] = []
    t.follower.follow('a', t, 1, { onRev: (r) => revs.push(r) })
    expect(t.follower.has('a')).toBe(true)
    await until(() => t.store.getState().live?.rev === 2, 'rev 2')
    expect(t.calls.map((c) => c.path)).toEqual(['/api/doc?rev=1', '/api/doc?rev=2'])
    expect(t.store.getState().doc?.statements.length).toBe(3)
    expect(t.store.getState().selection.stmt).toBe(1)
    expect(revs).toEqual([2])
    t.follower.stop('a')
  })

  it('stop (tab closed) aborts the request in flight and asks for nothing more', async () => {
    const t = tab(['hang'])
    t.follower.follow('a', t, 1)
    await until(() => t.calls.length === 1, 'the poll')
    t.follower.stop('a')
    expect(t.calls[0].signal?.aborted).toBe(true)
    expect(t.follower.has('a')).toBe(false)
    await new Promise((r) => setTimeout(r, 30))
    expect(t.calls.length).toBe(1)
  })

  it('a paused tab does not poll; resume asks again from the shown revision', async () => {
    const t = tab(['hang', 'hang'])
    t.follower.follow('a', t, 1)
    await until(() => t.calls.length === 1, 'the poll')
    t.store.actions.setLivePaused(true)
    expect(t.calls[0].signal?.aborted).toBe(true)
    await new Promise((r) => setTimeout(r, 30))
    expect(t.calls.length).toBe(1)
    t.store.actions.setLivePaused(false)
    await until(() => t.calls.length === 2, 'the poll after resume')
    expect(t.calls[1].path).toBe('/api/doc?rev=1')
    t.follower.stop('a')
  })

  it('reports the end when the engine stops the follow, not when the tab stops it', async () => {
    const t = tab([{ rev: 2, n: 3, live: 'failed' }])
    let ended = 0
    t.follower.follow('a', t, 1, { onEnd: () => ended++ })
    await until(() => ended === 1, 'the end')
    expect(t.store.getState().live?.state).toBe('ended')
    expect(t.follower.has('a')).toBe(false)
    expect(t.store.getState().doc?.statements.length).toBe(3) // the last snapshot stays

    const u = tab(['hang'])
    let uEnded = 0
    u.follower.follow('b', u, 1, { onEnd: () => uEnded++ })
    await until(() => u.calls.length === 1, 'the poll')
    u.follower.stop('b')
    await new Promise((r) => setTimeout(r, 30))
    expect(uEnded).toBe(0)
  })

  it('follows each tab on its own and replaces a tab\'s earlier follow; stopAll ends them all', async () => {
    const a = tab(['hang'])
    const b = tab(['hang'])
    const f = new LiveFollower((s, rev) => followLive(s, rev, { load: loadOf }))
    f.follow('a', a, 1)
    f.follow('b', b, 1)
    await until(() => a.calls.length === 1 && b.calls.length === 1, 'both polls')
    f.follow('a', a, 1) // e.g. the tab's session was opened again
    expect(a.calls[0].signal?.aborted).toBe(true)
    await until(() => a.calls.length === 2, 'the new poll')
    expect(b.calls[0].signal?.aborted).toBe(false)
    f.stopAll()
    expect(a.calls[1].signal?.aborted).toBe(true)
    expect(b.calls[0].signal?.aborted).toBe(true)
    expect(f.has('a') || f.has('b')).toBe(false)
  })
})
