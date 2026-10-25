import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from './client'
import { fetchLinesAnnot, lineAt, matchSpan, objectsAt, parseJump, probeLinesApi, readNdjson, search, type SearchHit } from './lines'

afterEach(() => vi.unstubAllGlobals())

const json = (v: unknown, init?: ResponseInit) => new Response(JSON.stringify(v), { headers: { 'content-type': 'application/json' }, ...init })

function stub(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const f = vi.fn(async (url: string, init?: RequestInit) => handler(url, init))
  vi.stubGlobal('fetch', f)
  return f
}

/** A streamed body delivered in the given chunks (strings are encoded as UTF-8; a chunk may end anywhere). */
function streamed(chunks: (string | Uint8Array)[], init?: ResponseInit): Response {
  const enc = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(c) { for (const ch of chunks) c.enqueue(typeof ch === 'string' ? enc.encode(ch) : ch); c.close() },
  })
  return new Response(body, init)
}

const client = createClient('http://h/s/1')

describe('annotated lines, lines/at, at', () => {
  it('asks for a page with annot=1 on the given file', async () => {
    const f = stub(() => json({ from: 4001, total: 9000, lines: [{ t: 'WAIT #1: nam=...', k: 'wait' }] }))
    const p = await fetchLinesAnnot(client, 2, 4001, 2000)
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/lines?annot=1&file=2&from=4001&n=2000')
    expect(p).toEqual({ from: 4001, total: 9000, lines: [{ t: 'WAIT #1: nam=...', k: 'wait' }] })
  })
  it('turns an error status into an Error carrying the body', async () => {
    stub(() => new Response('no such file', { status: 404, statusText: 'Not Found' }))
    await expect(fetchLinesAnnot(client, 5, 1, 10)).rejects.toThrow('404 Not Found: no such file')
  })
  it('lineAt returns the line of a tim', async () => {
    const f = stub(() => json({ line: 321 }))
    expect(await lineAt(client, 0, 1234.4)).toBe(321)
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/lines/at?file=0&tim=1234')
  })
  it('objectsAt keeps -1 for what the server leaves out', async () => {
    stub(() => json({ call: 3, stmt: 7, kind: 'wait' }))
    expect(await objectsAt(client, 0, 99)).toEqual({ call: 3, stmt: 7, cursor: -1, execNo: -1, wait: -1, bindSet: -1, ctx: -1, planLine: -1, kind: 'wait' })
  })
  it('probeLinesApi wants JSON (an SPA fallback answers text/html)', async () => {
    stub(() => json({ call: -1 }))
    expect(await probeLinesApi(client)).toBe(true)
    stub(() => new Response('<html>', { headers: { 'content-type': 'text/html' } }))
    expect(await probeLinesApi(client)).toBe(false)
    stub(() => new Response('', { status: 404 }))
    expect(await probeLinesApi(client)).toBe(false)
  })
})

describe('search (NDJSON)', () => {
  const q = { file: 0, q: 'db file', regex: false, caseSensitive: true, from: 1, limit: 1000 }

  it('delivers hits as they complete and resolves with the closing record', async () => {
    const f = stub(() => streamed([
      '{"line":3,"col":0,"text":"a"}\n{"line":9,"col"',   // a record split across chunks
      ':4,"text":"b"}\n',
      '{"done":true,"scanned":50,"truncated":false}\n',
    ]))
    const got: SearchHit[] = []
    const end = await search(client, q, (h) => got.push(h))
    expect(got).toEqual([{ line: 3, col: 0, text: 'a' }, { line: 9, col: 4, text: 'b' }])
    expect(end).toEqual({ scanned: 50, truncated: false, done: true })
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/search?file=0&q=db+file&regex=0&case=1&from=1&limit=1000')
  })

  it('hands over a hit before the stream has ended', async () => {
    const enc = new TextEncoder()
    let finish!: () => void
    const body = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(enc.encode('{"line":1,"col":0,"text":"x"}\n')); finish = () => { c.enqueue(enc.encode('{"done":true,"scanned":1,"truncated":false}\n')); c.close() } },
    })
    stub(() => new Response(body))
    const got: SearchHit[] = []
    const p = search(client, q, (h) => got.push(h))
    await vi.waitFor(() => expect(got.length).toBe(1))
    finish()
    expect((await p).done).toBe(true)
  })

  it('reassembles a multi-byte character cut between chunks', async () => {
    const bytes = new TextEncoder().encode('{"line":1,"col":0,"text":"é€"}\n')
    const cut = bytes.indexOf(0xc3) + 1
    stub(() => streamed([bytes.slice(0, cut), bytes.slice(cut)]))
    const got: SearchHit[] = []
    await search(client, q, (h) => got.push(h))
    expect(got[0].text).toBe('é€')
  })

  it('reports done=false when the stream ends without the closing record', async () => {
    stub(() => streamed(['{"line":1,"col":0,"text":"x"}\n']))
    const end = await search(client, q, () => {})
    expect(end.done).toBe(false)
  })

  it('rejects with the server message for a bad regex', async () => {
    stub(() => new Response('q: bad regexp', { status: 400, statusText: 'Bad Request' }))
    await expect(search(client, { ...q, regex: true, q: '(' }, () => {})).rejects.toThrow('400 Bad Request: q: bad regexp')
  })

  it('aborting stops the read with an AbortError', async () => {
    const ac = new AbortController()
    const enc = new TextEncoder()
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode('{"line":1,"col":0,"text":"x"}\n')) } }) // never closes
    stub((_u, init) => { init?.signal?.addEventListener('abort', () => {}); return new Response(body) })
    const got: SearchHit[] = []
    const p = search(client, q, (h) => { got.push(h); ac.abort() }, ac.signal)
    await expect(p).rejects.toMatchObject({ name: 'AbortError' })
    expect(got.length).toBe(1)
  })
})

describe('readNdjson', () => {
  it('skips blank lines and handles a final record without a newline', async () => {
    const recs: unknown[] = []
    await readNdjson(streamed(['{"a":1}\n\n{"a":2}']), (r) => recs.push(r))
    expect(recs).toEqual([{ a: 1 }, { a: 2 }])
  })
})

describe('parseJump', () => {
  const first = 10_804_499_034
  it('reads suffixed values as offsets from the start of the trace', () => {
    expect(parseJump('1.5s', first)).toBe(first + 1_500_000)
    expect(parseJump('250 ms', first)).toBe(first + 250_000)
    expect(parseJump('900us', first)).toBe(first + 900)
  })
  it('reads a bare number at or above the first tim as absolute, below as seconds', () => {
    expect(parseJump('10806000000', first)).toBe(10_806_000_000)
    expect(parseJump('2', first)).toBe(first + 2_000_000)
  })
  it('rejects anything else', () => {
    expect(parseJump('', first)).toBeNull()
    expect(parseJump('soon', first)).toBeNull()
    expect(parseJump('1m', first)).toBeNull()
  })
})

describe('matchSpan', () => {
  it('highlights a literal at the server column', () => {
    expect(matchSpan({ line: 1, col: 5, text: 'WAIT db file read' }, 'db file', false, true)).toEqual([5, 12])
  })
  it('converts a byte column to a character index', () => {
    // "é" is two bytes, so the match at byte 3 is character 2
    expect(matchSpan({ line: 1, col: 3, text: 'aéb' }, 'b', false, true)).toEqual([2, 3])
  })
  it('measures a regex match with JS semantics from the column', () => {
    expect(matchSpan({ line: 1, col: 3, text: 'ab ela= 1234 x' }, 'ela= \\d+', true, true)).toEqual([3, 12])
  })
  it('folds case for a case-insensitive regex', () => {
    expect(matchSpan({ line: 1, col: 0, text: 'WAIT #1' }, 'wait', true, false)).toEqual([0, 4])
  })
})
