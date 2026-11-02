import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
  type Connection, importInto, mergeConnections, newId, parseConnectionsFile, sameEngineDef, serializeConnections,
  toEngineDef, upsert, validateConnection,
} from './model'

const ssh: Connection = { id: 'lab', name: 'Lab', kind: 'ssh', host: 'dbmint', port: 2200, user: 'oracle' }
const db: Connection = { id: 'ora', name: 'Ora', kind: 'db', host: 'dbmint', port: 1521, user: 'mtk', service: 'pdb1.world' }

describe('validateConnection', () => {
  it('normalizes and defaults', () => {
    const { conn, problems } = validateConnection({ id: 'x', kind: 'db', host: ' h ', user: 'u', service: 's' })
    expect(problems).toEqual([])
    expect(conn).toEqual({ id: 'x', name: 'x', kind: 'db', host: 'h', port: 1521, user: 'u', service: 's' })
  })
  it('drops secrets and unknown fields with a warning', () => {
    const { conn, problems } = validateConnection({ ...ssh, password: 'hunter2', colour: 'red' })
    expect(conn).toEqual(ssh)
    expect(problems.join('\n')).toMatch(/"password" ignored/)
    expect(problems.join('\n')).toMatch(/unknown field "colour"/)
    expect(JSON.stringify(conn)).not.toContain('hunter2')
  })
  it('rejects unusable entries', () => {
    expect(validateConnection({ id: 'bad id', kind: 'ssh', host: 'h' }).conn).toBeUndefined()
    expect(validateConnection({ id: 'a', kind: 'ftp', host: 'h' }).conn).toBeUndefined()
    expect(validateConnection({ id: 'a', kind: 'db', host: 'h', user: 'u' }).problems.join()).toMatch(/service is required/)
    expect(validateConnection({ id: 'a', kind: 'ssh', host: 'h', port: 70000 }).conn).toBeUndefined()
    expect(validateConnection(null).problems).toEqual(['connection: not an object'])
  })
  it('keeps tlsSkipVerify only with tcps', () => {
    expect(validateConnection({ ...db, tlsSkipVerify: true }).conn?.tlsSkipVerify).toBeUndefined()
    expect(validateConnection({ ...db, tcps: true, tlsSkipVerify: true }).conn?.tlsSkipVerify).toBe(true)
  })
})

describe('parseConnectionsFile', () => {
  it('round-trips export and import', () => {
    const conns = [ssh, { ...db, adrHome: 'diag/rdbms/cdb1/cdb1', tcps: true, notes: 'n' }, { ...ssh, id: 'lib', transport: 'lib' as const }]
    const text = serializeConnections(conns)
    expect(JSON.parse(text).version).toBe(1)
    const back = parseConnectionsFile(text)
    expect(back.fatal).toBeUndefined()
    expect(back.problems).toEqual([])
    expect(back.connections).toEqual(conns)
  })
  it('reports a broken file without throwing', () => {
    expect(parseConnectionsFile('{"version":1,').fatal).toMatch(/not valid JSON/)
    expect(parseConnectionsFile('{"version":2,"connections":[]}').fatal).toMatch(/unsupported version 2/)
    expect(parseConnectionsFile('{"version":1,"connections":{}}').fatal).toMatch(/must be an array/)
    expect(parseConnectionsFile('"x"').fatal).toBeDefined()
  })
  it('skips bad and duplicate entries and keeps the rest', () => {
    const r = parseConnectionsFile(JSON.stringify({ version: 1, connections: [ssh, { id: 'x' }, { ...db, id: 'lab' }, db] }))
    expect(r.connections.map((c) => c.id)).toEqual(['lab', 'ora'])
    expect(r.problems.some((p) => p.startsWith('connections[1]:'))).toBe(true)
    expect(r.problems).toContain('connections[2]: duplicate id "lab" skipped')
  })
  it('accepts a bare array', () => {
    expect(parseConnectionsFile(JSON.stringify([ssh])).connections).toEqual([ssh])
  })
  it('reads the team fixture', () => {
    const r = parseConnectionsFile(readFileSync(new URL('./__fixtures__/team.json', import.meta.url), 'utf8'))
    expect(r.connections.map((c) => c.id)).toEqual(['lab-db', 'lab-ssh'])
    expect(r.problems.join('\n')).toMatch(/connections\[2\]: service is required/)
  })
})

describe('mergeConnections', () => {
  it('marks team entries and local overrides', () => {
    const team = [{ ...ssh, id: 't1', name: 'B team' }, { ...db, id: 'shared', name: 'C shared' }]
    const local = [{ ...ssh, name: 'A local' }, { ...db, id: 'shared', name: 'C mine', user: 'me' }]
    const m = mergeConnections(local, team)
    expect(m.map((e) => [e.id, e.source])).toEqual([
      ['lab', 'local'],
      ['t1', 'team'],
      ['shared', 'override'],
    ])
    expect(m.find((e) => e.id === 'shared')?.user).toBe('me')
  })
})

describe('local edits', () => {
  it('importInto replaces by id', () => {
    const r = importInto([ssh, db], [{ ...db, user: 'x' }, { ...ssh, id: 'new' }])
    expect(r).toMatchObject({ added: 1, replaced: 1 })
    expect(r.local.find((c) => c.id === 'ora')?.user).toBe('x')
  })
  it('upsert keeps the position and follows a rename', () => {
    expect(upsert([ssh, db], { ...ssh, id: 'lab2' }, 'lab').map((c) => c.id)).toEqual(['lab2', 'ora'])
    expect(upsert([ssh], db).map((c) => c.id)).toEqual(['lab', 'ora'])
  })
  it('newId slugs and dedupes', () => {
    expect(newId('Prod DB #1', [])).toBe('prod-db-1')
    expect(newId('Lab', ['lab', 'lab-2'])).toBe('lab-3')
    expect(newId('!!!', [])).toBe('conn')
  })
})

describe('toEngineDef', () => {
  it('sends no name, notes or foreign fields', () => {
    expect(toEngineDef({ ...ssh, notes: 'n' })).toEqual({ id: 'lab', kind: 'ssh', host: 'dbmint', port: 2200, user: 'oracle', transport: 'auto' })
    expect(toEngineDef({ ...db, tcps: true, tlsSkipVerify: true })).toEqual({
      id: 'ora', kind: 'db', host: 'dbmint', port: 1521, user: 'mtk', service: 'pdb1.world', tcps: true, tlsSkipVerify: true,
    })
    expect(sameEngineDef(ssh, { ...ssh, name: 'other', notes: 'x' })).toBe(true)
    expect(sameEngineDef(ssh, { ...ssh, port: 22 })).toBe(false)
  })
})

describe('infoToDef', () => {
  it('matches toEngineDef for what the engine echoes back', async () => {
    const { infoToDef } = await import('./model')
    expect(JSON.stringify(infoToDef({ ...toEngineDef(ssh), port: 2200, user: 'oracle', transport: 'auto', active: 'cli' }))).toBe(JSON.stringify(toEngineDef(ssh)))
    expect(JSON.stringify(infoToDef({ ...toEngineDef(db), port: 1521, user: 'mtk', transport: '', active: '' }))).toBe(JSON.stringify(toEngineDef(db)))
  })
})
