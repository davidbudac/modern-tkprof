package cut

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// item is one line of the new file.
type item struct {
	label byte // 'K' kept, 'E' kept to finish a call (outside the window), 'H' header, 'B' borrowed (before), 'A' borrowed (after), 'G' generated
	file  int32
	line  int32 // source line; 0 for a generated line
	text  []byte
	start *Piece // this line begins a piece (borrowed and generated blocks; nil for kept lines)
	ts    bool   // the generated timestamp, written once the anchor tim is known
	cond  bool   // ts: only when lines were left out before the anchor tim (markerAnchor)
	tim   bool   // a restated PARSING IN CURSOR line whose tim= is set to the anchor tim
}

// sink receives the lines of the new file in order.
type sink interface{ put(it *item) error }

// the attributes a session context carries, in marker order
var attrKinds = []trace.MarkerKind{trace.MarkerSessionID, trace.MarkerClientID, trace.MarkerServiceName, trace.MarkerModuleName,
	trace.MarkerActionName, trace.MarkerClientDriver, trace.MarkerContainerID}

func ctxAttrs(cx *model.Context) [7]string {
	return [7]string{cx.SessionID, cx.ClientID, cx.Service, cx.Module, cx.Action, cx.ClientDriver, cx.ContainerID}
}

func attrIndex(k trace.MarkerKind) int {
	for i, a := range attrKinds {
		if a == k {
			return i
		}
	}
	return -1
}

// emitter assembles the new file: kept lines in source order, with what they
// need inserted before them. After a break in the source (the start, a gap
// the source re-anchored its clock in, a process switch) it holds the lines
// back until the first line carrying a tim, so that the generated timestamp
// and the restated cursors can be given that tim.
type emitter struct {
	c   *Cutter
	sel *Selection
	s   *selected
	out sink

	lastFile, lastLine int32
	lastPK             int
	started            bool
	attrs              [7]string
	attrsDirty         bool
	anchorNeeded       bool
	waiting            bool
	gapped             bool // lines were left out while waiting
	copySwitch         bool // the record being prepared is the source's own process switch line
	pending            []*item
	bound              map[uint64]model.ID // cursor number -> the instance the new file has open
	anchorCtx          []model.ID          // per file: a context of it (wall-clock conversion)
	err                error
}

func (o *emitter) put(it *item) {
	if o.err != nil {
		return
	}
	if o.waiting {
		o.pending = append(o.pending, it)
		return
	}
	o.err = o.out.put(it)
}

// copyLine passes a source line through; tim > 0 resolves a pending anchor.
func (o *emitter) copyLine(label byte, f, ln int32, b []byte, tim int64) {
	it := &item{label: label, file: f, line: ln}
	if o.waiting {
		it.text = append([]byte(nil), b...)
	} else {
		it.text = b
	}
	o.put(it)
	o.lastFile, o.lastLine = f, ln
	if tim > 0 && o.waiting {
		o.resolve(f, ln, tim)
	}
}

// resolve writes the pending lines: the timestamp gets the wall clock of tim
// at (f, ln), restated cursors tim=tim.
func (o *emitter) resolve(f, ln int32, tim int64) {
	m := o.c.m
	wall := int64(0)
	if cx := o.anchorCtx[f]; cx != model.None {
		wall = m.CallWall(&model.Call{Context: cx, Line: ln, Tim: tim})
	}
	zone := time.UTC
	if fi, err := o.c.idx.file(int(f)); err == nil && fi.zone != nil {
		zone = fi.zone
	}
	o.waiting = false
	pend := o.pending
	o.pending = nil
	for _, it := range pend {
		switch {
		case it.ts && (wall == 0 || it.cond && !o.gapped):
			continue
		case it.ts:
			it.text = []byte("*** " + time.UnixMicro(wall).In(zone).Format("2006-01-02T15:04:05.000000-07:00"))
		case it.tim:
			it.text = timRe.ReplaceAll(it.text, []byte("tim="+strconv.FormatInt(tim, 10)))
		}
		o.put(it)
	}
}

// flush ends a wait without a tim (the section had none): no timestamp.
func (o *emitter) flush() {
	if !o.waiting {
		return
	}
	o.waiting = false
	pend := o.pending
	o.pending = nil
	for _, it := range pend {
		if !it.ts {
			o.put(it)
		}
	}
}

var timRe = regexp.MustCompile(`tim=\d+`)

// lineTim reads tim= (and the call's e= or the wait's ela=) of a record line.
func lineTim(b []byte) (tim, dur int64) {
	if i := bytes.LastIndex(b, []byte("tim=")); i >= 0 {
		tim = leadingInt(b[i+4:])
	}
	if i := bytes.Index(b, []byte(",e=")); i >= 0 {
		dur = leadingInt(b[i+3:])
	} else if i := bytes.Index(b, []byte(" ela= ")); i >= 0 {
		dur = leadingInt(b[i+6:])
	}
	return
}

func leadingInt(b []byte) int64 {
	var v int64
	for _, c := range b {
		if c < '0' || c > '9' {
			break
		}
		v = v*10 + int64(c-'0')
	}
	return v
}

// cursorNum reads the #n of a record line ("EXEC #n:", "WAIT #n:", "BINDS #n:", "STAT #n ", "PARSING IN CURSOR #n ").
func cursorNum(b []byte) (uint64, bool) {
	i := bytes.IndexByte(b, '#')
	if i < 0 {
		return 0, false
	}
	var v uint64
	j := i + 1
	for ; j < len(b) && b[j] >= '0' && b[j] <= '9'; j++ {
		v = v*10 + uint64(b[j]-'0')
	}
	return v, j > i+1
}

// prepare runs before a kept record's first line: process switch, the
// session markers and the cursor it needs, and the anchor.
func (o *emitter) prepare(f, ln int32, pk int, pid string, kind trace.Kind, b []byte) {
	s := o.s
	gap := !o.started || o.lastFile != f || ln != o.lastLine+1
	if gap && o.waiting {
		o.gapped = true
	}
	if o.copySwitch {
		o.copySwitch = false
		if !o.started || pk != o.lastPK {
			o.flush()
			o.attrsDirty, o.anchorNeeded = true, true
			o.started, o.lastPK = true, pk
		}
	} else if s.multiP && (!o.started || pk != o.lastPK) {
		o.flush()
		v := pid
		if v == "" {
			v = leadingDigits(o.c.m.File.Files[f].ProcessPID)
		}
		o.put(&item{label: 'G', file: f, text: []byte("*** [ Unix process pid: " + v + " ]"),
			start: &Piece{Kind: "generated", Title: "Process switch " + v, File: int(f),
				Reason: "The trcsess session-switch line: tkprof and mtkprof start another process here, so the cursor numbers of the two processes never mix."}})
		o.attrsDirty, o.anchorNeeded = true, true
	}
	if gap {
		o.attrsDirty = true
		if !o.started || o.lastFile != f || pk != o.lastPK {
			o.anchorNeeded = true
		} else if fi, err := o.c.idx.file(int(f)); err == nil && fi.timedBetween(o.lastLine, ln) {
			o.anchorNeeded = true
		}
	}
	o.started, o.lastPK = true, pk
	switch kind {
	case trace.KindMarker, trace.KindSeparator, trace.KindBlank:
		return
	}
	if o.attrsDirty {
		o.attrsDirty = false
		o.borrowAttrs(f, ln, pk, pid)
	}
	if o.anchorNeeded {
		o.anchorAfter(f, false, "Anchors the wall clock: it is the wall time of the next line with a tim, so wall times in the new file equal the source's.")
	}
	if kind == trace.KindParsingInCursor {
		if num, ok := cursorNum(b); ok {
			o.bound[num] = o.c.idx.cursorAt(int(f), num, ln)
		}
		return
	}
	if num, ok := cursorNum(b); ok && num != 0 {
		cur := o.c.idx.cursorAt(int(f), num, ln)
		if was, ok := o.bound[num]; cur != model.None && (!ok || was != cur) {
			if o.c.idx.restatable(cur) && !o.adoptedInCut(cur, pk) {
				o.restate(cur, f, ln, b)
			}
			o.bound[num] = cur
		}
	}
}

// adoptedInCut: the cursor was open before tracing started and is adopted
// by a later PARSING IN CURSOR that the new file keeps; the parser adopts it
// there again, so nothing is restated (a cut of everything stays the source).
func (o *emitter) adoptedInCut(cur model.ID, pk int) bool {
	at, ok := o.c.idx.adoption(cur)
	return ok && pk >= 0 && o.c.idx.cursorFile(cur) == o.s.pks[pk].file && inSpans(o.s.spans[pk], int32(at))
}

func leadingDigits(s string) string {
	i := 0
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return s[:i]
}

// borrowAttrs writes the session markers whose values the new file does not
// have yet: the source's own lines when they exist, else generated ones.
func (o *emitter) borrowAttrs(f, ln int32, pk int, pid string) {
	cx := o.c.contextAt(o.s, pk, ln)
	if cx == nil {
		return
	}
	want := ctxAttrs(cx)
	fi, _ := o.c.idx.file(int(f))
	var lines []int32
	var texts [][]byte
	var gen []string
	timed := false
	for i, k := range attrKinds {
		if want[i] == o.attrs[i] {
			continue
		}
		o.attrs[i] = want[i]
		if fi != nil {
			if mk := fi.latest(k, ln, &want[i]); mk != nil {
				lines = append(lines, mk.line)
				texts = append(texts, []byte(mk.text))
				timed = timed || mk.timed
				continue
			}
		}
		if want[i] == "" {
			continue
		}
		gen = append(gen, fmt.Sprintf("*** %s:(%s)", k, want[i]))
	}
	if len(lines) > 0 {
		order := make([]int, len(lines))
		for i := range order {
			order[i] = i
		}
		sort.SliceStable(order, func(a, b int) bool { return lines[order[a]] < lines[order[b]] })
		var refs []int32
		for _, i := range order {
			refs = append(refs, lines[i])
		}
		p := &Piece{Kind: "before", Title: "Session markers", File: int(f), Lines: refs,
			Reason: fmt.Sprintf("The session attributes in force at line %d, each the latest of its kind before it: the new file knows its session, module and action.", ln)}
		for j, i := range order {
			it := &item{label: 'B', file: f, line: lines[i], text: texts[i]}
			if j == 0 {
				it.start = p
			}
			o.put(it)
		}
	}
	if len(gen) > 0 {
		p := &Piece{Kind: "generated", Title: "Session markers", File: int(f),
			Reason: "Session attributes the source never wrote as a marker line (trcsess rewrites them to bare timestamps); generated from the session's context."}
		for j, g := range gen {
			it := &item{label: 'G', file: f, text: []byte(g)}
			if j == 0 {
				it.start = p
			}
			o.put(it)
		}
	}
	if timed {
		o.anchorAfter(f, false, "Anchors the wall clock: the borrowed markers carry their own (earlier) times, so the next line with a tim gets a timestamp of its own.")
	}
}

// restate copies a cursor's PARSING IN CURSOR block in front of its first use in the new file.
func (o *emitter) restate(cur model.ID, f, ln int32, use []byte) {
	lines, from, err := o.c.idx.parsingBlock(cur)
	if err != nil || len(lines) == 0 {
		return
	}
	m := o.c.m
	cf := int32(o.c.idx.cursorFile(cur))
	st := &m.Statements[m.Cursors[cur].Statement]
	what := string(use)
	if i := bytes.IndexAny(use, " #:"); i > 0 {
		what = string(use[:i])
	}
	p := &Piece{Kind: "before", Title: "Cursor " + sqlName(st), File: int(cf), SQL: st.SQLID,
		Reason: fmt.Sprintf("Parsed at line %d, before the cut. The kept lines use it, so its SQL text is restated right before its first use (line %d: %s); tim= is set to the time of the lines after it.",
			m.Cursors[cur].Line, ln, what)}
	if !o.waiting {
		o.waiting = true // hold the block until the next tim, which its tim= takes (no timestamp needed)
	}
	for i, l := range lines {
		it := &item{label: 'B', file: cf, line: int32(from + i), text: l}
		if i == 0 {
			it.start = p
		}
		it.tim = bytes.HasPrefix(l, []byte("PARSING IN CURSOR"))
		o.put(it)
	}
}

func sqlName(st *model.Statement) string {
	if st.SQLID != "" {
		return st.SQLID
	}
	return fmt.Sprintf("hv %d", st.HV)
}

// insertPlans writes the STAT lines borrowed for the cursors whose last kept call was just copied.
func (o *emitter) insertPlans(f, ln int32) {
	ids := o.s.borrowedPlans[fileLine{f, ln}]
	m := o.c.m
	for _, id := range ids {
		pl := &m.Plans[id]
		lines, err := o.c.idx.readLines(int(f), pl.Line, int(pl.N))
		if err != nil || len(lines) == 0 {
			continue
		}
		st := &m.Statements[pl.Statement]
		lab := o.s.planLabel[id]
		kind, when := "after", "when the cursor closed, after the cut"
		if lab == 'B' {
			kind, when = "before", "before the cut (the kept executions have no dump of their own)"
		}
		p := &Piece{Kind: kind, Title: "Plan of " + sqlName(st), File: int(f), SQL: st.SQLID,
			Reason: fmt.Sprintf("STAT lines dumped at line %d, %s. Placed after the cursor's last kept call (line %d), so the new file keeps the row-source statistics.", pl.Line, when, ln)}
		for i, l := range lines {
			it := &item{label: lab, file: f, line: int32(pl.Line + i), text: l}
			if i == 0 {
				it.start = p
			}
			o.put(it)
		}
	}
}

// contextAt is the context of process pk in force at line ln: the last one
// announced at or before it (the first one of the process before that).
func (c *Cutter) contextAt(s *selected, pk int, ln int32) *model.Context {
	if pk < 0 || pk >= len(s.ctxByPK) || len(s.ctxByPK[pk]) == 0 {
		return nil
	}
	l := s.ctxByPK[pk]
	i := sort.Search(len(l), func(i int) bool { return int32(c.m.Contexts[l[i]].Line) > ln })
	if i == 0 {
		return &c.m.Contexts[l[0]]
	}
	return &c.m.Contexts[l[i-1]]
}

// walk produces the new file into out.
func (c *Cutter) walk(ctx context.Context, sel *Selection, s *selected, out sink) error {
	m := c.m
	o := &emitter{c: c, sel: sel, s: s, out: out, bound: map[uint64]model.ID{}, lastPK: -1}
	o.anchorCtx = make([]model.ID, len(m.File.Files))
	for i := range o.anchorCtx {
		o.anchorCtx[i] = model.None
	}
	for i := len(m.Contexts) - 1; i >= 0; i-- {
		o.anchorCtx[m.Contexts[i].FileIdx] = model.ID(i)
	}
	// which files have kept lines
	has := make([]bool, len(m.File.Files))
	for p, sp := range s.spans {
		if len(sp) > 0 {
			has[s.pks[p].file] = true
		}
	}
	for f, ls := range s.keepOut {
		if len(ls) > 0 {
			has[f] = true
		}
	}
	first := -1
	for f, h := range has {
		if h {
			first = f
			break
		}
	}
	if first < 0 {
		return nil
	}
	// the header of the first file, and the provenance lines
	fi0, err := c.idx.file(first)
	if err != nil {
		return err
	}
	if fi0.body > 1 {
		hdr, err := c.idx.readLines(first, 1, fi0.body-1)
		if err != nil {
			return err
		}
		kind := "before"
		for p, sp := range s.spans {
			if s.pks[p].file == first && len(sp) > 0 && int(sp[0].from) <= fi0.body {
				kind = "kept"
			}
		}
		p := &Piece{Kind: "header", Title: "File header", File: first, Reason: "The prologue of " + m.File.Files[first].Name +
			": database version, instance, host and process. tkprof and mtkprof read it first."}
		label := byte('H')
		if kind == "kept" { // the kept lines start at the top of the file: the header is simply kept
			p.Kind, label = "kept", 'K'
			p.Reason = "The prologue of " + m.File.Files[first].Name + ", where the kept lines start."
		}
		for i, l := range hdr {
			it := &item{label: label, file: int32(first), line: int32(i + 1), text: l}
			if i == 0 {
				it.start = p
			}
			o.put(it)
		}
		if !sel.NoProvenance { // still prologue lines: the first marker comes after them
			o.provenance(sel, s)
		}
	} else if !sel.NoProvenance {
		o.provenance(sel, s)
	}
	for f, h := range has {
		if !h {
			continue
		}
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := c.walkFile(o, f); err != nil {
			return err
		}
		o.flush()
	}
	o.flush()
	return o.err
}

func (o *emitter) provenance(sel *Selection, s *selected) {
	m := o.c.m
	var names []string
	for _, f := range m.File.Files {
		names = append(names, f.Name)
	}
	var lines []string
	src := strings.Join(names, ", ")
	if len(names) > 3 {
		src = fmt.Sprintf("%s and %d more files", strings.Join(names[:3], ", "), len(names)-3)
	}
	lines = append(lines, "mtkprof cut: from "+src)
	var what []string
	if sel.From != 0 || sel.To != 0 {
		w := fmt.Sprintf("window tim %d-%d", sel.From, sel.To)
		if a, b := m.WallOf(sel.From), m.WallOf(sel.To); a != 0 && b != 0 {
			w += " (" + time.UnixMicro(a).UTC().Format("15:04:05.000000") + "-" + time.UnixMicro(b).UTC().Format("15:04:05.000000") + " UTC)"
		}
		what = append(what, w)
	}
	if sel.Statement != nil {
		what = append(what, "statement "+sqlName(&m.Statements[*sel.Statement])+" with its recursive work (its callers left out)")
	}
	if len(sel.Contexts) > 0 {
		seen := map[string]bool{}
		var ss []string
		for _, id := range sel.Contexts {
			if int(id) < len(m.Contexts) && !seen[m.Contexts[id].SessionID] {
				seen[m.Contexts[id].SessionID] = true
				ss = append(ss, m.Contexts[id].SessionID)
			}
		}
		what = append(what, "sessions "+strings.Join(ss, " "))
	}
	if len(what) == 0 {
		what = append(what, "everything")
	}
	edges := "whole calls"
	if sel.Executions {
		edges = "whole executions"
	}
	lines = append(lines, "mtkprof cut: kept "+strings.Join(what, "; ")+"; "+edges)
	opt := "binds " + map[Binds]string{BindsKeep: "kept", BindsMask: "masked", BindsNone: "left out"}[sel.Binds]
	if s.multiP {
		opt += "; processes one after another, with trcsess process switch lines"
	}
	lines = append(lines, "mtkprof cut: "+opt+"; cursors and plans the kept lines need are restated from outside the cut")
	p := &Piece{Kind: "generated", Title: "Provenance", Reason: "Written by the cut: where the file comes from and what was kept. Header lines: tkprof and mtkprof read past them."}
	for i, l := range lines {
		it := &item{label: 'G', text: []byte(l)}
		if i == 0 {
			it.start = p
		}
		o.put(it)
	}
}

// walkFile copies the kept lines of file f, inserting what they need.
func (c *Cutter) walkFile(o *emitter, f int) error {
	s, sel, m := o.s, o.sel, c.m
	fi, err := c.idx.file(f)
	if err != nil {
		return err
	}
	fh, err := os.Open(m.File.Files[f].Path)
	if err != nil {
		return err
	}
	defer fh.Close()
	var li *trace.LineIndex
	if f < len(c.lis) {
		li = c.lis[f]
	}
	r := newLineReader(fh, li)
	// the process of the first lines: the file's first context's
	pid := ""
	for i := range m.Contexts {
		if m.Contexts[i].FileIdx == f {
			pid = m.Contexts[i].Process
			break
		}
	}
	pkOf := func(pid string) int {
		if p, ok := s.pkOf[pkey{f, pid}]; ok {
			return p
		}
		return -1
	}
	pk := pkOf(pid)
	nPK := 0
	for _, k := range s.pks {
		if k.file == f {
			nPK++
		}
	}
	// where kept lines start: the reader may jump between them (one process per file only:
	// a trcsess file switches processes in lines it would skip)
	var starts []int32
	if nPK <= 1 && pk >= 0 {
		for _, sp := range s.spans[pk] {
			starts = append(starts, sp.from)
		}
		starts = append(starts, s.keepOut[f]...)
		sortLines(starts)
	}
	inSpan := func(ln int32) bool { return pk >= 0 && inSpans(s.spans[pk], ln) }
	r.seek(fi.body)
	cls := trace.NewClassifier(false)
	f32 := int32(f)
	window := sel.From != 0 || sel.To != 0
	var (
		recKeep  bool
		recKind  trace.Kind
		sepLine  int32
		sepText  []byte
		bindMask *maskState
		sql      sqlText
	)
	copyRec := func(label byte, ln int32, b []byte, tim int64) {
		o.copyLine(label, f32, ln, b, tim)
	}
	keepSep := func(keep bool, kind trace.Kind, next []byte) {
		if sepText == nil {
			return
		}
		if keep {
			o.prepare(f32, sepLine, pk, pid, kind, next)
			copyRec('K', sepLine, sepText, 0)
		}
		sepText = nil
	}
	for {
		if o.err != nil {
			return o.err
		}
		if starts != nil && !recKeep && sepText == nil && !inSpan(int32(r.line)) {
			i := sort.Search(len(starts), func(i int) bool { return starts[i] >= int32(r.line) })
			if i == len(starts) {
				break // nothing kept after this
			}
			if int(starts[i]) > r.line+4096 {
				r.seek(int(starts[i]))
				cls = trace.NewClassifier(false)
				sql.on = false
			}
		}
		lnI, b, ok := r.next()
		if !ok {
			break
		}
		ln := int32(lnI)
		if sql.on { // statement text follows its PARSING IN CURSOR line
			sql.next(b)
			if recKeep {
				copyRec('K', ln, b, 0)
			}
			continue
		}
		cls.InSQL = false
		k := cls.Next(b)
		// continuation lines follow their record
		switch k {
		case trace.KindSQLText, trace.KindEndOfStmt:
			if recKeep {
				copyRec('K', ln, b, 0)
			}
			continue
		case trace.KindBindLine, trace.KindUnknown, trace.KindBlank:
			if recKind == trace.KindBinds || recKind == trace.KindParseError || (k == trace.KindBlank && recKind != 0) {
				if recKeep {
					if bindMask != nil && recKind == trace.KindBinds {
						if out, keep := bindMask.line(b); keep {
							copyRec('K', ln, out, 0)
						}
					} else {
						copyRec('K', ln, b, 0)
					}
				}
				continue
			}
		}
		if k == trace.KindSeparator {
			keepSep(inSpan(sepLine), trace.KindSeparator, nil)
			sepLine, sepText = ln, append([]byte(nil), b...)
			recKeep, recKind = false, trace.KindSeparator
			continue
		}
		if k != trace.KindMarker {
			bindMask = nil
		}
		in := inSpan(ln)
		keep := in
		label := byte('K')
		switch k {
		case trace.KindMarker:
			inBinds := recKind == trace.KindBinds
			mk, isMk := parseMarker(b)
			if isMk && mk.kind == trace.MarkerProcess {
				pid, pk = leadingDigits(mk.value), pkOf(leadingDigits(mk.value))
				in = inSpan(ln)
				keep = in
				o.copySwitch = keep // the source's own switch line: no generated one
			}
			keepSep(keep, k, b)
			if keep {
				o.prepare(f32, ln, pk, pid, k, b)
				if isMk {
					if i := attrIndex(mk.kind); i >= 0 {
						o.attrs[i] = mk.value
					}
				}
				copyRec('K', ln, b, 0)
				if isMk && mk.timed {
					o.markerAnchor(f32)
				}
			}
			if !inBinds { // a marker inside a BINDS block does not end it (as the parser)
				recKeep, recKind = keep, k
			}
			continue
		case trace.KindParsingInCursor:
			sql.start(b)
			num, _ := cursorNum(b)
			cur := c.idx.cursorAt(f, num, ln)
			keep = in && cur >= 0 && s.ref.has(int64(cur))
		case trace.KindWait:
			if in {
				keep = !hasLine(s.dropIn[f], ln)
			} else {
				keep = hasLine(s.keepOut[f], ln)
			}
		case trace.KindBinds:
			keep = sel.Binds != BindsNone && (in || hasLine(s.keepOut[f], ln))
			if keep && sel.Binds == BindsMask {
				bindMask = &maskState{salt: sel.Salt}
			}
		case trace.KindStat:
			num, _ := cursorNum(b)
			cur := c.idx.cursorAt(f, num, ln)
			keep = in && (cur < 0 || s.ref.has(int64(cur)))
		}
		keepSep(keep && k == trace.KindParsingInCursor || (in && k != trace.KindParsingInCursor), k, b)
		recKeep, recKind = keep, k
		if !keep {
			continue
		}
		o.prepare(f32, ln, pk, pid, k, b)
		tim, dur := int64(0), int64(0)
		switch k {
		case trace.KindCall, trace.KindWait, trace.KindXctend, trace.KindParsingInCursor, trace.KindError, trace.KindParseError:
			tim, dur = lineTim(b)
		}
		if window && tim > 0 && (k == trace.KindCall || k == trace.KindWait) && ((sel.From != 0 && tim < sel.From) || (sel.To != 0 && tim-dur > sel.To)) {
			label = 'E'
		}
		copyRec(label, ln, b, tim)
		if k == trace.KindCall || k == trace.KindXctend {
			o.insertPlans(f32, ln)
		}
	}
	keepSep(inSpan(sepLine), trace.KindSeparator, nil)
	return r.err
}

// markerAnchor runs after a copied source marker with a time: it anchors
// the clock on the next tim, which is right only when the lines between
// them were copied too. A generated timestamp after it is written when
// lines were left out before the next tim (gapped), and dropped otherwise;
// an earlier pending one is not needed any more.
func (o *emitter) markerAnchor(f int32) {
	o.anchorAfter(f, true, "Re-anchors the wall clock: lines between the source's timestamp and the next line with a tim were left out.")
	o.gapped = false
}

// anchorAfter puts the generated timestamp after everything written so far
// (a timestamp the clock anchors on must be the last `***` time before the
// next tim): an earlier pending one moves here.
func (o *emitter) anchorAfter(f int32, cond bool, reason string) {
	o.anchorNeeded = false
	for i, it := range o.pending {
		if it.ts {
			o.pending = append(o.pending[:i], o.pending[i+1:]...)
			break
		}
	}
	o.waiting = true
	o.pending = append(o.pending, &item{label: 'G', file: f, ts: true, cond: cond, text: []byte("*** "),
		start: &Piece{Kind: "generated", Title: "Timestamp", File: int(f), Reason: reason}})
}

// maskState rewrites the value lines of a BINDS block (BindsMask): the
// value becomes model.RedactedValueSalt's token for the bind's type and
// length; the continuation and memory-dump lines of a value are left out.
type maskState struct {
	salt     string
	dty, avl int
	skipping bool
}

func (ms *maskState) line(b []byte) ([]byte, bool) {
	t := bytes.TrimLeft(b, " ")
	switch {
	case bytes.HasPrefix(t, []byte("Bind#")):
		ms.dty, ms.avl, ms.skipping = 0, 0, false
		return b, true
	case ms.skipping:
		return nil, false
	case bytes.HasPrefix(t, []byte("oacdty=")):
		ms.dty = int(leadingInt(t[len("oacdty="):]))
	case bytes.HasPrefix(t, []byte("kxsbbbfp=")):
		if i := bytes.Index(t, []byte("avl=")); i >= 0 {
			ms.avl = int(leadingInt(t[i+4:]))
		}
	case bytes.HasPrefix(t, []byte("value=")):
		v := string(t[len("value="):])
		bd := model.Bind{Dty: int32(ms.dty), Avl: int32(ms.avl)}
		switch {
		case strings.HasPrefix(v, "Unhandled datatype"):
			bd.IsDump = true
		case strings.HasPrefix(v, `"`):
			v = strings.TrimPrefix(v, `"`)
			v = strings.TrimSuffix(v, `"`)
		}
		bd.Value = v
		ms.skipping = true
		return []byte(`  value="` + model.RedactedValueSalt(&bd, ms.salt) + `"`), true
	}
	return b, true
}
