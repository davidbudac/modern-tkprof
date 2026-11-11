// The mock-up's 10053 reader: a throwaway parser that turns the trace text into the model the page shows (dumps, outline, landmarks,
// folds, costing runs, SQL versions, plan, legend). Rules come from docs/trace-format-10053.md; nothing here reads the costs.
//   import { parse } from './tools/parse.mjs'

const SEP = /^\s*[*=-]{3,}\s*$/
const UNDER = /^\s*[=-]{3,}\s*$/

export function parse(text, fileName) {
  const L = text.split('\n')
  if (L.at(-1) === '') L.pop()
  const N = L.length
  const ln = (i) => L[i - 1] ?? ''

  // ---- the file prologue ----
  const file = { name: fileName, lines: N, version: '', release: '', path: '' }
  for (let i = 1; i <= Math.min(40, N); i++) {
    const s = ln(i)
    let m
    if ((m = /^Trace file (.+)$/.exec(s))) file.path = m[1]
    if ((m = /^Version (\d+(?:\.\d+)+)/.exec(s)) && !file.version) file.version = m[1]
    if (/^Oracle Database .*Release/.test(s)) file.release = s.trim()
  }

  // ---- banners: a separator line, a title, a separator line (greedy from the top); and title + underline pairs ----
  const role = new Array(N + 2).fill('')
  const banner = new Map() // title line -> { top, title, bottom, text, under }
  for (let i = 2; i < N; i++) {
    if (role[i - 1] || role[i] || !SEP.test(ln(i - 1)) || !SEP.test(ln(i + 1)) || SEP.test(ln(i)) || !ln(i).trim()) continue
    role[i - 1] = 'bt'; role[i] = 'bh'; role[i + 1] = 'bb'
    banner.set(i, { top: i - 1, title: i, bottom: i + 1, text: ln(i).trim() })
  }
  for (let i = 1; i < N; i++) {
    if (role[i] || role[i + 1] || SEP.test(ln(i)) || !ln(i).trim() || !UNDER.test(ln(i + 1))) continue
    if (i > 1 && SEP.test(ln(i - 1)) && !role[i - 1]) continue
    if (Math.abs(ln(i + 1).trim().length - ln(i).trim().length) > 3) continue
    role[i] = 'uh'; role[i + 1] = 'ul'
    banner.set(i, { top: i, title: i, bottom: i + 1, text: ln(i).trim(), under: true })
  }

  // ---- dumps: from a `Registered qb: … (PARSER)` line outside a dump to `END SQL Statement Dump` ----
  const dumps = []
  {
    let cur = null
    for (let i = 1; i <= N; i++) {
      const s = ln(i)
      if (!cur && /^Registered qb: \S+ 0x[0-9a-f]+ \(PARSER\)/.test(s)) { cur = { from: i }; dumps.push(cur) }
      else if (cur && /END SQL Statement Dump/.test(s)) { cur.end = i; cur = null }
    }
    if (cur) cur.end = N
    dumps.forEach((d, k) => {
      d.idx = k
      d.viewFrom = k === 0 ? 1 : d.from
      d.viewTo = k + 1 < dumps.length ? dumps[k + 1].from - 1 : N
    })
  }

  const landmarks = []
  const folds = []
  const runs = []
  const sql = []
  const plans = []
  const legend = []
  let nodeSeq = 0

  for (const d of dumps) parseDump(d)

  function find(re, from, to) { for (let i = from; i <= to; i++) if (re.test(ln(i))) return i; return 0 }
  function trimRange(a, b) { while (a <= b && !ln(a).trim()) a++; while (b >= a && !ln(b).trim()) b--; return [a, b] }

  function parseDump(d) {
    const a = d.from, e = d.end
    // facts
    const cs = find(/^----- Current SQL Statement for this session \(sql_id=/, a, e)
    d.sqlId = cs ? /sql_id=(\w+)/.exec(ln(cs))[1] : '?'
    d.stmtLine = cs + 1
    let ps = cs ? find(/^----- Parser State -----/, cs, e) : 0
    d.stmtText = cs && ps ? L.slice(cs, ps - 1).join('\n') : ''
    d.stmtTo = ps ? ps - 1 : cs
    d.sqlStart = d.stmtText.replace(/\s+/g, ' ').trim()
    const ob = find(/^Objects referenced in the statement/, a, e)
    const tabs = []
    if (ob) for (let i = ob + 1; i <= e; i++) { const m = /^\s+(\w+)\[[^\]]*\] \d+, type/.exec(ln(i)); if (!m) break; if (!tabs.includes(m[1])) tabs.push(m[1]) }
    d.tables = tabs
    const ph = find(/^\s*plan_hash\s*:\s*\d+/, a, e)
    d.planHash = ph ? /:\s*(\d+)/.exec(ln(ph))[1] : ''
    d.planHashLine = ph
    d.lineCount = d.viewTo - d.viewFrom + 1

    // phases
    const tStart = find(/^Considering Query Transformations on query block/, a, e)
    const fq = find(/^Final query after transformations/, a, e)
    const rs = find(/^Starting SQL statement dump/, a, e)
    d.phases = { tStart, fq, rs }

    // ---- the outline: a stack of open nodes; opening a node at level L closes the open nodes of level L or more ----
    const root = mk('dump', d.sqlId, d.sqlId, d.viewFrom, 0)
    root.to = d.viewTo
    const stack = [root]
    const top = () => stack.at(-1)
    function mk(kind, label, crumb, from, lvl, extra) { return { id: 'n' + (nodeSeq++), kind, label, crumb, from, to: from, lvl, children: [], ...extra } }
    function popTo(to) { const n = stack.pop(); n.to = Math.max(n.from, to); return n }
    function open(kind, label, crumb, from, lvl, extra) {
      while (stack.length > 1 && top().lvl >= lvl) popTo(from - 1)
      const n = mk(kind, label, crumb, from, lvl, extra)
      top().children.push(n); stack.push(n); return n
    }
    const has = (kind) => stack.some((n) => n.kind === kind)
    const innermost = (kind) => { for (let k = stack.length - 1; k >= 0; k--) if (stack[k].kind === kind) return stack[k]; return null }
    function closeThrough(node, at) { while (stack.length > 1) { const n = top(); popTo(n === node ? at : at - 1); if (n === node) break } }

    if (d.idx === 0 && a > 1) { const h = open('file-header', 'File header', 'File header', 1, 1); h.to = a - 1; stack.pop() }

    const phaseAt = (i) => i === a ? ['phase-env', 'Environment'] : i === tStart ? ['phase-trans', 'Transformations'] : i === fq ? ['phase-cost', 'Costing'] : i === rs ? ['phase-result', 'Result'] : null
    let preamble = false
    const runList = []
    let lastSec = null

    for (let i = a; i <= e; i++) {
      const s = ln(i)
      const b = banner.get(i)
      const from = b ? b.top : i
      const ph = phaseAt(i)
      if (ph) { open(ph[0], ph[1], ph[1], i, 1); lastSec = null }
      const phase = stack[1]?.kind
      let m

      if (phase === 'phase-env') {
        if (i === a) open('parser-qbs', 'Query blocks from the parser', 'Parser query blocks', i, 2)
        else if (!preamble && /^(SPM:|kkoctx\(\))/.test(s)) { preamble = true; open('preamble', 'Preamble', 'Preamble', i, 2) }
        else if (/^OPTIMIZER INFORMATION\s*$/.test(s)) open('opt-info', 'Optimizer information', 'Optimizer information', i, 2)
        else if (/^----- Current SQL Statement for this session/.test(s)) open('statement', 'Current SQL statement', 'Statement', i, 3)
        else if (/^Legend\s*$/.test(s)) open('legend', 'Legend', 'Legend', i, 3)
        else if (b && /^PARAMETERS USED BY THE OPTIMIZER/.test(b.text)) open('params', 'Parameters used by the optimizer', 'Parameters', from, 3)
        else if (b && /^Column Usage Monitoring/.test(b.text)) open('col-usage', 'Column usage monitoring', 'Column usage', from, 3)
        else if (b && /^PARAMETERS WITH ALTERED VALUES/.test(b.text)) open('params-altered', 'Altered values', 'Altered values', from, 4)
        else if (b && /^PARAMETERS WITH DEFAULT VALUES/.test(b.text)) open('params-default', 'Default values', 'Default values', from, 4, { bannerBottom: b.bottom })
        else if (b && /^PARAMETERS IN OPT_PARAM HINT/.test(b.text)) open('params-optparam', 'OPT_PARAM hint', 'OPT_PARAM hint', from, 4)
      } else if (phase === 'phase-trans' || phase === 'phase-cost') {
        const inIter = has('iteration'), inRun = has('run')
        if ((m = /^Considering Query Transformations on query block (\S+)/.exec(s))) {
          if (!inIter && !inRun) { const lvl = has('cbqt') ? 3 : 2; open('qt', `Query transformations · ${m[1]}`, `QT ${m[1]}`, i, lvl); lastSec = null }
        } else if ((m = /^CBQT: Considering cost-based transformation on query block (\S+)/.exec(s))) {
          open('cbqt', `Cost-based transformations · ${m[1]}`, `CBQT ${m[1]}`, i, 2); lastSec = null
        } else if (b && /^Peeked values of the binds/.test(b.text) && !inRun) {
          open('peeked-binds', 'Peeked values of the binds', 'Peeked binds', from, 2); lastSec = null
        } else if (b && /^SPD: BEGIN context at statement level/.test(b.text) && !inRun) {
          open('spd', 'SQL plan directives', 'SPD', from, 2); lastSec = null
        } else if ((m = /^(\w+): Starting iteration (\d+), state space = (.*)$/.exec(s))) {
          while (stack.length > 1 && (top().lvl >= 5 || top().kind === 'tsec' || top().kind === 'registered')) popTo(i - 1)
          if (top().kind === 'iteration' && top().prefix === m[1]) popTo(i - 1)
          const it = mk('iteration', `${m[1]} iteration ${m[2]} · ${m[3]}`, `${m[1]} iteration ${m[2]}`, i, 4, { prefix: m[1], n: +m[2], space: m[3], runs: [] })
          top().children.push(it); stack.push(it)
        } else if ((m = /^(\w+): (Updated best state|Not update best state), Cost = (\S+)/.exec(s))) {
          const it = [...stack].reverse().find((n) => n.kind === 'iteration' && n.prefix === m[1])
          if (it) { it.verdict = { text: s.trim(), line: i, kept: m[2] === 'Updated best state' }; closeThrough(it, i) }
        } else if ((m = /^kkoqbc: optimizing query block (\S+) \(#(\d+)\)/.exec(s))) {
          const iter = innermost('iteration')
          const r = open('run', '', '', i, 5, { qb: m[1], qbn: m[2], iter: iter ? iter.id : null, final: phase === 'phase-cost' })
          if (iter) iter.runs.push(r.id)
          runList.push(r)
        } else if (/^kkoqbc: finish optimizing query block/.test(s)) {
          const r = innermost('run'); if (r) closeThrough(r, i)
        } else if (/^Final query after transformations/.test(s)) {
          open('final-query', 'Final query after transformations', 'Final query', i, 5)
        } else if (inRun) {
          const run = innermost('run')
          if (b && b.text === 'QUERY BLOCK TEXT') open('run-head', 'Query block text, signature, system statistics', 'Header', from, 6)
          else if (b && b.text === 'BASE STATISTICAL INFORMATION') open('base-stats', 'Base statistical information', 'Base statistics', from, 6)
          else if ((m = /^Access path analysis for (\S+)/.exec(s)) && L.slice(i, i + 3).some((x) => /^SINGLE TABLE ACCESS PATH/.test(x))) {
            const est = L.slice(i, i + 5).map((x) => /Single Table Cardinality Estimation for (\S+)/.exec(x)).find(Boolean)
            const name = est ? est[1] : m[1]
            open('table', name, name, i, 6, { table: m[1] })
          } else if (/^OPTIMIZER STATISTICS AND COMPUTATIONS\s*$/.test(s)) open('join-search', 'Join order search', 'Join orders', i, 6)
          else if ((m = /^Searching for inflection point \(join #(\d+)\)/.exec(s))) open('ap-search', `Adaptive plan: inflection point, join #${m[1]}`, `AP join #${m[1]}`, i, 6)
          else if (/^Final cost for query block/.test(s)) open('final-cost', 'Final cost', 'Final cost', i, 6)
          else if ((m = /^Join order\[(\d+)\]:\s+(.*?)\s*$/.exec(s)) && has('join-search')) open('join-order', `Join order[${m[1]}]`, `Join order ${m[1]}`, i, 7, { n: +m[1], tables: m[2].split(/\s+/) })
          else if (/^\(newjo-stop/.test(s)) { while (stack.length > 1 && top().lvl >= 7) popTo(i - 1) }
          else if (b && (m = /^Now joining: (\S+)/.exec(b.text))) open('join-step', `Now joining: ${m[1]}`, `Now joining ${m[1].replace(/#\d+$/, '')}`, from, 8, { table: m[1] })
          // facts the trace states about the open node
          const t = top()
          if ((m = /^\s*Best:: AccessPath: (\S+)/.exec(s)) && t.kind === 'table') t.best = m[1]
          if ((m = /^Best:: JoinMethod: (\S+)/.exec(s)) && t.kind === 'join-step') t.method = m[1]
          const jo = innermost('join-order')
          if (jo && /^Join order aborted/.test(s)) jo.aborted = s.trim()
          if (jo && (m = /^(?:Best so far:)?\s+Table#:\s*\d+\s+cost:\s*(\S+)/.exec(s))) jo.cost = m[1]
          if ((m = /^\s*Best join order: (\d+)/.exec(s))) run.bestJo = +m[1]
          if (/^\s*AP: Found point of inflection/.test(s) && t.kind === 'ap-search') popTo(i - 1)
        } else if (b && !inIter && stack.length > 2 && /^(Cost-based|Cost-Based|Statistic-based)/.test(b.text)) {
          // a cost-based transformation's section: its iterations are its children (consecutive ones of one title are one node)
          const prev = stack.find((n) => n.kind === 'cbsec')
          if (prev && prev.title === b.text && stack.indexOf(prev) >= stack.length - 2 && !prev.children.some((c) => c.kind === 'iteration')) { prev.count++; prev.label = `${b.text} ×${prev.count}` }
          else { open('cbsec', b.text, b.text.replace(/^Cost-based |^Cost-Based /, '').replace(/\s*\(.*\)\s*$/, '').trim(), from, 3, { title: b.text, count: 1 }) }
          lastSec = null
        } else if (!inIter && stack.length > 2 && (m = /^Registered qb: (\S+) 0x\w+ \((.*)\)\s*$/.exec(s))) {
          const lvl = has('cbsec') ? 4 : 3
          open('registered', `Registered qb: ${m[1]} (${m[2]})`, `Registered ${m[1]}`, i, lvl, { qb: m[1] }); lastSec = null
        } else if (b && !inIter && stack.length > 2 && !/^(Query transformations \(QT\)|COST-BASED QUERY TRANSFORMATIONS|SPD: |QUERY BLOCK SIGNATURE)/.test(b.text)) {
          // a banner section between the steps above (CSE, OBYE, JE, CNT …); consecutive ones of one title are one node
          const lvl = has('cbsec') ? 4 : stack.find((n, k) => k > 1 && ['qt', 'cbqt', 'peeked-binds', 'spd'].includes(n.kind)) ? 3 : 2
          if (lastSec && top() === lastSec && lastSec.title === b.text) { lastSec.count++; lastSec.label = `${b.text} ×${lastSec.count}` }
          else { lastSec = open('tsec', b.text, b.text.replace(/\s*\(.*\)\s*$/, '').trim() || b.text, from, lvl, { title: b.text, count: 1 }) }
        }
      } else if (phase === 'phase-result') {
        if (/^Starting SQL statement dump/.test(s)) open('stmt-dump', 'Statement dump', 'Statement dump', i, 2)
        else if (/^----- Explain Plan Dump -----/.test(s)) open('plan', 'Explain plan', 'Plan', i, 2)
        else if (b && b.text === 'Plan Table' && !b.under) open('plan-table', 'Plan table', 'Plan table', from, 3)
        else if (/^Query Block Name \/ Object Alias/.test(s)) open('plan-qbs', 'Query block name / object alias', 'Query blocks', i, 3)
        else if (/^Predicate Information:/.test(s)) open('plan-preds', 'Predicate information', 'Predicates', i, 3)
        else if (/^Content of other_xml column/.test(s)) open('other-xml', 'Content of other_xml column', 'other_xml', i, 2)
        else if (/^Peeked Binds\s*$/.test(s)) open('peeked', 'Peeked binds', 'Peeked binds', i, 3)
        else if (/^\s*adaptive_plan\s*:/.test(s) && top().kind === 'peeked') popTo(i - 1)
        else if (b && b.text === 'Optimizer Metrics') open('opt-metrics', 'Optimizer metrics', 'Metrics', from, 3)
        else if (b && b.text === 'QUERY BLOCK REGISTRY') open('qbreg-xml', 'Query block registry (XML)', 'QB registry', from, 3)
        else if (/^\s*Outline Data:/.test(s)) open('outline-data', 'Outline data', 'Outline data', i, 3)
        else if (/^\s*Hint Report:/.test(s)) open('hint-report', 'Hint report', 'Hint report', i, 3)
        else if (/^Optimizer state dump:/.test(s)) open('state-dump', 'Optimizer state dump', 'State dump', i, 2)
        else if (/^Compilation Environment Dump/.test(s) && has('state-dump')) open('state-params', 'Parameters', 'Parameters', i, 3)
        else if (/^Bug Fix Control Environment/.test(s) && has('state-dump')) open('state-fix', 'Fix controls', 'Fix controls', i, 3)
        else if (/^Query Block Registry:/.test(s)) open('qb-registry', 'Query block registry', 'QB registry', i, 2)
        else if (/^Dumping Hints\s*$/.test(s)) open('hints', 'Dumping hints', 'Hints', i, 2)
      }
    }
    while (stack.length > 1) popTo(e)
    if (e < d.viewTo) { const n = open('after', 'After the dump', 'After the dump', e + 1, 1); n.to = d.viewTo; stack.pop() }

    // run labels, verdicts, identical text (addresses and memory figures replaced)
    const byId = new Map()
    walk(root, (n) => byId.set(n.id, n))
    const seen = new Map()
    runList.forEach((r, k) => {
      r.n = k + 1; r.of = runList.length
      r.label = `Run ${r.n} of ${r.of} · ${r.qb} (#${r.qbn})`
      r.crumb = `${r.qb} run ${r.n} of ${r.of}`
      const it = r.iter ? byId.get(r.iter) : null
      if (it?.verdict) r.verdict = it.verdict
      if (it) r.iterLabel = `${it.prefix} iteration ${it.n}`
      const norm = L.slice(r.from - 1, r.to).join('\n')
        .replace(/0x[0-9a-fA-F]+/g, '0x…').replace(/\b(addr|in-use|alloc)=\w+/g, '$1=…')
      if (seen.has(norm)) r.sameAs = seen.get(norm)
      else seen.set(norm, r.n)
      runs.push({ dump: d.idx, id: r.id, n: r.n, of: r.of, qb: r.qb, qbn: r.qbn, from: r.from, to: r.to, verdict: r.verdict || null, iter: r.iterLabel || null, final: r.final, sameAs: r.sameAs || null, bestJo: r.bestJo || null })
      if (r.sameAs) folds.push({ dump: d.idx, from: r.from, to: r.to, kind: 'same-run', label: `same as run ${r.sameAs}`, closed: true })
    })
    walk(root, (n) => {
      if (n.kind === 'join-order') {
        const run = [...runList].find((r) => r.from <= n.from && n.to <= r.to)
        n.best = run && run.bestJo === n.n
        n.label = `Join order[${n.n}]:  ${n.tables.join('  ')}`
        n.result = n.aborted ? 'aborted' : n.cost ? `cost: ${n.cost}` : ''
      }
      if (n.kind === 'join-step' && n.method) n.result = n.method
      if (n.kind === 'table' && n.best) n.result = n.best
    })
    d.tree = root
    d.runCount = runList.length

    // ---- the legend (the trace's own abbreviation list) ----
    const lg = find(/^Legend\s*$/, a, e)
    if (lg && d.idx === 0) {
      let last = null
      for (let i = lg + 2; i <= e; i++) {
        const s = ln(i)
        if (SEP.test(s)) break
        let m
        if ((m = /^(\S+) - (.+?)\s*$/.exec(s))) { last = { term: m[1], text: m[2], line: i, codes: [] }; legend.push(last) }
        else if ((m = /^\s+(\d+): (.+?)\s*$/.exec(s)) && last) last.codes.push([m[1], m[2]])
      }
    }

    // ---- landmarks ----
    for (let i = d.viewFrom; i <= d.viewTo; i++) {
      const s = ln(i)
      let k = null, tone = null
      if (/^\s*Best:: AccessPath:/.test(s)) { k = 'best-ap'; tone = 'kept' }
      else if (/^\s*Best:: JoinMethod:/.test(s)) { k = 'best-jm'; tone = 'kept' }
      else if (/^Final cost for query block/.test(s)) { k = 'final-cost'; tone = 'kept' }
      else if (/^Join order aborted/.test(s)) { k = 'aborted'; tone = 'rejected' }
      else if (/^\w+: Updated best state/.test(s)) { k = 'verdict'; tone = 'kept' }
      else if (/^\w+: Not update best state/.test(s) || /^\w+: Will not (use|merge)\b/.test(s)) { k = 'verdict'; tone = 'rejected' }
      else if (/^\s*atom_hint=.*\berr=[1-9]/.test(s) || /WARNING: SOME HINTS HAVE ERRORS/.test(s) || /^\s*Syntax Error:/.test(s)) { k = 'hint-error'; tone = 'problem' }
      else if (/\bbypassed\b/i.test(s) || /not valid since/.test(s) || /\bCannot\b/.test(s) || /invalid because/.test(s) || /validity checks failed/.test(s) || /\bnot performed\b/.test(s)) { k = 'refused'; tone = 'rejected' }
      if (k) landmarks.push({ dump: d.idx, line: i, kind: k, tone, text: s.trim() })
    }

    // ---- SQL versions: the line after each `UNPARSED QUERY IS` ----
    const vers = []
    for (let i = a; i <= e; i++) {
      const s = ln(i)
      const m = /^(.*?)\*{3,} UNPARSED QUERY IS \*{3,}\s*$/.exec(s)
      if (!m || !ln(i + 1).trim()) continue
      let label = m[1].replace(/[:\s]+$/, '').trim()
      if (!label) label = ln(i - 1).trim().slice(0, 70)
      const text = ln(i + 1).trim()
      const same = vers.find((v) => v.text === text)
      const v = { dump: d.idx, head: i, line: i + 1, label, text, sameAs: same ? same.line : null, n: vers.length + 1 }
      vers.push(v)
      if (same) folds.push({ dump: d.idx, from: i + 1, to: i + 1, kind: 'same-sql', label: `same statement as line ${same.line}`, closed: true })
    }
    vers.forEach((v, k) => { v.prev = k > 0 ? vers[k - 1].line : null })
    sql.push(...vers)

    // ---- folds ----
    walk(root, (n) => {
      if (n.kind === 'params-default') {
        const [f, t] = trimRange(n.bannerBottom + 1, n.to)
        if (t > f) folds.push({ dump: d.idx, from: f, to: t, kind: 'params', label: 'parameters with default values', closed: true })
      }
      if (n.kind === 'state-dump') {
        const [f, t] = trimRange(n.from + 1, n.to)
        if (t > f) folds.push({ dump: d.idx, from: f, to: t, kind: 'state', label: 'optimizer state dump: the parameters and fix controls again', closed: true })
      }
      if (n.kind === 'ap-search') {
        const [f, t] = trimRange(n.from, n.to)
        if (t > f) folds.push({ dump: d.idx, from: f, to: t, kind: 'ap', label: 'adaptive plan re-costing', closed: true })
      }
      if (n.kind === 'run-head') {
        // the QUERY BLOCK TEXT body: the statement printed again
        const bt = banner.get(n.from + 1)
        if (bt) {
          let t = bt.bottom + 1
          while (t <= n.to && !(role[t] === 'bt')) t++
          const [f, tt] = trimRange(bt.bottom + 1, t - 1)
          const body = L.slice(f - 1, tt).join('\n')
          if (tt > f && body.trim() === d.stmtText.trim()) folds.push({ dump: d.idx, from: f, to: tt, kind: 'stmt-again', label: `statement text, as at line ${d.stmtLine}`, closed: true })
        }
      }
    })
    // fix controls (wherever there are any)
    for (let i = a; i <= e; i++) {
      if (!/^Bug Fix Control Environment/.test(ln(i))) continue
      let t = i
      while (/^\s+fix\s+\d+\s*=/.test(ln(t + 1))) t++
      if (t > i) folds.push({ dump: d.idx, from: i, to: t, kind: 'fix', label: 'fix controls', closed: true })
    }
    // the statement text printed again in the statement dump (after `----- Current SQL Statement …` and after `sql=`)
    if (rs) {
      const c2 = find(/^----- Current SQL Statement for this session/, rs, e)
      const p2 = c2 ? find(/^----- Parser State -----/, c2, e) : 0
      if (c2 && p2 && L.slice(c2, p2 - 1).join('\n').trim() === d.stmtText.trim() && p2 - 1 > c2 + 1)
        folds.push({ dump: d.idx, from: c2 + 1, to: p2 - 1, kind: 'stmt-again', label: `statement text, as at line ${d.stmtLine}`, closed: true })
      const sq = find(/^sql=/, rs, e)
      const ex = sq ? find(/^----- Explain Plan Dump/, sq, e) : 0
      if (sq && ex && ex - 1 > sq) folds.push({ dump: d.idx, from: sq, to: ex - 1, kind: 'stmt-again', label: `statement text, as at line ${d.stmtLine}`, closed: true })
    }

    // ---- the plan table, its query blocks and predicates ----
    const pt = find(/^Plan Table\s*$/, rs || a, e)
    if (pt) {
      const plan = { dump: d.idx, from: pt - 1, rows: [], qbs: {}, preds: {}, cols: [] }
      let i = pt + 2, head = 0
      for (; i <= e; i++) {
        const s = ln(i)
        if (/^\|\s*Id\s*\|/.test(s)) { head = i; plan.cols = s.split('|').slice(1, -1).map((c) => c.trim()); continue }
        if (/^\|\s*\d+\s*\|/.test(s)) {
          const c = s.split('|').slice(1, -1)
          const op = c[1]
          plan.rows.push({ line: i, id: +c[0].trim(), depth: op.length - op.replace(/^ +/, '').length - 1, op: op.trim(), name: c[2].trim(), rows: c[3].trim(), bytes: c[4].trim(), cost: c[5].trim(), time: (c[6] || '').trim() })
          continue
        }
        if (/^-+(?:\+-+)+\+\s*$/.test(s)) { if (plan.rows.length) { plan.tableTo = i; break } continue }
      }
      plan.head = head
      const qn = find(/^Query Block Name \/ Object Alias/, i, e)
      const pi = find(/^Predicate Information:/, i, e)
      if (qn) for (let j = qn + 2; j < (pi || e); j++) { const m = /^\s*(\d+) - (\S+)\s*(?:\/ (.+?))?\s*$/.exec(ln(j)); if (m) plan.qbs[m[1]] = { qb: m[2], alias: m[3] || '', line: j } }
      let end = pi
      if (pi) for (let j = pi + 2; j <= e; j++) { const m = /^\s*(\d+) - (.+?)\s*$/.exec(ln(j)); if (!m) break; (plan.preds[m[1]] ||= []).push({ text: m[2], line: j }); end = j }
      plan.to = end || plan.tableTo
      plans.push(plan)
      d.plan = plans.length - 1
    }
  }

  function walk(n, f, depth = 0) { f(n, depth); for (const c of n.children) walk(c, f, depth + 1) }

  // folds: one per start line (the outer one wins), sorted
  folds.sort((x, y) => x.from - y.from || y.to - x.to)
  const fl = []
  for (const f of folds) if (!fl.length || fl.at(-1).from !== f.from) fl.push(f)
  fl.forEach((f, k) => { f.id = 'f' + k; f.lines = f.to - f.from + 1 })

  // per-line roles the page needs (banner parts), compact
  const roles = {}
  for (let i = 1; i <= N; i++) if (role[i]) roles[i] = role[i]

  return { file, dumps, landmarks, folds: fl, runs, sql, plans, legend, roles, banners: [...banner.values()] }
}
