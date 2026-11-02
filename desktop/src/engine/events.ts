import type { ApiClient } from '@lib/data/client'
import type { JobInfo, LogEvent, PromptEvent, SessionEvent } from './types'

/** The events of `GET /engine/events`, plus `stream` when the connection opens or drops. */
export interface EngineEventMap {
  job: JobInfo
  session: SessionEvent
  prompt: PromptEvent
  log: LogEvent
  /** `connected: true` after every (re)connect: re-read `/engine/sessions` and `/engine/jobs` then */
  stream: { connected: boolean }
}

export type EngineEventType = keyof EngineEventMap
type Listener<K extends EngineEventType> = (data: EngineEventMap[K]) => void

/** A small typed emitter; `on` answers its unsubscribe function. */
export class EngineEvents {
  private listeners = new Map<EngineEventType, Set<(data: never) => void>>()

  on<K extends EngineEventType>(type: K, fn: Listener<K>): () => void {
    let set = this.listeners.get(type)
    if (!set) this.listeners.set(type, (set = new Set()))
    set.add(fn as (data: never) => void)
    return () => void set.delete(fn as (data: never) => void)
  }

  emit<K extends EngineEventType>(type: K, data: EngineEventMap[K]) {
    for (const fn of this.listeners.get(type) ?? []) {
      try {
        ;(fn as Listener<K>)(data)
      } catch (e) {
        console.error(`engine event ${type}:`, e)
      }
    }
  }
}

const ENGINE_EVENTS = new Set<string>(['job', 'session', 'prompt', 'log'])
const BACKOFF_MS = [500, 1000, 2000, 5000, 10000]

/**
 * Reads the engine's SSE stream with `fetch` (it needs the bearer header, which `EventSource`
 * cannot send) and emits each event until `signal` aborts; reconnects with backoff when the
 * stream drops (engine restarted, subscriber fell behind).
 */
export async function readEvents(client: ApiClient, events: EngineEvents, signal: AbortSignal): Promise<void> {
  let attempt = 0
  while (!signal.aborted) {
    let connected = false
    try {
      const r = await client.fetch('/engine/events', { signal, headers: { accept: 'text/event-stream' } })
      if (!r.ok || !r.body) throw new Error(`GET /engine/events: HTTP ${r.status}`)
      connected = true
      attempt = 0
      events.emit('stream', { connected: true })
      await parseStream(r.body, signal, (type, data) => {
        if (!ENGINE_EVENTS.has(type)) return
        try {
          events.emit(type as Exclude<EngineEventType, 'stream'>, JSON.parse(data))
        } catch (e) {
          console.error(`engine event ${type}: bad data`, e)
        }
      })
    } catch (e) {
      if (signal.aborted) break
      if (!connected) console.warn('engine events:', e)
    }
    if (connected) events.emit('stream', { connected: false })
    if (signal.aborted) break
    await sleep(BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)], signal)
  }
}

/** Splits a `text/event-stream` body into events (`event:` type, `data:` lines; `:` comments skipped). */
async function parseStream(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  onEvent: (type: string, data: string) => void,
): Promise<void> {
  const reader = body.getReader()
  const dec = new TextDecoder()
  const stop = () => void reader.cancel().catch(() => {})
  signal.addEventListener('abort', stop)
  let buf = ''
  let type = 'message'
  let data: string[] = []
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) return
      buf += dec.decode(value, { stream: true })
      let nl: number
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '')
        buf = buf.slice(nl + 1)
        if (line === '') {
          if (data.length) onEvent(type, data.join('\n'))
          type = 'message'
          data = []
        } else if (!line.startsWith(':')) {
          const i = line.indexOf(':')
          const field = i < 0 ? line : line.slice(0, i)
          const v = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '')
          if (field === 'event') type = v
          else if (field === 'data') data.push(v)
        }
      }
    }
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}
