package opt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// olderFixtures are the 11.2 and 12.1 traces of testdata/opt (README there; some are kept local only).
func olderFixtures(t *testing.T) []string {
	t.Helper()
	a, _ := filepath.Glob("../../testdata/opt/11g/*.trc")
	b, _ := filepath.Glob("../../testdata/opt/12c/*.trc")
	all := append(a, b...)
	if len(all) == 0 {
		t.Skip("no 11g or 12c fixtures")
	}
	return all
}

// TestOlderReleases: 11.2 and 12.1 write no "Version" line and no parser state; the statement text ends at the
// asterisks before "Legend", and its copy in the statement dump at "sql_text_length=".
func TestOlderReleases(t *testing.T) {
	for _, path := range olderFixtures(t) {
		name := fixtureName(path)
		t.Run(name, func(t *testing.T) {
			sc := scanOf(t, path)
			checkInvariants(t, name, sc)
			f := sc.File
			if !strings.HasPrefix(f.Version, "11.2.") && !strings.HasPrefix(f.Version, "12.1.") || f.Tested {
				t.Errorf("version %q tested %v (release %q)", f.Version, f.Tested, f.Release)
			}
			lines := fileLinesOf(t, path)
			for _, d := range sc.Dumps {
				if d.StmtText == "" || d.StmtTo < d.StmtLine {
					t.Errorf("dump %d: no statement text (lines %d-%d)", d.Idx+1, d.StmtLine, d.StmtTo)
					continue
				}
				if want := strings.Join(lines[d.StmtLine-1:d.StmtTo], "\n"); d.StmtText != want {
					t.Errorf("dump %d: statement %q, lines %d-%d hold %q", d.Idx+1, d.StmtText, d.StmtLine, d.StmtTo, want)
				}
				if !isStars([]byte(lines[d.StmtTo])) || !isLegendHeader([]byte(lines[d.StmtTo+1])) {
					t.Errorf("dump %d: statement ends before %q, %q", d.Idx+1, lines[d.StmtTo], lines[d.StmtTo+1])
				}
				again := false
				for _, fo := range d.Folds {
					again = again || fo.Kind == FoldStmtAgn
				}
				if !again && d.StmtTo > d.StmtLine { // a one-line copy is not folded

					t.Errorf("dump %d: the statement dump's copy of the text is not folded", d.Idx+1)
				}
			}
		})
	}
}

// fileLinesOf splits a file as the scanner does: at "\n", less one "\r" before it.
func fileLinesOf(t *testing.T, path string) []string {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := strings.Split(string(raw), "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines
}

func TestReleaseVersion(t *testing.T) {
	for in, want := range map[string]string{
		"Oracle Database 11g Enterprise Edition Release 11.2.0.3.0 - 64bit Production":    "11.2.0.3.0",
		"Oracle Database 12c Enterprise Edition Release 12.1.0.2.0 - 64bit Production":    "12.1.0.2.0",
		"Oracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production":          "",
		"Oracle Database 23ai Free Release 23.0.0.0.0 - Develop, Learn, and Run for Free": "",
		"": "",
	} {
		if got := releaseVersion(in); got != want {
			t.Errorf("releaseVersion(%q) = %q, want %q", in, got, want)
		}
	}
}
