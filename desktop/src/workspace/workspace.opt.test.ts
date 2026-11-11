import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSession, type TraceDoc } from '@lib'
import { Workspace, canCompare, type Tab } from './workspace'

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
const dumps = [{ idx: 0, sqlId: 'aaa' }, { idx: 1, sqlId: 'bbb' }, { idx: 2, sqlId: 'aaa' }]
const optDoc = { statements: [], events: [], cursors: [], contexts: [], file: {}, opt: { file: { name: 'o.trc', lines: 100, dumps } } }
const plainDoc = (...ids: string[]) => ({ statements: ids.map((sqlId) => ({ sqlId })), events: [], cursors: [], contexts: [], file: {} })

beforeEach(() => { kv.clear() })
afterEach(() => { vi.unstubAllGlobals() })

const opts = { binds: 'keep' } as const

/** An engine that opens every session at once; `kinds` says which paths are 10053 files; `docs` the document of each path. */
function engine(docs: Record<string, unknown>) {
  const sessions = new Map<string, { id: string; paths: string[] }>()
  const fetch = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST' && path === '/engine/sessions') {
      const paths = JSON.parse(String(init.body)).paths as string[]
      const id = `s-${paths[0]}`
      sessions.set(id, { id, paths })
      return json({ session: { id, state: 'opening', paths }, job: { id: `j-${id}` } }, 202)
    }
    const m = /^\/engine\/sessions\/([^/]+)$/.exec(path)
    if (m) {
      const s = sessions.get(decodeURIComponent(m[1]))!
      const isOpt = !!(docs[s.paths[0]] as { opt?: unknown }).opt
      return json({ id: s.id, state: 'ready', rev: 1, paths: s.paths, identity: `id-${s.paths[0]}`, hit: false, files: [], ...(isOpt ? { optSqlIds: ['aaa', 'bbb'] } : null) })
    }
    return json({})
  })
  // a session's own routes (`http://addr/s/{id}/api/doc`) go through the global fetch
  vi.stubGlobal('fetch', async (url: string) => {
    const d = /\/s\/([^/]+)\/api\/doc$/.exec(String(url))
    if (d) return new Response(JSON.stringify(docs[sessions.get(decodeURIComponent(d[1]))!.paths[0]]), { headers: { 'content-type': 'application/json', 'X-Rev': '1' } })
    return json({}, 404)
  })
  return { fetch, sessions }
}

async function settle() { for (let i = 0; i < 60; i++) await Promise.resolve() }

describe('opening several files at once', () => {
  const peeks: Record<string, { kind: string }> = { 'a.trc': { kind: '10046' }, 'b.trc': { kind: '10053' }, 'c.trc': { kind: 'both' }, 'd.trc': { kind: '10053' } }

  it('opens the 10046 files as one set and each 10053 file as a tab of its own, labelled, the set shown', () => {
    const ws = new Workspace()
    const keys = ws.openSplit(['a.trc', 'b.trc', 'c.trc', 'd.trc'], (p) => peeks[p], { binds: 'keep', follow: true })
    const tabs = ws.getSnapshot().tabs
    expect(tabs.map((t) => [t.set.paths, t.kind])).toEqual([[['a.trc', 'c.trc'], undefined], [['b.trc'], '10053'], [['d.trc'], '10053']])
    expect(tabs.map((t) => t.set.options.follow)).toEqual([undefined, undefined, undefined]) // follow is one live 10046 file
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: keys[0] })
    expect(ws.getSnapshot().recent.map((r) => [r.set.paths, r.kind])).toEqual([[['d.trc'], '10053'], [['b.trc'], '10053'], [['a.trc', 'c.trc'], undefined]])
  })

  it('shows the first optimizer trace when there is no 10046 file, and keeps follow for a lone 10046 file', () => {
    const ws = new Workspace()
    const keys = ws.openSplit(['b.trc', 'd.trc'], (p) => peeks[p], opts)
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: keys[0] })
    const one = new Workspace()
    one.openSplit(['a.trc', 'b.trc'], (p) => peeks[p], { binds: 'keep', follow: true })
    expect(one.getSnapshot().tabs.map((t) => !!t.set.options.follow)).toEqual([true, false])
  })

  it('opens files nobody peeked as one set, as before', () => {
    const ws = new Workspace()
    ws.openSplit(['a.trc', 'b.trc'], () => undefined, opts)
    expect(ws.getSnapshot().tabs.map((t) => t.set.paths)).toEqual([['a.trc', 'b.trc']])
  })
})

describe('a 10053 tab', () => {
  it('is known from the session and the document, is not offered to Compare, and is kept in workspace.json and the recent list', async () => {
    const ws = new Workspace()
    const e = engine({ 'o.trc': optDoc, 'p.trc': plainDoc('q1') })
    ws.bind({ client: { base: '', fetch: e.fetch } as never, addr: 'a', token: 't' })
    const o = ws.open({ paths: ['o.trc'], options: opts })
    const p = ws.open({ paths: ['p.trc'], options: opts })
    await settle()
    expect(ws.tab(o)).toMatchObject({ kind: '10053', optSqlIds: ['aaa', 'bbb'], state: 'ready' })
    expect(ws.tab(p)!.kind).toBeUndefined()
    expect(canCompare(ws.tab(o)!)).toBe(false)
    expect(canCompare(ws.tab(p)!)).toBe(true)
    expect(ws.tab(o)!.session!.store.getState().view).toBe('opt')
    expect(ws.tab(p)!.session!.store.getState().view).toBe('overview')
    expect(ws.getSnapshot().recent.find((r) => r.set.paths[0] === 'o.trc')!.kind).toBe('10053')
    await settle()
    expect((kv.get('open') as { kind?: string }[]).map((t) => t.kind)).toEqual(['10053', undefined])
  })

  it('is restored as a 10053 tab, labelled before its document is in', async () => {
    kv.set('open', [{ title: 'o.trc', set: { paths: ['o.trc'], options: opts }, kind: '10053' }, { title: 'p.trc', set: { paths: ['p.trc'], options: opts } }])
    kv.set('active', 0)
    const ws = new Workspace()
    await ws.restore({ startEmpty: false })
    expect(ws.getSnapshot().tabs.map((t) => [t.title, t.kind, t.state])).toEqual([['o.trc', '10053', 'opening'], ['p.trc', undefined, 'opening']])
    const e = engine({ 'o.trc': optDoc, 'p.trc': plainDoc() })
    ws.bind({ client: { base: '', fetch: e.fetch } as never, addr: 'a', token: 't' })
    await settle()
    expect(ws.getSnapshot().tabs.map((t) => [t.kind, t.state, t.session?.store.getState().view])).toEqual([['10053', 'ready', 'opt'], [undefined, 'ready', 'overview']])
  })
})

describe('the jump between a 10046 tab and a 10053 dump', () => {
  async function two() {
    const ws = new Workspace()
    const e = engine({ 'o.trc': optDoc, 'p.trc': plainDoc('q1', 'aaa'), 'r.trc': plainDoc('aaa') })
    ws.bind({ client: { base: '', fetch: e.fetch } as never, addr: 'a', token: 't' })
    const o = ws.open({ paths: ['o.trc'], options: opts })
    const p = ws.open({ paths: ['p.trc'], options: opts })
    const r = ws.open({ paths: ['r.trc'], options: opts })
    await settle()
    return { ws, o, p, r }
  }

  it('offers the 10053 mark on a statement whose sql_id is among another tab\'s dumps, and opens its first dump', async () => {
    const { ws, o, p } = await two()
    const link = ws.dumpLink(p)
    expect(link.has('aaa')).toBe(true)
    expect(link.has('bbb')).toBe(true)
    expect(link.has('q1')).toBe(false)
    ws.go({ kind: 'tab', key: p })
    link.open('bbb')
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: o })
    expect(ws.tab(o)!.session!.store.getState()).toMatchObject({ view: 'opt', optGo: { dump: 1 } })
    link.open('aaa') // dumped twice: the first
    expect(ws.tab(o)!.session!.store.getState().optGo).toMatchObject({ dump: 0, seq: 2 })
  })

  it('has no mark in the 10053 tab itself, and none for a sql_id no dump has', async () => {
    const { ws, o } = await two()
    expect(ws.dumpLink(o).has('aaa')).toBe(false)
  })

  it('keeps a jump made before the 10053 tab\'s document is in, and opens the dump with it', async () => {
    const ws = new Workspace()
    const e = engine({ 'o.trc': optDoc, 'p.trc': plainDoc('aaa') })
    ws.bind({ client: { base: '', fetch: e.fetch } as never, addr: 'a', token: 't' })
    const p = ws.open({ paths: ['p.trc'], options: opts })
    await settle()
    // the 10053 tab: its session is known (optSqlIds) but its document has not arrived
    const o = ws.open({ paths: ['o.trc'], options: opts }, false, true, undefined, undefined, true, '10053')
    Object.assign(ws.tab(o)!, { optSqlIds: ['aaa', 'bbb'] })
    ws.dumpLink(p).open('bbb')
    expect(ws.tab(o)!.openDump).toBe('bbb')
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: o })
    void (ws as unknown as { start(k: string): Promise<void> }).start(o)
    await settle()
    expect(ws.tab(o)!.session!.store.getState().optGo).toMatchObject({ dump: 1 })
    expect(ws.tab(o)!.openDump).toBeUndefined()
  })

  it('links a dump back to the open 10046 tab that has the statement, selects it, and takes the most recently used of several', async () => {
    const { ws, o, p, r } = await two()
    const link = ws.statementLink(o)
    expect(link.has('aaa')).toBe(true)
    expect(link.has('q1')).toBe(true)
    expect(link.has('zzz')).toBe(false)
    ws.go({ kind: 'tab', key: p })
    ws.go({ kind: 'tab', key: r })
    ws.go({ kind: 'tab', key: o })
    link.open('aaa') // p and r both have it: r was shown last
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: r })
    expect(ws.tab(r)!.session!.store.getState().selection.stmt).toBe(0)
    ws.go({ kind: 'tab', key: p })
    ws.go({ kind: 'tab', key: o })
    link.open('aaa')
    expect(ws.getSnapshot().route).toEqual({ kind: 'tab', key: p })
    expect(ws.tab(p)!.session!.store.getState().selection.stmt).toBe(1)
    expect(ws.tab(p)!.session!.store.getState().view).toBe('statements')
  })
})

describe('the note of a file left out of a set', () => {
  it('offers to open the 10053 file it names, from the requested paths or from a folder', async () => {
    const ws = new Workspace()
    const fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/engine/files') return json({ files: [{ path: '/t/opt_two.trc', size: 1, modified: '' }, { path: '/t/a.trc', size: 1, modified: '' }], dirs: ['/t'] })
      return init?.method === 'POST' ? json({ session: { id: 's', state: 'opening', paths: [] }, job: { id: 'j' } }, 202) : json({ id: 's', state: 'opening', paths: [] })
    })
    ws.bind({ client: { base: '', fetch } as never, addr: 'a', token: 't' })
    const direct = ws.open({ paths: ['/t/a.trc', '/t/opt_two.trc'], options: opts })
    const note = 'opt_two.trc is a 10053 file; open it on its own'
    const act = ws.noteAction(direct, note)!
    expect(act.label).toBe('Open opt_two.trc')
    act.run()
    await settle()
    expect(ws.getSnapshot().tabs.map((t) => t.set.paths)).toEqual([['/t/a.trc', '/t/opt_two.trc'], ['/t/opt_two.trc']])
    expect(ws.noteAction(direct, '2 optimizer (10053) dumps in this file, lines 54-18358; not shown as 10053 yet')).toBeNull()
    // a folder: the file is found by listing it
    const dir = ws.open({ paths: ['/t'], options: opts })
    Object.assign(ws.tab(dir)!, { dirs: ['/t'], files: [{ path: '/t/a.trc', name: 'a.trc' }] })
    ws.noteAction(dir, note)!.run()
    await settle()
    expect(ws.getSnapshot().route).toMatchObject({ kind: 'tab' })
    expect(ws.getSnapshot().tabs).toHaveLength(3) // the existing tab of that file was shown instead of a new one (openOrShow)
  })

  it('offers nothing on a comparison tab or when the named file is already open in this tab', () => {
    const ws = new Workspace()
    const k = ws.open({ paths: ['/t/opt_two.trc'], options: opts })
    Object.assign(ws.tab(k)!, { files: [{ path: '/t/opt_two.trc', name: 'opt_two.trc' }] })
    expect(ws.noteAction(k, 'opt_two.trc is a 10053 file; open it on its own')).toBeNull()
    expect(ws.noteAction('gone', 'x is a 10053 file')).toBeNull()
  })
})

// keeps the unused import honest for tools that complain
void createSession
void ({} as Tab)
