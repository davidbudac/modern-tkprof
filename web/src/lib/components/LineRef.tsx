import { useStore, useActions } from '../state/session'
import { fmtInt } from '../data/format'

/**
 * A trace line number (`file` = input file index of a multi-file trace). Under `mtkprof serve` it is a link that opens the raw line viewer;
 * in the standalone HTML (no server to read the file) it is plain text.
 * `bare` shows just the number (table cells); otherwise "line N".
 */
export function LineRef({ line, file = 0, bare, className }: { line: number; file?: number; bare?: boolean; className?: string }) {
  const actions = useActions()
  const available = useStore((s) => s.linesAvailable)
  if (!line || line <= 0) return null
  const text = bare ? fmtInt(line) : `line ${fmtInt(line)}`
  if (!available) return <>{text}</>
  return (
    <button className={'link lineref' + (className ? ' ' + className : '')} title={`view trace line ${fmtInt(line)}`}
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); actions.openLines(line, file) }}>
      {text}
    </button>
  )
}
