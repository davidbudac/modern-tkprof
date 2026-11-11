import { describe, expect, it } from 'vitest'
import type { ListedFile, TracePeek } from '../engine'
import { kindLabel, dumpsLabel, type PeekOpt } from './optTabs'
import { type Peek, DEFAULT_SORT, filterRows, fmtEnd, fmtSpan, fmtStamp, notSQL, peekBatches, selectionSummary, sessionsText, sortRows, toRows } from './folderPick'

const file = (name: string, size: number, modified: string): ListedFile => ({ path: `/t/${name}`, size, modified, dir: '/t' })
const peek = (name: string, p: Partial<TracePeek> & PeekOpt): Peek => ({ path: `/t/${name}`, size: 0, modified: '', elapsedUs: 0, sqlTrace: true, sessions: [], sessionCount: 0, ...p })

const files = [file('a.trc', 100, '2026-11-08T10:00:00Z'), file('b.trc', 5000, '2026-11-08T12:00:00Z'), file('c.trc', 10, '2026-11-08T11:00:00Z'), file('mmon.trc', 1, '2026-11-08T13:00:00Z')]
const peeks = new Map([
  ['/t/a.trc', peek('a.trc', { start: '2026-11-08T09:00:00+01:00', end: '2026-11-08T09:30:00+01:00', elapsedUs: 1800e6, sessions: [{ id: '51.1', module: 'SQL*Plus' }], sessionCount: 1 })],
  ['/t/b.trc', peek('b.trc', { start: '2026-11-08T11:00:00+01:00', end: '2026-11-09T01:00:00+01:00', elapsedUs: 14 * 3600e6, sessions: [{ id: '60.2', service: 'pdb1' }, { id: '61.9' }], sessionCount: 2 })],
  ['/t/mmon.trc', peek('mmon.trc', { sqlTrace: false })],
])
const rows = toRows(files, peeks)
const names = (rs: { name: string }[]) => rs.map((r) => r.name)

describe('folder picker rows', () => {
  it('sorts newest first by traced start, a file not read yet by its own time', () => {
    expect(names(sortRows(rows, DEFAULT_SORT))).toEqual(['mmon.trc', 'c.trc', 'b.trc', 'a.trc'])
    expect(names(sortRows(rows, { key: 'size', dir: -1 }))).toEqual(['b.trc', 'a.trc', 'c.trc', 'mmon.trc'])
    expect(names(sortRows(rows, { key: 'sessions', dir: -1 })).slice(0, 2)).toEqual(['b.trc', 'a.trc'])
  })

  it('filters by name, session and its attributes, and hides what has no SQL trace', () => {
    expect(names(filterRows(rows, '', true))).toEqual(['a.trc', 'b.trc', 'c.trc'])
    expect(notSQL(rows)).toBe(1)
    expect(names(filterRows(rows, 'pdb1', false))).toEqual(['b.trc'])
    expect(names(filterRows(rows, 'sql*plus 51.1', false))).toEqual(['a.trc'])
    expect(names(filterRows(rows, 'mmon', false))).toEqual(['mmon.trc'])
  })

  it('peeks small files together and a big one alone', () => {
    expect(peekBatches([file('x', 10, ''), file('y', 10, ''), file('big', 500, ''), file('z', 10, '')], 16, 100)).toEqual([['/t/x', '/t/y'], ['/t/big'], ['/t/z']])
    expect(peekBatches([file('x', 1, ''), file('y', 1, ''), file('z', 1, '')], 2)).toEqual([['/t/x', '/t/y'], ['/t/z']])
  })

  it('formats the traced time in the trace zone', () => {
    expect(fmtStamp('2026-11-08T09:00:00.123456+01:00')).toBe('2026-11-08 09:00:00')
    expect(fmtEnd('2026-11-08T09:00:00+01:00', '2026-11-08T09:30:00+01:00')).toBe('09:30:00')
    expect(fmtEnd('2026-11-08T09:00:00+01:00', '2026-11-09T01:00:00+01:00')).toBe('2026-11-09 01:00:00')
    expect([0.84e6, 6.46e6, 42e6, 937e6, 3 * 3600e6 + 300e6, 47 * 86400e6 + 6 * 3600e6].map(fmtSpan)).toEqual(['0.84 s', '6.5 s', '42 s', '15 min 37 s', '3 h 5 min', '47 d 6 h'])
    expect(fmtSpan(0)).toBe('–')
  })

  it('says which sessions a file has and what a selection adds up to', () => {
    expect(sessionsText(peeks.get('/t/a.trc')!)).toBe('51.1 SQL*Plus')
    expect(sessionsText(peeks.get('/t/b.trc')!)).toBe('2 sessions: 60.2, 61.9')
    expect(sessionsText(peeks.get('/t/mmon.trc')!)).toBe('–')
    expect(selectionSummary(rows.slice(0, 3))).toEqual({ files: 3, bytes: 5110, start: '2026-11-08T09:00:00+01:00', end: '2026-11-09T01:00:00+01:00' })
  })
})

describe('folder picker: 10053 files', () => {
  const opt = ['/t/p.trc', '/t/q.trc', '/t/r.trc']
  const fs = [...files, ...opt.map((p) => file(p.slice(3), 10, '2026-11-08T08:00:00Z'))]
  const withOpt = toRows(fs, new Map([...peeks, ['/t/p.trc', peek('p.trc', { sqlTrace: false, kind: '10053', optDumps: 3 })], ['/t/q.trc', peek('q.trc', { kind: 'both', optDumps: 2 })], ['/t/r.trc', peek('r.trc', { kind: '10046' })]]))

  it('shows each file\'s kind and its dumps, nothing for a plain 10046 trace', () => {
    const label = (name: string) => { const r = withOpt.find((x) => x.name === name)!; return [kindLabel(r.peek), dumpsLabel(r.peek)] }
    expect(label('p.trc')).toEqual(['10053', '3 dumps'])
    expect(label('q.trc')).toEqual(['10046 + 10053', '2 dumps'])
    expect(label('r.trc')).toEqual(['', ''])
    expect(label('a.trc')).toEqual(['', ''])
  })

  it('does not hide an optimizer trace as "no SQL trace" (it has no tim= to be a SQL trace), but still the background trace', () => {
    expect(names(filterRows(withOpt, '', true))).toContain('p.trc')
    expect(names(filterRows(withOpt, '', true))).not.toContain('mmon.trc')
    expect(notSQL(withOpt)).toBe(1)
  })

  it('finds files by their kind', () => {
    expect(names(filterRows(withOpt, '10053', false)).sort()).toEqual(['p.trc', 'q.trc'])
  })
})
