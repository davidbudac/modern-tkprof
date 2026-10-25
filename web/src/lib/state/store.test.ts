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
