import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { Tone } from '../data/blocklayout'
import type { TraceDoc } from '../data/doc'
import { fmtDur, fmtInt } from '../data/format'
import { shareText } from '../data/overview'
import { QUIET_TONE, toneColor } from '../data/readable'
import { filterRows, flatten, pickRows, sqlCut, type PickRow } from '../data/stmtpick'
import { ToolbarMenu } from '../components/ToolbarMenu'

/** What the highlighted statement has in this file: its calls and waits (the real counts), and what is said when the marks are bounded. */
export interface StmtCounts { calls: number; waits: number; note?: string }

/** A row's height in px (the virtualiser's estimate is exact: rows do not wrap). */
const ROW_H = 26
/** characters of the SQL a row cuts at (the cell's ellipsis cuts a narrower popover further) */
const SQL_CHARS = 64
/** rows a PageUp / PageDown moves */
const PAGE = 8

const countsText = (c: StmtCounts) => (c.calls + c.waits === 0 ? 'nothing in this file' : `${fmtInt(c.calls)} ${c.calls === 1 ? 'call' : 'calls'} · ${fmtInt(c.waits)} ${c.waits === 1 ? 'wait' : 'waits'}`)

/**
 * The statement picker: one button in the overview row's left slot that opens a searchable list of the file's statements, longest first. With a statement
 * highlighted the button says which (swatch, sql_id in its lane colour, time and share, the real counts of its calls and waits) and has the × that stops the
 * highlight; with none it says `Highlight a statement`. The list filters by sql_id or SQL text (case-insensitive), is virtualised (a SQLT trace has thousands
 * of statements), and takes ↑ ↓ PgUp PgDn, Enter and Esc; `None` leads it while a statement is highlighted. Picking one highlights it and goes to its first
 * line in this file. `open` is the owner's, so the palette and a key can open it.
 */
export function StatementPicker({ doc, file, tones, span, current, counts, open, onOpenChange, onPick, onClear }: {
  doc: TraceDoc; file: number; tones: ReadonlyMap<number, Tone>
  /** the traced time of the file, µs (the share of a statement is of this) */
  span: number
  /** the highlighted statement, null for none */
  current: number | null
  /** the highlighted statement's calls and waits in this file */
  counts?: StmtCounts | null
  open: boolean
  onOpenChange(open: boolean): void
  /** highlight the statement and go to its first line in this file */
  onPick(stmt: number): void
  /** stop highlighting */
  onClear(): void
}) {
  const st = current !== null ? doc.statements[current] : undefined
  const color = st ? toneColor(tones.get(st.id) ?? QUIET_TONE) : undefined
  const e = st ? doc.stats.statements[st.id]?.elapsed ?? 0 : 0
  const button: ReactNode = st ? (
    <>
      <i className="sp-sw" aria-hidden="true" />
      <span className="mono sp-id">{doc.label(st)}</span>
      <small className="sp-time">{fmtDur(e)} · {shareText(e, span)}</small>
      {counts && <small className="sp-cnt" title={`the rows of this statement's calls and waits are tinted in its colour, with a bar at their start edge (l highlights the selected line's statement instead, Enter opens it)${counts.note ? `\n${counts.note}` : ''}`}>{countsText(counts)}</small>}
    </>
  ) : (
    <><span className="sp-none">Highlight a statement</span><span className="cue" aria-hidden="true">▾</span></>
  )
  return (
    <div className={'stmt-pick' + (st ? ' on' : '')} style={color ? ({ '--chip': color } as CSSProperties) : undefined}>
      <ToolbarMenu label="Statements" className="tbmenu-start stmt-pick-menu" open={open} onOpenChange={onOpenChange} button={button}
        title={st ? `${doc.label(st)} is highlighted: its calls and waits are tinted in its colour. Choose another statement of this file (L)` : 'choose a statement of this file to highlight: its calls and waits are tinted in its colour, and the view goes to its first line (L)'}>
        <PickerList doc={doc} file={file} tones={tones} span={span} current={current} onPick={(id) => { onOpenChange(false); onPick(id) }} onClear={() => { onOpenChange(false); onClear() }} />
      </ToolbarMenu>
      {st && <button type="button" className="sp-x" onClick={onClear} aria-label="Stop highlighting" title="stop highlighting this statement">×</button>}
    </div>
  )
}

/** The popover's content: the filter box and the virtualised list (mounted while the popover is open). */
function PickerList({ doc, file, tones, span, current, onPick, onClear }: {
  doc: TraceDoc; file: number; tones: ReadonlyMap<number, Tone>; span: number; current: number | null; onPick(stmt: number): void; onClear(): void
}) {
  const uid = useId()
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => pickRows(doc, file), [doc, file])
  const [q, setQ] = useState('')
  const shown = useMemo(() => filterRows(rows, q), [rows, q])
  // `None` first while one is highlighted (a row that is not a statement: null)
  const items: (PickRow | null)[] = useMemo(() => (current !== null ? [null, ...shown] : shown), [current, shown])
  const lead = current !== null ? 1 : 0 // the first statement row
  const [pos, setPos] = useState(() => { const i = current !== null ? rows.findIndex((r) => r.id === current) : -1; return i >= 0 ? i + lead : lead })
  const active = Math.max(0, Math.min(pos, items.length - 1))
  const v = useVirtualizer({ count: items.length, getScrollElement: () => box.current, estimateSize: () => ROW_H, overscan: 10 })
  // the highlighted statement is in view when the list opens
  useLayoutEffect(() => { if (items.length > 0) v.scrollToIndex(active, { align: 'center' }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const move = (to: number) => { const i = Math.max(0, Math.min(items.length - 1, to)); setPos(i); v.scrollToIndex(i, { align: 'auto' }) }
  // the filter box has the focus while the list is open; where it was comes back when it closes (as the command palette does). `before` is kept in a ref: a
  // development build runs the effect twice, and the second run must not take the filter box for where the focus was.
  const before = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (before.current === null && document.activeElement !== input.current) before.current = document.activeElement as HTMLElement | null
    input.current?.focus({ preventScroll: true })
    return () => {
      const b = before.current, now = document.activeElement
      if (b && b.isConnected && (!now || now === document.body)) b.focus({ preventScroll: true })
    }
  }, [])
  const choose = (i: number) => { const r = items[i]; if (r === undefined) return; if (r === null) onClear(); else onPick(r.id) }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return
    switch (e.key) {
      case 'ArrowDown': e.preventDefault(); move(active + 1); break
      case 'ArrowUp': e.preventDefault(); move(active - 1); break
      case 'PageDown': e.preventDefault(); move(active + PAGE); break
      case 'PageUp': e.preventDefault(); move(active - PAGE); break
      case 'Enter': e.preventDefault(); choose(active); break
      case 'Tab': e.preventDefault(); break
      default: return
    }
    e.stopPropagation()
  }
  const qFlat = flatten(q).toLowerCase()
  const optId = (i: number) => `${uid}-o${i}`
  return (
    <div className="sp-pop">
      <div className="sp-find">
        <input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls={`${uid}-list`} aria-autocomplete="list" aria-activedescendant={items.length > 0 ? optId(active) : undefined}
          aria-label="Filter the statements by sql_id or SQL text" placeholder="Filter by sql_id or SQL text" value={q} spellCheck={false} autoComplete="off" autoCapitalize="off"
          onChange={(e) => { setQ(e.target.value); setPos(lead); box.current?.scrollTo?.({ top: 0 }) }} onKeyDown={onKeyDown} />
        <small className="sp-n" aria-live="polite">{shown.length === rows.length ? `${fmtInt(rows.length)} ${rows.length === 1 ? 'statement' : 'statements'}` : `${fmtInt(shown.length)} of ${fmtInt(rows.length)}`}</small>
      </div>
      <div className="sp-head" aria-hidden="true"><span /><span>sql_id</span><span>time</span><span>share</span><span>execs</span><span>SQL</span></div>
      <div id={`${uid}-list`} className="sp-list" ref={box} role="listbox" aria-label="Statements, longest first" onMouseDown={(e) => e.preventDefault()}>
        <div style={{ blockSize: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((it) => {
            const r = items[it.index]
            const place = { position: 'absolute', insetBlockStart: 0, insetInline: 0, blockSize: ROW_H, transform: `translateY(${it.start}px)` } as const
            const on = it.index === active
            if (r === null) {
              return (
                <div key="none" id={optId(it.index)} role="option" aria-selected={on} className={'sp-row sp-row-none' + (on ? ' active' : '')} style={place}
                  onMouseMove={() => { if (!on) setPos(it.index) }} onClick={onClear} title="stop highlighting this statement">
                  <span /><span className="sp-label">None</span><span className="sp-hint">stop highlighting</span>
                </div>
              )
            }
            if (!r) return null
            const c = toneColor(tones.get(r.id) ?? QUIET_TONE)
            const cut = sqlCut(r, q, SQL_CHARS)
            const li = qFlat ? r.label.toLowerCase().indexOf(qFlat) : -1
            return (
              <div key={r.id} id={optId(it.index)} role="option" aria-selected={on} className={'sp-row' + (on ? ' active' : '') + (r.id === current ? ' cur' : '')} style={{ ...place, '--chip': c } as CSSProperties}
                onMouseMove={() => { if (!on) setPos(it.index) }} onClick={() => onPick(r.id)}
                title={`${r.flat.slice(0, 300)}${r.flat.length > 300 ? '…' : ''}\n${fmtDur(r.e)} elapsed, ${fmtInt(r.executions)} ${r.executions === 1 ? 'execution' : 'executions'}, first line here: ${fmtInt(r.line)}\nhighlight its calls and waits and go to its first line in this file`}>
                <i className="sp-sw" aria-hidden="true" />
                <span className="mono sp-label">{li >= 0 ? <>{r.label.slice(0, li)}<mark>{r.label.slice(li, li + qFlat.length)}</mark>{r.label.slice(li + qFlat.length)}</> : r.label}</span>
                <span className="sp-num">{fmtDur(r.e)}</span>
                <span className="sp-num sp-share">{shareText(r.e, span)}</span>
                <span className="sp-num sp-ex">{fmtInt(r.executions)}</span>
                <span className="sp-sql">{cut.mark ? <>{cut.text.slice(0, cut.mark[0])}<mark>{cut.text.slice(...cut.mark)}</mark>{cut.text.slice(cut.mark[1])}</> : cut.text}</span>
              </div>
            )
          })}
        </div>
        {shown.length === 0 && <p className="sp-empty" role="status">{rows.length === 0 ? 'No statement of this file has a cursor.' : `No statement matches “${q.trim()}”.`}</p>}
      </div>
      <p className="sp-foot"><kbd>↑</kbd> <kbd>↓</kbd> choose · <kbd>Enter</kbd> highlight it and go to its first line · <kbd>Esc</kbd> close</p>
    </div>
  )
}
