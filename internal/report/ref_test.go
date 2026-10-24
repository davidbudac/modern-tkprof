package report

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
)

const ioWaits = "../../testdata/traces/19c/io_waits.trc"

func refModel(t *testing.T, bundle string) *model.Model {
	t.Helper()
	m, err := model.Build(ioWaits, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	b, err := ref.LoadBundle(bundle)
	if err != nil {
		t.Fatal(err)
	}
	model.ApplyRef(m, b)
	return m
}

func TestApplyRefTextReport(t *testing.T) {
	m := refModel(t, "../../testdata/reference/bundle")
	var b bytes.Buffer
	if err := Text(&b, m, TextOptions{Sort: "elapsed", Binds: 5, Execs: 20, Sys: true, Width: 120}); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	for _, want := range []string{
		"uid 165 (MTK)",
		"DBMS_XPLAN from ref bundle (plans/52nzchs09dgn1.txt)",
		"  Plan hash value: 2503715236",
	} {
		if !strings.Contains(out, want) {
			t.Errorf("text report lacks %q", want)
		}
	}
	// wait detail by object: the name follows the obj#
	if !regexp.MustCompile(`(?m)^\s+obj# 108611\s+MTK\.MTK_ORDERS\s+2\.379 s\s+1,331 waits`).MatchString(out) {
		t.Error("wait detail by object lacks the name of obj# 108611")
	}
	// the DBMS_XPLAN text comes after the STAT plan table of its statement
	if i, j := strings.Index(out, "Execution plan (plan hash 2503715236"), strings.Index(out, "DBMS_XPLAN from ref bundle"); i < 0 || j < i {
		t.Errorf("DBMS_XPLAN text must follow the plan table (%d, %d)", i, j)
	}
	// without a bundle the report is what it was
	plain := renderText(t, ioWaits, TextOptions{Sort: "elapsed", Binds: 5, Execs: 20, Sys: true, Width: 120})
	if strings.Contains(plain, "MTK.MTK_ORDERS") || strings.Contains(plain, "DBMS_XPLAN") || strings.Contains(plain, "(MTK)") {
		t.Error("report without -ref mentions names")
	}
}

func TestApplyRefDocument(t *testing.T) {
	m := refModel(t, "../../testdata/reference/bundle")
	var buf bytes.Buffer
	if err := JSON(&buf, m, DocOptions{}); err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Objects []struct {
			ID        int64
			Owner     string
			Name      string
			Subobject string
			Type      string
		}
		Files []struct {
			File       int64
			Name       string
			Tablespace string
		}
		Users []struct {
			ID   int64
			Name string
		}
		Statements []struct {
			SQLID   string
			RefPlan string
		}
		PlanLines []struct {
			Obj    int64
			Object string
		}
		Diag struct{ Notes []string }
	}
	if err := json.Unmarshal(buf.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	byID := map[int64]string{}
	for _, o := range doc.Objects {
		byID[o.ID] = o.Owner + "." + o.Name + "/" + o.Type
	}
	if byID[108611] != "MTK.MTK_ORDERS/TABLE" || byID[108609] != "MTK.MTK_CUST/TABLE" {
		t.Errorf("objects table = %v", byID)
	}
	if _, ok := byID[720]; ok {
		t.Error("obj# not in the bundle must not appear")
	}
	if len(doc.Objects) > len(byID) {
		t.Error("duplicate object rows")
	}
	files := map[int64]string{}
	for _, f := range doc.Files {
		files[f.File] = f.Tablespace
	}
	if files[12] != "USERS" || files[203] != "TEMP" {
		t.Errorf("files table = %v", files)
	}
	if len(doc.Users) != 2 || doc.Users[0].Name != "SYS" || doc.Users[1].ID != 165 || doc.Users[1].Name != "MTK" {
		t.Errorf("users table = %+v", doc.Users)
	}
	planned := 0
	for _, s := range doc.Statements {
		if s.RefPlan != "" {
			planned++
			if s.SQLID != "52nzchs09dgn1" || !strings.Contains(s.RefPlan, "Plan hash value: 2503715236") {
				t.Errorf("refPlan on %s", s.SQLID)
			}
		}
	}
	if planned != 1 {
		t.Errorf("%d statements carry refPlan, want 1", planned)
	}
	named := 0
	for _, l := range doc.PlanLines {
		if l.Obj == 108611 && l.Object != "" {
			named++
		}
	}
	if named == 0 {
		t.Error("plan lines on obj 108611 have no object name")
	}
	if len(doc.Diag.Notes) == 0 || !strings.Contains(doc.Diag.Notes[len(doc.Diag.Notes)-1], "ref bundle: ") {
		t.Errorf("notes = %v", doc.Diag.Notes)
	}

	// without a bundle the new tables are absent
	plain, err := model.Build(ioWaits, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	pj, _ := DocumentBytes(plain, DocOptions{})
	var top map[string]json.RawMessage
	if err := json.Unmarshal(pj, &top); err != nil {
		t.Fatal(err)
	}
	// "files" also names the trace-set entries under "file", so check top-level keys.
	for _, k := range []string{"objects", "files", "users"} {
		if _, ok := top[k]; ok {
			t.Errorf("document without -ref has top-level %q", k)
		}
	}
	if bytes.Contains(pj, []byte(`"refPlan"`)) {
		t.Errorf("document without -ref has refPlan")
	}
}

// ApplyRef only adds names: the model's measures are untouched.
func TestApplyRefChangesNoMeasure(t *testing.T) {
	plain, err := model.Build(ioWaits, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	m := refModel(t, "../../testdata/reference/bundle")
	a, _ := json.Marshal(plain.Waits)
	b, _ := json.Marshal(m.Waits)
	if !bytes.Equal(a, b) {
		t.Error("waits differ")
	}
	a, _ = json.Marshal(plain.Calls)
	b, _ = json.Marshal(m.Calls)
	if !bytes.Equal(a, b) {
		t.Error("calls differ")
	}
}

func TestApplyRefExport(t *testing.T) {
	m := refModel(t, "../../testdata/reference/bundle")
	dir := t.TempDir()
	if _, err := ExportCSV(m, dir); err != nil {
		t.Fatal(err)
	}
	read := func(name string) ([]string, [][]string) {
		f, err := os.Open(filepath.Join(dir, name))
		if err != nil {
			t.Fatal(err)
		}
		defer f.Close()
		rows, err := csv.NewReader(f).ReadAll()
		if err != nil {
			t.Fatal(err)
		}
		return rows[0], rows[1:]
	}
	col := func(h []string, name string) int {
		for i, c := range h {
			if c == name {
				return i
			}
		}
		t.Fatalf("no column %s in %v", name, h)
		return -1
	}
	h, rows := read("waits.csv")
	obj, name, file, fname := col(h, "obj"), col(h, "object_name"), col(h, "p1"), col(h, "file_name")
	nObj, nFile := 0, 0
	for _, r := range rows {
		if r[obj] == "108611" {
			nObj++
			if r[name] != "MTK.MTK_ORDERS" {
				t.Fatalf("object_name = %q for obj 108611", r[name])
			}
		}
		if r[col(h, "event")] == "direct path read temp" && r[file] == "203" {
			nFile++
			if !strings.HasSuffix(r[fname], "temp01.dbf") {
				t.Fatalf("file_name = %q", r[fname])
			}
		}
	}
	if nObj == 0 {
		t.Error("no wait on obj 108611")
	}
	h, rows = read("plan_lines.csv")
	owner, oname, pobj := col(h, "owner"), col(h, "object_name"), col(h, "obj")
	for _, r := range rows {
		if r[pobj] == "108611" && (r[owner] != "MTK" || r[oname] == "") {
			t.Fatalf("plan line row %v", r)
		}
	}
	if nFile == 0 {
		t.Error("no tempfile wait resolved to a file_name")
	}
}

// io_waits.trc + the bundle: the sort-spill statement's STAT plan has the
// plan hash of plans/52nzchs09dgn1.txt, so query block / alias are overlaid
// and show in the plan JSON (the visualizer contract) and the CSV. The lab
// plan has no Predicate Information block (no access/filter on that plan);
// predicates are covered by the hand-written text in the model tests.
func TestApplyRefXPlanOverlay(t *testing.T) {
	m := refModel(t, "../../testdata/reference/bundle")
	var plan *model.Plan
	for i := range m.Plans {
		if m.Plans[i].PLH == 2503715236 {
			plan = &m.Plans[i]
		}
	}
	if plan == nil || !plan.XPlanMatched {
		t.Fatalf("plan 2503715236 not matched: %+v", plan)
	}
	rows := PlanRows(m, plan)
	if len(rows) != 2 || rows[0].QBlockName != "SEL$1" || rows[1].ObjectAlias != "O@SEL$1" || rows[1].QBlockName != "SEL$1" {
		t.Errorf("plan rows = %+v", rows)
	}
	js, err := PlanJSON(m, plan)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(js, []byte(`"object_alias": "O@SEL$1"`)) || bytes.Contains(js, []byte(`"access_predicates"`)) {
		t.Errorf("plan json = %s", js)
	}
	// other plans (other hashes, no plan file) are untouched
	for i := range m.Plans {
		if m.Plans[i].PLH != 2503715236 && m.Plans[i].XPlanMatched {
			t.Errorf("plan %d matched without a plan file", i)
		}
	}
	dir := t.TempDir()
	if _, err := ExportCSV(m, dir); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, "plan_lines.csv"))
	if err != nil {
		t.Fatal(err)
	}
	if hdr := strings.SplitN(string(raw), "\n", 2)[0]; !strings.HasSuffix(hdr, "access_predicates,filter_predicates,e_rows") {
		t.Errorf("plan_lines.csv header = %s", hdr)
	}
}

// Predicates print as a sub-block under the plan table when present.
func TestTextReportPredicates(t *testing.T) {
	m := refModel(t, "../../testdata/reference/bundle")
	for i := range m.PlanLines {
		if m.Plans[m.PlanLines[i].Plan].PLH == 2503715236 && m.PlanLines[i].ID == 2 {
			m.PlanLines[i].Filter = `"O"."ID">5`
		}
	}
	var b bytes.Buffer
	if err := Text(&b, m, TextOptions{Sort: "elapsed", Binds: 5, Execs: 20, Sys: true, Width: 120}); err != nil {
		t.Fatal(err)
	}
	out := b.String()
	i, j := strings.Index(out, "Predicates (from ref bundle DBMS_XPLAN):\n     2: filter(\"O\".\"ID\">5)"), strings.Index(out, "DBMS_XPLAN from ref bundle")
	if i < 0 || j < i {
		t.Errorf("predicates block missing or misplaced (%d, %d)", i, j)
	}
}
