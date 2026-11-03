package model

import (
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
		{"control file sequential read", true, true},
		{"read by other session", true, false},
		{"buffer busy waits", true, false},
		{"free buffer waits", true, false},
		{"write complete waits", true, false},
		{"local write wait", true, false},
		{"gc cr request", true, false},
		{"gc current request", true, false},
		{"gc buffer busy acquire", true, false},
		{"gc cr multi block request", true, false},
		{"db file parallel read", false, false},       // files, blocks, requests: no address
		{"db file parallel write", false, false},      // requests, interrupt, timeout
		{"control file parallel write", false, false}, // files, block#, requests
		{"Disk file operations I/O", false, false},    // FileOperation, fileno, filetype
		{"log file sequential read", false, false},    // log#, block#, blocks
		{"external table read", false, false},         // filectx, file#, size
		{"gc cr block 2-way", false, false},           // no parameter names
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
