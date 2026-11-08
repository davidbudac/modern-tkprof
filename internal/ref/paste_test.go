package ref

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func readPaste(t *testing.T, name string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("testdata", name))
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

// The output of `mtkprof refscript -paste -plans` for io_waits.trc, run on the
// lab's PDB1 as SYSDBA (SQL*Plus; "Session altered." from the container switch).
func TestParsePasteSysdba(t *testing.T) {
	p := ParsePaste(readPaste(t, "paste_io_waits_sysdba.txt"))
	b := p.Bundle
	if !p.Header || !p.End || p.Tables {
		t.Errorf("header %v end %v tables %v", p.Header, p.End, p.Tables)
	}
	if len(b.Objects) != 7 || len(b.Files) != 3 || len(b.Users) != 2 {
		t.Fatalf("got %s", b.Summary())
	}
	if o, _ := b.Object(108613); o != (ObjectRef{ID: 108613, DataID: 108613, Owner: "MTK", Name: "MTK_ORDERS_CUST_IX", Type: "INDEX"}) {
		t.Errorf("108613 = %+v", o)
	}
	if f := b.Files[203]; f != (FileRef{File: 203, Name: "/u01/oradata/CDB1/pdb1/temp01.dbf", Tablespace: "TEMP", Type: "TEMPFILE"}) {
		t.Errorf("tempfile = %+v (keyed by abs_file#)", f)
	}
	if b.Users[165] != "MTK" || b.Users[0] != "SYS" {
		t.Errorf("users = %v", b.Users)
	}
	pl := b.Plans["10gywwmwk6xfy"]
	if !strings.HasPrefix(pl, "SQL_ID  10gywwmwk6xfy, child number 1\n") || !strings.Contains(pl, "Plan hash value: 1426583507") {
		t.Errorf("plan 10gywwmwk6xfy:\n%s", pl)
	}
	if !strings.Contains(pl, "\n|*  2 |   INDEX UNIQUE SCAN         | I_EXP_HEAD$ |      1 |\n") {
		t.Error("plan lines lost their layout")
	}
	if len(b.Plans) != 6 {
		t.Errorf("plans = %d, want 6", len(b.Plans))
	}
	if !contains(p.Notes, "plan 06nvwn223659v: no plan found") {
		t.Errorf("notes = %q", p.Notes)
	}
}

// The same script run as the schema owner (no DBA_ or V$ views): ALL_ views
// read instead, the notes say so, the plans are a privilege message.
func TestParsePasteFallback(t *testing.T) {
	p := ParsePaste(readPaste(t, "paste_io_waits_mtk.txt"))
	b := p.Bundle
	if len(b.Objects) != 5 || len(b.Files) != 0 || len(b.Users) != 2 || len(b.Plans) != 0 {
		t.Fatalf("got %s", b.Summary())
	}
	want := []string{
		"objects: ORA-00942: table or view does not exist; read ALL_OBJECTS: only the objects this user can see",
		"datafiles: ORA-00942: table or view does not exist",
		"users: ORA-00942: table or view does not exist; read ALL_USERS",
		"23 plans not read: User has no SELECT privilege on V$SQL",
	}
	if !reflect.DeepEqual(p.Notes, want) {
		t.Errorf("notes =\n%q\nwant\n%q", p.Notes, want)
	}
}

func TestParsePasteTolerance(t *testing.T) {
	// a paste at the SQL> prompt (echoed block, line numbers), CRLF, indentation, a
	// field with a comma and a quote, a cut-off end
	text := "SQL> declare\r\n  2    put('obj,' || x);\r\n" +
		"mtkprof-ref 1\r\n" +
		"  obj,5,,\"A\",\"B,\"\"C\",\"\",\"TABLE\"  \r\n" +
		"obj,x,1,\"A\",\"N\",\"\",\"T\"\r\n" + // not a number: skipped
		"obj,6,1\r\n" + // too short: skipped
		"user,7,\"\"\r\n" + // no name: skipped
		"PL/SQL procedure successfully completed.\r\n" +
		"objects,9,\"x\"\r\n" // not a tag
	p := ParsePaste(text)
	if !p.Header || p.End {
		t.Errorf("header %v end %v", p.Header, p.End)
	}
	if len(p.Bundle.Objects) != 1 || p.Bundle.Objects[5].Name != `B,"C` || p.Bundle.Objects[5].DataID != 0 || len(p.Bundle.Users) != 0 {
		t.Errorf("got %+v", p.Bundle.Objects)
	}
	if ParsePaste("plan,\"../x\",\"Plan hash value: 1\"\n").Bundle.Plans["../x"] != "" {
		t.Error("a plan id that is not a sql_id must not be kept")
	}
	if p := ParsePaste("nothing to see\n"); !p.Bundle.Empty() {
		t.Errorf("got %s", p.Bundle.Summary())
	}
}

// Without tagged lines a paste is read as tables: the full script's CSVs, a grid
// copied with its header (tab-separated), one after the other.
func TestParsePasteTables(t *testing.T) {
	objs, err := os.ReadFile("../../testdata/reference/bundle/objects.csv")
	if err != nil {
		t.Fatal(err)
	}
	text := string(objs) + "\n" +
		"FILE#\tNAME\tTABLESPACE_NAME\n12\t/u01/users01.dbf\tUSERS\n\n" +
		"USER_ID;USERNAME\n165;MTK\n"
	p := ParsePaste(text)
	want, err := LoadBundle("../../testdata/reference/bundle")
	if err != nil {
		t.Fatal(err)
	}
	if !p.Tables || !reflect.DeepEqual(p.Bundle.Objects, want.Objects) {
		t.Errorf("objects: tables %v, %d of %d", p.Tables, len(p.Bundle.Objects), len(want.Objects))
	}
	if p.Bundle.Files[12] != (FileRef{File: 12, Name: "/u01/users01.dbf", Tablespace: "USERS"}) || p.Bundle.Users[165] != "MTK" {
		t.Errorf("files %v users %v", p.Bundle.Files, p.Bundle.Users)
	}
}

// What the engine stores is what LoadBundle reads back; a file is read as a paste.
func TestWriteBundleRoundTrip(t *testing.T) {
	path := filepath.Join("testdata", "paste_io_waits_sysdba.txt")
	b, err := LoadBundle(path)
	if err != nil || len(b.Objects) != 7 {
		t.Fatalf("LoadBundle(file): %v %v", b, err)
	}
	dir := t.TempDir()
	if err := WriteBundle(b, dir); err != nil {
		t.Fatal(err)
	}
	back, err := LoadBundle(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(back.Objects, b.Objects) || !reflect.DeepEqual(back.Files, b.Files) || !reflect.DeepEqual(back.Users, b.Users) || !reflect.DeepEqual(back.Plans, b.Plans) {
		t.Errorf("round trip: %s -> %s", b.Summary(), back.Summary())
	}
}

func TestBundleMerge(t *testing.T) {
	a := NewBundle()
	a.addObject(ObjectRef{ID: 1, Name: "OLD"})
	a.Plans["abc"] = "Plan hash value: 1"
	b := NewBundle()
	b.addObject(ObjectRef{ID: 1, Name: "NEW"})
	b.addObject(ObjectRef{ID: 2, DataID: 3, Name: "T"})
	a.Merge(b)
	if a.Objects[1].Name != "NEW" || a.Plans["abc"] == "" {
		t.Errorf("merge: %+v %v", a.Objects, a.Plans)
	}
	if o, ok := a.Object(3); !ok || o.Name != "T" {
		t.Error("merged data_object_id lookup")
	}
}

func contains(v []string, s string) bool {
	for _, x := range v {
		if x == s {
			return true
		}
	}
	return false
}
