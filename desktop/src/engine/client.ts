import { createClient, type ApiClient } from '@lib/data/client'
import type { ErrorEnvelope, Health } from './types'

/** An `ApiClient` for the engine root (`/engine/*`); `sessionClient` is the one for `/s/{id}`. */
export function engineClient(addr: string, token: string): ApiClient {
  return createClient(`http://${addr}`, token)
}

export function sessionClient(addr: string, token: string, session: string): ApiClient {
  return createClient(`http://${addr}/s/${encodeURIComponent(session)}`, token)
}

/** The engine's error envelope as an Error (`code: message`), else the HTTP status. */
export async function responseError(r: Response, what: string): Promise<Error> {
  try {
    const e = (await r.json()) as ErrorEnvelope
    if (e?.error?.message) return new Error(`${what}: ${e.error.code}: ${e.error.message}`)
  } catch {
    // not an envelope
  }
  return new Error(`${what}: HTTP ${r.status}`)
}

export async function getJSON<T>(client: ApiClient, path: string, signal?: AbortSignal): Promise<T> {
  const r = await client.fetch(path, { signal })
  if (!r.ok) throw await responseError(r, `GET ${path}`)
  return (await r.json()) as T
}

export const fetchHealth = (client: ApiClient, signal?: AbortSignal) => getJSON<Health>(client, '/engine/health', signal)

/**
 * A request with a JSON body (or none) to the engine: the answer's JSON, or undefined for 204;
 * an error envelope becomes an Error (`code: message`).
 */
export async function send<T = void>(client: ApiClient, method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const init: RequestInit = { method, signal }
  if (body !== undefined) {
    init.body = JSON.stringify(body)
    init.headers = { 'content-type': 'application/json' }
  }
  const r = await client.fetch(path, init)
  if (!r.ok) throw await responseError(r, `${method} ${path}`)
  if (r.status === 204) return undefined as T
  return (await r.json()) as T
}
