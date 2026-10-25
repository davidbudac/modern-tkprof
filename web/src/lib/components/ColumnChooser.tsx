import { useEffect, useRef, useState } from 'react'

export interface ChooserColumn { key: string; label: string }

/** "columns" button with a popover of checkboxes; `hidden` holds the keys switched off. */
export function ColumnChooser({ all, hidden, onChange }: { all: ChooserColumn[]; hidden: string[]; onChange: (hidden: string[]) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => { document.removeEventListener('pointerdown', onDown); document.removeEventListener('keydown', onKey, true) }
  }, [open])
  const off = new Set(hidden)
  const shown = all.filter((c) => !off.has(c.key)).length
  const toggle = (k: string) => onChange(off.has(k) ? hidden.filter((x) => x !== k) : [...hidden, k])
  return (
    <span className="colchooser" ref={root}>
      <button className={off.size ? 'on' : undefined} aria-expanded={open} aria-haspopup="true" onClick={() => setOpen(!open)} title="show or hide columns">
        columns{off.size > 0 && <small> {shown}/{all.length}</small>}
      </button>
      {open && (
        <div className="colpop" role="group" aria-label="Columns">
          {all.map((c) => <label key={c.key}><input type="checkbox" checked={!off.has(c.key)} onChange={() => toggle(c.key)} />{c.label}</label>)}
          <button className="link" onClick={() => onChange([])} disabled={off.size === 0}>show all</button>
        </div>
      )}
    </span>
  )
}
