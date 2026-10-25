/** Copies text to the clipboard; falls back to a hidden textarea where the async API is missing (a page served over plain http, as on a tailnet). */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall through */ }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.cssText = 'position:fixed;inset-block-start:0;inset-inline-start:0;opacity:0;pointer-events:none'
  document.body.appendChild(ta)
  const prev = document.activeElement as HTMLElement | null
  ta.select()
  let ok = false
  try { ok = document.execCommand('copy') } catch { /* unavailable */ }
  ta.remove()
  prev?.focus({ preventScroll: true })
  return ok
}
