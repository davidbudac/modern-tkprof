// ---- rows: what the viewer shows for the open dump. Formatted dresses the trace's lines (banners as headings, folds, SQL pretty-printed,
// the plan as a plan); Raw is one row per line, untouched. Every row keeps the line it stands for, so search, landmarks and the map work. ---

const GL_RE = (() => {
  const terms = [...GLOSS.keys()].sort((a, b) => b.length - a.length).map((t) => t.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
  return new RegExp(`(?<![\\w$])(${terms.join('|')})(?![\\w$])`, 'g')
})()
const PFX_RE = /^(\s*)([A-Z][A-Za-z]{1,7}(?::\[V\d\])?:)/

const sqlCache = new Map()
function sqlLines(v) { let r = sqlCache.get(v.line); if (!r) { r = formatSql(v.text); sqlCache.set(v.line, r) } return r }

function buildRows(d) {
  const rows = []
  const map = new Int32Array(d.n).fill(-1)
  const set = (a, b, r) => { for (let i = a; i <= b; i++) { const k = i - d.viewFrom; if (k >= 0 && k < d.n && map[k] < 0) map[k] = r } }
  if (S.mode === 'raw') {
    for (let i = d.viewFrom; i <= d.viewTo; i++) { rows.push({ t: 'raw', line: i }); map[i - d.viewFrom] = rows.length - 1 }
    return { rows, map }
  }
  const plan = d.planObj, planOn = plan && !S.planText.has(d.idx)
  for (let i = d.viewFrom; i <= d.viewTo; i++) {
    const f = d.foldAt.get(i)
    if (f && foldClosed(f)) { rows.push({ t: 'fold', line: i, fold: f }); set(f.from, f.to, rows.length - 1); i = f.to; continue }
    if (planOn && i === plan.from) {
      const r0 = rows.length
      rows.push({ t: 'planhead', line: plan.from + 1, plan })
      rows.push({ t: 'plancols', line: plan.head, plan })
      for (const op of plan.rows) {
        rows.push({ t: 'planop', line: op.line, op })
        set(op.line, op.line, rows.length - 1)
        const qb = plan.qbs[op.id]
        if (qb) { rows.push({ t: 'planpred', line: qb.line, op, pred: { text: 'qb ' + qb.qb + (qb.alias ? ' / ' + qb.alias : ''), line: qb.line } }); set(qb.line, qb.line, rows.length - 1) }
        for (const p of plan.preds[op.id] || []) { rows.push({ t: 'planpred', line: p.line, op, pred: p }); set(p.line, p.line, rows.length - 1) }
      }
      rows.at(-1).last = true
      set(plan.head, plan.head, r0 + 1)
      set(plan.from, plan.to, r0)
      i = plan.to; continue
    }
    const role = ROLES[i]
    if (role === 'bt' && ROLES[i + 1] === 'bh') {
      const b = BANNER.get(i + 1)
      rows.push({ t: 'head', line: i + 1, from: i, to: i + 2, text: b.text, major: isMajor(d, i), fold: f && !foldClosed(f) ? f : null })
      set(i, i + 2, rows.length - 1); i += 2; continue
    }
    if (role === 'uh') {
      const b = BANNER.get(i)
      rows.push({ t: 'head', line: i, from: i, to: i + 1, text: b.text, major: isMajor(d, i), fold: f && !foldClosed(f) ? f : null })
      set(i, i + 1, rows.length - 1); i += 1; continue
    }
    const v = d.sqlAt.get(i)
    if (v) {
      const fl = sqlLines(v)
      const r0 = rows.length
      fl.forEach((tx, k) => rows.push({ t: 'sql', line: i, text: tx, k, n: fl.length, fold: k === 0 && f ? f : null }))
      set(i, i, r0); continue
    }
    rows.push({ t: 'line', line: i, fold: f && !foldClosed(f) ? f : null })
    set(i, i, rows.length - 1)
  }
  return { rows, map }
}

function isMajor(d, i) { const n = d.startAt.get(i); return !!n && n.lvl <= 3 }

// ---- spans: a line as runs of text with a class; the search marks are laid over them at the end ----
function splitSpans(spans, re, mk) {
  const out = []
  for (const sp of spans) {
    if (sp.cls) { out.push(sp); continue }
    re.lastIndex = 0
    let p = 0, m
    while ((m = re.exec(sp.text))) {
      if (m[0] === '') { re.lastIndex++; continue }
      if (m.index > p) out.push({ text: sp.text.slice(p, m.index), cls: '' })
      out.push(mk(m))
      p = m.index + m[0].length
    }
    if (p < sp.text.length) out.push({ text: sp.text.slice(p), cls: '' })
  }
  return out
}

function dressLine(d, i) {
  const s = line(i)
  let m
  if (SEP_RE.test(s)) return { cls: 'x-rule', spans: [] }
  if ((m = /^(-{3,} )(.+?)( -{3,})\s*$/.exec(s))) return { cls: 'x-h3', spans: [{ text: m[1], cls: 'x-dash' }, { text: m[2], cls: '' }, { text: m[3], cls: 'x-dash' }] }
  if (/^[A-Z][A-Z0-9 ()/,_-]{5,}$/.test(s.trim()) && s.trim().includes(' ')) return { cls: 'x-h2', spans: [{ text: s.trim(), cls: '' }] }
  if (d.sqlText.has(i)) return { cls: 'x-stmt', spans: sqlSpans(s) }
  const v = d.sqlHeadAt.get(i)
  if (v) {
    const k = s.indexOf('*******')
    return { cls: 'x-sqlhead', spans: [{ text: s.slice(0, k), cls: 'x-pfx' }, { text: s.slice(k), cls: 'x-dim' }], act: v }
  }
  if ((m = /^(\s*[_a-z][\w#$]*\s{2,}=)( .*)$/.exec(s))) return { cls: '', spans: [{ text: m[1], cls: 'rd-key' }, { text: m[2], cls: '' }] }
  if ((m = /^(\s+fix\s+\d+\s+=)(.*)$/.exec(s))) return { cls: '', spans: [{ text: m[1], cls: 'rd-key' }, { text: m[2], cls: '' }] }
  let spans = [{ text: s, cls: '' }]
  if ((m = PFX_RE.exec(s))) {
    const term = m[2].replace(/:.*$/, '').replace(/:$/, '')
    spans = [{ text: m[1], cls: '' }, { text: m[2], cls: 'x-pfx' + (GLOSS.has(term) ? ' gl' : ''), t: GLOSS.has(term) ? term : '' }, { text: s.slice(m[0].length), cls: '' }].filter((x) => x.text)
  }
  spans = splitSpans(spans, /Best::/g, (mm) => ({ text: mm[0], cls: 'x-best' }))
  if (i >= d.from) spans = splitSpans(spans, GL_RE, (mm) => ({ text: mm[0], cls: 'gl', t: mm[0] }))
  return { cls: '', spans }
}

/** spans -> html, with the search's matches as <mark> over them */
function spansHtml(spans, ranges) {
  let pos = 0, out = ''
  for (const sp of spans) {
    const a = pos, b = pos + sp.text.length
    let inner = '', p = a
    for (const [ra, rb, cur] of ranges) {
      if (rb <= p || ra >= b) continue
      const s0 = Math.max(ra, p), e0 = Math.min(rb, b)
      inner += esc(sp.text.slice(p - a, s0 - a)) + `<mark${cur ? ' class="cur"' : ''}>` + esc(sp.text.slice(s0 - a, e0 - a)) + '</mark>'
      p = e0
    }
    inner += esc(sp.text.slice(p - a))
    out += sp.cls ? `<span class="${sp.cls}"${sp.t ? ` data-t="${esc(sp.t)}"` : ''}>${inner}</span>` : inner
    pos = b
  }
  return out
}

function hitRanges(text, ln) {
  if (!S.qre || !S.hitSet.has(ln)) return []
  const out = []
  S.qre.lastIndex = 0
  let m, first = true
  while ((m = S.qre.exec(text))) {
    if (m[0] === '') { S.qre.lastIndex++; continue }
    out.push([m.index, m.index + m[0].length, first && ln === S.hitCur])
    first = false
    if (out.length > 200) break
  }
  return out
}

function foldHits(f) {
  if (!S.qre) return 0
  let n = 0
  for (const h of S.hits) if (h >= f.from && h <= f.to) n++
  return n
}

const SVG_RIGHT = '▸', SVG_DOWN = '▾'
function planVars(p) {
  if (!p._vars) {
    const opw = Math.max(9, ...p.rows.map((o) => o.depth * 2 + o.op.length))
    const nmw = Math.max(4, ...p.rows.map((o) => o.name.length))
    p._vars = `--opw:${opw};--nmw:${nmw}`
  }
  return p._vars
}

function paintRow(d, r, idx) {
  const cls = ['lv-row']
  const ln = r.line
  const lm = d.lmAt.get(ln)
  const lmOn = lm && S.lmOn[lm.kind] && r.t !== 'fold' && !(r.t === 'sql' && r.k > 0)
  if (lmOn) cls.push('lm', 'lm-' + lm.tone)
  if (ln === S.sel && !(r.t === 'sql' && r.k > 0) && !(r.t === 'planpred' && false)) cls.push('lv-sel')
  if (S.bms.has(ln) && !(r.t === 'sql' && r.k > 0)) cls.push(S.bms.get(ln) ? 'lv-note' : 'lv-bm')
  let num = String(ln), fh = '', tx = ''
  if (r.t === 'raw') {
    const s = line(ln)
    tx = spansHtml([{ text: s, cls: '' }], hitRanges(s, ln))
  } else if (r.t === 'fold') {
    const f = r.fold
    cls.push('x-fold', f.kind === 'same-run' ? 'x-fold-run' : '')
    const s = line(ln)
    const h = foldHits(f)
    fh = `<button class="lv-fold" data-fold="${f.id}" title="Open: ${esc(f.label)}, lines ${fmtN(f.from)}-${fmtN(f.to)}  (z)" aria-label="Open the fold">${SVG_RIGHT}</button>`
    const first = d.sqlAt.has(ln) ? s.slice(0, 90) + (s.length > 90 ? ' …' : '') : s
    tx = spansHtml([{ text: first, cls: '' }], hitRanges(first, ln)) +
      `<span class="fold-sum"><b>${fmtN(f.lines)}</b> ${f.lines === 1 ? 'line' : 'lines'} · ${esc(f.label)}${h ? ` · <i>${h} ${h === 1 ? 'hit' : 'hits'}</i>` : ''}</span>`
  } else if (r.t === 'head') {
    cls.push(r.major ? 'x-h1' : 'x-h2')
    if (r.fold) fh = `<button class="lv-fold" data-fold="${r.fold.id}" title="Close: ${esc(r.fold.label)}  (z)">${SVG_DOWN}</button>`
    const span = r.to - r.from + 1
    tx = `<span title="${span === 3 ? 'A banner' : 'A heading'}: lines ${r.from}-${r.to}">` + spansHtml([{ text: r.text, cls: '' }], hitRanges(r.text, ln)) + '</span>'
  } else if (r.t === 'sql') {
    cls.push('x-sql')
    if (r.k === 0) cls.push('x-sql-first')
    if (r.k === r.n - 1) cls.push('x-sql-last')
    if (r.fold) fh = `<button class="lv-fold" data-fold="${r.fold.id}" title="Close: ${esc(r.fold.label)}  (z)">${SVG_DOWN}</button>`
    tx = spansHtml(sqlSpans(r.text), hitRanges(r.text, ln))
  } else if (r.t === 'planhead') {
    cls.push('x-h1', 'x-planhead')
    tx = `Plan table<small>lines ${r.plan.from}-${r.plan.to}, the table, its query blocks and predicates</small><span class="x-seg"><button data-plan="plan" aria-pressed="true" title="The plan table as a plan">Plan</button><button data-plan="text" aria-pressed="false" title="The trace's own text">Text</button></span>`
  } else if (r.t === 'plancols') {
    num = ''
    tx = `<span class="lv-tbl lv-tbl-head lv-tbl-first" style="${planVars(r.plan)}"><span class="pc pc-id">Id</span><span class="pc pc-op">Operation</span><span class="pc pc-name">Name</span><span class="pc pc-n">Rows</span><span class="pc pc-n">Bytes</span><span class="pc pc-n">Cost</span><span class="pc pc-time">Time</span></span>`
  } else if (r.t === 'planop') {
    const o = r.op
    const hit = S.hitSet.has(ln) || (r.qb && S.hitSet.has(r.qb.line))
    tx = `<span class="lv-tbl${r.last ? ' lv-tbl-last' : ''}" style="${planVars(d.planObj)}${hit ? ';box-shadow: inset 0 0 0 999px color-mix(in oklch, var(--c-commit) 22%, transparent)' : ''}"><span class="pc pc-id">${o.id}</span><span class="pc pc-op" style="--dep:${o.depth}">${esc(o.op)}</span><span class="pc pc-name">${esc(o.name)}</span><span class="pc pc-n">${esc(o.rows)}</span><span class="pc pc-n">${esc(o.bytes)}</span><span class="pc pc-n">${esc(o.cost)}</span><span class="pc pc-time">${esc(o.time)}</span></span>`
  } else if (r.t === 'planpred') {
    const hit = S.hitSet.has(ln)
    const pm = /^(access|filter|qb)(.*)$/.exec(r.pred.text)
    tx = `<span class="lv-tbl${r.last ? ' lv-tbl-last' : ''}" style="${planVars(d.planObj)}${hit ? ';box-shadow: inset 0 0 0 999px color-mix(in oklch, var(--c-commit) 22%, transparent)' : ''}"><span class="pc pc-id"></span><span class="pc pc-pred" style="--dep:${r.op.depth}">${pm ? `<b>${pm[1]}</b>${esc(pm[2])}` : esc(r.pred.text)}</span></span>`
  } else {
    const dl = dressLine(d, ln)
    if (dl.cls) cls.push(dl.cls)
    if (r.fold) fh = `<button class="lv-fold" data-fold="${r.fold.id}" title="Close: ${esc(r.fold.label)}  (z)">${SVG_DOWN}</button>`
    const text = dl.spans.map((x) => x.text).join('')
    tx = spansHtml(dl.spans, hitRanges(text, ln))
    if (dl.act && dl.act.prev) tx += `<button class="x-act" data-diff="${dl.act.line}" title="The statement on the next line, pretty-printed, against the previous version (line ${dl.act.prev})">diff with line ${fmtN(dl.act.prev)}</button>`
    else if (dl.act) tx += `<span class="x-act" style="cursor:default;text-decoration:none">first version in this dump</span>`
  }
  if (r.t === 'sql' && r.k > 0) num = String(ln)
  return `<div class="${cls.filter(Boolean).join(' ')}" data-r="${idx}"><span class="lv-ln">${num}</span><span class="lv-fh">${fh}</span><span class="lv-tx">${tx}</span></div>`
}
