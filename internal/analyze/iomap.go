package analyze

import (
	"context"
	"sort"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// IOMapFile is the block range [Lo, Hi) one file's block I/O waits touch.
type IOMapFile struct {
	File int64 `json:"file"` // p1: a datafile or a tempfile (db_files + its number)
	Lo   int64 `json:"lo"`   // lowest block (p2)
	Hi   int64 `json:"hi"`   // end of the range (exclusive): the largest p2 + blocks
	N    int   `json:"n"`    // waits
}

// IOMap is the answer of /api/io/map: the physical I/O waits with a block
// address in scope (the Blocks view).
type IOMap struct {
	Total   int         `json:"total"`   // block I/O waits in scope
	Sampled bool        `json:"sampled"` // every k-th kept, k = ceil(Total/limit)
	Cols    []string    `json:"cols"`    // IOMapCols
	Rows    [][]int64   `json:"rows"`    // in trace order
	Files   []IOMapFile `json:"files"`   // over all matches, not only the kept rows; sorted by file
	Events  []model.ID  `json:"events"`  // the event ids that occurred, sorted
}

// IOMapCols are the columns of IOMap.Rows: the wait's end (tim) and elapsed,
// its event, file (p1), first block (p2), blocks moved (p3 when the event's
// p3 is a block count and p3 > 0, else 1), object (obj#, -1 none), statement, call
// (-1 none), trace line, session context and depth.
var IOMapCols = []string{"tim", "ela", "event", "file", "block", "blocks", "obj", "stmt", "call", "line", "ctx", "dep"}

// BlockEvents are the per-event flags IOMapOn takes: isBlock[e] =
// events[e].IsBlockIO(), countP3[e] = events[e].BlocksParam().
func BlockEvents(events []model.Event) (isBlock, countP3 []bool) {
	isBlock, countP3 = make([]bool, len(events)), make([]bool, len(events))
	for i := range events {
		isBlock[i], countP3[i] = events[i].IsBlockIO(), events[i].BlocksParam()
	}
	return isBlock, countP3
}

// IOMapOn lists the physical I/O waits with a block address in scope.
// isBlock[event] and countP3[event] come from the model's events
// (Event.IsBlockIO, Event.BlocksParam). With more than limit matches every
// k-th is kept (the 1st, the (k+1)-th, ...), k = ceil(Total/limit); Total,
// Files and Events are over all matches. Two passes over the waits, so a
// trace of millions of waits never holds more than the kept rows. Idle waits
// never match (block I/O is never idle): f.IncludeIdle changes nothing.
func IOMapOn(ctx context.Context, src Facts, f Filter, isBlock, countP3 []bool, limit int) (*IOMap, error) {
	mt := f.Matcher()
	match := func(w *model.Wait) bool {
		return w.Event >= 0 && int(w.Event) < len(isBlock) && isBlock[w.Event] && !w.Idle && mt.Wait(w)
	}
	blocks := func(w *model.Wait) int64 {
		if int(w.Event) < len(countP3) && countP3[w.Event] && w.P3 > 0 {
			return w.P3
		}
		return 1
	}
	out := &IOMap{Cols: IOMapCols, Rows: [][]int64{}, Files: []IOMapFile{}, Events: []model.ID{}}
	files := map[int64]*IOMapFile{}
	seen := make([]bool, len(isBlock))
	err := src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if !match(w) {
			return true
		}
		out.Total++
		seen[w.Event] = true
		hi := w.P2 + blocks(w)
		if r := files[w.P1]; r == nil {
			files[w.P1] = &IOMapFile{File: w.P1, Lo: w.P2, Hi: hi, N: 1}
		} else {
			r.N++
			r.Lo, r.Hi = min(r.Lo, w.P2), max(r.Hi, hi)
		}
		return true
	})
	if err != nil {
		return nil, err
	}
	for _, r := range files {
		out.Files = append(out.Files, *r)
	}
	sort.Slice(out.Files, func(a, b int) bool { return out.Files[a].File < out.Files[b].File })
	for e, ok := range seen {
		if ok {
			out.Events = append(out.Events, model.ID(e))
		}
	}
	if out.Total == 0 {
		return out, nil
	}
	if limit < 1 {
		limit = 1
	}
	k := (out.Total + limit - 1) / limit
	out.Sampled = k > 1
	out.Rows = make([][]int64, 0, (out.Total+k-1)/k)
	i := 0
	err = src.EachWait(ctx, f.Scan(), func(w *model.Wait) bool {
		if !match(w) {
			return true
		}
		if i%k == 0 {
			out.Rows = append(out.Rows, []int64{w.Tim, w.Ela, int64(w.Event), w.P1, w.P2, blocks(w), w.ObjID,
				int64(w.Statement), int64(w.Call), int64(w.Line), int64(w.Context), int64(w.Dep)})
		}
		i++
		return true
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
