/**
 * A bounded queue of tab starts. Restoring a workspace (or re-opening every tab after an engine
 * restart) starts many distinct traces at once, each parsed and indexed by the engine; the queue
 * lets only `limit` of them run, the active tab first. A start is "running" until its promise
 * settles (the workspace resolves it when the tab has left `opening`), and a failed start releases
 * its slot like a finished one. A key whose tab was closed while it waited is skipped.
 * Pure: it knows nothing of tabs or the engine.
 */
export class OpenQueue {
  private pending: string[] = []
  private running = new Set<string>()
  private cleared = false

  /**
   * @param start begins the key's open and settles when it is done (ready, failed or gone)
   * @param exists whether the key's tab is still there (checked again when the key is dequeued)
   */
  constructor(
    private start: (key: string) => Promise<unknown>,
    private exists: (key: string) => boolean,
    readonly limit = 2,
  ) {}

  /** Queues keys in order behind those already waiting; `first` keys go in front of all of them (in order). */
  add(keys: string[], first = false) {
    if (this.cleared) return
    const fresh = keys.filter((k, i) => !this.running.has(k) && keys.indexOf(k) === i)
    this.pending = first
      ? [...fresh, ...this.pending.filter((k) => !fresh.includes(k))]
      : [...this.pending, ...fresh.filter((k) => !this.pending.includes(k))]
    this.pump()
  }

  /** Moves a waiting key to the front (the user switched to its tab); a running or unknown key is left alone. */
  prioritize(key: string) {
    const i = this.pending.indexOf(key)
    if (i > 0) this.pending = [key, ...this.pending.slice(0, i), ...this.pending.slice(i + 1)]
  }

  /** Forgets the waiting keys and takes no more (the engine they were for is gone); running starts finish by themselves. */
  clear() {
    this.cleared = true
    this.pending = []
  }

  /** Whether `key` waits in the queue (not yet started). */
  waiting(key: string) {
    return this.pending.includes(key)
  }

  /** How many starts run now. */
  get active() {
    return this.running.size
  }

  /** How many wait. */
  get queued() {
    return this.pending.length
  }

  private pump() {
    while (!this.cleared && this.running.size < this.limit) {
      const key = this.pending.shift()
      if (key === undefined) return
      if (!this.exists(key)) continue // closed while it waited
      this.running.add(key)
      let done: Promise<unknown>
      try {
        done = Promise.resolve(this.start(key))
      } catch (e) {
        done = Promise.reject(e)
      }
      void done
        .catch(() => {}) // a failed start is the tab's own state; it must not hold its slot
        .finally(() => {
          this.running.delete(key)
          this.pump()
        })
    }
  }
}
