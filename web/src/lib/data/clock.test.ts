import { describe, expect, it } from 'vitest'
import { clockToTim, parseClock, parseClockTim, type ClockDoc } from './clock'

/** A trace whose first record is at 2026-01-02 12:00:00 local (UTC+02:00 = 10:00 UTC), tim 1000, running `lenUs`. */
const docAt = (lenUs: number, tzOffsetMin = 120, local = Date.UTC(2026, 0, 2, 12, 0, 0)): ClockDoc => {
  const firstWall = (local - tzOffsetMin * 60000) * 1000
  return { wallOffsetUs: firstWall - 1000, tzOffsetMin, span: { firstTim: 1000, lastTim: 1000 + lenUs } }
}
const hour = 3600e6

describe('parseClock', () => {
  it('reads a time of day with optional fraction', () => {
    expect(parseClock('14:03:07')).toEqual({ date: null, dayUs: ((14 * 60 + 3) * 60 + 7) * 1e6 })
    expect(parseClock(' 9:05:00.25 ')?.dayUs).toBe(((9 * 60 + 5) * 60) * 1e6 + 250000)
    expect(parseClock('00:00:01.000123')?.dayUs).toBe(1e6 + 123)
    expect(parseClock('00:00:01,5')?.dayUs).toBe(1.5e6)
  })
  it('reads a date and time', () => {
    expect(parseClock('2026-01-02 14:03:07.5')).toEqual({ date: { y: 2026, m: 1, d: 2 }, dayUs: ((14 * 60 + 3) * 60 + 7) * 1e6 + 500000 })
    expect(parseClock('2026-01-02T14:03:07')?.date).toEqual({ y: 2026, m: 1, d: 2 })
  })
  it('rejects what is not a clock time', () => {
    for (const t of ['', '1.5s', '14:03', '24:00:00', '12:60:00', '12:00:60', '2026-13-01 10:00:00', '2026-02-30 10:00:00', 'noon', '12:00:00 pm']) expect(parseClock(t), t).toBeNull()
  })
})

describe('clockToTim', () => {
  it('maps the trace start and later times of the same day (in the file zone)', () => {
    const d = docAt(hour)
    expect(parseClockTim('12:00:00', d)).toBe(1000)
    expect(parseClockTim('12:00:30.5', d)).toBe(1000 + 30.5e6)
    expect(parseClockTim('2026-01-02 12:30:00', d)).toBe(1000 + 1800e6)
  })
  it('honours a negative zone', () => {
    const d = docAt(hour, -300, Date.UTC(2026, 0, 2, 7, 0, 0))
    expect(parseClockTim('07:00:10', d)).toBe(1000 + 10e6)
  })
  it('reads a time before the start as the next day only when the trace runs past midnight', () => {
    const late = docAt(3 * hour, 120, Date.UTC(2026, 0, 2, 23, 0, 0))
    expect(parseClockTim('00:30:00', late)).toBe(1000 + 1.5 * hour) // inside the trace, after midnight
    expect(parseClockTim('22:00:00', late)).toBe(1000 - hour) // outside: stays on the start's day
  })
  it('an explicit date wins', () => {
    const d = docAt(hour)
    expect(parseClockTim('2026-01-03 12:00:00', d)).toBe(1000 + 24 * hour)
  })
  it('is null without timestamps', () => {
    expect(clockToTim({ wallOffsetUs: 0, tzOffsetMin: 0, span: { firstTim: 0, lastTim: 10 } }, { date: null, dayUs: 0 })).toBeNull()
  })
})
