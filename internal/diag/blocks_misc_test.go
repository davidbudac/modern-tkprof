package diag

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestPGATopSession: a row of the top 10 processes of a PGA summary carries the same session detail as its row of the
// full list.
func TestPGATopSession(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_pga_summary.trc"))
	var ps *PGASummary
	for _, n := range r.Scan.Top {
		if n.Kind == "pga-summary" {
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatal(err)
			}
			ps = rd.(*PGASummary)
		}
	}
	if ps == nil || ps.Processes == nil {
		t.Fatal("no process tables")
	}
	all := map[string]*PGASession{}
	for _, p := range ps.Processes.AllProcs {
		if p.Session != nil {
			all[p.OSPid] = p.Session
		}
	}
	if len(all) < 5 {
		t.Fatalf("%d sessions in the full list", len(all))
	}
	with := 0
	for _, p := range ps.Processes.TopProcs {
		want := all[p.OSPid]
		switch {
		case want == nil && p.Session != nil:
			t.Errorf("top row %s has a session the full list does not", p.OSPid)
		case want != nil && (p.Session == nil || *p.Session != *want):
			t.Errorf("top row %s: session %+v, the full list's %+v", p.OSPid, p.Session, want)
		case want != nil:
			with++
		}
	}
	if with < 5 {
		t.Errorf("only %d top rows have a session", with)
	}
	// the top rows without a detail have none in the full list either: ospid 2665 is in the list without one
	for _, p := range ps.Processes.TopProcs {
		if p.OSPid == "3262" && p.Session != nil {
			t.Errorf("a top row with no detail has one: %+v", p)
		}
	}
}

// TestHeapRunLabel: a run takes its label from the oradebug command before it, when the file has one; no committed
// fixture does (a heap dump prints nothing about its own level), and the ACTION NAME marker is not read.
func TestHeapRunLabel(t *testing.T) {
	for _, fx := range fixtures(t) {
		r := readerOf(t, fx)
		for _, n := range r.Scan.Top {
			if n.Kind != "heap" {
				continue
			}
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatal(err)
			}
			if h := rd.(*HeapReading); h.RunLabel != "" {
				t.Errorf("%s: run label %q on a fixture that prints no command", fixtureName(fx), h.RunLabel)
			}
		}
	}
	data, err := os.ReadFile(filepath.Join(diagDir, "diag_heap_uga.trc"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(data), "\n")
	// the first heap's line: insert the command in the lines before it, as oradebug prints it
	first := 0
	for i, l := range lines {
		if strings.HasPrefix(l, "HEAP DUMP heap name=") {
			first = i
			break
		}
	}
	for _, tc := range []struct {
		name, want string
		insert     []string
		at         int // lines above the rule of the heap
	}{
		{"oradebug", "oradebug: dump heapdump 5", []string{"Processing Oradebug command 'dump   heapdump 5'", "", "*** 2026-11-17T21:34:23.913334+00:00 (CDB$ROOT(1))"}, 1},
		{"command far above the markers", "oradebug: dump heapdump 4", []string{"Processing Oradebug command 'dump heapdump 4'", "", "*** 2026-11-17T21:34:23.913334+00:00 (CDB$ROOT(1))", " ", "*** 2026-11-17T21:34:23.913335+00:00"}, 1},
		{"some other line between", "", []string{"Processing Oradebug command 'dump heapdump 4'", "some other line", "*** 2026-11-17T21:34:23.913334+00:00"}, 1},
		{"an event, no command", "", []string{"*** 2026-11-17T21:34:23.913334+00:00 (CDB$ROOT(1))"}, 1},
	} {
		m := append(append(append([]string{}, lines[:first-tc.at]...), tc.insert...), lines[first-tc.at:]...)
		r := readerOfBytes(t, []byte(strings.Join(m, "\n")))
		seen := 0
		for _, n := range r.Scan.Top {
			if n.Kind != "heap" {
				continue
			}
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatal(err)
			}
			// the file holds two runs; the command is before the first heap of the first run only
			want := ""
			if seen == 0 {
				want = tc.want
			}
			if got := rd.(*HeapReading).RunLabel; got != want {
				t.Errorf("%s: heap %d: run label %q, want %q", tc.name, seen, got, want)
			}
			seen++
		}
		if seen != 5 {
			t.Errorf("%s: %d heap dumps", tc.name, seen)
		}
	}
	// the field is absent from the JSON when empty
	r := readerOf(t, filepath.Join(diagDir, "diag_heap_pga.trc"))
	rd, _ := r.Reading(r.Scan.Top[1].ID)
	raw, _ := json.Marshal(rd)
	if strings.Contains(string(raw), "runLabel") {
		t.Errorf("runLabel in the JSON of a heap with none")
	}
}

// TestNewReadingJSONShape pins the first field and the names of the fields of the three readings; lists are lists.
func TestNewReadingJSONShape(t *testing.T) {
	for _, tc := range []struct {
		file, kind string
		keys       []string
		absent     []string
		sub        map[string][]string // fields of the first element of a list
	}{
		{"diag_sysstate_l1.trc", "sysstate", []string{"kind", "node", "from", "to", "lines", "level", "levelNum", "shortStacks", "titleLine", "command", "caller", "session", "summaryLine", "summaryMarks", "bodyMarks", "counts", "processes", "processesOmitted", "tree", "treeNodes", "treeOmitted", "blocked", "roots", "ended", "notes"}, nil,
			map[string][]string{"processes": {"pid", "name", "kind", "sid", "serial", "line", "idle", "background", "blockedBy", "body", "inWait", "blocks", "blocked"}, "tree": {"session", "sid", "serial", "inWait", "blocks", "descendants", "line", "children"}}},
		{"diag_hang.trc", "hang", []string{"kind", "node", "from", "to", "lines", "instances", "level", "initiatedBy", "headerLine", "delays", "listed", "chains", "chainsTotal", "nodes", "extra", "dumps", "ended", "notes"}, nil,
			map[string][]string{"chains": {"n", "line", "from", "to", "events", "listed", "sessions", "sessionsTotal"}, "listed": {"letter", "chain", "signature", "events", "line"}}},
		{"diag_deadlock.trc", "deadlock", []string{"kind", "node", "from", "to", "lines", "ora", "line", "type", "graph", "cycle", "sessions", "sessionsTotal", "sessionsLine", "sessionsEnded", "victim", "rowsWaited", "dump", "notes"}, nil,
			map[string][]string{"sessions": {"line", "from", "to", "number", "sid", "serial", "key", "inGraph"}}},
	} {
		r := readerOf(t, filepath.Join(diagDir, tc.file))
		var n Node
		for _, x := range r.Scan.Top {
			if x.Kind == tc.kind {
				n = x
			}
		}
		rd, err := r.Reading(n.ID)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(rd)
		if !strings.HasPrefix(string(raw), `{"kind":"`+tc.kind+`","node":`) {
			t.Errorf("%s: %.60s", tc.kind, raw)
		}
		if jsonNull.Match(raw) {
			i := jsonNull.FindIndex(raw)
			t.Errorf("%s: a null: ...%s", tc.kind, raw[max(0, i[0]-60):i[1]])
		}
		var m map[string]any
		json.Unmarshal(raw, &m)
		for _, k := range tc.keys {
			if _, ok := m[k]; !ok {
				t.Errorf("%s: no %q", tc.kind, k)
			}
		}
		for list, keys := range tc.sub {
			arr, _ := m[list].([]any)
			if len(arr) == 0 {
				t.Errorf("%s: %s is empty", tc.kind, list)
				continue
			}
			el := arr[0].(map[string]any)
			for _, k := range keys {
				if _, ok := el[k]; !ok {
					t.Errorf("%s: %s[0] has no %q: %v", tc.kind, list, k, el)
				}
			}
		}
		// the node says it has the reading
		nr, _ := json.Marshal(n)
		if !strings.Contains(string(nr), `"reading":"`+tc.kind+`"`) {
			t.Errorf("%s: the node has no reading: %s", tc.kind, nr)
		}
	}
	// Reading answers for the nodes of these kinds only through their ids; ids of other kinds are not readings
	r := readerOf(t, filepath.Join(diagDir, "diag_hang.trc"))
	if _, err := r.Reading(r.Scan.Top[0].ID); err == nil {
		t.Errorf("the header has a reading")
	}
	if _, err := r.Reading("hang:42-9999999:1:40"); err == nil {
		t.Errorf("a node past the end of the file has a reading")
	}
}

// TestDigestNewReadings: the readings of the new kinds are in the document's digest under the same caps as the others.
func TestDigestNewReadings(t *testing.T) {
	for _, tc := range []struct{ file, kind string }{{"diag_hang.trc", "hang"}, {"diag_deadlock.trc", "deadlock"}, {"diag_sysstate_l1.trc", "sysstate"}} {
		r := readerOf(t, filepath.Join(diagDir, tc.file))
		d, err := r.Digest()
		if err != nil {
			t.Fatal(err)
		}
		found := 0
		for id, raw := range d.Readings {
			if strings.HasPrefix(id, tc.kind+":") {
				found++
				if !strings.HasPrefix(string(raw), `{"kind":"`+tc.kind+`"`) {
					t.Errorf("%s: %.50s", id, raw)
				}
			}
		}
		if found != 1 || d.ReadingsOmitted != 0 {
			t.Errorf("%s: %d readings of the kind, %d omitted", tc.file, found, d.ReadingsOmitted)
		}
	}
	// many analyses in one file: the count of readings stops at the cap and says so
	data, err := os.ReadFile(filepath.Join(diagDir, "diag_hang.trc"))
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(data), "\n")
	var b bytes.Buffer
	b.WriteString(strings.Join(lines[:31], "\n") + "\n")
	for i := 0; i < DigestReadings+30; i++ {
		fmt.Fprintf(&b, "*** 2026-11-17T21:34:41.409717+00:00 (CDB$ROOT(1))\n")
		b.WriteString(strings.Join(lines[41:275], "\n") + "\n")
	}
	r := readerOfBytes(t, b.Bytes())
	d, err := r.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Readings) != DigestReadings || d.ReadingsOmitted != 30 {
		t.Errorf("%d readings, %d omitted", len(d.Readings), d.ReadingsOmitted)
	}
	raw, _ := json.Marshal(d)
	t.Logf("%d hang analyses: the digest's JSON is %d KB", DigestReadings, len(raw)>>10)
	if len(raw) > DigestReadingBytes+1<<20 {
		t.Errorf("the digest is %d bytes", len(raw))
	}
}
