package peek

import (
	"bytes"
	"context"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// The peek agrees with the full model on every fixture: the sessions, the
// prologue and the traced time (first and last tim; the model takes the
// smallest and largest, the peek the first and last written, which may
// differ by the few µs between a call and its PARSING IN CURSOR line).
func TestPeekMatchesModel(t *testing.T) {
	var files []string
	for _, v := range []string{"19c", "21c", "23ai"} {
		fs, _ := filepath.Glob(filepath.Join("..", "..", "testdata", "traces", v, "*.trc"))
		files = append(files, fs...)
	}
	if len(files) < 30 {
		t.Fatalf("only %d fixtures", len(files))
	}
	for _, f := range files {
		t.Run(filepath.Base(f), func(t *testing.T) {
			s, err := File(context.Background(), f)
			if err != nil {
				t.Fatal(err)
			}
			m, err := model.Build(f, model.Options{})
			if err != nil {
				t.Fatal(err)
			}
			var want []string
			for _, c := range m.Contexts {
				if c.SessionID != "" && !slices.Contains(want, c.SessionID) {
					want = append(want, c.SessionID)
				}
			}
			var got []string
			for _, ss := range s.Sessions {
				got = append(got, ss.ID)
			}
			if !slices.Equal(got, want) || s.SessionCount != len(want) {
				t.Errorf("sessions %v (%d), model %v", got, s.SessionCount, want)
			}
			if s.Instance != m.File.Instance || s.Version != m.File.Version || s.TraceFile != m.File.TraceFile {
				t.Errorf("prologue %q %q %q, model %q %q %q", s.Instance, s.Version, s.TraceFile, m.File.Instance, m.File.Version, m.File.TraceFile)
			}
			const slack = int64(5 * time.Millisecond / time.Microsecond)
			if sp := m.Span; sp.FirstWallUs != 0 {
				if s.Start == nil || s.End == nil {
					t.Fatalf("no start or end; model %d..%d", sp.FirstWallUs, sp.LastWallUs)
				}
				if d := s.Start.UnixMicro() - sp.FirstWallUs; d < -slack || d > slack {
					t.Errorf("start %v, model %v (%d µs)", s.Start, time.UnixMicro(sp.FirstWallUs), d)
				}
				if d := s.End.UnixMicro() - sp.LastWallUs; d < -slack || d > slack {
					t.Errorf("end %v, model %v (%d µs)", s.End, time.UnixMicro(sp.LastWallUs), d)
				}
				if d := s.ElapsedUs - sp.Us(); d < -slack || d > slack {
					t.Errorf("elapsed %d, model %d", s.ElapsedUs, sp.Us())
				}
			}
			if !s.SQLTrace {
				t.Errorf("not seen as a SQL trace")
			}
			if (s.ContinuesIn != "") != (len(m.File.ContinuesIn) > 0) || s.Truncated != m.File.Truncated {
				t.Errorf("continues %q truncated %v, model %v %v", s.ContinuesIn, s.Truncated, m.File.ContinuesIn, m.File.Truncated)
			}
		})
	}
}

// A file without 10046 lines (a background process trace) is no SQL trace;
// its time comes from the markers.
func TestPeekBackgroundTrace(t *testing.T) {
	text := "Trace file /u01/diag/trace/cdb1_mmon_1234.trc\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\nVersion 19.27.0.0.0\nInstance name: cdb1\n\n" +
		"*** 2026-10-22T11:35:29.191626+00:00\nsome dump text\n\n*** 2026-10-22T11:45:29.191626+00:00\nmore dump text tim=x\n"
	var s Summary
	if err := Read(context.Background(), strings.NewReader(text), int64(len(text)), &s); err != nil {
		t.Fatal(err)
	}
	if s.SQLTrace || s.Instance != "cdb1" || s.Start == nil || s.End == nil || s.End.Sub(*s.Start) != 10*time.Minute || s.ElapsedUs != 600_000_000 {
		t.Errorf("got %+v", s)
	}
}

// Lines and markers that straddle the read buffer are read whole.
func TestPeekAcrossChunks(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("*** 2026-10-22T11:35:29.000000+00:00\n*** SESSION ID:(51.1) 2026-10-22T11:35:29.000000+00:00\n*** MODULE NAME:(m1) 2026-10-22T11:35:29.000000+00:00\n")
	b.WriteString("WAIT #1: nam='x' ela= 1 p1=0 p2=0 p3=0 obj#=-1 tim=1000000\n")
	line := "WAIT #1: nam='SQL*Net message from client' ela= 1 driver id=1 #bytes=1 p3=0 obj#=-1 tim=1000001\n"
	for b.Len() < chunk-20 {
		b.WriteString(line)
	}
	b.WriteString("*** SESSION ID:(52.7) 2026-10-22T11:36:29.000000+00:00\n*** MODULE NAME:(m2) 2026-10-22T11:36:29.000000+00:00\n")
	for b.Len() < 2*chunk+100 {
		b.WriteString(line)
	}
	b.WriteString("EXEC #1:c=1,e=1,p=0,cr=0,cu=0,mis=0,r=0,dep=0,og=1,plh=0,tim=61000000\n")
	var s Summary
	if err := Read(context.Background(), bytes.NewReader(b.Bytes()), int64(b.Len()), &s); err != nil {
		t.Fatal(err)
	}
	if s.SessionCount != 2 || s.Sessions[0].Module != "m1" || s.Sessions[1].ID != "52.7" || s.Sessions[1].Module != "m2" {
		t.Errorf("sessions %+v", s.Sessions)
	}
	// the second anchor (11:36:29 at tim 1000001) sets the end: 60 s later
	want := time.Date(2026, 10, 22, 11, 37, 28, 999999000, time.UTC)
	if s.End == nil || !s.End.Equal(want) || s.ElapsedUs != 60_000_000 {
		t.Errorf("end %v elapsed %d, want %v", s.End, s.ElapsedUs, want)
	}
}
