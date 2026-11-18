package diag

import (
	"fmt"
	"io"
	"strconv"
	"strings"
)

// DigestChildren is how many children of a node the digest lists (the rest are counted).
const DigestChildren = 100

// Digest is the outline of a file to a fixed depth: every node of the top level with its own children
// (one level down). It is what a client without a server shows (the standalone HTML report) and what
// the text report prints. The computed readings of the later stages join it.
type Digest struct {
	Outline []DigestNode `json:"outline"`
}

// DigestNode is a top-level node with its children.
type DigestNode struct {
	Node
	Children []Node `json:"children"`
	More     int    `json:"more,omitempty"` // children not listed
}

// Digest makes the digest: one scan of the lines of every node that has children.
func (r *Reader) Digest() (*Digest, error) {
	d := &Digest{Outline: make([]DigestNode, 0, len(r.Scan.Top))}
	for _, n := range r.Scan.Top {
		dn := DigestNode{Node: n, Children: []Node{}}
		if n.HasChildren {
			o, err := r.children(n.ID, 0, DigestChildren)
			if err != nil {
				return nil, err
			}
			dn.Children = o.Children
			dn.More = o.More
		}
		d.Outline = append(d.Outline, dn)
	}
	return d, nil
}

// WriteDigest writes the text digest of a file: its facts, then the outline to two levels, with the first
// and last line of each part and its line count. No readings yet (docs/PLAN-DIAG.md level 2).
func WriteDigest(w io.Writer, r *Reader) error {
	d, err := r.Digest()
	if err != nil {
		return err
	}
	f := &r.Scan.File
	p := func(format string, a ...any) { fmt.Fprintf(w, format, a...) }
	p("Diagnostic dump file %s\n", f.Name)
	if f.Release != "" {
		p("  %s\n", f.Release)
	}
	switch {
	case f.Version == "":
		p("  version unknown: read with the 19c rules\n")
	case f.Tested:
		p("  version %s (the version the rules were tested on)\n", f.Version)
	default:
		p("  version %s: read with the 19c rules, which were tested on 19.x only\n", f.Version)
	}
	if in := f.Incident; in != nil {
		p("  incident file")
		if in.ID != "" {
			p(" %s", in.ID)
		}
		if in.Problem != "" {
			p(" (%s)", in.Problem)
		}
		p("\n")
		if in.DumpFile != "" {
			p("  dump file: %s\n", in.DumpFile)
		}
		if in.ContinuedFrom != "" {
			p("  continued from: %s\n", in.ContinuedFrom)
		}
	}
	p("  %s lines, %s at the top level", thousands(f.Lines), pluralN(f.OutlineTotal, "part"))
	if n := len(f.Sections); n > 0 {
		p(", %s", pluralN(n, "diagnostic dump section"))
	}
	p("\n")
	if f.Records10046 > 0 {
		p("  %s lines of 10046 records (read it as a SQL trace for them)\n", thousands(f.Records10046))
	}
	if f.Unplaced > 0 {
		p("  %s lines in no known part (they are in the parts called Other lines)\n", thousands(f.Unplaced))
	}
	p("\nOutline: first-last line, number of lines, title\n")
	width := len(strconv.Itoa(f.Lines))
	lw := len(thousands(f.Lines))
	row := func(indent int, n Node) {
		rng := fmt.Sprintf("%*d-%*d", width, n.From, width, n.To)
		cut := ""
		if n.Cut {
			cut = " (cut short)"
		}
		sub := ""
		if n.Sub != "" {
			sub = "  [" + n.Sub + "]"
		}
		p("%s%s  %*s  %s%s%s\n", strings.Repeat("  ", indent), rng, lw, thousands(n.Lines), n.Title, cut, sub)
	}
	for _, dn := range d.Outline {
		row(0, dn.Node)
		for _, c := range dn.Children {
			row(1, c)
		}
		if dn.More > 0 {
			p("    ... %s more parts not listed\n", thousands(dn.More))
		}
	}
	return nil
}

func thousands(n int) string {
	s := strconv.Itoa(n)
	if len(s) <= 3 {
		return s
	}
	var b strings.Builder
	for i, c := range s {
		if i > 0 && (len(s)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return b.String()
}
