package diag

import (
	"errors"
	"sort"
	"strings"
	"sync"
)

// Readings (level 2 of docs/PLAN-DIAG.md): the computed summary of a node. A reading is addressed by the
// id of its node, because a heap dump can sit inside another section (an errorstack, a PGA summary). It
// is computed on demand by scanning the node's own lines (as Children does) and kept in a small cache;
// nothing is persisted.
//
// The kinds, and the nodes that have one:
//
//	heap         a node of kind heap                  HeapReading (heap.go)
//	pga-summary  a node of kind pga-summary           PGASummary  (pga.go)
//	pga-detail   a node of kind pga-detail            PGADetail   (pga.go)
//	callstack    a node of kind diagdump, an incident file and its "Dump for incident" part (kind toc)
//	                                                 CallStack   (stack.go)
//	procstate    a node of kind procstate or process (a PROCESS n of a system state)
//	                                                 ProcState   (procstate.go)
//
// The JSON form of a reading is an object whose first field is "kind" (the same string as Node.Reading),
// then the fields of that kind. TestReadingJSONShape pins the names.

// Reading is the computed reading of a node: *HeapReading, *PGASummary, *PGADetail, *CallStack or *ProcState. The
// JSON form of each starts with its "kind".
type Reading interface {
	ReadingKind() string
}

// Reading kinds.
const (
	ReadingHeap       = "heap"
	ReadingPGASummary = "pga-summary"
	ReadingPGADetail  = "pga-detail"
	ReadingCallStack  = "callstack"
	ReadingProcState  = "procstate"
)

// ReadingKindOf is the kind of the reading a node of this kind has, "" for a node without one. A node of kind
// toc has one only when it is the "Dump for incident" part of an incident file (readingKindFor says; the
// reader checks it again from the lines).
func ReadingKindOf(nodeKind string) string {
	switch nodeKind {
	case "heap":
		return ReadingHeap
	case "pga-summary":
		return ReadingPGASummary
	case "pga-detail":
		return ReadingPGADetail
	case "diagdump", "incident", "toc":
		return ReadingCallStack
	case "procstate", "process":
		return ReadingProcState
	}
	return ""
}

// readingKindFor is the Node.Reading of a node of this kind and title: ReadingKindOf, except that a toc
// part has a reading only when it holds the incident's dump.
func readingKindFor(nodeKind, title string) string {
	if nodeKind == "toc" && !strings.HasPrefix(title, "Dump for incident") {
		return ""
	}
	return ReadingKindOf(nodeKind)
}

// ErrNoReading is the error for a node that has no reading (its kind has none).
var ErrNoReading = errors.New("no reading for this kind of section")

// markersOnlySub is the Sub of a run of lines between sections that holds nothing but markers and blank
// lines: the glue between the heaps of one dump.
const markersOnlySub = "markers and blank lines"

// readingCacheSize is how many readings a Reader keeps.
const readingCacheSize = 8

type cachedReading struct {
	id string
	r  Reading
}

// Reading gives the reading of the node id: ErrNoNode for an id that is not a node of this file,
// ErrNoReading for a node whose kind has none. The first call for a node scans its lines.
func (r *Reader) Reading(id string) (Reading, error) {
	kind, from, to, _, _, err := parseID(id)
	if err != nil {
		return nil, wrapNoNode(id)
	}
	rk := ReadingKindOf(kind)
	if rk == "" {
		if id == RootID {
			return nil, wrapNoNode(id)
		}
		return nil, ErrNoReading
	}
	if n := r.src.Lines(); to > n {
		return nil, wrapNoNodeLines(id, n)
	}
	r.rmu.Lock()
	defer r.rmu.Unlock()
	for i, c := range r.readings {
		if c.id == id {
			r.readings = append(append(r.readings[:i:i], r.readings[i+1:]...), c)
			return c.r, nil
		}
	}
	var out Reading
	switch rk {
	case ReadingHeap:
		out, err = r.heapReading(id, from, to)
	case ReadingPGASummary:
		out, err = r.pgaSummary(id, from, to)
	case ReadingPGADetail:
		out, err = r.pgaDetail(id, from, to)
	case ReadingCallStack:
		out, err = r.callStack(id, kind, from, to)
	case ReadingProcState:
		out, err = r.procState(id, kind, from, to)
	}
	if err != nil {
		return nil, err
	}
	r.readings = append(r.readings, cachedReading{id, out})
	if len(r.readings) > readingCacheSize {
		r.readings = r.readings[len(r.readings)-readingCacheSize:]
	}
	return out, nil
}

// readingNodes are the nodes of the digest that carry a reading, in file order: the top-level nodes and
// their listed children (what Digest holds).
func (d *Digest) readingNodes() []Node {
	var out []Node
	for _, n := range d.Outline {
		if n.Reading != "" {
			out = append(out, n.Node)
		}
		for _, c := range n.Children {
			if c.Reading != "" {
				out = append(out, c)
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].From < out[j].From })
	return out
}

// the readings' mutex, beside the cache (Reader has the fields).
type readingState struct {
	rmu      sync.Mutex
	readings []cachedReading

	hmu  sync.Mutex
	hdrs map[int]runMember // the header facts of the heap nodes seen, by first line
}
