package analyze

import (
	"regexp"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// IOEvents are the per-event flags of the I/O map's routes, indexed by event
// id: Block (Event.IsBlockIO), CountP3 (Event.BlocksParam), Temp (a temp
// segment's I/O: direct path read / write temp; its obj# names the
// statement's object, not the owner of the blocks) and Write (the wait writes
// the blocks; else it reads them). Temp and Write are name rules, the twins of
// isTempEvent / isWriteEvent in web/src/lib/data/blocklayout.ts.
type IOEvents struct {
	Block, CountP3, Temp, Write []bool
}

var (
	tempName  = regexp.MustCompile(`(?i)\btemp\b`)
	writeName = regexp.MustCompile(`(?i)\bwrites?\b`)
)

// IOEventsOf reads the flags off the model's events.
func IOEventsOf(events []model.Event) IOEvents {
	n := len(events)
	ev := IOEvents{Block: make([]bool, n), CountP3: make([]bool, n), Temp: make([]bool, n), Write: make([]bool, n)}
	for i := range events {
		e := &events[i]
		ev.Block[i], ev.CountP3[i] = e.IsBlockIO(), e.BlocksParam()
		ev.Temp[i], ev.Write[i] = tempName.MatchString(e.Name), writeName.MatchString(e.Name)
	}
	return ev
}

// match is the I/O map's row predicate: a block I/O wait (never idle) the matcher keeps.
func (ev IOEvents) match(mt *Matcher, w *model.Wait) bool {
	return w.Event >= 0 && int(w.Event) < len(ev.Block) && ev.Block[w.Event] && !w.Idle && mt.Wait(w)
}

// MaxWaitBlocks is the most blocks one wait counts as moving: a multiblock
// read moves at most db_file_multiblock_read_count blocks (a few hundred), so
// a larger p3 is a corrupt line, and it must not make one wait cost millions
// of blocks in the routes' counting.
const MaxWaitBlocks = 1 << 16

// blocks is the number of blocks a wait moved: p3 when the event's p3 is a block count and positive (at most MaxWaitBlocks), else 1.
func (ev IOEvents) blocks(w *model.Wait) int64 {
	if int(w.Event) < len(ev.CountP3) && ev.CountP3[w.Event] && w.P3 > 0 {
		return min(w.P3, MaxWaitBlocks)
	}
	return 1
}

func (ev IOEvents) temp(w *model.Wait) bool { return int(w.Event) < len(ev.Temp) && ev.Temp[w.Event] }
func (ev IOEvents) write(w *model.Wait) bool {
	return int(w.Event) < len(ev.Write) && ev.Write[w.Event]
}
