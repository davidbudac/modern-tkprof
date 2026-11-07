import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import type { TraceDoc } from '../data/doc'
import { fmtDur, fmtInt } from '../data/format'
import type { HlSet } from '../data/hlset'
import { shareText } from '../data/overview'
import { pickerKey, selectAllTo, triState, type PickAct, type PickMode, type Tri } from '../data/pickkeys'
import { filterRows, flatten, pickRows, sqlCut, type FileStmtStats, type PickRow } from '../data/stmtpick'
import { FunnelIcon } from '../components/icons'
import { ToolbarMenu } from '../components/ToolbarMenu'

/** What the highlighted statement has in this file: its calls and waits (the real counts), and what is said when the marks are bounded. */
export interface StmtCounts { calls: number; waits: number; note?: string }

/** A row's height in px (the virtualiser's estimate is exact: rows do not wrap). */
const ROW_H = 26
/** characters of the SQL a row cuts at (the cell's ellipsis cuts a narrower popover further) */
const SQL_CHARS = 64
/** rows a PageUp / PageDown moves */
const PAGE = 8
/** swatches the closed button stacks for several highlighted statements */
const STACK = 4

const countsText = (c: StmtCounts) => (c.calls + c.waits === 0 ? 'nothing in this file' : `${fmtInt(c.calls)} ${c.calls === 1 ? 'call' : 'calls'} · ${fmtInt(c.waits)} ${c.waits === 1 ? 'wait' : 'waits'}`)

/** The state a select-all box shows as `aria-checked`. */
const ariaTri = (t: Tri): boolean | 'mixed' => (t === 'all' ? true : t === 'some' ? 'mixed' : false)

/**
 * The statement picker: one button in the overview row's left slot that opens a searchable, multi-select list of the file's statements, longest first (their time and
 * share are the file's). Each row toggles two things: the **highlight** (the statement's lines are tinted in a colour it takes when highlighted; only highlighted statements
 * have a colour) and the **filter** (only the lines of the filtered statements are shown). The closed button says what is on: nothing (`Highlight a statement`), one
 * highlighted statement (swatch, sql_id, time and share, its calls and waits), several (`3 highlighted`, their swatches stacked), and `2 filtered` beside them; its × clears both.
 * The list filters by sql_id or SQL text, is virtualised (a SQLT trace has thousands of statements) and takes keys (`pickerKey`: ↓ into the list, Space highlight, f filter,
 * a / A all, Enter go to the first line, / back to the filter box). `open` is the owner's, so the palette and a key can open it.
 */
export function StatementPicker({ doc, file, stats, span, hl, colors, filtered, counts, open, onOpenChange, onToggleHl, onToggleFilter, onSetHl, onSetFilter, onGo, onClear }: {
  doc: TraceDoc; file: number
  /** the statements' numbers in this file, by statement id */
  stats: readonly FileStmtStats[]
  /** the traced time of the file, µs (the share of a statement is of this) */
  span: number
  /** the highlighted statements and the colour each has */
  hl: HlSet
  colors: ReadonlyMap<number, string>
  /** the filtered statements */
  filtered: ReadonlySet<number>
  /** the calls and waits of the highlighted statement, when exactly one is */
  counts?: StmtCounts | null
  open: boolean
  onOpenChange(open: boolean): void
  onToggleHl(stmt: number): void
  onToggleFilter(stmt: number): void
  /** switch many at once on or off (the select-all boxes and keys) */
  onSetHl(stmts: readonly number[], on: boolean): void
  onSetFilter(stmts: readonly number[], on: boolean): void
  /** go to the statement's first line in this file (the owner closes the list) */
  onGo(stmt: number): void
  /** stop highlighting and filtering */
  onClear(): void
}) {
  const n = hl.ids.length, nf = filtered.size
  const one = n === 1 ? doc.statements[hl.ids[0]] : undefined
  const color = one ? colors.get(one.id) : undefined
  const e = one ? stats[one.id]?.elapsed ?? 0 : 0
  const names = hl.ids.slice(0, 12).map((id) => doc.statements[id] && doc.label(doc.statements[id]))
  const filterNote = nf > 0 && <small className="sp-fil" title={`${fmtInt(nf)} ${nf === 1 ? 'statement is' : 'statements are'} filtered: only ${nf === 1 ? 'its' : 'their'} lines are shown`}><FunnelIcon />{fmtInt(nf)}<span className="sp-fil-w"> filtered</span></small>
  let button: ReactNode
  if (one) {
    button = (
      <>
        <i className="sp-sw" aria-hidden="true" />
        <span className="mono sp-id">{doc.label(one)}</span>
        <small className="sp-time">{fmtDur(e)} · {shareText(e, span)}</small>
        {counts && <small className="sp-cnt" title={`the lines of this statement's cursors are tinted in its colour, with a bar at the start edge of its calls and waits${counts.note ? `\n${counts.note}` : ''}`}>{countsText(counts)}</small>}
        {filterNote}
      </>
    )
  } else if (n > 1) {
    button = (
      <>
        <span className="sp-sws" aria-hidden="true">{hl.ids.slice(0, STACK).map((id) => <i key={id} style={{ background: colors.get(id) }} />)}</span>
        <span className="sp-many">{fmtInt(n)} highlighted</span>
        {filterNote}
      </>
    )
  } else if (nf > 0) {
    button = <><span className="sp-none">No highlight</span>{filterNote}</>
  } else {
    button = <><span className="sp-none">Highlight a statement</span><span className="cue" aria-hidden="true">▾</span></>
  }
  const title = one
    ? `${doc.label(one)} is highlighted: its lines are tinted in its colour${nf > 0 ? `; ${fmtInt(nf)} filtered` : ''}. Choose statements of this file (L)`
    : n > 1 ? `${fmtInt(n)} statements are highlighted (${names.join(', ')}${n > names.length ? ', …' : ''})${nf > 0 ? `; ${fmtInt(nf)} filtered` : ''}. Choose statements of this file (L)`
      : nf > 0 ? `${fmtInt(nf)} ${nf === 1 ? 'statement is' : 'statements are'} filtered. Choose statements of this file (L)`
        : 'choose statements of this file to highlight (their lines are tinted, each in a colour of its own) or to filter by (only their lines are shown) (L)'
  return (
    <div className={'stmt-pick' + (n === 1 ? ' on' : n > 1 || nf > 0 ? ' many' : '') + (nf > 0 ? ' filt' : '')} style={color ? ({ '--chip': color } as CSSProperties) : undefined}>
      <ToolbarMenu label="Statements" className="tbmenu-start stmt-pick-menu" open={open} onOpenChange={onOpenChange} button={button} title={title}>
        <PickerList doc={doc} file={file} stats={stats} span={span} hl={hl} colors={colors} filtered={filtered}
          onToggleHl={onToggleHl} onToggleFilter={onToggleFilter} onSetHl={onSetHl} onSetFilter={onSetFilter} onGo={onGo} onClose={() => onOpenChange(false)} />
      </ToolbarMenu>
      {(n > 0 || nf > 0) && <button type="button" className="sp-x" onClick={onClear} aria-label="Clear the highlight and the filter" title="stop highlighting and stop filtering">×</button>}
    </div>
  )
}

/** A select-all box over a toggle column: none, some (a dash) or all of the listed statements on. */
function AllBox({ tri, label, title, onClick, children }: { tri: Tri; label: string; title: string; onClick(): void; children?: ReactNode }) {
  return (
    <button type="button" role="checkbox" aria-checked={ariaTri(tri)} aria-label={label} title={title} className={'sp-all sp-all-' + tri} onClick={onClick}>
      {children ?? (tri === 'all' ? '✓' : tri === 'some' ? '–' : '')}
    </button>
  )
}

/** The popover's content: the filter box, the select-all boxes over the two toggle columns, the virtualised list and the key footer (mounted while the popover is open). */
function PickerList({ doc, file, stats, span, hl, colors, filtered, onToggleHl, onToggleFilter, onSetHl, onSetFilter, onGo, onClose }: {
  doc: TraceDoc; file: number; stats: readonly FileStmtStats[]; span: number; hl: HlSet; colors: ReadonlyMap<number, string>; filtered: ReadonlySet<number>
  onToggleHl(stmt: number): void; onToggleFilter(stmt: number): void; onSetHl(stmts: readonly number[], on: boolean): void; onSetFilter(stmts: readonly number[], on: boolean): void
  onGo(stmt: number): void; onClose(): void
}) {
  const uid = useId()
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const rows = useMemo(() => pickRows(doc, file, stats), [doc, file, stats])
  const [q, setQ] = useState('')
  const shown = useMemo(() => filterRows(rows, q), [rows, q])
  const [mode, setMode] = useState<PickMode>('filter')
  // the first highlighted statement is the focused row when the list opens
  const [pos, setPos] = useState(() => { const i = hl.ids.length > 0 ? rows.findIndex((r) => r.id === hl.ids[0]) : -1; return Math.max(0, i) })
  const active = Math.max(0, Math.min(pos, shown.length - 1))
  const v = useVirtualizer({ count: shown.length, getScrollElement: () => box.current, estimateSize: () => ROW_H, overscan: 10 })
  // the focused statement is in view when the list opens
  useLayoutEffect(() => { if (shown.length > 0) v.scrollToIndex(active, { align: 'center' }) }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const move = (to: number) => { const i = Math.max(0, Math.min(shown.length - 1, to)); setPos(i); v.scrollToIndex(i, { align: 'auto' }) }
  // the filter box has the focus the whole time the list is open (the list is an aria-activedescendant listbox); where it was comes back when it closes (as the command
  // palette does). `before` is kept in a ref: a development build runs the effect twice, and the second run must not take the filter box for where the focus was.
  const before = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (before.current === null && document.activeElement !== input.current) before.current = document.activeElement as HTMLElement | null
    input.current?.focus({ preventScroll: true })
    return () => {
      const b = before.current, now = document.activeElement
      if (b && b.isConnected && (!now || now === document.body)) b.focus({ preventScroll: true })
    }
  }, [])
  const listed = useMemo(() => shown.map((r) => r.id), [shown])
  const hlTri = triState(listed, (id) => hl.slots.has(id))
  const fTri = triState(listed, (id) => filtered.has(id))
  const allHl = () => onSetHl(listed, selectAllTo(hlTri, listed.length))
  const allFilter = () => onSetFilter(listed, selectAllTo(fTri, listed.length))
  const run = (a: PickAct) => {
    const r = shown[active]
    switch (a.do) {
      case 'move': move(a.to === 'next' ? active + 1 : a.to === 'prev' ? active - 1 : a.to === 'nextPage' ? active + PAGE : a.to === 'prevPage' ? active - PAGE : a.to === 'first' ? 0 : shown.length - 1); break
      case 'highlight': if (r) onToggleHl(r.id); break
      case 'filter': if (r) onToggleFilter(r.id); break
      case 'allHighlight': allHl(); break
      case 'allFilter': allFilter(); break
      case 'go': if (r) onGo(r.id); break
      case 'close': onClose(); break
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const step = pickerKey(mode, e.nativeEvent, active === 0)
    if (step.mode !== mode) setMode(step.mode)
    if (step.handled) { e.preventDefault(); e.stopPropagation() }
    if (step.act) run(step.act)
  }
  const qFlat = flatten(q).toLowerCase()
  const optId = (i: number) => `${uid}-o${i}`
  const status = shown.length === rows.length ? `${fmtInt(rows.length)} ${rows.length === 1 ? 'statement' : 'statements'}` : `${fmtInt(shown.length)} of ${fmtInt(rows.length)}`
  return (
    <div className="sp-pop" data-mode={mode}>
      <div className="sp-find">
        <input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls={`${uid}-list`} aria-autocomplete="list" aria-activedescendant={shown.length > 0 ? optId(active) : undefined}
          aria-label="Filter the statements by sql_id or SQL text" placeholder="Filter by sql_id or SQL text" value={q} spellCheck={false} autoComplete="off" autoCapitalize="off"
          onChange={(e) => { setQ(e.target.value); setPos(0); setMode('filter'); box.current?.scrollTo?.({ top: 0 }) }} onKeyDown={onKeyDown} />
        <small className="sp-n" aria-live="polite">{status}</small>
      </div>
      {/* the pointer never takes the focus from the filter box */}
      <div className="sp-head" onMouseDown={(e) => e.preventDefault()}>
        <AllBox tri={hlTri} label="Highlight all listed statements" title={hlTri === 'all' ? 'stop highlighting the listed statements (a)' : 'highlight the listed statements, each in a colour of its own (a)'} onClick={allHl} />
        <AllBox tri={fTri} label="Filter by all listed statements" title={fTri === 'all' ? 'stop filtering by the listed statements (Shift+a)' : 'show only the lines of the listed statements (Shift+a)'} onClick={allFilter}><FunnelIcon /></AllBox>
        <span>sql_id</span><span>time</span><span>share</span><span>execs</span><span>SQL</span>
      </div>
      <div id={`${uid}-list`} className="sp-list" ref={box} role="listbox" aria-multiselectable="true" aria-label="Statements, longest first" onMouseDown={(e) => e.preventDefault()}>
        <div style={{ blockSize: v.getTotalSize(), position: 'relative' }}>
          {v.getVirtualItems().map((it) => {
            const r: PickRow | undefined = shown[it.index]
            if (!r) return null
            const place = { position: 'absolute', insetBlockStart: 0, insetInline: 0, blockSize: ROW_H, transform: `translateY(${it.start}px)` } as const
            const on = it.index === active
            const isHl = hl.slots.has(r.id), isF = filtered.has(r.id)
            const cut = sqlCut(r, q, SQL_CHARS)
            const li = qFlat ? r.label.toLowerCase().indexOf(qFlat) : -1
            return (
              <div key={r.id} id={optId(it.index)} role="option" aria-selected={isHl} className={'sp-row' + (on ? ' active' : '') + (isHl ? ' hl' : '') + (isF ? ' fil' : '')}
                style={{ ...place, '--chip': colors.get(r.id) } as CSSProperties}
                onMouseMove={() => { if (!on) setPos(it.index) }} onClick={() => { setPos(it.index); onToggleHl(r.id) }} onDoubleClick={() => onGo(r.id)}
                title={`${r.flat.slice(0, 300)}${r.flat.length > 300 ? '…' : ''}\n${fmtDur(r.e)} elapsed in this file, ${fmtInt(r.executions)} ${r.executions === 1 ? 'execution' : 'executions'}, first line: ${fmtInt(r.line)}\nclick: ${isHl ? 'stop highlighting' : 'highlight'} · funnel: ${isF ? 'stop filtering' : 'filter by it'} · double-click: go to its first line`}>
                <i className="sp-sw" aria-hidden="true" />
                <button type="button" className="sp-fn" aria-pressed={isF} aria-label={`Filter by ${r.label}`} title={isF ? 'stop filtering by this statement (f)' : 'show only the lines of this statement (f)'} tabIndex={-1}
                  onClick={(e) => { e.stopPropagation(); setPos(it.index); onToggleFilter(r.id) }} onDoubleClick={(e) => e.stopPropagation()}><FunnelIcon /></button>
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
      <p className="sp-foot">
        <span><kbd>↓</kbd> list</span> <span><kbd>Space</kbd> highlight</span> <span><kbd>f</kbd> filter</span> <span><kbd>a</kbd> <kbd>A</kbd> all highlight / filter</span>{' '}
        <span><kbd>Enter</kbd> go to</span> <span><kbd>/</kbd> type</span> <span><kbd>Esc</kbd> close</span>
      </p>
    </div>
  )
}
