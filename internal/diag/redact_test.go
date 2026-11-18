package diag

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const secretBind = "S3cr3t-BIND-value-4711"

// secretFile is diagnostic dump errorstack level 2 with the string bind of the cursor of mtk_diag_outer
// (diag_errorstack_l2:7762) replaced by a value that appears nowhere else.
func secretFile(t testing.TB) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(diagDir, "diag_errorstack_l2.trc"))
	if err != nil {
		t.Fatal(err)
	}
	old := `value="alter session set events 'immediate trace name errorstack level 2'"`
	if bytes.Count(data, []byte(old)) != 1 {
		t.Fatal("the bind value line is not where it was")
	}
	return bytes.Replace(data, []byte(old), []byte(`value="`+secretBind+`"`), 1)
}

func testToken(typ, value string, avl int) string {
	return fmt.Sprintf("<%s len=%d h=%x>", typ, avl, len(value)*7919)
}

// TestRedaction: -redact-binds and -binds none act on the bind values of the cursor dumps in the text digest
// and in the readings of the document; the live reading serves the file as it is, before and after.
func TestRedaction(t *testing.T) {
	r := readerOfBytes(t, secretFile(t))
	live := func() *CallStack { return callStacks(t, r)[0] }
	find := func(cs *CallStack) *DumpCursor {
		for i := range cs.Cursors {
			if cs.Cursors[i].SQLID == "f3j90cdzgg7d2" {
				return &cs.Cursors[i]
			}
		}
		t.Fatal("no cursor f3j90cdzgg7d2")
		return nil
	}
	if v := find(live()).Binds[0].Value; v != `"`+secretBind+`"` {
		t.Fatalf("the live reading has %q", v)
	}

	// kept: the value is in the text and the document
	var kept bytes.Buffer
	if err := WriteDigest(&kept, r); err != nil {
		t.Fatal(err)
	}
	dk, _ := r.Digest()
	jk, _ := json.Marshal(dk)
	if !strings.Contains(kept.String(), secretBind) || !bytes.Contains(jk, []byte(secretBind)) {
		t.Fatal("the unredacted digest does not hold the value")
	}
	if strings.Contains(kept.String(), "redacted") {
		t.Error("an unredacted digest says redacted")
	}

	// redacted
	o := TextOptions{RedactBind: func(typ, value string, avl int) string {
		v := strings.Trim(value, `"`)
		return testToken(typ, v, avl)
	}}
	var red bytes.Buffer
	if err := WriteDigestWith(&red, r, o); err != nil {
		t.Fatal(err)
	}
	d, err := r.DigestWith(o)
	if err != nil {
		t.Fatal(err)
	}
	j, _ := json.Marshal(d)
	token := testToken("VARCHAR2", secretBind, 66)
	for what, s := range map[string]string{"text": red.String(), "document": string(j)} {
		if strings.Contains(s, secretBind) {
			t.Errorf("the redacted %s holds the value", what)
		}
	}
	jsonToken := strings.NewReplacer("<", `\u003c`, ">", `\u003e`).Replace(token) // encoding/json escapes the angle brackets
	if !strings.Contains(red.String(), token) || !strings.Contains(string(j), jsonToken) {
		t.Errorf("the token %s is not in the digest", token)
	}
	if !strings.Contains(red.String(), "bind values redacted") {
		t.Errorf("the text digest does not say so")
	}
	// numbers are redacted too: 11 is not printed as a bind value any more
	if strings.Contains(red.String(), "NUMBER 11") || strings.Contains(string(j), `"value":"11"`) {
		t.Errorf("a numeric bind value is in the redacted digest")
	}
	if !strings.Contains(red.String(), "NUMBER "+testToken("NUMBER", "11", 2)) {
		t.Errorf("no token for a numeric bind in %s", red.String())
	}
	// the structure stays: counts, types, lines of the values
	dc := d.rd[firstReadingOf(t, d, ReadingCallStack)].(*CallStack)
	c := find(dc)
	if c.BindCount != 2 || len(c.Binds) != 2 || c.Binds[0].Type != "VARCHAR2" || c.Binds[0].Line != 7762 {
		t.Errorf("redacted cursor %+v", c)
	}
	// the statement text is not touched (it can hold literals, as for 10053)
	if dc.Statement == nil || dc.Statement.Text == "" {
		t.Errorf("the statement was lost")
	}

	// none
	var none bytes.Buffer
	WriteDigestWith(&none, r, TextOptions{DropBinds: true})
	dn, _ := r.DigestWith(TextOptions{DropBinds: true})
	jn, _ := json.Marshal(dn)
	for what, s := range map[string]string{"text": none.String(), "document": string(jn)} {
		if strings.Contains(s, secretBind) || strings.Contains(s, "value\":\"11\"") {
			t.Errorf("-binds none: the %s holds a value", what)
		}
	}
	if !strings.Contains(none.String(), "bind values dropped") || strings.Contains(none.String(), "binds: #") {
		t.Errorf("-binds none text: %s", none.String())
	}
	dnc := find(dn.rd[firstReadingOf(t, dn, ReadingCallStack)].(*CallStack))
	if dnc.BindCount != 2 || len(dnc.Binds) != 0 {
		t.Errorf("dropped cursor %+v", dnc)
	}

	// the live reading was not changed by any of it (the reading is cached; redaction copies)
	if v := find(live()).Binds[0].Value; v != `"`+secretBind+`"` {
		t.Errorf("the live reading has %q after redaction", v)
	}
	if v := find(live()).Binds[0]; v.Line != 7762 {
		t.Errorf("bind %+v", v)
	}
}

func firstReadingOf(t testing.TB, d *Digest, kind string) string {
	t.Helper()
	for id, rd := range d.rd {
		if rd.ReadingKind() == kind {
			return id
		}
	}
	t.Fatalf("no %s reading in the digest", kind)
	return ""
}

// TestRedactionMultiLine: a value that spans lines is one value (all its lines are the value's).
func TestRedactionMultiLine(t *testing.T) {
	data := secretFile(t)
	data = bytes.Replace(data, []byte(`value="`+secretBind+`"`), []byte("value=\"first line S3cr3t-ML\nsecond line S3cr3t-ML\nthird\""), 1)
	r := readerOfBytes(t, data)
	cs := callStacks(t, r)[0]
	var b *DumpBind
	for i := range cs.Cursors {
		if cs.Cursors[i].SQLID == "f3j90cdzgg7d2" {
			b = &cs.Cursors[i].Binds[0]
		}
	}
	if b == nil || b.LineTo != b.Line+2 || !strings.Contains(b.Value, "second line") || !strings.HasSuffix(b.Value, `third"`) {
		t.Fatalf("multi-line bind %+v", b)
	}
	if cs.Cursors[1].Binds[1].Value != "11" || cs.Cursors[1].Binds[1].Pos != 1 {
		t.Errorf("the bind after it: %+v", cs.Cursors[1].Binds[1])
	}
	var out bytes.Buffer
	WriteDigestWith(&out, r, TextOptions{RedactBind: func(typ, value string, avl int) string { return "<T>" }})
	if strings.Contains(out.String(), "S3cr3t-ML") {
		t.Errorf("a line of the multi-line value is in the redacted digest")
	}
}
