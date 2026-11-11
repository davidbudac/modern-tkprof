// ---- the data: the trace text (split into lines) and the model the build made from it (tools/parse.mjs) --------------------------------
const M = DATA.model
const LINES = DATA.text.split('\n')
const line = (i) => LINES[i - 1] ?? ''
const ROLES = M.roles
const BANNER = new Map(M.banners.map((b) => [b.title, b]))
const GLOSS = buildGlossary(M)
const SEP_RE = /^\s*[*=-]{3,}\s*$/
const fmtN = (n) => n.toLocaleString('en-US')
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

// the landmark kinds: what is on by default is the proposal (see the README)
const LM_KINDS = [
  { k: 'verdict', label: 'Updated / Not update best state, Will not …', short: 'Verdicts', tone: 'mixed', on: true },
  { k: 'final-cost', label: 'Final cost for query block', short: 'Final cost', tone: 'kept', on: true },
  { k: 'best-ap', label: 'Best:: AccessPath', short: 'Best access path', tone: 'kept', on: true },
  { k: 'hint-error', label: 'Hint with an error', short: 'Hint errors', tone: 'problem', on: true },
  { k: 'best-jm', label: 'Best:: JoinMethod', short: 'Best join method', tone: 'kept', on: true },
  { k: 'aborted', label: 'Join order aborted', short: 'Aborted join orders', tone: 'rejected', on: true },
  { k: 'refused', label: 'Bypassed or refused transformation', short: 'Refusals', tone: 'rejected', on: false },
]

const KIND_NAME = {
  'dump': 'Dump', 'file-header': 'File header', 'phase-env': 'Phase', 'phase-trans': 'Phase', 'phase-cost': 'Phase', 'phase-result': 'Phase',
  'parser-qbs': 'Section', 'preamble': 'Section', 'opt-info': 'Section', 'statement': 'Section', 'legend': 'Section', 'params': 'Section',
  'params-altered': 'Section', 'params-default': 'Section', 'params-optparam': 'Section', 'col-usage': 'Section', 'qt': 'Query transformations',
  'tsec': 'Banner section', 'registered': 'Query block', 'peeked-binds': 'Section', 'spd': 'Section', 'cbqt': 'Cost-based transformations',
  'cbsec': 'Cost-based transformation', 'iteration': 'Iteration', 'run': 'Costing run', 'run-head': 'Run header', 'base-stats': 'Base statistics',
  'table': 'Single table access path', 'join-search': 'Join order search', 'join-order': 'Join order', 'join-step': 'Join step',
  'final-cost': 'Final cost', 'ap-search': 'Adaptive plan', 'final-query': 'Final query', 'stmt-dump': 'Statement dump', 'plan': 'Explain plan',
  'plan-table': 'Plan table', 'plan-qbs': 'Plan', 'plan-preds': 'Plan', 'other-xml': 'other_xml', 'peeked': 'Peeked binds', 'opt-metrics': 'other_xml',
  'qbreg-xml': 'other_xml', 'outline-data': 'Outline data', 'hint-report': 'Hint report', 'state-dump': 'Optimizer state dump', 'state-params': 'Optimizer state dump',
  'state-fix': 'Optimizer state dump', 'qb-registry': 'Query block registry', 'hints': 'Hints', 'after': 'After the dump',
}

for (const d of M.dumps) {
  d.nodes = []
  const walk = (n, depth, parent) => { n.depth = depth; n.parent = parent; d.nodes.push(n); n.children.forEach((c) => walk(c, depth + 1, n)) }
  walk(d.tree, 0, null)
  d.byId = new Map(d.nodes.map((n) => [n.id, n]))
  d.startAt = new Map()
  for (const n of d.nodes) if (!d.startAt.has(n.from)) d.startAt.set(n.from, n)
  d.folds = M.folds.filter((f) => f.dump === d.idx)
  d.foldAt = new Map(d.folds.map((f) => [f.from, f]))
  d.lms = M.landmarks.filter((l) => l.dump === d.idx)
  d.lmAt = new Map(d.lms.map((l) => [l.line, l]))
  d.sql = M.sql.filter((v) => v.dump === d.idx)
  d.sqlAt = new Map(d.sql.map((v) => [v.line, v]))
  d.sqlHeadAt = new Map(d.sql.map((v) => [v.head, v]))
  d.runs = M.runs.filter((r) => r.dump === d.idx)
  d.runAt = new Map(d.runs.map((r) => [r.id, r]))
  d.planObj = d.plan != null ? M.plans[d.plan] : null
  d.n = d.viewTo - d.viewFrom + 1
  d.maxLen = 0
  for (let i = d.viewFrom; i <= d.viewTo; i++) d.maxLen = Math.max(d.maxLen, line(i).length)
  // lines of statement text (SQL colouring): the statement as typed and its repeats
  d.sqlText = new Set()
  for (let i = d.stmtLine; i <= d.stmtTo; i++) d.sqlText.add(i)
  for (const f of d.folds) if (f.kind === 'stmt-again') for (let i = f.from; i <= f.to; i++) d.sqlText.add(i)
  d.phaseNodes = d.tree.children.filter((n) => n.kind.startsWith('phase-'))
}

/** The chain of outline nodes holding a line, root first. */
function pathOf(d, ln) {
  const out = [d.tree]
  let n = d.tree
  for (;;) {
    const c = n.children.find((c) => c.from <= ln && ln <= c.to)
    if (!c) break
    out.push(c); n = c
  }
  return out
}

/** The innermost fold holding a line (or null). */
function foldOf(d, ln) {
  let best = null
  for (const f of d.folds) if (f.from <= ln && ln <= f.to && (!best || f.from >= best.from)) best = f
  return best
}

function guideLine(s) { return GUIDE_LINES.find((g) => g.re.test(s)) || null }
