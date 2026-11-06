import { describe, expect, it } from 'vitest'
import { PLAN_COLUMNS } from './readable'
import { PLAN_DROP, hiddenNote, hiddenPlanColumns, planHidden, planNeed } from './planlayout'

const CHW = 7.2 // a digit of the 12 px mono font
const HANDLE = 10 * CHW - CHW - 1 // the Operation column (10 digits) less the table's 1 ch inset and its 1 px frame

describe('the plan table drops columns in a fixed order as it narrows', () => {
  it('Cost, E-Rows, Starts, Writes, then Name (merged into Operation)', () => {
    expect(PLAN_DROP).toEqual(['cost', 'eRows', 'starts', 'pw', 'name'])
    expect([...hiddenPlanColumns(1)]).toEqual(['cost'])
    expect([...hiddenPlanColumns(3)]).toEqual(['cost', 'eRows', 'starts'])
    expect([...hiddenPlanColumns(5)]).toEqual(['cost', 'eRows', 'starts', 'pw', 'name'])
    expect(hiddenPlanColumns(0).size).toBe(0)
  })
  it('never drops Operation, A-Rows, A-Time, Buffers or Reads, whatever the width', () => {
    const all = hiddenPlanColumns(99)
    for (const k of ['aRows', 'time', 'cr', 'pr', 'op', 'id']) expect(all.has(k)).toBe(false)
    const keys = PLAN_COLUMNS.map((c) => c.key)
    for (const k of PLAN_DROP) expect(k === 'name' || keys.includes(k)).toBe(true) // every other name is a real column
  })
  it('each drop needs less room than the one before', () => {
    for (let l = 1; l <= 5; l++) expect(planNeed(l, CHW, HANDLE)).toBeLessThan(planNeed(l - 1, CHW, HANDLE))
  })
  it('a wide view shows everything; the narrower, the more is hidden', () => {
    expect(planHidden(1400, CHW, HANDLE)).toBe(0)
    let last = 0
    for (let w = 1400; w >= 300; w -= 10) {
      const h = planHidden(w, CHW, HANDLE)
      expect(h).toBeGreaterThanOrEqual(last) // monotone
      last = h
    }
    expect(last).toBe(5) // nothing fits: all five go, the table clips what is left
  })
  it('the least that fits: the width of a table is exactly enough for its level, one px less drops the next column', () => {
    for (let l = 0; l < 5; l++) {
      const need = planNeed(l, CHW, HANDLE)
      expect(planHidden(need, CHW, HANDLE)).toBe(l)
      expect(planHidden(need - 1, CHW, HANDLE)).toBe(l + 1)
    }
  })
  it('1280 px with the side panel open (about 520 px of table): Cost, E-Rows and Starts go before anything else; 1100 px without it: three hidden', () => {
    expect(planHidden(520, CHW, HANDLE)).toBeGreaterThanOrEqual(3)
    expect(planHidden(750, CHW, HANDLE)).toBe(3)
    expect([...hiddenPlanColumns(planHidden(750, CHW, HANDLE))]).toEqual(['cost', 'eRows', 'starts'])
  })
  it('an unmeasured table drops nothing', () => {
    expect(planHidden(0, CHW, HANDLE)).toBe(0)
    expect(planHidden(800, 0, HANDLE)).toBe(0)
  })
  it('the head row says how many are hidden and which', () => {
    expect(hiddenNote(0)).toBeNull()
    expect(hiddenNote(1)?.text).toBe('1 column hidden')
    expect(hiddenNote(3)?.text).toBe('3 columns hidden')
    expect(hiddenNote(3)?.title).toContain('Cost, E-Rows, Starts')
    expect(hiddenNote(5)?.title).toContain('Name (merged into Operation)')
  })
})
