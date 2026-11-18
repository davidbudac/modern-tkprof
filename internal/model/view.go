package model

import (
	"fmt"
	"path/filepath"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// The three ways a trace file is read as a session. The default follows the file; the option "view" opens a
// file another way (docs/PLAN-DIAG.md § A file opens by its kind, and can be opened another way).
const (
	View10046 = "10046" // SQL trace records: the model of the 10046 views
	View10053 = "10053" // optimizer dumps: the 10053 reader (internal/opt)
	ViewDiag  = "diag"  // an outline of the file: the dump reader (internal/diag)
)

// ParseView validates the value of the view option: "" (the file decides), "10046", "10053" or "diag".
func ParseView(v string) (string, error) {
	switch v {
	case "", View10046, View10053, ViewDiag:
		return v, nil
	}
	return "", fmt.Errorf("view: want 10046, 10053 or diag, not %q", v)
}

// HasRecords reports whether the parser counted a 10046 record of any kind in the model's files.
func (m *Model) HasRecords() bool {
	for _, k := range trace.RecordKindNames() {
		if m.Diag.LineKinds[k] > 0 {
			return true
		}
	}
	return false
}

// HasDumps reports whether any file of the model holds an optimizer (10053) dump.
func (m *Model) HasDumps() bool {
	for _, fe := range m.File.Files {
		if len(fe.Dumps) > 0 {
			return true
		}
	}
	return false
}

// DefaultView is the view a file opens in when none was asked for. inputs is how many files the user named
// (directories expanded; a followed chain does not count): the 10053 and diag views read one file.
//
//   - 10046 records: 10046 (a file that holds sections or optimizer dumps besides stays a 10046 trace)
//   - only optimizer dumps: 10053 (a single file, as OptOnly)
//   - otherwise, one file: diag (a file with sections and no records, and a file with nothing recognised:
//     the outline of its header and "Other lines" is still an outline)
//   - a set of files with no record: 10046, as before
func DefaultView(m *Model, inputs int) string {
	switch {
	case m.HasRecords():
		return View10046
	case m.OptOnly():
		return View10053
	case inputs == 1 && !m.HasDumps():
		return ViewDiag
	}
	return View10046
}

// ResolveView is the view a session opens in: the requested one, or the default. It refuses what cannot
// be: view 10053 on a file with no dump, 10053 or diag on a set of files.
func ResolveView(m *Model, requested string, inputs int) (string, error) {
	if requested == "" {
		return DefaultView(m, inputs), nil
	}
	if _, err := ParseView(requested); err != nil {
		return "", err
	}
	if requested != View10046 && inputs != 1 {
		return "", fmt.Errorf("view %s opens one file, not a set of %d", requested, inputs)
	}
	if requested == View10053 && (len(m.File.Files) == 0 || len(m.File.Files[0].Dumps) == 0) {
		name := "the file"
		if len(m.File.Files) > 0 {
			name = filepath.Base(m.File.Files[0].Path)
		}
		return "", fmt.Errorf("%s holds no optimizer (10053) dump; it cannot be opened with view 10053", name)
	}
	return requested, nil
}

// ViewModel is the model a document is made of when a file is opened in a view that is not the one of
// its 10046 records (view 10053 or diag on a trace that has records): the same file facts and notes, none
// of the records, so that the document is that of an empty 10046 model, as it is for a file that has none.
// A model without records is returned as it is.
func (m *Model) ViewModel() *Model {
	if !m.HasRecords() {
		return m
	}
	c := Model{File: m.File, Diag: m.Diag}
	c.Diag.ImplicitCursors, c.Diag.AssumedCursors, c.Diag.OrphanCalls, c.Diag.UnattributedWaits, c.Diag.Anchors, c.Diag.UnknownLines = 0, 0, 0, 0, 0, 0
	lk := map[string]int{}
	for k, n := range m.Diag.LineKinds {
		lk[k] = n
	}
	for _, k := range trace.RecordKindNames() {
		delete(lk, k)
	}
	c.Diag.LineKinds = lk
	return &c
}
