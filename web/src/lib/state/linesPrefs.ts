import { useSyncExternalStore } from 'react'

/** The Lines view's display toggles: global (not per file) and kept in localStorage. */
export interface LinesPrefs {
  wrap: boolean
  heat: boolean
  strip: boolean
  links: boolean
  /** inlay hints inside the rows: bind values and idle gaps */
  hints: boolean
  /** raw numbers shown readable in place (tim= as a clock, obj# as a name, e=/ela= as a duration, oacdty as a type); off shows the trace as written */
  readable: boolean
  /** a gutter column with each line's tim as a wall-clock time */
  clock: boolean
  /** a gutter column with each line's time from an anchor line in view */
  delta: boolean
  inspect: boolean
  inspectW: number
  /** the inspector follows the hovered line instead of the selected one */
  follow: boolean
  /** Mute groups (names) whose rows are dimmed */
  mute: string[]
  /** the Presets menu threshold for slow waits and calls (ms) */
  threshold: number
  /** idle gaps at or above this many ms get a tick and a hint */
  gapMs: number
}

export const LINES_PREFS_DEFAULTS: LinesPrefs = {
  wrap: false, heat: true, strip: true, links: true, hints: true, readable: true, clock: false, delta: false,
  inspect: false, inspectW: 400, follow: false, mute: [], threshold: 10, gapMs: 100,
}

const KEY = 'mtk.lines.prefs'
const KEYS = Object.keys(LINES_PREFS_DEFAULTS) as (keyof LinesPrefs)[]

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The value when it has the type of the default's field, else undefined. */
function valid<K extends keyof LinesPrefs>(k: K, v: unknown): LinesPrefs[K] | undefined {
  const d = LINES_PREFS_DEFAULTS[k]
  if (typeof d === 'boolean') return (typeof v === 'boolean' ? v : undefined) as LinesPrefs[K] | undefined
  if (Array.isArray(d)) return (Array.isArray(v) && v.every((x) => typeof x === 'string') ? [...v] : undefined) as LinesPrefs[K] | undefined
  if (k === 'inspectW') return (isNum(v) && v > 0 ? v : undefined) as LinesPrefs[K] | undefined
  return (isNum(v) && v >= 0 ? v : undefined) as LinesPrefs[K] | undefined
}

/** The defaults with the valid known fields of `raw` laid over them. */
function merge(base: LinesPrefs, raw: unknown): LinesPrefs {
  const out: LinesPrefs = { ...base, mute: [...base.mute] }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return out
  const src = raw as Record<string, unknown>
  const dst = out as unknown as Record<string, unknown>
  for (const k of KEYS) {
    if (!(k in src)) continue
    const v = valid(k, src[k])
    if (v !== undefined) dst[k] = v
  }
  return out
}

/** The stored prefs: the defaults merged with the stored JSON, unknown keys dropped and fields of the wrong type back to their default. */
export function readLinesPrefs(storage?: Pick<Storage, 'getItem'>): LinesPrefs {
  try {
    const s = storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
    const raw = s?.getItem(KEY)
    return merge(LINES_PREFS_DEFAULTS, raw == null ? null : JSON.parse(raw))
  } catch { return merge(LINES_PREFS_DEFAULTS, null) }
}

function same(a: LinesPrefs, b: LinesPrefs): boolean {
  return KEYS.every((k) => (k === 'mute' ? a.mute.length === b.mute.length && a.mute.every((x, i) => x === b.mute[i]) : a[k] === b[k]))
}

function persist(p: LinesPrefs): void {
  try {
    if (typeof localStorage === 'undefined') return
    if (same(p, LINES_PREFS_DEFAULTS)) localStorage.removeItem(KEY); else localStorage.setItem(KEY, JSON.stringify(p))
  } catch { /* storage unavailable: memory only */ }
}

// The module-level store: one state for every mounted view.
let state: LinesPrefs | null = null
const listeners = new Set<() => void>()
let watching = false

const emit = () => listeners.forEach((l) => l())

/** The current prefs (read from storage on first use); the same object until something changes. */
export function getLinesPrefs(): LinesPrefs {
  return (state ??= readLinesPrefs())
}

/** Change some prefs (invalid values are ignored); persists, and re-renders every mounted view. */
export function setLinesPrefs(patch: Partial<LinesPrefs>): void {
  const cur = getLinesPrefs()
  const next = merge(cur, patch)
  if (same(next, cur)) return
  state = next
  persist(next)
  emit()
}

/** Call `fn` on every change; returns the unsubscribe. Follows the window `storage` event while anyone listens. */
export function subscribeLinesPrefs(fn: () => void): () => void {
  listeners.add(fn)
  if (!watching && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    watching = true
    window.addEventListener('storage', onStorage)
  }
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && watching && typeof window !== 'undefined') {
      watching = false
      window.removeEventListener('storage', onStorage)
    }
  }
}

/** Another window wrote the key (or cleared storage): take its value. */
function onStorage(e: StorageEvent): void {
  if (e.key !== null && e.key !== KEY) return
  const next = readLinesPrefs()
  if (state && same(next, state)) return
  state = next
  emit()
}

/** The Lines view's display toggles, shared by every mounted view; `set` merges a patch. */
export function useLinesPrefs(): [LinesPrefs, (patch: Partial<LinesPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribeLinesPrefs, getLinesPrefs, getLinesPrefs)
  return [prefs, setLinesPrefs]
}
