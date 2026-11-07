// The Trace pane's highlighted statements: an ordered set, each with a colour slot it keeps for as long as it stays in the set. Only a highlighted statement
// has a colour in the pane (every other one is neutral), and the colours come from the categorical palette, so a statement keeps its hue while others come and go.
import { CATEGORICAL, type Tone } from './blocklayout'

/** The highlighted statements in the order they were added, and the colour slot each took. */
export interface HlSet { readonly ids: readonly number[]; readonly slots: ReadonlyMap<number, number> }

/** Nothing highlighted. */
export const NO_HL: HlSet = { ids: [], slots: new Map() }

/** The number of colour slots: the categorical palette's. With more statements highlighted than this, slots repeat. */
export const HL_SLOTS = CATEGORICAL.length

/**
 * The slot a statement added now takes: the lowest one nobody uses; once every slot is taken, the one the fewest statements use (the lowest on a tie),
 * so the colours repeat as evenly as they can.
 */
export function freeSlot(used: Iterable<number>): number {
  const n = new Array<number>(HL_SLOTS).fill(0)
  for (const s of used) n[s % HL_SLOTS]++
  let best = 0
  for (let s = 1; s < HL_SLOTS; s++) if (n[s] < n[best]) best = s
  return best
}

/** The set with `ids` added (the ones already in it keep their slot and place). Returns `set` itself when nothing is new. */
export function addHl(set: HlSet, ids: Iterable<number>): HlSet {
  let out: number[] | null = null
  let slots: Map<number, number> | null = null
  for (const id of ids) {
    if ((slots ?? set.slots).has(id)) continue
    if (!out) { out = [...set.ids]; slots = new Map(set.slots) }
    slots!.set(id, freeSlot(slots!.values()))
    out.push(id)
  }
  return out ? { ids: out, slots: slots! } : set
}

/** The set without `ids`; nobody else changes colour. Returns `set` itself when none of them was in it. */
export function removeHl(set: HlSet, ids: Iterable<number>): HlSet {
  const drop = new Set<number>()
  for (const id of ids) if (set.slots.has(id)) drop.add(id)
  if (drop.size === 0) return set
  const kept = set.ids.filter((id) => !drop.has(id))
  return kept.length === 0 ? NO_HL : { ids: kept, slots: new Map(kept.map((id) => [id, set.slots.get(id)!])) }
}

/** The set with `id` out when it is in, in when it is not. */
export const toggleHl = (set: HlSet, id: number): HlSet => (set.slots.has(id) ? removeHl(set, [id]) : addHl(set, [id]))

/** Every one of `ids` in (`on`) or out of the set. */
export const setHl = (set: HlSet, ids: Iterable<number>, on: boolean): HlSet => (on ? addHl(set, ids) : removeHl(set, ids))

/** The tone of a colour slot (the palette token; no shade: a slot is one of the palette's hues). */
export const slotTone = (slot: number): Tone => ({ token: CATEGORICAL[slot % HL_SLOTS], shade: 0 })

/** Each highlighted statement's tone. */
export function hlTones(set: HlSet): Map<number, Tone> {
  return new Map(set.ids.map((id) => [id, slotTone(set.slots.get(id)!)]))
}
