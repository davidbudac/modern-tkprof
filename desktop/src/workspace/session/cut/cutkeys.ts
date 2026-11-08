/** Keyboard decision for the label list beside the Cut map (unit-tested; CutView only wires it). */
import { isActivateKey, nextIndex } from '@lib/components/keyNav'

export type PieceKey = { kind: 'select' } | { kind: 'move'; to: number }

/**
 * What a key does on the label of piece `i` of `n`: Enter/Space select it, Down/Up (or j/k, as in the Statements
 * list) and Home/End move the selection, and focus with it; null leaves the key alone (also at either end of the list).
 */
export function pieceKey(key: string, i: number, n: number): PieceKey | null {
  if (isActivateKey(key)) return { kind: 'select' }
  const k = key === 'j' ? 'ArrowDown' : key === 'k' ? 'ArrowUp' : key
  const to = nextIndex(k, i, n)
  return to === null ? null : { kind: 'move', to }
}
