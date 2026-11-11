// A synthetic dump of a chosen number of lines, in the shape of the 10053 model, for the tests of scale and the dev harness (?big=1): a file header, the
// phases, many costing runs with join orders and join steps, landmarks, folds and a plan. Not a trace anyone wrote: the lines only look like one.
import type { OptDump, OptFile, OptFold, OptLandmark, OptNode, OptRun } from './opt'

export interface Synthetic { file: OptFile; dump: OptDump; lines: string[] }

export function syntheticDump(target: number): Synthetic {
  const lines: string[] = []
  const add = (s: string) => { lines.push(s); return lines.length }
  let id = 0
  const nid = () => `n${id++}`
  const landmarks: OptLandmark[] = []
  const folds: OptFold[] = []
  const runs: OptRun[] = []
  const roles: Record<string, string> = {}
  const banners: OptDump['banners'] = []
  const banner = (title: string) => {
    const t = add('***********************************')
    roles[t] = 'bt'
    const m = add(title)
    roles[m] = 'bh'
    const b = add('***********************************')
    roles[b] = 'bb'
    banners.push({ top: t, title: m, bottom: b, text: title })
  }
  const kids = (n: OptNode, c: OptNode) => { (n.children ??= []).push(c); return c }
  const node = (kind: string, label: string, from: number, lvl: number, extra: Partial<OptNode> = {}): OptNode => ({ id: nid(), kind, label, crumb: label, from, to: from, lvl, ...extra })

  const root = node('dump', 'synthetic0000', 1, 0)
  // header and environment
  const hdr = kids(root, node('file-header', 'File header', 1, 1))
  for (let i = 0; i < 30; i++) add(`Header line ${i + 1}`)
  hdr.to = lines.length
  const env = kids(root, node('phase-env', 'Environment', lines.length + 1, 1))
  banner('QUERY BLOCK SIGNATURE')
  const stmtLine = add('select a.x, b.y from t_a a join t_b b on a.id = b.id where a.x > :1 and b.y in (select y from t_c) order by 1')
  const params = kids(env, node('params-default', 'Default values', lines.length + 1, 2))
  const pf = lines.length + 1
  for (let i = 0; i < Math.floor(target * 0.04); i++) add(`parameter_${i}                 = ${i}`)
  params.to = lines.length
  folds.push({ id: 'f0', from: pf, to: lines.length, lines: lines.length - pf + 1, kind: 'params', label: 'parameters with default values', closed: true })
  env.to = lines.length

  // transformations
  const trans = kids(root, node('phase-trans', 'Transformations', lines.length + 1, 1))
  banner('Query transformations')
  for (let i = 0; i < 30; i++) add(`SU: Considering subquery unnesting in query block SEL$${i}`)
  landmarks.push({ line: lines.length, kind: 'refused', tone: 'rejected', text: 'SU: Bypassed: subquery is correlated' })
  trans.to = lines.length

  // costing: runs of join orders
  const cost = kids(root, node('phase-cost', 'Costing', lines.length + 1, 1))
  const nRuns = Math.max(2, Math.floor(target / 8000))
  const perRun = Math.floor((target * 0.8) / nRuns)
  for (let r = 1; r <= nRuns; r++) {
    const run = kids(cost, node('run', `Run ${r} of ${nRuns} · SEL$1 (#1)`, lines.length + 1, 2, { n: r, of: nRuns, qb: 'SEL$1', qbn: '1', sameAs: 0, final: r === nRuns, bestJo: 1 }))
    add(`kkoqbc: optimizing query block SEL$1 (#1)`)
    const js = kids(run, node('join-search', 'Join order search', lines.length + 1, 3))
    const start = lines.length
    let jo = 0
    while (lines.length - start < perRun) {
      jo++
      const j = kids(js, node('join-order', `Join order[${jo}]`, lines.length + 1, 4, { n: jo, tables: ['T_A[A]#0', 'T_B[B]#1'], isBest: jo === 1 }))
      add(`Join order[${jo}]:  T_A[A]#0  T_B[B]#1`)
      for (let s = 0; s < 2; s++) {
        const js2 = kids(j, node('join-step', `Now joining: T_B[B]#${s}`, lines.length + 1, 5, { method: 'NestedLoop', result: 'NestedLoop' }))
        add(`Now joining: T_B[B]#${s}`)
        for (let k = 0; k < 14; k++) add(`  NL Join:  Cost: ${100 + k}.000000  Resp: ${100 + k}.000000  Degree: 1`)
        landmarks.push({ line: add('  Best:: JoinMethod: NestedLoop'), kind: 'best-jm', tone: 'kept', text: 'Best:: JoinMethod: NestedLoop' })
        add('    Cost: 10.000000  Degree: 1  Resp: 10.000000  Card: 1.000000 Bytes: 0')
        js2.to = lines.length
      }
      if (jo % 3 === 0) { landmarks.push({ line: add('Join order aborted: cost > best plan cost'), kind: 'aborted', tone: 'rejected', text: 'Join order aborted: cost > best plan cost' }); j.result = 'aborted' }
      else { add('Best so far:  Table#: 0  cost: 5.000000'); j.result = 'cost: 5.000000'; j.cost = '5.000000' }
      j.to = lines.length
    }
    js.to = lines.length
    landmarks.push({ line: add('Final cost for query block SEL$1 (#1) - All Rows Plan:'), kind: 'final-cost', tone: 'kept', text: 'Final cost for query block SEL$1 (#1) - All Rows Plan:' })
    add('kkoqbc: finish optimizing query block SEL$1 (#1)')
    run.to = lines.length
    runs.push({ id: run.id, n: r, of: nRuns, qb: 'SEL$1', qbn: '1', from: run.from, to: run.to, iter: '', final: r === nRuns, sameAs: 0, bestJo: 1 })
  }
  cost.to = lines.length

  // result with a plan
  const result = kids(root, node('phase-result', 'Result', lines.length + 1, 1))
  banner('Plan Table')
  const planFrom = lines.length - 2
  const head = add('| Id  | Operation | Name | Rows | Bytes | Cost | Time |')
  const rowsOut = [0, 1, 2].map((i) => ({ line: add(`| ${i} | ${'  '.repeat(i)}OP${i} | T_${i} | 1 | 10 | ${i} | 00:00:01 |`), id: i, depth: i, op: `OP${i}`, name: `T_${i}`, rows: '1', bytes: '10', cost: String(i), time: '00:00:01' }))
  const planTo = add('Predicate Information:')
  result.to = lines.length
  while (lines.length < target) add('After the dump: a trailing line')
  root.to = lines.length
  result.to = lines.length

  const info = {
    idx: 0, from: 1, end: lines.length, viewFrom: 1, viewTo: lines.length, lineCount: lines.length, sqlId: 'synthetic0000', nth: 1, stmtText: lines[stmtLine - 1], sqlStart: lines[stmtLine - 1],
    tables: ['T_A', 'T_B'], planHash: '1', runCount: nRuns, unplaced: 0,
  }
  const dump: OptDump = {
    ...info, stmtLine, stmtTo: stmtLine, tree: root, landmarks, folds, runs, sql: [], legend: [{ term: 'NL', text: 'nested loops (join)', line: 5, codes: [] }], banners, roles, hints: [], binds: [], altered: [], bindLines: [],
    digest: [{ from: 1, to: 40 }, { from: planFrom, to: planTo }],
    plan: { from: planFrom, head, tableTo: planTo - 1, to: planTo, cols: ['Id', 'Operation', 'Name', 'Rows', 'Bytes', 'Cost', 'Time'], rows: rowsOut, qbs: {}, preds: {} },
  }
  const file: OptFile = { name: 'synthetic.trc', lines: lines.length, release: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production', version: '19.27.0.0.0', tested: true, records10046: 0, dumps: [info] }
  return { file, dump, lines }
}
