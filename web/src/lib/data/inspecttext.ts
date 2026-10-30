import type { BindRow } from './derive'
import type { LineDecode } from './linefields'

/** The translated line as plain text: one `label: value (raw)` per field, the title first and the note last (the inspector's Copy). */
export function decodeAsText(d: LineDecode, line?: number): string {
  const out: string[] = []
  const head = [line !== undefined ? `Line ${line}` : '', d.kindLabel ?? '', d.title].filter(Boolean)
  if (head.length) out.push(head.join(' · '))
  for (const f of d.fields) out.push(`${f.label}: ${f.value}${f.raw ? ` (${f.raw})` : ''}`)
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
