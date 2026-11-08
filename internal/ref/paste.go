package ref

import (
	"bytes"
	"encoding/csv"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// The names script (`mtkprof refscript -paste`, report.RefPasteScript) prints
// the reference data as text to copy and paste instead of spooling files:
// one PL/SQL block whose DBMS_OUTPUT lines are
//
//	mtkprof-ref 1                     first line
//	obj,<objects.csv columns>         OBJECT_ID, DATA_OBJECT_ID, OWNER, OBJECT_NAME, SUBOBJECT_NAME, OBJECT_TYPE
//	file,<datafiles.csv columns>      FILE#, NAME, TABLESPACE_NAME, FILE_TYPE, ABS_FILE#
//	user,<users.csv columns>          USER_ID, USERNAME
//	plan,"<sql_id>","<a DBMS_XPLAN line>"
//	note,"<what the script could not read>"
//	mtkprof-ref end                   last line
//
// The fields after the tag are CSV (text quoted, "" inside). Anything else in
// a paste (the client's echo, prompts, "PL/SQL procedure successfully
// completed.") is ignored.
const (
	PasteHeader = "mtkprof-ref 1"
	PasteEnd    = "mtkprof-ref end"
)

// Paste is what ParsePaste read.
type Paste struct {
	Bundle *Bundle
	// Notes are the script's note lines: a view the user could not read (and
	// the fallback it used), a plan not found.
	Notes []string
	// Header and End: the paste has the first and the last line of the
	// script's output (no End: it was cut off, or the script failed).
	Header, End bool
	// Tables: no tagged line; the paste was read as CSV / TSV tables with
	// header rows (an objects.csv, a grid copied with its headers).
	Tables bool
}

// NewBundle is an empty bundle.
func NewBundle() *Bundle {
	return &Bundle{Objects: map[int64]ObjectRef{}, Files: map[int64]FileRef{}, Users: map[int64]string{}, Plans: map[string]string{}, byData: map[int64]int64{}}
}

func (b *Bundle) addObject(o ObjectRef) {
	b.Objects[o.ID] = o
	if o.DataID > 0 && o.DataID != o.ID {
		b.byData[o.DataID] = o.ID
	}
}

// Merge adds o's entries to b; an entry of o replaces b's with the same key.
func (b *Bundle) Merge(o *Bundle) {
	if o == nil {
		return
	}
	for _, x := range o.Objects {
		b.addObject(x)
	}
	for k, v := range o.Files {
		b.Files[k] = v
	}
	for k, v := range o.Users {
		b.Users[k] = v
	}
	for k, v := range o.Plans {
		b.Plans[k] = v
	}
}

// ParsePaste reads the output of the names script (see PasteHeader). A paste
// without any tagged line is read as tables instead: CSV or tab-separated
// blocks, each under a header row that names its columns as the bundle's
// files do (OBJECT_ID ... for objects, ABS_FILE# or FILE# with NAME for
// datafiles, USER_ID with USERNAME for users).
func ParsePaste(text string) Paste {
	text = strings.TrimPrefix(text, "\ufeff")
	text = strings.ReplaceAll(text, "\r\n", "\n")
	p := Paste{Bundle: NewBundle()}
	plans := map[string][]string{}
	var planOrder []string
	tagged := false
	for _, raw := range strings.Split(text, "\n") {
		line := strings.TrimSpace(raw)
		switch {
		case line == PasteHeader:
			p.Header = true
			continue
		case line == PasteEnd:
			p.End = true
			continue
		}
		tag, rest, ok := strings.Cut(line, ",")
		if !ok {
			continue
		}
		switch tag {
		case "obj", "file", "user", "plan", "note":
		default:
			continue
		}
		f, err := csvFields(rest)
		if err != nil {
			continue
		}
		switch tag {
		case "obj": // OBJECT_ID, DATA_OBJECT_ID, OWNER, OBJECT_NAME, SUBOBJECT_NAME, OBJECT_TYPE
			if len(f) < 6 {
				continue
			}
			id, ok := num(f[0])
			if !ok {
				continue
			}
			o := ObjectRef{ID: id, Owner: f[2], Name: f[3], Sub: f[4], Type: f[5]}
			o.DataID, _ = num(f[1])
			p.Bundle.addObject(o)
		case "file": // FILE#, NAME, TABLESPACE_NAME, FILE_TYPE, ABS_FILE#
			if len(f) < 5 {
				continue
			}
			id, ok := num(f[4])
			if !ok {
				if id, ok = num(f[0]); !ok {
					continue
				}
			}
			p.Bundle.Files[id] = FileRef{File: id, Name: f[1], Tablespace: f[2], Type: f[3]}
		case "user": // USER_ID, USERNAME
			if len(f) < 2 || f[1] == "" {
				continue
			}
			id, ok := num(f[0])
			if !ok {
				continue
			}
			p.Bundle.Users[id] = f[1]
		case "plan": // sql_id, one line of DBMS_XPLAN output
			if len(f) < 2 || !validPlanID(f[0]) {
				continue
			}
			if _, seen := plans[f[0]]; !seen {
				planOrder = append(planOrder, f[0])
			}
			plans[f[0]] = append(plans[f[0]], strings.TrimRight(f[1], " \t"))
		case "note":
			if len(f) > 0 && f[0] != "" {
				p.Notes = append(p.Notes, f[0])
			}
		}
		tagged = true
	}
	// what loadPlans keeps: a plan, not a message ("cannot be found", "User has
	// no SELECT privilege on V$SQL"); the messages become one note each
	noPlan := map[string]int{}
	var msgs []string
	for _, id := range planOrder {
		txt := strings.Trim(strings.Join(plans[id], "\n"), "\n")
		if strings.Contains(txt, "Plan hash value") {
			p.Bundle.Plans[id] = txt
			continue
		}
		msg, _, _ := strings.Cut(strings.TrimSpace(txt), "\n")
		if noPlan[msg] == 0 {
			msgs = append(msgs, msg)
		}
		noPlan[msg]++
	}
	for _, msg := range msgs {
		if n := noPlan[msg]; n == 1 {
			p.Notes = append(p.Notes, "1 plan not read: "+msg)
		} else {
			p.Notes = append(p.Notes, fmt.Sprintf("%d plans not read: %s", n, msg))
		}
	}
	if !tagged {
		p.Tables = true
		p.Bundle.readTables(text)
	}
	return p
}

// csvFields splits one CSV record (quoted fields may hold commas and "").
func csvFields(s string) ([]string, error) {
	r := csv.NewReader(strings.NewReader(s))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	f, err := r.Read()
	if err != nil {
		return nil, err
	}
	for i := range f {
		f[i] = strings.TrimSpace(f[i])
	}
	return f, nil
}

// validPlanID: plan file names come from the paste; only Oracle's sql_id
// characters (base-32 digits), at most 13.
func validPlanID(s string) bool {
	if s == "" || len(s) > 13 {
		return false
	}
	for _, r := range s {
		if !(r >= '0' && r <= '9' || r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z') {
			return false
		}
	}
	return true
}

// readTables reads header-led CSV / TSV blocks (ParsePaste without tags). A
// header is a row naming a known key column; the rows under it, up to the
// next header, fill that part of the bundle.
func (b *Bundle) readTables(text string) {
	var h map[string]int
	var kind string
	var comma rune
	for _, line := range strings.Split(text, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		c := ','
		if strings.Contains(line, "\t") {
			c = '\t'
		} else if !strings.Contains(line, ",") && strings.Contains(line, ";") {
			c = ';'
		}
		r := csv.NewReader(strings.NewReader(line))
		r.Comma, r.FieldsPerRecord, r.LazyQuotes = c, -1, true
		f, err := r.Read()
		if err != nil || len(f) < 2 {
			continue
		}
		if hh, k := tableHeader(f); k != "" {
			h, kind, comma = hh, k, c
			continue
		}
		if kind == "" || c != comma {
			continue
		}
		switch kind {
		case "objects":
			if id, ok := num(cell(f, h, "OBJECT_ID", "OBJ#")); ok {
				o := ObjectRef{ID: id, Owner: cell(f, h, "OWNER"), Name: cell(f, h, "OBJECT_NAME", "NAME"), Sub: cell(f, h, "SUBOBJECT_NAME"), Type: cell(f, h, "OBJECT_TYPE", "TYPE")}
				o.DataID, _ = num(cell(f, h, "DATA_OBJECT_ID"))
				b.addObject(o)
			}
		case "files":
			if id, ok := num(cell(f, h, "ABS_FILE#", "FILE#", "FILE_ID")); ok {
				b.Files[id] = FileRef{File: id, Name: cell(f, h, "NAME", "FILE_NAME"), Tablespace: cell(f, h, "TABLESPACE_NAME", "TABLESPACE"), Type: cell(f, h, "FILE_TYPE")}
			}
		case "users":
			if id, ok := num(cell(f, h, "USER_ID", "UID")); ok {
				if name := cell(f, h, "USERNAME"); name != "" {
					b.Users[id] = name
				}
			}
		}
	}
}

// tableHeader recognises a header row: its columns by upper-case name and
// the part of the bundle its rows fill ("" = not a header).
func tableHeader(f []string) (map[string]int, string) {
	h := make(map[string]int, len(f))
	for i, c := range f {
		h[strings.ToUpper(strings.Trim(strings.TrimSpace(c), `"`))] = i
	}
	has := func(names ...string) bool {
		for _, n := range names {
			if _, ok := h[n]; ok {
				return true
			}
		}
		return false
	}
	switch {
	case has("OBJECT_ID") && has("OBJECT_NAME", "NAME"):
		return h, "objects"
	case has("ABS_FILE#", "FILE#", "FILE_ID") && has("NAME", "FILE_NAME"):
		return h, "files"
	case has("USER_ID") && has("USERNAME"):
		return h, "users"
	}
	return nil, ""
}

// loadPasteFile reads a file of pasted names (ParsePaste) as a bundle.
func loadPasteFile(path string) (*Bundle, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("reference bundle: %w", err)
	}
	return ParsePaste(string(raw)).Bundle, nil
}

// WriteBundle writes b into dir (created) in the layout LoadBundle reads:
// objects.csv, datafiles.csv and users.csv as SQL*Plus writes them with
// "markup csv on quote on", plans/<sql_id>.txt. A part b has nothing of is
// not written.
func WriteBundle(b *Bundle, dir string) error {
	if err := os.MkdirAll(filepath.Join(dir, "plans"), 0o700); err != nil {
		return err
	}
	q := func(s string) string { return `"` + strings.ReplaceAll(s, `"`, `""`) + `"` }
	n := func(v int64) string { return strconv.FormatInt(v, 10) }
	write := func(name, header string, rows []string) error {
		if len(rows) == 0 {
			return nil
		}
		var buf bytes.Buffer
		buf.WriteString(header + "\n")
		for _, r := range rows {
			buf.WriteString(r + "\n")
		}
		return os.WriteFile(filepath.Join(dir, name), buf.Bytes(), 0o600)
	}
	var rows []string
	for _, id := range sortedIDs(b.Objects) {
		o := b.Objects[id]
		data := ""
		if o.DataID > 0 {
			data = n(o.DataID)
		}
		rows = append(rows, strings.Join([]string{n(o.ID), data, q(o.Owner), q(o.Name), q(o.Sub), q(o.Type)}, ","))
	}
	if err := write("objects.csv", `"OBJECT_ID","DATA_OBJECT_ID","OWNER","OBJECT_NAME","SUBOBJECT_NAME","OBJECT_TYPE"`, rows); err != nil {
		return err
	}
	rows = rows[:0]
	for _, id := range sortedIDs(b.Files) {
		f := b.Files[id]
		rows = append(rows, strings.Join([]string{n(f.File), q(f.Name), q(f.Tablespace), q(f.Type), n(f.File)}, ","))
	}
	if err := write("datafiles.csv", `"FILE#","NAME","TABLESPACE_NAME","FILE_TYPE","ABS_FILE#"`, rows); err != nil {
		return err
	}
	rows = rows[:0]
	for _, id := range sortedIDs(b.Users) {
		rows = append(rows, n(id)+","+q(b.Users[id]))
	}
	if err := write("users.csv", `"USER_ID","USERNAME"`, rows); err != nil {
		return err
	}
	for id, txt := range b.Plans {
		if !validPlanID(id) {
			continue
		}
		if err := os.WriteFile(filepath.Join(dir, "plans", id+".txt"), []byte(txt+"\n"), 0o600); err != nil {
			return err
		}
	}
	return nil
}

func sortedIDs[V any](m map[int64]V) []int64 {
	out := make([]int64, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}
