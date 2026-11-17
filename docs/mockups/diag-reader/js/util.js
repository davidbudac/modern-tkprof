// small helpers shared by the page's scripts
const $ = (s, r = document) => r.querySelector(s)
const $$ = (s, r = document) => [...r.querySelectorAll(s)]
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
const fmtN = (n) => (n === null || n === undefined ? '' : Number(n).toLocaleString('en-US'))
/** seconds as the dump prints them, trimmed: 7.631663 -> "7.63 s", 0.000113 -> "0.000113 s" */
function fmtS(x) {
  if (x === null || x === undefined) return ''
  if (x === 0) return '0 s'
  if (x >= 100) return Math.round(x).toLocaleString('en-US') + ' s'
  if (x >= 1) return x.toFixed(2) + ' s'
  return String(x) + ' s'
}
/** how many elements of the sorted array are < v */
function lowerBound(a, v) { let lo = 0, hi = a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (a[m] < v) lo = m + 1; else hi = m } return lo }
function countIn(sorted, from, to) { return lowerBound(sorted, to + 1) - lowerBound(sorted, from) }
const tryLS = {
  get(k) { try { return localStorage.getItem(k) } catch (e) { return null } },
  set(k, v) { try { localStorage.setItem(k, v) } catch (e) {} },
}
function copyText(text) {
  try { if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).catch(() => fallbackCopy(text)) } catch (e) {}
  fallbackCopy(text)
}
function fallbackCopy(text) {
  const t = document.createElement('textarea')
  t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'
  document.body.append(t); t.select()
  try { document.execCommand('copy') } catch (e) {}
  t.remove()
}
