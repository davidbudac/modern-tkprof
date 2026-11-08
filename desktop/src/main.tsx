import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@lib/styles/fonts.css'
import '@lib/styles/tokens.css'
import '@lib/styles/base.css'
import '@lib/styles/app.css'
import './app.css'
import '@lib/styles/motion.css'
import { installSlidingPills } from '@lib/components/motion'
import { setFileHost } from '@lib/shell/files'
import { App } from './App'
import { routeExternalLinks } from './platform'
import { pickTextFile, saveAs } from './files'

routeExternalLinks()
installSlidingPills()
// the lib's Save / Open (the Import names dialog): the native dialogs
setFileHost({
  save: async (name, text, title) => (await saveAs(name, text, [{ name: name.split('.').pop()?.toUpperCase() ?? 'File', extensions: [name.split('.').pop() ?? 'txt'] }], title)) !== null,
  open: (exts, title) => pickTextFile([{ name: 'Text', extensions: exts }, { name: 'All files', extensions: ['*'] }], title),
})

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
