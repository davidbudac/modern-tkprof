package diag

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/trace"
)

// walker finds the heads of a node's lines, one line at a time, with the line before and after it.
type walker struct {
	nEmit   int  // heads put so far
	extents bool // a heap: the group "Extents" is open
	prof    profile
	skipTo  int // heads that start at or before this line are the node's own heading
	claimed int // the last line a banner took (its bottom rule may not be the top rule of the next)
	tocOpen []int
	titles  map[int]string // table of contents of an incident file: marker number -> title

	emit   func(h *head)       // a head was found
	tocEnd func(num, line int) // "[TOCnnnnn-END]" was found
}

// put hands a head to emit.
func (w *walker) put(h *head) {
	w.nEmit++
	if h.rank <= rankNested {
		w.extents = false
	}
	w.emit(h)
}

// line looks at line n (cur); prev and next are the lines around it (nil outside the node).
func (w *walker) line(n int, prev, cur, next []byte) {
	if n <= w.skipTo || len(cur) == 0 {
		return
	}
	if w.prof&pTOC != 0 {
		w.toc(n, cur, next)
		return
	}
	if w.prof&pHeap != 0 && w.heap(n, cur) {
		return
	}
	c := cur[0]
	// state objects (indented, or in a system state at the start of the line)
	if w.prof&pSO != 0 && (c == ' ' || c == 'S') && w.so(n, cur) {
		return
	}
	switch c {
	case '-':
		if w.prof&pTitle != 0 {
			if t, ok := dashTitle(cur); ok {
				h := &head{kind: "title", title: trunc(t, 120), from: n, hl: 1, rank: subTitleRank(t)}
				switch {
				case strings.HasPrefix(t, "Dump Cursor "):
					// "Dump Cursor sql_id=9zg9qd9bm4spu xsc=0x7f89b1895f58 cur=0x7f89b20c2538"
					f := strings.Fields(t)
					if len(f) >= 3 {
						h.title = "Cursor " + f[2]
						h.sub = strings.Join(f[3:], " ")
					}
				case strings.HasPrefix(t, "Current SQL Statement"):
					h.sub = trunc(strings.Join(strings.Fields(string(next)), " "), 90)
				}
				w.put(h)
			}
		}
		return
	case '=':
		if w.prof&pFrame != 0 && bytes.HasPrefix(cur, []byte("========== FRAME [")) {
			w.frame(n, cur)
		}
		return
	}
	if w.prof&pNested != 0 && len(cur) >= 10 && nestedFirst(c) {
		if k, ok := trace.IsSectionStart(cur); ok {
			h := &head{kind: nodeKind(k), from: n, hl: 1, rank: rankNested, end: endOf(k)}
			if h.end == endNone {
				h.rank = rankNestedPlain
			}
			sf := startFacts(k, cur)
			h.sk, h.sf, h.facts = k, &sf, sectionFactsLines
			if k == trace.SectionProcState || k == trace.SectionSysState || k == trace.SectionHang {
				// the rule above the title belongs to the section
				if prev != nil && n-1 > w.skipTo {
					if ch, ok := ruleLine(prev); ok && ch == '=' {
						h.from, h.hl = n-1, 2
					}
				}
			}
			w.put(h)
			return
		}
	}
	if w.prof&pProcess != 0 && c == 'P' && bytes.HasPrefix(cur, []byte("PROCESS ")) {
		if num, k := digits(cur[8:]); k > 0 && 8+k < len(cur) && cur[8+k] == ':' {
			name := strings.TrimSpace(string(cur[8+k+1:]))
			t := "Process " + strconv.Itoa(num)
			if name != "" {
				t += ": " + name
			}
			w.put(&head{kind: "process", title: t, name: name, n: num, from: n, hl: 1, rank: rankTitle})
			return
		}
	}
	if w.prof&pSummary != 0 && c == 'D' && exact(cur, "Dumping the Process Summary") {
		w.put(&head{kind: "title", title: "Process summary", from: n, hl: 1, rank: rankTitle})
		return
	}
	if w.prof&pChain != 0 {
		if w.chain(n, cur) {
			return
		}
	}
	if w.prof&pBanner != 0 {
		w.banner(n, prev, cur, next)
	}
}

// nestedFirst: the first bytes of the section starts (trace.IsSectionStart).
func nestedFirst(c byte) bool {
	switch c {
	case 'H', 'P', 'S', 'D', 'T', 'B', 'd', '[':
		return true
	}
	return false
}

// banner: a title framed by rules (top rule, title, bottom rule) or over an underline.
func (w *walker) banner(n int, prev, cur, next []byte) {
	if len(next) == 0 || (next[0] != '=' && next[0] != '-') {
		return
	}
	title, ok := bannerTitleOK(cur)
	if !ok {
		return
	}
	if len(prev) > 0 && (prev[0] == '=' || prev[0] == '-') && n-1 > w.claimed && n-1 > w.skipTo {
		if pc, ok := ruleLine(prev); ok {
			if _, ok := ruleLine(next); ok {
				w.claimed = n + 1
				h := &head{kind: "banner", title: trunc(title, 120), from: n - 1, hl: 3, rank: leafRank}
				if pc == '=' {
					h.rank = rankTitle
				}
				w.put(h)
				return
			}
		}
	}
	if n > w.claimed && underlineOK(title, next) && (len(prev) == 0 || !isRule(prev)) {
		w.claimed = n + 1
		w.put(&head{kind: "banner", title: trunc(title, 120), from: n, hl: 2, rank: leafRank})
	}
}

func isRule(b []byte) bool { _, ok := ruleLine(b); return ok }

// frame: "========== FRAME [3] (ksedst1()+95 -> kgdsdst()) =========="
func (w *walker) frame(n int, cur []byte) {
	rest := cur[len("========== FRAME ["):]
	num, k := digits(rest)
	if k == 0 {
		return
	}
	text := strings.TrimSpace(strings.Trim(string(rest[k:]), "= \t\r"))
	text = strings.TrimPrefix(text, "]")
	text = strings.TrimSpace(text)
	if strings.HasPrefix(text, "(") && strings.HasSuffix(text, ")") {
		text = text[1 : len(text)-1]
	}
	w.put(&head{kind: "frame", title: "Frame " + strconv.Itoa(num), sub: trunc(text, 100), n: num, from: n, hl: 1, rank: rankTitle + 1})
}

// so: "  SO: 0xa2eec2a0, type: process (2), map: 0xa255f4d8", nested by its indentation.
func (w *walker) so(n int, cur []byte) bool {
	ind := 0
	for ind < len(cur) && cur[ind] == ' ' {
		ind++
	}
	t := cur[ind:]
	if !bytes.HasPrefix(t, []byte("SO: 0x")) {
		return false
	}
	addr := string(t[4:])
	if i := strings.IndexByte(addr, ','); i >= 0 {
		addr = addr[:i]
	}
	typ := ""
	if i := bytes.Index(t, []byte("type: ")); i >= 0 {
		typ = string(t[i+6:])
		if j := strings.Index(typ, ", map"); j >= 0 {
			typ = typ[:j]
		}
		typ = strings.TrimSpace(typ)
	}
	num := 0
	if i := strings.LastIndexByte(typ, '('); i >= 0 {
		num, _ = strconv.Atoi(strings.TrimRight(typ[i+1:], ") "))
	}
	if typ == "" {
		typ = "state object"
	}
	w.put(&head{kind: "so", title: trunc(typ, 80), sub: addr, n: num, from: n, hl: 1, rank: rankTitle + 1 + ind/2, facts: soFactsLines})
	return true
}

// soFactsLines: how far below its SO line the "(session) sid: ..." line of a state object is looked for.
const soFactsLines = 40

// soFact reads the line that tells who a process or session state object is.
func soFact(h *head, line []byte) {
	t := bytes.TrimSpace(line)
	switch {
	case bytes.HasPrefix(t, []byte("(process) Oracle pid:")):
		// (process) Oracle pid:6, ser:33, calls cur/top: ...
		rest := t[len("(process) Oracle pid:"):]
		pid, k := digits(rest)
		ser := ""
		if i := bytes.Index(rest, []byte("ser:")); i >= 0 {
			s, k2 := digits(rest[i+4:])
			if k2 > 0 {
				ser = ", ser " + strconv.Itoa(s)
			}
		}
		if k > 0 {
			h.sub = "Oracle pid " + strconv.Itoa(pid) + ser
		}
		h.facts = 0
	case bytes.HasPrefix(t, []byte("(session) sid: ")):
		// (session) sid: 22 ser: 14058 trans: ...
		rest := t[len("(session) sid: "):]
		sid, k := digits(rest)
		ser := ""
		if i := bytes.Index(rest, []byte("ser: ")); i >= 0 {
			s, k2 := digits(rest[i+5:])
			if k2 > 0 {
				ser = " ser " + strconv.Itoa(s)
			}
		}
		if k > 0 {
			h.sub = "sid " + strconv.Itoa(sid) + ser
		}
		h.facts = 0
	}
}

var hangLabels = []string{
	"Chains most likely to have caused the hang:",
	"Non-intersecting chains:",
	"State of ALL nodes",
	"HANG ANALYSIS DUMPS:",
}

// chain: "Chain 1:" and the labels of a hang analysis.
func (w *walker) chain(n int, cur []byte) bool {
	if cur[0] == 'C' && bytes.HasPrefix(cur, []byte("Chain ")) {
		if num, k := digits(cur[6:]); k > 0 && exact(cur[6+k:], ":") {
			w.put(&head{kind: "chain", title: "Chain " + strconv.Itoa(num), n: num, from: n, hl: 1, rank: rankTitle + 1})
			return true
		}
	}
	if c := cur[0]; c == 'C' || c == 'N' || c == 'S' || c == 'H' {
		for _, l := range hangLabels {
			if exact(cur, l) {
				w.put(&head{kind: "title", title: strings.TrimSuffix(l, ":"), from: n, hl: 1, rank: rankTitle})
				return true
			}
		}
	}
	return false
}

// heap: the parts of a heap dump.
func (w *walker) heap(n int, cur []byte) bool {
	before := w.nEmit
	t := cur
	ind := 0
	for ind < len(t) && t[ind] == ' ' {
		ind++
	}
	t = t[ind:]
	if len(t) == 0 {
		return false
	}
	switch t[0] {
	case 'E':
		// EXTENT 0 addr=0x7f952ae99010
		if ind == 0 && bytes.HasPrefix(t, []byte("EXTENT ")) {
			if num, k := digits(t[7:]); k > 0 {
				sub := ""
				if i := bytes.Index(t, []byte("addr=")); i >= 0 {
					sub = "addr " + strings.TrimSpace(string(t[i+5:]))
				}
				if !w.extents {
					w.extents = true
					w.put(&head{kind: "extents", title: "Extents", from: n, hl: 0, rank: rankTitle}) // a group: its first extent is its first part
				}
				w.put(&head{kind: "extent", title: "Extent " + strconv.Itoa(num), sub: sub, n: num, from: n, hl: 1, rank: rankTitle + 1})
			}
		}
	case 'F':
		if ind == 0 && exact(t, "FREE LISTS:") {
			w.extents = false
			w.put(&head{kind: "freelists", title: "Free lists", from: n, hl: 1, rank: rankTitle})
		}
	case 'B':
		// " Bucket 0 size=56"
		if ind > 0 && bytes.HasPrefix(t, []byte("Bucket ")) {
			if num, k := digits(t[7:]); k > 0 {
				sub := ""
				if i := bytes.Index(t, []byte("size=")); i >= 0 {
					sub = strings.TrimSpace(string(t[i:]))
				}
				w.put(&head{kind: "bucket", title: "Bucket " + strconv.Itoa(num), sub: sub, n: num, from: n, hl: 1, rank: rankTitle + 1})
			}
		}
	case 'U':
		if ind == 0 && bytes.HasPrefix(t, []byte("UNPINNED RECREATABLE CHUNKS")) {
			w.extents = false
			w.put(&head{kind: "unpinned", title: "Unpinned recreatable chunks", from: n, hl: 1, rank: rankTitle})
		}
	case 'P':
		if ind == 0 && exact(t, "PERMANENT CHUNKS:") {
			w.extents = false
			w.put(&head{kind: "permanent", title: "Permanent chunks", from: n, hl: 1, rank: rankTitle})
		}
	default:
		// "5 LARGEST SUB HEAPS for heap name="pga heap"   desc=0x7fde9a405220"
		if ind == 0 && t[0] >= '0' && t[0] <= '9' {
			if num, k := digits(t); k > 0 && bytes.HasPrefix(t[k:], []byte(" LARGEST SUB HEAPS")) {
				sub := ""
				if i := bytes.Index(t, []byte("heap name=")); i >= 0 {
					rest := string(t[i+10:])
					if j := strings.Index(rest, "desc="); j >= 0 {
						rest = rest[:j]
					}
					sub = "of " + strings.TrimSpace(rest)
				}
				w.extents = false
				w.put(&head{kind: "subheaps", title: fmt.Sprintf("%d largest sub-heaps", num), sub: sub, n: num, from: n, hl: 1, rank: rankTitle})
			}
		}
	}
	return w.nEmit != before
}

// toc: the markers of an incident file.
func (w *walker) toc(n int, cur, next []byte) {
	if len(cur) < 8 {
		return
	}
	num, closes, before, alone, ok := tocMarker(cur)
	if !ok {
		return
	}
	if closes {
		for i := len(w.tocOpen) - 1; i >= 0; i-- {
			if w.tocOpen[i] == num {
				w.tocOpen = w.tocOpen[:i]
				break
			}
		}
		if w.tocEnd != nil {
			w.tocEnd(num, n)
		}
		return
	}
	title := before
	if alone {
		title = ""
		if next != nil {
			title = trunc(strings.TrimSpace(string(next)), 100)
		}
	}
	if t, ok := w.titles[num]; ok && t != "" {
		title = t
	}
	if title == "" {
		title = fmt.Sprintf("TOC%05d", num)
	}
	h := &head{kind: "toc", title: trunc(title, 120), sub: fmt.Sprintf("TOC%05d", num), n: num, from: n, hl: 1, rank: rankTitle + len(w.tocOpen), toc: true}
	w.tocOpen = append(w.tocOpen, num)
	w.put(h)
}
