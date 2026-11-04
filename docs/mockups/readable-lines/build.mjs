// Mock-up data for the redesigned "readable" Lines view: parses real ranges of
// testdata/traces/19c/io_waits.trc into the rows the view would render, then
// inlines them into template.html -> index.html.  node build.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '../../..')
const trc = readFileSync(join(root, 'testdata/traces/19c/io_waits.trc'), 'utf8').split('\n')
const RANGES = [[72, 447], [6811, 16423]] // 1-based, inclusive

// wall clock: the *** line before the KO wait at tim=10805134758 reads 11:35:29.826769
const ANCHOR_TIM = 10805134758, ANCHOR_US = ((11 * 60 + 35) * 60 + 29) * 1e6 + 826769

const kv = (s) => Object.fromEntries([...s.matchAll(/(\w+)=([^,\s]+)/g)].map((m) => [m[1], m[2]]))
const num = (o, k) => (o[k] === undefined ? undefined : Number(o[k]))

const objName = {} // obj# -> object, learnt from STAT lines
for (const l of trc) {
  const m = l.match(/^STAT .* obj=(\d+) op='(?:[A-Z ]+?) ([A-Z_$][A-Z0-9_$#]*) \(/)
  if (m && m[1] !== '0') objName[m[1]] = m[2]
}

const stmts = {} // sqlid -> {sqlid, text, dep, oct, plhs:[], color index}
const cursors = {} // cursor# -> {sqlid, open: execution record}
const rows = []
let order = 0

function waitParams(rest) {
  const p = {}
  for (const m of rest.matchAll(/([a-z#|_ ]+?)=\s*(-?\d+)/gi)) p[m[1].trim()] = Number(m[2])
  return p
}

for (const [from, to] of RANGES) {
  if (rows.length) rows.push({ k: 'elided', from: rows.at(-1).ln + 1, to: from - 1 })
  let i = from - 1
  while (i < to) {
    const l = trc[i], ln = i + 1
    let m
    if ((m = l.match(/^PARSING IN CURSOR #(\d+) len=(\d+) dep=(\d+) uid=(\d+) oct=(\d+) .*tim=(\d+) .*sqlid='(\w+)'/))) {
      const text = []
      i++
      while (trc[i] !== 'END OF STMT') text.push(trc[i++])
      const sql = text.join('\n').trimEnd()
      const [, cur, , dep, , oct, tim, sqlid] = m
      stmts[sqlid] ??= { sqlid, text: sql, dep: +dep, oct: +oct, uid: +m[4], plhs: [], order: order++ }
      cursors[cur] = { sqlid }
      rows.push({ k: 'SQL', ln, cur, sqlid, dep: +dep, tim: +tim, len: +m[2], oct: +oct, uid: +m[4] })
      i++
      continue
    }
    if ((m = l.match(/^(PARSE|EXEC|FETCH|CLOSE) #(\d+):(.*)$/))) {
      const o = kv(m[3]), cur = m[2], st = cursors[cur]
      const plh = num(o, 'plh')
      if (st && plh) { const s = stmts[st.sqlid]; if (!s.plhs.includes(plh)) s.plhs.push(plh) }
      rows.push({ k: m[1], ln, cur, sqlid: st?.sqlid, c: num(o, 'c'), e: num(o, 'e'), p: num(o, 'p'), cr: num(o, 'cr'), cu: num(o, 'cu'), mis: num(o, 'mis'), r: num(o, 'r'), dep: num(o, 'dep'), plh, type: num(o, 'type'), tim: num(o, 'tim') })
      i++
      continue
    }
    if ((m = l.match(/^WAIT #(\d+): nam='([^']+)' ela= (\d+) (.*) tim=(\d+)/))) {
      const p = waitParams(m[4])
      const obj = p['obj#'] > 0 ? (objName[p['obj#']] ?? `obj# ${p['obj#']}`) : undefined
      rows.push({ k: 'WAIT', ln, cur: m[1], sqlid: cursors[m[1]]?.sqlid, nam: m[2], ela: +m[3], tim: +m[5], obj, file: p['file number'], block: p['first dba'], blocks: p['block cnt'] })
      i++
      continue
    }
    if ((m = l.match(/^BINDS #(\d+):/))) {
      const binds = []
      i++
      while (i < to && !/^[A-Z=*]/.test(trc[i])) {
        const b = trc[i].match(/^ Bind#(\d+)/)
        if (b) binds.push({ pos: +b[1], dty: undefined, value: null, avl: undefined })
        const last = binds.at(-1)
        let x
        if (last && (x = trc[i].match(/oacdty=(\d+)/))) last.dty = +x[1]
        if (last && (x = trc[i].match(/avl=(\d+)/))) last.avl = +x[1]
        if (last && (x = trc[i].match(/^\s+value=(.*)$/))) last.value = x[1]
        i++
      }
      rows.push({ k: 'BINDS', ln, cur: m[1], sqlid: cursors[m[1]]?.sqlid, binds })
      continue
    }
    if ((m = l.match(/^STAT #(\d+) /))) {
      const plan = [], cur = m[1]
      while (i < to && trc[i].startsWith(`STAT #${cur} `)) {
        const s = trc[i].match(/id=(\d+) cnt=(\d+) pid=(\d+) pos=(\d+) obj=(\d+) op='(.*)'$/)
        const [, id, cnt, pid, pos, obj, op] = s
        const st = kv(op.slice(op.lastIndexOf('(') + 1).replace(/\)$/, ''))
        const opName = op.slice(0, op.lastIndexOf('(')).trim()
        const name = obj !== '0' ? objName[obj] : undefined
        plan.push({ id: +id, pid: +pid, pos: +pos, cnt: +cnt, op: name ? opName.slice(0, -name.length).trim() : opName, name, cr: num(st, 'cr'), pr: num(st, 'pr'), pw: num(st, 'pw'), str: num(st, 'str'), time: num(st, 'time'), cost: num(st, 'cost'), card: num(st, 'card') })
        i++
      }
      rows.push({ k: 'PLAN', ln, cur, sqlid: cursors[cur]?.sqlid, plan, to: i })
      continue
    }
    if ((m = l.match(/^\*\*\* (ACTION NAME|MODULE NAME):\((.*)\)/))) { rows.push({ k: 'MARK', ln, text: `${m[1] === 'ACTION NAME' ? 'action' : 'module'} ${m[2]}` }); i++; continue }
    i++ // =====, blank lines, *** timestamps
  }
}

// wall clock per row
for (const r of rows) if (r.tim !== undefined) r.us = ANCHOR_US + (r.tim - ANCHOR_TIM)

// every line as written, for the default (unfolded) view; tim is dropped once us is known
const flat = rows.map(({ tim, ...r }) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)))

// collapse waits: a run of 3+ same-name waits of one cursor is one row; a block between two calls that is still long
// after that becomes one summary row with a breakdown
const IDLE = new Set(['SQL*Net message from client'])
const out = []
for (let j = 0; j < rows.length;) {
  const r = rows[j]
  if (r.k !== 'WAIT' || IDLE.has(r.nam)) { out.push(r); j++; continue }
  let e = j
  while (e < rows.length && rows[e].k === 'WAIT' && rows[e].cur === r.cur && !IDLE.has(rows[e].nam)) e++
  const block = rows.slice(j, e)
  const runs = []
  for (const w of block) {
    const last = runs.at(-1)
    if (last && last[0].nam === w.nam) last.push(w)
    else runs.push([w])
  }
  const runRow = (ws) => ws.length < 3 ? ws : [{
    k: 'RUN', ln: ws[0].ln, lnTo: ws.at(-1).ln, cur: r.cur, sqlid: r.sqlid, nam: ws[0].nam, n: ws.length,
    ela: ws.reduce((a, w) => a + w.ela, 0), max: Math.max(...ws.map((w) => w.ela)), tim: ws.at(-1).tim, us: ws.at(-1).us, us0: ws[0].us - ws[0].ela,
    obj: ws[0].obj, blocksMin: Math.min(...ws.map((w) => w.blocks ?? 0)), blocksMax: Math.max(...ws.map((w) => w.blocks ?? 0)),
    items: ws.slice(0, 60), more: Math.max(0, ws.length - 60),
  }]
  const flat = runs.flatMap(runRow)
  if (flat.length <= 10) out.push(...flat)
  else {
    const by = {}
    for (const w of block) { by[w.nam] ??= { nam: w.nam, n: 0, ela: 0 }; by[w.nam].n++; by[w.nam].ela += w.ela }
    out.push({
      k: 'BLOCK', ln: block[0].ln, lnTo: block.at(-1).ln, cur: r.cur, sqlid: r.sqlid, n: block.length,
      ela: block.reduce((a, w) => a + w.ela, 0), tim: block.at(-1).tim, us: block.at(-1).us, us0: block[0].us - block[0].ela,
      by: Object.values(by).sort((a, b) => b.ela - a.ela), items: flat.slice(0, 40), more: Math.max(0, flat.length - 40),
    })
  }
  j = e
}

// fold fetch loops: 6+ FETCH calls of one cursor with only short waits between them become one row;
// a fetch that takes 1 % of the excerpt or more stays on its own line
const usOf = (r) => r.us
const spanUs = (() => { const t = out.filter((r) => r.us !== undefined); return t.at(-1).us - t[0].us })()
const folded = []
for (let j = 0; j < out.length;) {
  const r = out[j]
  const small = (x) => x.k === 'FETCH' && x.cur === r.cur && x.e < spanUs * 0.01
  if (!small(r)) { folded.push(r); j++; continue }
  let e = j, last = j
  const fetches = []
  while (e < out.length && (small(out[e]) || (['WAIT', 'RUN'].includes(out[e].k) && out[e].cur === r.cur && out[e].ela < spanUs * 0.01))) {
    if (out[e].k === 'FETCH') { fetches.push(out[e]); last = e }
    e++
  }
  if (fetches.length < 6) { folded.push(r); j++; continue }
  const part = out.slice(j, last + 1)
  const sum = (k) => fetches.reduce((a, f) => a + (f[k] ?? 0), 0)
  folded.push({
    k: 'FETCHES', ln: r.ln, lnTo: out[last].ln, cur: r.cur, sqlid: r.sqlid, dep: r.dep, n: fetches.length,
    e: sum('e'), c: sum('c'), r: sum('r'), p: sum('p'), cr: sum('cr'), max: Math.max(...fetches.map((f) => f.e)),
    idle: part.filter((x) => x.k === 'WAIT' && x.nam === 'SQL*Net message from client').reduce((a, w) => a + w.ela, 0),
    tim: out[last].tim, us: usOf(out[last]), us0: r.us - r.e, items: fetches.slice(0, 60), more: Math.max(0, fetches.length - 60),
  })
  j = last + 1
}
out.length = 0
out.push(...folded)

const data = { file: 'io_waits.trc', lines: trc.length, stmts, flat, folded: out }
const json = JSON.stringify(data)
writeFileSync(join(here, 'data.json'), json)
writeFileSync(join(here, 'index.html'), readFileSync(join(here, 'template.html'), 'utf8').replace('/*DATA*/null', json))
console.log(`${flat.length} lines, ${out.length} folded rows, ${Object.keys(stmts).length} statements, ${(json.length / 1024).toFixed(0)} KB`)
