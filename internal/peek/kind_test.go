package peek

import (
	"bytes"
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The kind, the number of dumps and their sql_ids agree with the parser's on
// every fixture: 10046 for the traces, 10053 for the optimizer files, both
// for the interleaved one.
func TestPeekKind(t *testing.T) {
	var files []string
	for _, g := range []string{"traces/*/*.trc", "opt/*/*.trc"} {
		fs, _ := filepath.Glob(filepath.Join("..", "..", "testdata", g))
		files = append(files, fs...)
	}
	if len(files) < 30 {
		t.Fatalf("only %d fixtures", len(files))
	}
	seen := map[string]int{}
	for _, f := range files {
		s, err := File(context.Background(), f)
		if err != nil {
			t.Fatal(err)
		}
		st, err := trace.ParseFile(f, trace.NopHandler{})
		if err != nil {
			t.Fatal(err)
		}
		want := map[trace.FileKind]string{trace.FileKind10046: "10046", trace.FileKind10053: "10053", trace.FileKindBoth: "both", trace.FileKindNone: ""}[st.FileKind()]
		if s.Kind != want {
			t.Errorf("%s: kind %q, parser says %q", f, s.Kind, want)
		}
		var ids []string
		for _, d := range st.Dumps {
			ids = append(ids, d.SQLID)
		}
		if s.OptDumps != len(st.Dumps) || !slices.Equal(s.OptSQLIDs, ids) {
			t.Errorf("%s: %d dumps %v, parser %d %v", f, s.OptDumps, s.OptSQLIDs, len(st.Dumps), ids)
		}
		seen[s.Kind]++
	}
	if seen["10053"] < 5 || seen["both"] != 1 || seen["10046"] < 30 {
		t.Errorf("kinds seen %v", seen)
	}
}

// A dump whose start, sql_id line and END banner are in different chunks.
func TestPeekDumpAcrossChunks(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("*** 2026-10-22T11:35:29.000000+00:00\nRegistered qb: SEL$1 0xe8eab888 (PARSER)\n")
	filler := strings.Repeat("x", 99) + "\n"
	for b.Len() < chunk-50 {
		b.WriteString(filler)
	}
	b.WriteString("----- Current SQL Statement for this session (sql_id=7jqt2tmvuc9hn) -----\n")
	for b.Len() < 2*chunk+50 {
		b.WriteString(filler)
	}
	b.WriteString("====================== END SQL Statement Dump ======================\n")
	b.WriteString("Registered qb: SEL$1 0xe97a6b70 (PARSER)\n")
	for b.Len() < 3*chunk {
		b.WriteString(filler)
	}
	b.WriteString("====================== END SQL Statement Dump ======================\n")
	var s Summary
	if err := Read(context.Background(), bytes.NewReader(b.Bytes()), int64(b.Len()), &s); err != nil {
		t.Fatal(err)
	}
	if s.Kind != "10053" || s.OptDumps != 2 || !slices.Equal(s.OptSQLIDs, []string{"7jqt2tmvuc9hn", ""}) {
		t.Errorf("kind %q dumps %d %q", s.Kind, s.OptDumps, s.OptSQLIDs)
	}
}

// Lines that are not a dump start, and a dump without END.
func TestPeekDumpLines(t *testing.T) {
	for _, c := range []struct {
		name, text, kind string
		dumps            int
	}{
		{"qb line that is not a start", "Registered qb: SEL$58A6D7F6 0x64387718 (VIEW MERGE SEL$2; SEL$1; SEL$2)\n", "", 0},
		{"cut dump", "Registered qb: SEL$1 0xe8eab888 (PARSER)\nmore\n", "10053", 1},
		{"qb lines in a dump", "Registered qb: SEL$1 0xe8eab888 (PARSER)\nRegistered qb: SEL$2 0xe97a3cf8 (PARSER)\n====================== END SQL Statement Dump ======================\nRegistered qb: UPD$1 0xe97a3cf8 (PARSER)\n", "10053", 2},
		{"record after a dump", "Registered qb: SEL$1 0xe8eab888 (PARSER)\n====================== END SQL Statement Dump ======================\nPARSING IN CURSOR #1 len=8 dep=0 uid=1 oct=3 lid=1 tim=100 hv=1 ad='0' sqlid='a'\nselect 1\nEND OF STMT\n", "both", 1},
		{"record before a dump", "EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=61000000\nRegistered qb: SEL$1 0xe8eab888 (PARSER)\n", "both", 1},
		{"no dump", "EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=61000000\n", "10046", 0},
	} {
		var s Summary
		if err := Read(context.Background(), strings.NewReader(c.text), int64(len(c.text)), &s); err != nil {
			t.Fatal(err)
		}
		if s.Kind != c.kind || s.OptDumps != c.dumps {
			t.Errorf("%s: kind %q dumps %d, want %q %d", c.name, s.Kind, s.OptDumps, c.kind, c.dumps)
		}
	}
}

// A read that is cancelled first answers with what it saw.
func TestPeekKindWhenCancelled(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("Registered qb: SEL$1 0xe8eab888 (PARSER)\n----- Current SQL Statement for this session (sql_id=7jqt2tmvuc9hn) -----\n")
	filler := strings.Repeat("x", 99) + "\n"
	for b.Len() < chunk+100 {
		b.WriteString(filler)
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &cancelAfterFirstRead{Reader: bytes.NewReader(b.Bytes()), cancel: cancel}
	var s Summary
	err := Read(ctx, r, int64(b.Len()), &s)
	if err == nil {
		t.Fatal("read not cancelled")
	}
	if s.Kind != "10053" || s.OptDumps != 1 || !slices.Equal(s.OptSQLIDs, []string{"7jqt2tmvuc9hn"}) {
		t.Errorf("kind %q dumps %d %q", s.Kind, s.OptDumps, s.OptSQLIDs)
	}
}

type cancelAfterFirstRead struct {
	*bytes.Reader
	cancel func()
}

func (c *cancelAfterFirstRead) ReadAt(p []byte, off int64) (int, error) {
	n, err := c.Reader.ReadAt(p, off)
	c.cancel()
	return n, err
}
