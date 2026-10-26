import { CallKind } from './types'

/** Call kind → color token. The Timeline and the Overview lanes document this mapping in a legend. */
export type KindGroup = 'parse' | 'exec' | 'fetch' | 'close' | 'other'

export const kindGroups: { id: KindGroup; label: string; token: string }[] = [
  { id: 'parse', label: 'PARSE', token: '--c-sysio' },
  { id: 'exec', label: 'EXEC', token: '--c-cpu' },
  { id: 'fetch', label: 'FETCH', token: '--c-userio' },
  { id: 'close', label: 'CLOSE', token: '--c-idle' },
  { id: 'other', label: 'LOB / commit / RPC', token: '--c-other' },
]

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
