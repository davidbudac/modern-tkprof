import { BIND_TYPE_NAMES } from './bindat'
import { fmtDur } from './format'
import type { DecodeContext } from './linefields'
import type { LineKind } from './lines'

export type InlayKind = 'bind' | 'type' | 'clock' | 'obj' | 'dur' | 'gap'
/** A dim annotation rendered inside a row: inserted after character index `at` of the text (`at` = text.length appends, `at` = 0 inserts before the text). */
export interface Inlay { at: number; text: string; kind: InlayKind }

const BIND_RE = /^\s*Bind#\d+/
const OACDTY_RE = /oacdty=(\d+)/
const TIM_RE = /\btim=(\d+)/g
const OBJ_WAIT_RE = /\bobj#=(\d+)/
const OBJ_STAT_RE = /\sobj=(\d+)/
const E_RE = /[:,]e=(\d+)/
const ELA_RE = /' ela=\s*(\d+)/

/** Where the dim duration of an `e=` / `ela=` starts to be worth showing: a millisecond. */
const DUR_MIN_US = 1000

/** The end index of the last match of `re` (global) in `text`, with its number. */
function lastMatch(re: RegExp, text: string): { end: number; n: number } | undefined {
  re.lastIndex = 0
  let r: { end: number; n: number } | undefined
  for (let m = re.exec(text); m; m = re.exec(text)) r = { end: m.index + m[0].length, n: Number(m[1]) }
  return r
}

function bindValueInlay(text: string, line: number, ctx: DecodeContext): Inlay[] {
  const ba = ctx.bindAt?.(line)
  const b = ba?.bind
  if (!ba || !b) return []
  const noValue = b.noDef || b.dump || (b.value === '' && !b.typed)
  const value = b.isNull ? 'NULL' : noValue ? '(no value)' : b.typed || b.value
  const type = b.type || (ba.dty !== undefined ? BIND_TYPE_NAMES[ba.dty] : '') || ''
  return [{ at: text.length, text: type ? `= ${value} ${type}` : `= ${value}`, kind: 'bind' }]
}

/** The hints of one line. `gapUs` is the idle gap before the line when the owner knows it (see gaps.ts), shown only when > 0. */
export function inlaysOf(text: string, kind: LineKind, line: number, ctx: DecodeContext, gapUs?: number): Inlay[] {
  if (kind !== 'call' && kind !== 'wait' && kind !== 'xctend' && kind !== 'stat' && kind !== 'bind-line') return []
  const out: Inlay[] = []
  if (gapUs !== undefined && gapUs > 0) out.push({ at: 0, text: `gap ${fmtDur(gapUs)}`, kind: 'gap' })
  if (kind === 'bind-line') {
    if (BIND_RE.test(text)) out.push(...bindValueInlay(text, line, ctx))
    const m = OACDTY_RE.exec(text)
    const name = m ? BIND_TYPE_NAMES[Number(m[1])] : undefined
    if (m && name) out.push({ at: m.index + m[0].length, text: name, kind: 'type' })
  } else if (kind === 'stat') {
    const m = OBJ_STAT_RE.exec(text)
    const name = m && Number(m[1]) > 0 ? ctx.objectName?.(Number(m[1])) : undefined
    if (m && name) out.push({ at: m.index + m[0].length, text: name, kind: 'obj' })
  } else {
    const tim = lastMatch(TIM_RE, text)
    const clock = tim ? ctx.clock?.(tim.n) : undefined
    if (tim && clock) out.push({ at: tim.end, text: clock, kind: 'clock' })
    if (kind === 'wait') {
      const m = OBJ_WAIT_RE.exec(text)
      const name = m && Number(m[1]) > 0 ? ctx.objectName?.(Number(m[1])) : undefined
      if (m && name) out.push({ at: m.index + m[0].length, text: name, kind: 'obj' })
    }
    if (kind !== 'xctend') {
      const m = (kind === 'call' ? E_RE : ELA_RE).exec(text)
      if (m && Number(m[1]) >= DUR_MIN_US) out.push({ at: m.index + m[0].length, text: fmtDur(Number(m[1])), kind: 'dur' })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}
