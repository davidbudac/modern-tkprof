import { describe, expect, it } from 'vitest'
import { bindCell, decodeAsText } from './inspecttext'

describe('decodeAsText', () => {
  it('lists label: value (raw) per field', () => {
    const t = decodeAsText({ title: 'EXEC', kindLabel: 'Call', note: 'n', fields: [{ label: 'CPU', value: '174 µs', raw: 'c=174' }, { label: 'Depth', value: '0' }] }, 12)
    expect(t).toBe('Line 12 · Call · EXEC\nCPU: 174 µs (c=174)\nDepth: 0\nn')
  })
})

describe('bindCell', () => {
  const b = { value: 'x', isNull: false, noDef: false, dump: false }
  it('names the special cases', () => {
    expect(bindCell(b)).toBe('x')
    expect(bindCell({ ...b, isNull: true })).toBe('NULL')
    expect(bindCell({ ...b, noDef: true })).toBe('(same as previous)')
    expect(bindCell({ ...b, dump: true, value: '' })).toBe('(memory dump)')
  })
})
