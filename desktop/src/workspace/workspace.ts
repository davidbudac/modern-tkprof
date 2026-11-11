import { createSession, filesFolded, fromRaw, inShellFilesWrite, mergeAnnotations, mergeBookmarks, type Bookmark, type NoteAction, type Opt10046Link, type Opt10053Link, type RawCompareDocument, type RawDocument, type Session, type TraceDoc } from '@lib'
import type { ApiClient } from '@lib/data/client'
import { getJSON, responseError, send, sessionClient, type EngineEvents } from '../engine'
import type { FileInfo, FileList, JobInfo, OpenSessionResponse, SessionEvent, SessionInfo, SessionOptions } from '../engine'
import { logInfo, openKV } from '../platform'
import type { BindMode } from '../settings/settings'
import { exportAnnotations, importAnnotations, loadBookmarks, loadNotes, saveBookmarks, saveNotes, type TraceAnnotations } from './annotations'
import { closeChat } from '../assist/conversation'
import { libraryFor } from '../library/library'
import { mergePanes, parsePanes, type Panes, type PanesPatch } from './panes'
import { dirsOf, titleOf, baseName } from './traceSet'
import { dumpIndexOf, dumpTabs, leftOutFile, pathNamed, pickJumpTab, splitByKind, sqlIdsOf, statementTabs, type PeekOpt, type TabKind } from './optTabs'
import { LiveFollower } from './liveFollow'
import { OpenQueue } from './openQueue'

/** The options a trace set is opened with (the open screen; defaults from the settings). */
export interface OpenOptions {
  binds: BindMode
  salt?: string
  /** a live session over one growing file */
  follow?: boolean
}

/**
 * The open options as the open screen holds them: `salt` is kept while another bind mode is
 * chosen (it only applies with `redact`), `follow` is a plain checkbox. `openRequest` turns them
 * into the options a trace set is opened with.
 */
export function openRequest(o: OpenOptions): OpenOptions {
  return { binds: o.binds, salt: o.binds === 'redact' && o.salt ? o.salt : undefined, follow: o.follow || undefined }
}

/** The open options a fresh open screen starts from: the settings' defaults, no follow. */
export const defaultOpenOptions = (s: { binds: BindMode; salt: string }): OpenOptions => ({ binds: s.binds, salt: s.salt, follow: false })

/**
 * The options (and a notice to show) for files dropped on the window. On the open screen they are
 * the options shown there, for every way of opening; on any other route no options are visible, so
 * the settings' defaults apply. `follow` is one live file: with several dropped paths the drop opens
 * without it, and says so.
 */
export function dropOptions(
  route: Route,
  openOptions: OpenOptions,
  settings: { binds: BindMode; salt: string },
  paths: readonly string[],
): { options: OpenOptions; notice?: string } {
  const options = openRequest(route.kind === 'open' ? openOptions : defaultOpenOptions(settings))
  if (options.follow && paths.length !== 1) return { options: { ...options, follow: undefined }, notice: 'Follow needs one file; opened without follow.' }
  return { options }
}

/** What the drop overlay says: which options a drop opens with (see `dropOptions`). */
export function dropOverlayText(route: Route, openOptions: OpenOptions, settings: { binds: BindMode; salt: string }): string {
  const o = openRequest(route.kind === 'open' ? openOptions : defaultOpenOptions(settings))
  const binds = o.binds === 'keep' ? 'binds kept' : o.binds === 'redact' ? 'binds redacted' : 'binds dropped'
  return `${route.kind === 'open' ? 'Opens with the options above' : 'Opens with the default options'} · ${binds}${o.follow ? ' · follow' : ''}`
}

export interface TraceSet {
  paths: string[]
  options: OpenOptions
}

/** `opening`: the open job runs (or the document loads); `live`: a following session with snapshots. */
export type TabState = 'opening' | 'ready' | 'live' | 'failed'

/** One open engine session. Tabs are immutable: every change replaces the object. */
export interface Tab {
  key: string
  title: string
  set: TraceSet
  /** `paths`: opened from `set` (restored on start, re-opened after an engine restart); `adopted`: a session opened elsewhere (S6: remote follow) */
  origin: 'paths' | 'adopted' | 'comparison'
  /** Snapshot comparison sources; this tab has no engine session and is not persisted. */
  comparison?: { a: string; b: string; labelA: string; labelB: string; identityA: string; identityB: string }
  live: boolean
  /** the engine's session id; changes when the session is opened again after an engine restart */
  sessionId: string | null
  state: TabState
  job: JobInfo | null
  error: string | null
  /** content identity (annotations key); empty for a live session */
  identity: string
  rev: number
  hit: boolean
  /** the files the engine opened (a folder expanded, continuation files followed); empty until the session is known */
  files: FileInfo[]
  /** the requested paths that are folders (those with a file below them in `files`) */
  dirs: string[]
  /** the Files panel's selection (input file indices; absent = all files), kept in `workspace.json` and re-applied when the session first loads */
  fileSel?: number[]
  /** which side panes are open and how wide (see `panes.ts`), kept in `workspace.json` */
  panes?: Panes
  /** `10053`: an optimizer trace, a tab of its own with the 10053 view; absent: a 10046 trace. Known from the session (`optSqlIds`) or the document (`opt`), kept in `workspace.json` so a restored tab is labelled before it opens */
  kind?: TabKind
  /** a 10053 tab: the distinct sql_ids of its dumps (the engine's `optSqlIds`; the "10053" mark on a statement of another tab reads it) */
  optSqlIds?: string[]
  /** a jump to a dump that arrived before the tab's document did: the sql_id whose dump opens when it is in */
  openDump?: string
  /** the lib session (store + client), once the first document is in; the store survives engine restarts and live updates */
  session: Session | null
  /** an adopted session's way to open again after an engine restart; without it the tab fails */
  reopen?: (engine: EngineRef) => Promise<OpenSessionResponse>
}

/** What the frame shows: the open screen ("+" tab), a session tab, or a desktop page (settings, about; S6: connections). */
export type Route = { kind: 'open' } | { kind: 'tab'; key: string } | { kind: 'page'; id: string }

/**
 * Where leaving a page goes: the route the user came from if it is still there (an open tab, or
 * the open screen), else the last tab, else the open screen.
 */
export function leaveRoute(tabs: Tab[], origin?: Route): Route {
  if (origin?.kind === 'open') return origin
  if (origin?.kind === 'tab' && tabs.some((t) => t.key === origin.key)) return origin
  const last = tabs[tabs.length - 1]
  return last ? { kind: 'tab', key: last.key } : { kind: 'open' }
}

export interface RecentEntry {
  title: string
  set: TraceSet
  /** ISO time of the last open */
  at: string
  /** the requested paths that were folders, and how many files the engine opened (known after the first open) */
  dirs?: string[]
  files?: number
  /** `10053`: the set is one optimizer trace (known after the first open) */
  kind?: TabKind
}

/**
 * Folders being looked at before anything in them is opened: the open screen shows their trace
 * files to choose from (`FolderPicker`, DESIGN § Opening a folder) instead of opening them all.
 */
export interface FolderPick {
  /** a new one for every listing (the picker starts afresh) */
  id: number
  /** the requested paths (folders, and maybe files beside them) */
  paths: string[]
  /** the options the chosen files open with */
  options: OpenOptions
  /** what the engine listed: the trace files, and which requested paths are folders */
  list: FileList
}

export interface Snapshot {
  tabs: Tab[]
  route: Route
  /** the non-page route the user was on when they entered the current page (what Back and Esc return to) */
  origin?: Route
  recent: RecentEntry[]
  /** the options the open screen shows (and drops on it use); not persisted, reset from the settings when the screen mounts */
  openOptions: OpenOptions
  /** the folders the open screen lists to choose from; not persisted */
  pick: FolderPick | null
}

export interface EngineRef {
  client: ApiClient
  addr: string
  token: string
}

/** `workspace.json`: `open` (the path tabs, restored on start), `active` (index), `recent` (last 20 trace sets). */
const FILE = 'workspace.json'
const RECENT_MAX = 20

let seq = 0
let pickSeq = 0
const newKey = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`

const setKey = (s: TraceSet) => JSON.stringify([s.paths, s.options.binds, s.options.salt ?? '', !!s.options.follow])

function bodyOptions(o: OpenOptions): Partial<SessionOptions> {
  const b: Partial<SessionOptions> = { binds: o.binds }
  if (o.salt) b.salt = o.salt
  if (o.follow) b.follow = true
  return b
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * The open sessions and what the frame shows. Opens trace sets on the engine, follows their jobs
 * and session events, loads each session's document into a lib store (`createSession`) and keeps
 * that store across live updates and engine restarts (the session is opened again from its paths,
 * a cache hit, and the new document and client are swapped in without touching the selection).
 * A live tab's document follows the engine through the lib's long poll (`LiveFollower`); the `session` events
 * only carry its state changes (failed, closed). A plain external store for `useSyncExternalStore`.
 */
export class Workspace {
  private snap: Snapshot = { tabs: [], route: { kind: 'open' }, recent: [], openOptions: { binds: 'keep', salt: '', follow: false }, pick: null }
  private listeners = new Set<() => void>()
  private engine: EngineRef | null = null
  private loading = new Set<string>()
  private again = new Set<string>()
  private annotationPauses = new Set<string>()
  private cancelAnnotationTimers = new Map<string, () => void>()
  private flushAnnotationTimers = new Map<string, () => Promise<unknown>>()
  private unwatch = new Map<string, () => void>()
  private follower = new LiveFollower()
  private queue: OpenQueue | null = null
  private settleWaiters = new Set<() => void>()
  private restored = false
  private released = false
  private widthTimer: ReturnType<typeof setTimeout> | undefined
  /** when each tab was last shown, as a count of the times any tab was (a tie-free clock): the jumps between a 10046 trace and a 10053 dump take the most recently used candidate */
  private used = new Map<string, number>()
  private useSeq = 0

  /** called once, with the first engine: re-open last run's tabs (see WorkspaceProvider) */
  onFirstEngine: (() => void) | null = null

  getSnapshot = () => this.snap
  subscribe = (l: () => void) => {
    this.listeners.add(l)
    return () => void this.listeners.delete(l)
  }

  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch }
    for (const l of this.listeners) l()
    for (const w of [...this.settleWaiters]) w()
  }

  setOpenOptions(openOptions: OpenOptions) {
    this.set({ openOptions })
  }

  tab(key: string): Tab | undefined {
    return this.snap.tabs.find((t) => t.key === key)
  }

  private bySession(id: string): Tab | undefined {
    return this.snap.tabs.find((t) => t.sessionId === id)
  }

  private patchTab(key: string, patch: Partial<Tab>) {
    if (!this.tab(key)) return
    this.set({ tabs: this.snap.tabs.map((t) => (t.key === key ? { ...t, ...patch } : t)) })
  }

  // ---- engine -------------------------------------------------------------------------------

  /** The running engine (null while it is down). A new address or token after the first is a restarted engine: every tab opens again. */
  bind(engine: EngineRef | null) {
    if (!engine) return
    const prev = this.engine
    if (prev && prev.addr === engine.addr && prev.token === engine.token) return
    this.engine = engine
    // starts still running or waiting for the previous engine are over (their waiters see the new engine)
    this.queue?.clear()
    this.queue = this.newQueue()
    for (const w of [...this.settleWaiters]) w()
    if (!prev) {
      for (const t of this.snap.tabs) if (!t.sessionId && t.origin !== 'comparison') void this.start(t.key)
      if (!this.restored) {
        this.restored = true
        this.onFirstEngine?.()
      }
      return
    }
    // every tab opens again: the active one first, two at a time. The ones that wait show as opening
    // meanwhile; their old session ids belong to the engine that is gone.
    const keys = this.snap.tabs.filter((t) => t.origin !== 'comparison').map((t) => t.key)
    for (const key of keys) {
      this.follower.stop(key)
      this.patchTab(key, { sessionId: null, state: 'opening', job: null, error: null, rev: 0 })
    }
    this.enqueue(keys)
  }

  private newQueue() {
    return new OpenQueue((key) => this.startAndSettle(key), (key) => !!this.tab(key))
  }

  /**
   * Starts the given tabs through the queue: the active tab's first, then in order. A tab that is
   * already past `opening` or has no engine to open on is left alone.
   */
  private enqueue(keys: string[]) {
    const route = this.snap.route
    const active = route.kind === 'tab' ? route.key : null
    const ordered = active && keys.includes(active) ? [active, ...keys.filter((k) => k !== active)] : keys
    this.queue?.add(ordered)
  }

  /** `start`, and then waits until the tab has left `opening` (document loaded or failed), is closed, or the engine changed: what the queue counts as running. */
  private async startAndSettle(key: string) {
    const e = this.engine
    await this.start(key)
    const done = () => {
      const t = this.tab(key)
      return !t || t.state !== 'opening' || this.engine !== e || this.released
    }
    if (done()) return
    await new Promise<void>((resolve) => {
      const check = () => {
        if (!done()) return
        this.settleWaiters.delete(check)
        resolve()
      }
      this.settleWaiters.add(check)
    })
  }

  /** Follows `job` and `session` events; re-reads the sessions when the stream (re)connects. */
  attach(events: EngineEvents): () => void {
    const offs = [
      events.on('job', (j) => {
        const t = j.session ? this.bySession(j.session) : undefined
        if (t) this.patchTab(t.key, { job: j })
      }),
      events.on('session', (ev) => this.onSessionEvent(ev)),
      events.on('stream', ({ connected }) => connected && this.resync()),
    ]
    return () => offs.forEach((f) => f())
  }

  private onSessionEvent(ev: SessionEvent) {
    const t = this.bySession(ev.id)
    if (!t) return
    if (ev.state === 'failed' || ev.state === 'closed') {
      void this.refresh(t.key) // a live tab's poll ends by itself: its last answer says `X-Live: failed|closed` (badge: ended)
      return
    }
    if (this.follower.has(t.key)) return // the long poll brings the snapshots
    if ((ev.state === 'ready' || ev.state === 'live') && (ev.rev > t.rev || t.state === 'opening')) void this.load(t.key, ev.rev)
  }

  private resync() {
    for (const t of this.snap.tabs) if (t.sessionId) void this.refresh(t.key)
  }

  /** Re-reads one session from the engine and applies it. */
  private async refresh(key: string) {
    const t = this.tab(key)
    const e = this.engine
    if (!t?.sessionId || !e) return
    const id = t.sessionId
    try {
      this.apply(key, await getJSON<SessionInfo>(e.client, `/engine/sessions/${encodeURIComponent(id)}`))
    } catch (err) {
      if (this.tab(key)?.sessionId === id && this.engine === e) this.patchTab(key, { state: 'failed', error: message(err) })
    }
  }

  private apply(key: string, info: SessionInfo) {
    const t = this.tab(key)
    if (!t || t.sessionId !== info.id) return
    const patch: Partial<Tab> = { identity: info.identity || t.identity, hit: info.hit }
    const optIds = info.optSqlIds
    if (optIds) { patch.kind = '10053'; patch.optSqlIds = optIds } // present only for a 10053 session
    if (info.files?.length && !t.live) {
      const dirs = dirsOf(t.set.paths, info.files)
      patch.files = info.files
      patch.dirs = dirs
      this.noteFiles(t.set, dirs, info.files.length)
    }
    if (info.state === 'failed') {
      patch.state = 'failed'
      patch.error = info.error || 'the session failed'
    } else if (info.state === 'closed') {
      patch.state = 'failed'
      patch.error = 'the engine closed the session'
    }
    this.patchTab(key, patch)
    if (patch.kind && t.kind !== patch.kind) this.persistOpen() // a restart reopens it as the 10053 tab it is
    if (this.follower.has(key)) return
    if ((info.state === 'ready' || info.state === 'live') && (info.rev > t.rev || t.state === 'opening')) void this.load(key, info.rev)
  }

  // ---- documents ----------------------------------------------------------------------------

  /** Loads the session's document (again); one load per tab at a time, a request meanwhile loads once more after it. */
  private async load(key: string, rev: number) {
    if (this.loading.has(key)) {
      this.again.add(key)
      return
    }
    this.loading.add(key)
    try {
      do {
        this.again.delete(key)
        await this.loadOnce(key, rev)
      } while (this.again.has(key) && !this.follower.has(key))
    } catch (err) {
      const t = this.tab(key)
      if (t && t.state === 'opening') this.patchTab(key, { state: 'failed', error: message(err) })
      else console.error(`reload ${t?.title}:`, err)
    } finally {
      this.loading.delete(key)
    }
  }

  private async loadOnce(key: string, rev: number) {
    const t = this.tab(key)
    const e = this.engine
    if (!t?.sessionId || !e) return
    const id = t.sessionId
    let client: ApiClient = sessionClient(e.addr, e.token, id)
    const old = t.session?.client
    if (old && old.base === client.base && old.token === client.token) client = old
    const r = await client.fetch('/api/doc', { headers: { accept: 'application/json' } })
    if (!r.ok) throw await responseError(r, 'GET api/doc')
    const xrev = Number(r.headers.get('X-Rev'))
    const raw = (await r.json()) as RawDocument | RawCompareDocument
    const l = await fromRaw(raw, client)
    const cur = this.tab(key)
    if (!cur || cur.sessionId !== id) return
    // the document says what the tab is (a restored tab only guessed)
    const opt = l.doc.opt
    const kind: TabKind | undefined = opt ? '10053' : undefined
    if (cur.kind !== kind || (opt && !cur.optSqlIds)) {
      this.patchTab(key, { kind, optSqlIds: opt ? sqlIdsOf(opt.file.dumps) : undefined })
      if (cur.kind !== kind) this.persistOpen()
    }
    this.noteKind(cur.set, kind) // the recent list marks it
    let session = cur.session
    if (!session) {
      session = { ...createSession(client), library: libraryFor() }
      session.store.setLoaded(l)
      // the restored Files selection (setLoaded resets it)
      if (cur.fileSel) session.store.actions.setFiles(new Set(cur.fileSel))
      if (cur.panes?.filesOpen !== undefined) session.store.actions.setFilesOpen(cur.panes.filesOpen)
      // notes and the Pivot library: persisted here (annotations.json, library.json)
      session.store.setState({ annotationsEnabled: true, libraryEnabled: true })
      // the engine answers api/lines (the drawer) and the Lines view's endpoints; "show in trace" opens the Lines tab
      session.store.setState({ linesApi: true, linesAvailable: true, lineRefTarget: 'drawer' })
      if (cur.identity) session.store.setState({ bookmarks: await loadBookmarks(cur.identity), annotations: await loadNotes(cur.identity) })
      this.watchSession(key, session)
      if (opt && cur.openDump) { // a jump from another tab that came before the document
        const i = dumpIndexOf(opt.file.dumps, cur.openDump)
        if (i >= 0) session.store.actions.openOpt(i)
      }
    } else {
      if (session.client !== client) session = { ...session, client }
      session.store.setState({ linesApi: true })
      session.store.swapDoc(l) // a newer document of the same trace: scope and selection stay
    }
    const first = cur.state === 'opening'
    const live = cur.live || cur.state === 'live'
    this.patchTab(key, {
      session,
      state: cur.state === 'failed' ? 'failed' : live ? 'live' : 'ready',
      rev: Math.max(rev, Number.isFinite(xrev) ? xrev : 0),
      error: cur.state === 'failed' ? cur.error : null,
      ...(cur.openDump ? { openDump: undefined } : null),
    })
    if (first) logInfo(`session ready: ${cur.title} (${id}${cur.hit ? ', cache hit' : ''})`)
    // a live session: from this snapshot on the long poll (api/doc?rev=) keeps the document current, until the engine stops it
    if (live && cur.state !== 'failed' && this.tab(key)?.sessionId === id && !this.released && r.headers.get('X-Live') === 'live' && Number.isFinite(xrev)) {
      this.follower.follow(key, session, xrev, {
        onRev: (rev) => this.patchTab(key, { rev }),
        onEnd: () => void this.refresh(key), // the follow stopped: the engine says why (failed, closed, gone)
      })
    }
  }

  /** Saves the tab's bookmarks and notes under its identity, and keeps its Files selection in the tab (and `workspace.json`), whenever they change. */
  private watchSession(key: string, session: Session) {
    this.unwatch.get(key)?.()
    let last: Bookmark[] = session.store.getState().bookmarks
    let lastNotes = session.store.getState().annotations
    let lastFiles = session.store.getState().files
    let lastFilesOpen = session.store.getState().filesOpen
    let timer: ReturnType<typeof setTimeout> | undefined
    let timerNotes: ReturnType<typeof setTimeout> | undefined
    this.cancelAnnotationTimers.set(key, () => { clearTimeout(timer); clearTimeout(timerNotes); timer = timerNotes = undefined })
    const flush = () => {
      const identity = this.tab(key)?.identity
      const writes: Promise<void>[] = []
      if (identity && timer !== undefined) writes.push(saveBookmarks(identity, last))
      if (identity && timerNotes !== undefined) writes.push(saveNotes(identity, lastNotes))
      clearTimeout(timer); clearTimeout(timerNotes)
      timer = timerNotes = undefined
      return Promise.all(writes)
    }
    this.flushAnnotationTimers.set(key, flush)
    const off = session.store.subscribe(() => {
      const { bookmarks: b, annotations: n, files, filesOpen } = session.store.getState()
      const identity = this.tab(key)?.identity
      if (b !== last) {
        last = b
        if (identity && !this.annotationPauses.has(identity)) {
          clearTimeout(timer)
          timer = setTimeout(() => { timer = undefined; void saveBookmarks(identity, b).catch((e) => console.error('bookmarks:', e)) }, 300)
        }
      }
      if (files !== lastFiles) {
        lastFiles = files
        this.patchTab(key, { fileSel: files ? [...files].sort((x, y) => x - y) : undefined })
        this.persistOpen()
      }
      // a panel the shell folded away for a narrow window is not the user's choice: leave `workspace.json` as it was
      // nor is a view's default (SessionShell sets it as you switch views): only the user's own toggles are saved
      if (filesOpen !== lastFilesOpen && !(filesOpen === false && filesFolded(session.store))) {
        lastFilesOpen = filesOpen
        if (filesOpen !== null && !inShellFilesWrite(session.store)) this.setPanes(key, { filesOpen })
      }
      if (n !== lastNotes) {
        lastNotes = n
        if (identity && !this.annotationPauses.has(identity)) {
          clearTimeout(timerNotes)
          timerNotes = setTimeout(() => { timerNotes = undefined; void saveNotes(identity, n).catch((e) => console.error('notes:', e)) }, 300)
        }
      }
    })
    this.unwatch.set(key, () => {
      off()
      void flush().catch((e) => console.error('annotations:', e))
      this.cancelAnnotationTimers.delete(key)
      this.flushAnnotationTimers.delete(key)
    })
  }

  /** Include edits still waiting in the workspace's debounce timers. */
  async exportInvestigationAnnotations() {
    await Promise.all([...this.flushAnnotationTimers.values()].map((flush) => flush()))
    return exportAnnotations()
  }

  /** Pause debounced writes while importing, then merge and refresh live stores before edits resume. */
  async importInvestigationAnnotations(incoming: Record<string, TraceAnnotations>) {
    const identities = Object.keys(incoming)
    for (const identity of identities) this.annotationPauses.add(identity)
    try {
      // A second tab of the same trace may have stale notes. Merge its entries;
      // never replace persisted notes with that tab's (possibly empty) snapshot.
      const captured = this.snap.tabs.filter((t) => t.session && this.annotationPauses.has(t.identity))
      const combined = { ...incoming }
      for (const t of captured) {
        this.cancelAnnotationTimers.get(t.key)?.()
        const state = t.session!.store.getState()
        const prior = combined[t.identity]
        combined[t.identity] = { notes: mergeAnnotations(prior?.notes ?? [], state.annotations), bookmarks: mergeBookmarks(prior?.bookmarks ?? [], state.bookmarks) }
      }
      await importAnnotations(combined)
      for (const identity of identities) {
        let notes = await loadNotes(identity)
        let bookmarks = await loadBookmarks(identity)
        // Include edits made while disk operations were pending; update all instances together.
        const matching = this.snap.tabs.filter((t) => t.identity === identity && t.session)
        const stores = new Set([...captured, ...matching].filter((t) => t.identity === identity).map((t) => t.session!))
        for (const session of stores) {
          const state = session.store.getState()
          notes = mergeAnnotations(notes, state.annotations)
          bookmarks = mergeBookmarks(bookmarks, state.bookmarks)
        }
        for (const t of matching) t.session!.store.setState({ annotations: notes, bookmarks })
        // Enqueue immediately, before allowing the next edit to enqueue its save.
        const savedNotes = saveNotes(identity, notes)
        const savedBookmarks = saveBookmarks(identity, bookmarks)
        this.annotationPauses.delete(identity)
        await Promise.all([savedNotes, savedBookmarks])
      }
    } finally {
      for (const identity of identities) this.annotationPauses.delete(identity)
    }
  }

  // ---- tabs ---------------------------------------------------------------------------------

  /** Whole-trace comparison snapshot; independently retained until closed, never persisted. */
  async compare(aKey: string, bKey: string): Promise<string> {
    const a = this.tab(aKey), b = this.tab(bKey), e = this.engine
    if (!e || !a || !b || a === b || !canCompare(a) || !canCompare(b)) throw new Error('Choose two ready, non-live trace tabs.')
    const raw = await getJSON<RawCompareDocument>(e.client, `/engine/compare?a=${encodeURIComponent(a.sessionId!)}&b=${encodeURIComponent(b.sessionId!)}`)
    const loaded = await fromRaw(raw)
    if (this.engine !== e || this.released) throw new Error('The engine changed while comparing; try again.')
    const session = createSession(e.client)
    session.store.setLoaded(loaded)
    session.store.setState({ view: 'compare', linesApi: false, linesAvailable: false })
    const key = newKey()
    const tab: Tab = {
      key, title: `${b.title} vs ${a.title}`, set: { paths: [], options: { binds: 'keep' } },
      origin: 'comparison', comparison: { a: aKey, b: bKey, labelA: `${a.title} · ${a.set.paths.join(', ')}`, labelB: `${b.title} · ${b.set.paths.join(', ')}`, identityA: a.identity, identityB: b.identity }, live: false,
      sessionId: null, state: 'ready', job: null, error: null, identity: '', rev: 0,
      hit: false, files: [], dirs: [], session,
    }
    this.set({ tabs: [...this.snap.tabs, tab], route: { kind: 'tab', key } })
    return key
  }

  /**
   * Opens a trace set in a new tab (shown at once unless `activate` is false), and lists it first in the recent list.
   * With `queued` the tab is only added: the caller starts it (`enqueue`).
   */
  open(set: TraceSet, activate = true, recent = true, fileSel?: number[], panes?: Panes, queued = false, kind?: TabKind): string {
    const key = newKey()
    const tab: Tab = {
      key,
      title: titleOf(set.paths),
      set,
      origin: 'paths',
      live: !!set.options.follow,
      sessionId: null,
      state: 'opening',
      job: null,
      error: null,
      identity: '',
      rev: 0,
      hit: false,
      files: [],
      dirs: [],
      fileSel,
      panes,
      session: null,
      ...(kind ? { kind } : null),
    }
    this.set({ tabs: [...this.snap.tabs, tab], route: activate ? { kind: 'tab', key } : this.snap.route })
    if (activate) this.used.set(key, ++this.useSeq)
    if (recent && !set.options.follow) this.addRecent(tab.title, set, kind)
    this.persistOpen()
    // a restore starts its tabs together through the queue (`restore`); an open by the user is immediate
    if (!queued) void this.start(key)
    return key
  }

  /**
   * Opens a trace set the user asked for, unless one of its paths is a folder: then the open screen
   * lists the folder's trace files to choose from (`pick`) and nothing is opened yet. The folder goes
   * first in the recent list (opening it from there lists it again). With `show`, a set that is
   * already open in a tab is shown instead (`openOrShow`). When the paths cannot be listed (a path
   * that is gone), the set opens as before and its tab shows the error.
   */
  async openOrPick(set: TraceSet, show = false): Promise<void> {
    const e = this.engine
    let list: FileList | null = null
    if (e && !this.released) {
      try {
        list = await send<FileList>(e.client, 'POST', '/engine/files', { paths: set.paths })
      } catch {
        list = null
      }
    }
    if (this.released) return
    if (!list?.dirs.length) {
      if (show) this.openOrShow(set)
      else this.open(set)
      return
    }
    this.set({ pick: { id: ++pickSeq, paths: set.paths, options: set.options, list }, route: { kind: 'open' } })
    this.addRecent(titleOf(set.paths), set)
    this.noteFiles(set, list.dirs, list.files.length)
  }

  /** Leaves the folder picker for the plain open screen. */
  closePick() {
    if (this.snap.pick) this.set({ pick: null })
  }

  /** Shows the tab that already has this trace set (a file opened from the Finder or the CLI a second time), else opens one. */
  openOrShow(set: TraceSet): string {
    const k = setKey(set)
    const tab = this.snap.tabs.find((t) => t.origin === 'paths' && !t.live && setKey(t.set) === k)
    if (!tab) return this.open(set)
    this.go({ kind: 'tab', key: tab.key })
    return tab.key
  }

  // ---- 10053 (optimizer trace) tabs ---------------------------------------------------------------

  /**
   * Opens a request for several files as tabs, split by what a peek found (`peekOf`; DESIGN § Opening a folder): the 10046 files form the set
   * they would have formed (one tab), each 10053 file is a tab of its own, after it. The first tab opened is shown. A file that was not peeked is a
   * 10046 file; the engine itself leaves a 10053 file out of a set and says so in a note (`noteAction` offers to open it). Returns the tabs' keys.
   */
  openSplit(paths: string[], peekOf: (path: string) => PeekOpt | null | undefined, options: OpenOptions): string[] {
    const { set, opt } = splitByKind(paths, peekOf)
    const keys: string[] = []
    // follow is one live file: a set of several, and a 10053 file, open without it
    if (set.length) keys.push(this.open({ paths: set, options: set.length === 1 ? options : { ...options, follow: undefined } }, true))
    opt.forEach((p, i) => keys.push(this.open({ paths: [p], options: { ...options, follow: undefined } }, !set.length && i === 0, true, undefined, undefined, false, '10053')))
    return keys
  }

  /** When the tab was last shown, in the order of showing (0: never). */
  lastUsed(key: string): number {
    return this.used.get(key) ?? 0
  }

  /** The "10053" mark of the 10046 tab `from`: whether another open tab holds a dump of the sql_id, and the jump to the most recently used one's first such dump. */
  dumpLink(from: string): Opt10053Link {
    return {
      has: (sqlId) => dumpTabs(this.snap.tabs, sqlId, from).length > 0,
      open: (sqlId) => this.openDump(from, sqlId),
    }
  }

  private openDump(from: string, sqlId: string) {
    const tab = pickJumpTab(dumpTabs(this.snap.tabs, sqlId, from), this.used)
    if (!tab) return
    const dumps = tab.session?.store.getState().doc?.opt?.file.dumps
    if (tab.session && dumps) {
      const i = dumpIndexOf(dumps, sqlId)
      if (i >= 0) tab.session.store.actions.openOpt(i)
    } else this.patchTab(tab.key, { openDump: sqlId }) // its document is not in yet: the dump opens with it
    this.go({ kind: 'tab', key: tab.key })
  }

  /** The "10046" link of the 10053 tab `from`: whether another open 10046 tab has a statement with the sql_id, and the jump to the most recently used one, selecting it. */
  statementLink(from: string): Opt10046Link {
    return {
      has: (sqlId) => statementTabs(this.snap.tabs, sqlId, from, hasStatement).length > 0,
      open: (sqlId) => {
        const tab = pickJumpTab(statementTabs(this.snap.tabs, sqlId, from, hasStatement), this.used)
        const doc = tab?.session?.store.getState().doc
        if (!tab || !tab.session || !doc) return
        const stmt = doc.statements.findIndex((x) => x.sqlId === sqlId)
        if (stmt >= 0) tab.session.store.actions.selectStmt(stmt)
        this.go({ kind: 'tab', key: tab.key })
      },
    }
  }

  /**
   * A button for a note of tab `key`'s document that says a 10053 file was left out of the set ("x.trc is a 10053 file; open it on its own"):
   * it opens that file in a tab of its own. The file is found among the requested paths, else in the folders among them.
   */
  noteAction(key: string, note: string): NoteAction | null {
    const tab = this.tab(key)
    if (!tab || tab.origin === 'comparison') return null
    const opened = new Set(tab.files.map((f) => baseName(f.path)))
    const name = leftOutFile(note) ?? tab.set.paths.map(baseName).find((n) => !opened.has(n) && note.includes(n)) ?? null
    if (!name || opened.has(name)) return null
    return { label: `Open ${name}`, title: `Open ${name} in a tab of its own`, run: () => void this.openLeftOut(tab, name) }
  }

  private async openLeftOut(tab: Tab, name: string) {
    let path = pathNamed(tab.set.paths, name)
    const e = this.engine
    if (!path && e) {
      try {
        const list = await send<FileList>(e.client, 'POST', '/engine/files', { paths: tab.dirs.length ? tab.dirs : tab.set.paths })
        path = list.files.find((f) => baseName(f.path) === name)?.path ?? null
      } catch (err) {
        console.warn('open the left-out file:', message(err))
      }
    }
    if (path) this.openOrShow({ paths: [path], options: { binds: tab.set.options.binds, salt: tab.set.options.salt } })
  }

  /**
   * Adds a tab for a session opened elsewhere (S6: `POST /engine/connections/{id}/follow`).
   * `reopen` opens it again after an engine restart; without it the tab fails then.
   */
  adopt(r: OpenSessionResponse, meta: { title: string; live: boolean; reopen?: Tab['reopen'] }, activate = true): string {
    const key = newKey()
    const tab: Tab = {
      key,
      title: meta.title,
      set: { paths: r.session.paths, options: { binds: 'keep', follow: meta.live } },
      origin: 'adopted',
      live: meta.live,
      sessionId: r.session.id,
      state: 'opening',
      job: r.job,
      error: null,
      identity: '',
      rev: 0,
      hit: false,
      files: [],
      dirs: [],
      session: null,
      reopen: meta.reopen,
    }
    this.set({ tabs: [...this.snap.tabs, tab], route: activate ? { kind: 'tab', key } : this.snap.route })
    this.apply(key, r.session)
    void this.refresh(key)
    return key
  }

  /** Opens the tab's session on the engine (first open, retry, engine restart). */
  private async start(key: string) {
    const t = this.tab(key)
    const e = this.engine
    if (!t || !e) return
    if (t.origin === 'adopted' && !t.reopen) {
      this.patchTab(key, { sessionId: null, state: 'failed', job: null, error: 'The engine restarted; open this session again.' })
      return
    }
    this.follower.stop(key)
    this.patchTab(key, { sessionId: null, state: 'opening', job: null, error: null, rev: 0 })
    try {
      const r = t.reopen
        ? await t.reopen(e)
        : await send<OpenSessionResponse>(e.client, 'POST', '/engine/sessions', {
            paths: t.set.paths,
            options: bodyOptions(t.set.options),
          })
      if (this.engine !== e) return // restarted meanwhile: bind() starts it again
      if (!this.tab(key) || this.released) {
        void send(e.client, 'DELETE', `/engine/sessions/${encodeURIComponent(r.session.id)}`).catch(() => {})
        return
      }
      this.patchTab(key, { sessionId: r.session.id, job: r.job })
      this.apply(key, r.session)
      await this.refresh(key) // the job may have finished before we knew the session id
    } catch (err) {
      if (this.engine === e) this.patchTab(key, { state: 'failed', error: message(err) })
    }
  }

  retry(key: string) {
    void this.start(key)
  }

  /** Cancels the tab's open job (`DELETE /engine/jobs/{id}`); the session fails with "cancelled". */
  async cancel(key: string) {
    const t = this.tab(key)
    const e = this.engine
    if (!t?.job || !e) return
    await send(e.client, 'DELETE', `/engine/jobs/${encodeURIComponent(t.job.id)}`).catch((err) =>
      console.warn('cancel:', err),
    )
  }

  /** Closes the tab and its engine session (the cache entry stays). */
  close(key: string) {
    const tabs = this.snap.tabs
    const i = tabs.findIndex((t) => t.key === key)
    if (i < 0) return
    const t = tabs[i]
    const rest = tabs.filter((x) => x.key !== key)
    let route = this.snap.route
    if (route.kind === 'tab' && route.key === key) {
      const next = rest[Math.min(i, rest.length - 1)]
      route = next ? { kind: 'tab', key: next.key } : { kind: 'open' }
    }
    this.unwatch.get(key)?.()
    this.unwatch.delete(key)
    this.used.delete(key)
    this.follower.stop(key) // cancels the open long poll
    closeChat(key)
    this.set({ tabs: rest, route })
    this.persistOpen()
    const e = this.engine
    if (t.sessionId && e) void send(e.client, 'DELETE', `/engine/sessions/${encodeURIComponent(t.sessionId)}`).catch(() => {})
  }

  /** Undoes `releaseSessions` (React StrictMode runs an effect's cleanup and setup again on the same workspace). */
  keepSessions() {
    this.released = false
  }

  /**
   * Closes the engine sessions of every tab without touching the tabs (the cache entries stay).
   * For a window that is going away or a workspace that is being replaced (dev reload); a
   * session that finishes opening afterwards is closed as well. Uses `keepalive` so the requests
   * survive the page unload.
   */
  releaseSessions() {
    const e = this.engine
    this.released = true
    this.follower.stopAll()
    if (!e) return
    for (const t of this.snap.tabs)
      if (t.sessionId) void e.client.fetch(`/engine/sessions/${encodeURIComponent(t.sessionId)}`, { method: 'DELETE', keepalive: true }).catch(() => {})
  }

  /** Changes the tab's pane state (a field set to `undefined` goes back to its default) and keeps it in `workspace.json`; a dragged width is written once it settles. */
  setPanes(key: string, patch: PanesPatch) {
    const t = this.tab(key)
    if (!t) return
    const panes = mergePanes(t.panes, patch)
    if (JSON.stringify(panes ?? null) === JSON.stringify(t.panes ?? null)) return
    this.patchTab(key, { panes })
    if ('filesW' in patch || 'inspectorW' in patch || 'assistantW' in patch) {
      clearTimeout(this.widthTimer)
      this.widthTimer = setTimeout(() => this.persistOpen(), 300)
    } else this.persistOpen()
  }

  go(route: Route) {
    const cur = this.snap.route
    // going from page to page keeps the original origin
    const origin = route.kind !== 'page' ? undefined : cur.kind === 'page' ? this.snap.origin : cur
    this.set({ route, origin })
    if (route.kind === 'tab') {
      this.used.set(route.key, ++this.useSeq)
      this.queue?.prioritize(route.key) // the user looks at a tab that still waits to open: next
      this.persistOpen()
    }
  }

  /** Leaves the current page for where the user came from (see `leaveRoute`). */
  leavePage() {
    const { tabs, route, origin } = this.snap
    if (route.kind === 'page') this.go(leaveRoute(tabs, origin))
  }

  /** Moves a tab to another position. (No drag in the strip yet.) */
  move(key: string, to: number) {
    const tabs = [...this.snap.tabs]
    const i = tabs.findIndex((t) => t.key === key)
    if (i < 0) return
    const [t] = tabs.splice(i, 1)
    tabs.splice(Math.max(0, Math.min(to, tabs.length)), 0, t)
    this.set({ tabs })
    this.persistOpen()
  }

  // ---- persistence --------------------------------------------------------------------------

  /** Last run's path tabs (live ones are not kept); `startEmpty` skips them. `extra` (a smoke run's trace) opens too. */
  async restore(opts: { startEmpty: boolean; extra?: TraceSet | null }) {
    const kv = await openKV(FILE)
    this.set({ recent: (await kv.get<RecentEntry[]>('recent')) ?? [] })
    const open = opts.startEmpty ? [] : ((await kv.get<(Panes & { title: string; set: TraceSet; files?: number[]; kind?: string })[]>('open')) ?? [])
    const active = (await kv.get<number>('active')) ?? -1
    // the tabs are added at once and opened through the queue (the shown one first, two at a time)
    const keys = open.filter((o) => o?.set?.paths?.length).map((o) => this.open(o.set, false, false, Array.isArray(o.files) ? o.files.filter((f) => Number.isInteger(f) && f >= 0) : undefined, parsePanes(o), true, o.kind === '10053' ? '10053' : undefined))
    const extra = opts.extra
    if (extra && !open.some((o) => setKey(o.set) === setKey(extra))) keys.push(this.open(extra, false, true, undefined, undefined, true))
    const show = extra ? keys[keys.length - 1] : (keys[active] ?? keys[0])
    if (show) this.go({ kind: 'tab', key: show })
    this.enqueue(keys)
  }

  private persistOpen() {
    const keep = this.snap.tabs.filter((t) => t.origin === 'paths' && !t.live)
    const r = this.snap.route
    const active = r.kind === 'tab' ? keep.findIndex((t) => t.key === r.key) : -1
    void openKV(FILE).then(async (kv) => {
      await kv.set('open', keep.map((t) => ({ title: t.title, set: t.set, ...(t.kind ? { kind: t.kind } : null), ...(t.fileSel ? { files: t.fileSel } : null), ...t.panes })))
      await kv.set('active', active)
    })
  }

  private addRecent(title: string, set: TraceSet, kind?: TabKind) {
    const k = setKey(set)
    const old = this.snap.recent.find((r) => setKey(r.set) === k)
    const recent = [{ title, set, at: new Date().toISOString(), ...((kind ?? old?.kind) ? { kind: kind ?? old?.kind } : null) }, ...this.snap.recent.filter((r) => setKey(r.set) !== k)].slice(0, RECENT_MAX)
    this.set({ recent })
    void openKV(FILE).then((kv) => kv.set('recent', recent))
  }

  /** Records on the set's recent entry which of its paths are folders and how many files the engine opened. */
  private noteFiles(set: TraceSet, dirs: string[], files: number) {
    const k = setKey(set)
    const at = this.snap.recent.findIndex((r) => setKey(r.set) === k)
    const r = this.snap.recent[at]
    if (!r || (r.files === files && (r.dirs ?? []).join('\n') === dirs.join('\n'))) return
    const recent = this.snap.recent.map((x, i) => (i === at ? { ...x, dirs, files } : x))
    this.set({ recent })
    void openKV(FILE).then((kv) => kv.set('recent', recent))
  }

  /** Records on the set's recent entry that it is a 10053 trace (or not): the open screen marks it. */
  private noteKind(set: TraceSet, kind: TabKind | undefined) {
    const k = setKey(set)
    const at = this.snap.recent.findIndex((r) => setKey(r.set) === k)
    const r = this.snap.recent[at]
    if (!r || r.kind === kind) return
    const recent = this.snap.recent.map((x, i) => {
      if (i !== at) return x
      const { kind: _old, ...rest } = x
      return kind ? { ...rest, kind } : rest
    })
    this.set({ recent })
    void openKV(FILE).then((kv) => kv.set('recent', recent))
  }

  removeRecent(at: number) {
    const recent = this.snap.recent.filter((_, i) => i !== at)
    this.set({ recent })
    void openKV(FILE).then((kv) => kv.set('recent', recent))
  }
}

/** Whether the tab's document has a statement with this sql_id (the sql_ids of a document are kept per document, not rebuilt for every ask). */
const sqlIdCache = new WeakMap<TraceDoc, ReadonlySet<string>>()
function hasStatement(t: Tab, sqlId: string): boolean {
  const doc = t.session?.store.getState().doc
  if (!doc) return false
  let ids = sqlIdCache.get(doc)
  if (!ids) sqlIdCache.set(doc, (ids = new Set(doc.statements.map((x) => x.sqlId).filter(Boolean))))
  return ids.has(sqlId)
}

/** Comparison uses full traces, independently of current filters and selections. A 10053 tab is not offered as a side: it has nothing to compare. */
export const canCompare = (t: Tab) => t.origin !== 'comparison' && t.kind !== '10053' && t.state === 'ready' && !t.live && !!t.sessionId && !!t.session
