package report

import (
	"flag"
	"os"
	"path/filepath"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

var updateRefScript = flag.Bool("update-refscript", false, "rewrite testdata/refscript_*.sql from RefScript")

// TestRefScriptPinned pins the whole script text: the RefQueries refactor
// (and any later change) must keep what DBAs run byte-identical.
func TestRefScriptPinned(t *testing.T) {
	cases := []struct {
		name string
		m    func(t *testing.T) *model.Model
		o    RefScriptOptions
	}{
		{"io_waits", fixture("io_waits"), RefScriptOptions{}},
		{"io_waits_lite", fixture("io_waits"), RefScriptOptions{Lite: true}},
		{"basic_binds", fixture("basic_binds"), RefScriptOptions{}},
		{"plan_stat_all", fixture("plan_stat_all"), RefScriptOptions{}},
		{"multisession_a", fixture("multisession_a"), RefScriptOptions{}},
		{"chunked", func(*testing.T) *model.Model { return chunkedModel() }, RefScriptOptions{}},
		{"chunked_lite", func(*testing.T) *model.Model { return chunkedModel() }, RefScriptOptions{Lite: true}},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := RefScript(c.m(t), c.o)
			path := filepath.Join("testdata", "refscript_"+c.name+".sql")
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
				t.Errorf("RefScript differs from %s", path)
			}
		})
	}
}

func fixture(name string) func(t *testing.T) *model.Model {
	return func(t *testing.T) *model.Model {
		m, err := model.Build("../../testdata/traces/19c/"+name+".trc", model.Options{})
		if err != nil {
			t.Fatal(err)
		}
		// the CLI names the script after the path it was given
		m.File.Path = "testdata/traces/19c/" + name + ".trc"
		return m
	}
}

// chunkedModel has more ids than one IN-list holds, file waits, and sql_ids
// that must be rejected.
func chunkedModel() *model.Model {
	m := &model.Model{File: model.FileInfo{Path: "/tmp/x\ny.trc"}}
	for i := 1; i <= 2500; i++ {
		m.Waits = append(m.Waits, model.Wait{ObjID: int64(100000 + i), Event: model.None})
	}
	m.Statements = []model.Statement{
		{Kind: model.StmtSQL, SQLID: "abcdefghijklm", Text: "select 1", UID: 5, LID: 7},
		{Kind: model.StmtSQL, SQLID: "x'; drop table t; --", Text: "select 2"},
		{Kind: model.StmtSQL, SQLID: "../../etc/passwd", Text: "select 3"},
		{Kind: model.StmtSQL, SQLID: "0123456789abc", Text: "select 4", UID: 1200},
	}
	for i := 0; i < 1500; i++ {
		m.Statements = append(m.Statements, model.Statement{Kind: model.StmtSQL, UID: 2000 + i})
	}
	return m
}
