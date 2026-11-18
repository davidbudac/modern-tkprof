import { useEffect, useMemo, useRef } from 'react'
import type { TraceDoc } from '../../data/doc'
import type { RawDump } from '../../data/diag'
import { outlineStoreOf } from '../../data/diagoutline'
import { diagSourceOf } from '../../data/diagsource'
import { storeAnnotations } from '../../data/opt'
import { useActions, useClient, useStore, useStoreApi } from '../../state/session'
import type { Store } from '../../state/store'
import { useOptLinks } from '../../shell/optlinks'
import { DiagView } from './DiagView'

/** The seq of the last `dumpGo` request a mounted view has taken, per tab: a view that mounts again (a tab switch) starts where it was, not at the old request. */
const taken = new WeakMap<Store, number>()

/**
 * The diag document in a shell: the view over its source (the document's digest, else the session's routes), the tab's bookmarks and notes
 * (`State.bookmarks` of input file 0: the lines of the file), the requests to show a node or a line (`State.dumpGo`), "Open as SQL trace", and the
 * document's notes above it. Fills the height it is given.
 */
export function DiagTab({ doc }: { doc: TraceDoc & { dump: RawDump } }) {
  const store = useStoreApi()
  const client = useClient()
  const actions = useActions()
  const links = useOptLinks()
  const bookmarks = useStore((s) => s.bookmarks)
  const req = useStore((s) => s.dumpGo)
  const source = useMemo(() => diagSourceOf(doc, client), [doc, client])
  const outline = useMemo(() => outlineStoreOf(source), [source])
  const annotations = useMemo(() => storeAnnotations(bookmarks, 0, actions, (line) => outline.nodeAt(line)?.title ?? ''), [bookmarks, actions, outline])
  // a request made before this view mounted (a jump from another tab, a deep link) is taken once; one made while it is mounted, when it comes
  const since = useRef(taken.get(store) ?? 0)
  const goTo = req && req.seq > since.current ? req : undefined
  useEffect(() => { if (req) taken.set(store, req.seq) }, [store, req])
  // the notes of the file; the engine's "spill mode" note is about calls, waits and binds, of which a dump file has none
  const notes = (doc.diag.notes ?? []).filter((n) => !/^spill mode:/.test(n))
  const openAs = links.openAs
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
        <DiagView source={source} annotations={annotations} goTo={goTo} onOpenAs10046={openAs ? () => openAs('10046') : undefined} />
      </div>
    </div>
  )
}
