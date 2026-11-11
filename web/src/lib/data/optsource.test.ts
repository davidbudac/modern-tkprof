import { describe, expect, it, vi } from 'vitest'
import type { ApiClient } from './client'
import { attachOptClient, digestSource, httpSource, optSourceOf } from './optsource'
import { makeOptDoc, optDumpOf, optFileOf } from './testdoc'

const file = optFileOf(2) // dump 0: lines 10-29, dump 1: lines 30-49

function fakeClient(routes: Record<string, () => Response | Promise<Response>>) {
  const fetch = vi.fn(async (path: string) => {
    const r = routes[path]
    return r ? r() : new Response('no such route', { status: 404, statusText: 'Not Found' })
  })
  return { client: { base: '', fetch } as unknown as ApiClient, fetch }
}

const textOf = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `line ${from + i}`).join('\n') + '\n'

describe('the digest source', () => {
  const digest = {
    dumps: [optDumpOf(file, 0, [{ from: 10, to: 12 }, { from: 20, to: 22 }]), optDumpOf(file, 1, [{ from: 30, to: 31 }])],
    lines: [{ from: 10, text: ['a10', 'a11', 'a12'] }, { from: 20, text: ['a20', 'a21', 'a22'] }, { from: 30, text: ['b30', 'b31'] }],
  }
  const s = digestSource({ file, digest })

  it('gives the dumps normalised (what Go leaves null is empty)', async () => {
    const d = await s.dump(0)
    expect(d.landmarks).toEqual([])
    expect(d.roles).toEqual({})
    expect(d.digest).toHaveLength(2)
  })

  it('gives only the lines the digest keeps, a gap where a line is absent', async () => {
    const t = await s.text(0)
    expect(t.complete).toBe(false)
    expect([t.from, t.to]).toEqual([10, 29])
    expect([10, 11, 12, 20, 22].map((l) => t.get(l))).toEqual(['a10', 'a11', 'a12', 'a20', 'a22'])
    expect([13, 19, 23, 29].map((l) => t.get(l))).toEqual([undefined, undefined, undefined, undefined])
    expect((await s.text(1)).get(31)).toBe('b31')
  })

  it('does not give a line of a run that is not in the dump digest ranges', async () => {
    const d = { ...digest, dumps: [optDumpOf(file, 0, [{ from: 10, to: 10 }]), digest.dumps[1]] }
    const t = await digestSource({ file, digest: d }).text(0)
    expect([t.get(10), t.get(11), t.get(20)]).toEqual(['a10', undefined, undefined])
  })

  it('rejects a dump the report does not hold', async () => {
    await expect(s.dump(5)).rejects.toThrow(/no dump 5/)
    await expect(s.text(5)).rejects.toThrow(/no dump 5/)
  })

  it('has no lines when the digest has no runs', async () => {
    const t = await digestSource({ file, digest: { dumps: [optDumpOf(file, 0, [{ from: 10, to: 29 }])], lines: [] } }).text(0)
    expect(t.get(10)).toBeUndefined()
  })
})

describe('the HTTP source', () => {
  it('keeps nothing between calls (the view\'s cache of two dumps is the one place), and normalises the model', async () => {
    const { client, fetch } = fakeClient({
      '/api/opt/dump?i=1': () => Response.json(optDumpOf(file, 1)),
      '/api/opt/text?i=1': () => new Response(textOf(30, 49)),
    })
    const s = httpSource(file, client)
    const a = await s.dump(1)
    const b = await s.dump(1)
    expect(a).not.toBe(b)
    expect(a.landmarks).toEqual([])
    const t = await s.text(1)
    expect(await s.text(1)).not.toBe(t)
    expect(t.complete).toBe(true)
    expect([t.from, t.to, t.get(30), t.get(49), t.get(29), t.get(50)]).toEqual([30, 49, 'line 30', 'line 49', undefined, undefined])
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('reports an HTTP error and asks again after it', async () => {
    let ok = false
    const { client, fetch } = fakeClient({ '/api/opt/dump?i=0': () => (ok ? Response.json(optDumpOf(file, 0)) : new Response('not a 10053 session', { status: 404, statusText: 'Not Found' })) })
    const s = httpSource(file, client)
    await expect(s.dump(0)).rejects.toThrow(/404 Not Found: not a 10053 session/)
    ok = true
    expect((await s.dump(0)).idx).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('rejects a text that is short of the dump range', async () => {
    const { client } = fakeClient({ '/api/opt/text?i=0': () => new Response(textOf(10, 25)) }) // 16 of 20 lines
    await expect(httpSource(file, client).text(0)).rejects.toThrow(/short: 16 of 20 lines/)
  })

  it('takes CRLF and a missing trailing newline', async () => {
    const { client } = fakeClient({ '/api/opt/text?i=0': () => new Response(textOf(10, 29).trimEnd().replace(/\n/g, '\r\n')) })
    const t = await httpSource(file, client).text(0)
    expect(t.get(29)).toBe('line 29')
  })

  it('rejects a dump the file does not list', async () => {
    const { client, fetch } = fakeClient({})
    await expect(httpSource(file, client).text(7)).rejects.toThrow(/no dump 7/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('sends the request through the client (the engine session path and its token are the client\'s)', async () => {
    const calls: string[] = []
    const client: ApiClient = { base: 'http://127.0.0.1:1/s/3', token: 't', fetch: async (path) => { calls.push(path); return Response.json(optDumpOf(file, 0)) } }
    await httpSource(file, client).dump(0)
    expect(calls).toEqual(['/api/opt/dump?i=0'])
  })
})

describe('optSourceOf', () => {
  it('reads a document that carries a digest from itself, without a request', async () => {
    const { client, fetch } = fakeClient({})
    const doc = await makeOptDoc({ file, digest: { dumps: [optDumpOf(file, 0), optDumpOf(file, 1)], lines: [] } })
    const s = optSourceOf(doc as never, client)
    expect((await s.dump(1)).idx).toBe(1)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('asks the routes of the client when the document has no digest', async () => {
    const { client, fetch } = fakeClient({ '/api/opt/dump?i=0': () => Response.json(optDumpOf(file, 0)) })
    const doc = await makeOptDoc({ file })
    const s = optSourceOf(doc as never, client)
    await s.dump(0)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('treats an empty digest object as a digest and null as none', async () => {
    const { client } = fakeClient({ '/api/opt/dump?i=0': () => Response.json(optDumpOf(file, 0)) })
    expect(await (optSourceOf((await makeOptDoc({ file, digest: null })) as never, client)).dump(0)).toMatchObject({ idx: 0 })
    await expect(optSourceOf((await makeOptDoc({ file, digest: { dumps: [], lines: [] } })) as never, client).dump(0)).rejects.toThrow(/no dump/)
  })

  it('returns the same source for the same document, so the view keeps its state', async () => {
    const { client } = fakeClient({})
    const doc = await makeOptDoc({ file })
    expect(optSourceOf(doc as never, client)).toBe(optSourceOf(doc as never, client))
    expect(optSourceOf((await makeOptDoc({ file })) as never, client)).not.toBe(optSourceOf(doc as never, client))
  })

  it('asks the server the document came from when it was recorded (a ?doc= URL on another server)', async () => {
    const mine = fakeClient({})
    const theirs = fakeClient({ '/api/opt/dump?i=0': () => Response.json(optDumpOf(file, 0)) })
    const doc = await makeOptDoc({ file })
    attachOptClient(doc.opt!, theirs.client)
    await optSourceOf(doc as never, mine.client).dump(0)
    expect(theirs.fetch).toHaveBeenCalledTimes(1)
    expect(mine.fetch).not.toHaveBeenCalled()
  })
})
