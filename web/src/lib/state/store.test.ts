import { describe, expect, it } from 'vitest'
import { createStore } from './store'

describe('Lines view state', () => {
  it('openLinesAt switches to the Lines view, closes the drawer and bumps seq each time', () => {
    const { getState, actions } = createStore()
    actions.openLines(10, 0)
    expect(getState().lineViewer).not.toBeNull()
    actions.openLinesAt(1, 500)
    expect(getState().view).toBe('lines')
    expect(getState().lineViewer).toBeNull()
    expect(getState().linesView).toEqual({ file: 1, line: 500, seq: 1 })
    actions.openLinesAt(1, 500)
    expect(getState().linesView.seq).toBe(2) // the same line again still moves the view
  })

  it('setLinesLine records the selection without asking the view to scroll', () => {
    const { getState, actions } = createStore()
    actions.openLinesAt(0, 7)
    actions.setLinesLine(0, 99)
    expect(getState().linesView).toEqual({ file: 0, line: 99, seq: 1 })
  })

  it('keeps bookmarks sorted, one per line, and relabels on add', () => {
    const { getState, actions } = createStore()
    actions.addBookmark(0, 30, 'b')
    actions.addBookmark(1, 5, 'x')
    actions.addBookmark(0, 10, 'a')
    actions.addBookmark(0, 30, 'b2')
    expect(getState().bookmarks).toEqual([{ file: 0, line: 10, label: 'a' }, { file: 0, line: 30, label: 'b2' }, { file: 1, line: 5, label: 'x' }])
    actions.removeBookmark(0, 10)
    expect(getState().bookmarks.map((b) => b.line)).toEqual([30, 5])
    actions.setBookmarks([])
    expect(getState().bookmarks).toEqual([])
  })
})

describe('annotations', () => {
  const stmt = { sqlId: 'abc', hash: '0011' }
  it('adds, updates (bumping updated), removes and replaces notes; setLoaded clears them', () => {
    const store = createStore()
    const { getState, actions } = store
    expect(getState().annotationsEnabled).toBe(false)
    actions.addAnnotation({ id: 'a', kind: 'statement', note: 'slow', created: 1, updated: 1, stmt })
    actions.addAnnotation({ id: 'b', kind: 'window', note: 'batch', created: 2, updated: 2, from: 10, to: 20 })
    actions.updateAnnotation('a', { note: 'very slow' })
    const a = getState().annotations.find((x) => x.id === 'a')!
    expect(a.note).toBe('very slow')
    expect(a.created).toBe(1)
    expect(a.updated).toBeGreaterThan(1)
    actions.addAnnotation({ ...a, note: 'replaced' })
    expect(getState().annotations.filter((x) => x.id === 'a').map((x) => x.note)).toEqual(['replaced'])
    actions.removeAnnotation('b')
    expect(getState().annotations.map((x) => x.id)).toEqual(['a'])
    actions.setAnnotations([])
    expect(getState().annotations).toEqual([])
    actions.addAnnotation(a)
    store.setLoaded({ doc: {} as never, compare: null })
    expect(getState().annotations).toEqual([])
  })

  it('a bookmark note survives relabelling and an empty note keeps the bookmark', () => {
    const { getState, actions } = createStore()
    actions.setBookmarkNote(0, 12, 'look here', 'PARSING IN CURSOR')
    expect(getState().bookmarks).toMatchObject([{ file: 0, line: 12, label: 'PARSING IN CURSOR', note: 'look here' }])
    actions.addBookmark(0, 12, 'renamed')
    expect(getState().bookmarks).toMatchObject([{ line: 12, label: 'renamed', note: 'look here' }])
    actions.setBookmarkNote(0, 12, '')
    expect(getState().bookmarks).toHaveLength(1)
    expect(getState().bookmarks[0].note).toBeUndefined()
    expect(getState().bookmarks[0].label).toBe('renamed')
  })

  it('setPivot changes the configuration and clears a notice', () => {
    const { getState, actions, setState } = createStore()
    setState({ pivot: { ...getState().pivot, notice: 'x' } })
    actions.setPivot({ fact: 'waits', by: ['event', 'obj'] })
    expect(getState().pivot).toMatchObject({ fact: 'waits', by: ['event', 'obj'], notice: null })
  })
})

describe('file selection', () => {
  it('setFiles normalises, and clears a context selection outside the files', async () => {
    const { makeDoc } = await import('../data/testdoc')
    const doc = await makeDoc([])
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    const { getState, actions } = store
    expect(getState().files).toBeNull()
    actions.setContexts(new Set([0, 2, 3])) // contexts 0 (file 0), 2 (file 1), 3 (file 2)
    actions.setFiles(new Set([0, 2]))
    expect([...getState().files!]).toEqual([0, 2])
    expect([...getState().contexts!].sort()).toEqual([0, 3])
    actions.setFiles(new Set([1]))
    expect(getState().contexts).toBeNull() // nothing left of the selection
    actions.setFiles(new Set([0, 1, 2]))
    expect(getState().files).toBeNull()
  })

  it('scopeOf sends the intersection of the context pick and the files as the context filter, and keeps setContexts working', async () => {
    const { makeDoc } = await import('../data/testdoc')
    const { scopeOf, scopeNarrows, filesPanelOpen } = await import('./store')
    const doc = await makeDoc([])
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    const { getState, actions } = store
    expect(scopeOf(getState()).contexts).toBeNull()
    expect(scopeNarrows(scopeOf(getState()))).toBe(false)
    actions.setContexts(new Set([1, 3]))
    expect([...scopeOf(getState()).contexts!].sort()).toEqual([1, 3])
    actions.setFiles(new Set([0, 1]))
    const sc = scopeOf(getState())
    expect([...sc.contexts!]).toEqual([1]) // contexts of files 0,1 are 0,1,2; picked 1,3 -> 1 (3 was cleared by setFiles)
    expect([...sc.files!].sort()).toEqual([0, 1])
    expect(scopeOf(getState()).contexts).toBe(sc.contexts) // same inputs, same Set (views key on it)
    actions.setContexts(null)
    expect([...scopeOf(getState()).contexts!].sort()).toEqual([0, 1, 2])
    expect(scopeNarrows(scopeOf(getState()))).toBe(true)
    actions.setFiles(new Set())
    expect(scopeOf(getState()).contexts!.size).toBe(0)
    actions.setFiles(null)
    expect(scopeOf(getState()).contexts).toBeNull()
    // the panel is on by default for several files, until the user closes it
    expect(filesPanelOpen(getState())).toBe(true)
    actions.setFilesOpen(false)
    expect(filesPanelOpen(getState())).toBe(false)
  })

  it('a new document starts with every file selected', async () => {
    const { makeDoc } = await import('../data/testdoc')
    const doc = await makeDoc([])
    const store = createStore()
    store.setLoaded({ doc, compare: null })
    store.actions.setFiles(new Set([2]))
    store.setLoaded({ doc, compare: null })
    expect(store.getState().files).toBeNull()
  })
})
