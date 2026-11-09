// The engine sidecar (docs/PLAN-DESKTOP.md § 2 and § 7 at the repository root): `mtkprof-engine
// engine` with a fresh bearer token in `MTKPROF_TOKEN` (never in argv), stdin held open (the
// engine exits when it closes, so it cannot outlive the app), and the JSON ready line from its
// stdout. A watcher per run forwards the engine's output to the log and, when the engine exits
// unexpectedly, emits `engine://crashed` and restarts it with backoff (at once, 1 s, 5 s); a
// fourth crash within a minute gives up with `engine://failed`. Every successful start emits
// `engine://ready`. On macOS and Linux the engine runs with the user's login-shell PATH, so the
// CLI agents it looks up (claude, codex) are found when the app was started from the Finder.

import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import os from 'node:os'
import readline from 'node:readline'
import { log } from './log'
import { enginePath as loginPath } from './loginpath'

/** The engine protocol this shell speaks. */
export const PROTOCOL = 1

const READY_TIMEOUT = 10_000
const STOP_TIMEOUT = 3_000
const CRASH_WINDOW = 60_000
/** Delay before the restart after the 1st, 2nd and 3rd crash within `CRASH_WINDOW`. */
const BACKOFF = [0, 1_000, 5_000]

export const EV_READY = 'engine://ready'
export const EV_CRASHED = 'engine://crashed'
export const EV_FAILED = 'engine://failed'

/** What `engine_start` answers and `engine://ready` carries. */
export interface EngineInfo {
  addr: string
  token: string
  version: string
  protocol: number
  /** automatic restarts since the app started */
  restarts: number
}

/** Engine flags the app may set (S4 settings); absent keeps the default. */
export interface EngineOptions {
  /** index cache directory (default `<app cache dir>/mtkprof`) */
  cacheDir?: string | null
  /** index cache cap, e.g. `20G` */
  cacheCap?: string | null
  planVizUrl?: string | null
}

type State = 'stopped' | 'running' | 'crashed' | 'failed'

export interface EngineStatus {
  state: State
  pid: number | null
  /** seconds since the running engine started */
  uptime: number | null
  restarts: number
  error: string | null
}

export interface EngineHost {
  /** the sidecar executable */
  sidecar: string
  /** `<app cache dir>/mtkprof` */
  defaultCacheDir: string
  /** the `-allow-origin` list */
  allowOrigins: string
  emit(event: string, payload: unknown): void
}

/** A start that failed; `fatal` ones (protocol mismatch) are not retried. */
class StartError extends Error {
  constructor(message: string, readonly fatal = false) {
    super(message)
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const newToken = () => randomBytes(48).toString('base64url')

/** One process of the engine: the child, and a promise that settles when it is gone. */
interface Run {
  child: ChildProcess
  exited: Promise<void>
}

/** The engine process and its restart bookkeeping, shared by the commands and the watchers. */
export class EngineManager {
  private run: Run | null = null
  private info: EngineInfo | null = null
  /** bumped by every start and every deliberate stop: a watcher whose run is no longer the current one ignores its process's exit */
  private gen = 0
  private state: State = 'stopped'
  private started: number | null = null
  private restarts = 0
  private crashes: number[] = []
  private error: string | null = null
  private opts: EngineOptions = {}
  /** serializes start/stop/restart/recover, as the Rust shell's mutex did */
  private lock: Promise<unknown> = Promise.resolve()

  constructor(private host: EngineHost) {}

  private locked<T>(f: () => Promise<T>): Promise<T> {
    const p = this.lock.then(f, f)
    this.lock = p.catch(() => {})
    return p
  }

  cacheDir(): string {
    return this.opts.cacheDir || this.host.defaultCacheDir
  }

  /** Spawns the engine and waits for its ready line. Called under the lock. */
  private async spawn(): Promise<EngineInfo> {
    const token = newToken()
    const args = ['engine', '-allow-origin', this.host.allowOrigins, '-cache', this.cacheDir()]
    if (this.opts.cacheCap) args.push('-cache-cap', this.opts.cacheCap)
    if (this.opts.planVizUrl) args.push('-plan-viz-url', this.opts.planVizUrl)
    const env: NodeJS.ProcessEnv = { ...process.env, MTKPROF_TOKEN: token }
    if (process.platform !== 'win32') env.PATH = await loginPath()

    let child: ChildProcess
    try {
      child = spawn(this.host.sidecar, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) {
      throw new StartError(`engine spawn: ${e}`)
    }
    // the stdin pipe of an engine that died must not throw EPIPE at the app
    child.stdin?.on('error', () => {})
    const exited = new Promise<void>((resolve) => child.once('close', () => resolve()))
    const stderr = readline.createInterface({ input: child.stderr! })
    stderr.on('line', (l) => logLine(l))
    const stdout = readline.createInterface({ input: child.stdout! })

    let line: string
    try {
      line = await new Promise<string>((resolve, reject) => {
        const t = setTimeout(() => reject(new StartError(`engine did not report ready within ${READY_TIMEOUT / 1000} s`)), READY_TIMEOUT)
        const done = (f: () => void) => {
          clearTimeout(t)
          stdout.off('line', onLine)
          child.off('exit', onExit)
          child.off('error', onError)
          f()
        }
        const onLine = (l: string) => done(() => resolve(l))
        const onExit = (code: number | null) => done(() => reject(new StartError(`engine exited before ready (code ${code})`)))
        const onError = (e: Error) => done(() => reject(new StartError(`engine spawn: ${e.message}`)))
        stdout.on('line', onLine)
        child.once('exit', onExit)
        child.once('error', onError)
      })
    } catch (e) {
      child.kill()
      throw e
    }
    let ready: { ready?: boolean; addr?: string; version?: string; protocol?: number }
    try {
      ready = JSON.parse(line)
    } catch {
      ready = {}
    }
    if (!ready.ready || typeof ready.addr !== 'string') {
      child.kill()
      throw new StartError(`engine ready line ${JSON.stringify(line)}`)
    }
    if (ready.protocol !== PROTOCOL) {
      child.kill()
      throw new StartError(`protocol mismatch (engine ${ready.protocol}, app ${PROTOCOL})`, true)
    }

    const gen = ++this.gen
    const info: EngineInfo = { addr: ready.addr, token, version: ready.version ?? '', protocol: ready.protocol, restarts: this.restarts }
    log.info(`engine ${info.version} ready on ${info.addr} (pid ${child.pid})`)
    this.run = { child, exited }
    this.info = info
    this.state = 'running'
    this.started = Date.now()
    this.error = null
    // the rest of stdout goes to the log (the pipes never fill)
    stdout.on('line', (l) => logLine(l))
    child.once('exit', (code, signal) => void this.recover(gen, code, signal))
    return info
  }

  /** Restarts the engine after run `gen` ended, unless that exit was deliberate. */
  private recover(gen: number, code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    let message = signal
      ? `the engine was killed by signal ${signal}`
      : code !== null
        ? `the engine exited with code ${code}`
        : 'the engine exited'
    let crashed: { code: number | null; signal: number | null; message: string } = { code, signal: signalNumber(signal), message }
    return this.locked(async () => {
      for (;;) {
        if (this.gen !== gen) return // stopped or restarted on purpose
        log.warn(message)
        this.run = null
        this.info = null
        this.started = null
        this.state = 'crashed'
        this.host.emit(EV_CRASHED, crashed)
        const now = Date.now()
        this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW)
        this.crashes.push(now)
        const delay = BACKOFF[this.crashes.length - 1]
        if (delay === undefined) {
          this.giveUp(`the engine crashed ${this.crashes.length} times within a minute: ${message}`)
          return
        }
        await sleep(delay)
        if (this.gen !== gen) return
        this.restarts++
        try {
          const info = await this.spawn()
          this.host.emit(EV_READY, info)
          return
        } catch (e) {
          this.restarts--
          const err = e instanceof StartError ? e : new StartError(String(e))
          if (err.fatal) {
            this.giveUp(err.message)
            return
          }
          message = err.message
          crashed = { code: null, signal: null, message }
        }
      }
    })
  }

  private giveUp(message: string) {
    log.error(message)
    this.state = 'failed'
    this.error = message
    this.crashes = []
    this.host.emit(EV_FAILED, { message })
  }

  /** Starts the engine unless it runs; `opts` replace the stored options when given. */
  start(opts?: EngineOptions | null): Promise<EngineInfo> {
    return this.locked(() => this.startLocked(opts))
  }

  private async startLocked(opts?: EngineOptions | null): Promise<EngineInfo> {
    if (this.info) return this.info
    if (opts) this.opts = opts
    try {
      const info = await this.spawn()
      this.host.emit(EV_READY, info)
      return info
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log.error(message)
      this.state = 'failed'
      this.error = message
      throw new Error(message)
    }
  }

  /** Stops the engine: closes its stdin and waits up to `STOP_TIMEOUT` for it to exit, then kills it. */
  stop(): Promise<void> {
    return this.locked(() => this.stopLocked())
  }

  private async stopLocked(): Promise<void> {
    this.gen++
    this.info = null
    this.started = null
    this.state = 'stopped'
    this.crashes = []
    const run = this.run
    this.run = null
    if (!run) return
    run.child.stdin?.end()
    const gone = await Promise.race([run.exited.then(() => true), sleep(STOP_TIMEOUT).then(() => false)])
    if (!gone) {
      log.warn(`engine pid ${run.child.pid} did not exit within ${STOP_TIMEOUT / 1000} s of its stdin closing; killing it`)
      run.child.kill('SIGKILL')
    }
  }

  /** Stops and starts the engine, with new options when given; also the way out of `failed`. */
  restart(opts?: EngineOptions | null): Promise<EngineInfo> {
    return this.locked(async () => {
      await this.stopLocked()
      return this.startLocked(opts)
    })
  }

  running(): boolean {
    return this.state === 'running'
  }

  /** The running engine's address and token. */
  endpoint(): { addr: string; token: string } | null {
    return this.info ? { addr: this.info.addr, token: this.info.token } : null
  }

  status(): EngineStatus {
    return {
      state: this.state,
      pid: this.run?.child.pid ?? null,
      uptime: this.started === null ? null : Math.floor((Date.now() - this.started) / 1000),
      restarts: this.restarts,
      error: this.error,
    }
  }

  /** Kills the engine as a crash would (dev builds and smoke runs): the watcher restarts it. */
  kill(): void {
    const child = this.run?.child
    if (!child) throw new Error('the engine is not running')
    log.warn(`killing engine pid ${child.pid} (simulated crash)`)
    child.kill('SIGKILL')
  }
}

function logLine(l: string) {
  const s = l.trimEnd()
  if (s) log.info(s, 'engine')
}

function signalNumber(s: NodeJS.Signals | null): number | null {
  if (!s) return null
  const n = os.constants.signals[s]
  return typeof n === 'number' ? n : null
}
