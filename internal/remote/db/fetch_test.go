package db

import (
	"bytes"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

const fetchQuery = "select line_number, payload from v$diag_trace_file_contents where adr_home = :h and trace_filename = :f and line_number between :a and :b order by line_number"

// traceView fakes V$DIAG_TRACE_FILE_CONTENTS for one file of n lines.
func traceView(t *testing.T, n int64, failAt int64) *fakeConn {
	return &fakeConn{query: func(q string, args []any) ([][]any, error) {
		want(t, q, fetchQuery)
		if args[0] != "/adr/home" || args[1] != "cdb1_ora_1.trc" {
			t.Fatalf("args %v", args)
		}
		a, b := args[2].(int64), args[3].(int64)
		if failAt >= a && failAt <= b {
			return nil, errors.New("ORA-03113: end-of-file on communication channel")
		}
		var rows [][]any
		for ln := a; ln <= b && ln <= n; ln++ {
			rows = append(rows, []any{ln, payload(ln)})
		}
		return rows, nil
	}}
}

func payload(ln int64) any {
	switch {
	case ln%1000 == 7:
		return nil // an empty line comes back NULL
	case ln%1000 == 8:
		return fmt.Sprintf("line %d with its own newline\n", ln)
	}
	return fmt.Sprintf("WAIT #1: nam='x' ela= %d", ln)
}

func expectText(from, to int64) string {
	var b strings.Builder
	for ln := from; ln <= to; ln++ {
		if p, ok := payload(ln).(string); ok {
			b.WriteString(strings.TrimSuffix(p, "\n"))
		}
		b.WriteByte('\n')
	}
	return b.String()
}

func chunks(fc *fakeConn) [][2]int64 {
	var out [][2]int64
	for _, c := range fc.calls {
		out = append(out, [2]int64{c.Args[2].(int64), c.Args[3].(int64)})
	}
	return out
}

func TestFetchChunks(t *testing.T) {
	fc := traceView(t, 120003, 0)
	var buf bytes.Buffer
	var prog []int64
	n, err := NewClient(fc).Fetch(ctx, "/adr/home", "cdb1_ora_1.trc", &buf, 0, func(l int64) { prog = append(prog, l) })
	if err != nil || n != 120003 {
		t.Fatalf("Fetch = %d, %v", n, err)
	}
	if got := chunks(fc); !reflect.DeepEqual(got, [][2]int64{{1, 50000}, {50001, 100000}, {100001, 150000}}) {
		t.Errorf("chunks %v", got)
	}
	if !reflect.DeepEqual(prog, []int64{50000, 100000, 120003}) {
		t.Errorf("progress %v", prog)
	}
	if buf.String() != expectText(1, 120003) {
		t.Error("content differs")
	}
}

func TestFetchExactMultiple(t *testing.T) {
	// a file of exactly 2 chunks needs a third, empty query to see the end
	fc := traceView(t, 100000, 0)
	var buf bytes.Buffer
	n, err := NewClient(fc).Fetch(ctx, "/adr/home", "cdb1_ora_1.trc", &buf, 1, nil)
	if err != nil || n != 100000 || len(fc.calls) != 3 {
		t.Errorf("Fetch = %d, %v after %d queries", n, err, len(fc.calls))
	}
}

func TestFetchResume(t *testing.T) {
	fc := traceView(t, 120003, 0)
	var buf bytes.Buffer
	n, err := NewClient(fc).Fetch(ctx, "/adr/home", "cdb1_ora_1.trc", &buf, 70001, nil)
	if err != nil || n != 50003 {
		t.Fatalf("Fetch = %d, %v", n, err)
	}
	if got := chunks(fc); !reflect.DeepEqual(got, [][2]int64{{70001, 120000}, {120001, 170000}}) {
		t.Errorf("chunks %v", got)
	}
	if buf.String() != expectText(70001, 120003) {
		t.Error("content differs")
	}
}

// A dropped connection mid-file leaves w holding whole chunks only; resuming
// at fromLine + lines completes an identical copy.
func TestFetchErrorThenResume(t *testing.T) {
	var buf bytes.Buffer
	n, err := NewClient(traceView(t, 120003, 60000)).Fetch(ctx, "/adr/home", "cdb1_ora_1.trc", &buf, 1, nil)
	if err == nil || n != 50000 || !strings.Contains(err.Error(), "lines 50001-100000") || !IsORA(err, 3113) {
		t.Fatalf("Fetch = %d, %v", n, err)
	}
	if buf.String() != expectText(1, 50000) {
		t.Fatal("partial content is not the first chunk")
	}
	m, err := NewClient(traceView(t, 120003, 0)).Fetch(ctx, "/adr/home", "cdb1_ora_1.trc", &buf, 1+n, nil)
	if err != nil || n+m != 120003 || buf.String() != expectText(1, 120003) {
		t.Errorf("resume = %d, %v", m, err)
	}
}

func TestFetchArgs(t *testing.T) {
	if _, err := NewClient(&fakeConn{}).Fetch(ctx, "", "x.trc", &bytes.Buffer{}, 1, nil); err == nil {
		t.Error("empty adr_home accepted")
	}
}
