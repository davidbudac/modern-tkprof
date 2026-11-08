package ref

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// ObjectRef is one row of a dba_objects / all_objects export.
type ObjectRef struct {
	ID     int64 // object_id
	DataID int64 // data_object_id (0 when absent)
	Owner  string
	Name   string
	Sub    string // subobject_name: partition / subpartition
	Type   string
}

// FileRef is one row of the datafile export. The key is the file number as
// it appears in wait events: for tempfiles that is the db_files offset
// number (ABS_FILE# in the export), not the tempfile's own file#.
type FileRef struct {
	File       int64
	Name       string
	Tablespace string
	Type       string // DATAFILE | TEMPFILE
}

// Bundle is the reference data a DBA collected with the script `mtkprof
// refscript` writes: object, datafile and user names plus DBMS_XPLAN output.
// Any part may be missing (nil or empty map).
type Bundle struct {
	Objects map[int64]ObjectRef // by object_id
	Files   map[int64]FileRef   // by wait-visible file number
	Users   map[int64]string    // user_id -> username
	Plans   map[string]string   // sql_id -> DBMS_XPLAN text

	byData map[int64]int64 // data_object_id -> object_id
}

// Object finds an object by the obj# of a trace line. WAIT lines carry
// object_id for most segments but data_object_id for some, so both are tried.
func (b *Bundle) Object(id int64) (ObjectRef, bool) {
	if b == nil {
		return ObjectRef{}, false
	}
	if o, ok := b.Objects[id]; ok {
		return o, true
	}
	if oid, ok := b.byData[id]; ok {
		o, ok := b.Objects[oid]
		return o, ok
	}
	return ObjectRef{}, false
}

// QualifiedName is owner.name[.subobject].
func (o ObjectRef) QualifiedName() string {
	s := o.Name
	if o.Owner != "" {
		s = o.Owner + "." + s
	}
	if o.Sub != "" {
		s += "." + o.Sub
	}
	return s
}

// Empty reports whether the bundle has no content at all.
func (b *Bundle) Empty() bool {
	return b == nil || len(b.Objects)+len(b.Files)+len(b.Users)+len(b.Plans) == 0
}

// Summary is a one-line description, e.g. "12 objects, 4 datafiles, 3 users, 2 plans".
func (b *Bundle) Summary() string {
	return fmt.Sprintf("%d objects, %d datafiles, %d users, %d plans", len(b.Objects), len(b.Files), len(b.Users), len(b.Plans))
}

// LoadBundle reads a reference bundle directory. The layout is what the
// refscript spools: objects.csv, datafiles.csv, users.csv and
// plans/<sql_id>.txt; every file is optional. For convenience (and so a raw
// export can be dropped in) *_objects.csv is read as objects and
// datafiles_*.csv as datafiles too. CSV headers are matched
// case-insensitively; quotes, a UTF-8 BOM and the blank / feedback lines
// SQL*Plus may leave around the data are tolerated. A file instead of a
// directory is read as the saved output of the names script (ParsePaste).
func LoadBundle(dir string) (*Bundle, error) {
	st, err := os.Stat(dir)
	if err != nil {
		return nil, fmt.Errorf("reference bundle: %w", err)
	}
	if !st.IsDir() {
		return loadPasteFile(dir)
	}
	b := NewBundle()
	for _, p := range globAll(dir, "objects.csv", "*_objects.csv") {
		if err := b.loadObjects(p); err != nil {
			return nil, err
		}
	}
	for _, p := range globAll(dir, "datafiles.csv", "datafiles_*.csv") {
		if err := b.loadFiles(p); err != nil {
			return nil, err
		}
	}
	if err := b.loadUsers(filepath.Join(dir, "users.csv")); err != nil {
		return nil, err
	}
	b.loadPlans(filepath.Join(dir, "plans"))
	return b, nil
}

func globAll(dir string, patterns ...string) []string {
	var out []string
	for _, pat := range patterns {
		ms, _ := filepath.Glob(filepath.Join(dir, pat))
		out = append(out, ms...)
	}
	sort.Strings(out)
	return out
}

// readTable reads a CSV file into header-indexed rows. A missing file is
// not an error (nil, nil).
func readTable(path string) (map[string]int, [][]string, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil, nil
		}
		return nil, nil, err
	}
	raw = bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))
	r := csv.NewReader(bytes.NewReader(raw))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	var rows [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, nil, fmt.Errorf("%s: %w", path, err)
		}
		rows = append(rows, rec)
	}
	// SQL*Plus may print blank lines or a banner before the header: take the
	// first row with more than one field, or whose first cell looks like a header
	for len(rows) > 0 && len(rows[0]) < 2 {
		rows = rows[1:]
	}
	if len(rows) == 0 {
		return nil, nil, nil
	}
	h := make(map[string]int, len(rows[0]))
	for i, c := range rows[0] {
		h[strings.ToUpper(strings.Trim(strings.TrimSpace(c), "\""))] = i
	}
	return h, rows[1:], nil
}

// cell returns the first non-empty value among the named columns.
func cell(row []string, h map[string]int, names ...string) string {
	for _, n := range names {
		if i, ok := h[n]; ok && i < len(row) {
			if v := strings.TrimSpace(row[i]); v != "" {
				return v
			}
		}
	}
	return ""
}

func num(s string) (int64, bool) {
	n, err := strconv.ParseInt(s, 10, 64)
	return n, err == nil
}

func (b *Bundle) loadObjects(path string) error {
	h, rows, err := readTable(path)
	if err != nil {
		return err
	}
	for _, row := range rows {
		id, ok := num(cell(row, h, "OBJECT_ID"))
		if !ok {
			continue
		}
		o := ObjectRef{ID: id, Owner: cell(row, h, "OWNER"), Name: cell(row, h, "OBJECT_NAME"), Sub: cell(row, h, "SUBOBJECT_NAME"), Type: cell(row, h, "OBJECT_TYPE")}
		o.DataID, _ = num(cell(row, h, "DATA_OBJECT_ID"))
		b.addObject(o)
	}
	return nil
}

func (b *Bundle) loadFiles(path string) error {
	h, rows, err := readTable(path)
	if err != nil {
		return err
	}
	for _, row := range rows {
		// ABS_FILE# is the number waits report (tempfiles are offset by db_files)
		id, ok := num(cell(row, h, "ABS_FILE#", "FILE#"))
		if !ok {
			continue
		}
		b.Files[id] = FileRef{File: id, Name: cell(row, h, "NAME", "FILE_NAME"), Tablespace: cell(row, h, "TABLESPACE_NAME", "TABLESPACE"), Type: cell(row, h, "FILE_TYPE")}
	}
	return nil
}

func (b *Bundle) loadUsers(path string) error {
	h, rows, err := readTable(path)
	if err != nil {
		return err
	}
	for _, row := range rows {
		id, ok := num(cell(row, h, "USER_ID", "UID"))
		if !ok {
			continue
		}
		if name := cell(row, h, "USERNAME", "NAME"); name != "" {
			b.Users[id] = name
		}
	}
	return nil
}

// loadPlans reads plans/<sql_id>.txt. Files without a "Plan hash value"
// line (the "cannot be found" message DISPLAY_CURSOR prints for an aged-out
// cursor, an error note from the script) carry no plan and are skipped.
func (b *Bundle) loadPlans(dir string) {
	ents, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range ents {
		name := e.Name()
		if e.IsDir() || !strings.HasSuffix(name, ".txt") {
			continue
		}
		raw, err := os.ReadFile(filepath.Join(dir, name))
		if err != nil {
			continue
		}
		txt := strings.TrimRight(string(bytes.TrimPrefix(raw, []byte("\xef\xbb\xbf"))), " \t\r\n")
		txt = strings.TrimLeft(strings.ReplaceAll(txt, "\r\n", "\n"), "\n")
		if !strings.Contains(txt, "Plan hash value") {
			continue
		}
		b.Plans[strings.TrimSuffix(name, ".txt")] = txt
	}
}

// CopyBundle copies the files LoadBundle reads from the bundle directory src
// (objects.csv, *_objects.csv, datafiles.csv, datafiles_*.csv, users.csv,
// plans/*.txt) into dst, which it creates; nothing else of src is copied. It
// returns how many files it copied.
func CopyBundle(src, dst string) (int, error) {
	files := globAll(src, "objects.csv", "*_objects.csv", "datafiles.csv", "datafiles_*.csv", "users.csv")
	files = append(files, globAll(filepath.Join(src, "plans"), "*.txt")...)
	if err := os.MkdirAll(filepath.Join(dst, "plans"), 0o700); err != nil {
		return 0, err
	}
	n := 0
	for _, f := range files {
		rel, err := filepath.Rel(src, f)
		if err != nil {
			return n, err
		}
		fi, err := os.Stat(f)
		if err != nil || !fi.Mode().IsRegular() {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			return n, err
		}
		if err := os.WriteFile(filepath.Join(dst, rel), raw, 0o600); err != nil {
			return n, err
		}
		n++
	}
	return n, nil
}
