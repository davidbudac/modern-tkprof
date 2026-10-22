import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/base.css'
import './styles/app.css'
import { App } from './app/App'
import { loadInitial } from './data/load'
import { setState } from './app/store'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

loadInitial()
  .then((doc) => setState({ doc, loading: false, error: null }))
  .catch((e) => setState({ loading: false, error: String(e) }))
