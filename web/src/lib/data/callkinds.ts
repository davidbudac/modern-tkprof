import { CallKind } from './types'

/**
 * Call kind → color token. The Timeline and the Overview lanes document this mapping in a legend.
 * Phases are shades of one neutral ramp (`--c-phase-*`), never the wait-class hues: the lanes draw wait strips
 * right next to them, and a FETCH bar must not read as User I/O. Adjacent shades are close, so each phase also
 * carries a brush (hatch direction / stripes / crosshatch; FETCH, the bulk of most traces, stays solid).
 */
export type KindGroup = 'parse' | 'exec' | 'fetch' | 'close' | 'other'

/** How a phase's fill is textured on top of its shade; `--b-phase-*` in CSS, `phasePattern` on canvas. */
export type Brush = 'solid' | 'fwd' | 'back' | 'vert' | 'cross'

export const kindGroups: { id: KindGroup; label: string; token: string; brush: Brush }[] = [
  { id: 'parse', label: 'PARSE', token: '--c-phase-parse', brush: 'fwd' },
  { id: 'exec', label: 'EXEC', token: '--c-phase-exec', brush: 'back' },
  { id: 'fetch', label: 'FETCH', token: '--c-phase-fetch', brush: 'solid' },
  { id: 'close', label: 'CLOSE', token: '--c-phase-close', brush: 'vert' },
  { id: 'other', label: 'LOB / commit / RPC', token: '--c-phase-other', brush: 'cross' },
]

/** CSS `background` for a phase: its brush layered over its shade. */
export function phaseBackground(g: KindGroup): string {
  return `var(--b-phase-${g}), var(--c-phase-${g})`
}

/** Index of a group in `kindGroups` (and in the engine's phase `us` array: parse, exec, fetch, close, other). */
export const groupIndex: Record<KindGroup, number> = { parse: 0, exec: 1, fetch: 2, close: 3, other: 4 }

export function groupOf(kind: number): KindGroup {
  switch (kind) {
    case CallKind.parse: return 'parse'
    case CallKind.exec: return 'exec'
    case CallKind.fetch: return 'fetch'
    case CallKind.close: return 'close'
    default: return 'other'
  }
}
