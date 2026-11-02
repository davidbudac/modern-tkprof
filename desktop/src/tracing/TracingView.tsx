import { Fragment, useState } from 'react'
import { copyText } from '@lib/data/clipboard'
import { after, groups, levels, type Recipe, type RecipeGroup } from './recipes'
import './tracing.css'

/** The 10046 cheatsheet: the ways to switch SQL trace on, common first, then getting the file and switching it all off. */
export function TracingView() {
  const all = [...groups, after]
  return (
    <div className="page tracing">
      <h1>Make a 10046 trace</h1>
      <p className="muted">
        SQL trace (event 10046) writes every parse, execute and fetch of a session, with its waits and bind values, to a trace file on the
        database server. Pick the way by whose work you want. Switch it off when you are done: a trace left on fills the disk.
      </p>
      <nav className="tr-toc" aria-label="On this page">
        {all.map((g) => (
          <div key={g.id} className="tr-toc-group">
            <span className="tr-toc-h">{g.title}</span>
            {g.recipes.map((r) => (
              <button key={r.id} onClick={() => jump(r.id)}>{r.title}</button>
            ))}
            {g.id === 'common' && <button onClick={() => jump('tr-levels')}>Levels and options</button>}
          </div>
        ))}
      </nav>
      {groups.map((g) => (
        <Fragment key={g.id}>
          <Group group={g} />
          {g.id === 'common' && <Levels />}
        </Fragment>
      ))}
      <Group group={after} />
      <p className="muted small">
        Checked on Oracle 19.27 (a CDB, sessions in a PDB): each command was run and its trace file read back. Notes on other releases come from
        Oracle's documentation and published tests. Version marks name the release a feature needs.
      </p>
    </div>
  )
}

function jump(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  el.focus({ preventScroll: true })
}

function Group({ group }: { group: RecipeGroup }) {
  return (
    <section aria-labelledby={`tr-${group.id}-h`}>
      <h2 id={`tr-${group.id}-h`}>{group.title}</h2>
      <p className="muted">{group.lead}</p>
      {group.recipes.map((r) => <RecipeCard key={r.id} recipe={r} />)}
    </section>
  )
}

function RecipeCard({ recipe: r }: { recipe: Recipe }) {
  return (
    <article className="tr-recipe" id={r.id} tabIndex={-1} aria-labelledby={`${r.id}-h`}>
      <h3 id={`${r.id}-h`}>
        {r.title}
        {r.since && <span className="tr-since" title={`Needs Oracle ${r.since} or later`}>{r.since}+</span>}
      </h3>
      <p className="muted small">{r.when}</p>
      <Snippet code={r.code} label={r.title} />
      {r.notes.length > 0 && (
        <ul className="tr-notes small">
          {r.notes.map((n, i) => <li key={i}>{n}</li>)}
        </ul>
      )}
    </article>
  )
}

function Snippet({ code, label }: { code: string; label: string }) {
  const [msg, setMsg] = useState<string | null>(null)
  const copy = () =>
    void copyText(code).then((ok) => {
      setMsg(ok ? 'Copied' : 'Could not copy')
      setTimeout(() => setMsg(null), 1600)
    })
  return (
    <div className="tr-code">
      <pre className="mono"><code>{code}</code></pre>
      <span className="tr-copy">
        {msg && <small className="muted" role="status">{msg}</small>}
        <button onClick={copy} aria-label={`Copy: ${label}`}>Copy</button>
      </span>
    </div>
  )
}

function Levels() {
  return (
    <section id="tr-levels" tabIndex={-1} aria-labelledby="tr-levels-h">
      <h2 id="tr-levels-h">Levels and options</h2>
      <p className="muted">
        The 10046 levels add up: 12 = 4 + 8, 28 = 4 + 8 + 16. The named options do the same in <code className="mono">sql_trace</code> events
        and in <code className="mono">DBMS_MONITOR</code> / <code className="mono">DBMS_SESSION</code> (<code className="mono">waits</code>,{' '}
        <code className="mono">binds</code>, <code className="mono">plan_stat</code>).
      </p>
      <table className="rb-table tr-levels">
        <thead>
          <tr>
            <th className="num">Level</th>
            <th>sql_trace option</th>
            <th>Adds</th>
          </tr>
        </thead>
        <tbody>
          {levels.map((l) => (
            <tr key={l.level}>
              <td className="num mono">{l.level}</td>
              <td className="mono">{l.option}</td>
              <td>{l.adds}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">
        Without <code className="mono">plan_stat</code>, STAT lines (the plan with rows and times) come after the first execution of each cursor
        only. Use all_executions when the plan or its row counts change between executions. On 19c, adaptive is event syntax only: the
        packages reject it (ORA-30449).
      </p>
    </section>
  )
}
