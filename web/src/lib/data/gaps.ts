import { LINE_KINDS } from './linecache'
import type { LineKind } from './lines'
import { elaOf } from './linefields'

/** The `tim=` of a call, wait or XCTEND line, undefined for other lines. */
export function timOf(text: string, kind: LineKind): number | undefined {
  if (kind !== 'call' && kind !== 'wait' && kind !== 'xctend') return undefined
  const i = text.lastIndexOf('tim=')
  if (i < 0) return undefined
  let v = 0, any = false
  for (let j = i + 4; j < text.length; j++) {
    const c = text.charCodeAt(j) - 48
    if (c < 0 || c > 9) break
    v = v * 10 + c
    any = true
  }
  return any ? v : undefined
}

/** The duration the line itself covers: `e=` of a call, `ela=` of a wait, 0 otherwise. */
export function durOf(text: string, kind: LineKind): number {
  return Math.max(0, elaOf(text, kind))
}

export interface Gap { us: number; fromLine: number }

/**
 * The idle gap before `line`: its start (tim minus its own duration) minus the tim of the line before it, walking back at most
 * `maxBack` lines over the loaded pages. The WAIT lines of a call are printed before the call's own line, and its `e=` covers them,
 * so for a call line the reference is the previous call line (waits and XCTEND are skipped); for a wait or XCTEND line it is the
 * previous line of any kind with a tim. null when the line has no tim, no earlier reference is loaded, or the gap is <= 0.
 */
export function gapBefore(cache: { line(n: number): { text: string; kind: number } | undefined }, line: number, maxBack = 2000): Gap | null {
  const cur = cache.line(line)
  if (!cur) return null
  const kind = LINE_KINDS[cur.kind]
  const tim = timOf(cur.text, kind)
  if (tim === undefined) return null
  const start = tim - durOf(cur.text, kind)
  const callsOnly = kind === 'call'
  for (let n = line - 1, i = 0; n >= 1 && i < maxBack; n--, i++) {
    const l = cache.line(n)
    if (!l) return null
    const k = LINE_KINDS[l.kind]
    if (callsOnly && k !== 'call') continue
    const prev = timOf(l.text, k)
    if (prev === undefined) continue
    const us = start - prev
    return us > 0 ? { us, fromLine: n } : null
  }
  return null
}
