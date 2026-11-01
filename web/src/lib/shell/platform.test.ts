import { describe, expect, it } from 'vitest'
import { isMac, macPlatform } from './platform'

describe('macPlatform', () => {
  it('prefers userAgentData and falls back to platform', () => {
    expect(macPlatform({ userAgentData: { platform: 'macOS' }, platform: 'Win32' })).toBe(true)
    expect(macPlatform({ userAgentData: { platform: '' }, platform: 'MacIntel' })).toBe(true)
    expect(macPlatform({ platform: 'Win32' })).toBe(false)
    expect(macPlatform({ platform: 'Linux x86_64' })).toBe(false)
    expect(macPlatform(undefined)).toBe(false)
  })
  it('is false outside a browser', () => {
    expect(isMac).toBe(false)
  })
})
