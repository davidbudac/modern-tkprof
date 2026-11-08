package model

import (
	"fmt"
	"slices"
	"sort"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/ref"
)

// RefObject is one resolved obj# (the object dimension of a reference bundle).
// ID is the obj# as it appears in the trace.
type RefObject struct {
	ID        int64  `json:"id"`
	Owner     string `json:"owner"`
	Name      string `json:"name"`
	Subobject string `json:"subobject,omitempty"`
	Type      string `json:"type,omitempty"`
}

// Qualified is owner.name[.subobject].
func (o *RefObject) Qualified() string {
	s := o.Name
	if o.Owner != "" {
		s = o.Owner + "." + s
	}
	if o.Subobject != "" {
		s += "." + o.Subobject
	}
	return s
}

// RefFile is one resolved file number from the p1 of a file I/O wait.
type RefFile struct {
	File       int64  `json:"file"`
	Name       string `json:"name"`
	Tablespace string `json:"tablespace,omitempty"`
	Type       string `json:"type,omitempty"`
}

// RefUser is one resolved parsing user id.
type RefUser struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// IsFileP1 reports whether the event's first parameter is a datafile or
// tempfile number (db file sequential read: file#, direct path read: file
// number). Not the control file events: control file sequential read and
// control file single write name their p1 file# too, but it is the number of
// a control file copy (0, 1 …), which would share a "file N" with a datafile
// (the Blocks view's panels, file names of a reference bundle). The twin is
// isFileP1 in web/src/lib/data/iomap.ts.
func (e *Event) IsFileP1() bool {
	return (e.P1Name == "file#" || e.P1Name == "file number") && !strings.HasPrefix(e.Name, "control file ")
}

// IsBlockIO reports whether the event's parameters are a file number and a
// block address (the waits of the Blocks view, analyze.IOMapOn): db file
// sequential/scattered read, db file single write, direct path read|write[
// temp], read by other session, buffer busy waits, gc cr/current request …;
// not db file parallel read (no address), Disk file operations I/O (no block),
// gc cr/current block 2-way (no parameter names) or the control file events
// (IsFileP1: p1 is a control file's number). Data-driven on the
// parameter names (V$EVENT_NAME, else those of the WAIT lines), so unknown
// and RAC events classify themselves.
func (e *Event) IsBlockIO() bool {
	return e.IsFileP1() && (e.P2Name == "block#" || e.P2Name == "first dba")
}

// BlocksParam reports whether p3 is a block count (else a wait moves one block).
func (e *Event) BlocksParam() bool { return e.P3Name == "blocks" || e.P3Name == "block cnt" }

// WaitFile returns the file number a wait reports in p1, if its event does.
func (m *Model) WaitFile(w *Wait) (int64, bool) {
	if w.Event < 0 || int(w.Event) >= len(m.Events) || !m.Events[w.Event].IsFileP1() {
		return 0, false
	}
	return w.P1, true
}

// RefIDSource is implemented by the sink of an aggregation-only build
// (analyze.Accumulator): such a model keeps no waits, so the obj# and file
// numbers they named come from it.
type RefIDSource interface {
	RefIDs() (objs, files []int64)
}

// WaitRefIDs returns the obj# (> 0) and file numbers (WaitFile) the waits of
// the model named, ascending: from its waits, or from the sink of an
// aggregation-only build. What a reference bundle can name besides the plan
// lines' objects and the users.
func (m *Model) WaitRefIDs() (objs, files []int64) {
	if src, ok := m.Agg.(RefIDSource); ok && m.Aggregate {
		return src.RefIDs()
	}
	os, fs := map[int64]bool{}, map[int64]bool{}
	for i := range m.Waits {
		w := &m.Waits[i]
		if w.ObjID > 0 && !os[w.ObjID] {
			os[w.ObjID] = true
			objs = append(objs, w.ObjID)
		}
		if f, ok := m.WaitFile(w); ok && !fs[f] {
			fs[f] = true
			files = append(files, f)
		}
	}
	slices.Sort(objs)
	slices.Sort(files)
	return objs, files
}

// ObjectName is the qualified name of an obj# resolved by ApplyRef, or "".
func (m *Model) ObjectName(obj int64) string {
	if i, ok := m.objIdx[obj]; ok {
		return m.Objects[i].Qualified()
	}
	return ""
}

// ObjectOwner is the owner of an obj# resolved by ApplyRef, or "".
func (m *Model) ObjectOwner(obj int64) string {
	if i, ok := m.objIdx[obj]; ok {
		return m.Objects[i].Owner
	}
	return ""
}

// FileName is the datafile name of a file number resolved by ApplyRef, or "".
func (m *Model) FileName(file int64) string {
	if i, ok := m.fileIdx[file]; ok {
		return m.Files[i].Name
	}
	return ""
}

// UserName is the username of a user id resolved by ApplyRef, or "".
func (m *Model) UserName(uid int64) string {
	if i, ok := m.userIdx[uid]; ok {
		return m.Users[i].Name
	}
	return ""
}

// ApplyRef is a post-pass (like RedactBinds) that adds names from a
// reference bundle and changes no measure, so every output sees the same
// thing. It fills the Objects, Files and Users dimension tables with the
// bundle entries the trace references (obj# of waits and plan lines, file
// numbers in file I/O waits, parsing user ids), fills PlanLine.Object when
// empty, and attaches DBMS_XPLAN text as Statement.RefPlan. DBMS_XPLAN
// plans with the same plan hash as a STAT plan are overlaid line by line
// (see overlayXPlans). A nil or empty bundle does nothing. Applying a bundle
// to a model that has one already replaces it (the engine applies a new
// bundle to an open session), as if the first had never been applied.
func ApplyRef(m *Model, b *ref.Bundle) {
	if b.Empty() {
		return
	}
	m.resetRef()
	m.objIdx, m.fileIdx, m.userIdx = map[int64]int{}, map[int64]int{}, map[int64]int{}
	seenObj, foundObj := map[int64]bool{}, 0
	addObj := func(id int64) {
		if id <= 0 || seenObj[id] {
			return
		}
		seenObj[id] = true
		if o, ok := b.Object(id); ok {
			m.Objects = append(m.Objects, RefObject{ID: id, Owner: o.Owner, Name: o.Name, Subobject: o.Sub, Type: o.Type})
			foundObj++
		}
	}
	seenFile, foundFile := map[int64]bool{}, 0
	objs, files := m.WaitRefIDs() // an aggregation-only model has no waits: its sink kept their ids
	for _, id := range objs {
		addObj(id)
	}
	for _, f := range files {
		if seenFile[f] {
			continue
		}
		seenFile[f] = true
		if fr, ok := b.Files[f]; ok {
			m.Files = append(m.Files, RefFile{File: f, Name: fr.Name, Tablespace: fr.Tablespace, Type: fr.Type})
			foundFile++
		}
	}
	for i := range m.PlanLines {
		addObj(m.PlanLines[i].Obj)
	}
	seenUser, foundUser := map[int64]bool{}, 0
	for i := range m.Statements {
		for _, uid := range [...]int64{int64(m.Statements[i].UID), int64(m.Statements[i].LID)} {
			if seenUser[uid] || m.Statements[i].Kind != StmtSQL {
				continue
			}
			seenUser[uid] = true
			if name, ok := b.Users[uid]; ok {
				m.Users = append(m.Users, RefUser{ID: uid, Name: name})
				foundUser++
			}
		}
	}
	sort.Slice(m.Objects, func(i, j int) bool { return m.Objects[i].ID < m.Objects[j].ID })
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].File < m.Files[j].File })
	sort.Slice(m.Users, func(i, j int) bool { return m.Users[i].ID < m.Users[j].ID })
	for i, o := range m.Objects {
		m.objIdx[o.ID] = i
	}
	for i, f := range m.Files {
		m.fileIdx[f.File] = i
	}
	for i, u := range m.Users {
		m.userIdx[u.ID] = i
	}
	for i := range m.PlanLines {
		l := &m.PlanLines[i]
		if l.Object == "" && l.Obj > 0 {
			l.Object = m.ObjectName(l.Obj)
		}
	}
	plans := 0
	xp := overlayXPlans(m, b)
	for i := range m.Statements {
		st := &m.Statements[i]
		if st.Kind == StmtSQL && st.SQLID != "" {
			if p, ok := b.Plans[st.SQLID]; ok {
				st.RefPlan = p
				plans++
			}
		}
	}
	m.Diag.Notes = append(m.Diag.Notes, fmt.Sprintf("ref bundle: %d/%d obj#, %d/%d file#, %d/%d user ids named; %d DBMS_XPLAN plans; %d/%d STAT plans with predicates and estimates",
		foundObj, len(seenObj), foundFile, len(seenFile), foundUser, len(seenUser), plans, xp.matched, xp.considered))
}

// resetRef undoes a previous ApplyRef: the dimension tables, the names it
// filled into plan lines, the overlaid DBMS_XPLAN data and its notes.
func (m *Model) resetRef() {
	for i := range m.PlanLines {
		l := &m.PlanLines[i]
		if l.Object != "" && l.Obj > 0 && l.Object == m.ObjectName(l.Obj) {
			l.Object = ""
		}
		l.Access, l.Filter, l.Alias, l.QBlock, l.ERows = "", "", "", "", 0
	}
	for i := range m.Plans {
		m.Plans[i].XPlanMatched = false
	}
	for i := range m.Statements {
		m.Statements[i].RefPlan = ""
	}
	m.Objects, m.Files, m.Users = nil, nil, nil
	m.objIdx, m.fileIdx, m.userIdx = nil, nil, nil
	m.Diag.Notes = slices.DeleteFunc(m.Diag.Notes, func(n string) bool { return strings.HasPrefix(n, "ref bundle") })
}

type xplanStats struct{ matched, considered int }

// overlayXPlans copies predicates, query block / alias and the optimizer
// estimate from the DBMS_XPLAN of a statement onto the STAT plan lines of
// every plan with the same plan hash value, matching by operation id. A
// different hash means a different plan: nothing is overlaid and a note says
// so. STAT carries card for most lines; ERows is only set where it does not
// (card < 0).
func overlayXPlans(m *Model, b *ref.Bundle) xplanStats {
	var st xplanStats
	parsed := map[string][]*ref.XPlan{}
	noted := map[string]bool{}
	for i := range m.Plans {
		p := &m.Plans[i]
		if p.Statement < 0 || int(p.Statement) >= len(m.Statements) || p.PLH == 0 {
			continue
		}
		sqlID := m.Statements[p.Statement].SQLID
		text, ok := b.Plans[sqlID]
		if !ok || sqlID == "" {
			continue
		}
		xs, done := parsed[sqlID]
		if !done {
			xs = ref.ParseXPlans(text)
			parsed[sqlID] = xs
		}
		st.considered++
		var x *ref.XPlan
		for _, c := range xs {
			if c.HasHash && c.PlanHash == p.PLH {
				x = c
				break
			}
		}
		if x == nil {
			key := fmt.Sprintf("%s/%d", sqlID, p.PLH)
			if !noted[key] {
				noted[key] = true
				have := "no parsable plan table"
				if len(xs) > 0 {
					hs := make([]string, 0, len(xs))
					for _, c := range xs {
						hs = append(hs, fmt.Sprint(c.PlanHash))
					}
					have = "plan hash " + strings.Join(hs, ", ")
				}
				m.Diag.Notes = append(m.Diag.Notes, fmt.Sprintf("ref bundle plans/%s.txt: %s; trace plan hash %d differs; predicates not overlaid", sqlID, have, p.PLH))
			}
			continue
		}
		p.XPlanMatched = true
		st.matched++
		for j := p.First; j < p.First+p.N; j++ {
			l := &m.PlanLines[j]
			r := x.Row(l.ID)
			if r == nil {
				continue
			}
			l.Access, l.Filter, l.Alias, l.QBlock = r.Access, r.Filter, r.Alias, r.QBlock
			if l.Card < 0 && r.ERows > 0 {
				l.ERows = r.ERows
			}
		}
	}
	return st
}
