import { useEffect, useMemo, useRef } from 'react'
import type { TraceDoc } from '../../data/doc'
import type { RawOpt } from '../../data/types'
import { lineLabel } from '../../data/optdoc'
import { storeAnnotations } from '../../data/opt'
import { optSourceOf } from '../../data/optsource'
import { planVizBase } from '../../data/planviz'
import { useActions, useClient, useStore, useStoreApi } from '../../state/session'
import type { Store } from '../../state/store'
import { useOptLinks } from '../../shell/optlinks'
import { OptView } from './OptView'

/** The seq of the last `optGo` request a mounted view has taken, per tab: a view that mounts again (a tab switch) starts where it was, not at the old request. */
const taken = new WeakMap<Store, number>()

/**
 * The 10053 document in a shell: the view over its source (the document's digest, else the session's routes), the tab's bookmarks and notes
 * (`State.bookmarks` of input file 0: the lines of the file), the requests to open a dump or a line (`State.optGo`), the 10046 link, and
 * the document's notes above it. Fills the height it is given.
 */
export function OptTab({ doc }: { doc: TraceDoc & { opt: RawOpt } }) {
  const store = useStoreApi()
  const client = useClient()
  const actions = useActions()
  const links = useOptLinks()
  const bookmarks = useStore((s) => s.bookmarks)
  const req = useStore((s) => s.optGo)
  const source = useMemo(() => optSourceOf(doc, client), [doc, client])
  const file = doc.opt.file
  const annotations = useMemo(() => storeAnnotations(bookmarks, 0, actions, (line) => lineLabel(file, line)), [bookmarks, actions, file])
  // a request made before this view mounted (a jump from another tab, a deep link) is taken once; one made while it is mounted, when it comes
  const since = useRef(taken.get(store) ?? 0)
  const goTo = req && req.seq > since.current ? req : undefined
  useEffect(() => { if (req) taken.set(store, req.seq) }, [store, req])
  const notes = doc.diag.notes ?? []
  const planViz = useMemo(() => ({ base: planVizBase(doc) }), [doc])
  return (
    <div className="opt-tab" style={{ display: 'grid', gridTemplateRows: notes.length ? 'auto minmax(0, 1fr)' : 'minmax(0, 1fr)', blockSize: '100%', minBlockSize: 0 }}>
      {notes.length > 0 && (
        <div className="opt-notes" aria-label="Notes on this file">
          {notes.map((n, i) => {
            const act = links.noteAction?.(n)
            return (
              <p key={i} className="opt-note">
                <span>{n}</span>
                {act && <button type="button" className="quiet" title={act.title} onClick={act.run}>{act.label}</button>}
              </p>
            )
          })}
        </div>
      )}
      <div style={{ minBlockSize: 0 }}>
        <OptView source={source} annotations={annotations} planViz={planViz} link10046={links.to10046} goTo={goTo} onDump={actions.setOptDump} />
      </div>
    </div>
  )
}
