// Parse real io_waits.trc ranges into row objects for the mock-up. node extract.mjs > rows.json
import { readFileSync } from 'node:fs'
const trc = readFileSync('/Users/davidbudac/claude_projects/modern-tkprof/testdata/traces/19c/io_waits.trc', 'utf8').split('\n')
const RANGES = [[23, 60], [95, 140], [2960, 3010], [10355, 10401]]
const ANCHOR_TIM = 10805134758, ANCHOR_US = ((11 * 60 + 35) * 60 + 29) * 1e6 + 826769
const objName = {}
for (const l of trc) { const m = l.match(/^STAT .* obj=(\d+) op='(?:[A-Z ]+?) ([A-Z_$][A-Z0-9_$#]*) \(/); if (m && m[1] !== '0') objName[m[1]] = m[2] }
const cursors = {}
for (const l of trc) { const m = l.match(/^PARSING IN CURSOR #(\d+) .* sqlid='(\w+)'/); if (m) cursors[m[1]] = m[2] }
const kv = (s) => Object.fromEntries([...s.matchAll(/([\w# ]+?)=\s*(-?[^,\s]+)/g)].map((m) => [m[1].trim(), m[2]]))
const clock = (tim) => { const us = ANCHOR_US + (tim - ANCHOR_TIM); const s = Math.floor(us / 1e6); return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}.${String(us % 1e6).padStart(6, '0')}` }
const out = []
for (const [a, b] of RANGES) {
  const rows = []
  for (let ln = a; ln <= b; ln++) {
    const l = trc[ln - 1]; let m
    const base = { ln, raw: l }
    if ((m = l.match(/^WAIT #(\d+): nam='([^']+)' ela= (\d+) (.*) tim=(\d+)/))) { const p = kv(m[4]); rows.push({ ...base, k: 'WAIT', cur: m[1], sqlid: cursors[m[1]], nam: m[2], ela: +m[3], p, obj: p['obj#'] > 0 ? objName[p['obj#']] : undefined, clock: clock(+m[5]), tim: +m[5] }); continue }
    if ((m = l.match(/^(PARSE|EXEC|FETCH|CLOSE) #(\d+):(.*)$/))) { const o = kv(m[3]); rows.push({ ...base, k: m[1], cur: m[2], sqlid: cursors[m[2]], ...Object.fromEntries(Object.entries(o).map(([k, v]) => [k, +v])), clock: clock(+o.tim) }); continue }
    if ((m = l.match(/^PARSING IN CURSOR #(\d+) len=(\d+) dep=(\d+) uid=(\d+) oct=(\d+) .*tim=(\d+) .*sqlid='(\w+)'/))) { rows.push({ ...base, k: 'CURSOR', cur: m[1], sqlid: m[7], dep: +m[3], uid: +m[4], oct: +m[5], clock: clock(+m[6]) }); continue }
    if ((m = l.match(/^STAT #(\d+) id=(\d+) cnt=(\d+) pid=(\d+) pos=(\d+) obj=(\d+) op='(.*)'$/))) { const op = m[7]; const st = kv(op.slice(op.lastIndexOf('(') + 1).replace(/\)$/, '')); let opName = op.slice(0, op.lastIndexOf('(')).trim(); const name = m[6] !== '0' ? objName[m[6]] : undefined; if (name && opName.endsWith(name)) opName = opName.slice(0, -name.length).trim(); rows.push({ ...base, k: 'STAT', cur: m[1], sqlid: cursors[m[1]], id: +m[2], cnt: +m[3], pid: +m[4], op: opName, name, ...Object.fromEntries(Object.entries(st).map(([k, v]) => [k, +v])) }); continue }
    if ((m = l.match(/^BINDS #(\d+):/))) { rows.push({ ...base, k: 'BINDS', cur: m[1], sqlid: cursors[m[1]] }); continue }
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
console.log(JSON.stringify(out, null, 1))
