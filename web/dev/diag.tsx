// Dev harness for the dump reader (not part of the production build): mounts <DiagView> on a memory source made from a real fixture.
//
//   pnpm --filter mtkprof-web dev          then   http://localhost:5173/dev/diag.html
//   ?theme=light|dark     (default: the system's)                       ?big=1      a synthetic file of 5,000,000 lines whose lines and parts are made on demand
//   ?big=N                N lines instead (to try the scroll map, the paging of the text and the "load more" row of the outline)
//   ?digest=1             the standalone report's source: the outline to two levels from the digest, no text, no requests
//   ?reading=1            the node "Call Stack Trace" carries a reading of kind `callstack` shown by a demo component; `?reading=none`: the kind has no component
//   ?node=ID&line=N       select a node and/or go to a line at mount          ?old=1      the file facts of a 23.x file (the "read with the 19c rules" notes)
//
// The fixture is web/dev/diag-errorstack_l2.fixture.json.gz, made by web/dev/diag-fixture.mjs from `mtkprof serve -view diag
// testdata/diag/19c/diag_errorstack_l2.trc`: the file's facts and outline, the children of the nodes that have some and every line, as the engine served them.
import { StrictMode, useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@lib/styles/fonts.css'
import '@lib/styles/tokens.css'
import '@lib/styles/base.css'
import '@lib/styles/app.css'
import '@lib/styles/motion.css'
import { DiagView } from '@lib/views/diag/DiagView'
import { registerReading, type ReadingProps } from '@lib/views/diag/readings'
import { memoryDiagSource, type DiagFile, type DiagNode, type DiagSource, type RawDump } from '@lib/data/diag'
import { digestDiagSource } from '@lib/data/diagsource'
import { syntheticDiag } from '@lib/data/diagsynth'
import type { OptAnnotations } from '@lib/data/opt'
import fixtureUrl from './diag-errorstack_l2.fixture.json.gz?url'

const q = new URLSearchParams(location.search)
const theme = q.get('theme')
if (theme === 'light' || theme === 'dark') document.documentElement.setAttribute('data-theme', theme)

interface Fixture { file: DiagFile; children: Record<string, DiagNode[]>; lines: string[] }

/** The fixture: gzipped JSON. The dev server may serve it with Content-Encoding (then the browser has inflated it already). */
async function loadFixture(): Promise<Fixture> {
  const res = await fetch(fixtureUrl)
  if (res.headers.get('content-encoding')?.includes('gzip') || !('DecompressionStream' in window)) return (await res.json()) as Fixture
  const text = await new Response(res.body!.pipeThrough(new DecompressionStream('gzip'))).text()
  return JSON.parse(text) as Fixture
}

/** A demo reading: what a stage-3 component is given. */
function DemoReading({ node, reading, goLine }: ReadingProps) {
  return (
    <div style={{ padding: '1rem 1.5rem', display: 'grid', gap: '0.5rem', maxInlineSize: '40rem' }}>
      <h3 style={{ margin: 0 }}>Demo reading of {node.title}</h3>
      <p style={{ margin: 0 }}>Kind <code>{reading.kind}</code>, lines {node.from}-{node.to}. The reading's payload: <code>{JSON.stringify(reading)}</code></p>
      <p style={{ margin: 0 }}><button type="button" className="link" onClick={() => goLine(node.from)}>Show line {node.from} in the text</button></p>
    </div>
  )
}

function build(fx: Fixture, o: { digest: boolean; old: boolean; big: number; reading: string | null }): DiagSource {
  if (o.big > 0) return syntheticDiag(o.big).source
  const file: DiagFile = o.old ? { ...fx.file, version: '23.6.0.0.0', tested: false, release: 'Oracle Database 23ai Enterprise Edition Release 23.0.0.0.0 - Production', unplaced: 1234 } : fx.file
  const mark = (n: DiagNode): DiagNode => (o.reading && n.title === 'Call Stack Trace' ? { ...n, reading: o.reading === 'none' ? 'procstate' : 'callstack' } : n)
  const children: Record<string, DiagNode[]> = {}
  for (const [id, kids] of Object.entries(fx.children)) children[id] = kids.map(mark)
  if (o.digest) {
    // what the standalone report holds: the top level, each node with its children
    const dump: RawDump = { file, digest: { outline: file.outline.map((n) => ({ ...n, children: children[n.id] ?? [] })) } }
    return digestDiagSource(dump)
  }
  const readings = { [Object.values(children).flat().find((n) => n.title === 'Call Stack Trace')?.id ?? '']: { kind: 'callstack', frames: 44, statement: 'alter session set events …' } }
  return memoryDiagSource(file, children, fx.lines, { readings })
}

function Harness() {
  const [fx, setFx] = useState<Fixture | null>(null)
  const [shown, setShown] = useState(true)
  useEffect(() => { void loadFixture().then(setFx) }, [])
  useEffect(() => { if (q.get('reading')) registerReading('callstack', DemoReading) }, [])
  const big = Number(q.get('big') ?? 0)
  const source = useMemo(() => (fx ? build(fx, { digest: q.get('digest') === '1', old: q.get('old') === '1', big: big === 1 ? 5_000_000 : big > 1 ? big : 0, reading: q.get('reading') }) : null), [fx, big])
  const [marks, setMarks] = useState<ReadonlyMap<number, string>>(new Map())
  const notes: OptAnnotations = useMemo(() => ({
    bookmarks: marks,
    toggle: (l) => setMarks((o) => { const n = new Map(o); if (n.has(l)) n.delete(l); else n.set(l, ''); return n }),
    setNote: (l, t) => setMarks((o) => new Map(o).set(l, t)),
    remove: (l) => setMarks((o) => { const n = new Map(o); n.delete(l); return n }),
  }), [marks])
  const goTo = q.get('node') || q.get('line') ? { node: q.get('node') ?? undefined, line: q.get('line') ? Number(q.get('line')) : undefined } : undefined
  return (
    <div style={{ display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)', blockSize: '100dvh' }}>
      <div className="harness" style={{ display: 'flex', gap: '1rem', alignItems: 'center', padding: '0.4rem 1rem', borderBlockEnd: '1px solid var(--hairline)', background: 'var(--surface-raised)', fontSize: 'var(--text-sm)' }}>
        <b>mtkprof</b><span>dump reader, dev harness</span>
        <button type="button" id="h-remount" className="quiet" onClick={() => setShown((v) => !v)}>{shown ? 'unmount the view' : 'mount it again'}</button>
        <span style={{ marginInlineStart: 'auto', color: 'var(--ink-3)' }}>{source?.file.name ?? 'loading the fixture'}</span>
      </div>
      <div style={{ minBlockSize: 0 }}>
        {shown && source && <DiagView source={source} annotations={notes} goTo={goTo} onOpenAs10046={() => console.info('open as SQL trace')} />}
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<StrictMode><Harness /></StrictMode>)
