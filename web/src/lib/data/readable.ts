// The readable mode of the Lines view: each trace line parsed and laid out as columns (what it is, its detail, its time), the lines of
// one cursor joined into a lane in the statement's colour. Pure: the view feeds it the cached lines (see views/readableRows.ts).
import { MAX_CATEGORIES, categoryTone, type Tone } from './blocklayout'
import { BIND_TYPE_NAMES } from './bindat'
import { bindNames } from './bindsql'
import type { BindRow } from './derive'
import { fmtCompact, fmtDur, fmtInt } from './format'
import { CLOSE_TYPES, COMMAND_NAMES } from './linefields'
import type { LineKind } from './lines'
import type { Role } from '../components/colors'

/** A piece of a row's detail: plain text, or text with a class (`rd-<c>`) and a tooltip. */
export type Seg = string | { t: string; c: string; title?: string }

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
  /** a plan line: its depth in the plan (the operation is indented by it) */
  depth?: number
}

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

const dim = (t: string, title?: string): Seg => ({ t, c: 'dim', title })
const sep: Seg = dim(' · ')
const numSeg = (t: string, title?: string): Seg => ({ t, c: 'num', title })

/** `n label` when n is set and not 0 (`always`: also 0). */
function qty(out: Seg[], n: number | undefined, label: string, title: string, always = false) {
  if (n === undefined || (n === 0 && !always)) return
  out.push(sep, numSeg(fmtInt(n)), dim(` ${label}`, title))
}

function describeCall(c: CallLine): LineView {
  const parts: Seg[] = [numSeg(fmtDur(c.e ?? 0), `e=${c.e ?? 0} µs elapsed`)]
  if (c.c) parts.push(sep, dim('cpu '), numSeg(fmtDur(c.c), `c=${c.c} µs`))
  qty(parts, c.r, c.r === 1 ? 'row' : 'rows', 'r= rows processed', c.op === 'FETCH' || (c.op === 'EXEC' && (c.r ?? 0) > 0))
  qty(parts, (c.cr ?? 0) + (c.cu ?? 0) || undefined, 'gets', `cr=${c.cr ?? 0} consistent, cu=${c.cu ?? 0} current`)
  qty(parts, c.p, 'reads', 'p= physical reads')
  if ((c.mis ?? 0) > 0) parts.push(sep, { t: 'hard parse', c: 'warn', title: `mis=${c.mis}: a library cache miss` })
  if (c.op === 'CLOSE' && c.type !== undefined) parts.push(sep, dim(CLOSE_TYPES[c.type] ?? `type ${c.type}`, `type=${c.type}`))
  return { label: c.op, tone: 'cpu', parts, bar: c.e !== undefined ? { us: c.e, cpu: Math.min(c.e, c.c ?? 0), role: 'cpu' } : undefined }
}

function describeWait(w: WaitLine, ctx: ReadableContext): LineView {
  const ev = ctx.eventOf?.(w.nam)
  const parts: Seg[] = [numSeg(fmtDur(w.ela), `ela=${w.ela} µs`), sep, { t: w.nam, c: 'name', title: ev?.class ? `wait class ${ev.class}` : undefined }]
  // Oracle leaves the last object's obj# on every wait: only on I/O and concurrency waits is it the object waited on
  const onObject = !ev || /I\/O|Concurrency|Application|Cluster/.test(ev.class)
  if (onObject && w.obj !== undefined && w.obj > 0) {
    const name = ctx.objectName?.(w.obj)
    parts.push(sep, { t: name ?? `obj# ${w.obj}`, c: 'obj', title: `obj#=${w.obj}` })
  }
  const shown = w.params.filter((p) => p.value !== '' && p.value !== '0')
  if (shown.length) parts.push(sep, dim(shown.map((p) => `${p.label} ${p.value}`).join('  ')))
  return { label: w.cur === '0' ? 'WAIT #0' : 'WAIT', tone: 'userio', parts, bar: { us: w.ela, role: ev?.role ?? 'other' } }
}

/** A row count and its estimate: the estimate is per start, the count over all starts; 10× or more apart is flagged. */
function rowsVsEstimate(s: StatLine): Seg[] {
  const out: Seg[] = [sep, numSeg(fmtCompact(s.cnt)), dim(s.cnt === 1 ? ' row' : ' rows', `cnt=${s.cnt}: rows produced (A-Rows)`)]
  if (s.card !== undefined) {
    const per = s.cnt / Math.max(1, s.str ?? 1)
    const off = Math.max(per, 1) / Math.max(s.card, 1)
    const bad = off >= 10 || off <= 0.1
    out.push(bad ? { t: ` est ${fmtCompact(s.card)}`, c: 'warn', title: `card=${s.card}: the optimizer expected ${fmtInt(s.card)} rows per start, ${fmtInt(Math.round(per))} came` } : dim(` est ${fmtCompact(s.card)}`, `card=${s.card}: estimated rows per start (E-Rows)`))
  }
  return out
}

function describeStat(s: StatLine, line: number, ctx: ReadableContext): LineView {
  const pc = ctx.planAt?.(line)
  const name = s.obj > 0 ? s.name ?? ctx.objectName?.(s.obj) ?? `obj# ${s.obj}` : undefined
  const parts: Seg[] = [{ t: String(s.id).padStart(3), c: 'dim', title: `id=${s.id} pid=${s.pid}` }, ' ', '  '.repeat(pc?.depth ?? 0), { t: s.op, c: 'op' }]
  if (name) parts.push(' ', { t: name, c: 'obj', title: `obj=${s.obj}` })
  if ((s.str ?? 1) > 1) parts.push(sep, numSeg(fmtCompact(s.str!)), dim(' starts', 'str= times the operation started'))
  parts.push(...rowsVsEstimate(s))
  if (s.time !== undefined) parts.push(sep, numSeg(fmtDur(s.time), `time=${s.time} µs, this operation and its children` + (pc ? `; ${fmtDur(pc.self)} its own` : '')))
  if (s.cost !== undefined) parts.push(sep, dim(`cost ${fmtCompact(s.cost)}`))
  qty(parts, s.cr, 'gets', 'cr= consistent reads')
  qty(parts, s.pr, 'reads', 'pr= physical reads')
  qty(parts, s.pw, 'writes', 'pw= physical writes')
  return { label: 'PLAN', tone: 'commit', parts, depth: pc?.depth }
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
    const names = at.sql !== undefined ? bindNames(at.sql, at.binds.length).names : []
    const parts: Seg[] = []
    at.binds.slice(0, 6).forEach((b, i) => {
      if (i) parts.push('  ')
      parts.push({ t: `:${names[b.pos] ?? b.pos} = ${bindChip(b)}`, c: 'chip', title: `Bind#${b.pos}${b.type ? ` ${b.type}` : ''}` })
    })
    if (at.binds.length > 6) parts.push(dim(`  +${at.binds.length - 6} more`))
    if (at.binds.length === 0) parts.push(dim('no binds'))
    return { label: 'BINDS', tone: 'network', parts, asRun: at.binds.length > 0 }
  }
  if (kind === 'binds') return { label: 'BINDS', tone: 'network', parts: [dim(text)] }
  const m = /^\s*Bind#(\d+)/.exec(text)
  if (m && at?.bind) {
    const names = at.sql !== undefined ? bindNames(at.sql, at.binds.length).names : []
    const b = at.bind
    const type = b.type || (at.dty !== undefined ? BIND_TYPE_NAMES[at.dty] : '') || ''
    return { label: 'Bind#' + m[1], tone: 'network', parts: [{ t: `:${names[b.pos] ?? b.pos}`, c: 'name' }, ' = ', { t: bindChip(b), c: b.isNull ? 'dim' : 'val' }, ...(type ? [dim(`  ${type}`)] : [])] }
  }
  if (m) return { label: 'Bind#' + m[1], tone: 'network', parts: [dim(text.trim())] }
  return { label: '', tone: 'dim', parts: [dim(text.trim())] }
}

function describeParsing(text: string, ctx: ReadableContext): LineView {
  const p = pairs(text)
  const parts: Seg[] = [{ t: p.get('sqlid') ?? '', c: 'name' }]
  const oct = num(p, 'oct'), uid = num(p, 'uid'), dep = num(p, 'dep')
  if (oct !== undefined) parts.push(sep, dim(COMMAND_NAMES[oct] ?? `oct ${oct}`))
  if (uid !== undefined) parts.push(sep, dim(`user ${ctx.userName?.(uid) ?? uid}`, `uid=${uid}`))
  if (dep) parts.push(sep, dim(`depth ${dep}`, 'dep=: a recursive statement'))
  return { label: 'CURSOR', tone: 'sysio', parts }
}

/** The readable row of one trace line (`line` resolves BINDS and STAT lines through the context). */
export function describeLine(text: string, kind: LineKind, line: number, ctx: ReadableContext = {}): LineView {
  switch (kind) {
    case 'call': { const c = parseCall(text); if (c) return describeCall(c); break }
    case 'wait': { const w = parseWait(text); if (w) return describeWait(w, ctx); break }
    case 'stat': { const s = parseStat(text); if (s) return describeStat(s, line, ctx); break }
    case 'binds': case 'bind-line': return describeBinds(text, kind, line, ctx)
    case 'parsing-in-cursor': return describeParsing(text, ctx)
    case 'sql-text': return { label: '', tone: '', parts: [{ t: text, c: 'sql' }] }
    case 'end-of-stmt': return { label: '', tone: 'dim', parts: [dim('end of statement')] }
    case 'xctend': {
      const p = pairs(text)
      const rb = num(p, 'rlbk') === 1, ro = num(p, 'rd_only') === 1
      return { label: rb ? 'ROLLBACK' : 'COMMIT', tone: 'commit', parts: [dim(ro ? 'read only: nothing was changed' : rb ? 'transaction rolled back' : 'transaction committed')] }
    }
    case 'marker': return { label: '***', tone: 'dim', parts: [dim(text.replace(/^\*{3}\s*/, ''))] }
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

