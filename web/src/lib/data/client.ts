/**
 * Where an engine or `mtkprof serve` is and how to talk to it. `base` is the server root
 * (`''` = this origin, `http://127.0.0.1:8046/s/1` = one session of the desktop engine);
 * paths passed to `fetch` start with `/api/...`.
 */
export interface ApiClient {
  base: string
  token?: string
  fetch(path: string, init?: RequestInit): Promise<Response>
}

/** `base` + `path` with exactly one slash between; an empty base leaves the path (same origin) as it is. */
export function joinUrl(base: string, path: string): string {
  if (base === '') return path
  return base.replace(/\/+$/, '') + (path.startsWith('/') ? path : '/' + path)
}

export function createClient(base: string, token?: string): ApiClient {
  return {
    base,
    token,
    fetch(path, init) {
      const url = joinUrl(base, path)
      if (!token) return fetch(url, init)
      const headers = new Headers(init?.headers)
      headers.set('authorization', `Bearer ${token}`)
      return fetch(url, { ...init, headers })
    },
  }
}
