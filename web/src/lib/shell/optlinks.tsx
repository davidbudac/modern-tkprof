import { createContext, useContext } from 'react'
import type { Opt10046Link } from '../data/opt'

/** A statement of this tab's trace has a dump in another open tab: whether it does, and the jump to that dump. */
export interface Opt10053Link {
  has(sqlId: string): boolean
  open(sqlId: string): void
}

/** What a note of the trace can offer to do (the desktop: open the 10053 file that was left out of a set of 10046 traces). */
export interface NoteAction { label: string; title?: string; run(): void }

/**
 * What a shell that holds several traces (the desktop) lets the views do across them. All optional: the standalone UI provides nothing, so
 * the marks and links are simply absent there.
 * - `to10053`: in a 10046 tab, the "10053" mark on a statement whose sql_id is among another open tab's dumps;
 * - `to10046`: in a 10053 tab, the dump list's "10046" link to an open 10046 tab that has the statement;
 * - `noteAction`: a button beside a note of the trace (`doc.diag.notes`).
 */
export interface OptLinks {
  to10053?: Opt10053Link
  to10046?: Opt10046Link
  noteAction?(note: string): NoteAction | null
}

export const OptLinksContext = createContext<OptLinks>({})
export const useOptLinks = (): OptLinks => useContext(OptLinksContext)
