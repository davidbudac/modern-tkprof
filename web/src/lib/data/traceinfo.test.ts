import { describe, expect, it } from 'vitest'
import { productOf, shortVersion, someOf, traceInfo, whenOf, type InfoDoc } from './traceinfo'
import type { Context, FileEntry, KV } from './types'

const ctx = (id: number, extra: Partial<Context> = {}): Context => ({
  id, line: id + 1, sessionId: '', clientId: '', service: '', module: '', action: '', clientDriver: '', containerId: '', process: '', fileIdx: 0, ...extra,
})
const fileEntry = (idx: number, extra: Partial<FileEntry> = {}): FileEntry => ({ idx, instance: 'cdb1', firstWallUs: 0, lastWallUs: 0, ...extra } as FileEntry)

// the header of testdata/traces/19c/io_waits.trc
const headers19c: KV[] = [
  { key: 'Oracle Database', value: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production' },
  { key: 'Oracle Version', value: '19.27.0.0.0' },
  { key: 'Instance name', value: 'cdb1' },
  { key: 'Database name', value: 'cdb1 ' },
  { key: 'Database role', value: 'PRIMARY' },
]

const T0 = Date.UTC(2026, 9, 22, 11, 35, 29, 191) * 1000 // 2026-10-22T11:35:29.191Z
const doc = (over: Partial<InfoDoc> = {}): InfoDoc => ({
  file: { headers: headers19c, version: '19.27.0.0.0', instance: 'cdb1', node: 'ol9-19-dg1.localdomain', machine: 'x86_64', systemName: 'Linux', files: [fileEntry(0)] },
  contexts: [
    ctx(0, { sessionId: '51.14688', service: 'pdb1', module: 'mtk_io_waits', action: 'start', clientDriver: 'SQL*PLUS', clientId: 'mtk_client', containerId: '3' }),
    ctx(1, { sessionId: '51.14688', service: 'pdb1', module: 'mtk_io_waits', action: 'full_scan', clientDriver: 'SQL*PLUS', clientId: 'mtk_client', containerId: '3' }),
  ],
  markers: [{ line: 23, kind: 1, text: 'PDB1(3)', time: '', hasTime: true }],
  span: { firstWallUs: T0, lastWallUs: T0 + 6_459_000 },
  tzOffsetMin: 0,
  wallOf: (tim) => T0 + tim,
  ...over,
})
const all = { window: null, files: null, contexts: null }

describe('the trace info of the Overview masthead', () => {
  it('names the database, its PDB, release, host and the session of a single-session trace', () => {
    const i = traceInfo(doc(), all)
    expect(i).toMatchObject({
      db: 'cdb1', pdbs: ['PDB1'], product: '19c Enterprise Edition', version: '19.27', role: '', instances: ['cdb1'], host: 'ol9-19-dg1', platform: 'Linux x86_64',
      sessions: ['51.14688'], pxSlaves: 0, services: ['pdb1'], modules: ['mtk_io_waits'], actions: ['start', 'full_scan'], drivers: ['SQL*PLUS'], clientIds: ['mtk_client'],
    })
  })

  it('shows a role other than PRIMARY, and falls back to the instance without a Database name line (21c XE)', () => {
    const headers = [{ key: 'Database role', value: 'PHYSICAL STANDBY' }]
    const i = traceInfo(doc({ file: { ...doc().file, headers } }), all)
    expect(i.role).toBe('PHYSICAL STANDBY')
    expect(i.db).toBe('cdb1')
    expect(i.product).toBe('')
  })

  it('counts PX slaves attached to a coordinator in scope apart from the sessions', () => {
    const d = doc({
      contexts: [
        ctx(0, { sessionId: '10.1', module: 'qc' }),
        ctx(1, { sessionId: '20.2', px: true, parent: 0 }),
        ctx(2, { sessionId: '30.3', px: true, parent: -1 }),
        ctx(3, { sessionId: '40.4', module: 'other' }),
      ],
    })
    expect(traceInfo(d, all)).toMatchObject({ sessions: ['10.1', '30.3', '40.4'], pxSlaves: 1, modules: ['qc', 'other'] })
    // the coordinator out of scope: its slave is a session of its own
    expect(traceInfo(d, { ...all, contexts: new Set([1, 3]) })).toMatchObject({ sessions: ['20.2', '40.4'], pxSlaves: 0 })
  })

  it('takes the instances and wall clock of the selected files, and the window\'s wall clock when one is set', () => {
    const files = [fileEntry(0, { instance: 'orcl1', firstWallUs: T0, lastWallUs: T0 + 1e6 }), fileEntry(1, { instance: 'orcl2', firstWallUs: T0 + 5e6, lastWallUs: T0 + 9e6 })]
    const d = doc({ file: { ...doc().file, files } })
    expect(traceInfo(d, all).instances).toEqual(['orcl1', 'orcl2'])
    expect(traceInfo(d, { ...all, files: new Set([1]) })).toMatchObject({ instances: ['orcl2'], firstWallUs: T0 + 5e6, lastWallUs: T0 + 9e6 })
    expect(traceInfo(d, { ...all, window: { startTim: 2e6, endTim: 3e6 } })).toMatchObject({ firstWallUs: T0 + 2e6, lastWallUs: T0 + 3e6 })
  })

  it('has no wall clock when the trace has none, and the window does not invent one', () => {
    const d = doc({ span: { firstWallUs: 0, lastWallUs: 0 }, wallOf: () => 0 })
    expect(whenOf(traceInfo(d, { ...all, window: { startTim: 1, endTim: 2 } }))).toBeNull()
  })
})

describe('trace info formats', () => {
  it('shortens the release and reads the product from the banner', () => {
    expect(['19.27.0.0.0', '23.26.3.0.0', '12.2.0.1.0', '21.3.0.0.0', '19'].map(shortVersion)).toEqual(['19.27', '23.26.3', '12.2.0.1', '21.3', '19'])
    expect(productOf('Oracle AI Database 26ai Free Release 23.26.3.0.0 - Develop, Learn, and Run for Free')).toBe('26ai Free')
    expect(productOf('Oracle Database 12c Enterprise Edition Release 12.2.0.1.0 - 64bit Production')).toBe('12c Enterprise Edition')
    expect(productOf('Oracle Database 21c Express Edition Release 21.0.0.0.0 - Production')).toBe('21c Express Edition')
    expect(productOf('something else')).toBe('')
  })

  it('writes the span in the trace\'s time zone, with both days when it crosses midnight', () => {
    expect(whenOf({ firstWallUs: T0, lastWallUs: T0 + 6_459_000, tzOffsetMin: 0 })).toEqual({ time: '11:35:29 → 11:35:35', date: 'Thu 22 Oct 2026 · UTC+00:00' })
    expect(whenOf({ firstWallUs: T0, lastWallUs: T0 + 3600e6, tzOffsetMin: 12 * 60 + 30 })).toEqual({ time: '00:05:29 → 01:05:29', date: 'Fri 23 Oct 2026 · UTC+12:30' })
    expect(whenOf({ firstWallUs: T0, lastWallUs: T0 + 168_000, tzOffsetMin: 0 })!.time).toBe('11:35:29.191 → 11:35:29.359')
    expect(whenOf({ firstWallUs: T0, lastWallUs: T0 + 13 * 3600e6, tzOffsetMin: 0 })!.date).toBe('Thu 22 Oct → Fri 23 Oct 2026 · UTC+00:00')
    expect(whenOf({ firstWallUs: Date.UTC(2025, 11, 31, 23) * 1000, lastWallUs: Date.UTC(2026, 0, 1, 1) * 1000, tzOffsetMin: 0 })!.date).toBe('Wed 31 Dec 2025 → Thu 1 Jan 2026 · UTC+00:00')
  })

  it('lists a few names and counts the rest', () => {
    expect(someOf(['a', 'b'])).toBe('a, b')
    expect(someOf(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c +2')
  })
})
