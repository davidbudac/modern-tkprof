import { describe, expect, it } from 'vitest'
import type { ApiClient } from '@lib/data/client'
import type { ConnectionInfo } from './api'
import { type EngineDef } from './model'
import { Registry } from './registry'

const client = (): ApiClient => ({ base: '', fetch: () => Promise.reject(new Error('no network')) })
const ssh: EngineDef = { id: 'lab', kind: 'ssh', host: 'dbmint', port: 2200, user: 'oracle', transport: 'auto' }

function fakeApi(held: ConnectionInfo[] = []) {
  const posts: string[] = []
  return {
    posts,
    list: async () => ({ connections: held }),
    register: async (_: ApiClient, def: EngineDef) => {
      await new Promise((r) => setTimeout(r, 5))
      posts.push(def.id + ':' + def.port)
    },
  }
}

describe('Registry', () => {
  it('posts a definition once, again only when it changed', async () => {
    const api = fakeApi()
    const r = new Registry(api)
    const cl = client()
    await r.ensure(cl, ssh)
    await r.ensure(cl, ssh)
    await r.ensure(cl, { ...ssh, port: 22 })
    expect(api.posts).toEqual(['lab:2200', 'lab:22'])
  })
  it('concurrent first uses post once', async () => {
    const api = fakeApi()
    const r = new Registry(api)
    const cl = client()
    await Promise.all([r.ensure(cl, ssh), r.ensure(cl, ssh), r.ensure(cl, ssh)])
    expect(api.posts).toEqual(['lab:2200'])
  })
  it('does not replace what the engine already holds (keeps its credentials)', async () => {
    const api = fakeApi([{ ...ssh, port: 2200, user: 'oracle', transport: 'auto', active: 'cli' }])
    const r = new Registry(api)
    await r.ensure(client(), ssh)
    expect(api.posts).toEqual([])
  })
  it('a new client (engine restart) starts over and remembers what was used', async () => {
    const api = fakeApi()
    const r = new Registry(api)
    const a = client()
    const b = client()
    await r.ensure(a, ssh)
    expect(r.isRestart(b)).toBe(true)
    expect([...r.used]).toEqual(['lab'])
    await r.ensure(b, ssh)
    expect(api.posts).toEqual(['lab:2200', 'lab:2200'])
    expect(r.isRestart(b)).toBe(false)
  })
  it('forget makes the next use post again', async () => {
    const api = fakeApi()
    const r = new Registry(api)
    const cl = client()
    await r.ensure(cl, ssh)
    r.forget('lab')
    expect(r.holds('lab')).toBe(false)
    await r.ensure(cl, ssh)
    expect(api.posts).toHaveLength(2)
  })
})
