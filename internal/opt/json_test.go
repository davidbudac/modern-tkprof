package opt

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestJSONShape: the JSON form is what the UI reads; lists are lists, never null.
func TestJSONShape(t *testing.T) {
	lists := []string{"landmarks", "folds", "runs", "sql", "legend", "banners", "hints", "binds", "altered", "bindLines", "digest", "tables"}
	check := func(what string, v any) {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatalf("%s: %v", what, err)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		for _, k := range lists {
			if x, ok := m[k]; !ok || x == nil {
				t.Errorf("%s: %q is %v", what, k, x)
			}
		}
		if m["tree"] == nil || m["roles"] == nil {
			t.Errorf("%s: tree or roles missing", what)
		}
		if strings.Contains(string(b), "null") {
			i := strings.Index(string(b), "null")
			t.Errorf("%s: a null in the JSON: ...%s...", what, string(b)[max(0, i-60):i+20])
		}
	}
	for _, fx := range fixtures(t) {
		for _, d := range scanOf(t, fx).Dumps {
			check(fixtureName(fx), d)
		}
	}
	// a dump cut short and a file with no dump
	sc, _ := ScanReader(strings.NewReader("Registered qb: SEL$1 0x1 (PARSER)\nSPM: x\n"), "x")
	check("cut", sc.Dumps[0])
	empty, _ := ScanReader(strings.NewReader(""), "e")
	b, _ := json.Marshal(empty.File)
	if !strings.Contains(string(b), `"dumps":[]`) {
		t.Errorf("file with no dump: %s", b)
	}
}
