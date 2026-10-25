import { useState } from 'react'

/**
 * A note being written or edited: a text box with Save / Cancel (and Delete for an existing note).
 * Ctrl/⌘+Enter saves, Esc cancels (without reaching the shell's Esc, which clears the window).
 */
export function NoteEditor({ text = '', label, title, onSave, onCancel, onDelete, children }: {
  text?: string
  /** the text box's accessible name */
  label: string
  /** a line above the box (what the note is on) */
  title?: string
  onSave(text: string): void
  onCancel(): void
  onDelete?(): void
  /** more fields before the text box (a window's label) */
  children?: React.ReactNode
}) {
  const [draft, setDraft] = useState(text)
  const save = () => { if (draft.trim()) onSave(draft.trim()); else if (onDelete) onDelete(); else onCancel() }
  return (
    <form className="note-edit" onSubmit={(e) => { e.preventDefault(); save() }}
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); onCancel() }
        else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save() }
      }}>
      {title && <span className="small muted">{title}</span>}
      {children}
      <textarea value={draft} aria-label={label} placeholder="Note (Ctrl+Enter saves)" rows={3} autoFocus onChange={(e) => setDraft(e.target.value)} />
      <span className="note-acts">
        <button type="submit">Save</button>
        <button type="button" onClick={onCancel}>Cancel</button>
        {onDelete && <button type="button" className="quiet" onClick={onDelete}>Delete note</button>}
      </span>
    </form>
  )
}

/** A saved note, with an edit button when notes can be edited. */
export function NoteBox({ text, onEdit, when }: { text: string; onEdit?: () => void; when?: number }) {
  return (
    <div className="note-box">
      <span className="note-mark" aria-hidden="true">✎</span>
      <p>{text}</p>
      {when ? <small className="muted" title={new Date(when).toLocaleString()}>{new Date(when).toLocaleDateString()}</small> : null}
      {onEdit && <button className="quiet" onClick={onEdit}>Edit</button>}
    </div>
  )
}
