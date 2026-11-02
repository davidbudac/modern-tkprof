import { followLive, type LiveFollow, type Session } from '@lib'

/** The part of a lib session a follow needs. */
export type FollowSession = Pick<Session, 'store' | 'client'>

export interface FollowHooks {
  /** the shown revision changed (a snapshot was swapped in) */
  onRev?: (rev: number) => void
  /** the follow ended by itself (the engine stopped it, the session is gone); not called by `stop` */
  onEnd?: () => void
}

type StartFollow = (session: FollowSession, rev: number) => LiveFollow

/**
 * The live tabs' long polls: one `followLive` per tab (lib: `GET api/doc?rev=` kept open, the document swapped in
 * with scope and selection kept, backoff on errors, pause/resume from the badge). A background tab keeps following:
 * its badge and data are current when it is shown again, and the poll costs the engine nothing while the file is idle.
 * `stop` (tab closed, engine restarted, session failed) aborts the request on its way.
 */
export class LiveFollower {
  private follows = new Map<string, { follow: LiveFollow; off: () => void }>()

  constructor(private start: StartFollow = (s, rev) => followLive(s, rev)) {}

  has(key: string): boolean {
    return this.follows.has(key)
  }

  /** Follows `session` from the revision it shows; replaces a follow the tab already has. */
  follow(key: string, session: FollowSession, rev: number, hooks: FollowHooks = {}): void {
    this.stop(key)
    const follow = this.start(session, rev)
    let last = rev
    const off = session.store.subscribe(() => {
      const r = session.store.getState().live?.rev
      if (r !== undefined && r !== last) {
        last = r
        hooks.onRev?.(r)
      }
    })
    const entry = { follow, off }
    this.follows.set(key, entry)
    void follow.done.then(() => {
      off()
      if (this.follows.get(key) !== entry) return // stopped or replaced meanwhile
      this.follows.delete(key)
      hooks.onEnd?.()
    })
  }

  stop(key: string): void {
    const f = this.follows.get(key)
    if (!f) return
    this.follows.delete(key)
    f.off()
    f.follow.stop()
  }

  stopAll(): void {
    for (const key of [...this.follows.keys()]) this.stop(key)
  }
}
