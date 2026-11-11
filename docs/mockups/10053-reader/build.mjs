// Builds index.html: one self-contained page (inline CSS, JS, the trace and its model) that opens from disk.
//   node build.mjs            (writes index.html and data/model.json)
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from './tools/parse.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(here, p), 'utf8')

const text = read('data/two.trc')
const model = parse(text, 'two.trc')
writeFileSync(join(here, 'data/model.json'), JSON.stringify(model, null, 1))

const css = ['src/tokens.css', 'src/base.css', 'src/page.css', 'src/view.css'].map(read).join('\n')
const js = ['src/guide.js', 'src/sqlfmt.js', 'src/model.js', 'src/paint.js', 'src/panels.js', 'src/app.js'].map(read).join('\n')
// `</` is escaped so no string can close the script
const json = JSON.stringify({ model, text }).replace(/</g, '\\u003c')

const html = read('src/template.html')
  .replace('/*@CSS*/', () => css)
  .replace('/*@DATA*/null', () => json)
  .replace('/*@JS*/', () => js)
writeFileSync(join(here, 'index.html'), html)

// what the build found, for the README and the report
const nodes = model.dumps.reduce((s, d) => { let c = 0; const w = (n) => { c++; n.children.forEach(w) }; w(d.tree); return s + c }, 0)
const lm = {}
for (const l of model.landmarks) lm[l.kind] = (lm[l.kind] || 0) + 1
const folds = model.folds.reduce((a, f) => { a[f.kind] = a[f.kind] || [0, 0]; a[f.kind][0]++; a[f.kind][1] += f.lines; return a }, {})
console.log(`index.html: ${(html.length / 1024).toFixed(0)} KB (css ${(css.length / 1024).toFixed(0)} KB, js ${(js.length / 1024).toFixed(0)} KB, data ${(json.length / 1024).toFixed(0)} KB)`)
console.log(`${model.file.lines} lines, ${model.dumps.length} dumps (${model.dumps.map((d) => `${d.sqlId} ${d.viewFrom}-${d.viewTo}, ${d.runCount} runs`).join('; ')}), ${nodes} outline nodes`)
console.log('landmarks', JSON.stringify(lm))
console.log('runs', model.runs.length, 'same as an earlier one', model.runs.filter((r) => r.sameAs).length, 'final', model.runs.filter((r) => r.final).length)
console.log('folds', JSON.stringify(folds))
console.log('sql versions', model.sql.length, 'legend terms', model.legend.length, 'plans', model.plans.map((p) => p.rows.length + ' ops').join(', '))
