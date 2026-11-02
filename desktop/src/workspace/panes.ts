/**
 * Which panes of a tab are open and how wide the side panes are. Kept per tab in `workspace.json`
 * (flat optional fields next to `files`, the Files selection); an absent field means "the default"
 * (open, except the assistant; the width from the CSS), so older files load unchanged.
 */
export interface Panes {
  /** the Files panel (multi-file sets only; default open) */
  filesOpen?: boolean
  /** its dragged width in px */
  filesW?: number
  /** the event details pane on the right (default open while an event is selected) */
  inspectorOpen?: boolean
  inspectorW?: number
  /** the Statements context pane */
  contextOpen?: boolean
  /** the assistant's chat panel beside the views (default closed; ⌘J) */
  assistantOpen?: boolean
  assistantW?: number
}

/** a change of some fields; `undefined` resets a field */
export type PanesPatch = { [K in keyof Panes]?: Panes[K] | undefined }

const FLAGS = ['filesOpen', 'inspectorOpen', 'contextOpen', 'assistantOpen'] as const
const WIDTHS = ['filesW', 'inspectorW', 'assistantW'] as const

const isWidth = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 100 && v <= 10000

/** The pane fields of a persisted tab entry; anything of the wrong type is ignored. `undefined` when none is set. */
export function parsePanes(o: unknown): Panes | undefined {
  if (!o || typeof o !== 'object') return undefined
  const src = o as Record<string, unknown>
  const p: Panes = {}
  for (const k of FLAGS) if (typeof src[k] === 'boolean') p[k] = src[k]
  for (const k of WIDTHS) if (isWidth(src[k])) p[k] = Math.round(src[k])
  return Object.keys(p).length ? p : undefined
}

/** `panes` with `patch` applied: a field set to `undefined` goes back to its default. `undefined` when nothing is left. */
export function mergePanes(panes: Panes | undefined, patch: PanesPatch): Panes | undefined {
  const next: Panes = { ...panes }
  for (const [k, v] of Object.entries(patch) as [keyof Panes, boolean | number | undefined][]) {
    if (v === undefined) delete next[k]
    else (next as Record<string, boolean | number>)[k] = v
  }
  return parsePanes(next)
}
