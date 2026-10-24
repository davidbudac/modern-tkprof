package model

import (
	"fmt"
	"sort"

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

// IsFileP1 reports whether the event's first parameter is a file number
// (db file sequential read: file#, direct path read: file number).
func (e *Event) IsFileP1() bool { return e.P1Name == "file#" || e.P1Name == "file number" }

// WaitFile returns the file number a wait reports in p1, if its event does.
func (m *Model) WaitFile(w *Wait) (int64, bool) {
	if w.Event < 0 || int(w.Event) >= len(m.Events) || !m.Events[w.Event].IsFileP1() {
		return 0, false
	}
	return w.P1, true
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
// empty, and attaches DBMS_XPLAN text as Statement.RefPlan. A nil or empty
// bundle does nothing.
func ApplyRef(m *Model, b *ref.Bundle) {
	if b.Empty() {
		return
	}
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
	for i := range m.Waits {
		w := &m.Waits[i]
		addObj(w.ObjID)
		if f, ok := m.WaitFile(w); ok && !seenFile[f] {
			seenFile[f] = true
			if fr, ok := b.Files[f]; ok {
				m.Files = append(m.Files, RefFile{File: f, Name: fr.Name, Tablespace: fr.Tablespace, Type: fr.Type})
				foundFile++
			}
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
	for i := range m.Statements {
		st := &m.Statements[i]
		if st.Kind == StmtSQL && st.SQLID != "" {
			if p, ok := b.Plans[st.SQLID]; ok {
				st.RefPlan = p
				plans++
			}
		}
	}
	m.Diag.Notes = append(m.Diag.Notes, fmt.Sprintf("reference bundle applied: %d of %d obj#, %d of %d file#, %d of %d user ids named; %d DBMS_XPLAN plans attached",
		foundObj, len(seenObj), foundFile, len(seenFile), foundUser, len(seenUser), plans))
}
