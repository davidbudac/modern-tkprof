package ref

import (
	"os"
	"path/filepath"
	"testing"
)

// The real SQL*Plus exports from the lab load as they are (quoted headers,
// empty data_object_id, tempfile offset in ABS_FILE#).
func TestLoadBundleRawExports(t *testing.T) {
	b, err := LoadBundle("../../testdata/reference")
	if err != nil {
		t.Fatal(err)
	}
	o, ok := b.Object(108611)
	if !ok || o.QualifiedName() != "MTK.MTK_ORDERS" || o.Type != "TABLE" {
		t.Errorf("object 108611 = %+v, %v", o, ok)
	}
	if o, ok := b.Object(108621); !ok || o.Name != "MTK_SEQ" || o.DataID != 0 {
		t.Errorf("sequence with empty data_object_id = %+v, %v", o, ok)
	}
	if f := b.Files[12]; f.Tablespace != "USERS" || f.Type != "DATAFILE" {
		t.Errorf("file 12 = %+v", f)
	}
	if f, ok := b.Files[203]; !ok || f.Type != "TEMPFILE" || f.Tablespace != "TEMP" {
		t.Errorf("tempfile must be keyed by its db_files-offset number 203: %+v, %v", f, ok)
	}
	if _, ok := b.Files[3]; ok {
		t.Error("tempfile must not be keyed by its own file#")
	}
	if len(b.Users) != 0 || len(b.Plans) != 0 {
		t.Errorf("no users or plans expected, got %d / %d", len(b.Users), len(b.Plans))
	}
}

func TestLoadBundleLayout(t *testing.T) {
	b, err := LoadBundle("../../testdata/reference/bundle")
	if err != nil {
		t.Fatal(err)
	}
	if b.Users[165] != "MTK" || b.Users[0] != "SYS" {
		t.Errorf("users = %v", b.Users)
	}
	if p := b.Plans["52nzchs09dgn1"]; len(p) < 100 || p[:6] != "SQL_ID" {
		t.Errorf("plan text = %q", p)
	}
}

func TestLoadBundleTolerance(t *testing.T) {
	dir := t.TempDir()
	write := func(name, s string) {
		t.Helper()
		p := filepath.Join(dir, name)
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(s), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// BOM, CRLF, lower-case unquoted headers, a data_object_id that differs, a blank line first
	write("objects.csv", "\xef\xbb\xbf\r\nobject_id,data_object_id,owner,object_name,subobject_name,object_type\r\n10,99,\"APP\",\"T\",\"P1\",\"TABLE PARTITION\"\r\n")
	write("users.csv", "\"user_id\",\"username\"\n7,\"SCOTT\"\nnot,a-row\n")
	write("plans/aaaaaaaaaaaaa.txt", "SQL_ID  aaaaaaaaaaaaa, child number 0\n\nPlan hash value: 1\n\n| Id |\r\n")
	write("plans/bbbbbbbbbbbbb.txt", "SQL_ID  bbbbbbbbbbbbb, child number 0 cannot be found\n")
	write("plans/ignored.dat", "x")
	b, err := LoadBundle(dir)
	if err != nil {
		t.Fatal(err)
	}
	if o, ok := b.Object(10); !ok || o.QualifiedName() != "APP.T.P1" {
		t.Errorf("object 10 = %+v, %v", o, ok)
	}
	if o, ok := b.Object(99); !ok || o.ID != 10 {
		t.Errorf("obj# 99 (a data_object_id) should find object 10: %+v, %v", o, ok)
	}
	if b.Users[7] != "SCOTT" || len(b.Users) != 1 {
		t.Errorf("users = %v", b.Users)
	}
	if len(b.Plans) != 1 || b.Plans["aaaaaaaaaaaaa"] == "" {
		t.Errorf("plans = %v (an aged-out cursor message is not a plan)", b.Plans)
	}
	if len(b.Files) != 0 {
		t.Errorf("files = %v", b.Files)
	}
}

func TestLoadBundleErrors(t *testing.T) {
	if _, err := LoadBundle(filepath.Join(t.TempDir(), "nope")); err == nil {
		t.Error("a missing directory must be an error")
	}
	b, err := LoadBundle(t.TempDir())
	if err != nil || !b.Empty() {
		t.Errorf("an empty directory is an empty bundle: %v %v", b, err)
	}
}

func TestCopyBundle(t *testing.T) {
	src := t.TempDir()
	os.MkdirAll(filepath.Join(src, "plans"), 0o755)
	for _, f := range []string{"objects.csv", "x_objects.csv", "datafiles.csv", "users.csv", "other.csv", "plans/a.txt", "plans/b.log"} {
		os.WriteFile(filepath.Join(src, f), []byte(f), 0o644)
	}
	dst := filepath.Join(t.TempDir(), "d")
	n, err := CopyBundle(src, dst)
	if err != nil || n != 5 {
		t.Fatalf("copied %d: %v", n, err)
	}
	for f, want := range map[string]bool{"objects.csv": true, "x_objects.csv": true, "datafiles.csv": true, "users.csv": true, "plans/a.txt": true, "other.csv": false, "plans/b.log": false} {
		if _, err := os.Stat(filepath.Join(dst, f)); (err == nil) != want {
			t.Errorf("%s: copied %v, want %v", f, err == nil, want)
		}
	}
}
