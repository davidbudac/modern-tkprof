package analyze

import (
	"context"
	"fmt"
	"math"
	"slices"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// IOHot is the answer of /api/io/hot: how often each block was read over
// every block I/O wait in scope (not a sample), the hottest blocks merged into
// runs of adjacent blocks, and the exact per-object and per-statement numbers
// of the I/O map's side panel.
type IOHot struct {
	Total      int   `json:"total"`      // block I/O waits in scope
	Reads      int   `json:"reads"`      // of them reads (the rest write)
	BlockReads int64 `json:"blockReads"` // blocks the reads moved: a multiblock read counts each block
	Distinct   int64 `json:"distinct"`   // distinct blocks read
	Reread     int64 `json:"reread"`     // distinct blocks read twice or more
	// Exact: the runs are what counting every block gives. Else the counter
	// map was pruned or more blocks were re-read than are recounted, and a
	// block in no run may have been read up to Bound times.
	Exact bool `json:"exact"`
	// Bound: a block in no run (of all RunsTotal) was read at most this many times (1 when Exact).
	Bound int64 `json:"bound"`
	// DistinctExact: Distinct and the objects' and statements' distinct
	// counts are exact (false once a seen-block set reached its cap: then a
	// block may count as new more than once, and re-reads per block are low).
	DistinctExact bool         `json:"distinctExact"`
	RunsTotal     int          `json:"runsTotal"` // runs before the limit
	Runs          []IOHotRun   `json:"runs"`
	Objects       []IOObjStat  `json:"objects"`
	Stmts         []IOStmtStat `json:"stmts"`
}

// IOHotRun is a run of adjacent blocks of one file each read twice or more.
// Every count is exact (recounted over the scope).
type IOHotRun struct {
	File    int64 `json:"file"`
	Lo      int64 `json:"lo"`      // first block
	Hi      int64 `json:"hi"`      // end (exclusive)
	Reads   int64 `json:"reads"`   // Σ reads of its blocks
	Rereads int64 `json:"rereads"` // Σ (reads − 1): the reads a big enough cache would have saved
	Max     int64 `json:"max"`     // the most reads of one block
	Min     int64 `json:"min"`     // the fewest
	Peak    int64 `json:"peak"`    // the block read Max times (the first on a tie)
	Waits   int   `json:"waits"`   // read waits that touched the run
	Writes  int   `json:"writes"`  // write waits that touched it
	Us      int64 `json:"us"`      // µs of its reads: each read's ela × its share of the read's blocks
	First   int64 `json:"first"`   // tim of the first read
	Last    int64 `json:"last"`    // tim of the last read
	Temp    bool  `json:"temp"`    // every read was temp I/O
	// Objs and Stmts: the objects (obj# of the non-temp reads) and statements
	// that read it, by blocks read, at most 3 each: [id, blocks].
	Objs  [][2]int64 `json:"objs"`
	Stmts [][2]int64 `json:"stmts"`
}

// IOObjStat is what the waits of one object (or the temp waits of a file, or
// the waits without an object of a file) did, over every wait in scope.
type IOObjStat struct {
	Key        string  `json:"key"`   // o108609, t203 (temp waits of file 203), n12 (no object, file 12)
	Obj        int64   `json:"obj"`   // -1 for t and n
	Temp       bool    `json:"temp"`  // a t group
	Files      []int64 `json:"files"` // ascending
	Waits      int     `json:"waits"`
	Reads      int     `json:"reads"`
	Writes     int     `json:"writes"`
	Us         int64   `json:"us"`
	MaxUs      int64   `json:"maxUs"`
	Blocks     int64   `json:"blocks"`     // moved by the reads and writes
	ReadBlocks int64   `json:"readBlocks"` // moved by the reads
	Distinct   int64   `json:"distinct"`   // distinct blocks read
	Seq        int     `json:"seq"`        // waits that start within IOSeqGap blocks after the previous one of the group ended (same file)
}

// IOStmtStat is what one statement did to the blocks of one file.
type IOStmtStat struct {
	Stmt          int64 `json:"stmt"` // -1: no statement
	File          int64 `json:"file"`
	Reads         int   `json:"reads"`
	ReadBlocks    int64 `json:"readBlocks"`
	ReadDistinct  int64 `json:"readDistinct"`
	Writes        int   `json:"writes"`
	WriteBlocks   int64 `json:"writeBlocks"`
	WriteDistinct int64 `json:"writeDistinct"`
	Us            int64 `json:"us"`
}

// IOSeqGap: a wait continues the previous one of its group when it starts at
// most this many blocks after where that one ended (iostats.ts SEQ_GAP).
const IOSeqGap = 64

// Defaults of IOHotOpts.
const (
	DefaultHotRuns       = 100
	MaxHotRuns           = 2000
	DefaultHotCandidates = 65536
	hotTop               = 3 // objects and statements per run
)

// IOHotOpts: Limit runs (default 100) by Sort ("rereads", the default: Σ
// re-reads; "max": the most reads of one block; "us": time); Candidates:
// the most re-read blocks recounted (default 65,536); CountCap and
// SeenBytes: the block counter's caps (blockCounter); OwnerBytes: the cap
// of the sets behind the distinct counts of the objects and statements.
type IOHotOpts struct {
	Limit      int    `json:"limit,omitempty"`
	Sort       string `json:"sort,omitempty"`
	Candidates int    `json:"candidates,omitempty"`
	CountCap   int    `json:"countCap,omitempty"`
	SeenBytes  int64  `json:"seenBytes,omitempty"`
	OwnerBytes int64  `json:"ownerBytes,omitempty"`
}

// HotSorts are the orders of IOHotOpts.Sort.
var HotSorts = []string{"rereads", "max", "us"}

// ioGroup is the key of a wait's object group (the I/O map's panels by object): temp waits per file, else the obj#, else no object per file.
type ioGroup struct {
	kind byte // 'o', 't', 'n'
	id   int64
}

func (g ioGroup) String() string { return fmt.Sprintf("%c%d", g.kind, g.id) }

func groupOf(ev IOEvents, w *model.Wait) ioGroup {
	switch {
	case ev.temp(w):
		return ioGroup{'t', w.P1}
	case w.ObjID >= 0:
		return ioGroup{'o', w.ObjID}
	default:
		return ioGroup{'n', w.P1}
	}
}

type stmtFile struct{ stmt, file int64 }

// IOHotOn counts the block reads of every block I/O wait in scope (a
// multiblock read counts each of its blocks) and lists the hottest blocks as
// runs. Pass 1 counts with a blockCounter (bounded memory: the seen sets and
// at most CountCap counters) and sums the objects' and statements' numbers;
// the Candidates most read blocks (read twice or more) are merged into runs
// of adjacent blocks; pass 2 recounts those runs exactly and collects their
// times, objects and statements. No list of the waits is kept.
func IOHotOn(ctx context.Context, src Facts, f Filter, ev IOEvents, o IOHotOpts) (*IOHot, error) {
	if o.Limit < 1 {
		o.Limit = DefaultHotRuns
	}
	if o.Candidates < 1 {
		o.Candidates = DefaultHotCandidates
	}
	if o.OwnerBytes <= 0 {
		o.OwnerBytes = DefaultOwnerBytes
	}
	mt := f.Matcher()
	bc := newBlockCounter(o.SeenBytes, o.CountCap)
	owned := newBlockSet() // the objects' and statements' distinct blocks, one owner each
	ownedCapped := false
	out := &IOHot{Runs: []IOHotRun{}, Objects: []IOObjStat{}, Stmts: []IOStmtStat{}}

	type objAcc struct {
		s     IOObjStat
		owner uint32
		files map[int64]bool
		last  struct{ file, end int64 }
		any   bool
	}
	type stmtAcc struct {
		s              IOStmtStat
		rOwner, wOwner uint32
	}
	objs := map[ioGroup]*objAcc{}
	var objOrder []*objAcc
	stmts := map[stmtFile]*stmtAcc{}
	var stmtOrder []*stmtAcc
	var owners uint32 // in order of first use
	owner := func() uint32 { owners++; return owners }
	err := src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if !ev.match(mt, w) {
			return true
		}
		n := ev.blocks(w)
		lo, hi := w.P2, w.P2+n
		write := ev.write(w)
		out.Total++
		bc.startWait()
		if !ownedCapped && owned.bytes >= o.OwnerBytes {
			ownedCapped = true
		}
		g := groupOf(ev, w)
		oa := objs[g]
		if oa == nil {
			oa = &objAcc{s: IOObjStat{Key: g.String(), Obj: -1, Temp: g.kind == 't'}, files: map[int64]bool{}}
			if g.kind == 'o' {
				oa.s.Obj = g.id
			}
			objs[g] = oa
			objOrder = append(objOrder, oa)
		}
		sk := stmtFile{int64(w.Statement), w.P1}
		sa := stmts[sk]
		if sa == nil {
			sa = &stmtAcc{s: IOStmtStat{Stmt: sk.stmt, File: sk.file}}
			stmts[sk] = sa
			stmtOrder = append(stmtOrder, sa)
		}
		s := &oa.s
		if oa.any && oa.last.file == w.P1 && lo-oa.last.end >= 0 && lo-oa.last.end <= IOSeqGap {
			s.Seq++
		}
		oa.any, oa.last.file, oa.last.end = true, w.P1, hi
		s.Waits++
		s.Us += w.Ela
		s.MaxUs = max(s.MaxUs, w.Ela)
		s.Blocks += n
		oa.files[w.P1] = true
		sa.s.Us += w.Ela
		// the distinct counts: add to the owner's set while it grows, else count every block as new
		distinct := func(own *uint32) int64 {
			if *own == 0 {
				*own = owner()
			}
			if ownedCapped {
				return n
			}
			return owned.addRange(*own, w.P1, lo, hi, nil)
		}
		if write {
			s.Writes++
			sa.s.Writes++
			sa.s.WriteBlocks += n
			sa.s.WriteDistinct += distinct(&sa.wOwner)
		} else {
			out.Reads++
			out.BlockReads += n
			s.Reads++
			s.ReadBlocks += n
			bc.read(w.P1, lo, hi)
			s.Distinct += distinct(&oa.owner)
			sa.s.Reads++
			sa.s.ReadBlocks += n
			sa.s.ReadDistinct += distinct(&sa.rOwner)
		}
		bc.endWait()
		return true
	})
	if err != nil {
		return nil, err
	}
	out.Distinct = bc.distinct
	out.DistinctExact = !bc.capped && !ownedCapped
	for _, oa := range objOrder {
		for f := range oa.files {
			oa.s.Files = append(oa.s.Files, f)
		}
		slices.Sort(oa.s.Files)
		out.Objects = append(out.Objects, oa.s)
	}
	sort.Slice(out.Objects, func(a, b int) bool {
		x, y := &out.Objects[a], &out.Objects[b]
		return x.Us > y.Us || (x.Us == y.Us && x.Key < y.Key)
	})
	for _, sa := range stmtOrder {
		out.Stmts = append(out.Stmts, sa.s)
	}
	sort.Slice(out.Stmts, func(a, b int) bool {
		x, y := &out.Stmts[a], &out.Stmts[b]
		return x.Us > y.Us || (x.Us == y.Us && (x.Stmt < y.Stmt || (x.Stmt == y.Stmt && x.File < y.File)))
	})

	// the candidates: the most read blocks of the counter map read twice or more, by count, then file and block
	type cand struct {
		key uint64
		n   int32
	}
	cands := make([]cand, 0, len(bc.count))
	for k, v := range bc.count {
		if v >= 2 {
			cands = append(cands, cand{k, v})
		}
	}
	out.Reread = int64(len(cands))
	slices.SortFunc(cands, func(a, b cand) int {
		if a.n != b.n {
			return int(b.n) - int(a.n)
		}
		if a.key < b.key {
			return -1
		}
		if a.key > b.key {
			return 1
		}
		return 0
	})
	cut := len(cands) > o.Candidates
	out.Bound = 1 + bc.dec
	if cut {
		out.Bound = max(out.Bound, int64(cands[o.Candidates].n)+bc.dec)
		cands = cands[:o.Candidates]
	}
	out.Exact = bc.dec == 0 && !cut
	bc, owned = nil, nil // pass 2 needs only the candidates
	if len(cands) == 0 {
		return out, nil
	}
	slices.SortFunc(cands, func(a, b cand) int {
		if a.key < b.key {
			return -1
		}
		if a.key > b.key {
			return 1
		}
		return 0
	})

	// runs of adjacent candidate blocks, per file in block order
	type runAcc struct {
		r      IOHotRun
		counts []int32
		us     float64
		temps  int
		objs   map[int64]int64
		stmts  map[int64]int64
	}
	runs := []*runAcc{}
	byFile := map[int64][]*runAcc{}
	for _, c := range cands {
		file, b := int64(c.key>>32), int64(uint32(c.key))
		l := byFile[file]
		if len(l) > 0 && l[len(l)-1].r.Hi == b {
			l[len(l)-1].r.Hi++
			continue
		}
		ra := &runAcc{r: IOHotRun{File: file, Lo: b, Hi: b + 1, First: math.MaxInt64, Last: math.MinInt64}, objs: map[int64]int64{}, stmts: map[int64]int64{}}
		byFile[file] = append(l, ra)
		runs = append(runs, ra)
	}
	for _, ra := range runs {
		ra.counts = make([]int32, ra.r.Hi-ra.r.Lo)
	}
	out.RunsTotal = len(runs)
	err = src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if !ev.match(mt, w) {
			return true
		}
		l := byFile[w.P1]
		if len(l) == 0 {
			return true
		}
		n := ev.blocks(w)
		lo, hi := max(w.P2, 0), w.P2+n
		write, temp := ev.write(w), ev.temp(w)
		for i := sort.Search(len(l), func(i int) bool { return l[i].r.Hi > lo }); i < len(l) && l[i].r.Lo < hi; i++ {
			ra := l[i]
			a, b := max(lo, ra.r.Lo), min(hi, ra.r.Hi)
			if write {
				ra.r.Writes++
				continue
			}
			for x := a; x < b; x++ {
				ra.counts[x-ra.r.Lo]++
			}
			ra.r.Waits++
			ra.us += float64(w.Ela) * float64(b-a) / float64(n)
			ra.r.First = min(ra.r.First, w.Tim)
			ra.r.Last = max(ra.r.Last, w.Tim)
			if temp {
				ra.temps++
			} else {
				ra.objs[w.ObjID] += b - a
			}
			ra.stmts[int64(w.Statement)] += b - a
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	top := func(m map[int64]int64) [][2]int64 {
		l := make([][2]int64, 0, len(m))
		for k, v := range m {
			l = append(l, [2]int64{k, v})
		}
		slices.SortFunc(l, func(a, b [2]int64) int {
			if a[1] != b[1] {
				return cmpDesc(a[1], b[1])
			}
			return cmpDesc(b[0], a[0])
		})
		return l[:min(len(l), hotTop)]
	}
	for _, ra := range runs {
		r := &ra.r
		r.Min = math.MaxInt64
		for i, v := range ra.counts {
			r.Reads += int64(v)
			if int64(v) > r.Max {
				r.Max, r.Peak = int64(v), r.Lo+int64(i)
			}
			r.Min = min(r.Min, int64(v))
		}
		r.Rereads = r.Reads - (r.Hi - r.Lo)
		r.Us = int64(math.Round(ra.us))
		r.Temp = ra.temps > 0 && ra.temps == r.Waits
		if r.Waits == 0 { // cannot happen (a candidate was read twice in scope), but never MaxInt64 in the answer
			r.First, r.Last, r.Min = 0, 0, 0
		}
		r.Objs, r.Stmts = top(ra.objs), top(ra.stmts)
	}
	key := func(r *IOHotRun) int64 {
		switch o.Sort {
		case "max":
			return r.Max
		case "us":
			return r.Us
		}
		return r.Rereads
	}
	slices.SortFunc(runs, func(a, b *runAcc) int {
		x, y := &a.r, &b.r
		if kx, ky := key(x), key(y); kx != ky {
			return cmpDesc(kx, ky)
		}
		if x.Max != y.Max {
			return cmpDesc(x.Max, y.Max)
		}
		if x.File != y.File {
			return cmpDesc(y.File, x.File)
		}
		return cmpDesc(y.Lo, x.Lo)
	})
	for _, ra := range runs[:min(len(runs), o.Limit)] {
		out.Runs = append(out.Runs, ra.r)
	}
	return out, nil
}

// cmpDesc orders larger first.
func cmpDesc(a, b int64) int {
	switch {
	case a > b:
		return -1
	case a < b:
		return 1
	}
	return 0
}
