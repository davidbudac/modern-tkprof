import type { TraceDoc } from '../data/doc'

export function Timeline({ doc }: { doc: TraceDoc }) {
  void doc
  return <p className="muted">The timeline view is being built.</p>
}
