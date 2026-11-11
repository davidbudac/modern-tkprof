package opt

import (
	"bytes"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestIsTableEnd(t *testing.T) {
	yes := []string{
		"-----+-----+",
		"-----+-----+-----+  ",
		"---------+---+----+-----+",
	}
	no := []string{"", "-----", "-----+", "-----+-----", "+-----+", "-----++", "-----+-----+x", "| Id |", "--- ---+---+"}
	for _, s := range yes {
		if !isTableEnd([]byte(s)) {
			t.Errorf("isTableEnd(%q) = false", s)
		}
	}
	for _, s := range no {
		if isTableEnd([]byte(s)) {
			t.Errorf("isTableEnd(%q) = true", s)
		}
	}
}

// A plan table with Pstart/Pstop or TQ/IN-OUT/PQ Distrib has a rule line of three groups: the predicates and
// query blocks after it are read, and the cells of the extra columns are kept.
func TestPlanExtraColumns(t *testing.T) {
	for _, name := range []string{"opt_part", "opt_parallel"} {
		sc := scanOf(t, filepath.Join(optDir, name+".trc"))
		pl := sc.Dumps[0].Plan
		if pl == nil {
			t.Fatalf("%s: no plan", name)
		}
		if len(pl.Preds) == 0 || len(pl.QBs) == 0 {
			t.Errorf("%s: preds %d, qbs %d", name, len(pl.Preds), len(pl.QBs))
		}
		if pl.To <= pl.TableTo {
			t.Errorf("%s: plan.to %d is not after tableTo %d", name, pl.To, pl.TableTo)
		}
		if !inDigest(sc.Dumps[0], pl.To) {
			t.Errorf("%s: the last predicate line %d is outside the digest ranges", name, pl.To)
		}
		for _, r := range pl.Rows {
			if len(r.Extra) != len(pl.Cols)-7 {
				t.Fatalf("%s: row %d has %d extra cells for columns %v", name, r.ID, len(r.Extra), pl.Cols)
			}
		}
	}

	pl := scanOf(t, filepath.Join(optDir, "opt_part.trc")).Dumps[0].Plan
	if !reflect.DeepEqual(pl.Cols[7:], []string{"Pstart", "Pstop"}) {
		t.Errorf("opt_part columns %v", pl.Cols)
	}
	var seen int
	for _, r := range pl.Rows {
		switch {
		case r.Op == "PARTITION RANGE SINGLE":
			seen++
			if !reflect.DeepEqual(r.Extra, []string{"3", "3"}) {
				t.Errorf("PARTITION RANGE SINGLE: extra %q", r.Extra)
			}
		case r.ID == 0:
			if !reflect.DeepEqual(r.Extra, []string{"", ""}) {
				t.Errorf("SELECT STATEMENT: extra %q", r.Extra)
			}
		}
	}
	if seen != 1 {
		t.Errorf("PARTITION RANGE SINGLE rows: %d", seen)
	}

	pl = scanOf(t, filepath.Join(optDir, "opt_parallel.trc")).Dumps[0].Plan
	if !reflect.DeepEqual(pl.Cols[7:], []string{"TQ", "IN-OUT", "PQ Distrib"}) {
		t.Errorf("opt_parallel columns %v", pl.Cols)
	}
	want := map[int][]string{
		0: {"", "", ""},
		3: {":Q1000", "P->S", "QC (RANDOM)"}, // PX SEND QC (RANDOM), name :TQ10000
		6: {":Q1000", "PCWC", ""},            // PX BLOCK ITERATOR
		8: {":Q1000", "PCWP", ""},            // INDEX UNIQUE SCAN
	}
	for _, r := range pl.Rows {
		if w, ok := want[r.ID]; ok {
			if !reflect.DeepEqual(r.Extra, w) {
				t.Errorf("row %d (%s): extra %q, want %q", r.ID, r.Op, r.Extra, w)
			}
			delete(want, r.ID)
		}
		if r.ID == 3 && (r.Op != "PX SEND QC (RANDOM)" || r.Name != ":TQ10000") {
			t.Errorf("row 3: %q %q", r.Op, r.Name)
		}
	}
	if len(want) != 0 {
		t.Errorf("rows not found: %v", want)
	}
	if p := pl.Preds[7]; len(p) != 2 || !strings.HasPrefix(p[0].Text, "access(") || !strings.HasPrefix(p[1].Text, "filter(") {
		t.Errorf("preds of 7: %+v", p)
	}

	// a plan without the extra columns has none
	for _, name := range []string{"opt_two", "opt_join8", "opt_dml"} {
		for _, d := range scanOf(t, filepath.Join(optDir, name+".trc")).Dumps {
			if d.Plan == nil {
				continue
			}
			if len(d.Plan.Cols) != 7 {
				t.Errorf("%s: columns %v", name, d.Plan.Cols)
			}
			for _, r := range d.Plan.Rows {
				if r.Extra != nil {
					t.Fatalf("%s: row %d extra %q", name, r.ID, r.Extra)
				}
			}
		}
	}
}

// The digest prints the Hint Report as the trace has it: no verdict is added to a bare line.
func TestDigestHintReportNoVerdictAdded(t *testing.T) {
	text, _ := digestText(t, filepath.Join(optDir, "opt_two.trc"), TextOptions{})
	if strings.Contains(text, "[used]") {
		t.Error("the digest labels a hint [used]; the trace says no such thing")
	}
	if !strings.Contains(text, "use_hash(c)\n") {
		t.Error("the bare Hint Report line is missing")
	}
}

// A digest made without the file's lines rebuilds the plan from the model: the extra columns are printed there too.
func TestDigestRebuiltPlanHasExtraColumns(t *testing.T) {
	var b bytes.Buffer
	sc := scanOf(t, filepath.Join(optDir, "opt_parallel.trc"))
	if err := WriteDigest(&b, sc, nil, TextOptions{}); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	for _, want := range []string{"TQ", "IN-OUT", "PQ Distrib", ":Q1000", "P->S", "QC (RANDOM)", "Query Block Name / Object Alias", `7 - access(:Z>=:Z AND :Z<=:Z)`} {
		if !strings.Contains(out, want) {
			t.Errorf("the rebuilt plan lacks %q", want)
		}
	}
}
