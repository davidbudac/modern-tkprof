import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { Theme } from './settings'

/** A group of settings rows on one raised surface. */
export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={'set-card' + (className ? ` ${className}` : '')}>{children}</div>
}

/** One setting: its name and what it does on the left, the control on the right (below it when `stack` or when narrow). */
export function Row({ label, desc, htmlFor, stack, extra, children }: {
  label: ReactNode
  desc?: ReactNode
  htmlFor?: string
  stack?: boolean
  /** full width under the row, e.g. a preview of the setting */
  extra?: ReactNode
  children?: ReactNode
}) {
  return (
    <div className={'set-row' + (stack ? ' stack' : '')}>
      <div className="set-text">
        {htmlFor ? <label className="set-label" htmlFor={htmlFor}>{label}</label> : <span className="set-label">{label}</span>}
        {desc && <span className="set-desc">{desc}</span>}
      </div>
      {children !== undefined && <div className="set-control">{children}</div>}
      {extra && <div className="set-extra">{extra}</div>}
    </div>
  )
}

/** A subsection heading with an optional action on its right and a line under it. */
export function SubHead({ title, desc, children }: { title: string; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div className="sub-head">
      <div className="sub-title">
        <h3>{title}</h3>
        {children}
      </div>
      {desc && <p className="set-desc">{desc}</p>}
    </div>
  )
}

/** A checkbox drawn as a switch (it stays a checkbox for forms and tests). */
export function Switch({ id, checked, onChange }: { id: string; checked: boolean; onChange(v: boolean): void }) {
  return <input id={id} type="checkbox" role="switch" className="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
}

/* ---- the bind preview: one real execution line of testdata/traces/19c/basic_binds.trc (line 152) ---- */

/** Two binds of that line: the type, the traced actual length (avl) and the value. */
const SAMPLE = [
  { n: 0, type: 'NUMBER', len: 2, value: '1' },
  { n: 1, type: 'VARCHAR2', len: 11, value: 'Customer 42' },
]

/** The first 8 hex digits of SHA-256(salt + NUL + value), or of the value alone without a salt: model.RedactedValueSalt. */
async function hash8(value: string, salt: string): Promise<string> {
  const data = new TextEncoder().encode(salt ? `${salt}\u0000${value}` : value)
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', data))
  return [...d.slice(0, 4)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

const randomSalt = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('')

/**
 * What a bind mode does to a traced execution, as the report prints it. `redact` hashes with the salt (none: the
 * stable unsalted hash); `mask` (the assistant) with a salt of its own, as each conversation has one.
 */
export function BindPreview({ mode, salt = '' }: { mode: 'keep' | 'redact' | 'none' | 'mask'; salt?: string }) {
  const convSalt = useMemo(randomSalt, [])
  const [hashes, setHashes] = useState<string[] | null>(null)
  const hashed = mode === 'redact' || mode === 'mask'
  const s = mode === 'mask' ? convSalt : salt
  useEffect(() => {
    if (!hashed) return
    let live = true
    Promise.all(SAMPLE.map((b) => hash8(b.value, s))).then((h) => live && setHashes(h), () => live && setHashes(null))
    return () => { live = false }
  }, [hashed, s])

  return (
    <div className="bind-preview" aria-label="Example: an execution of basic_binds.trc">
      <span className="bp-where">exec · line 152</span>
      {mode === 'none' ? (
        <code className="bp-line bp-dropped">bind values dropped</code>
      ) : (
        <code className="bp-line">
          {SAMPLE.map((b, i) => (
            <span key={b.n} className="bp-bind">
              <span className="bp-name">:{b.n} {b.type}=</span>
              <span className={'bp-value' + (hashed ? ' hashed' : '')}>
                {hashed ? `"<${b.type} len=${b.len} h=${hashes?.[i] ?? '········'}>"` : `"${b.value}"`}
              </span>
            </span>
          ))}
        </code>
      )}
    </div>
  )
}

/* ---- theme tiles: the Lines view in miniature, drawn with the app's own tokens in each color scheme ---- */

/** Trace lines of the miniature: the time bar (its width in the time column, its wait class), then the text. */
const MINI_ROWS = [
  { t: 70, w: 36, c: 'cpu' },
  { t: 56, w: 92, c: 'userio' },
  { t: 82, w: 14, c: 'cpu' },
  { t: 48, w: 60, c: 'sysio' },
  { t: 74, w: 24, c: 'commit' },
  { t: 60, w: 46, c: 'userio' },
]

function Mini({ scheme }: { scheme: 'light' | 'dark' }) {
  return (
    <span className="mini" data-scheme={scheme}>
      <span className="mini-top"><i className="mini-brand" /><i className="mini-tab" /><i className="mini-tab dim" /></span>
      <span className="mini-lines">
        {MINI_ROWS.map((r, i) => (
          <span key={i} className="mini-line">
            <i className="mini-text" style={{ inlineSize: `${r.t}%` }} />
            <i className="mini-bar" style={{ inlineSize: `${r.w}%`, background: `var(--c-${r.c})` }} />
          </span>
        ))}
      </span>
    </span>
  )
}

const THEMES: { id: Theme; label: string }[] = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]

export function ThemeTiles({ value, onChange }: { value: Theme; onChange(t: Theme): void }) {
  return (
    <div className="theme-tiles" role="group" aria-label="Theme">
      {THEMES.map((t) => (
        <button key={t.id} className="theme-tile" aria-pressed={value === t.id} onClick={() => onChange(t.id)}>
          <span className={'theme-mini' + (t.id === 'system' ? ' split' : '')} aria-hidden>
            {t.id === 'dark' ? <Mini scheme="dark" /> : <Mini scheme="light" />}
            {t.id === 'system' && <Mini scheme="dark" />}
          </span>
          <span className="theme-name">{t.label}</span>
        </button>
      ))}
    </div>
  )
}
