// The readings the dump reader can show. Each stage that adds a computed reading adds its component beside this file and registers it here:
//
//   import './heap'       // registerReading('heap', HeapReading) …
//
// Stage 2 (the reader at level 0) has none: no node carries a `reading` yet, and a node that does shows "This version has no view for this reading".
export { readingView, registerReading, registeredReadings, unregisterReading } from './registry'
export type { ReadingProps, ReadingView } from './registry'
