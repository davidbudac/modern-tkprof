// The readable mode of the Lines view: each trace line parsed and laid out as columns (what it is, its detail, its time), the lines of
// one cursor joined into a lane in the statement's colour. Pure: the view feeds it the cached lines (see views/readableRows.ts).
import { MAX_CATEGORIES, categoryTone, type Tone } from './blocklayout'
import { BIND_TYPE_NAMES, CHARSET_NAMES, FORM_NAMES } from './bindat'
import { bindNames } from './bindsql'
import type { BindRow } from './derive'
import { fmtDur, fmtInt } from './format'
import { CLOSE_TYPES, COMMAND_NAMES } from './linefields'
import type { LineKind } from './lines'
import type { Role } from '../components/colors'

/** A piece of a row's detail: plain text, text with a class (`rd-<c>`) and a tooltip, or a quantity (`rd-q-<q>`): its number in ink, its unit dim. */
export type Seg = string | { t: string; c: string; title?: string } | Quantity
export interface Quantity { q: string; n: string; unit: string; title?: string }

/** A duration as a quantity: `964 µs` → number 964, unit µs (with `label` after the unit). */
function durQ(q: string, us: number, title: string, label = ''): Quantity {
  const s = fmtDur(us), i = s.lastIndexOf(' ')
  return { q, n: s.slice(0, i), unit: s.slice(i + 1) + (label ? ` ${label}` : ''), title }
}
/** A count as a quantity. */
function countQ(q: string, n: number, one: string, many: string, title: string): Quantity {
  return { q, n: fmtInt(n), unit: n === 1 ? one : many, title }
}

/** What the readable row of one line shows, apart from its lane and its time columns. */
export interface LineView {
  /** the short name of the line (EXEC, WAIT, STAT, …), '' for none */
  label: string
  /** the tone of the label (`lv-tone-<tone>`) */
  tone: string
  parts: Seg[]
  /** the line's own time (e= of a call, ela= of a wait) for the bar; `cpu` the CPU part of a call, `role` the colour of a wait */
  bar?: { us: number; cpu?: number; role: Role }
  /** the row offers the statement with the values of this BINDS block */
  asRun?: boolean
  /** the time the line itself took (a call's e=, a wait's ela=), µs: shown in its own column, aligned down the view */
  dur?: number
  /** the detail is indented by this many steps (the attribute lines under a `Bind#`) */
  indent?: number
  /** a wall-clock time the line prints itself (`***` lines): HH:MM:SS.mmm and the µs after it, for the clock column */
  wall?: { clock: string; micros: string; title: string }
  /** a plan line (STAT): laid out as a row of the plan table, in columns (see `PLAN_COLUMNS`) */
  plan?: PlanRow
  /** what the Operation cell says it is: a call (loud), a wait (quiet), a structure (PLAN, BINDS), a marker; none: the cell keeps its tone */
  op?: OpKind
  /** a wait: the colour role of the dot before its event (hollow for idle) */
  dot?: Role
  /** a call: the time it spent waiting (its e= off the CPU) when that is a good share of it, else undefined */
  waited?: WaitShare
  /** a BINDS header whose values are known: the head of the table of its binds */
  bindHead?: boolean
  /** a `Bind#N` line whose value is known: a row of the table of binds (`last`: the set's last bind) */
  bindRow?: BindCellRow
}

/** How the Operation cell reads a line: a call (PARSE, EXEC, FETCH, CLOSE, CURSOR, COMMIT), a wait, a structure (PLAN, BINDS), a marker (`***`). */
export type OpKind = 'call' | 'wait' | 'struct' | 'mark'

/** The share of a call that went to waiting: µs, % of the call, and `crit` from half of it. */
export interface WaitShare { us: number; pct: number; crit: boolean }

/** A bind as a row of the table of binds: its placeholder, value and type. */
export interface BindCellRow { pos: number; name: string; value: string; type: string; none: boolean; last: boolean; title: string }

/** What describing a line may ask of the trace (every part optional). */
export interface ReadableContext {
  eventOf?(name: string): { class: string; idle: boolean; role: Role } | undefined
  objectName?(obj: number): string | undefined
  userName?(uid: number): string | undefined
  /** the bind set of a BINDS line and the statement text it belongs to (names the placeholders) */
  bindsAt?(line: number): { binds: BindRow[]; pos: number; header: boolean; bind?: BindRow; sql?: string; dty?: number } | undefined
  /** the plan line of a STAT line: its depth, its own time (time minus its children's) and the time of the plan's root */
  planAt?(line: number): PlanCell | undefined
}

export interface PlanCell { depth: number; self: number; root: number }

/**
 * One line of a plan as a table row, DBMS_XPLAN's columns: undefined where the STAT line has no such value. `self` is the time of
 * the operation without its children, `root` the time of the whole plan (the bar of A-Time is self / root); `off` flags an estimate
 * 10× or more away from the rows per start.
 */
export interface PlanRow {
  id: number; pid: number; depth: number; op: string; name?: string; obj: number
  starts?: number; eRows?: number; aRows: number; cost?: number; time?: number; self?: number; root?: number
  cr?: number; pr?: number; pw?: number
  off: boolean
  /** the operation's own time is 1 % of the traced time or more (set by the view, which knows the threshold) */
  hot?: boolean
}

/** The plan table's columns after Id, Operation and Name: key, header and what the header means (the cell tooltip). */
export const PLAN_COLUMNS = [
  { key: 'starts', head: 'Starts', title: 'str=: times the operation started' },
  { key: 'eRows', head: 'E-Rows', title: 'card=: the rows the optimizer expected per start' },
  { key: 'aRows', head: 'A-Rows', title: 'cnt=: the rows the operation produced, over all starts' },
  { key: 'cost', head: 'Cost', title: "cost=: the optimizer's cost" },
  { key: 'time', head: 'A-Time', title: 'time=: the time of the operation and its children; the bar is its own time, of the whole plan' },
  { key: 'cr', head: 'Buffers', title: 'cr=: consistent reads' },
  { key: 'pr', head: 'Reads', title: 'pr=: physical reads' },
  { key: 'pw', head: 'Writes', title: 'pw=: physical writes' },
] as const satisfies readonly { key: keyof PlanRow; head: string; title: string }[]

// ---- parsers -----------------------------------------------------------------------------------------------------------------

const pairsRe = /([\w#]+)=('[^']*'|[^\s,)]*)/g
function pairs(s: string): Map<string, string> {
  const m = new Map<string, string>()
  for (const x of s.matchAll(pairsRe)) m.set(x[1], x[2].replace(/^'|'$/g, ''))
  return m
}
const num = (m: Map<string, string>, k: string): number | undefined => {
  const v = m.get(k)
  if (v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isNaN(n) ? undefined : n
}

export interface CallLine { op: string; cur: string; c?: number; e?: number; p?: number; cr?: number; cu?: number; mis?: number; r?: number; dep?: number; plh?: number; type?: number; tim?: number }
export function parseCall(text: string): CallLine | null {
  const m = /^(PARSE|EXEC|FETCH|CLOSE|UNMAP|SORT UNMAP)\s+#(\d+):(.*)$/.exec(text)
  if (!m) return null
  const p = pairs(m[3])
  return { op: m[1], cur: m[2], c: num(p, 'c'), e: num(p, 'e'), p: num(p, 'p'), cr: num(p, 'cr'), cu: num(p, 'cu'), mis: num(p, 'mis'), r: num(p, 'r'), dep: num(p, 'dep'), plh: num(p, 'plh'), type: num(p, 'type'), tim: num(p, 'tim') }
}

export interface WaitLine { cur: string; nam: string; ela: number; params: { label: string; value: string }[]; obj?: number; tim?: number }
export function parseWait(text: string): WaitLine | null {
  const m = /^WAIT\s+#(\d+):\s*nam='(.*)'\s+ela=\s*(-?\d+)\s*(.*)$/.exec(text)
  if (!m) return null
  const rest = m[4]
  const tail = rest.search(/\bobj#=|\btim=/)
  const params: { label: string; value: string }[] = []
  for (const x of (tail < 0 ? rest : rest.slice(0, tail)).matchAll(/([^=]+)=(\S*)/g)) params.push({ label: x[1].trim(), value: x[2] })
  const p = pairs(rest.slice(Math.max(0, tail)))
  return { cur: m[1], nam: m[2], ela: Number(m[3]), params: params.slice(0, 3), obj: num(p, 'obj#'), tim: num(p, 'tim') }
}

export interface StatLine { cur: string; id: number; cnt: number; pid: number; obj: number; op: string; name?: string; cr?: number; pr?: number; pw?: number; str?: number; time?: number; cost?: number; card?: number }
export function parseStat(text: string): StatLine | null {
  const m = /^STAT\s+#(\d+)\s+(.*?)\s+op='(.*)'\s*$/.exec(text)
  if (!m) return null
  const p = pairs(m[2])
  const at = m[3].lastIndexOf('(cr=')
  const opText = (at < 0 ? m[3] : m[3].slice(0, at)).trim()
  const s = pairs(at < 0 ? '' : m[3].slice(at + 1, -1))
  const obj = num(p, 'obj') ?? 0
  // the object's name ends the operation text when the line has an object: `TABLE ACCESS FULL EMP`
  const sp = opText.lastIndexOf(' ')
  const name = obj > 0 && sp > 0 ? opText.slice(sp + 1) : undefined
  return {
    cur: m[1], id: num(p, 'id') ?? 0, cnt: num(p, 'cnt') ?? 0, pid: num(p, 'pid') ?? 0, obj, op: name ? opText.slice(0, sp) : opText, name,
    cr: num(s, 'cr'), pr: num(s, 'pr'), pw: num(s, 'pw'), str: num(s, 'str'), time: num(s, 'time'), cost: num(s, 'cost'), card: num(s, 'card'),
  }
}

// ---- one line --------------------------------------------------------------------------------------------------------------

/**
 * The time a call spent waiting, `e − c` (what was not CPU), when it is worth a word: at least 10 % of the call and 100 µs; `crit`
 * from half of the call. Undefined without both times or when it is not.
 */
export function waitShare(c: number | undefined, e: number | undefined): WaitShare | undefined {
  if (c === undefined || e === undefined) return undefined
  const us = e - c
  if (us < 0.1 * e || us < 100) return undefined
  return { us, pct: Math.round((100 * us) / e), crit: us >= 0.5 * e }
}

const dim = (t: string, title?: string): Seg => ({ t, c: 'dim', title })
const sep: Seg = dim(' · ')
const numSeg = (t: string, title?: string): Seg => ({ t, c: 'num', title })


/**
 * A call in columns: CPU, rows, gets (consistent + current), physical reads, each in a column of its own (empty where it is 0, so the
 * columns stay in line), then what is worth a word: a hard parse, how the cursor was closed.
 */
function describeCall(c: CallLine): LineView {
  const gets = (c.cr ?? 0) + (c.cu ?? 0)
  const parts: Seg[] = []
  // the CPU only where it is not the whole duration (the duration column has that): the rest of the time went elsewhere
  if (c.c && (c.e === undefined || (fmtDur(c.c) !== fmtDur(c.e) && c.c < c.e))) parts.push(durQ('cpu', c.c, `c=${c.c} µs: CPU, of e=${c.e ?? '?'} µs`, 'cpu'))
  if (c.r !== undefined && (c.op === 'FETCH' || c.r > 0)) parts.push(countQ('rows', c.r, 'row', 'rows', 'r= rows processed'))
  if (gets > 0) parts.push(countQ('gets', gets, 'get', 'gets', `cr=${c.cr ?? 0} consistent, cu=${c.cu ?? 0} current`))
  if ((c.p ?? 0) > 0) parts.push(countQ('reads', c.p!, 'read', 'reads', 'p= physical reads'))
  if ((c.mis ?? 0) > 0) parts.push({ t: 'hard parse', c: 'hp', title: `mis=${c.mis}: a library cache miss` })
  if (c.op === 'CLOSE' && c.type !== undefined) parts.push(dim(CLOSE_TYPES[c.type] ?? `type ${c.type}`, `type=${c.type}`))
  return { label: c.op, tone: 'cpu', op: 'call', parts, dur: c.e, waited: waitShare(c.c, c.e), bar: c.e !== undefined ? { us: c.e, cpu: Math.min(c.e, c.c ?? 0), role: 'cpu' } : undefined }
}

function describeWait(w: WaitLine, ctx: ReadableContext): LineView {
  const ev = ctx.eventOf?.(w.nam)
  // the event, the object, the parameters: one run of text
  const parts: Seg[] = [{ t: w.nam, c: 'ev', title: `${w.nam}${ev?.class ? ` (wait class ${ev.class})` : ''}` }]
  // Oracle leaves the last object's obj# on every wait: only on I/O and concurrency waits is it the object waited on
  const onObject = !ev || /I\/O|Concurrency|Application|Cluster/.test(ev.class)
  const name = onObject && w.obj !== undefined && w.obj > 0 ? ctx.objectName?.(w.obj) ?? `obj# ${w.obj}` : ''
  if (name) parts.push({ t: name, c: 'evobj', title: `${name} (obj#=${w.obj})` })
  const ps = waitParamSegs(w.params)
  if (ps.length) parts.push({ t: '', c: 'pgap' }, ...(ps[0] === sep ? ps.slice(1) : ps))
  const role = ev?.role ?? 'other'
  return { label: w.cur === '0' ? 'WAIT #0' : 'WAIT', tone: 'userio', op: 'wait', dot: role, parts, dur: w.ela, bar: { us: w.ela, role } }
}

/** How the usual wait parameters read: a short label, or null to leave one out (it says nothing a reader needs). */
const PARAM_LABELS: Record<string, string | null> = {
  'file#': 'file', 'file number': 'file', 'block#': 'block', 'first dba': 'block', 'blocks': 'blocks', 'block cnt': 'blocks',
  'driver id': null, '#bytes': 'bytes', 'p1': null, 'p2': null, 'p3': null, 'outstanding #aio': 'outstanding aio',
  'current aio limit': 'aio limit', 'new aio limit': 'new aio limit', 'FileOperation': 'operation', 'fileno': 'file', 'filetype': 'file type',
  'sleeptime/senderid': null, 'passes': 'passes',
}

/** The parameters of a wait worth reading, labelled: `file 12 · block 169947 · 5 blocks`, `8,103 bytes`, `mode 6`; zeros are left out. */
function waitParamSegs(params: { label: string; value: string }[]): Seg[] {
  const out: Seg[] = []
  for (const p of params) {
    if (p.value === '' || p.value === '0') continue
    const raw = `${p.label}=${p.value}`
    const n = Number(p.value)
    if (p.label === 'name|mode' && Number.isFinite(n)) { out.push(sep, dim(`mode ${n & 0xffff}`, raw)); continue } // the enqueue's name is in the event's
    const label = p.label in PARAM_LABELS ? PARAM_LABELS[p.label] : p.label
    if (label === null) continue
    const num = Number.isFinite(n) && /^\d+$/.test(p.value)
    if (label === 'blocks' || label === 'bytes') out.push(sep, numSeg(fmtInt(n), raw), dim(` ${n === 1 ? label.slice(0, -1) : label}`))
    else out.push(sep, dim(`${label} `), numSeg(num && label !== 'block' && label !== 'file' ? fmtInt(n) : p.value, raw))
  }
  return out
}

/** Whether the rows per start are 10× or more away from the estimate. */
function estimateOff(s: StatLine): boolean {
  if (s.card === undefined) return false
  const ratio = Math.max(s.cnt / Math.max(1, s.str ?? 1), 1) / Math.max(s.card, 1)
  return ratio >= 10 || ratio <= 0.1
}

function describeStat(s: StatLine, line: number, ctx: ReadableContext): LineView {
  const pc = ctx.planAt?.(line)
  const name = s.obj > 0 ? s.name ?? ctx.objectName?.(s.obj) ?? `obj# ${s.obj}` : undefined
  return {
    label: 'PLAN', tone: 'commit', op: 'struct', parts: [],
    plan: {
      id: s.id, pid: s.pid, depth: pc?.depth ?? 0, op: s.op, name, obj: s.obj,
      starts: s.str, eRows: s.card, aRows: s.cnt, cost: s.cost, time: s.time, self: pc?.self, root: pc?.root,
      cr: s.cr, pr: s.pr, pw: s.pw, off: estimateOff(s),
    },
  }
}

/** The value of a bind as one short chip: NULL, the value, or what the trace printed instead. */
export function bindChip(b: BindRow): string {
  if (b.isNull) return 'NULL'
  if (b.noDef) return '(same as before)'
  if (b.dump) return '(dump)'
  const v = b.typed || b.value
  return v === '' ? '(no value)' : v.length > 40 ? v.slice(0, 39) + '…' : v
}

function describeBinds(text: string, kind: LineKind, line: number, ctx: ReadableContext): LineView {
  const at = ctx.bindsAt?.(line)
  if (kind === 'binds' && at?.header) {
    // the head of the table of binds (each Bind# line below is a row of it)
    if (at.binds.length === 0) return { label: 'BINDS', tone: 'network', op: 'struct', parts: [dim('no binds')] }
    return { label: 'BINDS', tone: 'network', op: 'struct', parts: [], asRun: true, bindHead: true }
  }
  if (kind === 'binds') return { label: 'BINDS', tone: 'network', op: 'struct', parts: [dim(text)] }
  const m = /^\s*Bind#(\d+)/.exec(text)
  if (m && at?.bind) {
    const names = at.sql !== undefined ? bindNames(at.sql, at.binds.length).names : []
    const b = at.bind
    const type = b.type || (at.dty !== undefined ? BIND_TYPE_NAMES[at.dty] : '') || ''
    const value = bindChip(b)
    const full = b.isNull || b.noDef || b.dump ? value : b.typed || b.value
    const bindRow: BindCellRow = {
      pos: b.pos, name: `:${names[b.pos] ?? b.pos}`, value, type, none: b.isNull || b.noDef || b.dump,
      last: b.pos === at.binds[at.binds.length - 1]?.pos,
      title: `Bind#${b.pos}${type ? ` ${type}` : ''}: ${full}${b.typed && b.typed !== b.value ? `\nas printed: ${b.value}` : ''}\n(the type, length and character set: the Line tab, i)`,
    }
    return { label: 'Bind#' + m[1], tone: 'network', op: 'struct', parts: [{ t: bindRow.name, c: 'name' }, ' = ', { t: value, c: b.isNull ? 'dim' : 'val' }, ...(type ? [dim(`  ${type}`)] : [])], bindRow }
  }
  if (m) return { label: 'Bind#' + m[1], tone: 'network', op: 'struct', parts: [dim(text.trim())] }
  return { label: '', tone: 'dim', parts: bindAttrSegs(text), indent: 1 }
}

/**
 * The attribute lines under a `Bind#`, decoded: `oacdty=02 mxl=22(22) … scl=00 pre=00` → "NUMBER, up to 22 bytes";
 * `oacflg=… frm=01 csi=873` → its character set; `kxsbbbfp=… bln=22 avl=02` → "value length 2 of 22"; `value=…` → the value as
 * printed. Anything else stays as written, dimmed. The raw line is each piece's tooltip.
 */
export function bindAttrSegs(text: string): Seg[] {
  const t = text.trim(), p = pairs(t)
  if (t.startsWith('oacdty=')) {
    const dty = Number(p.get('oacdty')), mxl = Number(/^(\d+)/.exec(p.get('mxl') ?? '')?.[1] ?? NaN)
    const pre = Number(p.get('pre') ?? 0), scl = Number(p.get('scl') ?? 0)
    const out: Seg[] = [dim('type '), { t: BIND_TYPE_NAMES[dty] ?? `oacdty ${dty}`, c: 'val', title: t }]
    if (Number.isFinite(mxl)) out.push(dim(`, up to ${fmtInt(mxl)} bytes`))
    if (pre || scl) out.push(dim(`, precision ${pre}, scale ${scl}`))
    return out
  }
  if (t.startsWith('oacflg=')) {
    const csi = Number(p.get('csi') ?? 0), frm = Number(p.get('frm') ?? 0)
    if (!csi && !frm) return [dim('no character set (not a character type)', t)]
    return [dim('character set '), { t: CHARSET_NAMES[csi] ?? `csi ${csi}`, c: 'val', title: t }, ...(frm ? [dim(` · ${FORM_NAMES[frm] ?? `form ${frm}`}`)] : [])]
  }
  if (t.startsWith('kxsbbbfp=')) {
    const avl = Number(p.get('avl') ?? NaN), bln = Number(p.get('bln') ?? NaN)
    if (avl === 0) return [dim('no value: length 0 (NULL)', t)]
    return [dim('value length '), { t: Number.isFinite(avl) ? fmtInt(avl) : '?', c: 'val', title: t }, ...(Number.isFinite(bln) ? [dim(` of a ${fmtInt(bln)}-byte buffer`)] : [])]
  }
  const v = /^value=(.*)$/.exec(t)
  if (v) return [dim('as printed: '), { t: v[1], c: 'val', title: t }]
  if (t === 'No oacdef for this bind.' || t.startsWith('No oacdef')) return [dim('no definition of its own: the same placeholder as an earlier bind', t)]
  return [dim(t)]
}

/** `***` lines: the session markers by name, the timestamps as a clock time. */
const MARKERS: [RegExp, string][] = [
  [/^SESSION ID:\((.*?)\)/, 'SESSION'], [/^CLIENT ID:\((.*?)\)/, 'CLIENT'], [/^SERVICE NAME:\((.*?)\)/, 'SERVICE'],
  [/^MODULE NAME:\((.*?)\)/, 'MODULE'], [/^ACTION NAME:\((.*?)\)/, 'ACTION'], [/^CLIENT DRIVER:\((.*?)\)/, 'DRIVER'],
  [/^CONTAINER ID:\((.*?)\)/, 'CONTAINER'],
]
const ISO_RE = /(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d{3})(\d{0,3})\d*)?([+-]\d{2}:\d{2}|Z)?/

export function describeMarker(text: string): LineView {
  const t = text.replace(/^\*{3}\s*/, '')
  const ts = ISO_RE.exec(t)
  // the time goes to the clock column, where every other line has its time
  const wall = ts ? { clock: `${ts[2]}${ts[3] ? `.${ts[3]}` : ''}`, micros: (ts[4] ?? '').padEnd(ts[3] && ts[4] ? 3 : 0, '0'), title: ts[0] } : undefined
  for (const [re, label] of MARKERS) {
    const m = re.exec(t)
    if (m) return { label, tone: 'dim', op: 'mark', parts: [{ t: m[1] || '(none)', c: 'name' }], wall }
  }
  if (ts && ts.index === 0) { // the timestamp line: `*** 2026-10-22T11:35:03.510078+00:00 (PDB1(3))`
    const rest = t.slice(ts[0].length).trim().replace(/^\((.*)\)$/, '$1')
    return { label: 'TIME', tone: 'dim', op: 'mark', parts: [{ t: ts[1], c: 'val', title: ts[0] }, ...(ts[5] ? [dim(` UTC${ts[5] === 'Z' ? '' : ts[5]}`)] : []), ...(rest ? [sep, dim(rest)] : [])], wall }
  }
  return { label: '***', tone: 'dim', op: 'mark', parts: [dim(t)] }
}

/** SQL keywords that get the keyword colour in the statement's text. */
const SQL_KW = new Set(('select from where and or not in is null as on join left right inner outer full cross group by order having union all ' +
  'intersect minus insert into values update set delete merge using when matched then else end case begin declare exception ' +
  'create alter drop table index view with distinct exists between like escape asc desc nulls first last fetch next rows only ' +
  'offset for return returning commit rollback grant execute procedure function package body cursor loop if elsif while ' +
  'connect start prior partition over count sum min max avg nvl decode cast to_date to_char to_number sysdate rownum level').split(' '))

/** One line of SQL text in pieces: keywords, string literals, comments, binds and the rest (a line, not a statement: a comment or string opened on an earlier line is not known). */
export function sqlSegs(text: string): Seg[] {
  const out: Seg[] = []
  const re = /(--.*$|\/\*.*?(?:\*\/|$))|('(?:[^']|'')*'?)|(:[A-Za-z_][\w$#]*|:\d+)|([A-Za-z_][\w$#]*)|(\s+|[^\sA-Za-z_':\-\/]+|.)/g
  let plain = ''
  const flush = () => { if (plain) { out.push(plain); plain = '' } }
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1]) { flush(); out.push({ t: m[1], c: 'cmt' }) }
    else if (m[2]) { flush(); out.push({ t: m[2], c: 'str' }) }
    else if (m[3]) { flush(); out.push({ t: m[3], c: 'bind' }) }
    else if (m[4] && SQL_KW.has(m[4].toLowerCase())) { flush(); out.push({ t: m[4], c: 'kw' }) }
    else plain += m[0]
  }
  flush()
  return out.length ? out : [text]
}

/** A line of the trace file's header: `Key: value` with the key dimmed. */
function describeHeader(text: string): LineView {
  const m = /^([A-Za-z][\w .]*?):\s+(.*)$/.exec(text)
  if (m) return { label: '', tone: 'dim', parts: [{ t: m[1], c: 'key' }, { t: m[2], c: 'val' }] }
  const f = /^Trace file (.*)$/.exec(text)
  if (f) return { label: 'FILE', tone: 'dim', parts: [{ t: f[1], c: 'name' }] }
  return { label: '', tone: 'dim', parts: [dim(text)] }
}

function describeParsing(text: string, ctx: ReadableContext): LineView {
  const p = pairs(text)
  const parts: Seg[] = [{ t: p.get('sqlid') ?? '', c: 'name' }]
  const oct = num(p, 'oct'), uid = num(p, 'uid'), dep = num(p, 'dep')
  if (oct !== undefined) parts.push(sep, dim(COMMAND_NAMES[oct] ?? `oct ${oct}`))
  if (uid !== undefined) parts.push(sep, dim(`user ${ctx.userName?.(uid) ?? uid}`, `uid=${uid}`))
  if (dep) parts.push(sep, dim(`depth ${dep}`, 'dep=: a recursive statement'))
  return { label: 'CURSOR', tone: 'sysio', op: 'call', parts }
}

/** The readable row of one trace line (`line` resolves BINDS and STAT lines through the context). */
export function describeLine(text: string, kind: LineKind, line: number, ctx: ReadableContext = {}): LineView {
  switch (kind) {
    case 'call': { const c = parseCall(text); if (c) return describeCall(c); break }
    case 'wait': { const w = parseWait(text); if (w) return describeWait(w, ctx); break }
    case 'stat': { const s = parseStat(text); if (s) return describeStat(s, line, ctx); break }
    case 'binds': case 'bind-line': return describeBinds(text, kind, line, ctx)
    case 'parsing-in-cursor': return describeParsing(text, ctx)
    case 'sql-text': return { label: '', tone: '', parts: sqlSegs(text) }
    case 'separator': return { label: '', tone: 'dim', parts: [{ t: '', c: 'rule' }] }
    case 'header': return describeHeader(text)
    case 'end-of-stmt': return { label: '', tone: 'dim', parts: [dim('end of statement')] }
    case 'xctend': {
      const p = pairs(text)
      const rb = num(p, 'rlbk') === 1, ro = num(p, 'rd_only') === 1
      return { label: rb ? 'ROLLBACK' : 'COMMIT', tone: 'commit', op: 'call', parts: [dim(ro ? 'read only: nothing was changed' : rb ? 'transaction rolled back' : 'transaction committed')] }
    }
    case 'marker': return describeMarker(text)
    case 'error': case 'parse-error': return { label: 'ERROR', tone: 'error', parts: [{ t: text, c: 'warn' }] }
    case 'lob': case 'rpc': return { label: kind.toUpperCase(), tone: 'other', parts: [text] }
  }
  return { label: '', tone: 'dim', parts: [dim(text)] }
}

// ---- plan dumps ------------------------------------------------------------------------------------------------------------

/** How far a plan dump is followed up and down from a line (a plan of more lines shows no depth). */
const MAX_PLAN = 2000

/**
 * The plan cells of the STAT dump around `line` (its depth, own time, the root's time), keyed by line; empty when the line is not a
 * STAT line or the dump runs into a page that is not loaded.
 */
export function planDump(lineAt: (n: number) => { text: string; kind: LineKind } | undefined, line: number): Map<number, PlanCell> {
  const out = new Map<number, PlanCell>()
  const first = lineAt(line)
  const cur = first?.kind === 'stat' ? /^STAT\s+#(\d+)\s/.exec(first.text)?.[1] : undefined
  if (!cur) return out
  const prefix = `STAT #${cur} `
  const inDump = (n: number) => { const l = lineAt(n); return l === undefined ? undefined : l.kind === 'stat' && l.text.startsWith(prefix) }
  let from = line, to = line
  for (let i = 0; i < MAX_PLAN; i++) { const x = inDump(from - 1); if (x === undefined && from > 1) return out; if (!x) break; from-- }
  for (let i = 0; i < MAX_PLAN; i++) { const x = inDump(to + 1); if (!x) break; to++ }
  const rows: { n: number; s: StatLine }[] = []
  for (let n = from; n <= to; n++) { const s = parseStat(lineAt(n)!.text); if (s) rows.push({ n, s }) }
  const depth = new Map<number, number>(), kids = new Map<number, number>()
  for (const { s } of rows) {
    depth.set(s.id, s.pid === 0 || !depth.has(s.pid) ? 0 : depth.get(s.pid)! + 1)
    kids.set(s.pid, (kids.get(s.pid) ?? 0) + (s.time ?? 0))
  }
  const root = rows.find((r) => r.s.pid === 0)?.s.time ?? rows[0]?.s.time ?? 0
  for (const { n, s } of rows) out.set(n, { depth: depth.get(s.id) ?? 0, self: Math.max(0, (s.time ?? 0) - (kids.get(s.id) ?? 0)), root })
  return out
}

// ---- statement colours -----------------------------------------------------------------------------------------------------

/** The neutral tone of recursive SYS statements and of statements past the categorical colours. */
export const QUIET_TONE: Tone = { token: '--c-idle', shade: 0 }

/**
 * Each statement's lane colour: the statements ranked by elapsed time take the categorical colours in that order (the ones that
 * matter most get the clearest hues); recursive SYS SQL (parsed by uid 0 below the top level) stays neutral, and so does every
 * statement past `MAX_CATEGORIES`.
 */
export function statementTones(stmts: readonly { id: number; parsingUserId: number; minDepth: number }[], elapsed: (id: number) => number): Map<number, Tone> {
  const out = new Map<number, Tone>()
  const ranked = stmts.filter((s) => !(s.parsingUserId === 0 && s.minDepth > 0)).sort((a, b) => elapsed(b.id) - elapsed(a.id) || a.id - b.id)
  ranked.forEach((s, k) => out.set(s.id, k < MAX_CATEGORIES ? categoryTone(k) : QUIET_TONE))
  return out
}

/** The CSS colour of a tone: the token, mixed towards the surface for the shaded second round. */
export function toneColor(t: Tone): string {
  return t.shade === 0 ? `var(${t.token})` : `color-mix(in oklch, var(${t.token}) ${100 - 35 * t.shade}%, var(--surface-raised))`
}

