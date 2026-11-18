package diag

import (
	"bytes"
	"fmt"
	"sort"
	"strconv"
	"strings"
)

// The reading of a heap dump (docs/PLAN-DIAG.md § The readings; the format is docs/trace-format-diag.md §
// Heap dump): where the memory is, by chunk type, by comment, by sub-heap and in the free lists, checked
// against the totals the dump prints.
//
// One pass over the node's lines. The chunk lines of the extents are counted (a chunk line is
// "  Chunk <addr> sz=<bytes> <type> "<comment>" [ds=0x.. | alo=N | C<time>]"); the lines of the free lists,
// of the reserved free lists and of the permanent chunks are counted apart, and each sum is compared with
// the line the dump prints for it. What is aggregated:
//
//   - By type. The types are free, freeable, freeableU, recreate, perm, lastchk, R-free, R-freeable,
//     R-stopper, mfreeable and, in the shared pool, the family recr<P|U><C|T|R><nnn> (recrPC001,
//     recrUT003, ...). The family is one type, "recr", and the printed suffix is kept as a variant
//     (HeapType.Variants): the shared pool of the lab prints 18 of them, and the suffix says how a
//     recreatable chunk is pinned, not what it holds.
//   - By comment. A comment is the 15 characters between the quotes, trimmed. The shared pool puts a hash
//     after "^" (KGLH0^80b2c0e9, SQLP^bccb223e, KKSSP^22): the chunks of one library cache object share a
//     comment up to the "^". Comments are grouped by the part before "^", and HeapComment.Suffixes says
//     how many distinct suffixes were folded in. The list is sorted by bytes and bounded
//     (CommentCap); what is left is summed in one "other" entry that says how many comments it holds.
//   - By sub-heap: the "ds <addr> sz= ct=" line that follows the chunk holding a sub-heap's descriptor,
//     the "ds=0x..." that its extents' chunks carry, and the "N LARGEST SUB HEAPS" block.

const (
	// CommentCap is how many comments a heap reading lists; the rest is summed in HeapReading.OtherComments.
	CommentCap = 300
	// SubheapCap is how many sub-heaps a heap reading lists; the rest is summed in HeapReading.OtherSubheaps.
	SubheapCap = 100
	// RunCap is how many heaps of the dump run a heap reading lists (HeapReading.Run).
	RunCap = 400
	// LinesCap is how many chunk lines one answer of HeapLines gives.
	LinesCap = 2000
)

// Check states.
const (
	CheckMatch  = "match"
	CheckDiffer = "differ"
	CheckNone   = "none"
)

// Check names.
const (
	CheckHeap     = "heap"     // the chunks of the extents against "Total heap size"
	CheckFree     = "free"     // the chunks of the free lists against "Total free space"
	CheckPerm     = "perm"     // the perm chunks under PERMANENT CHUNKS: against "Permanent space"
	CheckReserved = "reserved" // the chunks of the reserved free lists against "Total of all reserved free space"
)

// HeapReading is the reading of one heap dump.
type HeapReading struct {
	Kind string `json:"kind"` // "heap"
	Node string `json:"node"` // the id of the node
	Name string `json:"name"` // the heap name as printed, trimmed ("pga heap", "sga heap(1,0)")
	// Desc is the heap's descriptor as the dump prints it ("0x7f952ce9a220"); Parent the descriptor of its
	// parent heap ("" for a top heap), ParentNode the node of that parent's own dump when the file holds it.
	Desc       string `json:"desc"`
	Parent     string `json:"parent,omitempty"`
	ParentNode string `json:"parentNode,omitempty"`
	Depth      *int   `json:"depth,omitempty"` // "dsx heap depth"; absent when the header has none
	PDB        *int   `json:"pdb,omitempty"`   // "pdb id"
	From       int    `json:"from"`            // the lines of the dump (the node's)
	To         int    `json:"to"`
	Lines      int    `json:"lines"`
	Extents    int    `json:"extents"`  // EXTENT lines
	Chunks     int    `json:"chunks"`   // chunk lines of the extents
	Bytes      int64  `json:"bytes"`    // their sum (what the check compares with Total heap size)
	HeapSize   int64  `json:"heapSize"` // "dsx heap size" of the header; 0 when it has none

	Flags HeapFlags `json:"flags"`
	// Checks are the sums compared with the totals the dump prints, in this order: heap, free, perm, and
	// reserved when the dump has reserved free lists.
	Checks []HeapCheck `json:"checks"`

	ByType []HeapType `json:"byType"` // by bytes, largest first
	// ByComment: the CommentCap comments with the most bytes (largest first, ties by name); OtherComments
	// sums the rest; Comments counts them all (ByComment and the comments in OtherComments).
	ByComment     []HeapComment `json:"byComment"`
	OtherComments *HeapOther    `json:"otherComments,omitempty"`
	Comments      int           `json:"comments"`

	FreeLists HeapFreeLists  `json:"freeLists"`
	Permanent *HeapPermanent `json:"permanent,omitempty"`
	Unpinned  *HeapUnpinned  `json:"unpinned,omitempty"`
	Subheaps  []HeapSub      `json:"subheaps"` // by size, largest first, at most SubheapCap
	SubTotal  int            `json:"subheapsTotal"`
	SubOther  *HeapOther     `json:"otherSubheaps,omitempty"`
	Largest   []HeapLargest  `json:"largest"` // the "N LARGEST SUB HEAPS" block, in the order printed
	Run       []HeapRun      `json:"run"`     // the heaps of the same dump run, in file order, at most RunCap
	RunMore   int            `json:"runMore,omitempty"`
	// RunLabel is a short label of the dump run when the file gives one: the oradebug command that took it ("oradebug:
	// dump heapdump 5"), read from the "Processing Oradebug command '...'" line before the run's first heap. A heap
	// dump prints nothing about its own level (no fixture does), and the "*** ACTION NAME" marker before it is a habit
	// of the lab scripts, not something the dump says, so a dump taken by an event or by alter session has no label:
	// the field is absent then. Only a heap dump of the top level has one (a heap nested in another section is its
	// own run).
	RunLabel string `json:"runLabel,omitempty"`
}

// ReadingKind is "heap".
func (*HeapReading) ReadingKind() string { return ReadingHeap }

// HeapFlags say what limits the reading.
type HeapFlags struct {
	// Contents: the dump holds memory contents ("Dump of memory" blocks); they are skipped, and counted.
	Contents *HeapContents `json:"contents,omitempty"`
	// PDBFiltered: the dump was taken inside a PDB and leaves out the chunks of other containers
	// ("(only chunks clearly belonging to pdb id N will be dumped)"); the id.
	PDBFiltered *int `json:"pdbFiltered,omitempty"`
	// Sampled: "Heap has significant amount of free memory (N percent)" / "Dumping sample extents": some
	// extents only, no totals.
	Sampled        bool `json:"sampled,omitempty"`
	SampledPercent int  `json:"sampledPercent,omitempty"`
	// NoExtents: the header is followed by no extent (the heap of a latch directory, IMCA_RO).
	NoExtents bool `json:"noExtents,omitempty"`
	// Cut: the dump stops before its end (the file ends first).
	Cut bool `json:"cut,omitempty"`
}

// HeapContents counts the memory contents a dump taken with contents holds.
type HeapContents struct {
	Blocks int `json:"blocks"` // "Dump of memory from ..." lines
	Lines  int `json:"lines"`  // those lines and the rows under them (skipped)
}

// HeapCheck is one comparison of a sum with a total the dump prints.
type HeapCheck struct {
	Name  string `json:"name"`  // heap, free, perm, reserved
	What  string `json:"what"`  // in words: "chunks of the extents against Total heap size"
	State string `json:"state"` // match, differ, none
	// Computed is the sum over the chunk lines; Printed the number on the dump's line (absent when the dump
	// has none); Line its line number; Diff = Computed - Printed for differ.
	Computed int64  `json:"computed"`
	Printed  *int64 `json:"printed,omitempty"`
	Line     int    `json:"line,omitempty"`
	Diff     int64  `json:"diff,omitempty"`
	// Reason: why a check could not be made (state none), in plain words.
	Reason string `json:"reason,omitempty"`
}

// HeapType is the chunks of one type.
type HeapType struct {
	Type   string `json:"type"`
	Chunks int    `json:"chunks"`
	Bytes  int64  `json:"bytes"`
	// Variants: for the family "recr", the printed types (recrPC001, ...) by bytes.
	Variants []HeapVariant `json:"variants,omitempty"`
}

// HeapVariant is the chunks of one printed type of a family.
type HeapVariant struct {
	Type   string `json:"type"`
	Chunks int    `json:"chunks"`
	Bytes  int64  `json:"bytes"`
}

// HeapComment is the chunks of one comment (grouped by the part before "^").
type HeapComment struct {
	Comment string          `json:"comment"` // "" for the blank comment of a free chunk
	Types   []HeapTypeShare `json:"types"`   // the types it occurs with, by bytes
	Chunks  int             `json:"chunks"`
	Bytes   int64           `json:"bytes"`
	Line    int             `json:"line"` // the line of its first chunk
	// Suffixes: how many distinct "^suffix" values the group holds; absent for a comment without one.
	Suffixes int `json:"suffixes,omitempty"`
}

// HeapTypeShare is a comment's chunks of one type.
type HeapTypeShare struct {
	Type   string `json:"type"`
	Chunks int    `json:"chunks"`
	Bytes  int64  `json:"bytes"`
}

// HeapOther sums what a bounded list leaves out.
type HeapOther struct {
	Count  int   `json:"count"` // comments (or sub-heaps) in it
	Chunks int   `json:"chunks"`
	Bytes  int64 `json:"bytes"`
}

// HeapFreeLists is the free lists.
type HeapFreeLists struct {
	Present bool   `json:"present"`        // the dump prints FREE LISTS:
	Line    int    `json:"line,omitempty"` // of that line
	Chunks  int    `json:"chunks"`         // chunks in the lists (not the list heads)
	Bytes   int64  `json:"bytes"`
	Printed *int64 `json:"printed,omitempty"` // Total free space
	// Buckets: every bucket the dump prints, empty ones too, in the order printed.
	Buckets []HeapBucket `json:"buckets"`
	// Reserved: the reserved free lists of an SGA heap, with the non-empty buckets.
	Reserved []HeapReserved `json:"reserved,omitempty"`
}

// HeapBucket is one free list.
type HeapBucket struct {
	N      int   `json:"n"`    // "Bucket N"
	Size   int64 `json:"size"` // "size=": the smallest chunk the list holds
	Chunks int   `json:"chunks"`
	Bytes  int64 `json:"bytes"`
}

// HeapReserved is one block of reserved free lists ("RESERVED FREE LISTS:", "... FOR SIZES 64KB to 256KB:").
type HeapReserved struct {
	Title   string       `json:"title"`
	Line    int          `json:"line"`
	Chunks  int          `json:"chunks"`
	Bytes   int64        `json:"bytes"`
	Printed *int64       `json:"printed,omitempty"` // "Total of this reserved free space"
	Buckets []HeapBucket `json:"buckets"`           // the non-empty ones
}

// HeapPermanent is the PERMANENT CHUNKS: part.
type HeapPermanent struct {
	Line    int    `json:"line"`
	Chunks  int    `json:"chunks"` // chunk lines of type perm
	Bytes   int64  `json:"bytes"`
	Printed *int64 `json:"printed,omitempty"` // Permanent space
}

// HeapUnpinned is the unpinned part of an SGA heap ("Unpinned space = N rcr=N trn=N").
type HeapUnpinned struct {
	Line  int   `json:"line"`
	Bytes int64 `json:"bytes"`
	Rcr   int   `json:"rcr"`
	Trn   int   `json:"trn"`
}

// HeapSub is a sub-heap seen in this heap.
type HeapSub struct {
	Desc    string `json:"desc"`              // "0x7f952bcd11e8"
	Name    string `json:"name"`              // the comment of the chunk that holds its descriptor, else of its first chunk
	Size    int64  `json:"size,omitempty"`    // the ds line's sz= (the sub-heap's own size); absent when the dump has no ds line for it
	Held    int64  `json:"held"`              // bytes of this heap's chunks that carry ds=<desc>
	Chunks  int    `json:"chunks"`            // those chunks
	Extents int    `json:"extents,omitempty"` // the ds line's ct=
	Line    int    `json:"line"`              // the ds line, else the first chunk that carries it
	Node    string `json:"node,omitempty"`    // the node of its own dump, when the file holds it
}

// HeapLargest is a line of the "N LARGEST SUB HEAPS" block.
type HeapLargest struct {
	Desc string `json:"desc"`
	Name string `json:"name"`
	Size int64  `json:"size"` // "size=" as printed (a little more than the sub-heap's own total)
	Line int    `json:"line"`
	Node string `json:"node,omitempty"`
}

// HeapRun is a heap of the same dump run (the heaps one command dumped, in file order).
type HeapRun struct {
	Node   string `json:"node"`
	Name   string `json:"name"`
	Desc   string `json:"desc"`
	Parent string `json:"parent,omitempty"` // the node of its parent heap in this run
	Depth  *int   `json:"depth,omitempty"`
	Size   int64  `json:"size"` // "dsx heap size"
	From   int    `json:"from"`
	To     int    `json:"to"`
}

// groupType is the type a chunk type is counted under: the shared pool's family recr<P|U><C|T|R><nnn>
// (recrPC001, recrUT003, ...) is one type, "recr". "recreate" is not in it: the letter after "recr" is
// upper case in the family.
func groupType(raw []byte) string {
	if len(raw) >= 7 && raw[0] == 'r' && raw[1] == 'e' && raw[2] == 'c' && raw[3] == 'r' && raw[4] >= 'A' && raw[4] <= 'Z' {
		return "recr"
	}
	return string(raw)
}

// splitComment splits a comment (as between the quotes) into its group key (trimmed, before "^") and the
// suffix after the "^".
func splitComment(c []byte) (key, suffix []byte) {
	c = bytes.TrimRight(c, " ")
	if i := bytes.IndexByte(c, '^'); i >= 0 {
		return bytes.TrimRight(c[:i], " "), c[i+1:]
	}
	return c, nil
}

// ---- the parser

type heapPhase uint8

const (
	hpHeader heapPhase = iota
	hpExtents
	hpAfterExtents // after Total heap size
	hpFree
	hpAfterFree // after Total free space; the reserved lists, if any
	hpReserved
	hpUnpinned
	hpPerm
	hpAfterPerm
	hpSubs
)

type typeAgg struct {
	chunks   int
	bytes    int64
	variants map[string]*HeapVariant
}

type commentAgg struct {
	key      string
	types    []HeapTypeShare
	chunks   int
	bytes    int64
	line     int
	suffixes map[string]struct{}
	hashed   bool
}

type subAgg struct {
	desc    string // normalised: no 0x, no leading zeros, lower case
	name    string
	size    int64
	held    int64
	chunks  int
	extents int
	line    int
	hasDS   bool
}

type printedTotal struct {
	v    int64
	line int
	ok   bool
}

type resAgg struct {
	title   string
	line    int
	chunks  int
	bytes   int64
	printed printedTotal
	buckets []HeapBucket
}

// heapParser reads the lines of one heap dump.
type heapParser struct {
	lite bool // no aggregates: only the hook is called, for the chunk lines of the extents
	// hook, when set, is called for the chunk line n of an extent with its raw type and the group key of
	// its comment (it may not keep the slices).
	hook func(n int, typ, key []byte)

	started, ended bool
	phase          heapPhase

	name, desc, parent string
	depth              *int
	hsize              int64
	pdb                *int
	filtered           *int
	sampled            bool
	sampledPct         int

	extents int
	chunks  int
	bytes   int64
	types   map[string]*typeAgg
	cmts    map[string]*commentAgg
	subs    map[string]*subAgg
	subList []*subAgg // creation order

	lastKey   string
	lastName  string
	haveLast  bool
	totalHeap printedTotal
	totalFree printedTotal
	totalPerm printedTotal
	resAll    printedTotal

	freeLine   int
	freeChunks int
	freeBytes  int64
	buckets    []HeapBucket
	bucket     *HeapBucket // the open bucket (index into buckets or into the reserved list's)
	reserved   []*resAgg
	res        *resAgg

	unpinned *HeapUnpinned

	permLine   int
	permChunks int
	permBytes  int64

	largest []HeapLargest

	contBlocks, contLines int
}

func newHeapParser() *heapParser {
	return &heapParser{types: map[string]*typeAgg{}, cmts: map[string]*commentAgg{}, subs: map[string]*subAgg{}}
}

func isStar54(l []byte) bool {
	if len(l) != 54 || l[0] != '*' {
		return false
	}
	for _, c := range l {
		if c != '*' {
			return false
		}
	}
	return true
}

// feed is the pass over one line of the node.
func (p *heapParser) feed(n int, l []byte) {
	if p.ended || len(l) == 0 {
		return
	}
	if l[0] == '*' && isStar54(l) {
		if p.started {
			p.ended = true
		}
		return
	}
	if !p.started {
		if hasPrefix(l, `HEAP DUMP heap name="`) {
			p.start(l)
		}
		return
	}
	if l[0] != ' ' && isContentRow(l) {
		p.contLines++
		return
	}
	switch l[0] {
	case ' ':
		p.indented(n, l)
	case 'E':
		if hasPrefix(l, "EXTENT ") && p.phase <= hpExtents {
			p.phase = hpExtents
			p.extents++
		}
	case 'T':
		p.total(n, l)
	case 'F':
		if exact(l, "FREE LISTS:") {
			p.phase, p.freeLine, p.bucket = hpFree, n, nil
		}
	case 'R':
		if hasPrefix(l, "RESERVED FREE LISTS") {
			p.phase = hpReserved
			p.res = &resAgg{title: strings.TrimRight(strings.TrimSpace(string(l)), ":"), line: n}
			p.reserved = append(p.reserved, p.res)
			p.bucket = nil
		}
	case 'U':
		if hasPrefix(l, "UNPINNED RECREATABLE CHUNKS") {
			p.phase = hpUnpinned
		} else if hasPrefix(l, "Unpinned space") {
			p.unpin(n, l)
		}
	case 'P':
		if exact(l, "PERMANENT CHUNKS:") {
			p.phase, p.permLine = hpPerm, n
		} else if hasPrefix(l, "Permanent space") {
			p.totalPerm = printedTotal{numAfterEq(l), n, true}
			p.phase = hpAfterPerm
		}
	case 'D':
		if hasPrefix(l, "Dump of memory") {
			p.contBlocks++
			p.contLines++
		} else if hasPrefix(l, "Dumping sample extents") {
			p.sampled = true
		}
	case '(':
		if hasPrefix(l, "(only chunks clearly belonging to pdb id ") {
			v, _ := digitsAt(l[len("(only chunks clearly belonging to pdb id "):])
			id := int(v)
			p.filtered = &id
		}
	default:
		if l[0] >= '0' && l[0] <= '9' {
			p.largestHeader(l)
		}
	}
}

// start reads the HEAP DUMP line.
func (p *heapParser) start(l []byte) {
	p.started = true
	p.phase = hpHeader
	s := string(l)
	if i := strings.Index(s, `name="`); i >= 0 {
		rest := s[i+6:]
		if j := strings.IndexByte(rest, '"'); j >= 0 {
			p.name = strings.TrimSpace(rest[:j])
			rest = rest[j+1:]
			if k := strings.Index(rest, "desc=0x"); k >= 0 {
				if f := strings.Fields(rest[k+7:]); len(f) > 0 {
					p.desc = "0x" + normHex(f[0])
				}
			}
		}
	}
}

// indented handles the lines that begin with a blank: the chunk lines, header lines, buckets, ds lines.
func (p *heapParser) indented(n int, l []byte) {
	if len(l) > 8 && l[1] == ' ' && l[2] == 'C' && hasPrefix(l[2:], "Chunk ") {
		p.chunkLine(n, l)
		return
	}
	t := bytes.TrimLeft(l, " ")
	if len(t) == 0 {
		return
	}
	if p.phase == hpHeader {
		p.headerLine(t)
		return
	}
	switch t[0] {
	case 'B':
		if p.phase == hpFree && hasPrefix(t, "Bucket ") {
			p.openBucket(t[len("Bucket "):], false)
		}
	case 'R':
		if p.phase == hpReserved && hasPrefix(t, "Reserved bucket ") {
			p.openBucket(t[len("Reserved bucket "):], true)
		} else if hasPrefix(t, "Repeat ") {
			p.contLines++
		}
	case 'd':
		if p.phase == hpExtents && hasPrefix(t, "ds ") {
			p.dsLine(n, t)
		}
	case 'S':
		if p.phase == hpSubs && hasPrefix(t, "Subheap ds=0x") {
			p.largestLine(n, t)
		}
	}
}

// headerLine reads a line of the header (before the first extent).
func (p *heapParser) headerLine(t []byte) {
	switch {
	case hasPrefix(t, "parent="):
		f := t[len("parent="):]
		if i := bytes.IndexByte(f, ' '); i >= 0 {
			f = f[:i]
		}
		if hasPrefix(f, "0x") {
			p.parent = "0x" + normHex(string(f[2:]))
		}
	case hasPrefix(t, "dsx heap size="):
		rest := t[len("dsx heap size="):]
		v, k := digitsAt(rest)
		p.hsize = v
		if i := bytes.Index(rest[k:], []byte("dsx heap depth=")); i >= 0 {
			d, _ := digitsAt(rest[k+i+len("dsx heap depth="):])
			dv := int(d)
			p.depth = &dv
		}
	case hasPrefix(t, "pdb id="):
		v, _ := digitsAt(t[len("pdb id="):])
		id := int(v)
		p.pdb = &id
	case hasPrefix(t, "Dumping sample extents"):
		p.sampled = true
	case hasPrefix(t, "Heap has significant amount of free memory"):
		p.sampled = true
		if i := bytes.IndexByte(t, '('); i >= 0 {
			v, _ := digitsAt(t[i+1:])
			p.sampledPct = int(v)
		}
	}
}

func (p *heapParser) openBucket(rest []byte, reserved bool) {
	num, k := digitsAt(rest)
	b := HeapBucket{N: int(num)}
	if i := bytes.Index(rest[k:], []byte("size=")); i >= 0 {
		b.Size, _ = digitsAt(rest[k+i+5:])
	}
	if reserved && p.res != nil {
		p.res.buckets = append(p.res.buckets, b)
		p.bucket = &p.res.buckets[len(p.res.buckets)-1]
		return
	}
	p.buckets = append(p.buckets, b)
	p.bucket = &p.buckets[len(p.buckets)-1]
}

// total handles the lines that begin with "Total".
func (p *heapParser) total(n int, l []byte) {
	switch {
	case hasPrefix(l, "Total heap size"):
		p.totalHeap = printedTotal{numAfterEq(l), n, true}
		p.phase = hpAfterExtents
	case hasPrefix(l, "Total free space"):
		p.totalFree = printedTotal{numAfterEq(l), n, true}
		p.phase = hpAfterFree
	case hasPrefix(l, "Total of this reserved free space"):
		if p.res != nil {
			p.res.printed = printedTotal{numAfterEq(l), n, true}
		}
	case hasPrefix(l, "Total of all reserved free space"):
		p.resAll = printedTotal{numAfterEq(l), n, true}
	}
}

func (p *heapParser) unpin(n int, l []byte) {
	u := &HeapUnpinned{Line: n, Bytes: numAfterEq(l)}
	if i := bytes.Index(l, []byte("rcr=")); i >= 0 {
		v, _ := digitsAt(l[i+4:])
		u.Rcr = int(v)
	}
	if i := bytes.Index(l, []byte("trn=")); i >= 0 {
		v, _ := digitsAt(l[i+4:])
		u.Trn = int(v)
	}
	p.unpinned = u
}

// largestHeader: "5 LARGEST SUB HEAPS for heap name=..." begins the block of the largest sub-heaps.
func (p *heapParser) largestHeader(l []byte) bool {
	_, k := digitsAt(l)
	if k > 0 && hasPrefix(l[k:], " LARGEST SUB HEAPS") {
		p.phase = hpSubs
		return true
	}
	return false
}

// largestLine: "  Subheap ds=0x7fde992411e8  heap name=  koh-kghu call   size=         3552984"
func (p *heapParser) largestLine(n int, t []byte) {
	s := string(t)
	h := HeapLargest{Line: n}
	rest := s[len("Subheap ds=0x"):]
	i := strings.IndexByte(rest, ' ')
	if i < 0 {
		return
	}
	h.Desc = "0x" + normHex(rest[:i])
	rest = rest[i:]
	if j := strings.Index(rest, "heap name="); j >= 0 {
		rest = rest[j+len("heap name="):]
		if k := strings.LastIndex(rest, "size="); k >= 0 {
			h.Name = strings.TrimSpace(rest[:k])
			h.Size, _ = strconv.ParseInt(strings.TrimSpace(rest[k+5:]), 10, 64)
		}
	}
	p.largest = append(p.largest, h)
}

// chunk is a parsed chunk line.
type chunk struct {
	size       int64
	typ        []byte
	comment    []byte
	hasComment bool
	rest       []byte // after the closing quote (or after the type)
}

// parseChunk parses "  Chunk <addr> sz= <n> <type> "<comment>" rest".
func parseChunk(l []byte) (c chunk, ok bool) {
	i := bytes.Index(l, []byte(" sz="))
	if i < 0 {
		return c, false
	}
	j := i + 4
	for j < len(l) && l[j] == ' ' {
		j++
	}
	v, k := digitsAt(l[j:])
	if k == 0 {
		return c, false
	}
	c.size = v
	j += k
	for j < len(l) && l[j] == ' ' {
		j++
	}
	t := j
	for j < len(l) && l[j] != ' ' {
		j++
	}
	c.typ = l[t:j]
	for j < len(l) && l[j] == ' ' {
		j++
	}
	c.rest = l[j:]
	if j < len(l) && l[j] == '"' {
		if e := bytes.LastIndexByte(l, '"'); e > j {
			c.comment, c.hasComment = l[j+1:e], true
			c.rest = l[e+1:]
		}
	}
	return c, true
}

// chunkLine counts a chunk line by the phase it is in.
func (p *heapParser) chunkLine(n int, l []byte) {
	c, ok := parseChunk(l)
	if !ok {
		return
	}
	switch p.phase {
	case hpHeader, hpExtents:
		p.phase = hpExtents
		p.extentChunk(n, c)
	case hpFree:
		if string(c.typ) == "kghdsx" {
			return
		}
		p.freeChunks++
		p.freeBytes += c.size
		if p.bucket != nil {
			p.bucket.Chunks++
			p.bucket.Bytes += c.size
		}
	case hpReserved:
		if p.res != nil {
			p.res.chunks++
			p.res.bytes += c.size
			if p.bucket != nil {
				p.bucket.Chunks++
				p.bucket.Bytes += c.size
			}
		}
	case hpPerm:
		if string(c.typ) == "perm" {
			p.permChunks++
			p.permBytes += c.size
		}
	}
}

// extentChunk counts a chunk line of the extents.
func (p *heapParser) extentChunk(n int, c chunk) {
	key, suffix := splitComment(c.comment)
	if p.hook != nil {
		p.hook(n, c.typ, key)
	}
	if p.lite {
		return
	}
	p.chunks++
	p.bytes += c.size
	tg := groupType(c.typ)
	ta := p.types[tg]
	if ta == nil {
		ta = &typeAgg{}
		p.types[tg] = ta
	}
	ta.chunks++
	ta.bytes += c.size
	if tg == "recr" {
		if ta.variants == nil {
			ta.variants = map[string]*HeapVariant{}
		}
		v := ta.variants[string(c.typ)]
		if v == nil {
			v = &HeapVariant{Type: string(c.typ)}
			ta.variants[v.Type] = v
		}
		v.Chunks++
		v.Bytes += c.size
	}
	ca := p.cmts[string(key)]
	if ca == nil {
		ca = &commentAgg{key: string(key), line: n}
		p.cmts[ca.key] = ca
	}
	ca.chunks++
	ca.bytes += c.size
	found := false
	for i := range ca.types {
		if ca.types[i].Type == tg {
			ca.types[i].Chunks++
			ca.types[i].Bytes += c.size
			found = true
			break
		}
	}
	if !found {
		ca.types = append(ca.types, HeapTypeShare{Type: tg, Chunks: 1, Bytes: c.size})
	}
	if suffix != nil {
		ca.hashed = true
		if ca.suffixes == nil {
			ca.suffixes = map[string]struct{}{}
		}
		if _, ok := ca.suffixes[string(suffix)]; !ok {
			ca.suffixes[string(suffix)] = struct{}{}
		}
	}
	// the sub-heap this chunk is an extent of: "ds=0x<desc>"
	if i := bytes.Index(c.rest, []byte("ds=0x")); i >= 0 {
		rest := c.rest[i+5:]
		e := 0
		for e < len(rest) && isHex(rest[e]) {
			e++
		}
		d := normHexBytes(rest[:e])
		s := p.subs[string(d)]
		if s == nil {
			s = &subAgg{desc: string(d), line: n, name: strings.TrimSpace(string(c.comment))}
			p.subs[s.desc] = s
			p.subList = append(p.subList, s)
		}
		s.held += c.size
		s.chunks++
	}
	p.lastName, p.haveLast = strings.TrimSpace(string(c.comment)), true
}

// dsLine: "ds     7f952bcd11e8 sz=  3552984 ct=      158", the line after the chunk that holds a sub-heap's
// descriptor.
func (p *heapParser) dsLine(n int, t []byte) {
	f := strings.Fields(string(t))
	if len(f) < 3 || !isAllHex(f[1]) {
		return
	}
	var sz, ct string
	have := false
	for i := 2; i < len(f); i++ {
		switch {
		case f[i] == "sz=" && i+1 < len(f):
			sz, have = f[i+1], true
			i++
		case strings.HasPrefix(f[i], "sz="):
			sz, have = f[i][3:], true
		case f[i] == "ct=" && i+1 < len(f):
			ct = f[i+1]
			i++
		case strings.HasPrefix(f[i], "ct="):
			ct = f[i][3:]
		}
	}
	if !have {
		return
	}
	d := normHex(f[1])
	s := p.subs[d]
	if s == nil {
		s = &subAgg{desc: d}
		p.subs[d] = s
		p.subList = append(p.subList, s)
	}
	if !s.hasDS {
		s.hasDS = true
		s.line = n
		if p.haveLast {
			s.name = p.lastName
		}
	}
	s.size, _ = strconv.ParseInt(sz, 10, 64)
	v, _ := strconv.Atoi(ct)
	s.extents = v
}

func isHex(c byte) bool {
	return c >= '0' && c <= '9' || c >= 'a' && c <= 'f' || c >= 'A' && c <= 'F'
}

func isAllHex(s string) bool {
	if s == "" {
		return false
	}
	for i := 0; i < len(s); i++ {
		if !isHex(s[i]) {
			return false
		}
	}
	return true
}

// normHex: lower case, no leading zeros ("076d91398" -> "76d91398").
func normHex(s string) string {
	s = strings.TrimPrefix(strings.TrimPrefix(s, "0x"), "0X")
	s = strings.TrimLeft(strings.ToLower(s), "0")
	if s == "" {
		return "0"
	}
	return s
}

func normHexBytes(b []byte) []byte {
	for len(b) > 1 && b[0] == '0' {
		b = b[1:]
	}
	out := make([]byte, len(b))
	for i, c := range b {
		if c >= 'A' && c <= 'F' {
			c += 'a' - 'A'
		}
		out[i] = c
	}
	return out
}

// isContentRow: a row of a memory dump: 8 or more hex digits at the start of the line, then a blank
// ("7F311C358020 000010E9 C0B38F00 ..."); a "Repeat N times" line is counted where it is read.
func isContentRow(l []byte) bool {
	i := 0
	for i < len(l) && isHex(l[i]) {
		i++
	}
	return i >= 8 && i < len(l) && l[i] == ' ' && bytes.HasSuffix(bytes.TrimRight(l, " "), []byte("]"))
}

// digitsAt parses the decimal number at the start of b after blanks, and the bytes taken (blanks included).
func digitsAt(b []byte) (int64, int) {
	i := 0
	for i < len(b) && b[i] == ' ' {
		i++
	}
	st := i
	var v int64
	for i < len(b) && b[i] >= '0' && b[i] <= '9' {
		v = v*10 + int64(b[i]-'0')
		i++
	}
	if i == st {
		return 0, 0
	}
	return v, i
}

// numAfterEq: the number after the first "=" of a line ("Total heap size    =  4707160").
func numAfterEq(l []byte) int64 {
	i := bytes.IndexByte(l, '=')
	if i < 0 {
		return 0
	}
	v, _ := digitsAt(l[i+1:])
	return v
}

// ---- the reading

// startsHeap: the node's first lines are a heap dump's (its rule and HEAP DUMP line).
func (r *Reader) startsHeap(from int) bool {
	raw, err := r.src.Read(from, 2)
	if err != nil {
		return false
	}
	for _, l := range splitLines(raw) {
		if hasPrefix(l, `HEAP DUMP heap name="`) {
			return true
		}
	}
	return false
}

// heapReading reads the heap dump of the node id (lines from..to).
func (r *Reader) heapReading(id string, from, to int) (Reading, error) {
	if !r.startsHeap(from) {
		return nil, wrapNoNode(id)
	}
	p := newHeapParser()
	err := scanLines(r.src, from, to, func(n int, _, line, _ []byte) { p.feed(n, line) })
	if err != nil {
		return nil, err
	}
	top := r.topAt(from, "heap")
	cut := !p.ended && !p.totalPerm.ok
	if top != nil {
		cut = top.Cut
	}
	hr := p.reading(id, from, to, cut)
	r.linkHeap(hr, p, top)
	return hr, nil
}

// topAt is the top-level node of this kind that starts at line from, if there is one.
func (r *Reader) topAt(from int, kind string) *Node {
	top := r.Scan.Top
	i := sort.Search(len(top), func(i int) bool { return top[i].From >= from })
	if i < len(top) && top[i].From == from && top[i].Kind == kind {
		return &top[i]
	}
	return nil
}

// reading builds the model out of what the pass found.
func (p *heapParser) reading(id string, from, to int, cut bool) *HeapReading {
	if cut {
		// the last line of a dump that stops short may stop in the middle of a number: a total printed on it
		// is not taken
		for _, pt := range []*printedTotal{&p.totalHeap, &p.totalFree, &p.totalPerm, &p.resAll} {
			if pt.ok && pt.line == to {
				pt.ok = false
			}
		}
		for _, ra := range p.reserved {
			if ra.printed.ok && ra.printed.line == to {
				ra.printed.ok = false
			}
		}
	}
	hr := &HeapReading{Kind: ReadingHeap, Node: id, Name: p.name, Desc: p.desc, Parent: p.parent, Depth: p.depth, PDB: p.pdb,
		From: from, To: to, Lines: to - from + 1, Extents: p.extents, Chunks: p.chunks, Bytes: p.bytes, HeapSize: p.hsize}
	if p.parent == "0x0" { // "(nil)" is not a descriptor
		hr.Parent = ""
	}
	f := &hr.Flags
	if p.contBlocks > 0 {
		f.Contents = &HeapContents{Blocks: p.contBlocks, Lines: p.contLines}
	}
	f.PDBFiltered = p.filtered
	f.Sampled, f.SampledPercent = p.sampled, p.sampledPct
	f.NoExtents = p.extents == 0 && !p.totalHeap.ok
	f.Cut = cut

	hr.ByType = p.byType()
	hr.ByComment, hr.OtherComments, hr.Comments = p.byComment()

	fl := &hr.FreeLists
	fl.Present = p.freeLine > 0
	fl.Line = p.freeLine
	fl.Chunks, fl.Bytes = p.freeChunks, p.freeBytes
	if p.totalFree.ok {
		v := p.totalFree.v
		fl.Printed = &v
	}
	fl.Buckets = append([]HeapBucket{}, p.buckets...)
	for _, ra := range p.reserved {
		rr := HeapReserved{Title: ra.title, Line: ra.line, Chunks: ra.chunks, Bytes: ra.bytes, Buckets: []HeapBucket{}}
		if ra.printed.ok {
			v := ra.printed.v
			rr.Printed = &v
		}
		for _, b := range ra.buckets {
			if b.Chunks > 0 {
				rr.Buckets = append(rr.Buckets, b)
			}
		}
		fl.Reserved = append(fl.Reserved, rr)
	}
	if p.permLine > 0 {
		pm := &HeapPermanent{Line: p.permLine, Chunks: p.permChunks, Bytes: p.permBytes}
		if p.totalPerm.ok {
			v := p.totalPerm.v
			pm.Printed = &v
		}
		hr.Permanent = pm
	}
	hr.Unpinned = p.unpinned
	hr.Subheaps, hr.SubTotal, hr.SubOther = p.subheaps()
	hr.Largest = append([]HeapLargest{}, p.largest...)
	hr.Checks = p.checks(hr)
	hr.Run = []HeapRun{}
	return hr
}

func (p *heapParser) byType() []HeapType {
	out := make([]HeapType, 0, len(p.types))
	for t, a := range p.types {
		ht := HeapType{Type: t, Chunks: a.chunks, Bytes: a.bytes}
		for _, v := range a.variants {
			ht.Variants = append(ht.Variants, *v)
		}
		sort.Slice(ht.Variants, func(i, j int) bool {
			if ht.Variants[i].Bytes != ht.Variants[j].Bytes {
				return ht.Variants[i].Bytes > ht.Variants[j].Bytes
			}
			return ht.Variants[i].Type < ht.Variants[j].Type
		})
		out = append(out, ht)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].Bytes != out[j].Bytes {
			return out[i].Bytes > out[j].Bytes
		}
		return out[i].Type < out[j].Type
	})
	return out
}

func (p *heapParser) byComment() ([]HeapComment, *HeapOther, int) {
	all := make([]*commentAgg, 0, len(p.cmts))
	for _, a := range p.cmts {
		all = append(all, a)
	}
	sort.Slice(all, func(i, j int) bool {
		if all[i].bytes != all[j].bytes {
			return all[i].bytes > all[j].bytes
		}
		return all[i].key < all[j].key
	})
	out := make([]HeapComment, 0, min(len(all), CommentCap))
	var other *HeapOther
	for i, a := range all {
		if i >= CommentCap {
			if other == nil {
				other = &HeapOther{}
			}
			other.Count++
			other.Chunks += a.chunks
			other.Bytes += a.bytes
			continue
		}
		hc := HeapComment{Comment: a.key, Types: append([]HeapTypeShare{}, a.types...), Chunks: a.chunks, Bytes: a.bytes, Line: a.line}
		sort.SliceStable(hc.Types, func(i, j int) bool {
			if hc.Types[i].Bytes != hc.Types[j].Bytes {
				return hc.Types[i].Bytes > hc.Types[j].Bytes
			}
			return hc.Types[i].Type < hc.Types[j].Type
		})
		if a.hashed {
			hc.Suffixes = len(a.suffixes)
		}
		out = append(out, hc)
	}
	return out, other, len(all)
}

func (p *heapParser) subheaps() ([]HeapSub, int, *HeapOther) {
	all := make([]*subAgg, len(p.subList))
	copy(all, p.subList)
	key := func(s *subAgg) int64 {
		if s.size > 0 {
			return s.size
		}
		return s.held
	}
	sort.SliceStable(all, func(i, j int) bool {
		if key(all[i]) != key(all[j]) {
			return key(all[i]) > key(all[j])
		}
		return all[i].desc < all[j].desc
	})
	out := make([]HeapSub, 0, min(len(all), SubheapCap))
	var other *HeapOther
	for i, s := range all {
		if i >= SubheapCap {
			if other == nil {
				other = &HeapOther{}
			}
			other.Count++
			other.Chunks += s.chunks
			other.Bytes += s.held
			continue
		}
		out = append(out, HeapSub{Desc: "0x" + s.desc, Name: s.name, Size: s.size, Held: s.held, Chunks: s.chunks, Extents: s.extents, Line: s.line})
	}
	return out, len(all), other
}

// checks makes the comparisons of the sums with the totals the dump prints.
func (p *heapParser) checks(hr *HeapReading) []HeapCheck {
	// why no check can be made at all
	var blocked string
	switch {
	case p.filtered != nil:
		blocked = fmt.Sprintf("the dump was taken inside a PDB and leaves out the chunks of other containers (only chunks clearly belonging to pdb id %d are dumped)", *p.filtered)
	case p.sampled:
		blocked = "the heap was sampled (\"Dumping sample extents\"): only some extents are listed and no totals are printed"
	case hr.Flags.NoExtents:
		blocked = "the heap header has no extents: the dump lists no chunks and prints no totals"
	}
	mk := func(name, what string, computed int64, pt printedTotal, missing string) HeapCheck {
		c := HeapCheck{Name: name, What: what, Computed: computed}
		switch {
		case blocked != "":
			c.State, c.Reason = CheckNone, blocked
			if pt.ok {
				v := pt.v
				c.Printed, c.Line = &v, pt.line
			}
		case !pt.ok:
			c.State = CheckNone
			if hr.Flags.Cut {
				c.Reason = "the dump is cut before the " + missing + " line"
			} else {
				c.Reason = "the dump prints no " + missing + " line"
			}
		default:
			v := pt.v
			c.Printed, c.Line = &v, pt.line
			if computed == pt.v {
				c.State = CheckMatch
			} else {
				c.State, c.Diff = CheckDiffer, computed-pt.v
			}
		}
		return c
	}
	out := []HeapCheck{
		mk(CheckHeap, "chunks of the extents against Total heap size", p.bytes, p.totalHeap, "Total heap size"),
		mk(CheckFree, "chunks of the free lists against Total free space", p.freeBytes, p.totalFree, "Total free space"),
		mk(CheckPerm, "perm chunks under PERMANENT CHUNKS against Permanent space", p.permBytes, p.totalPerm, "Permanent space"),
	}
	if len(p.reserved) > 0 {
		var sum int64
		var last printedTotal
		var thisSum int64
		for _, ra := range p.reserved {
			sum += ra.bytes
			if ra.printed.ok {
				thisSum += ra.printed.v
				last = printedTotal{0, ra.printed.line, true}
			}
		}
		pt := p.resAll
		what := "chunks of the reserved free lists against Total of all reserved free space"
		if !pt.ok && last.ok {
			// a single block prints only "Total of this reserved free space"
			pt = printedTotal{thisSum, last.line, true}
			what = "chunks of the reserved free lists against Total of this reserved free space"
		}
		out = append(out, mk(CheckReserved, what, sum, pt, "Total of all reserved free space"))
	}
	return out
}

// ---- the dump run and the links

// runInfo is the heap dumps one run holds.
type runInfo struct {
	members []runMember
}

type runMember struct {
	node         Node
	desc, parent string
}

// readHeapHeader reads the descriptor and the parent descriptor out of the header of the heap dump the node
// starts.
func (r *Reader) readHeapHeader(n Node) runMember {
	m := runMember{node: n}
	raw, err := r.src.Read(n.From, 16)
	if err != nil {
		return m
	}
	hp := newHeapParser()
	for _, l := range splitLines(raw) {
		if hp.started && len(l) > 0 && l[0] == 'E' {
			break
		}
		if len(l) > 0 && l[0] == ' ' {
			hp.headerLine(bytes.TrimLeft(l, " "))
		} else if !hp.started && hasPrefix(l, `HEAP DUMP heap name="`) {
			hp.start(l)
		}
	}
	m.desc, m.parent = hp.desc, hp.parent
	if m.parent == "0x0" {
		m.parent = ""
	}
	return m
}

// runOf returns the heap dumps of the run the top-level heap node at index idx belongs to, and the index of
// the node among them. A run is the heaps of one command: the heap nodes that follow one another (with
// nothing but markers and blank lines between them), cut where a descriptor repeats (a second command dumps
// the same heaps again).
func (r *Reader) runOf(idx int) (*runInfo, int) {
	top := r.Scan.Top
	const reach = 2000
	lo, hi := idx, idx
	glue := func(n Node) bool {
		return n.Kind == "heap" || (n.Kind == "other" && n.Sub == markersOnlySub)
	}
	for lo > 0 && idx-lo < reach && glue(top[lo-1]) {
		lo--
	}
	for hi < len(top)-1 && hi-idx < reach && glue(top[hi+1]) {
		hi++
	}
	r.hmu.Lock()
	defer r.hmu.Unlock()
	if r.hdrs == nil {
		r.hdrs = map[int]runMember{}
	}
	cur := &runInfo{}
	seen := map[string]bool{}
	for i := lo; i <= hi; i++ {
		n := top[i]
		if n.Kind != "heap" {
			continue
		}
		m, ok := r.hdrs[n.From]
		if !ok {
			m = r.readHeapHeader(n)
			r.hdrs[n.From] = m
		}
		if m.desc != "" && seen[m.desc] { // the same heap again: another command's dump begins
			if k := memberIndex(cur, top[idx].From); k >= 0 {
				return cur, k
			}
			cur, seen = &runInfo{}, map[string]bool{}
		}
		if m.desc != "" {
			seen[m.desc] = true
		}
		cur.members = append(cur.members, m)
	}
	if k := memberIndex(cur, top[idx].From); k >= 0 {
		return cur, k
	}
	return &runInfo{members: []runMember{{node: top[idx]}}}, 0
}

func memberIndex(ri *runInfo, from int) int {
	for k, m := range ri.members {
		if m.node.From == from {
			return k
		}
	}
	return -1
}

// linkHeap fills the links of a reading: its parent heap, the dump of each sub-heap, and the run.
func (r *Reader) linkHeap(hr *HeapReading, p *heapParser, top *Node) {
	if top == nil { // a heap nested in another section: its run is itself
		hr.Run = []HeapRun{{Node: hr.Node, Name: hr.Name, Desc: hr.Desc, Depth: hr.Depth, Size: hr.HeapSize, From: hr.From, To: hr.To}}
		return
	}
	idx := sort.Search(len(r.Scan.Top), func(i int) bool { return r.Scan.Top[i].From >= top.From })
	run, at := r.runOf(idx)
	ms := run.members
	if len(ms) > 0 {
		hr.RunLabel = r.runLabel(ms[0].node.From)
	}
	// parent of each member: the nearest earlier member with the descriptor named by its parent=
	parentOf := func(k int) int {
		if ms[k].parent == "" {
			return -1
		}
		for j := k - 1; j >= 0; j-- {
			if ms[j].desc == ms[k].parent {
				return j
			}
		}
		return -1
	}
	if pj := parentOf(at); pj >= 0 {
		hr.ParentNode = ms[pj].node.ID
	}
	// the dump of a sub-heap: the nearest later member with its descriptor, else the nearest earlier
	find := func(desc string) string {
		if desc == "" {
			return ""
		}
		for j := at + 1; j < len(ms); j++ {
			if ms[j].desc == desc {
				return ms[j].node.ID
			}
		}
		for j := at - 1; j >= 0; j-- {
			if ms[j].desc == desc {
				return ms[j].node.ID
			}
		}
		return ""
	}
	for i := range hr.Subheaps {
		hr.Subheaps[i].Node = find(hr.Subheaps[i].Desc)
	}
	for i := range hr.Largest {
		hr.Largest[i].Node = find(hr.Largest[i].Desc)
	}
	// the run, bounded: a window of RunCap members around this one
	a, b := 0, len(ms)
	if len(ms) > RunCap {
		a = max(0, min(at-RunCap/2, len(ms)-RunCap))
		b = a + RunCap
		hr.RunMore = len(ms) - RunCap
	}
	hr.Run = make([]HeapRun, 0, b-a)
	for k := a; k < b; k++ {
		m := ms[k]
		e := HeapRun{Node: m.node.ID, Name: m.node.Name, Desc: m.desc, Depth: m.node.Depth, Size: m.node.Size, From: m.node.From, To: m.node.To}
		if pj := parentOf(k); pj >= 0 {
			e.Parent = ms[pj].node.ID
		}
		hr.Run = append(hr.Run, e)
	}
}

// runLabel reads the label of the dump run whose first heap starts at line first: the oradebug command on the
// lines before it. It walks back over blank lines, "*** " markers and rules and stops at the first line that is
// none of them: the command line, or no label.
func (r *Reader) runLabel(first int) string {
	if first <= 1 {
		return ""
	}
	lo := max(1, first-24)
	raw, err := r.src.Read(lo, first-lo)
	if err != nil {
		return ""
	}
	lines := splitLines(raw)
	for i := len(lines) - 1; i >= 0; i-- {
		l := bytes.TrimSpace(lines[i])
		if len(l) == 0 || hasPrefix(l, "*** ") || isRule(l) || star54(l) {
			continue
		}
		const pfx = "Processing Oradebug command '"
		if hasPrefix(l, pfx) {
			cmd := string(l[len(pfx):])
			if j := strings.LastIndexByte(cmd, '\''); j >= 0 {
				cmd = cmd[:j]
			}
			if cmd = strings.Join(strings.Fields(cmd), " "); cmd != "" {
				return "oradebug: " + cmd
			}
		}
		return ""
	}
	return ""
}

// ---- the chunk lines of a comment

// HeapLines is an answer of Reader.HeapLines.
type HeapLines struct {
	Node  string `json:"node"`
	Lines []int  `json:"lines"` // line numbers of chunk lines of the extents, ascending
	// More is how many matching lines follow those listed; Next, when More > 0, is the "after" for the next
	// page (the last line listed).
	More int `json:"more"`
	Next int `json:"next,omitempty"`
	// Total is how many chunk lines match in all.
	Total int `json:"total"`
}

// HeapLines lists the chunk lines of the extents of the heap dump of node id whose comment group is comment
// (what HeapComment.Comment says; matched when hasComment) and whose type is typ (the grouped type, or the
// printed one; "" matches any), after line number after, at most LinesCap of them.
func (r *Reader) HeapLines(id string, comment string, hasComment bool, typ string, after int) (*HeapLines, error) {
	kind, from, to, _, _, err := parseID(id)
	if err != nil {
		return nil, wrapNoNode(id)
	}
	if kind != "heap" {
		return nil, ErrNoReading
	}
	if n := r.src.Lines(); to > n {
		return nil, wrapNoNodeLines(id, n)
	}
	if !r.startsHeap(from) {
		return nil, wrapNoNode(id)
	}
	p := newHeapParser()
	p.lite = true
	out := &HeapLines{Node: id, Lines: []int{}}
	p.hook = func(n int, t, key []byte) {
		if hasComment && string(key) != comment {
			return
		}
		if typ != "" && string(t) != typ && groupType(t) != typ {
			return
		}
		out.Total++
		if n <= after {
			return
		}
		if len(out.Lines) < LinesCap {
			out.Lines = append(out.Lines, n)
		} else {
			out.More++
		}
	}
	err = scanLines(r.src, from, to, func(n int, _, line, _ []byte) { p.feed(n, line) })
	if err != nil {
		return nil, err
	}
	if out.More > 0 {
		out.Next = out.Lines[len(out.Lines)-1]
	}
	return out, nil
}
