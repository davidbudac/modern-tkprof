import { useStore, useActions } from '../state/session'
import { fmtInt } from '../data/format'

/**
 * A trace line number (`file` = input file index of a multi-file trace). Under `mtkprof serve` it is a link that opens the raw line viewer;
 * in the standalone HTML (no server to read the file) it is plain text.
 * `bare` shows just the number (table cells); otherwise "line N".
 * With the Lines tab available (`linesApi`) a click opens the drawer or the tab as `lineRefTarget` says (standalone app: the drawer, desktop shell: the tab),
 * Shift+click the other one.
 */
export function LineRef({ line, file = 0, bare, className }: { line: number; file?: number; bare?: boolean; className?: string }) {
  const actions = useActions()
  const available = useStore((s) => s.linesAvailable)
  const tab = useStore((s) => s.linesApi && !!s.doc?.slice)
  const toTab = useStore((s) => s.lineRefTarget === 'view')
  if (!line || line <= 0) return null
  const text = bare ? fmtInt(line) : `line ${fmtInt(line)}`
  if (!available && !tab) return <>{text}</>
  const open = (e: { shiftKey: boolean }) => {
    const view = tab && (toTab !== e.shiftKey || !available)
    if (view) actions.openLinesAt(file, line); else actions.openLines(line, file)
  }
  return (
    <button className={'link lineref' + (className ? ' ' + className : '')}
      title={`view trace line ${fmtInt(line)}${tab && available ? (toTab ? ' (Shift: in the drawer)' : ' (Shift: in the Lines tab)') : ''}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); open(e) }}>
      {text}
    </button>
  )
}
