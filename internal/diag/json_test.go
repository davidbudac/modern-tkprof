package diag

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestJSONShape: the JSON form is what the clients read; lists are lists, never null, and the field names
// are pinned.
func TestJSONShape(t *testing.T) {
	r := readerOf(t, filepathJoin(diagDir, "diag_heap_pga.trc"))
	b, err := json.Marshal(r.Scan.File)
	if err != nil {
		t.Fatal(err)
	}
	var m map[string]any
	if err := json.Unmarshal(b, &m); err != nil {
		t.Fatal(err)
	}
	for _, k := range []string{"name", "lines", "release", "version", "tested", "records10046", "sections", "unplaced", "outline", "outlineTotal"} {
		if _, ok := m[k]; !ok {
			t.Errorf("File has no %q: %s", k, b)
		}
	}
	if m["incident"] != nil {
		t.Errorf("a trace file has no incident facts: %v", m["incident"])
	}
	for _, k := range []string{"sections", "outline"} {
		if _, ok := m[k].([]any); !ok {
			t.Errorf("%q is %v, not a list", k, m[k])
		}
	}
	first := m["outline"].([]any)[1].(map[string]any) // the first heap
	for _, k := range []string{"id", "kind", "title", "from", "to", "lines", "hasChildren", "depth", "size", "name"} {
		if _, ok := first[k]; !ok {
			t.Errorf("a heap node has no %q: %v", k, first)
		}
	}
	if d, ok := first["depth"].(float64); !ok || d != 0 {
		t.Errorf("the depth of a top heap is %v, want 0 (present)", first["depth"])
	}
	for _, k := range []string{"n", "records", "cut"} {
		if _, ok := first[k]; ok {
			t.Errorf("a heap node has %q: %v", k, first[k])
		}
	}

	// an empty file is an outline of nothing, not null
	sc, err := ScanReader(strings.NewReader(""), "empty.trc")
	if err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(sc.File)
	if !strings.Contains(string(b), `"outline":[]`) || !strings.Contains(string(b), `"sections":[]`) || strings.Contains(string(b), "null") {
		t.Errorf("empty file: %s", b)
	}

	// an answer of Children, and the digest
	o, err := r.Children(r.Scan.Top[1].ID, 0)
	if err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(o)
	var om map[string]any
	json.Unmarshal(b, &om)
	for _, k := range []string{"node", "children", "more"} {
		if _, ok := om[k]; !ok {
			t.Errorf("Outline has no %q: %s", k, b)
		}
	}
	if _, ok := om["next"]; ok {
		t.Errorf("an answer without a next page has next: %s", b)
	}
	d, err := r.Digest()
	if err != nil {
		t.Fatal(err)
	}
	b, _ = json.Marshal(d)
	if strings.Contains(string(b), "null") {
		i := strings.Index(string(b), "null")
		t.Errorf("a null in the digest: ...%s...", string(b)[max(0, i-60):i+20])
	}
	var dm map[string]any
	json.Unmarshal(b, &dm)
	row := dm["outline"].([]any)[1].(map[string]any)
	if _, ok := row["children"].([]any); !ok || row["kind"] != "heap" {
		t.Errorf("a digest row is %v", row)
	}
}
