// The statement of a "One statement" cut: one button that opens a list of every statement of the trace with calls, longest
// first and the picked one on top, filtered by what the user types (sql_id or SQL text: the lib's statement picker rows).
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ToolbarMenu, fmtDur, fmtInt, sqlCut } from '@lib'
import { pickerRows, type StmtChoice } from './cutstate'

/** rows the list shows at once: the filter reaches the others */
const SHOWN = 300
/** characters of the SQL a row shows */
const SQL_CHARS = 72
/** rows a PageUp / PageDown moves */
const PAGE = 8

export function StmtPicker({ choices, pick, onPick }: { choices: readonly StmtChoice[]; pick: number | null; onPick: (id: number) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const cur = pick === null ? undefined : choices.find((c) => c.id === pick)
  const button = cur ? (
    <>
      <span className="mono sp-id">{cur.label}</span>
      <small>{fmtDur(cur.e)}</small>
      <span className="cut-pick-sql">{sqlCut(cur, '', 48).text}</span>
      <span className="cue" aria-hidden="true">▾</span>
    </>
  ) : <span className="muted">No statement with calls</span>
  const choose = (id: number) => {
    onPick(id)
    setOpen(false)
    root.current?.querySelector<HTMLButtonElement>('.tbmenu > button')?.focus()
  }
  return (
    <span className="cut-pick" ref={root}>
      <ToolbarMenu label="Statement" className="stmt-pick-menu" open={open} onOpenChange={setOpen} button={button} disabled={choices.length === 0}
        title={cur ? `${cur.label}: ${cur.flat.slice(0, 200)}${cur.flat.length > 200 ? '…' : ''}\nchoose the statement to cut` : 'the trace has no statement with calls'}>
        <PickList choices={choices} pick={pick} onPick={choose} />
      </ToolbarMenu>
    </span>
  )
}

function PickList({ choices, pick, onPick }: { choices: readonly StmtChoice[]; pick: number | null; onPick: (id: number) => void }) {
  const uid = useId()
  const input = useRef<HTMLInputElement>(null)
  const box = useRef<HTMLDivElement>(null)
  const [q, setQ] = useState('')
  const rows = useMemo(() => pickerRows(choices, pick, q), [choices, pick, q])
  const shown = rows.length > SHOWN ? rows.slice(0, SHOWN) : rows
  const [pos, setPos] = useState(0)
  const active = Math.max(0, Math.min(pos, shown.length - 1))
  useEffect(() => { input.current?.focus({ preventScroll: true }) }, [])
  useEffect(() => { box.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView?.({ block: 'nearest' }) }, [active, q])
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    const to = e.key === 'ArrowDown' ? active + 1 : e.key === 'ArrowUp' ? active - 1 : e.key === 'PageDown' ? active + PAGE : e.key === 'PageUp' ? active - PAGE : null
    if (to !== null) {
      e.preventDefault()
      setPos(Math.max(0, Math.min(shown.length - 1, to)))
    } else if (e.key === 'Enter' && shown[active]) {
      e.preventDefault()
      onPick(shown[active].id)
    }
  }
  const optId = (i: number) => `${uid}-o${i}`
  const status = rows.length === choices.length ? `${fmtInt(rows.length)} ${rows.length === 1 ? 'statement' : 'statements'}` : `${fmtInt(rows.length)} of ${fmtInt(choices.length)}`
  return (
    <div className="sp-pop cut-pick-pop">
      <div className="sp-find">
        <input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls={`${uid}-list`} aria-autocomplete="list" aria-activedescendant={shown.length > 0 ? optId(active) : undefined}
          aria-label="Filter the statements by sql_id or SQL text" placeholder="Filter by sql_id or SQL text" value={q} spellCheck={false} autoComplete="off" autoCapitalize="off"
          onChange={(e) => { setQ(e.target.value); setPos(0); box.current?.scrollTo?.({ top: 0 }) }} onKeyDown={onKeyDown} />
        <small className="sp-n" aria-live="polite">{status}</small>
      </div>
      <div className="sp-head" aria-hidden="true"><span>sql_id</span><span>time</span><span>execs</span><span>SQL</span></div>
      <div id={`${uid}-list`} className="sp-list" ref={box} role="listbox" aria-label="Statements, longest first" onMouseDown={(e) => e.preventDefault()}>
        {shown.map((r, i) => {
          const cut = sqlCut(r, q, SQL_CHARS)
          return (
            <div key={r.id} id={optId(i)} data-i={i} role="option" aria-selected={r.id === pick} className={'sp-row' + (i === active ? ' active' : '') + (r.id === pick ? ' picked' : '')}
              onMouseMove={() => { if (i !== active) setPos(i) }} onClick={() => onPick(r.id)} title={r.flat.slice(0, 300) + (r.flat.length > 300 ? '…' : '')}>
              <span className="mono sp-label">{r.label}</span>
              <span className="sp-num">{fmtDur(r.e)}</span>
              <span className="sp-num">{fmtInt(r.executions)}</span>
              <span className="sp-sql">{cut.mark ? <>{cut.text.slice(0, cut.mark[0])}<mark>{cut.text.slice(...cut.mark)}</mark>{cut.text.slice(cut.mark[1])}</> : cut.text}</span>
            </div>
          )
        })}
        {rows.length > shown.length && <p className="sp-empty">and {fmtInt(rows.length - shown.length)} more: type to narrow the list</p>}
        {rows.length === 0 && <p className="sp-empty" role="status">{choices.length === 0 ? 'No statement has calls.' : `No statement matches “${q.trim()}”.`}</p>}
      </div>
      <p className="sp-foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span> <span><kbd>Enter</kbd> cut this statement</span> <span><kbd>Esc</kbd> close</span></p>
    </div>
  )
}
