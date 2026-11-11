package report

import (
	"io"
	"slices"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/opt"
)

// The 10053 reader's part of a report (docs/PLAN-10053.md § Build contract).
// The model of a 10053 file is the empty model of a trace without 10046
// records; what the file holds is read by internal/opt from the file itself.
// The document of such a file carries it as "opt", the text report prints its
// digest.

// OptInput is what a document or a text report of a 10053 file is made from.
type OptInput struct {
	Scan *opt.Scan
	// Line gives the text of a line of the file (1-based, without its
	// terminator). With Digest it supplies the lines of the document's
	// digest; the text digest reads the plan table through it. May be nil
	// without Digest (the text digest then rebuilds the plan from the model).
	Line func(n int) (string, bool)
	// Digest puts the digest (the dumps' models and their lines) in the
	// document: for a client without a server (mtkprof html, json, the
	// default command, the engine's HTML export). A document made for a
	// server leaves it out; the client then reads the two api/opt routes.
	Digest bool
	// Text is the bind handling of the text digest and of the document's
	// digest (-redact-binds, -binds none).
	Text opt.TextOptions
}

// OptDoc is the document's "opt" member.
type OptDoc struct {
	File   *opt.File  `json:"file"`
	Digest *OptDigest `json:"digest,omitempty"`
}

// OptDigest is the digest of a 10053 file in the document.
type OptDigest struct {
	Dumps []*opt.Dump `json:"dumps"`
	// Lines are the lines of the dumps' digest ranges (opt.Dump.Digest, all
	// dumps), ascending, in runs of consecutive lines.
	Lines []OptLines `json:"lines"`
}

// OptLines is a run of consecutive lines: Text[i] is line From+i.
type OptLines struct {
	From int      `json:"from"`
	Text []string `json:"text"`
}

// OptScan scans the file of a 10053 model. It returns nil without an error
// when the model is not that of a 10053 file (an ordinary trace, one with the
// dumps interleaved with 10046 records, a trace set).
func OptScan(m *model.Model) (*opt.Scan, error) {
	if m == nil || !m.OptOnly() {
		return nil, nil
	}
	sc, err := opt.ScanFile(m.File.Files[0].Path)
	if err != nil {
		return nil, err
	}
	if !sc.File.Pure() {
		return nil, nil
	}
	return sc, nil
}

// OptBindText is the opt.TextOptions of a bind mode and salt, the same hash
// the 10046 redaction uses (model.RedactToken): one value gives one token in
// either kind of report. A value is hashed without the double quotes the
// 10053 prints around a string, and its length is that of the unquoted value.
func OptBindText(mode model.BindMode, salt string) opt.TextOptions {
	switch mode {
	case model.BindsNone:
		return opt.TextOptions{DropBinds: true}
	case model.BindsRedact:
		return opt.TextOptions{RedactBind: func(typ, value string) string {
			v := unquoteBind(value)
			if typ == "" {
				typ = "bind"
			}
			return model.RedactToken(typ, v, len(v), salt)
		}}
	}
	return opt.TextOptions{}
}

func unquoteBind(v string) string {
	if n := len(v); n >= 2 && v[0] == '"' && v[n-1] == '"' {
		return v[1 : n-1]
	}
	return v
}

// OptText writes the text report of a 10053 file: its digest.
func OptText(w io.Writer, in *OptInput) error {
	return opt.WriteDigest(w, in.Scan, in.Line, in.Text)
}

// buildOpt is the document's "opt" member.
func buildOpt(in *OptInput) *OptDoc {
	f := in.Scan.File
	if f.Dumps == nil {
		f.Dumps = []opt.DumpInfo{}
	}
	for i := range f.Dumps {
		if f.Dumps[i].Tables == nil {
			f.Dumps[i].Tables = []string{}
		}
	}
	d := &OptDoc{File: &f}
	if !in.Digest {
		return d
	}
	dg := &OptDigest{Dumps: make([]*opt.Dump, len(in.Scan.Dumps)), Lines: []OptLines{}}
	for i, dump := range in.Scan.Dumps {
		dg.Dumps[i] = redactDump(dump, in.Text)
	}
	dg.Lines = digestLines(in)
	d.Digest = dg
	return d
}

// redactDump returns the dump with its binds handled as asked: a copy when
// there is anything to change, the dump itself otherwise.
func redactDump(d *opt.Dump, o opt.TextOptions) *opt.Dump {
	if !o.DropBinds && o.RedactBind == nil {
		return d
	}
	c := *d
	c.Binds = slices.Clone(d.Binds)
	for i := range c.Binds {
		b := &c.Binds[i]
		if b.Line == 0 || b.Dup != 0 {
			continue
		}
		if o.DropBinds {
			b.Value = ""
		} else {
			b.Value = o.RedactBind(b.Type, b.Value)
		}
	}
	return &c
}

// digestLines reads the lines of every dump's digest ranges, bind values
// handled as asked, in runs of consecutive lines.
func digestLines(in *OptInput) []OptLines {
	out := []OptLines{}
	if in.Line == nil {
		return out
	}
	var ranges []opt.Range
	bindLine := map[int]bool{}
	byLine := map[int]opt.Bind{} // the bind a "value=" line prints
	byValue := map[string]string{}
	for _, d := range in.Scan.Dumps {
		ranges = append(ranges, d.Digest...)
		for _, n := range d.BindLines {
			bindLine[n] = true
		}
		for _, b := range d.Binds {
			if b.Line != 0 {
				byLine[b.Line] = b
				byValue[b.Value] = b.Type
			}
		}
	}
	slices.SortFunc(ranges, func(a, b opt.Range) int { return a.From - b.From })
	var cur *OptLines
	next := 0
	for _, r := range ranges {
		for n := max(r.From, next); n <= r.To; n++ {
			s, ok := in.Line(n)
			if !ok {
				cur = nil
				continue
			}
			if bindLine[n] {
				s = bindLineText(s, byLine[n], byValue, in.Text)
			}
			if cur == nil || cur.From+len(cur.Text) != n {
				out = append(out, OptLines{From: n})
				cur = &out[len(out)-1]
			}
			cur.Text = append(cur.Text, s)
			next = n + 1
		}
	}
	return out
}

// bindLineText rewrites a line that prints a bind value: the text after
// "value=" becomes the redacted token (or nothing for -binds none); a
// continuation line of a value that runs over several lines is emptied. The
// line keeps its place and the text before the value.
func bindLineText(s string, b opt.Bind, byValue map[string]string, o opt.TextOptions) string {
	if !o.DropBinds && o.RedactBind == nil {
		return s
	}
	i := strings.Index(s, "value=")
	if i < 0 || strings.TrimSpace(s[:i]) != "" {
		return "" // the rest of a value that began on an earlier line
	}
	head := s[:i+len("value=")]
	if o.DropBinds {
		return head
	}
	v := strings.TrimRight(s[i+len("value="):], " \t")
	typ := b.Type
	if b.Line == 0 {
		typ = byValue[v]
	}
	return head + o.RedactBind(typ, v)
}

// withoutDumpNotes returns the model's notes without the "not shown as 10053
// yet" notes of its dumps: the reader shows them.
func withoutDumpNotes(m *model.Model) []string {
	drop := m.DumpNotes()
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
