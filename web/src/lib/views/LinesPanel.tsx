import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Bookmark } from '../state/store'
import { fmtInt } from '../data/format'
import { matchSpan, sameSearch, type RecentSearch, type SearchHit } from '../data/lines'

const HIT_H = 22
/** characters of the line shown before the match, so it is visible in a narrow panel */
const LEAD = 14

/** The hits of a search, streamed in: `hits` grows while `count` (the render trigger) follows it. */
export function HitList({ hits, count, selected, q, regex, caseSensitive, onGo }: {
  hits: SearchHit[]; count: number; selected: number; q: string; regex: boolean; caseSensitive: boolean; onGo(line: number): void
}) {
  const box = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count, getScrollElement: () => box.current, estimateSize: () => HIT_H, overscan: 12 })
  if (count === 0) return <p className="small muted lines-empty">No hits.</p>
  return (
    <div className="lines-hits" ref={box} role="listbox" aria-label="Search hits">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((it) => {
          const h = hits[it.index]
          if (!h) return null
          const span = matchSpan(h, q, regex, caseSensitive)
          return (
            <div key={it.key} role="option" aria-selected={h.line === selected} className={'lines-hit' + (h.line === selected ? ' on' : '')}
              style={{ position: 'absolute', insetBlockStart: 0, insetInline: 0, height: HIT_H, transform: `translateY(${it.start}px)` }}
              onClick={() => onGo(h.line)} title={`line ${fmtInt(h.line)}, column ${h.col}`}>
              <span className="ln">{fmtInt(h.line)}</span>
              <span className="col">{h.col}</span>
              <code>{span ? <>{span[0] > LEAD && '…'}{h.text.slice(Math.max(0, span[0] - LEAD), span[0])}<mark>{h.text.slice(span[0], span[1])}</mark>{h.text.slice(span[1])}</> : h.text}</code>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export function BookmarkList({ bookmarks, fileName, onGo, onLabel, onRemove, onNote }: {
  bookmarks: Bookmark[]; fileName(file: number): string; onGo(b: Bookmark): void; onLabel(b: Bookmark, label: string): void; onRemove(b: Bookmark): void
  /** edit the bookmark's note (notes enabled) */
  onNote?(b: Bookmark): void
}) {
  if (bookmarks.length === 0) return <p className="small muted lines-empty">No bookmarks. Right-click a line number, or press <kbd>b</kbd> on the selected line.</p>
  return (
    <ul className="lines-bms">
      {bookmarks.map((b) => (
        <li key={`${b.file}:${b.line}`}>
          <button className="link lineref" onClick={() => onGo(b)} title="go to this line">{fileName(b.file) ? `${fileName(b.file)}:` : ''}{fmtInt(b.line)}</button>
          <input type="text" defaultValue={b.label} aria-label={`Label of the bookmark at line ${b.line}`}
            onBlur={(e) => { if (e.target.value !== b.label) onLabel(b, e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          {(onNote || b.note) && <button className={'quiet note-btn' + (b.note ? ' on' : '')} disabled={!onNote} onClick={() => onNote?.(b)} title={b.note || 'add a note'} aria-label={`${b.note ? 'Edit the note' : 'Add a note'} at line ${b.line}`}>✎</button>}
          <button className="quiet" onClick={() => onRemove(b)} aria-label={`Remove the bookmark at line ${b.line}`}>×</button>
          {b.note && <p className="small lines-bm-note">{b.note}</p>}
        </li>
      ))}
    </ul>
  )
}

const SCOPE_NOTE = { file: '', window: ' · window', stmt: ' · statement' } as const
const CHIP_CHARS = 24

/** The last searches as chips: a click restores one's hits at once, a click on the active chip (or its ↻) runs it again. */
export function RecentSearches({ recent, active, onPick, onRerun }: {
  recent: RecentSearch[]; active: Pick<RecentSearch, 'q' | 'regex' | 'caseSensitive' | 'scope'> | null; onPick(r: RecentSearch): void; onRerun(r: RecentSearch): void
}) {
  if (recent.length === 0) return null
  return (
    <div className="lines-recent" role="group" aria-label="Recent searches">
      {recent.map((r) => {
        const on = !!active && sameSearch(r, active)
        const text = r.q.length > CHIP_CHARS ? r.q.slice(0, CHIP_CHARS - 1) + '…' : r.q
        return (
          <span key={`${r.scope}:${r.regex ? 're' : 'tx'}:${r.caseSensitive ? 'cs' : 'ci'}:${r.q}`} className={'lines-chip' + (on ? ' on' : '')}>
            <button type="button" className="quiet" aria-pressed={on} onClick={() => (on ? onRerun(r) : onPick(r))}
              title={`${r.q}${r.regex ? ' (regex)' : ''}${r.caseSensitive ? ' (match case)' : ''}${SCOPE_NOTE[r.scope]}: ${on ? 'click to run again' : 'show these hits'}`}>
              <code>{text}</code> <small>{fmtInt(r.hits.length)}</small>
            </button>
            {on && <button type="button" className="quiet" onClick={() => onRerun(r)} aria-label={`Run "${r.q}" again`} title="run this search again">↻</button>}
          </span>
        )
      })}
    </div>
  )
}

/** The keys of the viewer and of the view, for the Keys menu. */
const KEYS: [string, string][] = [
  ['↑ ↓', 'previous / next line'],
  ['PgUp PgDn', 'a page up / down'],
  ['Home End', 'first / last line'],
  ['/', 'focus the search box'],
  ['g', 'focus the Go to box'],
  ['Enter', 'open the statement of the selected line'],
  ['m M', 'next / previous mark of the selected statement'],
  ['h', 'toggle the heat gutter'],
  ['] [', 'next / previous call (loaded pages)'],
  ['w W', 'next / previous wait (loaded pages)'],
  ['x X', 'next / previous commit (loaded pages)'],
  ['c C', 'next / previous PARSING IN CURSOR'],
  ['e E', 'next / previous error'],
  ['b', 'bookmark the selected line'],
  ['Backspace', 'back to the line before the last jump'],
  ['F3 Shift+F3', 'next / previous search hit'],
  ['Esc', 'cancel a running search'],
  ['?', 'this list'],
]

/** Every key the viewer and the view handle (the letters work with the viewer focused, not while typing in a box). */
export function KeyMap() {
  return (
    <table className="lines-keys">
      <caption className="small muted">With the viewer focused</caption>
      <tbody>
        {KEYS.map(([k, what]) => (
          <tr key={k}><th scope="row">{k.split(' ').map((x, i) => <kbd key={i}>{x}</kbd>)}</th><td>{what}</td></tr>
        ))}
      </tbody>
    </table>
  )
}
