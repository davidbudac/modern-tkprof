import { describe, expect, it } from 'vitest'
import { createStore } from '../state/store'
import { describePivotConfig, libraryFile, mergeLibrary, parseLibraryFile, pivotConfigOf, resolvePivotConfig, type PivotConfig, type SavedPivot } from './pivotconfig'
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

describe('window by clock time', () => {
  // two traces of the same day: B starts 30 s (of wall clock) after A, with other tim values
  const wall0 = Date.UTC(2026, 0, 2, 10, 0, 0) * 1000
  const timed = (base: typeof docA, firstTim: number, firstWall: number, lastTim: number) =>
    ({ ...base, span: { ...base.span, firstTim, lastTim, firstWallUs: firstWall }, wallOffsetUs: firstWall - firstTim, wallOf: (t: number) => t + firstWall - firstTim })
  const tA = timed(docA, 1000, wall0, 61000) // 60 ms long
  const tB = timed(docB, 5000, wall0 + 30_000, 65000) // starts 30 ms later
  const cur = createStore().getState().pivot

  it('records the window as wall-clock times only on request', () => {
    const store = createStore()
    store.setState({ doc: tA as never, window: { startTim: 11000, endTim: 21000 } })
    expect(store.getPivotConfig().windowClock).toBeUndefined()
    const cfg = store.getPivotConfig({ clock: true })
    expect(cfg.window).toEqual({ fromUs: 10000, toUs: 20000 })
    expect(cfg.windowClock).toEqual({ fromWallUs: wall0 + 10000, toWallUs: wall0 + 20000 })
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg)
    // a trace without timestamps has nothing to record
    store.setState({ doc: docA as never })
    expect(store.getPivotConfig({ clock: true }).windowClock).toBeUndefined()
  })

  it('applies by wall-clock time to a trace that starts at another moment', () => {
    const cfg: PivotConfig = { fact: 'calls', by: ['stmt'], sort: 'e', limit: 10, includeIdle: true, window: { fromUs: 10000, toUs: 20000 }, windowClock: { fromWallUs: wall0 + 40_000, toWallUs: wall0 + 50_000 } }
    // B: wall 40 ms is 10 ms after its start = tim 15000
    expect(resolvePivotConfig(tB, cfg, cur).patch.window).toEqual({ startTim: 15000, endTim: 25000 })
    // the offsets alone (an older configuration) keep meaning "from the trace start"
    const { windowClock: _drop, ...old } = cfg
    expect(resolvePivotConfig(tB, old, cur).patch.window).toEqual({ startTim: 15000, endTim: 25000 })
    expect(resolvePivotConfig(tB, { ...cfg, windowClock: { fromWallUs: wall0 + 35_000, toWallUs: wall0 + 45_000 } }, cur).patch.window).toEqual({ startTim: 10000, endTim: 20000 })
  })

  it('cuts to the span, drops a window outside it, and falls back to offsets without timestamps', () => {
    const cfg: PivotConfig = { fact: 'calls', by: ['stmt'], sort: 'e', limit: 10, includeIdle: true, window: { fromUs: 10000, toUs: 20000 }, windowClock: { fromWallUs: wall0 - 5000, toWallUs: wall0 + 5000 } }
    expect(resolvePivotConfig(tA, cfg, cur).patch.window).toEqual({ startTim: 1000, endTim: 6000 })
    const out = resolvePivotConfig(tA, { ...cfg, windowClock: { fromWallUs: wall0 + 90_000, toWallUs: wall0 + 99_000 } }, cur)
    expect(out.patch.window).toBeNull()
    expect(out.dropped).toEqual(['time window (that clock time is outside this trace)'])
    expect(resolvePivotConfig(docB, cfg, cur).patch.window).toEqual({ startTim: 15000, endTim: 25000 })
  })

  it('old library files load unchanged; a malformed clock window is ignored', () => {
    const base = { id: '1', name: 'old', created: 1, updated: 2, config: { fact: 'calls', by: ['stmt'], sort: 'e', limit: 1000, includeIdle: true, window: { fromUs: 1, toUs: 2 } } }
    const oldFile = JSON.stringify({ version: 1, pivots: [base] })
    const r = parseLibraryFile(oldFile)
    expect(r.skipped).toBe(0)
    expect(r.pivots[0].config).toEqual(base.config)
    expect(r.pivots[0].config.windowClock).toBeUndefined()

    const good = { ...base, id: '2', config: { ...base.config, windowClock: { fromWallUs: 1.7e15, toWallUs: 1.7e15 + 5 } } }
    const bad = { ...base, id: '3', config: { ...base.config, windowClock: { fromWallUs: 'x', toWallUs: 3 } } }
    const rev = { ...base, id: '4', config: { ...base.config, windowClock: { fromWallUs: 9, toWallUs: 3 } } }
    const got = parseLibraryFile(JSON.stringify({ version: 1, pivots: [good, bad, rev] })).pivots
    expect(got.map((p) => p.config.windowClock)).toEqual([good.config.windowClock, undefined, undefined])
    expect(got[1].config.window).toEqual({ fromUs: 1, toUs: 2 })
  })

  it('describes a clock window', () => {
    expect(describePivotConfig({ fact: 'calls', by: ['stmt'], sort: 'e', limit: 1, includeIdle: true, window: { fromUs: 0, toUs: 1 }, windowClock: { fromWallUs: 1, toWallUs: 2 } })).toContain('window (clock time)')
  })
})

describe('file selection', () => {
  const fe = (idx: number, name: string) => ({ idx, name })
  const withFiles = <T extends object>(base: T, files: string[], ctxFiles: number[]) =>
    ({ ...base, file: { files: files.map((n, i) => fe(i, n)) }, contexts: ctxFiles.map((f, i) => ({ ...ctx(i, `s${i}`), fileIdx: f })) })
  const setA = withFiles(docA, ['a.trc', 'b.trc', 'c.trc'], [0, 1, 2]) // the set the configuration is saved on
  const setB = withFiles(docB, ['c.trc', 'a.trc', 'z.trc', 'q.trc'], [0, 1, 2, 3]) // another set: the same names in other places
  const cur = createStore().getState().pivot

  it('is saved as file names, only on request and only with a selection', () => {
    const store = createStore()
    store.setState({ doc: setA as never, files: new Set([2, 0]) })
    expect(store.getPivotConfig().files).toBeUndefined()
    const cfg = store.getPivotConfig({ files: true })
    expect(cfg.files).toEqual(['a.trc', 'c.trc'])
    expect(JSON.parse(JSON.stringify(cfg))).toEqual(cfg)
    store.setState({ files: null })
    expect(store.getPivotConfig({ files: true }).files).toBeUndefined()
    // a single-file document has no file list
    store.setState({ doc: docA as never, files: new Set([0]) })
    expect(store.getPivotConfig({ files: true }).files).toBeUndefined()
  })

  it('selects the files of the target that have these names', () => {
    const store = createStore()
    store.setState({ doc: setB as never })
    const { dropped } = store.applyPivotConfig({ fact: 'calls', by: ['stmt'], sort: 'e', limit: 10, includeIdle: true, files: ['a.trc', 'c.trc'] })
    expect([...store.getState().files!].sort()).toEqual([0, 1])
    expect(dropped).toEqual([])
    expect(store.getState().pivot.notice).toBeNull()
  })

  it('reports the names the target does not have, selecting the rest', () => {
    const store = createStore()
    store.setState({ doc: setB as never })
    const r = store.applyPivotConfig({ fact: 'calls', by: ['stmt'], sort: 'e', limit: 10, includeIdle: true, files: ['a.trc', 'gone.trc', 'b.trc'] })
    expect([...store.getState().files!]).toEqual([1])
    expect(r.dropped).toEqual(['2 of 3 files (gone.trc, b.trc)'])
    expect(store.getState().pivot.notice).toMatch(/left out: 2 of 3 files \(gone\.trc, b\.trc\)/)
  })

  it('leaves the selection alone when no file of the configuration exists, or when it has none', () => {
    const store = createStore()
    store.setState({ doc: setB as never, files: new Set([3]) })
    const base: PivotConfig = { fact: 'calls', by: ['stmt'], sort: 'e', limit: 10, includeIdle: true }
    const none = store.applyPivotConfig({ ...base, files: ['gone.trc'] })
    expect([...store.getState().files!]).toEqual([3])
    expect(none.dropped).toEqual(['file selection (gone.trc)'])
    store.applyPivotConfig(base)
    expect([...store.getState().files!]).toEqual([3])
    expect(store.getState().pivot.notice).toBeNull()
  })

  it('every file by name is the whole set (no selection)', () => {
    const store = createStore()
    store.setState({ doc: setB as never, files: new Set([1]) })
    store.applyPivotConfig({ fact: 'calls', by: ['stmt'], sort: 'e', limit: 10, includeIdle: true, files: ['c.trc', 'a.trc', 'z.trc', 'q.trc'] })
    expect(store.getState().files).toBeNull()
  })

  it('keeps the session contexts that the selected files hold', () => {
    // sessions s0/s1 of set A are contexts 0/1 of set B too (files c.trc / a.trc); only a.trc is selected
    const cfg: PivotConfig = { fact: 'calls', by: ['stmt'], sort: 'e', limit: 10, includeIdle: true, files: ['a.trc'], contexts: [{ session: 's0', module: 'SQL*Plus', action: '' }, { session: 's1', module: 'SQL*Plus', action: '' }] }
    const r = resolvePivotConfig(setB, cfg, cur)
    expect([...r.patch.files!]).toEqual([1])
    expect([...r.patch.contexts!]).toEqual([1])
    // without any of them in the selected files the contexts are dropped, with the reason
    const out = resolvePivotConfig(setB, { ...cfg, contexts: [cfg.contexts![0]] }, cur)
    expect(out.patch.contexts).toBeNull()
    expect(out.dropped).toEqual(['session contexts (not in the selected files)'])
    // a configuration without files is checked against the selection that stays
    const stay = resolvePivotConfig(setB, { ...cfg, files: undefined }, cur, new Set([2]))
    expect(stay.patch.contexts).toBeNull()
  })

  it('old library files load unchanged; a malformed file list is ignored; the description counts the files', () => {
    const base = { id: '1', name: 'old', created: 1, updated: 2, config: { fact: 'calls', by: ['stmt'], sort: 'e', limit: 1000, includeIdle: true } }
    const old = parseLibraryFile(JSON.stringify({ version: 1, pivots: [base] }))
    expect(old.pivots[0].config).toEqual(base.config)
    const withFilesCfg = (id: string, files: unknown) => ({ ...base, id, config: { ...base.config, files } })
    const got = parseLibraryFile(JSON.stringify({ version: 1, pivots: [withFilesCfg('2', ['a.trc']), withFilesCfg('3', 'a.trc'), withFilesCfg('4', [1]), withFilesCfg('5', [])] })).pivots
    expect(got.map((p) => p.config.files)).toEqual([['a.trc'], undefined, undefined, undefined])
    expect(describePivotConfig({ ...base.config, files: ['a.trc', 'b.trc'] } as PivotConfig)).toContain('2 files')
  })
})
