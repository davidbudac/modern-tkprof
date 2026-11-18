package report

import (
	"io"
	"slices"

	"github.com/davidbudac/modern-tkprof/internal/diag"
	"github.com/davidbudac/modern-tkprof/internal/model"
)

// The dump reader's part of a report (docs/PLAN-DIAG.md § Build contract). The model of a file opened as a
// diag session is the empty model of a trace without 10046 records; what the file holds is read by
// internal/diag from the file itself. The document carries it as "dump" (the key "diag" of a document is
// the parser's diagnostics), the text report prints its digest.

// DiagInput is what a document or a text report of a diag session is made from.
type DiagInput struct {
	Reader *diag.Reader
	digest *diag.Digest // set when the document carries the digest
}

// NewDiagInput is the input for the file r reads. digest puts the digest (the outline to two levels) in
// the document: for a client without a server (mtkprof html, json, the default command, the engine's HTML
// and JSON exports). A document made for a server leaves it out; the client then reads the api/diag
// routes. The digest is made here (it reads the lines of the file), so that a failure is the caller's.
func NewDiagInput(r *diag.Reader, digest bool) (*DiagInput, error) {
	in := &DiagInput{Reader: r}
	if digest {
		dg, err := r.Digest()
		if err != nil {
			return nil, err
		}
		in.digest = dg
	}
	return in, nil
}

// DiagDoc is the document's "dump" member.
type DiagDoc struct {
	File   *diag.File   `json:"file"`
	Digest *diag.Digest `json:"digest,omitempty"`
}

// DiagText writes the text report of a diag file: its digest.
func DiagText(w io.Writer, in *DiagInput) error { return diag.WriteDigest(w, in.Reader) }

// buildDiag is the document's "dump" member.
func buildDiag(in *DiagInput) *DiagDoc {
	f := in.Reader.Scan.File
	return &DiagDoc{File: &f, Digest: in.digest}
}

// withoutSectionNotes returns the model's notes without the notes about the diagnostic dump sections of
// its files: the reader shows them.
func withoutSectionNotes(m *model.Model) []string {
	drop := m.SectionNotes()
	out := []string{}
	for _, n := range m.Diag.Notes {
		if i := slices.Index(drop, n); i >= 0 {
			drop = slices.Delete(drop, i, i+1)
			continue
		}
		out = append(out, n)
	}
	return out
}
