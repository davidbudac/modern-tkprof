// A synthetic dump file for the dev harness and the tests: millions of lines that are made on demand (nothing is held), a top level of more than one
// page of nodes (the "load more" row), and nodes with parts of their own. It exists to try the scroll map, the paging of the text and of the outline.
import { memoryDiagSource, type DiagFile, type DiagNode, type DiagSource } from './diag'

/** Lines per top-level node of the synthetic file, and lines per part of a node. */
export const SYN_SECTION = 1000
export const SYN_PART = 100

const hex = (n: number) => (Math.imul(n, 2654435761) >>> 0).toString(16).padStart(8, '0')

/** The text of line `n` of the synthetic file: a section's first line is its heading, a part's first line its title, the rest are chunk lines. */
export function synthLine(n: number): string {
  const sec = Math.floor((n - 1) / SYN_SECTION)
  const at = (n - 1) % SYN_SECTION
  if (at === 0) return `HEAP DUMP heap name="synthetic ${sec + 1}"  desc=0x${hex(sec)}`
  if (at % SYN_PART === 0) return `----- Part ${at / SYN_PART} of section ${sec + 1} -----`
  if (at % 37 === 0) return `*** 2026-11-17T21:${String(at % 60).padStart(2, '0')}:26.${String(n % 1000000).padStart(6, '0')}+00:00`
  return `  Chunk     ${hex(n)}${hex(n + 7)} sz= ${String(1000 + (n * 7919) % 90000).padStart(8)}    free      "synthetic chunk"`
}

/** The synthetic file of `lines` lines (at least one section) as a source: `sections` top-level nodes, the first 2,000 in `file.outline`, the rest a page away. */
export function syntheticDiag(lines = 5_000_000): { file: DiagFile; source: DiagSource } {
  const sections = Math.max(1, Math.ceil(lines / SYN_SECTION))
  const node = (i: number): DiagNode => {
    const from = i * SYN_SECTION + 1
    const to = Math.min(lines, (i + 1) * SYN_SECTION)
    return { id: `syn:${i}`, kind: 'heap', title: `Heap dump: synthetic ${i + 1}`, sub: i % 5 === 0 ? 'a heap with a sub line' : undefined, from, to, lines: to - from + 1, hasChildren: to - from + 1 > SYN_PART, name: `synthetic ${i + 1}`, depth: 0, size: 100000 + i * 1000 }
  }
  const top = Array.from({ length: Math.min(sections, 2000) }, (_, i) => node(i))
  const file: DiagFile = { name: 'synthetic.trc', lines, release: 'Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production', version: '19.27.0.0.0', tested: true, records10046: 0, sections: [], unplaced: 0, outline: top, outlineTotal: sections }
  // the whole top level and the parts of any node are made when asked for
  const base = memoryDiagSource(file, {}, { count: lines, at: synthLine })
  const source: DiagSource = {
    ...base,
    outline: (id, after = 0) => {
      if (id === 'root') {
        const page = Array.from({ length: Math.max(0, Math.min(2000, sections - after)) }, (_, k) => node(after + k))
        const more = Math.max(0, sections - after - page.length)
        return Promise.resolve({ node: id, children: page, more, ...(more > 0 ? { next: after + page.length } : null) })
      }
      const m = /^syn:(\d+)$/.exec(id)
      if (!m) return Promise.resolve({ node: id, children: [], more: 0 })
      const sec = node(Number(m[1]))
      const parts: DiagNode[] = []
      for (let from = sec.from; from <= sec.to; from += SYN_PART) {
        const to = Math.min(sec.to, from + SYN_PART - 1)
        const k = (from - sec.from) / SYN_PART
        parts.push({ id: `syn:${m[1]}:${k}`, kind: 'title', title: k === 0 ? 'Heap header' : `Part ${k}`, from, to, lines: to - from + 1, hasChildren: false, n: k })
      }
      return Promise.resolve({ node: id, children: parts, more: 0 })
    },
  }
  return { file, source }
}
