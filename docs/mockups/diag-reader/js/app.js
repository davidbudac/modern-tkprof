// The dump reader mock-up: state, the text viewer, the outline, the two variants (A: Reading | Text in the centre; B: text always, the reading in the
// right panel), the line map, search, folds, the four states. No framework; the data comes from tools/parse.mjs.
const ROW = 20

const STATES = [
  { id: 'errorstack', label: 'Error stack', file: 'errorstack', title: 'Error stack, level 2' },
  { id: 'process', label: 'Process', file: 'errorstack', title: 'Process state of the same file' },
  { id: 'heap', label: 'Heap', file: 'heap', title: 'Heap dump with sub-heaps' },
  { id: 'sysstate', label: 'System state', file: 'sysstate', title: 'System state, level 266' },
  { id: 'hang', label: 'Hang analysis', file: 'hang', title: 'Hang analysis' },
]

const S = {
  state: 'errorstack', variant: 'a', mode: 'reading', node: null, sel: 0,
  foldOv: new Map(), exp: new Set(),
  q: '', hits: [], hitSet: new Set(), hitCur: 0,
  heapTab: 'comment', chunk: null, incOwn: false, ownOpen: false, hideIdle: false,
  sort: { comment: { col: 'bytes', dir: -1 }, type: { col: 'bytes', dir: -1 }, subs: { col: 'total', dir: -1 }, proc: { col: 'pid', dir: 1 } },
}
let M = null, LINES = [], NODES = [], BYID = new Map(), PARENT = new Map(), FOLDS = [], FOLD_BY_FROM = new Map(), HEADS = {}
let VIEW = { rows: [], map: new Int32Array(0) }
let LOADED_SET = null

// ---- loading ----------------------------------------------------------------------------------------------------------------------------------
function loadScript(src) {
  return new Promise((res, rej) => {
    const s = document.createElement('script')
    s.src = src; s.onload = res; s.onerror = () => rej(new Error('cannot load ' + src + ' (run node tools/parse.mjs)'))
    document.head.append(s)
  })
}
async function ensure(key) {
  if (!(window.DIAG && window.DIAG[key])) await loadScript(`data/${key}.js`)
  if (!(window.TXT && window.TXT[key])) await loadScript(`data/${key}.txt.js`)
}

function indexModel() {
  NODES = []; BYID = new Map(); PARENT = new Map()
  const walk = (n, p) => { NODES.push(n); BYID.set(n.id, n); if (p) PARENT.set(n.id, p); n.children.forEach((c) => walk(c, n)) }
  walk(M.outline, null)
  const t = TXT[M.key]
  LINES = new Array(t.lines + 2)
  for (const sl of t.slices) { const a = sl.text.split('\n'); for (let i = 0; i < a.length; i++) LINES[sl.from + i] = a[i] }
  HEADS = M.heads
  FOLDS = M.folds.map((f, i) => ({ ...f, id: 'f' + i, lines: f.to - f.from + 1 }))
  FOLD_BY_FROM = new Map()
  for (const f of FOLDS) { if (!FOLD_BY_FROM.has(f.from)) FOLD_BY_FROM.set(f.from, []); FOLD_BY_FROM.get(f.from).push(f) }
  for (const a of FOLD_BY_FROM.values()) a.sort((x, y) => y.to - x.to)
}
const isLoaded = (ln) => LINES[ln] !== undefined
const lineText = (ln) => LINES[ln]
function foldClosed(f) { return S.foldOv.has(f.id) ? S.foldOv.get(f.id) : true }

// ---- the model: nodes, paths, readings -----------------------------------------------------------------------------------------------------
function deepestAt(ln) {
  let best = null, bs = Infinity
  for (const n of NODES) { if (n === M.outline) continue; if (n.from <= ln && ln <= n.to) { const sz = n.to - n.from; if (sz <= bs) { bs = sz; best = n } } }
  return best
}
function pathTo(n) { const p = []; for (let x = n; x; x = PARENT.get(x.id)) if (x !== M.outline) p.unshift(x); return p }
function readingNode(n) { for (let x = n; x; x = PARENT.get(x.id)) if (x.r) return x; return null }
function readingKey(n) { const x = readingNode(n); return x ? x.r : null }
function readingTitle(key) {
  if (!key) return ''
  if (key === 'callstack') return 'Call stack'
  if (key.startsWith('proc:')) return 'Process'
  if (key.startsWith('heap:')) return 'Heap'
  if (key === 'sysstate') return 'System state'
  if (key === 'hang') return 'Hang analysis'
  return ''
}
function renderReadingHtml(key) {
  if (!key) return noReading()
  if (key === 'callstack') return readCallstack()
  if (key.startsWith('proc:')) return readProcess(key)
  if (key.startsWith('heap:')) return readHeap(key.slice(5))
  if (key === 'sysstate') return readSysstate()
  if (key === 'hang') return readHang()
  return noReading()
}
const effMode = () => (S.variant === 'a' && readingKey(BYID.get(S.node)) && S.mode === 'reading' ? 'reading' : 'text')

// ---- rows of the text viewer ----------------------------------------------------------------------------------------------------------------
function buildRows() {
  const n = M.lines
  const rows = []
  const map = new Int32Array(n + 2).fill(-1)
  let ln = 1
  while (ln <= n) {
    if (!isLoaded(ln)) {
      let e = ln
      while (e + 1 <= n && !isLoaded(e + 1)) e++
      for (let i = ln; i <= e; i++) map[i] = rows.length
      rows.push({ t: 'gap', ln, from: ln, to: e })
      ln = e + 1
      continue
    }
    const fl = FOLD_BY_FROM.get(ln)
    const f = fl && fl.find((x) => foldClosed(x))
    if (f) {
      for (let i = f.from; i <= f.to; i++) map[i] = rows.length
      rows.push({ t: 'fold', ln, fold: f })
      ln = f.to + 1
      continue
    }
    map[ln] = rows.length
    rows.push({ t: 'line', ln })
    ln++
  }
  VIEW = { rows, map }
}
const lv = $('#lv'), inner = $('#lv-inner'), layer = $('#lv-layer')
function rowOf(ln) { const r = VIEW.map[Math.min(Math.max(ln, 1), M.lines)]; return r < 0 ? 0 : r }
function topLine() { const r = VIEW.rows[Math.floor(lv.scrollTop / ROW)]; return r ? r.ln : 1 }
function bottomLine() { const r = VIEW.rows[Math.min(VIEW.rows.length - 1, Math.floor((lv.scrollTop + lv.clientHeight - 1) / ROW))]; return r ? (r.t === 'gap' ? r.to : r.t === 'fold' ? r.fold.to : r.ln) : M.lines }
function selVisible() { if (!S.sel) return false; const r = rowOf(S.sel); return r * ROW >= lv.scrollTop - 1 && (r + 1) * ROW <= lv.scrollTop + lv.clientHeight + 1 }
function focusLine() { return selVisible() ? S.sel : topLine() }

function rebuild(keepLine) {
  const top = keepLine ?? topLine()
  buildRows()
  inner.style.blockSize = VIEW.rows.length * ROW + 'px'
  lv.scrollTop = rowOf(top) * ROW
  paint()
}

// ---- painting a row --------------------------------------------------------------------------------------------------------------------------------
let qre = null
function marked(text) {
  if (!qre) return esc(text)
  let out = '', last = 0, m
  qre.lastIndex = 0
  while ((m = qre.exec(text))) {
    if (m[0] === '') { qre.lastIndex++; continue }
    out += esc(text.slice(last, m.index)) + '<mark>' + esc(m[0]) + '</mark>'
    last = m.index + m[0].length
  }
  return out + esc(text.slice(last))
}
const RULE = /^\s*(={5,}|-{5,}|\*{5,})\s*$/
function dress(ln, text, hit) {
  const h = HEADS[ln]
  const t = text
  if (RULE.test(t)) return { cls: 'x-rule', html: '' }
  switch (h) {
    case 'b': case 'b1': return { cls: 'x-h1', html: marked(t) }
    case 'h2': return { cls: 'x-h1', html: marked(t) }
    case 'hp': { return { cls: 'x-h1 x-hp', html: hit ? marked(t) : esc(t).replace(/(heap name=)(&quot;.*?&quot;)/, '$1<b>$2</b>') } }
    case 't': case 'f': case 'hs': {
      if (hit) return { cls: 'x-h3', html: marked(t) }
      const m = /^(-{5,}|={5,})(\s+)(.*?)(\s*)(-{5,}|={5,})$/.exec(t)
      if (m && h !== 'hs') return { cls: 'x-h3', html: `<span class="x-dash">${m[1]}</span>${m[2]}${esc(m[3])}${m[4]}<span class="x-dash">${m[5]}</span>` }
      return { cls: 'x-h3', html: esc(t) }
    }
    case 'so': return { cls: 'x-so', html: hit ? marked(t) : esc(t).replace(/^(\s*SO:)(.*?type: )(.*?)(, map:.*)$/, '<span class="x-dim">$1</span>$2<b>$3</b><span class="x-dim">$4</span>') }
    case 'ex': return { cls: 'x-ex', html: marked(t) }
    case 'ts': return { cls: 'x-dim', html: marked(t) }
    default: return { cls: '', html: marked(t) }
  }
}
function paintRow(r, k) {
  if (r.t === 'gap') {
    const n = r.to - r.from + 1
    return `<div class="lv-row x-gap" data-r="${k}"><span class="lv-ln">${fmtN(r.from)}</span><span class="lv-fh"></span><span class="lv-tx">${fmtN(n)} line${n === 1 ? '' : 's'} not loaded in this mock-up <span class="x-dim">(lines ${fmtN(r.from)}-${fmtN(r.to)})</span></span></div>`
  }
  const ln = r.ln
  const hit = S.hitSet.has(ln)
  const ch = S.chunk && S.chunk.set.has(ln)
  const cls = ['lv-row']
  if (ln === S.sel) cls.push('lv-sel')
  if (ch) cls.push('lv-hl')
  if (r.t === 'fold') {
    const f = r.fold
    const txt = lineText(ln)
    const inHits = S.hits.length ? countIn(S.hits, f.from + 1, f.to) : 0
    cls.push('x-fold')
    return `<div class="${cls.join(' ')}" data-r="${k}"><span class="lv-ln">${fmtN(ln)}</span><span class="lv-fh"><button type="button" class="lv-fold" data-fold="${f.id}" aria-label="Open the fold" title="Open: ${esc(f.reason)}">▸</button></span><span class="lv-tx"><span class="fold-t">${hit ? marked(txt) : esc(txt)}</span><span class="fold-sum"><b>${fmtN(f.lines - 1)}</b> lines folded · ${esc(f.reason)}${inHits ? ` · <i>${fmtN(inHits)} hit${inHits === 1 ? '' : 's'} inside</i>` : ''}</span></span></div>`
  }
  const txt = lineText(ln)
  const d = dress(ln, txt, hit)
  if (d.cls) cls.push(d.cls)
  const fl = FOLD_BY_FROM.get(ln)
  const fb = fl ? `<button type="button" class="lv-fold" data-fold="${fl[0].id}" aria-label="Close the fold" title="Fold: ${esc(fl[0].reason)}">▾</button>` : ''
  return `<div class="${cls.join(' ')}" data-r="${k}"><span class="lv-ln">${fmtN(ln)}</span><span class="lv-fh">${fb}</span><span class="lv-tx">${d.html}</span></div>`
}
let frame = 0
function paint() {
  frame = 0
  if (!M) return
  const first = Math.max(0, Math.floor(lv.scrollTop / ROW) - 8)
  const last = Math.min(VIEW.rows.length, Math.ceil((lv.scrollTop + lv.clientHeight) / ROW) + 8)
  layer.style.transform = `translateY(${first * ROW}px)`
  let html = ''
  for (let k = first; k < last; k++) html += paintRow(VIEW.rows[k], k)
  layer.innerHTML = html
  context()
}
function schedule() { if (!frame) frame = requestAnimationFrame(paint) }
lv.addEventListener('scroll', schedule, { passive: true })
new ResizeObserver(() => { schedule(); paintStrip() }).observe(lv)

/** Bring a line into view: open the folds that hide it, then scroll. */
function reveal(ln, how = 'center') {
  let changed = false
  for (const f of FOLDS) if (f.from < ln && ln <= f.to && foldClosed(f)) { S.foldOv.set(f.id, false); changed = true }
  if (changed) rebuild(topLine())
  const r = rowOf(ln)
  const y = r * ROW
  if (how === 'top') lv.scrollTop = Math.max(0, y - ROW)
  else if (how === 'near') { if (y < lv.scrollTop) lv.scrollTop = y; else if (y + ROW > lv.scrollTop + lv.clientHeight) lv.scrollTop = y + ROW - lv.clientHeight }
  else if (y < lv.scrollTop || y + ROW > lv.scrollTop + lv.clientHeight) lv.scrollTop = Math.max(0, y - lv.clientHeight / 2 + ROW)
  schedule()
}

// ---- selection: nodes and lines ------------------------------------------------------------------------------------------------------------------
function expandTo(n) { for (let x = PARENT.get(n.id); x; x = PARENT.get(x.id)) S.exp.add(x.id) }
function selectNode(id, opts = {}) {
  const n = BYID.get(id)
  if (!n) return
  const prevHeap = S.chunk ? S.chunk.heap : null
  S.node = id
  expandTo(n)
  const rk = readingKey(n)
  if (S.variant === 'a' && opts.fromOutline !== false) S.mode = rk ? 'reading' : 'text'
  if (S.chunk && !(rk && rk === 'heap:' + S.chunk.heap)) S.chunk = null
  S.sel = n.from
  if (isLoaded(n.from)) reveal(n.from, 'top')
  updateAll()
}
function selectLine(ln, how) {
  S.sel = ln
  const n = deepestAt(ln)
  if (n) { S.node = n.id; expandTo(n) }
  if (S.chunk && !(n && readingKey(n) === 'heap:' + S.chunk.heap)) S.chunk = null
  reveal(ln, how)
  updateAll()
}
/** from a reading: go to a line of the text (switches the centre to Text in variant A) */
function goLine(ln) {
  if (S.variant === 'a') S.mode = 'text'
  if (!isLoaded(ln)) return
  S.sel = ln
  const n = deepestAt(ln)
  if (n && !readingNode(BYID.get(S.node)) === !readingNode(n)) { /* keep the reading's node */ }
  updateAll()
  requestAnimationFrame(() => { reveal(ln, 'center'); updateAll() })
}

// ---- the centre: path, text or reading, status -----------------------------------------------------------------------------------------------
let lastCtx = ''
function context() {
  if (!M) return
  const reading = effMode() === 'reading'
  const ln = focusLine()
  const n = reading ? BYID.get(S.node) : deepestAt(ln)
  const key = `${M.key}|${reading}|${ln}|${n ? n.id : ''}|${S.node}|${S.sel}|${S.hits.length}`
  paintStrip()
  if (key === lastCtx) return
  lastCtx = key
  const path = n ? pathTo(n) : []
  const parts = [`<button type="button" class="link crumb-id" data-go-line="1" title="Top of the file">${esc(M.name)}</button>`]
  path.forEach((x, k) => parts.push(`<span class="crumb-sep">›</span><button type="button" class="link${k === path.length - 1 ? ' crumb-last' : ''}" data-go-node="${x.id}" title="${esc(x.label)}: lines ${fmtN(x.from)}-${fmtN(x.to)}">${esc(x.label)}</button>`))
  $('#crumbs').innerHTML = parts.join('')
  $('#at-line').textContent = reading && n ? `lines ${fmtN(n.from)}-${fmtN(n.to)}` : `line ${fmtN(ln)}`
  markOutline(n)
  status()
}
function status() {
  let hidden = 0, nf = 0
  for (const r of VIEW.rows) if (r.t === 'fold') { hidden += r.fold.lines - 1; nf++ }
  const lost = M.lines - M.present.reduce((s, [a, b]) => s + b - a + 1, 0)
  $('#status').innerHTML = `<span>Lines <b>${fmtN(topLine())}-${fmtN(bottomLine())}</b> of ${fmtN(M.lines)}</span><span>${nf} ${nf === 1 ? 'fold' : 'folds'} closed, <b>${fmtN(hidden)}</b> lines hidden</span>` +
    (lost ? `<span><b>${fmtN(lost)}</b> lines not loaded in this mock-up</span>` : '') +
    `<span class="end" title="${esc(M.path)}">Mock-up on a real trace</span>`
}

// ---- the outline -----------------------------------------------------------------------------------------------------------------------------------
function isExp(n) { return n.children.length > 0 && S.exp.has(n.id) }
function olFlat() {
  const out = []
  const go = (n, d) => {
    if (S.hideIdle && n.idle) return
    out.push({ n, d })
    if (isExp(n)) n.children.forEach((c) => go(c, d + 1))
  }
  M.outline.children.forEach((c) => go(c, 0))
  return out
}
function nodeHits(n) {
  if (!S.hits.length) return 0
  return countIn(S.hits, n.from, n.to)
}
function renderOutline() {
  const flat = olFlat()
  const cur = deepestAt(focusLine())
  const curPath = new Set(cur ? pathTo(cur).map((x) => x.id) : [])
  let html = '<div class="ol">'
  for (const { n, d } of flat) {
    const hasKids = n.children.length > 0
    const hits = nodeHits(n)
    const tag = n.kind === 'process' && n.idle ? ' ol-dim' : ''
    html += `<div class="ol-row${S.node === n.id ? ' on' : ''}${curPath.has(n.id) ? ' inpath' : ''}${tag}" style="--d:${d}" data-node="${n.id}" role="treeitem" ${hasKids ? `aria-expanded="${isExp(n)}"` : ''}>` +
      `<span class="ol-x" ${hasKids ? `data-tw="${n.id}"` : ''}>${hasKids ? (isExp(n) ? '▾' : '▸') : ''}</span>` +
      `<span class="ol-main"><span class="ol-l1"><span class="ol-label${n.kind === 'so-group' ? ' ol-grp' : ''}">${esc(n.label)}</span>${hits ? `<span class="ol-hits">${fmtN(hits)}</span>` : ''}<span class="ol-n" title="${fmtN(n.n)} lines (${fmtN(n.from)}-${fmtN(n.to)})">${fmtN(n.n)}</span></span>` +
      `${n.sub ? `<span class="ol-l2"><span class="${n.kind === 'cursor' || n.kind === 'so:LIBRARY OBJECT LOCK' || n.kind === 'so:LIBRARY OBJECT PIN' ? 'mono' : ''}">${esc(n.sub)}</span></span>` : ''}</span></div>`
  }
  html += '</div>'
  const body = $('#lbody')
  const st = body.scrollTop
  body.innerHTML = html
  body.scrollTop = st
  $('#ltitle').innerHTML = `Outline<small>${fmtN(NODES.length - 1)} nodes</small>`
  const ctl = $('#ol-ctl')
  ctl.hidden = M.key !== 'sysstate'
  if (M.key === 'sysstate') ctl.querySelector('input').checked = S.hideIdle
  if (M.key === 'sysstate') ctl.querySelector('span').textContent = `Hide idle background processes (${M.readings.sysstate.counts.idleBg})`
}
let olCur = ''
function markOutline(cur) {
  const body = $('#lbody')
  const path = new Set(cur ? pathTo(cur).map((x) => x.id) : [])
  const sig = [...path].join(',') + '|' + S.node
  if (sig === olCur) return
  olCur = sig
  for (const el of $$('.ol-row', body)) { el.classList.toggle('on', el.dataset.node === S.node); el.classList.toggle('inpath', path.has(el.dataset.node)) }
}
function scrollOutlineTo(id) {
  const el = $(`.ol-row[data-node="${id}"]`, $('#lbody'))
  if (el) el.scrollIntoView({ block: 'nearest' })
}

// ---- the toolbar, centre switch and panels ---------------------------------------------------------------------------------------------------
function renderToolbar() {
  $('#states').innerHTML = STATES.map((s) => `<button type="button" role="radio" data-state="${s.id}" aria-checked="${S.state === s.id}" title="${esc(s.title)}">${esc(s.label)}</button>`).join('')
  const has = !!readingKey(BYID.get(S.node))
  const em = effMode()
  $('#m-read').setAttribute('aria-checked', em === 'reading'); $('#m-text').setAttribute('aria-checked', em === 'text')
  $('#m-read').disabled = !has
  $('#modes').hidden = S.variant !== 'a'
  $('#var-a').setAttribute('aria-checked', S.variant === 'a'); $('#var-b').setAttribute('aria-checked', S.variant === 'b')
  const any = FOLDS.some((f) => foldClosed(f))
  $('#fold-all').textContent = any ? 'Unfold all' : 'Default folds'
  $('#fold-all').disabled = !FOLDS.length
  $('#q-count').textContent = S.q ? (S.hits.length ? `${S.hitCur ? S.hits.indexOf(S.hitCur) + 1 : 0} / ${fmtN(S.hits.length)}` : '0 hits') : ''
  $('#tab-count').textContent = `${fmtN(NODES.length - 1)} nodes`
  $('#file-name').textContent = M.name
  const h = M.header || {}
  const lost = M.lines - M.present.reduce((s, [a, b]) => s + b - a + 1, 0)
  $('#subbar').innerHTML = `<span><b>${esc(M.name)}</b></span><span class="ttl">${esc(M.title)}</span>${h.release ? `<span class="rel">${esc(h.release.replace(/ - Production$/, ''))}</span>` : ''}${h.version ? `<span>Version <b>${esc(h.version)}</b></span>` : ''}${h.instance ? `<span>Instance <b>${esc(h.instance)}</b></span>` : ''}<span><b>${fmtN(M.lines)}</b> lines · ${(M.bytes / 1048576).toFixed(M.bytes > 1048576 ? 1 : 2)} MB</span>${lost ? `<span class="warn-n">${fmtN(lost)} lines not loaded in this mock-up</span>` : ''}<span class="note mono">${esc(M.path)}</span>`
}
function renderCentre() {
  const em = effMode()
  const rc = $('#rd-centre')
  $('#lv-box').hidden = em !== 'text'
  rc.hidden = em !== 'reading'
  if (em === 'reading') {
    const st = rc.scrollTop
    rc.innerHTML = renderReadingHtml(readingKey(BYID.get(S.node)))
    rc.scrollTop = st
  } else { schedule() }
}
function renderRight() {
  const n = BYID.get(S.node)
  const rk = n ? readingKey(n) : null
  const body = $('#rbody')
  const st = body.scrollTop
  if (S.variant === 'b') {
    $('#rtitle').innerHTML = rk ? `Reading<small>${esc(readingTitle(rk))}</small>` : 'Reading'
    const about = guideHtml(n)
    body.innerHTML = (rk ? renderReadingHtml(rk) : noReadingFor(n)) + (about ? `<details class="about"><summary>About this section</summary>${about}</details>` : '')
  } else {
    $('#rtitle').innerHTML = `Guide<small>${n ? esc(n.label) : ''}</small>`
    body.innerHTML = detailsHtml(n)
  }
  body.scrollTop = st
}
function noReadingFor(n) { return `<div class="rd"><div class="rd-empty"><b>No reading for this kind of section.</b><br>${n ? esc(n.label) + ' is shown as text only.' : ''}</div></div>` }
function guideHtml(n) {
  if (!n) return ''
  const gs = guideFor(n.kind)
  if (!gs.length) return `<div class="g-none">No guide text for this kind of section (sourced or silent: ${esc(n.kind)}).</div>`
  return gs.map((g) => `<section class="g-sec"><div class="g-t">${g.t}</div><div class="g-p">${g.p}</div>${g.note ? `<div class="g-p g-note">${g.note}</div>` : ''}<div class="g-k">Source: <b>${SRC}</b>, § ${esc(g.src)}</div></section>`).join('')
}
function detailsHtml(n) {
  if (!n) return '<div class="side-note">Select a node in the outline.</div>'
  let nf = 0, fl = 0, edge = 0
  for (const f of FOLDS) if (f.from >= n.from && f.to <= n.to && f.from > edge) { nf++; fl += f.to - f.from; edge = f.to }
  const hits = nodeHits(n)
  const present = M.present.reduce((s, [a, b]) => s + Math.max(0, Math.min(b, n.to) - Math.max(a, n.from) + 1), 0)
  const rk = readingKey(n)
  return `<div class="guide">
    <section class="g-sec"><div class="g-k">Selected</div><div class="g-t">${esc(n.label)}</div>
      ${n.sub ? `<div class="g-p dim">${esc(n.sub)}</div>` : ''}
      <dl class="kv kv-s"><dt>Lines</dt><dd>${lnk(n.from, fmtN(n.from))} – ${fmtN(n.to)} <span class="dim">(${fmtN(n.n)})</span></dd>
        <dt>Kind</dt><dd class="mono">${esc(n.kind)}</dd>
        <dt>Children</dt><dd>${n.children.length ? fmtN(n.children.length) : 'none'}</dd>
        <dt>Folds</dt><dd>${nf ? `${nf} (${fmtN(fl)} lines)` : 'none'}</dd>
        ${S.q ? `<dt>Hits</dt><dd>${fmtN(hits)} for <span class="mono">${esc(S.q)}</span></dd>` : ''}
        ${present < n.n ? `<dt>Text</dt><dd>${fmtN(present)} of ${fmtN(n.n)} lines loaded</dd>` : ''}
        <dt>Reading</dt><dd>${rk ? `<b>${esc(readingTitle(rk))}</b> <span class="dim">(centre, Reading)</span>` : '<span class="dim">none for this kind of section</span>'}</dd></dl></section>
    ${guideHtml(n)}
  </div>`
}

function updateAll() {
  lastCtx = ''; olCur = ''
  renderToolbar(); renderOutline(); renderCentre(); renderRight()
  schedule()
  scrollOutlineTo(S.node)
  centreTree()
  context()
}

// ---- the line map ----------------------------------------------------------------------------------------------------------------------------
const strip = $('#strip')
function resolveColor(v) { const el = document.createElement('i'); el.style.color = v; document.body.append(el); const c = getComputedStyle(el).color; el.remove(); return c }
let colors = null
function paintStrip() {
  if (!M || $('#lv-box').hidden) return
  const h = Math.floor(strip.clientHeight), W = 16
  if (h <= 0) return
  const dpr = devicePixelRatio || 1
  if (strip.width !== W * dpr || strip.height !== h * dpr) { strip.width = W * dpr; strip.height = h * dpr }
  const ctx = strip.getContext('2d')
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, W, h)
  if (!colors) colors = { ink: resolveColor('var(--ink)'), ink2: resolveColor('var(--ink-2)'), ink3: resolveColor('var(--ink-3)'), amber: resolveColor('var(--c-commit)'), acc: resolveColor('var(--c-cpu)') }
  const n = M.lines, y = (ln) => ((ln - 1) / n) * h
  // sections (depth 2) as bands, in two neutral shades in turn
  let k = 0
  for (const x of NODES) {
    if (x.depth !== 2) continue
    ctx.globalAlpha = k++ % 2 ? 0.07 : 0.18
    ctx.fillStyle = colors.ink
    ctx.fillRect(3, y(x.from), W - 6, Math.max(1, y(x.to + 1) - y(x.from)))
  }
  // text that is loaded (only drawn when part of the file is missing)
  if (M.present.length > 1 || M.present[0][1] - M.present[0][0] + 1 < n) {
    ctx.globalAlpha = 0.55; ctx.fillStyle = colors.ink2
    for (const [a, b] of M.present) ctx.fillRect(W - 7, y(a), 2, Math.max(1, y(b + 1) - y(a)))
  }
  ctx.globalAlpha = 1
  // the chunk lines of a selected heap row, in the accent; search hits at the right edge
  if (S.chunk) { ctx.fillStyle = colors.acc; for (const l of S.chunk.lines) ctx.fillRect(0, Math.floor(y(l)), 4, 2) }
  ctx.fillStyle = colors.ink2
  for (const ht of S.hits) ctx.fillRect(W - 3, Math.floor(y(ht)), 3, 1)
  if (S.sel >= 1 && S.sel <= n) { ctx.fillStyle = colors.amber; ctx.fillRect(0, Math.min(h - 2, Math.floor(y(S.sel))), W, 2) }
  const t = topLine(), b = bottomLine()
  const bh = Math.min(h, Math.max(5, y(b + 1) - y(t)))
  const by = Math.min(h - bh, Math.max(0, y(t)))
  ctx.globalAlpha = 0.1; ctx.fillStyle = colors.ink; ctx.fillRect(0, by, W, bh); ctx.globalAlpha = 1
  ctx.strokeStyle = colors.ink; ctx.lineWidth = 1; ctx.strokeRect(0.5, by + 0.5, W - 1, bh - 1)
}
function stripLine(e) { const r = strip.getBoundingClientRect(); return Math.min(M.lines, Math.max(1, 1 + Math.floor(((e.clientY - r.top) / r.height) * M.lines))) }
let dragging = false
function nearestLoaded(ln) {
  if (isLoaded(ln)) return ln
  let best = null, bd = Infinity
  for (const [a, b] of M.present) { const d = ln < a ? a - ln : ln > b ? ln - b : 0; if (d < bd) { bd = d; best = ln < a ? a : b } }
  return best ?? ln
}
strip.addEventListener('pointerdown', (e) => { dragging = true; try { strip.setPointerCapture(e.pointerId) } catch (x) {} reveal(nearestLoaded(stripLine(e)), 'top') })
strip.addEventListener('pointermove', (e) => {
  const ln = stripLine(e)
  const nd = deepestAt(ln)
  strip.title = `Line ${fmtN(ln)}${nd ? ' · ' + pathTo(nd).slice(-2).map((x) => x.label).join(' › ') : ''}${isLoaded(ln) ? '' : ' (not loaded)'}. Sections as bands; chunk lines at the left edge, search hits at the right edge; the box is the visible range. Click or drag to go there.`
  if (dragging) reveal(nearestLoaded(ln), 'top')
})
strip.addEventListener('pointerup', () => { dragging = false; updateAll() })

// ---- search -----------------------------------------------------------------------------------------------------------------------------------
let qTimer = 0
function runSearch() {
  S.hits = []; S.hitSet = new Set(); qre = null
  if (S.q) {
    qre = new RegExp(S.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    const q = S.q.toLowerCase()
    for (let i = 1; i <= M.lines; i++) { const t = LINES[i]; if (t !== undefined && t.toLowerCase().includes(q)) S.hits.push(i) }
    S.hitSet = new Set(S.hits)
  }
  if (!S.hitSet.has(S.hitCur)) S.hitCur = 0
  rebuildKeep()
  updateAll()
}
function rebuildKeep() { /* rows do not depend on hits */ }
function stepHit(dir) {
  if (!S.hits.length) return
  const from = S.sel || S.hitCur || focusLine()
  S.hitCur = dir > 0 ? S.hits.find((l) => l > from) ?? S.hits[0] : [...S.hits].reverse().find((l) => l < from) ?? S.hits.at(-1)
  if (S.variant === 'a') S.mode = 'text'
  S.sel = S.hitCur
  const n = deepestAt(S.hitCur)
  if (n) { S.node = n.id; expandTo(n) }
  reveal(S.hitCur, 'center')
  updateAll()
}

// ---- folds -----------------------------------------------------------------------------------------------------------------------------------
function toggleFold(id) {
  const f = FOLDS.find((x) => x.id === id)
  if (!f) return
  const top = topLine()
  const closing = !foldClosed(f)
  S.foldOv.set(f.id, closing)
  if (closing) for (const g of FOLDS) if (g !== f && g.from > f.from && g.to <= f.to) S.foldOv.delete(g.id)
  rebuild(closing ? f.from : top)
  if (closing) S.sel = f.from
  if (!closing) S.sel = f.from
  updateAll()
}
function toggleAllFolds() {
  const top = topLine()
  if (FOLDS.some((f) => foldClosed(f))) for (const f of FOLDS) S.foldOv.set(f.id, false)
  else S.foldOv.clear()
  rebuild(top); updateAll()
}

// ---- events ------------------------------------------------------------------------------------------------------------------------------------
layer.addEventListener('click', (e) => {
  const rowEl = e.target.closest('.lv-row')
  if (!rowEl) return
  const r = VIEW.rows[+rowEl.dataset.r]
  const fb = e.target.closest('[data-fold]')
  if (fb) { toggleFold(fb.dataset.fold); return }
  if (r.t === 'fold') { toggleFold(r.fold.id); return }
  if (r.t === 'gap') return
  selectLine(r.ln, 'near')
  lv.focus({ preventScroll: true })
})
$('#lbody').addEventListener('click', (e) => {
  const tw = e.target.closest('[data-tw]')
  if (tw) { const id = tw.dataset.tw; if (S.exp.has(id)) S.exp.delete(id); else S.exp.add(id); renderOutline(); return }
  const nd = e.target.closest('[data-node]')
  if (nd) { const n = BYID.get(nd.dataset.node); if (n.children.length && S.node === n.id) { if (S.exp.has(n.id)) S.exp.delete(n.id); else S.exp.add(n.id) } selectNode(nd.dataset.node) }
})
$('#ol-expand').onclick = () => { for (const n of NODES) if (n.children.length && n.depth <= 3) S.exp.add(n.id); renderOutline() }
$('#ol-collapse').onclick = () => { S.exp.clear(); for (const n of NODES) if (n.depth <= 1 && n !== M.outline) S.exp.add(n.id); const sn = BYID.get(S.node); if (sn) expandTo(sn); renderOutline() }
$('#ol-ctl').addEventListener('change', (e) => { if (e.target.matches('input')) { S.hideIdle = e.target.checked; updateAll() } })
$('#crumbs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-go-node]')
  if (b) { selectNode(b.dataset.goNode); return }
  if (e.target.closest('[data-go-line]')) { S.sel = 1; if (S.variant === 'a') S.mode = 'text'; reveal(1, 'top'); updateAll() }
})
$('#states').addEventListener('click', (e) => { const b = e.target.closest('[data-state]'); if (b) setState(b.dataset.state) })
$('#m-read').onclick = () => { if (!$('#m-read').disabled) { S.mode = 'reading'; updateAll() } }
$('#m-text').onclick = () => { S.mode = 'text'; updateAll(); requestAnimationFrame(() => { reveal(S.sel || 1, 'center') }) }
$('#var-a').onclick = () => setVariant('a')
$('#var-b').onclick = () => setVariant('b')
$('#fold-all').onclick = toggleAllFolds
$('#q').addEventListener('input', (e) => { S.q = e.target.value; clearTimeout(qTimer); qTimer = setTimeout(runSearch, 120) })
$('#q').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); clearTimeout(qTimer); if (S.q !== $('#q').value) { S.q = $('#q').value; runSearch() } stepHit(e.shiftKey ? -1 : 1) }
  else if (e.key === 'Escape') { e.preventDefault(); lv.focus() }
})
$('#q-next').onclick = () => stepHit(1)
$('#q-prev').onclick = () => stepHit(-1)

function onReadingClick(e) {
  const t = e.target
  let el
  if ((el = t.closest('[data-copy]'))) { const src = $('#' + el.dataset.copy); if (src) { copyText(src.textContent); el.textContent = 'Copied'; setTimeout(() => { el.textContent = 'Copy' }, 1200) } return }
  if ((el = t.closest('[data-own-toggle]'))) { S.ownOpen = !S.ownOpen; renderReadingsOnly(); return }
  if ((el = t.closest('[data-sort]'))) {
    const tbl = t.closest('table')
    const which = tbl.classList.contains('proctbl') ? 'proc' : S.heapTab
    const st = S.sort[which]
    const col = el.dataset.sort
    if (st.col === col) st.dir = -st.dir
    else { st.col = col; st.dir = (col === 'c' || col === 't' || col === 'name' || col === 'pid' || col === 'wait') ? 1 : -1 }
    renderReadingsOnly(); return
  }
  if ((el = t.closest('[data-tab]'))) { S.heapTab = el.dataset.tab; renderReadingsOnly(); return }
  if ((el = t.closest('[data-hrow]'))) { pickChunks(el.dataset.hrow); return }
  if ((el = t.closest('[data-chunk]'))) { stepChunk(+el.dataset.chunk); return }
  if ((el = t.closest('[data-chunk-show]'))) { showChunk(); return }
  if ((el = t.closest('[data-heap]'))) { const nid = nodeOfHeap(el.dataset.heap); if (nid) selectNode(nid, { fromOutline: false }); return }
  if ((el = t.closest('[data-proc]'))) { const nid = nodeOfProc(+el.dataset.proc); if (nid) selectNode(nid); return }
  if ((el = t.closest('[data-go]'))) { goLine(+el.dataset.go); return }
}
function onReadingChange(e) {
  if (e.target.matches('[data-own]')) { S.incOwn = e.target.checked; renderReadingsOnly() }
  else if (e.target.matches('[data-hide-idle]')) { S.hideIdle = e.target.checked; updateAll() }
}
for (const el of [$('#rd-centre'), $('#rbody')]) { el.addEventListener('click', onReadingClick); el.addEventListener('change', onReadingChange) }
function renderReadingsOnly() { if (effMode() === 'reading') renderCentre(); if (S.variant === 'b') renderRight(); renderOutline(); centreTree() }
/** the heap tree scrolls to the selected heap */
function centreTree() { for (const t of $$('.tree')) { const on = $('.tn.on', t); if (on) t.scrollTop = Math.max(0, on.offsetTop - t.offsetTop - t.clientHeight / 2 + on.offsetHeight / 2) } }
function nodeOfHeap(hid) { const n = NODES.find((x) => x.heapId === hid); return n ? n.id : null }
function nodeOfProc(pid) { const n = NODES.find((x) => x.kind === 'process' && x.pid === pid); if (n) return n.id; const s = NODES.find((x) => x.r === 'proc:' + pid); return s ? s.id : null }
function pickChunks(key) {
  const rk = readingKey(BYID.get(S.node))
  const h = heapById(rk.slice(5))
  let lines = [], label = ''
  if (key.startsWith('c:')) { const c = h.byComment.find((x) => x.c === key.slice(2)); lines = c ? c.lines : []; label = key.slice(2) || '(no comment)' }
  else { const t = h.byType.find((x) => x.t === key.slice(2)); lines = t ? t.lines : []; label = key.slice(2) }
  if (S.chunk && S.chunk.heap === h.id && S.chunk.key === key) S.chunk = null
  else S.chunk = { heap: h.id, key, label, lines, set: new Set(lines), i: 0 }
  if (S.chunk && S.variant === 'b') { S.sel = S.chunk.lines[0]; reveal(S.sel, 'center') }
  updateAll()
}
function stepChunk(d) {
  const c = S.chunk; if (!c) return
  c.i = (c.i + d + c.lines.length) % c.lines.length
  S.sel = c.lines[c.i]
  if (S.variant === 'b') reveal(S.sel, 'center')
  updateAll()
}
function showChunk() { const c = S.chunk; if (!c) return; if (S.variant === 'a') S.mode = 'text'; S.sel = c.lines[c.i]; updateAll(); requestAnimationFrame(() => { reveal(S.sel, 'center'); updateAll() }) }

document.addEventListener('keydown', (e) => {
  if ((e.key === 'f' || e.key === 'F') && (e.metaKey || e.ctrlKey)) { e.preventDefault(); $('#q').focus(); $('#q').select(); return }
  if (e.target.closest('input, textarea') || e.metaKey || e.ctrlKey || e.altKey) return
  if (e.key === '/') { e.preventDefault(); $('#q').focus(); $('#q').select() }
  else if (e.key === 'F3') { e.preventDefault(); stepHit(e.shiftKey ? -1 : 1) }
  else if (e.key === 'z' && S.sel) { const fl = FOLD_BY_FROM.get(S.sel); const r = VIEW.rows[rowOf(S.sel)]; const f = r && r.t === 'fold' ? r.fold : fl && fl[0]; if (f) toggleFold(f.id) }
  else if (e.key === 'Z') toggleAllFolds()
})

// ---- theme, variant, resizer -------------------------------------------------------------------------------------------------------------------
;(function theme() {
  const root = document.documentElement, btn = $('#theme'), label = $('#theme-label')
  const modes = ['auto', 'light', 'dark']
  let mode = tryLS.get('mtk-diag-theme') || 'auto'
  const q = new URLSearchParams(location.search).get('theme')
  if (q && modes.includes(q)) mode = q
  const apply = () => { if (mode === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', mode); label.textContent = mode[0].toUpperCase() + mode.slice(1); colors = null; paintStrip() }
  btn.addEventListener('click', () => { mode = modes[(modes.indexOf(mode) + 1) % 3]; tryLS.set('mtk-diag-theme', mode); apply() })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { colors = null; paintStrip() })
  apply()
})()
function setVariant(v) {
  if (v === S.variant) return
  S.variant = v
  document.getElementById('app').dataset.variant = v
  if (v === 'a') { const rk = readingKey(BYID.get(S.node)); S.mode = rk ? 'reading' : 'text' }
  updateAll()
  requestAnimationFrame(() => { if (effMode() === 'text') reveal(S.sel || 1, 'center') })
}
;(function resizer() {
  const r = $('#resizer'), app = document.documentElement
  const saved = +tryLS.get('mtk-diag-right-b')
  if (saved) app.style.setProperty('--w-right-b', saved + 'px')
  let sx = 0, sw = 0, on = false
  r.addEventListener('pointerdown', (e) => { on = true; sx = e.clientX; sw = $('.side-r').getBoundingClientRect().width; try { r.setPointerCapture(e.pointerId) } catch (x) {} r.classList.add('drag'); e.preventDefault() })
  r.addEventListener('pointermove', (e) => { if (!on) return; const w = Math.min(window.innerWidth * 0.62, Math.max(300, sw + (sx - e.clientX))); app.style.setProperty('--w-right-b', w + 'px'); schedule(); paintStrip() })
  r.addEventListener('pointerup', () => { on = false; r.classList.remove('drag'); const w = $('.side-r').getBoundingClientRect().width; if (S.variant === 'b') tryLS.set('mtk-diag-right-b', String(Math.round(w))) })
  r.addEventListener('keydown', (e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { const w = $('.side-r').getBoundingClientRect().width + (e.key === 'ArrowLeft' ? 24 : -24); app.style.setProperty('--w-right-b', Math.max(300, w) + 'px'); schedule() } })
})()

// ---- states ------------------------------------------------------------------------------------------------------------------------------------
function defaultNode(st, params) {
  const find = (f) => NODES.find(f)
  if (params && params.get('node') && BYID.has(params.get('node'))) return BYID.get(params.get('node'))
  if (st === 'heap') { const hid = (params && params.get('heap')) || 'h1'; return find((n) => n.heapId === hid) || find((n) => n.heapId) }
  if (st === 'errorstack') return find((n) => n.kind === 'sec:callstack')
  if (st === 'process') return find((n) => n.kind === 'so:session')
  if (st === 'sysstate') return find((n) => n.kind === 'sysstate')
  if (st === 'hang') return find((n) => n.kind === 'hang')
  return NODES[1]
}
async function setState(id, params) {
  const st = STATES.find((s) => s.id === id)
  if (!st) return
  $('#loading').hidden = false
  try { await ensure(st.file) } catch (e) { $('#loading').textContent = e.message; return }
  $('#loading').hidden = true
  const reuse = M && M.key === st.file
  S.state = id
  if (!reuse) {
    M = DIAG[st.file]
    indexModel()
    S.foldOv = new Map(); S.exp = new Set(); S.hits = []; S.hitSet = new Set(); S.hitCur = 0; S.chunk = null; qre = null
    for (const n of NODES) if (n !== M.outline && n.depth <= 1) S.exp.add(n.id)
    if (S.q) { $('#q').value = ''; S.q = '' }
    buildRows()
  }
  const n = defaultNode(id, params)
  S.node = n.id
  S.sel = n.from
  expandTo(n)
  if (S.exp.size && n.children.length && id !== 'sysstate') { /* leave the node itself as it is */ }
  S.mode = readingKey(n) ? 'reading' : 'text'
  if (params && params.get('mode')) S.mode = params.get('mode') === 'text' ? 'text' : 'reading'
  S.heapTab = params && params.get('tab') ? params.get('tab') : 'comment'
  if (id === 'sysstate') S.hideIdle = !!(params && params.get('hideidle'))
  lv.scrollTop = 0
  rebuild(isLoaded(n.from) ? n.from : 1)
  updateAll()
  if (isLoaded(n.from)) reveal(n.from, 'top')
  if (params && params.get('chunk') && id === 'heap') { const rk = readingKey(n); const h = heapById(rk.slice(5)); const c = h.byComment[+params.get('chunk')]; if (c) pickChunks('c:' + c.c) }
  if (params && params.get('q')) { $('#q').value = params.get('q'); S.q = params.get('q'); runSearch() }
  updateAll()
}

;(async function boot() {
  const params = new URLSearchParams(location.search)
  const v = params.get('variant')
  if (v === 'a' || v === 'b') { S.variant = v; document.getElementById('app').dataset.variant = v }
  let id = params.get('file') || params.get('state') || 'errorstack'
  if (!STATES.some((s) => s.id === id)) id = 'errorstack'
  await setState(id, params)
  window.__app = { S, STATES, setState, setVariant, selectNode, selectLine, goLine, runSearch, toggleAllFolds, get M() { return M }, get NODES() { return NODES }, rebuild, reveal, updateAll, VIEW: () => VIEW, pickChunks, stepChunk, showChunk }
  document.body.dataset.ready = '1'
})()
