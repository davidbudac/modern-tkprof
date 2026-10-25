import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { TraceDoc } from './doc'
import { componentRowsFrom } from './derive'
import { fmtDur } from './format'
import { makeDoc, type CallSpec } from './testdoc'
import { scopedStatements } from './stmtstats'
import { effectiveContexts } from './fileset'
import { localFileShares, shareTotals } from './fileshares'
import { concentrationLede, responseBaseUs, responseOf, responseShare, responseUs, scopeResponse, sessionsLabel, sessionsOf, shareNote, wallSpanUs } from './response'
import { LocalSource } from './source'
import type { Scope } from '../state/store'
import type { FileEntry, RawDocument } from './types'
import { CallKind } from './types'

const X = CallKind.exec
const file = (idx: number, firstTim: number, lastTim: number, extra: Partial<FileEntry> = {}): FileEntry => ({ idx, name: `f${idx}`, firstTim, lastTim, chain: idx, ...extra } as FileEntry)

// file 0: ctx 0 (1100..1500); file 1: ctx 1 (pid 11) and ctx 2 (pid 12) run at the same time (2100..2900, 2200..2900)
const calls: CallSpec[] = [
  { ctx: 0, stmt: 0, kind: X, e: 300, c: 100, tim: 1400, idleEla: 100 },
  { ctx: 0, stmt: 1, kind: X, e: 50, c: 50, tim: 1500 },
  { ctx: 1, stmt: 0, kind: X, e: 400, c: 50, tim: 2500, idleEla: 150 },
  { ctx: 1, stmt: 1, kind: X, e: 100, c: 50, tim: 2900 },
  { ctx: 2, stmt: 0, kind: X, e: 400, c: 50, tim: 2600, idleEla: 150 },
  { ctx: 2, stmt: 1, kind: X, e: 200, c: 150, tim: 2900, idleEla: 0 },
]

const make = () => makeDoc(calls, {
  files: [file(0, 1000, 2000), file(1, 2000, 3000)],
  contexts: [{ fileIdx: 0 }, { fileIdx: 1, process: '11' }, { fileIdx: 1, process: '12' }],
})
const scoped = (doc: Awaited<ReturnType<typeof make>>, files: number[] | null, window: Scope['window'] = null): Scope => {
  const f = files ? new Set(files) : null
  return { window, files: f, contexts: effectiveContexts(doc, f, null), includeIdle: true }
}

describe('the response time of a scope', () => {
  it('sums the sessions\' spans: a process of a file chain, from its first call start to its last row', async () => {
    const doc = await make()
    expect(sessionsOf(doc).n).toBe(3)
    const all = scopeResponse(doc, scoped(doc, null))
    // ctx 0: 1100..1500, ctx 1: 2100..2900, ctx 2: 2200..2900
    expect(all).toEqual({ responseUs: 400 + 800 + 700, wallUs: doc.spanUs(), sessions: 3 })
    expect(sessionsLabel(all, (us) => `${us}`)).toBe(`3 sessions · wall ${doc.spanUs()}`)
    expect(scopeResponse(doc, scoped(doc, [1]))).toEqual({ responseUs: 1500, wallUs: 1000, sessions: 2 })
    expect(sessionsLabel(scopeResponse(doc, scoped(doc, [0])), String)).toBe('')
  })

  it('is a single session\'s span, its file\'s range at most', async () => {
    const doc = await makeDoc([{ ctx: 0, stmt: 0, kind: X, e: 900, tim: 1400 }, { ctx: 1, stmt: 1, kind: X, e: 10, tim: 1900 }],
      { files: [file(0, 1400, 1900)], contexts: [{ fileIdx: 0 }, { fileIdx: 0 }] })
    // the first call started 500 µs before the file's first line: it counts from there, as the trace span does
    expect(scopeResponse(doc, { window: null, contexts: null })).toEqual({ responseUs: 500, wallUs: doc.spanUs(), sessions: 1 })
  })

  it('clips every session to a window', async () => {
    const doc = await make()
    const w = { startTim: 2300, endTim: 2600 }
    expect(scopeResponse(doc, scoped(doc, null, w))).toEqual({ responseUs: 600, wallUs: 300, sessions: 2 })
  })

  it('counts runs of selected contexts of a session, not the gaps between them', async () => {
    const doc = await makeDoc([
      { ctx: 0, stmt: 0, kind: X, e: 100, tim: 1200 }, { ctx: 1, stmt: 0, kind: X, e: 100, tim: 1500 }, { ctx: 2, stmt: 0, kind: X, e: 100, tim: 1900 },
    ], { files: [file(0, 1100, 1900)], contexts: [{ fileIdx: 0 }, { fileIdx: 0 }, { fileIdx: 0 }] })
    expect(scopeResponse(doc, { window: null, contexts: null }).responseUs).toBe(800)
    expect(scopeResponse(doc, { window: null, contexts: new Set([0, 2]) })).toMatchObject({ responseUs: 200, sessions: 1 })
    expect(scopeResponse(doc, { window: null, contexts: new Set([0, 1]) }).responseUs).toBe(400)
    expect(scopeResponse(doc, { window: null, contexts: new Set() })).toEqual({ responseUs: 0, wallUs: 0, sessions: 0 })
  })

  it('leaves out PX slaves whose coordinator is in scope; a slave alone is a session', async () => {
    // the default test set: ctx 2 (file 1) is a PX slave of ctx 0
    const doc = await makeDoc([
      { ctx: 0, stmt: 0, kind: X, e: 400, tim: 1400 }, { ctx: 2, stmt: 0, kind: X, e: 200, tim: 2300 }, { ctx: 3, stmt: 1, kind: X, e: 100, tim: 3400 },
    ])
    expect(scopeResponse(doc, { window: null, contexts: null })).toMatchObject({ responseUs: 400 + 100, sessions: 2 })
    expect(scopeResponse(doc, { window: null, contexts: new Set([2]) })).toMatchObject({ responseUs: 200, sessions: 1 })
    expect(scopeResponse(doc, { window: null, contexts: new Set([0, 2]) })).toMatchObject({ responseUs: 400, sessions: 1 })
  })

  it('comes with the profile: LocalSource computes it, a server\'s answer is taken as it is', async () => {
    const doc = await make()
    const sc = scoped(doc, [1])
    const p = new LocalSource(doc).profile(sc)!
    expect([p.responseUs, p.wallUs, p.sessions]).toEqual([1500, 1000, 2])
    expect(responseOf(doc, sc, { responseUs: 7, wallUs: 8, sessions: 9 })).toEqual({ responseUs: 7, wallUs: 8, sessions: 9 })
    expect(responseOf(doc, sc, { responseUs: 7 })).toEqual(scopeResponse(doc, sc)) // an older engine: computed here
  })

  it('the wall clock: the window, else the span of the files of the contexts, else the trace', async () => {
    const doc = await make()
    expect(wallSpanUs(doc, { window: { startTim: 10, endTim: 60 }, contexts: null })).toBe(50)
    expect(wallSpanUs(doc, { window: null, contexts: null })).toBe(doc.spanUs())
    expect(wallSpanUs(doc, { window: null, contexts: new Set([0]) })).toBe(1000)
    expect(wallSpanUs(doc, { window: null, contexts: new Set([0, 2]) })).toBe(2000)
  })
})

describe('a statement\'s share of the response time', () => {
  it('is (elapsed + idle) over the scope\'s response time, the same in every view', async () => {
    const doc = await make()
    const sc = scoped(doc, [0])
    const s = scopedStatements(doc, sc)[0]
    expect(responseUs(s)).toBe(300 + 100)
    const base = responseBaseUs(doc, sc, true)
    expect(base).toBe(400) // the session of file 0, not the trace's
    expect(responseShare(s, base)).toBeCloseTo(1)
    expect(shareNote(responseShare(s, base))).toBeUndefined()
    // not narrowed (an engine without api/statements): whole-trace numbers over the whole trace
    expect(responseBaseUs(doc, sc, false)).toBe(1900)
  })

  it('stays within the sum of concurrent sessions where the wall clock would not', async () => {
    const doc = await make()
    const sc = scoped(doc, [1])
    const s = scopedStatements(doc, sc)[0]
    expect(responseUs(s)).toBe(2 * (400 + 150))
    const share = responseShare(s, responseBaseUs(doc, sc, true))
    expect(share).toBeCloseTo(1100 / 1500)
    expect(responseUs(s) / wallSpanUs(doc, sc)).toBeGreaterThan(1) // what the wall clock said before
    for (const st of scopedStatements(doc, scoped(doc, null))) expect(responseShare(st, responseBaseUs(doc, scoped(doc, null), true))).toBeLessThanOrEqual(1)
  })

  it('can pass 100 % with a window (a call overlapping it counts whole), and says why', async () => {
    const doc = await make()
    const sc = scoped(doc, null, { startTim: 2300, endTim: 2600 })
    const s = scopedStatements(doc, sc)[0]
    const share = responseShare(s, responseBaseUs(doc, sc, true))
    expect(share).toBeGreaterThan(1)
    expect(shareNote(share)).toMatch(/above 100/)
  })

  it('is 0 without a base', () => {
    expect(responseShare({ elapsed: 5, idleUs: 5 }, 0)).toBe(0)
  })
})

describe('the Files panel shares', () => {
  it('give each file its own rows: a chain part with only recursive calls still has its time', async () => {
    // one session in two chained files: the top-level call ends in part 2, its recursive children run in part 1
    const doc = await makeDoc([
      { ctx: 0, stmt: 1, kind: X, e: 400, c: 10, tim: 1500, dep: 1, parent: 1 },
      { ctx: 1, stmt: 0, kind: X, e: 1500, c: 40, tim: 2500 },
    ], { files: [file(0, 1100, 1500, { chain: 0 }), file(1, 1600, 2500, { chain: 0 })], contexts: [{ fileIdx: 0 }, { fileIdx: 1 }] })
    expect(sessionsOf(doc).n).toBe(1)
    const sh = localFileShares(doc)!
    expect(sh.map((s) => s.responseUs)).toEqual([400, 900]) // part 2's call started in part 1: counted from part 2's first line
    expect(shareTotals(doc, sh).responseUs).toBe(1400) // the session: part 1's first call start to part 2's end
  })
})

// The workload set (testdata/sets/workload: 4 concurrent sessions, 8 attached PX slaves, a 2-file chain), as the document
// internal/report TestFindingsDocsCurrent writes.
describe('the Overview of a set of concurrent sessions', () => {
  const load = async () => {
    const raw = JSON.parse(gunzipSync(readFileSync(fileURLToPath(new URL('./testdata/findings-workload.json.gz', import.meta.url)))).toString('utf8'))
    return TraceDoc.fromRaw(raw.doc as RawDocument)
  }

  it('heads with the sum over the sessions and the wall clock beside it', async () => {
    const doc = await load()
    const r = scopeResponse(doc, { window: null, contexts: null })
    expect(r).toEqual({ responseUs: 5330494, wallUs: 3849126, sessions: 4 })
    expect(`Response time ${fmtDur(r.responseUs)} · ${sessionsLabel(r, fmtDur)}`).toBe('Response time 5.330 s · 4 sessions · wall 3.849 s')
  })

  it('keeps every ledger row, statement and the top-statements lede within 100 %', async () => {
    const doc = await load()
    const scope: Scope = { window: null, files: null, contexts: null, includeIdle: true }
    const p = new LocalSource(doc).profile(scope)!
    const base = responseOf(doc, scope, p).responseUs
    const rows = componentRowsFrom(doc, p, base)
    expect(rows.find((x) => x.label === 'PL/SQL lock timer')!.us / base).toBeCloseTo(4.952 / 5.330, 2)
    for (const x of rows) expect(Math.abs(x.us), x.label).toBeLessThanOrEqual(base)
    expect(rows.find((x) => x.kind === 'unaccounted')!.us).toBeGreaterThan(0)
    const stmts = scopedStatements(doc, scope).sort((a, b) => responseUs(b) - responseUs(a))
    for (const s of stmts) expect(responseShare(s, base), `statement ${s.id}`).toBeLessThanOrEqual(1)
    expect(concentrationLede(base, stmts)).toBe('top 2 statements: 94%')
  })

  it('gives the first part of the batch chain its own share in the Files panel', async () => {
    const doc = await load()
    const sh = localFileShares(doc)!
    const files = doc.file.files!
    const share = (name: string) => sh[files.findIndex((f) => f.name === name)].responseUs / shareTotals(doc, sh).responseUs
    expect(share('cdb1_ora_22608_mtk_wl_batch.trc')).toBeGreaterThan(0.07) // 0.41 s of 5.33 s: the part ends with the 0.4 s sleep
    expect(share('cdb1_ora_22608_mtk_wl_batch_2.trc')).toBeGreaterThan(0.1)
    expect(share('cdb1_ora_22604_mtk_wl_orders.trc')).toBeCloseTo(3.849 / 5.330, 2)
    let sum = 0
    files.forEach((f, i) => { if (!f.px) sum += sh[i].responseUs })
    expect(sum / shareTotals(doc, sh).responseUs).toBeLessThanOrEqual(1)
  })
})
