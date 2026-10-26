// The global filters that narrow every view (`scopeOf`), as the chips of the filter row under the top bar.
import type { TraceDoc } from './doc'
import { fileCount, selectedCount, sessionLabel } from './fileset'
import { fmtDur, fmtWall } from './format'
import { activeBlock, type State } from '../state/store'

export type FilterKind = 'files' | 'sessions' | 'window' | 'idle'

/** One active filter: the chip's kind label and text, and a longer `title` for its tooltip. */
export interface ActiveFilter { kind: FilterKind; label: string; text: string; title: string }

/** What `activeFilters` reads of the store. */
export type FilterState = Pick<State, 'files' | 'contexts' | 'window' | 'block' | 'includeIdle'>

/** Names listed in a chip before "+N". */
const MAX_FILES = 3
const MAX_SESSIONS = 2

/** `a, b, c +2` */
function nameList(names: string[], max: number): string {
  return names.slice(0, max).join(', ') + (names.length > max ? ` +${names.length - max}` : '')
}

/**
 * The filters in force, in the order files, sessions, window, idle: the Files panel selection, the Sessions selection, the time
 * window (and the lane block it came from) and hidden idle waits. `origin` is the tim that `+offset` times count from when the
 * trace has no wall clock.
 */
export function activeFilters(doc: TraceDoc, s: FilterState, origin = doc.span.firstTim): ActiveFilter[] {
  const out: ActiveFilter[] = []

  if (s.files) {
    const n = fileCount(doc)
    const list = doc.file.files ?? []
    const names = list.filter((_, i) => s.files!.has(i)).map((f) => f.name || f.path.split(/[\\/]/).pop() || f.path)
    const count = `${selectedCount(doc, s.files)} of ${n} files`
    out.push({
      kind: 'files', label: 'Files', text: names.length ? `${count} · ${nameList(names, MAX_FILES)}` : count,
      title: names.length ? `Only these files are shown:\n${list.filter((_, i) => s.files!.has(i)).map((f) => f.path).join('\n')}` : 'No file is selected: the views are empty',
    })
  }

  if (s.contexts) {
    const labels: string[] = []
    for (const id of [...s.contexts].sort((a, b) => a - b)) {
      const c = doc.contexts[id]
      const l = c ? sessionLabel(c) : '–'
      if (l !== '–' && !labels.includes(l)) labels.push(l) // an unnamed context adds nothing to read
    }
    const count = `${s.contexts.size} of ${doc.contexts.length} sessions`
    out.push({
      kind: 'sessions', label: 'Sessions', text: labels.length ? `${count} · ${nameList(labels, MAX_SESSIONS)}` : count,
      title: `Only these session contexts are shown${labels.length ? `:\n${labels.join('\n')}` : ''}`,
    })
  }

  const w = s.window
  if (w) {
    const micros = w.endTim - w.startTim < 10_000 // a window under 10 ms needs µs, or its ends read the same
    const at = (tim: number, date = false) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(tim), doc.tzOffsetMin, { micros, date }) : `+${fmtDur(tim - origin)}`)
    const block = activeBlock(s)
    const blockOf = block && doc.statements[block.stmt] ? doc.label(doc.statements[block.stmt]) : null
    out.push({
      kind: 'window', label: 'Window', text: `${at(w.startTim)} → ${at(w.endTim)} · ${fmtDur(w.endTim - w.startTim)}${blockOf ? ` · block of ${blockOf}` : ''}`,
      title: `Only this time window is counted: ${at(w.startTim, true)} → ${at(w.endTim, true)}${blockOf ? `\nthe block of ${blockOf} that was clicked in the Overview lanes` : ''}`,
    })
  }

  if (!s.includeIdle) out.push({ kind: 'idle', label: 'Idle waits', text: 'hidden', title: 'Idle waits (SQL*Net message from client and the like) are left out of the wait statistics and the timeline strips' })

  return out
}
