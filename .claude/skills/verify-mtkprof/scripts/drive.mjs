#!/usr/bin/env node
// Headless-Playwright driver for mtkprof dev browser mode. Reads <root>/state.env (URL) from launch.sh; root = $VERIFY_MTKPROF_ROOT or /tmp/verify-mtkprof.
// usage: node drive.mjs --open <abs path>[,<abs path>...] [--view Lines] [--page Settings|Connections] [--name label]
//                       [--evidence <dir>] [--click "<css>"]... [--prefs '{"wrap":true}'] [--viewport 1440x900]
// Writes <evidence>/<name>-NN-<step>.png, <name>.aria.txt, <name>.json (tabs, views, console errors). Exit 1 on any failed assertion.
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const PW = '/Users/davidbudac/.claude/skills/deck-to-pptx/node_modules/playwright/index.mjs'
const { chromium } = await import(pathToFileURL(PW).href)

const a = process.argv.slice(2)
const opt = (k, d) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : d }
const root = process.env.VERIFY_MTKPROF_ROOT || '/tmp/verify-mtkprof'
const state = Object.fromEntries(fs.readFileSync(`${root}/state.env`, 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, '')] }))
const name = opt('name', 'drive')
const ev = opt('evidence', `${root}/evidence/${new Date().toISOString().replace(/[:.]/g, '-')}`)
fs.mkdirSync(ev, { recursive: true })
const paths = (opt('open', '') || '').split(',').filter(Boolean)
for (const p of paths) if (!path.isAbsolute(p)) { console.error(`path must be absolute (relative paths fail with "no such file"): ${p}`); process.exit(2) }

const browser = await chromium.launch({ headless: true })
const [vw, vh] = opt('viewport', '1440x900').split('x').map(Number)
const ctx = await browser.newContext({ viewport: { width: vw, height: vh } })   // fresh context: no trace open, empty localStorage
const page = await ctx.newPage()
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))
let n = 0
const shot = async (step) => { const f = path.join(ev, `${name}-${String(++n).padStart(2, '0')}-${step}.png`); await page.screenshot({ path: f }); console.log('screenshot', f); return f }
const fail = async (msg) => { console.error('FAIL: ' + msg); await shot('failure').catch(() => {}); fs.writeFileSync(path.join(ev, `${name}.json`), JSON.stringify({ ok: false, msg, errors }, null, 2)); await browser.close(); process.exit(1) }

if (opt('prefs')) await ctx.addInitScript((p) => localStorage.setItem('mtk.lines.prefs', p), opt('prefs'))
await page.goto(state.URL)
// Ready = the open form is enabled (it says "Waiting for the engine…" until the engine answers).
try { await page.waitForSelector('.open-screen .actions button.primary:not([disabled])', { timeout: 20000 }) } catch { await fail('engine never became ready in the UI (Open files button stayed disabled)') }
await shot('start-page')

if (paths.length) {
  await page.fill('#open-path', paths.join('\n'))
  await shot('paths-filled')
  await page.click('form button[type=submit]')
  try { await page.waitForSelector('.session-tab-main', { timeout: 30000 }) } catch { await fail('no session tab appeared after Open') }
  // wait until the tab is no longer opening/failed
  try { await page.waitForSelector('.session-nav .tabs button.tab', { timeout: 30000 }) } catch { await fail('views bar never appeared (open failed? check .tab-dot.bad / .tab-banner.bad)') }
  await page.waitForTimeout(1200) // the views reveal themselves (fade + rise) once the document is in; the nav is in the top row and shows before that ends
}
const tabTitles = await page.locator('.session-tab-main .mono').allInnerTexts()
const views = await page.locator('.session-nav .tabs button.tab').allInnerTexts()
if (opt('view')) {
  // the label is followed by a hidden key hint (<kbd class="key-hint">), so match on the text before it
  const v = page.locator('.session-nav .tabs button.tab', { hasText: new RegExp('^' + opt('view') + '(\\s|⌘|Ctrl|$)') })
  if (!(await v.count())) await fail(`view "${opt('view')}" not offered; available: ${views.join(', ')}`)
  await v.click()
  try { await page.waitForSelector(`.session-nav .tabs button.tab[aria-current=page]:has-text("${opt('view')}")`, { timeout: 5000 }) } catch { await fail('view button never became aria-current=page') }
  await page.waitForTimeout(1500)
}
if (opt('page')) {
  // the page links are icons: their name is the aria-label
  const b = page.locator(`.page-links button[aria-label="${opt('page')}"]`)
  if (!(await b.count())) await fail(`page link "${opt('page')}" missing`)
  await b.click(); await page.waitForTimeout(800)
}
for (let i = 0; i < a.length; i++) if (a[i] === '--click') { await page.click(a[i + 1]); await page.waitForTimeout(600) }
const last = await shot(opt('view') ? 'view-' + opt('view') : opt('page') ? 'page-' + opt('page') : 'end')
fs.writeFileSync(path.join(ev, `${name}.aria.txt`), await page.locator('body').ariaSnapshot())
const linesPrefs = await page.evaluate(() => localStorage.getItem('mtk.lines.prefs'))
const sum = { ok: true, url: state.URL.replace(/token=[^&]+/, 'token=***'), tabTitles, views, activeView: await page.locator('.session-nav .tabs button.tab[aria-current=page]').allInnerTexts(), linesPrefs, errors, screenshot: last }
fs.writeFileSync(path.join(ev, `${name}.json`), JSON.stringify(sum, null, 2))
console.log(JSON.stringify(sum, null, 2))
await browser.close()
