/**
 * Tab that collapses / expands a pane docked to an edge of its container (position: relative).
 * `side="end"` (default): the pane is at the inline-end edge; open, the tab sits centred on the pane's left edge (the pane
 * width comes from `--pane-w`, set per pane in CSS); closed, it sits on the container's edge. `side="start"`: the mirror image
 * for a pane at the inline-start edge.
 */
export function PaneToggle({ open, onToggle, label, className, side = 'end' }: {
  open: boolean
  onToggle: () => void
  label: string
  className?: string
  side?: 'start' | 'end'
}) {
  const title = `${open ? 'Hide' : 'Show'} ${label}`
  const glyph = (side === 'end') === open ? '›' : '‹'
  return (
    <button className={'pane-toggle' + (side === 'start' ? ' start' : '') + (open ? '' : ' closed') + (className ? ` ${className}` : '')}
      onClick={onToggle} aria-expanded={open} aria-label={title} title={title}>{glyph}</button>
  )
}
