package db

import (
	"bytes"
	"encoding/csv"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/ref"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

const bundleDir = "../../../testdata/reference/bundle"

// csvTable reads a fixture CSV as the database would return it: bare
// numbers as int64, quoted cells as strings, empty cells as NULL.
func csvTable(t *testing.T, name string) (header []string, rows [][]any) {
	raw, err := os.ReadFile(filepath.Join(bundleDir, name))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		r := csv.NewReader(strings.NewReader(line))
		rec, err := r.Read()
		if err != nil {
			t.Fatal(err)
		}
		if header == nil {
			header = rec
			continue
		}
		row := make([]any, len(rec))
		// the raw text decides: quoted string or bare number
		cells := splitRaw(line)
		for i, c := range rec {
			switch {
			case cells[i] == "":
				row[i] = nil
			case strings.HasPrefix(cells[i], `"`):
				row[i] = c
			default:
				n, err := strconv.ParseInt(c, 10, 64)
				if err != nil {
					t.Fatalf("%s: %q", name, c)
				}
				row[i] = n
			}
		}
		rows = append(rows, row)
	}
	return header, rows
}

// splitRaw splits a CSV line at commas outside quotes, keeping the quotes.
func splitRaw(line string) []string {
	var out []string
	var cur strings.Builder
	in := false
	for _, r := range line {
		switch {
		case r == '"':
			in = !in
			cur.WriteRune(r)
		case r == ',' && !in:
			out = append(out, cur.String())
			cur.Reset()
		default:
			cur.WriteRune(r)
		}
	}
	return append(out, cur.String())
}

var inList = regexp.MustCompile(`(\w+#?) in \(([^)]*)\)`)

// filterIn keeps the rows whose key column is in one of the query's
// IN-lists on that column (or on alt).
func filterIn(t *testing.T, q string, header []string, rows [][]any, cols ...string) [][]any {
	keep := map[string]map[int64]bool{}
	for _, m := range inList.FindAllStringSubmatch(q, -1) {
		set := keep[strings.ToUpper(m[1])]
		if set == nil {
			set = map[int64]bool{}
			keep[strings.ToUpper(m[1])] = set
		}
		for _, f := range strings.FieldsFunc(m[2], func(r rune) bool { return r == ',' || r == ' ' || r == '\n' }) {
			n, _ := strconv.ParseInt(f, 10, 64)
			set[n] = true
		}
	}
	var out [][]any
	for _, r := range rows {
		for _, c := range cols {
			i := indexOf(header, c)
			if v, ok := r[i].(int64); ok && keep[c][v] {
				out = append(out, r)
				break
			}
		}
	}
	return out
}

func indexOf(h []string, c string) int {
	for i, x := range h {
		if x == c {
			return i
		}
	}
	panic(c)
}

// refDB fakes the reference views from testdata/reference/bundle.
func refDB(t *testing.T) *fakeConn {
	oh, objs := csvTable(t, "objects.csv")
	fh, files := csvTable(t, "datafiles.csv")
	uh, users := csvTable(t, "users.csv")
	plan, err := os.ReadFile(filepath.Join(bundleDir, "plans", "52nzchs09dgn1.txt"))
	if err != nil {
		t.Fatal(err)
	}
	return &fakeConn{query: func(q string, _ []any) ([][]any, error) {
		switch {
		case strings.Contains(q, " from dba_objects"):
			return filterIn(t, q, oh, objs, "OBJECT_ID", "DATA_OBJECT_ID"), nil
		case strings.Contains(q, " from v$datafile"):
			return filterIn(t, q, fh, files, "ABS_FILE#"), nil
		case strings.Contains(q, " from dba_users"):
			return filterIn(t, q, uh, users, "USER_ID"), nil
		case strings.Contains(q, "display_cursor('52nzchs09dgn1'"):
			var rows [][]any
			for _, l := range strings.Split(strings.TrimSuffix(string(plan), "\n"), "\n") {
				var v any = l + "   " // DBMS_XPLAN pads; trimspool trims
				if l == "" {
					v = nil
				}
				rows = append(rows, []any{v})
			}
			return rows, nil
		case strings.Contains(q, "display_cursor("):
			return [][]any{{"SQL_ID: x, child number: 0 cannot be found"}, {"ignored"}}, nil
		case strings.Contains(q, "display_awr("):
			return nil, nil
		}
		t.Errorf("unexpected query %q", q)
		return nil, errors.New("unexpected")
	}}
}

func buildIOWaits(t *testing.T) *model.Model {
	m, err := model.Build("../../../testdata/traces/19c/io_waits.trc", model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

func docOf(t *testing.T, m *model.Model, dir string) []byte {
	b, err := ref.LoadBundle(dir)
	if err != nil {
		t.Fatal(err)
	}
	model.ApplyRef(m, b)
	doc, err := report.DocumentBytes(m, report.DocOptions{Facts: true})
	if err != nil {
		t.Fatal(err)
	}
	// the build time is the only field that may differ
	return generated.ReplaceAll(doc, []byte(`"generated":""`))
}

var generated = regexp.MustCompile(`"generated":"[^"]*"`)

// The bundle FetchRef writes from the database gives the same model as the
// bundle the refscript spooled.
func TestFetchRefRoundTrip(t *testing.T) {
	m := buildIOWaits(t)
	fc := refDB(t)
	dir := t.TempDir()
	var prog [][2]int
	if err := NewClient(fc).FetchRef(ctx, m, dir, false, func(d, n int) { prog = append(prog, [2]int{d, n}) }); err != nil {
		t.Fatal(err)
	}
	qs := report.RefQueries(m, false)
	var sent []string
	for _, q := range qs {
		sent = append(sent, q.SQL)
		if q.Name == "plan" && q.SQLID != "52nzchs09dgn1" {
			sent = append(sent, q.Fallback)
		}
	}
	if !reflect.DeepEqual(fc.queries(), sent) {
		t.Errorf("queries sent differ from report.RefQueries:\n%q", fc.queries())
	}
	if len(prog) != len(qs) || prog[len(prog)-1] != [2]int{len(qs), len(qs)} {
		t.Errorf("progress %v", prog)
	}
	got, err := os.ReadFile(filepath.Join(dir, "plans", "52nzchs09dgn1.txt"))
	if wantPlan, _ := os.ReadFile(filepath.Join(bundleDir, "plans", "52nzchs09dgn1.txt")); err != nil || !bytes.Equal(got, wantPlan) {
		t.Errorf("plan file differs:\n%s", got)
	}
	users, _ := os.ReadFile(filepath.Join(dir, "users.csv"))
	if string(users) != "\"USER_ID\",\"USERNAME\"\n0,\"SYS\"\n165,\"MTK\"\n" {
		t.Errorf("users.csv %q", users)
	}
	objs, _ := os.ReadFile(filepath.Join(dir, "objects.csv"))
	if !strings.HasPrefix(string(objs), "\"OBJECT_ID\",\"DATA_OBJECT_ID\",\"OWNER\",\"OBJECT_NAME\",\"SUBOBJECT_NAME\",\"OBJECT_TYPE\"\n") ||
		!strings.Contains(string(objs), "\n108611,108611,\"MTK\",\"MTK_ORDERS\",,\"TABLE\"\n") {
		t.Errorf("objects.csv\n%s", objs)
	}
	for _, q := range qs {
		if q.Name == "plan" && q.SQLID != "52nzchs09dgn1" {
			b, _ := os.ReadFile(filepath.Join(dir, "plans", q.SQLID+".txt"))
			if string(b) != "-- no plan found for "+q.SQLID+"\n" {
				t.Errorf("%s: %q", q.SQLID, b)
			}
		}
	}

	if a, b := docOf(t, buildIOWaits(t), bundleDir), docOf(t, buildIOWaits(t), dir); !bytes.Equal(a, b) {
		t.Error("ApplyRef of the fetched bundle differs from the fixture bundle")
	}
	if a, b := docOf(t, buildIOWaits(t), dir), docOf(t, buildIOWaits(t), t.TempDir()); bytes.Equal(a, b) {
		t.Error("the bundle changes nothing (test is vacuous)")
	}
}

func TestFetchRefPartial(t *testing.T) {
	m := buildIOWaits(t)
	fc := refDB(t)
	inner := fc.query
	fc.query = func(q string, args []any) ([][]any, error) {
		if strings.Contains(q, "v$datafile") {
			return nil, errors.New("ORA-00942: table or view does not exist")
		}
		if strings.Contains(q, "display_cursor('52nzchs09dgn1'") {
			return nil, errors.New("ORA-01031: insufficient privileges\nmore")
		}
		return inner(q, args)
	}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "datafiles.csv"), []byte("stale"), 0o644)
	err := NewClient(fc).FetchRef(ctx, m, dir, false, nil)
	var pe *PartialError
	if !errors.As(err, &pe) || len(pe.Failed) != 1 || pe.Failed[0].Target != "datafiles.csv" {
		t.Fatalf("err %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "datafiles.csv")); !os.IsNotExist(err) {
		t.Error("stale datafiles.csv kept")
	}
	plan, _ := os.ReadFile(filepath.Join(dir, "plans", "52nzchs09dgn1.txt"))
	if string(plan) != "-- no plan for 52nzchs09dgn1: ORA-01031: insufficient privileges\n" {
		t.Errorf("plan %q", plan)
	}
	b, err := ref.LoadBundle(dir)
	if err != nil || len(b.Objects) == 0 || len(b.Users) != 2 || len(b.Files) != 0 || len(b.Plans) != 0 {
		t.Errorf("bundle %v %v", b.Summary(), err)
	}
}

func TestFetchRefLite(t *testing.T) {
	m := buildIOWaits(t)
	fc := &fakeConn{query: func(q string, _ []any) ([][]any, error) {
		if strings.Contains(strings.ToLower(q), "dba_") || strings.Contains(q, "v$datafile") {
			t.Errorf("lite ran %q", q)
		}
		return nil, nil
	}}
	if err := NewClient(fc).FetchRef(ctx, m, t.TempDir(), true, nil); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(fc.calls[0].SQL, "from all_objects") {
		t.Errorf("first query %q", fc.calls[0].SQL)
	}
}
