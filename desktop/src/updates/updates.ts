import { useSyncExternalStore } from 'react'
import { engineStop } from '../engine/commands'
import { inApp, logInfo, logWarn } from '../platform'
import { invoke } from '../shell'

/**
 * The app's updates: the shell (`electron/updates.ts`) compares the newest GitHub release with the
 * app's version. One check on start (the `updateCheck` setting), more from Settings → About. The
 * Electron app does not install updates itself yet (`installsItself`): "Download" opens the
 * release page with the installers. The download/install states stay for an in-place updater.
 *
 * Dev browser mode: no updater; `?mock=update` pretends a newer version exists, to look at the UI.
 */

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  /** no newer version than the app's */
  | { kind: 'current'; at: number }
  | { kind: 'available'; version: string; current: string; date?: string }
  | { kind: 'downloading'; version: string; done: number; total: number | null }
  | { kind: 'installing'; version: string }
  | { kind: 'error'; message: string; during: 'check' | 'install'; version?: string }

/** what `check` and `install` need of the plugin's Update object (and of the mock) */
interface Pending {
  version: string
  currentVersion: string
  date?: string
  download(onEvent: (e: DownloadEvent) => void): Promise<void>
  install(): Promise<void>
}
type DownloadEvent =
  | { event: 'Started'; data: { contentLength?: number } }
  | { event: 'Progress'; data: { chunkLength: number } }
  | { event: 'Finished' }

let state: UpdateState = { kind: 'idle' }
let pending: Pending | null = null
const listeners = new Set<() => void>()

function set(s: UpdateState) {
  state = s
  for (const l of listeners) l()
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => void listeners.delete(l)
}

export function useUpdateState(): UpdateState {
  return useSyncExternalStore(subscribe, () => state)
}

/** The updater is there: the app, or the dev browser with `?mock=update`. */
export const updatesAvailable = inApp || mockUpdate()

/** Installing replaces the app and relaunches it (the mock); false: it opens the release page. */
export const installsItself = !inApp

function mockUpdate(): boolean {
  return typeof location !== 'undefined' && new URLSearchParams(location.search).get('mock') === 'update'
}

export const releaseUrl = (version: string) => `https://github.com/davidbudac/modern-tkprof/releases/tag/v${version}`

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Asks the release feed for a newer version. Not while a download or an install is running. */
export async function checkForUpdate(): Promise<UpdateState> {
  if (!updatesAvailable || state.kind === 'checking' || state.kind === 'downloading' || state.kind === 'installing') return state
  set({ kind: 'checking' })
  try {
    const u = inApp ? await appCheck() : await mockCheck()
    pending = u
    if (!u) {
      set({ kind: 'current', at: Date.now() })
      logInfo('update check: up to date')
    } else {
      set({ kind: 'available', version: u.version, current: u.currentVersion, date: u.date })
      logInfo(`update check: ${u.version} available (this is ${u.currentVersion})`)
    }
  } catch (e) {
    pending = null
    set({ kind: 'error', message: message(e), during: 'check' })
    logWarn(`update check: ${message(e)}`)
  }
  return state
}

async function appCheck(): Promise<Pending | null> {
  const a = await invoke<{ version: string; currentVersion: string; date?: string } | null>('update_check')
  if (!a) return null
  return {
    ...a,
    async download() {},
    async install() {
      await invoke('open_external_url', { url: releaseUrl(a.version) })
    },
  }
}

async function mockCheck(): Promise<Pending> {
  await new Promise((r) => setTimeout(r, 600))
  return {
    version: '9.9.9',
    currentVersion: (await import('../../package.json')).version,
    date: new Date().toISOString(),
    async download(on) {
      const total = 18 * 2 ** 20
      on({ event: 'Started', data: { contentLength: total } })
      for (let done = 0; done < total; done += 2 ** 20) {
        await new Promise((r) => setTimeout(r, 120))
        on({ event: 'Progress', data: { chunkLength: 2 ** 20 } })
      }
      on({ event: 'Finished' })
    },
    async install() {
      throw new Error('dev browser mode (?mock=update): nothing to install')
    },
  }
}

/**
 * Downloads the update, then stops the engine (on Windows the installer replaces its binary) and
 * installs it and relaunches the app. When the install fails the engine is started again
 * (`restartEngine`: the engine context's restart, with the settings' options) and the error is the state.
 */
export async function installUpdate(restartEngine: () => Promise<void>): Promise<void> {
  const u = pending
  if (!u || state.kind !== 'available') return
  const version = u.version
  if (!installsItself) {
    await u.install().catch((e) => logWarn(`update ${version}: open the release page: ${message(e)}`))
    return
  }
  let done = 0
  let total: number | null = null
  set({ kind: 'downloading', version, done, total })
  try {
    await u.download((e) => {
      if (e.event === 'Started') total = e.data.contentLength ?? null
      else if (e.event === 'Progress') done += e.data.chunkLength
      set({ kind: 'downloading', version, done, total })
    })
  } catch (e) {
    set({ kind: 'error', message: `download: ${message(e)}`, during: 'install', version })
    logWarn(`update ${version}: download: ${message(e)}`)
    return
  }
  set({ kind: 'installing', version })
  logInfo(`update ${version}: downloaded ${done} bytes, installing`)
  let stopped = false
  try {
    if (inApp) await engineStop()
    stopped = true
    await u.install()
    if (inApp) await invoke('relaunch')
  } catch (e) {
    set({ kind: 'error', message: `install: ${message(e)}`, during: 'install', version })
    logWarn(`update ${version}: install: ${message(e)}`)
    if (stopped) await restartEngine().catch(() => {})
  }
}
