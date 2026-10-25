import { describe, expect, it } from 'vitest'
import { makeDoc, type CallSpec } from './testdoc'
import { scopedStatements } from './stmtstats'
import { effectiveContexts } from './fileset'
import { responseBaseUs, responseShare, responseUs, shareNote } from './response'
import type { Scope } from '../state/store'
import type { FileEntry } from './types'
import { CallKind } from './types'

const X = CallKind.exec
const file = (idx: number, firstTim: number, lastTim: number): FileEntry => ({ idx, name: `f${idx}`, firstTim, lastTim } as FileEntry)

// file 0: ctx 0 (1000..2000); file 1: ctx 1 and 2 run at the same time (5000..6000); stmt 0 sleeps in both, 400 each, 150 idle inside the call
const calls: CallSpec[] = [
  { ctx: 0, stmt: 0, kind: X, e: 300, c: 100, tim: 1500, idleEla: 100 },
  { ctx: 1, stmt: 0, kind: X, e: 400, c: 50, tim: 5500, idleEla: 150 },
  { ctx: 2, stmt: 0, kind: X, e: 400, c: 50, tim: 5600, idleEla: 150 },
  { ctx: 2, stmt: 1, kind: X, e: 200, c: 150, tim: 5900, idleEla: 0 },
]

const make = () => makeDoc(calls, { files: [file(0, 1000, 2000), file(1, 5000, 6000)], contexts: [{ fileIdx: 0 }, { fileIdx: 1 }, { fileIdx: 1 }] })
const scoped = (doc: Awaited<ReturnType<typeof make>>, files: number[]): Scope => {
  const f = new Set(files)
  return { window: null, files: f, contexts: effectiveContexts(doc, f, null), includeIdle: true }
}

describe('a statement\'s share of the response time', () => {
  it('is (elapsed + idle) over the scope\'s response time, the same in every view', async () => {
    const doc = await make()
    const sc = scoped(doc, [0])
    const s = scopedStatements(doc, sc)[0]
    expect(responseUs(s)).toBe(300 + 100)
    const base = responseBaseUs(doc, null, sc.files, true)
    expect(base).toBe(1000) // the span of file 0, not the trace's
    expect(responseShare(s, base)).toBeCloseTo(0.4)
    expect(shareNote(responseShare(s, base))).toBeUndefined()
    // not narrowed (an engine without api/statements): whole-trace numbers over the whole trace
    expect(responseBaseUs(doc, null, sc.files, false)).toBe(doc.spanUs())
  })

  it('a time window is the base when there is one', async () => {
    const doc = await make()
    expect(responseBaseUs(doc, { startTim: 5100, endTim: 5400 }, new Set([1]), true)).toBe(300)
  })

  it('exceeds 100 % when sessions of the scope run at once, and says why', async () => {
    const doc = await make()
    const sc = scoped(doc, [1])
    const s = scopedStatements(doc, sc)[0]
    expect(responseUs(s)).toBe(2 * (400 + 150))
    const share = responseShare(s, responseBaseUs(doc, null, sc.files, true))
    expect(share).toBeCloseTo(1.1)
    expect(shareNote(share)).toMatch(/above 100/)
  })

  it('is 0 without a base', () => {
    expect(responseShare({ elapsed: 5, idleUs: 5 }, 0)).toBe(0)
  })
})
