import { describe, expect, it } from 'vitest'
import { mcpAddCommand } from './McpSection'

describe('mcpAddCommand', () => {
  it('falls back to mtkprof on PATH outside the app, with the bind setting', () => {
    expect(mcpAddCommand('/Applications/mtkprof.app/Contents/MacOS/mtkprof-engine', 'mask')).toBe('claude mcp add -s user mtkprof -- mtkprof mcp')
    expect(mcpAddCommand(undefined, 'keep')).toBe('claude mcp add -s user mtkprof -- mtkprof mcp -binds keep')
  })
})
