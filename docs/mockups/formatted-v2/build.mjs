// Builds index.html: one self-contained file (inline CSS, JS and data) that opens from disk.
//   node build.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const read = (p) => readFileSync(join(here, p), 'utf8')

const css = ['src/tokens.css', 'src/page.css', 'src/rows.css', 'src/chrome.css'].map(read).join('\n')
const js = ['src/fmt.js', 'src/model.js', 'src/present.js', 'src/render.js', 'src/chrome.js', 'src/sections.js', 'src/page.js'].map(read).join('\n')
// the data: the spec's rows.json and the extra lines of the same trace (data/extra.json, made by tools/extract-extra.mjs)
const data = { rows: JSON.parse(read('data/rows.json')), extra: JSON.parse(read('data/extra.json')) }
// the raw trace line of each row stays (the wait parameters are read from it); `</` is escaped so no string can close the script
const json = JSON.stringify(data).replace(/</g, '\\u003c')

const html = read('src/template.html')
  .replace('/*@CSS*/', () => css)
  .replace('/*@DATA*/null', () => json)
  .replace('/*@JS*/', () => js)
writeFileSync(join(here, 'index.html'), html)
console.log(`index.html: ${(html.length / 1024).toFixed(0)} KB (css ${(css.length / 1024).toFixed(0)} KB, js ${(js.length / 1024).toFixed(0)} KB, data ${(json.length / 1024).toFixed(0)} KB)`)
