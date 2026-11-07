import { describe, expect, it } from 'vitest'
import { HL_SLOTS, NO_HL, addHl, freeSlot, hlTones, removeHl, setHl, slotTone, toggleHl } from './hlset'

const slots = (s: ReturnType<typeof addHl>) => s.ids.map((id) => s.slots.get(id))

describe('the highlight set and its colour slots', () => {
  it('takes the lowest free slot as statements are added, in order', () => {
    const s = addHl(NO_HL, [40, 7, 12])
    expect(s.ids).toEqual([40, 7, 12])
    expect(slots(s)).toEqual([0, 1, 2])
  })
  it('keeps a statement\'s slot while it is in the set: removing one recolours nobody', () => {
    const s = removeHl(addHl(NO_HL, [1, 2, 3]), [2])
    expect(s.ids).toEqual([1, 3])
    expect(slots(s)).toEqual([0, 2])
  })
  it('hands the freed slot to the next statement added (the lowest free one)', () => {
    const s = addHl(removeHl(addHl(NO_HL, [1, 2, 3]), [1]), [9])
    expect(s.ids).toEqual([2, 3, 9])
    expect(slots(s)).toEqual([1, 2, 0])
  })
  it('adding a statement that is in the set changes nothing (and returns the same set)', () => {
    const s = addHl(NO_HL, [1, 2])
    expect(addHl(s, [2])).toBe(s)
    expect(addHl(s, [])).toBe(s)
    expect(removeHl(s, [99])).toBe(s)
  })
  it('repeats the slots past the palette, the least used first', () => {
    const ids = Array.from({ length: HL_SLOTS + 3 }, (_, i) => i)
    const s = addHl(NO_HL, ids)
    expect(slots(s)).toEqual([...Array.from({ length: HL_SLOTS }, (_, i) => i), 0, 1, 2])
    // one of the slot-0 statements goes: slot 0 is now used once, the others twice or once, and the next statement takes the least used, lowest first
    expect(freeSlot([0, 0, 1, 1, 2, 2, 3, 4, 5, 6])).toBe(3)
  })
  it('toggles and sets many at once', () => {
    let s = toggleHl(NO_HL, 5)
    expect(s.ids).toEqual([5])
    s = toggleHl(s, 5)
    expect(s).toBe(NO_HL)
    s = setHl(NO_HL, [3, 4, 5], true)
    expect(s.ids).toEqual([3, 4, 5])
    expect(setHl(s, [3, 5, 8], false).ids).toEqual([4])
    expect(setHl(s, [3, 4, 5], false)).toBe(NO_HL)
  })
  it('names the tone of each slot from the categorical palette', () => {
    expect(slotTone(0)).toEqual({ token: '--c-cpu', shade: 0 })
    expect(slotTone(HL_SLOTS)).toEqual(slotTone(0))
    const t = hlTones(addHl(NO_HL, [8, 9]))
    expect([...t.keys()]).toEqual([8, 9])
    expect(t.get(9)).toEqual(slotTone(1))
  })
})
