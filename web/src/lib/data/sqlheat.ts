// SQL heat (views/SqlHeat.tsx): a plan dump's self time painted back onto the statement's text. Developers read SQL, the
// trace speaks in plan lines: each fragment of the text (a FROM item with its own predicates, a join condition, ORDER BY,
// GROUP BY, …) gets the share of the plan's self time of the lines that belong to it; lines that fit nowhere are "not
// placed", so the shares add up to 100 %.
//
// The text shown is formatSql's (optsql.ts, which a Go port is pinned to: not changed here). The parse reads sqlTokens of
// the original text; offsets reach the formatted lines through the non-blank characters, which formatSql keeps in order
// (it only re-spaces and upper-cases clause words). Self time is Row flow's (rowflow.ts). Pure functions, no DOM; the
// rules are unit-tested in sqlheat.test.ts. `sqlHeat` never throws: what it cannot read comes back as a fallback with a
// note, and the view shows the plan table.
import type { TraceDoc } from './doc'
import { CallKind, type ID, type Plan, type PlanLine } from './types'
import type { ExecTrace } from './exectrace'
import { formatSql, sqlTokens, type SqlTokenType } from './optsql'
import { opText, rowFlow, type FlowNode, type RowFlow } from './rowflow'
import { fmtDur } from './format'

// ---- the result

/** A recursive statement run under this one (`StmtStats.children`), for the ≈ callout on a function of the text. */
export interface HeatChild {
  statement: ID
  /** its executions under this statement */
  executions: number
  /** its elapsed time under this statement, µs */
  elapsedUs: number
  /** false: the executions under this statement are estimated (it runs under several statements and the document has no call facts) */
  exact: boolean
}

/**
 * The executions a STAT dump covers and their time, which the plan lines are compared with. A dump's numbers add up the
 * executions its main row source started (1 for a first-execution or per-execution dump); they are the last ones of the
 * dump's cursor before it (Replay's rule, `planOfExecution`, read backwards).
 */
export interface HeatCover {
  /** how many executions the dump adds up */
  executions: number
  /** the cursor's execution number of the first of them (1: the cursor's first); 0 = averaged, no particular one */
  execNo: number
  /** elapsed of their EXEC and FETCH calls, recursive SQL under them included, µs (the Executions table's Elapsed) */
  elapsedUs: number
  /** elapsed of the recursive statements that are not dictionary SQL, directly under those calls, µs */
  recursiveUs: number
  /** false: the statement's per-execution averages (the document has no call facts) */
  exact: boolean
}

export interface HeatInput {
  text: string
  /** one STAT dump in dump order */
  lines: readonly PlanLine[]
  /** the statement's executions (the denominator of "times per execution") */
  executions: number
  /** recursive statements run under it that are not dictionary SQL, the slowest first */
  children?: readonly HeatChild[]
  /** the executions the dump covers; absent: the shares stay of the plan lines' time, with no comparison */
  cover?: HeatCover | null
}

/** One plan line of a group: its self time and self buffer gets (cr minus its children's). */
export interface HeatPart { id: number; op: string; selfUs: number; selfCr: number; clamped: boolean }

export interface HeatGroup {
  /** the fragment: "MTK_CUST c", "join condition", "ORDER BY", "outside the plan: recursive SQL", … */
  what: string
  /** its plan lines, by id (none for recursive SQL outside the plan) */
  parts: HeatPart[]
  /** its time, µs: the plan lines' self time, or the recursive SQL's elapsed */
  selfUs: number
  /** of `HeatOk.totalUs` */
  share: number
  /** recursive SQL outside the plan, tinted on the function call it is taken to run in */
  recursive?: { fn: string; statement: ID }
  /** why the match is inferred (≈); empty: exact */
  approx: string[]
  /** the formatted lines its fragments touch */
  firstLine: number
  lastLine: number
}

/** A run of one formatted line; `group` indexes `groups`, -1 = no plan line. */
export interface HeatSeg { text: string; group: number }

/** "≈ runs statement N K times per execution": a function of the text and the recursive statement it is taken to run. */
export interface HeatCallout {
  /** formatted line and column of the call */
  line: number
  col: number
  fn: string
  child: HeatChild
  /** child.executions over the statement's executions; 0 = unknown */
  perExec: number
  /** further recursive statements not named */
  others: number
}

export interface HeatOk {
  ok: true
  /** the formatted text, one array of runs per line */
  lines: HeatSeg[][]
  /** by time, largest first */
  groups: HeatGroup[]
  /** plan lines the text has no place for */
  unplaced: { parts: HeatPart[]; selfUs: number; share: number }
  /** Σ self time of the plan lines */
  planUs: number
  /**
   * What the shares are of. 'plan': the plan lines' self time (`planUs`), which holds the recursive SQL a plan line runs.
   * 'calls': recursive SQL runs outside the plan lines, so the shares are of the covered executions' EXEC and FETCH time.
   */
  basis: 'plan' | 'calls'
  /** the denominator of every share, µs */
  totalUs: number
  /** the executions the dump covers, null = unknown (no comparison) */
  cover: HeatCover | null
  /** recursive SQL that cannot sit in the plan lines; `group` its index in `groups` (tinted on the call), -1 = not in the text */
  outside: { us: number; share: number; group: number; why: string } | null
  /** basis 'calls': the covered calls' time in no plan line and no recursive SQL */
  rest: { us: number; share: number } | null
  /** what the plan lines account for, and what the shares are of: sentences for the view */
  account: string[]
  callouts: HeatCallout[]
  /** Row flow's notes on the dump (clamped self times, left-out lines) */
  notes: string[]
}

export type HeatWhy = 'empty' | 'nostats' | 'notime' | 'plsql' | 'dml' | 'other' | 'parse'
export interface HeatFallback { ok: false; why: HeatWhy; note: string }
export type SqlHeat = HeatOk | HeatFallback

/** A group below this share gets no tint and no margin bar (its numbers stay in the mapping lines). */
export const HEAT_MIN_SHARE = 0.01

/** The tint strength in percent for a share: 0 below `HEAT_MIN_SHARE`, else 8 % to 55 %. */
export function heatTint(share: number): number {
  return share < HEAT_MIN_SHARE ? 0 : 8 + 47 * Math.min(1, share)
}

const FALLBACK_NOTES: Record<HeatWhy, string> = {
  empty: 'This plan dump has no lines.',
  nostats: 'No row-source statistics in this plan dump: SQL heat needs a time per plan line, so the table shows instead.',
  notime: 'The row-source statistics of this dump report no time on any line: nothing to paint, so the table shows instead.',
  plsql: 'SQL heat reads queries; this statement is a PL/SQL block, so the table shows instead.',
  dml: 'SQL heat reads queries (SELECT and WITH), so the table shows instead.',
  other: 'SQL heat reads queries (SELECT and WITH); this statement is not one, so the table shows instead.',
  parse: 'SQL heat could not read the text of this statement, so the table shows instead.',
}

function fallback(why: HeatWhy, kind = ''): HeatFallback {
  const note = why === 'dml' && kind ? `SQL heat reads queries (SELECT and WITH); this statement is ${/^[AEIOU]/.test(kind) ? 'an' : 'a'} ${kind}, so the table shows instead.` : FALLBACK_NOTES[why]
  return { ok: false, why, note }
}

// ---- the parse: query blocks, FROM items, conjuncts, clauses

type Span = [number, number] // token indexes (significant tokens), end exclusive

interface Tok { t: SqlTokenType; v: string; a: number; b: number }

interface Paren {
  open: number
  close: number
  /** where the query sits: an inline view, a predicate's subquery, a select list's scalar subquery, a WITH query, an operand of a set operation */
  kind: 'from' | 'where' | 'select' | 'cte' | 'set' | 'other'
  /** the block it sits in (null: a WITH query, or an operand at the top) */
  outer: Block | null
  blocks: Block[]
  /** an inline view's alias, -1 */
  alias: number
  /** the FROM item it is (an inline view) */
  item: Item | null
  cte: string
}

interface Block {
  /** 1-based position of its SELECT in the text (DBMS_XPLAN's SEL$n before query transformations rename it) */
  n: number
  sel: number
  end: number
  depth: number
  parent: Block | null
  paren: Paren | null
  list: Span
  distinct: number
  items: Item[]
  conj: Conj[]
  /** order, group, having, connect, start, fetch, offset, update: from the keyword to the clause's end */
  clause: Map<string, Span>
  setOp: Span | null
  aggs: Span[]
  overs: Span[]
  /** ROWNUM in the select list */
  rownums: number[]
}

interface Item {
  idx: number
  block: Block
  /** table, view or WITH query name: upper case unless quoted; '' for an inline view or a table function */
  name: string
  alias: string
  /** the name (or function) and the alias */
  span: Span
  /** the FROM keyword before the block's first item, -1 */
  fromKw: number
  view: Paren | null
  cte: Paren | null
  fn: boolean
  join: Join | null
}

interface Join { item: Item; kw: Span; cond: Span | null; using: boolean; refs: Set<Item>; unresolved: boolean; cols: Set<string> }

interface Conj {
  idx: number
  block: Block
  /** WHERE or AND before it */
  kw: number
  span: Span
  /** FROM items its columns name (outside its subqueries), this block's or an outer one's */
  refs: Set<Item>
  /** subqueries in it */
  nested: Paren[]
  /** a column the parse cannot give to one FROM item (unqualified in a block of several) */
  unresolved: boolean
  rownum: boolean
  /** the column names it uses (upper case), for matching the predicates of a ref bundle */
  cols: Set<string>
}

interface FnCall { name: string; at: number; end: number }

interface Parsed {
  toks: Tok[]
  blocks: Block[]
  items: Item[]
  conjs: Conj[]
  joins: Join[]
  parens: Paren[]
  queryAt: Map<number, Paren>
  /** calls of functions that are not Oracle built-ins, first occurrence of each */
  fns: FnCall[]
  /** every call of a function that is not an Oracle built-in */
  calls: FnCall[]
  withAt: number
}

const AGG = new Set(('COUNT SUM MIN MAX AVG STDDEV STDDEV_POP STDDEV_SAMP VARIANCE VAR_POP VAR_SAMP MEDIAN LISTAGG COLLECT CORR CORR_K CORR_S ' +
  'COVAR_POP COVAR_SAMP PERCENTILE_CONT PERCENTILE_DISC XMLAGG JSON_ARRAYAGG JSON_OBJECTAGG STATS_MODE GROUPING GROUPING_ID ANY_VALUE ' +
  'REGR_SLOPE REGR_INTERCEPT REGR_COUNT REGR_R2 REGR_AVGX REGR_AVGY REGR_SXX REGR_SYY REGR_SXY APPROX_COUNT_DISTINCT APPROX_COUNT ' +
  'APPROX_MEDIAN APPROX_PERCENTILE APPROX_SUM BIT_AND_AGG BIT_OR_AGG BIT_XOR_AGG KURTOSIS_POP KURTOSIS_SAMP SKEWNESS_POP SKEWNESS_SAMP').split(' '))
/** aggregates only with WITHIN GROUP, analytic with OVER */
const HYPOTHETICAL = new Set(['RANK', 'DENSE_RANK', 'CUME_DIST', 'PERCENT_RANK'])

const BUILTIN = new Set(('ABS ACOS ADD_MONTHS ASCII ASCIISTR ASIN ATAN ATAN2 BFILENAME BIN_TO_NUM BITAND CARDINALITY CAST CEIL CHARTOROWID CHR ' +
  'COALESCE COMPOSE CONCAT CONVERT COS COSH CUME_DIST CURRENT_DATE CURRENT_TIMESTAMP CV DECODE DECOMPOSE DENSE_RANK DEPTH DEREF DUMP EMPTY_BLOB ' +
  'EMPTY_CLOB EXISTSNODE EXP EXTRACT EXTRACTVALUE FIRST FIRST_VALUE FLOOR FROM_TZ GREATEST HEXTORAW INITCAP INSTR INSTRB INSTRC INSTR2 INSTR4 ' +
  'LAG LAST LAST_DAY LAST_VALUE LEAD LEAST LENGTH LENGTHB LENGTHC LENGTH2 LENGTH4 LN LNNVL LOCALTIMESTAMP LOG LOWER LPAD LTRIM MAKE_REF MOD ' +
  'MONTHS_BETWEEN NANVL NCHR NEW_TIME NEXT_DAY NTH_VALUE NTILE NULLIF NUMTODSINTERVAL NUMTOYMINTERVAL NVL NVL2 PATH PERCENT_RANK POWER ' +
  'POWERMULTISET PREDICTION PRESENTNNV PRESENTV PREVIOUS RANK RATIO_TO_REPORT RAWTOHEX RAWTONHEX REF REFTOHEX REMAINDER REPLACE ROUND ' +
  'ROW_NUMBER ROWIDTOCHAR ROWIDTONCHAR RPAD RTRIM SCN_TO_TIMESTAMP SESSIONTIMEZONE SET SIGN SIN SINH SOUNDEX SQRT STANDARD_HASH SUBSTR ' +
  'SUBSTRB SUBSTRC SUBSTR2 SUBSTR4 SYSDATE SYSTIMESTAMP TAN TANH TIMESTAMP_TO_SCN TRANSLATE TREAT TRIM TRUNC TZ_OFFSET UID UNISTR UPPER USER ' +
  'USERENV VALIDATE_CONVERSION VALUE VSIZE WIDTH_BUCKET DBTIMEZONE CONTAINS SCORE CATSEARCH ITERATION_NUMBER CLUSTER_ID FEATURE_ID ' +
  'LISTAGG CHAR_LENGTH OCTET_LENGTH COLLATION UNNEST').split(' '))
const BUILTIN_PREFIX = /^(SYS_|XML|JSON|REGEXP_|APPROX_|STATS_|TO_|NLS_|ORA_|BIT_|REGR_|CON_|PREDICTION_|CLUSTER_|FEATURE_|SDO_|ST_)/
const BUILTIN_PACKAGE = /^(DBMS_|UTL_|OWA|HTP$|HTF$|SYS$|PUBLIC$|STANDARD$|SDO_|CTX_|ORD|XMLTYPE$|APEX_)/
/** words a parenthesis can follow that are not calls: syntax and data types */
const NOT_CALL = new Set(('TABLE THE CURSOR MULTISET VALUES USING PARTITION SUBPARTITION SAMPLE SEED KEEP WITHIN OVER PIVOT UNPIVOT MATCH_RECOGNIZE ' +
  'MODEL DIMENSION MEASURES RULES ROLLUP CUBE SETS LATERAL IN EXISTS ANY ALL SOME AS ON NOT AND OR INTO SET SEARCH CYCLE DEFAULT PRIOR OF ' +
  'NUMBER VARCHAR2 VARCHAR CHAR NCHAR NVARCHAR2 RAW FLOAT DECIMAL DEC INTEGER INT NUMERIC TIMESTAMP INTERVAL DATE CLOB BLOB NCLOB ' +
  'BINARY_DOUBLE BINARY_FLOAT LONG UROWID ROWID WHERE FROM SELECT HAVING BY CASE WHEN THEN ELSE END ONLY CONTAINERS SHARDS ' +
  'XMLTABLE JSON_TABLE XMLNAMESPACES PASSING COLUMNS NESTED ORDINALITY RETURNING CONNECT_BY_ROOT').split(' '))
/** unqualified words in a predicate that are never columns: pseudocolumns */
const PSEUDO = new Set(('LEVEL ROWID SYSDATE SYSTIMESTAMP USER UID CURRENT_DATE CURRENT_TIMESTAMP LOCALTIMESTAMP DBTIMEZONE SESSIONTIMEZONE ' +
  'ORA_ROWSCN CONNECT_BY_ISLEAF CONNECT_BY_ISCYCLE CONNECT_BY_ROOT COLUMN_VALUE OBJECT_VALUE TRUE FALSE').split(' '))
/** words of SQL syntax (literals, casts, frames) that a column may also be called: no column of an unknown table in a block of several */
const SYNTAX = new Set(('DATE TIMESTAMP INTERVAL DAY MONTH YEAR HOUR MINUTE SECOND TO ESCAPE MEMBER OF SUBMULTISET EMPTY SET A INFINITE NAN ' +
  'LEADING TRAILING BOTH AT TIME ZONE LOCAL IGNORE RESPECT PRECEDING FOLLOWING UNBOUNDED CURRENT ROW RANGE GROUPS EXCLUDE TIES OTHERS ' +
  'OVERFLOW TRUNCATE ERROR WITHOUT COUNT COLLATE NUMBER VARCHAR2 VARCHAR CHAR NCHAR NVARCHAR2 RAW FLOAT DECIMAL INTEGER INT CLOB BLOB ' +
  'NCLOB BINARY_DOUBLE BINARY_FLOAT ROWS FORMAT JSON STRICT LAX WRAPPER UNCONDITIONAL CONDITIONAL ARRAY ABSENT ON EMPTY DOCUMENT CONTENT').split(' '))
/** words after a FROM item that end it rather than name its alias */
const ALIAS_STOP = new Set(('JOIN INNER LEFT RIGHT FULL CROSS NATURAL OUTER ON USING WHERE GROUP HAVING ORDER CONNECT START UNION INTERSECT ' +
  'MINUS EXCEPT FETCH OFFSET FOR MODEL PARTITION SUBPARTITION SAMPLE PIVOT UNPIVOT MATCH_RECOGNIZE APPLY WITH WINDOW AS VERSIONS').split(' '))

/** Parses the text, or tells why it cannot be heated. */
function parse(text: string): Parsed | { why: HeatWhy; kind: string } {
  const toks: Tok[] = []
  let off = 0
  for (const t of sqlTokens(text)) {
    if (t.t !== 'ws' && t.t !== 'cmt') toks.push({ t: t.t, v: t.v, a: off, b: off + t.v.length })
    off += t.v.length
  }
  while (toks.length && toks[toks.length - 1].t === 'p' && (toks[toks.length - 1].v === ';' || toks[toks.length - 1].v === '/')) toks.pop()
  const n = toks.length
  const isP = (i: number, c: string) => toks[i]?.t === 'p' && toks[i].v === c
  const U = (i: number) => { const t = toks[i]; return t && (t.t === 'word' || t.t === 'kw') ? t.v.toUpperCase() : '' }
  const wordy = (i: number) => { const t = toks[i]; return !!t && (t.t === 'word' || t.t === 'qid') }
  const ident = (i: number) => { const t = toks[i]; return t.t === 'qid' ? t.v.slice(1, -1) : t.v.toUpperCase() }

  const match = new Int32Array(n).fill(-1)
  const stack: number[] = []
  for (let i = 0; i < n; i++) {
    if (isP(i, '(')) stack.push(i)
    else if (isP(i, ')')) {
      const o = stack.pop()
      if (o === undefined) return { why: 'parse', kind: '' }
      match[o] = i
      match[i] = o
    }
  }
  if (stack.length) return { why: 'parse', kind: '' }

  let k0 = 0
  while (isP(k0, '(')) k0++
  const u0 = U(k0)
  if (u0 === 'WITH' && (U(k0 + 1) === 'FUNCTION' || U(k0 + 1) === 'PROCEDURE')) return { why: 'plsql', kind: '' }
  if (['BEGIN', 'DECLARE', 'CALL', 'EXEC', 'EXECUTE'].includes(u0)) return { why: 'plsql', kind: '' }
  if (['INSERT', 'UPDATE', 'DELETE', 'MERGE', 'UPSERT'].includes(u0)) return { why: 'dml', kind: u0 }
  if (u0 !== 'SELECT' && u0 !== 'WITH') return { why: 'other', kind: u0 }

  const blocks: Block[] = []
  const items: Item[] = []
  const conjs: Conj[] = []
  const joins: Join[] = []
  const parens: Paren[] = []
  const queryAt = new Map<number, Paren>()
  const ctes = new Map<string, Paren>()

  const isQueryStart = (j: number): boolean => U(j) === 'SELECT' || U(j) === 'WITH' || (isP(j, '(') && isQueryStart(j + 1))
  const newParen = (open: number, kind: Paren['kind'], outer: Block | null): Paren => {
    const p: Paren = { open, close: match[open], kind, outer, blocks: [], alias: -1, item: null, cte: '' }
    parens.push(p)
    queryAt.set(open, p)
    return p
  }
  const setOpAt = (i: number): number => {
    const u = U(i)
    if (u === 'UNION' || u === 'INTERSECT' || u === 'MINUS' || u === 'EXCEPT') return U(i + 1) === 'ALL' || U(i + 1) === 'DISTINCT' ? i + 2 : i + 1
    return -1
  }

  /** The query blocks of a query expression in [a, b): an optional WITH, blocks joined by set operators. */
  const queryExpr = (a: number, b: number, outer: Block | null, paren: Paren | null, depth: number): Block[] => {
    let i = a
    if (U(i) === 'WITH') i = withClause(i + 1, b, depth)
    const out: Block[] = []
    let op: Span | null = null
    while (i < b) {
      if (isP(i, '(') && isQueryStart(i + 1)) {
        const p = newParen(i, 'set', outer)
        p.blocks = queryExpr(i + 1, p.close, outer, p, depth)
        if (op && p.blocks[0]) p.blocks[0].setOp = op
        out.push(...p.blocks)
        i = p.close + 1
      } else if (U(i) === 'SELECT') {
        const blk = block(i, b, outer, paren, depth)
        blk.setOp = op
        out.push(blk)
        i = blk.end
      } else break
      op = null
      const e = setOpAt(i)
      if (e < 0) break
      op = [i, e]
      i = e
    }
    return out
  }

  /** WITH name [(columns)] AS (query) [SEARCH …] [CYCLE …], …: returns the index of the main query. */
  const withClause = (i: number, b: number, depth: number): number => {
    while (i < b && wordy(i)) {
      const name = ident(i)
      let j = i + 1
      if (isP(j, '(')) j = match[j] + 1
      if (U(j) !== 'AS') return j
      j++
      if (!isP(j, '(')) return j
      const p = newParen(j, 'cte', null)
      p.cte = name
      ctes.set(name, p)
      p.blocks = queryExpr(j + 1, p.close, null, p, depth + 1)
      j = p.close + 1
      while (j < b && !isP(j, ',') && U(j) !== 'SELECT' && !isP(j, '(')) j++
      if (!isP(j, ',')) return j
      i = j + 1
    }
    return i
  }

  type Mark = { k: string; at: number; body: number }
  /** A clause keyword at i: its name and where its body starts; 'setop' ends the block. */
  const clauseAt = (i: number): Mark | null => {
    const u = U(i)
    switch (u) {
      case 'FROM': case 'WHERE': case 'HAVING': return { k: u.toLowerCase(), at: i, body: i + 1 }
      case 'GROUP': return U(i + 1) === 'BY' ? { k: 'group', at: i, body: i + 2 } : null
      case 'ORDER':
        if (U(i + 1) === 'BY') return { k: 'order', at: i, body: i + 2 }
        return U(i + 1) === 'SIBLINGS' && U(i + 2) === 'BY' ? { k: 'order', at: i, body: i + 3 } : null
      case 'CONNECT': return U(i + 1) === 'BY' ? { k: 'connect', at: i, body: i + 2 } : null
      case 'START': return U(i + 1) === 'WITH' ? { k: 'start', at: i, body: i + 2 } : null
      case 'FETCH': return U(i + 1) === 'FIRST' || U(i + 1) === 'NEXT' ? { k: 'fetch', at: i, body: i + 1 } : null
      case 'OFFSET': return toks[i + 1] && (toks[i + 1].t === 'num' || toks[i + 1].t === 'bind') ? { k: 'offset', at: i, body: i + 1 } : null
      case 'FOR': return U(i + 1) === 'UPDATE' ? { k: 'update', at: i, body: i + 2 } : null
      case 'MODEL': return { k: 'model', at: i, body: i + 1 }
      case 'UNION': case 'INTERSECT': case 'MINUS': case 'EXCEPT': return { k: 'setop', at: i, body: i }
    }
    return null
  }

  /** One SELECT … block from `sel`, up to a set operator or `b`. */
  const block = (sel: number, b: number, parent: Block | null, paren: Paren | null, depth: number): Block => {
    const blk: Block = {
      n: 0, sel, end: b, depth, parent, paren, list: [sel + 1, sel + 1], distinct: -1, items: [], conj: [], clause: new Map(),
      setOp: null, aggs: [], overs: [], rownums: [],
    }
    blocks.push(blk)
    const marks: Mark[] = []
    let i = sel + 1
    while (i < b) {
      if (isP(i, '(')) { i = match[i] + 1; continue }
      const m = clauseAt(i)
      if (m) {
        if (m.k === 'setop') break
        marks.push(m)
        i = m.body
        continue
      }
      i++
    }
    blk.end = i
    const endOf = (k: number) => (k + 1 < marks.length ? marks[k + 1].at : blk.end)
    let ls = sel + 1
    if (U(ls) === 'DISTINCT' || U(ls) === 'UNIQUE') { blk.distinct = ls; ls++ } else if (U(ls) === 'ALL') ls++
    blk.list = [ls, marks.length ? marks[0].at : blk.end]
    marks.forEach((m, k) => {
      const e = endOf(k)
      if (m.k === 'from') fromList(m.body, e, blk, m.at)
      else if (m.k === 'where') conjuncts(m.body, e, blk, m.at)
      else {
        blk.clause.set(m.k, [m.at, e])
        nested(m.body, e, blk, m.k === 'having' || m.k === 'connect' || m.k === 'start' ? 'where' : 'other')
      }
    })
    nested(blk.list[0], blk.list[1], blk, 'select')
    calls(blk, blk.list, true)
    const ord = blk.clause.get('order')
    if (ord) calls(blk, ord, false)
    return blk
  }

  /** Subqueries in [a, b), at any depth of parentheses. */
  const nested = (a: number, b: number, blk: Block, kind: Paren['kind']) => {
    for (let i = a; i < b; i++) {
      if (!isP(i, '(') || !isQueryStart(i + 1)) continue
      const p = newParen(i, kind, blk)
      p.blocks = queryExpr(i + 1, p.close, blk, p, blk.depth + 1)
      i = p.close
    }
  }

  /** Aggregates and analytic calls of a select list (or ORDER BY: analytic only), and ROWNUM in it. */
  const calls = (blk: Block, [a, b]: Span, list: boolean) => {
    for (let i = a; i < b; i++) {
      if (queryAt.has(i)) { i = match[i]; continue }
      const u = U(i)
      if (list && u === 'ROWNUM') blk.rownums.push(i)
      if (!u || !isP(i + 1, '(') || isP(i - 1, '.')) continue
      if (!AGG.has(u) && !HYPOTHETICAL.has(u) && !BUILTIN.has(u)) continue
      let e = match[i + 1] + 1
      let within = false
      for (;;) {
        if (U(e) === 'WITHIN' && U(e + 1) === 'GROUP' && isP(e + 2, '(')) { e = match[e + 2] + 1; within = true; continue }
        if (U(e) === 'KEEP' && isP(e + 1, '(')) { e = match[e + 1] + 1; continue }
        break
      }
      if (U(e) === 'OVER') {
        e = isP(e + 1, '(') ? match[e + 1] + 1 : e + 2
        blk.overs.push([i, e])
        i = e - 1
      } else if (list && (AGG.has(u) || (within && HYPOTHETICAL.has(u)))) {
        blk.aggs.push([i, e])
        i = e - 1
      }
    }
  }

  /** NATURAL / INNER / CROSS / LEFT [OUTER] / RIGHT [OUTER] / FULL [OUTER] JOIN, CROSS / OUTER APPLY at i: the index after it, -1. */
  const joinAt = (i: number): number => {
    let j = i
    if (U(j) === 'NATURAL') j++
    const u = U(j)
    if ((u === 'CROSS' || u === 'OUTER') && U(j + 1) === 'APPLY') return j + 2
    if (u === 'INNER' || u === 'CROSS') j++
    else if (u === 'LEFT' || u === 'RIGHT' || u === 'FULL') { j++; if (U(j) === 'OUTER') j++ }
    return U(j) === 'JOIN' ? j + 1 : -1
  }

  /** The FROM items in [a, b) of a block; `kw` the FROM keyword (the first item's). */
  const fromList = (a: number, b: number, blk: Block, kw: number) => {
    let i = a
    let join: Span | null = null
    while (i < b) {
      const before = i
      if (isP(i, ',')) { i++; continue }
      const je = joinAt(i)
      if (je > 0) { join = [i, je]; i = je; continue }
      if (U(i) === 'PARTITION' && U(i + 1) === 'BY') { i += 2; if (isP(i, '(')) i = match[i] + 1; continue }
      const r = item(i, b, blk, kw)
      kw = -1
      i = r.next
      if (join && r.item) {
        const j: Join = { item: r.item, kw: join, cond: null, using: false, refs: new Set(), unresolved: false, cols: new Set() }
        if (U(i) === 'ON') {
          let e = i + 1
          while (e < b && !isP(e, ',') && joinAt(e) < 0) e = isP(e, '(') ? match[e] + 1 : e + 1
          j.cond = [i, e]
          nested(i + 1, e, blk, 'where')
          i = e
        } else if (U(i) === 'USING' && isP(i + 1, '(')) {
          j.cond = [i, match[i + 1] + 1]
          j.using = true
          i = match[i + 1] + 1
        }
        r.item.join = j
        joins.push(j)
      }
      join = null
      if (i === before) i++
    }
  }

  /** One FROM item at i: a table (or view, or WITH query) with its alias, an inline view, a table function. */
  const item = (i: number, b: number, blk: Block, fromKw: number): { item: Item | null; next: number } => {
    const start = i
    const it: Item = { idx: -1, block: blk, name: '', alias: '', span: [i, i], fromKw, view: null, cte: null, fn: false, join: null }
    const lateral = U(i) === 'LATERAL' && isP(i + 1, '(')
    if (isP(i, '(') || lateral) {
      const o = lateral ? i + 1 : i
      if (!isQueryStart(o + 1)) { // a parenthesised join: its items are this block's
        fromList(o + 1, match[o], blk, fromKw)
        return { item: null, next: match[o] + 1 }
      }
      const p = newParen(o, 'from', blk)
      p.item = it
      p.blocks = queryExpr(o + 1, p.close, blk, p, blk.depth + 1)
      it.view = p
      i = p.close + 1
    } else if (['TABLE', 'XMLTABLE', 'JSON_TABLE', 'THE'].includes(U(i)) && isP(i + 1, '(')) {
      it.fn = true
      nested(i + 2, match[i + 1], blk, 'other')
      i = match[i + 1] + 1
    } else if (wordy(i)) {
      const parts = [ident(i)]
      i++
      while (isP(i, '.') && wordy(i + 1)) { parts.push(ident(i + 1)); i += 2 }
      if (isP(i, '@')) { i++; while (i < b && (wordy(i) || isP(i, '.'))) i++ }
      if (isP(i, '(')) { // a table function without TABLE ( )
        it.fn = true
        nested(i + 1, match[i], blk, 'other')
        i = match[i] + 1
      } else it.name = parts[parts.length - 1]
    } else return { item: null, next: i + 1 }
    for (;;) {
      const u = U(i)
      if (u === 'PARTITION' || u === 'SUBPARTITION') { i++; if (U(i) === 'FOR') i++; if (isP(i, '(')) i = match[i] + 1; continue }
      if (u === 'SAMPLE') { i++; if (U(i) === 'BLOCK') i++; if (isP(i, '(')) i = match[i] + 1; if (U(i) === 'SEED' && isP(i + 1, '(')) i = match[i + 1] + 1; continue }
      if (u === 'PIVOT' || u === 'UNPIVOT') { i++; while (i < b && !isP(i, '(')) i++; if (isP(i, '(')) i = match[i] + 1; continue }
      break
    }
    let alias = -1
    if (U(i) === 'AS' && wordy(i + 1)) { alias = i + 1; i += 2 }
    else if (toks[i] && (toks[i].t === 'qid' || (toks[i].t === 'word' && !ALIAS_STOP.has(U(i))))) { alias = i; i++ }
    if (alias >= 0) it.alias = ident(alias)
    if (it.view) it.view.alias = alias
    it.span = [it.view ? alias >= 0 ? alias : i : start, i]
    if (it.view && alias < 0) it.span = [i, i]
    it.idx = items.length
    items.push(it)
    blk.items.push(it)
    return { item: it, next: i }
  }

  /** WHERE … split at its top-level ANDs (not BETWEEN's, not inside CASE). */
  const conjuncts = (a: number, b: number, blk: Block, kw: number) => {
    const push = (k: number, s: number, e: number) => {
      if (s >= e) return
      const c: Conj = { idx: conjs.length, block: blk, kw: k, span: [s, e], refs: new Set(), nested: [], unresolved: false, rownum: false, cols: new Set() }
      conjs.push(c)
      blk.conj.push(c)
    }
    let start = a, between = 0, cases = 0
    for (let i = a; i < b; i++) {
      if (isP(i, '(')) { i = match[i]; continue }
      const u = U(i)
      if (u === 'CASE') cases++
      else if (u === 'END' && cases > 0) cases--
      else if (u === 'BETWEEN' && cases === 0) between++
      else if (u === 'AND' && cases === 0) {
        if (between > 0) { between--; continue }
        push(kw, start, i)
        kw = i
        start = i + 1
      }
    }
    push(kw, start, b)
    nested(a, b, blk, 'where')
  }

  queryExpr(0, n, null, null, 0)
  if (!blocks.length) return { why: 'parse', kind: '' }
  blocks.sort((x, y) => x.sel - y.sel).forEach((x, k) => { x.n = k + 1 })
  for (const it of items) if (it.name && !it.fn && !it.view && ctes.has(it.name)) it.cte = ctes.get(it.name) ?? null

  // ---- what the predicates name
  const findItem = (blk: Block | null, q: string): { item: Item | null } => {
    for (let x = blk; x; x = x.parent) {
      const it = x.items.find((y) => y.alias === q) ?? x.items.find((y) => !y.alias && y.name === q)
      if (it) return { item: it }
    }
    return { item: null }
  }
  const refsIn = (blk: Block, a: number, b: number) => {
    const out = { refs: new Set<Item>(), unresolved: false, rownum: false, nested: [] as Paren[], cols: new Set<string>() }
    for (let i = a; i < b; i++) {
      const p = queryAt.get(i)
      if (p) { out.nested.push(p); i = p.close; continue }
      const t = toks[i]
      if (t.t === 'kw') { if (U(i) === 'ROWNUM') out.rownum = true; continue }
      if (!(t.t === 'word' || t.t === 'qid') || isP(i - 1, '.')) continue
      const parts = [ident(i)]
      let j = i + 1
      while (isP(j, '.') && toks[j + 1] && (toks[j + 1].t === 'word' || toks[j + 1].t === 'qid' || toks[j + 1].t === 'kw')) { parts.push(ident(j + 1)); j += 2 }
      const plus = isP(j, '(') && isP(j + 1, '+') && isP(j + 2, ')') // an old-style outer join marker, not a call
      i = plus ? j + 2 : j - 1
      if (!plus && (isP(j, '(') || (isP(j, '=') && isP(j + 1, '>')))) continue // a call, a named argument
      const last = parts[parts.length - 1]
      if (last === 'NEXTVAL' || last === 'CURRVAL') continue
      if (parts.length === 1) {
        if (t.t === 'word' && PSEUDO.has(last)) continue
        if (blk.items.length === 1) { out.refs.add(blk.items[0]); out.cols.add(last) }
        else if (blk.items.length > 1 && !(t.t === 'word' && SYNTAX.has(last))) { out.unresolved = true; out.cols.add(last) }
        continue
      }
      out.cols.add(last)
      const r = findItem(blk, parts[parts.length - 2])
      if (r.item) out.refs.add(r.item)
      else out.unresolved = true
    }
    return out
  }
  for (const c of conjs) {
    const r = refsIn(c.block, c.span[0], c.span[1])
    c.refs = r.refs
    c.unresolved = r.unresolved
    c.rownum = r.rownum
    c.nested = r.nested
    c.cols = r.cols
  }
  for (const j of joins) {
    if (!j.cond || j.using) continue
    const r = refsIn(j.item.block, j.cond[0] + 1, j.cond[1])
    j.refs = r.refs
    j.unresolved = r.unresolved
    j.cols = r.cols
  }

  // ---- calls of functions that are not Oracle built-ins
  const fns: FnCall[] = []
  const fnCalls: FnCall[] = []
  const seen = new Set<string>()
  for (let i = 0; i < n; i++) {
    const t = toks[i]
    if (!(t.t === 'word' || t.t === 'qid') || isP(i - 1, '.')) continue
    const parts = [ident(i)]
    let j = i + 1
    while (isP(j, '.') && toks[j + 1] && (toks[j + 1].t === 'word' || toks[j + 1].t === 'qid')) { parts.push(ident(j + 1)); j += 2 }
    if (!isP(j, '(') || (isP(j + 1, '+') && isP(j + 2, ')'))) { i = j - 1; continue }
    const last = parts[parts.length - 1]
    const builtin = parts.length === 1
      ? t.t === 'word' && (BUILTIN.has(last) || AGG.has(last) || BUILTIN_PREFIX.test(last) || NOT_CALL.has(last))
      : BUILTIN_PACKAGE.test(parts[parts.length - 2])
    const cteHead = parts.length === 1 && ctes.has(last) && U(match[j] + 1) === 'AS'
    if (!builtin && !cteHead) {
      const name = parts.join('.')
      const call = { name: text.slice(t.a, toks[j - 1].b), at: i, end: match[j] + 1 }
      fnCalls.push(call)
      if (!seen.has(name)) { seen.add(name); fns.push(call) }
    }
    i = j - 1
  }
  const withAt = U(k0) === 'WITH' ? k0 : -1
  return { toks, blocks, items, conjs, joins, parens, queryAt, fns, calls: fnCalls, withAt }
}

// ---- the mapping: plan line → fragment

interface Target {
  key: string
  what: string
  /** token spans (holes for subqueries are cut when painting) */
  spans: Span[]
  conjs: Conj[]
  joins: Join[]
  approx: Set<string>
}

const INDEX = /^(INDEX |BITMAP INDEX|DOMAIN INDEX)/
const BY_INDEX_ROWID = /^TABLE ACCESS BY (LOCAL |GLOBAL )?INDEX ROWID/
/** a table access an index line feeds as its first input */
const FED_BY_INDEX = /^TABLE ACCESS (BY (LOCAL |GLOBAL )?INDEX ROWID|CLUSTER|HASH)/
/** between an index and the table access it feeds */
const UP_TO_TABLE = /^(BITMAP (CONVERSION|AND|OR|MERGE|MINUS|KEY ITERATION)|INLIST ITERATOR|PARTITION |SORT CLUSTER BY ROWID|PX BLOCK ITERATOR)/
const JOIN = /^(HASH JOIN|NESTED LOOPS|MERGE JOIN)/
/** go with the join above them */
const WITH_JOIN = /^(SORT JOIN|BUFFER SORT|JOIN FILTER)/
/** go with the row source below them */
const TRANSPARENT = /^(FIRST ROW|PARTITION |INLIST ITERATOR|PX |BITMAP (CONVERSION|AND|OR|MERGE|MINUS|KEY ITERATION)|STATISTICS COLLECTOR|RESULT CACHE|SORT CLUSTER BY ROWID|TABLE ACCESS BY |INDEX |BITMAP INDEX|MAT_VIEW )/
const SETOP = /^(UNION-ALL|UNION ALL|INTERSECTION|MINUS|CONCATENATION)/
const COLLECTION = /^(COLLECTION ITERATOR|XMLTABLE EVALUATION|XPATH EVALUATION|JSONTABLE EVALUATION)/

/** access operations that name an object after them */
const ACCESS = /^(TABLE ACCESS (?:BY (?:LOCAL |GLOBAL )?INDEX ROWID(?: BATCHED)?|BY USER ROWID|BY ROWID RANGE|FULL|CLUSTER|HASH|SAMPLE|STORAGE FULL|INMEMORY FULL)|INDEX (?:RANGE SCAN(?: DESCENDING)?|UNIQUE SCAN|FULL SCAN(?: DESCENDING)?|FAST FULL SCAN|SKIP SCAN|(?:FULL|RANGE) SCAN \(MIN\/MAX\)|SAMPLE FAST FULL SCAN)|BITMAP INDEX (?:SINGLE VALUE|RANGE SCAN|FULL SCAN|FAST FULL SCAN)|FIXED TABLE (?:FULL|FIXED INDEX)|MAT_VIEW (?:REWRITE )?ACCESS (?:FULL|BY INDEX ROWID)) (\S+)$/i

/**
 * A line's operation and object. The trace's text is "op object", and the model does not always split it where it should:
 * a line without an obj# keeps the object in its operation ("FIXED TABLE FULL X$KXFPSST"), and a partitioned line's
 * "PARTITION: start stop" takes the place of the object ("TABLE ACCESS FULL SALES_P PARTITION: KEY" + "1048575"). So: the partition bounds
 * go, a known access operation takes the word after it, else the line's own object, else a last word that operation
 * words never look like (with $, #, _ or a digit).
 */
const splitOp = (l: PlanLine): { op: string; obj: string } => {
  const own = (l.object ?? '').trim()
  const full = `${l.op} ${own}`.replace(/\s+/g, ' ').trim().replace(/ PARTITION: \S+(?: \S+)?$/i, '')
  let op = full, obj = ''
  const k = ACCESS.exec(full)
  if (k) { op = k[1]; obj = k[2] }
  else if (own && full.toUpperCase().endsWith(' ' + own.toUpperCase())) { op = full.slice(0, -own.length - 1); obj = own }
  else {
    const m = /^(.+) (\S*[$#_0-9]\S*)$/.exec(full)
    if (m && !/[()/:]/.test(m[2])) { op = m[1]; obj = m[2] }
  }
  if (obj.includes('.')) obj = obj.slice(obj.lastIndexOf('.') + 1)
  return { op: op.toUpperCase(), obj: obj.replace(/"/g, '') }
}
const opOf = (l: PlanLine): string => splitOp(l).op
const objOf = (l: PlanLine): string => splitOp(l).obj
const sameName = (name: string, obj: string) => name === obj || name === obj.toUpperCase()

function mapPlan(P: Parsed, flow: RowFlow, text: string) {
  const { toks, items, blocks, conjs, joins, parens } = P
  const nodes = flow.nodes.filter((x) => x.index >= 0)
  const src = (s: Span) => (s[1] > s[0] ? text.slice(toks[s[0]].a, toks[s[1] - 1].b) : '')
  const targets = new Map<string, Target>()
  const target = (key: string, what: string, spans: () => Span[]): Target => {
    let t = targets.get(key)
    if (!t) { t = { key, what, spans: spans(), conjs: [], joins: [], approx: new Set() }; targets.set(key, t) }
    return t
  }
  const of = new Map<FlowNode, Target>()
  const itemOf = new Map<FlowNode, Item>()
  const why = new Map<FlowNode, string>()
  const itemWhy = new Map<Item, string>()
  const taken = new Set<Item>()
  const tables = items.filter((it) => it.name && !it.view && !it.fn).sort((a, b) => a.span[0] - b.span[0])

  const byAlias = (l: PlanLine, cands: Item[]): Item | null => {
    if (!l.alias) return null
    const [al, qb0] = l.alias.replace(/"/g, '').split('@')
    const qb = qb0 || l.qblock || ''
    let m = cands.filter((it) => (it.alias || it.name) === al || (it.alias || it.name) === al.toUpperCase())
    const sel = /^SEL\$(\d+)$/i.exec(qb)
    if (m.length > 1 && sel) { const k = Number(sel[1]); const mm = m.filter((it) => it.block.n === k); if (mm.length) m = mm }
    return m.length === 1 ? m[0] : null
  }
  const setItem = (x: FlowNode, it: Item, reason?: string) => {
    itemOf.set(x, it)
    taken.add(it)
    if (reason) { why.set(x, reason); if (!itemWhy.has(it)) itemWhy.set(it, reason) }
  }
  /** the items the lines of x's subtree are given */
  const placedBelow = (x: FlowNode): Set<Block> => {
    const out = new Set<Block>()
    const stack = [x]
    while (stack.length) {
      const y = stack.pop() as FlowNode
      const it = itemOf.get(y)
      if (it) out.add(it.block)
      stack.push(...y.children)
    }
    return out
  }
  /**
   * One of several candidates (a table named twice): the alias of a ref bundle decides; else one not taken yet, of the
   * query block whose other tables are nearest in the plan (the lowest real ancestor with a placed line below it), in
   * text order (≈).
   */
  const pick = (x: FlowNode, cands: Item[], several: string, reason?: string) => {
    const a = byAlias(x.line, cands)
    if (a) { setItem(x, a); return }
    if (cands.length === 1) { setItem(x, cands[0], reason); return }
    const free = cands.filter((c) => !taken.has(c))
    const pool = free.length ? free : cands
    let it: Item | undefined
    for (let p = x.parent; p && p.index >= 0 && !it; p = p.parent) {
      const near = placedBelow(p)
      it = pool.find((c) => near.has(c.block))
    }
    setItem(x, it ?? pool[0], several)
  }

  // pass 1: a line whose object is a table, view or WITH query of the text; the unambiguous ones first, so the others
  // can lean on where they sit
  const tableCands = (x: FlowNode): Item[] => {
    const op = opOf(x.line), obj = objOf(x.line)
    if (INDEX.test(op)) return []
    if (obj.toUpperCase().startsWith('SYS_TEMP_')) return items.filter((it) => it.cte)
    return obj ? tables.filter((it) => sameName(it.name, obj)) : op === 'FAST DUAL' ? tables.filter((it) => it.name === 'DUAL') : []
  }
  for (const ambiguous of [false, true]) {
    for (const x of nodes) {
      if (itemOf.has(x)) continue
      const cands = tableCands(x)
      if (!cands.length || (cands.length > 1 && !byAlias(x.line, cands)) !== ambiguous) continue
      const several = objOf(x.line).toUpperCase().startsWith('SYS_TEMP_')
        ? 'a materialised WITH query read by name: the trace does not say which one'
        : `${cands[0].name} appears ${cands.length} times in the text and the trace does not say which one this line reads`
      pick(x, cands, several)
    }
  }
  // a table or fixed table under another name (a synonym, a V$ view's X$ table) when the text reads one table
  if (new Set(tables.map((it) => it.name)).size === 1) {
    for (const x of nodes) {
      if (!itemOf.has(x) && objOf(x.line) && /^(TABLE ACCESS|FIXED TABLE|MAT_VIEW ACCESS|EXTERNAL TABLE ACCESS)/.test(opOf(x.line))) {
        pick(x, tables, `${tables[0].name} appears ${tables.length} times in the text and the trace does not say which one this line reads`, `the statement reads one table or view, and the plan names ${objOf(x.line)}`)
      }
    }
  }

  // pass 2: an index line goes with its table
  for (const x of nodes) {
    const op = opOf(x.line)
    if (itemOf.has(x) || !INDEX.test(op)) continue
    const a = byAlias(x.line, tables)
    if (a) { setItem(x, a); continue }
    // the TABLE ACCESS BY INDEX ROWID it feeds as its first input (through bitmap conversions, iterators, partitions);
    // not through another index line: an index line below an index line is a subquery evaluated as its key
    let c = x, p = x.parent
    while (p && p.index >= 0 && UP_TO_TABLE.test(opOf(p.line)) && (p.children[0] === c || /^BITMAP (AND|OR|MERGE|MINUS)/.test(opOf(p.line)))) { c = p; p = p.parent }
    if (p && p.index >= 0 && FED_BY_INDEX.test(opOf(p.line)) && p.children[0] === c && itemOf.has(p)) {
      setItem(x, itemOf.get(p) as Item, why.get(p))
      continue
    }
    // a batched nested loop: NESTED LOOPS (NESTED LOOPS (outer, this index), TABLE ACCESS BY INDEX ROWID t)
    if (p && p.index >= 0 && /^NESTED LOOPS/.test(opOf(p.line)) && p.children.length === 2 && p.children[1] === c) {
      const q = p.parent
      const t = q && q.index >= 0 && /^NESTED LOOPS/.test(opOf(q.line)) && q.children.length === 2 && q.children[0] === p ? q.children[1] : null
      if (t && BY_INDEX_ROWID.test(opOf(t.line)) && itemOf.has(t)) { setItem(x, itemOf.get(t) as Item, why.get(t)); continue }
    }
    // the table whose name the index name contains (PK_ORDERS: ORDERS), the longest; a whole word of it first
    const name = objOf(x.line).toUpperCase()
    const word = (it: Item) => new RegExp(`(^|[^A-Z0-9])${it.name.replace(/[$#]/g, '\\$&')}($|[^A-Z0-9])`).test(name)
    let hits = name ? tables.filter((it) => it.name.length >= 2 && word(it)) : []
    let how = 'contains'
    const stem = (it: Item) => it.name.replace(/[$#]+$/, '')
    const alnum = (v: string) => v.replace(/[^A-Z0-9]/g, '')
    if (!hits.length && name) { hits = tables.filter((it) => stem(it).length >= 3 && name.includes(stem(it))); how = 'resembles' }
    if (!hits.length && name) hits = tables.filter((it) => alnum(it.name).length >= 4 && alnum(name).includes(alnum(it.name)))
    if (hits.length) {
      const len = Math.max(...hits.map((it) => it.name.length))
      const best = hits.filter((it) => it.name.length === len)
      pick(x, best, `${best[0].name} appears ${best.length} times in the text and the index name ${name} does not say which one`, `the index name ${name} ${how} the table name ${best[0].name}`)
      continue
    }
    if (new Set(tables.map((it) => it.name)).size === 1) pick(x, tables, `${tables[0].name} appears ${tables.length} times in the text and the trace does not say which one this index serves`, 'the statement reads one table')
  }
  // by elimination: one index line left and one table no line reads
  const lostIdx = nodes.filter((x) => !itemOf.has(x) && INDEX.test(opOf(x.line)))
  const unread = tables.filter((it) => !taken.has(it) && !it.cte)
  if (lostIdx.length === 1 && unread.length === 1) setItem(lostIdx[0], unread[0], `${unread[0].name} is the one table no other line reads`)

  const mapped = new Set(itemOf.values())
  const leafB = new Map<Block, Set<Item>>()
  const leafP = new Map<Paren, Set<Item>>()
  const leafOfParen = (p: Paren, seen: Set<Paren> = new Set()): Set<Item> => {
    const memo = leafP.get(p)
    if (memo) return memo
    const s = new Set<Item>()
    if (seen.has(p)) return s
    seen.add(p)
    for (const b of p.blocks) for (const it of leafOfBlock(b, seen)) s.add(it)
    leafP.set(p, s)
    return s
  }
  const leafOfBlock = (b: Block, seen: Set<Paren> = new Set()): Set<Item> => {
    const memo = leafB.get(b)
    if (memo) return memo
    const s = new Set<Item>()
    for (const it of b.items) {
      const p = it.view ?? it.cte
      if (p) for (const l of leafOfParen(p, seen)) s.add(l)
      else s.add(it)
    }
    leafB.set(b, s)
    return s
  }
  const underMemo = new Map<FlowNode, Set<Item>>()
  const under = (x: FlowNode): Set<Item> => {
    let s = underMemo.get(x)
    if (s) return s
    s = new Set<Item>()
    const it = itemOf.get(x)
    if (it) s.add(it)
    for (const c of x.children) for (const i of under(c)) s.add(i)
    underMemo.set(x, s)
    return s
  }
  const covered = (s: Set<Item>, it: Item) => s.has(it) || (!!(it.view ?? it.cte) && [...leafOfParen((it.view ?? it.cte) as Paren)].some((l) => s.has(l)))
  const placedIn = (leaf: Set<Item>, u: Set<Item>) => {
    const m = [...leaf].filter((it) => mapped.has(it))
    return m.length > 0 && m.every((it) => u.has(it))
  }
  /** the blocks whose placed tables all lie under x and that `need` something, innermost first */
  const blocksBy = (x: FlowNode, need: (b: Block) => boolean): Block[] => {
    const u = under(x)
    const out = blocks.filter((b) => need(b) && placedIn(leafOfBlock(b), u))
    if (!out.length) {
      const any = blocks.filter(need)
      if (any.length === 1 && ![...leafOfBlock(any[0])].some((it) => mapped.has(it))) return any
    }
    return out.sort((a, b) => b.depth - a.depth || a.sel - b.sel)
  }
  const used = new Set<string>()
  const choose = (x: FlowNode, need: (b: Block) => boolean, key: string): Block | null => {
    const cs = blocksBy(x, need)
    const b = cs.find((c) => !used.has(`${key}:${c.n}`)) ?? cs[0] ?? null
    if (b) used.add(`${key}:${b.n}`)
    return b
  }
  const conjOwner = new Map<Conj, Target>()
  const joinOwner = new Map<Join, Target>()
  /** the column names in a line's predicates from a ref bundle (DBMS_XPLAN's access and filter: "ALIAS"."COLUMN"), null without any */
  const predCols = (l: PlanLine): Set<string> | null => {
    const t = `${l.access ?? ''} ${l.filter ?? ''}`
    const out = new Set<string>()
    for (const m of t.matchAll(/"([^"]+)"\."([^"]+)"|"([^"]+)"/g)) out.add((m[2] ?? m[3]).toUpperCase())
    return out.size ? out : null
  }
  /** every column of a fragment is in the predicate */
  const within = (cols: Set<string>, pc: Set<string>) => cols.size > 0 && [...cols].every((c) => pc.has(c.toUpperCase()))
  const viewOf = new Map<Paren, Target>()
  const inferred = (its: Iterable<Item>) => [...its].some((it) => itemWhy.has(it))

  const itemTarget = (it: Item): Target => target(`item:${it.idx}`, src(it.span), () => [it.fromKw >= 0 ? [it.fromKw, it.span[1]] : it.span])
  const clauseTarget = (b: Block, k: string, what: string): Target =>
    target(`${k}:${b.n}`, what, () => {
      const s = [b.clause.get(k) as Span]
      if (k === 'connect' && b.clause.has('start')) s.push(b.clause.get('start') as Span)
      if (k === 'fetch' && b.clause.has('offset')) s.push(b.clause.get('offset') as Span)
      return s
    })
  const own = (t: Target, cs: Conj[]) => { for (const c of cs) { conjOwner.set(c, t); t.conjs.push(c) } }
  const fullRefs = (c: Conj): Item[] => [...c.refs, ...c.nested.flatMap((p) => [...leafOfParen(p)])]
  const viewTarget = (p: Paren): Target => {
    const t = target(`view:${p.open}`, p.kind === 'from' ? 'inline view' : p.kind === 'cte' ? `WITH query ${p.cte}` : 'subquery', () => {
      const s: Span[] = [[p.open, p.open + 1], [p.close, p.close + 1]]
      if (p.alias >= 0) s.push([p.alias, p.alias + 1])
      if (p.item && p.item.fromKw >= 0) s.push([p.item.fromKw, p.item.fromKw + 1])
      return s
    })
    viewOf.set(p, t)
    return t
  }

  const joinRule = (x: FlowNode): Target | null => {
    const sides = x.children.map(under)
    if (sides.length < 2) return null
    // a ref bundle's predicate names the columns: the join condition (or WHERE predicates) with those columns, exactly
    const pc = predCols(x.line)
    if (pc) {
      const pj = joins.find((j) => !joinOwner.has(j) && j.cond && within(j.cols, pc))
      if (pj) {
        const t = target(`join:${pj.item.idx}`, 'join condition', () => [])
        t.joins.push(pj)
        joinOwner.set(pj, t)
        return t
      }
      const pcs = conjs.filter((c) => !conjOwner.has(c) && within(c.cols, pc) && (c.unresolved || c.refs.size >= 2 || c.nested.length > 0) &&
        [...c.refs].every((r) => sides.some((s) => covered(s, r))))
      if (pcs.length) {
        const t = target(`where:${pcs.map((c) => c.idx).join(',')}`, pcs.length === 1 ? 'join predicate' : 'join predicates', () => [])
        own(t, pcs)
        return t
      }
    }
    const fits = (refs: Item[]) => refs.length > 0 && refs.every((r) => sides.some((s) => covered(s, r))) && sides.filter((s) => refs.some((r) => covered(s, r))).length >= 2
    const usingFits = (j: Join) => {
      const k = sides.findIndex((s) => covered(s, j.item))
      if (k < 0) return false
      const left = j.item.block.items.slice(0, j.item.block.items.indexOf(j.item))
      return sides.some((s, i) => i !== k && left.some((it) => covered(s, it)))
    }
    const js = joins.filter((j) => !joinOwner.has(j) && j.cond && !j.unresolved && (j.using ? usingFits(j) : fits([j.item, ...j.refs])))
    if (js.length) {
      const j = js[0]
      const t = target(`join:${j.item.idx}`, j.using ? 'join (USING)' : 'join condition', () => [])
      t.joins.push(j)
      joinOwner.set(j, t)
      if (inferred([j.item, ...j.refs])) t.approx.add('the tables it joins were matched by inference')
      return t
    }
    const cs = conjs.filter((c) => !conjOwner.has(c) && !c.unresolved && fits(fullRefs(c)))
    if (cs.length) {
      const t = target(`where:${cs.map((c) => c.idx).join(',')}`, cs.length === 1 ? 'join predicate' : 'join predicates', () => [])
      own(t, cs)
      if (inferred(cs.flatMap(fullRefs))) t.approx.add('the tables it joins were matched by inference')
      return t
    }
    // the outer half of a batched nested loop: one input brings no new table; the join below has the condition
    if (sides.some((s, i) => s.size > 0 && [...s].every((it) => sides.some((o, k) => k !== i && o.has(it))))) {
      const queue = [...x.children]
      while (queue.length) {
        const y = queue.shift() as FlowNode
        const t = of.get(y)
        if (t && JOIN.test(opOf(y.line))) return t
        queue.push(...y.children)
      }
    }
    return null
  }

  const filterRule = (x: FlowNode): Target | null => {
    const pc = predCols(x.line)
    if (pc) {
      const pcs = conjs.filter((c) => !conjOwner.has(c) && !c.rownum && within(c.cols, pc) && (c.unresolved || c.refs.size !== 1 || c.nested.length > 0))
      if (pcs.length) {
        const t = target(`filter:${pcs.map((c) => c.idx).join(',')}`, 'filter predicates', () => [])
        own(t, pcs)
        return t
      }
    }
    if (x.children.length >= 2) {
      const subs = x.children.slice(1).map(under)
      const cs = conjs.filter((c) => !conjOwner.has(c) && c.nested.some((p) => [...leafOfParen(p)].some((it) => subs.some((s) => s.has(it)))))
      if (!cs.length) return null
      const t = target(`filter:${cs.map((c) => c.idx).join(',')}`, 'subquery predicate', () => [])
      own(t, cs)
      return t
    }
    const child = x.children[0]
    if (child && /^(SORT|HASH) GROUP BY/.test(opOf(child.line))) {
      const b = choose(x, (b) => b.clause.has('having'), 'having')
      if (b) return clauseTarget(b, 'having', 'HAVING')
    }
    const leftover = (c: Conj) => !conjOwner.has(c) && !c.rownum && (c.unresolved || c.refs.size !== 1)
    const b = blocksBy(x, (b) => b.conj.some(leftover))[0]
    if (!b) {
      // nothing left for it (it checks conditions on the binds alone, such as BETWEEN's low ≤ high): the rows below it
      const t = child ? of.get(child) : undefined
      if (t) t.approx.add('a FILTER above it with no predicate of its own is counted here')
      return t ?? null
    }
    const cs = b.conj.filter(leftover)
    const t = target(`filter:${cs.map((c) => c.idx).join(',')}`, 'filter predicates', () => [])
    own(t, cs)
    t.approx.add('the predicates no single table claims')
    return t
  }

  const rule = (x: FlowNode, op: string): Target | null | 'defer' => {
    if (JOIN.test(op)) return joinRule(x)
    // the inequality of a merge join, between it and the sort of its second input
    if (op === 'FILTER' && x.children.length === 1 && x.parent && x.parent.index >= 0 && /^MERGE JOIN/.test(opOf(x.parent.line))) return 'defer'
    if (op === 'FILTER') return filterRule(x)
    if (/^SORT ORDER BY/.test(op)) {
      const b = choose(x, (b) => b.clause.has('order'), 'order')
      return b ? clauseTarget(b, 'order', 'ORDER BY') : null
    }
    if (/^(SORT|HASH) GROUP BY/.test(op)) {
      const b = choose(x, (b) => b.clause.has('group'), 'group')
      if (b) return clauseTarget(b, 'group', 'GROUP BY')
      const d = choose(x, (b) => b.distinct >= 0, 'distinct')
      return d ? target(`distinct:${d.n}`, 'DISTINCT', () => [[d.distinct, d.distinct + 1]]) : null
    }
    if (/^(SORT|HASH) UNIQUE/.test(op)) {
      const d = choose(x, (b) => b.distinct >= 0, 'distinct')
      if (d) return target(`distinct:${d.n}`, 'DISTINCT', () => [[d.distinct, d.distinct + 1]])
      const ops = blocksBy(x, (b) => !!b.setOp && /^UNION$/i.test(toks[b.setOp[0]].v) && b.setOp[1] - b.setOp[0] === 1)
      return ops.length ? target(`setop:${ops.map((b) => b.n).join(',')}`, 'UNION', () => ops.map((b) => b.setOp as Span)) : null
    }
    if (op === 'SORT AGGREGATE') {
      const b = choose(x, (b) => b.aggs.length > 0, 'aggs')
      return b ? target(`aggs:${b.n}`, 'aggregates', () => b.aggs) : null
    }
    if (/^COUNT STOPKEY/.test(op)) {
      const free = (c: Conj) => c.rownum && c.refs.size === 0 && !conjOwner.has(c)
      const b = choose(x, (b) => b.conj.some(free), 'rownum')
      if (b) { const t = target(`rownum:${b.n}`, 'ROWNUM predicate', () => []); own(t, b.conj.filter(free)); return t }
      const f = choose(x, (b) => b.clause.has('fetch'), 'fetch')
      return f ? clauseTarget(f, 'fetch', 'FETCH FIRST') : null
    }
    if (op === 'COUNT') {
      const b = choose(x, (b) => b.rownums.length > 0, 'rownums')
      return b ? target(`rownums:${b.n}`, 'ROWNUM', () => b.rownums.map((i): Span => [i, i + 1])) : null
    }
    if (/^CONNECT BY PUMP/.test(op)) return 'defer'
    if (/^CONNECT BY/.test(op)) {
      const b = choose(x, (b) => b.clause.has('connect'), 'connect')
      return b ? clauseTarget(b, 'connect', 'CONNECT BY') : null
    }
    if (/^WINDOW/.test(op)) {
      const b = choose(x, (b) => b.overs.length > 0, 'over')
      if (b) return target(`over:${b.n}`, 'analytic functions', () => b.overs)
      const f = choose(x, (b) => b.clause.has('fetch'), 'fetch')
      return f ? clauseTarget(f, 'fetch', 'FETCH FIRST') : null
    }
    if (/^VIEW/.test(op) || /^LOAD AS SELECT/.test(op)) {
      const u = under(x)
      const cs = parens.filter((p) => p.kind !== 'set' && (op.startsWith('LOAD') ? p.kind === 'cte' : true) && placedIn(leafOfParen(p), u))
        .sort((a, b) => (b.blocks[0]?.depth ?? 0) - (a.blocks[0]?.depth ?? 0) || a.open - b.open)
      const p = cs.find((c) => !viewOf.has(c)) ?? cs[0]
      if (p) return viewTarget(p)
      // the view a FETCH FIRST is run as
      const f = choose(x, (b) => b.clause.has('fetch'), 'fetchview')
      return f ? clauseTarget(f, 'fetch', 'FETCH FIRST') : null
    }
    if (SETOP.test(op)) {
      const ops = blocksBy(x, (b) => !!b.setOp)
      return ops.length ? target(`setop:${ops.map((b) => b.n).join(',')}`, 'set operator', () => ops.map((b) => b.setOp as Span)) : null
    }
    if (/^FOR UPDATE/.test(op)) {
      const b = choose(x, (b) => b.clause.has('update'), 'update')
      return b ? clauseTarget(b, 'update', 'FOR UPDATE') : null
    }
    if (op === 'SEQUENCE') {
      const obj = objOf(x.line).toUpperCase()
      const at: Span[] = []
      for (let i = 0; i + 2 < toks.length; i++) {
        const nx = toks[i + 2].v.toUpperCase()
        if (toks[i].v.replace(/"/g, '').toUpperCase() === obj && toks[i + 1].v === '.' && (nx === 'NEXTVAL' || nx === 'CURRVAL')) at.push([i, i + 3])
      }
      return at.length ? target(`seq:${obj}`, 'sequence', () => at) : null
    }
    if (op === 'TEMP TABLE TRANSFORMATION') {
      const w = P.withAt
      return w >= 0 ? target('with', 'WITH', () => [[w, w + 1]]) : null
    }
    if (COLLECTION.test(op)) {
      const fns = items.filter((it) => it.fn)
      if (!fns.length) return null
      const it = fns.find((f) => !taken.has(f)) ?? fns[0]
      taken.add(it)
      const t = itemTarget(it)
      if (fns.length > 1) t.approx.add('one of several table functions')
      return t
    }
    if (WITH_JOIN.test(op)) return 'defer'
    if (TRANSPARENT.test(op)) return single(x)
    return null
  }
  /** the target of every input, when they share one */
  const single = (x: FlowNode): Target | null => {
    const ts = x.children.map((c) => of.get(c))
    return ts.length > 0 && ts[0] && ts.every((t) => t === ts[0]) ? ts[0] : null
  }

  // pass 3: the rest, inputs before the lines that consume them
  const deferred: FlowNode[] = []
  for (let k = nodes.length - 1; k >= 0; k--) {
    const x = nodes[k]
    const it = itemOf.get(x)
    if (it) { of.set(x, itemTarget(it)); continue }
    const t = rule(x, opOf(x.line))
    if (t === 'defer') deferred.push(x)
    else if (t) of.set(x, t)
  }
  // SORT JOIN, BUFFER SORT, JOIN FILTER, a merge join's FILTER: the nearest join above; CONNECT BY PUMP: the CONNECT BY
  // above; else their input's
  for (const x of deferred.reverse()) {
    const pump = /^CONNECT BY PUMP/.test(opOf(x.line))
    for (let p = x.parent; p && p.index >= 0; p = p.parent) {
      const t = of.get(p)
      if (t && (pump ? /^CONNECT BY/.test(opOf(p.line)) : JOIN.test(opOf(p.line)))) { of.set(x, t); break }
    }
    if (!of.has(x)) { const t = single(x); if (t) of.set(x, t) }
  }
  // a ref bundle's predicates on a table's line: the conjuncts of its block with those columns, qualified or not
  for (const [x, it] of itemOf) {
    const pc = predCols(x.line)
    if (!pc) continue
    const cs = it.block.conj.filter((c) => !conjOwner.has(c) && !c.rownum && within(c.cols, pc) && [...c.refs].every((r) => r === it || r.block !== it.block))
    if (cs.length) own(itemTarget(it), cs)
  }
  // a table's own predicates: the conjuncts of its block that name only it (or only the inline view a VIEW line is)
  const outerOf = (b: Block, it: Item) => { for (let p = b.parent; p; p = p.parent) if (it.block === p) return true; return false }
  for (const c of conjs) {
    if (conjOwner.has(c) || c.unresolved || c.rownum) continue
    // its block's one table (a correlated predicate also names tables of outer blocks)
    const local = [...c.refs].filter((it) => it.block === c.block)
    if (local.length !== 1 || ![...c.refs].every((it) => it.block === c.block || outerOf(c.block, it))) continue
    const it = local[0]
    const t = targets.get(`item:${it.idx}`) ?? (it.view ? viewOf.get(it.view) : undefined)
    if (t) own(t, [c])
  }
  for (const [x, t] of of) { const w = why.get(x); if (w) t.approx.add(w) }
  return of
}

// ---- painting the formatted text

/** Formatted-text index of every non-blank character of `text` (-1 for blanks), or null when they do not line up. */
function align(text: string, formatted: string): Int32Array | null {
  const o2f = new Int32Array(text.length).fill(-1)
  const blank = /\s/
  let f = 0
  for (let o = 0; o < text.length; o++) {
    if (blank.test(text[o])) continue
    while (f < formatted.length && blank.test(formatted[f])) f++
    if (f >= formatted.length || formatted[f].toUpperCase() !== text[o].toUpperCase()) return null
    o2f[o] = f++
  }
  while (f < formatted.length && blank.test(formatted[f])) f++
  return f === formatted.length ? o2f : null
}

/** Paints a statement's text with the self time of one plan dump. Never throws. */
export function sqlHeat(input: HeatInput): SqlHeat {
  try {
    return heat(input)
  } catch {
    return fallback('parse')
  }
}

function heat(input: HeatInput): SqlHeat {
  const { text, lines } = input
  if (!lines.length) return fallback('empty')
  const P = parse(text)
  if ('why' in P) return fallback(P.why, P.kind)
  const flow = rowFlow(lines)
  if (!flow.hasStats) return fallback('nostats')
  if (flow.selfSumUs <= 0) return fallback('notime')
  const formatted = formatSql(text).join('\n')
  const o2f = align(text, formatted)
  if (!o2f) return fallback('parse')
  const of = mapPlan(P, flow, text)
  const { toks, queryAt } = P

  const part = (x: FlowNode): HeatPart => ({ id: x.line.id, op: opText(x.line), selfUs: x.selfUs, selfCr: x.selfCr, clamped: x.clamped })
  const nodes = flow.nodes.filter((x) => x.index >= 0)
  const byTarget = new Map<Target, FlowNode[]>()
  for (const x of nodes) {
    const t = of.get(x)
    if (!t) continue
    const l = byTarget.get(t)
    if (l) l.push(x); else byTarget.set(t, [x])
  }
  /** token spans with the inside of subqueries cut out (their parentheses stay with the fragment) */
  const cut = ([a, b]: Span): Span[] => {
    const out: Span[] = []
    let s = a
    for (let i = a; i < b; i++) {
      const p = queryAt.get(i)
      if (p && p.close < b) { out.push([s, i + 1]); i = p.close - 1; s = p.close }
    }
    out.push([s, b])
    return out.filter(([x, y]) => y > x)
  }
  const spansOf = (t: Target): Span[] => {
    const raw: Span[] = [...t.spans]
    for (const c of t.conjs) raw.push([c.kw >= 0 && c.kw < c.span[0] ? c.kw : c.span[0], c.span[1]])
    for (const j of t.joins) { raw.push(j.kw); if (j.cond) raw.push(j.cond) }
    return raw.filter(([a, b]) => b > a).flatMap(cut)
  }
  const planUs = flow.selfSumUs
  type Cand = { what: string; approx: string[]; xs: FlowNode[]; spans: Span[]; us: number; recursive?: { fn: string; statement: ID } }
  const cands: Cand[] = [...byTarget.entries()]
    .map(([t, xs]) => ({ what: t.what, approx: [...t.approx], xs, spans: spansOf(t), us: xs.reduce((a, x) => a + x.selfUs, 0) }))
    .filter((g) => g.spans.length > 0)
  // paint: wide spans first, so a fragment inside another (a subquery's FROM in a predicate) keeps its own group
  const paint = new Int32Array(formatted.length).fill(-1)
  const paintSpans = (list: { span: Span; g: number }[]) => {
    list.sort((a, b) => (toks[b.span[1] - 1].b - toks[b.span[0]].a) - (toks[a.span[1] - 1].b - toks[a.span[0]].a))
    for (const { span: [a, b], g } of list) {
      for (let i = a; i < b; i++) for (let o = toks[i].a; o < toks[i].b; o++) { const f = o2f[o]; if (f >= 0) paint[f] = g }
    }
  }
  paintSpans(cands.flatMap((g, gi) => g.spans.map((span) => ({ span, g: gi }))))

  // Recursive SQL run by a row source is in that plan line's self time; run anywhere else (a function of the select list
  // is called as rows are handed to the client, not by a plan line) it is in no plan line at all. Every call of a function
  // that is not a built-in is placed: none in a fragment of a plan line, the recursive SQL is outside the plan; all in such
  // fragments, it is inside, unless (exact numbers only) it took longer than those fragments' self time, when the excess
  // is outside; some in and some out, the split is not known (only an excess is certain). Tinted on the calls when they
  // call one function.
  const cover = input.cover ?? null
  const kids = input.children ?? []
  const fn = P.fns.length === 1 ? P.fns[0] : null
  const names = P.fns.map((f) => f.name).join(', ')
  const holders = P.calls.map((c) => { const f = o2f[toks[c.at].a]; return f >= 0 ? paint[f] : -1 })
  const where: Where = !P.calls.length ? 'none' : holders.every((h) => h < 0) ? 'outside' : holders.every((h) => h >= 0) ? 'inside' : 'mixed'
  let outside: { us: number; why: string; tint: boolean } | null = null
  if (cover && cover.recursiveUs > 0 && kids.length > 0) {
    const room = where === 'none' ? planUs : [...new Set(holders.filter((h) => h >= 0))].reduce((a, h) => a + cands[h].us, 0)
    if (where === 'outside') {
      outside = { us: cover.recursiveUs, tint: !!fn, why: `${names} ${P.fns.length === 1 ? 'is' : 'are'} called outside every fragment a plan line evaluates, so the recursive SQL ${P.fns.length === 1 ? 'it runs' : 'they run'} is not in a plan line's time` }
    } else if (cover.exact && cover.recursiveUs > room) {
      outside = {
        us: cover.recursiveUs - room, tint: where === 'inside' && !!fn,
        why: `the recursive SQL under these calls (${fmtDur(cover.recursiveUs)}) took longer than ${where === 'none' ? 'the plan lines' : `the self time of the fragments that call ${names}`} (${fmtDur(room)}): the rest cannot be in a plan line`,
      }
    }
  }
  const basis: HeatOk['basis'] = outside ? 'calls' : 'plan'
  const total = outside && cover ? Math.max(cover.elapsedUs, planUs + outside.us) : planUs
  if (outside?.tint && fn) {
    const mine = P.calls.filter((c) => c.name.toUpperCase() === fn.name.toUpperCase())
    const approx = [`the recursive SQL is taken to run in ${fn.name}, the one function of the text that is not an Oracle built-in`, outside.why]
    if (cover && !cover.exact) approx.push('averaged over the statement\'s executions')
    cands.push({ what: 'outside the plan: recursive SQL', approx, xs: [], spans: mine.map((c): Span => [c.at, c.end]), us: outside.us, recursive: { fn: fn.name, statement: kids[0].statement } })
    paintSpans(mine.map((c) => ({ span: [c.at, c.end] as Span, g: cands.length - 1 })))
  }

  // blanks between two characters of one group on one line belong to it
  const starts: number[] = [0]
  for (let f = 0; f < formatted.length; f++) if (formatted[f] === '\n') starts.push(f + 1)
  for (let f = 0; f < formatted.length; f++) {
    if (paint[f] >= 0 || formatted[f] !== ' ') continue
    let l = f - 1
    while (l >= 0 && formatted[l] === ' ') l--
    let r = f + 1
    while (r < formatted.length && formatted[r] === ' ') r++
    if (l >= 0 && r < formatted.length && formatted[l] !== '\n' && formatted[r] !== '\n' && paint[l] >= 0 && paint[l] === paint[r]) {
      for (let k = l + 1; k < r; k++) paint[k] = paint[l]
    }
    f = r - 1
  }
  const lineOf = (f: number) => { let lo = 0, hi = starts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (starts[m] <= f) lo = m; else hi = m - 1 } return lo }
  const first = new Array<number>(cands.length).fill(-1), last = new Array<number>(cands.length).fill(-1)
  for (let f = 0; f < formatted.length; f++) {
    const g = paint[f]
    if (g < 0) continue
    const ln = lineOf(f)
    if (first[g] < 0) first[g] = ln
    last[g] = ln
  }
  // the groups that reached the text, by time; one that reached no character is not placed after all
  const order = cands.map((_, gi) => gi).filter((gi) => first[gi] >= 0)
    .sort((a, b) => cands[b].us - cands[a].us || cands[a].spans[0][0] - cands[b].spans[0][0])
  const remap = new Int32Array(cands.length).fill(-1)
  order.forEach((gi, k) => { remap[gi] = k })
  const out: HeatSeg[][] = []
  for (let k = 0; k < starts.length; k++) {
    const s = starts[k], e = k + 1 < starts.length ? starts[k + 1] - 1 : formatted.length
    const segs: HeatSeg[] = []
    for (let f = s; f < e;) {
      let g = f
      while (g < e && paint[g] === paint[f]) g++
      segs.push({ text: formatted.slice(f, g), group: paint[f] >= 0 ? remap[paint[f]] : -1 })
      f = g
    }
    out.push(segs)
  }
  const groups: HeatGroup[] = order.map((gi) => {
    const g = cands[gi]
    return {
      what: g.what,
      parts: g.xs.map(part).sort((a, b) => a.id - b.id),
      selfUs: g.us,
      share: g.us / total,
      ...(g.recursive ? { recursive: g.recursive } : {}),
      approx: g.approx,
      firstLine: first[gi],
      lastLine: last[gi],
    }
  })
  const placed = new Set(order.flatMap((gi) => cands[gi].xs))
  const restLines = nodes.filter((x) => !placed.has(x))
  const restLinesUs = restLines.reduce((a, x) => a + x.selfUs, 0)
  const outGroup = groups.findIndex((g) => !!g.recursive)
  const outsideRes = outside ? { us: outside.us, share: outside.us / total, group: outGroup, why: outside.why } : null
  const restUs = outside ? Math.max(0, total - planUs - outside.us) : 0
  const rest = outside ? { us: restUs, share: restUs / total } : null

  // ≈ the one function of the text that is not a built-in runs the recursive statement under this one
  const callouts: HeatCallout[] = []
  if (fn && kids.length > 0) {
    const f = o2f[toks[fn.at].a]
    if (f >= 0) {
      const ln = lineOf(f)
      const child = kids[0]
      callouts.push({ line: ln, col: f - starts[ln], fn: fn.name, child, perExec: input.executions > 0 ? child.executions / input.executions : 0, others: kids.length - 1 })
    }
  }
  const res: HeatOk = {
    ok: true,
    lines: out,
    groups,
    unplaced: { parts: restLines.map(part).sort((a, b) => a.id - b.id), selfUs: restLinesUs, share: restLinesUs / total },
    planUs,
    basis,
    totalUs: total,
    cover,
    outside: outsideRes,
    rest,
    account: [],
    callouts,
    notes: flow.notes,
  }
  res.account = accountOf(res, names, where)
  return res
}

/** "the first execution", "execution #3", "the 4 executions", "an average execution" */
export function coveredWord(c: HeatCover): string {
  if (!c.exact && c.execNo === 0) return c.executions === 1 ? 'an average execution' : `${c.executions} average executions`
  if (c.executions > 1) return `the ${c.executions} executions`
  return c.execNo <= 1 ? 'the first execution' : `execution #${c.execNo}`
}

/** What the plan lines account for of the covered executions, and what the shares are of. */
type Where = 'none' | 'inside' | 'outside' | 'mixed'

/** What the plan lines account for of the covered executions, and what the shares are of. `names`: the functions of the text that are not built-ins; `where`: where their calls sit. */
function accountOf(h: HeatOk, names: string, where: Where): string[] {
  const c = h.cover
  if (!c) return [`The shares are of the plan lines' self time, ${fmtDur(h.planUs)}; the executions this dump covers are not known, so it is not compared with the statement's time.`]
  const which = coveredWord(c)
  const out: string[] = []
  if (!c.exact) {
    out.push(c.executions === 1
      ? `The plan lines account for ${fmtDur(h.planUs)}; an execution of this statement takes ${fmtDur(c.elapsedUs)} in its EXEC and FETCH calls on average (the document has no call facts for the execution this dump covers).`
      : `The plan lines account for ${fmtDur(h.planUs)}; ${c.executions} executions of this statement take ${fmtDur(c.elapsedUs)} in their EXEC and FETCH calls on average (the document has no call facts for the executions this dump covers).`)
  } else {
    out.push(h.planUs > c.elapsedUs
      ? `The plan lines report ${fmtDur(h.planUs)}, more than the ${fmtDur(c.elapsedUs)} of the EXEC and FETCH calls of ${which}, which this dump covers: row-source times are sampled.`
      : `The plan lines account for ${fmtDur(h.planUs)} of ${fmtDur(c.elapsedUs)}, the EXEC and FETCH calls of ${which}, which this dump covers.`)
  }
  if (h.outside) {
    const by = h.outside.group >= 0 ? ` (≈, on ${names})` : where === 'none' ? ' (≈, from no function of the text: not placed in it)' : ` (≈, from ${names}: not placed in the text)`
    out.push(`Recursive SQL outside the plan lines takes ${fmtDur(h.outside.us)}${by}, and ${fmtDur(h.rest?.us ?? 0)} are in neither. The shares are of the ${fmtDur(h.totalUs)} of these calls.`)
  } else {
    if (c.recursiveUs > 0) {
      const r = fmtDur(c.recursiveUs)
      out.push(where === 'inside'
        ? `The recursive SQL under these calls, ${r}, runs in plan lines (${names} ${names.includes(',') ? 'are' : 'is'} called only in fragments plan lines evaluate) and is part of their time.`
        : where === 'mixed'
          ? `The recursive SQL under these calls, ${r}, may run partly outside the plan lines: ${names} ${names.includes(',') ? 'are' : 'is'} called both in fragments plan lines evaluate and outside them, so the split is not known.`
          : `The text calls no function of its own, so where the recursive SQL under these calls (${r}) runs is not known.`)
    }
    out.push(`The shares are of the plan lines' ${fmtDur(h.planUs)}.`)
  }
  return out
}

// ---- from the document

/**
 * The recursive statements run under `stmt` that are not dictionary SQL (parsed by SYS), the slowest first, with their
 * executions under it: counted from the call facts when the document has them, else the statement's executions when it
 * runs under this statement only, else its executions shared out by calls (inexact).
 */
export function heatChildren(doc: TraceDoc, stmt: ID): HeatChild[] {
  const links = doc.stats.statements[stmt]?.children ?? []
  const calls = doc.calls
  const out: HeatChild[] = []
  for (const l of links) {
    const st = doc.statements[l.statement]
    const cs = doc.stats.statements[l.statement]
    if (!st || !cs || st.kind !== 0 || st.parsingUserId === 0) continue
    let executions = 0
    let exact = true
    if (calls.n > 0) {
      for (const i of doc.callsByStmt.get(l.statement)) {
        if (calls.kind[i] !== CallKind.exec) continue
        const p = calls.parent[i]
        if (p >= 0 && p < calls.n && calls.stmt[p] === stmt) executions++
      }
    }
    if (executions === 0) {
      const parents = cs.parents ?? []
      if (parents.length <= 1) executions = cs.executions
      else {
        const sum = parents.reduce((a, p) => a + p.calls, 0)
        executions = sum > 0 ? Math.round((cs.executions * l.calls) / sum) : 0
        exact = false
      }
    }
    out.push({ statement: l.statement, executions, elapsedUs: l.elapsed, exact })
  }
  return out.sort((a, b) => b.elapsedUs - a.elapsedUs)
}

/** How many executions a dump's numbers add up: its main row source's starts (the last top line: a scalar subquery beside it starts once per row). */
export function dumpExecutions(lines: readonly PlanLine[]): number {
  const top = lines.filter((l) => l.parentId === 0)
  const main = top.sort((a, b) => a.pos - b.pos || a.id - b.id)[top.length - 1]
  return Math.max(1, main?.starts ?? 1)
}

/**
 * The executions dump `plan` covers (`dumpExecutions` of them: the last ones of its cursor whose EXEC is before the dump)
 * and their time: from the call facts when the document has them; else the statement's averages per execution (exact
 * when the dump covers all of them). `userStmts`: the recursive statements that count (`heatChildren`). Null: no
 * execution of the cursor before the dump, or nothing to go by.
 */
export function heatCover(doc: TraceDoc, plan: Plan, lines: readonly PlanLine[], userStmts: readonly ID[]): HeatCover | null {
  try {
    const n = dumpExecutions(lines)
    const c = doc.calls
    if (c.n > 0) {
      const exs: { execNo: number; own: number[] }[] = []
      for (const i of doc.callsByStmt.get(plan.statement)) {
        if (c.cursor[i] !== plan.cursor || c.line[i] > plan.line) continue
        if (c.kind[i] === CallKind.exec) exs.push({ execNo: c.execNo[i], own: [i] })
        else if (c.kind[i] === CallKind.fetch && exs.length && exs[exs.length - 1].execNo === c.execNo[i]) exs[exs.length - 1].own.push(i)
      }
      if (!exs.length) return null
      const covered = exs.slice(-n)
      const own = new Set(covered.flatMap((e) => e.own))
      let elapsedUs = 0
      for (const i of own) elapsedUs += c.e[i]
      let recursiveUs = 0
      for (const s of userStmts) for (const i of doc.callsByStmt.get(s)) if (own.has(c.parent[i])) recursiveUs += c.e[i]
      return { executions: covered.length, execNo: covered[0].execNo, elapsedUs, recursiveUs, exact: true }
    }
    const st = doc.stats.statements[plan.statement]
    if (!st || st.executions <= 0) return null
    const k = Math.min(n, st.executions)
    const users = new Set(userStmts)
    const rec = (st.children ?? []).filter((l) => users.has(l.statement)).reduce((a, l) => a + l.elapsed, 0)
    const all = k >= st.executions
    return {
      executions: k, execNo: all ? 1 : 0, exact: all,
      elapsedUs: ((st.exec.elapsed + st.fetch.elapsed) * k) / st.executions, recursiveUs: (rec * k) / st.executions,
    }
  } catch {
    return null
  }
}

/**
 * The cover of one execution from its execution trace (`DataSource.executionTrace`, for a document without call facts):
 * its EXEC and FETCH calls and the recursive statements of `userStmts` directly under them. Null when the trace was cut.
 */
export function heatCoverOfTrace(trace: ExecTrace, userStmts: readonly ID[]): HeatCover | null {
  try {
    if (trace.truncated) return null
    const own = trace.calls.filter((x) => x.kind === CallKind.exec || x.kind === CallKind.fetch)
    const exec = own.find((x) => x.kind === CallKind.exec)
    if (!exec) return null
    const ids = new Set(own.map((x) => x.id))
    const users = new Set(userStmts)
    const recursiveUs = trace.children.filter((x) => ids.has(x.parent) && users.has(x.stmt)).reduce((a, x) => a + x.e, 0)
    return { executions: 1, execNo: exec.execNo, elapsedUs: own.reduce((a, x) => a + x.e, 0), recursiveUs, exact: true }
  } catch {
    return null
  }
}

/** What `sqlHeat` needs for one plan dump of a statement. Never throws. */
export function heatInput(doc: TraceDoc, plan: Plan): HeatInput {
  const text = doc.statements[plan.statement]?.text ?? ''
  try {
    const lines = doc.planLines.slice(plan.first, plan.first + plan.n)
    const children = heatChildren(doc, plan.statement)
    return {
      text, lines, children,
      executions: doc.stats.statements[plan.statement]?.executions ?? 0,
      cover: heatCover(doc, plan, lines, children.map((k) => k.statement)),
    }
  } catch {
    return { text, lines: [], executions: 0 }
  }
}
