import type { ApiClient } from '@lib/data/client'
import type { ConnectionInfo } from './api'
import { type EngineDef, infoToDef } from './model'

interface RegistryApi {
  list(cl: ApiClient): Promise<{ connections: ConnectionInfo[] }>
  register(cl: ApiClient, def: EngineDef): Promise<unknown>
}

/**
 * Which definitions the current engine run holds. A definition is posted on first use and again
 * when it changed; an identical one is never posted twice, because replacing a connection drops
 * the credentials the engine keeps for it. A new client (engine restart: new address and token)
 * starts empty, seeded once from `GET /engine/connections` (a reloaded window finds the
 * connections it registered before). `used` remembers every id registered in this window, for
 * registering them again after a restart.
 */
export class Registry {
  private cl: ApiClient | null = null
  private defs = new Map<string, string>()
  private seeded: Promise<void> = Promise.resolve()
  private inflight = new Map<string, Promise<void>>()
  readonly used = new Set<string>()

  constructor(private api: RegistryApi) {}

  private bind(cl: ApiClient) {
    if (cl === this.cl) return
    this.cl = cl
    this.defs = new Map()
    this.inflight = new Map()
    this.seeded = this.api.list(cl).then(
      (r) => {
        if (this.cl !== cl) return
        for (const info of r.connections) if (!this.defs.has(info.id)) this.defs.set(info.id, JSON.stringify(infoToDef(info)))
      },
      () => {},
    )
  }

  async ensure(cl: ApiClient, def: EngineDef): Promise<void> {
    this.bind(cl)
    await this.seeded
    if (this.cl !== cl) return this.ensure(cl, def)
    const key = JSON.stringify(def)
    if (this.defs.get(def.id) === key) {
      this.used.add(def.id)
      return
    }
    const prev = this.inflight.get(def.id)
    if (prev) {
      await prev.catch(() => {})
      return this.ensure(cl, def)
    }
    const p = this.api.register(cl, def).then(() => {
      if (this.cl === cl) this.defs.set(def.id, key)
    })
    this.inflight.set(def.id, p)
    try {
      await p
      this.used.add(def.id)
    } finally {
      if (this.inflight.get(def.id) === p) this.inflight.delete(def.id)
    }
  }

  /** The engine no longer holds `id` (deleted, or it answered 404). */
  forget(id: string) {
    this.defs.delete(id)
  }

  holds(id: string): boolean {
    return this.defs.has(id)
  }

  /** Whether `cl` is a different engine run than the last one used (and there was one). */
  isRestart(cl: ApiClient): boolean {
    return this.cl !== null && this.cl !== cl
  }
}
