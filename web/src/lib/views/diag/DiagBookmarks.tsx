import { memo } from 'react'
import type { OptAnnotations } from '../../data/opt'
import type { DiagNode } from '../../data/diag'
import { listKey } from '../opt/listKeys'

/** The bookmarked lines of the file with their notes: a line's text when its page is loaded, the part of the file it is in. */
export const DiagBookmarks = memo(function DiagBookmarks({ bookmarks, textOf, pathOf, onGo, onNote, onRemove }: {
  bookmarks: OptAnnotations['bookmarks']
  textOf(line: number): string | undefined
  pathOf(line: number): readonly DiagNode[]
  onGo(line: number): void
  onNote(line: number, note: string): void
  onRemove(line: number): void
}) {
  const list = [...bookmarks.entries()].sort((a, b) => a[0] - b[0])
  if (list.length === 0) return <p className="opt-side-note">No bookmarks. Select a line and press b, or use the bookmark button in the toolbar.</p>
  return (
    <ul className="opt-bms">
      {list.map(([l, note]) => (
        <li key={l}>
          <span className="ln">{l}</span>
          <span>
            <code className="opt-bm-go" role="button" tabIndex={0} title={`Go to line ${l}`} onClick={() => onGo(l)} onKeyDown={(e) => { listKey(e, { activate: () => onGo(l) }) }}>{textOf(l)?.trim() || '(not loaded)'}</code>
            <span className="opt-bm-crumb">{pathOf(l).map((n) => n.title).join(' › ')}</span>
            <input type="text" placeholder="Note" aria-label={`Note on line ${l}`} defaultValue={note} key={`${l}:${note}`}
              onBlur={(e) => { if (e.target.value !== note) onNote(l, e.target.value) }} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur() }} />
          </span>
          <button type="button" className="quiet icon-btn" onClick={() => onRemove(l)} title="Remove the bookmark" aria-label={`Remove the bookmark at line ${l}`}>×</button>
        </li>
      ))}
    </ul>
  )
})
