import { describe, expect, it } from 'vitest'
import { createStore } from '../state/store'
import { libraryFile, mergeLibrary, parseLibraryFile, pivotConfigOf, resolvePivotConfig, type PivotConfig, type SavedPivot } from './pivotconfig'
import { stmtRef } from './annotations'
import type { Context, Event, Statement } from './types'

const st = (id: number, sqlId: string, text: string): Statement =>
  ({ id, kind: 0, sqlId, hashValue: 0, text, len: text.length, commandType: 3, commandName: 'SELECT', parsingUserId: 0, privilegeUserId: 0, minDepth: 0, firstLine: 1, cursors: [] })
const ev = (id: number, name: string): Event => ({ id, name, class: 'User I/O', p1Name: '', p2Name: '', p3Name: '', idle: false })
const ctx = (id: number, sessionId: string, module = 'SQL*Plus'): Context =>
  ({ id, line: 1, sessionId, clientId: '', service: '', module, action: '', clientDriver: '', containerId: '', process: '' })
const span = (first: number, last: number) => ({ firstTim: first, lastTim: last, firstWallUs: 0, lastWallUs: 0, firstLine: 1, lastLine: 9 })

const docA = { statements: [st(0, 'aaa', 'select a'), st(1, 'bbb', 'select b')], events: [ev(0, 'db file sequential read'), ev(1, 'log file sync')], contexts: [ctx(0, '12.34'), ctx(1, '56.78')], span: span(1000, 61000) }
const docB = { statements: [st(0, 'zzz', 'select z'), st(1, 'bbb', 'select b')], events: [ev(0, 'log file sync')], contexts: [ctx(0, '99.1')], span: span(5000, 35000) }

describe('pivot config', () => {
  it('captures the store state with stable keys and resolves it on another document', () => {
    const store = createStore()
    store.setState({ doc: docA as never, window: { startTim: 11000, endTim: 21000 }, contexts: new Set([1]), includeIdle: false })
    store.actions.setPivot({ fact: 'waits', by: ['event', 'obj'], sort: { calls: 'e', waits: 'max' }, stmt: 1, event: 1 })
    const cfg = store.getPivotConfig()
    expect(cfg).toEqual({
      fact: 'waits', by: ['event', 'obj'], sort: 'max', limit: 1000, includeIdle: false,
      window: { fromUs: 10000, toUs: 20000 }, contexts: [{ session: '56.78', module: 'SQL*Plus', action: '' }],
      stmt: stmtRef(docA.statements[1]), event: 'log file sync',
    } satisfies PivotConfig)
    // JSON-safe
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg)

    const other = createStore()
    other.setState({ doc: docB as never })
    const { dropped } = other.applyPivotConfig(cfg)
    const s = other.getState()
    expect(s.view).toBe('pivot')
    expect(s.pivot).toMatchObject({ fact: 'waits', by: ['event', 'obj'], sort: { waits: 'max' }, stmt: 1, event: 0 })
    expect(s.window).toEqual({ startTim: 15000, endTim: 25000 })
    expect(s.contexts).toBeNull()
    expect(s.includeIdle).toBe(false)
    expect(dropped).toEqual(['session contexts'])
    expect(s.pivot.notice).toMatch(/left out: session contexts/)
  })

  it('drops what the target does not have and cuts the window to its span', () => {
    const cfg: PivotConfig = { fact: 'calls', by: ['stmt'], sort: 'nope', limit: 50, includeIdle: true, window: { fromUs: 20000, toUs: 90000 }, stmt: { sqlId: 'aaa', hash: 'x' }, event: 'gc buffer busy' }
    const cur = createStore().getState().pivot
    const r = resolvePivotConfig(docB, cfg, cur)
    expect(r.patch.window).toEqual({ startTim: 25000, endTim: 35000 })
    expect(r.patch.pivot).toMatchObject({ sort: { calls: 'e' }, limit: 50, stmt: null, event: null })
    expect(r.dropped).toEqual(['sort by nope', 'statement aaa', 'event "gc buffer busy"'])
    expect(resolvePivotConfig(docB, { ...cfg, window: { fromUs: 40000, toUs: 50000 } }, cur).dropped).toContain('time window (after the end of this trace)')
  })

  it('with no document keeps only the shape', () => {
    const s = createStore().getState()
    expect(pivotConfigOf(s)).toEqual({ fact: 'calls', by: ['stmt'], sort: 'e', limit: 1000, includeIdle: true })
  })
})

describe('library file', () => {
  const p = (id: string, name: string, updated: number): SavedPivot => ({ id, name, created: 1, updated, config: { fact: 'calls', by: ['stmt'], sort: 'e', limit: 1000, includeIdle: true } })
  it('round-trips, also inside an export of everything, and merges by id (newer wins)', () => {
    const f = libraryFile([p('1', 'top sql', 5), p('2', 'by module', 5)])
    expect(parseLibraryFile(JSON.stringify(f)).pivots).toEqual(f.pivots)
    expect(parseLibraryFile(JSON.stringify({ version: 1, connections: [], library: f })).pivots).toHaveLength(2)
    expect(() => parseLibraryFile('{"version":1}')).toThrow(/not a library file/)
    const bad = parseLibraryFile(JSON.stringify({ version: 1, pivots: [p('3', 'x', 1), { id: 'y', name: 'y', updated: 1, config: { fact: 'rows' } }] }))
    expect(bad.skipped).toBe(1)
    const m = mergeLibrary([p('1', 'top sql', 5), p('2', 'by module', 9)], [p('1', 'top sql (new)', 6), p('2', 'by module (old)', 3), p('4', 'added', 1)])
    expect(m.map((x) => x.name)).toEqual(['added', 'by module', 'top sql (new)'])
  })
})
