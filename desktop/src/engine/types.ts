import type { components } from './api'

/** Schemas of `engine/api/engine.openapi.yaml` (generated into `api.d.ts` by `pnpm gen:api`). */
export type Schemas = components['schemas']
export type Health = Schemas['Health']
export type JobInfo = Schemas['JobInfo']
export type SessionInfo = Schemas['SessionInfo']
export type FileInfo = Schemas['FileInfo']
export type SessionEvent = Schemas['SessionEvent']
export type PromptEvent = Schemas['PromptEvent']
export type LogEvent = Schemas['LogEvent']
export type ErrorEnvelope = Schemas['ErrorEnvelope']
export type SessionOptions = Schemas['SessionOptions']
export type OpenSessionRequest = Schemas['OpenSessionRequest']
export type OpenSessionResponse = Schemas['OpenSessionResponse']
export type CacheItem = Schemas['CacheItem']
export type CacheList = Schemas['CacheList']
export type CacheWipe = Schemas['CacheWipe']

/** What `engine_start`/`engine_restart` answer and `engine://ready` carries. */
export interface EngineInfo {
  addr: string
  token: string
  version: string
  protocol: number
  /** automatic restarts since the app started */
  restarts: number
}

/** `engine://crashed`: the engine exited unexpectedly; the shell restarts it. */
export interface EngineCrashed {
  code: number | null
  signal: number | null
  message: string
}

/** `engine://failed`: the shell gave up (repeated crashes or protocol mismatch). */
export interface EngineFailed {
  message: string
}

/** `engine_status`. */
export interface EngineStatus {
  state: 'stopped' | 'running' | 'crashed' | 'failed'
  pid: number | null
  /** seconds */
  uptime: number | null
  restarts: number
  error: string | null
}

/** Engine flags the app may set (settings); omitted fields keep the default. */
export interface EngineOptions {
  cacheDir?: string
  cacheCap?: string
  planVizUrl?: string
}
