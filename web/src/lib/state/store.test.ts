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
