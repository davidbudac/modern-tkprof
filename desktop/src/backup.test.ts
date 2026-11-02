import { describe, expect, it } from 'vitest'
import { libraryFile, parseLibraryFile, type SavedPivot } from '@lib/data/pivotconfig'
import { describeMerge, mergeBackup, parseBackup, serializeBackup } from './backup'
import type { Connection } from './connections/model'
import { defaults, type Settings } from './settings/settings'

const ssh: Connection = { id: 'lab', name: 'Lab', kind: 'ssh', host: 'dbmint', port: 2200, user: 'oracle' }
const db: Connection = { id: 'ora', name: 'Ora', kind: 'db', host: 'dbmint', port: 1521, user: 'mtk', service: 'pdb1.world' }
const pivot = (id: string, name: string, updated: number): SavedPivot => ({
  id, name, created: 1, updated,
  config: { fact: 'calls', by: ['sql'], sort: 'elapsed', limit: 1000, includeIdle: true } as SavedPivot['config'],
})

describe('serializeBackup / parseBackup', () => {
  it('keeps a saved pivot\'s clock-time window (windowClock) through the backup and the lib\'s version 1 library file', () => {
    const clock = { fromWallUs: 1_700_000_000_000_000, toWallUs: 1_700_000_060_000_000 }
    const p = pivot('p1', 'Clock', 5)
    p.config = { ...p.config, window: { fromUs: 10, toUs: 20 }, windowClock: clock }
    expect(parseBackup(serializeBackup([], [p])).library[0].config.windowClock).toEqual(clock)
    const file = parseLibraryFile(JSON.stringify(libraryFile([p])))
    expect(file.pivots[0].config.windowClock).toEqual(clock)
    // library.json holds the list as is (kv.set / kv.get): JSON round trip
    expect(JSON.parse(JSON.stringify([p]))[0].config.windowClock).toEqual(clock)
    // a malformed window is dropped, the rest of the entry is kept
    const bad = { ...p, config: { ...p.config, windowClock: { fromWallUs: 5, toWallUs: 1 } } }
    expect(parseLibraryFile(JSON.stringify(libraryFile([bad]))).pivots[0].config.windowClock).toBeUndefined()
  })

  it('round-trips connections and library', () => {
    const text = serializeBackup([ssh, db], [pivot('p1', 'Slow', 5)])
    const o = JSON.parse(text)
    expect(o['mtkprof-desktop']).toBe(1)
    const b = parseBackup(text)
    expect(b.fatal).toBeUndefined()
    expect(b.connections).toEqual([ssh, db])
    expect(b.library.map((p) => [p.id, p.name, p.updated])).toEqual([['p1', 'Slow', 5]])
    expect(b.problems).toEqual([])
    expect(b.skipped).toBe(0)
  })

  it('never writes a secret, and drops one found in a file', () => {
    const text = serializeBackup([{ ...ssh, password: 'hunter2' } as Connection], [])
    expect(text).not.toMatch(/hunter2|password/)
    const b = parseBackup(JSON.stringify({ 'mtkprof-desktop': 1, connections: [{ ...ssh, password: 'hunter2', passphrase: 'x' }] }))
    expect(JSON.stringify(b.connections)).not.toMatch(/hunter2|passphrase/)
    expect(b.problems.join('\n')).toMatch(/"password" ignored/)
    expect(text).toContain('"id": "lab"')
  })

  it('accepts a file with one part only', () => {
    const b = parseBackup(JSON.stringify({ 'mtkprof-desktop': 1, library: [pivot('p1', 'A', 1)] }))
    expect(b.connections).toEqual([])
    expect(b.library).toHaveLength(1)
    const c = parseBackup(JSON.stringify({ 'mtkprof-desktop': 1, connections: [ssh] }))
    expect(c.connections).toEqual([ssh])
    expect(c.library).toEqual([])
  })

  it('counts unusable entries', () => {
    const b = parseBackup(JSON.stringify({ 'mtkprof-desktop': 1, connections: [ssh, { id: 'bad id!' }, 7], library: [pivot('p1', 'A', 1), { id: 'x' }] }))
    expect(b.connections).toEqual([ssh])
    expect(b.problems.length).toBeGreaterThan(0)
    expect(b.skipped).toBe(1)
  })

  it.each([
    ['not json', /not valid JSON/],
    ['[]', /expected/],
    ['{"connections":[]}', /not an mtkprof-desktop backup/],
    ['{"mtkprof-desktop":3}', /unsupported backup version 3/],
    ['{"mtkprof-desktop":1,"connections":{}}', /"connections" must be an array/],
    ['{"mtkprof-desktop":1,"library":"x"}', /"library" must be an array/],
  ])('rejects %s', (text, why) => {
    const b = parseBackup(text)
    expect(b.fatal).toMatch(why)
    expect(b.connections).toEqual([])
    expect(b.library).toEqual([])
  })
})

describe('mergeBackup', () => {
  const incoming = { connections: [{ ...ssh, host: 'new' }, db], library: [pivot('p1', 'Old name', 1), pivot('p2', 'Newer', 20), pivot('p3', 'Fresh', 3)] }
  const m = mergeBackup([ssh], [pivot('p1', 'Mine', 9), pivot('p2', 'Older', 10)], incoming)

  it('replaces connections by id and adds the others', () => {
    expect(m.connections.map((c) => [c.id, c.host])).toEqual([['lab', 'new'], ['ora', 'dbmint']])
  })
  it('keeps the newer saved pivot per id', () => {
    expect(m.library.map((p) => p.name)).toEqual(['Fresh', 'Mine', 'Newer'])
  })
  it('counts', () => {
    expect(m.counts).toEqual({ connAdded: 1, connReplaced: 1, libAdded: 1, libReplaced: 1, libKept: 1 })
    expect(describeMerge(m.counts, { problems: ['x'], skipped: 1 })).toBe(
      'Imported connections: 1 new, 1 replaced; library: 1 new, 1 replaced, 1 kept (the local one is newer); 2 problems in the file (skipped or ignored).',
    )
  })
  it('importing into an empty app adds everything; importing twice changes nothing', () => {
    const once = mergeBackup([], [], incoming)
    expect(once.counts).toMatchObject({ connAdded: 2, connReplaced: 0, libAdded: 3, libReplaced: 0 })
    const twice = mergeBackup(once.connections, once.library, incoming)
    expect(twice.library).toEqual(once.library)
    expect(twice.counts).toMatchObject({ connAdded: 0, connReplaced: 2, libAdded: 0, libReplaced: 0, libKept: 3 })
  })
})


describe('optional investigation backups', () => {
  it('preserves legacy exports and migrates version 2 without unsafe fields', () => {
    expect(JSON.parse(serializeBackup([], []))['mtkprof-desktop']).toBe(1)
    const b = parseBackup(serializeBackup([], [], {
      annotations: { trace: { notes: [{ id: 'n', kind: 'window', note: 'review', created: 1, updated: 2, from: 1, to: 3, password: 'secret' }], bookmarks: [{ file: 0, line: 2, label: 'here' }] } },
      settings: { theme: 'dark', salt: 'secret', planVizUrl: 'https://private' },
      workspace: [{ paths: ['/local/a.trc'], options: { follow: true, salt: 'secret' }, action: 'open' }],
    } as unknown as Parameters<typeof serializeBackup>[2]))
    expect(b.fatal).toBeUndefined()
    expect(b.investigation?.settings).toEqual({ theme: 'dark' })
    expect(b.investigation?.workspace).toEqual([{ paths: ['/local/a.trc'] }])
    expect(b.investigation?.annotations?.trace.bookmarks).toEqual([{ file: 0, line: 2, label: 'here' }])
    expect(JSON.stringify(b)).not.toMatch(/secret|password|follow|private/)
  })
  it.each([
    { annotations: { trace: { notes: [{}] } } },
    { annotations: { trace: { bookmarks: [{ file: -1, line: 2, label: 'x' }] } } },
    { settings: { theme: 'unknown' } },
    { workspace: [{ paths: [7] }] },
  ])('rejects invalid optional metadata before merging', (investigation) => {
    expect(parseBackup(JSON.stringify({ 'mtkprof-desktop': 2, investigation })).fatal).toBeTruthy()
  })
})

describe('assistant providers', () => {
  it('never reach a backup: no base URL, header or key, even when the settings carry them', () => {
    const settings: Settings = {
      ...defaults,
      theme: 'dark',
      assistProviders: [
        { id: 'p1', kind: 'openai', name: 'Lab', auth: 'bearer', baseUrl: 'https://llm.internal.example/v1', model: 'm', headers: { 'X-Team': 'dba-only' } },
      ],
    }
    const withKey = { ...settings, assistProviders: [{ ...settings.assistProviders[0], apiKey: 'sk-live-123' }] }
    for (const investigation of [undefined, { settings: withKey }] as unknown as Parameters<typeof serializeBackup>[2][]) {
      const text = serializeBackup([ssh], [], investigation)
      expect(text).not.toMatch(/llm\.internal|dba-only|sk-live|X-Team|assistProviders|p1/)
    }
    expect(parseBackup(serializeBackup([], [], { settings: withKey } as unknown as Parameters<typeof serializeBackup>[2])).investigation?.settings).toEqual({ theme: 'dark', binds: 'keep', startEmpty: false })
  })
})
