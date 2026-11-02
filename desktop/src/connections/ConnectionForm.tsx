import { useState, type FormEvent } from 'react'
import { type Connection, type ConnKind, ID_RE, newId, validateConnection } from './model'

interface Props {
  /** the definition to edit, or a fresh one */
  initial: Connection
  isNew: boolean
  /** ids in use (local and team), for the id check */
  taken: string[]
  onSave(c: Connection, prevId?: string): void
  onCancel(): void
}

export function blankConnection(kind: ConnKind, taken: string[]): Connection {
  const name = kind === 'ssh' ? 'New ssh host' : 'New database'
  return kind === 'ssh'
    ? { id: newId(name, taken), name, kind, host: '', port: 0, user: '', transport: 'auto' }
    : { id: newId(name, taken), name, kind, host: '', port: 1521, user: '', service: '' }
}

/** Add/edit a definition. There are no secret fields: credentials are asked on use. */
export function ConnectionForm({ initial, isNew, taken, onSave, onCancel }: Props) {
  const [c, setC] = useState<Connection>(initial)
  const [idTouched, setIdTouched] = useState(!isNew)
  const [problems, setProblems] = useState<string[]>([])
  // bumped by every failed submit: the list's key, so even the same problems shake it again
  const [fails, setFails] = useState(0)
  const set = <K extends keyof Connection>(k: K, v: Connection[K]) => setC((x) => ({ ...x, [k]: v }))
  const others = taken.filter((t) => t !== initial.id)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const { conn, problems: p } = validateConnection(c)
    const errs = [...p.filter((x) => !/ignored/.test(x))]
    if (conn && others.includes(conn.id)) errs.push(`id "${conn.id}" is already used`)
    if (!conn || errs.length) {
      setProblems(errs.map((x) => x.replace(/^connection: /, '')))
      setFails((n) => n + 1)
      return
    }
    onSave(conn, isNew ? undefined : initial.id)
  }

  return (
    <form className="conn-form" onSubmit={submit} autoComplete="off">
      <h2>{isNew ? `Add ${c.kind === 'ssh' ? 'an ssh host' : 'a database'}` : `Edit ${initial.name}`}</h2>
      <label>
        <span>Name</span>
        <input
          type="text"
          value={c.name}
          onChange={(e) => {
            const name = e.target.value
            setC((x) => ({ ...x, name, id: idTouched ? x.id : newId(name, others) }))
          }}
          autoFocus
        />
      </label>
      <label>
        <span>Id</span>
        <input
          type="text"
          className="mono"
          value={c.id}
          onChange={(e) => {
            setIdTouched(true)
            set('id', e.target.value)
          }}
          aria-invalid={!ID_RE.test(c.id)}
        />
        <small className="muted">Used by the engine and in shared files; letters, digits, <code>. _ -</code>.</small>
      </label>
      <div className="row">
        <label className="grow">
          <span>Host</span>
          <input type="text" value={c.host} onChange={(e) => set('host', e.target.value)} placeholder={c.kind === 'ssh' ? 'host or ~/.ssh/config alias' : 'db host'} />
        </label>
        <label className="port">
          <span>Port</span>
          <input
            type="text"
            inputMode="numeric"
            value={c.port || ''}
            placeholder={c.kind === 'ssh' ? '22' : '1521'}
            onChange={(e) => set('port', Number(e.target.value.replace(/\D/g, '')) || 0)}
          />
        </label>
      </div>
      <label>
        <span>User</span>
        <input type="text" value={c.user} onChange={(e) => set('user', e.target.value)} placeholder={c.kind === 'ssh' ? 'from ~/.ssh/config, else your login' : ''} />
      </label>
      {c.kind === 'db' ? (
        <>
          <label>
            <span>Service</span>
            <input type="text" value={c.service ?? ''} onChange={(e) => set('service', e.target.value)} placeholder="pdb1.example.com" />
          </label>
          <label>
            <span>ADR home (optional)</span>
            <input type="text" className="mono" value={c.adrHome ?? ''} onChange={(e) => set('adrHome', e.target.value)} placeholder="diag/rdbms/cdb1/cdb1 (default: V$DIAG_INFO)" />
          </label>
          <div className="row checks">
            <label className="check">
              <input type="checkbox" checked={!!c.tcps} onChange={(e) => setC((x) => ({ ...x, tcps: e.target.checked, tlsSkipVerify: e.target.checked && x.tlsSkipVerify }))} />
              TCPS (TLS)
            </label>
            <label className="check">
              <input type="checkbox" disabled={!c.tcps} checked={!!c.tlsSkipVerify} onChange={(e) => set('tlsSkipVerify', e.target.checked)} />
              Do not verify the server certificate
            </label>
          </div>
        </>
      ) : (
        <label>
          <span>Transport</span>
          <select value={c.transport ?? 'auto'} onChange={(e) => set('transport', e.target.value as Connection['transport'])}>
            <option value="auto">auto: system ssh, falls back to built-in SSH if ssh.exe ignores askpass</option>
            <option value="cli">cli: system ssh/sftp (~/.ssh/config, agents, bastions)</option>
            <option value="lib">lib: built-in SSH (agent, key files, password)</option>
          </select>
          <small className="muted">
            Windows 11's ssh.exe may ignore askpass (Win32-OpenSSH #2115); auto then switches to the built-in SSH for the rest of the run.
          </small>
        </label>
      )}
      <label>
        <span>Notes</span>
        <textarea rows={2} value={c.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
      </label>
      <p className="note">
        No password fields: {c.kind === 'ssh' ? 'passwords, key passphrases and one-time codes' : 'the password'} {c.kind === 'ssh' ? 'are' : 'is'} asked when the connection is used
        and kept only in the engine's memory until the app quits or you choose “Forget credentials”.
      </p>
      {problems.length > 0 && (
        <ul key={fails} className="conn-problems" role="alert">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <footer>
        <button type="button" onClick={onCancel}>Cancel</button>
        <button type="submit" className="primary">{isNew ? 'Add' : 'Save'}</button>
      </footer>
    </form>
  )
}
