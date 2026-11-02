import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { listen } from '../platform'
import type { ApiClient } from '@lib/data/client'
import { engineClient, fetchHealth } from './client'
import { EV_CRASHED, EV_FAILED, EV_READY, engineDevTools, engineKill, engineRestart, engineStart } from './commands'
import { EngineEvents, readEvents } from './events'
import type { EngineCrashed, EngineFailed, EngineInfo, EngineOptions, Health } from './types'

const HEALTH_EVERY_MS = 5000

/** `starting` until the first ready line; `restarting` between `engine://crashed` and the next `engine://ready`. */
export type EngineStatusKind = 'starting' | 'ready' | 'restarting' | 'failed'

export interface Engine {
  status: EngineStatusKind
  addr: string | null
  token: string | null
  version: string | null
  protocol: number | null
  /** automatic restarts since the app started */
  restarts: number
  /** why the engine failed (start error, protocol mismatch, too many crashes) */
  error: string | null
  /** crashes seen by this window; the last one's details */
  crashes: number
  lastCrash: EngineCrashed | null
  /** `GET /engine/health`, polled every 5 s while ready, and again on a session event (not on a live snapshot) */
  health: Health | null
  /** the client for `/engine/*` of the running engine */
  client: ApiClient | null
  /** `job`, `session`, `prompt`, `log` from `GET /engine/events`, and `stream` */
  events: EngineEvents
  /** debug build or smoke run: `kill` works */
  devTools: boolean
  /** the options of the last start (settings that need a restart compare against them) */
  options: EngineOptions | undefined
  /** stops and starts the engine, with new options when given */
  restart(opts?: EngineOptions): Promise<void>
  kill(): Promise<void>
}

type Core = Omit<Engine, 'health' | 'client' | 'events' | 'devTools' | 'options' | 'restart' | 'kill'>

const initial: Core = {
  status: 'starting',
  addr: null,
  token: null,
  version: null,
  protocol: null,
  restarts: 0,
  error: null,
  crashes: 0,
  lastCrash: null,
}

const ready = (s: Core, i: EngineInfo): Core => ({
  ...s,
  status: 'ready',
  addr: i.addr,
  token: i.token,
  version: i.version,
  protocol: i.protocol,
  restarts: i.restarts,
  error: null,
})

const EngineContext = createContext<Engine | null>(null)

/** Starts the engine sidecar (with `options`, from the settings) and tracks it through the shell's `engine://*` events. */
export function EngineProvider({ options, children }: { options?: EngineOptions; children: ReactNode }) {
  const started = useRef(options)
  const [startedWith, setStartedWith] = useState(options)
  const [core, setCore] = useState<Core>(initial)
  const [health, setHealth] = useState<Health | null>(null)
  const [devTools, setDevTools] = useState(false)
  const events = useMemo(() => new EngineEvents(), [])
  const fail = (e: unknown) => setCore((s) => ({ ...s, status: 'failed', error: String(e) }))

  useEffect(() => {
    let alive = true
    const unlisten = Promise.all([
      listen<EngineInfo>(EV_READY, (e) => setCore((s) => ready(s, e.payload))),
      listen<EngineCrashed>(EV_CRASHED, (e) =>
        setCore((s) => ({ ...s, status: 'restarting', crashes: s.crashes + 1, lastCrash: e.payload })),
      ),
      listen<EngineFailed>(EV_FAILED, (e) => setCore((s) => ({ ...s, status: 'failed', error: e.payload.message }))),
    ])
    // after the listeners, so no ready event is missed; idempotent when the engine already runs
    unlisten
      .then(() => engineStart(started.current))
      .then((i) => alive && setCore((s) => ready(s, i)))
      .catch((e) => alive && fail(e))
    engineDevTools().then((d) => alive && setDevTools(d), () => {})
    return () => {
      alive = false
      void unlisten.then((fns) => fns.forEach((f) => f()))
    }
  }, [])

  const { addr, token, status } = core
  const client = useMemo(() => (addr && token ? engineClient(addr, token) : null), [addr, token])

  // events and health of the current engine run; a restart brings a new address and token
  useEffect(() => {
    if (!client || status !== 'ready') return
    const ac = new AbortController()
    void readEvents(client, events, ac.signal)
    const poll = () =>
      fetchHealth(client, ac.signal).then(
        (h) => setHealth(h),
        () => {},
      )
    poll()
    const t = setInterval(poll, HEALTH_EVERY_MS)
    // a session opened or closed: the count in `health` changed, do not wait for the next tick
    // (`live` is a followed session's new snapshot, the count stays)
    const offSession = events.on('session', (e) => e.state !== 'live' && poll())
    return () => {
      offSession()
      clearInterval(t)
      ac.abort()
    }
  }, [client, status, events])

  const restart = useCallback(async (opts?: EngineOptions) => {
    setCore((s) => ({ ...s, status: 'starting', error: null }))
    try {
      const i = await engineRestart(opts)
      if (opts) setStartedWith(opts)
      setCore((s) => ready(s, i))
    } catch (e) {
      fail(e)
    }
  }, [])
  const kill = useCallback(() => engineKill(), [])

  const value = useMemo<Engine>(
    () => ({ ...core, health: status === 'ready' ? health : null, client, events, devTools, options: startedWith, restart, kill }),
    [core, status, health, client, events, devTools, startedWith, restart, kill],
  )
  return <EngineContext.Provider value={value}>{children}</EngineContext.Provider>
}

export function useEngine(): Engine {
  const e = useContext(EngineContext)
  if (!e) throw new Error('no EngineProvider above this component')
  return e
}
