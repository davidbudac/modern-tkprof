import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import { App } from './app/App'
import { loadInitial } from './data/load'
import { setState } from './app/store'
import { startUrlSync } from './app/urlstate'
import { probeLines } from './data/lines'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

startUrlSync()
void probeLines().then((linesAvailable) => setState({ linesAvailable }))

loadInitial()
  .then((doc) => setState({ doc, loading: false, error: null }))
  .catch((e) => setState({ loading: false, error: String(e) }))
