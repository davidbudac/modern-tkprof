import { useOptLinks } from '../shell/optlinks'

/** The "10053" mark on a statement whose sql_id has a dump in another open tab (desktop); a click opens that dump. Nothing where the shell provides no link. */
export function OptMark({ sqlId }: { sqlId: string }) {
  const link = useOptLinks().to10053
  if (!link || !sqlId || !link.has(sqlId)) return null
  return (
    <button type="button" className="opt-mark" title={`This statement has an optimizer (10053) dump in another tab. Open it.`} aria-label={`Open the 10053 dump of ${sqlId}`}
      onClick={(e) => { e.stopPropagation(); link.open(sqlId) }}>10053</button>
  )
}
