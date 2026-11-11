// Writes sqlfmt_golden.json: statements and what the mock-up's pretty-printer (docs/mockups/10053-reader/src/sqlfmt.js)
// makes of them. internal/opt/sqlfmt_test.go checks FormatSQL against it. Run from this folder:
//   node gen_sqlfmt_golden.mjs
// The statements are the ones the mock-up's parser reads from the fixtures plus a few hand-written edge cases.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import vm from 'node:vm'
import { parse } from '../../../docs/mockups/10053-reader/tools/parse.mjs'

const mock = '../../../docs/mockups/10053-reader/'
const ctx = {}
vm.runInNewContext(readFileSync(mock + 'src/sqlfmt.js', 'utf8') + '\nthis.formatSql = formatSql', ctx)

const inputs = new Set()
const dir = '../../../testdata/opt/19c/'
for (const f of readdirSync(dir).filter((f) => f.endsWith('.trc'))) {
  const m = parse(readFileSync(dir + f, 'utf8'), f)
  for (const d of m.dumps) inputs.add(d.stmtText.trim())
  for (const s of m.sql) inputs.add(s.text)
}
const hand = [
  'select 1 from dual',
  "select 'it''s' x, \"Mixed Case\" from t where a = 'x and y' and b in (1,2,3) or c is null",
  'select /*+ index(t i) */ a, b -- trailing comment\n from t where x = :b1 and y = :1',
  'select a from t1 union all select b from t2 minus select c from t3 order by 1',
  'select case when a > 1 then 2 else 3 end, (select max(x) from u where u.id = t.id) m from t, u where t.a = u.a(+) and exists (select 1 from v where v.a = t.a)',
  'with q as (select a from t) select * from q connect by prior a = b start with a = 1',
  "select 1.5e-3, 10, .5 from t where s = 'unterminated",
  'select ' + Array.from({ length: 30 }, (_, i) => 'col_' + i + ' c' + i).join(', ') + ' from t group by ' + Array.from({ length: 30 }, (_, i) => 'col_' + i).join(', '),
  'insert into t (a, b) select a, b from s where x > 1',
  '',
  '   ',
  'x',
]
for (const h of hand) inputs.add(h.trim())

const cases = [...inputs].map((s) => ({ in: s, out: ctx.formatSql(s).join('\n') }))
writeFileSync('sqlfmt_golden.json', JSON.stringify(cases, null, 1))
console.log(cases.length, 'cases')
