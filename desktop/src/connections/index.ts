// Connections (S6): definitions without secrets, the Connections view, remote browser, DB
// panel, jobs dock. Integration: wrap the workspace in <ConnectionsProvider bridge={...}>,
// render <ConnectionsView/> for the "Connections" nav entry and <JobsPanel/> once.
export { ConnectionsProvider, useConnections, useConnectionsOptional } from './ConnectionsProvider'
export type { Connections, WorkspaceBridge, TeamState, Notice } from './ConnectionsProvider'
export { ConnectionsView } from './ConnectionsView'
export { JobsPanel } from './JobsPanel'
export type { Connection, Entry } from './model'
