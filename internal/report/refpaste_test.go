package report

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// TestRefPasteScriptPinned pins the names script (`refscript -paste`): the
// io_waits one ran on the lab (internal/ref/testdata/paste_io_waits_*.txt are
// its output), so a change must be run there again.
func TestRefPasteScriptPinned(t *testing.T) {
	cases := []struct {
		name string
		m    func(t *testing.T) *model.Model
		o    RefPasteOptions
	}{
		{"io_waits", fixture("io_waits"), RefPasteOptions{}},
		{"io_waits_plans", fixture("io_waits"), RefPasteOptions{Plans: true}},
		{"chunked_plans", func(*testing.T) *model.Model { return chunkedModel() }, RefPasteOptions{Plans: true}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := RefPasteScript(c.m(t), c.o)
			path := filepath.Join("testdata", "refpaste_"+c.name+".sql")
			if *updateRefScript {
				if err := os.WriteFile(path, []byte(got), 0o644); err != nil {
					t.Fatal(err)
				}
			}
			want, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if got != string(want) {
				t.Errorf("RefPasteScript differs from %s", path)
			}
		})
	}
}

// The ids go in as constructor calls of at most 1000; sql_ids from a hostile
// trace never reach the script; without plans there is no plan section.
func TestRefPasteScriptChunksAndSanitises(t *testing.T) {
	m := chunkedModel()
	sc := RefPasteScript(m, RefPasteOptions{Plans: true})
	for _, list := range regexp.MustCompile(`(?s)sys\.odci(?:number|varchar2)list\(([^)]+)\)\);`).FindAllStringSubmatch(sc, -1) {
		if n := strings.Count(list[1], ",") + 1; n > 1000 {
			t.Errorf("a list of %d ids", n)
		}
	}
	if n := strings.Count(sc, "push(objs, "); n != 3 {
		t.Errorf("2500 obj# in %d lists, want 3", n)
	}
	if strings.Contains(sc, "drop table") || strings.Contains(sc, "passwd") {
		t.Error("untrusted sql_id leaked into the script")
	}
	if !strings.Contains(sc, "push(sqlids, sys.odcivarchar2list('0123456789abc', 'abcdefghijklm'));") {
		t.Error("the valid sql_ids are missing")
	}
	if !strings.HasPrefix(sc, "-- mtkprof names script for x?y.trc\n") {
		t.Errorf("trace name not sanitised: %q", strings.SplitN(sc, "\n", 2)[0])
	}
	no := RefPasteScript(m, RefPasteOptions{})
	if strings.Contains(no, "sqlids") || strings.Contains(no, "dbms_xplan") {
		t.Error("a script without plans must not ask for them")
	}
	if c := RefCountsOf(m); c != (RefCounts{Objects: 2500, Users: 1504, Plans: 2}) {
		t.Errorf("counts = %+v", c)
	}
	// read-only: no DDL or DML outside the comments and literals that name them
	code := regexp.MustCompile(`(?m)^--.*$`).ReplaceAllString(sc, "")
	for _, bad := range []string{"insert ", "update ", "delete ", "merge ", "create ", "drop ", "alter ", "grant ", "truncate "} {
		if strings.Contains(strings.ToLower(code), bad) {
			t.Errorf("the script contains %q", bad)
		}
	}
}
