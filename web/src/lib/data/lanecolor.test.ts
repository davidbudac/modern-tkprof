import { describe, expect, it } from 'vitest'
import { LANE_COLORS, decadeStep, isLaneColor, laneColorOf, laneLegend, rampColor, type LaneFacts } from './lanecolor'

const base: LaneFacts = { stmt: 'var(--c-cpu)', kind: 'call', label: 'FETCH', execNo: 3, ctx: 1, depth: 0, role: 'cpu', dur: 2500, delta: 40_000 }

describe('lane colours', () => {
  it('steps by decade', () => {
    expect([0, 99, 100, 999, 1000, 9_999, 10_000, 100_000, 999_999, 1_000_000, 5e9].map(decadeStep)).toEqual([0, 0, 1, 1, 2, 2, 3, 4, 4, 5, 5])
  })
  it('colours a line by each mode', () => {
    expect(laneColorOf('stmt', base)).toBe('var(--c-cpu)')
    expect(laneColorOf('none', base)).toBeUndefined()
    expect(laneColorOf('exec', base)).toBe('var(--c-other)') // CATEGORICAL[3]
    expect(laneColorOf('exec', { ...base, execNo: -1 })).toBeUndefined()
    expect(laneColorOf('op', base)).toBe('var(--c-network)')
    expect(laneColorOf('op', { ...base, kind: 'bind-line', label: 'Bind#2' })).toBe('var(--c-concurrency)')
    expect(laneColorOf('op', { ...base, kind: 'sql-text', label: '' })).toBe('var(--c-sysio)')
    expect(laneColorOf('op', { ...base, kind: 'stat', label: 'PLAN' })).toBeUndefined()
    expect(laneColorOf('class', { ...base, kind: 'wait', role: 'userio' })).toBe('var(--c-userio)')
    expect(laneColorOf('class', { ...base, role: undefined })).toBeUndefined()
    expect(laneColorOf('dur', base)).toBe(rampColor(2))
    expect(laneColorOf('delta', base)).toBe(rampColor(3))
    expect(laneColorOf('delta', { ...base, delta: -5 })).toBeUndefined()
    expect(laneColorOf('depth', { ...base, depth: 1 })).toBe('var(--c-network)')
  })
  it('has a key for the modes whose colours mean something fixed', () => {
    expect(laneLegend('stmt')).toBeNull()
    expect(laneLegend('dur')!.map((e) => e.label)).toEqual(['under 100 µs', '100 µs – 1 ms', '1 ms – 10 ms', '10 ms – 100 ms', '100 ms – 1 s', '1 s or more'])
    expect(laneLegend('session', ['a', 'b'])!.map((e) => e.label)).toEqual(['a', 'b'])
    expect(LANE_COLORS.every((c) => isLaneColor(c.id))).toBe(true)
    expect(isLaneColor('bogus')).toBe(false)
  })
})
