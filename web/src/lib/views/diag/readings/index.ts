// The readings the dump reader can show. Each stage that adds a computed reading adds its component beside this file and registers it here (the import runs
// its `registerReading(kind, View)`):
//
//   heap          readings/heap.tsx   (the heap reading: check, heap tree, by comment / by type / sub-heaps, chunk lines, free lists)
//   pga-summary   readings/pga.tsx
//   pga-detail    readings/pga.tsx
//
// A node whose reading has no component here is shown as text, with "This version has no view for this reading" behind the Reading switch.
import './heap'
import './pga'
export { readingView, registerReading, registeredReadings, unregisterReading } from './registry'
export type { ReadingProps, ReadingView } from './registry'
