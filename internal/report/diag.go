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
	// Text is how the digest handles the bind values of the cursor dumps (DiagBindText); the zero value keeps them.
	Text   diag.TextOptions
	digest *diag.Digest // set when the document carries the digest
}

// NewDiagInput is the input for the file r reads. digest puts the digest (the outline to two levels) in
// the document: for a client without a server (mtkprof html, json, the default command, the engine's HTML
// and JSON exports). A document made for a server leaves it out; the client then reads the api/diag
// routes. The digest is made here (it reads the lines of the file), so that a failure is the caller's.
func NewDiagInput(r *diag.Reader, digest bool, text diag.TextOptions) (*DiagInput, error) {
	in := &DiagInput{Reader: r, Text: text}
	if digest {
		dg, err := r.DigestWith(text)
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
func DiagText(w io.Writer, in *DiagInput) error { return diag.WriteDigestWith(w, in.Reader, in.Text) }

// DiagBindText is the diag.TextOptions of a bind mode and salt: the bind values of the cursor dumps are dropped
// (-binds none) or replaced by the token the 10046 redaction makes of the same value (model.RedactToken: type
// name, length, hash), so that one value has one token in a SQL trace report and in a diagnostic dump report. A
// value is hashed without the double quotes a dump prints around a string, and its length is the printed avl,
// else that of the unquoted value, as in the 10046 model.
func DiagBindText(mode model.BindMode, salt string) diag.TextOptions {
	switch mode {
	case model.BindsNone:
		return diag.TextOptions{DropBinds: true}
	case model.BindsRedact:
		return diag.TextOptions{RedactBind: func(typ, value string, avl int) string {
			v := unquoteBind(value)
			n := avl
			if n <= 0 {
				n = len(v)
			}
			return model.RedactToken(typ, v, n, salt)
		}}
	}
	return diag.TextOptions{}
}

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
