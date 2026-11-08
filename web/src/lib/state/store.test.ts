import { describe, expect, it } from 'vitest'
import { activeBlock, createStore } from './store'

describe('SQL detail call-type filter', () => {
  it('marks several types, preserves the selection across statements, and clears the last mark', () => {
    const { getState, actions } = createStore()
    actions.toggleStatementCallType('fetch')
    actions.pickStmt(1)
    expect(getState().statementCallTypes).toEqual(new Set(['fetch']))
    actions.toggleStatementCallType('parse')
    expect(getState().statementCallTypes).toEqual(new Set(['fetch', 'parse']))
    actions.toggleStatementCallType('fetch')
    actions.toggleStatementCallType('parse')
    expect(getState().statementCallTypes).toBeNull()
  })

  it('clears through the filter action and when opening a new trace', () => {
    const store = createStore()
    store.actions.toggleStatementCallType('fetch')
    store.actions.setStatementCallTypes(null)
    expect(store.getState().statementCallTypes).toBeNull()
    store.actions.toggleStatementCallType('fetch')
    store.setLoaded({ doc: {} as never, compare: null })
    expect(store.getState().statementCallTypes).toBeNull()
  })
})

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

  it('openLinesAt carries keepSelection for that move only', () => {
    const { getState, actions } = createStore()
    actions.openLinesAt(0, 40, { keepSelection: true })
    expect(getState().linesView).toEqual({ file: 0, line: 40, seq: 1, keep: true })
    actions.setLinesLine(0, 41) // a click inside the view
    expect(getState().linesView.keep).toBeUndefined()
    actions.openLinesAt(0, 40, { keepSelection: true })
    actions.openLinesAt(0, 50) // another deep link re-picks as before
    expect(getState().linesView).toEqual({ file: 0, line: 50, seq: 3 })
    expect(getState().linesView.keep).toBeUndefined()
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

describe('lane block', () => {
  it('pickBlock sets the window, the block and the statement without leaving the view', () => {
    const { getState, actions } = createStore()
    actions.selectEvent(3)
    actions.pickBlock(2, 100, 250)
    const s = getState()
    expect(s.view).toBe('overview')
    expect(s.window).toEqual({ startTim: 100, endTim: 250 })
    expect(s.block).toEqual({ stmt: 2, startTim: 100, endTim: 250 })
    expect(s.selection).toEqual({ stmt: 2, event: null, call: null, exec: null })
    expect(activeBlock(s)).toBe(s.block)
  })

  it('is active only while the window is exactly its interval', () => {
    const { getState, actions } = createStore()
    expect(activeBlock(getState())).toBeNull()
    actions.pickBlock(1, 10, 20)
    expect(activeBlock(getState())).not.toBeNull()
    actions.selectStmt(1) // opening the statement keeps the window, so the statement stays filtered to the block
    expect(getState().view).toBe('statements')
    expect(activeBlock(getState())).toEqual({ stmt: 1, startTim: 10, endTim: 20 })
    expect(getState().window).toEqual({ startTim: 10, endTim: 20 })
    actions.setWindow({ startTim: 10, endTim: 21 }) // a new window is not the block
    expect(getState().block).toBeNull()
    expect(activeBlock(getState())).toBeNull()
    actions.pickBlock(1, 10, 20)
    actions.setWindow(null)
    expect(getState().block).toBeNull()
    expect(getState().window).toBeNull()
  })

  it('activeBlock ignores a block whose window was replaced by a plain setState', () => {
    const { getState, setState, actions } = createStore()
    actions.pickBlock(1, 10, 20)
    setState({ window: { startTim: 10, endTim: 99 } })
    expect(activeBlock(getState())).toBeNull()
    setState({ window: null })
    expect(activeBlock(getState())).toBeNull()
  })

  it('setLoaded, setSide and openStmtOn drop it', () => {
    const store = createStore()
    const { getState, actions } = store
    const doc = {} as never
    store.setLoaded({ doc, compare: null })
    actions.pickBlock(1, 10, 20)
    store.setLoaded({ doc, compare: null })
    expect(getState().block).toBeNull()
    const both = { a: doc, b: doc, diff: { statements: [] } } as never
    store.setLoaded({ doc, compare: both })
    actions.pickBlock(1, 10, 20)
    actions.setSide('b')
    expect(getState().block).toBeNull()
    expect(getState().window).toBeNull()
    actions.setSide('a')
    actions.pickBlock(1, 10, 20)
    actions.openStmtOn('b', 0)
    expect(getState().block).toBeNull()
    expect(getState().window).toBeNull()
    store.setLoaded({ doc, compare: null })
    actions.pickBlock(1, 10, 20)
    actions.openStmtOn('a', 0)
    expect(getState().block).toBeNull()
  })
})

describe('lanes zoom', () => {
  const w = (startTim: number, endTim: number) => ({ startTim, endTim })

  it('zoomLanes pushes, the range on top again changes nothing, zoomOutLanes pops and resetLanesZoom empties', () => {
    const { getState, actions } = createStore()
    expect(getState().lanesZoom).toEqual([])
    actions.zoomLanes(w(10, 90))
    actions.zoomLanes(w(10, 90))
    expect(getState().lanesZoom).toEqual([w(10, 90)])
    actions.zoomLanes(w(20, 30))
    actions.zoomLanes(w(10, 90)) // not the top: pushed
    expect(getState().lanesZoom).toEqual([w(10, 90), w(20, 30), w(10, 90)])
    actions.zoomOutLanes()
    expect(getState().lanesZoom).toEqual([w(10, 90), w(20, 30)])
    actions.resetLanesZoom()
    expect(getState().lanesZoom).toEqual([])
    actions.zoomOutLanes() // nothing to pop
    expect(getState().lanesZoom).toEqual([])
  })

  it('copies the range, is not a filter, and leaves the window and block alone', () => {
    const { getState, actions } = createStore()
    actions.pickBlock(1, 10, 20)
    const win = getState().window!
    actions.zoomLanes(win)
    expect(getState().lanesZoom[0]).not.toBe(win)
    expect(getState().window).toBe(win)
    expect(getState().block).not.toBeNull()
    actions.setWindow(null) // clearing the window does not zoom out
    expect(getState().lanesZoom).toEqual([w(10, 20)])
  })

  it('setLoaded, setSide and openStmtOn on a comparison reset it; openStmtOn of one trace and swapDoc keep it', () => {
    const store = createStore()
    const { getState, actions } = store
    const doc = {} as never
    store.setLoaded({ doc, compare: null })
    actions.zoomLanes(w(1, 2))
    store.setLoaded({ doc, compare: null })
    expect(getState().lanesZoom).toEqual([])
    actions.zoomLanes(w(1, 2))
    actions.openStmtOn('a', 0)
    expect(getState().lanesZoom).toEqual([w(1, 2)])
    const both = { a: doc, b: doc, diff: { statements: [] } } as never
    store.setLoaded({ doc, compare: both })
    actions.zoomLanes(w(1, 2))
    actions.setSide('b')
    expect(getState().lanesZoom).toEqual([])
    actions.zoomLanes(w(1, 2))
    actions.openStmtOn('a', 0)
    expect(getState().lanesZoom).toEqual([])
  })

  it('survives the next snapshot of a live session', () => {
    const doc = (stmts: number) => ({
      statements: new Array(stmts).fill(null), events: [], cursors: new Array(stmts).fill(null), contexts: [{ fileIdx: 0 }], file: { files: [null] },
    }) as unknown as import('../data/doc').TraceDoc
    const store = createStore()
    store.setLoaded({ doc: doc(2), compare: null })
    store.actions.zoomLanes(w(5, 6))
    const before = store.getState().lanesZoom
    store.swapDoc({ doc: doc(3), compare: null })
    expect(store.getState().lanesZoom).toBe(before)
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

describe('swapDoc (a live session next snapshot)', () => {
  const doc = (stmts: number, events: number, ctxs: number, files: number) => ({
    statements: new Array(stmts).fill(null), events: new Array(events).fill(null), cursors: new Array(stmts).fill(null),
    contexts: new Array(ctxs).fill({ fileIdx: 0 }), file: { files: new Array(files).fill(null) },
  }) as unknown as import('../data/doc').TraceDoc

  it('keeps the view, scope and selection whose ids still exist, and counts the documents', () => {
    const store = createStore()
    store.setLoaded({ doc: doc(3, 2, 2, 1), compare: null })
    const { actions } = store
    actions.selectStmt(2)
    actions.selectEvent(1)
    actions.selectExec({ cursor: 2, execNo: 4 })
    actions.pickBlock(2, 1, 9)
    actions.setContexts(new Set([0, 1]))
    actions.openLinesAt(0, 120)
    const before = store.getState()
    store.swapDoc({ doc: doc(5, 3, 3, 2), compare: null })
    const s = store.getState()
    expect(s.rev).toBe(before.rev + 1)
    expect(s.doc?.statements.length).toBe(5)
    expect(s.view).toBe('lines')
    expect(s.selection).toBe(before.selection) // unchanged: the same object
    expect(s.contexts).toBe(before.contexts)
    expect(s.window).toBe(before.window)
    expect(s.block).toBe(before.block)
    expect(s.linesView).toBe(before.linesView)
  })

  it('drops the ids the new document does not have (a restarted server)', () => {
    const store = createStore()
    store.setLoaded({ doc: doc(5, 3, 3, 2), compare: null })
    store.actions.selectStmt(4)
    store.actions.selectEvent(2)
    store.actions.setContexts(new Set([0, 2]))
    store.actions.setFiles(new Set([1]))
    store.actions.setPivot({ stmt: 4, event: 1 })
    store.actions.openLinesAt(1, 7)
    store.actions.pickBlock(4, 5, 6)
    store.swapDoc({ doc: doc(2, 2, 1, 1), compare: null })
    const s = store.getState()
    expect(s.block).toBeNull() // its statement is gone; the window stays
    expect(s.window).toEqual({ startTim: 5, endTim: 6 })
    expect(s.selection.stmt).toBeNull()
    expect(s.selection.event).toBeNull()
    expect(s.files).toEqual(new Set())
    expect(s.pivot.stmt).toBeNull()
    expect(s.pivot.event).toBe(1)
    expect(s.linesView.file).toBe(0)
  })
})

describe('the I/O map filter and zoom', () => {
  it('showBlocks opens the I/O map (view blocks) filtered; setBlocks changes the filter in place', () => {
    const { getState, actions } = createStore()
    actions.showBlocks({ stmt: 3, event: 7 })
    expect(getState().view).toBe('blocks')
    expect(getState().blocks).toEqual({ stmt: 3, event: 7 })
    actions.setView('statements')
    actions.setBlocks({ event: null })
    expect(getState().view).toBe('statements')
    expect(getState().blocks).toEqual({ stmt: 3, event: null })
    actions.showBlocks()
    expect(getState().blocks).toEqual({ stmt: null, event: null })
  })
  it('zoomIO pushes or replaces; out pops, reset clears; a new window, a link in or another trace clears the stack', () => {
    const { getState, actions } = createStore()
    const a = { range: { startTim: 10, endTim: 20 }, blocks: {} }
    const b = { range: { startTim: 12, endTim: 18 }, blocks: { f12: [{ file: 12, lo: 100, hi: 200 }] } }
    actions.zoomIO(a)
    actions.zoomIO({ range: { startTim: 10, endTim: 20 }, blocks: {} }) // the same again: nothing
    actions.zoomIO(b)
    expect(getState().ioZoom).toEqual([a, b])
    actions.zoomIO({ range: { startTim: 13, endTim: 19 }, blocks: {} }, true) // a pan
    expect(getState().ioZoom.map((z) => z.range?.startTim)).toEqual([10, 13])
    actions.zoomOutIO()
    expect(getState().ioZoom).toEqual([a])
    actions.zoomIO(b)
    actions.resetIOZoom()
    expect(getState().ioZoom).toEqual([])
    actions.zoomIO(a)
    actions.setBlocks({ stmt: 1 })
    expect(getState().ioZoom).toEqual([a]) // a filter chip keeps the zoom
    actions.setWindow({ startTim: 0, endTim: 5 })
    expect(getState().ioZoom).toEqual([])
    actions.zoomIO(a)
    actions.showBlocks({ stmt: 2 })
    expect(getState().ioZoom).toEqual([])
  })
})
