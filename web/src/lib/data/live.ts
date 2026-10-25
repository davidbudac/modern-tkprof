// A live session's document follows the server (docs/ARCHITECTURE.md § Engine mode, "Live sessions"): one
// `GET api/doc?rev=<shown>` is kept open. The server answers when it has a newer snapshot, after its wait (25 s) with the
// same revision, and at once when the follow has stopped (`X-Live` other than `live`). Every new revision replaces the
// store's document (`Store.swapDoc`: scope, selection and positions stay); the views refetch their slice queries because
// the new document has a source of its own (`attachRemote`).
import type { ApiClient } from './client'
import { fromRaw, type Loaded } from './load'
import type { RawCompareDocument, RawDocument } from './types'
import type { LiveStatus, Store } from '../state/store'

export interface LiveOptions {
  /** waits after a failed request, in turn (the last one repeats) */
  backoffMs?: number[]
  /** a request that answers the shown revision faster than this is followed by a pause this long (a server whose follow ended but that sends no `X-Live`) */
  minGapMs?: number
  /** turns an answer into the document the store shows (default `fromRaw(raw, client)`) */
  load?: (raw: RawDocument | RawCompareDocument) => Promise<Loaded>
  now?: () => number
}

export interface LiveFollow {
  /** stops following (the document stays); `done` resolves once the loop has ended */
  stop(): void
  readonly done: Promise<void>
}

export const LIVE_BACKOFF_MS = [1000, 2000, 5000, 10000, 30000]

const isAbort = (e: unknown) => e instanceof DOMException && e.name === 'AbortError'

/**
 * Follows the live session behind `client` from revision `rev` (the `X-Rev` of the document the store shows) until the
 * session stops (`X-Live` not `live`, no `X-Rev`, 404/410) or `stop()`. `store.live` tells the state; the user's
 * pause (`actions.setLivePaused`) aborts the request on its way and nothing is asked until resumed. Errors are retried
 * after `backoffMs`.
 */
export function followLive(session: { store: Store; client: ApiClient }, rev: number, opts: LiveOptions = {}): LiveFollow {
  const { store, client } = session
  const backoff = opts.backoffMs ?? LIVE_BACKOFF_MS
  const minGap = opts.minGapMs ?? 1000
  const now = opts.now ?? Date.now
  const load = opts.load ?? ((raw) => fromRaw(raw, client))
  let stopped = false
  let ac: AbortController | null = null
  let wake: (() => void) | null = null

  const setLive = (patch: Partial<LiveStatus>) => store.setState((s) => (s.live ? { live: { ...s.live, ...patch } } : {}))
  store.setState((s) => ({ live: { state: 'live', rev, updated: s.live?.updated ?? now(), paused: s.live?.paused ?? false, error: null, retryAt: null } }))
  let paused = store.getState().live?.paused ?? false
  const unsubscribe = store.subscribe(() => {
    const p = store.getState().live?.paused ?? false
    if (p === paused) return
    paused = p
    if (p) ac?.abort()
    wake?.()
  })
  /** waits `ms` (or, without, until woken): a pause, a resume or `stop` wakes it early */
  const sleep = (ms?: number) => new Promise<void>((resolve) => {
    const t = ms === undefined ? undefined : setTimeout(() => done(), ms)
    const done = () => { clearTimeout(t); if (wake === done) wake = null; resolve() }
    wake = done
  })

  const run = async () => {
    let fails = 0
    while (!stopped) {
      if (paused) { await sleep(); continue }
      const ctl = (ac = new AbortController())
      const started = now()
      try {
        const res = await client.fetch(`/api/doc?rev=${rev}`, { signal: ctl.signal, headers: { accept: 'application/json' } })
        if (res.status === 404 || res.status === 410) break // the session is gone
        if (!res.ok) throw new Error(`api/doc: ${res.status} ${(await res.text()).trim() || res.statusText}`)
        const xrev = res.headers.get('X-Rev')
        if (xrev === null) { void res.body?.cancel(); break } // not a live session
        const got = Number(xrev)
        const state = res.headers.get('X-Live') ?? 'live'
        const fresh = got !== rev // newer, or a restarted server's own count
        if (fresh) {
          const l = await load((await res.json()) as RawDocument | RawCompareDocument)
          if (stopped || ctl.signal.aborted) continue
          store.swapDoc(l)
          rev = got
          setLive({ state: 'live', rev, updated: now(), error: null, retryAt: null })
        } else {
          void res.body?.cancel()
          if (fails > 0) setLive({ state: 'live', error: null, retryAt: null })
        }
        fails = 0
        if (state !== 'live') break
        if (!fresh && now() - started < minGap) await sleep(minGap)
      } catch (e) {
        if (stopped || (isAbort(e) && ctl.signal.aborted)) continue // stopped or paused
        const wait = backoff[Math.min(fails, backoff.length - 1)]
        fails++
        setLive({ state: 'error', error: e instanceof Error ? e.message : String(e), retryAt: now() + wait })
        await sleep(wait)
      } finally {
        if (ac === ctl) ac = null
      }
    }
    unsubscribe()
    if (!stopped) setLive({ state: 'ended', error: null, retryAt: null })
  }
  const done = run()
  return {
    stop() {
      if (stopped) return
      stopped = true
      ac?.abort()
      wake?.()
    },
    done,
  }
}
