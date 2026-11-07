import { describe, expect, it } from 'vitest'
import { LINE_KINDS } from './linecache'
import { axisTicks, bracketAt, shareText, viewSpan } from './overview'

describe('the share a statement took', () => {
  // io_waits.trc: 6.46 s
  const SPAN = 6_460_000
  it('reads like the mock: `38 %`, and `< 1 %` for a sliver', () => {
    expect(shareText(2_486_000, SPAN)).toBe('38 %')
    expect(shareText(40, SPAN)).toBe('< 1 %')
    expect(shareText(0, SPAN)).toBe('0 %')
    expect(shareText(5, 0)).toBe('–')
  })
})

describe('the time axis', () => {
  // io_waits.trc: 11:35:29.191045 UTC to +6.46 s; tim and wall are µs
  const FROM = 10_804_499_034
  const clock = { wallOffsetUs: Date.UTC(2026, 9, 22, 11, 35, 29) * 1000 + 191_045 - FROM, tzOffsetMin: 0 }
  it('ticks on whole seconds of the wall clock, with HH:MM:SS labels, inside the bar', () => {
    const ticks = axisTicks(FROM, FROM + 6_460_000, clock)
    expect(ticks.length).toBeGreaterThanOrEqual(4)
    expect(ticks.length).toBeLessThanOrEqual(8)
    for (const t of ticks) { expect(t.f).toBeGreaterThanOrEqual(0); expect(t.f).toBeLessThanOrEqual(1); expect(t.label).toMatch(/^\d\d:\d\d:\d\d$/) }
    // the first tick is the next whole second after the first row's clock
    const first = ticks[0]
    expect(first.label.endsWith(':30')).toBe(true)
    expect(first.f).toBeCloseTo((1_000_000 - 191_045) / 6_460_000, 6)
    // consecutive ticks are a whole step apart
    expect((ticks[1].f - ticks[0].f) * 6_460_000).toBeCloseTo(1_000_000, 3)
  })
  it('a short span ticks in milliseconds, a long one in minutes', () => {
    const ms = axisTicks(FROM, FROM + 40_000, clock)
    expect(ms[0].label).toMatch(/^\d\d:\d\d:\d\d\.\d\d\d$/)
    const long = axisTicks(FROM, FROM + 3_600_000_000, clock)
    expect(long.length).toBeLessThanOrEqual(8)
    expect(long[1].f - long[0].f).toBeGreaterThan(0)
  })
  it('a trace without a wall clock ticks on round offsets from its start', () => {
    const ticks = axisTicks(FROM, FROM + 6_460_000, { wallOffsetUs: 0, tzOffsetMin: 0 })
    expect(ticks.map((t) => t.label)).toEqual(['0', '+1 s', '+2 s', '+3 s', '+4 s', '+5 s', '+6 s'])
    expect(ticks[0].f).toBe(0)
  })
  it('no ticks for an empty span', () => {
    expect(axisTicks(FROM, FROM, clock)).toEqual([])
  })
})

describe('the bracket of the rows in view', () => {
  const lines: [string, string][] = [
    ['blank', ''],
    ['call', 'EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=1000'],
    ['blank', ''],
    ["wait", "WAIT #1: nam='x' ela= 5 p1=0 p2=0 p3=0 obj#=-1 tim=1500"],
    ['blank', ''],
  ]
  const cache = { line: (n: number) => { const l = lines[n - 1]; return l ? { text: l[1], kind: LINE_KINDS.indexOf(l[0] as never) } : undefined } }
  it('runs from the first timed line in view to the last one', () => {
    expect(viewSpan(cache, 1, 5)).toEqual([1000, 1500])
    expect(viewSpan(cache, 3, 3)).toEqual([1500, 1500])
    expect(viewSpan(cache, 1, 1)).toBeNull() // a blank line only
    expect(viewSpan(cache, 6, 4)).toBeNull() // not loaded
  })
  it('sits on the bar as fractions of the span, clamped to it', () => {
    expect(bracketAt([1000, 1500], 0, 2000)).toEqual({ left: 0.5, width: 0.25 })
    expect(bracketAt([-100, 5000], 0, 2000)).toEqual({ left: 0, width: 1 })
    expect(bracketAt([3000, 4000], 0, 2000)).toBeNull()
    expect(bracketAt(null, 0, 2000)).toBeNull()
  })
})
