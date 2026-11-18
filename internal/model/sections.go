package model

import (
	"fmt"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// Diagnostic dump sections in a trace file (heap dump, errorstack, process
// state, system state, hang analysis, ...). The parser finds them
// (trace.Stats.Sections) and counts their lines as "diagnostic" instead of
// unknown ones; the model keeps their ranges per file (FileEntry.Sections) and
// says so in a note. Nothing of a section is read here (package diag will).

func sectionRanges(ss []trace.Section) []SectionRange {
	if len(ss) == 0 {
		return nil
	}
	out := make([]SectionRange, len(ss))
	for i, s := range ss {
		out[i] = SectionRange{Kind: s.Kind.String(), First: s.First, Last: s.Last, Cut: s.Cut}
	}
	return out
}

// sectionNouns say what a kind of section is called in a note: singular, plural.
var sectionNouns = map[string][2]string{
	"heap":        {"heap dump", "heap dumps"},
	"pga-summary": {"PGA memory summary", "PGA memory summaries"},
	"pga-detail":  {"PGA memory detail dump", "PGA memory detail dumps"},
	"diagdump":    {"diagnostic dump", "diagnostic dumps"},
	"procstate":   {"process state", "process states"},
	"sysstate":    {"system state", "system states"},
	"hang":        {"hang analysis", "hang analyses"},
	"deadlock":    {"deadlock graph", "deadlock graphs"},
	"incident":    {"incident dump", "incident dumps"},
}

func sectionNoun(kind string, n int) string {
	nn, ok := sectionNouns[kind]
	if !ok {
		nn = [2]string{"diagnostic dump", "diagnostic dumps"}
	}
	if n == 1 {
		return nn[0]
	}
	return nn[1]
}

// SectionNote is the note for a file with diagnostic dump sections: "1
// diagnostic dump in this file, lines 114-29753"; of one other kind "3 heap
// dumps in this file, lines 32-923, 924-1034 and 1035-1486"; of several
// "5 diagnostic dumps in this file (2 heap dumps, 1 process state and 2 hang
// analyses), lines ...". At most five ranges are listed, then "and N more".
// name is the file's name for a trace set of several files (the note then
// starts with it), "" for a single file. "" when there is no section.
func SectionNote(name string, ss []SectionRange) string {
	if len(ss) == 0 {
		return ""
	}
	var kinds []string // in order of first appearance
	count := map[string]int{}
	for _, s := range ss {
		if count[s.Kind] == 0 {
			kinds = append(kinds, s.Kind)
		}
		count[s.Kind]++
	}
	var what string
	if len(kinds) == 1 {
		what = fmt.Sprintf("%d %s", len(ss), sectionNoun(kinds[0], len(ss)))
	} else {
		parts := make([]string, len(kinds))
		for i, k := range kinds {
			parts[i] = fmt.Sprintf("%d %s", count[k], sectionNoun(k, count[k]))
		}
		what = fmt.Sprintf("%d diagnostic dumps (%s)", len(ss), joinAnd(parts))
	}
	var b strings.Builder
	if name == "" {
		fmt.Fprintf(&b, "%s in this file, lines ", what)
	} else {
		fmt.Fprintf(&b, "%s has %s, lines ", name, what)
	}
	shown := ss
	if len(shown) > maxDumpRanges {
		shown = shown[:maxDumpRanges]
	}
	for i, s := range shown {
		switch {
		case i == 0:
		case i == len(shown)-1 && len(shown) == len(ss):
			b.WriteString(" and ")
		default:
			b.WriteString(", ")
		}
		fmt.Fprintf(&b, "%d-%d", s.First, s.Last)
		if s.Cut {
			b.WriteString(" (cut short)")
		}
	}
	if more := len(ss) - len(shown); more > 0 {
		fmt.Fprintf(&b, " and %d more", more)
	}
	return b.String()
}

// joinAnd joins "a, b and c".
func joinAnd(parts []string) string {
	switch len(parts) {
	case 0:
		return ""
	case 1:
		return parts[0]
	}
	return strings.Join(parts[:len(parts)-1], ", ") + " and " + parts[len(parts)-1]
}

// SectionNotes are the notes noteSections adds: one per file that holds
// diagnostic dump sections.
func (m *Model) SectionNotes() []string {
	var out []string
	multi := len(m.File.Files) > 1
	for _, fe := range m.File.Files {
		name := ""
		if multi {
			name = fe.Name
		}
		if n := SectionNote(name, fe.Sections); n != "" {
			out = append(out, n)
		}
	}
	return out
}

// noteSections adds one note per file that holds diagnostic dump sections.
func (m *Model) noteSections() {
	m.Diag.Notes = append(m.Diag.Notes, m.SectionNotes()...)
}
