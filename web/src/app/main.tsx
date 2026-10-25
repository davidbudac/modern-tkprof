import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@lib/styles/fonts.css'
import '@lib/styles/tokens.css'
import '@lib/styles/base.css'
import '@lib/styles/app.css'
import { SessionProvider, createClient, createSession, followLive, loadInitial, probeLines, probeLinesApi } from '@lib'
import { App } from './App'
import { startUrlSync } from './urlstate'

const client = createClient('')
const session = createSession(client)
const { store } = session

createRoot(document.getElementById('root')!).render(<StrictMode><SessionProvider session={session}><App /></SessionProvider></StrictMode>)

startUrlSync(store)
void probeLines(client).then((linesAvailable) => store.setState({ linesAvailable }))
// the Lines tab needs the engine's line endpoints; probe before the document opens, so a #view=lines link restores
const linesApi = probeLinesApi(client).then((ok) => store.setState({ linesApi: ok }))

loadInitial(client)
  .then(async (l) => { await linesApi; return l })
  .then((l) => {
    if (!l) return store.setState({ doc: null, loading: false, error: null })
    store.setLoaded(l)
    // a live session (`mtkprof follow -serve`, an engine follow session): keep the document on the server's latest snapshot
    if (l.rev !== undefined && l.live === 'live') followLive({ store, client: l.client ?? client }, l.rev)
  })
  .catch((e) => store.setState({ loading: false, error: String(e) }))
