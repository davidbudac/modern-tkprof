import { useMemo, useState, type ReactNode } from 'react'
import {
  NoteEditor, annotationsFile, annotationsMarkdown, dumpOfLine, fmtDur, fmtInt, fmtWall, mergeAnnotations, mergeBookmarks, parseAnnotationsFile, preview,
  resolveExec, resolveStmt, useActions, useStore, type Annotation, type Bookmark, type StmtRef, type TraceDoc,
} from '@lib'
import { pickTextFile, safeFileName, saveAs } from '../../files'
import { DeskMenu } from '../../ui/DeskMenu'
import { PencilIcon, TrashIcon } from '../../ui/icons'
import { traceStem, useCurrentTab } from './useTab'

type Editing = { id: string } | { line: Bookmark } | null

/**
 * The notes of this trace (kept per content identity in `annotations.json`): statements,
 * executions, time windows and bookmarked lines, with jump links, inline edit and delete, and
 * an Export menu (Markdown, JSON) and JSON import.
 */
export function AnnotationsView({ doc }: { doc: TraceDoc }) {
  const actions = useActions()
  const notes = useStore((s) => s.annotations)
  const bookmarks = useStore((s) => s.bookmarks)
  const linesApi = useStore((s) => s.linesApi)
  const tab = useCurrentTab()
  const [editing, setEditing] = useState<Editing>(null)
  const [exportOpen, setExportOpen] = useState(false)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const identity = tab?.identity ?? ''
  const traceName = (doc.file.traceFile || doc.file.path).split(/[\\/]/).pop() || tab?.title || 'trace'
  const base = doc.span.firstTim
  const at = (tim: number) => (doc.wallOffsetUs ? fmtWall(doc.wallOf(tim), doc.tzOffsetMin, { date: true }) : `+${fmtDur(tim - base)}`)
  const stmtText = (r?: StmtRef) => {
    const id = r ? resolveStmt(doc, r) : null
    return id === null ? `\`${r?.sqlId || r?.hash}\` (not in this trace)` : `\`${doc.label(doc.statements[id])}\` ${preview(doc.statements[id].text, 60)}`
  }

  const groups = useMemo(() => {
    const by = (k: Annotation['kind']) => notes.filter((a) => a.kind === k)
    return { statement: by('statement'), execution: by('execution'), window: by('window').sort((a, b) => (a.from ?? 0) - (b.from ?? 0)) }
  }, [notes])
  const total = notes.length + bookmarks.length

  const run = (f: () => Promise<string | null>) =>
    void f().then(
      (text) => text && setMsg({ ok: true, text }),
      (e: unknown) => setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) }),
    )
  const file = () => annotationsFile(identity, traceName, notes, bookmarks)
  const stem = safeFileName(`${traceStem(doc, tab)}-notes`)
  const exportMd = () =>
    run(async () => {
      const md = annotationsMarkdown(file(), { stmtLabel: stmtText, time: at, fileName: (f) => doc.traceFileName(f) || traceName })
      return (await saveAs(`${stem}.md`, md, [{ name: 'Markdown', extensions: ['md'] }], 'Export notes as Markdown')) ? 'Exported as Markdown.' : null
    })
  const exportJson = () =>
    run(async () => ((await saveAs(`${stem}.json`, JSON.stringify(file(), null, 2) + '\n', [{ name: 'JSON', extensions: ['json'] }], 'Export notes as JSON')) ? 'Exported as JSON.' : null))
  const importJson = () =>
    run(async () => {
      const f = await pickTextFile([{ name: 'JSON', extensions: ['json'] }], 'Import notes')
      if (!f) return null
      const r = parseAnnotationsFile(f.text)
      actions.setAnnotations(mergeAnnotations(notes, r.annotations))
      actions.setBookmarks(mergeBookmarks(bookmarks, r.bookmarks))
      const other = r.identity && identity && r.identity !== identity ? ` They were written on another trace (${r.trace || r.identity}); statements match by sql_id and text, lines and windows by number.` : ''
      return `Imported ${r.annotations.length + r.bookmarks.length} from ${f.name} (same id: the newer one kept)${r.skipped ? `; ${r.skipped} entries not understood` : ''}.${other}`
    })

  const edit = (a: Annotation, title: string, extra?: ReactNode) =>
    editing && 'id' in editing && editing.id === a.id ? (
      <NoteEditor draftKey={`annotation:${a.id}`} label={`Note: ${title}`} text={a.note} onSave={(t) => { actions.updateAnnotation(a.id, { note: t }); setEditing(null) }} onCancel={() => setEditing(null)} onDelete={() => { actions.removeAnnotation(a.id); setEditing(null) }}>
        {extra}
      </NoteEditor>
    ) : (
      <Note text={a.note} when={a.updated} onEdit={() => setEditing({ id: a.id })} onDelete={() => actions.removeAnnotation(a.id)} />
    )

  return (
    <section className="section annotations">
      <header>
        <h2>Annotations</h2>
        <span className="hint">
          {total ? `${total} note${total === 1 ? '' : 's'} and bookmarks` : 'no notes yet'} · kept with this trace's content{identity ? ` (${identity.slice(0, 12)}…)` : ''}
        </span>
        <span className="tools actions">
          <DeskMenu label="Export" title={total === 0 ? 'Nothing to export yet' : 'Save the notes and bookmarks of this trace'} open={exportOpen} onOpenChange={setExportOpen}>
            <button onClick={exportMd} disabled={total === 0}>Markdown…</button>
            <button onClick={exportJson} disabled={total === 0}>JSON…</button>
          </DeskMenu>
          <button onClick={importJson}>Import JSON…</button>
        </span>
      </header>
      {msg && <p className={msg.ok ? 'small muted' : 'callout report-error'} role={msg.ok ? 'status' : 'alert'}>{msg.text}</p>}
      {total === 0 && (
        <p className="muted small">
          {doc.opt ? <>Add notes with <b>b</b> (bookmark) on a line of the 10053 view, then the ✎ in its Bookmarks tab.</> : <>Add notes with <b>✎ Add note</b> in a statement, the ✎ column of its executions, <b>✎ Annotate window</b> in the Timeline once a time window is set, and <b>✎ Note</b> or a bookmark in the Trace view.</>}
        </p>
      )}

      {groups.statement.length > 0 && (
        <Group title="Statements">
          {groups.statement.map((a) => {
            const id = a.stmt ? resolveStmt(doc, a.stmt) : null
            return (
              <li key={a.id}>
                <span className="ann-head">
                  {id === null ? <span className="mono muted">{a.stmt?.sqlId || a.stmt?.hash} (not in this trace)</span> : (
                    <><button className="link mono" onClick={() => actions.selectStmt(id)}>{doc.label(doc.statements[id])}</button><span className="muted small clip">{preview(doc.statements[id].text, 90)}</span></>
                  )}
                </span>
                {edit(a, `statement ${a.stmt?.sqlId ?? ''}`)}
              </li>
            )
          })}
        </Group>
      )}

      {groups.execution.length > 0 && (
        <Group title="Executions">
          {groups.execution.map((a) => {
            const r = resolveExec(doc, a)
            return (
              <li key={a.id}>
                <span className="ann-head">
                  {r === null ? <span className="mono muted">{a.stmt?.sqlId || a.stmt?.hash} #{a.execNo} (not in this trace)</span> : (
                    <><button className="link mono" onClick={() => { actions.selectStmt(r.stmt); actions.selectExec({ cursor: r.cursor, execNo: r.execNo }) }}>{doc.label(doc.statements[r.stmt])} · execution #{r.execNo}</button>
                      <span className="muted small clip">{preview(doc.statements[r.stmt].text, 80)}</span></>
                  )}
                </span>
                {edit(a, `execution #${a.execNo}`)}
              </li>
            )
          })}
        </Group>
      )}

      {groups.window.length > 0 && (
        <Group title="Time windows">
          {groups.window.map((a) => (
            <li key={a.id}>
              <span className="ann-head">
                <button className="link" onClick={() => { actions.setWindow({ startTim: a.from!, endTim: a.to! }); actions.setView('timeline') }} title="apply the window in the Timeline">
                  {a.label ? <b>{a.label}</b> : 'window'}
                </button>
                <span className="muted small mono">{at(a.from!)} → {at(a.to!)} ({fmtDur(a.to! - a.from!)})</span>
              </span>
              {edit(a, `window ${a.label ?? ''}`, <WindowLabel a={a} />)}
            </li>
          ))}
        </Group>
      )}

      {bookmarks.length > 0 && (
        <Group title="Lines">
          {bookmarks.map((b) => {
            const key = `${b.file}:${b.line}`
            const open = editing && 'line' in editing && editing.line.file === b.file && editing.line.line === b.line
            return (
              <li key={key}>
                <span className="ann-head">
                  {doc.opt ? (
                    // a line of a 10053 file: the 10053 view at its dump and line
                    <button className="link mono" onClick={() => actions.openOpt(dumpOfLine(doc.opt!.file, b.line) ?? 0, b.line)} title="open this line in the 10053 view">
                      {(() => { const d = dumpOfLine(doc.opt!.file, b.line); return d === null ? '' : `dump ${d + 1} · ` })()}line {fmtInt(b.line)}
                    </button>
                  ) : (
                  <button className="link mono" onClick={() => (linesApi ? actions.openLinesAt(b.file, b.line) : actions.openLines(b.line, b.file))}>
                    {doc.traceFileName(b.file) ? `${doc.traceFileName(b.file)}:` : 'line '}{fmtInt(b.line)}
                  </button>
                  )}
                  <code className="small clip">{b.label}</code>
                </span>
                {open ? (
                  <NoteEditor draftKey={`line:${b.file}:${b.line}`} label={`Note on line ${b.line}`} text={b.note} onSave={(t) => { actions.setBookmarkNote(b.file, b.line, t); setEditing(null) }} onCancel={() => setEditing(null)}
                    onDelete={b.note ? () => { actions.setBookmarkNote(b.file, b.line, ''); setEditing(null) } : undefined} />
                ) : (
                  <Note text={b.note ?? ''} when={b.updated} onEdit={() => setEditing({ line: b })} onDelete={() => actions.removeBookmark(b.file, b.line)} deleteLabel="Remove bookmark" />
                )}
              </li>
            )
          })}
        </Group>
      )}
    </section>
  )
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="ann-group">
      <h3>{title}</h3>
      <ul className="ann-list">{children}</ul>
    </div>
  )
}

function Note({ text, when, onEdit, onDelete, deleteLabel = 'Delete' }: { text: string; when?: number; onEdit(): void; onDelete(): void; deleteLabel?: string }) {
  return (
    <div className="ann-note">
      {text ? <p>{text}</p> : <p className="muted small">no note</p>}
      {when ? <small className="muted" title={new Date(when).toLocaleString()}>{new Date(when).toLocaleDateString()}</small> : <span />}
      <span className="actions">
        <button className="quiet icon-btn" onClick={onEdit} aria-label={text ? 'Edit note' : 'Add note'} title={text ? 'Edit note' : 'Add note'}><PencilIcon /></button>
        <button className="quiet icon-btn" onClick={onDelete} aria-label={deleteLabel} title={deleteLabel}><TrashIcon /></button>
      </span>
    </div>
  )
}

/** The window's label, edited next to its note. */
function WindowLabel({ a }: { a: Annotation }) {
  const actions = useActions()
  return (
    <input type="text" defaultValue={a.label ?? ''} placeholder="Label (optional)" aria-label="Label of the time window"
      onBlur={(e) => { const v = e.target.value.trim(); if (v !== (a.label ?? '')) actions.updateAnnotation(a.id, { label: v || undefined }) }} />
  )
}
