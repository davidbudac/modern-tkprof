import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TraceDoc } from '@lib'
import { Workspace, canCompare } from './workspace'

const kv = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../platform', () => ({
  logInfo: vi.fn(),
  openKV: async () => ({ get: async (k: string) => kv.get(k), set: async (k: string, v: unknown) => { kv.set(k, v) }, delete: async (k: string) => { kv.delete(k) }, keys: async () => [...kv.keys()] }),
}))
// the document the engine serves is the JSON itself: tests put the fields the workspace reads in it
vi.mock('@lib', async (original) => ({
  ...(await original<typeof import('@lib')>()),
  fromRaw: async (raw: unknown) => ({ doc: raw as TraceDoc, compare: null }),
}))

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const base = { statements: [], events: [], cursors: [], contexts: [], file: {} }
const dumpDoc = { ...base, dump: { file: { name: 'h.trc', lines: 100, sections: [], outline: [], outlineTotal: 0 } } }
const plainDoc = { ...base, diag: { notes: [] } }

beforeEach(() => { kv.clear() })
afterEach(() => { vi.unstubAllGlobals() })

const opts = { binds: 'keep' } as const

interface Post { paths: string[]; options?: { follow?: boolean; view?: string; binds?: string } }

/** An engine that opens every session at once; the document of a session is that of its first path and view (`docs['path']`, or `docs['path|view']`). */
function engine(docs: Record<string, unknown>, held: (paths: string[]) => string[] = (p) => p) {
  const sessions = new Map<string, { id: string; paths: string[]; view?: string }>()
  const posts: Post[] = []
  const docOf = (s: { paths: string[]; view?: string }) => docs[`${s.paths[0]}|${s.view ?? ''}`] ?? docs[s.paths[0]]
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST' && path === '/engine/sessions') {
      const body = JSON.parse(String(init.body)) as Post
      posts.push(body)
      const id = `s${sessions.size}-${body.paths[0]}`
      sessions.set(id, { id, paths: body.paths, view: body.options?.view })
      return json({ session: { id, state: 'opening', paths: body.paths }, job: { id: `j-${id}` } }, 202)
    }
    const m = /^\/engine\/sessions\/([^/]+)$/.exec(path)
    if (m) {
      const s = sessions.get(decodeURIComponent(m[1]))!
      const d = docOf(s) as { dump?: unknown; opt?: unknown }
      const view = s.view ?? (d.dump ? 'diag' : d.opt ? '10053' : '10046')
      return json({ id: s.id, state: 'ready', rev: 1, paths: s.paths, identity: `id-${s.id}`, hit: false, view, files: held(s.paths).map((p) => ({ path: p, name: p })) })
    }
    return json({})
  })
  vi.stubGlobal('fetch', async (url: string) => {
    const d = /\/s\/([^/]+)\/api\/doc$/.exec(String(url))
    if (d) return new Response(JSON.stringify(docOf(sessions.get(decodeURIComponent(d[1]))!)), { headers: { 'content-type': 'application/json', 'X-Rev': '1' } })
    return json({}, 404)
  })
  return { fetch, sessions, posts }
}

async function settle() { for (let i = 0; i < 80; i++) await Promise.resolve() }
const bind = (ws: Workspace, e: { fetch: unknown }) => ws.bind({ client: { base: '', fetch: e.fetch } as never, addr: 'a', token: 't' })

describe('opening several files at once, with files of diagnostic dumps among them', () => {
  const peeks: Record<string, { kind: string }> = { 'a.trc': { kind: '10046' }, 'b.trc': { kind: '10053' }, 'h.trc': { kind: 'diag' }, 'e.trc': { kind: 'diag' } }

  it('opens the 10046 files as one set and each optimizer trace and each dump file as a tab of its own, labelled, the set shown', () => {
    const ws = new Workspace()
    const keys = ws.openSplit(['h.trc', 'a.trc', 'b.trc', 'e.trc'], (p) => peeks[p], { binds: 'keep', follow: true })
    const tabs = ws.getSnapshot().tabs
    expect(tabs.map((t) => [t.set.paths, t.kind, !!t.set.options.follow])).toEqual([[['a.trc'], undefined, true], [['b.trc'], '10053', false], [['h.trc'], 'dump', false], [['e.trc'], 'dump', false]])
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: keys[0] })
    expect(ws.getSnapshot().recent.map((r) => [r.set.paths[0], r.kind])).toEqual([['e.trc', 'dump'], ['h.trc', 'dump'], ['b.trc', '10053']]) // (the live file is not listed as recent)
  })

  it('shows the first of the own-tab files when there is no 10046 file: the optimizer traces first, then the dump files', () => {
    const ws = new Workspace()
    const keys = ws.openSplit(['h.trc', 'e.trc'], (p) => peeks[p], opts)
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: keys[0] })
    const both = new Workspace()
    const k2 = both.openSplit(['h.trc', 'b.trc'], (p) => peeks[p], opts)
    expect(both.getSnapshot().route).toEqual({ kind: 'tab', key: k2[0] })
    expect(both.tab(k2[0])!.kind).toBe('10053')
  })
})

describe('a dump tab', () => {
  it('is known from the session\'s view and the document, shows the dump reader, is not offered to Compare, and is kept in workspace.json and the recent list', async () => {
    const ws = new Workspace()
    const e = engine({ 'h.trc': dumpDoc, 'p.trc': plainDoc })
    bind(ws, e)
    const h = ws.open({ paths: ['h.trc'], options: opts })
    const p = ws.open({ paths: ['p.trc'], options: opts })
    await settle()
    expect(ws.tab(h)).toMatchObject({ kind: 'dump', state: 'ready' })
    expect(ws.tab(p)!.kind).toBeUndefined()
    expect(canCompare(ws.tab(h)!)).toBe(false)
    expect(canCompare(ws.tab(p)!)).toBe(true)
    expect(ws.tab(h)!.session!.store.getState().view).toBe('dump')
    expect(ws.tab(p)!.session!.store.getState().view).toBe('overview')
    expect(ws.getSnapshot().recent.find((r) => r.set.paths[0] === 'h.trc')!.kind).toBe('dump')
    await settle()
    expect((kv.get('open') as { kind?: string }[]).map((t) => t.kind)).toEqual(['dump', undefined])
  })

  it('is restored as a dump tab, labelled before its document is in', async () => {
    kv.set('open', [{ title: 'h.trc', set: { paths: ['h.trc'], options: opts }, kind: 'dump' }, { title: 'p.trc', set: { paths: ['p.trc'], options: opts } }])
    kv.set('active', 0)
    const ws = new Workspace()
    await ws.restore({ startEmpty: false })
    expect(ws.getSnapshot().tabs.map((t) => [t.title, t.kind, t.state])).toEqual([['h.trc', 'dump', 'opening'], ['p.trc', undefined, 'opening']])
    bind(ws, engine({ 'h.trc': dumpDoc, 'p.trc': plainDoc }))
    await settle()
    expect(ws.getSnapshot().tabs.map((t) => [t.kind, t.state, t.session?.store.getState().view])).toEqual([['dump', 'ready', 'dump'], [undefined, 'ready', 'overview']])
  })

  it('opens a file in the view it was asked for, and restores that view: the option goes to the engine and is kept in the set', async () => {
    const ws = new Workspace()
    const e = engine({ 'x.trc': plainDoc, 'x.trc|diag': dumpDoc })
    bind(ws, e)
    const k = ws.open({ paths: ['x.trc'], options: { binds: 'redact', salt: 's', view: 'diag' } })
    expect(ws.tab(k)!.kind).toBe('dump') // the badge before the session is there
    await settle()
    expect(e.posts).toEqual([{ paths: ['x.trc'], options: { binds: 'redact', salt: 's', view: 'diag' } }])
    expect(ws.tab(k)).toMatchObject({ kind: 'dump', state: 'ready' })
    await settle()
    expect((kv.get('open') as { set: { options: { view?: string } } }[])[0].set.options.view).toBe('diag')
  })

  it('does not follow a file of diagnostic dumps: it does not ask the engine for the view\'s refusal first', async () => {
    const ws = new Workspace()
    const e = engine({ 'h.trc': dumpDoc })
    bind(ws, e)
    ws.openSplit(['h.trc'], () => ({ kind: 'diag' }), { binds: 'keep', follow: true })
    await settle()
    expect(e.posts).toEqual([{ paths: ['h.trc'], options: { binds: 'keep' } }])
  })
})

describe('the notes of a 10046 trace that holds dumps', () => {
  async function trace(held?: (p: string[]) => string[]) {
    const ws = new Workspace()
    const e = engine({ '/t/x.trc': plainDoc, '/t/x.trc|diag': dumpDoc, '/t/x.trc|10053': { ...base, opt: { file: { name: 'x.trc', lines: 9, dumps: [{ idx: 0, sqlId: 'q' }] } } } }, held)
    bind(ws, e)
    const k = ws.open({ paths: ['/t/x.trc'], options: opts })
    await settle()
    return { ws, e, k }
  }

  it('offers "Open in the dump reader" beside the note of diagnostic dumps and opens the same file in a new tab with view diag', async () => {
    const { ws, e, k } = await trace()
    const act = ws.noteAction(k, '1 diagnostic dump in this file, lines 114-29753')!
    expect(act).toMatchObject({ label: 'Open in the dump reader' })
    act.run()
    await settle()
    expect(e.posts.at(-1)).toEqual({ paths: ['/t/x.trc'], options: { binds: 'keep', view: 'diag' } })
    const tabs = ws.getSnapshot().tabs
    expect(tabs.map((t) => [t.set.paths, t.kind])).toEqual([[['/t/x.trc'], undefined], [['/t/x.trc'], 'dump']])
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: tabs[1].key })
    // asked again: the tab that is open is shown, not a second one
    ws.go({ kind: 'tab', key: k })
    ws.noteAction(k, '1 diagnostic dump in this file, lines 114-29753')!.run()
    expect(ws.getSnapshot().tabs).toHaveLength(2)
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: tabs[1].key })
  })

  it('offers "Open as 10053" beside the note of an interleaved file\'s optimizer dumps and opens it with view 10053', async () => {
    const { ws, e, k } = await trace()
    const act = ws.noteAction(k, '2 optimizer (10053) dumps in this file, lines 54-18358 and 18734-27979; not shown as 10053 yet')!
    expect(act).toMatchObject({ label: 'Open as 10053' })
    act.run()
    await settle()
    expect(e.posts.at(-1)).toEqual({ paths: ['/t/x.trc'], options: { binds: 'keep', view: '10053' } })
    expect(ws.getSnapshot().tabs.map((t) => t.kind)).toEqual([undefined, '10053'])
  })

  it('finds the file a set\'s note names, and offers nothing when it cannot tell which file', async () => {
    const ws = new Workspace()
    const e = engine({ 'a.trc': plainDoc }, (p) => p)
    bind(ws, e)
    const set = ws.open({ paths: ['/t/a.trc', '/t/b.trc'], options: opts })
    await settle()
    Object.assign(ws.tab(set)!, { files: [{ path: '/t/a.trc', name: 'a.trc' }, { path: '/t/b.trc', name: 'b.trc' }] })
    ws.noteAction(set, 'b.trc has 3 heap dumps, lines 32-923, 924-1034 and 1035-1486')!.run()
    await settle()
    expect(e.posts.at(-1)).toEqual({ paths: ['/t/b.trc'], options: { binds: 'keep', view: 'diag' } })
    expect(ws.noteAction(set, '3 heap dumps in this file, lines 32-923, 924-1034 and 1035-1486')).toBeNull() // two files, and the note names none
    expect(ws.noteAction(set, 'c.trc has 1 diagnostic dump, lines 1-9')).toBeNull() // not a file of this tab
  })

  it('offers nothing in a dump tab for diagnostic dumps, nor on a comparison tab; the left-out note of a diagnostic file still opens it', async () => {
    const ws = new Workspace()
    const e = engine({ 'h.trc': dumpDoc, 'a.trc': plainDoc })
    bind(ws, e)
    const h = ws.open({ paths: ['h.trc'], options: opts })
    await settle()
    expect(ws.noteAction(h, '1 diagnostic dump in this file, lines 1-9')).toBeNull()
    expect(ws.noteAction('gone', '1 diagnostic dump in this file, lines 1-9')).toBeNull()
    const set = ws.open({ paths: ['/t/a.trc', '/t/h2.trc'], options: opts })
    const act = ws.noteAction(set, 'h2.trc holds diagnostic dumps only; open it on its own')!
    expect(act.label).toBe('Open h2.trc')
  })
})

describe('"Open as SQL trace" from a dump tab', () => {
  it('shows the SQL trace tab the dump tab was opened from instead of a second one', async () => {
    const ws = new Workspace()
    const e = engine({ '/t/x.trc': plainDoc, '/t/x.trc|diag': dumpDoc })
    bind(ws, e)
    const trace = ws.open({ paths: ['/t/x.trc'], options: opts })
    await settle()
    expect(ws.tab(trace)!.state).toBe('ready')
    ws.noteAction(trace, '1 diagnostic dump in this file, lines 114-29753')!.run()
    await settle()
    const dump = ws.getSnapshot().tabs[1].key
    expect(ws.openAs(dump, '10046')).toBe(trace)
    expect(ws.getSnapshot().tabs).toHaveLength(2)
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: trace })
    expect(e.posts).toHaveLength(2)
  })

  it('opens the same file again in a new tab with view 10046, once', async () => {
    const ws = new Workspace()
    const e = engine({ 'h.trc': dumpDoc, 'h.trc|10046': plainDoc })
    bind(ws, e)
    const h = ws.open({ paths: ['h.trc'], options: opts })
    await settle()
    const k = ws.openAs(h, '10046')!
    await settle()
    expect(e.posts.at(-1)).toEqual({ paths: ['h.trc'], options: { binds: 'keep', view: '10046' } })
    expect(ws.tab(k)).toMatchObject({ state: 'ready' })
    expect(ws.tab(k)!.kind).toBeUndefined()
    expect(ws.tab(k)!.session!.store.getState().view).toBe('overview')
    expect(ws.openAs(h, '10046')).toBe(k) // shown, not a third tab
    expect(ws.getSnapshot().tabs).toHaveLength(2)
  })

  it('refuses a set and a comparison tab, as the engine refuses a view on a set', async () => {
    const ws = new Workspace()
    bind(ws, engine({ 'a.trc': plainDoc }))
    const set = ws.open({ paths: ['a.trc', 'b.trc'], options: opts })
    expect(ws.openAs(set, 'diag')).toBeNull()
    expect(ws.openAs('gone', 'diag')).toBeNull()
  })
})
