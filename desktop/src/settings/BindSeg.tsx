import type { BindMode } from './settings'

const MODES: { id: BindMode; label: string; title: string }[] = [
  { id: 'keep', label: 'Keep', title: 'Keep the bind values as traced' },
  { id: 'redact', label: 'Redact', title: 'Replace them by a salted hash' },
  { id: 'none', label: 'None', title: 'Drop them' },
]

/** The bind values choice (keep · redact · none) as the segmented button group the Theme setting uses. */
export function BindSeg({ value, onChange }: { value: BindMode; onChange: (m: BindMode) => void }) {
  return (
    <span className="seg" role="group" aria-label="Bind values">
      {MODES.map((m) => (
        <button key={m.id} aria-pressed={value === m.id} title={m.title} onClick={() => onChange(m.id)}>
          {m.label}
        </button>
      ))}
    </span>
  )
}
