import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FilterBar } from './FilterBar'
import { WindowBar } from './WindowBar'
import { createSession, SessionContext } from '../state/session'
import { makeDoc } from '../data/testdoc'

describe('window controls', () => {
  it('uses the dedicated bar on Overview and Timeline, retaining the global window chip elsewhere', async () => {
    const doc = await makeDoc([])
    const session = createSession()
    session.store.setState({ doc, window: { startTim: 1100, endTim: 1200 } })
    const render = () => renderToStaticMarkup(createElement(SessionContext.Provider, { value: session }, createElement(FilterBar, { doc })))
    for (const view of ['overview', 'timeline'] as const) {
      session.store.actions.setView(view)
      expect(render()).not.toContain('Remove filter: time window')
    }
    for (const view of ['statements', 'waits', 'lines', 'sessions'] as const) {
      session.store.actions.setView(view)
      expect(render()).toContain('Remove filter: time window')
      expect(render()).toContain('<b>Window</b>')
    }
  })

  it('retains Lines, Zoom, Statement and one clear action in the dedicated bar', async () => {
    const doc = await makeDoc([])
    const session = createSession()
    const window = { startTim: 1100, endTim: 1200 }
    Object.defineProperty(doc, 'slice', { value: {} })
    session.store.setState({ doc, window, block: { ...window, stmt: 0 }, linesApi: true })
    const html = renderToStaticMarkup(createElement(SessionContext.Provider, { value: session }, createElement(WindowBar, { doc, zoom: true })))
    expect(html).toContain('>Lines</button>')
    expect(html).toContain('>Zoom</button>')
    expect(html).toContain('>Statement</button>')
    expect(html.match(/aria-label="Clear time window"/g)).toHaveLength(1)
  })
})
