// The screenshots of shots/ at 1680 x 1050 (light and dark where it matters).
//   PLAYWRIGHT=/path/to/node_modules/playwright node tools/shots.cjs [name,name] [out dir]
const { chromium, URL, SHOTS } = require('./pw.cjs')
const only = process.argv[2]
const out = process.argv[3] || SHOTS
;(async () => {
  const b = await chromium.launch()
  const errs = []
  async function page(theme) {
    const p = await b.newPage({ viewport: { width: 1680, height: 1050 } })
    p.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.type() + ': ' + m.text()) })
    p.on('pageerror', (e) => errs.push('pageerror: ' + e.message))
    await p.emulateMedia({ colorScheme: theme })
    await p.goto(URL)
    await p.evaluate(() => document.fonts.ready)
    await p.waitForTimeout(400)
    return p
  }
  const want = (n) => !only || only.split(',').includes(n)
  const shot = async (p, name) => { await p.waitForTimeout(250); await p.screenshot({ path: out + name + '.png' }); console.log('shot', name) }

  for (const theme of ['light', 'dark']) {
    if (want('overview')) { const p = await page(theme); await shot(p, `overview-${theme}`); await p.close() }
    if (want('costing')) {
      const p = await page(theme)
      await p.evaluate(() => {
        const a = window.__app
        a.openDump(1)
        const d = a.D()
        const jo = d.nodes.find((n) => n.kind === 'join-order' && n.from === 24562)
        let n = jo.parent; while (n) { a.S.exp.add(n.id); n = n.parent }
        // collapse what is above the run, so the run's join orders are in view
        for (const x of d.nodes) if (['phase-env', 'phase-trans'].includes(x.kind)) a.S.exp.delete(x.id)
        a.S.sel = jo.from
        a.updateAll()
        document.querySelector('#lv').scrollTop = a.rowOf(24528) * 20
      })
      await p.waitForTimeout(200)
      await p.evaluate(() => { const el = document.querySelector('#lbody .ol-row.on'); el && el.scrollIntoView({ block: 'center' }) })
      await shot(p, `costing-${theme}`)
      await p.close()
    }
  }
  if (want('runs')) {
    const p = await page('light')
    await p.click('[data-olmode="runs"]')
    await p.evaluate(() => { const a = window.__app; const r = a.D().nodes.find((n) => n.kind === 'run' && n.final); a.goNode(r.id) })
    await shot(p, 'runs-light')
    // the second dump: identical runs folded
    await p.evaluate(() => { const a = window.__app; a.openDump(1); const r = a.D().nodes.find((n) => n.kind === 'run' && n.label.startsWith('Run 5 ')); a.goNode(r.id); document.querySelector('#lv').scrollTop -= 6 * 20 })
    await shot(p, 'runs-same-light')
    await p.close()
  }
  if (want('search')) {
    const p = await page('light')
    await p.fill('#q', 'MTK_ORDERS_CUST_IX')
    await p.waitForTimeout(300)
    await p.press('#q', 'Enter'); await p.press('#q', 'Enter'); await p.press('#q', 'Enter')
    await p.evaluate(() => { const a = window.__app, d = a.D(); for (const n of d.nodes) if (n.kind === 'cbqt' || n.kind === 'cbsec' && n.label.includes('Group-By')) a.S.exp.add(n.id); a.updateAll() })
    await shot(p, 'search-light')
    await p.close()
  }
  if (want('sql')) {
    const p = await page('light')
    await p.evaluate(() => { const a = window.__app; a.select(9383, 'top'); document.querySelector('#lv').scrollTop = a.rowOf(9378) * 20 })
    await p.waitForTimeout(200)
    await p.click('[data-diff="9384"]')
    await shot(p, 'sql-diff-light')
    await p.close()
  }
  if (want('plan')) {
    const p = await page('light')
    await p.evaluate(() => { const a = window.__app; const n = a.D().nodes.find((x) => x.kind === 'plan'); a.S.exp.add(n.id); a.goNode(n.id); a.select(15771) ; document.querySelector('#lv').scrollTop = a.rowOf(15754) * 20 - 20 })
    await shot(p, 'plan-light')
    await p.close()
  }
  if (want('hints')) {
    const p = await page('light')
    await p.evaluate(() => { const a = window.__app; a.openDump(1); a.S.ltab = 'landmarks'; a.S.lmCur = 27726; a.select(27726); document.querySelector('#lv').scrollTop = a.rowOf(27700) * 20 })
    await p.waitForTimeout(200)
    await p.evaluate(() => { const el = document.querySelector('.lml-h:last-of-type'); })
    await shot(p, 'hints-light')
    await p.close()
  }
  if (want('raw')) {
    const p = await page('light')
    await p.evaluate(() => { const a = window.__app; a.S.sel = 1868; a.setMode('raw'); document.querySelector('#lv').scrollTop = a.rowOf(1838) * 20 })
    await shot(p, 'raw-light')
    await p.close()
  }
  console.log(errs.join('\n') || 'no console errors')
  await b.close()
})()
