package diag

import (
	"bytes"
	"regexp"
	"strconv"
	"strings"
)

// The readings of the PGA memory dumps (docs/trace-format-diag.md § PGA memory dumps): the dump's own tables
// read as tables, with the sizes as printed and in bytes.
//
//	pga-summary   the memory part of an out-of-memory trace (event pga_summary): the top uses of the process,
//	              the private heap summary with its depth blocks, the instance-wide figures, the memory of each
//	              Oracle process (the top 10 and all, with the session detail of the big ones), the estimated
//	              uses for all processes (from a sample of snapshots), the swap lines.
//	pga-detail    "oradebug dump pga_detail_dump": the same rows of the top uses with exact bytes.
//
// The summary's figures are rounded (a whole KB or MB as printed): it has no total to check them against,
// and the reading says so (PGASummary.Note). The lines of each row are kept so that a row can be shown in
// the text.

// PGARowCap is how many rows of one table a PGA reading keeps; a table with more says how many were left out.
const PGARowCap = 5000

// pgaRoundedNote is the note a summary reading carries.
const pgaRoundedNote = "The figures of this dump are rounded (a whole KB or MB as printed) and it prints no total to check them against; the sizes in bytes are the printed figures times 1024 per unit."

// PGASize is a size as the dump prints it, and in bytes.
type PGASize struct {
	Text  string `json:"text"`  // "3429 KB", "108 MB", "3512312 bytes"
	Bytes int64  `json:"bytes"` // 3429 * 1024
}

// PGAUse is a row of the top uses of memory: "32% 3429 KB, 217 chunks: "pl/sql vc2" PL/SQL" and the line of
// the heap under it ("koh-kghu call   ds=0x7f72d80b11e8  dsprt=0x7f72d9282220"). The same shape serves the
// estimated uses for all processes (Count is processes there) and the rows of a pga_detail_dump.
type PGAUse struct {
	Line     int     `json:"line"`
	Percent  *int    `json:"percent,omitempty"` // absent in a pga_detail_dump
	Size     PGASize `json:"size"`
	Count    int     `json:"count"`              // chunks (processes, heaps, per Unit)
	Unit     string  `json:"unit"`               // chunks, processes, heaps
	Comment  string  `json:"comment"`            // trimmed
	Category string  `json:"category,omitempty"` // PL/SQL, SQL
	Heap     string  `json:"heap,omitempty"`     // the heap the chunks are in, trimmed (the line under the row)
	DS       string  `json:"ds,omitempty"`       // "0x7f72d80b11e8"
	DSParent string  `json:"dsParent,omitempty"` // "dsprt=", "" for (nil)
	Chunks   int     `json:"chunks,omitempty"`   // estimated uses: the chunks of the line under the row
}

// PGASummary is the reading of a pga-summary node.
type PGASummary struct {
	Kind  string `json:"kind"` // "pga-summary"
	Node  string `json:"node"`
	From  int    `json:"from"`
	To    int    `json:"to"`
	Lines int    `json:"lines"`
	// Note says the figures are rounded and nothing can be checked.
	Note string `json:"note"`

	Top       []PGAUse      `json:"top"` // TOP 10 MEMORY USES FOR THIS PROCESS
	TopLine   int           `json:"topLine,omitempty"`
	Private   []PGABlock    `json:"private"` // PRIVATE HEAP SUMMARY DUMP and the "Summary of subheaps at depth N" blocks
	Instance  []PGAInstance `json:"instance"`
	Processes *PGAProcesses `json:"processes,omitempty"`
	Estimated *PGAEstimated `json:"estimated,omitempty"`
	Swap      []PGAKV       `json:"swap"`
}

// ReadingKind is "pga-summary".
func (*PGASummary) ReadingKind() string { return ReadingPGASummary }

// PGABlock is a block of the private heap summary: the heap itself (Depth 0) or the sub-heaps at one depth.
type PGABlock struct {
	Line      int           `json:"line"`
	Title     string        `json:"title"` // "Private heap summary", "Summary of subheaps at depth 1"
	Depth     int           `json:"depth"`
	Total     PGASize       `json:"total"`
	Commented *PGASize      `json:"commented,omitempty"`
	Permanent *PGASize      `json:"permanent,omitempty"`
	Free      *PGASize      `json:"free,omitempty"`
	EmptyExt  *PGASize      `json:"emptyExtents,omitempty"` // "(384 KB in empty extents)"
	Rows      []PGABlockRow `json:"rows"`
}

// PGABlockRow is a line of a block: "3523 KB,   2 heaps:   "koh-kghu call  "     52 KB free held".
type PGABlockRow struct {
	Line     int      `json:"line"`
	Size     PGASize  `json:"size"`
	Count    int      `json:"count"`
	Unit     string   `json:"unit"` // chunks or heaps
	Comment  string   `json:"comment"`
	FreeHeld *PGASize `json:"freeHeld,omitempty"`
}

// PGAInstance is a line of the instance-wide summary ("Global SGA Info", "SGA Info (PDB 3)").
type PGAInstance struct {
	Line  int    `json:"line"`
	Scope string `json:"scope"`
	Name  string `json:"name"`
	Value string `json:"value"` // as printed: "512 MB", "0 %", "1"
}

// PGAKV is a name and a value as printed (the swap information).
type PGAKV struct {
	Line  int    `json:"line"`
	Name  string `json:"name"`
	Value string `json:"value"`
}

// PGAProcesses is "Private memory usage per Oracle process".
type PGAProcesses struct {
	Line           int       `json:"line"`
	TotalAllocated *PGASize  `json:"totalAllocated,omitempty"` // "(percentage is of 644 MB total allocated memory)"
	MGA            string    `json:"mga,omitempty"`            // "MGA used size accounted under PGA values = 0 KB": the size as printed
	TopProcs       []PGAProc `json:"top"`
	AllProcs       []PGAProc `json:"all"`
	AllOmitted     int       `json:"allOmitted,omitempty"`
}

// PGAProc is a process row: "17% ospid 2361        (MMON): 14 MB used, 108 MB alloc, 512 KB freeable".
type PGAProc struct {
	Line     int         `json:"line"`
	Percent  *int        `json:"percent,omitempty"` // the top 10 only
	OSPid    string      `json:"ospid"`             // as printed: "2361", "2299_2300" (a thread)
	Name     string      `json:"name"`              // "MMON"; blank for a foreground process
	PDB      string      `json:"pdb,omitempty"`     // the "(3)" after the name
	Used     PGASize     `json:"used"`
	Alloc    PGASize     `json:"alloc"`
	Freeable *PGASize    `json:"freeable,omitempty"`
	Session  *PGASession `json:"session,omitempty"` // the session detail printed under a process over 32 MB
}

// PGASession is "Begin session detail for pid N" ... "End session detail".
type PGASession struct {
	From       int    `json:"from"`
	To         int    `json:"to"`
	Pid        int    `json:"pid"`
	Sid        int    `json:"sid"`
	Serial     int    `json:"serial"`
	User       string `json:"user,omitempty"` // "0/SYS"
	PDB        string `json:"pdb,omitempty"`  // "1/CDB$ROOT"
	OSPid      string `json:"ospid,omitempty"`
	Image      string `json:"image,omitempty"`
	Machine    string `json:"machine,omitempty"`
	Program    string `json:"program,omitempty"`
	CurrentSQL string `json:"currentSql,omitempty"` // "" or "<none>" when there is none
}

// PGAEstimated is "ESTIMATED MEMORY USES FOR ALL PROCESSES".
type PGAEstimated struct {
	Line      int      `json:"line"`
	Snapshots int      `json:"snapshots"` // "from 10 snapshots out of 74 processes"
	Processes int      `json:"processes"`
	Rows      []PGAUse `json:"rows"`
	Omitted   int      `json:"omitted,omitempty"`
}

// PGADetail is the reading of a pga-detail node.
type PGADetail struct {
	Kind  string   `json:"kind"` // "pga-detail"
	Node  string   `json:"node"`
	From  int      `json:"from"`
	To    int      `json:"to"`
	Lines int      `json:"lines"`
	Pid   int      `json:"pid,omitempty"` // "PGA memory detail for pid 6, OS pid 14085"
	OSPid int      `json:"ospid,omitempty"`
	Rows  []PGAUse `json:"rows"` // exact bytes: Size.Text is "3512312 bytes"
	// Bytes and Chunks sum the rows (a listing of the largest uses, not a total of the process).
	Bytes   int64 `json:"bytes"`
	Chunks  int   `json:"chunks"`
	Omitted int   `json:"omitted,omitempty"`
}

// ReadingKind is "pga-detail".
func (*PGADetail) ReadingKind() string { return ReadingPGADetail }

var (
	reSize      = `(\d+(?:\.\d+)?)\s?(bytes|KB|MB|GB|TB|K|M|G)`
	reUse       = regexp.MustCompile(`^\s*(?:(\d+)%\s+)?` + reSize + `,\s+(\d+)\s+(chunks?|processes|process|heaps?)\s*:\s+"(.*?)"\s*(.*?)\s*$`)
	reHeap      = regexp.MustCompile(`^\s+(\S.*?)\s+ds=(0x[0-9a-fA-F]+|\(nil\))\s+dsprt=(0x[0-9a-fA-F]+|\(nil\))\s*$`)
	reEstHeap   = regexp.MustCompile(`^\s+(\S.*?)\s+(\d+)\s+chunks?\s*$`)
	reTotal     = regexp.MustCompile(`^\s*` + reSize + ` total:\s*$`)
	reComm      = regexp.MustCompile(`^\s*` + reSize + ` commented,\s+` + reSize + ` permanent\s*$`)
	reFree      = regexp.MustCompile(`^\s*` + reSize + ` free(?:\s+\(` + reSize + ` in empty extents\))?,?\s*$`)
	reRow       = regexp.MustCompile(`^\s*` + reSize + `,\s+(\d+)\s+(chunks?|heaps?)\s*:\s+"(.*?)"\s*(?:` + reSize + ` free held)?\s*$`)
	reProc      = regexp.MustCompile(`^\s*(?:(\d+)%\s+)?ospid\s+(\S+)\s+\(([^)]*)\)(?:\s+\((\d+)\))?:\s+` + reSize + ` used,\s+` + reSize + ` alloc(?:,\s+` + reSize + ` freeable)?\s*$`)
	reAllocOf   = regexp.MustCompile(`\(percentage is of ` + reSize + ` total allocated memory\)`)
	reFrom      = regexp.MustCompile(`\(from (\d+) snapshots? out of (\d+) processes?\)`)
	reSess      = regexp.MustCompile(`sid:\s*(\d+)\s+ser:\s*(\d+)(?:\s+audsid:\s*\S+)?(?:\s+user:\s*(\S+))?`)
	reKV        = regexp.MustCompile(`^\s{4}(\S[^:]*?):\s+(\S.*?)\s*$`)
	reDetailFor = regexp.MustCompile(`PGA memory detail for pid (\d+)(?:, OS pid (\d+))?`)
)

// pgaBlock says which block of the summary a line is in.
type pgaBlock uint8

const (
	pbNone pgaBlock = iota
	pbTop
	pbPrivate
	pbInstance
	pbProcs
	pbEst
	pbSwap
	pbOther
)

func sizeOf(num, unit string) PGASize {
	f, _ := strconv.ParseFloat(num, 64)
	mult := int64(1)
	switch strings.ToUpper(unit) {
	case "KB", "K":
		mult = 1 << 10
	case "MB", "M":
		mult = 1 << 20
	case "GB", "G":
		mult = 1 << 30
	case "TB", "T":
		mult = 1 << 40
	}
	text := num + " " + unit
	if unit == "K" || unit == "M" || unit == "G" || unit == "T" {
		text = num + unit
	}
	return PGASize{Text: text, Bytes: int64(f * float64(mult))}
}

func sizeAt(m []string, i int) PGASize { return sizeOf(m[i], m[i+1]) }

func sizePtr(m []string, i int) *PGASize {
	if i+1 >= len(m) || m[i] == "" {
		return nil
	}
	s := sizeOf(m[i], m[i+1])
	return &s
}

func descOf(s string) string {
	if s == "(nil)" {
		return ""
	}
	return s
}

func unitOf(s string) string {
	switch s {
	case "chunk", "chunks":
		return "chunks"
	case "process", "processes":
		return "processes"
	case "heap", "heaps":
		return "heaps"
	}
	return s
}

// pgaSummary reads the pga-summary node (lines from..to).
func (r *Reader) pgaSummary(id string, from, to int) (Reading, error) {
	s := &PGASummary{Kind: ReadingPGASummary, Node: id, From: from, To: to, Lines: to - from + 1, Note: pgaRoundedNote,
		Top: []PGAUse{}, Private: []PGABlock{}, Instance: []PGAInstance{}, Swap: []PGAKV{}}
	if raw, err := r.src.Read(from, 1); err != nil || !bytes.HasPrefix(raw, []byte("TOP ")) {
		return nil, wrapNoNode(id)
	}
	blk := pbNone
	var pendUse *PGAUse // a use row waiting for its heap line
	var curBlock *PGABlock
	var curProcs *[]PGAProc
	var curSession *PGASession
	var lastProc *PGAProc
	scope := ""
	pendEstChunks := false
	err := scanLines(r.src, from, to, func(n int, _, line, _ []byte) {
		t := string(line)
		tt := strings.TrimRight(t, " \r")
		// block banners
		switch {
		case strings.HasPrefix(tt, "TOP ") && strings.HasSuffix(tt, " MEMORY USES FOR THIS PROCESS"):
			blk, s.TopLine = pbTop, n
			return
		case tt == "PRIVATE MEMORY SUMMARY FOR THIS PROCESS":
			blk = pbPrivate
			return
		case tt == "REAL-FREE ALLOCATOR DUMP FOR THIS PROCESS", tt == "MGA MEMORY USAGE SUMMARY FOR ALL PROCESSES":
			blk = pbOther
			return
		case tt == "INSTANCE-WIDE PRIVATE MEMORY USAGE SUMMARY":
			blk, scope = pbInstance, ""
			return
		case tt == "PER-PROCESS PRIVATE MEMORY USAGE":
			blk = pbProcs
			if s.Processes == nil {
				s.Processes = &PGAProcesses{Line: n, TopProcs: []PGAProc{}, AllProcs: []PGAProc{}}
			}
			curProcs = nil
			return
		case tt == "ESTIMATED MEMORY USES FOR ALL PROCESSES":
			blk = pbEst
			s.Estimated = &PGAEstimated{Line: n, Rows: []PGAUse{}}
			pendUse = nil
			return
		case tt == "SWAP INFORMATION":
			blk = pbSwap
			return
		}
		switch blk {
		case pbTop:
			if m := reUse.FindStringSubmatch(tt); m != nil {
				if len(s.Top) >= PGARowCap {
					return
				}
				s.Top = append(s.Top, useOf(n, m))
				pendUse = &s.Top[len(s.Top)-1]
				return
			}
			if pendUse != nil {
				if m := reHeap.FindStringSubmatch(tt); m != nil {
					pendUse.Heap, pendUse.DS, pendUse.DSParent = m[1], descOf(m[2]), descOf(m[3])
				}
				pendUse = nil
			}
		case pbPrivate:
			if tt == "PRIVATE HEAP SUMMARY DUMP" {
				s.Private = append(s.Private, PGABlock{Line: n, Title: "Private heap summary", Rows: []PGABlockRow{}})
				curBlock = &s.Private[len(s.Private)-1]
				return
			}
			if strings.HasPrefix(tt, "Summary of subheaps at depth ") {
				d, _ := strconv.Atoi(strings.TrimSpace(tt[len("Summary of subheaps at depth "):]))
				s.Private = append(s.Private, PGABlock{Line: n, Title: tt, Depth: d, Rows: []PGABlockRow{}})
				curBlock = &s.Private[len(s.Private)-1]
				return
			}
			if curBlock == nil {
				return
			}
			if m := reTotal.FindStringSubmatch(tt); m != nil {
				curBlock.Total = sizeAt(m, 1)
			} else if m := reComm.FindStringSubmatch(tt); m != nil {
				c, p := sizeAt(m, 1), sizeAt(m, 3)
				curBlock.Commented, curBlock.Permanent = &c, &p
			} else if m := reFree.FindStringSubmatch(tt); m != nil {
				f := sizeAt(m, 1)
				curBlock.Free = &f
				curBlock.EmptyExt = sizePtr(m, 3)
			} else if m := reRow.FindStringSubmatch(tt); m != nil {
				if len(curBlock.Rows) < PGARowCap {
					c, _ := strconv.Atoi(m[3])
					curBlock.Rows = append(curBlock.Rows, PGABlockRow{Line: n, Size: sizeAt(m, 1), Count: c, Unit: unitOf(m[4]),
						Comment: strings.TrimSpace(m[5]), FreeHeld: sizePtr(m, 6)})
				}
			}
		case pbInstance:
			if h := strings.TrimSpace(tt); h != "" && strings.HasPrefix(tt, "  ") && !strings.HasPrefix(tt, "   ") && !strings.HasPrefix(h, "-") {
				scope = h
				return
			}
			if m := reKV.FindStringSubmatch(tt); m != nil && len(s.Instance) < PGARowCap {
				s.Instance = append(s.Instance, PGAInstance{Line: n, Scope: scope, Name: m[1], Value: m[2]})
			}
		case pbProcs:
			p := s.Processes
			switch {
			case strings.HasPrefix(tt, "MGA used size accounted under PGA values"):
				if i := strings.IndexByte(tt, '='); i >= 0 {
					p.MGA = strings.TrimSpace(tt[i+1:])
				}
			case strings.HasPrefix(tt, "Top ") && strings.HasSuffix(tt, " processes:"):
				curProcs = &p.TopProcs
			case tt == "All processes:":
				curProcs = &p.AllProcs
			case strings.HasPrefix(tt, "Begin session detail for pid "):
				pid, _ := strconv.Atoi(strings.TrimSpace(tt[len("Begin session detail for pid "):]))
				curSession = &PGASession{From: n, Pid: pid}
			case strings.HasPrefix(tt, "End session detail"):
				if curSession != nil {
					curSession.To = n
					attachSession(p, curSession, lastProc)
					curSession = nil
				}
			case curSession != nil:
				sessionLine(curSession, tt)
			default:
				if m := reAllocOf.FindStringSubmatch(tt); m != nil {
					sz := sizeAt(m, 1)
					p.TotalAllocated = &sz
				} else if m := reProc.FindStringSubmatch(tt); m != nil && curProcs != nil {
					pr := PGAProc{Line: n, OSPid: m[2], Name: strings.TrimSpace(m[3]), PDB: m[4], Used: sizeAt(m, 5), Alloc: sizeAt(m, 7), Freeable: sizePtr(m, 9)}
					if m[1] != "" {
						v, _ := strconv.Atoi(m[1])
						pr.Percent = &v
					}
					if curProcs == &p.AllProcs && len(*curProcs) >= PGARowCap {
						p.AllOmitted++
						lastProc = nil
						return
					}
					*curProcs = append(*curProcs, pr)
					lastProc = &(*curProcs)[len(*curProcs)-1]
				}
			}
		case pbEst:
			e := s.Estimated
			if m := reFrom.FindStringSubmatch(tt); m != nil {
				e.Snapshots, _ = strconv.Atoi(m[1])
				e.Processes, _ = strconv.Atoi(m[2])
				return
			}
			if m := reUse.FindStringSubmatch(tt); m != nil {
				if len(e.Rows) >= PGARowCap {
					e.Omitted++
					pendUse = nil
					return
				}
				e.Rows = append(e.Rows, useOf(n, m))
				pendUse = &e.Rows[len(e.Rows)-1]
				pendEstChunks = true
				return
			}
			if pendUse != nil && pendEstChunks {
				if m := reEstHeap.FindStringSubmatch(tt); m != nil {
					pendUse.Heap = m[1]
					pendUse.Chunks, _ = strconv.Atoi(m[2])
				}
				pendUse, pendEstChunks = nil, false
			}
		case pbSwap:
			if i := strings.IndexByte(tt, '='); i > 0 && len(s.Swap) < 20 {
				s.Swap = append(s.Swap, PGAKV{Line: n, Name: strings.TrimSpace(tt[:i]), Value: strings.TrimSpace(tt[i+1:])})
			}
		}
	})
	if err != nil {
		return nil, err
	}
	return s, nil
}

// useOf makes a PGAUse of a reUse match.
func useOf(n int, m []string) PGAUse {
	u := PGAUse{Line: n, Size: sizeAt(m, 2), Unit: unitOf(m[5]), Comment: strings.TrimSpace(m[6]), Category: strings.TrimSpace(m[7])}
	u.Count, _ = strconv.Atoi(m[4])
	if m[1] != "" {
		v, _ := strconv.Atoi(m[1])
		u.Percent = &v
	}
	return u
}

// sessionLine reads a line inside "Begin session detail".
func sessionLine(s *PGASession, t string) {
	tt := strings.TrimSpace(t)
	switch {
	case strings.HasPrefix(tt, "sid:"):
		if m := reSess.FindStringSubmatch(tt); m != nil {
			s.Sid, _ = strconv.Atoi(m[1])
			s.Serial, _ = strconv.Atoi(m[2])
			s.User = m[3]
		}
	case strings.HasPrefix(tt, "pdb:"):
		s.PDB = strings.TrimSpace(tt[4:])
	case strings.HasPrefix(tt, "pid:"):
		if i := strings.Index(tt, "ospid:"); i >= 0 {
			f := strings.Fields(tt[i+6:])
			if len(f) > 0 {
				s.OSPid = strings.TrimRight(f[0], ",")
			}
		}
	case strings.HasPrefix(tt, "image:"):
		s.Image = strings.TrimSpace(tt[6:])
	case strings.HasPrefix(tt, "machine:"):
		rest := tt[len("machine:"):]
		if i := strings.Index(rest, "program:"); i >= 0 {
			s.Machine = strings.TrimSpace(rest[:i])
			s.Program = strings.TrimSpace(rest[i+len("program:"):])
		} else {
			s.Machine = strings.TrimSpace(rest)
		}
	case strings.HasPrefix(tt, "current SQL:"):
		s.CurrentSQL = strings.TrimSpace(tt[len("current SQL:"):])
	case s.CurrentSQL != "" && s.CurrentSQL != "<none>" && !strings.HasSuffix(s.CurrentSQL, "…") && len(s.CurrentSQL) < 2000 && tt != "":
		s.CurrentSQL += " " + tt
	}
}

// attachSession puts a session detail under the process row it belongs to: the one with its ospid, else the
// row printed just before.
func attachSession(p *PGAProcesses, s *PGASession, last *PGAProc) {
	for _, list := range []*[]PGAProc{&p.AllProcs, &p.TopProcs} {
		for i := range *list {
			pr := &(*list)[i]
			if pr.Session == nil && s.OSPid != "" && pr.OSPid == s.OSPid && list == &p.AllProcs {
				pr.Session = s
				// the top 10 row of the same process carries the same detail (the top list is printed first, the detail
				// belongs to the process, not to the list it is read under)
				for j := range p.TopProcs {
					if tp := &p.TopProcs[j]; tp.Session == nil && tp.OSPid == s.OSPid {
						tp.Session = s
					}
				}
				return
			}
		}
	}
	if last != nil && last.Session == nil {
		last.Session = s
	}
}

// pgaDetail reads the pga-detail node.
func (r *Reader) pgaDetail(id string, from, to int) (Reading, error) {
	d := &PGADetail{Kind: ReadingPGADetail, Node: id, From: from, To: to, Lines: to - from + 1, Rows: []PGAUse{}}
	if raw, err := r.src.Read(from, 1); err != nil || !bytes.HasPrefix(raw, []byte("Begin PGA memory detail dump")) {
		return nil, wrapNoNode(id)
	}
	var pend *PGAUse
	err := scanLines(r.src, from, to, func(n int, _, line, _ []byte) {
		tt := strings.TrimRight(string(line), " \r")
		if m := reDetailFor.FindStringSubmatch(tt); m != nil {
			d.Pid, _ = strconv.Atoi(m[1])
			d.OSPid, _ = strconv.Atoi(m[2])
			return
		}
		if m := reUse.FindStringSubmatch(tt); m != nil && m[1] == "" {
			u := useOf(n, m)
			d.Bytes += u.Size.Bytes
			d.Chunks += u.Count
			if len(d.Rows) >= PGARowCap {
				d.Omitted++
				pend = nil
				return
			}
			d.Rows = append(d.Rows, u)
			pend = &d.Rows[len(d.Rows)-1]
			return
		}
		if pend != nil {
			if m := reHeap.FindStringSubmatch(tt); m != nil {
				pend.Heap, pend.DS, pend.DSParent = m[1], descOf(m[2]), descOf(m[3])
			}
			pend = nil
		}
	})
	if err != nil {
		return nil, err
	}
	return d, nil
}
