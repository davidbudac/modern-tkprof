import { Component, Fragment, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches a render error in the views, so the shell around them (top bar, filters; the desktop's tab strip and other tabs)
 * stays up: an error card takes the views' place. A new `resetKey` (compared by identity: another document, another
 * view, the desktop's new engine session) clears the error and renders the views again.
 *
 * The card's classes come in pairs: `view-error*` are styled by the lib (styles/app.css), and `panel-center`, `card bad`,
 * `blocker-error`, `actions` let a shell with its own card styles (the desktop) draw it as its other cards.
 */
interface Props {
  /** what the card names: the trace file, the desktop's tab title */
  title: string
  /** extra lines for "Copy details" (paths, session) */
  context?: string[]
  resetKey: unknown
  /** the sentence under the error; the default says nothing about tabs */
  note?: ReactNode
  /** the first word of the copied details: which program crashed */
  product?: string
  children: ReactNode
}

interface State {
  error: Error | null
  componentStack: string
  /** bumped by "Reload": remounts the views, dropping their local state */
  attempt: number
}

const defaultNote = 'The rest of the window is not affected. Reload draws the view again; Copy details puts the error on the clipboard for a bug report.'

/** The text "Copy details" puts on the clipboard. */
export function errorDetails(title: string, context: string[], error: Error, componentStack: string, product = 'mtkprof'): string {
  return [
    `${product}: view crashed in "${title}"`,
    ...context,
    '',
    `${error.name}: ${error.message}`,
    error.stack ?? '',
    componentStack ? `\nComponent stack:${componentStack}` : '',
  ].join('\n').trimEnd()
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: '', attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`view of "${this.props.title}" crashed:`, error)
    this.setState({ componentStack: info.componentStack ?? '' })
  }

  componentDidUpdate(prev: Props) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null, componentStack: '' })
  }

  reload = () => this.setState((s) => ({ error: null, componentStack: '', attempt: s.attempt + 1 }))

  copy = () => {
    const { error, componentStack } = this.state
    if (!error) return
    const text = errorDetails(this.props.title, this.props.context ?? [], error, componentStack, this.props.product)
    void navigator.clipboard?.writeText(text).catch(() => {})
  }

  render() {
    const { error, attempt } = this.state
    if (!error) return <Fragment key={attempt}>{this.props.children}</Fragment>
    return (
      <div className="view-error panel-center">
        <section className="view-error-card card bad" role="alert">
          <h2>
            This view crashed <span className="mono">{this.props.title}</span>
          </h2>
          <pre className="view-error-msg blocker-error">{error.message || String(error)}</pre>
          <p className="muted small">{this.props.note ?? defaultNote}</p>
          <p className="view-error-actions actions">
            <button onClick={this.reload}>Reload</button>
            <button className="quiet" onClick={this.copy}>Copy details</button>
          </p>
        </section>
      </div>
    )
  }
}
