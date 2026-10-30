import type { TraceDoc } from './doc'
import { bindsOf, type BindRow } from './derive'
import { LINE_KINDS, type PageCache } from './linecache'
import type { AtObjects } from './lines'

/** `oacdty` codes of bind datatypes (port of `bindTypes` in internal/ref/ref.go). */
export const BIND_TYPE_NAMES: Record<number, string> = {
  1: 'VARCHAR2', 2: 'NUMBER', 3: 'NATIVE INTEGER', 4: 'FLOAT', 5: 'STRING', 6: 'VARNUM', 7: 'LONG DECIMAL', 8: 'LONG',
  9: 'VARCHAR', 11: 'ROWID', 12: 'DATE', 15: 'VARRAW', 23: 'RAW', 24: 'LONG RAW', 25: 'UNSIGNED INT', 29: 'LONG VARRAW',
  68: 'UNSIGNED INT (OCI)', 96: 'CHAR', 97: 'CHARZ', 100: 'BINARY_FLOAT', 101: 'BINARY_DOUBLE', 102: 'REF CURSOR',
  104: 'UROWID', 105: 'MLSLABEL', 106: 'MLSLABEL', 108: 'OBJECT', 109: 'ADT', 110: 'REF', 111: 'REF', 112: 'CLOB', 113: 'BLOB',
  114: 'BFILE', 115: 'CFILE', 119: 'JSON', 121: 'NAMED OBJECT', 122: 'NESTED TABLE', 123: 'VARRAY', 178: 'TIME',
  179: 'TIME WITH TIME ZONE', 180: 'TIMESTAMP', 181: 'TIMESTAMP WITH TIME ZONE', 182: 'INTERVAL YEAR TO MONTH',
  183: 'INTERVAL DAY TO SECOND', 208: 'UROWID', 231: 'TIMESTAMP WITH LOCAL TIME ZONE', 252: 'BOOLEAN', 286: 'VECTOR',
}

/** `frm` of a bind: the character set form. */
export const FORM_NAMES: Record<number, string> = {
  0: 'not a character type', 1: 'database character set (CHAR)', 2: 'national character set (NCHAR)',
}

/** `csi` of a bind: the usual character set ids. */
export const CHARSET_NAMES: Record<number, string> = {
  1: 'US7ASCII', 31: 'WE8ISO8859P1', 46: 'WE8ISO8859P15', 170: 'EE8MSWIN1250', 171: 'CL8MSWIN1251', 178: 'WE8MSWIN1252',
  870: 'AL24UTFFSS', 871: 'UTF8', 873: 'AL32UTF8', 2000: 'AL16UTF16', 2002: 'AL16UTF16LE',
}

/** The bind set and bind a line of a BINDS block belongs to. */
export interface BindAt {
  set: number            // bind set id
  header: boolean        // true on the "BINDS #" line itself
  pos: number            // Bind#N the line belongs to (-1 on the header and on lines before the first Bind#)
  bind?: BindRow         // the bind at pos (undefined on the header or when the set has no such pos)
  dty?: number           // oacdty of that bind, when the document has the column
  binds: BindRow[]       // all binds of the set
  cursor: number         // doc.bindSets.cursor[set]
  stmt: number           // doc.bindSets.stmt[set]
}

/** How far up a line is searched for its `Bind#` and `BINDS #` header (a bind block of 100 binds is about 400 lines). */
const MAX_WALK = 300
const HEADER_RE = /^BINDS\s+#/
const BIND_RE = /^\s*Bind#(\d+)/
/** Lines of a memory dump of a value: `Dumping '' addr=`, `Dump of memory from`, `7F2B3C10 0A1D0101 00000101   [....]`. */
const DUMP_RE = /^(?:Dump(?:ing| of memory)|[0-9A-Fa-f]{8,16} [0-9A-Fa-f]{8})/

/** line of the `BINDS #` header -> bind set, per file of a document (built once per document). */
const setsOfLine = new WeakMap<object, Map<number, Map<number, number>>>()

function setByLine(doc: TraceDoc, file: number): Map<number, number> {
  let perFile = setsOfLine.get(doc)
  if (!perFile) {
    perFile = new Map()
    const bs = doc.bindSets
    for (let s = 0; s < bs.n; s++) {
      const f = doc.fileOfCursor(bs.cursor[s])
      let m = perFile.get(f)
      if (!m) perFile.set(f, (m = new Map()))
      m.set(bs.line[s], s)
    }
    setsOfLine.set(doc, perFile)
  }
  return perFile.get(file) ?? new Map()
}

/** What an `/api/at` answer says of a bind set: for engine sessions, whose document has no bind tables. */
interface Remembered { set: number; binds: BindRow[]; cursor: number; stmt: number }
/** `BINDS #` line -> the bind set the engine reported for it, per file of a document. */
const remembered = new WeakMap<TraceDoc, Map<number, Map<number, Remembered>>>()

/**
 * Keeps the bind set of an `/api/at` answer (`bindLine`, `binds`) so `bindAtOf` can resolve bind lines when the document
 * does not carry the `bindSets`/`binds` tables (an engine session). Answers without a bind set are ignored.
 */
export function rememberBinds(doc: TraceDoc, file: number, at: AtObjects): void {
  if (!(at.bindSet >= 0 && at.bindLine >= 0 && at.binds)) return
  let perFile = remembered.get(doc)
  if (!perFile) remembered.set(doc, (perFile = new Map()))
  let m = perFile.get(file)
  if (!m) perFile.set(file, (m = new Map()))
  m.set(at.bindLine, { set: at.bindSet, binds: at.binds, cursor: at.cursor, stmt: at.stmt })
}

/**
 * The bind set and bind a line of a BINDS block belongs to, from the cached text around it; undefined for lines outside bind
 * blocks, when a page between the line and its `BINDS #` header is not cached, or when no bind set starts at that header.
 * Walks up at most 300 lines through bind lines, blank lines, memory dumps and unclassified lines (a value can span lines).
 */
export function bindAtOf(doc: TraceDoc, file: number, cache: Pick<PageCache, 'line'>): (line: number) => BindAt | undefined {
  const memo = new Map<number, BindRow[]>()
  const bindsOfSet = (set: number): BindRow[] => {
    let b = memo.get(set)
    if (!b) memo.set(set, (b = bindsOf(doc, set)))
    return b
  }
  const dtyOf = (set: number, pos: number): number | undefined => {
    const col = doc.binds.dty
    if (!col) return undefined
    const first = doc.bindSets.first[set], n = doc.bindSets.count[set]
    for (let i = first; i < first + n; i++) if (doc.binds.pos[i] === pos) return col[i]
    return undefined
  }
  return (line) => {
    const start = cache.line(line)
    if (!start) return undefined
    let headerLine = -1, pos = -1
    const kind0 = LINE_KINDS[start.kind]
    if (kind0 === 'binds' && HEADER_RE.test(start.text)) headerLine = line
    else {
      for (let n = line, i = 0; i < MAX_WALK && n >= 1; n--, i++) {
        const l = n === line ? start : cache.line(n)
        if (!l) return undefined
        const k = LINE_KINDS[l.kind]
        if (k === 'binds') {
          if (HEADER_RE.test(l.text)) headerLine = n
          break
        }
        const dump = DUMP_RE.test(l.text.trim())
        // the starting line itself must be a bind line, a dump or a value continuation; blank lines only connect
        const ok = k === 'bind-line' || dump || k === 'unknown' || (k === 'blank' && n !== line)
        if (!ok) return undefined
        if (pos < 0) { const m = BIND_RE.exec(l.text); if (m) pos = Number(m[1]) }
      }
      if (headerLine < 0) return undefined
    }
    const set = setByLine(doc, file).get(headerLine)
    const mem = set === undefined ? remembered.get(doc)?.get(file)?.get(headerLine) : undefined
    if (set === undefined && !mem) return undefined
    const setId = set ?? mem!.set
    const binds = mem ? mem.binds : bindsOfSet(setId)
    const header = headerLine === line
    const bind = header || pos < 0 ? undefined : binds.find((b) => b.pos === pos)
    return {
      set: setId, header, pos: header ? -1 : pos, bind, dty: bind && !mem ? dtyOf(setId, pos) : undefined, binds,
      cursor: mem ? mem.cursor : doc.bindSets.cursor[setId], stmt: mem ? mem.stmt : doc.bindSets.stmt[setId],
    }
  }
}
