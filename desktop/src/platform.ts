import pkg from '../package.json'
import { inApp, invoke, listen, pathForFile, type UnlistenFn } from './shell'

/**
 * What the app needs from the Electron shell (`src/shell.ts`), with a fallback for the dev browser
 * mode: without the shell (`pnpm dev` in a browser) and with `?engine=HOST:PORT&token=TOKEN` in the
 * URL the app talks to an engine started by hand, keeps its stores in localStorage and takes paths
 * from a text box instead of the file dialog.
 */
export { inApp, listen }

/** `?engine=&token=` of the dev browser mode, else null. */
export function devEngine(): { addr: string; token: string } | null {
  if (inApp) return null
  const q = new URLSearchParams(location.search)
  const addr = q.get('engine')
  const token = q.get('token')
  return addr && token ? { addr, token } : null
}

// ---- key-value stores (electron/store.ts: <app data dir>/<name>; dev browser: localStorage) ----

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
  if (!p) kvs.set(name, (p = inApp ? appKV(name) : Promise.resolve(localKV(name))))
  return p
}

/** The page's copy of the store; every change also goes to the shell, which writes the file. */
async function appKV(name: string): Promise<KV> {
  const data = new Map(Object.entries(await invoke<Record<string, unknown>>('store_load', { name })))
  return {
    get: async <T>(k: string) => (data.has(k) ? (structuredClone(data.get(k)) as T) : undefined),
    async set(k, v) {
      data.set(k, structuredClone(v))
      await invoke('store_set', { name, key: k, value: v })
    },
    async delete(k) {
      data.delete(k)
      await invoke('store_delete', { name, key: k })
    },
    keys: async () => [...data.keys()],
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

export interface DialogFilter {
  name: string
  extensions: string[]
}

/** The shell's open dialog: the picked paths, or null when cancelled. A picked file may be read for the rest of the run. */
export function openDialog(o: { directory?: boolean; multiple?: boolean; title?: string; filters?: DialogFilter[] }): Promise<string[] | null> {
  return invoke<string[] | null>('dialog_open', o)
}

/** The shell's save dialog (in the downloads folder): the path, which may then be written, or null when cancelled. */
export function saveDialog(o: { defaultName?: string; title?: string; filters?: DialogFilter[] }): Promise<string | null> {
  return invoke<string | null>('dialog_save', o)
}

/** A text file picked in a dialog, the team file, or one of the app's own. */
export const readTextFile = (path: string) => invoke<string>('fs_read_text', { path })

/** Trace files (or, with `directory`, folders of them) from the open dialog; null when cancelled or in the dev browser. */
export async function pickPaths(directory: boolean): Promise<string[] | null> {
  if (!inApp) return null
  return openDialog(
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
}

/** One folder from the dialog (the cache location); null when cancelled or in the dev browser. */
export async function pickFolder(title: string): Promise<string | null> {
  if (!inApp) return null
  const r = await openDialog({ directory: true, multiple: false, title })
  return r?.[0] ?? null
}

export type DropState = { over: boolean; paths?: string[] }

const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files') ?? false

/**
 * Files dropped on the window, with their paths (the shell's webUtils gives a dropped File its
 * path; a browser gives none). The window takes every file drag, so a drop never loads the file.
 */
export async function onDrop(fn: (e: DropState) => void): Promise<UnlistenFn> {
  if (!inApp) return () => {}
  // dragenter/dragleave fire for every element crossed: count them to know when the drag left the window
  let depth = 0
  const enter = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (depth++ === 0) fn({ over: true })
  }
  const over = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
  }
  const leave = (e: DragEvent) => {
    if (!hasFiles(e)) return
    if (--depth <= 0) {
      depth = 0
      fn({ over: false })
    }
  }
  const drop = (e: DragEvent) => {
    if (!hasFiles(e)) return
    e.preventDefault()
    depth = 0
    const paths = [...(e.dataTransfer?.files ?? [])].map(pathForFile).filter((p): p is string => !!p)
    fn({ over: false, paths })
  }
  window.addEventListener('dragenter', enter)
  window.addEventListener('dragover', over)
  window.addEventListener('dragleave', leave)
  window.addEventListener('drop', drop)
  return () => {
    window.removeEventListener('dragenter', enter)
    window.removeEventListener('dragover', over)
    window.removeEventListener('dragleave', leave)
    window.removeEventListener('drop', drop)
  }
}

/**
 * Trace sets handed to the app from outside (its command line, a second launch, the Finder, `mtkprof open`),
 * queued in the shell until taken; empty in the dev browser.
 */
export function takeOpenRequests(): Promise<string[][]> {
  return inApp ? invoke<string[][]>('take_open_requests') : Promise.resolve([])
}

/** Called when an open request is queued (`app://open`). */
export function onOpenRequest(fn: () => void): Promise<UnlistenFn> {
  return listen<null>('app://open', () => fn())
}

/** A line in the app log (electron/log.ts: stdout and the log dir); CI's smoke step waits on some. */
export function logInfo(message: string): void {
  if (!inApp) {
    console.info(message)
    return
  }
  invoke('log', { level: 'info', message }).catch(() => {})
}

/** A warning in the app log; the release window has no console to read. */
export function logWarn(message: string): void {
  if (!inApp) {
    console.warn(message)
    return
  }
  invoke('log', { level: 'warn', message }).catch(() => {})
}

export async function appVersion(): Promise<string> {
  if (!inApp) return pkg.version
  return invoke<string>('app_version')
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
  if (inApp) return invoke<AppInfo>('app_info')
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
 * Web links that would open a new tab or leave the app (the engine UI's "Open in plan viz") go to
 * the system browser instead; the shell also denies new windows and navigation away, so this only
 * makes the click do it at once. No-op in the dev browser mode.
 */
export function routeExternalLinks(): void {
  if (!inApp) return
  window.addEventListener(
    'click',
    (e) => {
      if (e.button !== 0) return
      const a = (e.target as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null
      if (!a || !/^https?:$/.test(a.protocol)) return
      if (a.target !== '_blank' && a.origin === location.origin) return
      e.preventDefault()
      e.stopPropagation()
      invoke('open_external_url', { url: a.href }).catch((err) => logWarn(`open link: ${err}`))
    },
    true,
  )
}

export function openReleasesPage(): Promise<void> {
  if (inApp) return invoke<void>('open_releases_page')
  window.open('https://github.com/davidbudac/modern-tkprof/releases', '_blank', 'noopener')
  return Promise.resolve()
}
