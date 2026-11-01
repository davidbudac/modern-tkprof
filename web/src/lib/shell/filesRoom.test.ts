import { describe, expect, it } from 'vitest'
import type { Store } from '../state/store'
import { filesFolded, filesNeedRoom, markFilesFolded } from './filesRoom'

const rem = 16
// the lib's defaults at 1440: files 22vw, details 34vw (clamped)
const files = 304, inspector = 490

describe('filesNeedRoom', () => {
  it('folds when the three columns leave the view under 40rem', () => {
    const need = files + 40 * rem + inspector // 1434
    expect(filesNeedRoom(need - 1, files, inspector, rem, false)).toBe(true)
    expect(filesNeedRoom(need, files, inspector, rem, false)).toBe(false)
    expect(filesNeedRoom(1100, 270, 408, rem, false)).toBe(true) // 1024 to 1100 px windows
    expect(filesNeedRoom(1600, files, inspector, rem, false)).toBe(false)
  })
  it('has nothing to fold once the panes stack', () => {
    expect(filesNeedRoom(900, files, inspector, rem, true)).toBe(false)
  })
  it('follows the root font size', () => {
    expect(filesNeedRoom(1500, files, inspector, 20, false)).toBe(true)
  })
})

describe('markFilesFolded', () => {
  it('is per store and can be cleared', () => {
    const a = {} as Store, b = {} as Store
    expect(filesFolded(a)).toBe(false)
    markFilesFolded(a, true)
    expect(filesFolded(a)).toBe(true)
    expect(filesFolded(b)).toBe(false)
    markFilesFolded(a, false)
    expect(filesFolded(a)).toBe(false)
  })
})
