import { useRef, type KeyboardEvent, type PointerEvent } from 'react'

/** A column of the formatted view that the user can resize: key (`--w-<key>` and the `cols` pref), header, default and least width (px). */
export interface FormattedColumn { key: string; label: string; title: string; def: number; min: number }

export const FORMATTED_COLUMNS: FormattedColumn[] = [
  { key: 'lane', label: 'Statement', title: "the cursor's statement: its sql_id on the first line of a stretch, the start of its SQL on the second; the colour is the statement's", def: 150, min: 40 },
  { key: 'bar', label: 'Time', title: 'the time the line took, on one linear scale for the file (full: its longest line); a call\'s CPU part is the solid end', def: 90, min: 24 },
  { key: 'kind', label: 'Operation', title: 'what the line is: PARSE, EXEC, FETCH, CLOSE, WAIT, PLAN, BINDS, …', def: 84, min: 40 },
  { key: 'dur', label: 'Duration', title: "the line's e= (a call) or ela= (a wait); a fold's total", def: 84, min: 48 },
  { key: 'dlt', label: 'Δ', title: 'the time from the pinned line (a), else from the line with a time before', def: 92, min: 48 },
  { key: 'clk', label: 'Clock', title: "the wall-clock time of the line's tim= in the trace's zone", def: 136, min: 72 },
]

/** The CSS variables of the column widths: the stored ones, the defaults for the rest. */
export function columnVars(cols: Readonly<Record<string, number>>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const c of FORMATTED_COLUMNS) out[`--w-${c.key}`] = `${Math.max(c.min, cols[c.key] ?? c.def)}px`
  return out
}

/**
 * The formatted view's column headers, in the rows' columns. The edge after a header resizes its column: drag it (the width follows
 * the pointer through a CSS variable, stored when the drag ends), double-click it for the default, or focus it and use ← →.
 */
export function FormattedHead({ cols, onCols }: { cols: Readonly<Record<string, number>>; onCols(cols: Record<string, number>): void }) {
  const box = useRef<HTMLDivElement>(null)
  // `dir` -1: the column is at the end edge, its grip on its start edge (dragging left widens it)
  const drag = useRef<{ key: string; x: number; w: number; min: number; dir: 1 | -1 } | null>(null)
  const widthOf = (c: FormattedColumn) => Math.max(c.min, cols[c.key] ?? c.def)
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
    drag.current = { key: c.key, x: e.clientX, w: widthOf(c), min: c.min, dir }
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
    if (e.key === 'ArrowLeft') set(c.key, Math.max(c.min, widthOf(c) - step))
    else if (e.key === 'ArrowRight') set(c.key, Math.max(c.min, widthOf(c) + step))
    else if (e.key === 'Home' || e.key === 'Delete') set(c.key, undefined)
    else return
    e.preventDefault()
  }
  /** A header and its grip: on its end edge, or (`atEnd`: a column at the view's end edge) on its start edge. */
  const cell = (key: string, atEnd = false, alignEnd = false) => {
    const c = FORMATTED_COLUMNS.find((x) => x.key === key)!
    const dir = atEnd ? -1 : 1
    return (
      <span className={`lv-ch lv-ch-${key}${atEnd ? ' lv-ch-atend' : ''}${alignEnd ? ' lv-ch-alend' : ''}`} title={c.title}>
        <span className="lv-ch-label">{c.label}</span>
        <span className="lv-ch-grip" role="separator" aria-orientation="vertical" aria-label={`Resize the ${c.label} column`} aria-valuenow={widthOf(c)} aria-valuemin={c.min}
          tabIndex={0} title="drag to resize; double-click: the default width; ← → with the focus here" onPointerDown={onDown(c, dir)} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
          onDoubleClick={() => set(c.key, undefined)} onKeyDown={onKey(c, dir)} />
      </span>
    )
  }
  // the same classes as a row's cells for the line number and the fold handle, so the columns after them start where the rows' do
  return (
    <div className="lv-colhead lv-rd" ref={box} role="presentation">
      <span className="lv-ln" />
      {cell('lane')}
      <span className="lv-fh" />
      {cell('bar')}
      {cell('kind')}
      {cell('dur', false, true)}
      <span className="lv-ch lv-ch-tx" title="what the line says, parsed: a call's CPU, rows, gets and reads; a wait's event, object and parameters; …">Detail</span>
      {cell('dlt', true, true)}
      {cell('clk', true, true)}
    </div>
  )
}
