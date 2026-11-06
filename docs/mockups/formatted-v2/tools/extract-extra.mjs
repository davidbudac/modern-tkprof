// Parse the extra line ranges the mock-up needs (the spec's rows.json stops short of them) from the real io_waits.trc
// and write data/extra.json. Same row shapes and the same (uncorrected) clock convention as rows.json; the page adds the
// 619 µs correction to every clock (see CLOCK_FIX_US in src/model.js).
//   node tools/extract-extra.mjs [path/to/io_waits.trc] > data/extra.json
import { readFileSync } from 'node:fs'
const TRACE = process.argv[2] || '/Users/davidbudac/claude_projects/modern-tkprof/testdata/traces/19c/io_waits.trc'
const trc = readFileSync(TRACE, 'utf8').split('\n')

// lines 84-94: the c7ry5gr75qv4b cursor start, the 632 ms enq: KO wait; 141-200: the rest of the 1-bind BINDS block of 10gywwmwk6xfy and
// the 8-bind block of dbvj6jc977hqh; 3011-3014 / 10402-10443: the rest of the loop's last bind (3011-3014) and the 8-bind block of dbvj6jc977hqh that the second excerpt ends in;
// 792-794 and 6878-6881: the SQL text of dk21j71dpu26c and 52nzchs09dgn1 (for the sticky lane label)
const RANGES = [[84, 94], [141, 200], [3011, 3014], [10402, 10443], [792, 794], [6878, 6881]]
const ANCHOR_TIM = 10805134758, ANCHOR_US = ((11 * 60 + 35) * 60 + 29) * 1e6 + 826769
const objName = {}
for (const l of trc) { const m = l.match(/^STAT .* obj=(\d+) op='(?:[A-Z ]+?) ([A-Z_$][A-Z0-9_$#]*) \(/); if (m && m[1] !== '0') objName[m[1]] = m[2] }
const kv = (s) => Object.fromEntries([...s.matchAll(/([\w# ]+?)=\s*(-?[^,\s]+)/g)].map((m) => [m[1].trim(), m[2]]))
const clock = (tim) => { const us = ANCHOR_US + (tim - ANCHOR_TIM); const s = Math.floor(us / 1e6); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(us % 1e6).padStart(6, '0')}` }

// walk the whole file once: which sql_id each cursor number meant at each line, and the execution count of each sql_id
const sqlAt = new Array(trc.length + 1)       // line -> sqlid of the cursor the line belongs to (calls / waits / binds / stat)
const execNoAt = {}                            // line of an EXEC -> [n, total]
const stmtE = {}                               // sqlid -> { e: µs of its calls, calls: n }
{
  const cur = {}, execs = {}, execLines = {}
  trc.forEach((l, i) => {
    let m
    if ((m = l.match(/^PARSING IN CURSOR #(\d+) .* sqlid='(\w+)'/))) cur[m[1]] = m[2]
    else if ((m = l.match(/^(PARSE|EXEC|FETCH|CLOSE|WAIT|STAT|BINDS) #(\d+)/))) {
      const sid = cur[m[2]]
      sqlAt[i + 1] = sid
      if (m[1] === 'EXEC' && sid) { (execLines[sid] ||= []).push(i + 1) }
      if (sid && /^(PARSE|EXEC|FETCH|CLOSE)$/.test(m[1])) { const e = +(l.match(/[:,]e=(\d+)/)?.[1] ?? 0); const s = (stmtE[sid] ||= { e: 0, calls: 0, waits: 0 }); s.e += e; s.calls++ }
      if (sid && m[1] === 'WAIT') { const s = (stmtE[sid] ||= { e: 0, calls: 0, waits: 0 }); s.waits++ }
    }
  })
  for (const [sid, ls] of Object.entries(execLines)) ls.forEach((ln, k) => { execNoAt[ln] = [k + 1, ls.length] })
}

const out = []
for (const [a, b] of RANGES) {
  const rows = []
  for (let ln = a; ln <= b; ln++) {
    const l = trc[ln - 1]; let m
    const base = { ln, raw: l }
    if ((m = l.match(/^WAIT #(\d+): nam='([^']+)' ela= (\d+) (.*) tim=(\d+)/))) { const p = kv(m[4]); rows.push({ ...base, k: 'WAIT', cur: m[1], sqlid: sqlAt[ln], nam: m[2], ela: +m[3], p, obj: p['obj#'] > 0 ? objName[p['obj#']] : undefined, clock: clock(+m[5]), tim: +m[5] }); continue }
    if ((m = l.match(/^(PARSE|EXEC|FETCH|CLOSE) #(\d+):(.*)$/))) { const o = kv(m[3]); const r = { ...base, k: m[1], cur: m[2], sqlid: sqlAt[ln], ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v])), clock: clock(+o.tim) }; if (execNoAt[ln]) { r.execNo = execNoAt[ln][0]; r.execTotal = execNoAt[ln][1] } rows.push(r); continue }
    if ((m = l.match(/^PARSING IN CURSOR #(\d+) len=(\d+) dep=(\d+) uid=(\d+) oct=(\d+) .*tim=(\d+) .*sqlid='(\w+)'/))) { rows.push({ ...base, k: 'CURSOR', cur: m[1], sqlid: m[7], len: +m[2], dep: +m[3], uid: +m[4], oct: +m[5], clock: clock(+m[6]), tim: +m[6] }); continue }
    if ((m = l.match(/^STAT #(\d+) id=(\d+) cnt=(\d+) pid=(\d+) pos=(\d+) obj=(\d+) op='(.*)'$/))) { const op = m[7]; const st = kv(op.slice(op.lastIndexOf('(') + 1).replace(/\)$/, '')); let opName = op.slice(0, op.lastIndexOf('(')).trim(); const name = m[6] !== '0' ? objName[m[6]] : undefined; if (name && opName.endsWith(name)) opName = opName.slice(0, -name.length).trim(); rows.push({ ...base, k: 'STAT', cur: m[1], sqlid: sqlAt[ln], id: +m[2], cnt: +m[3], pid: +m[4], op: opName, name, ...Object.fromEntries(Object.entries(st).map(([k, v]) => [k, +v])) }); continue }
    if ((m = l.match(/^BINDS #(\d+):/))) { rows.push({ ...base, k: 'BINDS', cur: m[1], sqlid: sqlAt[ln] }); continue }
    if ((m = l.match(/^ Bind#(\d+)/))) { rows.push({ ...base, k: 'BIND', pos: +m[1] }); continue }
    if ((m = l.match(/^\*\*\* (.*?):\((.*)\) (\S+)/))) { rows.push({ ...base, k: 'MARK', name: m[1], value: m[2], at: m[3] }); continue }
    if (l === 'END OF STMT') { rows.push({ ...base, k: 'ENDSTMT' }); continue }
    if (/^=+$/.test(l)) { rows.push({ ...base, k: 'RULE' }); continue }
    if (l.trim() === '') { rows.push({ ...base, k: 'BLANK' }); continue }
    if (/^\s+(oacdty|oacflg|kxsbbbfp|value)=/.test(l)) { rows.push({ ...base, k: 'BINDATTR', text: l.trim() }); continue }
    rows.push({ ...base, k: 'TEXT', text: l })
  }
  out.push({ from: a, to: b, rows })
}
// the exec numbers of the excerpts' EXEC lines in rows.json (the loop's selected exec must come out as 221 of 300)
const loopExec = {}
for (const [a, b] of [[23, 60], [84, 200], [2960, 3014], [10355, 10443]]) for (let ln = a; ln <= b; ln++) if (execNoAt[ln]) loopExec[ln] = execNoAt[ln]
// the tim of the line with a time before each excerpt's first line (the app looks back at most 400 lines), for the first row's Δ
const timOfText = (l) => (/^(WAIT|PARSE|EXEC|FETCH|CLOSE|PARSING IN CURSOR) /.test(l) ? +(l.match(/tim=(\d+)/)?.[1] ?? NaN) : NaN)
const prevTim = {}
for (const start of [23, 84, 2960, 10355]) { prevTim[start] = null; for (let x = start - 1, i = 0; x >= 1 && i < 400; x--, i++) { const t = timOfText(trc[x - 1]); if (!Number.isNaN(t)) { prevTim[start] = { ln: x, tim: t }; break } } }
const firstTim = +trc.find((l) => /tim=\d+/.test(l)).match(/tim=(\d+)/)[1]
const lastTim = +[...trc].reverse().find((l) => /tim=\d+/.test(l)).match(/tim=(\d+)/)[1]
console.log(JSON.stringify({ excerpts: out, loopExec, prevTim, span: { firstTim, lastTim, us: lastTim - firstTim }, stmtE }, null, 1))
