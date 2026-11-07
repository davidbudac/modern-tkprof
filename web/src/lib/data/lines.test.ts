import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient } from './client'
import { indexFolds, foldHiding, lineOfRow, rowOfLine, visibleCount } from './folds'
import { fetchLinesAnnot, highlightRuns, lineAt, linePermalink, matchSpan, matchSpans, nextLine, bindFolds, frameFolds, linesBlocks, mergeFolds, objectsAt, parseGoTo, parseJump, cursorLine, statementsOf, stmtLineIn, probeLinesApi, readNdjson, search, callsOverRe, waitsOverRe, SEARCH_PRESETS, groupHits, GROUP_UNKNOWN, firstAbove, hotStep, sqlBandAt, fetchStmtUnion, fetchStmtRuns, fetchStmtBins, type SearchHit } from './lines'

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
    expect(await objectsAt(client, 0, 99)).toEqual({ call: 3, stmt: 7, cursor: -1, execNo: -1, wait: -1, bindSet: -1, ctx: -1, planLine: -1, kind: 'wait', execFrom: -1, execTo: -1, prevExec: -1, nextExec: -1, cursorLine: -1, closeLine: -1, object: '', bindLine: -1, binds: undefined })
  })
  it('objectsAt carries the execution span, its neighbours and the wait object', async () => {
    stub(() => json({ call: 3, stmt: 7, execFrom: 10, execTo: 20, prevExec: 4, nextExec: 30, cursorLine: 2, closeLine: 40, object: 'SCOTT.EMP', kind: 'call' }))
    expect(await objectsAt(client, 0, 12)).toMatchObject({ execFrom: 10, execTo: 20, prevExec: 4, nextExec: 30, cursorLine: 2, closeLine: 40, object: 'SCOTT.EMP' })
  })
  it('objectsAt maps the binds of the line\'s bind set', async () => {
    stub(() => json({ bindSet: 2, bindLine: 53, binds: [{ pos: 0, type: 'NUMBER', value: '42', isNull: false, noDef: false, dump: false, mal: 22, kind: 'number' }, { pos: 1, type: 'DATE', value: 'x', isNull: true, noDef: false, dump: false, mal: 0, kind: 'date', typed: '2024-01-01' }], kind: 'bind-line' }))
    const o = await objectsAt(client, 0, 59)
    expect(o).toMatchObject({ bindSet: 2, bindLine: 53 })
    expect(o.binds).toEqual([
      { pos: 0, type: 'NUMBER', value: '42', isNull: false, noDef: false, dump: false, mal: 22, kind: 'number', typed: undefined },
      { pos: 1, type: 'DATE', value: 'x', isNull: true, noDef: false, dump: false, mal: 0, kind: 'date', typed: '2024-01-01' },
    ])
  })
  it('nextLine asks lines/next, answers null on a 404 and throws on other errors', async () => {
    const f = stub(() => json({ line: 77 }))
    expect(await nextLine(client, 1, 50, 'wait', -1)).toBe(77)
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/lines/next?file=1&from=50&what=wait&dir=-1')
    stub(() => new Response('nothing further', { status: 404 }))
    expect(await nextLine(client, 0, 9, 'plan', 1)).toBeNull()
    stub(() => new Response('bad what', { status: 400 }))
    await expect(nextLine(client, 0, 9, 'call', 1)).rejects.toThrow('400')
  })
  it('nextLine appends min (µs) for the gap kind', async () => {
    const f = stub(() => json({ line: 12 }))
    expect(await nextLine(client, 0, 5, 'gap', 1, undefined, 100_000)).toBe(12)
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/lines/next?file=0&from=5&what=gap&dir=1&min=100000')
    await nextLine(client, 0, 5, 'call', 1)
    expect(f.mock.calls[1][0]).not.toContain('min=')
  })
  it('linesBlocks lists the blocks of a kind and tells when the list was cut', async () => {
    const f = stub(() => json({ blocks: [[3, 9], [20, 20], [0, 4], [8, 2]], bindLines: [[4, 7, 12], [], [1], []], truncated: true }))
    // a bind line outside its block is dropped; the bad blocks go with their lines
    expect(await linesBlocks(client, 1, 'binds')).toEqual({ blocks: [[3, 9], [20, 20]], bindLines: [[4, 7], []], texts: [], truncated: true })
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/lines/blocks?file=1&what=binds')
    stub(() => json({}))
    expect(await linesBlocks(client, 0, 'stat')).toEqual({ blocks: [], bindLines: [], texts: [], truncated: false })
    stub(() => new Response('bad', { status: 400 }))
    await expect(linesBlocks(client, 0, 'stat')).rejects.toThrow('400')
  })
  it('linesBlocks hands over the SQL texts of a frame answer, ascending and apart (a bad one is dropped)', async () => {
    stub(() => json({ blocks: [[83, 83], [86, 86]], texts: [[85, 85, 3], [90, 94, 4], [92, 93, 5], [95, 94, 6], [100, 101], [120, 130, 7]], truncated: false }))
    expect((await linesBlocks(client, 0, 'frame')).texts).toEqual([[85, 85, 3], [90, 94, 4], [120, 130, 7]])
    stub(() => json({ blocks: [[83, 83], [86, 86]], truncated: false })) // an engine that does not send them
    expect((await linesBlocks(client, 0, 'frame')).texts).toEqual([])
  })
  it('bindFolds folds the attribute lines under each Bind# line, up to the next one or the block end', () => {
    expect(bindFolds([[3, 12], [20, 21]], [[4, 8, 12], [21]]).map((f) => [f.from, f.to, !!f.quiet, !!f.auto])).toEqual([[4, 7, true, true], [8, 11, true, true]])
    // a blank line under the header folds into it
    expect(bindFolds([[3, 9]], [[5, 7]]).map((f) => [f.from, f.to])).toEqual([[3, 4], [5, 6], [7, 9]])
  })
  it('a BINDS block of at most 4 binds is one quiet fold under its header (inline: the binds are chips on it); a bigger one keeps its table', () => {
    const blocks: [number, number][] = [[3, 12], [20, 40], [50, 51]]
    const lines = [[4, 8, 12], [22, 24, 26, 28, 30], []]
    const got = bindFolds(blocks, lines, 4)
    expect(got.slice(0, 1).map((f) => [f.from, f.to, !!f.quiet, !!f.auto, !!f.inline])).toEqual([[3, 12, true, true, true]])
    expect(got.slice(1).every((f) => !f.inline && f.quiet)).toBe(true) // 5 binds: attribute folds as before
    expect(got.slice(1).map((f) => [f.from, f.to])).toEqual([[20, 21], [22, 23], [24, 25], [26, 27], [28, 29], [30, 40]])
    expect(bindFolds(blocks, lines).some((f) => f.inline)).toBe(false) // the default: no inline blocks
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

describe('parseGoTo', () => {
  const first = 10_804_499_034
  const clock = { wallOffsetUs: Date.UTC(2026, 0, 2, 10, 0, 0) * 1000 - first, tzOffsetMin: 120, span: { firstTim: first, lastTim: first + 3600e6 } }
  it('reads a bare integer, L12345 and :12345 as a line', () => {
    expect(parseGoTo('12345', first)).toEqual({ kind: 'line', line: 12345 })
    expect(parseGoTo(' L12345 ', first)).toEqual({ kind: 'line', line: 12345 })
    expect(parseGoTo('l7', first)).toEqual({ kind: 'line', line: 7 })
    expect(parseGoTo(':12345', first)).toEqual({ kind: 'line', line: 12345 })
    expect(parseGoTo('10806000000', first)).toEqual({ kind: 'line', line: 10806000000 })
  })
  it('reads #number as a cursor', () => {
    expect(parseGoTo('#140124363561040', first)).toEqual({ kind: 'cursor', number: 140124363561040 })
    expect(parseGoTo('#', first)).toBeNull()
  })
  it('reads 13 characters as a sql_id, with an optional /N execution', () => {
    expect(parseGoTo('9h8pw1x9xgbsj', first)).toEqual({ kind: 'sqlid', sqlId: '9h8pw1x9xgbsj', prefix: false })
    expect(parseGoTo('9h8pw1x9xgbsj/3', first)).toEqual({ kind: 'sqlid', sqlId: '9h8pw1x9xgbsj', prefix: false, execNo: 3 })
    expect(parseGoTo('9H8PW1X9XGBSJ', first)).toEqual({ kind: 'sqlid', sqlId: '9h8pw1x9xgbsj', prefix: false })
  })
  it('reads a prefix followed by * as a sql_id prefix', () => {
    expect(parseGoTo('9h8*', first)).toEqual({ kind: 'sqlid', sqlId: '9h8', prefix: true })
    expect(parseGoTo('9h8*/2', first)).toEqual({ kind: 'sqlid', sqlId: '9h8', prefix: true, execNo: 2 })
    expect(parseGoTo('9h8', first)).toBeNull() // a short sql_id needs its star
    expect(parseGoTo('*', first)).toBeNull()
  })
  it('keeps the times with a unit and the clock times, and no longer reads a bare number as a time', () => {
    expect(parseGoTo('1.5s', first)).toEqual({ kind: 'tim', tim: first + 1_500_000 })
    expect(parseGoTo('250 ms', first)).toEqual({ kind: 'tim', tim: first + 250_000 })
    expect(parseGoTo('900us', first)).toEqual({ kind: 'tim', tim: first + 900 })
    expect(parseGoTo('12:00:01.5', first, clock)).toEqual({ kind: 'tim', tim: first + 1.5e6 })
    expect(parseGoTo('12:00:01', first)).toBeNull()
    expect(parseGoTo('1.5', first)).toBeNull()
    expect(parseGoTo('-3', first)).toBeNull()
  })
  it('rejects anything else', () => {
    expect(parseGoTo('', first)).toBeNull()
    expect(parseGoTo('soon', first)).toBeNull()
    expect(parseGoTo('1m', first)).toBeNull()
  })
})

describe('resolving a Go to against the document', () => {
  const cursors = [
    { id: 0, number: 100, line: 10, context: 0, statement: 0 }, { id: 1, number: 100, line: 50, context: 0, statement: 0 },
    { id: 2, number: 100, line: 5, context: 1, statement: 1 }, { id: 3, number: 7, line: 30, context: 0, statement: 1 },
  ]
  const doc = {
    cursors, fileOfCursor: (c: number) => cursors[c].context,
    statements: [{ id: 0, sqlId: '9h8pw1x9xgbsj', cursors: [0, 1] }, { id: 1, sqlId: '9h8zzzzzzzzzz', cursors: [2, 3] }, { id: 2, sqlId: '', cursors: [] }],
  } as never
  it('finds the nearest PARSING IN CURSOR line after the selected one, wrapping, only in the file', () => {
    expect(cursorLine(doc, 0, 100, 1)).toBe(10)
    expect(cursorLine(doc, 0, 100, 10)).toBe(50)
    expect(cursorLine(doc, 0, 100, 50)).toBe(10)
    expect(cursorLine(doc, 1, 100, 1)).toBe(5)
    expect(cursorLine(doc, 1, 7, 1)).toBeUndefined()
  })
  it('finds the statements of a sql_id or a prefix', () => {
    expect(statementsOf(doc, '9h8pw1x9xgbsj', false)).toEqual({ ids: ['9h8pw1x9xgbsj'], stmts: [0] })
    expect(statementsOf(doc, '9h8', true).ids).toEqual(['9h8pw1x9xgbsj', '9h8zzzzzzzzzz'])
    expect(statementsOf(doc, 'zz', true).stmts).toEqual([])
  })
  it('finds the first line of a statement in a file', () => {
    expect(stmtLineIn(doc, 0, 0)).toBe(10)
    expect(stmtLineIn(doc, 1, 0)).toBeUndefined()
    expect(stmtLineIn(doc, 1, 1)).toBe(5)
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

describe('jump to a clock time', () => {
  const first = 5_000_000
  const clock = { wallOffsetUs: Date.UTC(2026, 0, 2, 10, 0, 0) * 1000 - first, tzOffsetMin: 120, span: { firstTim: first, lastTim: first + 3600e6 } }
  it('takes a time of day in the file zone, and still the offsets', () => {
    expect(parseJump('12:00:01.5', first, clock)).toBe(first + 1.5e6)
    expect(parseJump('2026-01-02 12:10:00', first, clock)).toBe(first + 600e6)
    expect(parseJump('250ms', first, clock)).toBe(first + 250e3)
    expect(parseJump('7', first, clock)).toBe(first + 7e6)
  })
  it('rejects a clock time without a wall clock or with a bad one', () => {
    expect(parseJump('12:00:01', first)).toBeNull()
    expect(parseJump('25:00:01', first, clock)).toBeNull()
  })
})

describe('search-match highlighting', () => {
  it('finds every literal match, case-insensitively unless asked', () => {
    expect(matchSpans('EXEC #1: Exec exec', 'exec', false, false)).toEqual([[0, 4], [9, 13], [14, 18]])
    expect(matchSpans('EXEC #1: Exec exec', 'exec', false, true)).toEqual([[14, 18]])
    expect(matchSpans('aaaa', 'aa', false, true)).toEqual([[0, 2], [2, 4]])
    expect(matchSpans('abc', '', false, false)).toEqual([])
  })
  it('finds regex matches, skips empty ones and survives a regex JS rejects', () => {
    expect(matchSpans('tim=123 tim=45', 'tim=\\d+', true, true)).toEqual([[0, 7], [8, 14]])
    expect(matchSpans('abc', 'x*', true, true)).toEqual([])
    expect(matchSpans('abc', '(?P<n>a)', true, true)).toEqual([])
  })
  it('splits a text into runs that concatenate to it', () => {
    const t = 'WAIT #1: nam=x ela=5'
    const runs = highlightRuns(t, [[0, 4], [9, 12]])
    expect(runs).toEqual([{ text: 'WAIT', hit: true }, { text: ' #1: ', hit: false }, { text: 'nam', hit: true }, { text: '=x ela=5', hit: false }])
    expect(runs.map((r) => r.text).join('')).toBe(t)
  })
  it('handles no spans, overlaps and spans past the end', () => {
    expect(highlightRuns('abc', [])).toEqual([{ text: 'abc', hit: false }])
    expect(highlightRuns('abc', [[0, 2], [1, 3]])).toEqual([{ text: 'ab', hit: true }, { text: 'c', hit: false }])
    expect(highlightRuns('abc', [[2, 9]])).toEqual([{ text: 'ab', hit: false }, { text: 'c', hit: true }])
    expect(highlightRuns('', [])).toEqual([{ text: '', hit: false }])
  })
})

describe('line permalink', () => {
  const loc = { origin: 'http://100.64.0.1:8046', pathname: '/', search: '?doc=a.json' }
  it('is the page with the Lines view hash the app writes', () => {
    expect(linePermalink(loc, 0, 4711)).toBe('http://100.64.0.1:8046/?doc=a.json#view=lines&line=4711')
    expect(linePermalink(loc, 2, 9)).toBe('http://100.64.0.1:8046/?doc=a.json#view=lines&file=2&line=9')
    expect(linePermalink({ ...loc, search: '' }, 0, 1)).toBe('http://100.64.0.1:8046/#view=lines')
  })
})

describe('search presets', () => {
  it('builds the threshold regexes from the digits of the threshold in µs', () => {
    expect(waitsOverRe(10)).toBe('ela= \\d{5,}')
    expect(waitsOverRe(1)).toBe('ela= \\d{4,}')
    expect(waitsOverRe(0.5)).toBe('ela= \\d{3,}')
    expect(waitsOverRe(0)).toBe('ela= \\d{1,}')
    expect(callsOverRe(10)).toBe(',e=\\d{5,}')
    expect(callsOverRe(1000)).toBe(',e=\\d{7,}')
  })

  it('matches the trace lines it is meant for', () => {
    const re = new RegExp(waitsOverRe(10))
    expect(re.test("WAIT #1: nam='db file sequential read' ela= 12345 file#=1")).toBe(true)
    expect(re.test("WAIT #1: nam='db file sequential read' ela= 999 file#=1")).toBe(false)
    expect(new RegExp(callsOverRe(10)).test('EXEC #1:c=0,e=250000,p=0')).toBe(true)
    expect(SEARCH_PRESETS.every((p) => { try { new RegExp(typeof p.re === 'string' ? p.re : p.re(p.ms ?? 10)); return true } catch { return false } })).toBe(true)
  })
})

describe('groupHits', () => {
  const hit = (line: number): SearchHit => ({ line, col: 0, text: '' })
  it('groups by statement, biggest first, with unknown and statement-less hits apart', () => {
    const owner: Record<number, number | undefined> = { 10: 4, 20: 7, 30: 7, 40: undefined, 50: -1, 60: 7, 70: 4, 80: undefined, 90: undefined }
    const hits = [10, 20, 30, 40, 50, 60, 70, 80, 90].map(hit)
    const g = groupHits(hits, (l) => owner[l])
    expect(g.map((x) => [x.stmt, x.hits.length, x.first])).toEqual([[7, 3, 20], [GROUP_UNKNOWN, 3, 40], [4, 2, 10], [-1, 1, 50]])
    expect(g.reduce((n, x) => n + x.hits.length, 0)).toBe(hits.length)
    expect(g[0].hits.map((h) => h.line)).toEqual([20, 30, 60])
  })
  it('is empty for no hits', () => { expect(groupHits([], () => 1)).toEqual([]) })
})

describe('frameFolds', () => {
  it('each framing range folds quietly under the line above it: the rule into the CURSOR above it, END OF STMT into the last SQL line', () => {
    const got = frameFolds([[83, 83], [86, 86], [120, 121]])
    expect(got.map((f) => [f.from, f.to, !!f.quiet, !!f.auto, !!f.frame])).toEqual([[82, 83, true, true, true], [85, 86, true, true, true], [119, 121, true, true, true]])
  })
  it('a range at line 1 has no line above to fold into; a handle the caller skips (a row of a plan table) leaves its range as rows', () => {
    expect(frameFolds([[1, 1], [10, 10], [30, 30]], (h) => h >= 8 && h <= 9).map((f) => f.from)).toEqual([29])
  })
  it('the lines vanish from the layout and come back with the fold opened', () => {
    const folds = frameFolds([[83, 83], [86, 86]])
    const ix = indexFolds(folds)
    expect(visibleCount(130, ix)).toBe(128)
    expect(lineOfRow(rowOfLine(84, ix), ix)).toBe(84) // the CURSOR row follows the line it was folded into
    expect(rowOfLine(84, ix) - rowOfLine(82, ix)).toBe(1) // ... right under it
    expect(foldHiding(83, ix)?.from).toBe(82)
    expect(foldHiding(86, ix)?.from).toBe(85)
    expect(visibleCount(130, [])).toBe(130)
  })
  it('works with the bind folds: overlapping ones lose to the first, and a lot of them merge fast', () => {
    const binds = bindFolds([[100, 110]], [[102, 106]], 4)
    const frame = frameFolds([[111, 111], [109, 109]]) // handles 110 and 108: both inside the BINDS block's fold [100, 110]
    expect(mergeFolds(binds, frame).map((f) => [f.from, f.to])).toEqual([[100, 110]])
    expect(mergeFolds(binds, frameFolds([[112, 112]])).map((f) => [f.from, f.to])).toEqual([[100, 110], [111, 112]])
    const many = Array.from({ length: 60000 }, (_, i): [number, number] => [3 * i + 5, 3 * i + 5])
    const t0 = Date.now()
    expect(mergeFolds([], frameFolds(many)).length).toBe(60000)
    expect(Date.now() - t0).toBeLessThan(2000)
  })
})

describe('frameFolds with SQL bands (wrap mode)', () => {
  // io_waits.trc: the cursor parsed at line 84 has one text line (85); a made-up second one has the text lines 201..212
  const ranges: [number, number][] = [[83, 83], [86, 86], [199, 199], [213, 213]]
  const bands = [{ from: 85, to: 85, text: 'select 1 from dual' }, { from: 201, to: 212, text: 'select\n  1\nfrom\n  dual' }]
  it('the text lines after the first fold into it together with the END OF STMT line, and the END OF STMT fold of the same text is not a second fold', () => {
    const got = frameFolds(ranges, undefined, bands)
    expect(got.map((f) => [f.from, f.to, !!f.sql, !!f.quiet, !!f.auto])).toEqual([[82, 83, false, true, true], [85, 86, true, true, true], [198, 199, false, true, true], [201, 213, true, true, true]])
    expect(got[3].summary).toBe('SQL text: 12 lines, wrapped')
    // without bands (wrap off, or an engine without them) the framing folds are the same as before
    expect(frameFolds(ranges).map((f) => [f.from, f.to, !!f.sql])).toEqual([[82, 83, false], [85, 86, false], [198, 199, false], [212, 213, false]])
  })
  it('the lines of a folded text map to its first line: the row of a hidden text line is the band row, the CURSOR row stays above it', () => {
    const ix = indexFolds(frameFolds(ranges, undefined, bands))
    expect(rowOfLine(205, ix)).toBe(rowOfLine(201, ix)) // a go-to into a folded text line lands on the band row
    expect(rowOfLine(213, ix)).toBe(rowOfLine(201, ix)) // ... and so does the END OF STMT line
    expect(foldHiding(205, ix)?.sql).toBe(true)
    expect(foldHiding(201, ix)).toBeUndefined() // the first text line is the handle, it stays
    expect(lineOfRow(rowOfLine(201, ix), ix)).toBe(201)
    expect(rowOfLine(200, ix) + 1).toBe(rowOfLine(201, ix)) // the CURSOR row is right above
    expect(visibleCount(300, ix)).toBe(300 - (1 + 1 + 1 + 12)) // the folds hide 1 (rule), 1 (END OF STMT), 1 (rule) and 12 (11 text lines and END OF STMT)
  })
  it('sqlBandAt finds the band that holds a text line (none for the CURSOR line above it, the END OF STMT line below it, or no bands)', () => {
    expect(sqlBandAt(bands, 85)?.text).toBe('select 1 from dual')
    expect(sqlBandAt(bands, 201)?.from).toBe(201)
    expect(sqlBandAt(bands, 212)?.from).toBe(201)
    expect(sqlBandAt(bands, 84)).toBeUndefined()
    expect(sqlBandAt(bands, 86)).toBeUndefined()
    expect(sqlBandAt(bands, 213)).toBeUndefined()
    expect(sqlBandAt(bands, 1)).toBeUndefined()
    expect(sqlBandAt(undefined, 85)).toBeUndefined()
    expect(sqlBandAt([], 85)).toBeUndefined()
  })
  it('a text the engine did not list keeps its framing fold and its rows', () => {
    const got = frameFolds(ranges, undefined, [bands[0]])
    expect(got.map((f) => [f.from, f.to, !!f.sql])).toEqual([[82, 83, false], [85, 86, true], [198, 199, false], [212, 213, false]])
  })
})

describe('mergeFolds', () => {
  const f = (from: number, to: number) => ({ from, to, summary: `${from}-${to}` })
  it('keeps the existing folds, adds the ones that overlap nothing and sorts', () => {
    const got = mergeFolds([f(10, 20), f(50, 60)], [f(5, 8), f(15, 30), f(21, 25), f(60, 70), f(90, 95)])
    expect(got.map((x) => [x.from, x.to])).toEqual([[5, 8], [10, 20], [21, 25], [50, 60], [90, 95]])
  })
  it('drops added folds that overlap each other', () => {
    expect(mergeFolds([], [f(1, 5), f(5, 9)]).map((x) => x.from)).toEqual([1])
  })
})

describe('hotStep: j and J, the toolbar\'s Hot spot ↓ and ↑', () => {
  const hot = [10, 40, 90]
  it('firstAbove is the first index past x', () => {
    expect(firstAbove(hot, 9)).toBe(0)
    expect(firstAbove(hot, 10)).toBe(1)
    expect(firstAbove(hot, 90)).toBe(3)
    expect(firstAbove([], 5)).toBe(0)
  })
  it('steps down to the next hot spot, never staying on the line it is on', () => {
    expect(hotStep(hot, 1, 1)).toBe(10)
    expect(hotStep(hot, 10, 1)).toBe(40)
    expect(hotStep(hot, 25, 1)).toBe(40)
    expect(hotStep(hot, 90, 1)).toBeUndefined() // the last one: none after
  })
  it('steps up to the previous one, from a hot spot or from between two', () => {
    expect(hotStep(hot, 91, -1)).toBe(90)
    expect(hotStep(hot, 90, -1)).toBe(40) // on a hot spot: the one before it
    expect(hotStep(hot, 25, -1)).toBe(10)
    expect(hotStep(hot, 10, -1)).toBeUndefined() // the first one: none before
    expect(hotStep(hot, 3, -1)).toBeUndefined()
    expect(hotStep([], 3, -1)).toBeUndefined()
    expect(hotStep([], 3, 1)).toBeUndefined()
  })
})

describe('the statement routes (api/lines/stmts)', () => {
  it('asks for the union of the runs of the statements, sorted and once each, and reads the runs', async () => {
    const f = stub(() => json({ total: 900, lines: 7, runs: [[3, 5], [9, 9]], truncated: true }))
    const r = await fetchStmtUnion(client, 1, [12, 3, 12, 40], undefined, 500)
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/lines/stmts?file=1&ids=3,12,40&union=1&limit=500')
    expect(r).toEqual({ total: 900, lines: 7, runs: [[3, 5], [9, 9]], truncated: true })
  })
  it('asks for each statement\'s runs', async () => {
    const f = stub(() => json({ total: 50, stmts: [{ id: 2, lines: 4, runs: [[1, 4]] }, { id: 5 }], truncated: false }))
    const r = await fetchStmtRuns(client, 0, [5, 2])
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/lines/stmts?file=0&ids=2,5&limit=100000')
    expect(r.stmts).toEqual([{ id: 2, lines: 4, runs: [[1, 4]] }, { id: 5, lines: 0, runs: [] }])
  })
  it('asks for the counts per bucket (the strip) and fills a missing bucket with 0', async () => {
    const f = stub(() => json({ total: 100, buckets: 4, size: 25, stmts: [{ id: 2, lines: 30, counts: [10, 20] }] }))
    const r = await fetchStmtBins(client, 0, [2], 4)
    expect(f.mock.calls[0][0]).toBe('http://h/s/1/api/lines/stmts?file=0&ids=2&bins=4')
    expect(r.stmts[0].counts).toEqual([10, 20, 0, 0])
  })
  it('throws the engine\'s message when it does not know the route', async () => {
    stub(() => new Response('404 page not found', { status: 404, statusText: 'Not Found' }))
    await expect(fetchStmtUnion(client, 0, [1])).rejects.toThrow('404')
  })
})
