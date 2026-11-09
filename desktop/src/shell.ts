/**
 * The Electron shell as the page sees it: `window.mtkprof` from `electron/preload.ts`, absent in
 * the dev browser mode. `invoke` runs a command of `electron/main.ts` and rejects with its error
 * message (a string, as Tauri's invoke did); `listen` takes the shell's events with Tauri's
 * `{payload}` envelope.
 */

interface Bridge {
  invoke(cmd: string, args?: Record<string, unknown>): Promise<{ ok: true; value: unknown } | { ok: false; error: string }>
  onEvent(fn: (event: string, payload: unknown) => void): () => void
  pathForFile(f: File): string
  platform: string
}

declare global {
  interface Window {
    mtkprof?: Bridge
  }
}

const bridge: Bridge | undefined = typeof window !== 'undefined' ? window.mtkprof : undefined

/** The desktop app (false: the dev browser mode). */
export const inApp = bridge !== undefined

export async function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  if (!bridge) throw new Error(`${cmd}: not in the app`)
  const r = await bridge.invoke(cmd, args)
  if (!r.ok) throw r.error
  return r.value as T
}

export type UnlistenFn = () => void
export type EventCallback<T> = (e: { event: string; payload: T }) => void

const handlers = new Map<string, Set<EventCallback<unknown>>>()
let subscribed = false

export function listen<T>(event: string, fn: EventCallback<T>): Promise<UnlistenFn> {
  if (!bridge) return Promise.resolve(() => {})
  if (!subscribed) {
    subscribed = true
    bridge.onEvent((name, payload) => {
      for (const h of handlers.get(name) ?? []) h({ event: name, payload })
    })
  }
  let set = handlers.get(event)
  if (!set) handlers.set(event, (set = new Set()))
  const h = fn as EventCallback<unknown>
  set.add(h)
  return Promise.resolve(() => void set.delete(h))
}

/** The path of a file dropped on the window or picked in a file input (the app only). */
export const pathForFile = (f: File): string | null => (bridge ? bridge.pathForFile(f) || null : null)
