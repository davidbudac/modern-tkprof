import { useEffect, useState } from 'react'
import { NoReading, type DiagNode, type DiagReading, type DiagSource } from '../../data/diag'
import { Shimmer } from '../../components/motion'
import { readingView } from './readings'

type St = { id: string; state: 'loading' } | { id: string; state: 'ok'; reading: DiagReading } | { id: string; state: 'none'; omitted: boolean } | { id: string; state: 'error'; message: string }

/** What a source answered for a node, kept per source so that going back to a node (or to Reading from Text) asks nothing. */
const answers = new WeakMap<DiagSource, Map<string, Promise<DiagReading>>>()

function readingOf(source: DiagSource, id: string): Promise<DiagReading> {
  let m = answers.get(source)
  if (!m) { m = new Map(); answers.set(source, m) }
  let p = m.get(id)
  if (!p) {
    p = source.reading(id)
    m.set(id, p)
    p.catch(() => { if (m.get(id) === p) m.delete(id) }) // a failure is asked again; a node without a reading is asked again too (cheap)
  }
  return p
}

/**
 * The centre in Reading mode: the reading of a node, asked of the source when the node is selected, shown by the component registered for its kind
 * (`readings/registry.ts`). A kind nobody has registered says so and leaves the text to read.
 */
export function ReadingHost({ node, source, goLine, selectNode }: { node: DiagNode; source: DiagSource; goLine(line: number): void; selectNode(id: string): void }) {
  const kind = node.reading
  const View = kind ? readingView(kind) : undefined
  const [st, setSt] = useState<St>({ id: node.id, state: 'loading' })
  useEffect(() => {
    if (!View) return
    let live = true
    setSt({ id: node.id, state: 'loading' })
    readingOf(source, node.id).then(
      (reading) => { if (live) setSt({ id: node.id, state: 'ok', reading }) },
      (e: unknown) => { if (live) setSt(e instanceof NoReading ? { id: node.id, state: 'none', omitted: e.omitted } : { id: node.id, state: 'error', message: e instanceof Error ? e.message : String(e) }) },
    )
    return () => { live = false }
  }, [source, node.id, View])

  if (!kind) return <p className="dg-reading-note"><b>No reading for this part.</b> It is shown as text only.</p>
  if (!View) {
    return (
      <p className="dg-reading-note"><b>This version has no view for this reading.</b> The part has a reading of kind <code>{kind}</code>; read it as Text, from the switch above.</p>
    )
  }
  if (st.id !== node.id || st.state === 'loading') return <p className="dg-reading-note"><Shimmer>Loading the reading…</Shimmer></p>
  if (st.state === 'none' && st.omitted) {
    return (
      <p className="dg-reading-note"><b>This reading is not in this report.</b> The report keeps the readings of the first parts of the file only, to stay small. Open the file with <code>mtkprof serve</code> or the desktop app to see it.</p>
    )
  }
  if (st.state === 'none') return <p className="dg-reading-note"><b>No reading for this part.</b> The engine has none for it; it is shown as text only.</p>
  if (st.state === 'error') return <p className="dg-reading-note dg-err" role="alert">Could not read the reading: {st.message}</p>
  return <View node={node} reading={st.reading} source={source} goLine={goLine} selectNode={selectNode} />
}
