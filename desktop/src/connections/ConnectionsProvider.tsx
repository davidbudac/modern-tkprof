import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import type { ApiClient } from '@lib/data/client'
import { useEngine, type JobInfo, type OpenSessionResponse } from '../engine'
import { EngineError, errorText, remoteApi, type ConnectionTest } from './api'
import { emptyJobs, jobsReducer, toAutoOpen, type JobsAction, type JobsState } from './jobs'
import { mockDbEnabled, withDbMock } from './mock'
import { Registry } from './registry'
import {
  type Connection, type Entry, importInto, mergeConnections, parseConnectionsFile, serializeConnections, toEngineDef, upsert,
} from './model'
import {
  type ConnStatus, loadSaved, pickJsonFile, readPicked, readTeamFile, saveConnections, saveFile, saveStatus, saveTeamPath,
} from './persist'

/**
 * What the connections UI needs from the workspace (S3): open fetched files as a session tab,
 * show an engine session that already exists (a live follow) as a tab, and the session of the
 * active tab (for "fetch reference data").
 */
export interface WorkspaceBridge {
  openPaths(paths: string[]): void | Promise<void>
  /** a tab for a session opened by the connection (follow); `reopen` follows again after an engine restart */
  attachSession(r: OpenSessionResponse, meta: { title: string; live: boolean; reopen?: (client: ApiClient) => Promise<OpenSessionResponse> }): void
  activeSession?(): string | null
}

export interface TeamState {
  path: string | null
  connections: Connection[]
  /** the file could not be read or parsed (the last good list stays) */
  error?: string
  /** entries skipped or fields dropped */
  problems: string[]
  loadedAt?: number
}

export interface Notice {
  id: number
  kind: 'info' | 'warn' | 'error'
  text: string
}

export interface Connections {
  loaded: boolean
  entries: Entry[]
  local: Connection[]
  team: TeamState
  status: Record<string, ConnStatus>
  jobs: JobsState
  notices: Notice[]
  bridge: WorkspaceBridge
  /** the engine client (with the `?mock=db` routes in dev mode); null while the engine is down */
  client: ApiClient | null
  save(c: Connection, prevId?: string): void
  remove(id: string): void
  /** a local copy of a team definition, which then overrides it */
  overrideLocally(id: string): void
  setTeamPath(path: string | null): void
  chooseTeamFile(): Promise<void>
  importFile(): Promise<void>
  exportFile(): Promise<void>
  /** replaces the local definitions (the combined backup import merges first; saved like any change) */
  replaceLocal(list: Connection[]): void
  /** registers the definition with the engine if needed (lazily, again after a restart or an edit) and runs `fn` */
  run<T>(id: string, fn: (client: ApiClient) => Promise<T>): Promise<T>
  /** `run` on a given engine client (a tab's `reopen` after an engine restart gets the new one) */
  runOn<T>(client: ApiClient | null, id: string, fn: (client: ApiClient) => Promise<T>): Promise<T>
  test(id: string): Promise<ConnectionTest>
  /** DELETE the engine's connection (credentials gone) and register the definition again */
  forget(id: string): Promise<void>
  trackJob(job: JobInfo, label: string, autoOpen?: boolean): void
  dispatchJobs(a: JobsAction): void
  cancelJob(id: string): Promise<void>
  notify(text: string, kind?: Notice['kind']): void
  dismissNotice(id: number): void
}

const Ctx = createContext<Connections | null>(null)
const TEAM_POLL_MS = 5000
const NOTICE_MS = 8000
const JOBS_POLL_MS = 3000

export function ConnectionsProvider({ bridge, children }: { bridge: WorkspaceBridge; children: ReactNode }) {
  const { client: engineClient, events } = useEngine()
  const [loaded, setLoaded] = useState(false)
  const [local, setLocal] = useState<Connection[]>([])
  const [team, setTeam] = useState<TeamState>({ path: null, connections: [], problems: [] })
  const [status, setStatus] = useState<Record<string, ConnStatus>>({})
  const [jobs, dispatchJobs] = useReducer(jobsReducer, emptyJobs)
  const [notices, setNotices] = useState<Notice[]>([])

  const entries = useMemo(() => mergeConnections(local, team.connections), [local, team.connections])
  const entriesRef = useRef(entries)
  entriesRef.current = entries
  const bridgeRef = useRef(bridge)
  bridgeRef.current = bridge

  const client = useMemo(() => {
    if (!engineClient) return null
    return mockDbEnabled() ? withDbMock(engineClient, (id) => entriesRef.current.find((e) => e.id === id)?.kind === 'db') : engineClient
  }, [engineClient])

  const noticeSeq = useRef(0)
  const notify = useCallback((text: string, kind: Notice['kind'] = 'info') => {
    const id = ++noticeSeq.current
    setNotices((n) => [...n.slice(-4), { id, kind, text }])
    if (kind === 'info') setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), NOTICE_MS)
  }, [])
  const dismissNotice = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), [])

  // load once; then every change is saved
  useEffect(() => {
    let alive = true
    loadSaved().then(
      (s) => {
        if (!alive) return
        setLocal(s.connections)
        setStatus(s.status)
        setTeam((t) => ({ ...t, path: s.teamPath }))
        setLoaded(true)
      },
      (e) => {
        notify(`Connections could not be loaded: ${errorText(e)}`, 'error')
        setLoaded(true)
      },
    )
    return () => {
      alive = false
    }
  }, [notify])
  useEffect(() => {
    if (loaded) saveConnections(local).catch((e) => notify(`Saving connections failed: ${errorText(e)}`, 'error'))
  }, [local, loaded, notify])
  useEffect(() => {
    if (loaded) saveStatus(status).catch(() => {})
  }, [status, loaded])

  // the team file: read now and every 5 s; a broken file keeps the last good list and shows why
  const teamPath = team.path
  useEffect(() => {
    if (!loaded) return
    if (!teamPath) {
      setTeam({ path: null, connections: [], problems: [] })
      return
    }
    let alive = true
    let last: string | null = null
    const read = async () => {
      try {
        const text = await readTeamFile(teamPath)
        if (!alive || text === last) return
        last = text
        const r = parseConnectionsFile(text)
        setTeam((t) =>
          r.fatal
            ? { ...t, error: r.fatal, problems: [], loadedAt: Date.now() }
            : { path: teamPath, connections: r.connections, problems: r.problems, error: undefined, loadedAt: Date.now() },
        )
      } catch (e) {
        if (!alive) return
        last = null
        setTeam((t) => ({ ...t, error: errorText(e) }))
      }
    }
    void read()
    const timer = setInterval(read, TEAM_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [teamPath, loaded])

  // engine registration (lazily, again when changed, again after an engine restart)
  const registry = useRef(new Registry(remoteApi)).current
  const ensureOn = useCallback(
    async (cl: ApiClient | null, id: string): Promise<ApiClient> => {
      if (!cl) throw new EngineError(0, 'unreachable', 'the engine is not running')
      const e = entriesRef.current.find((x) => x.id === id)
      if (!e) throw new Error(`no connection ${id}`)
      await registry.ensure(cl, toEngineDef(e))
      return cl
    },
    [registry],
  )
  useEffect(() => {
    if (!client || !registry.isRestart(client)) return
    // a new engine run (crash restart or manual restart): its connections and jobs are gone
    dispatchJobs({ type: 'lost' })
    const used = [...registry.used].filter((id) => entriesRef.current.some((e) => e.id === id))
    if (!used.length) return
    void Promise.allSettled(used.map((id) => ensureOn(client, id))).then(() =>
      notify(
        `Engine restarted: ${used.length} connection${used.length > 1 ? 's' : ''} registered again. Credentials were kept only in the engine and will be asked again.`,
        'warn',
      ),
    )
  }, [client, registry, ensureOn, notify])

  const setOne = useCallback((id: string, s: Partial<ConnStatus>) => setStatus((m) => ({ ...m, [id]: { ...(m[id] ?? { state: 'unknown' }), ...s } })), [])

  const runOn = useCallback(
    async <T,>(cl: ApiClient | null, id: string, fn: (client: ApiClient) => Promise<T>): Promise<T> => {
      const once = async () => fn(await ensureOn(cl, id))
      try {
        try {
          return await once()
        } catch (e) {
          // the engine lost the definition (e.g. deleted elsewhere): register again, once
          if (e instanceof EngineError && e.status === 404 && /connection/i.test(e.message)) {
            registry.forget(id)
            return await once()
          }
          throw e
        }
      } catch (e) {
        if (e instanceof EngineError && e.code === 'remote') setOne(id, { state: 'error', message: e.message })
        throw e
      }
    },
    [ensureOn, registry, setOne],
  )
  const run = useCallback(<T,>(id: string, fn: (client: ApiClient) => Promise<T>) => runOn(client, id, fn), [runOn, client])

  const test = useCallback(
    async (id: string) => {
      const at = new Date().toISOString()
      try {
        const t = await run(id, (cl) => remoteApi.test(cl, id))
        setOne(id, { state: 'ok', at, message: undefined, server: t.server, transport: t.transport })
        return t
      } catch (e) {
        if (!(e instanceof EngineError && e.code === 'cancelled')) setOne(id, { state: 'error', at, message: errorText(e) })
        throw e
      }
    },
    [run, setOne],
  )

  const forget = useCallback(
    async (id: string) => {
      if (!client) throw new EngineError(0, 'unreachable', 'the engine is not running')
      try {
        await remoteApi.remove(client, id)
      } catch (e) {
        if (!(e instanceof EngineError && e.status === 404)) throw e
      }
      registry.forget(id)
      await ensureOn(client, id)
      setOne(id, { state: 'unknown', message: undefined })
      notify(`Credentials of ${id} forgotten`)
    },
    [client, registry, ensureOn, setOne, notify],
  )

  const save = useCallback((c: Connection, prevId?: string) => {
    setLocal((l) => upsert(l, c, prevId))
    if (prevId && prevId !== c.id) setStatus(({ [prevId]: _, ...rest }) => rest)
  }, [])
  const remove = useCallback(
    (id: string) => {
      setLocal((l) => l.filter((c) => c.id !== id))
      if (!team.connections.some((c) => c.id === id)) setStatus(({ [id]: _, ...rest }) => rest)
      if (client && registry.holds(id) && !team.connections.some((c) => c.id === id)) {
        registry.forget(id)
        remoteApi.remove(client, id).catch(() => {})
      }
    },
    [client, registry, team.connections],
  )
  const overrideLocally = useCallback(
    (id: string) => {
      const t = team.connections.find((c) => c.id === id)
      if (t) setLocal((l) => upsert(l, { ...t }))
    },
    [team.connections],
  )

  const setTeamPath = useCallback(
    (path: string | null) => {
      setTeam({ path, connections: [], problems: [] })
      saveTeamPath(path).catch((e) => notify(`Saving the team file setting failed: ${errorText(e)}`, 'error'))
    },
    [notify],
  )
  const chooseTeamFile = useCallback(async () => {
    const p = await pickJsonFile('Team connections file')
    if (p) setTeamPath(p)
  }, [setTeamPath])

  const importFile = useCallback(async () => {
    try {
      const p = await pickJsonFile('Import connections')
      if (!p) return
      const r = parseConnectionsFile(await readPicked(p))
      if (r.fatal) {
        notify(`Import failed: ${r.fatal}`, 'error')
        return
      }
      const res = importInto(local, r.connections)
      setLocal(res.local)
      const skipped = r.problems.length ? `; ${r.problems.length} problem${r.problems.length > 1 ? 's' : ''}: ${r.problems.slice(0, 3).join('; ')}` : ''
      notify(`Imported ${res.added} new, ${res.replaced} replaced${skipped}`, r.problems.length ? 'warn' : 'info')
    } catch (e) {
      notify(`Import failed: ${errorText(e)}`, 'error')
    }
  }, [local, notify])
  const exportFile = useCallback(async () => {
    try {
      const p = await saveFile(serializeConnections(entriesRef.current.map(({ source: _, ...c }) => c)))
      if (p) notify(`Exported ${entriesRef.current.length} connections to ${p}`)
    } catch (e) {
      notify(`Export failed: ${errorText(e)}`, 'error')
    }
  }, [notify])

  const replaceLocal = useCallback((list: Connection[]) => setLocal(list), [])

  // jobs: events, a re-read after every (re)connect, auto-open of finished fetches
  useEffect(() => {
    const offJob = events.on('job', (job) => dispatchJobs({ type: 'event', job }))
    const offStream = events.on('stream', ({ connected }) => {
      if (connected && client) remoteApi.jobs(client).then((r) => dispatchJobs({ type: 'sync', jobs: r.jobs }), () => {})
    })
    return () => {
      offJob()
      offStream()
    }
  }, [events, client])
  // a follow (or a slow remote) may stay quiet for long: re-read while anything runs
  const anyRunning = jobs.list.some((t) => t.job.state === 'running')
  useEffect(() => {
    if (!anyRunning || !client) return
    const timer = setInterval(() => remoteApi.jobs(client).then((r) => dispatchJobs({ type: 'sync', jobs: r.jobs }), () => {}), JOBS_POLL_MS)
    return () => clearInterval(timer)
  }, [anyRunning, client])
  useEffect(() => {
    for (const t of toAutoOpen(jobs)) {
      dispatchJobs({ type: 'opened', id: t.job.id })
      Promise.resolve(bridgeRef.current.openPaths(t.job.localPaths ?? [])).catch((e) => notify(`Opening failed: ${errorText(e)}`, 'error'))
    }
  }, [jobs, notify])

  const trackJob = useCallback((job: JobInfo, label: string, autoOpen?: boolean) => dispatchJobs({ type: 'track', job, label, autoOpen }), [])
  const cancelJob = useCallback(
    async (id: string) => {
      if (!client) return
      try {
        const r = await remoteApi.cancelJob(client, id)
        dispatchJobs({ type: 'event', job: r.job })
      } catch (e) {
        if (!(e instanceof EngineError && e.status === 409)) notify(`Cancel failed: ${errorText(e)}`, 'error')
      }
    },
    [client, notify],
  )

  const value = useMemo<Connections>(
    () => ({
      loaded, entries, local, team, status, jobs, notices, bridge, client,
      save, remove, overrideLocally, setTeamPath, chooseTeamFile, importFile, exportFile, replaceLocal,
      run, runOn, test, forget, trackJob, dispatchJobs, cancelJob, notify, dismissNotice,
    }),
    [loaded, entries, local, team, status, jobs, notices, bridge, client, save, remove, overrideLocally, setTeamPath,
      chooseTeamFile, importFile, exportFile, replaceLocal, run, runOn, test, forget, trackJob, cancelJob, notify, dismissNotice],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useConnections(): Connections {
  const c = useContext(Ctx)
  if (!c) throw new Error('no ConnectionsProvider above this component')
  return c
}

/** For components that also work without connections (the prompt modal). */
export function useConnectionsOptional(): Connections | null {
  return useContext(Ctx)
}
