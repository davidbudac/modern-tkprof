import { describe, expect, it } from 'vitest'
import { baseName, dirOf, dirsOf, setSummary, setTooltip, titleOf } from './traceSet'

describe('titleOf', () => {
  it('names one file or folder', () => {
    expect(titleOf(['/u/trace/a_ora_1.trc'])).toBe('a_ora_1.trc')
    expect(titleOf(['/u/trace/'])).toBe('trace')
    expect(titleOf(['C:\\traces\\dir\\'])).toBe('dir')
  })
  it('counts the others of a set', () => {
    expect(titleOf(['/u/a.trc', '/u/b.trc'])).toBe('a.trc (+1)')
    expect(titleOf(['/u/a.trc', '/u/b.trc', '/v/c.trc'])).toBe('a.trc (+2)')
    expect(titleOf(['/u/dir', '/u/x.trc'])).toBe('dir (+1)')
  })
  it('has a title for no paths', () => {
    expect(titleOf([])).toBe('trace')
  })
  it('baseName of a bare name', () => {
    expect(baseName('a.trc')).toBe('a.trc')
  })
})

describe('dirsOf', () => {
  const files = [{ path: '/u/set/a.trc' }, { path: '/u/set/b.trc' }]
  it('marks a requested folder the engine expanded', () => {
    expect(dirsOf(['/u/set'], files)).toEqual(['/u/set'])
    expect(dirsOf(['/u/set/'], files)).toEqual(['/u/set/'])
  })
  it('does not mark files, followed chains or a prefix sibling', () => {
    expect(dirsOf(['/u/set/a.trc'], files)).toEqual([])
    expect(dirsOf(['/u/se'], files)).toEqual([])
    expect(dirsOf(['/u/set'], [])).toEqual([])
  })
  it('compares Windows paths by separator and case', () => {
    expect(dirsOf(['C:\\Traces\\Set'], [{ path: 'c:/traces/set/a.trc' }])).toEqual(['C:\\Traces\\Set'])
  })
  it('marks only the folder of a mixed set', () => {
    expect(dirsOf(['/u/x.trc', '/u/set'], [{ path: '/u/x.trc' }, ...files])).toEqual(['/u/set'])
  })
})

describe('setTooltip', () => {
  it('lists the paths when nothing was added', () => {
    expect(setTooltip(['/u/a.trc', '/u/b.trc'], [{ name: 'a.trc' }, { name: 'b.trc' }])).toBe('/u/a.trc\n/u/b.trc')
    expect(setTooltip(['/u/a.trc'])).toBe('/u/a.trc')
  })
  it('adds the file count when the engine opened more than were given', () => {
    expect(setTooltip(['/u/set'], [{ name: 'a.trc' }, { name: 'b.trc' }, { name: 'c.trc' }])).toBe('/u/set\n\n3 files: a.trc, b.trc, c.trc')
  })
  it('cuts a long list', () => {
    const files = Array.from({ length: 12 }, (_, i) => ({ name: `f${i}.trc` }))
    expect(setTooltip(['/u/set'], files)).toBe('/u/set\n\n12 files: f0.trc, f1.trc, f2.trc, f3.trc, f4.trc, f5.trc, f6.trc, f7.trc, …')
  })
})

describe('dirOf', () => {
  it('is the folder of a file or folder', () => {
    expect(dirOf('/u/trace/a.trc')).toBe('/u/trace')
    expect(dirOf('/u/trace/')).toBe('/u')
    expect(dirOf('C:\\traces\\a.trc')).toBe('C:\\traces')
  })
  it('keeps the root', () => {
    expect(dirOf('/a.trc')).toBe('/')
    expect(dirOf('C:\\a.trc')).toBe('C:\\')
  })
  it('is empty for a bare name', () => {
    expect(dirOf('a.trc')).toBe('')
  })
})

describe('setSummary', () => {
  it('shows the path of a single entry until the file count is known', () => {
    expect(setSummary(['/u/a.trc'])).toBe('/u/a.trc')
  })
  it('gives the count and the folder of a single file', () => {
    expect(setSummary(['/u/19c/plan.trc'], 1)).toBe('1 file · /u/19c')
    expect(setSummary(['/u/19c/a.trc'], 3)).toBe('3 files · /u/19c')
  })
  it('says "in" for a folder', () => {
    expect(setSummary(['/u/set'], 3, ['/u/set'])).toBe('3 files in /u/set')
    expect(setSummary(['/u/set'], 1, ['/u/set'])).toBe('1 file in /u/set')
  })
  it('gives the count alone for a set, the path count while unknown', () => {
    expect(setSummary(['/u/a.trc', '/u/b.trc'], 2)).toBe('2 files')
    expect(setSummary(['/u/a.trc', '/u/b.trc'])).toBe('2 paths')
  })
})
