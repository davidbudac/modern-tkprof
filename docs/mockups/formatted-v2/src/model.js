// ---- the data: rows.json (the spec's excerpts) + extra.json (the lines the excerpts stop short of, from the same trace) ----------
// DATA = { rows: [...], extra: {...} } is inlined by build.mjs.

/** rows.json clocks are tim-anchored on the *** TIME mark; the app anchors on the wait after it, 619 µs later (checked against
 *  io_waits-plan-light.png: row 99 is 11:35:29.828061 there and .827442 in rows.json). Every clock here is corrected by it. */
const CLOCK_FIX_US = 619
const SPAN_US = DATA.extra.span.us                 // first tim to last tim of the file: 6.46 s
const HOT_US = SPAN_US * 0.01                        // a hot spot takes 1 % of the traced time or more
const SCALE_US = 2448362                             // the Δ column's bar: full = the longest line of the file (the 2.448 s sort)
const TIM0 = 10805134758, T0 = ((11 * 60 + 35) * 60 + 29) * 1e6 + 826769 + CLOCK_FIX_US
const timToUs = (tim) => T0 + (tim - TIM0)

// ---- events: wait class → role (colour) ----------------------------------------------------------------------------------------
const EVENT = {
  'direct path read': 'userio', 'db file sequential read': 'userio', 'direct path read temp': 'userio', 'Disk file operations I/O': 'userio',
  'SQL*Net message to client': 'network', 'SQL*Net more data to client': 'network', 'SQL*Net message from client': 'idle',
  'enq: KO - fast object checkpoint': 'other', 'PGA memory operation': 'other', 'reliable message': 'other', 'asynch descriptor resize': 'other',
}
const roleOf = (nam) => EVENT[nam] || 'other'
const ROLE_VAR = { userio: '--c-userio', sysio: '--c-sysio', network: '--c-network', idle: '--c-idle', other: '--c-other', commit: '--c-commit', concurrency: '--c-concurrency', cpu: '--c-cpu' }
const ROLE_NAME = { userio: 'User I/O', network: 'Network', idle: 'Idle', other: 'Other' }
const CLOSE_TYPES = { 0: 'hard close', 1: 'soft close, kept in the cursor cache', 2: 'soft close', 3: 'already in the cursor cache' }
const COMMANDS = { 2: 'INSERT', 3: 'SELECT', 42: 'ALTER SESSION', 47: 'PL/SQL EXECUTE' }

// ---- statement colours: the top 8 statements by elapsed time take the categorical slots in order, the rest are quiet (--c-idle) ------
const LANE_TOKEN = {
  '52nzchs09dgn1': 'var(--c-cpu)', '4w3wvjbkvq24v': 'var(--c-network)', c7ry5gr75qv4b: 'var(--c-userio)', '7r10y07tqpg98': 'var(--c-other)',
  dcxgz5g2j9ts2: 'var(--c-sysio)', dk21j71dpu26c: 'var(--c-concurrency)', f9xbak7zf0a4a: 'var(--c-commit)',
  '64y0jakbjfvm9': 'color-mix(in oklch, var(--c-cpu) 65%, var(--surface-raised))',
}
const laneColor = (sqlid) => LANE_TOKEN[sqlid] || 'var(--c-idle)'
/** per statement: what the sticky label's third line and the chips need (calls / waits / execs / time are the app's own numbers for the file) */
const STMT = {
  c7ry5gr75qv4b: { total: '638 ms', execs: 1, calls: 5, waits: 34 },
  '52nzchs09dgn1': { total: '2.486 s', execs: 1, calls: 205, waits: 1000 },
  dk21j71dpu26c: { total: '11.5 ms', execs: 300, calls: 901, waits: 0 },
}

// ---- the pool of rows, in segments of contiguous lines -----------------------------------------------------------------------
const SEGS = []
const byLn = new Map()   // line -> row (all segments)
const SQLTEXT = {}       // sqlid -> text (the lines between a CURSOR row and its END OF STMT)

function buildSegments() {
  const rowsOf = (list) => list.flatMap((e) => e.rows)
  const ex = DATA.extra.excerpts
  const ext = (from) => ex.find((e) => e.from === from).rows
  const rj = (from) => DATA.rows.find((e) => e.from === from).rows
  const mk = (id, rows, o) => SEGS.push({ id, rows: rows.map((r) => ({ ...r })), ...o })
  mk('hdr', rj(23), { contBefore: false, prevTim: DATA.extra.prevTim['23'] })
  mk('cur', [...ext(84), ...rj(95), ...ext(141)], { contBefore: false, prevTim: DATA.extra.prevTim['84'] })
  mk('loop', [...rj(2960), ...ext(3011)], { contBefore: true, init: { '139745603983880': 'dk21j71dpu26c' }, prevTim: DATA.extra.prevTim['2960'] })
  mk('fetch', [...rj(10355), ...ext(10402)], { contBefore: true, init: { '139745604251096': '52nzchs09dgn1' }, prevTim: DATA.extra.prevTim['10355'] })
  // sql texts of the two statements the loop / sort excerpts start inside of
  for (const from of [792, 6878]) { let sid = null, text = []; for (const r of ext(from)) { if (r.k === 'CURSOR') { sid = r.sqlid; text = [] } else if (r.k === 'TEXT') text.push(r.text); else if (r.k === 'ENDSTMT' && sid) SQLTEXT[sid] = text } }
  for (const s of SEGS) annotate(s)
  for (const s of SEGS) for (const r of s.rows) byLn.set(r.ln, r)
  // SQL texts of every cursor in the segments
  for (const s of SEGS) { let sid = null, text = []; for (const r of s.rows) { if (r.k === 'CURSOR') { sid = r.sqlid; text = [] } else if (r.k === 'TEXT' && sid && !/^\*\*\*/.test(r.text)) text.push(r.text); else if (r.k === 'ENDSTMT' && sid) { SQLTEXT[sid] = text; sid = null } } }
}

const FRAMING = new Set(['BLANK', 'RULE', 'MARK'])
const isFraming = (r) => FRAMING.has(r.k) || (r.k === 'TEXT' && /^\*\*\*/.test(r.text))

/** Parse the wait parameters in file order, as the app (readable.ts parseWait): the first three, `obj#` and `tim` left out. */
function parseWaitParams(raw) {
  const m = /^WAIT\s+#(\d+):\s*nam='(.*)'\s+ela=\s*(-?\d+)\s*(.*)$/.exec(raw)
  const rest = m[4], tail = rest.search(/\bobj#=|\btim=/)
  const out = []
  for (const x of (tail < 0 ? rest : rest.slice(0, tail)).matchAll(/([^=]+)=(\S*)/g)) out.push({ label: x[1].trim(), value: x[2] })
  return out.slice(0, 3)
}

function annotate(seg) {
  const rows = seg.rows
  const curMap = {}
  let n = 0
  // recursive SQL (dep 1): the three statements of the excerpts whose CURSOR line is not in them
  const DEEP = { '10gywwmwk6xfy': 1, dbvj6jc977hqh: 1, dk21j71dpu26c: 1 }
  const mkInst = (sqlid, cur, dep) => ({ id: ++n, sqlid, cur, depth: dep || DEEP[sqlid] || 0 })
  for (const [cur, sid] of Object.entries(seg.init || {})) curMap[cur] = mkInst(sid, cur, sid === 'dk21j71dpu26c' ? 1 : 0)
  let inst = Object.values(curMap)[0] || null   // a segment that starts inside a statement
  const prevT = seg.prevTim ? timToUs(seg.prevTim.tim) : null
  let lastT = prevT
  let lastDur = null
  for (const r of rows) {
    // the cursor instance (a cursor number is reused for other statements: the instance is what a lane is)
    if (r.k === 'CURSOR') { inst = mkInst(r.sqlid, r.cur, r.dep); curMap[r.cur] = inst; r.inst = inst }
    else if (r.cur !== undefined) {
      if (r.cur === '0') { r.inst = null; inst = null }
      else {
        // a cursor parsed before this segment: rows.json knows its sql_id, except for the one cursor number that several statements reuse
        r.inst = curMap[r.cur] || (curMap[r.cur] = mkInst(r.cur === '139745604251096' ? null : r.sqlid || null, r.cur, 0))
        inst = r.inst
      }
    } else if (!isFraming(r)) r.inst = inst
    // time
    if (r.clock && r.k !== 'MARK') r.t = clockToUs(r.clock) + CLOCK_FIX_US
    if (r.k === 'WAIT') { r.dur = r.ela; r.role = roleOf(r.nam); r.params = parseWaitParams(r.raw) }
    if (['PARSE', 'EXEC', 'FETCH', 'CLOSE'].includes(r.k)) r.dur = r.e
    if (r.t !== undefined) {
      r.delta = lastT === null ? undefined : r.t - lastT
      r.prevDur = lastDur
      r.prevT = lastT
      lastT = r.t; lastDur = r.dur ?? 0
    }
    if (r.dur !== undefined && r.role !== 'idle') r.hot = r.dur >= HOT_US
    if (r.k === 'EXEC' && DATA.extra.loopExec[r.ln]) { r.execNo = DATA.extra.loopExec[r.ln][0]; r.execTotal = DATA.extra.loopExec[r.ln][1] }
    if (r.k === 'MARK') r.clock = r.at.slice(11, 26).replace(/\+.*/, '').padEnd(15, '0').slice(0, 15)
  }
  // framing rows join the lane when the cursor before and after is the same one (the app looks 40 lines each way)
  const LOOK = 40
  const keys = rows.map((r) => (isFraming(r) ? undefined : r.inst ? r.inst.id : -1))
  rows.forEach((r, i) => {
    if (keys[i] !== undefined) return
    const near = (dir) => { for (let k = 1, x = i + dir; k <= LOOK; k++, x += dir) { if (x < 0 || x >= rows.length) return -2; if (keys[x] !== undefined) return keys[x] } return -2 }
    const a = near(-1), b = near(1)
    keys[i] = a >= 0 && a === b ? a : -1
    if (keys[i] >= 0) r.inst = rows.find((q) => q.inst && q.inst.id === keys[i]).inst
  })
  rows.forEach((r, i) => {
    r.laneKey = keys[i]
    if (keys[i] < 0) return
    const before1 = i >= 1 ? keys[i - 1] : (seg.contBefore ? keys[i] : -1)
    const before2 = i >= 2 ? keys[i - 2] : (i === 1 ? (seg.contBefore ? keys[i] : -1) : (seg.contBefore ? keys[i] : -1))
    r.laneFirst = before1 !== keys[i]
    r.laneSecond = !r.laneFirst && before2 !== keys[i]
  })
}

// ---- bind blocks: a BINDS row, its blank line, then Bind#N rows each with 4 attribute lines ---------------------------------------
const BIND_TYPES = { '01': 'VARCHAR2', '02': 'NUMBER', '12': 'DATE', '96': 'CHAR' }
function bindNamesOf(sqlid, n) {
  const text = (SQLTEXT[sqlid] || []).join(' ')
  const seen = []
  for (const m of text.matchAll(/:([A-Za-z_][\w$#]*|\d+)/g)) if (!seen.includes(m[1])) seen.push(m[1])
  return Array.from({ length: n }, (_, i) => ':' + (seen[i] ?? i))
}
function bindValue(typeCode, raw) {
  let v = raw
  if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1)
  if (typeCode === '12') { const m = /^(\d+)\/(\d+)\/(\d+) (\d+:\d+:\d+)$/.exec(v); if (m) v = `${m[3]}-${m[1]}-${m[2]}T${m[4]}` }
  return v
}
/** The binds of the BINDS row at index i of seg.rows, with the line each Bind# is on. */
function bindsOf(seg, i) {
  const rows = seg.rows, head = rows[i]
  const binds = []
  let cur = null
  for (let k = i + 1; k < rows.length; k++) {
    const r = rows[k]
    if (r.k === 'BLANK') continue
    if (r.k === 'BIND') { cur = { pos: r.pos, ln: r.ln, attrLns: [], type: '', value: '' }; binds.push(cur); continue }
    if (r.k === 'BINDATTR' && cur) {
      cur.attrLns.push(r.ln)
      const t = r.text
      if (t.startsWith('oacdty=')) cur.typeCode = t.slice(7, 9)
      if (t.startsWith('value=')) cur.raw = t.slice(6)
      continue
    }
    break
  }
  const names = bindNamesOf(head.sqlid || (head.inst && head.inst.sqlid), binds.length)
  for (const b of binds) { b.name = names[b.pos]; b.type = BIND_TYPES[b.typeCode] || b.typeCode; b.value = bindValue(b.typeCode, b.raw ?? ''); b.last = b === binds[binds.length - 1] }
  return binds
}
/** Every BINDS row also knows its binds (the full block may continue past the end of the pool: the 8-bind block of dbvj6jc977hqh does not). */
function indexBinds() {
  for (const seg of SEGS) {
    seg.rows.forEach((r, i) => {
      if (r.k === 'BINDS') { r.binds = bindsOf(seg, i); r.sqlidResolved = r.inst && r.inst.sqlid }
    })
    // the bind rows know their BINDS row; a Bind# row at the start of the segment belongs to a BINDS row above it
    let cur = null
    seg.rows.forEach((r) => {
      if (r.k === 'BINDS') cur = r
      else if (r.k === 'BIND') {
        if (!cur) { // orphan at the start of the segment: its block started above the first row (the loop excerpt)
          const sid = r.inst && r.inst.sqlid
          const attrs = seg.rows.filter((q) => q.k === 'BINDATTR' && q.ln > r.ln && q.ln <= r.ln + 4)
          const fake = { k: 'BINDS', ln: r.ln - 2, inst: r.inst, binds: [], orphan: true }
          const b = { pos: r.pos, ln: r.ln, attrLns: attrs.map((q) => q.ln), last: true }
          for (const q of attrs) { if (q.text.startsWith('oacdty=')) b.typeCode = q.text.slice(7, 9); if (q.text.startsWith('value=')) b.raw = q.text.slice(6) }
          b.name = bindNamesOf(sid, 1)[0]; b.type = BIND_TYPES[b.typeCode]; b.value = bindValue(b.typeCode, b.raw ?? '')
          fake.binds.push(b); r.bindsRow = fake; cur = fake
        } else r.bindsRow = cur
      }
    })
  }
}

buildSegments()
indexBinds()
const segOf = (ln) => SEGS.find((s) => s.rows.length && ln >= s.rows[0].ln && ln <= s.rows[s.rows.length - 1].ln)
const rowsIn = (a, b) => { const s = segOf(a); return s.rows.filter((r) => r.ln >= a && r.ln <= b) }
