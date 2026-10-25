/**
 * Clock times (`HH:MM:SS[.fff]`, `YYYY-MM-DD HH:MM:SS[.fff]`) against a trace's wall-clock origin.
 * A wall value is µs since the epoch; shown in the trace file's own zone it is `wall + tz·60 s` read as UTC (see `fmtWall`).
 */

/** What mapping a clock time to a trace tim needs (a TraceDoc has all of it). */
export interface ClockDoc {
  wallOffsetUs: number
  tzOffsetMin: number
  span: { firstTim: number; lastTim: number }
}

export interface Clock {
  /** UTC fields of the date as written; null for a bare time of day */
  date: { y: number; m: number; d: number } | null
  /** µs since local midnight (the trace file's zone) */
  dayUs: number
}

/** `HH:MM:SS[.ffffff]` or `YYYY-MM-DD[ T]HH:MM:SS[.ffffff]`; null when the text is neither. */
export function parseClock(text: string): Clock | null {
  const m = /^\s*(?:(\d{4})-(\d\d)-(\d\d)[ T]+)?(\d{1,2}):(\d\d):(\d\d)(?:[.,](\d{1,6}))?\s*$/.exec(text)
  if (!m) return null
  const [h, mi, s] = [Number(m[4]), Number(m[5]), Number(m[6])]
  if (h > 23 || mi > 59 || s > 59) return null
  let date: Clock['date'] = null
  if (m[1] !== undefined) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
    const t = new Date(Date.UTC(y, mo - 1, d))
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null
    date = { y, m: mo, d }
  }
  const frac = m[7] ? Number(m[7].padEnd(6, '0')) : 0
  return { date, dayUs: ((h * 60 + mi) * 60 + s) * 1e6 + frac }
}

const DAY_US = 86_400e6

/** wall µs (epoch) → trace tim; 0 offset = the trace has no timestamps */
export const timOfWall = (doc: Pick<ClockDoc, 'wallOffsetUs'>, wallUs: number): number => wallUs - doc.wallOffsetUs

/**
 * The tim a clock time stands for, or null when the trace has no wall clock.
 * A bare time of day is read on the day the trace starts, or the day after when that lands inside the trace instead
 * (a trace that runs past midnight); otherwise the day of the start.
 */
export function clockToTim(doc: ClockDoc, c: Clock): number | null {
  if (!doc.wallOffsetUs) return null
  const tzUs = doc.tzOffsetMin * 60e6
  const first = doc.span.firstTim, last = doc.span.lastTim
  if (c.date) return timOfWall(doc, Date.UTC(c.date.y, c.date.m - 1, c.date.d) * 1000 + c.dayUs - tzUs)
  const localFirst = first + doc.wallOffsetUs + tzUs // the first tim as a local wall clock, µs since the epoch (zone applied)
  const midnight = Math.floor(localFirst / DAY_US) * DAY_US
  const day0 = midnight + c.dayUs - tzUs - doc.wallOffsetUs
  if (day0 >= first - 0.5 || day0 + DAY_US > last) return day0
  return day0 + DAY_US
}

/** The tim of a clock text, or null when it is not one or the trace has no wall clock. */
export function parseClockTim(text: string, doc: ClockDoc): number | null {
  const c = parseClock(text)
  return c ? clockToTim(doc, c) : null
}
