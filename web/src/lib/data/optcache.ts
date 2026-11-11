// What the 10053 view holds of a source's dumps: the open dump and the one before it, no more. A dump's model and its whole text are megabytes
// (a two-million-line dump is a few hundred MB as strings), so a file of many dumps would otherwise grow with every one opened. This is the one
// place that keeps them: the sources (`httpSource`, `digestSource`, `memoryOptSource`) hold nothing between calls.
import type { OptSource } from './opt'

/** A least-recently-used cache of promises by key, `cap` entries. A load that fails is forgotten, so the next ask tries again. */
export class Recent<T> {
  private readonly m = new Map<number, Promise<T>>()
  constructor(readonly cap = 2) {}

  /** The value for `key`, loaded by `load` when it is not held; asking makes it the most recently used and drops the least recently used beyond `cap`. */
  get(key: number, load: () => Promise<T>): Promise<T> {
    let p = this.m.get(key)
    if (p) {
      this.m.delete(key)
      this.m.set(key, p)
      return p
    }
    p = load()
    const mine = p
    this.m.set(key, mine)
    mine.catch(() => { if (this.m.get(key) === mine) this.m.delete(key) })
    while (this.m.size > this.cap) this.m.delete(this.m.keys().next().value as number)
    return mine
  }

  /** The keys held, least recently used first. */
  keys(): number[] { return [...this.m.keys()] }
}

/** Two dumps: the open one and the previous one. */
export const KEEP_DUMPS = 2

const held = new WeakMap<OptSource, Recent<unknown>>()

/** The cache of a source's loaded dumps; the same object for the same source, so a tab that is shown again finds its dumps and a closed one lets them go. */
export function dumpCacheOf<T>(source: OptSource): Recent<T> {
  let c = held.get(source)
  if (!c) { c = new Recent<unknown>(KEEP_DUMPS); held.set(source, c) }
  return c as Recent<T>
}
