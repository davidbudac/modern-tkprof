package diag

import (
	"fmt"
	"io"
	"strings"
)

// The text of a reading, for the digest (docs/PLAN-DIAG.md § Clients: text and UI equal in numbers). The
// numbers are those of the reading, formatted with thousands separators; a list a reading bounds is printed
// to a shorter bound here (the digest of a file with many heaps would be long), and says so.

const (
	// DigestComments is how many comments of a heap the text digest lists (DigestCommentsMany when the file
	// holds more than manyHeaps heaps).
	DigestComments     = 15
	DigestCommentsMany = 5
	// DigestSubheaps is how many sub-heaps of a heap the text digest lists (DigestSubheapsMany likewise).
	DigestSubheaps     = 8
	DigestSubheapsMany = 3
	manyHeaps          = 12
	digestBuckets      = 6
	digestVariants     = 6
)

// textOpts carries what the text of a reading depends on.
type textOpts struct {
	many bool // the file holds many heap dumps: shorter lists
}

// writeReading writes the text of a reading, every line indented by indent.
func writeReading(w io.Writer, indent string, rd Reading, o textOpts) {
	switch x := rd.(type) {
	case *HeapReading:
		writeHeapText(w, indent, x, o)
	case *PGASummary:
		writePGASummaryText(w, indent, x)
	case *PGADetail:
		writePGADetailText(w, indent, x)
	}
}

// table aligns rows into columns: cells[i][j]; right[j] right-aligns column j.
func table(w io.Writer, indent string, rows [][]string, right ...bool) {
	if len(rows) == 0 {
		return
	}
	width := make([]int, 0, 8)
	for _, r := range rows {
		for j, c := range r {
			for len(width) <= j {
				width = append(width, 0)
			}
			if n := len([]rune(c)); n > width[j] {
				width[j] = n
			}
		}
	}
	for _, r := range rows {
		var b strings.Builder
		b.WriteString(indent)
		for j, c := range r {
			pad := width[j] - len([]rune(c))
			isRight := j < len(right) && right[j]
			if j == len(r)-1 && !isRight { // no trailing blanks
				b.WriteString(c)
				break
			}
			if isRight {
				b.WriteString(strings.Repeat(" ", pad))
				b.WriteString(c)
			} else {
				b.WriteString(c)
				b.WriteString(strings.Repeat(" ", pad))
			}
			if j < len(r)-1 {
				b.WriteString("  ")
			}
		}
		fmt.Fprintln(w, strings.TrimRight(b.String(), " "))
	}
}

func th64(n int64) string {
	neg := n < 0
	if neg {
		n = -n
	}
	s := thousands64(n)
	if neg {
		return "-" + s
	}
	return s
}

func thousands64(n int64) string {
	s := fmt.Sprintf("%d", n)
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

func pct(part, whole int64) string {
	if whole <= 0 {
		return ""
	}
	return fmt.Sprintf("%.1f%%", 100*float64(part)/float64(whole))
}

func optInt(p *int) string {
	if p == nil {
		return "?"
	}
	return fmt.Sprint(*p)
}

// nodeLines is "lines 934-1344" of a node id.
func nodeLines(id string) string {
	_, from, to, _, _, err := parseID(id)
	if err != nil {
		return ""
	}
	return fmt.Sprintf("lines %d-%d", from, to)
}

// countText: "1 chunk", "217 chunks" (unit as the reading has it, plural).
func countText(n int, unit string) string {
	if n == 1 {
		switch unit {
		case "chunks", "heaps", "extents":
			unit = unit[:len(unit)-1]
		case "processes":
			unit = "process"
		}
	}
	return thousands64(int64(n)) + " " + unit
}

func commentText(c string) string {
	if c == "" {
		return "(no comment)"
	}
	return c
}

func writeHeapText(w io.Writer, ind string, h *HeapReading, o textOpts) {
	p := func(f string, a ...any) { fmt.Fprintf(w, ind+f+"\n", a...) }
	p("Reading: heap %q, desc %s, depth %s, pdb id %s", h.Name, h.Desc, optInt(h.Depth), optInt(h.PDB))
	if h.Parent != "" {
		pn := ""
		if h.ParentNode != "" {
			pn = " (dumped at " + nodeLines(h.ParentNode) + ")"
		}
		p("  parent heap %s%s", h.Parent, pn)
	}
	p("  %s, %s, %s bytes in the extents", countText(h.Extents, "extents"), countText(h.Chunks, "chunks"), th64(h.Bytes))
	f := h.Flags
	if f.PDBFiltered != nil {
		p("  taken inside a PDB: only the chunks clearly belonging to pdb id %d are dumped", *f.PDBFiltered)
	}
	if f.Sampled {
		s := "  sampled heap: only some extents are listed"
		if f.SampledPercent > 0 {
			s += fmt.Sprintf(" (the heap has %d percent free memory)", f.SampledPercent)
		}
		p("%s", s)
	}
	if f.NoExtents {
		p("  the header has no extents")
	}
	if f.Contents != nil {
		p("  memory contents present: %s \"Dump of memory\" blocks, %s lines skipped", thousands64(int64(f.Contents.Blocks)), thousands64(int64(f.Contents.Lines)))
	}
	if f.Cut {
		p("  the dump is cut short")
	}
	p("  Checked against the totals the dump prints:")
	lastReason := ""
	for _, c := range h.Checks {
		switch c.State {
		case CheckMatch:
			p("    match   %s: %s = %s (line %d)", c.What, th64(c.Computed), th64(*c.Printed), c.Line)
		case CheckDiffer:
			p("    DIFFER  %s: computed %s, printed %s, difference %s (line %d)", c.What, th64(c.Computed), th64(*c.Printed), signed(c.Diff), c.Line)
		default:
			reason := c.Reason
			if reason == lastReason {
				reason = "for the same reason"
			}
			lastReason = c.Reason
			if c.Printed != nil {
				reason += fmt.Sprintf(" (the dump prints %s at line %d)", th64(*c.Printed), c.Line)
			}
			p("    none    %s: %s", c.What, reason)
		}
	}
	if len(h.ByType) > 0 {
		p("  By type:")
		rows := [][]string{{"type", "chunks", "bytes", "share"}}
		for _, t := range h.ByType {
			rows = append(rows, []string{t.Type, thousands64(int64(t.Chunks)), th64(t.Bytes), pct(t.Bytes, h.Bytes)})
			for i, v := range t.Variants {
				if i >= digestVariants {
					rows = append(rows, []string{"  ...", "", "", ""})
					break
				}
				rows = append(rows, []string{"  " + v.Type, thousands64(int64(v.Chunks)), th64(v.Bytes), pct(v.Bytes, h.Bytes)})
			}
		}
		table(w, ind+"    ", rows, false, true, true, true)
	}
	if len(h.ByComment) > 0 {
		nc := DigestComments
		if o.many {
			nc = DigestCommentsMany
		}
		shown := min(nc, len(h.ByComment))
		p("  By comment (%d of %s, most bytes first):", shown, thousands64(int64(h.Comments)))
		rows := [][]string{{"comment", "types", "chunks", "bytes", "share", "first line"}}
		for _, c := range h.ByComment[:shown] {
			ts := make([]string, 0, len(c.Types))
			for _, t := range c.Types {
				ts = append(ts, t.Type)
			}
			name := commentText(c.Comment)
			if c.Suffixes > 0 {
				name += fmt.Sprintf(" (%s ^suffixes)", thousands64(int64(c.Suffixes)))
			}
			rows = append(rows, []string{name, strings.Join(ts, ","), thousands64(int64(c.Chunks)), th64(c.Bytes), pct(c.Bytes, h.Bytes), fmt.Sprint(c.Line)})
		}
		table(w, ind+"    ", rows, false, false, true, true, true, true)
		var restC int
		var restB int64
		for _, c := range h.ByComment[shown:] {
			restC += c.Chunks
			restB += c.Bytes
		}
		if rest := len(h.ByComment) - shown; rest > 0 {
			p("    %s more comments listed in the reading: %s chunks, %s bytes", thousands64(int64(rest)), thousands64(int64(restC)), th64(restB))
		}
		if h.OtherComments != nil {
			oc := h.OtherComments
			p("    other: %s more comments, %s chunks, %s bytes (the reading lists the %d largest)", thousands64(int64(oc.Count)), thousands64(int64(oc.Chunks)), th64(oc.Bytes), CommentCap)
		}
	}
	writeFreeText(w, ind, h)
	if h.Permanent != nil {
		s := fmt.Sprintf("  Permanent chunks (line %d): %s perm chunks, %s bytes", h.Permanent.Line, thousands64(int64(h.Permanent.Chunks)), th64(h.Permanent.Bytes))
		p("%s", s)
	}
	if u := h.Unpinned; u != nil {
		p("  Unpinned space (line %d): %s bytes, rcr=%s trn=%s", u.Line, th64(u.Bytes), thousands64(int64(u.Rcr)), thousands64(int64(u.Trn)))
	}
	ns := DigestSubheaps
	if o.many {
		ns = DigestSubheapsMany
	}
	if h.SubTotal > 0 {
		shown := min(ns, len(h.Subheaps))
		p("  Sub-heaps: %s (%d largest listed)", thousands64(int64(h.SubTotal)), shown)
		rows := [][]string{{"name", "desc", "size", "held here", "chunks", "extents", "dump"}}
		for _, s := range h.Subheaps[:shown] {
			size := "?"
			if s.Size > 0 {
				size = th64(s.Size)
			}
			rows = append(rows, []string{commentText(s.Name), s.Desc, size, th64(s.Held), thousands64(int64(s.Chunks)), extentsText(s.Extents), nodeLines(s.Node)})
		}
		table(w, ind+"    ", rows, false, false, true, true, true, true)
	}
	if len(h.Largest) > 0 {
		p("  Largest sub-heaps the dump names:")
		rows := [][]string{}
		for _, l := range h.Largest {
			rows = append(rows, []string{commentText(l.Name), l.Desc, th64(l.Size), nodeLines(l.Node)})
		}
		table(w, ind+"    ", rows, false, false, true)
	}
}

func extentsText(n int) string {
	if n == 0 {
		return "?"
	}
	return thousands64(int64(n))
}

func signed(n int64) string {
	if n > 0 {
		return "+" + th64(n)
	}
	return th64(n)
}

func writeFreeText(w io.Writer, ind string, h *HeapReading) {
	fl := h.FreeLists
	if !fl.Present {
		return
	}
	p := func(f string, a ...any) { fmt.Fprintf(w, ind+f+"\n", a...) }
	used := 0
	for _, b := range fl.Buckets {
		if b.Chunks > 0 {
			used++
		}
	}
	p("  Free lists (line %d): %s chunks, %s bytes in %d of %d buckets", fl.Line, thousands64(int64(fl.Chunks)), th64(fl.Bytes), used, len(fl.Buckets))
	rows := [][]string{}
	shown := 0
	// the buckets with the most bytes first
	order := make([]HeapBucket, 0, used)
	for _, b := range fl.Buckets {
		if b.Chunks > 0 {
			order = append(order, b)
		}
	}
	sortBuckets(order)
	for _, b := range order {
		if shown >= digestBuckets {
			break
		}
		rows = append(rows, []string{fmt.Sprintf("bucket %d", b.N), "size " + th64(b.Size), countText(b.Chunks, "chunks"), th64(b.Bytes) + " bytes"})
		shown++
	}
	table(w, ind+"    ", rows, false, true, true, true)
	if used > shown {
		p("    %d more buckets hold chunks", used-shown)
	}
	for _, r := range fl.Reserved {
		p("  %s (line %d): %s chunks, %s bytes", r.Title, r.Line, thousands64(int64(r.Chunks)), th64(r.Bytes))
	}
}

func sortBuckets(b []HeapBucket) {
	for i := 1; i < len(b); i++ {
		for j := i; j > 0 && (b[j].Bytes > b[j-1].Bytes || b[j].Bytes == b[j-1].Bytes && b[j].N < b[j-1].N); j-- {
			b[j], b[j-1] = b[j-1], b[j]
		}
	}
}

func useRowCells(u PGAUse, withPct bool) []string {
	row := []string{}
	if withPct {
		if u.Percent != nil {
			row = append(row, fmt.Sprintf("%d%%", *u.Percent))
		} else {
			row = append(row, "")
		}
	}
	row = append(row, u.Size.Text, countText(u.Count, u.Unit), commentText(u.Comment), u.Category, u.Heap, u.DS, u.DSParent)
	return row
}

func writePGASummaryText(w io.Writer, ind string, s *PGASummary) {
	p := func(f string, a ...any) { fmt.Fprintf(w, ind+f+"\n", a...) }
	p("Reading: PGA memory summary")
	p("  %s", s.Note)
	if len(s.Top) > 0 {
		p("  Top uses of memory by this process (line %d): share, size, count, comment, category, heap, ds, parent ds", s.TopLine)
		rows := [][]string{}
		for _, u := range s.Top {
			rows = append(rows, useRowCells(u, true))
		}
		table(w, ind+"    ", rows, true, true, true)
	}
	for _, b := range s.Private {
		p("  %s (line %d): %s total", b.Title, b.Line, b.Total.Text)
		var parts []string
		if b.Commented != nil {
			parts = append(parts, b.Commented.Text+" commented")
		}
		if b.Permanent != nil {
			parts = append(parts, b.Permanent.Text+" permanent")
		}
		if b.Free != nil {
			f := b.Free.Text + " free"
			if b.EmptyExt != nil {
				f += " (" + b.EmptyExt.Text + " in empty extents)"
			}
			parts = append(parts, f)
		}
		if len(parts) > 0 {
			p("    %s", strings.Join(parts, ", "))
		}
		rows := [][]string{}
		for _, r := range b.Rows {
			fh := ""
			if r.FreeHeld != nil {
				fh = r.FreeHeld.Text + " free held"
			}
			rows = append(rows, []string{r.Size.Text, countText(r.Count, r.Unit), commentText(r.Comment), fh})
		}
		table(w, ind+"    ", rows, true, true)
	}
	if len(s.Instance) > 0 {
		p("  Instance-wide private memory usage:")
		rows := [][]string{}
		for _, i := range s.Instance {
			rows = append(rows, []string{i.Scope, i.Name, i.Value})
		}
		table(w, ind+"    ", rows, false, false, true)
	}
	if pr := s.Processes; pr != nil {
		head := fmt.Sprintf("  Private memory usage per Oracle process (line %d)", pr.Line)
		if pr.TotalAllocated != nil {
			head += ", percentages of " + pr.TotalAllocated.Text + " allocated"
		}
		if pr.MGA != "" {
			head += "; MGA used size accounted under PGA values = " + pr.MGA
		}
		p("%s", head)
		writeProcs(w, ind, "Top processes", pr.TopProcs, true)
		writeProcs(w, ind, "All processes", pr.AllProcs, false)
		if pr.AllOmitted > 0 {
			p("    ... %d more processes not listed", pr.AllOmitted)
		}
	}
	if e := s.Estimated; e != nil {
		p("  Estimated memory uses for all processes (line %d), from %d snapshots out of %d processes: share, size, processes, comment, category, heap, chunks", e.Line, e.Snapshots, e.Processes)
		rows := [][]string{}
		for _, u := range e.Rows {
			row := useRowCells(u, true)
			row = row[:len(row)-2] // no ds on these rows
			chunks := ""
			if u.Chunks > 0 {
				chunks = countText(u.Chunks, "chunks")
			}
			rows = append(rows, append(row, chunks))
		}
		table(w, ind+"    ", rows, true, true, true)
		if e.Omitted > 0 {
			p("    ... %d more rows not listed", e.Omitted)
		}
	}
	if len(s.Swap) > 0 {
		p("  Swap information:")
		rows := [][]string{}
		for _, k := range s.Swap {
			rows = append(rows, []string{k.Name, k.Value})
		}
		table(w, ind+"    ", rows)
	}
}

func writeProcs(w io.Writer, ind, title string, procs []PGAProc, withPct bool) {
	if len(procs) == 0 {
		return
	}
	fmt.Fprintf(w, "%s    %s (%d): ospid, name, used, allocated, freeable\n", ind, title, len(procs))
	rows := [][]string{}
	for _, pr := range procs {
		name := pr.Name
		if pr.PDB != "" {
			name = strings.TrimSpace(name + " (pdb " + pr.PDB + ")")
		}
		free := ""
		if pr.Freeable != nil {
			free = pr.Freeable.Text
		}
		row := []string{}
		if withPct {
			if pr.Percent != nil {
				row = append(row, fmt.Sprintf("%d%%", *pr.Percent))
			} else {
				row = append(row, "")
			}
		}
		row = append(row, pr.OSPid, name, pr.Used.Text, pr.Alloc.Text, free)
		rows = append(rows, row)
	}
	right := []bool{false, false, false, true, true, true}
	if withPct {
		right = []bool{true, false, false, true, true, true}
	}
	table(w, ind+"      ", rows, right...)
	for _, pr := range procs {
		if s := pr.Session; s != nil {
			sql := s.CurrentSQL
			if sql == "" || sql == "<none>" {
				sql = "no current SQL"
			} else {
				sql = "current SQL: " + trunc(sql, 100)
			}
			fmt.Fprintf(w, "%s      session of ospid %s (lines %d-%d): sid %d serial %d, user %s, pdb %s, %s\n", ind, pr.OSPid, s.From, s.To, s.Sid, s.Serial, s.User, s.PDB, sql)
		}
	}
}

func writePGADetailText(w io.Writer, ind string, d *PGADetail) {
	p := func(f string, a ...any) { fmt.Fprintf(w, ind+f+"\n", a...) }
	head := "Reading: PGA memory detail"
	if d.Pid > 0 {
		head += fmt.Sprintf(" for pid %d, OS pid %d", d.Pid, d.OSPid)
	}
	p("%s", head)
	p("  %s rows, %s chunks, %s bytes: the largest uses of this process, with exact bytes (a listing, not a total)", thousands64(int64(len(d.Rows))), thousands64(int64(d.Chunks)), th64(d.Bytes))
	rows := [][]string{{"bytes", "chunks", "comment", "category", "heap", "ds", "parent ds"}}
	for _, u := range d.Rows {
		rows = append(rows, []string{th64(u.Size.Bytes), thousands64(int64(u.Count)), commentText(u.Comment), u.Category, u.Heap, u.DS, u.DSParent})
	}
	table(w, ind+"  ", rows, true, true)
	if d.Omitted > 0 {
		p("  ... %d more rows not listed", d.Omitted)
	}
}
