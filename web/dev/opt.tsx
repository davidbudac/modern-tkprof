// Dev harness for the 10053 view (not part of the production build): mounts <OptView> on real data before the shells register it.
//
//   pnpm --filter mtkprof-web dev          then   http://localhost:5173/dev/opt.html
//   ?digest=1     the text cut to each dump's digest ranges (gap rows)      ?theme=light|dark   (default: the system's)
//   ?dump=1&line=N  open the second dump (and a line)                                      ?big=1      a synthetic 100,000-line dump (?big=N, N over 1000: that many lines)
//   ?old=1        the file summary with a 23.x version (the "read with the 19c rules" line)      ?trunc=1    the first dump marked truncated
//
// The model is web/dev/opt-two.model.json, made from the mock-up's model by `node web/dev/opt-convert.mjs` (until the Go scanner serves it); the
// text is that model's trace, docs/mockups/10053-reader/data/two.trc.
import { StrictMode, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@lib/styles/fonts.css'
import '@lib/styles/tokens.css'
import '@lib/styles/base.css'
import '@lib/styles/app.css'
import '@lib/styles/motion.css'
import { OptView } from '@lib/views/opt/OptView'
import { memoryOptSource, type OptAnnotations, type OptDump, type OptFile } from '@lib/data/opt'
import { syntheticDump } from '@lib/data/optsynth'
import model from './opt-two.model.json'
import trace from '../../docs/mockups/10053-reader/data/two.trc?raw'

const q = new URLSearchParams(location.search)
const theme = q.get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)

function build(digest: boolean, old: boolean, big: boolean, trunc: boolean) {
  if (big) {
    const n = Number(q.get('big'))
    const s = syntheticDump(n > 1000 ? n : 100_000)
    return memoryOptSource(s.file, [s.dump], s.lines, { digest })
  }
  const file = { ...(model.file as OptFile), ...(old ? { version: '23.6.0.0.0', tested: false, release: 'Oracle Database 23ai Enterprise Edition Release 23.0.0.0.0 - Production' } : {}) }
  const dumps = (model.dumps as unknown as OptDump[]).map((d, i) => (trunc && i === 0 ? { ...d, truncated: true } : d))
  file.dumps = file.dumps.map((d, i) => (trunc && i === 0 ? { ...d, truncated: true } : d))
  return memoryOptSource(file, dumps, trace, { digest })
}

function Harness() {
  const [digest, setDigest] = useState(q.get('digest') === '1')
  const [goTo, setGoTo] = useState<{ dump: number; line?: number; seq?: number } | undefined>(q.get('dump') || q.get('line') ? { dump: Number(q.get('dump') ?? 0), line: q.get('line') ? Number(q.get('line')) : undefined } : undefined)
  const [open, setOpen] = useState(0)
  const [shown, setShown] = useState(true)
  const source = useMemo(() => build(digest, q.get('old') === '1', !!q.get('big') && q.get('big') !== '0', q.get('trunc') === '1'), [digest])
  // an annotations adapter of the harness (the desktop's lives in the store): bookmarks and notes in a Map
  const [marks, setMarks] = useState<ReadonlyMap<number, string>>(new Map())
  const notes: OptAnnotations = useMemo(() => ({
    bookmarks: marks,
    toggle: (l) => setMarks((o) => { const n = new Map(o); if (n.has(l)) n.delete(l); else n.set(l, ''); return n }),
    setNote: (l, t) => setMarks((o) => new Map(o).set(l, t)),
    remove: (l) => setMarks((o) => { const n = new Map(o); n.delete(l); return n }),
  }), [marks])
  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', blockSize: '100dvh' }}>
      <div className="harness" style={{ display: 'flex', gap: '1rem', alignItems: 'center', padding: '0.4rem 1rem', borderBlockEnd: '1px solid var(--hairline)', background: 'var(--surface-raised)', fontSize: 'var(--text-sm)' }}>
        <b>mtkprof</b><span>10053 view, dev harness</span>
        <label><input type="checkbox" id="h-digest" checked={digest} onChange={(e) => setDigest(e.target.checked)} /> digest (the lines a report keeps)</label>
        <button type="button" id="h-jump" className="quiet" onClick={() => setGoTo({ dump: (open + 1) % source.file.dumps.length, seq: (goTo?.seq ?? 0) + 1 })}>open the next dump from outside</button>
        <button type="button" id="h-remount" className="quiet" onClick={() => setShown((v) => !v)}>{shown ? 'unmount the view' : 'mount it again'}</button>
        <span style={{ marginInlineStart: 'auto', color: 'var(--ink-3)' }}>{source.file.name}</span>
      </div>
      <div style={{ minBlockSize: 0 }}>
        {shown && <OptView source={source} annotations={notes} goTo={goTo} onDump={setOpen}
          link10046={{ has: (id) => id === '4a6t4jr44yb2d', open: (id) => console.info('open the 10046 statement', id) }} />}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
