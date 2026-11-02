import { invoke, isTauri } from '@tauri-apps/api/core'
import { listen as tauriListen, type EventCallback, type UnlistenFn } from '@tauri-apps/api/event'
import pkg from '../package.json'

/**
 * What the app needs from the Tauri shell, with a fallback for the dev browser mode: without the
 * Tauri API (`pnpm dev` in a browser) and with `?engine=HOST:PORT&token=TOKEN` in the URL the app
 * talks to an engine started by hand, keeps its stores in localStorage and takes paths from a
 * text box instead of the file dialog.
 */
export const inTauri = isTauri()

/** `?engine=&token=` of the dev browser mode, else null. */
export function devEngine(): { addr: string; token: string } | null {
  if (inTauri) return null
  const q = new URLSearchParams(location.search)
  const addr = q.get('engine')
  const token = q.get('token')
  return addr && token ? { addr, token } : null
}

export function listen<T>(event: string, fn: EventCallback<T>): Promise<UnlistenFn> {
  return inTauri ? tauriListen<T>(event, fn) : Promise.resolve(() => {})
}

// ---- key-value stores (tauri-plugin-store: <app data dir>/<name>; dev browser: localStorage) ----

export interface KV {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

const kvs = new Map<string, Promise<KV>>()

/** The store file `name` (`settings.json`, `workspace.json`, `annotations.json`, …), loaded once. */
export function openKV(name: string): Promise<KV> {
  let p = kvs.get(name)
  if (!p) kvs.set(name, (p = inTauri ? tauriKV(name) : Promise.resolve(localKV(name))))
  return p
}

async function tauriKV(name: string): Promise<KV> {
  const { load } = await import('@tauri-apps/plugin-store')
  const s = await load(name, { autoSave: 300, defaults: {} })
  return {
    get: (k) => s.get(k),
    set: (k, v) => s.set(k, v),
    delete: async (k) => void (await s.delete(k)),
    keys: () => s.keys(),
  }
}

function localKV(name: string): KV {
  const prefix = `mtkprof:${name}:`
  return {
    async get<T>(k: string) {
      const v = localStorage.getItem(prefix + k)
      return v === null ? undefined : (JSON.parse(v) as T)
    },
    async set(k, v) { localStorage.setItem(prefix + k, JSON.stringify(v)) },
    async delete(k) { localStorage.removeItem(prefix + k) },
    async keys() {
      const out: string[] = []
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)
        if (k?.startsWith(prefix)) out.push(k.slice(prefix.length))
      }
      return out
    },
  }
}

// ---- dialogs, drag-drop, log, app info ----

/** Trace files (or, with `directory`, folders of them) from the open dialog; null when cancelled or in the dev browser. */
export async function pickPaths(directory: boolean): Promise<string[] | null> {
  if (!inTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const r = await open(
    directory
      ? { directory: true, multiple: true, title: 'Open folders of trace files' }
      : {
          multiple: true,
          title: 'Open trace files',
          filters: [
            { name: 'Oracle trace files', extensions: ['trc'] },
            { name: 'All files', extensions: ['*'] },
          ],
        },
  )
  if (r === null) return null
  return Array.isArray(r) ? r : [r]
}

/** One folder from the dialog (the cache location); null when cancelled or in the dev browser. */
export async function pickFolder(title: string): Promise<string | null> {
  if (!inTauri) return null
  const { open } = await import('@tauri-apps/plugin-dialog')
  const r = await open({ directory: true, multiple: false, title })
  return typeof r === 'string' ? r : null
}

export type DropState = { over: boolean; paths?: string[] }

/** Files dropped on the window (Tauri's drag-drop event carries their paths; the browser's does not). */
export async function onDrop(fn: (e: DropState) => void): Promise<UnlistenFn> {
  if (!inTauri) return () => {}
  const { getCurrentWebview } = await import('@tauri-apps/api/webview')
  return getCurrentWebview().onDragDropEvent((e) => {
    const p = e.payload
    if (p.type === 'enter' || p.type === 'over') fn({ over: true })
    else if (p.type === 'leave') fn({ over: false })
    else fn({ over: false, paths: p.paths })
  })
}

/**
 * Trace sets handed to the app from outside (its command line, a second launch, the Finder, `mtkprof open`),
 * queued in the shell until taken; empty in the dev browser.
 */
export function takeOpenRequests(): Promise<string[][]> {
  return inTauri ? invoke<string[][]>('take_open_requests') : Promise.resolve([])
}

/** Called when an open request is queued (`app://open`). */
export function onOpenRequest(fn: () => void): Promise<UnlistenFn> {
  return listen<null>('app://open', () => fn())
}

/** A line in the app log (tauri-plugin-log: stdout and the log dir); CI's smoke step waits on some. */
export function logInfo(message: string): void {
  if (!inTauri) {
    console.info(message)
    return
  }
  void import('@tauri-apps/plugin-log').then((l) => l.info(message), () => {})
}

export async function appVersion(): Promise<string> {
  if (!inTauri) return pkg.version
  const { getVersion } = await import('@tauri-apps/api/app')
  return getVersion()
}

/** `app_info`: where things live, and the smoke run's trace to open. */
export interface AppInfo {
  /** the cache directory the engine runs with (the setting, or the default) */
  cacheDir: string
  defaultCacheDir: string
  enginePath: string
  /** the store files (settings.json, workspace.json, annotations.json) */
  dataDir: string
  logDir: string
  /** `MTKPROF_SMOKE_OPEN` of a smoke run: a trace to open on start */
  smokeOpen: string | null
}

export async function appInfo(): Promise<AppInfo> {
  if (inTauri) return invoke<AppInfo>('app_info')
  return {
    cacheDir: '(engine -cache flag)',
    defaultCacheDir: '(engine -cache flag)',
    enginePath: '(started by hand: dev browser mode)',
    dataDir: 'localStorage',
    logDir: 'browser console',
    smokeOpen: null,
  }
}

/**
 * The webview drops `target="_blank"` links (the engine UI's "Open in plan viz"), so web links
 * that would open a new tab go to the system browser instead. No-op in the dev browser mode.
 */
export function routeExternalLinks(): void {
  if (!inTauri) return
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return
    const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || !/^https?:$/.test(a.protocol)) return
    if (a.target !== '_blank' && a.origin === location.origin) return
    e.preventDefault()
    invoke('open_external_url', { url: a.href }).catch((err) => console.error('open link:', err))
  })
}

export function openReleasesPage(): Promise<void> {
  if (inTauri) return invoke<void>('open_releases_page')
  window.open('https://github.com/davidbudac/mtkprof-desktop/releases', '_blank', 'noopener')
  return Promise.resolve()
}
