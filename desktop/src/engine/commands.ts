import { invoke } from '@tauri-apps/api/core'
import { devEngine, inTauri } from '../platform'
import type { EngineInfo, EngineOptions, EngineStatus, Health } from './types'

/** The dev browser mode's "start": the engine given by `?engine=&token=`, asked for its version. */
async function devStart(): Promise<EngineInfo> {
  const e = devEngine()
  if (!e) throw new Error('dev browser mode: open the app with ?engine=127.0.0.1:PORT&token=TOKEN of an engine started by hand')
  const r = await fetch(`http://${e.addr}/engine/health`)
  if (!r.ok) throw new Error(`GET /engine/health: HTTP ${r.status}`)
  const h = (await r.json()) as Health
  return { addr: e.addr, token: e.token, version: h.version, protocol: h.protocol, restarts: 0 }
}

/** Tauri commands of `src-tauri/src/engine.rs` and `lib.rs` (the dev browser mode answers start/restart itself). */
export const engineStart = (opts?: EngineOptions) => (inTauri ? invoke<EngineInfo>('engine_start', { opts }) : devStart())
export const engineRestart = (opts?: EngineOptions) =>
  inTauri ? invoke<EngineInfo>('engine_restart', { opts }) : devStart()
export const engineStop = () => invoke<void>('engine_stop')
export const engineStatus = () => invoke<EngineStatus>('engine_status')
/** Kills the engine as a crash would; debug builds and `MTKPROF_SMOKE=1` only. */
export const engineKill = () => invoke<void>('engine_kill')
export const engineDevTools = () => (inTauri ? invoke<boolean>('engine_dev_tools') : Promise.resolve(false))
export { openReleasesPage } from '../platform'

/** The Tauri events the shell emits about the engine. */
export const EV_READY = 'engine://ready'
export const EV_CRASHED = 'engine://crashed'
export const EV_FAILED = 'engine://failed'

/**
 * The assistant's key commands of `src-tauri/src/secrets.rs` (Tauri only). Rust answers an
 * `apikey` prompt with a key remembered in the OS keychain itself, so it never reaches the page.
 */
export type KeyAnswer = { status: 'answered' } | { status: 'missing'; keychain: boolean }
/** where a typed key was kept besides the engine's memory */
export type KeyKept = 'keychain' | 'session' | 'engine'
export const assistKeyAnswer = (promptId: string, provider: string) => invoke<KeyAnswer>('assist_key_answer', { promptId, provider })
export const assistKeyStoreAndAnswer = (promptId: string, provider: string, key: string, remember: boolean) =>
  invoke<KeyKept>('assist_key_store_and_answer', { promptId, provider, key, remember })
export const assistKeyForget = (provider: string) => invoke<void>('assist_key_forget', { provider })
