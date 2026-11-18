package diag

import (
	"bytes"
	"errors"
	"fmt"
	"strconv"
	"strings"
	"sync"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Source gives the lines of the file: *trace.LineIndex is one. Read returns up to n raw lines from the
// 1-based line from, with their terminators.
type Source interface {
	Read(from, n int) ([]byte, error)
	Lines() int
}

// ErrNoNode is the error for a node id that is not one (Reader.Children).
var ErrNoNode = errors.New("no such node")

// Reader answers the children of nodes of one scanned file. It holds the top-level outline (the scan) and
// a small cache of recent answers; nothing else of the file stays in memory.
type Reader struct {
	Scan *Scan
	src  Source

	mu    sync.Mutex
	cache []cached // most recent last

	tocOnce sync.Once
	titles  map[int]string

	readingState // the readings kept, see reading.go

	closer func() error // OpenFile: closes the line index
}

type cached struct {
	key string
	out *Outline
}

const cacheSize = 16

// NewReader returns the reader of a scanned file whose lines src gives.
func NewReader(sc *Scan, src Source) *Reader { return &Reader{Scan: sc, src: src} }

// OpenFile scans the file at path and opens its line index: the reader of a file for a caller that has
// neither (the text digest of the CLI). Close releases the index.
func OpenFile(path string) (*Reader, error) {
	sc, err := ScanFile(path)
	if err != nil {
		return nil, err
	}
	li, err := trace.OpenLineIndex(path)
	if err != nil {
		return nil, err
	}
	r := NewReader(sc, li)
	r.closer = li.Close
	return r, nil
}

// Close releases what OpenFile opened.
func (r *Reader) Close() error {
	if r == nil || r.closer == nil {
		return nil
	}
	c := r.closer
	r.closer = nil
	return c()
}

func wrapNoNode(id string) error { return fmt.Errorf("%w: %q", ErrNoNode, id) }

func wrapNoNodeLines(id string, lines int) error {
	return fmt.Errorf("%w: %q (the file has %d lines)", ErrNoNode, id, lines)
}

// nodeID makes the id of a node: kind, first and last line, the lines of its heading and the rules its own
// lines are read with ("heap:32-923:1:100").
func nodeID(kind string, from, to, hl int, p profile) string {
	return kind + ":" + strconv.Itoa(from) + "-" + strconv.Itoa(to) + ":" + strconv.Itoa(hl) + ":" + strconv.FormatUint(uint64(p), 16)
}

// RootID is the id of the top level.
const RootID = "root"

func parseID(id string) (kind string, from, to, hl int, p profile, err error) {
	parts := strings.Split(id, ":")
	if len(parts) != 4 || parts[0] == "" {
		return "", 0, 0, 0, 0, ErrNoNode
	}
	r := strings.SplitN(parts[1], "-", 2)
	if len(r) != 2 {
		return "", 0, 0, 0, 0, ErrNoNode
	}
	var e1, e2, e3, e4 error
	from, e1 = strconv.Atoi(r[0])
	to, e2 = strconv.Atoi(r[1])
	hl, e3 = strconv.Atoi(parts[2])
	pv, e4 := strconv.ParseUint(parts[3], 16, 16)
	if e1 != nil || e2 != nil || e3 != nil || e4 != nil || from < 1 || to < from || hl < 0 {
		return "", 0, 0, 0, 0, ErrNoNode
	}
	return parts[0], from, to, hl, profile(pv), nil
}

// Children gives the children of the node id: its parts, found by reading only its lines. after is how
// many children the client has already (0 for the first page); an answer lists at most Cap.
func (r *Reader) Children(id string, after int) (*Outline, error) {
	return r.children(id, after, Cap)
}

func (r *Reader) children(id string, after, capN int) (*Outline, error) {
	if after < 0 {
		after = 0
	}
	key := id + "|" + strconv.Itoa(after) + "|" + strconv.Itoa(capN)
	r.mu.Lock()
	for i, c := range r.cache {
		if c.key == key {
			r.cache = append(append(r.cache[:i:i], r.cache[i+1:]...), c)
			r.mu.Unlock()
			return c.out, nil
		}
	}
	r.mu.Unlock()
	var out *Outline
	var err error
	if id == RootID {
		out = pageNodes(id, r.Scan.Top, after, capN)
	} else {
		out, err = r.scanChildren(id, after, capN)
		if err != nil {
			return nil, err
		}
	}
	r.mu.Lock()
	r.cache = append(r.cache, cached{key, out})
	if len(r.cache) > cacheSize {
		r.cache = r.cache[len(r.cache)-cacheSize:]
	}
	r.mu.Unlock()
	return out, nil
}

// pageNodes is the page of a list of nodes.
func pageNodes(id string, all []Node, after, capN int) *Outline {
	if after > len(all) {
		after = len(all)
	}
	end := min(len(all), after+capN)
	out := &Outline{Node: id, Children: append([]Node{}, all[after:end]...), More: len(all) - end}
	if out.More > 0 {
		out.Next = end
	}
	return out
}

// builder turns the heads a walker finds into the tree of one node: a stack of the open heads, a head
// closes the open ones of its rank or deeper. Only the children of the node itself are kept (the count of
// all of them, and the nodes of the page asked for); what is deeper only sets HasChildren.
type builder struct {
	base       profile // the rules of the scan
	prof       profile // the rules of the heads that are open (ownProfile of each)
	stack      []*head
	out        []Node
	total      int
	after, cap int
	last       int // the node's last line
	lastTo     int // the last line of the part emitted last
}

func (b *builder) add(h *head) {
	for len(b.stack) > 0 {
		top := b.stack[len(b.stack)-1]
		// a part with an end line of its own holds what comes before that line, unless it is of a plain
		// section (a section with no end line of its own)
		if top.rank < h.rank || (top.end != endNone && h.rank > rankNestedPlain) {
			break
		}
		b.pop(h.from - 1)
	}
	if len(b.stack) > 0 {
		b.stack[len(b.stack)-1].nkid++
	} else if h.from <= b.lastTo { // the part before ended by its own end line, past where this one begins
		shift := b.lastTo + 1 - h.from
		h.from += shift
		h.hl = max(1, h.hl-shift)
	}
	b.stack = append(b.stack, h)
	b.prof |= ownProfile(h.kind)
}

// pop closes the innermost open head at line to (unless its own end line closed it).
func (b *builder) pop(to int) {
	h := b.stack[len(b.stack)-1]
	b.stack = b.stack[:len(b.stack)-1]
	b.prof = 0
	for _, o := range b.stack {
		b.prof |= ownProfile(o.kind)
	}
	if h.to == 0 {
		h.to = to
		h.cut = h.end != endNone
	}
	if h.to < h.from+h.hl-1 {
		h.to = h.from + h.hl - 1
	}
	if h.to < h.from {
		h.to = h.from
	}
	if h.to > b.last {
		h.to = b.last
	}
	if len(b.stack) == 0 {
		b.emitTop(h)
	}
}

func (b *builder) emitTop(h *head) {
	b.lastTo = h.to
	i := b.total
	b.total++
	if i >= b.after && len(b.out) < b.cap {
		b.out = append(b.out, headNode(h, b.base))
	}
}

// headNode makes the node of a closed head.
func headNode(h *head, base profile) Node {
	n := Node{ID: nodeID(h.kind, h.from, h.to, h.hl, base|ownProfile(h.kind)), Kind: h.kind, Title: h.title, Sub: h.sub,
		From: h.from, To: h.to, Lines: h.to - h.from + 1, HasChildren: h.nkid > 0,
		N: h.n, Name: h.name, Depth: h.depth, Size: h.size, Cut: h.cut, Reading: ReadingKindOf(h.kind)}
	if h.kind == "extents" {
		n.Sub = pluralN(h.nkid, "extent")
	}
	if h.sf != nil {
		n.Title, n.Sub = h.sf.title(h.sk), h.sf.sub(h.sk)
		n.Name, n.Depth, n.Size = h.sf.name, h.sf.depth, h.sf.size
	}
	return n
}

// closeNamed ends the open marker with number num of an incident file at line.
func (b *builder) closeNamed(num, line int) {
	for i := len(b.stack) - 1; i >= 0; i-- {
		h := b.stack[i]
		if h.toc && h.n == num {
			for len(b.stack) > i+1 {
				b.pop(line - 1)
			}
			h.to = line
			b.pop(line)
			return
		}
	}
}

// endCheck: the innermost open section that ends by its own end line may end at line n.
func (b *builder) endCheck(n int, line, next []byte) {
	for i := len(b.stack) - 1; i >= 0; i-- {
		h := b.stack[i]
		if h.end == endNone {
			continue
		}
		if hit, withRule := h.end.matchesEnd(line, n, h.from); hit {
			to := n
			if withRule && next != nil && isRule(next) {
				to = n + 1
			}
			for len(b.stack) > i+1 {
				b.pop(n - 1)
			}
			h.to = to
			h.end = endNone
			b.pop(to)
		}
		return
	}
}

// facts feeds a line to the open heads that still read facts for their titles.
func (b *builder) facts(line []byte) {
	for i := len(b.stack) - 1; i >= 0; i-- {
		h := b.stack[i]
		if h.facts <= 0 {
			continue
		}
		h.facts--
		if h.sf != nil {
			h.sf.absorb(h.sk, line)
		} else if h.kind == "so" {
			soFact(h, line)
		}
		if h.kind == "so" {
			return // the innermost state object takes the line
		}
	}
}

// chunkLines is how many lines are read at a time when a node is scanned.
const chunkLines = 8192

// scanLines calls fn for the lines from..to, with the lines around each (nil beyond the range).
func scanLines(src Source, from, to int, fn func(n int, prev, line, next []byte)) error {
	var prev, prevBuf []byte
	for pos := from; pos <= to; {
		n := min(chunkLines, to-pos+1)
		raw, err := src.Read(pos, min(n+1, to-pos+1)) // one more line, for the last one's next
		if err != nil {
			return err
		}
		lines := splitLines(raw)
		if len(lines) == 0 {
			return nil
		}
		n = min(n, len(lines))
		for i := 0; i < n; i++ {
			var next []byte
			if pos+i+1 <= to && i+1 < len(lines) {
				next = lines[i+1]
			}
			fn(pos+i, prev, lines[i], next)
			prev = lines[i]
		}
		pos += n
		if pos <= to { // the last line of this chunk is the previous one of the next: keep a copy
			prevBuf = append(prevBuf[:0], prev...)
			prev = prevBuf
		}
	}
	return nil
}

// splitLines splits raw lines on \n and drops a \r before it. A missing last terminator is fine. The
// lines point into raw.
func splitLines(raw []byte) [][]byte {
	n := bytes.Count(raw, []byte{'\n'})
	out := make([][]byte, 0, n+1)
	for len(raw) > 0 {
		i := bytes.IndexByte(raw, '\n')
		var l []byte
		if i < 0 {
			l, raw = raw, nil
		} else {
			l, raw = raw[:i], raw[i+1:]
		}
		if m := len(l); m > 0 && l[m-1] == '\r' {
			l = l[:m-1]
		}
		out = append(out, l)
	}
	return out
}

func (r *Reader) scanChildren(id string, after, capN int) (*Outline, error) {
	kind, from, to, hl, base, err := parseID(id)
	if err != nil {
		return nil, fmt.Errorf("%w: %q", ErrNoNode, id)
	}
	if n := r.src.Lines(); to > n {
		return nil, fmt.Errorf("%w: %q (the file has %d lines)", ErrNoNode, id, n)
	}
	if base == 0 {
		return &Outline{Node: id, Children: []Node{}}, nil
	}
	b := &builder{base: base, after: after, cap: capN, last: to}
	w := &walker{prof: base, skipTo: from + hl - 1, claimed: from + hl - 1, extents: kind == "extents"}
	if base&pTOC != 0 {
		w.titles = r.tocTitles()
	}
	w.emit = b.add
	w.tocEnd = b.closeNamed
	err = scanLines(r.src, from, to, func(n int, prev, line, next []byte) {
		if len(b.stack) > 0 {
			b.endCheck(n, line, next)
			b.facts(line)
		}
		w.prof = base | b.prof
		w.line(n, prev, line, next)
	})
	if err != nil {
		return nil, err
	}
	for len(b.stack) > 0 {
		b.pop(to)
	}
	out := &Outline{Node: id, Children: b.out}
	if out.Children == nil {
		out.Children = []Node{}
	}
	if shown := after + len(b.out); b.total > shown {
		out.More = b.total - shown
		out.Next = shown
	}
	return out, nil
}

// tocTitles is the table of contents at the end of an incident file: the title of each marker number.
// Found once, in the last lines of every incident section.
func (r *Reader) tocTitles() map[int]string {
	r.tocOnce.Do(func() {
		r.titles = map[int]string{}
		for _, s := range r.Scan.File.Sections {
			if s.Kind != trace.SectionIncident.String() {
				continue
			}
			r.readTOCTable(s.First, s.Last)
		}
	})
	return r.titles
}

// readTOCTable reads the table of contents from the end of lines first..last: blocks of lines going back
// until the line "TOC00000 - Table of contents" is found (at most 64 blocks).
func (r *Reader) readTOCTable(first, last int) {
	const block = 2048
	for k := 0; k < 64; k++ {
		hi := last - k*block
		lo := max(first, hi-block+1)
		if hi < first {
			return
		}
		raw, err := r.src.Read(lo, hi-lo+1)
		if err != nil {
			return
		}
		lines := splitLines(raw)
		found := -1
		for i := len(lines) - 1; i >= 0; i-- {
			if num, _, ok := tocTableLine(lines[i]); ok && num == 0 && bytes.Contains(lines[i], []byte("Table of contents")) {
				found = i
				break
			}
		}
		if found < 0 {
			continue
		}
		// the table runs from found to "End of TOC", possibly into the following blocks
		for i := found; i < len(lines); i++ {
			if num, t, ok := tocTableLine(lines[i]); ok {
				r.titles[num] = t
			}
		}
		for p := lo + len(lines); p <= last; p += block {
			raw, err := r.src.Read(p, min(block, last-p+1))
			if err != nil {
				return
			}
			end := false
			for _, l := range splitLines(raw) {
				if exact(l, "End of TOC") {
					end = true
					break
				}
				if num, t, ok := tocTableLine(l); ok {
					r.titles[num] = t
				}
			}
			if end {
				return
			}
		}
		return
	}
}
