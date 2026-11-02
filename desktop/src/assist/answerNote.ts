// Save as note: an answer becomes a note (the lib's annotations, kept per trace in annotations.json) on the statement,
// execution or time window its links name. A note on the same place gets the answer after what it has.
import { execKey, execNotes, fmtDur, fmtWall, makeAnnotation, preview, stmtNote, stmtRef, unresolved, type Store, type TraceDoc } from '@lib'
import type { AssistantMessage } from './conversation'
import { intentHash } from './intents'
import { statementOf } from './links'
import { mtkprofLinks } from './markdown'

/** What a note can hang on, by the place a link of the answer names; `stmt` is the statement's index in the document. */
export type NoteTarget =
  | { kind: 'statement'; key: string; stmt: number }
  | { kind: 'execution'; key: string; stmt: number; cursorLine: number; execNo: number }
  | { kind: 'window'; key: string; from: number; to: number }

/** The hashes an answer points at: its links and the places it was asked to show. */
export function citedHashes(m: AssistantMessage): string[] {
  return m.parts.flatMap((p) => (p.kind === 'text' ? mtkprofLinks(p.text).map((l) => l.hash) : p.kind === 'intent' ? [intentHash(p) ?? ''] : [])).filter(Boolean)
}

/**
 * The statements, executions and time windows `hashes` name that `doc` has, once each, in the order of first mention. A hash
 * is the most specific of them: an execution before a statement before a window.
 */
export function citedTargets(doc: TraceDoc, hashes: string[]): NoteTarget[] {
  const found = new Map<string, NoteTarget>()
  for (const hash of hashes) {
    if (unresolved(doc, hash).length > 0) continue
    const p = new URLSearchParams(hash.replace(/^#/, ''))
    const stmt = statementOf(doc, p.get('sql'))
    const exec = /^(\d+):(\d+)$/.exec(p.get('exec') ?? '')
    const win = /^(-?\d+)-(\d+)$/.exec(p.get('win') ?? '')
    let t: NoteTarget | null = null
    if (stmt !== null && exec) t = { kind: 'execution', key: `e:${stmt}:${exec[1]}:${exec[2]}`, stmt, cursorLine: Number(exec[1]), execNo: Number(exec[2]) }
    else if (stmt !== null) t = { kind: 'statement', key: `s:${stmt}`, stmt }
    else if (win) t = { kind: 'window', key: `w:${win[1]}-${win[2]}`, from: doc.span.firstTim + Number(win[1]), to: doc.span.firstTim + Number(win[2]) }
    if (t && !found.has(t.key)) found.set(t.key, t)
  }
  return [...found.values()]
}

/** Where a note goes, short: "statement f6jyzt7462kx2", "execution #3 of f6jyzt7462kx2", "time window +1.2 s → +2.4 s". */
export function targetName(doc: TraceDoc, t: NoteTarget): string {
  const at = (tim: number) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(tim), doc.tzOffsetMin) : `+${fmtDur(tim - doc.span.firstTim)}`)
  switch (t.kind) {
    case 'statement': return `statement ${doc.label(doc.statements[t.stmt])}`
    case 'execution': return `execution #${t.execNo} of ${doc.label(doc.statements[t.stmt])}`
    case 'window': return `time window ${at(t.from)} → ${at(t.to)}`
  }
}

/** A place to pick from a list: its name, and for a statement or an execution the start of the SQL text. */
export function targetLabel(doc: TraceDoc, t: NoteTarget): string {
  const name = targetName(doc, t)
  const label = name[0].toUpperCase() + name.slice(1)
  return t.kind === 'window' ? label : `${label} · ${preview(doc.statements[t.stmt].text, 36)}`
}

/** The answer as a note's text: its words with each link as its label, under a line that says where it came from. */
export function noteText(m: AssistantMessage): string {
  const body = m.parts
    .flatMap((p) => {
      if (p.kind !== 'text') return []
      return [mtkprofLinks(p.text).reduce((text, l) => text.replace(l.source, l.label), p.text).trim()]
    })
    .filter(Boolean)
    .join('\n\n')
  return `From the assistant (${m.provider}):\n\n${body}`
}

/** Puts `text` on the target: a new note, or after the note the place already has; nothing when that note holds it already. */
export function saveNote(store: Store, t: NoteTarget, text: string): 'added' | 'appended' | 'present' {
  const { doc, annotations } = store.getState()
  if (!doc) throw new Error('no trace is loaded')
  const ref = t.kind === 'window' ? undefined : stmtRef(doc.statements[t.stmt])
  const cur =
    t.kind === 'statement' ? stmtNote(annotations, ref!)
    : t.kind === 'execution' ? execNotes(annotations, ref!).get(execKey(t.cursorLine, t.execNo))
    : annotations.find((a) => a.kind === 'window' && a.from === t.from && a.to === t.to)
  if (cur) {
    if (cur.note.includes(text)) return 'present'
    store.actions.updateAnnotation(cur.id, { note: cur.note ? `${cur.note}\n\n${text}` : text })
    return 'appended'
  }
  store.actions.addAnnotation(
    makeAnnotation(
      t.kind === 'statement' ? { kind: 'statement', note: text, stmt: ref }
      : t.kind === 'execution' ? { kind: 'execution', note: text, stmt: ref, execNo: t.execNo, cursorLine: t.cursorLine }
      : { kind: 'window', note: text, from: t.from, to: t.to },
    ),
  )
  return 'added'
}
