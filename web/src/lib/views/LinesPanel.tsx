import { useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Bookmark } from '../state/store'
import { fmtInt } from '../data/format'
import { matchSpan, type SearchHit } from '../data/lines'

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

export function BookmarkList({ bookmarks, fileName, onGo, onLabel, onRemove }: {
  bookmarks: Bookmark[]; fileName(file: number): string; onGo(b: Bookmark): void; onLabel(b: Bookmark, label: string): void; onRemove(b: Bookmark): void
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
          <button className="quiet" onClick={() => onRemove(b)} aria-label={`Remove the bookmark at line ${b.line}`}>×</button>
        </li>
      ))}
    </ul>
  )
}
