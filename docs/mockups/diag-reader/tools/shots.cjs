// Screenshots of the mock-up, 1440 x 900. PLAYWRIGHT=…/node_modules/playwright [CHROMIUM=…/chrome-headless-shell] node tools/shots.cjs [name,name,…]
const { chromium, BASE, SHOTS } = require('./pw.cjs')
const W = 1440, H = 900
const SHOT = {
  'errorstack-light': { q: 'file=errorstack&variant=a&theme=light' },
  'errorstack-dark': { q: 'file=errorstack&variant=a&theme=dark' },
  'errorstack-text-light': { q: 'file=errorstack&variant=a&theme=light&mode=text' },
  'errorstack-b-light': { q: 'file=errorstack&variant=b&theme=light' },
  'heap-a-light': { q: 'file=heap&variant=a&theme=light&chunk=0' },
  'heap-a-dark': { q: 'file=heap&variant=a&theme=dark&chunk=0' },
  'heap-b-light': { q: 'file=heap&variant=b&theme=light&heap=h30&chunk=0' },
  'process-light': { q: 'file=process&variant=a&theme=light' },
  'sysstate-light': { q: 'file=sysstate&variant=a&theme=light&hideidle=1' },
  'sysstate-dark': { q: 'file=sysstate&variant=a&theme=dark' },
  'hang-light': { q: 'file=hang&variant=a&theme=light' },
}
;(async () => {
  const want = process.argv[2] ? process.argv[2].split(',') : Object.keys(SHOT)
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {})
  for (const name of want) {
    const s = SHOT[name]
    if (!s) { console.log('unknown', name); continue }
    const page = await browser.newPage({ viewport: { width: s.w || W, height: s.h || H }, deviceScaleFactor: 1 })
    const errs = []
    page.on('pageerror', (e) => errs.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()) })
    await page.goto(BASE + '?' + s.q)
    await page.waitForSelector('body[data-ready="1"]', { timeout: 20000 })
    await page.waitForTimeout(400)
    if (s.after) await s.after(page)
    await page.screenshot({ path: SHOTS + (s.file || name) + '.png' })
    console.log(name, errs.length ? 'ERRORS: ' + errs.join(' | ') : 'ok')
    await page.close()
  }
  await browser.close()
})()
