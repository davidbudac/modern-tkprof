import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, type TraceDoc } from '@lib'
import { chatOf } from '../assist/conversation'
import { Workspace, canCompare, leaveRoute, type Tab } from './workspace'

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
