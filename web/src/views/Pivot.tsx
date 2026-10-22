import type { TraceDoc } from '../data/doc'

export function Pivot({ doc }: { doc: TraceDoc }) {
  void doc
  return <p className="muted">The pivot view is being built.</p>
}
