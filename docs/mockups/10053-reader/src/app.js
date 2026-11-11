// ---- state, the viewer, the line map, the toolbar, the keys ----------------------------------------------------------------------------
const $ = (s) => document.querySelector(s)
const ROW = 20

const S = {
  dump: 0, mode: 'fmt', sel: 0,
  foldOv: new Map(), // fold id -> closed (the user's choice over the default)
  planText: new Set(), // dumps whose plan shows as the trace's text
  q: '', re: false, cs: false, qre: null, qbad: false, hits: [], hitSet: new Set(), hitCur: 0,
  lmOn: Object.fromEntries(LM_KINDS.map((k) => [k.k, k.on])), lmCur: 0,
  bms: new Map(), // line -> note
  exp: new Set(), olMode: 'all', ltab: 'outline', rtab: 'guide', sqlSel: 0, sqlAgainst: 0, sqlDiff: false,
}
const D = () => M.dumps[S.dump]
let VIEW = { rows: [], map: new Int32Array(0) }

function foldClosed(f) { return S.foldOv.has(f.id) ? S.foldOv.get(f.id) : f.closed }

// default outline: every dump and its phases open (two levels)
for (const d of M.dumps) { S.exp.add(d.tree.id); for (const p of d.phaseNodes) S.exp.add(p.id) }

// ---- the viewer ----
const lv = $('#lv'), inner = $('#lv-inner'), layer = $('#lv-layer')

function rebuild(keepLine) {
  const d = D()
  const top = keepLine ?? topLine()
  VIEW = buildRows(d)
  inner.style.blockSize = VIEW.rows.length * ROW + 'px'
  inner.style.inlineSize = S.mode === 'raw' ? `calc(${d.maxLen}ch + 12ch)` : '100%'
  lv.classList.toggle('lv-fmt', S.mode === 'fmt')
  if (top) lv.scrollTop = rowOf(top) * ROW
  paint()
}

function rowOf(ln) { const d = D(); const k = Math.min(Math.max(ln, d.viewFrom), d.viewTo) - d.viewFrom; const r = VIEW.map[k]; return r < 0 ? 0 : r }
function topLine() { const r = VIEW.rows[Math.floor(lv.scrollTop / ROW)]; return r ? r.line : D().viewFrom }
function bottomLine() { const r = VIEW.rows[Math.min(VIEW.rows.length - 1, Math.floor((lv.scrollTop + lv.clientHeight - 1) / ROW))]; return r ? r.line : D().viewTo }
function selVisible() { if (!S.sel) return false; const r = rowOf(S.sel); return r * ROW >= lv.scrollTop - 1 && (r + 1) * ROW <= lv.scrollTop + lv.clientHeight + 1 }
function focusLine() { return selVisible() ? S.sel : topLine() }

let frame = 0
function paint() {
  frame = 0
  const d = D()
  const first = Math.max(0, Math.floor(lv.scrollTop / ROW) - 8)
  const last = Math.min(VIEW.rows.length, Math.ceil((lv.scrollTop + lv.clientHeight) / ROW) + 8)
  layer.style.transform = `translateY(${first * ROW}px)`
  let html = ''
  for (let k = first; k < last; k++) html += paintRow(d, VIEW.rows[k], k)
  layer.innerHTML = html
  context()
}
function schedule() { if (!frame) frame = requestAnimationFrame(paint) }
lv.addEventListener('scroll', schedule, { passive: true })
new ResizeObserver(() => { schedule(); paintStrip() }).observe(lv)

/** Bring a line into view: open the folds that hide it, then scroll (top: the line at the top of the view; else only if it is out of view). */
function reveal(ln, how = 'center') {
  const d = D()
  let changed = false
  for (const f of d.folds) if (f.from < ln && ln <= f.to && foldClosed(f)) { S.foldOv.set(f.id, false); changed = true }
  if (d.planObj && S.planText.has(d.idx) === false && ln > d.planObj.from && ln <= d.planObj.to && !VIEW.rows.some((r) => r.line === ln)) { /* inside the plan block: its row stands for it */ }
  if (changed) rebuild(topLine())
  const r = rowOf(ln)
  const y = r * ROW
  if (how === 'top') lv.scrollTop = Math.max(0, y - ROW)
  else if (how === 'near') { if (y < lv.scrollTop) lv.scrollTop = y; else if (y + ROW > lv.scrollTop + lv.clientHeight) lv.scrollTop = y + ROW - lv.clientHeight }
  else if (y < lv.scrollTop || y + ROW > lv.scrollTop + lv.clientHeight) lv.scrollTop = Math.max(0, y - lv.clientHeight / 2 + ROW)
  schedule()
}
function select(ln, how) { S.sel = ln; reveal(ln, how); updateAll() }

// ---- the context: path, outline mark, guide, status, strip, counts (once per frame of scrolling) ----
let lastCtx = ''
function context() {
  const d = D()
  const ln = focusLine()
  const path = pathOf(d, ln)
  const key = `${S.dump}|${ln}|${path.at(-1).id}|${S.sel}`
  paintStrip()
  if (key === lastCtx) return
  lastCtx = key
  const cpath = path.filter((n) => n.kind !== 'cbqt' && n.kind !== 'join-search')
  $('#crumbs').innerHTML = cpath.map((n, k) => `${k ? '<span class="crumb-sep">›</span>' : ''}<button class="link${k === 0 ? ' crumb-id' : ''}${k === cpath.length - 1 ? ' crumb-last' : ''}" data-go-node="${n.id}" title="${esc(n.label)}: lines ${fmtN(n.from)}-${fmtN(n.to)}">${esc(n.crumb)}</button>`).join('')
  $('#at-line').textContent = `line ${fmtN(ln)}`
  const curBefore = olCurId
  if (S.ltab === 'outline') {
    const flat = olFlat()
    const shown = new Set(flat.map((x) => x.n.id))
    let cur = null
    for (const n of path) if (shown.has(n.id)) cur = n.id
    if (cur !== curBefore) renderOutline(true)
  }
  renderGuide()
  status()
}

function status() {
  const d = D()
  let hidden = 0, nf = 0
  if (S.mode === 'fmt') for (const r of VIEW.rows) if (r.t === 'fold') { hidden += r.fold.lines - 1; nf++ }
  $('#status').innerHTML = `<span>Lines <b>${fmtN(topLine())}-${fmtN(bottomLine())}</b> of ${fmtN(d.viewFrom)}-${fmtN(d.viewTo)}</span><span>Dump <b>${d.idx + 1}</b> of ${M.dumps.length}</span>` +
    (S.mode === 'fmt' ? `<span>${nf} ${nf === 1 ? 'fold' : 'folds'} closed, <b>${fmtN(hidden)}</b> lines hidden</span>` : '<span>Raw: the file as it is</span>') +
    `<span class="end">Mock-up on a real trace: data/two.trc</span>`
}

function updateAll() {
  lastCtx = ''
  schedule()
  counts()
  renderLeft(true)
  renderRight()
}

function counts() {
  const d = D()
  $('#q-count').textContent = S.qbad ? 'invalid' : S.q ? `${S.hitCur ? S.hits.indexOf(S.hitCur) + 1 : 0} / ${fmtN(S.hits.length)}` : ''
  const lms = enabledLms(d)
  const k = lms.findIndex((l) => l.line === S.lmCur)
  $('#lm-count').textContent = `${k >= 0 ? k + 1 : '–'} / ${fmtN(lms.length)}`
  $('#tab-count').textContent = `${M.dumps.length} dumps`
  const any = D().folds.some((f) => foldClosed(f))
  $('#fold-all').textContent = any ? 'Unfold all' : 'Default folds'
  $('#m-fmt').setAttribute('aria-checked', S.mode === 'fmt'); $('#m-raw').setAttribute('aria-checked', S.mode === 'raw')
  $('#bm').setAttribute('aria-pressed', S.bms.has(S.sel))
}

// ---- the line map ----
const strip = $('#strip')
function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim() }
function resolveColor(v) { const el = document.createElement('i'); el.style.color = v; document.body.append(el); const c = getComputedStyle(el).color; el.remove(); return c }
let colors = null
function paintStrip() {
  const d = D()
  const h = Math.floor(strip.clientHeight), W = 16
  if (h <= 0) return
  const dpr = devicePixelRatio || 1
  if (strip.width !== W * dpr || strip.height !== h * dpr) { strip.width = W * dpr; strip.height = h * dpr }
  const ctx = strip.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, h)
  if (!colors) colors = { ink: resolveColor('var(--ink)'), ink2: resolveColor('var(--ink-2)'), ink3: resolveColor('var(--ink-3)'), good: resolveColor('var(--s-good)'), crit: resolveColor('var(--s-critical)'), amber: resolveColor('var(--c-commit)') }
  const n = d.n, y = (ln) => ((ln - d.viewFrom) / n) * h
  // phases as bands in the middle lane (neutral shades in turn), a hairline between them
  const alpha = { 'phase-env': 0.07, 'phase-trans': 0.16, 'phase-cost': 0.27, 'phase-result': 0.1 }
  for (const p of d.phaseNodes) {
    ctx.globalAlpha = alpha[p.kind] ?? 0.05
    ctx.fillStyle = colors.ink
    ctx.fillRect(3, y(p.from), W - 6, Math.max(1, y(p.to + 1) - y(p.from)))
  }
  ctx.globalAlpha = 1
  // landmarks of the kinds that are on: the start lane, in their tone
  for (const l of d.lms) {
    if (!S.lmOn[l.kind]) continue
    ctx.fillStyle = l.tone === 'kept' ? colors.good : l.tone === 'problem' ? colors.crit : colors.ink3
    ctx.fillRect(0, Math.floor(y(l.line)), l.tone === 'problem' ? 6 : 3, l.tone === 'problem' ? 3 : 1)
  }
  // bookmarks: the start lane, ink; search hits: the end lane
  ctx.fillStyle = colors.ink
  for (const b of S.bms.keys()) if (b >= d.viewFrom && b <= d.viewTo) ctx.fillRect(0, Math.max(0, y(b) - 1), 5, 3)
  ctx.fillStyle = colors.ink2
  for (const ht of S.hits) ctx.fillRect(W - 3, Math.floor(y(ht)), 3, 1)
  if (S.sel >= d.viewFrom && S.sel <= d.viewTo) { ctx.fillStyle = colors.amber; ctx.fillRect(0, Math.min(h - 2, Math.floor(y(S.sel))), W, 2) }
  // the visible range
  const t = topLine(), b = bottomLine()
  const bh = Math.min(h, Math.max(5, y(b + 1) - y(t)))
  const by = Math.min(h - bh, Math.max(0, y(t)))
  ctx.globalAlpha = 0.1; ctx.fillStyle = colors.ink; ctx.fillRect(0, by, W, bh); ctx.globalAlpha = 1
  ctx.strokeStyle = colors.ink; ctx.lineWidth = 1; ctx.strokeRect(0.5, by + 0.5, W - 1, bh - 1)
}
function stripLine(e) { const r = strip.getBoundingClientRect(); const d = D(); return Math.min(d.viewTo, Math.max(d.viewFrom, d.viewFrom + Math.floor(((e.clientY - r.top) / r.height) * d.n))) }
let dragging = false
strip.addEventListener('pointerdown', (e) => { dragging = true; try { strip.setPointerCapture(e.pointerId) } catch (x) {} reveal(stripLine(e), 'top') })
strip.addEventListener('pointermove', (e) => {
  const ln = stripLine(e)
  const p = D().phaseNodes.find((x) => x.from <= ln && ln <= x.to)
  strip.title = `Line ${fmtN(ln)}${p ? ' · ' + p.label : ''}. Phases as bands; landmarks at the left edge, search hits at the right edge; the box is the visible range. Click or drag to go there.`
  if (dragging) reveal(ln, 'top')
})
strip.addEventListener('pointerup', () => { dragging = false; updateAll() })

// ---- search ----
let qTimer = 0
function runSearch() {
  const d = D()
  S.hits = []; S.hitSet = new Set(); S.qre = null; S.qbad = false
  if (S.q) {
    try { S.qre = new RegExp(S.re ? S.q : S.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g' + (S.cs ? '' : 'i')) } catch (e) { S.qbad = true }
    if (S.qre) {
      const t = new RegExp(S.qre.source, S.qre.flags.replace('g', ''))
      for (let i = d.viewFrom; i <= d.viewTo; i++) if (t.test(line(i))) S.hits.push(i)
      S.hitSet = new Set(S.hits)
    }
  }
  if (!S.hitSet.has(S.hitCur)) S.hitCur = 0
  $('#q').classList.toggle('bad', S.qbad)
  updateAll()
}
function step(list, cur, dir) {
  if (!list.length) return 0
  const from = cur || focusLine()
  if (dir > 0) return list.find((l) => l > from) ?? list[0]
  return [...list].reverse().find((l) => l < from) ?? list.at(-1)
}
function stepHit(dir) { if (!S.hits.length) return; S.hitCur = step(S.hits, S.sel || S.hitCur, dir); select(S.hitCur) }
function stepLm(dir) { const ls = enabledLms(D()).map((l) => l.line); if (!ls.length) return; S.lmCur = step(ls, S.sel || S.lmCur, dir); select(S.lmCur) }
function stepRun(dir) { const rs = D().runs.map((r) => r.from); const ln = step(rs, S.sel, dir); if (ln) select(ln, 'top') }

// ---- folds ----
function toggleFoldAt(ln) {
  const d = D()
  const r = VIEW.rows[rowOf(ln)]
  const f = r && r.t === 'fold' ? r.fold : foldOf(d, ln)
  if (!f) return
  const top = topLine()
  S.foldOv.set(f.id, !foldClosed(f))
  rebuild(top)
  if (foldClosed(f)) S.sel = f.from
  reveal(S.sel || f.from)
  updateAll()
}
function toggleAllFolds() {
  const d = D()
  const top = topLine()
  if (d.folds.some((f) => foldClosed(f))) for (const f of d.folds) S.foldOv.set(f.id, false)
  else for (const f of d.folds) S.foldOv.delete(f.id)
  rebuild(top); updateAll()
}

// ---- dumps, modes ----
function openDump(k) {
  if (k === S.dump) return
  S.dump = k; S.sel = 0; S.hitCur = 0; S.lmCur = 0; S.sqlSel = 0
  lastCtx = ''
  lv.scrollTop = 0
  runSearch()
  rebuild(D().viewFrom)
  lv.scrollTop = 0
  updateAll()
}
function setMode(m) { if (m === S.mode) return; const top = S.sel && selVisible() ? null : topLine(); S.mode = m; rebuild(top ?? topLine()); if (S.sel) reveal(S.sel); updateAll() }
function goNode(id) {
  const d = D()
  const n = d.byId.get(id)
  if (!n) return
  S.sel = n.from
  reveal(n.from, 'top')
  updateAll()
}

// ---- events ----
$('#m-fmt').onclick = () => setMode('fmt')
$('#m-raw').onclick = () => setMode('raw')
$('#q').addEventListener('input', (e) => { S.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(runSearch, 120) })
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qTimer); if (S.q !== $('#q').value) { S.q = $('#q').value; runSearch() } stepHit(e.shiftKey ? -1 : 1) }
  else if (e.key === 'Escape') { e.preventDefault(); lv.focus() }
})
$('#q-re').onclick = () => { S.re = !S.re; $('#q-re').setAttribute('aria-pressed', S.re); runSearch() }
$('#q-cs').onclick = () => { S.cs = !S.cs; $('#q-cs').setAttribute('aria-pressed', S.cs); runSearch() }
$('#q-next').onclick = () => stepHit(1)
$('#q-prev').onclick = () => stepHit(-1)
$('#lm-next').onclick = () => stepLm(1)
$('#lm-prev').onclick = () => stepLm(-1)
$('#run-next').onclick = () => stepRun(1)
$('#run-prev').onclick = () => stepRun(-1)
$('#fold-all').onclick = toggleAllFolds
$('#bm').onclick = () => toggleBm()
function toggleBm() { if (!S.sel) return; if (S.bms.has(S.sel)) S.bms.delete(S.sel); else S.bms.set(S.sel, ''); updateAll() }
$('#keys-btn').onclick = (e) => { e.stopPropagation(); const p = $('#keys-pop'); p.hidden = !p.hidden; $('#keys-btn').setAttribute('aria-expanded', !p.hidden) }
document.addEventListener('click', (e) => { if (!e.target.closest('.tbmenu')) { $('#keys-pop').hidden = true; $('#keys-btn').setAttribute('aria-expanded', 'false') } })

layer.addEventListener('click', (e) => {
  const fb = e.target.closest('[data-fold]')
  const rowEl = e.target.closest('.lv-row')
  if (!rowEl) return
  const r = VIEW.rows[+rowEl.dataset.r]
  if (fb) { S.sel = r.line; toggleFoldAt(r.line); return }
  if (r.t === 'fold') { S.sel = r.line; toggleFoldAt(r.line); return }
  const pl = e.target.closest('[data-plan]')
  if (pl) { const d = D(); const top = topLine(); if (pl.dataset.plan === 'text') S.planText.add(d.idx); else S.planText.delete(d.idx); rebuild(top); updateAll(); return }
  const df = e.target.closest('[data-diff]')
  if (df) { S.rtab = 'sql'; S.sqlSel = +df.dataset.diff; S.sqlAgainst = 0; S.sqlDiff = true; S.sel = r.line; updateAll(); return }
  S.sel = r.line
  lastCtx = ''
  updateAll()
  lv.focus({ preventScroll: true })
})
// the glossary card
const card = $('#card')
layer.addEventListener('mouseover', (e) => {
  const g = e.target.closest('.gl')
  if (!g) { card.hidden = true; return }
  const t = GLOSS.get(g.dataset.t)
  if (!t) return
  card.innerHTML = `<b>${esc(t.term)}</b>${esc(t.text)}`
  const r = g.getBoundingClientRect()
  card.style.setProperty('--x', Math.min(r.left, innerWidth - 460) + 'px')
  card.style.setProperty('--y', r.bottom + 4 + 'px')
  card.hidden = false
})
layer.addEventListener('mouseleave', () => { card.hidden = true })

$('#lbody').addEventListener('click', (e) => {
  const tw = e.target.closest('[data-tw]')
  const dumpEl = e.target.closest('[data-dump]')
  if (dumpEl && +dumpEl.dataset.dump !== S.dump) { openDump(+dumpEl.dataset.dump); return }
  if (tw && tw.dataset.tw) { const id = tw.dataset.tw; if (S.exp.has(id)) S.exp.delete(id); else S.exp.add(id); renderOutline(false); return }
  const nd = e.target.closest('[data-node]')
  if (nd) { const id = nd.dataset.node; const n = D().byId.get(id); if (n && n.children.length) S.exp.add(id); goNode(id); return }
  const go = e.target.closest('[data-go]')
  if (go) { const ln = +go.dataset.go; if (D().lmAt.has(ln)) S.lmCur = ln; select(ln); return }
  const ub = e.target.closest('[data-unbm]')
  if (ub) { S.bms.delete(+ub.dataset.unbm); updateAll() }
})
$('#lbody').addEventListener('change', (e) => {
  const k = e.target.dataset.lmk
  if (k) { S.lmOn[k] = e.target.checked; updateAll() }
})
$('#lbody').addEventListener('input', (e) => { const l = e.target.dataset.note; if (l) { S.bms.set(+l, e.target.value); schedule() } })
$('#ltitle').addEventListener('click', (e) => { const b = e.target.closest('[data-olmode]'); if (b) { S.olMode = b.dataset.olmode; renderLeft(true) } })
$('#ltabs').addEventListener('click', (e) => { const t = e.target.closest('[data-ltab]'); if (t) { S.ltab = t.dataset.ltab; renderLeft(true) } })
$('#rtabs').addEventListener('click', (e) => { const t = e.target.closest('[data-rtab]'); if (t) { S.rtab = t.dataset.rtab; renderRight() } })
$('#rbody').addEventListener('click', (e) => {
  const v = e.target.closest('[data-sqlv]')
  if (v) { S.sqlSel = +v.dataset.sqlv; S.sqlAgainst = 0; renderSql(); return }
  if (e.target.closest('#sql-diff')) { S.sqlDiff = !S.sqlDiff; renderSql(); return }
  const g = e.target.closest('[data-sqlgo]')
  if (g) { select(+g.dataset.sqlgo, 'top') }
})
$('#rbody').addEventListener('change', (e) => { if (e.target.id === 'sql-against') { S.sqlAgainst = +e.target.value; renderSql() } })
$('#crumbs').addEventListener('click', (e) => { const b = e.target.closest('[data-go-node]'); if (b) goNode(b.dataset.goNode) })

document.addEventListener('keydown', (e) => {
  if (e.key === 'F3') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1); return }
  if ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#q').focus(); $('#q').select(); return }
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return
  const d = D()
  const move = (dir) => {
    const cur = S.sel && selVisible() ? S.sel : (dir > 0 ? topLine() : bottomLine())
    let r = rowOf(cur) + (S.sel && selVisible() ? dir : 0)
    while (VIEW.rows[r] && VIEW.rows[r].line === cur && dir) r += dir
    const row = VIEW.rows[Math.min(VIEW.rows.length - 1, Math.max(0, r))]
    if (row) { S.sel = row.line; reveal(row.line, 'near'); updateAll() }
  }
  switch (e.key) {
    case 'v': setMode(S.mode === 'fmt' ? 'raw' : 'fmt'); break
    case '/': e.preventDefault(); $('#q').focus(); $('#q').select(); break
    case ']': stepLm(1); break
    case '[': stepLm(-1); break
    case 'r': stepRun(1); break
    case 'R': stepRun(-1); break
    case 'z': if (S.sel) toggleFoldAt(S.sel); break
    case 'Z': toggleAllFolds(); break
    case 'b': toggleBm(); break
    case 'd': openDump((S.dump + 1) % M.dumps.length); break
    case 'g': select(d.viewFrom, 'top'); break
    case 'G': select(d.viewTo); break
    case 'j': case 'ArrowDown': e.preventDefault(); move(1); break
    case 'k': case 'ArrowUp': e.preventDefault(); move(-1); break
    case '?': $('#keys-btn').click(); break
    case 'Escape': $('#keys-pop').hidden = true; break
    default: return
  }
})

// ---- theme: auto (the system), light, dark; data-theme on <html> ----
;(function theme() {
  const root = document.documentElement, btn = $('#theme'), label = $('#theme-label')
  const modes = ['auto', 'light', 'dark']
  let mode = 'auto'
  try { mode = localStorage.getItem('mtk-mock-theme') || 'auto' } catch (e) {}
  const q = new URLSearchParams(location.search).get('theme')
  if (q && modes.includes(q)) mode = q
  const apply = () => { if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode); label.textContent = mode[0].toUpperCase() + mode.slice(1); colors = null; paintStrip() }
  btn.addEventListener('click', () => { mode = modes[(modes.indexOf(mode) + 1) % 3]; try { localStorage.setItem('mtk-mock-theme', mode) } catch (e) {} apply() })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colors = null; paintStrip() })
  apply()
})()

// ---- boot ----
;(function boot() {
  const f = M.file
  $('#file-name').textContent = f.name
  $('#subbar').innerHTML = `<span><b>${esc(f.name)}</b></span><span>${esc(f.release.replace(/ - Production$/, ''))}</span><span>Version <b>${esc(f.version)}</b></span>` +
    `<span><b>${M.dumps.length}</b> optimizer (10053) dumps</span><span><b>${fmtN(f.lines)}</b> lines</span><span class="note mono" title="${esc(f.path)}">${esc(f.path.split('/').pop())}</span>`
  rebuild(D().viewFrom)
  lv.scrollTop = 0
  updateAll()
  window.__app = { S, M, D, rebuild, select, openDump, goNode, setMode, runSearch, stepHit, stepLm, toggleAllFolds, toggleFoldAt, topLine, rowOf, VIEW: () => VIEW, renderLeft, renderRight, updateAll }
})()
