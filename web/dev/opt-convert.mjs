// Converts the mock-up's model (docs/mockups/10053-reader/data/model.json, made by its throwaway parser) into the shape of the Go contract
// (internal/opt/model.go; web/src/lib/data/opt.ts): a file summary with `dumps: DumpInfo[]`, and one Dump per dump. For the dev harness only:
// once the Go scanner exists the fixture is generated from it instead (the engine's JSON of testdata/opt/19c/opt_two.trc) and this script goes.
//
//   node web/dev/opt-convert.mjs            # writes web/dev/opt-two.model.json (read with docs/mockups/10053-reader/data/two.trc)
//
// What the mock-up's model does not hold is derived here from the trace text: the hints, the peeked binds, the altered parameters, the lines that
// print a bind value, the lines outside any known section and a plausible digest (headings, landmarks, the statement, the SQL versions, the plan,
// the hints and the binds).
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..', '..')
const mock = JSON.parse(readFileSync(join(root, 'docs/mockups/10053-reader/data/model.json'), 'utf8'))
// the mock-up's own trace: testdata/opt/19c/opt_two.trc is a later lab run of the same scenario (another sql_id, 27,963 lines), so its lines do not match this model
const text = readFileSync(join(root, 'docs/mockups/10053-reader/data/two.trc'), 'utf8')
const L = text.split('\n')
if (L.at(-1) === '') L.pop()
const ln = (i) => L[i - 1] ?? ''

const file = {
  name: mock.file.name,
  lines: L.length,
  release: mock.file.release,
  version: mock.file.version,
  tested: /^19\./.test(mock.file.version),
  records10046: 0,
  dumps: [],
}

/** The nodes of the tree with the contract's names: sameAs as a number (0 none), isBest on a join order. */
function node(n) {
  const o = { ...n }
  delete o.aborted
  if (o.kind === 'join-order') { o.isBest = o.best === true; delete o.best }
  if (o.kind === 'run') o.sameAs = o.sameAs ?? 0
  if (o.iter === null) delete o.iter
  if (o.children) o.children = o.children.map(node)
  else delete o.children
  return o
}

function chain(tree, line) {
  const out = [tree]
  let n = tree
  for (;;) {
    const c = (n.children ?? []).find((c) => c.from <= line && line <= c.to)
    if (!c) break
    out.push(c)
    n = c
  }
  return out
}

function mergeRanges(rs) {
  const s = rs.filter((r) => r.to >= r.from).sort((a, b) => a.from - b.from || a.to - b.to)
  const out = []
  for (const r of s) {
    const last = out.at(-1)
    if (last && r.from <= last.to + 1) last.to = Math.max(last.to, r.to)
    else out.push({ ...r })
  }
  return out
}

const seen = new Map()
const dumps = mock.dumps.map((d) => {
  const nth = (seen.get(d.sqlId) ?? 0) + 1
  seen.set(d.sqlId, nth)
  const inDump = (l) => l >= d.viewFrom && l <= d.viewTo
  const plan0 = mock.plans[d.plan]
  const plan = plan0 ? { from: plan0.from, head: plan0.head, tableTo: plan0.tableTo, to: plan0.to, cols: plan0.cols, rows: plan0.rows, qbs: plan0.qbs, preds: plan0.preds } : undefined

  // hints: "Dumping Hints" atom_hint lines and the Hint Report
  const hints = []
  for (let i = d.from; i <= d.end; i++) {
    const s = ln(i)
    let m
    if ((m = /^\s*atom_hint=\(.* err=(\d+) .* used=(\d+) .* txt=(.*?)\s*\)\s*$/.exec(s))) hints.push({ line: i, text: m[3], err: +m[1], used: +m[2], src: 'dump' })
    else if ((m = /^\s+Unused: (.*)$/.exec(s))) {
      const reason = /^\s+reason: (.*)$/.exec(ln(i + 1))
      hints.push({ line: i, text: m[1], err: 0, used: 0, note: 'Unused' + (reason ? ': ' + reason[1] : ''), src: 'report' })
    }
  }
  // peeked binds: "Peeked Binds" of the other_xml section
  const binds = []
  const pb = (() => { for (let i = d.from; i <= d.end; i++) if (ln(i) === 'Peeked Binds') return i; return 0 })()
  if (pb) {
    let cur = null
    for (let i = pb + 2; i <= d.end; i++) {
      const s = ln(i)
      let m
      if (/^\S/.test(s)) break
      if ((m = /^\s+position=(\d+)/.exec(s))) { cur = { pos: +m[1], type: '', value: '', line: 0 }; binds.push(cur) }
      else if (cur && (m = /^\s+dup_position=(\d+)/.exec(s))) cur.dup = +m[1]
      else if (cur && (m = /^\s+datatype\(string\)=(.*)$/.exec(s))) cur.type = m[1]
      else if (cur && (m = /^\s+value=(.*)$/.exec(s))) { cur.value = m[1]; cur.line = i }
    }
  }
  // the lines that print a bind value: under Bind Info and Peeked Binds
  const bindLines = []
  for (let i = d.from; i <= d.end; i++) {
    if (/^\s+value=/.test(ln(i)) && (chain(d.tree, i).some((n) => n.kind === 'peeked-binds' || n.kind === 'peeked'))) bindLines.push(i)
  }
  // altered parameters: "name = value" lines after PARAMETERS WITH ALTERED VALUES (before the next banner)
  const altered = []
  for (let i = d.from; i <= d.end; i++) {
    if (!/^\s+PARAMETERS WITH ALTERED VALUES/.test(ln(i))) continue
    for (let j = i + 2; j <= d.end && !/^\s+\*{5,}/.test(ln(j)); j++) {
      const m = /^([_a-z][\w#$]*)\s+=\s+(.*)$/.exec(ln(j)) ?? /^\s+fix (\d+)\s+=\s+(.*)$/.exec(ln(j))
      if (m) altered.push({ name: m[1], value: m[2].trim(), line: j, from: 'altered' })
    }
    break
  }
  // unplaced: lines of from..end that sit directly under a phase or the dump node
  let unplaced = 0
  for (let i = d.from; i <= d.end; i++) {
    const deepest = chain(d.tree, i).at(-1)
    if (deepest.kind === 'dump' || deepest.kind.startsWith('phase-')) unplaced++
  }
  // the digest
  const keep = []
  const banners = mock.banners.filter((b) => inDump(b.top) && inDump(b.bottom)).map(({ top, title, bottom, text }) => ({ top, title, bottom, text }))
  for (const b of banners) keep.push({ from: b.top, to: b.bottom })
  for (const l of mock.landmarks) if (l.dump === d.idx) keep.push({ from: l.line, to: l.line })
  keep.push({ from: d.stmtLine - 1, to: d.stmtTo })
  for (const v of mock.sql) if (v.dump === d.idx) keep.push({ from: v.head, to: v.line })
  if (plan) keep.push({ from: plan.from, to: plan.to })
  for (const h of hints) keep.push({ from: h.line, to: h.line })
  for (const b of binds) keep.push({ from: b.line - 6, to: b.line })
  for (const a of altered) keep.push({ from: a.line, to: a.line })
  const digest = mergeRanges(keep.map((r) => ({ from: Math.max(d.viewFrom, r.from), to: Math.min(d.viewTo, r.to) })))

  const info = {
    idx: d.idx, from: d.from, end: d.end, viewFrom: d.viewFrom, viewTo: d.viewTo, lineCount: d.viewTo - d.viewFrom + 1,
    sqlId: d.sqlId, nth, stmtText: d.stmtText, sqlStart: d.sqlStart.slice(0, 240), tables: d.tables, planHash: d.planHash ?? '', runCount: d.runCount, unplaced,
  }
  file.dumps.push(info)
  const roles = {}
  for (const [k, v] of Object.entries(mock.roles)) if (inDump(+k)) roles[k] = v
  return {
    ...info,
    stmtLine: d.stmtLine,
    stmtTo: d.stmtTo,
    tree: node(d.tree),
    landmarks: mock.landmarks.filter((l) => l.dump === d.idx).map(({ dump, ...l }) => l),
    folds: mock.folds.filter((f) => f.dump === d.idx).map(({ dump, ...f }) => f),
    runs: mock.runs.filter((r) => r.dump === d.idx).map(({ dump, ...r }) => ({ ...r, sameAs: r.sameAs ?? 0, iter: r.iter ?? '' })),
    // `prev` is the line of the nearest earlier statement whose text differs (the contract); the mock-up's was simply the one before
    sql: mock.sql.filter((v) => v.dump === d.idx).map(({ dump, ...v }, i, all) => ({ ...v, sameAs: v.sameAs ?? 0, prev: all.slice(0, i).reverse().find((u) => u.text !== v.text)?.line ?? 0 })),
    ...(plan ? { plan } : {}),
    // the mock-up's legend is one list for the file, from the first dump's OPTIMIZER INFORMATION; every dump prints it, so each dump gets it
    legend: mock.legend.filter((t) => t.line >= mock.dumps[0].from && t.line <= mock.dumps[0].end),
    banners,
    roles,
    hints,
    binds,
    altered,
    bindLines,
    digest,
  }
})

writeFileSync(join(here, 'opt-two.model.json'), JSON.stringify({ file, dumps }))
console.log(`wrote web/dev/opt-two.model.json: ${dumps.length} dumps, ${dumps.map((d) => `${d.sqlId} ${d.hints.length} hints ${d.binds.length} binds ${d.digest.length} digest ranges`).join('; ')}`)
