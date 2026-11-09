// Where the app keeps its files. The same folders the Tauri shell used (its app_data_dir,
// app_cache_dir, app_log_dir under the bundle identifier), so settings, workspace, annotations,
// connections and the index cache survive the switch to Electron.

import { app } from 'electron'
import os from 'node:os'
import path from 'node:path'

export const IDENTIFIER = 'com.davidbudac.mtkprof'

const home = os.homedir()
const env = (k: string) => (process.env[k] ? process.env[k]! : undefined)

function base(kind: 'data' | 'cache' | 'localData'): string {
  switch (process.platform) {
    case 'darwin':
      return kind === 'cache' ? path.join(home, 'Library', 'Caches') : path.join(home, 'Library', 'Application Support')
    case 'win32':
      return kind === 'data'
        ? env('APPDATA') ?? path.join(home, 'AppData', 'Roaming')
        : env('LOCALAPPDATA') ?? path.join(home, 'AppData', 'Local')
    default:
      return kind === 'cache'
        ? env('XDG_CACHE_HOME') ?? path.join(home, '.cache')
        : env('XDG_DATA_HOME') ?? path.join(home, '.local', 'share')
  }
}

/**
 * `MTKPROF_PROFILE=<dir>` (dev and smoke runs only): data, cache and logs under `<dir>`, so a test
 * run neither reads nor changes the user's own tabs, settings and keys.
 */
function profile(): string | null {
  const p = process.env.MTKPROF_PROFILE
  return p && (!app?.isPackaged || process.env.MTKPROF_SMOKE === '1') ? path.resolve(p) : null
}

/** settings.json, workspace.json, annotations.json, connections, library, secrets */
export const dataDir = () => (profile() ? path.join(profile()!, 'data') : path.join(base('data'), IDENTIFIER))
/** the default engine cache (`<cache>/mtkprof`), reports, cuts */
export const cacheDir = () => (profile() ? path.join(profile()!, 'cache') : path.join(base('cache'), IDENTIFIER))
export const logDir = () =>
  profile()
    ? path.join(profile()!, 'logs')
    : process.platform === 'darwin'
      ? path.join(home, 'Library', 'Logs', IDENTIFIER)
      : path.join(base('localData'), IDENTIFIER, 'logs')

/** Called before `ready`: Electron's own files (Chromium's caches, local storage) go under the cache dir, not among the stores. */
export function setElectronPaths(): void {
  app.setPath('userData', dataDir())
  app.setPath('sessionData', path.join(cacheDir(), 'chromium'))
  app.setAppLogsPath(logDir())
}

/** `<dir>/<name>` when it stays inside `dir`, else null (`..`, absolute names, separators). */
export function inside(dir: string, name: string): string | null {
  if (!name || name !== path.basename(name) || name === '.' || name === '..') return null
  return path.join(dir, name)
}

/** `p` is `dir` or below it. */
export function isUnder(p: string, dir: string): boolean {
  const rel = path.relative(dir, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
