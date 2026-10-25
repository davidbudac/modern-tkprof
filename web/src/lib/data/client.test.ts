import { afterEach, describe, expect, it, vi } from 'vitest'
import { createClient, joinUrl } from './client'

afterEach(() => vi.unstubAllGlobals())

function stubFetch() {
  const f = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'))
  vi.stubGlobal('fetch', f)
  return f
}

describe('joinUrl', () => {
  it('leaves the path alone for the relative client', () => {
    expect(joinUrl('', '/api/lines?from=1&n=1')).toBe('/api/lines?from=1&n=1')
  })
  it('puts exactly one slash between base and path', () => {
    expect(joinUrl('http://127.0.0.1:9/s/1', '/api/doc')).toBe('http://127.0.0.1:9/s/1/api/doc')
    expect(joinUrl('http://127.0.0.1:9/s/1/', '/api/doc')).toBe('http://127.0.0.1:9/s/1/api/doc')
    expect(joinUrl('http://127.0.0.1:9', 'api/doc')).toBe('http://127.0.0.1:9/api/doc')
  })
})

describe('createClient', () => {
  it('requests the same URL as a bare fetch when the base is empty, with no authorization', async () => {
    const f = stubFetch()
    await createClient('').fetch('/api/doc', { headers: { accept: 'application/json' } })
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('/api/doc')
    expect(new Headers(init?.headers).get('authorization')).toBeNull()
  })

  it('joins the base and adds the bearer token next to the caller headers', async () => {
    const f = stubFetch()
    await createClient('http://127.0.0.1:9/s/1', 'tok').fetch('/api/doc', { headers: { accept: 'application/json' } })
    const [url, init] = f.mock.calls[0]
    expect(url).toBe('http://127.0.0.1:9/s/1/api/doc')
    const h = new Headers(init?.headers)
    expect(h.get('authorization')).toBe('Bearer tok')
    expect(h.get('accept')).toBe('application/json')
  })

  it('passes the AbortSignal through', async () => {
    const f = stubFetch()
    const ac = new AbortController()
    await createClient('http://h', 'tok').fetch('/api/x', { signal: ac.signal })
    await createClient('').fetch('/api/x', { signal: ac.signal })
    expect(f.mock.calls[0][1]?.signal).toBe(ac.signal)
    expect(f.mock.calls[1][1]?.signal).toBe(ac.signal)
  })
})
