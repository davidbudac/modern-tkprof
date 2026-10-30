import { useEffect, useRef } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Bookmark } from '../state/store'
import type { TraceDoc } from '../data/doc'
import { fmtInt, preview } from '../data/format'
import { GROUP_UNKNOWN, groupHits, matchSpan, sameSearch, type HitGroup, type RecentSearch, type SearchHit } from '../data/lines'
import { useActions } from '../state/session'

const HIT_H = 22
/** characters of the line shown before the match, so it is visible in a narrow panel */
const LEAD = 14

/** A statement's sql_id as a chip on a hit row: a click opens the statement (the row's own click, going to the line, is not triggered). */
function StmtChip({ doc, id }: { doc: TraceDoc; id: number }) {
  const actions = useActions()
  const st = doc.statements[id]
  if (!st) return <span className="muted hit-stmt">–</span>
  return (
    <button type="button" className="link mono sqlid hit-stmt" title={preview(st.text, 60) || 'open this statement'}
      onClick={(e) => { e.stopPropagation(); actions.selectStmt(id) }}>{doc.label(st)}</button>
  )
}

/** One row of the flattened hit list: a hit, or in the grouped list a statement's header. */
type HitItem = { type: 'group'; g: HitGroup; open: boolean } | { type: 'hit'; h: SearchHit; grouped: boolean }

/**
 * The hits of a search, streamed in: `hits` grows while `count` (the render trigger) follows it. `stmtOf` tells a hit line's statement
 * (undefined: not known yet, negative: none), `onNeed` asks the owner to learn it (the rendered hits only). With `group` the list is the
 * statements by hit count, a group's hits listed while it is in `open`.
 */
export function HitList({ doc, hits, count, selected, q, regex, caseSensitive, stmtOf, onNeed, group, open, onToggle, onGo }: {
  doc: TraceDoc; hits: SearchHit[]; count: number; selected: number; q: string; regex: boolean; caseSensitive: boolean
  stmtOf(line: number): number | undefined; onNeed(line: number): void
  group: boolean; open: ReadonlySet<number>; onToggle(stmt: number): void; onGo(line: number): void
}) {
  const box = useRef<HTMLDivElement>(null)
  // not memoized: a page arriving changes what `stmtOf` answers without changing `hits` (an in-place array)
  const items: HitItem[] = []
  if (!group) for (let i = 0; i < count && i < hits.length; i++) items.push({ type: 'hit', h: hits[i], grouped: false })
  else {
    for (const g of groupHits(hits.length > count ? hits.slice(0, count) : hits, stmtOf)) {
      items.push({ type: 'group', g, open: open.has(g.stmt) })
      if (open.has(g.stmt)) for (const h of g.hits) items.push({ type: 'hit', h, grouped: true })
    }
  }
  const v = useVirtualizer({ count: items.length, getScrollElement: () => box.current, estimateSize: () => HIT_H, overscan: 12 })
  // the statements of the hits in view (without the overscan) are learnt by loading their pages
  const range = v.range
  useEffect(() => {
    if (!range) return
    for (let i = range.startIndex; i <= range.endIndex; i++) {
      const it = items[i]
      if (it?.type === 'hit' && stmtOf(it.h.line) === undefined) onNeed(it.h.line)
    }
  })
  if (count === 0) return <p className="small muted lines-empty">No hits.</p>
  return (
    <div className="lines-hits" ref={box} role="listbox" aria-label="Search hits">
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {v.getVirtualItems().map((it) => {
          const item = items[it.index]
          if (!item) return null
          const pos = { position: 'absolute', insetBlockStart: 0, insetInline: 0, height: HIT_H, transform: `translateY(${it.start}px)` } as const
          if (item.type === 'group') {
            const { g } = item
            return (
              <div key={it.key} role="option" aria-selected={false} aria-expanded={item.open} className="lines-hit lines-grp" style={pos} onClick={() => onToggle(g.stmt)}
                title={item.open ? 'hide these hits' : 'list these hits'}>
                <span className="grp-x">{item.open ? '▾' : '▸'}</span>
                {g.stmt >= 0 ? <StmtChip doc={doc} id={g.stmt} /> : <span className="muted hit-stmt">{g.stmt === GROUP_UNKNOWN ? `not loaded yet (${fmtInt(g.hits.length)})` : `no statement (${fmtInt(g.hits.length)})`}</span>}
                {g.stmt >= 0 && <span className="grp-n">{fmtInt(g.hits.length)} {g.hits.length === 1 ? 'hit' : 'hits'}</span>}
                <button type="button" className="link ln" title="go to the first hit" onClick={(e) => { e.stopPropagation(); onGo(g.first) }}>{fmtInt(g.first)}</button>
              </div>
            )
          }
          const h = item.h
          const span = matchSpan(h, q, regex, caseSensitive)
          const owner = item.grouped ? undefined : stmtOf(h.line)
          return (
            <div key={it.key} role="option" aria-selected={h.line === selected} className={'lines-hit' + (h.line === selected ? ' on' : '') + (item.grouped ? ' in-grp' : '')}
              style={pos} onClick={() => onGo(h.line)} title={`line ${fmtInt(h.line)}, column ${h.col}`}>
              <span className="ln">{fmtInt(h.line)}</span>
              <span className="col">{h.col}</span>
              {!item.grouped && (owner === undefined ? <span className="muted hit-stmt" title="the statement of this line is not loaded yet">…</span> : owner >= 0 ? <StmtChip doc={doc} id={owner} /> : <span className="muted hit-stmt" title="no statement at this line">–</span>)}
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
  ['] [', 'next / previous call'],
  ['w W', 'next / previous wait'],
  ['x X', 'next / previous commit'],
  ['c C', 'next / previous PARSING IN CURSOR'],
  ['e E', 'next / previous error'],
  ['p P', 'next / previous STAT dump (the plan of a cursor)'],
  ['s S', 'next / previous session marker (SESSION / CLIENT / MODULE / ACTION)'],
  ['d D', 'next / previous execution of the selected line\'s cursor'],
  ['f', "focus the selected line's cursor (dims the rows of other cursors)"],
  ['b', 'bookmark the selected line'],
  ['Backspace', 'back to the line before the last jump'],
  ['F3 Shift+F3', 'next / previous search hit'],
  ['Esc', 'cancel a running search, else clear the cursor focus'],
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
