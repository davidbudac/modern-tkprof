import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, type TraceDoc } from '@lib'
import { chatOf } from '../assist/conversation'
import { Workspace, canCompare, defaultOpenOptions, dropOptions, dropOverlayText, leaveRoute, openRequest, type OpenOptions, type Route, type Tab } from './workspace'
import { OpenQueue } from './openQueue'

const kv = vi.hoisted(() => new Map<string, unknown>())
const annotationsKV = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../platform', () => ({
  logInfo: vi.fn(),
  openKV: async (name: string) => {
    const store = name === 'annotations.json' ? annotationsKV : kv
    return { get: async (k: string) => store.get(k), set: async (k: string, v: unknown) => { store.set(k, v) }, delete: async (k: string) => { store.delete(k) }, keys: async () => [...store.keys()] }
  },
}))
vi.mock('@lib', async (original) => ({
  ...await original<typeof import('@lib')>(),
  fromRaw: async () => {
    const doc = { statements: [], events: [], cursors: [], contexts: [], file: {} } as unknown as TraceDoc
    return { doc, compare: { a: doc, b: doc, diff: { statements: [], events: [], totals: [] } } }
  },
}))

const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve() }

function sources() {
  const ws = new Workspace()
  const keys = ['a.trc', 'b.trc'].map((p) => ws.open({ paths: [p], options: { binds: 'keep' } }))
  for (const key of keys) Object.assign(ws.tab(key)!, { state: 'ready', sessionId: key, session: createSession() })
  // No pending open requests: bind sees both sources as already owned sessions.
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) => new Response('{}', { headers: { 'content-type': 'application/json' } }))
  ws.bind({ client: { base: '', fetch }, addr: 'first', token: 'token' })
  return { ws, keys, fetch }
}

beforeEach(() => { kv.clear(); annotationsKV.clear() })

describe('workspace close', () => {
  it('drops the chat of the tab that closes', async () => {
    const { ws, keys } = sources()
    const chat = chatOf(keys[0], 'trace-a')
    expect(chatOf(keys[0], 'trace-a')).toBe(chat)
    ws.close(keys[0])
    expect(chatOf(keys[0], 'trace-a')).not.toBe(chat)
    expect(chatOf(keys[1], 'trace-b')).toBe(chatOf(keys[1], 'trace-b'))
  })
})

describe('workspace comparison snapshots', () => {
  it('compares ordered sources, keeps snapshot after closing a source, excludes it from restore data', async () => {
    const { ws, keys, fetch } = sources()
    const key = await ws.compare(keys[0], keys[1])
    const tab = ws.tab(key)!
    expect(fetch.mock.calls[0][0]).toBe(`/engine/compare?a=${keys[0]}&b=${keys[1]}`)
    expect(tab.origin).toBe('comparison')
    expect(tab.sessionId).toBeNull()
    expect(tab.session!.store.getState()).toMatchObject({ view: 'compare', linesApi: false, linesAvailable: false })
    ws.close(keys[0])
    expect(ws.tab(key)?.session).toBe(tab.session)
    await tick()
    expect((kv.get('open') as { set: unknown }[])).toHaveLength(1)
    fetch.mockClear()
    ws.bind({ client: { base: '', fetch }, addr: 'restart', token: 'token2' })
    expect(ws.tab(key)?.state).toBe('ready')
    expect(fetch.mock.calls.every(([path]) => !String(path).includes('/engine/compare'))).toBe(true)
  })

  it('rejects identical, live, opening and comparison inputs without fetching', async () => {
    const { ws, keys, fetch } = sources()
    await expect(ws.compare(keys[0], keys[0])).rejects.toThrow()
    Object.assign(ws.tab(keys[1])!, { live: true })
    await expect(ws.compare(keys[0], keys[1])).rejects.toThrow()
    expect(fetch).not.toHaveBeenCalled()
    expect(canCompare({ ...ws.tab(keys[0])!, origin: 'comparison' } as Tab)).toBe(false)
    expect(canCompare({ ...ws.tab(keys[0])!, state: 'opening' } as Tab)).toBe(false)
  })

  it('moves tabs, preserving active selection and saved order', async () => {
    const { ws, keys } = sources()
    ws.go({ kind: 'tab', key: keys[0] })
    ws.move(keys[0], 1)
    expect(ws.getSnapshot().tabs.map((t) => t.key)).toEqual([keys[1], keys[0]])
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: keys[0] })
    await tick()
    expect((kv.get('open') as { set: { paths: string[] } }[]).map((t) => t.set.paths[0])).toEqual(['b.trc', 'a.trc'])
    expect(kv.get('active')).toBe(1)
  })
})


describe('annotation imports with open traces', () => {
  it('cancels stale pending saves, refreshes live state, and preserves imported entries on the next edit', async () => {
    vi.useFakeTimers()
    try {
      const { ws, keys } = sources()
      const tab = ws.tab(keys[0])!
      const session = tab.session!
      Object.assign(tab, { identity: 'content-a' })
      const note = (id: string, updated: number) => ({ id, kind: 'window' as const, note: id, from: 1, to: 2, created: 1, updated })
      // Attach the production persistence watcher to this test's ready session.
      ;(ws as unknown as { watchSession(key: string, session: NonNullable<Tab['session']>): void }).watchSession(tab.key, session)
      session.store.actions.setAnnotations([note('local', 1)])
      session.store.actions.setBookmarks([{ file: 0, line: 1, label: 'local' }])
      await ws.importInvestigationAnnotations({ 'content-a': { notes: [note('imported', 2)], bookmarks: [{ file: 0, line: 2, label: 'imported' }] } })
      expect(session.store.getState().annotations.map((n) => n.id)).toEqual(['imported', 'local'])
      expect(session.store.getState().bookmarks.map((b) => b.line)).toEqual([1, 2])
      session.store.actions.addAnnotation(note('next-edit', 3))
      session.store.actions.setBookmarks([...session.store.getState().bookmarks, { file: 0, line: 3, label: 'next' }])
      await vi.advanceTimersByTimeAsync(400)
      const stored = annotationsKV.get('content-a') as { notes: { id: string }[]; bookmarks: { line: number }[] }
      expect(stored.notes.map((n) => n.id)).toEqual(['imported', 'local', 'next-edit'])
      expect(stored.bookmarks.map((b) => b.line)).toEqual([1, 2, 3])
      ws.close(tab.key)
    } finally { vi.useRealTimers() }
  })
})

describe('investigation persistence at action boundaries', () => {
  const note = (id: string) => ({ id, kind: 'window' as const, note: id, from: 1, to: 2, created: 1, updated: 1 })
  function watched() {
    const { ws, keys } = sources()
    const tab = ws.tab(keys[0])!
    Object.assign(tab, { identity: 'content-a' })
    ;(ws as unknown as { watchSession(key: string, session: NonNullable<Tab['session']>): void }).watchSession(tab.key, tab.session!)
    return { ws, tab, store: tab.session!.store }
  }

  it('flushes pending notes and bookmarks when the tab closes immediately', async () => {
    vi.useFakeTimers()
    try {
      const { ws, tab, store } = watched()
      store.actions.setAnnotations([note('last-edit')])
      store.actions.setBookmarks([{ file: 0, line: 9, label: 'last bookmark' }])
      ws.close(tab.key)
      const exported = await ws.exportInvestigationAnnotations()
      expect(exported['content-a'].notes?.map((n) => n.id)).toEqual(['last-edit'])
      expect(exported['content-a'].bookmarks?.map((b) => b.line)).toEqual([9])
    } finally { vi.useRealTimers() }
  })

  it('exports edits before the debounce timer has fired', async () => {
    vi.useFakeTimers()
    try {
      const { ws, tab, store } = watched()
      store.actions.setAnnotations([note('last-edit')])
      store.actions.setBookmarks([{ file: 0, line: 7, label: 'pending' }])
      const exported = await ws.exportInvestigationAnnotations()
      expect(exported['content-a'].notes?.map((n) => n.id)).toEqual(['last-edit'])
      expect(exported['content-a'].bookmarks?.map((b) => b.line)).toEqual([7])
      ws.close(tab.key)
    } finally { vi.useRealTimers() }
  })

  it('imports without deleting disk notes absent from a stale open tab', async () => {
    const { ws, tab, store } = watched()
    annotationsKV.set('content-a', { notes: [note('disk-only')], bookmarks: [{ file: 0, line: 4, label: 'disk' }] })
    expect(store.getState().annotations).toEqual([])
    await ws.importInvestigationAnnotations({ 'content-a': { notes: [note('imported')] } })
    expect(store.getState().annotations.map((n) => n.id)).toEqual(['disk-only', 'imported'])
    const exported = await ws.exportInvestigationAnnotations()
    expect(exported['content-a'].notes?.map((n) => n.id)).toEqual(['disk-only', 'imported'])
    expect(exported['content-a'].bookmarks?.map((b) => b.line)).toEqual([4])
    ws.close(tab.key)
  })
})

describe('leaving a page', () => {
  const page = (id: string) => ({ kind: 'page' as const, id })
  const tabs = ['a', 'b'].map((k) => ({ key: k }) as Tab)

  it('leaveRoute prefers a live origin, then the last tab, then the open screen', () => {
    expect(leaveRoute(tabs, { kind: 'tab', key: 'a' })).toEqual({ kind: 'tab', key: 'a' })
    expect(leaveRoute(tabs, { kind: 'open' })).toEqual({ kind: 'open' })
    expect(leaveRoute(tabs, { kind: 'tab', key: 'gone' })).toEqual({ kind: 'tab', key: 'b' })
    expect(leaveRoute(tabs)).toEqual({ kind: 'tab', key: 'b' })
    expect(leaveRoute([], { kind: 'tab', key: 'gone' })).toEqual({ kind: 'open' })
  })

  it('remembers where the page was entered from, across page to page', () => {
    const ws = new Workspace()
    const a = ws.open({ paths: ['a.trc'], options: { binds: 'keep' } })
    ws.open({ paths: ['b.trc'], options: { binds: 'keep' } })
    ws.go({ kind: 'tab', key: a })
    ws.go(page('settings'))
    ws.go(page('connections'))
    expect(ws.getSnapshot().origin).toEqual({ kind: 'tab', key: a })
    ws.leavePage()
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: a })
    expect(ws.getSnapshot().origin).toBeUndefined()
  })

  it('goes back to the open screen, or falls back when the origin tab was closed', () => {
    const ws = new Workspace()
    const a = ws.open({ paths: ['a.trc'], options: { binds: 'keep' } })
    ws.go({ kind: 'open' })
    ws.go(page('settings'))
    ws.leavePage()
    expect(ws.getSnapshot().route).toEqual({ kind: 'open' })
    ws.go({ kind: 'tab', key: a })
    ws.go(page('settings'))
    ws.close(a)
    ws.leavePage()
    expect(ws.getSnapshot().route).toEqual({ kind: 'open' })
  })
})

describe('open options and drops (F02)', () => {
  const open: Route = { kind: 'open' }
  const tab: Route = { kind: 'tab', key: 't1' }
  const settings = { binds: 'keep' as const, salt: 'global' }
  const shown = (o: Partial<OpenOptions>): OpenOptions => ({ binds: 'keep', salt: '', follow: false, ...o })

  it('setOpenOptions replaces the snapshot value and notifies; the options are not persisted', async () => {
    const ws = new Workspace()
    let calls = 0
    ws.subscribe(() => calls++)
    expect(ws.getSnapshot().openOptions).toEqual({ binds: 'keep', salt: '', follow: false })
    ws.setOpenOptions({ binds: 'redact', salt: 'x', follow: true })
    expect(ws.getSnapshot().openOptions).toEqual({ binds: 'redact', salt: 'x', follow: true })
    expect(calls).toBe(1)
    await tick()
    expect(kv.has('openOptions')).toBe(false)
  })
  it('a fresh open screen starts from the settings', () => {
    expect(defaultOpenOptions({ binds: 'redact', salt: 's' })).toEqual({ binds: 'redact', salt: 's', follow: false })
  })
  it('openRequest keeps the salt only for redact and follow only when set', () => {
    expect(openRequest({ binds: 'keep', salt: 'x', follow: false })).toEqual({ binds: 'keep', salt: undefined, follow: undefined })
    expect(openRequest({ binds: 'redact', salt: 'x', follow: true })).toEqual({ binds: 'redact', salt: 'x', follow: true })
    expect(openRequest({ binds: 'redact', salt: '' }).salt).toBeUndefined()
  })
  it('on the open screen a drop uses the displayed options, like the picker', () => {
    const o = shown({ binds: 'redact', salt: 'mine' })
    expect(dropOptions(open, o, settings, ['a.trc', 'b.trc'])).toEqual({ options: openRequest(o) })
    expect(dropOptions(open, shown({ binds: 'none', salt: 'mine' }), settings, ['a.trc']).options).toMatchObject({ binds: 'none', salt: undefined })
  })
  it('elsewhere a drop uses the settings defaults, whatever the open screen last held', () => {
    const o = shown({ binds: 'none', follow: true })
    expect(dropOptions(tab, o, settings, ['a.trc'])).toEqual({ options: { binds: 'keep', salt: undefined, follow: undefined } })
    expect(dropOptions({ kind: 'page', id: 'settings' }, o, { binds: 'redact', salt: 'g' }, ['a.trc']).options).toEqual({ binds: 'redact', salt: 'g', follow: undefined })
  })
  it('follow applies to one dropped path; several open without it and say so', () => {
    const o = shown({ follow: true })
    expect(dropOptions(open, o, settings, ['live.trc'])).toEqual({ options: { binds: 'keep', salt: undefined, follow: true } })
    const many = dropOptions(open, o, settings, ['a.trc', 'b.trc'])
    expect(many.options.follow).toBeUndefined()
    expect(many.notice).toMatch(/follow/i)
  })
  it('the overlay says which options apply', () => {
    expect(dropOverlayText(open, shown({ binds: 'redact', follow: true }), settings)).toBe('Opens with the options above · binds redacted · follow')
    expect(dropOverlayText(tab, shown({ binds: 'redact', follow: true }), settings)).toBe('Opens with the default options · binds kept')
  })
})

describe('OpenQueue (F04)', () => {
  /** start promises the test settles by hand */
  function harness(alive: (k: string) => boolean = () => true, limit?: number) {
    const started: string[] = []
    const gates = new Map<string, { ok: () => void; fail: () => void }>()
    const q = new OpenQueue(
      (k) => new Promise<void>((ok, fail) => { started.push(k); gates.set(k, { ok, fail: () => fail(new Error('boom')) }) }),
      alive,
      limit,
    )
    const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve() }
    return { q, started, gates, flush }
  }

  it('starts at most two at a time, in order, and the next as one finishes', async () => {
    const { q, started, gates, flush } = harness()
    q.add(['a', 'b', 'c', 'd'])
    expect(started).toEqual(['a', 'b'])
    expect(q.active).toBe(2)
    expect(q.queued).toBe(2)
    gates.get('a')!.ok()
    await flush()
    expect(started).toEqual(['a', 'b', 'c'])
    gates.get('c')!.ok()
    gates.get('b')!.ok()
    await flush()
    expect(started).toEqual(['a', 'b', 'c', 'd'])
    expect(q.active).toBe(1)
  })
  it('first puts the keys in front of those waiting, and prioritize moves one up', async () => {
    const { q, started, gates, flush } = harness(() => true, 1)
    q.add(['a', 'b', 'c', 'd'])
    q.prioritize('d')
    q.prioritize('a') // already running: ignored
    gates.get('a')!.ok()
    await flush()
    expect(started).toEqual(['a', 'd'])
    q.add(['x'], true)
    gates.get('d')!.ok()
    await flush()
    expect(started).toEqual(['a', 'd', 'x'])
  })
  it('skips a key whose tab was closed while it waited', async () => {
    const closed = new Set<string>()
    const { q, started, gates, flush } = harness((k) => !closed.has(k), 1)
    q.add(['a', 'b', 'c'])
    closed.add('b')
    gates.get('a')!.ok()
    await flush()
    expect(started).toEqual(['a', 'c'])
  })
  it('a failed or throwing start releases its slot', async () => {
    const started: string[] = []
    const gates: Record<string, () => void> = {}
    const q = new OpenQueue(
      (k) => {
        started.push(k)
        if (k === 'bad') throw new Error('sync')
        return new Promise<void>((_, fail) => { gates[k] = () => fail(new Error('boom')) })
      },
      () => true,
      1,
    )
    q.add(['a', 'bad', 'c'])
    expect(started).toEqual(['a'])
    gates.a()
    for (let i = 0; i < 6; i++) await Promise.resolve()
    expect(started).toEqual(['a', 'bad', 'c'])
    expect(q.active).toBe(1)
  })
  it('does not queue a key twice, nor one that is running', async () => {
    const { q, started, flush } = harness()
    q.add(['a', 'a', 'b'])
    q.add(['a', 'b', 'c'])
    await flush()
    expect(started).toEqual(['a', 'b'])
    expect(q.queued).toBe(1)
  })
  it('clear drops the waiting keys and takes no more', async () => {
    const { q, started, gates, flush } = harness(() => true, 1)
    q.add(['a', 'b'])
    q.clear()
    gates.get('a')!.ok()
    await flush()
    q.add(['c'])
    expect(started).toEqual(['a'])
  })
})

describe('restoring a workspace (F04)', () => {
  it('opens the shown tab first and no more than two traces at once', async () => {
    kv.set('open', ['a', 'b', 'c', 'd'].map((n) => ({ title: n, set: { paths: [`${n}.trc`], options: { binds: 'keep' } } })))
    kv.set('active', 2)
    const posted: string[] = []
    const ws = new Workspace()
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path === '/engine/sessions') {
        const paths = JSON.parse(String(init.body)).paths as string[]
        posted.push(paths[0])
        return new Response(JSON.stringify({ session: { id: `s-${paths[0]}`, state: 'opening', paths }, job: { id: `j-${paths[0]}` } }), { status: 202, headers: { 'content-type': 'application/json' } })
      }
      // the session never becomes ready: the slots stay taken
      const id = decodeURIComponent(path.split('/').pop()!)
      return new Response(JSON.stringify({ id, state: 'opening', paths: [] }), { headers: { 'content-type': 'application/json' } })
    })
    ws.bind({ client: { base: '', fetch } as never, addr: 'first', token: 'token' })
    await ws.restore({ startEmpty: false })
    for (let i = 0; i < 30; i++) await Promise.resolve()
    expect(posted).toEqual(['c.trc', 'a.trc'])
    expect(ws.getSnapshot().tabs.map((t) => t.state)).toEqual(['opening', 'opening', 'opening', 'opening'])
  })
  it('a trace that fails to open frees its slot for the next one', async () => {
    kv.set('open', ['a', 'b', 'c'].map((n) => ({ title: n, set: { paths: [`${n}.trc`], options: { binds: 'keep' } } })))
    kv.set('active', 0)
    const posted: string[] = []
    const ws = new Workspace()
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path === '/engine/sessions') {
        const paths = JSON.parse(String(init.body)).paths as string[]
        posted.push(paths[0])
        return new Response(JSON.stringify({ session: { id: `s-${paths[0]}`, state: 'opening', paths }, job: { id: `j-${paths[0]}` } }), { status: 202, headers: { 'content-type': 'application/json' } })
      }
      const id = decodeURIComponent(path.split('/').pop()!)
      return new Response(JSON.stringify({ id, state: id === 's-a.trc' ? 'failed' : 'opening', error: 'bad trace', paths: [] }), { headers: { 'content-type': 'application/json' } })
    })
    ws.bind({ client: { base: '', fetch } as never, addr: 'first', token: 'token' })
    await ws.restore({ startEmpty: false })
    for (let i = 0; i < 40; i++) await Promise.resolve()
    expect(posted).toEqual(['a.trc', 'b.trc', 'c.trc'])
    expect(ws.getSnapshot().tabs.map((t) => t.state)).toEqual(['failed', 'opening', 'opening'])
  })
  it('closing a queued tab means it is never opened', async () => {
    kv.set('open', ['a', 'b', 'c'].map((n) => ({ title: n, set: { paths: [`${n}.trc`], options: { binds: 'keep' } } })))
    kv.set('active', 0)
    const posted: string[] = []
    const ws = new Workspace()
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST' && path === '/engine/sessions') {
        const paths = JSON.parse(String(init.body)).paths as string[]
        posted.push(paths[0])
        return new Response(JSON.stringify({ session: { id: `s-${paths[0]}`, state: 'opening', paths }, job: { id: `j-${paths[0]}` } }), { status: 202, headers: { 'content-type': 'application/json' } })
      }
      const id = decodeURIComponent(path.split('/').pop()!)
      return new Response(JSON.stringify({ id, state: id === 's-a.trc' ? 'failed' : 'opening', paths: [] }), { headers: { 'content-type': 'application/json' } })
    })
    ws.bind({ client: { base: '', fetch } as never, addr: 'first', token: 'token' })
    await ws.restore({ startEmpty: false })
    // c waits behind a and b (limit 2); close it before a slot frees
    const c = ws.getSnapshot().tabs[2].key
    ws.close(c)
    for (let i = 0; i < 40; i++) await Promise.resolve()
    expect(posted).toEqual(['a.trc', 'b.trc'])
  })
})
