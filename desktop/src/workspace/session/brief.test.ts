import { describe, expect, it } from 'vitest'
import { makeAnnotation, type Annotation } from '@lib/data/annotations'
import type { ApiClient } from '@lib/data/client'
import { makeDoc } from '@lib/data/testdoc'
import { createStore, type Store } from '@lib/state/store'
import { briefRequest, fetchBrief, fmtTokens, type BriefChoices } from './brief'

const choices: BriefChoices = { caseText: '', notes: true, plans: true, binds: 'mask', salt: 'abc' }
const calls = [{ ctx: 0, stmt: 0, kind: 2, e: 1 }, { ctx: 2, stmt: 1, kind: 2, e: 1 }]

async function setup(): Promise<Store> {
  const store = createStore()
  store.setLoaded({ doc: await makeDoc(calls), compare: null })
  return store
}

describe('briefRequest', () => {
  it('is the whole trace with binds masked and the engine defaults when nothing is chosen or selected', async () => {
    const s = await setup()
    expect(briefRequest(s.getState(), choices)).toEqual({
      case: '',
      notes: [],
      options: { maxStatements: 0, maxSqlChars: 0, maxPlanLines: 0, binds: 'mask', salt: 'abc' },
      scope: { from: 0, to: 0, contexts: [] },
    })
  })

  it('carries the case text and the choices', async () => {
    const s = await setup()
    const req = briefRequest(s.getState(), { caseText: 'slow after the upgrade', notes: false, plans: false, binds: 'keep', salt: 'x' })
    expect(req.case).toBe('slow after the upgrade')
    expect(req.options).toMatchObject({ binds: 'keep', maxPlanLines: -1, salt: 'x' })
  })

  it('carries the scope of the views: the time window and the contexts', async () => {
    const s = await setup()
    s.actions.setWindow({ startTim: 1000.4, endTim: 2000.2 })
    s.actions.setContexts(new Set([2, 0]))
    expect(briefRequest(s.getState(), choices).scope).toEqual({ from: 1000, to: 2001, contexts: [0, 2] })
  })

  it('follows the Files selection into the contexts', async () => {
    const s = await setup()
    s.actions.setFiles(new Set([0]))
    expect(briefRequest(s.getState(), choices).scope?.contexts).toEqual([0, 1])
    s.actions.setFiles(null)
    expect(briefRequest(s.getState(), choices).scope?.contexts).toEqual([])
  })

  it('carries the notes, and the bookmarks that have one as line notes', async () => {
    const s = await setup()
    const stmt = makeAnnotation({ kind: 'statement', note: 'the slow one', stmt: { sqlId: 'abc', hash: '1a2b3c4d' } }, 5)
    const window = makeAnnotation({ kind: 'window', note: 'batch ran here', from: 10, to: 20, label: 'batch' }, 6)
    s.actions.setAnnotations([stmt, window])
    s.actions.setBookmarks([{ file: 0, line: 7, label: 'plain' }, { file: 0, line: 9, label: 'odd', note: 'why here', updated: 3 }])
    const { notes } = briefRequest(s.getState(), choices)
    expect(notes).toEqual([
      { id: stmt.id, kind: 'statement', note: 'the slow one', created: 5, updated: 5, stmt: stmt.stmt },
      { id: window.id, kind: 'window', note: 'batch ran here', created: 6, updated: 6, from: 10, to: 20, label: 'batch' },
      { id: 'line:0:9', kind: 'line', note: 'why here', created: 3, updated: 3, label: 'odd', file: 0, line: 9 },
    ])
    expect(briefRequest(s.getState(), { ...choices, notes: false }).notes).toEqual([])
  })

  it('sends only the fields of the schema, which the engine insists on', async () => {
    const s = await setup()
    const stored = { ...makeAnnotation({ kind: 'window', note: 'n', from: 1, to: 2 }), extra: 1, stmt: undefined } as Annotation
    s.actions.setAnnotations([stored])
    const body = JSON.parse(JSON.stringify(briefRequest(s.getState(), choices))) as { notes: object[] }
    expect(Object.keys(body.notes[0]).sort()).toEqual(['created', 'from', 'id', 'kind', 'note', 'to', 'updated'])
  })
})

const clientAnswering = (r: Response, seen: { path?: string; init?: RequestInit } = {}): ApiClient => ({
  base: '/s/1',
  fetch: async (path, init) => { seen.path = path; seen.init = init; return r },
})

describe('fetchBrief', () => {
  it('posts the request as JSON and answers the Markdown and the token estimate', async () => {
    const seen: { path?: string; init?: RequestInit } = {}
    const req = briefRequest((await setup()).getState(), choices)
    const client = clientAnswering(new Response('# Trace brief\n', { headers: { 'content-type': 'text/markdown', 'X-Mtkprof-Est-Tokens': '1234' } }), seen)
    expect(await fetchBrief(client, req)).toEqual({ markdown: '# Trace brief\n', tokens: 1234 })
    expect(seen.path).toBe('/api/brief')
    expect(seen.init?.method).toBe('POST')
    expect(new Headers(seen.init?.headers).get('content-type')).toBe('application/json')
    expect(JSON.parse(seen.init?.body as string)).toEqual(req)
  })

  it('turns the engine error envelope into an Error', async () => {
    const req = briefRequest((await setup()).getState(), choices)
    const client = clientAnswering(Response.json({ error: { code: 'bad_request', message: 'scope.to: 5 is before from: 9' } }, { status: 400 }))
    await expect(fetchBrief(client, req)).rejects.toThrow('brief: bad_request: scope.to: 5 is before from: 9')
  })
})

describe('fmtTokens', () => {
  it('keeps it short', () => {
    expect([812, 7432, 99_960, 120_400].map(fmtTokens)).toEqual(['812', '7.4k', '100k', '120k'])
  })
})
