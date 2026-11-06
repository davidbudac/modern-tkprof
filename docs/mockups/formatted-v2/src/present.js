// ---- present(): the rows of a line range as the display items of the Lines view, NOW or with the proposals applied --------------
// `o` carries the proposal flags p1..p9 (all off = what the app draws today). Each item is { type, r, ... } for one displayed row.

/** The plan metrics of a run of STAT rows: depth from pid, own time = time minus the children's, root = the whole plan's time. */
function planOf(stats) {
  const byId = new Map(stats.map((s) => [s.id, s]))
  const depth = (s) => { let d = 0; for (let p = byId.get(s.pid); p; p = byId.get(p.pid)) d++; return d }
  const kids = new Map()
  for (const s of stats) kids.set(s.pid, (kids.get(s.pid) || 0) + (s.time || 0))
  const root = stats.find((s) => !byId.has(s.pid))
  return stats.map((s) => {
    const cost = s['us cost'] ?? s.cost
    const perStart = Math.max(s.cnt / Math.max(1, s.str ?? 1), 1)
    const ratio = s.card !== undefined ? perStart / Math.max(s.card, 1) : 1
    return {
      id: s.id, pid: s.pid, depth: depth(s), op: s.op, name: s.name, starts: s.str, eRows: s.card, aRows: s.cnt, cost,
      time: s.time, self: Math.max(0, (s.time || 0) - (kids.get(s.id) || 0)), root: root ? root.time : s.time, cr: s.cr, pr: s.pr, pw: s.pw,
      off: s.card !== undefined && (ratio >= 10 || ratio <= 0.1), perStart,
    }
  })
}

const isCall = (r) => ['PARSE', 'EXEC', 'FETCH', 'CLOSE'].includes(r.k)
const isIdle = (r) => r.k === 'WAIT' && r.role === 'idle'

function present(a, b, o) {
  const seg = segOf(a), rows = seg.rows
  const lo = rows.findIndex((r) => r.ln === a), hi = rows.findIndex((r) => r.ln === b)
  const items = []
  const inline = new Set()   // BINDS rows drawn as chips (p6a): their Bind# rows are not drawn
  let ruleBefore = false
  for (let i = lo; i <= hi; i++) {
    const r = rows[i], prev = rows[i - 1]
    switch (r.k) {
      case 'BINDATTR': break                                   // the attribute lines are folded under their Bind# row
      case 'BLANK':
        if (o.p6) break                                        // (b) folds quietly
        if (prev && ['BINDS', 'BIND', 'BINDATTR', 'BLANK'].includes(prev.k)) break // the blank under BINDS is part of its table
        items.push({ type: 'blank', r }); break
      case 'RULE': if (o.p6) ruleBefore = true; else items.push({ type: 'rule', r }); break
      case 'ENDSTMT': if (!o.p6) items.push({ type: 'end', r }); break
      case 'TEXT': items.push({ type: /^\*\*\*/.test(r.text) ? 'time' : 'sql', r }); break
      case 'MARK': items.push({ type: 'mark', r }); break
      case 'CURSOR': { const it = { type: 'cursor', r }; if (ruleBefore) { it.ruleTop = true; ruleBefore = false } items.push(it); break }
      case 'BINDS': {
        const ok = o.p6 && r.binds.length > 0 && r.binds.length <= 4 && r.binds.every((x) => x.value.length <= 24)
        if (ok) { inline.add(r); items.push({ type: 'binds-inline', r }) } else items.push({ type: 'binds', r })
        break
      }
      case 'BIND': {
        const br = r.bindsRow
        if (br && (inline.has(br) || (o.p6 && br.orphan))) break
        items.push({ type: 'bindrow', r, bind: br.binds.find((x) => x.ln === r.ln), head: br }); break
      }
      case 'STAT': {
        if (prev && prev.k === 'STAT' && prev.cur === r.cur && i > lo) break   // handled with the first row of its run
        let s = i, e = i
        while (rows[s - 1] && rows[s - 1].k === 'STAT' && rows[s - 1].cur === r.cur) s--
        while (rows[e + 1] && rows[e + 1].k === 'STAT' && rows[e + 1].cur === r.cur) e++
        const run = rows.slice(s, e + 1), plans = planOf(run)
        items.push({ type: 'planhead', r: run[0], plan: plans })
        for (let k = i; k <= Math.min(e, hi); k++) items.push({ type: 'plan', r: rows[k], plan: plans[k - s], first: k === s, last: k === e })
        break
      }
      default: items.push({ type: isCall(r) ? 'call' : r.k === 'WAIT' ? 'wait' : 'other', r })
    }
  }
  post(items, o, seg)
  return items
}

/** The passes over the displayed rows: skips, execution starts, brackets, runs of the same wait, the clock. */
function post(items, o, seg) {
  const lnItems = items.filter((it) => it.r && it.type !== 'planhead')
  // p6: a dotted gap mark in the # cell where lines were folded away
  if (o.p6) lnItems.forEach((it, k) => { const p = lnItems[k - 1]; if (p && it.r.ln - p.r.ln > 1) it.gap = true })
  // executions: the first row of each is its BINDS row when it has one, else its EXEC row (found in the model rows, so a BINDS row whose
  // EXEC is below the range still knows its execution)
  const rws = seg.rows
  const afterBinds = (i) => { for (let k = i + 1; k < rws.length; k++) { if (['BLANK', 'BIND', 'BINDATTR'].includes(rws[k].k)) continue; return rws[k].k === 'EXEC' ? rws[k] : null } return null }
  const beforeExec = (i) => { for (let k = i - 1; k >= 0; k--) { if (['BLANK', 'BINDATTR'].includes(rws[k].k)) continue; return rws[k].k === 'BINDS' || rws[k].k === 'BIND' } return false }
  items.forEach((it) => {
    const r = it.r
    if (!r) return
    let ex = null
    if (it.type === 'binds' || it.type === 'binds-inline') ex = afterBinds(rws.indexOf(r))
    else if (it.type === 'call' && r.k === 'EXEC' && !beforeExec(rws.indexOf(r))) ex = r
    if (ex && ex.execNo) { it.execFirst = true; it.execNo = ex.execNo; it.execTotal = ex.execTotal; if (it.type !== 'call') r._exec = ex.execNo }
  })
  // p4: the call says what it waited for; wait rows under a call are bracketed
  if (o.p4) {
    let open = -1
    items.forEach((it, k) => {
      const r = it.r
      if (it.type === 'wait' && r.role !== 'idle' && r.inst) { if (open < 0 || items[open].r.inst !== r.inst) open = k }
      else if (it.type === 'call' && open >= 0) {
        if (items[open].r.inst === r.inst) {
          for (let j = open; j < k; j++) { items[j].br = j === open ? 'first' : 'in'; if (items[j].type === 'wait' && items[j].r.role !== 'idle') items[j].indent = true }
          it.br = 'end'
        }
        open = -1
      } else if (it.type === 'cursor' || it.type === 'planhead') open = -1
    })
    items.forEach((it) => {
      const r = it.r
      if (it.type === 'call' && r.e !== undefined && r.c !== undefined) {
        const waited = r.e - r.c
        if (waited >= 0.1 * r.e && waited >= 100) it.share = { us: waited, pct: Math.round((100 * waited) / r.e), crit: waited >= 0.5 * r.e }
      }
    })
  }
  // p7: a run of 3 or more waits of the same event and object (inside one call's waits) gets micro-columns; a wait whose neighbour above is
  // in the same run drops its prefix to a ditto
  if (o.p7) {
    const groups = []
    let g = []
    items.forEach((it) => { if (it.type === 'wait') g.push(it); else if (it.type === 'call' || it.type === 'cursor') { groups.push(g); g = [] } })
    groups.push(g)
    const key = (it) => it.r.nam + '|' + (it.r.obj || '')
    for (const grp of groups) {
      const counts = {}
      grp.forEach((it) => { if (it.r.role !== 'idle' && it.r.role !== 'network') counts[key(it)] = (counts[key(it)] || 0) + 1 })
      grp.forEach((it) => {
        if (counts[key(it)] >= 3 && it.r.role === 'userio' && it.r.params.length === 3) {
          it.micro = true
          const k = items.indexOf(it), p = items[k - 1]
          it.ditto = !!(p && p.micro && key(p) === key(it))
        }
      })
    }
  }
  // p8: the link of a BINDS table is a row after its last bind row, not a header cell
  if (o.p8) {
    for (let k = items.length - 1; k >= 0; k--) {
      const it = items[k]
      if (it.type === 'bindrow' && it.bind && it.bind.last) { it.footer = true; items.splice(k + 1, 0, { type: 'bindfoot', r: it.r, head: it.head }) }
    }
  }
  // p9: the full clock on the first row, the selected row and where HH:MM:SS changes, else the changing microseconds
  if (o.p9) {
    let last = null
    items.forEach((it) => {
      const c = clockOf(it)
      if (!c) return
      const hms = c.slice(0, 8)
      it.clockFull = last === null || hms !== last || (o.sel !== undefined && it.r.ln === o.sel)
      last = hms
    })
  }
}

/** The clock string a row shows (µs precision), or '' for none. */
function clockOf(it) {
  const r = it.r
  if (!r) return ''
  if (it.type === 'time') { const m = /(\d\d:\d\d:\d\d\.\d+)/.exec(r.text); return m ? m[1] : '' }
  if (it.type === 'mark') return r.clock || ''
  if (r.t !== undefined && ['call', 'wait', 'cursor'].includes(it.type)) return usToClock(r.t)
  return ''
}
