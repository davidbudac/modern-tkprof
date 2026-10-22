import type { TraceDoc } from '../data/doc'

export function Sessions({ doc }: { doc: TraceDoc }) {
  void doc
  return <p className="muted">The sessions view is being built.</p>
}
