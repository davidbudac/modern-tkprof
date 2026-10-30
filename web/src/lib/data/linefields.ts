import type { LineKind } from './lines'
import { fmtDur, fmtInt, oraErr } from './format'

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
}

export interface LineField { label: string; value: string; hint?: string }
/** What a hover card shows of one line: a title, a two-column table, an optional remark. */
export interface LineDecode { title: string; fields: LineField[]; note?: string }

/** `v$sqlcommand` numbers of the usual `oct` values. */
const COMMANDS: Record<number, string> = {
  1: 'CREATE TABLE', 2: 'INSERT', 3: 'SELECT', 6: 'UPDATE', 7: 'DELETE', 9: 'CREATE INDEX', 42: 'ALTER SESSION',
  44: 'COMMIT', 45: 'ROLLBACK', 47: 'PL/SQL EXECUTE', 85: 'TRUNCATE TABLE', 170: 'CALL METHOD', 189: 'MERGE',
}
const GOALS: Record<number, string> = { 1: 'ALL_ROWS', 2: 'FIRST_ROWS', 3: 'RULE', 4: 'CHOOSE' }
const CLOSE_TYPES: Record<number, string> = { 0: 'hard close', 1: 'soft close, kept in the cursor cache', 2: 'soft close', 3: 'already in the cursor cache' }
/** `oacdty` codes of bind datatypes. */
const BIND_TYPES: Record<number, string> = {
  1: 'VARCHAR2', 2: 'NUMBER', 8: 'LONG', 12: 'DATE', 23: 'RAW', 24: 'LONG RAW', 69: 'ROWID', 96: 'CHAR', 100: 'BINARY_FLOAT', 101: 'BINARY_DOUBLE',
  112: 'CLOB', 113: 'BLOB', 123: 'collection', 180: 'TIMESTAMP', 181: 'TIMESTAMP WITH TZ', 182: 'INTERVAL YEAR TO MONTH',
  183: 'INTERVAL DAY TO SECOND', 208: 'UROWID', 231: 'TIMESTAMP WITH LOCAL TZ',
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

/** An obj# with its name when the trace's reference data knows it; none for 0 and -1. */
function objField(label: string, obj: number | undefined, ctx: DecodeContext): LineField[] {
  if (obj === undefined || obj <= 0) return []
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

/** A bind-block line (` Bind#0`, `oacdty=…`, `kxsbbbfp=… avl=…`, `value=…`) or the first lines of its dump. */
function decodeBindLine(text: string): LineDecode | null {
  const t = text.trim()
  const head = /^Bind#(\d+)(.*)$/.exec(t)
  if (head) {
    const dup = /\(dup\b/i.test(head[2])
    return { title: `Bind #${head[1]}`, fields: [{ label: 'Position', value: head[1] }], note: dup ? 'A repeated occurrence of an earlier bind (dup): no value is printed.' : undefined }
  }
  if (t.startsWith('oacdty=')) {
    const p = pairs(t)
    const ty = num(p, 'oacdty')
    const f: LineField[] = []
    if (ty !== undefined) f.push({ label: 'Datatype', value: BIND_TYPES[ty] ? `${BIND_TYPES[ty]} (${ty})` : String(ty), hint: `oacdty=${p.get('oacdty')}` })
    const mxl = /^mxl=(\d+)(?:\((\d+)\))?/m.exec(t.slice(t.indexOf('mxl=')))
    if (mxl) f.push({ label: 'Max length', value: mxl[1], hint: mxl[2] ? `private length ${mxl[2]}` : undefined })
    for (const [k, label] of [['mal', 'Max array length'], ['scl', 'Scale'], ['pre', 'Precision']] as const) {
      const v = num(p, k)
      if (v) f.push({ label, value: String(v) })
    }
    return { title: 'Bind type', fields: f }
  }
  if (t.startsWith('kxsbbbfp=')) {
    const p = pairs(t)
    const avl = num(p, 'avl'), f: LineField[] = []
    if (avl !== undefined) f.push({ label: 'Actual length', value: avl === 0 ? '0 (NULL)' : String(avl), hint: 'avl' })
    f.push(...count('Buffer length', num(p, 'bln')))
    if (p.has('flg')) f.push({ label: 'Flags', value: p.get('flg')!, hint: 'flg' })
    return { title: 'Bind buffer', fields: f, note: avl === 0 ? 'NULL: there is no value line.' : undefined }
  }
  if (t.startsWith('oacflg=')) {
    const f: LineField[] = []
    for (const [k, v] of pairs(t)) f.push({ label: k, value: v })
    return { title: 'Bind attributes', fields: f }
  }
  if (t.startsWith('value=')) {
    const v = t.slice(6)
    const dump = v.startsWith('Unhandled datatype')
    return {
      title: 'Bind value', fields: [{ label: 'Value', value: v }],
      note: dump ? 'The trace prints this type as a memory dump; the lines below hold the bytes.' : v === 'NULL' ? 'NULL' : v.endsWith('..."...') || v.endsWith('"...') ? 'The value is cut by the trace.' : undefined,
    }
  }
  if (/^No oacdef for this bind/.test(t)) return { title: 'Bind (dup)', fields: [], note: 'No oacdef for this bind: a repeated occurrence of an earlier bind name (dup), no value is printed.' }
  if (/^Dump(ing|\s+of memory)/.test(t)) return { title: 'Bind value (memory dump)', fields: [], note: 'The bytes of a value the trace cannot print as text.' }
  return null
}

function decodeBinds(text: string): LineDecode | null {
  const m = /^BINDS\s+#(\d+):/.exec(text)
  return m ? { title: `BINDS #${m[1]}`, fields: [{ label: 'Cursor', value: `#${m[1]}` }], note: 'The bind variables of the next execution follow, one Bind#n block each.' } : null
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
  if (oct !== undefined) f.push({ label: 'Command', value: COMMANDS[oct] ? `${COMMANDS[oct]} (${oct})` : String(oct), hint: `oct=${oct}, v$sqlcommand` })
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
    if (oct !== undefined) f.push({ label: 'Command', value: COMMANDS[oct] ? `${COMMANDS[oct]} (${oct})` : String(oct), hint: `oct=${oct}, v$sqlcommand` })
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

function decodeMarker(text: string, ctx: DecodeContext): LineDecode | null {
  let m = /^\*\*\* (\d{4}-\S+)(?:\s+\((.*)\))?\s*$/.exec(text)
  if (m) {
    const f: LineField[] = [{ label: 'Time', value: m[1] }]
    if (m[2]) f.push({ label: 'Container', value: m[2] })
    return { title: 'Timestamp', fields: f, note: 'The wall clock that anchors the tim= values around it.' }
  }
  m = /^\*\*\* ([A-Z][A-Z ]*):\((.*)\)(?:\s+(\d\S*))?\s*$/.exec(text)
  if (m) {
    const f: LineField[] = []
    if (m[1] === 'SESSION ID') {
      const [sid, serial] = m[2].split('.')
      f.push({ label: 'SID', value: sid }, { label: 'Serial#', value: serial ?? '' })
    } else f.push({ label: 'Value', value: m[2] === '' ? '(empty)' : m[2] })
    if (m[3]) f.push({ label: 'Time', value: m[3] })
    return { title: m[1][0] + m[1].slice(1).toLowerCase(), fields: f }
  }
  m = /^\*\*\* TRACE (CONTINUED FROM|CONTINUES IN) FILE (.*?) \*\*\*\s*$/.exec(text)
  if (m) return { title: m[1] === 'CONTINUES IN' ? 'Trace continues in file' : 'Trace continued from file', fields: [{ label: 'File', value: m[2] }] }
  m = /^\*\*\* DUMP FILE SIZE IS LIMITED TO (\d+) BYTES \*\*\*/.exec(text)
  if (m) return { title: 'Dump file size limit', fields: [{ label: 'Limit', value: `${fmtInt(Number(m[1]))} bytes` }], note: 'The trace was cut by max_dump_file_size; it may end in the middle of any block.' }
  m = /^\*\*\* \[ Unix process pid: (\d+) \]/.exec(text)
  if (m) return { title: 'Process switch', fields: [{ label: 'Unix pid', value: m[1] }], note: 'A trcsess file: the lines after this come from another process.' }
  void ctx
  return null
}

/**
 * The fields of one trace line for the hover card, from its text and kind (null where there is nothing to decode).
 * Only the fixed grammar of `docs/trace-format-19c.md` is read; a line that does not match decodes to null.
 */
export function decodeLine(text: string, kind: LineKind, ctx: DecodeContext = {}): LineDecode | null {
  switch (kind) {
    case 'call': return decodeCall(text, ctx)
    case 'wait': return decodeWait(text, ctx)
    case 'stat': return decodeStat(text, ctx)
    case 'binds': return decodeBinds(text)
    case 'bind-line': return decodeBindLine(text)
    case 'xctend': return decodeXctend(text, ctx)
    case 'parsing-in-cursor': return decodeParsing(text, ctx)
    case 'error': case 'parse-error': return decodeError(text, ctx)
    case 'lob': return decodeLob(text, ctx)
    case 'marker': return decodeMarker(text, ctx)
    default: return null
  }
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
