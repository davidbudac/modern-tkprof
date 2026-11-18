package diag

import (
	"errors"
	"fmt"
	"sort"
	"sync"
)

// The path of a line: the chain of nodes from the top level down to the deepest node that holds a line
// (GET api/diag/path), so that a client can say where a line is in an outline it has not loaded (a heap nested in a
// PGA summary, a process of a system state) and show the where-am-I path anywhere.
//
// The top node is found by binary search in the scan (the top level tiles the file). Each level down reads only the
// lines of the node it is in, from its start to the end of the child that holds the line (Reader.scanChildrenFor
// stops there), and keeps nothing but that child. The answers are cached by line. The depth is bounded by PathDepth.

// PathDepth bounds the nodes of a path (the nesting of the lab's dumps is at most six).
const PathDepth = 16

// pathCacheSize is how many paths a Reader keeps.
const pathCacheSize = 32

// Path is the answer of Reader.Path and Reader.PathTo: the nodes from the top level down, each inside the one
// before it; the last is the deepest node that holds the line (or the node asked for).
type Path struct {
	Nodes []Node `json:"nodes"`
}

// ErrNoLine is the error for a line that is not a line of the file.
var ErrNoLine = errors.New("no such line")

// pathState is the cache of paths, beside the Reader's other caches.
type pathState struct {
	pmu   sync.Mutex
	paths []cachedPath
}

type cachedPath struct {
	key string
	p   *Path
}

// Path gives the chain of nodes that hold line (1-based): ErrNoLine for a line outside the file.
func (r *Reader) Path(line int) (*Path, error) {
	if line < 1 || line > r.src.Lines() {
		return nil, fmt.Errorf("%w: %d (the file has %d lines)", ErrNoLine, line, r.src.Lines())
	}
	return r.path("l"+fmt.Sprint(line), line, "")
}

// PathTo gives the chain of nodes from the top level down to the node id: ErrNoNode for an id that is not a node
// of the file. "root" has the empty path.
func (r *Reader) PathTo(id string) (*Path, error) {
	if id == RootID {
		return &Path{Nodes: []Node{}}, nil
	}
	_, from, to, _, _, err := parseID(id)
	if err != nil {
		return nil, wrapNoNode(id)
	}
	if n := r.src.Lines(); to > n {
		return nil, wrapNoNodeLines(id, n)
	}
	p, err := r.path("n"+id, from, id)
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (r *Reader) path(key string, line int, stop string) (*Path, error) {
	r.pmu.Lock()
	for i, c := range r.paths {
		if c.key == key {
			r.paths = append(append(r.paths[:i:i], r.paths[i+1:]...), c)
			r.pmu.Unlock()
			return c.p, nil
		}
	}
	r.pmu.Unlock()
	top := r.Scan.Top
	i := sort.Search(len(top), func(i int) bool { return top[i].To >= line })
	if i >= len(top) || top[i].From > line {
		return nil, fmt.Errorf("%w: %d", ErrNoLine, line)
	}
	nodes := []Node{top[i]}
	for len(nodes) < PathDepth && (stop == "" || nodes[len(nodes)-1].ID != stop) {
		cur := nodes[len(nodes)-1]
		if !cur.HasChildren {
			break
		}
		o, err := r.scanChildrenFor(cur.ID, 0, 1, line)
		if err != nil {
			return nil, err
		}
		if len(o.Children) == 0 {
			break
		}
		nodes = append(nodes, o.Children[0])
	}
	if stop != "" && nodes[len(nodes)-1].ID != stop {
		return nil, wrapNoNode(stop)
	}
	out := &Path{Nodes: nodes}
	r.pmu.Lock()
	r.paths = append(r.paths, cachedPath{key, out})
	if len(r.paths) > pathCacheSize {
		r.paths = r.paths[len(r.paths)-pathCacheSize:]
	}
	r.pmu.Unlock()
	return out, nil
}
