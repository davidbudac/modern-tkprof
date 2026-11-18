// The registry of the dump reader's readings: a node that has a reading (`DiagNode.reading`, the reading's kind) is shown by the component
// registered for that kind, in the centre behind the Reading | Text switch. A kind nobody has registered is said so in the centre ("This version has
// no view for this reading") and the switch's Text stays the way to read the node. The readings of stages 3 to 6 (heap, pga-summary, pga-detail,
// callstack, procstate, hang, deadlock, sysstate) register themselves from `readings/index.ts`.
import type { ComponentType } from 'react'
import type { DiagNode, DiagReading, DiagSource } from '../../../data/diag'

/** What a reading's component is given. */
export interface ReadingProps {
  node: DiagNode
  /** the answer of `api/diag/reading?node=`: `kind` and what that kind carries */
  reading: DiagReading
  source: DiagSource
  /** show a line of the file in the text (switches the centre to Text) */
  goLine(line: number): void
  /** select another node of the outline (a link inside a reading: another heap, another process) */
  selectNode(id: string): void
}

export type ReadingView = ComponentType<ReadingProps>

const registry = new Map<string, ReadingView>()

/** Registers the component that shows readings of `kind` (the last registration wins). */
export function registerReading(kind: string, view: ReadingView): void {
  registry.set(kind, view)
}

/** The component for a reading kind, or undefined when this version has none. */
export function readingView(kind: string): ReadingView | undefined {
  return registry.get(kind)
}

/** The kinds that have a component (the tests and the guide's "whether the reading can be shown"). */
export function registeredReadings(): string[] {
  return [...registry.keys()]
}

/** Forgets a registration (the tests). */
export function unregisterReading(kind: string): void {
  registry.delete(kind)
}
