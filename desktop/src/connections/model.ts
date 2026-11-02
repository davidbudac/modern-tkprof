import type { Schemas } from '../engine'

/**
 * Connection definitions as the app keeps them (store, import/export file, team file): what
 * the engine needs (`ConnectionDef`) plus a display name and notes. Never a secret: passwords,
 * passphrases and one-time codes are asked through engine prompts on use and live only in the
 * engine's memory.
 */
export type ConnKind = 'ssh' | 'db'
export type Transport = 'auto' | 'cli' | 'lib'

export interface Connection {
  id: string
  name: string
  kind: ConnKind
  host: string
  /** ssh: 0 = ~/.ssh/config or 22; db: the listener port (1521, TCPS usually 2484) */
  port: number
  /** ssh: empty = ~/.ssh/config or the local user */
  user: string
  /** db: the service name */
  service?: string
  /** db: the default ADR home of a fetch */
  adrHome?: string
  /** ssh only */
  transport?: Transport
  /** db only */
  tcps?: boolean
  /** db only, with tcps */
  tlsSkipVerify?: boolean
  notes?: string
}

/** `mtkprof-connections.json`, the import/export and team file. */
export const FILE_VERSION = 1
export const FILE_NAME = 'mtkprof-connections.json'
export interface ConnectionsFile {
  version: typeof FILE_VERSION
  connections: Connection[]
}

export const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const SECRET_KEYS = ['password', 'passphrase', 'secret', 'pwd', 'pass']
const KNOWN_KEYS = new Set([
  'id', 'name', 'kind', 'host', 'port', 'user', 'service', 'adrHome', 'transport', 'tcps', 'tlsSkipVerify', 'notes',
])

const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '')

/**
 * Checks one definition. Answers the normalized connection (or none when it is unusable) and
 * the problems found; unknown fields are dropped, a secret field is dropped with a warning.
 */
export function validateConnection(raw: unknown, where = 'connection'): { conn?: Connection; problems: string[] } {
  const problems: string[] = []
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: [`${where}: not an object`] }
  const r = raw as Record<string, unknown>
  for (const k of Object.keys(r)) {
    if (SECRET_KEYS.includes(k.toLowerCase())) problems.push(`${where}: "${k}" ignored (secrets are never stored; they are asked on use)`)
    else if (!KNOWN_KEYS.has(k)) problems.push(`${where}: unknown field "${k}" ignored`)
  }
  const id = str(r.id)
  const kind = r.kind
  const host = str(r.host)
  const bad: string[] = []
  if (!ID_RE.test(id)) bad.push(`id ${JSON.stringify(r.id ?? '')} must be 1-64 of A-Z a-z 0-9 . _ - (starting with a letter or digit)`)
  if (kind !== 'ssh' && kind !== 'db') bad.push(`kind must be "ssh" or "db"`)
  if (!host) bad.push('host is required')
  let port = 0
  if (r.port !== undefined && r.port !== null && r.port !== '') {
    const p = typeof r.port === 'string' ? Number(r.port) : r.port
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 0 || p > 65535) bad.push('port must be 0-65535')
    else port = p
  }
  const user = str(r.user)
  const service = str(r.service)
  if (kind === 'db') {
    if (!service) bad.push('service is required for a db connection')
    if (!user) bad.push('user is required for a db connection')
  }
  let transport: Transport | undefined
  if (r.transport !== undefined && r.transport !== '') {
    if (r.transport === 'auto' || r.transport === 'cli' || r.transport === 'lib') transport = r.transport
    else bad.push('transport must be auto, cli or lib')
  }
  if (bad.length) return { problems: [...problems, ...bad.map((b) => `${where}: ${b}`)] }

  const c: Connection = { id, name: str(r.name) || id, kind: kind as ConnKind, host, port, user }
  if (kind === 'db') {
    if (!port) c.port = 1521
    c.service = service
    if (str(r.adrHome)) c.adrHome = str(r.adrHome)
    if (r.tcps === true) c.tcps = true
    if (r.tlsSkipVerify === true) {
      if (c.tcps) c.tlsSkipVerify = true
      else problems.push(`${where}: tlsSkipVerify ignored without tcps`)
    }
    if (transport) problems.push(`${where}: transport ignored for a db connection`)
  } else {
    if (transport && transport !== 'auto') c.transport = transport
    if (r.tcps || r.tlsSkipVerify) problems.push(`${where}: tcps/tlsSkipVerify ignored for an ssh connection`)
  }
  if (str(r.notes)) c.notes = String(r.notes)
  return { conn: c, problems }
}

export interface ParseResult {
  connections: Connection[]
  /** entries skipped or fields dropped, one line each */
  problems: string[]
  /** the file as a whole is unusable (not JSON, wrong version): no connections */
  fatal?: string
}

/** Parses an import/export or team file: `{version: 1, connections: [...]}` (a bare array is accepted too). */
export function parseConnectionsFile(text: string): ParseResult {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch (e) {
    return { connections: [], problems: [], fatal: `not valid JSON: ${(e as Error).message}` }
  }
  let list: unknown
  if (Array.isArray(data)) list = data
  else if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>
    if (d.version !== FILE_VERSION)
      return { connections: [], problems: [], fatal: `unsupported version ${JSON.stringify(d.version)} (this app reads version ${FILE_VERSION})` }
    list = d.connections
    if (!Array.isArray(list)) return { connections: [], problems: [], fatal: '"connections" must be an array' }
  } else return { connections: [], problems: [], fatal: 'expected {"version": 1, "connections": [...]}' }

  const out: Connection[] = []
  const problems: string[] = []
  const seen = new Set<string>()
  ;(list as unknown[]).forEach((raw, i) => {
    const where = `connections[${i}]`
    const { conn, problems: p } = validateConnection(raw, where)
    problems.push(...p)
    if (!conn) return
    if (seen.has(conn.id)) {
      problems.push(`${where}: duplicate id "${conn.id}" skipped`)
      return
    }
    seen.add(conn.id)
    out.push(conn)
  })
  return { connections: out, problems }
}

export function serializeConnections(conns: Connection[]): string {
  const file: ConnectionsFile = { version: FILE_VERSION, connections: conns.map(clean) }
  return JSON.stringify(file, null, 2) + '\n'
}

/** Drops empty optional fields so exported files stay short. */
function clean(c: Connection): Connection {
  const o: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(c)) if (v !== undefined && v !== '' && v !== false) o[k] = v
  if (o.port === undefined) o.port = 0
  if (o.user === undefined) o.user = ''
  return o as unknown as Connection
}

/** Where a merged entry comes from: the local store, the team file, or a local copy overriding a team entry. */
export type Source = 'local' | 'team' | 'override'
export interface Entry extends Connection {
  source: Source
}

/** Local definitions plus the team file's; a local definition with a team entry's id overrides it. Sorted by name. */
export function mergeConnections(local: Connection[], team: Connection[]): Entry[] {
  const teamIds = new Set(team.map((c) => c.id))
  const localIds = new Set(local.map((c) => c.id))
  const out: Entry[] = [
    ...team.filter((c) => !localIds.has(c.id)).map((c) => ({ ...c, source: 'team' as const })),
    ...local.map((c) => ({ ...c, source: teamIds.has(c.id) ? ('override' as const) : ('local' as const) })),
  ]
  return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
}

/** Adds imported definitions to the local ones; an imported id replaces the local definition. */
export function importInto(local: Connection[], incoming: Connection[]): { local: Connection[]; added: number; replaced: number } {
  const byId = new Map(local.map((c) => [c.id, c]))
  let added = 0
  let replaced = 0
  for (const c of incoming) {
    if (byId.has(c.id)) replaced++
    else added++
    byId.set(c.id, c)
  }
  return { local: [...byId.values()], added, replaced }
}

/** Replaces (or adds) one local definition; `prevId` is its id before an edit renamed it. */
export function upsert(local: Connection[], c: Connection, prevId?: string): Connection[] {
  const drop = new Set([c.id, prevId ?? c.id])
  const i = local.findIndex((x) => x.id === (prevId ?? c.id))
  const rest = local.filter((x) => !drop.has(x.id))
  if (i < 0) return [...rest, c]
  rest.splice(Math.min(i, rest.length), 0, c)
  return rest
}

/** A new id from a name: lowercase slug, unique among `taken`. */
export function newId(name: string, taken: Iterable<string>): string {
  const t = new Set(taken)
  const base = (name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+|-+$/g, '').slice(0, 56)) || 'conn'
  if (!t.has(base)) return base
  for (let i = 2; ; i++) if (!t.has(`${base}-${i}`)) return `${base}-${i}`
}

/** `transport` has a default in the schema (so the generated type requires it); it is ssh only. */
export type EngineDef = Omit<Schemas['ConnectionDef'], 'transport'> & { transport?: Transport }

/** What `POST /engine/connections` takes (no name, no notes: the engine rejects unknown fields). */
export function toEngineDef(c: Connection): EngineDef {
  const d: EngineDef = { id: c.id, kind: c.kind, host: c.host, port: c.port, user: c.user }
  if (c.kind === 'db') {
    d.service = c.service
    if (c.adrHome) d.adrHome = c.adrHome
    if (c.tcps) d.tcps = true
    if (c.tcps && c.tlsSkipVerify) d.tlsSkipVerify = true
  } else {
    d.transport = c.transport ?? 'auto'
  }
  return d
}

/** The definition an engine `ConnectionInfo` was registered with, in `toEngineDef`'s shape (for comparing). */
export function infoToDef(i: Schemas['ConnectionInfo']): EngineDef {
  const d: EngineDef = { id: i.id, kind: i.kind, host: i.host, port: i.port, user: i.user }
  if (i.kind === 'db') {
    d.service = i.service
    if (i.adrHome) d.adrHome = i.adrHome
    if (i.tcps) d.tcps = true
    if (i.tcps && i.tlsSkipVerify) d.tlsSkipVerify = true
  } else {
    d.transport = i.transport || 'auto'
  }
  return d
}

export function sameEngineDef(a: Connection, b: Connection): boolean {
  return JSON.stringify(toEngineDef(a)) === JSON.stringify(toEngineDef(b))
}

/** `user@host:port` (ssh) or `user@host:port/service` (db), for lists. */
export function address(c: Connection): string {
  const u = c.user ? `${c.user}@` : ''
  const p = c.port ? `:${c.port}` : ''
  return c.kind === 'db' ? `${u}${c.host}${p}/${c.service ?? ''}` : `${u}${c.host}${p}`
}
