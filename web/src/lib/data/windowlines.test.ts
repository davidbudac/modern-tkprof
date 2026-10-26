import { describe, expect, it } from 'vitest'
import type { ApiClient } from './client'
import type { FileEntry } from './types'
import { makeDoc } from './testdoc'
import { fileInWindow, windowFiles, windowLineRange } from './windowlines'

// makeDoc's files: 0 spans tim 1000-1500 (100 lines), 1 spans 2000-2500 (200 lines), 2 spans 3000-3500 (300 lines)
const win = (startTim: number, endTim: number) => ({ startTim, endTim })

describe('windowFiles', () => {
  it('is the files whose time range overlaps the window, in file order', async () => {
    const doc = await makeDoc([])
    expect(windowFiles(doc, win(1100, 2100), null)).toEqual([0, 1])
    expect(windowFiles(doc, win(1500, 2000), null)).toEqual([0, 1]) // the edges count
    expect(windowFiles(doc, win(2600, 2900), null)).toEqual([]) // between the files
    expect(windowFiles(doc, win(0, 9999), null)).toEqual([0, 1, 2])
  })

  it('leaves out the files outside the file selection', async () => {
    const doc = await makeDoc([])
    expect(windowFiles(doc, win(0, 9999), new Set([1, 2]))).toEqual([1, 2])
    expect(windowFiles(doc, win(1100, 1200), new Set([1, 2]))).toEqual([])
    expect(windowFiles(doc, win(0, 9999), new Set())).toEqual([])
  })

  it('lists the files holding the statement\'s cursors first', async () => {
    const doc = await makeDoc([])
    ;(doc.cursors[1] as { context: number }).context = 3 // statement 1 runs in context 3, file 2
    expect(windowFiles(doc, win(0, 9999), null, 1)).toEqual([2, 0, 1])
    expect(windowFiles(doc, win(0, 9999), null, 0)).toEqual([0, 1, 2])
    expect(windowFiles(doc, win(1100, 2100), null, 1)).toEqual([0, 1]) // its file does not overlap: the others stay
    expect(windowFiles(doc, win(0, 9999), null, 99)).toEqual([0, 1, 2]) // an unknown statement
    expect(windowFiles(doc, win(0, 9999), null, null)).toEqual([0, 1, 2])
  })

  it('is file 0 for a single-file trace, whatever the times', async () => {
    const one: FileEntry = { idx: 0, path: '/t/a.trc', name: 'a.trc', size: 1, lines: 10, firstTim: 1000, lastTim: 2000, firstWallUs: 0, lastWallUs: 0, processPid: '1', instance: '', traceFile: '', px: false, chain: 0, followed: false }
    expect(windowFiles(await makeDoc([], { files: [one] }), win(5000, 6000), null)).toEqual([0])
    expect(windowFiles(await makeDoc([], { files: [] }), win(5000, 6000), null)).toEqual([0])
  })
})

describe('fileInWindow', () => {
  it('needs timed records', () => {
    expect(fileInWindow({ firstTim: 0, lastTim: 0 }, win(0, 100))).toBe(false)
    expect(fileInWindow({ firstTim: 10, lastTim: 20 }, win(20, 30))).toBe(true)
    expect(fileInWindow({ firstTim: 10, lastTim: 20 }, win(21, 30))).toBe(false)
  })
})

describe('windowLineRange', () => {
  /** A server for file 0 (tim 1000-1500, 100 lines) whose record at tim t is line 10 + (t-1000)/10, clamped to the file's records (lines 10-60). */
  function server() {
    const asked: string[] = []
    const client: ApiClient = {
      base: '',
      async fetch(path) {
        asked.push(path)
        const tim = Number(new URL(path, 'http://h').searchParams.get('tim'))
        return new Response(JSON.stringify({ line: Math.min(60, Math.max(10, 10 + Math.floor((tim - 1000) / 10))) }), { headers: { 'content-type': 'application/json' } })
      },
    }
    return { client, asked }
  }

  it('runs from the start\'s line to the line before the first record past the end', async () => {
    const doc = await makeDoc([])
    const { client, asked } = server()
    expect(await windowLineRange(client, doc, 0, win(1100, 1300))).toEqual({ from: 20, to: 39 })
    expect(asked).toEqual(['/api/lines/at?file=0&tim=1100', '/api/lines/at?file=0&tim=1301'])
  })

  it('rounds a fractional window inward', async () => {
    const doc = await makeDoc([])
    const { client, asked } = server()
    expect(await windowLineRange(client, doc, 0, win(1100.4, 1300.7))).toEqual({ from: 20, to: 39 })
    expect(asked).toEqual(['/api/lines/at?file=0&tim=1101', '/api/lines/at?file=0&tim=1301'])
  })

  it('ends at the file\'s last line when the window reaches its last record, and starts at the first record when it began earlier', async () => {
    const doc = await makeDoc([])
    const { client, asked } = server()
    expect(await windowLineRange(client, doc, 0, win(1100, 1500))).toEqual({ from: 20, to: 100 })
    expect(await windowLineRange(client, doc, 0, win(0, 9999))).toEqual({ from: 10, to: 100 })
    expect(asked).toHaveLength(2) // the end needs no request
  })

  it('is null, without asking, when the window does not overlap the file', async () => {
    const doc = await makeDoc([])
    const { client, asked } = server()
    expect(await windowLineRange(client, doc, 0, win(1501, 1600))).toBeNull()
    expect(await windowLineRange(client, doc, 0, win(0, 999))).toBeNull()
    expect(await windowLineRange(client, doc, 7, win(0, 9999))).toBeNull() // no such file
    expect(asked).toEqual([])
  })

  it('is null when the window holds none of the file\'s records', async () => {
    const doc = await makeDoc([])
    const { client } = server()
    expect(await windowLineRange(client, doc, 0, win(1105, 1105))).toBeNull() // starts at line 20, the first record past the end is line 20 too
  })

  it('fails with the server\'s error', async () => {
    const doc = await makeDoc([])
    const client: ApiClient = { base: '', fetch: async () => new Response('boom', { status: 500, statusText: 'Internal Server Error' }) }
    await expect(windowLineRange(client, doc, 0, win(1100, 1300))).rejects.toThrow('500 Internal Server Error: boom')
  })
})
