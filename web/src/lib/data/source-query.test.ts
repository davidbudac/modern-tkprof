import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LocalSource, RemoteSource, useSourceQuery } from './source'
import { makeDoc } from './testdoc'
import type { ApiClient } from './client'

describe('source query readiness', () => {
  it('marks a remote query pending before its first answer, rather than treating the initial key as answered', async () => {
    const doc = await makeDoc([])
    const source = new RemoteSource(doc, {} as ApiClient)
    let ran = false
    function Probe() {
      const q = useSourceQuery(source, 'profile:window', () => { ran = true; return Promise.resolve(12) })
      return createElement('output', null, JSON.stringify(q))
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain('&quot;loading&quot;:true')
    expect(ran).toBe(false) // remote work starts in the effect, after the render
  })

  it('answers a local query in the render without a pending state', async () => {
    const doc = await makeDoc([])
    function Probe() {
      const q = useSourceQuery(new LocalSource(doc), 'local', () => 12)
      return createElement('output', null, JSON.stringify(q))
    }
    expect(renderToStaticMarkup(createElement(Probe))).toContain('&quot;data&quot;:12,&quot;loading&quot;:false')
  })
})
