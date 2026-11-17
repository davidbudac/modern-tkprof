// The throwaway parser of the dump-reader mock-up. Reads the real diag fixtures and writes, per state, a small model
// (data/<key>.js, with the same JSON in data/<key>.json) and the slice of raw text the page shows (data/<key>.txt.js).
//   node tools/parse.mjs
// Nothing here is the product's parser: it knows these four files. Every number the page shows comes from here.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const ROOT = join(here, '..', '..', '..', '..')
const OUT = join(here, '..', 'data')
mkdirSync(OUT, { recursive: true })

const FILES = {
  errorstack: { path: 'testdata/diag/19c/diag_errorstack_l2.trc', title: 'Error stack, level 2' },
  heap: { path: 'testdata/diag/19c/diag_heap_sub.trc', title: 'Heap dump with sub-heaps' },
  sysstate: { path: 'testdata/big/diag/diag_sysstate_l266.trc', title: 'System state, level 266' },
  hang: { path: 'testdata/diag/19c/diag_hang.trc', title: 'Hang analysis, level 3' },
}

const num = (s) => Number(String(s).replace(/,/g, ''))
const trimR = (s) => s.replace(/\s+$/, '')
const stats = {}

// ---- small helpers over a 1-indexed line array ---------------------------------------------------------------------------------------------
function lines1(text) {
  const a = text.split('\n')
  if (a.length && a[a.length - 1] === '') a.pop()
  return a.map((l) => l.replace(/\r$/, ''))
}
const at = (L, ln) => L[ln - 1] ?? ''

function header(L) {
  const h = { markers: {} }
  for (let i = 1; i <= Math.min(L.length, 60); i++) {
    const s = at(L, i)
    let m
    if ((m = /^Trace file (.+)$/.exec(s))) h.traceFile = m[1]
    else if ((m = /^Oracle Database (.+)$/.exec(s))) h.release = m[1]
    else if ((m = /^Version (\S+)/.exec(s))) h.version = m[1]
    else if ((m = /^Instance name: (\S+)/.exec(s))) h.instance = m[1]
    else if ((m = /^Database name: (\S+)/.exec(s))) h.database = m[1]
    else if ((m = /^Node name:\s+(\S+)/.exec(s))) h.node = m[1]
    else if ((m = /^Oracle process number: (\d+)/.exec(s))) h.orapid = +m[1]
    else if ((m = /^Unix process pid: (\d+)/.exec(s))) h.ospid = +m[1]
    else if ((m = /^\*\*\* (SESSION ID|CLIENT ID|SERVICE NAME|MODULE NAME|ACTION NAME|CLIENT DRIVER|CONTAINER ID):\((.*?)\)/.exec(s))) h.markers[m[1]] = m[2]
  }
  return h
}

// ---- outline nodes ---------------------------------------------------------------------------------------------------------------------------
function Ids() {
  let k = 0
  return (p = 'n') => `${p}${++k}`
}
function node(id, label, from, to, kind, x = {}) {
  return { id, label, kind, from, to, n: to - from + 1, children: [], ...x }
}
/** Put `child` under the deepest node of `parent` that contains it (children stay ordered and inside). */
function place(parent, child) {
  for (const c of parent.children) if (c.from <= child.from && child.to <= c.to && !(c.from === child.from && c.to === child.to)) return place(c, child)
  parent.children.push(child)
  parent.children.sort((a, b) => a.from - b.from)
  return child
}
function walk(n, f, d = 0) {
  f(n, d)
  for (const c of n.children) walk(c, f, d + 1)
}

// ---- noise folds, shared by the file kinds -----------------------------------------------------------------------------------------------------
const HEX_ROW = /^\s*[0-9A-Fa-f]{8,16}(?: [0-9A-Fa-f]{8})+\s+\[.*\]\s*$|^\s*[0-9A-Fa-f]{8,16}\s+(?:[0-9A-Fa-f]{8} ?)+\s*\[.*\]\s*$|^\s*Repeat \d+ times\s*$/
function memoryFolds(L, from, to, folds) {
  for (let i = from; i <= to; i++) {
    const m = /^\s*Dump of memory from 0x([0-9A-Fa-f]+) to 0x([0-9A-Fa-f]+)/.exec(at(L, i))
    if (!m) continue
    let j = i
    while (j + 1 <= to && (HEX_ROW.test(at(L, j + 1)) || /^\s*[0-9A-Fa-f]{8,16}\s.*\[/.test(at(L, j + 1)) || /^\s*Repeat \d+ times/.test(at(L, j + 1)))) j++
    const bytes = parseInt(m[2], 16) - parseInt(m[1], 16)
    if (j - i >= 3) folds.push({ from: i, to: j, kind: 'memory', reason: `memory dump${bytes > 0 && bytes < 1e8 ? `, ${bytes.toLocaleString('en-US')} bytes` : ''}` })
    i = j
  }
}
function atomicLogFolds(L, from, to, folds) {
  // `KGX Atomic Operation Log 0x..` plus its more-indented lines; three or more in a row are one fold
  let i = from
  while (i <= to) {
    const m = /^(\s*)KGX Atomic Operation Log /.exec(at(L, i))
    if (!m) { i++; continue }
    const ind = m[1].length
    const start = i
    let j = i, count = 0
    for (;;) {
      const mm = /^(\s*)KGX Atomic Operation Log /.exec(at(L, j))
      if (!mm || mm[1].length !== ind) break
      let k = j + 1
      while (k <= to && /^\s+/.exec(at(L, k)) && at(L, k).match(/^\s*/)[0].length > ind) k++
      count++
      j = k
    }
    if (count >= 3) folds.push({ from: start, to: j - 1, kind: 'mutex', reason: `${count} mutex operation logs, all idle` })
    i = Math.max(j, i + 1)
  }
}

// ======================================================================================================================================================
//  State objects (process state): the tree, and the readings taken from it
// ======================================================================================================================================================
const SO_RE = /^( *)SO: (0x[0-9a-f]+), type: (.+?) \((\d+)\), map: (0x[0-9a-f]+)/

function buildSoTree(L, from, to, ids, idp = 'so') {
  // returns the roots (normally one process) with their children, each node spanning its own text and its children's
  const list = []
  for (let i = from; i <= to; i++) {
    const m = SO_RE.exec(at(L, i))
    if (!m) continue
    let start = i
    if (/^\s+-{20,}\s*$/.test(at(L, i - 1))) start = i - 1
    list.push({ i, start, indent: m[1].length, addr: m[2], type: m[3], typeNo: +m[4] })
  }
  const roots = []
  const stack = []
  for (let k = 0; k < list.length; k++) {
    const e = list[k]
    while (stack.length && stack[stack.length - 1].indent >= e.indent) stack.pop()
    const nd = node(ids(idp), e.type, e.start, to, 'so', { so: e.type, soNo: e.typeNo, addr: e.addr, indent: e.indent })
    if (stack.length) stack[stack.length - 1].children.push(nd)
    else roots.push(nd)
    stack.push(nd)
  }
  // ranges: a node ends where the next node of the same or a lower indent starts
  const flat = []
  const w = (n) => { flat.push(n); n.children.forEach(w) }
  roots.forEach(w)
  const byStart = flat.map((n) => n)
  for (const n of flat) {
    // find the next node in file order whose indent <= n.indent
    const idx = byStart.indexOf(n)
    let end = to
    for (let k = idx + 1; k < byStart.length; k++) if (byStart[k].indent <= n.indent) { end = byStart[k].from - 1; break }
    n.to = end
    n.n = n.to - n.from + 1
  }
  return roots
}

function soLabel(L, n) {
  // a short identity for a state object, read from its own lines
  let s = ''
  const lim = Math.min(n.to, n.from + 80)
  const find = (re) => { for (let i = n.from; i <= lim; i++) { const m = re.exec(at(L, i)); if (m) return m } return null }
  let m
  switch (n.so) {
    case 'process': if ((m = find(/\(process\) Oracle pid:(\d+), ser:(\d+)/))) s = `Oracle pid ${m[1]}, ser ${m[2]}`; break
    case 'session': if ((m = find(/\(session\) sid: (\d+) ser: (\d+)/))) { s = `${m[1]}.${m[2]}`; const u = find(/user#\/name: \d+\/(\S+)/); if (u) s += ` ${u[1]}` } break
    case 'LIBRARY OBJECT LOCK':
    case 'LIBRARY OBJECT PIN': {
      const nm = find(/ObjectName:\s+Name=(.*)$/)
      const md = find(/(?:LibraryObjectLock|LibraryObjectPin):\s+Address=\S+ Handle=\S+ Mode=(\w)/)
      if (nm) s = trimR(nm[1])
      n.mode = md ? md[1] : null
      break
    }
    case 'enqueue': {
      const q = find(/\(enqueue\) (\S+)/); const md = find(/mode: (\w+), lock_flag/)
      if (q) s = q[1]
      if (md) { s += ` mode ${md[1]}`; n.mode = md[1] }
      if (q) n.enq = q[1]
      break
    }
    case 'call': if ((m = find(/\(call\) .*depth:(\d+)/))) s = `depth ${m[1]}`; break
    default: break
  }
  return s
}

/** Group three or more consecutive siblings of one type; label each node; set the outline kind and reading. */
function dressSo(L, roots, ids, readingKey) {
  const go = (n) => {
    n.sub = soLabel(L, n)
    n.label = n.so === 'LIBRARY OBJECT LOCK' ? 'Library object lock' : n.so === 'LIBRARY OBJECT PIN' ? 'Library object pin' : n.so
    n.kind = 'so:' + n.so
    n.r = readingKey
    n.children.forEach(go)
    const out = []
    let i = 0
    while (i < n.children.length) {
      let j = i
      while (j + 1 < n.children.length && n.children[j + 1].so === n.children[i].so) j++
      if (j - i + 1 >= 3) {
        const grp = n.children.slice(i, j + 1)
        const g = node(ids('sg'), `${grp[0].label} × ${grp.length}`, grp[0].from, grp[grp.length - 1].to, 'so-group', { children: grp, r: readingKey, count: grp.length })
        out.push(g)
      } else out.push(...n.children.slice(i, j + 1))
      i = j + 1
    }
    n.children = out
  }
  roots.forEach(go)
}

function soCounts(L, roots) {
  // what a session / process holds, by type: count, modes, and the names the lines give
  const t = {}
  const add = (n) => {
    const e = (t[n.so] = t[n.so] || { type: n.so, no: n.soNo, count: 0, modes: {}, names: [] })
    e.count++
    if (n.mode) e.modes[n.mode] = (e.modes[n.mode] || 0) + 1
    if (n.sub && e.names.length < 80) e.names.push(n.sub.length > 110 ? n.sub.slice(0, 110) + '...' : n.sub)
  }
  const w = (n) => { add(n); const kids = n.children; kids.forEach((c) => (c.so ? w(c) : c.children.forEach(w))) }
  const flatGrp = (n) => (n.kind === 'so-group' ? n.children : [n])
  const flat = (n) => { add(n); for (const c of n.children) for (const d of flatGrp(c)) flat(d) }
  roots.forEach(flat)
  return t
}

/** The reading of one process, from its lines [from, to] of L. `statements` lets a session's statement be found by handle. */
function readProcess(L, from, to, soRoots) {
  const find = (re, a = from, b = to) => { for (let i = a; i <= b; i++) { const m = re.exec(at(L, i)); if (m) return { m, i } } return null }
  const p = { lines: [from, to] }
  let r
  if ((r = find(/\(process\) Oracle pid:(\d+), ser:(\d+)/))) { p.pid = +r.m[1]; p.pser = +r.m[2] }
  if ((r = find(/O\/S info: user: (\S+), term: \S*, ospid: (\d+)/))) { p.ospid = +r.m[2] }
  const sess = find(/\(session\) sid: (\d+) ser: (\d+)/)
  if (!sess) return p
  p.sid = +sess.m[1]; p.ser = +sess.m[2]; p.sessLine = sess.i
  const sEnd = to
  if ((r = find(/user#\/name: (\d+)\/(\S+)/, sess.i, sEnd))) p.user = r.m[2]
  if ((r = find(/con_id\/con_uid\/con_name: \d+\/\d+\/(\S+)/, sess.i, sEnd))) p.pdb = r.m[1]
  if ((r = find(/oct: (\d+), prv: \d+, sql: (0x[0-9a-f]+|\(nil\)), psql: (0x[0-9a-f]+|\(nil\))/, sess.i, sEnd))) { p.oct = +r.m[1]; p.sqlHandle = r.m[2]; p.psqlHandle = r.m[3] }
  if ((r = find(/^\s+service name: (\S+)/, sess.i, sEnd))) p.service = r.m[1]
  if ((r = find(/O\/S info: user: (\S+), term: ([^,]*), ospid: (\d+)/, sess.i, sEnd))) { p.clientOspid = +r.m[3] }
  if ((r = find(/^\s+machine: (\S+) program: (.+?)\s*$/, sess.i, sEnd))) { p.machine = r.m[1]; p.program = r.m[2] }
  if ((r = find(/^\s+application name: (.*?), hash value=/, sess.i, sEnd))) p.module = r.m[1]
  if ((r = find(/^\s+action name: (.*?), hash value=/, sess.i, sEnd))) p.action = r.m[1]
  // current wait
  const cw = find(/^\s+Current Wait Stack:/, sess.i, sEnd)
  if (cw) {
    const nx = at(L, cw.i + 1)
    let m
    if ((m = /Not in wait; last wait ended ([\d.]+) sec ago/.exec(nx))) p.wait = { none: true, ago: +m[1], line: cw.i }
    else if ((m = /^\s+\d+: waiting for '(.*)'/.exec(nx))) {
      const w = { event: m[1], line: cw.i + 1, params: [] }
      for (let i = cw.i + 2; i <= Math.min(sEnd, cw.i + 14); i++) {
        const s = at(L, i)
        let q
        if ((q = /wait times: snap=([\d.]+) sec, exc=([\d.]+) sec, total=([\d.]+) sec/.exec(s))) { w.snap = +q[1]; w.total = +q[3] }
        else if ((q = /in_wait=(\d)/.exec(s))) w.inWait = q[1] === '1'
        else if (/^\s+(wait_id|wait times: max|wait counts)/.test(s)) continue
        else if (/^\s+\S+=0x/.test(s) || /^\s+\S+=\d/.test(s)) w.params.push(s.trim())
        else if (/^\s{4}\S/.test(s) && !/^\s+\d+:/.test(s)) break
      }
      p.wait = w
    }
  }
  // blockers
  const bl = find(/Dumping (\d+) direct blocker\(s\):/, sess.i, sEnd)
  if (bl) { const q = /inst: (\d+), sid: (\d+), ser: (\d+)/.exec(at(L, bl.i + 1)); if (q) p.directBlocker = { sid: +q[2], ser: +q[3], line: bl.i } }
  const fb = find(/Dumping final blocker:/, sess.i, sEnd)
  if (fb) { const q = /inst: (\d+), sid: (\d+), ser: (\d+)/.exec(at(L, fb.i + 1)); if (q) p.finalBlocker = { sid: +q[2], ser: +q[3], line: fb.i } }
  const nb = find(/There are (\d+) sessions? blocked by this session/, sess.i, sEnd)
  if (nb) { p.blocks = +nb.m[1]; p.blocksLine = nb.i }
  const wt = find(/Dumping one waiter:/, sess.i, sEnd)
  if (wt) {
    const q = /inst: (\d+), sid: (\d+), ser: (\d+)/.exec(at(L, wt.i + 1))
    const ev = /wait event: '(.*)'/.exec(at(L, wt.i + 2))
    const row = find(/row_wait_obj#: (\d+), block#: (\d+), row#: (\d+), file# (\d+)/, wt.i, wt.i + 10)
    const mb = find(/min_blocked_time: (\d+) secs/, wt.i, wt.i + 12)
    if (q) p.waiter = { sid: +q[2], ser: +q[3], event: ev ? ev[1] : null, obj: row ? { obj: +row.m[1], block: +row.m[2], row: +row.m[3], file: +row.m[4] } : null, blockedSecs: mb ? +mb.m[1] : null, line: wt.i }
  }
  // wait history
  const wh = find(/^\s+Session Wait History:/, sess.i, sEnd)
  if (wh) {
    p.history = []
    let cur = null
    for (let i = wh.i + 1; i <= sEnd; i++) {
      const s = at(L, i)
      let q
      if ((q = /^\s+(\d+): waited for '(.*)'/.exec(s))) { cur = { n: +q[1], event: q[2], line: i }; p.history.push(cur) }
      else if (cur && (q = /wait times: snap=([\d.]+) sec, exc=([\d.]+) sec, total=([\d.]+) sec/.exec(s))) cur.total = +q[3]
      else if (cur && (q = /occurred after ([\d.]+) sec of elapsed time/.exec(s))) cur.after = +q[1]
      else if (/^\s+elapsed time of ([\d.]+) sec since/.test(s)) { p.historyElapsed = +/([\d.]+) sec/.exec(s)[1] }
      else if (/^\s{4}\S/.test(s) && !/^\s+\d+:/.test(s) && i > wh.i + 1 && !/^\s+elapsed/.test(s)) break
      else if (/^\s*$/.test(s) || /^\*\*\*/.test(s)) continue
      else if (/^ {0,5}\S/.test(s) && !/^\s+(driver id|#bytes|wait_id|wait times|wait counts|occurred|elapsed|name\||p\d|duration|[a-z#_ |<]+=)/.test(s) && !/^\s+\d+:/.test(s)) break
      if (p.history.length >= 12 && !cur) break
    }
  }
  // statement: the library handle the session points at
  if (p.sqlHandle && p.sqlHandle !== '(nil)') {
    const h = find(new RegExp(`LibraryHandle:\\s+Address=${p.sqlHandle} `))
    if (h) {
      const nm = /ObjectName:\s+Name=(.*)$/.exec(at(L, h.i + 1))
      const sq = /SqlId=(\w{13})/.exec(at(L, h.i + 2))
      if (nm) { p.sql = trimR(nm[1]); p.sqlLine = h.i + 1 }
      if (sq) p.sqlId = sq[1]
    }
  }
  if (soRoots) {
    p.holds = soCounts(L, soRoots)
    // how many state objects hang under the session
    let ss = 0
    const w = (n) => { ss++; n.children.forEach((c) => (c.kind === 'so-group' ? c.children.forEach(w) : w(c))) }
    soRoots.forEach(w)
    p.soTotal = ss
  }
  return p
}

// ======================================================================================================================================================
//  The error stack file
// ======================================================================================================================================================
const OWN_FRAMES = /^(ksedst1?|kgdsdst|dbkedDefDump|ksedmp|dbkdaKsdActDriver|dbgda\w+|dbgdRunActions|dbgdParseCmd|dbkdParseCmd)$/

function parseErrorstack(L) {
  const ids = Ids()
  const N = L.length
  const folds = []
  const heads = {}
  const root = node('root', 'File', 1, N, 'file')
  const dumpStart = (() => { for (let i = 1; i <= N; i++) if (/^dbkedDefDump\(\):/.test(at(L, i))) return i; return 1 })()
  // header: up to the blank line before the dump (the marker group is part of it)
  let hdrEnd = dumpStart - 1
  while (hdrEnd > 1 && /^\s*$/.test(at(L, hdrEnd))) hdrEnd--
  root.children.push(node(ids(), 'File header', 1, hdrEnd, 'file-header', { sub: 'trace facts and the session markers' }))

  // titled sections at column 0
  const TITLE = /^-{5} (.+?) ?-{5}$/
  const titles = []
  for (let i = dumpStart; i <= N; i++) {
    const m = TITLE.exec(at(L, i))
    if (m) titles.push({ i, name: m[1] })
  }
  const find = (re, from = dumpStart) => { for (let i = from; i <= N; i++) if (re.test(at(L, i))) return i; return 0 }
  const endCST = find(/^----- End of Call Stack Trace -----/)
  const psdStart = find(/^----- Process State Dump/)
  const psdEnd = find(/^END OF PROCESS STATE/)
  const INNER = /^(Bind |Dump Cursor|Session Open Cursors|Session Cached Cursor Dump|Generic Session|RDBMS Session|Argument\/Register|End of Call Stack|end of |IMDB Pinned|.+ END$|Error Stack Dump$)/
  const lvl1 = []
  for (const t of titles) {
    if (t.i > psdStart && t.i <= psdEnd) continue
    if (INNER.test(t.name) && t.name !== 'Error Stack Dump') continue
    let name = t.name.replace(/ START$/, '')
    lvl1.push({ ...t, name })
  }
  // add the lone 'Binary Stack Dump' title (a longer underline form) as an inner section of the call stack
  const binStart = find(/^-{10,} Binary Stack Dump -{10,}$/)
  const argStart = find(/^----- Argument\/Register Address Dump -----/)

  const diag = node(ids(), 'Diagnostic dump', dumpStart, N, 'diag-dump', { sub: at(L, dumpStart).replace(/^dbkedDefDump\(\): /, '').replace(/ \(flags.*$/, ''), r: 'callstack' })
  root.children.push(diag)
  const kindOf = (name) => {
    if (/^Error Stack Dump/.test(name)) return ['sec:error-stack', 'callstack']
    if (/^Current SQL Statement/.test(name)) return ['sec:sql', 'callstack']
    if (/^PL\/SQL (Call )?Stack/.test(name)) return ['sec:plsql', 'callstack']
    if (/^Call Stack Trace/.test(name)) return ['sec:callstack', 'callstack']
    if (/^Process State Dump/.test(name)) return ['sec:procstate', null]
    return ['sec:' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''), null]
  }
  for (let k = 0; k < lvl1.length; k++) {
    const t = lvl1[k]
    let to = k + 1 < lvl1.length ? lvl1[k + 1].i - 1 : N
    if (/^Call Stack Trace/.test(t.name) && endCST) to = endCST
    if (/^Process State Dump/.test(t.name) && psdEnd) to = psdEnd
    if (/^(.+) START$/.test(at(L, t.i).slice(6, -6))) { const e = find(new RegExp(`^----- ${t.name} END -----`), t.i); if (e) to = Math.max(t.i, e) }
    if (to < t.i) to = t.i
    let label = t.name
    let sub = ''
    const mm = /^Current SQL Statement for this session \(sql_id=(\w+)\)/.exec(t.name)
    if (mm) { label = 'Current SQL Statement'; sub = `sql_id ${mm[1]}` }
    const mp = /^Process State Dump \((\d+)\)/.exec(t.name)
    if (mp) { label = 'Process State Dump'; sub = `level ${mp[1]}` }
    const [kind, r] = kindOf(t.name)
    const nd = node(ids(), label, t.i, to, kind, { sub, r })
    diag.children.push(nd)
    heads[t.i] = 't'
    if (/^Error Stack Dump/.test(t.name)) nd.label = 'Error Stack Dump'
  }
  // Call Stack Trace: the frame table, the binary stack dump with one node per frame, the argument dump
  const cst = diag.children.find((c) => c.kind === 'sec:callstack')
  const frames = []
  if (cst && binStart) {
    heads[binStart] = 't'
    const bin = node(ids(), 'Binary Stack Dump', binStart, (argStart || endCST) - 1, 'sec:binary', { sub: 'registers and memory, one block per frame', r: 'callstack' })
    cst.children.push(bin)
    const fr = []
    for (let i = binStart; i <= bin.to; i++) {
      const m = /^========== FRAME \[(\d+)\] \((.+?)\+(\d+) -> (.+?)\) ==========/.exec(at(L, i))
      if (m) fr.push({ n: +m[1], caller: m[2], off: +m[3], callee: m[4], line: i })
    }
    for (let k = 0; k < fr.length; k++) {
      const to = k + 1 < fr.length ? fr[k + 1].line - 1 : bin.to
      const f = fr[k]
      bin.children.push(node(ids(), `Frame ${f.n}`, f.line, to, 'frame', { sub: `${f.caller}+${f.off}`, r: 'callstack' }))
      heads[f.line] = 'f'
      frames.push({ n: f.n, fn: f.caller.replace(/\(\)$/, ''), off: f.off, callee: f.callee.replace(/\(\)$/, ''), line: f.line, own: OWN_FRAMES.test(f.caller.replace(/\(\)$/, '')) })
    }
    folds.push({ from: binStart, to: bin.to, kind: 'binary', reason: `binary stack dump: registers and memory of ${fr.length} frames` })
    for (const c of bin.children) if (c.n > 8) folds.push({ from: c.from, to: c.to, kind: 'frame', reason: 'frame registers and memory', inner: true })
  }
  if (cst && argStart) {
    cst.children.push(node(ids(), 'Argument/Register Address Dump', argStart, endCST - 1, 'sec:argdump', { r: 'callstack' }))
    folds.push({ from: argStart, to: endCST - 1, kind: 'argdump', reason: 'argument and register address dump' })
  }
  const pm = diag.children.find((c) => c.kind === 'sec:process-map-dump')
  if (pm) folds.push({ from: pm.from + 1, to: pm.to, kind: 'procmap', reason: 'process memory map' })

  // the call stack reading's own data
  const sqlSec = diag.children.find((c) => c.kind === 'sec:sql')
  const reading = { dumpLevel: +(/level=(\d+)/.exec(at(L, dumpStart)) || [0, 0])[1], dumpLine: dumpStart }
  if (sqlSec) {
    const m = /sql_id=(\w+)/.exec(at(L, sqlSec.from))
    const txt = []
    for (let i = sqlSec.from + 1; i <= sqlSec.to; i++) txt.push(at(L, i))
    reading.sql = { id: m ? m[1] : null, text: trimR(txt.join('\n')), line: sqlSec.from + 1 }
  }
  const plsec = diag.children.find((c) => c.kind === 'sec:plsql' && /Call/.test(c.label))
  if (plsec) {
    reading.plsql = []
    for (let i = plsec.from + 1; i <= plsec.to; i++) {
      const m = /^(0x[0-9a-f]+)\s+(\d+)\s+(.+?)\s*$/.exec(at(L, i))
      if (m) reading.plsql.push({ handle: m[1], line: +m[2], obj: m[3], at: i })
    }
    reading.plsqlLine = plsec.from
  }
  const es = diag.children.find((c) => c.kind === 'sec:error-stack')
  if (es) { reading.barrier = trimR(at(L, es.from + 1)); reading.barrierLine = es.from + 1 }
  reading.frames = frames
  reading.cstLine = cst ? cst.from : 0
  reading.ora = []
  for (let i = 1; i <= N; i++) if (/\bORA-\d{4,5}\b/.test(at(L, i))) reading.ora.push({ line: i, text: trimR(at(L, i)).slice(0, 120) })

  // process state: banner, state objects, the rest of the dump
  const psd = diag.children.find((c) => c.kind === 'sec:procstate')
  const procReadings = {}
  if (psd) {
    const psTitle = find(/^PROCESS STATE\s*$/, psd.from)
    const instTitle = find(/^CURRENT SESSION'S INSTANTIATION STATE/, psd.from)
    const scd = find(/^----- Session Cursor Dump -----/, psd.from)
    const sccd = find(/^----- Session Cached Cursor Dump -----/, psd.from)
    const ksfd = find(/^KSFD PGA DUMPS/, psd.from)
    const ps = node(ids(), 'Process state', psTitle - 1, (instTitle ? instTitle - 2 : psd.to), 'procstate', { sub: 'state object tree', r: 'proc:p0' })
    heads[psTitle] = 'b'
    heads[instTitle] = 'b'
    psd.children.push(ps)
    const soRoots = buildSoTree(L, ps.from, ps.to, ids)
    dressSo(L, soRoots, ids, 'proc:p0')
    for (const rn of soRoots) { rn.sub = rn.sub; ps.children.push(rn) }
    const pr = readProcess(L, ps.from, ps.to, soRoots)
    pr.key = 'p0'
    // the file's own statement is the "Current SQL Statement" section when the handle lookup finds none
    if (!pr.sql && reading.sql) { pr.sql = reading.sql.text; pr.sqlId = reading.sql.id; pr.sqlLine = reading.sql.line }
    procReadings.p0 = pr
    // the session node of the tree
    const sessNode = soRoots[0] && soRoots[0].children.find((c) => c.so === 'session')
    if (sessNode) sessNode.r = 'proc:p0'
    if (instTitle) psd.children.push(node(ids(), "Current session's instantiation state", instTitle - 1, (scd || ksfd || psd.to) - 1, 'sec:kgi', { sub: 'PL/SQL objects instantiated in the session' }))
    if (scd) {
      const sc = node(ids(), 'Session Cursor Dump', scd, (sccd || ksfd) - 1, 'sec:cursors', { sub: '' })
      psd.children.push(sc)
      heads[scd] = 't'
      const openC = find(/^----- Session Open Cursors -----/, scd)
      if (openC) {
        const oc = node(ids(), 'Session Open Cursors', openC, sc.to, 'sec:open-cursors')
        sc.children.push(oc)
        heads[openC] = 't'
        cursorNodes(L, oc, ids, heads)
      }
    }
    if (sccd) {
      const scc = node(ids(), 'Session Cached Cursor Dump', sccd, (ksfd || psd.to) - 1, 'sec:cached-cursors')
      psd.children.push(scc)
      heads[sccd] = 't'
      const gen = find(/^----- Generic Session Cached Cursor Dump -----/, sccd)
      const rdb = find(/^----- RDBMS Session Cached Cursor Dump -----/, sccd)
      if (gen) { scc.children.push(node(ids(), 'Generic Session Cached Cursor Dump', gen, (rdb || scc.to + 1) - 1, 'sec:generic-cached')); heads[gen] = 't' }
      if (rdb) {
        const rn = node(ids(), 'RDBMS Session Cached Cursor Dump', rdb, scc.to, 'sec:rdbms-cached')
        scc.children.push(rn)
        heads[rdb] = 't'
        cursorNodes(L, rn, ids, heads)
      }
    }
    if (ksfd) psd.children.push(node(ids(), 'KSFD PGA DUMPS', ksfd, psd.to, 'sec:ksfd', { sub: 'open files, KFK dump, MGA' }))
    psd.children.sort((a, b) => a.from - b.from)
    // PSD's own lines before PROCESS STATE are the banner
    psd.r = 'proc:p0'
    memoryFolds(L, psd.from, psd.to, folds)
    atomicLogFolds(L, psd.from, psd.to, folds)
  }
  // pinned buffer history: one fold per buffer header, and the section's own children
  const pbh = diag.children.find((c) => c.kind === 'sec:pinned-buffer-history')
  if (pbh) {
    const bhs = []
    for (let i = pbh.from; i <= pbh.to; i++) if (/^BH \(0x[0-9a-f]+\)/.test(at(L, i))) bhs.push(i)
    const endBh = find(/^END OF PINNED BUFFER HISTORY/, pbh.from) || pbh.to
    for (let k = 0; k < bhs.length; k++) {
      const to = k + 1 < bhs.length ? bhs[k + 1] - 1 : endBh - 1
      const m = /file#: (\d+) rdba: (0x[0-9a-f]+)/.exec(at(L, bhs[k]))
      pbh.children.push(node(ids(), `Buffer header ${k + 1}`, bhs[k], to, 'bh', { sub: m ? `file ${m[1]}, rdba ${m[2]}` : '' }))
      folds.push({ from: bhs[k], to, kind: 'bh', reason: 'buffer header and block dump' })
    }
    pbh.sub = `${bhs.length} buffers with block dumps`
  }
  const tlm = diag.children.find((c) => c.kind === 'sec:transaction-layer-metadata')
  if (tlm) {
    const first = find(/^ts:\d+/, tlm.from), last = (() => { let l = 0; for (let i = tlm.from; i <= tlm.to; i++) if (/^ts:\d+/.test(at(L, i))) l = i; return l })()
    if (first && last > first + 3) folds.push({ from: first, to: last, kind: 'minscn', reason: `${last - first + 1} min-scn trace entries` })
  }
  memoryFolds(L, dumpStart, N, folds)
  atomicLogFolds(L, dumpStart, N, folds)
  // banners as headings
  for (let i = 2; i < N; i++) if (/^={10,}\s*$/.test(at(L, i - 1)) && /^[A-Z][A-Z' ()=,]{6,}$/.test(at(L, i)) && /^-{5,}\s*$/.test(at(L, i + 1))) heads[i] = 'b'
  for (let i = 1; i <= N; i++) if (/^\*\*\* \d{4}-\d\d-\d\dT/.test(at(L, i)) && !heads[i]) heads[i] = 'ts'
  for (let i = dumpStart; i <= N; i++) { const m = /^( *)SO: 0x/.exec(at(L, i)); if (m) heads[i] = 'so' }
  heads[dumpStart] = 'b1'
  // timestamp markers are dimmed; give the heads map no more than it needs
  return { root, folds, heads, readings: { callstack: reading, ...Object.fromEntries(Object.entries(procReadings).map(([k, v]) => ['proc:' + k, v])) }, header: header(L) }
}

function cursorNodes(L, parent, ids, heads) {
  const cur = []
  for (let i = parent.from; i <= parent.to; i++) {
    const m = /^----- Dump Cursor sql_id=(\w+) xsc=(0x[0-9a-f]+) cur=(0x[0-9a-f]+|\(nil\)) -----/.exec(at(L, i))
    if (!m) continue
    let start = i
    for (let b = 1; b <= 4; b++) if (/^Cursor#\d+\(/.test(at(L, i - b))) { start = i - b; break }
    cur.push({ i, start, id: m[1], num: (/^Cursor#(\d+)/.exec(at(L, start)) || [])[1], state: (/state=(\w+)/.exec(at(L, start)) || [])[1] })
  }
  for (let k = 0; k < cur.length; k++) {
    const c = cur[k]
    let to = k + 1 < cur.length ? cur[k + 1].start - 1 : parent.to
    while (to > c.i && /^-{20,}\s*$/.test(at(L, to))) to--
    let sql = ''
    for (let i = c.i; i <= to; i++) { const m = /ObjectName:\s+Name=(.*)$/.exec(at(L, i)); if (m) { sql = trimR(m[1]); break } }
    let binds = 0
    for (let i = c.i; i <= to; i++) if (/^\s*Bind#\d+/.test(at(L, i))) binds++
    const nd = node(ids(), `Cursor${c.num ? ' #' + c.num : ''} ${c.id}`, c.start, to, 'cursor', { sub: sql.replace(/\s+/g, ' ').slice(0, 90), sqlId: c.id })
    parent.children.push(nd)
    heads[c.i] = 't'
  }
}

// ======================================================================================================================================================
//  The heap file
// ======================================================================================================================================================
const CHUNK = /^\s+Chunk\s+([0-9a-f]+)\s+sz=\s*(\d+)\s+(\S+)\s+"(.*?)"(.*)$/
const CHUNK_ANY = /^\s+Chunk\s+([0-9a-f]+)\s+sz=\s*(\d+)\s+(\S+)(?:\s+"(.*?)")?(.*)$/

function parseHeap(L) {
  const N = L.length
  const ids = Ids()
  const folds = []
  const heads = {}
  const heaps = []
  const runs = []
  const root = node('root', 'File', 1, N, 'file')
  // runs: ACTION NAME markers
  for (let i = 1; i <= N; i++) {
    const m = /^\*\*\* ACTION NAME:\((.*?)\)/.exec(at(L, i))
    if (m) runs.push({ i, label: m[1], level: (/_(\d+)$/.exec(m[1]) || [])[1] })
  }
  // heaps
  let h = null
  let state = null
  let bucket = null
  const starts = []
  for (let i = 1; i <= N; i++) {
    const s = at(L, i)
    let m
    if ((m = /^HEAP DUMP heap name="(.*?)"\s+desc=0x([0-9a-f]+)/.exec(s))) {
      let from = i
      if (/^\*{20,}/.test(at(L, i - 1))) from = i - 1
      if (/^SUBHEAP \d+: desc=/.test(at(L, from - 1)) || (/^\*{20,}/.test(at(L, from - 1)) && /^SUBHEAP \d+: desc=/.test(at(L, from - 2)))) from = /^SUBHEAP/.test(at(L, from - 1)) ? from - 1 : from - 2
      const run = runs.reduce((a, r, k) => (r.i < i ? k : a), 0)
      h = { id: 'h' + (heaps.length + 1), name: m[1].replace(/\s+$/, ''), rawName: m[1], desc: m[2], run, line: i, from, to: N, depth: 0, parent: null, extents: 0, chunkCount: 0, byType: {}, byComment: new Map(), dsChunks: {}, dsInfo: {}, buckets: [], total: null, free: null, perm: null, sumExt: 0, sumFree: 0, sumPerm: 0, subList: [], freeLine: 0, permLine: 0, extLine: 0, totalLine: 0, totalFreeLine: 0, permSpaceLine: 0, unpinnedLine: 0, nochunks: false, sample: false }
      heaps.push(h)
      state = 'header'
      bucket = null
      continue
    }
    if (!h) continue
    if ((m = /^ parent=(\S+) owner/.exec(s))) h.parent = m[1] === '(nil)' ? null : m[1].replace(/^0x/, '')
    else if ((m = /dsx heap size=(\d+), dsx heap depth=(\d+)/.exec(s))) { h.dsxSize = +m[1]; h.depth = +m[2] }
    else if ((m = /^ pdb id=(\d+)/.exec(s))) h.pdb = +m[1]
    else if (/^EXTENT \d+ addr=/.test(s)) { h.extents++; state = 'ext'; if (!h.extLine) h.extLine = i }
    else if ((m = /^Total heap size\s+=\s+(\d+)/.exec(s))) { h.total = +m[1]; h.totalLine = i; state = 'after' }
    else if (/^FREE LISTS:/.test(s)) { state = 'free'; h.freeLine = i }
    else if ((m = /^ Bucket (\d+) size=(\d+)/.exec(s))) { bucket = { i: +m[1], size: +m[2], chunks: 0, bytes: 0, line: i }; h.buckets.push(bucket) }
    else if ((m = /^Total free space\s+=\s+(\d+)/.exec(s))) { h.free = +m[1]; h.totalFreeLine = i; state = 'afterfree' }
    else if (/^UNPINNED RECREATABLE CHUNKS/.test(s)) { state = 'unpinned'; h.unpinnedLine = i }
    else if (/^PERMANENT CHUNKS:/.test(s)) { state = 'perm'; h.permLine = i }
    else if ((m = /^Permanent space\s+=\s+(\d+)/.exec(s))) { h.perm = +m[1]; h.permSpaceLine = i; state = 'done' }
    else if (/^Heap has significant amount of free memory/.test(s)) h.sample = true
    else if (/only chunks clearly belonging to pdb id/.test(s)) h.pdbFiltered = true
    else if ((m = /^     ds\s+([0-9a-f]+) sz=\s*(\d+) ct=\s*(\d+)/.exec(s))) h.dsInfo[m[1]] = { size: +m[2], ext: +m[3], line: i }
    else if ((m = /^\s+Subheap ds=0x([0-9a-f]+)\s+heap name=\s*(.*?)\s+size=\s*(\d+)/.exec(s))) h.subList.push({ desc: m[1], name: m[2], size: +m[3] })
    else if ((m = CHUNK_ANY.exec(s))) {
      const size = +m[2], type = m[3], comment = m[4] === undefined ? '' : m[4].replace(/\s+$/, '')
      if (state === 'ext') {
        h.chunkCount++
        h.sumExt += size
        h.byType[type] = h.byType[type] || { chunks: 0, bytes: 0, lines: [] }
        h.byType[type].chunks++; h.byType[type].bytes += size; h.byType[type].lines.push(i)
        let c = h.byComment.get(comment)
        if (!c) { c = { c: comment, chunks: 0, bytes: 0, types: {}, lines: [] }; h.byComment.set(comment, c) }
        c.chunks++; c.bytes += size; c.types[type] = (c.types[type] || 0) + 1; c.lines.push(i)
        const ds = /ds=0x([0-9a-f]+)/.exec(m[5] || '')
        if (ds) { const d = (h.dsChunks[ds[1]] = h.dsChunks[ds[1]] || { chunks: 0, bytes: 0, line: i }); d.chunks++; d.bytes += size }
      } else if (state === 'free') {
        if (type !== 'kghdsx') { h.sumFree += size; if (bucket) { bucket.chunks++; bucket.bytes += size } }
        else if (bucket) bucket.heads = (bucket.heads || 0) + 1
      } else if (state === 'perm') {
        if (type === 'perm') h.sumPerm += size
      }
    }
  }
  for (let k = 0; k < heaps.length; k++) {
    const nx = heaps[k + 1]
    const run = runs[heaps[k].run]
    const nextRun = runs[heaps[k].run + 1]
    let to = nx ? nx.from - 1 : N
    if (nextRun && nextRun.i <= to) to = nextRun.i - 1
    heaps[k].to = to
  }
  // tree: parent by desc within a run
  for (let k = 0; k < heaps.length; k++) {
    const x = heaps[k]
    x.parentHeap = null
    if (!x.parent) continue
    for (let j = k - 1; j >= 0; j--) if (heaps[j].run === x.run && heaps[j].desc === x.parent) { x.parentHeap = heaps[j]; break }
  }
  // the check
  const chk = (sum, total) => (total === null ? null : { sum, total, ok: sum === total })
  const out = []
  let checkStats = { heaps: 0, withTotals: 0, chunksOk: 0, freeOk: 0, permOk: 0, bad: [] }
  for (const x of heaps) {
    const rows = [...x.byComment.values()].sort((a, b) => b.bytes - a.bytes)
    const subs = heaps.filter((y) => y.parentHeap === x)
    const rec = {
      id: x.id, name: x.name, desc: x.desc, parent: x.parentHeap ? x.parentHeap.id : null, run: x.run, depth: x.depth, from: x.from, line: x.line, to: x.to,
      extents: x.extents, chunks: x.chunkCount, total: x.total, free: x.free, perm: x.perm, dsxSize: x.dsxSize,
      sample: x.sample, pdbFiltered: !!x.pdbFiltered, headerOnly: x.extents === 0 && x.total === null,
      check: {
        chunks: x.total === null ? null : chk(x.sumExt, x.total),
        free: x.free === null ? null : chk(x.sumFree, x.free),
        perm: x.perm === null ? null : chk(x.sumPerm, x.perm),
      },
      byType: Object.entries(x.byType).map(([t, v]) => ({ t, chunks: v.chunks, bytes: v.bytes, lines: v.lines })).sort((a, b) => b.bytes - a.bytes),
      byComment: rows,
      buckets: x.buckets,
      subs: subs.map((s) => ({ id: s.id, name: s.name, desc: s.desc, size: (x.dsInfo[s.desc] || {}).size ?? null, ext: (x.dsInfo[s.desc] || {}).ext ?? null, total: s.total, chunks: s.chunkCount, parentChunks: (x.dsChunks[s.desc] || {}).chunks ?? 0, parentBytes: (x.dsChunks[s.desc] || {}).bytes ?? 0, line: s.from })),
      lines: { free: x.freeLine, perm: x.permLine, totalHeap: x.totalLine, totalFree: x.totalFreeLine, permSpace: x.permSpaceLine, ext: x.extLine },
    }
    out.push(rec)
    checkStats.heaps++
    if (x.total !== null) {
      checkStats.withTotals++
      if (rec.check.chunks.ok) checkStats.chunksOk++
      if (rec.check.free && rec.check.free.ok) checkStats.freeOk++
      if (rec.check.perm && rec.check.perm.ok) checkStats.permOk++
      if (!rec.check.chunks.ok || (rec.check.free && !rec.check.free.ok) || (rec.check.perm && !rec.check.perm.ok)) checkStats.bad.push({ id: x.id, name: x.name, line: x.line, chunks: rec.check.chunks, free: rec.check.free, perm: rec.check.perm })
    }
  }
  stats.heap = checkStats
  // outline: file header, runs, heaps nested by parent
  const firstHeap = heaps[0]
  const hdr = node(ids(), 'File header', 1, firstHeap.from - 1, 'file-header', { sub: 'trace facts and the session markers' })
  root.children.push(hdr)
  const runNodes = runs.map((r, k) => {
    const hs = heaps.filter((x) => x.run === k)
    const from = k === 0 ? hs[0].from : r.i
    const to = k + 1 < runs.length ? runs[k + 1].i - 1 : N
    return node(ids(), `Heap dump ${k + 1} of ${runs.length}`, from, to, 'run', { sub: `event level ${r.level}`, runNo: k + 1 })
  })
  root.children.push(...runNodes)
  const nodeOf = new Map()
  for (const x of heaps) {
    const nd = node(ids(), x.name, x.from, x.to, 'heap', { sub: `${x.total !== null ? x.total.toLocaleString('en-US') + ' bytes' : 'header only'}`, r: 'heap:' + x.id, heapId: x.id, depth: x.depth })
    nodeOf.set(x, nd)
  }
  for (const x of heaps) {
    const nd = nodeOf.get(x)
    // the heap's node spans only its own text; the sub-heaps are its children in the outline but not in its line range
    if (x.parentHeap) nodeOf.get(x.parentHeap).children.push(nd)
    else runNodes[x.run].children.push(nd)
  }
  // heap node ranges: own text only. `children` hold the sub-heaps (their ranges follow the parent's own text, so they are not nested by range).
  for (const x of heaps) {
    // folds: free lists and permanent chunks are listed again
    if (x.freeLine && x.totalFreeLine && x.totalFreeLine - 1 > x.freeLine) folds.push({ from: x.freeLine, to: x.totalFreeLine - 1, kind: 'freelists', reason: `free chunks again, in ${x.buckets.length} size buckets` })
    if (x.permLine && x.permSpaceLine && x.permSpaceLine - 1 > x.permLine) folds.push({ from: x.permLine, to: x.permSpaceLine - 1, kind: 'permchunks', reason: 'permanent chunks again, with their parts' })
    heads[x.line] = 'hp'
    if (x.extLine) {
      // extent lines get a light dress
    }
    for (const ln of [x.totalLine, x.totalFreeLine, x.permSpaceLine, x.freeLine, x.permLine, x.unpinnedLine]) if (ln) heads[ln] = 'hs'
  }
  for (let i = 1; i <= N; i++) {
    const s = at(L, i)
    if (/^\d+ LARGEST SUB HEAPS for heap name=/.test(s) || /^SUBHEAP \d+: desc=/.test(s)) heads[i] = 'hs'
    else if (/^EXTENT \d+ addr=/.test(s)) heads[i] = 'ex'
    else if (/^\*\*\* \d{4}-\d\d-\d\dT/.test(s)) heads[i] = 'ts'
  }
  for (const r of runs) heads[r.i] = 'ts'
  return { root, folds, heads, readings: { heaps: out, runs: runs.map((r, k) => ({ label: r.label, level: r.level, line: r.i, heaps: heaps.filter((x) => x.run === k).map((x) => x.id) })) }, header: header(L) }
}

// ======================================================================================================================================================
//  The system state file
// ======================================================================================================================================================
const IDLE_RE = /idle|timer|rdbms ipc message|slave wait|Streams AQ|Data Guard|watchdog|heartbeat|wait for unread message|jobq slave|class slave wait/i

function parseSysstate(L) {
  const N = L.length
  const ids = Ids()
  const heads = {}
  const folds = []
  const root = node('root', 'File', 1, N, 'file')
  const find = (re, from = 1, to = N) => { for (let i = from; i <= to; i++) if (re.test(at(L, i))) return i; return 0 }
  const sysLine = find(/^SYSTEM STATE \(level=/)
  const sumLine = find(/^Dumping the Process Summary/)
  const endLine = find(/^END OF SYSTEM STATE/)
  const sysGlobal = find(/^System global information:/, sumLine)
  const procLines = []
  for (let i = sysGlobal; i <= endLine; i++) {
    const m = /^PROCESS (\d+): ?(.*)$/.exec(at(L, i))
    if (m) procLines.push({ i, pid: +m[1], name: trimR(m[2]) })
  }
  // process summary
  const rows = []
  for (let i = sumLine + 1; i < sysGlobal; i++) {
    const s = at(L, i)
    let m
    if ((m = /^\s+(\d+): (\S+)(?: process)?(?: ospid (\S+) sid (\d+) ser (\d+),)?(?: waiting for '(.*)')?\s*$/.exec(s))) {
      rows.push({ pid: +m[1], name: m[2], ospid: m[3] || null, sid: m[4] !== undefined ? +m[4] : null, ser: m[5] !== undefined ? +m[5] : null, event: m[6] || null, line: i })
    } else if ((m = /^\s+Cmd: (.*)$/.exec(s)) && rows.length) rows[rows.length - 1].cmd = m[1].trim()
    else if ((m = /^\s+Blocked by inst: (\d+), sid: (\d+), ser: (\d+)/.exec(s)) && rows.length) rows[rows.length - 1].blockedBy = { sid: +m[2], ser: +m[3] }
    else if ((m = /^\s+Final Blocker inst: (\d+), sid: (\d+), ser: (\d+)/.exec(s)) && rows.length) rows[rows.length - 1].finalBlocker = { sid: +m[2], ser: +m[3] }
  }
  // the process sections
  const lastEnd = (() => { const m = find(/^mapped: /, procLines[procLines.length - 1].i); return m ? m - 1 : endLine - 1 })()
  const procReadings = {}
  const procNodes = []
  const soTrees = {}
  for (let k = 0; k < procLines.length; k++) {
    const pl = procLines[k]
    const to = k + 1 < procLines.length ? procLines[k + 1].i - 1 : lastEnd
    const roots = buildSoTree(L, pl.i, to, () => 'x')
    const p = readProcess(L, pl.i, to, roots)
    p.pidNo = pl.pid
    procReadings[pl.pid] = p
    soTrees[pl.pid] = { roots, from: pl.i, to }
    const row = rows.find((r) => r.pid === pl.pid)
    procNodes.push({ pl, to, row })
  }
  // idle and who waits how long
  for (const r of rows) {
    const p = procReadings[r.pid]
    r.kind = r.name === 'USER' ? 'user' : r.name === 'PSEUDO' ? 'pseudo' : 'bg'
    if (p && p.wait && p.wait.event) { r.waitSecs = p.wait.total; r.inWait = p.wait.inWait !== false }
    if (p && p.sql) { r.sql = p.sql; r.sqlId = p.sqlId }
    if (p) { r.blocks = p.blocks || 0; r.app = p.module || null; r.user = p.user || null; r.program = p.program || null }
    r.idle = r.kind === 'bg' && (r.sid === 0 || (r.event ? IDLE_RE.test(r.event) : false))
    r.from = (procNodes.find((x) => x.pl.pid === r.pid) || {}).pl?.i
    r.to = (procNodes.find((x) => x.pl.pid === r.pid) || {}).to
  }
  // outline
  const present = []
  const hdr = node(ids(), 'File header', 1, 30, 'file-header', { sub: 'trace facts and the session markers' })
  root.children.push(hdr)
  const callerStack = find(/^System state caller's stack:/)
  if (callerStack) root.children.push(node(ids(), "Oradebug command and caller's stack", find(/^\*\*\* TRACE CONTINUED FROM/) || callerStack, sysLine - 2, 'sec:caller', { sub: 'the command, and the short stack of the process that took the dump' }))
  const sys = node(ids(), 'System state', sysLine - 1, endLine, 'sysstate', { sub: at(L, sysLine).replace(/^SYSTEM STATE /, ''), r: 'sysstate' })
  root.children.push(sys)
  heads[sysLine] = 'b'
  sys.children.push(node(ids(), 'Process summary', sumLine, sysGlobal - 1, 'sec:summary', { sub: `${rows.length} processes`, r: 'sysstate' }))
  heads[sumLine] = 'hs'
  const nextAfter = procLines[0].i - 1
  sys.children.push(node(ids(), 'System global information', sysGlobal, nextAfter, 'sec:sysglobal', { sub: 'counts and statistics of the instance' }))
  heads[sysGlobal] = 'hs'
  const loaded = new Set([6, 61, 68])
  const ids2 = Ids()
  for (const x of procNodes) {
    const row = x.row
    const label = `PROCESS ${x.pl.pid}${x.pl.name ? ' ' + x.pl.name : row ? ' ' + row.name : ''}`
    const sub = row ? [row.sid ? `${row.sid}.${row.ser}` : '', row.event ? `waiting for ${row.event}` : (row.cmd || '')].filter(Boolean).join(' · ') : ''
    const nd = node(ids(), label, x.pl.i, x.to, 'process', { sub, r: 'proc:' + x.pl.pid, pid: x.pl.pid, idle: row ? row.idle : false, kind2: row ? row.kind : '' })
    heads[x.pl.i] = 'h2'
    if (loaded.has(x.pl.pid)) {
      const tr = soTrees[x.pl.pid]
      const roots = buildSoTree(L, x.pl.i, x.to, ids)
      dressSo(L, roots, ids, 'proc:' + x.pl.pid)
      for (const rn of roots) nd.children.push(rn)
      procReadings[x.pl.pid].loaded = true
      memoryFolds(L, x.pl.i, x.to, folds)
      atomicLogFolds(L, x.pl.i, x.to, folds)
      present.push([x.pl.i - 1, x.to])
    }
    sys.children.push(nd)
  }
  sys.children.push(node(ids(), 'After the last process', lastEnd + 1, endLine - 1, 'sec:rest', { sub: 'pseudo process, allocation slots, Data Guard broker' }))
  // a few lines around
  present.push([1, procLines[0].i + 90])
  present.push([N - 12, N])
  for (let i = 1; i <= N; i++) { const s = at(L, i); if (/^\*\*\* \d{4}-\d\d-\d\dT/.test(s) && !heads[i]) heads[i] = 'ts' }
  heads[endLine] = 'b'
  // loaded range merge
  present.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const r of present) { const l = merged[merged.length - 1]; if (l && r[0] <= l[1] + 1) l[1] = Math.max(l[1], r[1]); else merged.push([Math.max(1, r[0]), Math.min(N, r[1])]) }
  // the blocker tree, from the summary's own words
  const sess = rows.filter((r) => r.sid)
  const key = (sid, ser) => `${sid}.${ser}`
  const chainNodes = new Map()
  const need = (sid, ser) => { const r = rows.find((x) => x.sid === sid && x.ser === ser); if (r) chainNodes.set(key(sid, ser), r) }
  for (const r of rows) if (r.blockedBy) { need(r.sid, r.ser); need(r.blockedBy.sid, r.blockedBy.ser); if (r.finalBlocker) need(r.finalBlocker.sid, r.finalBlocker.ser) }
  const treeNodes = [...chainNodes.values()].map((r) => {
    const p = procReadings[r.pid]
    return {
      sid: r.sid, ser: r.ser, pid: r.pid, name: r.name, ospid: r.ospid, event: r.event, waitSecs: r.waitSecs ?? null, cmd: r.cmd || null,
      sql: r.sql || null, sqlId: r.sqlId || null, user: r.user || null, module: r.app || null, action: p.action || null, program: p.program || null,
      blockedBy: r.blockedBy ? key(r.blockedBy.sid, r.blockedBy.ser) : null, finalBlocker: r.finalBlocker ? key(r.finalBlocker.sid, r.finalBlocker.ser) : null,
      blocks: p.blocks || 0, directBlockerLine: p.directBlocker ? p.directBlocker.line : null, finalBlockerLine: p.finalBlocker ? p.finalBlocker.line : null, blocksLine: p.blocksLine || null,
      waiter: p.waiter || null, line: r.from, key: key(r.sid, r.ser),
    }
  })
  const counts = { total: rows.length, user: rows.filter((r) => r.kind === 'user').length, bg: rows.filter((r) => r.kind === 'bg').length, idleBg: rows.filter((r) => r.idle).length, pseudo: rows.filter((r) => r.kind === 'pseudo').length, waiting: rows.filter((r) => r.event).length }
  stats.sysstate = { ...counts, chain: treeNodes.map((t) => t.key) }
  return {
    root, folds, heads, header: header(L), present: merged,
    readings: { sysstate: { rows, counts, tree: treeNodes, sysLine }, ...Object.fromEntries(Object.entries(procReadings).map(([k, v]) => ['proc:' + k, v])) },
  }
}

// ======================================================================================================================================================
//  The hang analysis file
// ======================================================================================================================================================
function parseHang(L) {
  const N = L.length
  const ids = Ids()
  const heads = {}
  const folds = []
  const root = node('root', 'File', 1, N, 'file')
  const find = (re, from = 1, to = N) => { for (let i = from; i <= to; i++) if (re.test(at(L, i))) return i; return 0 }
  const hdrEnd = find(/^Processing Oradebug command 'setmypid'/) - 1
  root.children.push(node(ids(), 'File header', 1, hdrEnd > 0 ? hdrEnd : 31, 'file-header', { sub: 'trace facts and the session markers' }))
  const hStart = find(/^HANG ANALYSIS:/) - 1
  const hEnd = find(/^END OF HANG ANALYSIS/)
  const oc = find(/^Processing Oradebug command 'hanganalyze/)
  if (oc) root.children.push(node(ids(), 'Oradebug command', find(/^Processing Oradebug command 'setmypid'/), hStart - 2, 'sec:oradebug', { sub: "setmypid, then 'hanganalyze 3'" }))
  const hang = node(ids(), 'Hang analysis', hStart, hEnd + 1, 'hang', { sub: at(L, find(/oradebug_node_dump_level/)).trim(), r: 'hang' })
  root.children.push(hang)
  heads[hStart + 1] = 'b'
  // sections of the analysis
  const secs = []
  const mostLikely = find(/^Chains most likely to have caused the hang:/)
  const nonInt = find(/^Non-intersecting chains:/)
  const invol = find(/^Sessions in an involuntary wait or not in a wait:/)
  const extra = find(/^Extra information that will be dumped at higher levels:/)
  const allNodes = find(/^State of ALL nodes/)
  const pts = [[hStart + 2, 'Header: instances, scheduling delay, drift', 'hang-hdr'], [mostLikely, 'Chains most likely to have caused the hang', 'sec:hang-likely'], [nonInt, 'Non-intersecting chains', 'sec:hang-nonint'], [invol, 'Sessions in an involuntary wait or not in a wait', 'sec:hang-invol'], [extra, 'Extra information for higher levels', 'sec:hang-extra'], [allNodes, 'State of ALL nodes', 'sec:hang-nodes']].filter((x) => x[0])
  for (let k = 0; k < pts.length; k++) {
    const from = pts[k][0] - (k > 0 && /^=+$/.test(at(L, pts[k][0] - 1)) ? 1 : 0)
    const to = k + 1 < pts.length ? pts[k + 1][0] - 2 : hEnd - 1
    const nd = node(ids(), pts[k][1], from, to, pts[k][2], { r: 'hang' })
    hang.children.push(nd)
    heads[pts[k][0]] = 'hs'
  }
  // chains
  const chains = []
  for (let i = 1; i <= N; i++) {
    const m = /^Chain (\d+):$/.exec(at(L, i))
    if (!m) continue
    const from = i - 1
    let to = i
    for (let j = i + 1; j <= N; j++) if (/^Chain \d+ Signature Hash:/.test(at(L, j))) { to = j + 1; break }
    const ch = { n: +m[1], from, to, sessions: [] }
    // sessions
    const starts = []
    for (let j = i; j <= to; j++) if (/Oracle session identified by:/.test(at(L, j))) starts.push(j)
    for (let k = 0; k < starts.length; k++) {
      const a = starts[k], b = k + 1 < starts.length ? starts[k + 1] - 1 : to
      const g = (re) => { for (let j = a; j <= b; j++) { const mm = re.exec(at(L, j)); if (mm) return mm } return null }
      const s = { line: a }
      let mm
      if ((mm = g(/session id: (\d+)/))) s.sid = +mm[1]
      if ((mm = g(/session serial #: (\d+)/))) s.ser = +mm[1]
      if ((mm = g(/os id: (\d+)/))) s.ospid = +mm[1]
      if ((mm = g(/process id: (\d+), (.+)$/))) { s.pid = +mm[1]; s.image = mm[2] }
      if ((mm = g(/module name: \d+ \((.*)\)\s*$/))) s.module = mm[1]
      if ((mm = g(/pdb id: (\d+) \((.*)\)/))) s.pdb = mm[2]
      if ((mm = g(/(?:is|which is) waiting for '(.*?)' with wait info/))) { s.event = mm[1]; s.eventLine = a + 0 }
      if ((mm = g(/time in wait: ([\d.]+) sec/))) s.waitSecs = +mm[1]
      if ((mm = g(/timeout after: ([\d.]+) sec/))) s.timeout = +mm[1]
      if ((mm = g(/blocking: (\d+) sessions?/))) s.blocks = +mm[1]
      if ((mm = g(/current sql_id: (\d+)/))) s.sqlNo = mm[1]
      if ((mm = g(/current sql: (.*)$/))) { s.sql = trimR(mm[1]); s.sqlLine = (() => { for (let j = a; j <= b; j++) if (/current sql: /.test(at(L, j))) return j; return a })() }
      if ((mm = g(/short stack: (.*)$/))) s.stack = trimR(mm[1])
      s.history = []
      for (let j = a; j <= b; j++) { const q = /^\s+(\d+)\.\s+event: '(.*)'/.exec(at(L, j)); if (q) { const w = /time waited: ([\d.]+) sec/.exec(at(L, j + 1)); s.history.push({ n: +q[1], event: q[2], secs: w ? +w[1] : null, line: j }) } }
      ch.sessions.push(s)
    }
    const sg = find(/^Chain \d+ Signature: /, i)
    if (sg) ch.signature = at(L, sg).replace(/^Chain \d+ Signature: /, '')
    chains.push(ch)
  }
  // chain nodes in the outline, under the section that holds them
  for (const ch of chains) {
    const nd = node(ids(), `Chain ${ch.n}`, ch.from, ch.to, 'chain', { sub: `${ch.sessions.length} session${ch.sessions.length === 1 ? '' : 's'}`, r: 'hang', chain: ch.n })
    const parent = hang.children.find((c) => c.from <= nd.from && nd.to <= c.to) || hang
    parent.children.push(nd)
    ch.sessions.forEach((s, k) => nd.children.push(node(ids(), `Session ${s.sid}.${s.ser}`, s.line - 1, (k + 1 < ch.sessions.length ? ch.sessions[k + 1].line - 2 : ch.to - 3), 'hang-session', { sub: s.event ? `waiting for ${s.event}` : '', r: 'hang' })))
    heads[ch.from + 1] = 'hs'
  }
  // nodes
  const nodesList = []
  if (allNodes) for (let i = allNodes + 2; i <= allNodes + 12; i++) { const m = /^\[(\d+)\]\/(\d+)\/(\d+)\/(\d+)\/(0x[0-9a-f]+)\/(\d+)\/(\w+)\/(.*)$/.exec(at(L, i)); if (m) nodesList.push({ node: +m[1], sid: +m[3], ser: +m[4], ospid: +m[6], state: m[7], adj: m[8].replace(/^\[|\]$/g, '') }) }
  const dumps = find(/^HANG ANALYSIS DUMPS:/)
  if (dumps) root.children.push(node(ids(), 'Hang analysis dumps', dumps - 1, find(/^HANG ANALYSIS DUMPS: END/) + 1, 'sec:hang-dumps', { sub: 'state of local nodes, which processes were dumped' }))
  const tail = find(/Oradebug command 'hanganalyze 3' console output/)
  if (tail) root.children.push(node(ids(), 'Oradebug output', tail - 1, N, 'sec:oradebug-out'))
  for (let i = 1; i <= N; i++) if (/^\*\*\* \d{4}-\d\d-\d\dT/.test(at(L, i)) && !heads[i]) heads[i] = 'ts'
  for (const k of [hEnd]) heads[k] = 'b'
  const dl = find(/^HANG ANALYSIS DUMPS:/); if (dl) heads[dl] = 'b'
  const sigs = []
  for (let i = mostLikely; i < nonInt; i++) { const m = /^\s*\[(\w)\] Chain (\d+) Signature: (.*)$/.exec(at(L, i)); if (m) sigs.push({ tag: m[1], n: +m[2], sig: m[3], hash: (/Signature Hash: (\S+)/.exec(at(L, i + 1)) || [])[1], line: i }) }
  stats.hang = { chains: chains.map((c) => c.sessions.length) }
  return { root, folds, heads, header: header(L), readings: { hang: { chains, nodes: nodesList, sigs, level: (/oradebug_node_dump_level: (\d+)/.exec(at(L, find(/oradebug_node_dump_level/))) || [])[1] } } }
}

// ======================================================================================================================================================
//  Drive
// ======================================================================================================================================================
function finish(model, L, key, extra = {}) {
  walk(model.root, (n, d) => { n.depth = d })
  // totals for the status bar
  return model
}

const PARSERS = { errorstack: parseErrorstack, heap: parseHeap, sysstate: parseSysstate, hang: parseHang }
const summary = {}

for (const [key, spec] of Object.entries(FILES)) {
  const abs = join(ROOT, spec.path)
  if (!existsSync(abs)) {
    if (existsSync(join(OUT, key + '.js'))) { console.log(`${key}: ${spec.path} is missing; the data already written is kept`); continue }
    console.log(`${key}: ${spec.path} is missing and there is no data to keep; skipped`)
    continue
  }
  const buf = readFileSync(abs)
  const text = buf.toString('utf8')
  const L = lines1(text)
  const m = PARSERS[key](L)
  walk(m.root, (n, d) => { n.depth = d })
  const present = m.present && m.present.length ? m.present : [[1, L.length]]
  const model = {
    key, title: spec.title, name: spec.path.split('/').pop(), path: spec.path, bytes: buf.length, lines: L.length,
    header: m.header, present, outline: m.root, folds: m.folds.sort((a, b) => a.from - b.from || b.to - a.to), heads: m.heads, readings: m.readings,
  }
  const json = JSON.stringify(model)
  writeFileSync(join(OUT, key + '.json'), json)
  writeFileSync(join(OUT, key + '.js'), `window.DIAG = window.DIAG || {}; window.DIAG[${JSON.stringify(key)}] = ${json.replace(/</g, '\\u003c')};\n`)
  // the text slices
  const slices = present.map(([a, b]) => ({ from: a, text: L.slice(a - 1, b).join('\n') }))
  const loadedLines = present.reduce((s, [a, b]) => s + (b - a + 1), 0)
  writeFileSync(join(OUT, key + '.txt.js'), `window.TXT = window.TXT || {}; window.TXT[${JSON.stringify(key)}] = ${JSON.stringify({ lines: L.length, slices }).replace(/</g, '\\u003c')};\n`)
  let nodes = 0
  walk(m.root, () => nodes++)
  summary[key] = { lines: L.length, loaded: loadedLines, nodes, folds: model.folds.length, foldedLines: model.folds.reduce((s, f) => s + (f.to - f.from), 0), modelKB: Math.round(json.length / 1024) }
}
console.log(JSON.stringify(summary, null, 1))
console.log(JSON.stringify(stats, (k, v) => (Array.isArray(v) && v.length > 20 ? `[${v.length} items]` : v), 1))
writeFileSync(join(OUT, 'stats.json'), JSON.stringify({ summary, stats }, null, 1))
