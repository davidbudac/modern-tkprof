import { createContext, useContext } from 'react'
import type { Opt10046Link } from '../data/opt'
import type { DiagLink } from '../data/diagmarks'

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
 * - `toDump`: in a 10046 tab, the "dump" mark on a statement (its sql_id) or a session (its `sid.serial`) that a dump tab names;
 * - `toTrace`: in a dump tab, the "10046" link on a statement or a session that a 10046 tab holds;
 * - `noteAction`: a button beside a note of the trace (`doc.diag.notes`);
 * - `openAs`: open the tab's own file again in a new tab in another view (`view` of a session: the dump reader's "Open as SQL trace").
 */
export interface OptLinks {
  to10053?: Opt10053Link
  to10046?: Opt10046Link
  toDump?: DiagLink
  toTrace?: DiagLink
  noteAction?(note: string): NoteAction | null
  openAs?(view: '10046' | '10053' | 'diag'): void
}

export const OptLinksContext = createContext<OptLinks>({})
export const useOptLinks = (): OptLinks => useContext(OptLinksContext)
