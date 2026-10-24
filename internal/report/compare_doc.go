package report

import (
	"encoding/json"
	"io"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// CompareDocument is the payload of `mtkprof html|serve|json a b -compare`:
// the two trace documents as the UI loads them on their own, plus the
// comparison computed in Go. The UI detects the top-level "compare" key.
type CompareDocument struct {
	Tool      string    `json:"tool"`
	Version   string    `json:"version"`
	Generated time.Time `json:"generated"`
	Format    int       `json:"format"`

	Compare CompareBody `json:"compare"`
}

// CompareBody holds both documents and the diff (B against A).
type CompareBody struct {
	A    *Document          `json:"a"`
	B    *Document          `json:"b"`
	Diff analyze.Comparison `json:"diff"`
}

// BuildCompareDocument assembles the comparison document from two models.
func BuildCompareDocument(a, b *model.Model, o DocOptions) *CompareDocument {
	return &CompareDocument{
		Tool: "mtkprof", Version: Version, Generated: time.Now(), Format: 2,
		Compare: CompareBody{A: BuildDocument(a, o), B: BuildDocument(b, o), Diff: analyze.Compare(a, b)},
	}
}

// CompareJSON writes the comparison document to w.
func CompareJSON(w io.Writer, a, b *model.Model, o DocOptions) error {
	return json.NewEncoder(w).Encode(BuildCompareDocument(a, b, o))
}

// CompareBytes marshals the comparison document (HTML-safe, inlineable in a <script> tag).
func CompareBytes(a, b *model.Model, o DocOptions) ([]byte, error) {
	return json.Marshal(BuildCompareDocument(a, b, o))
}
