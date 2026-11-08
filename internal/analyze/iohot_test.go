package analyze

import (
	"context"
	"math"
	"math/rand"
	"reflect"
	"sort"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// ---- blockSet ------------------------------------------------------------------------

// TestBlockSet: ranges into arrays and bitmaps give what a plain set gives, seen in order, and the modelled size.
func TestBlockSet(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	s := newBlockSet()
	ref := map[[3]int64]bool{}
	for i := 0; i < 20000; i++ {
		owner := uint32(rng.Intn(3))
		file := int64(rng.Intn(3))
		var lo int64
		switch rng.Intn(3) {
		case 0:
			lo = int64(rng.Intn(3000)) // dense: bitmaps
		case 1:
			lo = int64(rng.Intn(1 << 22)) // sparse: arrays
		default:
			lo = 65530 + int64(rng.Intn(12)) // across a chunk boundary
		}
		n := int64(1 + rng.Intn(4))
		if rng.Intn(20) == 0 {
			n = int64(1 + rng.Intn(1500)) // a range that turns an array into a bitmap
		}
		var seen, want []int64
		var wantAdded int64
		for b := lo; b < lo+n; b++ {
			k := [3]int64{int64(owner), file, b}
			if ref[k] {
				want = append(want, b)
			} else {
				wantAdded++
				ref[k] = true
			}
		}
		added := s.addRange(owner, file, lo, lo+n, func(b int64) { seen = append(seen, b) })
		if added != wantAdded || !reflect.DeepEqual(seen, want) {
			t.Fatalf("add %d %d [%d, %d): added %d seen %v, want %d %v", owner, file, lo, lo+n, added, seen, wantAdded, want)
		}
	}
	var bytes int64
	for k, c := range s.chunks {
		bytes += c.cost()
		if (c.bits != nil) != (c.n > chunkArrayMax || c.bits != nil) || (c.bits == nil && len(c.arr) != c.n) {
			t.Errorf("chunk %+v: n %d, %d in the array, bitmap %v", k, c.n, len(c.arr), c.bits != nil)
		}
		if c.bits == nil && !sort.SliceIsSorted(c.arr, func(a, b int) bool { return c.arr[a] < c.arr[b] }) {
			t.Errorf("chunk %+v: array not sorted", k)
		}
	}
	if bytes != s.bytes {
		t.Errorf("bytes %d, the chunks cost %d", s.bytes, bytes)
	}
	for k := range ref {
		if !s.has(uint32(k[0]), k[1], k[2]) {
			t.Fatalf("has %v false", k)
		}
	}
	for i := 0; i < 5000; i++ {
		k := [3]int64{int64(rng.Intn(3)), int64(rng.Intn(3)), int64(rng.Intn(1 << 22))}
		if s.has(uint32(k[0]), k[1], k[2]) != ref[k] {
			t.Fatalf("has %v: %v", k, !ref[k])
		}
	}
	if s.addRange(0, 0, -5, 0, nil) != 0 || s.has(0, 0, -1) {
		t.Error("negative blocks are not left out")
	}
}

// TestBlockCounterPrune: with a small cap the counts are underestimates by at most dec, and a block with no entry was read at most 1 + dec times.
func TestBlockCounterPrune(t *testing.T) {
	rng := rand.New(rand.NewSource(2))
	for _, seenBytes := range []int64{DefaultSeenBytes, 1} {
		bc := newBlockCounter(seenBytes, 64)
		truth := map[int64]int64{}
		for i := 0; i < 30000; i++ {
			var lo, n int64
			if rng.Intn(4) == 0 {
				lo, n = int64(rng.Intn(20)), 1 // hot
			} else {
				lo, n = int64(rng.Intn(1<<20)), int64(1+rng.Intn(8))
			}
			bc.startWait()
			bc.read(7, lo, lo+n)
			bc.endWait()
			for b := lo; b < lo+n; b++ {
				truth[b]++
			}
			if len(bc.count) > bc.countCap {
				t.Fatalf("%d entries above the cap %d", len(bc.count), bc.countCap)
			}
		}
		if bc.dec == 0 {
			t.Fatalf("seenBytes %d: never pruned", seenBytes)
		}
		for b, n := range truth {
			if v, ok := bc.count[blockKey(7, b)]; ok {
				if int64(v) > n || int64(v) < n-bc.dec {
					t.Fatalf("block %d: count %d, read %d times, dec %d", b, v, n, bc.dec)
				}
			} else if n > 1+bc.dec {
				t.Fatalf("block %d read %d times has no entry (dec %d)", b, n, bc.dec)
			}
		}
		for b := int64(0); b < 20 && seenBytes == DefaultSeenBytes; b++ { // the seen set keeps single reads out of the map: the hot blocks survive
			if _, ok := bc.count[blockKey(7, b)]; !ok {
				t.Errorf("seenBytes %d: hot block %d pruned", seenBytes, b)
			}
		}
		if seenBytes == 1 != bc.capped {
			t.Errorf("seenBytes %d: capped %v", seenBytes, bc.capped)
		}
	}
}

// ---- IOHotOn --------------------------------------------------------------------------

// hotRef is the brute-force answer over the model's waits: per block its reads and the reads that touched it.
type hotRef struct {
	reads  map[[2]int64]int64
	waits  map[[2]int64][]int // read waits touching the block
	writes map[[2]int64][]int
}

func hotReference(m *model.Model, f Filter) (hotRef, []int) {
	ev := IOEventsOf(m.Events)
	mt := f.Matcher()
	r := hotRef{reads: map[[2]int64]int64{}, waits: map[[2]int64][]int{}, writes: map[[2]int64][]int{}}
	var idx []int
	for i := range m.Waits {
		w := &m.Waits[i]
		if !ev.match(mt, w) {
			continue
		}
		idx = append(idx, i)
		for b := max(w.P2, 0); b < w.P2+ev.blocks(w); b++ {
			k := [2]int64{w.P1, b}
			if ev.write(w) {
				r.writes[k] = append(r.writes[k], i)
			} else {
				r.reads[k]++
				r.waits[k] = append(r.waits[k], i)
			}
		}
	}
	return r, idx
}

func ioHot(t *testing.T, m *model.Model, f Filter, o IOHotOpts) *IOHot {
	t.Helper()
	h, err := IOHotOn(context.Background(), ModelFacts(m), f, IOEventsOf(m.Events), o)
	if err != nil {
		t.Fatal(err)
	}
	return h
}

// checkRuns: every run is a stretch of adjacent blocks each read twice or more, its numbers are the brute-force ones.
func checkRuns(t *testing.T, m *model.Model, h *IOHot, ref hotRef) {
	t.Helper()
	ev := IOEventsOf(m.Events)
	for _, r := range h.Runs {
		var reads, mx int64 = 0, 0
		mn := int64(math.MaxInt64)
		peak := int64(-1)
		waits, writes := map[int]bool{}, map[int]bool{}
		for b := r.Lo; b < r.Hi; b++ {
			k := [2]int64{r.File, b}
			n := ref.reads[k]
			if n < 2 {
				t.Fatalf("run %+v: block %d read %d times", r, b, n)
			}
			reads += n
			if n > mx {
				mx, peak = n, b
			}
			mn = min(mn, n)
			for _, i := range ref.waits[k] {
				waits[i] = true
			}
			for _, i := range ref.writes[k] {
				writes[i] = true
			}
		}
		var us float64
		first, last := int64(math.MaxInt64), int64(math.MinInt64)
		objs, stmts := map[int64]int64{}, map[int64]int64{}
		order := make([]int, 0, len(waits))
		for i := range waits {
			order = append(order, i)
		}
		sort.Ints(order)
		for _, i := range order {
			w := &m.Waits[i]
			n := ev.blocks(w)
			ov := min(w.P2+n, r.Hi) - max(w.P2, r.Lo)
			us += float64(w.Ela) * float64(ov) / float64(n)
			first, last = min(first, w.Tim), max(last, w.Tim)
			if !ev.temp(w) {
				objs[w.ObjID] += ov
			}
			stmts[int64(w.Statement)] += ov
		}
		if r.Reads != reads || r.Max != mx || r.Min != mn || r.Peak != peak || r.Rereads != reads-(r.Hi-r.Lo) || r.Waits != len(waits) ||
			r.Writes != len(writes) || r.Us != int64(math.Round(us)) || r.First != first || r.Last != last {
			t.Errorf("run %+v\nwant reads %d max %d min %d peak %d waits %d writes %d us %.0f first %d last %d", r, reads, mx, mn, peak, len(waits), len(writes), us, first, last)
		}
		if len(r.Stmts) == 0 || r.Stmts[0][1] != maxVal(stmts) || (len(objs) > 0 && r.Objs[0][1] != maxVal(objs)) {
			t.Errorf("run %+v: stmts %v objs %v, want the top of %v %v", r, r.Stmts, r.Objs, stmts, objs)
		}
		// maximal: the blocks around it are not hot
		for _, b := range []int64{r.Lo - 1, r.Hi} {
			if ref.reads[[2]int64{r.File, b}] >= 2 && h.Exact {
				t.Errorf("run %+v is not maximal: block %d read %d times", r, b, ref.reads[[2]int64{r.File, b}])
			}
		}
	}
}

func maxVal(m map[int64]int64) int64 {
	var x int64
	for _, v := range m {
		x = max(x, v)
	}
	return x
}

func TestIOHotIOWaits(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	f := Filter{IncludeIdle: true}
	ref, idx := hotReference(m, f)
	h := ioHot(t, m, f, IOHotOpts{Limit: MaxHotRuns})
	var blockReads, reread int64
	for _, n := range ref.reads {
		blockReads += n
		if n >= 2 {
			reread++
		}
	}
	reads := 0
	ev := IOEventsOf(m.Events)
	for _, i := range idx {
		if !ev.write(&m.Waits[i]) {
			reads++
		}
	}
	if h.Total != 8747 || h.Reads != reads || h.BlockReads != blockReads || h.Distinct != int64(len(ref.reads)) || h.Reread != reread ||
		!h.Exact || h.Bound != 1 || !h.DistinctExact || h.RunsTotal != len(h.Runs) {
		t.Fatalf("total %d reads %d blocks %d distinct %d reread %d exact %v bound %d runs %d/%d\nwant 8747 %d %d %d %d true 1",
			h.Total, h.Reads, h.BlockReads, h.Distinct, h.Reread, h.Exact, h.Bound, len(h.Runs), h.RunsTotal, reads, blockReads, len(ref.reads), reread)
	}
	checkRuns(t, m, h, ref)
	// every re-read block is in a run
	in := 0
	for _, r := range h.Runs {
		in += int(r.Hi - r.Lo)
	}
	if int64(in) != reread {
		t.Errorf("the runs hold %d blocks, %d were re-read", in, reread)
	}
	// stmt 22's multipass hash join: its 276 temp blocks of tempfile 203, read 5,612 times, lead
	top := h.Runs[0]
	if top.File != 203 || !top.Temp || top.Stmts[0][0] != 22 {
		t.Errorf("the top run is %+v, want stmt 22's temp blocks", top)
	}
	var s22 int64
	for _, r := range h.Runs {
		for _, s := range r.Stmts {
			if s[0] == 22 && r.File == 203 {
				s22 += s[1]
			}
		}
	}
	if s22 < 5000 {
		t.Errorf("stmt 22 re-read %d temp blocks in the runs", s22)
	}
	// sorts
	for _, by := range HotSorts {
		h := ioHot(t, m, f, IOHotOpts{Limit: 5, Sort: by})
		if len(h.Runs) != min(5, h.RunsTotal) {
			t.Fatalf("sort %s: %d runs", by, len(h.Runs))
		}
		for i := 1; i < len(h.Runs); i++ {
			a, b := h.Runs[i-1], h.Runs[i]
			ka, kb := map[string][2]int64{"rereads": {a.Rereads, b.Rereads}, "max": {a.Max, b.Max}, "us": {a.Us, b.Us}}[by][0], map[string][2]int64{"rereads": {a.Rereads, b.Rereads}, "max": {a.Max, b.Max}, "us": {a.Us, b.Us}}[by][1]
			if ka < kb {
				t.Errorf("sort %s: %+v before %+v", by, a, b)
			}
		}
	}
}

// TestIOHotObjects: the per-object and per-statement numbers are the brute-force ones over every wait.
func TestIOHotObjects(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	ev := IOEventsOf(m.Events)
	f := Filter{IncludeIdle: true}
	h := ioHot(t, m, f, IOHotOpts{})
	type acc struct {
		s       IOObjStat
		read    map[[2]int64]bool
		files   map[int64]bool
		lastF   int64
		lastEnd int64
		any     bool
	}
	want := map[string]*acc{}
	type sacc struct {
		s      IOStmtStat
		rd, wr map[int64]bool
	}
	wantS := map[[2]int64]*sacc{}
	mt := f.Matcher()
	for i := range m.Waits {
		w := &m.Waits[i]
		if !ev.match(mt, w) {
			continue
		}
		g := groupOf(ev, w).String()
		a := want[g]
		if a == nil {
			a = &acc{s: IOObjStat{Key: g, Obj: -1}, read: map[[2]int64]bool{}, files: map[int64]bool{}}
			want[g] = a
		}
		n := ev.blocks(w)
		if a.any && a.lastF == w.P1 && w.P2-a.lastEnd >= 0 && w.P2-a.lastEnd <= IOSeqGap {
			a.s.Seq++
		}
		a.any, a.lastF, a.lastEnd = true, w.P1, w.P2+n
		a.s.Waits++
		a.s.Us += w.Ela
		a.s.Blocks += n
		a.files[w.P1] = true
		sk := [2]int64{int64(w.Statement), w.P1}
		sa := wantS[sk]
		if sa == nil {
			sa = &sacc{s: IOStmtStat{Stmt: sk[0], File: sk[1]}, rd: map[int64]bool{}, wr: map[int64]bool{}}
			wantS[sk] = sa
		}
		sa.s.Us += w.Ela
		if ev.write(w) {
			a.s.Writes++
			sa.s.Writes++
			sa.s.WriteBlocks += n
			for b := w.P2; b < w.P2+n; b++ {
				sa.wr[b] = true
			}
		} else {
			a.s.Reads++
			a.s.ReadBlocks += n
			sa.s.Reads++
			sa.s.ReadBlocks += n
			for b := w.P2; b < w.P2+n; b++ {
				a.read[[2]int64{w.P1, b}] = true
				sa.rd[b] = true
			}
		}
	}
	if len(h.Objects) != len(want) || len(h.Stmts) != len(wantS) {
		t.Fatalf("%d objects %d statements, want %d %d", len(h.Objects), len(h.Stmts), len(want), len(wantS))
	}
	for i, o := range h.Objects {
		a := want[o.Key]
		if a == nil {
			t.Fatalf("object %s", o.Key)
		}
		if i > 0 && h.Objects[i-1].Us < o.Us {
			t.Errorf("objects not by time")
		}
		if o.Waits != a.s.Waits || o.Reads != a.s.Reads || o.Writes != a.s.Writes || o.Us != a.s.Us || o.Blocks != a.s.Blocks ||
			o.ReadBlocks != a.s.ReadBlocks || o.Distinct != int64(len(a.read)) || o.Seq != a.s.Seq || len(o.Files) != len(a.files) {
			t.Errorf("object %+v\nwant %+v distinct %d", o, a.s, len(a.read))
		}
	}
	for _, s := range h.Stmts {
		a := wantS[[2]int64{s.Stmt, s.File}]
		if a == nil || s.Reads != a.s.Reads || s.ReadBlocks != a.s.ReadBlocks || s.ReadDistinct != int64(len(a.rd)) || s.Writes != a.s.Writes ||
			s.WriteBlocks != a.s.WriteBlocks || s.WriteDistinct != int64(len(a.wr)) || s.Us != a.s.Us {
			t.Errorf("statement %+v, want %+v (distinct %d / %d)", s, a, len(a.rd), len(a.wr))
		}
	}
	// stmt 22's temp reads: 5,612 reads on 276 blocks (DESIGN § Three new views)
	for _, s := range h.Stmts {
		if s.Stmt == 22 && s.File == 203 && (s.Reads != 5612 || s.ReadDistinct != 276) {
			t.Errorf("stmt 22 file 203: %+v, want 5612 reads of 276 blocks", s)
		}
	}
}

// TestIOHotBounded: with tiny caps the runs keep exact counts, the answer says it is approximate, and no block outside the runs was read more than Bound times.
func TestIOHotBounded(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	f := Filter{IncludeIdle: true}
	ref, _ := hotReference(m, f)
	exact := ioHot(t, m, f, IOHotOpts{Limit: MaxHotRuns})
	for _, o := range []IOHotOpts{{CountCap: 50}, {Candidates: 40}, {CountCap: 50, SeenBytes: 1}, {SeenBytes: 1}, {OwnerBytes: 1}} {
		o.Limit = MaxHotRuns
		h := ioHot(t, m, f, o)
		checkRuns(t, m, h, ref)
		inRun := map[[2]int64]bool{}
		for _, r := range h.Runs {
			for b := r.Lo; b < r.Hi; b++ {
				inRun[[2]int64{r.File, b}] = true
			}
		}
		for k, n := range ref.reads {
			if !inRun[k] && n > h.Bound {
				t.Errorf("%+v: block %v read %d times is in no run, bound %d", o, k, n, h.Bound)
			}
		}
		pruned := o.CountCap > 0 || o.Candidates > 0
		if h.Exact == pruned || h.DistinctExact != (o.SeenBytes == 0 && o.OwnerBytes == 0) {
			t.Errorf("%+v: exact %v distinctExact %v", o, h.Exact, h.DistinctExact)
		}
		if !pruned && !reflect.DeepEqual(h.Runs, exact.Runs) {
			t.Errorf("%+v: a capped seen set changed the runs", o)
		}
		if (pruned && h.Bound <= 1) || (o.Candidates > 0 && len(h.Runs) == 0) {
			t.Errorf("%+v: bound %d, %d runs", o, h.Bound, len(h.Runs))
		}
	}
}

// TestIOMapReads: IOMap.Reads is the most read block of each row, counted over every match.
func TestIOMapReads(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	ev := IOEventsOf(m.Events)
	f := Filter{IncludeIdle: true}
	ref, _ := hotReference(m, f)
	for _, limit := range []int{20000, 300} {
		r, err := IOMapWith(context.Background(), ModelFacts(m), f, ev, limit, IOMapOpts{Reads: true})
		if err != nil {
			t.Fatal(err)
		}
		plain := ioMap(t, m, f, limit)
		if !reflect.DeepEqual(r.Rows, plain.Rows) || len(r.Reads) != len(r.Rows) || !r.ReadsExact {
			t.Fatalf("limit %d: rows differ or %d reads for %d rows (exact %v)", limit, len(r.Reads), len(r.Rows), r.ReadsExact)
		}
		for i, row := range r.Rows {
			var most int64
			for b := row[4]; b < row[4]+row[5]; b++ {
				most = max(most, ref.reads[[2]int64{row[3], b}])
			}
			if r.Reads[i] != most {
				t.Fatalf("limit %d row %d: reads %d, want %d", limit, i, r.Reads[i], most)
			}
		}
	}
	r, _ := IOMapWith(context.Background(), ModelFacts(m), f, ev, 20000, IOMapOpts{Reads: true, CountCap: 20})
	if r.ReadsExact {
		t.Error("a pruned count says it is exact")
	}
}

// TestIOHotOddWaits: a corrupt p3 counts as at most MaxWaitBlocks blocks, and blocks a counter key cannot hold (a file below
// 0, a block from 2^32) are left out of the counting instead of landing on another block's key.
func TestIOHotOddWaits(t *testing.T) {
	events := []model.Event{{Name: "direct path read", P1Name: "file number", P2Name: "first dba", P3Name: "block cnt", Class: "User I/O"}}
	waits := []model.Wait{
		{Tim: 10, Ela: 5, P1: 4, P2: 0, P3: 1 << 40, Statement: 1}, // a p3 no read has
		{Tim: 20, Ela: 5, P1: -1, P2: 7, P3: 1, Statement: 1},
		{Tim: 30, Ela: 5, P1: -1, P2: 7, P3: 1, Statement: 1},
		{Tim: 40, Ela: 5, P1: 5, P2: 1<<32 + 100, P3: 1, Statement: 1},
		{Tim: 50, Ela: 5, P1: 5, P2: 100, P3: 1, Statement: 1},
		{Tim: 60, Ela: 5, P1: 5, P2: 1<<32 + 100, P3: 1, Statement: 1},
		{Tim: 70, Ela: 5, P1: 4, P2: 3, P3: 2, Statement: 1}, // re-reads blocks 3 and 4 of the first wait
	}
	for i := range waits {
		waits[i].ID, waits[i].Call, waits[i].ObjID = model.ID(i), -1, -1
	}
	m := &model.Model{Events: events, Waits: waits}
	h := ioHot(t, m, Filter{IncludeIdle: true}, IOHotOpts{})
	if h.BlockReads != MaxWaitBlocks+7 { // the blocks the counting leaves out are still block reads
		t.Errorf("block reads %d, want %d", h.BlockReads, MaxWaitBlocks+7)
	}
	if len(h.Runs) != 1 || h.Runs[0].File != 4 || h.Runs[0].Lo != 3 || h.Runs[0].Hi != 5 || h.Runs[0].Reads != 4 || h.Runs[0].First != 10 || h.Runs[0].Last != 70 {
		t.Errorf("runs %+v, want the two re-read blocks of file 4", h.Runs)
	}
	r, err := IOMapWith(context.Background(), ModelFacts(m), Filter{IncludeIdle: true}, IOEventsOf(events), 100, IOMapOpts{Reads: true})
	if err != nil {
		t.Fatal(err)
	}
	if r.Rows[0][5] != MaxWaitBlocks || r.Reads[1] != 0 || r.Reads[3] != 0 || r.Reads[4] != 1 || r.Reads[6] != 2 {
		t.Errorf("rows %v reads %v", r.Rows, r.Reads)
	}
}
