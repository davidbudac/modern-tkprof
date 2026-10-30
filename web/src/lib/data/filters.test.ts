import { describe, expect, it } from 'vitest'
import type { TraceDoc } from './doc'
import type { FileEntry } from './types'
import { makeDoc } from './testdoc'
import { activeFilters, type FilterState } from './filters'

const none: FilterState = { files: null, contexts: null, window: null, block: null, includeIdle: true, statementCallTypes: null }

/** A document with a wall clock (tim 0 is 22:13:20 UTC) and two statements, for the window chips. */
const clocked = {
  wallOffsetUs: 1_700_000_000_000_000, wallOf: (t: number) => t + 1_700_000_000_000_000, tzOffsetMin: 0, span: { firstTim: 1000 },
  statements: [{ sqlId: 'aaaaaaaaaaaaa' }, { sqlId: 'dqs15xw1bmqs1' }], label: (s: { sqlId: string }) => s.sqlId,
  contexts: [], file: {},
} as unknown as TraceDoc

describe('activeFilters', () => {
  it('is empty without a filter', async () => {
    expect(activeFilters(await makeDoc([]), none)).toEqual([])
  })

  it('names the selected files', async () => {
    const doc = await makeDoc([]) // qc.trc, px_p000.trc, other.trc
    const [f, ...rest] = activeFilters(doc, { ...none, files: new Set([0, 2]) })
    expect(rest).toEqual([])
    expect(f).toMatchObject({ kind: 'files', label: 'Files', text: '2 of 3 files · qc.trc, other.trc' })
    expect(f.title).toBe('Only these files are shown:\n/t/qc.trc\n/t/other.trc')
  })

  it('lists three files and counts the rest', async () => {
    const file = (idx: number): FileEntry => ({ idx, path: `/t/f${idx}.trc`, name: `f${idx}.trc`, size: 1, lines: 1, firstTim: 0, lastTim: 0, firstWallUs: 0, lastWallUs: 0, processPid: '', instance: '', traceFile: '', px: false, chain: idx, followed: false })
    const doc = await makeDoc([], { files: [0, 1, 2, 3, 4, 5].map(file) })
    expect(activeFilters(doc, { ...none, files: new Set([5, 1, 2, 3, 0]) })[0].text).toBe('5 of 6 files · f0.trc, f1.trc, f2.trc +2')
  })

  it('says so when no file is selected', async () => {
    const [f] = activeFilters(await makeDoc([]), { ...none, files: new Set() })
    expect(f.text).toBe('0 of 3 files')
    expect(f.title).toMatch(/empty/)
  })

  it('names the sessions by session id, else process id, once each, and skips unnamed ones', async () => {
    const doc = await makeDoc([], { contexts: [{ fileIdx: 0, sessionId: '1.2' }, { fileIdx: 0, sessionId: '1.2' }, { fileIdx: 1, process: '4242' }, { fileIdx: 2 }, { fileIdx: 2, sessionId: '7.8' }] })
    expect(activeFilters(doc, { ...none, contexts: new Set([1, 0]) })[0]).toMatchObject({ kind: 'sessions', label: 'Sessions', text: '2 of 5 sessions · 1.2' })
    expect(activeFilters(doc, { ...none, contexts: new Set([3, 2, 0]) })[0].text).toBe('3 of 5 sessions · 1.2, pid 4242')
    expect(activeFilters(doc, { ...none, contexts: new Set([4, 3, 2, 0]) })[0].text).toBe('4 of 5 sessions · 1.2, pid 4242 +1')
    expect(activeFilters(doc, { ...none, contexts: new Set([3]) })[0].text).toBe('1 of 5 sessions')
    expect(activeFilters(doc, { ...none, contexts: new Set([2]) })[0].title).toBe('Only these session contexts are shown:\npid 4242')
  })

  it('shows the window on the wall clock, with microseconds under 10 ms', () => {
    const [w] = activeFilters(clocked, { ...none, window: { startTim: 1_500_000, endTim: 3_250_000 } })
    expect(w).toMatchObject({ kind: 'window', label: 'Window', text: '22:13:21.500 → 22:13:23.250 · 1.750 s' })
    expect(w.title).toBe('Only this time window is counted: 2023-11-14 22:13:21.500 → 2023-11-14 22:13:23.250')
    expect(activeFilters(clocked, { ...none, window: { startTim: 1_000, endTim: 1_250 } })[0].text).toBe('22:13:20.001000 → 22:13:20.001250 · 250 µs')
  })

  it('shows the window as offsets from the trace start without a wall clock', async () => {
    const doc = await makeDoc([]) // first tim 1000
    expect(activeFilters(doc, { ...none, window: { startTim: 1500, endTim: 3500 } })[0].text).toBe('+500 µs → +2.50 ms · 2.00 ms')
    expect(activeFilters(doc, { ...none, window: { startTim: 1500, endTim: 3500 } }, 500)[0].text).toBe('+1.00 ms → +3.00 ms · 2.00 ms') // from the axis start
  })

  it('names the lane block only while the window is its interval', () => {
    const window = { startTim: 1_500_000, endTim: 3_250_000 }
    const block = { stmt: 1, startTim: 1_500_000, endTim: 3_250_000 }
    const [w] = activeFilters(clocked, { ...none, window, block })
    expect(w.text).toBe('22:13:21.500 → 22:13:23.250 · 1.750 s · block of dqs15xw1bmqs1')
    expect(w.title).toMatch(/\nthe block of dqs15xw1bmqs1 /)
    expect(activeFilters(clocked, { ...none, window: { ...window, endTim: 3_250_001 }, block })[0].text).not.toMatch(/block/)
    expect(activeFilters(clocked, { ...none, window, block: { ...block, stmt: 9 } })[0].text).not.toMatch(/block/) // a statement the document does not have
  })

  it('lists hidden idle waits', async () => {
    const doc = await makeDoc([])
    expect(activeFilters(doc, { ...none, includeIdle: false })).toMatchObject([{ kind: 'idle', label: 'Idle waits', text: 'hidden' }])
  })

  it('adds marked database call types to the filter row in call order', async () => {
    const doc = await makeDoc([])
    expect(activeFilters(doc, { ...none, statementCallTypes: new Set(['fetch', 'parse']) })).toEqual([
      { kind: 'statementCalls', label: 'Database calls', text: 'PARSE, FETCH', title: "SQL detail's Database calls table shows only: PARSE, FETCH" },
    ])
    expect(activeFilters(doc, { ...none, statementCallTypes: null })).toEqual([])
  })

  it('lists them in the order files, sessions, window, idle', async () => {
    const doc = await makeDoc([])
    const all = activeFilters(doc, { ...none, files: new Set([1]), contexts: new Set([2]), window: { startTim: 1000, endTim: 2000 }, block: null, includeIdle: false })
    expect(all.map((f) => f.kind)).toEqual(['files', 'sessions', 'window', 'idle'])
  })
})
