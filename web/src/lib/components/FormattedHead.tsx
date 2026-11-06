import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

/**
 * A column of the formatted view that the user can resize: key (`--w-<key>` and the `cols` pref), header, default width in digits of
 * the rows' font (so it fits its values at any font size; lines.css has the same numbers) and least width (px).
 */
export interface FormattedColumn { key: string; label: string; title: string; def: number; min: number }

export const FORMATTED_COLUMNS: FormattedColumn[] = [
  { key: 'lane', label: 'Statement', title: "the cursor's statement: its sql_id on the first line of a stretch, the start of its SQL on the second; the colour is the statement's", def: 18, min: 40 },
  { key: 'bar', label: 'Time', title: 'the bar: the time the line took, on one linear scale for the file (full: its longest line), a call\'s CPU part the solid end; the text: Δ, the time from the pinned line (a), else from the line with a time before (the trace bar\'s Δ hides it)', def: 12, min: 24 },
  { key: 'kind', label: 'Operation', title: 'what the line is: PARSE, EXEC, FETCH, CLOSE, WAIT, PLAN, BINDS, …', def: 10, min: 40 },
  { key: 'dur', label: 'Duration', title: "the line's e= (a call) or ela= (a wait); a fold's total", def: 10, min: 40 },
  { key: 'clk', label: 'Clock', title: "the wall-clock time of the line's tim= in the trace's zone: the whole stamp on the first row, the selected one and where the second changes, else the digits that change", def: 11.7, min: 72 },
]

/** The CSS variables of the widths the user set (px); a column without one has its default (lines.css). */
export function columnVars(cols: Readonly<Record<string, number>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of FORMATTED_COLUMNS) if (cols[c.key] !== undefined) out[`--w-${c.key}`] = `${Math.max(c.min, cols[c.key])}px`
  return out
}

/**
 * The formatted view's column headers, in the rows' columns. The edge after a header resizes its column: drag it (the width follows
 * the pointer through a CSS variable, stored when the drag ends), double-click it for the default, or focus it and use ← →.
 */
export function FormattedHead({ cols, delta, onCols }: { cols: Readonly<Record<string, number>>; delta: boolean; onCols(cols: Record<string, number>): void }) {
  const box = useRef<HTMLDivElement>(null)
  // `dir` -1: the column is at the end edge, its grip on its start edge (dragging left widens it)
  const drag = useRef<{ key: string; x: number; w: number; min: number; dir: 1 | -1 } | null>(null)
  /** the column's width now: its header cell's (the grip's parent) */
  const widthOf = (grip: HTMLElement) => grip.parentElement?.getBoundingClientRect().width ?? 0
  const set = (key: string, w: number | undefined) => {
    const next = { ...cols }
    if (w === undefined) delete next[key]; else next[key] = Math.round(w)
    onCols(next)
  }
  // the variables live on the viewer box (the rows read them); while dragging they are set there directly, without a render
  const host = () => box.current?.closest<HTMLElement>('.lv-box') ?? null
  const onDown = (c: FormattedColumn, dir: 1 | -1) => (e: PointerEvent<HTMLSpanElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { key: c.key, x: e.clientX, w: widthOf(e.currentTarget), min: c.min, dir }
  }
  const widthAt = (d: NonNullable<typeof drag.current>, x: number) => Math.max(d.min, d.w + (x - d.x) * d.dir)
  const onMove = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current
    if (d) host()?.style.setProperty(`--w-${d.key}`, `${widthAt(d, e.clientX)}px`)
  }
  const onUp = (e: PointerEvent<HTMLSpanElement>) => {
    const d = drag.current
    if (!d) return
    drag.current = null
    host()?.style.removeProperty(`--w-${d.key}`)
    if (e.clientX !== d.x) set(d.key, widthAt(d, e.clientX))
  }
  const onKey = (c: FormattedColumn, dir: 1 | -1) => (e: KeyboardEvent<HTMLSpanElement>) => {
    const step = (e.shiftKey ? 40 : 8) * dir
    if (e.key === 'ArrowLeft') set(c.key, Math.max(c.min, widthOf(e.currentTarget) - step))
    else if (e.key === 'ArrowRight') set(c.key, Math.max(c.min, widthOf(e.currentTarget) + step))
    else if (e.key === 'Home' || e.key === 'Delete') set(c.key, undefined)
    else return
    e.preventDefault()
  }
  /** A header and its grip: on its end edge, or (`atEnd`: a column at the view's end edge) on its start edge. */
  const cell = (key: string, atEnd = false, alignEnd = false, label?: string) => {
    const c = FORMATTED_COLUMNS.find((x) => x.key === key)!
    const dir = atEnd ? -1 : 1
    return (
      <span className={`lv-ch lv-ch-${key}${atEnd ? ' lv-ch-atend' : ''}${alignEnd ? ' lv-ch-alend' : ''}`} title={c.title}>
        <span className="lv-ch-label">{label ?? c.label}</span>
        <span className="lv-ch-grip" role="separator" aria-orientation="vertical" aria-label={`Resize the ${c.label} column`} aria-valuenow={cols[c.key]} aria-valuemin={c.min}
          tabIndex={0} title="drag to resize; double-click: the default width; ← → with the focus here" onPointerDown={onDown(c, dir)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onDoubleClick={() => set(c.key, undefined)} onKeyDown={onKey(c, dir)} />
      </span>
    )
  }
  // the same classes as a row's cells for the line number and the fold handle, so the columns after them start where the rows' do
  return (
    <div className="lv-colhead lv-rd" ref={box} role="presentation">
      {delta && cell('bar', false, true, 'Δ · time')}
      <span className="lv-ln" />
      {cell('lane')}
      <span className="lv-fh" />
      {cell('dur', false, true)}
      {cell('kind')}
      <span className="lv-ch lv-ch-tx" title="what the line says, parsed: a call's CPU (when it is not all of the duration), rows, gets and reads; a wait's event, object and parameters; a plan's table; …">Detail</span>
      {cell('clk', true, true)}
    </div>
  )
}
