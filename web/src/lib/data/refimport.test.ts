import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { engineRefImporter, previewPaste, RefError } from './refimport'
import type { ApiClient } from './client'
import { createStore } from '../state/store'
import { makeDoc } from './testdoc'
import { LocalSource, RemoteSource } from './source'

// what the names script printed on the lab (internal/ref/testdata; the Go parser's tests read the same files)
const lab = (name: string) => readFileSync(fileURLToPath(new URL(`../../../../internal/ref/testdata/${name}`, import.meta.url)), 'utf8')

describe('previewPaste', () => {
  it('counts what the engine will read: SYSDBA', () => {
    const text = lab('paste_io_waits_sysdba.txt')
    const p = previewPaste(text)
    expect({ objects: p.objects, files: p.files, users: p.users, plans: p.plans, header: p.header, end: p.end, tables: p.tables })
      .toEqual({ objects: 7, files: 3, users: 2, plans: 6, header: true, end: true, tables: false })
    expect(p.notes).toContain('plan 06nvwn223659v: no plan found')
    expect(p.notes.length).toBe(text.split('\n').filter((l) => l.startsWith('note,')).length)
  })

  it('a user without the DBA_ views: the notes, no plans from privilege messages', () => {
    const p = previewPaste(lab('paste_io_waits_mtk.txt'))
    expect([p.objects, p.files, p.users, p.plans]).toEqual([5, 0, 2, 0])
    expect(p.notes[0]).toBe('objects: ORA-00942: table or view does not exist; read ALL_OBJECTS: only the objects this user can see')
  })

  it('cut off, echoed, CRLF; tables; nothing', () => {
    const cut = previewPaste('SQL> declare\r\n  2  put(1);\r\nmtkprof-ref 1\r\n  obj,5,,"A","B,""C","","TABLE"\r\nfile,"/x.dbf","T","TEMPFILE",203\r\n')
    expect([cut.objects, cut.files, cut.header, cut.end]).toEqual([1, 1, true, false])
    expect(previewPaste('"OBJECT_ID","OWNER","OBJECT_NAME"\n5,"A","B"\n').tables).toBe(true)
    const none = previewPaste('select 1 from dual;\n')
    expect([none.objects + none.files + none.users + none.plans, none.tables]).toEqual([0, false])
  })
})

describe('engineRefImporter', () => {
  const fake = (answer: (path: string, init?: RequestInit) => Response) => {
    const calls: { path: string; init?: RequestInit }[] = []
    const client: ApiClient = { base: 'http://e/s/1', fetch: async (path, init) => { calls.push({ path, init }); return answer(path, init) } }
    return { calls, refs: engineRefImporter(client) }
  }

  it('calls the session routes', async () => {
    const { calls, refs } = fake(() => new Response('{}', { status: 200 }))
    await refs.status()
    await refs.script(false)
    await refs.script(true)
    await refs.paste('mtkprof-ref 1')
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.path}`)).toEqual(['GET /api/ref', 'GET /api/ref/script', 'GET /api/ref/script?plans=true', 'POST /api/ref/paste'])
    expect(JSON.parse(String(calls[3].init?.body))).toEqual({ text: 'mtkprof-ref 1' })
  })

  it('an error is the envelope message with the status', async () => {
    const { refs } = fake(() => new Response(JSON.stringify({ error: { code: 'bad_request', message: 'no names in the pasted text' } }), { status: 400 }))
    const e = await refs.paste('x').catch((x: unknown) => x)
    expect(e).toBeInstanceOf(RefError)
    expect([(e as RefError).status, (e as RefError).message]).toEqual([400, 'no names in the pasted text'])
    const { refs: serve } = fake(() => new Response('404 page not found\n', { status: 404 }))
    expect(((await serve.status().catch((x: unknown) => x)) as RefError).status).toBe(404)
  })

  it('a served document has an importer, a document on its own none', async () => {
    const doc = await makeDoc([])
    expect(new LocalSource(doc).refs).toBeNull()
    expect(new RemoteSource(doc, { base: '', fetch: async () => new Response('{}') }).refs).not.toBeNull()
  })
})

describe('the Import names flag', () => {
  it('stays across a newer document of the trace, not across another trace', async () => {
    const store = createStore()
    const doc = await makeDoc([])
    store.setLoaded({ doc, compare: null })
    store.actions.openRefImport()
    store.swapDoc({ doc: await makeDoc([]), compare: null })
    expect(store.getState().refImport).toBe(true)
    store.setLoaded({ doc: await makeDoc([]), compare: null })
    expect(store.getState().refImport).toBe(false)
    store.actions.openRefImport()
    store.actions.closeRefImport()
    expect(store.getState().refImport).toBe(false)
  })
})
