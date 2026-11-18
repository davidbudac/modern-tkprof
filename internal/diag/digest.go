package diag

import (
	"encoding/json"
	"fmt"
	"io"
	"strconv"
	"strings"
)

// DigestChildren is how many children of a node the digest lists (the rest are counted).
const DigestChildren = 100

const (
	// DigestReadings is how many nodes of the digest get a reading in it (the first ones in file order); the
	// nodes are the top-level nodes and their listed children that have one (Node.Reading).
	DigestReadings = 200
	// DigestReadingBytes bounds the JSON of the readings of a digest: readings are added in file order until
	// the next would pass it.
	DigestReadingBytes = 8 << 20
)

// Digest is the outline of a file to a fixed depth: every node of the top level with its own children
// (one level down), and the readings of those nodes that have one. It is what a client without a server
// shows (the standalone HTML report) and what the text report prints.
type Digest struct {
	Outline []DigestNode `json:"outline"`
	// Readings are the readings of the nodes of Outline (top level and listed children) that have one, by
	// node id: the first DigestReadings of them in file order, as long as their JSON stays under
	// DigestReadingBytes. A heap dump nested deeper in a section (inside an errorstack, inside a banner of a
	// PGA summary) is not here: the client asks api/diag/reading for it. Each value is the JSON of the
	// reading, as api/diag/reading answers it ({"kind": ..., ...}).
	Readings map[string]json.RawMessage `json:"readings,omitempty"`
	// ReadingsOmitted counts the nodes with a reading that did not get one (the bounds above).
	ReadingsOmitted int `json:"readingsOmitted,omitempty"`

	rd map[string]Reading // the same readings, typed (a digest made here, not one decoded from JSON)
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
	size := 0
	for _, n := range d.readingNodes() {
		if len(d.Readings) >= DigestReadings {
			d.ReadingsOmitted++
			continue
		}
		rd, err := r.Reading(n.ID)
		if err != nil { // a node whose lines are no reading's (cannot happen for a node of the scan): none
			d.ReadingsOmitted++
			continue
		}
		b, err := json.Marshal(rd)
		if err != nil {
			return nil, err
		}
		if size+len(b) > DigestReadingBytes {
			d.ReadingsOmitted++
			continue
		}
		size += len(b)
		if d.Readings == nil {
			d.Readings = map[string]json.RawMessage{}
			d.rd = map[string]Reading{}
		}
		d.Readings[n.ID] = b
		d.rd[n.ID] = rd
	}
	return d, nil
}

// WriteDigest writes the text digest of a file: its facts, then the outline to two levels, with the first
// and last line of each part and its line count, and under each part that has one its reading (heap totals and
// the check against them, the PGA tables).
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
	opts := textOpts{many: countHeaps(d) > manyHeaps}
	for _, dn := range d.Outline {
		row(0, dn.Node)
		if rd, ok := d.rd[dn.ID]; ok {
			writeReading(w, "    ", rd, opts)
		}
		for _, c := range dn.Children {
			row(1, c)
			if rd, ok := d.rd[c.ID]; ok {
				writeReading(w, "      ", rd, opts)
			}
		}
		if dn.More > 0 {
			p("    ... %s more parts not listed\n", thousands(dn.More))
		}
	}
	if d.ReadingsOmitted > 0 {
		p("\n%s of the parts that have a reading are shown without it (the digest holds at most %d readings, %d MB of them)\n", thousands(d.ReadingsOmitted), DigestReadings, DigestReadingBytes>>20)
	}
	return nil
}

// countHeaps counts the heap dumps of the top level of the digest.
func countHeaps(d *Digest) int {
	n := 0
	for _, dn := range d.Outline {
		if dn.Kind == "heap" {
			n++
		}
	}
	return n
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
