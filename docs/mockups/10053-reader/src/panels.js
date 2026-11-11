// ---- the side panels: Outline, Landmarks, Bookmarks on the left; Guide and SQL on the right ---------------------------------------------

const ICONS = {
  outline: '<path d="M21 12h-8"/><path d="M21 6H8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/>',
  landmarks: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  bookmarks: '<path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>',
  guide: '<path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/>',
  sql: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
}
const icon = (k) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k]}</svg>`

const LTABS = [['outline', 'Outline', 'The dumps and their sections, with line counts and search hits'], ['landmarks', 'Landmarks', 'Key lines by kind; [ and ] step through the kinds that are on'], ['bookmarks', 'Bookmarks', 'Bookmarked lines and their notes (b on a line)']]
const RTABS = [['guide', 'Guide', 'What the section and the line under the selection are'], ['sql', 'SQL', 'Every UNPARSED QUERY IS statement of the dump, pretty-printed, with a diff against the previous one']]

function renderTabs() {
  const d = D()
  const badge = { landmarks: enabledLms(d).length, bookmarks: [...S.bms.keys()].filter((l) => l >= d.viewFrom && l <= d.viewTo).length, sql: d.sql.length }
  const tabs = (list, cur, side) => list.map(([k, name, tip]) => `<button class="side-tab" role="tab" data-${side}tab="${k}" aria-selected="${cur === k}" title="${name}: ${tip}" aria-label="${name}">${icon(k)}${badge[k] && k !== 'sql' && k !== 'landmarks' ? `<small>${badge[k]}</small>` : ''}</button>`).join('')
  $('#ltabs').innerHTML = tabs(LTABS, S.ltab, 'l')
  $('#rtabs').innerHTML = tabs(RTABS, S.rtab, 'r')
  const lt = LTABS.find((t) => t[0] === S.ltab)[1], rt = RTABS.find((t) => t[0] === S.rtab)[1]
  const lsmall = S.ltab === 'outline' ? `${M.dumps.length} dumps` : S.ltab === 'landmarks' ? `${fmtN(badge.landmarks)} on` : `${badge.bookmarks}`
  $('#ltitle').innerHTML = `${lt}<small>${lsmall}</small>` + (S.ltab === 'outline' ? `<span class="x-seg ol-seg" role="radiogroup" aria-label="Outline"><button data-olmode="all" aria-pressed="${S.olMode === 'all'}" title="Every section, full depth">All</button><button data-olmode="runs" aria-pressed="${S.olMode === 'runs'}" title="The costing runs only, in file order, with their verdicts">Runs</button></span>` : '')
  $('#rtitle').innerHTML = `${rt}<small>${S.rtab === 'sql' ? `${d.sql.length} versions` : ''}</small>`
}

// ---- the outline ----
function olFlat() {
  const out = []
  const push = (n, depth) => { out.push({ n, depth }); if (S.exp.has(n.id)) for (const c of n.children) push(c, depth + 1) }
  for (const d of M.dumps) {
    out.push({ dump: d, n: d.tree, depth: 0 })
    if (d.idx !== S.dump || !S.exp.has(d.tree.id)) continue
    if (S.olMode === 'runs') { for (const r of d.nodes.filter((n) => n.kind === 'run')) push(r, 1) }
    else for (const c of d.tree.children) push(c, 1)
  }
  return out
}

function hitsIn(a, b) {
  if (!S.qre || !S.hits.length) return 0
  const h = S.hits
  let lo = 0, hi = h.length
  while (lo < hi) { const m = (lo + hi) >> 1; if (h[m] < a) lo = m + 1; else hi = m }
  let k = lo
  while (k < h.length && h[k] <= b) k++
  return k - lo
}

function olRow(it, curId) {
  const n = it.n, d = it.dump
  const has = n.children.length > 0
  const open = S.exp.has(n.id)
  const x = has ? (open ? '▾' : '▸') : ''
  const cnt = `<span class="ol-n" title="${fmtN(n.to - n.from + 1)} lines, ${fmtN(n.from)}-${fmtN(n.to)}">${fmtN(n.to - n.from + 1)}</span>`
  if (d) {
    const isOpen = d.idx === S.dump
    const h = isOpen ? hitsIn(d.viewFrom, d.viewTo) : 0
    return `<div class="ol-row ol-dump${isOpen ? ' open' : ''}${curId === n.id ? ' on' : ''}" style="--d:0" data-dump="${d.idx}" data-node="${n.id}" title="Dump ${d.idx + 1} of ${M.dumps.length}: lines ${fmtN(d.viewFrom)}-${fmtN(d.viewTo)}">
      <span class="ol-x" data-tw="${n.id}">${isOpen ? (open ? '▾' : '▸') : '▸'}</span>
      <span class="ol-main"><span class="ol-l1"><span class="ol-label">${esc(d.sqlId)}</span><span class="ol-k">dump ${d.idx + 1}</span>${h ? `<span class="ol-hits" title="${h} search hits">${h}</span>` : ''}<span class="ol-n">${fmtN(d.n)}</span></span>
      <span class="ol-sql">${esc(d.sqlStart.slice(0, 80))}</span>
      <span class="ol-facts">${esc(d.tables.join(' · '))} · ${fmtN(d.n)} lines · plan hash ${esc(d.planHash || '—')}</span></span></div>`
  }
  const dd = D()
  const h = hitsIn(n.from, n.to)
  const hits = h ? `<span class="ol-hits" title="${h} search ${h === 1 ? 'hit' : 'hits'}">${h}</span>` : ''
  let l1 = '', l2 = '', extra = '', mono = false
  if (n.kind === 'run') {
    const r = dd.runAt.get(n.id)
    const tags = (r.final ? `<span class="ol-tag final" title="Costed after \`Final query after transformations\`; the plan of the Result follows">final plan</span>` : '') +
      (r.sameAs ? `<span class="ol-tag same" title="Its text equals run ${r.sameAs}'s, addresses and memory figures ignored; folded">same as run ${r.sameAs}</span>` : '')
    l1 = `<span class="ol-label">${esc(n.label)}</span>${tags}`
    if (r.verdict) l2 = `<span class="ol-dot ${r.verdict.kept ? 'kept' : 'rejected'}"></span><span class="mono" title="${esc(r.iter)}: the verdict of the iteration it belongs to (line ${r.verdict.line})">${esc(r.verdict.text)}</span>`
    else if (r.final) l2 = `<span>after Final query after transformations, line ${fmtN(dd.phases.fq)}</span>`
    if (S.olMode === 'runs' && !r.final) { const it = r.iter ? dd.nodes.find((x) => x.kind === 'iteration' && x.runs.includes(n.id)) : null; l2 += `</span><span class="ol-l2 ol-l3"><span>${it ? esc(it.label) : 'after Final query after transformations, line ' + fmtN(dd.phases.fq)}</span>` }
  } else if (n.kind === 'iteration') {
    l1 = `<span class="ol-label">${esc(n.label)}</span>`
    if (n.verdict) l2 = `<span class="ol-dot ${n.verdict.kept ? 'kept' : 'rejected'}"></span><span class="mono">${esc(n.verdict.text.replace(/^\w+: /, ''))}</span>`
  } else if (n.kind === 'join-order') {
    mono = true
    l1 = `<span class="ol-label" title="${esc(n.label)}">Join order[${n.n}]</span>${n.best ? '<span class="ol-tag best" title="The run\'s Final cost says: Best join order: ' + n.n + '">best</span>' : ''}<span class="ol-res${n.aborted ? ' rej' : ''}">${esc(n.result)}</span>`
    l2 = `<span class="mono" title="${esc(n.label)}">${esc(n.tables.join('  '))}</span>`
  } else if (n.kind === 'join-step' || n.kind === 'table') {
    mono = n.kind === 'join-step'
    l1 = `<span class="ol-label">${esc(n.label)}</span>${n.result ? `<span class="ol-res" title="Best:: ${n.kind === 'table' ? 'AccessPath' : 'JoinMethod'}: ${esc(n.result)}">${esc(n.result)}</span>` : ''}`
  } else {
    l1 = `<span class="ol-label" title="${esc(n.label)}">${esc(n.label)}</span>`
  }
  const phase = n.kind.startsWith('phase-')
  return `<div class="ol-row${phase ? ' ol-phase' : ''}${mono ? ' ol-mono' : ''}${curId === n.id ? ' on' : ''}" style="--d:${it.depth}" data-node="${n.id}" title="${esc(KIND_NAME[n.kind] || '')}: lines ${fmtN(n.from)}-${fmtN(n.to)}">
    <span class="ol-x" data-tw="${has ? n.id : ''}">${x}</span><span class="ol-main"><span class="ol-l1">${l1}${hits}${cnt}</span>${l2 ? `<span class="ol-l2">${l2}</span>` : ''}</span></div>`
}

let olCurId = null
function renderOutline(scroll) {
  if (S.ltab !== 'outline') return
  const flat = olFlat()
  const path = pathOf(D(), focusLine())
  // the node marked: the deepest node of the path that the outline shows
  const shown = new Set(flat.map((x) => x.n.id))
  let cur = null
  for (const n of path) if (shown.has(n.id)) cur = n.id
  olCurId = cur
  $('#lbody').innerHTML = `<div class="ol">${flat.map((it) => olRow(it, cur)).join('')}</div>`
  if (scroll) { const el = $('#lbody .ol-row.on'); if (el) el.scrollIntoView({ block: 'nearest' }) }
}

// ---- landmarks ----
function enabledLms(d) { return d.lms.filter((l) => S.lmOn[l.kind]) }
function renderLandmarks() {
  if (S.ltab !== 'landmarks') return
  const d = D()
  const counts = {}
  for (const l of d.lms) counts[l.kind] = (counts[l.kind] || 0) + 1
  const kinds = LM_KINDS.map((k) => `<label class="lmk-row" title="${esc(k.label)}"><input type="checkbox" data-lmk="${k.k}"${S.lmOn[k.k] ? ' checked' : ''}><span class="lmk-sw ${k.tone}"></span><span>${esc(k.label)}</span><small>${fmtN(counts[k.k] || 0)}</small></label>`).join('')
  const groups = LM_KINDS.filter((k) => S.lmOn[k.k] && counts[k.k]).map((k) => {
    const items = d.lms.filter((l) => l.kind === k.k).map((l) => {
      const p = pathOf(d, l.line)
      const ctx = p.slice(2).filter((n) => ['iteration', 'run', 'table', 'join-order', 'join-step', 'cbsec', 'qt', 'hints', 'hint-report', 'ap-search'].includes(n.kind)).map((n) => n.crumb).join(' › ') || p.slice(1).map((n) => n.crumb).join(' › ')
      return `<div class="lml-i${l.line === S.lmCur ? ' on' : ''}" data-go="${l.line}"><span class="ln">${l.line}</span><span class="tx"><code>${esc(l.text)}</code><span>${esc(ctx)}</span></span></div>`
    }).join('')
    return `<div class="lml-h"><span class="lmk-sw ${k.tone}"></span>${esc(k.short)}<small>${fmtN(counts[k.k])}</small></div>${items}`
  }).join('')
  $('#lbody').innerHTML = `<div class="lmk">${kinds}<p class="lmk-note">A kind that is off is not tinted in the text, not on the line map and not stepped through with [ and ].</p></div><div class="lml">${groups || '<p class="side-note">No landmark kind is on.</p>'}</div>`
  const on = $('#lbody .lml-i.on'); if (on) on.scrollIntoView({ block: 'center' })
}

// ---- bookmarks ----
function renderBookmarks() {
  if (S.ltab !== 'bookmarks') return
  const d = D()
  const list = [...S.bms.entries()].filter(([l]) => l >= d.viewFrom && l <= d.viewTo).sort((a, b) => a[0] - b[0])
  if (!list.length) { $('#lbody').innerHTML = '<p class="side-note">No bookmarks in this dump. Select a line and press b, or the bookmark button in the toolbar. Kept in memory in the mock-up.</p>'; return }
  $('#lbody').innerHTML = `<ul class="bms">${list.map(([l, note]) => {
    const p = pathOf(d, l)
    return `<li><span class="ln">${l}</span><span><code data-go="${l}" title="Go to line ${l}">${esc(line(l).trim() || '(blank)')}</code><span class="crumb">${esc(p.slice(1).map((n) => n.crumb).join(' › '))}</span><input type="text" data-note="${l}" placeholder="Note" value="${esc(note || '')}"></span><button class="quiet icon-btn" data-unbm="${l}" title="Remove the bookmark" aria-label="Remove the bookmark at line ${l}">×</button></li>`
  }).join('')}</ul>`
}

// ---- the guide ----
function md(s) { return esc(s).replace(/`([^`]+)`/g, '<code>$1</code>') }
let guideKey = ''
function renderGuide(force) {
  if (S.rtab !== 'guide') return
  const d = D()
  const ln = focusLine()
  const path = pathOf(d, ln)
  const node = path.at(-1)
  const key = `${S.dump}:${ln}:${node.id}`
  if (!force && key === guideKey) return
  guideKey = key
  const sec = GUIDE_SECTIONS[node.kind]
  const kind = KIND_NAME[node.kind] || node.kind
  const s = line(ln)
  const gl = guideLine(s)
  const terms = []
  if (ln >= d.from && !d.sqlText.has(ln)) {
    const seen = new Set()
    GL_RE.lastIndex = 0
    let m
    while ((m = GL_RE.exec(s))) if (!seen.has(m[0])) { seen.add(m[0]); terms.push(GLOSS.get(m[0])) }
    const pm = PFX_RE.exec(s)
    if (pm) { const t = pm[2].replace(/:.*$/, ''); if (GLOSS.has(t) && !seen.has(t)) terms.unshift(GLOSS.get(t)) }
  }
  const where = S.sel === ln ? 'Selected line' : 'Top of the text'
  $('#rbody').innerHTML = `<div class="guide">
    <div class="g-sec">
      <span class="g-k"><b>Section</b> · ${esc(kind)} · lines ${fmtN(node.from)}-${fmtN(node.to)}</span>
      <span class="g-where" title="${esc(node.label)}">${esc(node.label)}</span>
      ${sec ? `<span class="g-t">${esc(sec.title)}</span><p class="g-p">${md(sec.text)}</p>` : `<p class="g-none">No guide text for this kind of section. An entry is written only where a source backs it.</p>`}
    </div>
    <div class="g-sec">
      <span class="g-k"><b>Line ${fmtN(ln)}</b> · ${where.toLowerCase()}</span>
      <span class="g-where">${esc(s.trim() || '(blank line)')}</span>
      ${gl ? `<span class="g-t">${esc(gl.title)}</span><p class="g-p">${md(gl.text)}</p>` : `<p class="g-none">No guide text for this kind of line.</p>`}
    </div>
    ${terms.length ? `<div class="g-sec"><span class="g-k"><b>Terms on this line</b> · from the trace's legend and the format reference</span><dl class="g-terms">${terms.map((t) => `<dt>${esc(t.term)}</dt><dd>${esc(t.text)}</dd>`).join('')}</dl></div>` : ''}
  </div>`
}

// ---- statement versions ----
function renderSql() {
  if (S.rtab !== 'sql') return
  const d = D()
  if (!d.sql.length) { $('#rbody').innerHTML = '<p class="side-note">No UNPARSED QUERY IS statement in this dump.</p>'; return }
  let sel = d.sqlAt.get(S.sqlSel)
  if (!sel) { const ln = focusLine(); sel = [...d.sql].reverse().find((v) => v.line <= ln) || d.sql[0] }
  const list = d.sql.map((v) => `<div class="sqlv-i${v === sel ? ' on' : ''}" data-sqlv="${v.line}" title="Line ${v.line}: ${esc(v.label)}"><span class="ln">${v.line}</span><span class="lb">${esc(v.label)}</span><small>${v.sameAs ? `same as ${v.sameAs}` : `${fmtN(v.text.length)} chars`}</small></div>`).join('')
  const cur = sqlLines(sel)
  let body
  const against = d.sqlAt.get(S.sqlAgainst) && S.sqlAgainst < sel.line ? S.sqlAgainst : sel.prev
  if (S.sqlDiff && against) {
    const prev = sqlLines(d.sqlAt.get(against))
    const df = diffLines(prev, cur)
    const ch = df.filter((x) => x.op !== ' ').length
    const opts = d.sql.filter((v) => v.line < sel.line && !v.sameAs).map((v) => `<option value="${v.line}"${v.line === against ? ' selected' : ''}>line ${v.line} · ${esc(v.label)}${v.line === sel.prev ? ' (previous)' : ''}</option>`).join('')
    const prevOpt = d.sqlAt.get(sel.prev).sameAs ? `<option value="${sel.prev}"${sel.prev === against ? ' selected' : ''}>line ${sel.prev} · ${esc(d.sqlAt.get(sel.prev).label)} (previous)</option>` : ''
    body = `<label class="sqlv-against">Against <select id="sql-against">${prevOpt}${opts}</select></label><p class="sqlv-note">${ch ? `${df.filter((x) => x.op === '-').length} lines out, ${df.filter((x) => x.op === '+').length} in` : 'The same text'}${ch ? ', in the pretty-printed text' : ''}.</p>
      <pre class="sqlv-pre">${df.map((x) => `<div class="${x.op === '+' ? 'd-add' : x.op === '-' ? 'd-del' : ''}"><span class="d-op">${x.op === ' ' ? '' : x.op}</span>${spansHtml(sqlSpans(x.text), [])}</div>`).join('')}</pre>`
  } else {
    body = `<pre class="sqlv-pre">${cur.map((x) => `<div>${spansHtml(sqlSpans(x), [])}</div>`).join('')}</pre>`
  }
  $('#rbody').innerHTML = `<div class="sqlv"><div class="sqlv-list">${list}</div><div class="sqlv-body">
    <div class="sqlv-head"><b>Line ${fmtN(sel.line)}</b><span>${esc(sel.label)}</span><span class="sp"></span>
      <button class="quiet" data-sqlgo="${sel.line}" title="Show this line in the text">Show in text</button>
      <button class="quiet" id="sql-diff" aria-pressed="${S.sqlDiff && !!sel.prev}"${sel.prev ? '' : ' disabled'} title="${sel.prev ? `Diff against the previous version, line ${sel.prev}` : 'The first version in this dump'}">Diff</button></div>
    ${body}</div></div>`
  const on = $('#rbody .sqlv-i.on'); if (on) on.scrollIntoView({ block: 'nearest' })
}

function renderLeft(scroll) { renderTabs(); if (S.ltab === 'outline') renderOutline(scroll); else if (S.ltab === 'landmarks') renderLandmarks(); else renderBookmarks() }
function renderRight() { renderTabs(); if (S.rtab === 'guide') renderGuide(true); else renderSql() }
