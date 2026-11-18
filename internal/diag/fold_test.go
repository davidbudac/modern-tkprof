package diag

import (
	"sort"
	"strings"
	"testing"
)

// foldedSet lists the (kind: title) of the children of every top-level node that carry a fold, with the
// reason, and the unfolded ones that are bulk (800 lines or more) as a second list.
func foldedSet(t testing.TB, r *Reader) (folded map[string]string, bulk []string) {
	t.Helper()
	folded = map[string]string{}
	var walk func(n Node, depth int)
	walk = func(n Node, depth int) {
		if n.Fold != "" {
			folded[n.Kind+": "+n.Title] = n.Fold
		} else if depth > 0 && n.Lines >= 800 && (n.Kind == "title" || n.Kind == "banner" || n.Kind == "toc") {
			bulk = append(bulk, n.Title)
		}
		// what is inside a folded part is folded with it
		if !n.HasChildren || n.Fold != "" || depth >= 3 || n.Kind == "heap" || n.Kind == "process" || n.Kind == "so" {
			return
		}
		for _, c := range allChildren(t, r, n.ID, Cap) {
			walk(c, depth+1)
		}
	}
	for _, n := range r.Scan.Top {
		if n.Fold != "" {
			t.Errorf("top-level node %q has a fold", n.Title)
		}
		walk(n, 0)
	}
	sort.Strings(bulk)
	return
}

// TestFolds: the fold list. Every part the table names that the fixtures hold is folded with its reason,
// no section and no part with state objects is, and what stays unfolded among the bulky parts (800 lines or
// more) is a short list that names what it is: the reader's own subjects.
func TestFolds(t *testing.T) {
	files := append(fixtures(t), bigFixtures()...)
	seen := map[string]bool{}
	allowed := map[string]bool{
		"Process summary":                         true, // the system state's table of processes
		"Session Cached Cursor Dump":              true, // the cursors the reading lists, 774-914 lines
		"Session Cursor Dump":                     true,
		"RDBMS Session Cached Cursor Dump":        true,
		"Process State Dump (2)":                  true, // the part of an incident file that holds the process state
		"CURRENT SESSION'S INSTANTIATION STATE":   true,
		"Non-intersecting chains":                 true, // hang analysis
		"PER-PROCESS PRIVATE MEMORY USAGE":        true, // PGA summary tables
		"ESTIMATED MEMORY USES FOR ALL PROCESSES": true,
	}
	for _, fx := range files {
		r := readerOf(t, fx)
		folded, bulk := foldedSet(t, r)
		for k, reason := range folded {
			seen[k] = true
			title := k[strings.Index(k, ": ")+2:]
			ok := false
			for _, f := range foldTable {
				if strings.HasPrefix(title, f.prefix) && f.reason == reason {
					ok = true
				}
			}
			if !ok {
				t.Errorf("%s: %q folds with %q, not by the table", fixtureName(fx), k, reason)
			}
			if reason == "" || len(reason) > 80 {
				t.Errorf("%s: %q has the fold %q", fixtureName(fx), k, reason)
			}
		}
		for _, title := range bulk {
			if !allowed[title] && !strings.HasPrefix(title, "Dump for incident") && !strings.Contains(title, "krsh main SGA") {
				t.Errorf("%s: %q is %d lines or more and is not folded: add it to foldTable (with evidence) or to the allowed list", fixtureName(fx), title, 800)
			}
		}
	}
	for _, want := range []string{"title: Binary Stack Dump", "title: Argument/Register Address Dump", "title: Process Map Dump", "title: Pinned Buffer History",
		"title: end of leaf block dump", "title: Dump of the Fixed PGA", "title: Fixed Areas Dump (level=65)"} {
		if !seen[want] {
			t.Errorf("no fixture folds %q", want)
		}
	}
	if len(bigFixtures()) > 0 {
		for _, want := range []string{"title: Dump of the Fixed SGA", "title: Dump of Compile-Time Constants", "toc: Fixed Areas Dump (level=327)", "toc: START DDE Actions Dump", "toc: Archival Runtime State", "toc: Auto SGA Transfer History", "title: KSM MGA SYSTEM DUMP - END"} {
			if !seen[want] {
				t.Errorf("no big fixture folds %q", want)
			}
		}
	}
	// the process state of a dump and what it holds are not folded
	for _, k := range []string{"procstate: Process state", "so: process (2)", "diagdump: Diagnostic dump (level 2)", "title: Session Cursor Dump", "title: Call Stack Trace", "title: PL/SQL Call Stack"} {
		if seen[k] {
			t.Errorf("%q is folded", k)
		}
	}
}
