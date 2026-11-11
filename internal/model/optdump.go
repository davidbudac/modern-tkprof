package model

import (
	"fmt"
	"path/filepath"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Optimizer (10053) dumps in a 10046 trace file. The parser finds them
// (trace.Stats.Dumps) and counts their lines as "optimizer" instead of
// unknown ones; the model keeps their ranges per file (FileEntry.Dumps) and
// says so in a note. Nothing of a dump is read yet.

// maxDumpRanges is how many ranges a note lists before "and N more".
const maxDumpRanges = 5

func dumpRanges(ds []trace.Dump) []DumpRange {
	if len(ds) == 0 {
		return nil
	}
	out := make([]DumpRange, len(ds))
	for i, d := range ds {
		out[i] = DumpRange{First: d.First, Last: d.Last, SQLID: d.SQLID, Cut: d.Cut}
	}
	return out
}

// DumpNote is the note for a file with optimizer dumps: "2 optimizer (10053)
// dumps in this file, lines 54-18358 and 18734-27979; not shown as 10053 yet".
// name is the file's name for a trace set of several files (the note then
// starts with it), "" for a single file. "" when there is no dump.
func DumpNote(name string, ds []DumpRange) string {
	if len(ds) == 0 {
		return ""
	}
	var b strings.Builder
	noun := "dumps"
	if len(ds) == 1 {
		noun = "dump"
	}
	if name == "" {
		fmt.Fprintf(&b, "%d optimizer (10053) %s in this file, ", len(ds), noun)
	} else {
		fmt.Fprintf(&b, "%s has %d optimizer (10053) %s, ", name, len(ds), noun)
	}
	b.WriteString("lines ")
	shown := ds
	if len(shown) > maxDumpRanges {
		shown = shown[:maxDumpRanges]
	}
	for i, d := range shown {
		switch {
		case i == 0:
		case i == len(shown)-1 && len(shown) == len(ds):
			b.WriteString(" and ")
		default:
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "%d-%d", d.First, d.Last)
		if d.Cut {
			b.WriteString(" (cut short)")
		}
	}
	if more := len(ds) - len(shown); more > 0 {
		fmt.Fprintf(&b, " and %d more", more)
	}
	b.WriteString("; not shown as 10053 yet")
	return b.String()
}

// noteDumps adds one note per file that holds optimizer dumps.
func (m *Model) noteDumps() {
	multi := len(m.File.Files) > 1
	for _, fe := range m.File.Files {
		name := ""
		if multi {
			name = fe.Name
		}
		if n := DumpNote(name, fe.Dumps); n != "" {
			m.Diag.Notes = append(m.Diag.Notes, n)
		}
	}
}

// DropOptFiles takes the files that hold only optimizer (10053) dumps out of
// a trace set that also has other files: a 10053 file is read on its own,
// never as part of a set of 10046 traces. It returns the files that stay, in
// their order, and one note per file left out ("opt_two.trc is a 10053 file;
// open it on its own"). A set of one file, or one made only of 10053 files,
// is returned as it is; a file that cannot be read stays (the build reports
// it). Deciding costs the read of the start of each file up to its first
// 10046 record, and of a 10053 file to its end.
func DropOptFiles(files []string) (kept, notes []string) {
	if len(files) < 2 {
		return files, nil
	}
	only := make([]bool, len(files))
	n := 0
	for i, f := range files {
		if sn, err := trace.SniffFile(f, trace.SniffOptions{StopAtRecord: true}); err == nil && sn.Kind == trace.FileKind10053 {
			only[i] = true
			n++
		}
	}
	if n == 0 || n == len(files) {
		return files, nil
	}
	for i, f := range files {
		if only[i] {
			notes = append(notes, fmt.Sprintf("%s is a 10053 file; open it on its own", filepath.Base(f)))
		} else {
			kept = append(kept, f)
		}
	}
	return kept, notes
}
