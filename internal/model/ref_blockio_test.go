package model

import (
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// TestEventIsBlockIO classifies events by their V$EVENT_NAME parameter names,
// built the way Builder.event does, plus an event unknown to the reference
// that carries its names on the WAIT line.
func TestEventIsBlockIO(t *testing.T) {
	for _, tc := range []struct {
		name          string
		block, blocks bool
	}{
		{"db file sequential read", true, true},
		{"db file scattered read", true, true},
		{"db file single write", true, true},
		{"direct path read", true, true},
		{"direct path read temp", true, true},
		{"direct path write", true, true},
		{"direct path write temp", true, true},
		{"read by other session", true, false},
		{"buffer busy waits", true, false},
		{"free buffer waits", true, false},
		{"write complete waits", true, false},
		{"local write wait", true, false},
		{"gc cr request", true, false},
		{"gc current request", true, false},
		{"gc buffer busy acquire", true, false},
		{"gc cr multi block request", true, false},
		{"db file parallel read", false, false},        // files, blocks, requests: no address
		{"db file parallel write", false, false},       // requests, interrupt, timeout
		{"control file sequential read", false, false}, // file#, block#, blocks: p1 is a control file's number
		{"control file single write", false, false},    // likewise
		{"control file parallel write", false, false},  // files, block#, requests
		{"Disk file operations I/O", false, false},     // FileOperation, fileno, filetype
		{"log file sequential read", false, false},     // log#, block#, blocks
		{"external table read", false, false},          // filectx, file#, size
		{"gc cr block 2-way", false, false},            // no parameter names
		{"gc current block 2-way", false, false},
		{"SQL*Net message from client", false, false},
	} {
		info := ref.Event(tc.name)
		if info.Class == "" {
			t.Fatalf("%s: not in the reference", tc.name)
		}
		e := Event{Name: tc.name, P1Name: info.P1, P2Name: info.P2, P3Name: info.P3}
		if got := e.IsBlockIO(); got != tc.block {
			t.Errorf("%s (%s, %s, %s): IsBlockIO %v, want %v", tc.name, info.P1, info.P2, info.P3, got, tc.block)
		}
		if got := e.IsBlockIO() && e.BlocksParam(); got != tc.blocks {
			t.Errorf("%s (%s, %s, %s): BlocksParam %v, want %v", tc.name, info.P1, info.P2, info.P3, got, tc.blocks)
		}
	}
	// an event the reference does not know classifies itself from the WAIT line's names
	if e := (Event{Name: "some future read", P1Name: "file#", P2Name: "block#", P3Name: "blocks"}); !e.IsBlockIO() || !e.BlocksParam() {
		t.Error("an unknown event with file#, block#, blocks is block I/O with a block count")
	}
	if e := (Event{Name: "some event", P1Name: "p1", P2Name: "p2", P3Name: "p3"}); e.IsBlockIO() {
		t.Error("generic parameter names are not block I/O")
	}
}

// TestControlFileNotFileP1: the control file events name p1 file#, but it is
// a control file's number (0, 1 …), so WaitFile reports no datafile for them
// (21c io_waits.trc reads the control files during a tempfile resize).
func TestControlFileNotFileP1(t *testing.T) {
	m, err := Build("../../testdata/traces/21c/io_waits.trc", Options{})
	if err != nil {
		t.Fatal(err)
	}
	ctl, files := 0, map[int64]bool{}
	for i := range m.Waits {
		w := &m.Waits[i]
		f, ok := m.WaitFile(w)
		if strings.HasPrefix(m.Events[w.Event].Name, "control file ") {
			ctl++
			if ok || m.Events[w.Event].IsBlockIO() {
				t.Fatalf("line %d %s: a file number (%d)", w.Line, m.Events[w.Event].Name, f)
			}
		} else if ok {
			files[f] = true
		}
	}
	if ctl != 14 || files[0] || files[1] {
		t.Errorf("%d control file waits (want 14); files %v", ctl, files)
	}
}

// TestObjNoneU32: 23ai writes the "no object" obj# as 4294967295 (-1 as an
// unsigned 32-bit number) where 19c writes -1; the model keeps -1 for both.
func TestObjNoneU32(t *testing.T) {
	m, err := Build("../../testdata/traces/23ai/nasty_sql.trc", Options{})
	if err != nil {
		t.Fatal(err)
	}
	none := 0
	for i := range m.Waits {
		w := &m.Waits[i]
		if w.ObjID == objNoneU32 {
			t.Fatalf("line %d: obj# %d", w.Line, w.ObjID)
		}
		if w.ObjID == -1 {
			none++
		}
	}
	if none != 188 { // the WAIT lines with obj#=4294967295
		t.Errorf("%d waits without an object, want 188", none)
	}
	b := build(t, "WAIT #0: nam='SQL*Net message to client' ela= 1 driver id=1 #bytes=1 p3=0 obj#=4294967295 tim=10\n"+
		"WAIT #0: nam='db file sequential read' ela= 5 file#=4 block#=100 blocks=1 obj#=4294967294 tim=20\n")
	if len(b.Waits) != 2 || b.Waits[0].ObjID != -1 || b.Waits[1].ObjID != 4294967294 {
		t.Errorf("waits %+v", b.Waits)
	}
}
