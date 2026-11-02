// The standalone app's Back/Forward come from browser history (the lib's urlstate, web/src/lib/shell/urlstate.ts, startUrlSync); the
// desktop has no URL bar, so each tab keeps the same entries (hashes) and the same push-or-replace rules in memory.
import { apply, hashOf, type Store, type TraceDoc, type State } from '@lib'

/** Entries kept per tab; the oldest fall off. */
const CAP = 100

let inputSeq = 0
let listening = false

/** Counts a user input (pointer or key); tests call it to stand for one. */
export function noteUserInput(): void { inputSeq++ }

/** One page-wide listener, in the capture phase so it runs before the handlers that act on the same event. */
function listenForInput() {
  if (listening || typeof window === 'undefined') return
  listening = true
  window.addEventListener('pointerdown', noteUserInput, { capture: true })
  window.addEventListener('keydown', noteUserInput, { capture: true })
}

/** What the Back / Forward buttons show. */
export interface NavSnapshot { canBack: boolean; canForward: boolean }

/**
 * One store's view history: every change of view, selection, files or compare side pushes an entry; a changed window only,
 * a first auto-picked statement or stepping through the lines of one file replaces the current one, so brushing does not
 * flood Back. After back() / forward() the views settle on their own (they re-pick a statement, resolve a line, ...); those
 * store writes are not recorded until the next user input. A new document of the same trace (live update, engine restart) is tracked without re-applying anything.
 */
export class NavHistory {
  private entries: string[] = []
  private index = -1
  private doc: TraceDoc | null = null
  private prev: Key | null = null // what the store showed at the last update
  private applying = false // store updates caused by back() / forward() must not record themselves
  private navSeq = -1 // `inputSeq` at the last back() / forward(): until it moves, store writes are the views settling
  private pushNext = false // inside move(): the next recorded change is an entry of its own
  private snap: NavSnapshot = { canBack: false, canForward: false }
  private listeners = new Set<() => void>()

  constructor(private store: Store) {
    listenForInput()
    const s = store.getState()
    if (s.doc) this.start(s.doc, s)
    store.subscribe(() => this.onStore())
  }

  get canBack(): boolean { return this.index > 0 }
  get canForward(): boolean { return this.index >= 0 && this.index < this.entries.length - 1 }
  /** The hash of the entry the history is at; changes with every push and every step. */
  get current(): string { return this.entries[this.index] ?? '' }

  back(): void { this.go(this.index - 1) }
  forward(): void { this.go(this.index + 1) }

  subscribe = (l: () => void): (() => void) => {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  /** Stable between changes, for `useSyncExternalStore`. */
  getSnapshot = (): NavSnapshot => this.snap

  /**
   * Runs `change`, a move of the views that no click or key caused (the assistant's "show me"). The views as they stand are kept
   * as the entry Back returns to, and the move is an entry of its own even when it changes only the window or a first pick.
   */
  move(change: () => void): void {
    if (!this.doc) return change()
    this.record(true)
    this.navSeq = -1
    this.pushNext = true
    try { change() } finally { this.pushNext = false }
  }

  private start(doc: TraceDoc, s: State) {
    this.doc = doc
    this.entries = [hashOf(doc, s)]
    this.prev = keyOf(this.entries[0])
    this.index = 0
    this.emit()
  }

  private go(i: number) {
    if (!this.doc || i < 0 || i >= this.entries.length) return
    this.index = i
    this.applying = true
    try {
      this.doc = apply(this.store, this.doc, this.entries[i])
      // urlstate only knows the engine's views
      const view = new URLSearchParams(this.entries[i].slice(1)).get('view')
      if ((view === 'annotations' || view === 'reports') && this.store.getState().view !== view) this.store.setState({ view })
    } finally { this.applying = false }
    this.navSeq = inputSeq
    this.entries[i] = hashOf(this.doc, this.store.getState()) // what the store could show of it (unknown ids are dropped)
    this.prev = keyOf(this.entries[i])
    this.emit()
  }

  private record(replace: boolean) {
    const doc = this.doc
    if (!doc) return
    const hash = hashOf(doc, this.store.getState())
    if (hash === this.entries[this.index]) return
    if (replace) this.entries[this.index] = hash
    else {
      this.entries.length = this.index + 1 // a new push drops the forward entries
      this.entries.push(hash)
      if (this.entries.length > CAP) this.entries.shift()
      this.index = this.entries.length - 1
    }
    this.emit()
  }

  private onStore() {
    if (this.applying) return
    const s = this.store.getState()
    const old = this.doc
    if (s.doc !== old) {
      if (old && s.doc && s.compare && (s.doc === s.compare.a || s.doc === s.compare.b) && (old === s.compare.a || old === s.compare.b)) {
        // the A/B toggle: the store already holds the new selection, record it
        this.doc = s.doc
        this.prev = keyOf(hashOf(s.doc, s))
        this.record(false)
        return
      }
      if (!s.doc) { this.doc = null; this.prev = null; return }
      if (!old) { this.start(s.doc, s); return }
      // a newer document of the same trace: ids and names in the entries still stand; what carryOver dropped updates this one
      this.doc = s.doc
      this.prev = keyOf(hashOf(s.doc, s))
      this.record(true)
      return
    }
    const doc = this.doc
    if (!doc || !this.prev) return
    const a = this.prev, b = keyOf(hashOf(doc, s))
    if (inputSeq === this.navSeq) { this.prev = b; return } // the views settling after back() / forward()
    const onlyWindow = a.view === b.view && a.sql === b.sql && a.ev === b.ev
    const firstPick = a.view === b.view && a.sql === '' && b.sql !== '' && a.ev === b.ev
    const lineStep = a.view === 'lines' && b.view === 'lines' && a.file === b.file // clicking through lines must not flood Back
    this.prev = b
    const push = this.pushNext
    this.pushNext = false
    this.record(!push && (onlyWindow || firstPick || lineStep))
  }

  private emit() {
    const canBack = this.canBack, canForward = this.canForward
    if (canBack !== this.snap.canBack || canForward !== this.snap.canForward) this.snap = { canBack, canForward }
    for (const l of this.listeners) l()
  }
}

type Key = { view: string; sql: string; ev: string; file: string }

/** The parts of a hash that decide push or replace. */
function keyOf(hash: string): Key {
  const p = new URLSearchParams(hash.slice(1))
  return { view: p.get('view') ?? 'overview', sql: p.get('sql') ?? '', ev: p.get('ev') ?? '', file: p.get('file') ?? '0' }
}

const histories = new WeakMap<Store, NavHistory>()

/** The store's history, created on first use and kept as long as the store lives (a tab's views come and go with the visible tab). */
export function navHistoryOf(store: Store): NavHistory {
  let h = histories.get(store)
  if (!h) histories.set(store, (h = new NavHistory(store)))
  return h
}
