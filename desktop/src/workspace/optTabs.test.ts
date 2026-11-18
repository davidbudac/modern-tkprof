import { describe, expect, it } from 'vitest'
import { diagDumpNote, dumpIndexOf, dumpTabs, dumpsLabel, fileKindOf, hasOwnTab, isDumpFile, isFollowRefusal, isOptFile, kindBadge, kindLabel, kindTitle, leftOutFile, optDumpNote, optionsFor, pathNamed, pickJumpTab, splitByKind, sqlIdsOf, statementTabs, tabKindForFile, tabKindOf, tabKindOfView, type PeekOpt } from './optTabs'

describe('the kind of a file', () => {
  it('reads what the engine peek says, the interleaved kind under both of its spellings', () => {
    expect(fileKindOf({ kind: '10046' })).toBe('10046')
    expect(fileKindOf({ kind: '10053', optDumps: 2 })).toBe('10053')
    expect(fileKindOf({ kind: 'both', optDumps: 2 })).toBe('both')
    expect(fileKindOf({ kind: '10046+10053' })).toBe('both')
    expect(fileKindOf({})).toBe('')
    expect(fileKindOf(null)).toBe('')
    expect(fileKindOf({ optDumps: 3 })).toBe('both') // dumps and nothing said about the kind: not a pure optimizer file
    expect(isOptFile({ kind: '10053' })).toBe(true)
    expect(isOptFile({ kind: 'both' })).toBe(false)
  })

  it('labels the kinds for the folder picker: 10053, 10046 + 10053, nothing for a plain trace; and the number of dumps', () => {
    expect(kindLabel({ kind: '10053' })).toBe('10053')
    expect(kindLabel({ kind: 'both' })).toBe('10046 + 10053')
    expect(kindLabel({ kind: '10046' })).toBe('')
    expect(kindLabel(undefined)).toBe('')
    expect(dumpsLabel({ optDumps: 1 })).toBe('1 dump')
    expect(dumpsLabel({ optDumps: 12 })).toBe('12 dumps')
    expect(dumpsLabel({ kind: '10046' })).toBe('')
    expect(kindTitle({ kind: '10053' })).toMatch(/tab of its own/)
    expect(kindTitle({ kind: 'both' })).toMatch(/opens as a 10046 trace/)
    expect(kindTitle({ kind: '10046' })).toBe('')
  })
})

describe('splitting a request for several files', () => {
  const peeks: Record<string, PeekOpt> = { '/t/a.trc': { kind: '10046' }, '/t/b.trc': { kind: '10053', optDumps: 2 }, '/t/c.trc': { kind: 'both', optDumps: 1 }, '/t/d.trc': { kind: '10053' } }
  const peekOf = (p: string) => peeks[p]

  it('keeps the 10046 files (an interleaved one among them) as the set and takes each 10053 file out, in order', () => {
    expect(splitByKind(['/t/a.trc', '/t/b.trc', '/t/c.trc', '/t/d.trc'], peekOf)).toEqual({ set: ['/t/a.trc', '/t/c.trc'], opt: ['/t/b.trc', '/t/d.trc'], dump: [] })
  })
  it('treats a file that was not peeked as a 10046 file', () => {
    expect(splitByKind(['/t/x.trc', '/t/b.trc'], peekOf)).toEqual({ set: ['/t/x.trc'], opt: ['/t/b.trc'], dump: [] })
  })
  it('gives an empty set for 10053 files only, and nothing for nothing', () => {
    expect(splitByKind(['/t/b.trc', '/t/d.trc'], peekOf)).toEqual({ set: [], opt: ['/t/b.trc', '/t/d.trc'], dump: [] })
    expect(splitByKind([], peekOf)).toEqual({ set: [], opt: [], dump: [] })
  })
  it('takes each file of diagnostic dumps out as a tab of its own too, in order', () => {
    const p2: Record<string, PeekOpt> = { ...peeks, '/t/h.trc': { kind: 'diag', sections: [{ kind: 'heap', count: 3 }] }, '/t/e.trc': { kind: 'diag' } }
    expect(splitByKind(['/t/h.trc', '/t/a.trc', '/t/b.trc', '/t/e.trc'], (p) => p2[p])).toEqual({ set: ['/t/a.trc'], opt: ['/t/b.trc'], dump: ['/t/h.trc', '/t/e.trc'] })
  })
})

describe('files of diagnostic dumps', () => {
  const heaps: PeekOpt = { kind: 'diag', sections: [{ kind: 'heap', count: 3 }, { kind: 'procstate', count: 1 }] }

  it('reads the peek\'s diag kind: a tab of its own, never a member of a set', () => {
    expect(fileKindOf(heaps)).toBe('diag')
    expect(isDumpFile(heaps)).toBe(true)
    expect(isDumpFile({ kind: '10053' })).toBe(false)
    expect(hasOwnTab(heaps) && hasOwnTab({ kind: '10053' })).toBe(true)
    expect(hasOwnTab({ kind: 'both' }) || hasOwnTab({ kind: '10046' }) || hasOwnTab(null)).toBe(false)
    expect(isOptFile(heaps)).toBe(false)
  })

  it('tags it "dump" with its sections by kind, in the words of the dump reader', () => {
    expect(kindLabel(heaps)).toBe('dump')
    expect(dumpsLabel(heaps)).toBe('3 heap dumps, 1 process state')
    expect(dumpsLabel({ kind: 'diag', sections: [{ kind: 'diagdump', count: 1 }, { kind: 'hang', count: 2 }, { kind: 'pga-summary', count: 1 }] })).toBe('1 errorstack, 2 hang analyses, 1 PGA summary')
    expect(dumpsLabel({ kind: 'diag' })).toBe('')
    expect(kindTitle(heaps)).toMatch(/dump reader.*tab of its own/)
    expect(kindTitle({ kind: 'both' })).toMatch(/open it as 10053/)
  })

  it('opens without follow, as a 10053 file does', () => {
    expect(optionsFor({ binds: 'keep' as const, follow: true }, 1, 'diag')).toEqual({ binds: 'keep', follow: undefined })
  })

  it('maps files, stored kinds and session views to the kind of a tab and its badge', () => {
    expect(tabKindForFile('diag')).toBe('dump')
    expect(tabKindForFile('10053')).toBe('10053')
    expect(tabKindForFile('both') ?? tabKindForFile('10046') ?? tabKindForFile('')).toBeUndefined()
    expect(tabKindOf('dump')).toBe('dump')
    expect(tabKindOf('10053')).toBe('10053')
    expect(tabKindOf('x') ?? tabKindOf(undefined)).toBeUndefined()
    expect(tabKindOfView('diag')).toBe('dump')
    expect(tabKindOfView('10053')).toBe('10053')
    expect(tabKindOfView('10046') ?? tabKindOfView(undefined)).toBeUndefined()
    expect(kindBadge('dump')).toMatchObject({ text: 'dump' })
    expect(kindBadge('10053')).toMatchObject({ text: '10053' })
    expect(kindBadge(undefined)).toBeNull()
  })
})

describe('the notes of a trace that holds dumps', () => {
  it('knows the note of diagnostic dumps, of one file and of a file of a set, and not an optimizer-dump note', () => {
    expect(diagDumpNote('1 diagnostic dump in this file, lines 114-29753')).toBe('')
    expect(diagDumpNote('3 heap dumps in this file, lines 32-923, 924-1034 and 1035-1486')).toBe('')
    expect(diagDumpNote('5 diagnostic dumps (2 heap dumps, 1 process state and 2 hang analyses), lines 1-9 and 10-20')).toBe('')
    expect(diagDumpNote('x.trc has 1 deadlock graph, lines 33-90')).toBe('x.trc')
    expect(diagDumpNote('x y.trc has 2 PGA memory summaries, lines 1-5 and 7-9')).toBe('x y.trc')
    expect(diagDumpNote('2 optimizer (10053) dumps in this file, lines 54-18358 and 18734-27979; not shown as 10053 yet')).toBeNull()
    expect(diagDumpNote('opt_two.trc is a 10053 file; open it on its own')).toBeNull()
    expect(diagDumpNote('cut by max_dump_file_size')).toBeNull()
  })

  it('knows the note of optimizer dumps in a 10046 trace', () => {
    expect(optDumpNote('2 optimizer (10053) dumps in this file, lines 54-18358 and 18734-27979; not shown as 10053 yet')).toBe('')
    expect(optDumpNote('1 optimizer (10053) dump in this file, lines 5-9')).toBe('')
    expect(optDumpNote('y.trc has 2 optimizer (10053) dumps, lines 1-5 and 7-9')).toBe('y.trc')
    expect(optDumpNote('1 diagnostic dump in this file, lines 114-29753')).toBeNull()
  })

  it('reads the engine\'s note of a diagnostic file left out of a set as a left-out file', () => {
    expect(leftOutFile('x.trc holds diagnostic dumps only; open it on its own')).toBe('x.trc')
    expect(leftOutFile('opt_two.trc is a 10053 file; open it on its own')).toBe('opt_two.trc')
  })
})

describe('the jump between a 10046 tab and a 10053 dump', () => {
  const t = (key: string, o: object = {}) => ({ key, origin: 'paths', ...o })
  const tabs = [t('a'), t('b', { kind: '10053', optSqlIds: ['s1', 's2'] }), t('c', { kind: '10053', optSqlIds: ['s2'] }), t('d'), t('cmp', { origin: 'comparison' })]

  it('finds the other 10053 tabs that have a dump of the sql_id', () => {
    expect(dumpTabs(tabs, 's2', 'a').map((x) => x.key)).toEqual(['b', 'c'])
    expect(dumpTabs(tabs, 's1', 'a').map((x) => x.key)).toEqual(['b'])
    expect(dumpTabs(tabs, 's1', 'b')).toEqual([])
    expect(dumpTabs(tabs, 'nope', 'a')).toEqual([])
    expect(dumpTabs(tabs, '', 'a')).toEqual([])
  })

  it('finds the other open 10046 tabs that have the statement, never a 10053 or a comparison tab', () => {
    const has = (x: { key: string }, id: string) => (x.key === 'a' || x.key === 'd' || x.key === 'b' || x.key === 'cmp') && id === 'q1'
    expect(statementTabs(tabs, 'q1', 'b', has).map((x) => x.key)).toEqual(['a', 'd'])
    expect(statementTabs(tabs, 'q1', 'a', has).map((x) => x.key)).toEqual(['d'])
    expect(statementTabs(tabs, 'q2', 'b', has)).toEqual([])
  })

  it('takes the most recently used candidate, the later tab on a tie, nothing when there is none', () => {
    const c = [t('a'), t('b'), t('c')]
    expect(pickJumpTab(c, new Map([['a', 5], ['b', 9], ['c', 7]]))?.key).toBe('b')
    expect(pickJumpTab(c, new Map([['a', 5]]))?.key).toBe('a')
    expect(pickJumpTab(c, new Map())?.key).toBe('c')
    expect(pickJumpTab([], new Map())).toBeUndefined()
  })

  it('finds the first dump of a sql_id and the distinct sql_ids of a file', () => {
    const dumps = [{ idx: 0, sqlId: 'x' }, { idx: 1, sqlId: 'y' }, { idx: 2, sqlId: 'x' }, { idx: 3, sqlId: '' }]
    expect(dumpIndexOf(dumps, 'x')).toBe(0)
    expect(dumpIndexOf(dumps, 'y')).toBe(1)
    expect(dumpIndexOf(dumps, 'z')).toBe(-1)
    expect(sqlIdsOf(dumps)).toEqual(['x', 'y'])
  })
})

describe('the note of a file that was left out of a set', () => {
  it('reads the file name out of the engine note, and nothing out of other notes', () => {
    expect(leftOutFile('opt_two.trc is a 10053 file; open it on its own')).toBe('opt_two.trc')
    expect(leftOutFile('2 optimizer (10053) dumps in this file, lines 54-18358 and 18734-27979; not shown as 10053 yet')).toBeNull()
    expect(leftOutFile('cut by max_dump_file_size')).toBeNull()
  })
  it('finds the requested path with that name', () => {
    expect(pathNamed(['/t/a.trc', '/t/opt_two.trc'], 'opt_two.trc')).toBe('/t/opt_two.trc')
    expect(pathNamed(['C:\\t\\opt_two.trc'], 'opt_two.trc')).toBe('C:\\t\\opt_two.trc')
    expect(pathNamed(['/t'], 'opt_two.trc')).toBeNull()
  })
})

describe('the options a file is opened with', () => {
  const follow = { binds: 'keep' as const, follow: true }
  it('keeps follow for one 10046 file and drops it for a set of several and for a 10053 file (the folder picker\'s "Open each in a tab" and the split)', () => {
    expect(optionsFor(follow, 1, '10046')).toBe(follow)
    expect(optionsFor(follow, 1, '')).toBe(follow)
    expect(optionsFor(follow, 1, 'both')).toBe(follow)
    expect(optionsFor(follow, 3, '10046')).toEqual({ binds: 'keep', follow: undefined })
    expect(optionsFor(follow, 1, '10053')).toEqual({ binds: 'keep', follow: undefined })
    const none = { binds: 'redact' as const, salt: 'x', follow: false }
    expect(optionsFor(none, 1, '10053')).toBe(none)
  })
  it('reads the engine\'s refusal to follow a 10053 file', () => {
    expect(isFollowRefusal('POST /engine/sessions: bad_request: follow: o.trc is a 10053 file (optimizer trace); it cannot be followed live: open it without follow')).toBe(true)
    expect(isFollowRefusal('POST /engine/sessions: bad_request: follow: want one file')).toBe(false)
  })
})
