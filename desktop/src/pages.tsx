import type { ReactNode } from 'react'
import { ConnectionsView } from './connections'
import { SettingsView } from './settings/SettingsView'
import { TracingView } from './tracing/TracingView'
import { BookIcon, ConnectionsIcon, SettingsIcon } from './ui/icons'

/**
 * The desktop pages next to the session tabs (top right of the frame), in order. A page is shown
 * with `workspace.go({kind: 'page', id})`; S6 adds Connections here, S8 Annotations.
 */
export interface Page {
  id: string
  label: string
  /** the nav shows the icon alone; the label is its name and tooltip */
  icon: ReactNode
  render: () => ReactNode
  /** routable but not in the nav */
  hidden?: true
}

export const pages: Page[] = [
  { id: 'tracing', label: 'Make a 10046 trace', icon: <BookIcon />, render: () => <TracingView /> },
  { id: 'connections', label: 'Connections', icon: <ConnectionsIcon />, render: () => <ConnectionsView /> },
  { id: 'settings', label: 'Settings', icon: <SettingsIcon />, render: () => <SettingsView /> },
]
