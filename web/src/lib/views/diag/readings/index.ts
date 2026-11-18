// The readings the dump reader can show. Each stage that adds a computed reading adds its component beside this file and registers it here (the import runs
// its `registerReading(kind, View)`):
//
//   heap          readings/heap.tsx   (the heap reading: check, heap tree, by comment / by type / sub-heaps, chunk lines, free lists)
//   pga-summary   readings/pga.tsx
//   pga-detail    readings/pga.tsx
//   callstack     readings/callstack.tsx   (a diagnostic dump, an incident: error, statement, PL/SQL stack, the stack as one line, frames, cursors)
//   procstate     readings/procstate.tsx   (a process state, a process of a system state: who, what it runs, waits, blockers, holds)
//   sysstate      readings/sysstate.tsx    (the blocker tree, the process table with the idle background processes hidden)
//   hang          readings/hang.tsx        (the chains as trees of session cards, the "State of ALL nodes" table)
//   deadlock      readings/deadlock.tsx    (the cycle drawn, the graph as the dump's table, the sessions' blocks, the rows waited on)
//
// A node whose reading has no component here is shown as text, with "This version has no view for this reading" behind the Reading switch.
import './heap'
import './pga'
import './callstack'
import './procstate'
import './sysstate'
import './hang'
import './deadlock'
export { readingView, registerReading, registeredReadings, unregisterReading } from './registry'
export type { ReadingProps, ReadingView } from './registry'
