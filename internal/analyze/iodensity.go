package analyze

import (
	"context"
	"fmt"
	"math"
	"slices"
	"sort"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// IODensity is the answer of /api/io/density: every block I/O wait in scope
// (not a sample) counted into the cells of the I/O map's panels. x is the
// I/O order (the wait's index among the matches, counted in trace order as
// IOMapOn does) or the time (the wait's midpoint, tim − ela/2, clamped to the
// domain); y is the block, per panel over its segments. A wait counts in
// every y cell its blocks [block, block + blocks) touch: waits + 1, blocks +
// the blocks in the cell, µs + ela × that share of its blocks.
type IODensity struct {
	Total  int              `json:"total"` // block I/O waits in scope
	X      string           `json:"x"`     // order | time
	XSegs  [][3]int64       `json:"xsegs"` // [a, b, bins]: the x bins, numbered across the segments in order
	Panels []IODensityPanel `json:"panels"`
	Cols   []string         `json:"cols"`  // IODensityCols
	Cells  [][]int64        `json:"cells"` // the cells with waits, by panel, x, y
	Events []model.ID       `json:"events"`
}

// IODensityPanel is one panel's y axis as binned: segments [file, lo, hi,
// bins] (block ranges [lo, hi); bins numbered across the segments in order,
// at most hi − lo per segment), the waits binned in it, and those its key
// selects that no segment or x bin holds.
type IODensityPanel struct {
	Key   string     `json:"key"`
	Segs  [][4]int64 `json:"segs"`
	Waits int        `json:"waits"`
	Out   int        `json:"out"`
}

// IODensityCols are the columns of IODensity.Cells: the panel (index into
// Panels), the x bin, the y bin, the waits that touched the cell, the blocks
// of them in it, their µs (rounded), the event with the most waits there
// (the lower id on a tie) and its waits.
var IODensityCols = []string{"panel", "x", "y", "waits", "blocks", "us", "event", "eventWaits"}

// IODensityReq is the question: x "order" (default) or "time"; XSegs the x
// bins (order: [a, b) of match indices; time: [a, b) of tim µs), nil = one
// segment of XBins bins over the scope's matches; Panels, nil = one per file
// over its block range with YBins bins (the first 64 files; fewer bins when
// the grid would pass MaxDensityCells). A panel's key selects its waits like
// the I/O map's panel keys: f<file> (the file's waits), o<obj> (an object's
// non-temp waits), t<file> (the temp waits of a file), n<file> (a file's
// non-temp waits without an object), rest (non-temp waits with an obj# no
// o-panel of the request selects).
type IODensityReq struct {
	X      string              `json:"x,omitempty"`
	XSegs  [][3]int64          `json:"xsegs,omitempty"`
	XBins  int                 `json:"xbins,omitempty"`
	Panels []IODensityPanelReq `json:"panels,omitempty"`
	YBins  int                 `json:"ybins,omitempty"`
}

// IODensityPanelReq is one panel of the request: its key and y segments [file, lo, hi, bins].
type IODensityPanelReq struct {
	Key  string     `json:"key"`
	Segs [][4]int64 `json:"segs"`
}

// Limits of a density request.
const (
	DefaultDensityXBins = 200
	DefaultDensityYBins = 64
	MaxDensityXBins     = 4000    // Σ over the x segments
	MaxDensityYBins     = 2000    // Σ over one panel's segments
	MaxDensitySegs      = 64      // x segments, or segments of one panel
	MaxDensityPanels    = 64      // panels of a request
	MaxDensityCells     = 1 << 20 // x bins × the y bins of every panel
	// the coordinates a segment may have: blocks in [0, 2^40], x (match indices, tim µs) within ±2^53
	maxDensityBlock = 1 << 40
	maxDensityX     = 1 << 53
)

type densSel struct {
	kind byte // 'f', 'o', 't', 'n', 'r'
	id   int64
}

// parseDensityKey reads a panel key (f12, o108609, t203, n12, rest).
func parseDensityKey(k string) (densSel, error) {
	if k == "rest" {
		return densSel{kind: 'r'}, nil
	}
	if len(k) < 2 || (k[0] != 'f' && k[0] != 'o' && k[0] != 't' && k[0] != 'n') {
		return densSel{}, fmt.Errorf("panel key %q: want f<file>, o<obj>, t<file>, n<file> or rest", k)
	}
	id, err := strconv.ParseInt(k[1:], 10, 64)
	if err != nil || id < 0 {
		return densSel{}, fmt.Errorf("panel key %q: want f<file>, o<obj>, t<file>, n<file> or rest", k)
	}
	return densSel{kind: k[0], id: id}, nil
}

// CheckDensityReq validates a request's shape and limits (the panels' keys, the segments, the bin counts).
func CheckDensityReq(q IODensityReq) error {
	if q.X != "" && q.X != "order" && q.X != "time" {
		return fmt.Errorf("x: %q (want order or time)", q.X)
	}
	if len(q.XSegs) > MaxDensitySegs {
		return fmt.Errorf("xs: at most %d segments", MaxDensitySegs)
	}
	if q.XBins < 0 || q.XBins > MaxDensityXBins || q.YBins < 0 || q.YBins > MaxDensityYBins {
		return fmt.Errorf("xbins, ybins: at most %d and %d", MaxDensityXBins, MaxDensityYBins)
	}
	var xbins int64
	for i, s := range q.XSegs {
		if s[1] <= s[0] || s[2] < 1 || s[2] > MaxDensityXBins || s[0] < -maxDensityX || s[1] > maxDensityX {
			return fmt.Errorf("xs: segment %d.%d.%d is empty or out of range", s[0], s[1], s[2])
		}
		if i > 0 && s[0] < q.XSegs[i-1][1] {
			return fmt.Errorf("xs: segment %d.%d.%d starts before the one before it ends", s[0], s[1], s[2])
		}
		xbins += s[2]
	}
	if q.XSegs == nil {
		xbins = int64(q.XBins)
		if xbins == 0 {
			xbins = DefaultDensityXBins
		}
	}
	if xbins > MaxDensityXBins {
		return fmt.Errorf("xs: at most %d x bins", MaxDensityXBins)
	}
	if len(q.Panels) > MaxDensityPanels {
		return fmt.Errorf("p: at most %d panels", MaxDensityPanels)
	}
	var ybins int64
	for _, p := range q.Panels {
		if _, err := parseDensityKey(p.Key); err != nil {
			return err
		}
		if len(p.Segs) == 0 || len(p.Segs) > MaxDensitySegs {
			return fmt.Errorf("p %s: 1 to %d segments", p.Key, MaxDensitySegs)
		}
		var n int64
		for _, s := range p.Segs {
			if s[2] <= s[1] || s[3] < 1 || s[3] > MaxDensityYBins || s[1] < 0 || s[2] > maxDensityBlock {
				return fmt.Errorf("p %s: segment %d.%d.%d.%d is empty or out of range", p.Key, s[0], s[1], s[2], s[3])
			}
			n += s[3]
		}
		if n > MaxDensityYBins {
			return fmt.Errorf("p %s: at most %d y bins", p.Key, MaxDensityYBins)
		}
		ybins += n
	}
	if q.Panels != nil && xbins*ybins > MaxDensityCells {
		return fmt.Errorf("%d x bins × %d y bins is more than %d cells", xbins, ybins, MaxDensityCells)
	}
	return nil
}

type densPanel struct {
	key   string
	sel   densSel
	segs  [][4]int64 // as binned (bins ≤ hi − lo)
	off   []int64    // the first y bin of each segment
	order []int      // segment indices by file, lo
	waits int
	out   int
}

type densCell struct {
	waits, blocks int64
	us            float64
	ev            []int32 // event, waits pairs
}

// IODensityOn bins the block I/O waits in scope. With the request's x
// segments and panels it is one pass over the waits; without them a first
// pass finds the matches' count, time extent and files. No list of the waits
// is kept: memory is the cells with waits.
func IODensityOn(ctx context.Context, src Facts, f Filter, ev IOEvents, q IODensityReq) (*IODensity, error) {
	if err := CheckDensityReq(q); err != nil {
		return nil, err
	}
	mt := f.Matcher()
	mode := q.X
	if mode == "" {
		mode = "order"
	}
	out := &IODensity{X: mode, Cols: IODensityCols, Cells: [][]int64{}, Events: []model.ID{}, Panels: []IODensityPanel{}}
	xsegs, preqs := slices.Clone(q.XSegs), q.Panels
	if xsegs == nil || preqs == nil {
		// pass 0: the domain and the files
		total := 0
		t0, t1 := int64(math.MaxInt64), int64(math.MinInt64)
		files := map[int64][2]int64{}
		err := src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
			if !ev.match(mt, w) {
				return true
			}
			total++
			t0, t1 = min(t0, w.Tim-w.Ela), max(t1, w.Tim)
			lo, hi := w.P2, w.P2+ev.blocks(w)
			if r, ok := files[w.P1]; ok {
				files[w.P1] = [2]int64{min(r[0], lo), max(r[1], hi)}
			} else {
				files[w.P1] = [2]int64{lo, hi}
			}
			return true
		})
		if err != nil {
			return nil, err
		}
		if xsegs == nil {
			bins := int64(q.XBins)
			if bins < 1 {
				bins = DefaultDensityXBins
			}
			if mode == "order" {
				xsegs = [][3]int64{{0, int64(max(total, 1)), bins}}
			} else if total > 0 {
				xsegs = [][3]int64{{t0, max(t1, t0+1), bins}}
			} else {
				xsegs = [][3]int64{{0, 1, bins}}
			}
		}
		if preqs == nil {
			// one panel per file (the first MaxDensityPanels by number), with fewer y bins when the grid would pass MaxDensityCells
			bins := int64(q.YBins)
			if bins < 1 {
				bins = DefaultDensityYBins
			}
			keys := make([]int64, 0, len(files))
			for k := range files {
				keys = append(keys, k)
			}
			slices.Sort(keys)
			keys = keys[:min(len(keys), MaxDensityPanels)]
			var xb int64
			for _, s := range xsegs {
				xb += s[2]
			}
			if n := int64(len(keys)) * xb; n > 0 {
				bins = max(1, min(bins, MaxDensityCells/n))
			}
			for _, k := range keys {
				r := files[k]
				preqs = append(preqs, IODensityPanelReq{Key: fmt.Sprintf("f%d", k), Segs: [][4]int64{{k, max(r[0], 0), max(r[1], max(r[0], 0)+1), bins}}})
			}
		}
	}
	// the x bins
	for i := range xsegs {
		if mode == "order" {
			xsegs[i][2] = min(xsegs[i][2], xsegs[i][1]-xsegs[i][0]) // at most one bin per wait
		}
	}
	xoff := make([]int64, len(xsegs)+1)
	for i, s := range xsegs {
		xoff[i+1] = xoff[i] + s[2]
	}
	// the panels
	panels := make([]*densPanel, len(preqs))
	objPanel := map[int64]bool{}
	byKind := map[densSel][]int{} // selector → panels
	ymax := int64(1)
	for i, p := range preqs {
		sel, _ := parseDensityKey(p.Key)
		dp := &densPanel{key: p.Key, sel: sel, off: make([]int64, len(p.Segs)+1)}
		for j, s := range p.Segs {
			s[3] = min(s[3], s[2]-s[1]) // at most one bin per block
			dp.segs = append(dp.segs, s)
			dp.off[j+1] = dp.off[j] + s[3]
			dp.order = append(dp.order, j)
		}
		sort.SliceStable(dp.order, func(a, b int) bool {
			x, y := dp.segs[dp.order[a]], dp.segs[dp.order[b]]
			return x[0] < y[0] || (x[0] == y[0] && x[1] < y[1])
		})
		ymax = max(ymax, dp.off[len(p.Segs)])
		panels[i] = dp
		if sel.kind == 'o' {
			objPanel[sel.id] = true
		}
		byKind[sel] = append(byKind[sel], i)
	}
	xtot := xoff[len(xsegs)]
	cells := map[int64]*densCell{}
	seen := make([]bool, len(ev.Block))
	idx := int64(-1)
	var hits []int
	err := src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if !ev.match(mt, w) {
			return true
		}
		idx++
		out.Total++
		seen[w.Event] = true
		// its panels
		hits = hits[:0]
		temp := ev.temp(w)
		hits = append(hits, byKind[densSel{'f', w.P1}]...)
		switch {
		case temp:
			hits = append(hits, byKind[densSel{'t', w.P1}]...)
		case w.ObjID >= 0:
			hits = append(hits, byKind[densSel{'o', w.ObjID}]...)
			if !objPanel[w.ObjID] {
				hits = append(hits, byKind[densSel{kind: 'r'}]...)
			}
		default:
			hits = append(hits, byKind[densSel{'n', w.P1}]...)
		}
		if len(hits) == 0 {
			return true
		}
		// its x bin
		var pos float64
		if mode == "order" {
			pos = float64(idx)
		} else {
			pos = float64(w.Tim) - float64(w.Ela)/2
		}
		xb := xBin(xsegs, xoff, mode == "time", pos)
		n := ev.blocks(w)
		lo, hi := w.P2, w.P2+n
		for _, pi := range hits {
			dp := panels[pi]
			if xb < 0 {
				dp.out++
				continue
			}
			binned := false
			for _, j := range dp.order {
				s := dp.segs[j]
				if s[0] != w.P1 || s[2] <= lo || s[1] >= hi {
					continue
				}
				binned = true
				span := s[2] - s[1]
				a, b := max(lo, s[1]), min(hi, s[2])
				for y := (a - s[1]) * s[3] / span; y < s[3]; y++ {
					ylo, yhi := s[1]+(y*span+s[3]-1)/s[3], s[1]+((y+1)*span+s[3]-1)/s[3] // the blocks of bin y
					if ylo >= b {
						break
					}
					ov := min(b, yhi) - max(a, ylo)
					if ov <= 0 {
						continue
					}
					key := (int64(pi)*xtot+xb)*ymax + dp.off[j] + y
					c := cells[key]
					if c == nil {
						c = &densCell{}
						cells[key] = c
					}
					c.waits++
					c.blocks += ov
					c.us += float64(w.Ela) * float64(ov) / float64(n)
					c.addEvent(int32(w.Event))
				}
			}
			if binned {
				dp.waits++
			} else {
				dp.out++
			}
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	for e, ok := range seen {
		if ok {
			out.Events = append(out.Events, model.ID(e))
		}
	}
	out.XSegs = xsegs
	for _, dp := range panels {
		out.Panels = append(out.Panels, IODensityPanel{Key: dp.key, Segs: dp.segs, Waits: dp.waits, Out: dp.out})
	}
	keys := make([]int64, 0, len(cells))
	for k := range cells {
		keys = append(keys, k)
	}
	slices.Sort(keys)
	out.Cells = make([][]int64, 0, len(keys))
	for _, k := range keys {
		c := cells[k]
		pi, rest := k/(xtot*ymax), k%(xtot*ymax)
		e, en := c.top()
		out.Cells = append(out.Cells, []int64{pi, rest / ymax, rest % ymax, c.waits, c.blocks, int64(math.Round(c.us)), int64(e), int64(en)})
	}
	return out, nil
}

// xBin is the x bin of a position: the bin of the segment that holds it;
// outside every segment -1 (order), or the nearest bin after it, the last
// when it is past the end (time: a wait overlapping the window can have its
// midpoint outside the domain).
func xBin(segs [][3]int64, off []int64, clamp bool, pos float64) int64 {
	i := sort.Search(len(segs), func(i int) bool { return float64(segs[i][1]) > pos }) // the first segment that ends after pos
	if i == len(segs) {
		if !clamp || len(segs) == 0 {
			return -1
		}
		return off[len(segs)] - 1
	}
	s := segs[i]
	if pos < float64(s[0]) { // before the first segment, or between two
		if !clamp {
			return -1
		}
		return off[i]
	}
	b := int64(math.Floor((pos - float64(s[0])) * float64(s[2]) / float64(s[1]-s[0])))
	return off[i] + min(max(b, 0), s[2]-1)
}

func (c *densCell) addEvent(e int32) {
	for i := 0; i < len(c.ev); i += 2 {
		if c.ev[i] == e {
			c.ev[i+1]++
			return
		}
	}
	c.ev = append(c.ev, e, 1)
}

// top is the event with the most waits in the cell (the lower id on a tie) and its waits.
func (c *densCell) top() (int32, int32) {
	be, bn := int32(-1), int32(0)
	for i := 0; i < len(c.ev); i += 2 {
		if c.ev[i+1] > bn || (c.ev[i+1] == bn && c.ev[i] < be) {
			be, bn = c.ev[i], c.ev[i+1]
		}
	}
	return be, bn
}
