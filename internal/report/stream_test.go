package report

import (
	"bytes"
	"encoding/json"
	"regexp"
	"testing"
)

var generatedRe = regexp.MustCompile(`"generated":"[^"]*"`)

// The streamed packed document must be byte-identical to the one built in
// memory (columns copied, packed, base64'd, marshalled).
func TestStreamedDocumentMatchesInMemory(t *testing.T) {
	for _, fx := range []string{"basic_binds.trc", "io_waits.trc", "lobs.trc", "plsql_recursive.trc"} {
		m := buildFixture(t, fx)
		o := DocOptions{Facts: true, Packed: true}
		want, err := json.Marshal(BuildDocument(m, o))
		if err != nil {
			t.Fatal(err)
		}
		var got bytes.Buffer
		if err := WriteDocument(&got, m, o); err != nil {
			t.Fatal(err)
		}
		w := generatedRe.ReplaceAll(want, nil)
		g := generatedRe.ReplaceAll(got.Bytes(), nil)
		if !bytes.Equal(w, g) {
			i := 0
			for i < len(w) && i < len(g) && w[i] == g[i] {
				i++
			}
			t.Errorf("%s: streamed document differs from the in-memory one at byte %d (len %d vs %d)", fx, i, len(g), len(w))
		}
	}
}
