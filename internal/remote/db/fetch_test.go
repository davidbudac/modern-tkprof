package db

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

// The view of basic_binds.trc as read on dbmint (testdata/db/basic_binds.view):
// 2707 records of the 3059-line file; a record is one or more lines, its
// line_number is the file's line count at its end (a few STAT lines are one
// less, several records share a number, and 20 records are NULL).
type viewRow struct {
	ln      int64
	payload any // string, or nil for NULL
}

func loadView(t *testing.T) ([]viewRow, string) {
	t.Helper()
	b, err := os.ReadFile("../../../testdata/db/basic_binds.view")
	if err != nil {
		t.Fatal(err)
	}
	var rows []viewRow
	for _, l := range strings.Split(string(b), "\n") {
		if l == "" || l[0] == '#' {
			continue
		}
		ln, p, _ := strings.Cut(l, "\t")
		n, err := strconv.ParseInt(ln, 10, 64)
		if err != nil {
			t.Fatal(err)
		}
		r := viewRow{ln: n}
		if p != "NULL" {
			if r.payload, err = strconv.Unquote(p); err != nil {
				t.Fatal(err)
			}
		}
		rows = append(rows, r)
	}
	want, err := os.ReadFile("../../../testdata/traces/19c/basic_binds.trc")
	if err != nil {
		t.Fatal(err)
	}
	return rows, string(want)
}

// scaled repeats the view k times, line numbers continuing, so it spans
// several FetchChunk ranges; the file is k copies of the trace.
func scaled(rows []viewRow, k int, lines int64) []viewRow {
	var out []viewRow
	for i := 0; i < k; i++ {
		for _, r := range rows {
			out = append(out, viewRow{r.ln + int64(i)*lines, r.payload})
		}
	}
	return out
}

// traceView fakes V$DIAG_TRACE_FILE_CONTENTS for one file; the statement
// whose range holds failAt fails.
func traceView(t *testing.T, view []viewRow, failAt int64) *fakeConn {
	return &fakeConn{query: func(q string, args []any) ([][]any, error) {
		if args[0] != "/adr/home" || args[1] != "cdb1_ora_1.trc" {
			t.Fatalf("args %v", args)
		}
		if q == fetchMaxSQL {
			if len(view) == 0 {
				return [][]any{{nil}}, nil
			}
			return [][]any{{view[len(view)-1].ln}}, nil
		}
		want(t, q, fetchSQL)
		a, b := args[2].(int64), args[3].(int64)
		if failAt >= a && failAt <= b {
			return nil, errors.New("ORA-03113: end-of-file on communication channel")
		}
		var rows [][]any
		for _, r := range view {
			if r.ln >= a && r.ln <= b {
				rows = append(rows, []any{r.ln, r.payload})
			}
		}
		return rows, nil
	}}
}

// chunks lists the (a, b) of the range queries.
func chunks(fc *fakeConn) [][2]int64 {
	var out [][2]int64
	for _, c := range fc.calls {
		if len(c.Args) == 4 {
			out = append(out, [2]int64{c.Args[2].(int64), c.Args[3].(int64)})
		}
	}
	return out
}

func fetchAll(t *testing.T, view []viewRow, from Resume, w *bytes.Buffer) (int64, *fakeConn, error) {
	fc := traceView(t, view, 0)
	n, err := NewClient(fc).Fetch(ctx, "/adr/home", "cdb1_ora_1.trc", w, from, nil)
	return n, fc, err
}

// resumeOf is what OpenResume reports for a local file holding prefix.
func resumeOf(prefix string) Resume {
	r := Resume{Lines: int64(strings.Count(prefix, "\n"))}
	if len(prefix) > ResumeTail {
		prefix = prefix[len(prefix)-ResumeTail:]
	}
	r.Tail = []byte(prefix)
	return r
}

// The payloads, written as they are, are the file: no newline is added and
// the NULL records add nothing.
func TestFetchFixtureBytes(t *testing.T) {
	view, want := loadView(t)
	if len(view) != 2707 || strings.Count(want, "\n") != 3059 {
		t.Fatalf("fixture: %d records, %d lines", len(view), strings.Count(want, "\n"))
	}
	var buf bytes.Buffer
	var prog []int64
	fc := traceView(t, view, 0)
	n, err := NewClient(fc).Fetch(ctx, "/adr/home", "cdb1_ora_1.trc", &buf, Resume{}, func(l int64) { prog = append(prog, l) })
	if err != nil || n != 3059 || buf.String() != want {
		t.Fatalf("Fetch = %d, %v; equal: %v", n, err, buf.String() == want)
	}
	if !reflect.DeepEqual(prog, []int64{3059}) {
		t.Errorf("progress %v", prog)
	}
	// max(line_number) first, then one range
	if q := fc.queries(); len(q) != 2 || q[0] != fetchMaxSQL || !reflect.DeepEqual(chunks(fc), [][2]int64{{1, 50000}}) {
		t.Errorf("queries %q", q)
	}
}

// Several ranges, the last one holding the end; a file that is an exact
// multiple of the range needs no extra empty query.
func TestFetchChunks(t *testing.T) {
	view, want := loadView(t)
	big := scaled(view, 40, 3059) // 122 360 lines
	var buf bytes.Buffer
	n, fc, err := fetchAll(t, big, Resume{}, &buf)
	if err != nil || n != 40*3059 || buf.String() != strings.Repeat(want, 40) {
		t.Fatalf("Fetch = %d, %v", n, err)
	}
	if got := chunks(fc); !reflect.DeepEqual(got, [][2]int64{{1, 50000}, {50001, 100000}, {100001, 150000}}) {
		t.Errorf("chunks %v", got)
	}
	exact := []viewRow{{1, "a\n"}, {50000, "b\n"}, {100000, "c\n"}}
	buf.Reset()
	if n, fc, err = fetchAll(t, exact, Resume{}, &buf); err != nil || n != 3 || len(chunks(fc)) != 2 {
		t.Errorf("exact multiple: %d, %v, %d ranges", n, err, len(chunks(fc)))
	}
	// an empty or unknown file: max is NULL, nothing is asked
	buf.Reset()
	if n, fc, err = fetchAll(t, nil, Resume{}, &buf); err != nil || n != 0 || len(chunks(fc)) != 0 {
		t.Errorf("empty: %d, %v, %d ranges", n, err, len(chunks(fc)))
	}
}

// A copy cut at any line of the file, or in the middle of one, resumes to
// the same bytes: the rows before the cut are matched, not counted, because
// line_number is not the line index (a STAT line right after its FETCH has
// the FETCH's number).
func TestFetchResumeEveryLine(t *testing.T) {
	view, want := loadView(t)
	cuts := 0
	for i := 0; i <= len(want); i++ {
		if i < len(want) && want[i] != '\n' && i%97 != 0 {
			continue // all line ends, and some points inside lines
		}
		var local string
		if i < len(want) && want[i] != '\n' {
			j := strings.LastIndexByte(want[:i], '\n')
			local = want[:j+1] // OpenResume cuts the partial line
		} else if i < len(want) {
			local = want[:i+1]
		} else {
			local = want
		}
		var buf bytes.Buffer
		n, _, err := fetchAll(t, view, resumeOf(local), &buf)
		if err != nil || local+buf.String() != want || n != int64(strings.Count(want[len(local):], "\n")) {
			t.Fatalf("cut at %d (%d lines): %d, %v, equal %v", i, strings.Count(local, "\n"), n, err, local+buf.String() == want)
		}
		cuts++
	}
	t.Logf("%d cuts", cuts)
}

// The cases line_number alone gets wrong: the copy ends after a FETCH whose
// STAT line has the same number, and in the middle of a multi-line record.
func TestFetchResumeSTATAndMidRecord(t *testing.T) {
	view, want := loadView(t)
	for _, c := range []struct{ name, after string }{
		{"after FETCH, before STAT", "FETCH #140124363549808:c=29"},
		{"inside the Dump record", "Dump of memory from 0x7f713ee967a0 to 0x7f713ee967ac\n"},
	} {
		i := strings.Index(want, c.after)
		if i < 0 {
			t.Fatal(c.name)
		}
		i += len(c.after)
		if j := strings.IndexByte(want[i:], '\n'); j >= 0 && !strings.HasSuffix(c.after, "\n") {
			i += j + 1
		}
		local := want[:i]
		var buf bytes.Buffer
		n, fc, err := fetchAll(t, view, resumeOf(local), &buf)
		if err != nil || local+buf.String() != want {
			t.Fatalf("%s: %d, %v", c.name, n, err)
		}
		if c.name[0] == 'a' {
			// the wrong way: records with line_number > lines in the copy lose the STAT
			L := int64(strings.Count(local, "\n"))
			skipped := false
			for _, r := range view {
				if r.ln == L && strings.HasPrefix(r.payload.(string), "STAT") {
					skipped = true
				}
			}
			if !skipped {
				t.Errorf("fixture no longer has a STAT numbered like the FETCH before it")
			}
		}
		if got := chunks(fc); len(got) != 1 || got[0][0] != int64(strings.Count(local, "\n")-ResumeBack) {
			t.Errorf("%s: ranges %v", c.name, got)
		}
	}
}

func TestFetchResumeMismatch(t *testing.T) {
	view, want := loadView(t)
	for _, local := range []string{
		"another file\nwith other lines\n",
		want[:len(want)/2] + "tampered line\n",
		want + "one line more than the database has\n",
	} {
		var buf bytes.Buffer
		n, _, err := fetchAll(t, view, resumeOf(local), &buf)
		if err == nil || !strings.Contains(err.Error(), "does not match") || n != 0 || buf.Len() != 0 {
			t.Errorf("%.30q...: %d, %v, wrote %d", local, n, err, buf.Len())
		}
	}
}

// A copy that already is the whole trace adds nothing.
func TestFetchResumeComplete(t *testing.T) {
	view, want := loadView(t)
	var buf bytes.Buffer
	if n, _, err := fetchAll(t, view, resumeOf(want), &buf); err != nil || n != 0 || buf.Len() != 0 {
		t.Errorf("%d, %v, wrote %d", n, err, buf.Len())
	}
}

// A dropped connection mid-file leaves w holding whole ranges only; resuming
// from what is in w completes an identical copy.
func TestFetchErrorThenResume(t *testing.T) {
	view, want := loadView(t)
	big := scaled(view, 40, 3059)
	full := strings.Repeat(want, 40)
	var buf bytes.Buffer
	n, err := NewClient(traceView(t, big, 60000)).Fetch(ctx, "/adr/home", "cdb1_ora_1.trc", &buf, Resume{}, nil)
	if err == nil || !strings.Contains(err.Error(), "lines 50001-100000") || !IsORA(err, 3113) {
		t.Fatalf("Fetch = %d, %v", n, err)
	}
	if n < 49000 || n > 50000 || !strings.HasPrefix(full, buf.String()) || int64(strings.Count(buf.String(), "\n")) != n {
		t.Fatalf("partial copy: %d lines, %d bytes", n, buf.Len())
	}
	local := buf.String()
	m, fc, err := fetchAll(t, big, resumeOf(local), &buf)
	if err != nil || n+m != 40*3059 || buf.String() != full {
		t.Errorf("resume = %d after %d lines, %v; total %d, equal %v", m, n, err, n+m, buf.String() == full)
	}
	if got := chunks(fc); got[0][0] != n-ResumeBack {
		t.Errorf("first range %v after %d lines", got[0], n)
	}
}

// OpenResume: cuts a partial last line, hands over the count and the tail.
func TestOpenResume(t *testing.T) {
	p := filepath.Join(t.TempDir(), "x.trc")
	os.WriteFile(p, []byte("one\ntwo\nthr"), 0o644)
	f, r, err := OpenResume(p, 0o644)
	if err != nil || r.Lines != 2 || string(r.Tail) != "one\ntwo\n" {
		t.Fatalf("OpenResume = %+v, %v", r, err)
	}
	f.WriteString("three\n")
	f.Close()
	if b, _ := os.ReadFile(p); string(b) != "one\ntwo\nthree\n" {
		t.Errorf("%q", b)
	}
	big := strings.Repeat("0123456789abcdef\n", ResumeTail/16)
	os.WriteFile(p, []byte(big+"par"), 0o644)
	f, r, err = OpenResume(p, 0o644)
	f.Close()
	if err != nil || r.Lines != int64(ResumeTail/16) || len(r.Tail) != ResumeTail || !strings.HasSuffix(big, string(r.Tail)) {
		t.Errorf("big file: %d lines, %d tail bytes, %v", r.Lines, len(r.Tail), err)
	}
	f, r, err = OpenResume(filepath.Join(t.TempDir(), "new.trc"), 0o644)
	f.Close()
	if err != nil || r.Lines != 0 || len(r.Tail) != 0 {
		t.Errorf("new file: %+v, %v", r, err)
	}
}

func TestFetchArgs(t *testing.T) {
	if _, err := NewClient(&fakeConn{}).Fetch(ctx, "", "x.trc", &bytes.Buffer{}, Resume{}, nil); err == nil {
		t.Error("empty adr_home accepted")
	}
}
