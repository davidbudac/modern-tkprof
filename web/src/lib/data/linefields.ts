import type { LineKind } from './lines'
import { fmtDur, fmtInt, oraErr } from './format'
import { BIND_TYPE_NAMES, CHARSET_NAMES, FORM_NAMES, type BindAt } from './bindat'
import { previewOfBinds } from './derive'

/** What the decoder may ask of the loaded trace (all optional: a bare line decodes without it). */
export interface DecodeContext {
  /** the event of a wait by name: its class and the names of p1..p3 */
  eventOf?(name: string): { class: string; p1Name: string; p2Name: string; p3Name: string } | undefined
  /** owner.name of an obj# */
  objectName?(obj: number): string | undefined
  /** the clock time of a `tim` value */
  clock?(tim: number): string | undefined
  /** the `tim` of the trace's first call: call and wait times are shown as offsets from it */
  firstTim?: number
  /** the bind set and bind a line of a BINDS block belongs to (`bindAtOf`); used with `opts.line` */
  bindAt?(line: number): BindAt | undefined
  /** the idle gap before a line (`gapBefore`), for the derived field of calls and waits; used with `opts.line` */
  gapBefore?(line: number): { us: number; fromLine: number } | undefined
}

/**
 * One decoded value of a line. `raw` is the token as written on the line (`c=174`, `ela= 1234`) and `desc` one sentence of meaning;
 * both are only set in verbose mode (and `desc` on the fields that come from the bind table).
 */
export interface LineField { label: string; value: string; hint?: string; raw?: string; desc?: string }
/** What a hover card shows of one line: a title, a two-column table, an optional remark; `kindLabel` is the human name of the line kind. */
export interface LineDecode { title: string; fields: LineField[]; note?: string; kindLabel?: string }

export interface DecodeOptions {
  /** every `key=value` token of the line, zeros included, with its raw text and a description (the line inspector) */
  verbose?: boolean
  /** the line number of `text` in its file: lets bind lines resolve through `ctx.bindAt` */
  line?: number
}

/** `v$sqlcommand` names by `oct` (the 19c table of internal/ref/data/sqlcommand_19c.csv). */
export const COMMAND_NAMES: Record<number, string> = {
  1: 'CREATE TABLE', 2: 'INSERT', 3: 'SELECT', 4: 'CREATE CLUSTER', 5: 'ALTER CLUSTER', 6: 'UPDATE', 7: 'DELETE',
  8: 'DROP CLUSTER', 9: 'CREATE INDEX', 10: 'DROP INDEX', 11: 'ALTER INDEX', 12: 'DROP TABLE', 13: 'CREATE SEQUENCE',
  14: 'ALTER SEQUENCE', 15: 'ALTER TABLE', 16: 'DROP SEQUENCE', 17: 'GRANT OBJECT', 18: 'REVOKE OBJECT', 19: 'CREATE SYNONYM',
  20: 'DROP SYNONYM', 21: 'CREATE VIEW', 22: 'DROP VIEW', 23: 'VALIDATE INDEX', 24: 'CREATE PROCEDURE', 25: 'ALTER PROCEDURE',
  26: 'LOCK TABLE', 27: 'NO-OP', 28: 'RENAME', 29: 'COMMENT', 30: 'AUDIT OBJECT', 31: 'NOAUDIT OBJECT',
  32: 'CREATE DATABASE LINK', 33: 'DROP DATABASE LINK', 34: 'CREATE DATABASE', 35: 'ALTER DATABASE',
  36: 'CREATE ROLLBACK SEGMENT', 37: 'ALTER ROLLBACK SEGMENT', 38: 'DROP ROLLBACK SEGMENT', 39: 'CREATE TABLESPACE',
  40: 'ALTER TABLESPACE', 41: 'DROP TABLESPACE', 42: 'ALTER SESSION', 43: 'ALTER USER', 44: 'COMMIT', 45: 'ROLLBACK',
  46: 'SAVEPOINT', 47: 'PL/SQL EXECUTE', 48: 'SET TRANSACTION', 49: 'ALTER SYSTEM', 50: 'EXPLAIN', 51: 'CREATE USER',
  52: 'CREATE ROLE', 53: 'DROP USER', 54: 'DROP ROLE', 55: 'SET ROLE', 56: 'CREATE SCHEMA', 57: 'CREATE CONTROL FILE',
  58: 'ALTER TRACING', 59: 'CREATE TRIGGER', 60: 'ALTER TRIGGER', 61: 'DROP TRIGGER', 62: 'ANALYZE TABLE', 63: 'ANALYZE INDEX',
  64: 'ANALYZE CLUSTER', 65: 'CREATE PROFILE', 66: 'DROP PROFILE', 67: 'ALTER PROFILE', 68: 'DROP PROCEDURE',
  70: 'ALTER RESOURCE COST', 71: 'CREATE MATERIALIZED VIEW LOG', 72: 'ALTER MATERIALIZED VIEW LOG',
  73: 'DROP MATERIALIZED VIEW LOG', 74: 'CREATE MATERIALIZED VIEW', 75: 'ALTER MATERIALIZED VIEW',
  76: 'DROP MATERIALIZED VIEW', 77: 'CREATE TYPE', 78: 'DROP TYPE', 79: 'ALTER ROLE', 80: 'ALTER TYPE', 81: 'CREATE TYPE BODY',
  82: 'ALTER TYPE BODY', 83: 'DROP TYPE BODY', 84: 'DROP LIBRARY', 85: 'TRUNCATE TABLE', 86: 'TRUNCATE CLUSTER',
  87: 'CREATE BITMAPFILE', 88: 'ALTER VIEW', 89: 'DROP BITMAPFILE', 90: 'SET CONSTRAINTS', 91: 'CREATE FUNCTION',
  92: 'ALTER FUNCTION', 93: 'DROP FUNCTION', 94: 'CREATE PACKAGE', 95: 'ALTER PACKAGE', 96: 'DROP PACKAGE',
  97: 'CREATE PACKAGE BODY', 98: 'ALTER PACKAGE BODY', 99: 'DROP PACKAGE BODY', 130: 'ALTER MINING MODEL',
  133: 'CREATE MINING MODEL', 157: 'CREATE DIRECTORY', 158: 'DROP DIRECTORY', 159: 'CREATE LIBRARY', 160: 'CREATE JAVA',
  161: 'ALTER JAVA', 162: 'DROP JAVA', 163: 'CREATE OPERATOR', 164: 'CREATE INDEXTYPE', 165: 'DROP INDEXTYPE',
  166: 'ALTER INDEXTYPE', 167: 'DROP OPERATOR', 168: 'ASSOCIATE STATISTICS', 169: 'DISASSOCIATE STATISTICS',
  170: 'CALL METHOD', 171: 'CREATE SUMMARY', 172: 'ALTER SUMMARY', 173: 'DROP SUMMARY', 174: 'CREATE DIMENSION',
  175: 'ALTER DIMENSION', 176: 'DROP DIMENSION', 177: 'CREATE CONTEXT', 178: 'DROP CONTEXT', 179: 'ALTER OUTLINE',
  180: 'CREATE OUTLINE', 181: 'DROP OUTLINE', 182: 'UPDATE INDEXES', 183: 'ALTER OPERATOR', 184: 'Do not use 184',
  185: 'Do not use 185', 186: 'Do not use 186', 187: 'CREATE SPFILE', 188: 'CREATE PFILE', 189: 'UPSERT',
  190: 'CHANGE PASSWORD', 191: 'UPDATE JOIN INDEX', 192: 'ALTER SYNONYM', 193: 'ALTER DISK GROUP', 194: 'CREATE DISK GROUP',
  195: 'DROP DISK GROUP', 196: 'ALTER LIBRARY', 197: 'PURGE RECYCLEBIN', 198: 'PURGE DBA RECYCLEBIN', 199: 'PURGE TABLESPACE',
  200: 'PURGE TABLE', 201: 'PURGE INDEX', 202: 'UNDROP OBJECT', 203: 'DROP DATABASE', 204: 'FLASHBACK DATABASE',
  205: 'FLASHBACK TABLE', 206: 'CREATE RESTORE POINT', 207: 'DROP RESTORE POINT', 209: 'DECLARE REWRITE EQUIVALENCE',
  210: 'ALTER REWRITE EQUIVALENCE', 211: 'DROP REWRITE EQUIVALENCE', 212: 'CREATE EDITION', 213: 'ALTER EDITION',
  214: 'DROP EDITION', 215: 'DROP ASSEMBLY', 216: 'CREATE ASSEMBLY', 217: 'ALTER ASSEMBLY', 218: 'CREATE FLASHBACK ARCHIVE',
  219: 'ALTER FLASHBACK ARCHIVE', 220: 'DROP FLASHBACK ARCHIVE', 222: 'CREATE SCHEMA SYNONYM', 224: 'DROP SCHEMA SYNONYM',
  225: 'ALTER DATABASE LINK', 226: 'CREATE PLUGGABLE DATABASE', 227: 'ALTER PLUGGABLE DATABASE',
  228: 'DROP PLUGGABLE DATABASE', 229: 'CREATE AUDIT POLICY', 230: 'ALTER AUDIT POLICY', 231: 'DROP AUDIT POLICY',
  234: 'CREATE LOCKDOWN PROFILE', 235: 'DROP LOCKDOWN PROFILE', 236: 'ALTER LOCKDOWN PROFILE',
  238: 'ADMINISTER KEY MANAGEMENT', 239: 'CREATE MATERIALIZED ZONEMAP', 240: 'ALTER MATERIALIZED ZONEMAP',
  241: 'DROP MATERIALIZED ZONEMAP', 242: 'DROP MINING MODEL', 243: 'CREATE ATTRIBUTE DIMENSION',
  244: 'ALTER ATTRIBUTE DIMENSION', 245: 'DROP ATTRIBUTE DIMENSION', 246: 'CREATE HIERARCHY', 247: 'ALTER HIERARCHY',
  248: 'DROP HIERARCHY', 249: 'CREATE ANALYTIC VIEW', 250: 'ALTER ANALYTIC VIEW', 251: 'DROP ANALYTIC VIEW',
  252: 'ALTER DATABASE DICTIONARY', 253: 'CREATE INMEMORY JOIN GROUP', 254: 'ALTER INMEMORY JOIN GROUP',
  255: 'DROP INMEMORY JOIN GROUP',
}
const GOALS: Record<number, string> = { 1: 'ALL_ROWS', 2: 'FIRST_ROWS', 3: 'RULE', 4: 'CHOOSE' }
export const CLOSE_TYPES: Record<number, string> = { 0: 'hard close', 1: 'soft close, kept in the cursor cache', 2: 'soft close', 3: 'already in the cursor cache' }

const KIND_LABELS: Record<LineKind, string> = {
  unknown: 'Unrecognised line', blank: 'Blank line', header: 'Trace header', separator: 'Separator', marker: 'Marker',
  'parsing-in-cursor': 'Cursor parse', 'sql-text': 'SQL text', 'end-of-stmt': 'End of statement', call: 'Call', wait: 'Wait event',
  stat: 'Row-source statistics', binds: 'Bind values', 'bind-line': 'Bind values', xctend: 'Transaction end', error: 'Error',
  'parse-error': 'Parse error', lob: 'LOB operation', rpc: 'Remote call', optimizer: 'Optimizer (10053) line',
}
/** the remark of the verbose card for kinds without fields */
const KIND_NOTES: Partial<Record<LineKind, string>> = {
  unknown: 'The parser did not recognise this line; it is kept in the trace but takes part in no analysis.',
  blank: 'An empty line.',
  header: 'The trace file header: database version, instance, host and the process that wrote the file.',
  separator: 'A row of = characters that opens the text of a cursor.',
  'sql-text': 'The text of the statement parsed in the cursor above.',
  'end-of-stmt': 'END OF STMT: the statement text ends above and the cursor body (calls, waits) follows.',
  rpc: 'A remote procedure call line (unverified in the 19c format).',
  optimizer: 'A line of an optimizer (10053) dump written into this trace. This file holds 10046 and 10053 together; the dump is not shown as 10053 yet, so it is only kept here as plain text.',
}

/** The `key=value` pairs of a text (values up to the next space; single quotes stripped). */
function pairs(s: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const x of s.matchAll(/([\w#]+)=('[^']*'|[^\s,)]*)/g)) m.set(x[1], x[2].replace(/^'|'$/g, ''))
  return m
}
const num = (m: Map<string, string>, k: string): number | undefined => {
  const v = m.get(k)
  return v === undefined || v === '' ? undefined : Number.isNaN(Number(v)) ? undefined : Number(v)
}
const dur = (label: string, us: number | undefined, hint?: string): LineField[] => (us === undefined ? [] : [{ label, value: fmtDur(us), hint: hint ?? `${fmtInt(us)} µs` }])
const count = (label: string, n: number | undefined): LineField[] => (n === undefined ? [] : [{ label, value: fmtInt(n) }])

/** `tim` as the offset from the trace's first call and, when the trace has a wall clock, the clock time. */
function timField(tim: number | undefined, ctx: DecodeContext, label = 'Time'): LineField[] {
  if (tim === undefined || tim <= 0) return []
  const clock = ctx.clock?.(tim)
  const off = ctx.firstTim ? `+${fmtDur(tim - ctx.firstTim)} from start` : ''
  const value = [off, clock].filter(Boolean).join(' · ')
  return [{ label, value: value || String(tim), hint: `tim=${tim}` }]
}

/** 23ai's "no object" obj# on a WAIT line: -1 as an unsigned 32-bit number (the model reads it as -1: `objNoneU32` in internal/model/builder.go). */
const OBJ_NONE_U32 = 4294967295

/** An obj# with its name when the trace's reference data knows it; none for 0, -1 and 4294967295. */
function objField(label: string, obj: number | undefined, ctx: DecodeContext): LineField[] {
  if (obj === undefined || obj <= 0 || obj === OBJ_NONE_U32) return []
  const name = ctx.objectName?.(obj)
  return [{ label, value: name ? `${name} (${obj})` : String(obj), hint: `obj#=${obj}` }]
}

function decodeCall(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^(PARSE|EXEC|FETCH|CLOSE)\s+#(\d+):(.*)$/.exec(text)
  if (!m) return null
  const p = pairs(m[3])
  const f: LineField[] = [
    ...dur('CPU', num(p, 'c')), ...dur('Elapsed', num(p, 'e')),
    ...count('Physical reads', num(p, 'p')), ...count('Consistent gets', num(p, 'cr')), ...count('Current gets', num(p, 'cu')),
  ]
  const mis = num(p, 'mis')
  if (mis !== undefined) f.push({ label: 'Library cache miss', value: mis > 0 ? 'hard parse' : 'no', hint: `mis=${mis}` })
  f.push(...count('Rows', num(p, 'r')), ...count('Depth', num(p, 'dep')))
  const type = num(p, 'type')
  if (type !== undefined) f.push({ label: 'Close type', value: CLOSE_TYPES[type] ?? String(type), hint: `type=${type}` })
  const og = num(p, 'og')
  if (og !== undefined) f.push({ label: 'Optimizer goal', value: GOALS[og] ?? String(og), hint: `og=${og}` })
  const plh = p.get('plh')
  if (plh !== undefined && plh !== '') f.push({ label: 'Plan hash', value: plh === '0' ? '0 (none)' : plh })
  f.push(...timField(num(p, 'tim'), ctx))
  return { title: `${m[1]} #${m[2]}`, fields: f }
}

/** The names and values of the three parameters of a wait: `file number=12 first dba=172318 block cnt=1`. */
function waitParams(s: string): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  for (const x of s.matchAll(/([^=]+)=(\S*)/g)) out.push({ label: x[1].trim(), value: x[2] })
  return out
}

function decodeWait(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^WAIT\s+#(\d+):\s*nam='(.*)'\s+ela=\s*(-?\d+)\s*(.*)$/.exec(text)
  if (!m) return null
  const [, cursor, name, ela, rest] = m
  const ev = ctx.eventOf?.(name)
  const f: LineField[] = [{ label: 'Event', value: name }, ...dur('Waited', Number(ela))]
  if (ev?.class) f.push({ label: 'Class', value: ev.class })
  // the parameters end at obj# (or tim): everything before is "label=value" x3
  const tail = rest.search(/\bobj#=|\btim=/)
  const params = waitParams(tail < 0 ? rest : rest.slice(0, tail))
  const names = ev ? [ev.p1Name, ev.p2Name, ev.p3Name] : []
  params.slice(0, 3).forEach((x, i) => {
    const named = names[i]
    f.push({ label: named || x.label, value: x.value, hint: `p${i + 1}${named && named !== x.label ? `, the trace prints "${x.label}"` : ''}` })
  })
  const p = pairs(rest.slice(Math.max(0, tail)))
  f.push(...objField('Object', num(p, 'obj#'), ctx), ...timField(num(p, 'tim'), ctx))
  return { title: cursor === '0' ? 'WAIT (no cursor)' : `WAIT #${cursor}`, fields: f }
}

function decodeStat(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^STAT\s+#(\d+)\s+(.*?)\s+op='(.*)'\s*$/.exec(text)
  if (!m) return null
  const p = pairs(m[2])
  const at = m[3].lastIndexOf('(cr=')
  const op = (at < 0 ? m[3] : m[3].slice(0, at)).trim()
  const s = pairs(at < 0 ? '' : m[3].slice(at))
  const id = num(p, 'id'), pid = num(p, 'pid')
  const f: LineField[] = []
  if (id !== undefined) f.push({ label: 'Plan line', value: pid === undefined ? String(id) : `${id} (parent ${pid})`, hint: `id=${id} pid=${pid ?? ''} pos=${p.get('pos') ?? ''}` })
  f.push({ label: 'Operation', value: op })
  f.push(...objField('Object', num(p, 'obj'), ctx), ...count('Rows', num(p, 'cnt')), ...count('Starts', num(s, 'str')))
  f.push(...count('Consistent gets', num(s, 'cr')), ...count('Physical reads', num(s, 'pr')), ...count('Physical writes', num(s, 'pw')))
  f.push(...dur('Time', num(s, 'time')), ...count('Cost', num(s, 'cost')), ...count('Size', num(s, 'size')), ...count('Estimated rows', num(s, 'card')))
  return { title: `STAT #${m[1]}`, fields: f }
}

function decodeXctend(text: string, ctx: DecodeContext): LineDecode | null {
  if (!text.startsWith('XCTEND')) return null
  const p = pairs(text)
  const f: LineField[] = []
  const rlbk = num(p, 'rlbk'), ro = num(p, 'rd_only')
  if (rlbk !== undefined) f.push({ label: 'Outcome', value: rlbk ? 'rollback' : 'commit', hint: `rlbk=${rlbk}` })
  if (ro !== undefined) f.push({ label: 'Read only', value: ro ? 'yes, nothing to commit' : 'no', hint: `rd_only=${ro}` })
  f.push(...timField(num(p, 'tim'), ctx))
  return { title: 'XCTEND', fields: f }
}

function decodeParsing(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^PARSING IN CURSOR\s+#(\d+)(.*)$/.exec(text)
  if (!m) return null
  const p = pairs(m[2])
  const f: LineField[] = [...count('Length', num(p, 'len')), ...count('Depth', num(p, 'dep')), ...count('Parsing user id', num(p, 'uid'))]
  const oct = num(p, 'oct')
  if (oct !== undefined) f.push({ label: 'Command', value: COMMAND_NAMES[oct] ? `${COMMAND_NAMES[oct]} (${oct})` : String(oct), hint: `oct=${oct}, v$sqlcommand` })
  f.push(...count('Privilege user id', num(p, 'lid')))
  for (const [k, label] of [['hv', 'Hash value'], ['ad', 'Address'], ['sqlid', 'SQL ID']] as const) if (p.get(k)) f.push({ label, value: p.get(k)! })
  f.push(...timField(num(p, 'tim'), ctx))
  return { title: `PARSING IN CURSOR #${m[1]}`, fields: f }
}

function decodeError(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^(PARSE )?ERROR\s+#(\d+):(.*)$/.exec(text)
  if (!m) return null
  const p = pairs(m[3])
  const err = num(p, 'err')
  const f: LineField[] = []
  if (err !== undefined) f.push({ label: 'Error', value: oraErr(err), hint: `err=${err}` })
  if (m[1]) {
    f.push(...count('Length', num(p, 'len')), ...count('Depth', num(p, 'dep')), ...count('Parsing user id', num(p, 'uid')))
    const oct = num(p, 'oct')
    if (oct !== undefined) f.push({ label: 'Command', value: COMMAND_NAMES[oct] ? `${COMMAND_NAMES[oct]} (${oct})` : String(oct), hint: `oct=${oct}, v$sqlcommand` })
    f.push(...count('Privilege user id', num(p, 'lid')))
  }
  f.push(...timField(num(p, 'tim'), ctx))
  return { title: `${m[1] ?? ''}ERROR #${m[2]}`, fields: f, note: m[1] ? 'The statement text follows, without END OF STMT.' : undefined }
}

function decodeLob(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^(\w+):\s*(.*)$/.exec(text)
  if (!m) return null
  const p = new Map<string, string>()
  for (const x of m[2].split(',')) { const i = x.indexOf('='); if (i > 0) p.set(x.slice(0, i).trim(), x.slice(i + 1).trim()) }
  const f: LineField[] = []
  if (p.get('type')) f.push({ label: 'LOB type', value: p.get('type')! })
  f.push(...count('Bytes', num(p, 'bytes')), ...dur('CPU', num(p, 'c')), ...dur('Elapsed', num(p, 'e')))
  f.push(...count('Physical reads', num(p, 'p')), ...count('Consistent gets', num(p, 'cr')), ...count('Current gets', num(p, 'cu')))
  f.push(...timField(num(p, 'tim'), ctx))
  return { title: m[1], fields: f }
}

// ---- bind lines ----------------------------------------------------------------------------------------

/** A row of a memory dump: `7F2B3C10 0A1D0101 00000101   [........]`. */
const HEX_DUMP = /^[0-9A-Fa-f]{8,16} [0-9A-Fa-f]{8}/

/** The fields the bind table adds to a line of a BINDS block (empty where the line does not resolve). */
function bindAtFields(ba: BindAt | undefined): LineField[] {
  if (!ba) return []
  if (ba.header) {
    const n = ba.binds.length
    return [{
      label: 'Bind set', value: n === 0 ? '0 binds' : `${n} bind${n === 1 ? '' : 's'}: ${previewOfBinds(ba.binds, 120)}`, hint: `bind set ${ba.set}`,
      desc: 'every bind of this execution with the value the engine read',
    }]
  }
  if (ba.pos < 0) return []
  const f: LineField[] = [{ label: 'Bind', value: `:${ba.pos}`, desc: 'position of the bind variable (Bind#N)' }]
  const b = ba.bind
  if (!b) return f
  const name = b.type || (ba.dty !== undefined ? BIND_TYPE_NAMES[ba.dty] ?? '' : '')
  if (name || ba.dty !== undefined) {
    f.push({ label: 'Datatype', value: ba.dty !== undefined ? `${name || 'unknown'} (oacdty ${ba.dty})` : name, desc: 'Oracle datatype of the bind' })
  }
  f.push({
    label: 'Value',
    value: b.noDef ? 'same definition as the previous bind (No oacdef)' : b.isNull ? 'NULL' : b.value,
    desc: b.dump ? 'raw memory dump: the engine could not decode this type' : 'the value as the engine read it from the trace',
  })
  if (b.typed) f.push({ label: 'Typed value', value: b.typed, desc: 'ISO 8601 / base-64 ROWID form' })
  if (b.mal > 0) f.push({ label: 'Array', value: `up to ${b.mal} elements`, hint: `mal=${b.mal}`, desc: 'array bind: the trace prints the first element only; r= of the EXEC tells the array size' })
  return f
}

/** The attribute lines of a bind in verbose mode: every token, in the order written. */
function bindAttrFields(t: string): LineField[] {
  const f: LineField[] = []
  for (const x of t.matchAll(/([\w#]+)=(\S*)/g)) {
    const key = x[1], val = x[2], raw = x[0]
    const n = numOf(val)
    const mk = (label: string, value: string, desc: string, hint?: string): LineField => ({ label, value, raw, desc, ...(hint ? { hint } : {}) })
    const cnt = (label: string, desc: string): LineField => mk(label, n === undefined ? val : fmtInt(n), desc)
    switch (key) {
      case 'oacdty': f.push(mk('Datatype', n === undefined ? val : BIND_TYPE_NAMES[n] ? `${BIND_TYPE_NAMES[n]} (${n})` : `unknown (${n})`, 'Oracle internal datatype code of the bind', `oacdty=${val}`)); break
      case 'mxl': {
        const m = /^(\d+)(?:\((\d+)\))?$/.exec(val)
        f.push(m ? mk('Max length', m[2] ? `${m[1]} (private ${m[2]})` : m[1], 'max length of the bind in bytes; in parentheses the private length') : mk('Max length', val, 'max length of the bind in bytes'))
        break
      }
      case 'mxlc': f.push(cnt('Max length (chars)', 'max length in characters (0 for non-character types)')); break
      case 'mal': f.push(mk('Max array length', n === 0 ? '0 (scalar)' : val, 'max array length (0: scalar)')); break
      case 'scl': f.push(cnt('Scale', 'scale of a NUMBER bind (or fractional-second digits)')); break
      case 'pre': f.push(cnt('Precision', 'precision of a NUMBER bind')); break
      case 'oacflg': f.push(mk('Bind flags', val, 'bind flags (hex, undocumented)')); break
      case 'fl2': f.push(mk('Bind flags 2', val, 'bind flags (hex, undocumented)')); break
      case 'frm': f.push(mk('Character form', n !== undefined && FORM_NAMES[n] ? `${FORM_NAMES[n]} (${n})` : val, 'character set form: which character set a character bind uses')); break
      case 'csi': f.push(mk('Character set', n !== undefined && CHARSET_NAMES[n] ? `${CHARSET_NAMES[n]} (${n})` : val, 'id of the character set of the bind (0: not a character type)')); break
      case 'siz': f.push(mk('Buffer size', n === undefined ? val : `${fmtInt(n)} bytes`, 'size of the bind buffer in bytes')); break
      case 'off': f.push(cnt('Offset', 'offset of the value in the bind buffer')); break
      case 'kxsbbbfp': f.push(mk('Buffer address', val, 'address of the bind buffer in the server process (hex)')); break
      case 'bln': f.push(mk('Buffer length', n === undefined ? val : `${fmtInt(n)} bytes`, 'length of the bind buffer in bytes')); break
      case 'avl': f.push(mk('Actual length', n === 0 ? '0 (NULL)' : val, 'actual value length (0 means NULL)')); break
      case 'flg': f.push(mk('Flags', val, 'bind buffer flags (hex, undocumented)', 'flg')); break
      default: f.push({ label: key, value: val, raw, desc: 'not a documented field' })
    }
  }
  return f
}

/** A bind-block line (` Bind#0`, `oacdty=…`, `kxsbbbfp=… avl=…`, `value=…`) or a line of its dump. */
function bindLineBody(text: string, ba: BindAt | undefined, v: boolean): LineDecode | null {
  const t = text.trim()
  const head = /^Bind#(\d+)(.*)$/.exec(t)
  if (head) {
    const dup = /\(dup\b/i.test(head[2])
    const pos: LineField = { label: 'Position', value: head[1] }
    if (v) { pos.raw = `Bind#${head[1]}`; pos.desc = 'position of the bind variable in the statement' }
    return { title: `Bind #${head[1]}`, fields: [pos], note: dup ? 'A repeated occurrence of an earlier bind (dup): no value is printed.' : undefined }
  }
  if (t.startsWith('oacdty=')) {
    if (v) return { title: 'Bind type', fields: bindAttrFields(t) }
    const p = pairs(t)
    const ty = num(p, 'oacdty')
    const f: LineField[] = []
    if (ty !== undefined) f.push({ label: 'Datatype', value: BIND_TYPE_NAMES[ty] ? `${BIND_TYPE_NAMES[ty]} (${ty})` : String(ty), hint: `oacdty=${p.get('oacdty')}` })
    const mxl = /^mxl=(\d+)(?:\((\d+)\))?/m.exec(t.slice(t.indexOf('mxl=')))
    if (mxl) f.push({ label: 'Max length', value: mxl[1], hint: mxl[2] ? `private length ${mxl[2]}` : undefined })
    for (const [k, label] of [['mal', 'Max array length'], ['scl', 'Scale'], ['pre', 'Precision']] as const) {
      const n = num(p, k)
      if (n) f.push({ label, value: String(n) })
    }
    return { title: 'Bind type', fields: f }
  }
  if (t.startsWith('kxsbbbfp=')) {
    const p = pairs(t)
    const avl = num(p, 'avl')
    const note = avl === 0 ? 'NULL: there is no value line.' : undefined
    if (v) return { title: 'Bind buffer', fields: bindAttrFields(t), note }
    const f: LineField[] = []
    if (avl !== undefined) f.push({ label: 'Actual length', value: avl === 0 ? '0 (NULL)' : String(avl), hint: 'avl' })
    f.push(...count('Buffer length', num(p, 'bln')))
    if (p.has('flg')) f.push({ label: 'Flags', value: p.get('flg')!, hint: 'flg' })
    return { title: 'Bind buffer', fields: f, note }
  }
  if (t.startsWith('oacflg=')) {
    if (v) return { title: 'Bind attributes', fields: bindAttrFields(t) }
    const f: LineField[] = []
    for (const [k, val] of pairs(t)) f.push({ label: k, value: val })
    return { title: 'Bind attributes', fields: f }
  }
  if (t.startsWith('value=')) {
    const val = t.slice(6)
    const dump = val.startsWith('Unhandled datatype')
    const field: LineField = { label: ba?.bind ? 'Printed value' : 'Value', value: val }
    if (v) { field.raw = t; field.desc = 'the value exactly as the trace prints it' }
    return {
      title: 'Bind value', fields: [field],
      note: dump ? 'The trace prints this type as a memory dump; the lines below hold the bytes.' : val === 'NULL' ? 'NULL' : val.endsWith('..."...') || val.endsWith('"...') ? 'The value is cut by the trace.' : undefined,
    }
  }
  if (/^No oacdef for this bind/.test(t)) return { title: 'Bind (dup)', fields: [], note: 'No oacdef for this bind: a repeated occurrence of an earlier bind name (dup), no value is printed.' }
  if (/^Dump(ing|\s+of memory)/.test(t) || HEX_DUMP.test(t)) {
    return {
      title: 'Memory dump of the bind value', fields: [],
      note: ba?.bind ? 'the engine decodes DATE, TIMESTAMP and INTERVAL dumps: see the Value field' : 'The bytes of a value the trace cannot print as text.',
    }
  }
  return null
}

function decodeBindLine(text: string, ctx: DecodeContext, o: DecodeOptions): LineDecode | null {
  const ba = o.line !== undefined ? ctx.bindAt?.(o.line) : undefined
  // the oacdty line names the datatype itself: the bind table's Datatype would repeat it
  const top = bindAtFields(ba).filter((f) => !(f.label === 'Datatype' && /\boacdty=/.test(text)))
  const d = bindLineBody(text, ba, !!o.verbose)
  if (!d) return top.length ? { title: 'Bind values', fields: top } : null
  if (top.length) d.fields = [...top, ...d.fields]
  return d
}

function decodeBinds(text: string, ctx: DecodeContext, o: DecodeOptions): LineDecode | null {
  const m = /^BINDS\s+#(\d+):/.exec(text)
  if (!m) return null
  const cursor: LineField = { label: 'Cursor', value: `#${m[1]}` }
  if (o.verbose) { cursor.raw = `BINDS #${m[1]}:`; cursor.desc = 'the cursor (its address in the server process) the binds belong to' }
  const top = o.line !== undefined ? bindAtFields(ctx.bindAt?.(o.line)) : []
  return { title: `BINDS #${m[1]}`, fields: [...top, cursor], note: 'The bind variables of the next execution follow, one Bind#n block each.' }
}

// ---- markers -------------------------------------------------------------------------------------------

const MARKER_DESC: Record<string, string> = {
  'SESSION ID': 'session id and serial# of the session that writes this trace',
  'CLIENT ID': 'client identifier set with dbms_session.set_identifier (empty when unset)',
  'SERVICE NAME': 'the service the session connected through (SYS$USERS for bequeath)',
  'MODULE NAME': 'module set with dbms_application_info.set_module',
  'ACTION NAME': 'action set with dbms_application_info.set_action',
  'CLIENT DRIVER': 'the client driver (SERVER for parallel-execution slaves)',
  'CONTAINER ID': 'con_id of the container (pluggable database) the session is in',
}

function decodeMarker(text: string, v: boolean): LineDecode | null {
  /** a field, with `raw` and `desc` in verbose mode */
  const fm = (label: string, value: string, raw: string, desc: string): LineField => (v ? { label, value, raw, desc } : { label, value })
  let m = /^\*\*\* (\d{4}-\S+)(?:\s+\((.*)\))?\s*$/.exec(text)
  if (m) {
    const f: LineField[] = [fm('Time', m[1], m[1], 'wall clock time of the session; it anchors the tim= values around it')]
    if (m[2]) f.push(fm('Container', m[2], `(${m[2]})`, 'pluggable database name and con_id'))
    return { title: 'Timestamp', fields: f, note: 'The wall clock that anchors the tim= values around it.' }
  }
  m = /^\*\*\* ([A-Z][A-Z ]*):\((.*)\)(?:\s+(\d\S*))?\s*$/.exec(text)
  if (m) {
    const f: LineField[] = []
    const desc = MARKER_DESC[m[1]] ?? 'session attribute written when it changes'
    if (m[1] === 'SESSION ID') {
      const [sid, serial] = m[2].split('.')
      f.push(fm('SID', sid, `(${m[2]})`, 'session id (v$session.sid)'), fm('Serial#', serial ?? '', `(${m[2]})`, 'serial number (v$session.serial#): tells a reused sid apart'))
    } else f.push(fm('Value', m[2] === '' ? '(empty)' : m[2], `(${m[2]})`, desc))
    if (m[3]) f.push(fm('Time', m[3], m[3], 'wall clock time at which the attribute was written'))
    return { title: m[1][0] + m[1].slice(1).toLowerCase(), fields: f }
  }
  m = /^\*\*\* TRACE (CONTINUED FROM|CONTINUES IN) FILE (.*?) \*\*\*\s*$/.exec(text)
  if (m) return { title: m[1] === 'CONTINUES IN' ? 'Trace continues in file' : 'Trace continued from file', fields: [fm('File', m[2], m[2], 'the trace file the session wrote before or after this one')] }
  m = /^\*\*\* DUMP FILE SIZE IS LIMITED TO (\d+) BYTES \*\*\*/.exec(text)
  if (m) return { title: 'Dump file size limit', fields: [fm('Limit', `${fmtInt(Number(m[1]))} bytes`, m[1], 'max_dump_file_size: the trace stops at this size')], note: 'The trace was cut by max_dump_file_size; it may end in the middle of any block.' }
  m = /^\*\*\* \[ Unix process pid: (\d+) \]/.exec(text)
  if (m) return { title: 'Process switch', fields: [fm('Unix pid', m[1], m[1], 'operating system process id that wrote the lines after this one')], note: 'A trcsess file: the lines after this come from another process.' }
  return null
}

// ---- verbose: every token of the line ------------------------------------------------------------------

interface Tok { key: string; val: string; raw: string }
type Scope = 'call' | 'lob' | 'cursor' | 'error' | 'xctend'

/** The `key=value` tokens of a text in the order written, with the token as written. */
function scan(s: string): Tok[] {
  const out: Tok[] = []
  for (const x of s.matchAll(/([\w#]+)=('[^']*'|[^\s,)]*)/g)) out.push({ key: x[1], val: x[2].replace(/^'|'$/g, ''), raw: x[0] })
  return out
}
function numOf(s: string): number | undefined { return s === '' || Number.isNaN(Number(s)) ? undefined : Number(s) }

/** `tim` for the verbose card: offset from the first call and clock time when known, the µs in the hint; shown also for 0. */
function timV(t: Tok, ctx: DecodeContext, desc: string): LineField {
  const n = numOf(t.val)
  if (n === undefined) return { label: 'Time', value: t.val, raw: t.raw, desc }
  const off = ctx.firstTim && n > 0 ? `+${fmtDur(n - ctx.firstTim)} from start` : ''
  const value = [off, n > 0 ? ctx.clock?.(n) : undefined].filter(Boolean).join(' · ')
  return { label: 'Time', value: value || String(n), hint: `${fmtInt(n)} µs on the process clock`, raw: t.raw, desc }
}

/** One token of a call, LOB, cursor-parse, error or XCTEND line as a field with its meaning. */
function vfield(t: Tok, ctx: DecodeContext, scope: Scope): LineField {
  const n = numOf(t.val)
  const mk = (label: string, value: string, desc: string, hint?: string): LineField => ({ label, value, raw: t.raw, desc, ...(hint ? { hint } : {}) })
  const dur = (label: string, desc: string) => (n === undefined ? mk(label, t.val, desc) : mk(label, fmtDur(n), desc, `${fmtInt(n)} µs`))
  const cnt = (label: string, desc: string) => mk(label, n === undefined ? t.val : fmtInt(n), desc)
  switch (t.key) {
    case 'c': return dur('CPU', scope === 'lob' ? 'CPU time this LOB operation consumed' : 'CPU time this call consumed')
    case 'e': return dur('Elapsed', scope === 'lob' ? 'wall-clock time of the operation, waits included' : 'wall-clock time of the call, waits included')
    case 'p': return cnt('Physical reads', 'database blocks read from disk')
    case 'cr': return cnt('Consistent gets', 'blocks read in consistent (query) mode')
    case 'cu': return cnt('Current gets', 'blocks read in current mode (latest version, for changes)')
    case 'mis': return mk('Library cache miss', n === undefined ? t.val : n > 0 ? 'hard parse' : 'soft parse / cursor found', 'library-cache misses: 1 means a hard parse', `mis=${t.val}`)
    case 'r': return cnt('Rows', 'rows processed (EXEC) or returned (FETCH) by the call')
    case 'dep': return mk('Depth', n === undefined ? t.val : n === 0 ? 'top-level (issued by the client)' : `recursive, depth ${n}`, 'recursion depth: 0 is issued by the client, higher is SQL run on behalf of other SQL', `dep=${t.val}`)
    case 'og': return mk('Optimizer goal', n === undefined ? t.val : GOALS[n] ?? String(n), 'optimizer goal the statement was parsed with', `og=${t.val}`)
    case 'plh': return mk('Plan hash', n === 0 ? '0 (no plan hash yet)' : t.val, 'hash of the execution plan (0: no plan yet, e.g. before the parse finished)')
    case 'type':
      return scope === 'lob'
        ? mk('LOB type', t.val, 'PERSISTENT LOB (in a table) or TEMPORARY LOB')
        : mk('Close type', n === undefined ? t.val : CLOSE_TYPES[n] ?? String(n), 'how the cursor was closed: 0 really closed, 1-3 kept in the session cursor cache', `type=${t.val}`)
    case 'bytes': return cnt('Bytes', 'bytes the LOB operation moved')
    case 'tim': return timV(t, ctx, 'microsecond clock of the process when the event ended; compare with other tim values or map to wall time through the *** timestamps')
    case 'len': return cnt('Length', 'length of the SQL text in bytes')
    case 'uid': return cnt('Parsing user id', 'id of the user that parsed the statement (user$)')
    case 'lid': return cnt('Privilege user id', 'id of the user whose privileges the statement runs with')
    case 'oct': return mk('Command', n !== undefined && COMMAND_NAMES[n] ? `${COMMAND_NAMES[n]} (${n})` : t.val, 'SQL command code of the statement (v$sqlcommand)', `oct=${t.val}`)
    case 'hv': return mk('Hash value', t.val, 'hash value of the SQL text (v$sql.hash_value)')
    case 'ad': return mk('Address', t.val, 'address of the cursor in the shared pool (v$sql.address)')
    case 'sqlid': return mk('SQL ID', t.val, 'SQL id of the statement (v$sql.sql_id)')
    case 'err': return mk('Error', n === undefined ? t.val : oraErr(n), 'Oracle error number the call raised', `err=${t.val}`)
    case 'rlbk': return mk('Outcome', n === undefined ? t.val : n ? 'rollback' : 'commit', 'rlbk=1 means the transaction was rolled back, 0 that it was committed', `rlbk=${t.val}`)
    case 'rd_only': return mk('Read only', n === undefined ? t.val : n ? 'read-only transaction' : 'changes were made', 'rd_only=1 means the transaction changed nothing', `rd_only=${t.val}`)
    default: return { label: t.key, value: t.val, raw: t.raw, desc: 'not a documented field' }
  }
}

function decodeCallV(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^(PARSE|EXEC|FETCH|CLOSE)\s+#(\d+):(.*)$/.exec(text)
  if (!m) return null
  const toks = scan(m[3])
  const f = toks.map((t) => vfield(t, ctx, 'call'))
  const c = numOf(toks.find((t) => t.key === 'c')?.val ?? ''), e = numOf(toks.find((t) => t.key === 'e')?.val ?? '')
  if (c !== undefined && e !== undefined) {
    f.push({ label: 'Elapsed − CPU', value: fmtDur(e - c), hint: `${fmtInt(e - c)} µs`, desc: 'time not on CPU: waits or run-queue' })
  }
  return { title: `${m[1]} #${m[2]}`, fields: f }
}

function decodeWaitV(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^WAIT\s+#(\d+):\s*nam='(.*)'\s+(ela=\s*(-?\d+))\s*(.*)$/.exec(text)
  if (!m) return null
  const [, cursor, name, elaRaw, ela, rest] = m
  const ev = ctx.eventOf?.(name)
  const f: LineField[] = [
    { label: 'Event', value: name, raw: `nam='${name}'`, desc: 'name of the wait event' },
    { label: 'Waited', value: fmtDur(Number(ela)), hint: `${fmtInt(Number(ela))} µs`, raw: elaRaw, desc: 'time the session waited' },
  ]
  if (ev?.class) f.push({ label: 'Class', value: ev.class, desc: 'wait class of the event' })
  const tail = rest.search(/\bobj#=|\btim=/)
  const params = waitParams(tail < 0 ? rest : rest.slice(0, tail))
  const names = ev ? [ev.p1Name, ev.p2Name, ev.p3Name] : []
  params.forEach((x, i) => {
    const raw = `${x.label}=${x.value}`
    if (i >= 3) { f.push({ label: x.label, value: x.value, raw, desc: 'not a documented field' }); return }
    const named = names[i]
    f.push({ label: named || x.label, value: x.value, raw, hint: `p${i + 1}`, desc: `parameter ${i + 1} of the event${named && named !== x.label ? `; the trace prints "${x.label}"` : ''}` })
  })
  if (tail >= 0) {
    for (const t of scan(rest.slice(tail))) {
      const n = numOf(t.val)
      if (t.key === 'obj#') {
        const some = n !== undefined && n > 0 && n !== OBJ_NONE_U32
        const on = some ? ctx.objectName?.(n) : undefined
        f.push({ label: 'Object', value: n === undefined ? t.val : on ? `${on} (${n})` : some ? String(n) : `none (${n})`, hint: `obj#=${t.val}`, raw: t.raw, desc: 'object the wait is about (-1, or 4294967295 in 23ai: not applicable)' })
      } else if (t.key === 'tim') f.push(timV(t, ctx, 'microsecond clock of the process when the wait ended'))
      else f.push({ label: t.key, value: t.val, raw: t.raw, desc: 'not a documented field' })
    }
  }
  return { title: cursor === '0' ? 'WAIT (no cursor)' : `WAIT #${cursor}`, fields: f }
}

const STAT_ID: Record<string, [string, string]> = {
  id: ['Plan line', 'id of the row source in the plan'], cnt: ['Rows', 'rows this row source produced'],
  pid: ['Parent', 'id of the parent plan line (0: the root)'], pos: ['Position', 'order of the row source among its siblings'],
}
const STAT_OP: Record<string, [string, string]> = {
  cr: ['Consistent gets', 'blocks read in consistent mode by the row source and its children'],
  pr: ['Physical reads', 'database blocks read from disk'], pw: ['Physical writes', 'database blocks written to disk'],
  str: ['Starts', 'times the row source was started'], time: ['Time', 'elapsed time of the row source and its children'],
  cost: ['Cost', 'optimizer cost estimate'], size: ['Size', 'optimizer estimate of the bytes returned'], card: ['Estimated rows', 'optimizer cardinality estimate'],
}

function decodeStatV(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^STAT\s+#(\d+)\s+(.*?)\s+op='(.*)'\s*$/.exec(text)
  if (!m) return null
  const f: LineField[] = []
  for (const t of scan(m[2])) {
    const n = numOf(t.val)
    if (t.key === 'obj') {
      const name = n !== undefined && n > 0 ? ctx.objectName?.(n) : undefined
      f.push({ label: 'Object', value: n === undefined ? t.val : n === 0 ? '0 (none)' : name ? `${name} (${n})` : String(n), hint: `obj=${t.val}`, raw: t.raw, desc: 'obj# of the table or index the row source reads (0: none)' })
    } else if (STAT_ID[t.key]) f.push({ label: STAT_ID[t.key][0], value: n === undefined ? t.val : fmtInt(n), raw: t.raw, desc: STAT_ID[t.key][1] })
    else f.push({ label: t.key, value: t.val, raw: t.raw, desc: 'not a documented field' })
  }
  const at = m[3].lastIndexOf('(cr=')
  const op = (at < 0 ? m[3] : m[3].slice(0, at)).trim()
  f.push({ label: 'Operation', value: op, raw: op, desc: 'the row-source operation and, when it reads an object, its name' })
  if (at >= 0) {
    for (const x of m[3].slice(at).matchAll(/(\w+)=(-?\d+)( us)?/g)) {
      const n = Number(x[2]), spec = STAT_OP[x[1]]
      if (!spec) f.push({ label: x[1], value: x[2], raw: x[0], desc: 'not a documented field' })
      else if (x[1] === 'time') f.push({ label: spec[0], value: fmtDur(n), hint: `${fmtInt(n)} µs`, raw: x[0], desc: spec[1] })
      else f.push({ label: spec[0], value: fmtInt(n), raw: x[0], desc: spec[1] })
    }
  }
  return { title: `STAT #${m[1]}`, fields: f }
}

function decodeXctendV(text: string, ctx: DecodeContext): LineDecode | null {
  if (!text.startsWith('XCTEND')) return null
  return { title: 'XCTEND', fields: scan(text).map((t) => vfield(t, ctx, 'xctend')) }
}

function decodeParsingV(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^PARSING IN CURSOR\s+#(\d+)(.*)$/.exec(text)
  if (!m) return null
  return { title: `PARSING IN CURSOR #${m[1]}`, fields: scan(m[2]).map((t) => vfield(t, ctx, 'cursor')) }
}

function decodeErrorV(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^(PARSE )?ERROR\s+#(\d+):(.*)$/.exec(text)
  if (!m) return null
  return { title: `${m[1] ?? ''}ERROR #${m[2]}`, fields: scan(m[3]).map((t) => vfield(t, ctx, 'error')), note: m[1] ? 'The statement text follows, without END OF STMT.' : undefined }
}

const LOB_OPS: Record<string, string> = {
  LOBREAD: 'A read from a LOB.', LOBARRTMPFRE: 'Frees temporary LOBs (array form).', LOBGETLEN: 'Reads the length of a LOB.',
  LOBWRITE: 'A write to a LOB.', LOBAPPEND: 'An append to a LOB.', LOBPGSIZE: 'Reads the page size of a LOB.',
}

function decodeLobV(text: string, ctx: DecodeContext): LineDecode | null {
  const m = /^(\w+):\s*(.*)$/.exec(text)
  if (!m) return null
  const f: LineField[] = []
  for (const x of m[2].split(',')) {
    const i = x.indexOf('=')
    if (i > 0) f.push(vfield({ key: x.slice(0, i).trim(), val: x.slice(i + 1).trim(), raw: x.trim() }, ctx, 'lob'))
  }
  return { title: m[1], fields: f, note: LOB_OPS[m[1]] }
}

/**
 * The fields of one trace line for the hover card, from its text and kind (null where there is nothing to decode).
 * Only the fixed grammar of `docs/trace-format-19c.md` is read; a line that does not match decodes to null.
 *
 * `opts.verbose` (the line inspector) lists every `key=value` token in the order written, zeros included, each with the token as
 * written (`raw`) and its meaning (`desc`), and never returns null: a line without fields decodes to its kind label and a remark.
 * `opts.line` with `ctx.bindAt` lets the lines of a BINDS block show the datatype and the value the engine read for their bind.
 */
export function decodeLine(text: string, kind: LineKind, ctx: DecodeContext = {}, opts: DecodeOptions = {}): LineDecode | null {
  const v = !!opts.verbose
  let d: LineDecode | null
  switch (kind) {
    case 'call': d = v ? decodeCallV(text, ctx) : decodeCall(text, ctx); break
    case 'wait': d = v ? decodeWaitV(text, ctx) : decodeWait(text, ctx); break
    case 'stat': d = v ? decodeStatV(text, ctx) : decodeStat(text, ctx); break
    case 'binds': d = decodeBinds(text, ctx, opts); break
    case 'bind-line': d = decodeBindLine(text, ctx, opts); break
    case 'xctend': d = v ? decodeXctendV(text, ctx) : decodeXctend(text, ctx); break
    case 'parsing-in-cursor': d = v ? decodeParsingV(text, ctx) : decodeParsing(text, ctx); break
    case 'error': case 'parse-error': d = v ? decodeErrorV(text, ctx) : decodeError(text, ctx); break
    case 'lob': d = v ? decodeLobV(text, ctx) : decodeLob(text, ctx); break
    case 'marker': d = decodeMarker(text, v); break
    default: d = null
  }
  if (d && v && opts.line !== undefined && (kind === 'call' || kind === 'wait')) {
    const g = ctx.gapBefore?.(opts.line)
    if (g) {
      d.fields.push({
        label: 'Gap before', value: fmtDur(g.us), hint: `idle since line ${g.fromLine}`,
        desc: 'time between the end of the previous call or wait and the start of this one',
      })
    }
  }
  if (!d) {
    if (!v) return null
    d = { title: KIND_LABELS[kind], fields: [], note: KIND_NOTES[kind] ?? 'The line does not match the documented format of its kind.' }
  }
  d.kindLabel = KIND_LABELS[kind]
  return d
}

/** The digits at `i` (after spaces) as a number, or -1. */
function digitsAt(text: string, i: number): number {
  const n = text.length
  while (i < n && text.charCodeAt(i) === 32) i++
  let v = 0, any = false
  for (; i < n; i++) {
    const c = text.charCodeAt(i) - 48
    if (c < 0 || c > 9) break
    v = v * 10 + c
    any = true
  }
  return any ? v : -1
}

/**
 * The elapsed µs of a call line (`,e=NNN`) or a wait line (`ela= NNN`), -1 for any other line. Cheap: an indexOf and a digit loop,
 * no RegExp and no allocation, as the viewer calls it for every rendered call and wait.
 */
export function elaOf(text: string, kind: LineKind): number {
  if (kind === 'call') {
    const i = text.indexOf(',e=')
    return i < 0 ? -1 : digitsAt(text, i + 3)
  }
  if (kind === 'wait') {
    const i = text.indexOf("' ela=")
    return i < 0 ? -1 : digitsAt(text, i + 6)
  }
  return -1
}

/** A field whose value says "nothing": `0`, `0` with a unit (`0 µs`), or `no`. */
const ZERO = /^(?:0(?:\s.*)?|no)$/

/**
 * The hover card's layout of a decode: the fields with something to say, and the labels (lower case) of the zero ones, which the
 * card lists on one line instead of a row each. The inspector keeps every field.
 */
export function splitZeros(fields: readonly LineField[]): { shown: LineField[]; zeros: string[] } {
  const shown: LineField[] = [], zeros: string[] = []
  for (const f of fields) {
    if (ZERO.test(f.value.trim())) zeros.push(f.label.toLowerCase()); else shown.push(f)
  }
  return { shown, zeros }
}
