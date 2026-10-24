package report

import (
	"bytes"
	"encoding/json"
	"testing"
)

// An unpacked document must carry u8 columns (call kind, flags) as JSON number
// arrays, not the base64 string Go uses for []byte; the UI loader expects arrays.
func TestUnpackedU8ColumnsAreNumberArrays(t *testing.T) {
	m := buildFixture(t, "basic_binds.trc")
	var buf bytes.Buffer
	if err := JSON(&buf, m, DocOptions{Facts: true}); err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Facts struct {
			Calls map[string]json.RawMessage `json:"calls"`
			Waits map[string]json.RawMessage `json:"waits"`
		} `json:"facts"`
	}
	if err := json.Unmarshal(buf.Bytes(), &doc); err != nil {
		t.Fatal(err)
	}
	for _, c := range []struct {
		table map[string]json.RawMessage
		col   string
	}{{doc.Facts.Calls, "kind"}, {doc.Facts.Calls, "flags"}, {doc.Facts.Waits, "flags"}} {
		raw, ok := c.table[c.col]
		if !ok {
			t.Fatalf("column %q missing", c.col)
		}
		var nums []int
		if err := json.Unmarshal(raw, &nums); err != nil {
			t.Fatalf("column %q is not a JSON array of numbers: %v (%.40s)", c.col, err, raw)
		}
		if len(nums) == 0 {
			t.Errorf("column %q is empty", c.col)
		}
	}
}
