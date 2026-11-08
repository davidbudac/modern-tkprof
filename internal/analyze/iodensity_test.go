package analyze

import (
	"context"
	"math"
	"reflect"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

func ioDensity(t *testing.T, m *model.Model, f Filter, q IODensityReq) *IODensity {
	t.Helper()
	d, err := IODensityOn(context.Background(), ModelFacts(m), f, IOEventsOf(m.Events), q)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

// densityReference bins the waits of a panel request one block at a time.
func densityReference(m *model.Model, f Filter, q IODensityReq) map[[3]int64][3]float64 {
	ev := IOEventsOf(m.Events)
	mt := f.Matcher()
	out := map[[3]int64][3]float64{}
	objs := map[int64]bool{}
	for _, p := range q.Panels {
		if p.Key[0] == 'o' {
			sel, _ := parseDensityKey(p.Key)
			objs[sel.id] = true
		}
	}
	idx := -1
	for i := range m.Waits {
		w := &m.Waits[i]
		if !ev.match(mt, w) {
			continue
		}
		idx++
		var x int64 = -1
		pos := float64(idx)
		if q.X == "time" {
			pos = float64(w.Tim) - float64(w.Ela)/2
		}
		var off int64
		for k, s := range q.XSegs {
			bins := s[2]
			if q.X != "time" {
				bins = min(bins, s[1]-s[0])
			}
			if pos >= float64(s[0]) && pos < float64(s[1]) {
				x = off + int64(math.Floor((pos-float64(s[0]))*float64(bins)/float64(s[1]-s[0])))
			}
			if q.X == "time" && k == 0 && pos < float64(s[0]) {
				x = 0
			}
			off += bins
			if q.X == "time" && k == len(q.XSegs)-1 && pos >= float64(s[1]) {
				x = off - 1
			}
		}
		if x < 0 {
			continue
		}
		n := ev.blocks(w)
		g := groupOf(ev, w)
		for pi, p := range q.Panels {
			sel, _ := parseDensityKey(p.Key)
			ok := (sel.kind == 'f' && sel.id == w.P1) || (sel.kind == byte(g.kind) && sel.id == g.id) ||
				(sel.kind == 'r' && g.kind == 'o' && !objs[g.id])
			if !ok {
				continue
			}
			var yoff int64
			for _, s := range p.Segs {
				bins := min(s[3], s[2]-s[1])
				touched := map[int64]int64{}
				for b := w.P2; b < w.P2+n; b++ {
					if s[0] == w.P1 && b >= s[1] && b < s[2] {
						touched[(b-s[1])*bins/(s[2]-s[1])]++
					}
				}
				for y, ov := range touched {
					k := [3]int64{int64(pi), x, yoff + y}
					c := out[k]
					out[k] = [3]float64{c[0] + 1, c[1] + float64(ov), c[2] + float64(w.Ela)*float64(ov)/float64(n)}
				}
				yoff += bins
			}
		}
	}
	return out
}

func checkDensity(t *testing.T, m *model.Model, f Filter, q IODensityReq) *IODensity {
	t.Helper()
	d := ioDensity(t, m, f, q)
	eff := IODensityReq{X: d.X, XSegs: d.XSegs} // the request as binned (defaults filled in)
	for _, p := range d.Panels {
		eff.Panels = append(eff.Panels, IODensityPanelReq{Key: p.Key, Segs: p.Segs})
	}
	ref := densityReference(m, f, eff)
	if len(d.Cells) != len(ref) {
		t.Errorf("%+v: %d cells, want %d", q, len(d.Cells), len(ref))
	}
	for i, c := range d.Cells {
		r, ok := ref[[3]int64{c[0], c[1], c[2]}]
		if !ok || c[3] != int64(r[0]) || c[4] != int64(r[1]) || math.Abs(float64(c[5])-r[2]) > 1 {
			t.Fatalf("cell %v, want %v (%v)", c, r, ok)
		}
		if c[7] < 1 || c[7] > c[3] || !m.Events[c[6]].IsBlockIO() {
			t.Fatalf("cell %v: dominant event %d with %d waits", c, c[6], c[7])
		}
		if i > 0 {
			p := d.Cells[i-1]
			if p[0] > c[0] || (p[0] == c[0] && (p[1] > c[1] || (p[1] == c[1] && p[2] >= c[2]))) {
				t.Fatalf("cells not in order: %v then %v", p, c)
			}
		}
	}
	return d
}

func TestIODensityIOWaits(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	f := Filter{IncludeIdle: true}
	all := ioMap(t, m, f, 20000)
	// the defaults: one panel per file over its range, the order over all matches
	d := ioDensity(t, m, f, IODensityReq{})
	if d.Total != 8747 || d.X != "order" || len(d.Panels) != len(all.Files) || !reflect.DeepEqual(d.Cols, IODensityCols) || !reflect.DeepEqual(d.Events, all.Events) {
		t.Fatalf("defaults: total %d x %s panels %d cols %v events %v", d.Total, d.X, len(d.Panels), d.Cols, d.Events)
	}
	if !reflect.DeepEqual(d.XSegs, [][3]int64{{0, 8747, DefaultDensityXBins}}) {
		t.Errorf("x segments %v", d.XSegs)
	}
	var waits, blocks int64
	var us int64
	for i, p := range d.Panels {
		fl := all.Files[i]
		if p.Key != "f"+itoa(fl.File) || p.Waits != fl.N || p.Out != 0 || p.Segs[0][0] != fl.File || p.Segs[0][1] != fl.Lo || p.Segs[0][2] != fl.Hi {
			t.Errorf("panel %+v, file %+v", p, fl)
		}
	}
	for _, c := range d.Cells {
		waits += c[3]
		blocks += c[4]
		us += c[5]
	}
	var wantBlocks, wantUs int64
	for _, r := range all.Rows {
		wantBlocks += r[5]
		wantUs += r[1]
	}
	if blocks != wantBlocks || waits < 8747 || math.Abs(float64(us-wantUs)) > float64(len(d.Cells)) {
		t.Errorf("cells hold %d waits %d blocks %d µs, the map %d blocks %d µs", waits, blocks, us, wantBlocks, wantUs)
	}
	checkDensity(t, m, f, IODensityReq{})

	// panels of the view: a file, a packed object, temp, the rest; widened order segments
	tempFile, dataFile := int64(203), int64(12)
	q := IODensityReq{
		X:     "order",
		XSegs: [][3]int64{{0, 100, 64}, {100, 8000, 200}, {8000, 8747, 40}},
		Panels: []IODensityPanelReq{
			{Key: "f" + itoa(dataFile), Segs: [][4]int64{{dataFile, 167795, 172288, 75}}},
			{Key: "t" + itoa(tempFile), Segs: [][4]int64{{tempFile, 756103, 756400, 30}, {tempFile, 756400, 756743, 7}}},
			{Key: "o" + itoa(all.Rows[0][6]), Segs: [][4]int64{{all.Rows[0][3], all.Rows[0][4], all.Rows[0][4] + 3, 50}}}, // 50 bins over 3 blocks: 3
			{Key: "rest", Segs: [][4]int64{{dataFile, 0, 1 << 20, 100}}},
			{Key: "n10", Segs: [][4]int64{{10, 0, 1 << 20, 10}}},
		},
	}
	d = checkDensity(t, m, f, q)
	if d.Panels[2].Segs[0][3] != 3 {
		t.Errorf("bins over 3 blocks: %v", d.Panels[2].Segs)
	}
	if d.Panels[0].Waits != 194 || d.Panels[1].Waits+d.Panels[1].Out != 8550 {
		t.Errorf("panels %+v", d.Panels)
	}
	// the time axis, a window and one statement
	mid := m.Span.FirstTim + (m.Span.LastTim-m.Span.FirstTim)/2
	s22 := model.ID(22)
	for _, f := range []Filter{{IncludeIdle: true}, {StartTim: mid}, {Statement: &s22}} {
		q.X, q.XSegs = "time", [][3]int64{{m.Span.FirstTim + 1000, mid, 300}}
		checkDensity(t, m, f, q)
	}
	// errors
	for _, bad := range []IODensityReq{
		{X: "space"},
		{XSegs: [][3]int64{{5, 5, 1}}},
		{XSegs: [][3]int64{{0, 10, 1}, {5, 20, 1}}},
		{XSegs: [][3]int64{{0, 10, MaxDensityXBins + 1}}},
		{Panels: []IODensityPanelReq{{Key: "x1", Segs: [][4]int64{{1, 0, 1, 1}}}}},
		{Panels: []IODensityPanelReq{{Key: "f1"}}},
		{Panels: []IODensityPanelReq{{Key: "f1", Segs: [][4]int64{{1, 4, 4, 1}}}}},
		{XSegs: [][3]int64{{0, 10, 2000}}, Panels: []IODensityPanelReq{{Key: "f1", Segs: [][4]int64{{1, 0, 1 << 20, 2000}}}}},
	} {
		if _, err := IODensityOn(context.Background(), ModelFacts(m), f, IOEventsOf(m.Events), bad); err == nil {
			t.Errorf("%+v: no error", bad)
		}
	}
	// nothing in scope
	d = ioDensity(t, m, Filter{NoContexts: true}, IODensityReq{})
	if d.Total != 0 || len(d.Cells) != 0 || d.Cells == nil || len(d.Panels) != 0 || d.Panels == nil || d.Events == nil {
		t.Errorf("empty scope: %+v", d)
	}
}

func itoa(n int64) string {
	return string(appendInt(nil, n))
}

func appendInt(b []byte, n int64) []byte {
	if n < 0 {
		return appendInt(append(b, '-'), -n)
	}
	if n >= 10 {
		b = appendInt(b, n/10)
	}
	return append(b, byte('0'+n%10))
}

// TestIODensityLimits: requests that would overflow the bin arithmetic or pass the cells limit are refused; the default
// panels keep within it.
func TestIODensityLimits(t *testing.T) {
	m := loadModel(t, "io_waits.trc")
	const big = math.MaxInt64
	for _, bad := range []IODensityReq{
		// bins that wrap around when summed (the review's crash)
		{XSegs: [][3]int64{{0, 4294967295, big}, {4294967295, 4294967296, big}}, Panels: []IODensityPanelReq{{Key: "f7", Segs: [][4]int64{{7, 0, 4294967295, big}, {7, 4294967295, 4294967296, big}}}}},
		{Panels: []IODensityPanelReq{{Key: "f7", Segs: [][4]int64{{7, 0, big, 2000}}}}},  // y*span overflows
		{XSegs: [][3]int64{{-big, 10, 5}}},                                                // x out of range
		{XBins: 4000, Panels: []IODensityPanelReq{{Key: "f12", Segs: [][4]int64{{12, 0, 1 << 20, 2000}}}}}, // 8M cells with the default x
		{XBins: -1},
	} {
		if err := CheckDensityReq(bad); err == nil {
			t.Errorf("%+v: accepted", bad)
		}
	}
	d := ioDensity(t, m, Filter{IncludeIdle: true}, IODensityReq{XBins: 4000, YBins: 2000})
	var cells int64
	for _, p := range d.Panels {
		for _, s := range p.Segs {
			cells += s[3] * d.XSegs[0][2]
		}
	}
	if cells > MaxDensityCells || len(d.Panels) != 3 {
		t.Errorf("default panels: %d cells in %d panels", cells, len(d.Panels))
	}
}
