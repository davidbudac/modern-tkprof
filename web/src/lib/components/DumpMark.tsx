import { useOptLinks } from '../shell/optlinks'
import { dumpMarkTitle, keyKind, keyText, traceMarkTitle, type DiagKey } from '../data/diagmarks'

/**
 * The "dump" mark on a statement or session of a SQL trace that a diagnostic dump open in another tab names (desktop); a click shows it in that tab. Nothing where
 * the shell provides no link, and nothing for a key no dump names. Beside it, `TraceMark` is the way back.
 */
export function DumpMark({ by, className }: { by: DiagKey; className?: string }) {
  const link = useOptLinks().toDump
  const key = keyText(by)
  if (!link || !key || !link.has(by)) return null
  return (
    <button type="button" className={'opt-mark' + (className ? ` ${className}` : '')} title={dumpMarkTitle(by)} aria-label={`Show ${keyKind(by)} ${key} in the dump`}
      onClick={(e) => { e.stopPropagation(); link.open(by) }}>dump</button>
  )
}

/** The "10046" link in a dump reader's reading on a statement or session that a SQL trace open in another tab holds; a click shows it in that tab. */
export function TraceMark({ by }: { by: DiagKey }) {
  const link = useOptLinks().toTrace
  const key = keyText(by)
  if (!link || !key || !link.has(by)) return null
  return (
    <button type="button" className="opt-mark rd-10046" title={traceMarkTitle(by)} aria-label={`Show ${keyKind(by)} ${key} in the SQL trace`}
      onClick={(e) => { e.stopPropagation(); link.open(by) }}>10046</button>
  )
}
