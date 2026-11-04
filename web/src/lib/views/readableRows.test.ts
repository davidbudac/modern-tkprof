import { describe, expect, it } from 'vitest'
import type { TraceDoc } from '../data/doc'
import { LINE_KINDS, type CachedLine } from '../data/linecache'
import type { LineKind } from '../data/lines'
import { readableRowsOf } from './readableRows'

// lines of testdata/traces/19c/io_waits.trc (around line 40; the tims are adjusted to give round deltas), with the cursor ids the engine
// gives them: two cursors, 0 and 1
const LINES: [string, LineKind, number][] = [
  ['EXEC #139745605242584:c=19,e=19,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=0,plh=0,tim=10804500070', 'call', 0],
  ["WAIT #139745605242584: nam='SQL*Net message to client' ela= 0 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=10804500079", 'wait', 0],
  ['', 'blank', -1],
  ["WAIT #139745605242584: nam='SQL*Net message from client' ela= 122 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=10804500200", 'wait', 0],
  ['', 'blank', -1],
  ['EXEC #139745605240912:c=81,e=81,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=0,plh=0,tim=10804500410', 'call', 1],
]
const line = (n: number): CachedLine | undefined => {
  const l = LINES[n - 1]
  return l && { text: l[0], kind: LINE_KINDS.indexOf(l[1]), call: -1, stmt: l[2], cursor: l[2], execNo: -1, wait: -1 }
}
const doc = {
  events: [], planLines: [], wallOffsetUs: 0, tzOffsetMin: 0, span: { firstTim: 10804500000 },
  cursors: [{ id: 0, number: 139745605242584, statement: 0, depth: 0 }, { id: 1, number: 139745605240912, statement: 1, depth: 0 }],
  statements: [{ id: 0, kind: 0, sqlId: 'aaaaaaaaaaaaa', text: 'select 1 from dual' }, { id: 1, kind: 0, sqlId: 'bbbbbbbbbbbbb', text: 'select 2 from dual' }],
  label: (s: { sqlId: string }) => s.sqlId,
  objectName: () => undefined, userName: () => undefined,
} as unknown as TraceDoc

const rows = (pin: { line: number; tim: number } | null = null) => {
  const f = readableRowsOf({ doc, line, tones: new Map(), pin, hot: new Map([[4, 122]]), scaleUs: 244 })
  return (n: number) => f(n, line(n)!)
}

describe('readableRowsOf', () => {
  it('a cursor stretch is one lane: the sql_id on its first row, the SQL on its second; a blank line between its lines stays in it', () => {
    const r = rows()
    expect(r(1).lane).toMatchObject({ label: 'aaaaaaaaaaaaa', stmt: 0, title: expect.stringContaining('cursor #139745605242584') })
    expect(r(2).lane).toMatchObject({ label: undefined, sub: 'select 1 from dual' })
    expect(r(3).lane?.stmt).toBe(0)
    expect(r(5).lane).toBeNull() // between two cursors: no lane
    expect(r(6).lane).toMatchObject({ label: 'bbbbbbbbbbbbb' })
  })
  it('Δ is the time from the line with a time before, or from the pin', () => {
    expect(rows()(4).delta).toBe('+121 µs')
    const p = rows({ line: 1, tim: 10804500070 })
    expect(p(1).pinned).toBe(true)
    expect(p(6).delta).toBe('+340 µs')
  })
  it('hot spots and bars on the file scale', () => {
    const r = rows()
    expect(r(4).hot).toBe(true)
    expect(r(4).barW).toBe(0.5)
    expect(r(2).hot).toBe(false)
  })
})
