import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from './client'
import { NoReading, type DiagFile, type DiagNode } from './diag'
import { attachDiagClient, diagSourceOf, digestDiagSource, httpDiagSource } from './diagsource'
import { makeDiagDoc } from './testdoc'

const node = (id: string, from: number, to: number, kids = false): DiagNode => ({ id, kind: 'title', title: id, from, to, lines: to - from + 1, hasChildren: kids })
const file: DiagFile = { name: 'f.trc', lines: 300, release: '', version: '19.27.0.0.0', tested: true, records10046: 0, sections: [], unplaced: 0, outline: [node('a:1-100:1:f', 1, 100, true), node('b', 101, 300)], outlineTotal: 2 }

function fakeClient(routes: Record<string, () => Response | Promise<Response>>) {
  const fetch = vi.fn(async (path: string) => {
    const r = routes[path]
    return r ? r() : new Response('{"error":{"code":"not_found","message":"no such route"}}', { status: 404, statusText: 'Not Found' })
  })
  return { client: { base: '', fetch } as unknown as ApiClient, fetch }
}
const json = (o: unknown) => () => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } })

describe('the HTTP source', () => {
  it('asks api/diag/outline with the node id encoded and `after` only when it is set', async () => {
    const { client, fetch } = fakeClient({
      '/api/diag/outline?node=a%3A1-100%3A1%3Af': json({ node: 'a:1-100:1:f', children: [node('a1', 1, 50)], more: 3, next: 1 }),
      '/api/diag/outline?node=root&after=2000': json({ node: 'root', children: [], more: 0 }),
    })
    const s = httpDiagSource(file, client)
    expect(await s.outline('a:1-100:1:f')).toEqual({ node: 'a:1-100:1:f', children: [node('a1', 1, 50)], more: 3, next: 1 })
    expect((await s.outline('root', 2000)).more).toBe(0)
    expect(fetch.mock.calls.map((c) => c[0])).toEqual(['/api/diag/outline?node=a%3A1-100%3A1%3Af', '/api/diag/outline?node=root&after=2000'])
    expect(s.digest).toBe(false)
  })

  it('says why an outline could not be had, with the engine\'s message', async () => {
    const { client } = fakeClient({ '/api/diag/outline?node=x': () => new Response('{"error":{"code":"bad_request","message":"no such node: x"}}', { status: 400, statusText: 'Bad Request' }) })
    await expect(httpDiagSource(file, client).outline('x')).rejects.toThrow('outline of x: 400 Bad Request: no such node: x')
  })

  it('reads a reading, and says NoReading for a 404', async () => {
    const { client } = fakeClient({ '/api/diag/reading?node=h1': json({ kind: 'heap', chunks: 12 }) })
    const s = httpDiagSource(file, client)
    expect(await s.reading('h1')).toEqual({ kind: 'heap', chunks: 12 })
    await expect(s.reading('nothing')).rejects.toBeInstanceOf(NoReading)
  })

  it('serves the text from api/lines of input file 0 and search from api/search', async () => {
    const { client, fetch } = fakeClient({
      '/api/lines?annot=1&file=0&from=2001&n=2000': json({ from: 2001, total: 5000, lines: [{ t: 'a', k: 'diagnostic' }] }),
      '/api/search?file=0&q=ORA-&regex=0&case=0&from=1&limit=100': () => new Response('{"line":5,"col":0,"text":"ORA-1"}\n{"done":true,"scanned":9,"truncated":false}\n'),
    })
    const t = httpDiagSource(file, client).text!
    const sig = new AbortController().signal
    const p = await t.page(2001, 2000, sig)
    expect(p).toEqual({ from: 2001, total: 5000, lines: [{ t: 'a', k: 'diagnostic' }] })
    const hits: number[] = []
    const end = await t.search({ q: 'ORA-', regex: false, caseSensitive: false, from: 1, limit: 100 }, (h) => hits.push(h.line), sig)
    expect(hits).toEqual([5])
    expect(end).toEqual({ scanned: 9, truncated: false, done: true })
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

describe('the digest source', () => {
  const digest = { outline: [{ ...file.outline[0], children: [node('a1', 1, 50)], more: 7 }, { ...file.outline[1], children: [] }] }
  const s = digestDiagSource({ file, digest })

  it('has no text and says it is a digest', () => {
    expect(s.text).toBeNull()
    expect(s.digest).toBe(true)
  })

  it('holds the children of the top level nodes and how many it does not list', async () => {
    expect(s.preloaded?.get('a:1-100:1:f')).toMatchObject({ children: [node('a1', 1, 50)], more: 0, unlisted: 7 })
    expect((await s.outline('a:1-100:1:f')).children).toHaveLength(1)
    await expect(s.outline('a1')).rejects.toThrow(/not in it/)
    expect((await s.outline('root', 1)).children.map((n) => n.id)).toEqual(['b'])
  })

  it('has no readings', async () => {
    await expect(s.reading('a1')).rejects.toBeInstanceOf(NoReading)
  })
})

describe('the pick', () => {
  it('reads a document that carries a digest from itself and any other from the routes, once per document', async () => {
    const { client } = fakeClient({})
    const withDigest = await makeDiagDoc({ file, digest: { outline: [] } })
    const without = await makeDiagDoc({ file })
    const a = diagSourceOf(withDigest as never, client)
    expect(a.digest).toBe(true)
    expect(diagSourceOf(withDigest as never, client)).toBe(a)
    const b = diagSourceOf(without as never, client)
    expect(b.digest).toBe(false)
    expect(b.text).not.toBeNull()
    expect(diagSourceOf(without as never, client)).toBe(b)
  })

  it('asks the server a document came from when that is not the session\'s', async () => {
    const other = fakeClient({ '/api/diag/outline?node=root': json({ node: 'root', children: [node('z', 1, 5)], more: 0 }) })
    const mine = fakeClient({})
    const doc = await makeDiagDoc({ file })
    attachDiagClient(doc.dump!, other.client)
    const s = diagSourceOf(doc as never, mine.client)
    expect((await s.outline('root')).children[0].id).toBe('z')
    expect(mine.fetch).not.toHaveBeenCalled()
  })
})
