import { useState } from 'react'

export function SqlText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1200) } catch { /* clipboard unavailable */ }
  }
  return (
    <div className="section">
      <pre className="sql">{text}</pre>
      <div className="flex xs muted"><span>{text.length.toLocaleString()} chars</span><button onClick={copy}>{copied ? 'Copied' : 'Copy SQL'}</button></div>
    </div>
  )
}
