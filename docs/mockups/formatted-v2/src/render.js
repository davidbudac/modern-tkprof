// ---- render(): display items -> the DOM of a pane (a header row and the rows), NOW or PROPOSED ------------------------------------
// Class names are the implementation vocabulary: .row .c-delta .c-ln .c-lane .c-fh .c-dur .c-op .c-detail .c-clock .bar .hot .sel .mk
// .sticky-lane .tbl-plan .tbl-binds .chip ... (rows.css has the rules, commented per section).

const SQL_KW = new Set(('select from where and or not in is null as on join left right inner outer full cross group by order having union all intersect minus insert into values update set delete merge using when matched then else end case begin declare exception create alter drop table index view with distinct exists between like escape asc desc nulls first last fetch next rows only offset for return returning commit rollback grant execute procedure function package body cursor loop if elsif while connect start prior partition over count sum min max avg nvl decode cast to_date to_char to_number sysdate rownum level').split(' '))
function sqlHtml(text) {
  const re = /(--.*$|\/\*.*?(?:\*\/|$))|('(?:[^']|'')*'?)|(:[A-Za-z_][\w$#]*|:\d+)|([A-Za-z_][\w$#]*)|(\s+|[^\sA-Za-z_':\-\/]+|.)/g
  let out = ''
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[1]) out += `<span class="rd-cmt">${esc(m[1])}</span>`
    else if (m[2]) out += `<span class="rd-str">${esc(m[2])}</span>`
    else if (m[3]) out += `<span class="rd-bind">${esc(m[3])}</span>`
    else if (m[4] && SQL_KW.has(m[4].toLowerCase())) out += `<span class="rd-kw">${esc(m[4])}</span>`
    else out += esc(m[0])
  }
  return out
}

const q = (cls, n, unit) => `<span class="rd-q rd-q-${cls}"><b>${esc(n)}</b> <small>${esc(unit)}</small></span>`
const dim = (t) => `<span class="rd-dim">${esc(t)}</span>`
const SEP = dim(' · ')

// ---- the detail text of a call, a wait, a cursor ----------------------------------------------------------------------------------
function callDetail(it, o) {
  const r = it.r, gets = (r.cr || 0) + (r.cu || 0)
  let h = ''
  if (r.c && (r.e === undefined || (fmtDur(r.c) !== fmtDur(r.e) && r.c < r.e))) { const [n, u] = durParts(r.c); h += q('cpu', n, u + ' cpu') }
  if (r.r !== undefined && (r.k === 'FETCH' || r.r > 0)) h += q('rows', fmtInt(r.r), r.r === 1 ? 'row' : 'rows')
  if (gets > 0) h += q('gets', fmtInt(gets), gets === 1 ? 'get' : 'gets')
  if ((r.p || 0) > 0) h += q('reads', fmtInt(r.p), r.p === 1 ? 'read' : 'reads')
  if ((r.mis || 0) > 0) h += o.p4 ? `<span class="pill-hp">hard parse</span>` : `<span class="rd-warn">hard parse</span>`
  if (r.k === 'CLOSE' && r.type !== undefined) h += dim(o.p6 ? (r.type === 0 ? 'closed' : 'cached') : CLOSE_TYPES[r.type])
  if (it.share) h += `<span class="share${it.share.crit ? ' crit' : ''}">· ${fmtDur(it.share.us)} waiting (${it.share.pct} %)</span>`
  return h
}

const PARAM_LABELS = { 'file#': 'file', 'file number': 'file', 'block#': 'block', 'first dba': 'block', blocks: 'blocks', 'block cnt': 'blocks', 'driver id': null, '#bytes': 'bytes', p1: null, p2: null, p3: null, 'outstanding #aio': 'outstanding aio', 'current aio limit': 'aio limit', 'new aio limit': 'new aio limit', FileOperation: 'operation', fileno: 'file', filetype: 'file type', 'sleeptime/senderid': null, passes: 'passes' }
/** The parameters of a wait worth reading, as the app labels them; zeros are left out. `o.p6` also drops the single byte of a SQL*Net message. */
function waitParams(r, o) {
  const out = []
  for (const p of r.params) {
    if (p.value === '' || p.value === '0') continue
    const n = Number(p.value)
    if (p.label === 'name|mode' && Number.isFinite(n)) { out.push(dim(`mode ${n & 0xffff}`)); continue }
    const label = p.label in PARAM_LABELS ? PARAM_LABELS[p.label] : p.label
    if (label === null) continue
    const isNum = Number.isFinite(n) && /^\d+$/.test(p.value)
    if (label === 'blocks' || label === 'bytes') {
      if (o && o.p6 && label === 'bytes' && n === 1) continue
      out.push(`<span class="rd-num">${fmtInt(n)}</span>` + dim(` ${n === 1 ? label.slice(0, -1) : label}`))
    } else out.push(dim(`${label} `) + `<span class="rd-num">${isNum && label !== 'block' && label !== 'file' ? fmtInt(n) : esc(p.value)}</span>`)
  }
  return out
}
const objOf = (r) => (r.obj && r.role === 'userio' ? r.obj : '')

function waitDetail(it, o, ctx) {
  const r = it.r
  const dot = o.p4 ? `<i class="dot${r.role === 'idle' ? ' ring' : ''}" style="--dot: var(${ROLE_VAR[r.role]})" title="${ROLE_NAME[r.role] || 'Other'}"></i>` : ''
  if (it.micro) return microDetail(it, o, ctx, dot)
  let h = dot + `<span class="rd-ev">${esc(r.nam)}</span>`
  const obj = objOf(r)
  if (obj) h += `<span class="rd-evobj">${esc(obj)}</span>`
  const ps = waitParams(r, o)
  if (ps.length) h += `<span class="rd-pgap"></span>` + ps.join(SEP)
  return h
}

/** p7: the repeated prefix is a ditto, the varying fields are right-aligned micro-columns (file | block | blocks). */
function microDetail(it, o, ctx, dot) {
  const r = it.r
  const obj = objOf(r)
  const [f, b, n] = r.params
  const pre = `<span class="pre${it.ditto ? ' ditto' : ''}" style="--ch: ${ctx.prefixCh}">${dot}<span class="rd-ev">${esc(r.nam)}</span>${obj ? `<span class="rd-evobj">${esc(obj)}</span>` : ''}</span>`
  const cells = `<span class="mc mc-file"><i>file</i> <b>${esc(f.value)}</b></span><span class="mc mc-block"><i>block</i> <b>${esc(b.value)}</b></span><span class="mc mc-blocks"><b>${fmtInt(+n.value)}</b> <i>${+n.value === 1 ? 'block' : 'blocks'}</i></span>`
  return pre + cells
}

function cursorDetail(it, o) {
  const r = it.r, txt = (SQLTEXT[r.sqlid] || [''])
  let h = `<span class="rd-name">${esc(r.sqlid)}</span>`
  const parts = [COMMANDS[r.oct] || `oct ${r.oct}`, `user ${r.uid}`]
  if (o.p6) {
    parts.push(`${r.len || txt.join('\n').length} chars`)
    if (r.dep) parts.splice(2, 0, `depth ${r.dep}`)
    return h + `<span class="rd-pgap"></span>` + dim(parts.join(' · '))
  }
  if (r.dep) parts.push(`depth ${r.dep}`)
  return h + parts.map((p) => SEP + dim(p)).join('')
}

const MARK_LABELS = { 'SESSION ID': 'SESSION', 'CLIENT ID': 'CLIENT', 'SERVICE NAME': 'SERVICE', 'MODULE NAME': 'MODULE', 'ACTION NAME': 'ACTION', 'CLIENT DRIVER': 'DRIVER', 'CONTAINER ID': 'CONTAINER' }

// ---- the cells ----------------------------------------------------------------------------------------------------------------------
function opOf(it, o) {
  const r = it.r
  switch (it.type) {
    case 'call': return { t: r.k, tone: 'cpu', cls: 'op-call' }
    case 'wait': return { t: r.cur === '0' ? 'WAIT #0' : 'WAIT', tone: 'userio', cls: 'op-wait' }
    case 'cursor': return { t: 'CURSOR', tone: 'sysio', cls: 'op-call' }
    case 'planhead': return { t: 'PLAN', tone: 'commit', cls: 'op-struct' }
    case 'binds': case 'binds-inline': return { t: 'BINDS', tone: 'network', cls: 'op-struct' }
    case 'mark': return { t: MARK_LABELS[r.name] || r.name, tone: 'dim', cls: 'op-mark' }
    case 'time': return { t: 'TIME', tone: 'dim', cls: 'op-mark' }
    default: return { t: '', tone: '', cls: '' }
  }
}
function opCell(it, o) {
  const x = opOf(it, o)
  let t = x.t
  if (o.p4 && x.cls === 'op-wait') t = t.toLowerCase().replace('wait #0', 'wait #0')
  const fold = o.p8 && (it.type === 'planhead' || it.type === 'binds') ? '<span class="fold">▾</span> ' : ''
  return `<div class="c-op ${o.p4 ? x.cls : ''} tone-${x.tone || 'none'}">${fold}${esc(t)}</div>`
}

function durCell(it, o) {
  const r = it.r
  if (!r || r.dur === undefined || it.type === 'planhead') return `<div class="c-dur"></div>`
  const [n, u] = durParts(r.dur)
  if (!o.p3) return `<div class="c-dur${r.dur === 0 && o.p6 ? ' zero' : ''}" title="${fmtInt(r.dur)} µs"><b>${n}</b><small>${u}</small></div>`
  const zero = r.dur === 0 && o.p6
  const f = (us) => (us >= 1 ? Math.min(1, Math.log10(us) / 7) : 0)
  const col = it.type === 'wait' ? `var(${ROLE_VAR[r.role]})` : `var(--c-phase-${r.k.toLowerCase()})`
  let fills = ''
  if (it.type === 'wait') fills = `<i class="fill" style="--f:${f(r.dur).toFixed(4)};--col:${col}"></i>`
  else fills = `<i class="fill waited" style="--f:${f(r.dur).toFixed(4)};--col:${col}"></i><i class="fill cpu" style="--f:${f(Math.min(r.dur, r.c ?? 0)).toFixed(4)};--col:${col}"></i>`
  let ticks = ''
  for (let k = 1; k <= 6; k++) ticks += `<u style="--x:${((k / 7) * 100).toFixed(3)}%"></u>`
  return `<div class="c-dur" title="${fmtInt(r.dur)} µs"><span class="dnum mag-${magOf(r.dur)}${zero ? ' zero' : ''}"><b>${n}</b><small>${u}</small></span><span class="trk">${fills}${ticks}</span></div>`
}

function deltaCell(it, o) {
  const r = it.r
  let txt = '', cls = ''
  if (r && r.t !== undefined && it.type !== 'planhead') {
    if (o.p3gap) {
      if (r.prevT !== null && r.prevT !== undefined) { const gap = r.t - (r.dur || 0) - r.prevT; if (gap >= 50) { txt = fmtDelta(gap); cls = gap >= 1000 && gap >= 2 * (r.prevDur || 0) ? ' emph' : '' } }
    } else if (r.delta !== undefined) {
      if (o.p3) { if (Math.abs(r.delta) >= 50) { txt = fmtDelta(r.delta); cls = r.delta >= 1000 && r.delta >= 2 * (r.prevDur || 0) ? ' emph' : '' } }
      else { txt = fmtDelta(r.delta); cls = r.delta < 0 ? ' neg' : '' }
    }
  }
  let bar = ''
  if (!o.p3 && !o.p3gap && r && r.dur !== undefined && it.type !== 'planhead') {
    const w = Math.min(1, r.dur / SCALE_US)
    if (w > 0) {
      const role = it.type === 'wait' ? r.role : 'cpu'
      bar += `<i class="bar bar-${role}" style="--w:${w.toFixed(4)}"></i>`
      if (it.type === 'call') { const cw = Math.min(1, Math.min(r.dur, r.c ?? 0) / SCALE_US); if (cw > 0) bar += `<b class="bar-solid" style="--w:${cw.toFixed(4)}"></b>` }
    }
  }
  return `<div class="c-delta">${bar}<span class="dtext${cls}">${txt}</span></div>`
}

function lnCell(it, o) {
  if (!it.r || it.type === 'planhead' || it.type === 'bindfoot') return `<div class="c-ln"></div>`
  return `<div class="c-ln${it.gap ? ' gap' : ''}">${it.r.ln}</div>`
}

const previewSql = (sqlid) => { const t = (SQLTEXT[sqlid] || []).join(' ').replace(/\s+/g, ' ').trim(); return t.length > 60 ? t.slice(0, 59) + '…' : t }
function laneCell(it, o) {
  const r = it.r
  if (!r || (r.laneKey ?? -1) < 0) return `<div class="c-lane lane-none"></div>`
  const inst = r.inst
  let h = ''
  if (!o.p5) {
    if (r.laneFirst && it.type !== 'bindrow') {
      h = (inst.depth > 0 ? `<span class="lane-dep">↳${inst.depth}</span>` : '') + `<a class="lane-id">${esc(inst.sqlid || 'unknown')}</a>`
    } else if (r.laneSecond && inst.sqlid && previewSql(inst.sqlid)) h = `<span class="lane-sub">${esc(previewSql(inst.sqlid))}</span>`
  }
  return `<div class="c-lane">${h}</div>`
}

function clockCell(it, o) {
  const c = clockOf(it)
  if (!c) return `<div class="c-clock"></div>`
  if (o.p9) {
    if (it.clockFull) return `<div class="c-clock full">${c}</div>`
    return `<div class="c-clock short">${c.slice(8)}</div>`
  }
  return `<div class="c-clock">${c.slice(0, 12)}<small>${c.slice(12)}</small></div>`
}

// ---- the tables ---------------------------------------------------------------------------------------------------------------------
const PLAN_HEADS = [['starts', 'Starts'], ['erows', 'E-Rows'], ['arows', 'A-Rows'], ['cost', 'Cost'], ['time', 'A-Time'], ['cr', 'Buffers'], ['pr', 'Reads'], ['pw', 'Writes']]
function planCells(p, o, hot) {
  const c = (cls, v) => `<span class="pc pc-${cls}">${v === undefined ? '' : fmtCompact(v)}</span>`
  const w = p.root ? Math.min(1, p.self / p.root) : 0
  let time
  if (o.p8) time = `<span class="pc pc-time${hot ? ' hot-cell' : ''}"><span class="trk"><i class="fill" style="--f:${w.toFixed(4)}"></i></span><span class="tnum">${p.time === undefined ? '' : fmtDur(p.time)}</span></span>`
  else time = `<span class="pc pc-n pc-time${hot ? ' hot-cell' : ''}">${p.root ? `<i class="pc-self" style="--w:${w.toFixed(3)}"></i>` : ''}${p.time === undefined ? '' : fmtDur(p.time)}</span>`
  const n = (cls, v, extra = '') => `<span class="pc pc-n pc-${cls}${extra}">${v === undefined ? '' : fmtCompact(v)}</span>`
  return `<span class="pc pc-id">${p.id}</span><span class="pc pc-op" style="--dep:${p.depth}">${esc(p.op)}</span><span class="pc pc-name">${esc(p.name || '')}</span>`
    + n('starts', p.starts) + n('erows', p.eRows, p.off ? ' pc-off' : '') + n('arows', p.aRows) + n('cost', p.cost) + time + n('cr', p.cr) + n('pr', p.pr) + n('pw', p.pw)
}
function planHeads(o) {
  const t = o.p8 ? 'A-Time <small>(bar: self)</small>' : 'A-Time'
  return `<span class="pc pc-id">Id</span><span class="pc pc-op">Operation</span><span class="pc pc-name">Name</span>`
    + PLAN_HEADS.map(([k, l]) => `<span class="pc pc-n pc-${k}">${k === 'time' ? t : l}</span>`).join('')
}
const bindHeads = `<span class="pc pc-bname">Variable</span><span class="pc pc-bval">Value</span><span class="pc pc-btype">Type</span>`
const asRun = `<a class="asrun">SQL with values →</a>`

// ---- one row ----------------------------------------------------------------------------------------------------------------------
function rowHtml(it, o, ctx) {
  const r = it.r
  const cls = ['row', 'k-' + it.type]
  const inst = r && r.inst
  const sqlid = inst && inst.sqlid
  const lane = r && (r.laneKey ?? -1) >= 0
  const hlRow = o.hl && lane && sqlid === o.hl
  // the calls and waits of the highlighted statement (NOW: the app's marks stop at 1,000 waits, bug 2)
  // bug 2: the app's marks stop at 1,000 waits, so the waits of 52nzchs09dgn1 in these excerpts (it has 3,293) are untinted in NOW
  const capped = !o.proposed && o.hl === '52nzchs09dgn1'
  const marked = hlRow && (it.type === 'call' || (it.type === 'wait' && !capped))
  if (marked) cls.push('mk')
  if (hlRow) cls.push('hlane')
  const hotRow = r && r.hot && (it.type === 'call' || it.type === 'wait')
  if (hotRow) cls.push('hot')
  if (o.sel === (r && r.ln) && !['planhead', 'binds', 'bindfoot'].includes(it.type)) cls.push('sel')
  if (it.br) cls.push('br-' + it.br)
  if (it.indent) cls.push('indent')
  if (it.execFirst && o.p6) cls.push('exec-first')
  if (it.ruleTop) cls.push('rule-top')
  const tbl = ['planhead', 'plan', 'binds', 'bindrow', 'bindfoot'].includes(it.type)
  if (tbl) cls.push('tb')
  if (it.type === 'planhead' || (it.type === 'binds' && !o.p8)) cls.push('tb-head')
  if ((it.type === 'plan' && it.last) || (it.type === 'bindrow' && it.bind && it.bind.last)) cls.push('tb-end')
  const style = [lane ? `--lane:${laneColor(sqlid)}` : '', lane && inst.depth ? `--dep:${inst.depth}` : ''].filter(Boolean).join(';')
  const fhOn = !o.p8 && ((it.type === 'plan' && it.first) || it.type === 'binds')
  let cells = deltaCell(it, o) + lnCell(it, o) + laneCell(it, o)
  if (!o.noFh) cells += `<div class="c-fh">${fhOn ? '<span class="fold">▾</span>' : ''}</div>`
  // p8: a table spans the Operation column to the right edge
  if (o.p8 && ['planhead', 'plan', 'binds', 'bindrow', 'bindfoot'].includes(it.type)) {
    cells += durCell({ ...it, r: null }, o) + tableSpan(it, o)
    return `<div class="${cls.join(' ')}" style="${style}" data-ln="${r.ln}">${cells}</div>`
  }
  cells += durCell(it, o)
  cells += opCell(it, o)
  cells += detailCell(it, o, ctx)
  cells += clockCell(it, o)
  return `<div class="${cls.join(' ')}" style="${style}" data-ln="${r ? r.ln : ''}">${cells}</div>`
}

function detailCell(it, o, ctx) {
  const r = it.r
  let inner = '', cls = 'c-detail'
  const tag = it.execFirst && o.p5 && it.execNo ? `<span class="exectag">exec ${it.execNo}</span>` : ''
  switch (it.type) {
    case 'call': inner = tag + callDetail(it, o); break
    case 'wait': inner = waitDetail(it, o, ctx); break
    case 'cursor': inner = cursorDetail(it, o); break
    case 'sql': inner = sqlHtml(r.text); break
    case 'end': inner = dim('end of statement'); break
    case 'rule': inner = '<span class="rd-rule"></span>'; break
    case 'mark': inner = `<span class="rd-name">${esc(r.value || '(none)')}</span>`; break
    case 'time': { const m = /^\*\*\* (\d{4}-\d\d-\d\d)T[\d:.]+(\+\d\d:\d\d)\s*\((.*)\)\s*$/.exec(r.text); inner = `<span class="rd-val">${m[1]}</span>` + dim(` UTC${m[2]}`) + SEP + dim(m[3]); break }
    case 'planhead': cls += ' tbl tbl-plan'; inner = planHeads(o); break
    case 'plan': cls += ' tbl tbl-plan'; inner = planCells(it.plan, o, !!o.p2 && it.plan.self >= HOT_US); break
    case 'binds': cls += ' tbl tbl-binds'; inner = tagCell(it, o, true) + bindHeads + asRun; break
    case 'binds-inline': cls += ' binds-inline'; inner = tag + bindChips(it); break
    case 'bindrow': cls += ' tbl tbl-binds'; inner = tagCell(it, o, false) + bindCells(it.bind); break
    default: inner = ''
  }
  const title = ''
  return `<div class="${cls}"${title}>${inner}</div>`
}
/** p5 without p8: the execution tag is the first cell of the BINDS table (a cell of every row, so the columns still line up). */
function tagCell(it, o, head) {
  if (!o.p5 || o.p8) return ''
  const no = head ? it.execNo : 0
  return `<span class="pc pc-tag">${no ? `<span class="exectag">exec ${no}</span>` : ''}</span>`
}
function bindCells(b) { return `<span class="pc pc-bname">${esc(b.name)}</span><span class="pc pc-bval">${esc(b.value)}</span><span class="pc pc-btype">${esc(b.type)}</span>` }
function bindChips(it) {
  return it.r.binds.map((b) => `<span class="chip chip-bind"><span class="bname">${esc(b.name)}</span> = <b class="bval">${esc(b.value)}</b> <small>${esc(b.type)}</small></span>`).join('') + asRun
}

/** p8: the table's cell, spanning Operation .. Clock, on --surface-sunken in a hairline frame, inset 1 ch. */
function tableSpan(it, o) {
  const first = it.type === 'planhead' || it.type === 'binds'
  const bindSet = it.type === 'binds' || it.type === 'bindrow' || it.type === 'bindfoot'
  const last = (it.type === 'plan' && it.last) || it.type === 'bindfoot' || (it.type === 'bindrow' && it.bind.last && !it.footer)
  const handle = first ? `<span class="tc tc-handle"><span class="fold">▾</span> ${it.type === 'planhead' ? 'PLAN' : 'BINDS'}</span>` : `<span class="tc tc-handle"></span>`
  let inner
  if (it.type === 'planhead') inner = planHeads(o)
  else if (it.type === 'plan') inner = planCells(it.plan, o, it.plan.self >= HOT_US && o.p2)
  else if (it.type === 'binds') inner = bindHeads
  else if (it.type === 'bindfoot') inner = `<span class="asrun-foot">SQL with values →</span>`
  else inner = bindCells(it.bind)
  const cls = ['c-tbl', bindSet ? 'tbl-binds' : 'tbl-plan', first ? 'tbl-first' : '', last ? 'tbl-last' : '', first ? 'tbl-head' : ''].filter(Boolean).join(' ')
  return `<div class="${cls}">${handle}${inner}</div>`
}

// ---- the pane: a header row and the rows ------------------------------------------------------------------------------------------
function colHead(o) {
  const grip = (end) => (o.p10 ? '' : `<span class="grip${end ? ' at-end' : ''}"></span>`)
  return `<div class="colhead">`
    + `<div class="ch ch-delta">Δ · time${grip()}</div><div class="ch ch-ln"></div><div class="ch ch-lane">${o.p5 ? '' : 'Statement'}${grip()}</div><div class="ch ch-fh"></div>`
    + `<div class="ch ch-dur"><span>Duration</span>${grip()}</div><div class="ch ch-op">Operation${grip()}</div><div class="ch ch-detail">Detail</div><div class="ch ch-clock">Clock${grip(true)}</div></div>`
}

/** The sticky lane label (p5): an overlay at the top of the row block, like the plan head row today. */
function stickyLabel(o) {
  const s = o.sticky
  if (!s) return ''
  const t = (SQLTEXT[s.sqlid] || []).join(' ').replace(/\s+/g, ' ').trim()
  const cut = t.length > 48 ? t.slice(0, 47).trimEnd() + '…' : t
  return `<div class="sticky-lane" style="--lane:${laneColor(s.sqlid)}"><b class="sl-id">${esc(s.sqlid)}</b><span class="sl-sep">·</span><span class="sl-sql">${esc(cut)}</span><span class="sl-facts">${esc(s.facts)}</span></div>`
}

function rowsHtml(ranges, o) {
  const ctx = { prefixCh: 0 }
  const groups = ranges.map(([a, b]) => present(a, b, o))
  if (o.p7) { // the prefix column of the micro-columns is as wide as the longest prefix of the block, so the cells line up across runs
    let max = 0
    groups.flat().forEach((it) => { if (it.micro) max = Math.max(max, it.r.nam.length + (objOf(it.r) ? 2 + objOf(it.r).length : 0) + 2 + (o.p4 ? 1 : 0)) })
    ctx.prefixCh = max
  }
  let h = ''
  groups.forEach((items, gi) => {
    if (gi > 0) h += `<div class="row k-skip"><div class="c-delta"></div><div class="c-ln"></div><div class="c-lane"></div>${o.noFh ? '' : '<div class="c-fh"></div>'}<div class="c-dur"></div><div class="c-op"></div><div class="c-detail"><span class="rd-dim">⋯ rows ${ranges[gi][0] === ranges[gi - 1][1] + 1 ? '' : 'skipped ⋯'}</span></div><div class="c-clock"></div></div>`
    h += items.map((it) => rowHtml(it, o, ctx)).join('')
  })
  return h
}

/** One pane. `o`: the proposal flags (p1..p9), `hl` the highlighted statement, `sel` the selected line, `ranges` the line ranges. */
function paneHtml(ranges, o) {
  const flags = ['p1', 'p2', 'p3', 'p3gap', 'p4', 'p5', 'p6', 'p7', 'p8', 'p9'].filter((k) => o[k]).join(' ')
  const klass = ['pane', o.composite ? 'composite' : '', o.p10 ? 'p10' : '', flags, o.proposed ? 'proposed' : 'now'].filter(Boolean).join(' ')
  const vars = o.hl ? `--hl:${laneColor(o.hl)}` : ''
  const body = `<div class="rows">${stickyLabel(o)}${rowsHtml(ranges, o)}</div>`
  const view = `<div class="view"><div class="view-col">${colHead(o)}${body}</div>${o.strip === false ? '' : stripHtml(o)}</div>`
  return `<div class="${klass}" style="${vars}">${o.chrome ? chromeHtml(o) : ''}${view}${o.status ? statusHtml(o) : ''}</div>`
}
