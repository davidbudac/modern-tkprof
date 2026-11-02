import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@lib/styles/fonts.css'
import '@lib/styles/tokens.css'
import '@lib/styles/base.css'
import '@lib/styles/app.css'
import './app.css'
import './motion.css'
import { App } from './App'
import { routeExternalLinks } from './platform'

routeExternalLinks()

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
