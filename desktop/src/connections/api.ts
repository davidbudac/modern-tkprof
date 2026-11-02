import type { ApiClient } from '@lib/data/client'
import type { ErrorEnvelope, JobInfo, Schemas, SessionInfo } from '../engine'
import type { EngineDef } from './model'

/** An engine error with its envelope code (`remote` 502, `needs_prompt` 428, `cancelled` 409, ...). */
export class EngineError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function call<T>(client: ApiClient, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, signal }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  let r: Response
  try {
    r = await client.fetch(path, init)
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e
    throw new EngineError(0, 'unreachable', `engine not reachable: ${(e as Error).message}`)
  }
  if (!r.ok) {
    let code = `http_${r.status}`
    let message = `${method} ${path}: HTTP ${r.status}`
    try {
      const env = (await r.json()) as ErrorEnvelope
      if (env?.error?.message) {
        code = env.error.code
        message = env.error.message
      }
    } catch {
      // not an envelope
    }
    throw new EngineError(r.status, code, message)
  }
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}

const c = (id: string) => `/engine/connections/${encodeURIComponent(id)}`

export type ConnectionInfo = Schemas['ConnectionInfo']
export type ConnectionTest = Schemas['ConnectionTest']
export type RemoteListing = Schemas['RemoteListing']
export type RemoteEntry = Schemas['RemoteEntry']
export type DBSession = Schemas['DBSession']
export type DBTraceFile = Schemas['DBTraceFile']
export type PlanStat = 'never' | 'first_execution' | 'all_executions'

export interface TraceRequest {
  sid?: number
  serial?: number
  self?: boolean
  enable: boolean
  waits?: boolean
  binds?: boolean
  planStat?: PlanStat
}

/** The `/engine/connections*` routes and `POST /s/{id}/api/ref` (api/engine.openapi.yaml). */
export const remoteApi = {
  list: (cl: ApiClient) => call<{ connections: ConnectionInfo[] }>(cl, 'GET', '/engine/connections'),
  register: (cl: ApiClient, def: EngineDef) => call<{ connection: ConnectionInfo }>(cl, 'POST', '/engine/connections', def),
  remove: (cl: ApiClient, id: string) => call<void>(cl, 'DELETE', c(id)),
  test: (cl: ApiClient, id: string) => call<ConnectionTest>(cl, 'POST', `${c(id)}/test`),
  ls: (cl: ApiClient, id: string, path: string, signal?: AbortSignal) =>
    call<RemoteListing>(cl, 'GET', `${c(id)}/ls?path=${encodeURIComponent(path)}`, undefined, signal),
  diag: (cl: ApiClient, id: string) => call<{ dirs: string[]; adrHome?: string }>(cl, 'GET', `${c(id)}/diag`),
  fetchSsh: (cl: ApiClient, id: string, paths: string[], gzip = true) =>
    call<{ job: JobInfo; localPaths: string[] }>(cl, 'POST', `${c(id)}/fetch`, { paths, gzip }),
  fetchDb: (cl: ApiClient, id: string, name: string, adrHome?: string) =>
    call<{ job: JobInfo; localPaths: string[] }>(cl, 'POST', `${c(id)}/fetch`, adrHome ? { adrHome, name } : { name }),
  follow: (cl: ApiClient, id: string, path: string) =>
    call<{ session?: SessionInfo; job: JobInfo; localPath: string }>(cl, 'POST', `${c(id)}/follow`, { path }),
  tracefiles: (cl: ApiClient, id: string, q: { sid?: number; serial?: number; since?: string }) => {
    const p = new URLSearchParams()
    if (q.sid != null) p.set('sid', String(q.sid))
    if (q.serial != null) p.set('serial', String(q.serial))
    if (q.since) p.set('since', q.since)
    const qs = p.toString()
    return call<{ files: DBTraceFile[] }>(cl, 'GET', `${c(id)}/tracefiles${qs ? '?' + qs : ''}`)
  },
  sessions: (cl: ApiClient, id: string) => call<{ sessions: DBSession[] }>(cl, 'GET', `${c(id)}/sessions`),
  trace: (cl: ApiClient, id: string, req: TraceRequest) => call<{ enabled: boolean; traceFile?: string }>(cl, 'POST', `${c(id)}/trace`, req),
  ref: (cl: ApiClient, session: string, body: { connection: string; lite?: boolean } | { dir: string }) =>
    call<{ job: JobInfo }>(cl, 'POST', `/s/${encodeURIComponent(session)}/api/ref`, body),
  sessionsList: (cl: ApiClient) => call<{ sessions: SessionInfo[] }>(cl, 'GET', '/engine/sessions'),
  jobs: (cl: ApiClient) => call<{ jobs: JobInfo[] }>(cl, 'GET', '/engine/jobs'),
  cancelJob: (cl: ApiClient, id: string) => call<{ job: JobInfo }>(cl, 'DELETE', `/engine/jobs/${encodeURIComponent(id)}`),
  answerPrompt: (cl: ApiClient, id: string, body: { answer: string } | { cancel: true }) =>
    call<void>(cl, 'POST', `/engine/prompts/${encodeURIComponent(id)}`, body),
}

/** A short, human message for an error from these routes. */
export function errorText(e: unknown): string {
  if (e instanceof EngineError) {
    switch (e.code) {
      case 'cancelled':
        return 'cancelled'
      case 'remote':
        return e.message
      case 'needs_prompt':
        return `needs an answer to a prompt: ${e.message}`
      default:
        return e.message
    }
  }
  return e instanceof Error ? e.message : String(e)
}
