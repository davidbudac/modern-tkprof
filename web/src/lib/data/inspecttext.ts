import type { BindRow } from './derive'
import type { LineDecode, LineField } from './linefields'
import { execSummaryLines, type ExecSummary } from './execsummary'

/** What a value of the translated table can be a link to. */
export type FieldRefKind = 'cursor' | 'sqlid' | 'plh' | 'obj' | 'event'

/** The cursor number a line starts with (`EXEC #139:`, `WAIT #139:`, `STAT #139 `, `BINDS #139:`, `PARSING IN CURSOR #139 `, errors); null for none and for `#0`. */
export function cursorOfText(text: string): string | null {
  const m = /^(?:PARSE ERROR|ERROR|PARSE|EXEC|FETCH|CLOSE|WAIT|STAT|BINDS|PARSING IN CURSOR)\s+#(\d+)/.exec(text)
  return m && Number(m[1]) > 0 ? m[1] : null
}

/**
 * The reference a field names, decided by the token the decoder wrote (`raw`, else `hint`) and not by the display text:
 * `plh=` (not 0), `obj#=` / `obj=` (above 0), `sqlid=` (13 chars of 0-9a-z), `nam='…'` (a wait event), or the BINDS `Cursor` field (`#N`).
 */
export function refOfField(f: Pick<LineField, 'label' | 'value' | 'raw' | 'hint'>): { kind: FieldRefKind; value: string } | null {
  if (f.label === 'Cursor') {
    const m = /^#(\d+)$/.exec(f.value)
    return m ? { kind: 'cursor', value: m[1] } : null
  }
  for (const tok of [f.raw, f.hint]) {
    const m = tok ? /^(plh|obj#|obj|sqlid|nam)=(.*)$/.exec(tok.trim()) : null
    if (!m) continue
    const v = m[2].replace(/^'|'$/g, '')
    switch (m[1]) {
      case 'plh': return /^\d+$/.test(v) && Number(v) > 0 ? { kind: 'plh', value: v } : null
      case 'obj#': case 'obj': return /^\d+$/.test(v) && Number(v) > 0 ? { kind: 'obj', value: v } : null
      case 'sqlid': return /^[0-9a-z]{13}$/.test(v) ? { kind: 'sqlid', value: v } : null
      default: return v !== '' ? { kind: 'event', value: v } : null
    }
  }
  return null
}

/**
 * The translated line as plain text: one `label: value (raw)` per field, the title first and the note last (the inspector's Copy).
 * With an execution summary (and `eventName`, the names of its wait events) an "Execution" block follows the fields.
 */
export function decodeAsText(d: LineDecode, line?: number, exec?: ExecSummary | null, eventName: (id: number) => string = (id) => `event ${id}`): string {
  const out: string[] = []
  const head = [line !== undefined ? `Line ${line}` : '', d.kindLabel ?? '', d.title].filter(Boolean)
  if (head.length) out.push(head.join(' · '))
  for (const f of d.fields) out.push(`${f.label}: ${f.value}${f.raw ? ` (${f.raw})` : ''}`)
  if (exec) out.push('', ...execSummaryLines(exec, eventName))
  if (d.note) out.push(d.note)
  return out.join('\n')
}

/** What the inspector's bind table shows as the value of a bind. */
export function bindCell(b: Pick<BindRow, 'value' | 'isNull' | 'noDef' | 'dump'>): string {
  if (b.isNull) return 'NULL'
  if (b.noDef) return '(same as previous)'
  if (b.dump) return b.value || '(memory dump)'
  return b.value
}
