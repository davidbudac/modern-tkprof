import type { ApiClient } from '@lib/data/client'
import type { DBSession, DBTraceFile } from './api'

/**
 * Dev only (`?mock=db` or `?mock=db:<id>,<id>` in a plain browser): answers the db read routes (`test`, `diag`,
 * `sessions`, `tracefiles`, `trace`) of db connections with canned data, so the DB panel can
 * be looked at without a database. Everything else goes to the engine.
 */
export function mockDbEnabled(): boolean {
  return mockedIds() !== null
}

/** `?mock=db`: every db connection (empty set); `?mock=db:a,b`: only those ids; else null. */
function mockedIds(): Set<string> | null {
  if (typeof location === 'undefined') return null
  const m = new URLSearchParams(location.search).get('mock')
  if (m === 'db') return new Set()
  return m?.startsWith('db:') ? new Set(m.slice(3).split(',')) : null
}

const ADR = 'diag/rdbms/cdb1/cdb1'
const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()

const sessions: DBSession[] = [
  { sid: 37, serial: 51022, username: 'MTK', osuser: 'db', machine: 'laptop', program: 'mtkprof', module: 'mtkprof', status: 'ACTIVE', sqlId: '9babjv8yq8ru3', logonTime: ago(2), sqlTrace: 'DISABLED', traceFile: `/u01/app/oracle/${ADR}/trace/cdb1_ora_4711.trc`, self: true },
  { sid: 142, serial: 3381, username: 'APP', osuser: 'app', machine: 'app01', program: 'JDBC Thin Client', module: 'OrderService', action: 'checkout', status: 'ACTIVE', sqlId: 'a5ks9fhw2v9s1', logonTime: ago(40), sqlTrace: 'ENABLED', traceFile: `/u01/app/oracle/${ADR}/trace/cdb1_ora_5120.trc`, self: false },
  { sid: 288, serial: 17, username: 'APP', osuser: 'app', machine: 'app02', program: 'JDBC Thin Client', module: 'OrderService', status: 'INACTIVE', logonTime: ago(95), sqlTrace: 'DISABLED', traceFile: `/u01/app/oracle/${ADR}/trace/cdb1_ora_5233.trc`, self: false },
  { sid: 301, serial: 9122, username: 'REPORTS', osuser: 'batch', machine: 'etl01', program: 'sqlplus@etl01', module: 'NIGHTLY_LOAD', status: 'INACTIVE', logonTime: ago(300), sqlTrace: 'DISABLED', traceFile: `/u01/app/oracle/${ADR}/trace/cdb1_ora_6020.trc`, self: false },
]

const files: DBTraceFile[] = [
  { adrHome: ADR, name: 'cdb1_ora_5120.trc', path: `/u01/app/oracle/${ADR}/trace/cdb1_ora_5120.trc`, modified: ago(1), conId: 3, sid: 142, serial: 3381, username: 'APP' },
  { adrHome: ADR, name: 'cdb1_ora_4711.trc', modified: ago(12), conId: 3 },
  { adrHome: ADR, name: 'cdb1_ora_133146_mtk_basic_binds.trc', modified: ago(180), conId: 3 },
  { adrHome: ADR, name: 'cdb1_mmon_2211.trc', modified: ago(600), conId: 3 },
]

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

export function withDbMock(client: ApiClient, isDb: (id: string) => boolean): ApiClient {
  return {
    ...client,
    async fetch(path, init) {
      const m = /^\/engine\/connections\/([^/?]+)\/(test|diag|sessions|tracefiles|trace)(\?.*)?$/.exec(path)
      const id = m ? decodeURIComponent(m[1]) : ''
      const only = mockedIds()
      if (!m || !isDb(id) || (only?.size && !only.has(id))) return client.fetch(path, init)
      await new Promise((r) => setTimeout(r, 150))
      switch (m[2]) {
        case 'test':
          return json({ server: '19.27.0.0.0', transport: 'tcp', diag: { adrHome: ADR, traceDir: `/u01/app/oracle/${ADR}/trace` } })
        case 'diag':
          return json({ dirs: [`/u01/app/oracle/${ADR}/trace`], adrHome: ADR })
        case 'sessions':
          return json({ sessions })
        case 'tracefiles': {
          const q = new URLSearchParams(m[3] ?? '')
          const sid = q.get('sid')
          return json({ files: sid ? files.filter((f) => String(f.sid) === sid) : files })
        }
        case 'trace': {
          const req = JSON.parse(String(init?.body ?? '{}')) as { sid?: number; self?: boolean; enable: boolean }
          const s = sessions.find((x) => (req.self ? x.self : x.sid === req.sid))
          if (!s) return json({ error: { code: 'remote', message: 'ORA-00030: User session ID does not exist.' } }, 502)
          s.sqlTrace = req.enable ? 'ENABLED' : 'DISABLED'
          return json({ enabled: req.enable, traceFile: req.enable ? s.traceFile : undefined })
        }
      }
      return client.fetch(path, init)
    },
  }
}
