package model_test

import (
	"bytes"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/report"
)

const bindsFixture = "../../testdata/traces/19c/basic_binds.trc"

// secrets are bind values of basic_binds.trc that never occur in its SQL text.
var secrets = []string{"Customer 42", "Long text, ong text", "More long text, ore", "PAID", "3.1415926535897931E+000D", "AAAahBAAMAAAo92AAG", "2.25E+000D", "65 e5 67"}

func build(t *testing.T) *model.Model {
	t.Helper()
	m, err := model.Build(bindsFixture, model.Options{})
	if err != nil {
		t.Fatal(err)
	}
	return m
}

// render returns the text report, the JSON document (with facts, unpacked)
// and every CSV file of the export, concatenated.
func render(t *testing.T, m *model.Model) (text, doc, csv string) {
	t.Helper()
	var tb, jb bytes.Buffer
	if err := report.Text(&tb, m, report.TextOptions{Sort: "elapsed", Binds: 1000, Sys: true, Width: 120}); err != nil {
		t.Fatal(err)
	}
	if err := report.JSON(&jb, m, report.DocOptions{Facts: true}); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	files, err := report.ExportCSV(m, dir)
	if err != nil {
		t.Fatal(err)
	}
	var cb strings.Builder
	for _, f := range files {
		b, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		cb.WriteString(filepath.Base(f) + "\n")
		cb.Write(b)
	}
	return tb.String(), jb.String(), cb.String()
}

func TestSecretsPresentWhenKept(t *testing.T) {
	m := build(t)
	text, doc, csv := render(t, m)
	for _, s := range secrets {
		for name, out := range map[string]string{"text": text, "json": doc, "csv": csv} {
			if !strings.Contains(out, s) {
				t.Errorf("%s output lacks bind value %q without redaction (fixture changed?)", name, s)
			}
		}
	}
}

func TestBindsKeepIsNoop(t *testing.T) {
	a, b := build(t), build(t)
	model.RedactBinds(b, model.BindsKeep)
	if !reflect.DeepEqual(a, b) {
		t.Fatal("RedactBinds(BindsKeep) changed the model")
	}
	if b.Diag.BindMode != "kept" {
		t.Fatalf("bindMode = %q, want kept", b.Diag.BindMode)
	}
}

func TestRedactBinds(t *testing.T) {
	orig := build(t)
	m := build(t)
	model.RedactBinds(m, model.BindsRedact)
	if m.Diag.BindMode != "redacted" {
		t.Fatalf("bindMode = %q", m.Diag.BindMode)
	}
	text, doc, csv := render(t, m)
	for _, s := range secrets {
		for name, out := range map[string]string{"text": text, "json": doc, "csv": csv} {
			if strings.Contains(out, s) {
				t.Errorf("%s output still contains bind value %q", name, s)
			}
		}
	}
	if !strings.Contains(text, "bind values redacted") || !strings.Contains(doc, `"bindMode":"redacted"`) {
		t.Error("redaction is not announced in the text report / JSON diag")
	}

	tok := regexp.MustCompile(`^<[A-Z0-9_ ]+ len=\d+ h=[0-9a-f]{8}>$`)
	dump := regexp.MustCompile(`^<[A-Za-z0-9_ ]+ dump len=\d+>$`)
	byValue := map[string]string{} // type + original value -> token
	for i := range m.Binds {
		o, r := &orig.Binds[i], &m.Binds[i]
		// metadata is kept
		if o.TypeName != r.TypeName || o.Avl != r.Avl || o.Mxl != r.Mxl || o.Dty != r.Dty || o.IsNull != r.IsNull || o.NoDef != r.NoDef || o.IsDump != r.IsDump {
			t.Fatalf("bind %d: metadata changed: %+v -> %+v", i, *o, *r)
		}
		switch {
		case o.IsNull || o.NoDef:
			if r.Value != o.Value {
				t.Errorf("bind %d: null/no-oacdef value changed to %q", i, r.Value)
			}
		case o.IsDump:
			if !dump.MatchString(r.Value) {
				t.Errorf("bind %d: dump redacted to %q", i, r.Value)
			}
		default:
			if !tok.MatchString(r.Value) {
				t.Errorf("bind %d: redacted to %q", i, r.Value)
			}
			k := o.TypeName + "\x00" + o.Value
			if prev, ok := byValue[k]; ok && prev != r.Value {
				t.Errorf("value %q redacted to %q and %q", o.Value, prev, r.Value)
			}
			byValue[k] = r.Value
		}
	}
	// equal values recur across executions in the fixture and map to one token
	if tk := byValue["VARCHAR2\x00Customer 42"]; tk == "" || strings.Count(text, tk) < 2 {
		t.Errorf("token for a repeated value %q does not repeat in the report", tk)
	}
	// stable across runs: a fresh build gives identical tokens
	again := build(t)
	model.RedactBinds(again, model.BindsRedact)
	if !reflect.DeepEqual(again.Binds, m.Binds) {
		t.Error("redaction is not deterministic")
	}
	// distinct values of a type give distinct tokens (no collisions in the fixture)
	seen := map[string]string{}
	for v, tk := range byValue {
		if w, ok := seen[tk]; ok {
			t.Errorf("values %q and %q share token %s", v, w, tk)
		}
		seen[tk] = v
	}
}

func TestBindsNone(t *testing.T) {
	m := build(t)
	if len(m.Binds) == 0 || len(m.BindSets) == 0 {
		t.Fatal("fixture has no binds")
	}
	model.RedactBinds(m, model.BindsNone)
	if len(m.Binds) != 0 || len(m.BindSets) != 0 || m.Binds == nil || m.BindSets == nil {
		t.Fatalf("binds %v sets %v, want empty non-nil", m.Binds, m.BindSets)
	}
	for i := range m.Calls {
		if m.Calls[i].BindSet != model.None {
			t.Fatalf("call %d still points at bind set %d", i, m.Calls[i].BindSet)
		}
	}
	text, doc, csv := render(t, m)
	for _, s := range secrets {
		for name, out := range map[string]string{"text": text, "json": doc, "csv": csv} {
			if strings.Contains(out, s) {
				t.Errorf("%s output still contains bind value %q", name, s)
			}
		}
	}
	if strings.Contains(text, "Bind values (") || !strings.Contains(text, "bind values dropped") {
		t.Error("text report: bind section printed or drop not announced")
	}
	if !strings.Contains(doc, `"bindMode":"none"`) {
		t.Error("JSON diag lacks bindMode none")
	}
	if !strings.Contains(csv, "binds.csv\nbind_set_id,") {
		t.Error("binds.csv missing or without header")
	}
	// packed documents (html/serve) cope with empty tables too
	if _, err := report.DocumentBytes(m, report.DocOptions{Facts: true, Packed: true}); err != nil {
		t.Fatal(err)
	}
}

func TestRedactBindsSalt(t *testing.T) {
	redact := func(salt string) *model.Model {
		m := build(t)
		model.RedactBindsSalt(m, model.BindsRedact, salt)
		return m
	}
	unsalted, a1, a2, b := redact(""), redact("pepper"), redact("pepper"), redact("other")
	if !reflect.DeepEqual(a1.Binds, a2.Binds) {
		t.Error("same salt: tokens differ between runs")
	}
	tok := regexp.MustCompile(`^<[A-Z0-9_ ]+ len=\d+ h=[0-9a-f]{8}>$`)
	differs, same := 0, 0
	byValue := map[string]string{}
	for i := range a1.Binds {
		o := &unsalted.Binds[i]
		if o.IsNull || o.NoDef || o.IsDump {
			continue
		}
		if !tok.MatchString(a1.Binds[i].Value) {
			t.Errorf("bind %d: salted token %q", i, a1.Binds[i].Value)
		}
		if a1.Binds[i].Value != o.Value {
			differs++
		}
		if a1.Binds[i].Value == b.Binds[i].Value {
			same++
		}
		// equal values stay equal within the salt
		k := o.TypeName + "\x00" + o.Value
		if prev, ok := byValue[k]; ok && prev != a1.Binds[i].Value {
			t.Errorf("value redacted to %q and %q under one salt", prev, a1.Binds[i].Value)
		}
		byValue[k] = a1.Binds[i].Value
	}
	if differs == 0 || same != 0 {
		t.Errorf("salted tokens equal to unsalted for %d binds fewer than expected (differs=%d), equal under another salt for %d", len(a1.Binds)-differs, differs, same)
	}
	text, doc, csv := render(t, a1)
	for _, s := range secrets {
		for name, out := range map[string]string{"text": text, "json": doc, "csv": csv} {
			if strings.Contains(out, s) {
				t.Errorf("%s output still contains bind value %q", name, s)
			}
		}
	}
	if strings.Contains(text, "pepper") || strings.Contains(doc, "pepper") || strings.Contains(csv, "pepper") {
		t.Error("the salt leaks into the output")
	}
	if n := a1.Diag.Notes; len(n) == 0 || !strings.Contains(n[len(n)-1], "salted hash") {
		t.Errorf("salted redaction is not announced in Diag.Notes: %v", n)
	}
	// the empty salt is the unsalted behaviour
	if !reflect.DeepEqual(redact("").Binds, unsalted.Binds) {
		t.Error("empty salt changed the tokens")
	}
}
