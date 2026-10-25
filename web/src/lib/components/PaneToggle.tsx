/**
 * Tab that collapses / expands a pane docked to the inline-end edge of its
 * container (position: relative). Open, it sits centred on the pane's left
 * edge (the pane width comes from `--pane-w`, set per pane in CSS); closed, it
 * sits on the container's edge.
 */
export function PaneToggle({ open, onToggle, label, className }: {
  open: boolean
  onToggle: () => void
  label: string
  className?: string
}) {
  const title = `${open ? 'Hide' : 'Show'} ${label}`
  return (
    <button className={'pane-toggle' + (open ? '' : ' closed') + (className ? ` ${className}` : '')}
      onClick={onToggle} aria-expanded={open} aria-label={title} title={title}>{open ? '›' : '‹'}</button>
  )
}
