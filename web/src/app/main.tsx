import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@lib/styles/fonts.css'
import '@lib/styles/tokens.css'
import '@lib/styles/base.css'
import '@lib/styles/app.css'
import { SessionProvider, createClient, createSession, loadInitial, probeLines } from '@lib'
import { App } from './App'
import { startUrlSync } from './urlstate'

const client = createClient('')
const session = createSession(client)
const { store } = session

createRoot(document.getElementById('root')!).render(<StrictMode><SessionProvider session={session}><App /></SessionProvider></StrictMode>)

startUrlSync(store)
void probeLines(client).then((linesAvailable) => store.setState({ linesAvailable }))

loadInitial(client)
  .then((l) => (l ? store.setLoaded(l) : store.setState({ doc: null, loading: false, error: null })))
  .catch((e) => store.setState({ loading: false, error: String(e) }))
