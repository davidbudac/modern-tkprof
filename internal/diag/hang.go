package diag

import (
	"bytes"
	"strconv"
	"strings"
)

// The reading of a hang analysis (docs/PLAN-DIAG.md § The readings; the format is docs/trace-format-diag.md § Hang
// analysis): the chains of sessions that wait for one another, as the dump prints them, and the other tables of
// the dump. Fixtures: diag_hang (oradebug hanganalyze 3) and diag_hang_event (the event form, which prints no
// "analysis initiated by" line).
//
// One pass over the section's lines. What is read, and from which lines:
//
//	header     "instances (db_name.oracle_sid): cdb1.cdb1", "oradebug_node_dump_level: 3", "analysis initiated by oradebug",
//	           the "os thread scheduling delay history" lines
//	listed     "Chains most likely to have caused the hang:" with ` [a] Chain 1 Signature: 'A'<='B'<='C'` and
//	           `     Chain 1 Signature Hash: 0x5e4fa8d6`
//	chains     a group label ("Non-intersecting chains:", "Sessions in an involuntary wait or not in a wait:") over
//	           "Chain N:", then per session the block
//	               Oracle session identified by:  { instance: .. os id: .. process id: .. session id: .. session serial #: ..
//	                                                module name: .. pdb id: .. }
//	               is waiting for 'event' with wait info:  { p1: .. time in wait: .. timeout after: .. wait id: .. blocking: ..
//	                                                         current sql_id: .. current sql: .. short stack: .. wait history: .. }
//	               and is blocked by
//	            and, as the last session of the chain, "which is waiting for ..." (a session after "and is blocked by" is
//	            introduced by " => Oracle session identified by:"); then the chain's own "Chain N Signature:" and hash
//	nodes      "State of ALL nodes" with "([nodenum]/cnode/sid/sess_srno/session/ospid/state/[adjlist]):" and one row per
//	           node, "[254]/1/255/22508/0xa299efe8/13912/NLEAF/[51]"; the adjacency is the node the session is blocked by
//	extra      "Extra information that will be dumped at higher levels:" with "[level  4] :   1 node dumps -- [LEAF] [LEAF_NW]"
//	dumps      "HANG ANALYSIS DUMPS:" (a header with the level), "State of LOCAL nodes", "No processes qualify for dumping.",
//	           "HANG ANALYSIS DUMPS: END"
//
// The sessions of a chain are in the order the dump prints them: the first waits, each next one is the one that
// blocks the one before ("and is blocked by"), the last one is the head of the chain. The signature lists the events
// the other way round: the head's first ('PL/SQL lock timer'<='enq: TX - row lock contention'<=...).
//
// "current sql_id" is a number, not a sql_id: it is the high 32 bits of the 64-bit number a sql_id is (the sql_id is
// the last 8 bytes of the statement's MD5 in base 32), that is bytes 9 to 12 of the "FullHashValue" of the statement's
// library handle, and NOT the hash value (the low 32 bits, "Hash=" and "Identifier=" of the handle, `hv=` of a 10046
// trace). Evidence (docs/trace-format-diag.md § Hang analysis; the test TestHangSqlIDHigh): the statement `select id
// from mtk_cust where id = 302 for update wait 60` has sql_id ck39zc6g6ufn3, FullHashValue ee9e4662e14b3f2e c90d3f61
// 9e6d3a83, hash value 2657958531 (0x9e6d3a83); the hang analysis prints 3373088609 = 0xc90d3f61 for it. The field is
// therefore sqlIdHigh. 0 means no statement.
//
// Not shown by a fixture: a session that is not in a wait. The reader reads any line of the session's "is ..." /
// "which is ..." line that does not say "waiting for '...'" as the state (not waiting) and keeps its text.

// Bounds of a hang reading.
const (
	// HangChainCap is how many chains a hang reading lists; ChainsTotal counts them all.
	HangChainCap = 200
	// HangSessionCap is how many sessions of a chain are listed (HangChain.SessionsTotal counts them all).
	HangSessionCap = 100
	// HangHistoryCap is how many entries of a session's wait history are listed.
	HangHistoryCap = 30
	// HangNodeCap is how many rows of a node table are listed.
	HangNodeCap = 1000
	// HangListedCap is how many chains of the "most likely" list are listed.
	HangListedCap = 200
	// HangTextCap is how many bytes of a statement or a short stack are kept.
	HangTextCap  = 4000
	hangExtraCap = 50
	hangDelayCap = 40
	hangOtherCap = 20
)

// HangReading is the reading of a hang analysis.
type HangReading struct {
	Kind  string `json:"kind"` // "hang"
	Node  string `json:"node"`
	From  int    `json:"from"`
	To    int    `json:"to"`
	Lines int    `json:"lines"`

	// Instances are the "instances (db_name.oracle_sid)" the analysis covers; Level the "oradebug_node_dump_level";
	// InitiatedBy the text after "analysis initiated by" ("oradebug"), absent when the dump prints none (the event
	// form of the lab does not).
	Instances   []string `json:"instances"`
	Level       *int     `json:"level,omitempty"`
	InitiatedBy string   `json:"initiatedBy,omitempty"`
	HeaderLine  int      `json:"headerLine"`
	// Delays are the lines of "os thread scheduling delay history", as printed and trimmed.
	Delays []string `json:"delays"`

	// Listed is the "Chains most likely to have caused the hang" list; Chains are the chains of the body.
	Listed      []HangListed `json:"listed"`
	Chains      []HangChain  `json:"chains"`
	ChainsTotal int          `json:"chainsTotal"`

	// Nodes is the "State of ALL nodes" table, absent when the dump prints none.
	Nodes *HangNodes `json:"nodes,omitempty"`
	// Extra are the lines under "Extra information that will be dumped at higher levels".
	Extra []string `json:"extra"`
	// Dumps are the facts of the "HANG ANALYSIS DUMPS:" block, absent when the section has none.
	Dumps *HangDumps `json:"dumps,omitempty"`

	// Ended: "END OF HANG ANALYSIS" was reached.
	Ended bool     `json:"ended"`
	Notes []string `json:"notes"`
}

// ReadingKind is "hang".
func (*HangReading) ReadingKind() string { return ReadingHang }

// HangListed is an entry of the list of chains most likely to have caused the hang.
type HangListed struct {
	Letter string `json:"letter"` // "a" of " [a] Chain 1 Signature: ..."
	Chain  int    `json:"chain"`
	// Signature is as printed ("'PL/SQL lock timer'<='enq: TX - row lock contention'"); Events its list, the head's first.
	Signature string   `json:"signature"`
	Events    []string `json:"events"`
	Hash      string   `json:"hash,omitempty"` // "0x5e4fa8d6"
	Line      int      `json:"line"`
}

// HangChain is one chain of the body.
type HangChain struct {
	N    int `json:"n"`
	Line int `json:"line"` // "Chain N:"
	From int `json:"from"`
	To   int `json:"to"`
	// Group is the label over it: "Non-intersecting chains" or "Sessions in an involuntary wait or not in a wait".
	Group string `json:"group,omitempty"`
	// Signature, Events and Hash are the chain's own "Chain N Signature:" lines (the list's when it has none).
	Signature string   `json:"signature,omitempty"`
	Events    []string `json:"events"`
	Hash      string   `json:"hash,omitempty"`
	// Listed: the chain is in the "most likely" list; Letter is its letter there.
	Listed bool   `json:"listed"`
	Letter string `json:"letter,omitempty"`
	// Sessions are in the order the dump prints them: the first waits, each next one blocks the one before it, the
	// last is the head of the chain. At most HangSessionCap; SessionsTotal counts them all.
	Sessions      []HangSession `json:"sessions"`
	SessionsTotal int           `json:"sessionsTotal"`
}

// HangSession is one session of a chain.
type HangSession struct {
	Position int `json:"position"` // 1 for the first
	Line     int `json:"line"`     // "Oracle session identified by:"
	From     int `json:"from"`
	To       int `json:"to"`

	// The identification block, as printed. Instance is "1 (cdb1.cdb1)" as printed.
	Instance string `json:"instance,omitempty"`
	OSId     string `json:"osId,omitempty"`
	// ProcessID is the Oracle process number; Process the rest of the line ("oracle@ol9-19-dg1.localdomain (J001)").
	ProcessID *int   `json:"processId,omitempty"`
	Process   string `json:"process,omitempty"`
	Sid       int    `json:"sid"`
	Serial    int    `json:"serial"`
	Key       string `json:"key"` // "sid.serial"
	// Module is the text of "module name: 3 (mtk_diag_chain-dg1.localdomain (TNS V1-V3))" in the outer parentheses,
	// as printed: the dump joins the module with what follows it in a buffer, so the text can carry the tail of the
	// machine name (fixture diag_hang: "DBMS_SCHEDULERstack_l1aldomain (TNS V1-V3)"). ModuleNum is the number before
	// it, the container id on every fixture.
	Module    string `json:"module,omitempty"`
	ModuleNum *int   `json:"moduleNum,omitempty"`
	PDBID     *int   `json:"pdbId,omitempty"`
	PDB       string `json:"pdb,omitempty"`

	// Waiting: "is waiting for '<event>' with wait info:". State is the line that says it, as printed. Event is
	// absent for a session that is not waiting.
	Waiting bool   `json:"waiting"`
	Event   string `json:"event,omitempty"`
	State   string `json:"state,omitempty"`
	// Params are the wait parameters as printed ("p1: 'name|mode'=0x54580006").
	Params []string `json:"params"`
	// The wait info: time in wait, "heur. time in wait", "timeout after" (TimeoutText as printed: "55.970964 sec" or
	// "never"), "wait id", "blocking: N session(s)".
	TimeInWaitSec     *float64 `json:"timeInWaitSec,omitempty"`
	HeurTimeInWaitSec *float64 `json:"heurTimeInWaitSec,omitempty"`
	TimeoutSec        *float64 `json:"timeoutSec,omitempty"`
	TimeoutText       string   `json:"timeoutText,omitempty"`
	WaitID            *int     `json:"waitId,omitempty"`
	Blocking          *int     `json:"blocking,omitempty"`
	// LastWaitText is "last wait:" of a session that is not waiting, as printed (not shown by a fixture).
	LastWaitText string `json:"lastWaitText,omitempty"`

	// SqlIdHigh is "current sql_id": a number that is the high 32 bits of the statement's sql_id, not its hash
	// value (see the comment of this file). Absent when the dump prints none; 0 is no statement. SqlText is "current
	// sql:" (at most HangTextCap bytes, SqlCut says it was cut), absent when the dump prints none.
	SqlIdHigh *int64 `json:"sqlIdHigh,omitempty"`
	SqlText   string `json:"sqlText,omitempty"`
	SqlCut    bool   `json:"sqlCut,omitempty"`
	// ShortStack is the session's "short stack:" as printed (functions joined by "<-", no offsets); ShortStackNoOwn
	// without the leading entries of the signal handler that took it, ShortStackOwn how many those are.
	ShortStack      string `json:"shortStack,omitempty"`
	ShortStackNoOwn string `json:"shortStackNoOwn,omitempty"`
	ShortStackOwn   int    `json:"shortStackOwn,omitempty"`
	// History is the wait history, latest first, at most HangHistoryCap; HistoryTotal counts them.
	History      []HangWait `json:"history"`
	HistoryTotal int        `json:"historyTotal"`
	HistoryLine  int        `json:"historyLine,omitempty"`
}

// HangWait is an entry of a session's wait history.
type HangWait struct {
	N       int      `json:"n"` // 1 is the latest
	Event   string   `json:"event"`
	WaitedS *float64 `json:"waitedSec,omitempty"` // "time waited"
	// GapSec is the "* time between wait #1 and #2: 0.000005 sec" line above the entry: the time between the wait before
	// it (the current wait for entry 1) and this one; GapLabel is that line as printed.
	GapSec   *float64 `json:"gapSec,omitempty"`
	WaitID   *int     `json:"waitId,omitempty"`
	Params   []string `json:"params"`
	Line     int      `json:"line"`
	GapLabel string   `json:"gapLabel,omitempty"`
}

// HangNodes is a "State of ... nodes" table.
type HangNodes struct {
	Line   int        `json:"line"`
	Header string     `json:"header,omitempty"` // "([nodenum]/cnode/sid/sess_srno/session/ospid/state/[adjlist]):"
	Rows   []HangNode `json:"rows"`
	Total  int        `json:"total"`
}

// HangNode is a row of "State of ALL nodes": "[254]/1/255/22508/0xa299efe8/13912/NLEAF/[51]".
type HangNode struct {
	Line    int    `json:"line"`
	Num     int    `json:"num"`
	CNode   int    `json:"cnode"`
	Sid     int    `json:"sid"`
	Serial  int    `json:"serial"`
	Key     string `json:"key"`     // "sid.serial"
	Session string `json:"session"` // the session's address, as printed
	OSPid   string `json:"ospid"`
	State   string `json:"state"` // SINGLE_NODE, NLEAF, LEAF, ...
	// Adj is the adjacency list: the node numbers in brackets at the end of the row.
	Adj []int `json:"adj"`
}

// HangDumps are the facts of the "HANG ANALYSIS DUMPS:" block.
type HangDumps struct {
	Line  int  `json:"line"`
	Level *int `json:"level,omitempty"` // "oradebug_node_dump_level: 3"
	// Local is "State of LOCAL nodes".
	Local *HangNodes `json:"local,omitempty"`
	// Lines are the other lines of the block, as printed ("No processes qualify for dumping.").
	Lines []string `json:"lines"`
	Ended bool     `json:"ended"` // "HANG ANALYSIS DUMPS: END"
}

// hangPhase of the parser.
const (
	hpHead = iota
	hpListed
	hpChains
	hpNodes
	hpExtra
	hpDumps
	hpAfter
)

type hangParser struct {
	h *HangReading

	phase    int
	prevRule bool
	group    string
	pendList *HangListed // the list entry whose hash line follows

	chain *HangChain
	sess  *HangSession
	sub   int // session sub-state, below
	// the history entry being read
	hist     *HangWait
	gap      *float64
	gapLabel string
	// the statement being read (lines after "current sql:" that are not another key)
	inSQL  bool
	sqlBuf []byte

	nodes *HangNodes
	last  int // the last line seen
}

// session sub-states
const (
	hsNone     = iota
	hsIdent    // after "Oracle session identified by:", before "{"
	hsIdentIn  // inside the identification block
	hsState    // after its "}", the "is waiting for ..." line is next
	hsWaitOpen // after the state line, "{" is next
	hsInfo     // inside the wait info block
	hsHistory  // inside the wait history
)

// hangReading reads the lines of a node of kind hang.
func (r *Reader) hangReading(id string, from, to int) (*HangReading, error) {
	h := &HangReading{Kind: ReadingHang, Node: id, From: from, To: to, Lines: to - from + 1,
		Instances: []string{}, Delays: []string{}, Listed: []HangListed{}, Chains: []HangChain{}, Extra: []string{}, Notes: []string{}}
	p := &hangParser{h: h}
	err := scanLines(r.src, from, to, func(n int, prev, line, next []byte) { p.line(n, line) })
	if err != nil {
		return nil, err
	}
	p.closeChain(to)
	p.finish()
	return h, nil
}

// hangSigEvents splits "'A'<='B'<='C'" into its events.
func hangSigEvents(sig string) []string {
	sig = strings.TrimSpace(sig)
	out := []string{}
	if sig == "" {
		return out
	}
	sig = strings.TrimPrefix(sig, "'")
	sig = strings.TrimSuffix(sig, "'")
	for _, e := range strings.Split(sig, "'<='") {
		out = append(out, e)
	}
	return out
}

func isRuleBytes(l []byte) bool {
	if len(l) < 5 || (l[0] != '=' && l[0] != '-') {
		return false
	}
	c := l[0]
	for _, x := range bytes.TrimRight(l, " \r") {
		if x != c {
			return false
		}
	}
	return true
}

func (p *hangParser) line(n int, l []byte) {
	p.last = n
	h := p.h
	if len(l) == 0 {
		return
	}
	if isRuleBytes(l) {
		p.prevRule = true
		return
	}
	t := strings.TrimSpace(string(l))
	if t == "" {
		return
	}
	col0 := l[0] != ' '
	prevRule := p.prevRule
	p.prevRule = false

	switch {
	case col0 && t == "HANG ANALYSIS:":
		p.phase, h.HeaderLine = hpHead, n
		return
	case col0 && t == "END OF HANG ANALYSIS":
		p.closeChain(n - 1)
		h.Ended = true
		p.phase = hpAfter
		return
	case col0 && t == "HANG ANALYSIS DUMPS:":
		p.closeChain(n - 1)
		p.phase = hpDumps
		h.Dumps = &HangDumps{Line: n, Lines: []string{}}
		return
	case col0 && t == "HANG ANALYSIS DUMPS: END":
		if h.Dumps != nil {
			h.Dumps.Ended = true
		}
		p.phase = hpAfter
		return
	case col0 && t == "Chains most likely to have caused the hang:":
		p.phase = hpListed
		return
	case col0 && strings.HasPrefix(t, "Extra information that will be dumped"):
		p.closeChain(n - 1)
		p.phase = hpExtra
		return
	case col0 && (strings.HasPrefix(t, "State of ALL nodes") || strings.HasPrefix(t, "State of LOCAL nodes")):
		p.closeChain(n - 1)
		hn := &HangNodes{Line: n, Rows: []HangNode{}}
		if strings.HasPrefix(t, "State of ALL") {
			p.phase = hpNodes
			h.Nodes = hn
		} else {
			if h.Dumps == nil {
				h.Dumps = &HangDumps{Line: 0, Lines: []string{}}
			}
			h.Dumps.Local = hn
		}
		p.nodes = hn
		return
	case col0 && prevRule && strings.HasSuffix(t, ":") && !strings.HasPrefix(t, "Chain "):
		// a label over the chains
		if p.phase == hpHead || p.phase == hpListed || p.phase == hpChains {
			p.closeChain(n - 1)
			p.phase = hpChains
			p.group = strings.TrimSuffix(t, ":")
			return
		}
	}
	if col0 && strings.HasPrefix(t, "Chain ") {
		rest := t[len("Chain "):]
		if num, k := digits([]byte(rest)); k > 0 {
			tail := rest[k:]
			switch {
			case tail == ":":
				p.closeChain(n - 1)
				p.phase = hpChains
				p.openChain(n, num)
				return
			case strings.HasPrefix(tail, " Signature Hash:") && p.phase == hpChains && p.chain != nil:
				p.chain.Hash = strings.TrimSpace(tail[len(" Signature Hash:"):])
				p.endSession(n - 1)
				return
			case strings.HasPrefix(tail, " Signature:") && p.phase == hpChains && p.chain != nil:
				p.endSession(n - 1)
				p.chain.Signature = strings.TrimSpace(tail[len(" Signature:"):])
				p.chain.Events = hangSigEvents(p.chain.Signature)
				return
			}
		}
	}
	switch p.phase {
	case hpHead:
		p.headLine(n, t)
	case hpListed:
		p.listedLine(n, t)
	case hpChains:
		if p.chain != nil {
			p.chainLine(n, string(l), t)
		}
	case hpNodes:
		p.nodeLine(n, t)
	case hpExtra:
		if strings.HasPrefix(t, "[level") && len(h.Extra) < hangExtraCap {
			h.Extra = append(h.Extra, t)
		}
	case hpDumps:
		d := h.Dumps
		switch {
		case strings.HasPrefix(t, "oradebug_node_dump_level:"):
			if v, err := strconv.Atoi(strings.TrimSpace(t[len("oradebug_node_dump_level:"):])); err == nil {
				d.Level = &v
			}
		case p.nodes != nil && d.Local != nil && p.nodes == d.Local && (strings.HasPrefix(t, "(") || strings.HasPrefix(t, "[")):
			p.nodeLine(n, t)
		default:
			if len(d.Lines) < hangOtherCap {
				d.Lines = append(d.Lines, t)
			}
		}
	}
}

func (p *hangParser) headLine(n int, t string) {
	h := p.h
	switch {
	case strings.HasPrefix(t, "instances (db_name.oracle_sid):"):
		v := strings.TrimSpace(t[len("instances (db_name.oracle_sid):"):])
		for _, f := range strings.FieldsFunc(v, func(r rune) bool { return r == ',' || r == ' ' }) {
			h.Instances = append(h.Instances, f)
		}
	case strings.HasPrefix(t, "oradebug_node_dump_level:"):
		if v, err := strconv.Atoi(strings.TrimSpace(t[len("oradebug_node_dump_level:"):])); err == nil {
			h.Level = &v
		}
	case strings.HasPrefix(t, "analysis initiated by"):
		h.InitiatedBy = strings.TrimSpace(t[len("analysis initiated by"):])
	case strings.HasPrefix(t, "os thread scheduling delay history") || strings.HasPrefix(t, "vktm time drift history") ||
		strings.Contains(t, " secs ") || strings.HasPrefix(t, "NOTE:"):
		if len(h.Delays) < hangDelayCap {
			h.Delays = append(h.Delays, t)
		}
	}
}

func (p *hangParser) listedLine(n int, t string) {
	h := p.h
	if strings.HasPrefix(t, "[") {
		// "[a] Chain 1 Signature: 'X'<='Y'"
		i := strings.IndexByte(t, ']')
		if i < 2 {
			return
		}
		letter := t[1:i]
		rest := strings.TrimSpace(t[i+1:])
		if !strings.HasPrefix(rest, "Chain ") {
			return
		}
		rest = rest[len("Chain "):]
		num, k := digits([]byte(rest))
		if k == 0 || !strings.HasPrefix(rest[k:], " Signature:") {
			return
		}
		sig := strings.TrimSpace(rest[k+len(" Signature:"):])
		if len(h.Listed) >= HangListedCap {
			p.pendList = nil
			return
		}
		h.Listed = append(h.Listed, HangListed{Letter: letter, Chain: num, Signature: sig, Events: hangSigEvents(sig), Line: n})
		p.pendList = &h.Listed[len(h.Listed)-1]
		return
	}
	if strings.HasPrefix(t, "Chain ") && strings.Contains(t, "Signature Hash:") && p.pendList != nil {
		p.pendList.Hash = strings.TrimSpace(t[strings.Index(t, "Signature Hash:")+len("Signature Hash:"):])
		p.pendList = nil
	}
}

func (p *hangParser) openChain(n, num int) {
	p.h.ChainsTotal++
	p.chain = &HangChain{N: num, Line: n, From: n, To: n, Group: p.group, Events: []string{}, Sessions: []HangSession{}}
	if p.h.ChainsTotal > HangChainCap {
		// counted, not listed: the lines are still read (into a chain that is dropped)
		p.chain.Sessions = nil
	}
	p.sess, p.sub = nil, hsNone
}

// closeChain ends the chain being read at line to and adds it to the reading.
func (p *hangParser) closeChain(to int) {
	if p.chain == nil {
		return
	}
	p.endSession(to)
	c := p.chain
	p.chain = nil
	if p.h.ChainsTotal > HangChainCap {
		return
	}
	c.To = max(to, c.From)
	p.h.Chains = append(p.h.Chains, *c)
}

// endSession finishes the session being read (to is its last line).
func (p *hangParser) endSession(to int) {
	s := p.sess
	if s == nil {
		return
	}
	p.sess, p.sub, p.hist, p.inSQL = nil, hsNone, nil, false
	s.To = max(to, s.From)
	s.Key = strconv.Itoa(s.Sid) + "." + strconv.Itoa(s.Serial)
	if s.ShortStack != "" {
		fns := []string{}
		for _, e := range strings.Split(s.ShortStack, "<-") {
			fn, _ := splitFrameText(e)
			fns = append(fns, fn)
		}
		s.ShortStackOwn = ownShortStack(fns)
		ents := strings.Split(s.ShortStack, "<-")
		s.ShortStackNoOwn = strings.Join(ents[min(s.ShortStackOwn, len(ents)):], "<-")
	}
	c := p.chain
	c.SessionsTotal++
	s.Position = c.SessionsTotal
	if c.Sessions != nil && len(c.Sessions) < HangSessionCap {
		c.Sessions = append(c.Sessions, *s)
	}
}

// hangKeys are the keys of the wait info block (a line with another key after "current sql:" continues the statement).
var hangKeys = map[string]bool{
	"time in wait": true, "heur. time in wait": true, "timeout after": true, "wait id": true, "blocking": true,
	"current sql_id": true, "current sql": true, "short stack": true, "wait history": true, "last wait": true,
}

func hangKeyOf(t string) (key, val string, ok bool) {
	i := strings.Index(t, ":")
	if i <= 0 {
		return "", "", false
	}
	key = t[:i]
	val = strings.TrimSpace(t[i+1:])
	if hangKeys[key] {
		return key, val, true
	}
	if len(key) == 2 && key[0] == 'p' && key[1] >= '0' && key[1] <= '9' {
		return key, val, true
	}
	return "", "", false
}

func firstFloat(v string) *float64 {
	f := v
	if i := strings.IndexByte(v, ' '); i >= 0 {
		f = v[:i]
	}
	x, err := strconv.ParseFloat(f, 64)
	if err != nil {
		return nil
	}
	return &x
}

func firstInt(v string) *int {
	f := v
	if i := strings.IndexByte(v, ' '); i >= 0 {
		f = v[:i]
	}
	x, err := strconv.Atoi(f)
	if err != nil {
		return nil
	}
	return &x
}

// chainLine reads a line inside a chain (raw is the line, t its trimmed text).
func (p *hangParser) chainLine(n int, raw, t string) {
	if strings.Contains(t, "Oracle session identified by:") {
		p.endSession(n - 1)
		p.sess = &HangSession{Line: n, From: n, Params: []string{}, History: []HangWait{}}
		p.sub = hsIdent
		return
	}
	s := p.sess
	if s == nil {
		return
	}
	s.To = n
	switch p.sub {
	case hsIdent:
		if t == "{" {
			p.sub = hsIdentIn
		}
	case hsIdentIn:
		if t == "}" {
			p.sub = hsState
			return
		}
		p.identLine(s, t)
	case hsState:
		if strings.HasPrefix(t, "is ") || strings.HasPrefix(t, "which ") || strings.HasPrefix(t, "and is ") {
			if strings.HasPrefix(t, "and is blocked by") {
				p.sub = hsNone
				return
			}
			s.State = t
			if i := strings.Index(t, "waiting for '"); i >= 0 {
				ev := t[i+len("waiting for '"):]
				if j := strings.Index(ev, "' with wait info"); j >= 0 {
					ev = ev[:j]
				} else if j := strings.LastIndexByte(ev, '\''); j >= 0 {
					ev = ev[:j]
				}
				s.Waiting, s.Event = true, ev
			}
			p.sub = hsWaitOpen
		}
	case hsWaitOpen:
		if t == "{" {
			p.sub = hsInfo
		} else if t == "and is blocked by" {
			p.sub = hsNone
		}
	case hsInfo, hsHistory:
		if t == "}" {
			p.flushSQL()
			p.sub, p.hist = hsNone, nil
			return
		}
		if p.sub == hsHistory {
			p.histLine(n, t)
			return
		}
		p.infoLine(n, t)
	}
}

func (p *hangParser) identLine(s *HangSession, t string) {
	i := strings.Index(t, ": ")
	if i < 0 {
		return
	}
	key, val := t[:i], strings.TrimSpace(t[i+2:])
	switch key {
	case "instance":
		s.Instance = val
	case "os id":
		s.OSId = val
	case "process id":
		// "61, oracle@ol9-19-dg1.localdomain (J001)"
		num := val
		if j := strings.IndexByte(val, ','); j >= 0 {
			num = val[:j]
			s.Process = strings.TrimSpace(val[j+1:])
		}
		if v, err := strconv.Atoi(strings.TrimSpace(num)); err == nil {
			s.ProcessID = &v
		}
	case "session id":
		s.Sid, _ = strconv.Atoi(val)
	case "session serial #":
		s.Serial, _ = strconv.Atoi(val)
	case "module name":
		// "3 (mtk_diag_chain-dg1.localdomain (TNS V1-V3))"
		if j := strings.IndexByte(val, ' '); j > 0 {
			if v, err := strconv.Atoi(val[:j]); err == nil {
				s.ModuleNum = &v
				val = strings.TrimSpace(val[j:])
			}
		}
		if strings.HasPrefix(val, "(") && strings.HasSuffix(val, ")") {
			val = val[1 : len(val)-1]
		}
		s.Module = val
	case "pdb id":
		// "3 (PDB1)"
		num := val
		if j := strings.IndexByte(val, ' '); j > 0 {
			num = val[:j]
			name := strings.TrimSpace(val[j:])
			s.PDB = strings.TrimSuffix(strings.TrimPrefix(name, "("), ")")
		}
		if v, err := strconv.Atoi(num); err == nil {
			s.PDBID = &v
		}
	}
}

func (p *hangParser) flushSQL() {
	if !p.inSQL {
		return
	}
	p.inSQL = false
	if p.sess != nil {
		p.sess.SqlText = string(p.sqlBuf)
	}
	p.sqlBuf = p.sqlBuf[:0]
}

func (p *hangParser) infoLine(n int, t string) {
	s := p.sess
	key, val, ok := hangKeyOf(t)
	if !ok {
		if p.inSQL {
			// the statement goes on
			if len(p.sqlBuf) < HangTextCap {
				p.sqlBuf = append(p.sqlBuf, '\n')
				p.sqlBuf = append(p.sqlBuf, t...)
				if len(p.sqlBuf) > HangTextCap {
					p.sqlBuf = p.sqlBuf[:HangTextCap]
					s.SqlCut = true
				}
			} else {
				s.SqlCut = true
			}
		}
		return
	}
	p.flushSQL()
	switch key {
	case "time in wait":
		s.TimeInWaitSec = firstFloat(val)
	case "heur. time in wait":
		s.HeurTimeInWaitSec = firstFloat(val)
	case "timeout after":
		s.TimeoutText = val
		s.TimeoutSec = firstFloat(val)
	case "wait id":
		s.WaitID = firstInt(val)
	case "blocking":
		s.Blocking = firstInt(val)
	case "last wait":
		s.LastWaitText = val
	case "current sql_id":
		if v, err := strconv.ParseInt(strings.TrimSpace(val), 10, 64); err == nil {
			s.SqlIdHigh = &v
		}
	case "current sql":
		p.inSQL = true
		p.sqlBuf = append(p.sqlBuf[:0], val...)
		if len(p.sqlBuf) > HangTextCap {
			p.sqlBuf = p.sqlBuf[:HangTextCap]
			s.SqlCut = true
		}
	case "short stack":
		if len(val) > HangTextCap {
			val = val[:HangTextCap]
		}
		s.ShortStack = val
	case "wait history":
		p.sub = hsHistory
		s.HistoryLine = n
	default:
		// p1..p9
		s.Params = append(s.Params, t)
	}
}

// histLine reads a line of the wait history.
func (p *hangParser) histLine(n int, t string) {
	s := p.sess
	switch {
	case strings.HasPrefix(t, "* time between"):
		// "* time between current wait and wait #1: 0.000132 sec"
		p.gapLabel = t
		p.gap = nil
		if i := strings.LastIndex(t, ": "); i >= 0 {
			p.gap = firstFloat(strings.TrimSpace(t[i+2:]))
		}
		return
	case strings.HasPrefix(t, "time waited:"):
		if p.hist != nil {
			p.hist.WaitedS = firstFloat(strings.TrimSpace(t[len("time waited:"):]))
		}
		return
	case strings.HasPrefix(t, "wait id:"):
		if p.hist != nil {
			rest := strings.TrimSpace(t[len("wait id:"):])
			p.hist.WaitID = firstInt(rest)
			if j := strings.Index(rest, "p1:"); j >= 0 {
				p.hist.Params = append(p.hist.Params, strings.TrimSpace(rest[j:]))
			}
		}
		return
	}
	if k := strings.Index(t, "event: '"); k > 0 && len(t) > k+len("event: '") && t[len(t)-1] == '\'' {
		numPart := strings.TrimSpace(t[:k])
		if strings.HasSuffix(numPart, ".") {
			if num, err := strconv.Atoi(strings.TrimSuffix(numPart, ".")); err == nil {
				s.HistoryTotal++
				p.hist = nil
				if len(s.History) < HangHistoryCap {
					ev := t[k+len("event: '") : len(t)-1]
					s.History = append(s.History, HangWait{N: num, Event: ev, GapSec: p.gap, GapLabel: p.gapLabel, Params: []string{}, Line: n})
					p.hist = &s.History[len(s.History)-1]
				}
				p.gap, p.gapLabel = nil, ""
				return
			}
		}
	}
	if len(t) > 3 && t[0] == 'p' && t[1] >= '0' && t[1] <= '9' && t[2] == ':' && p.hist != nil {
		p.hist.Params = append(p.hist.Params, t)
	}
}

// nodeLine reads a line of a node table: its header or a row "[254]/1/255/22508/0xa299efe8/13912/NLEAF/[51]".
func (p *hangParser) nodeLine(n int, t string) {
	hn := p.nodes
	if hn == nil {
		return
	}
	if strings.HasPrefix(t, "([nodenum]") {
		hn.Header = t
		return
	}
	if !strings.HasPrefix(t, "[") {
		return
	}
	f := strings.Split(t, "/")
	if len(f) < 7 || !strings.HasSuffix(f[0], "]") {
		return
	}
	num, err := strconv.Atoi(strings.Trim(f[0], "[]"))
	if err != nil {
		return
	}
	hn.Total++
	if len(hn.Rows) >= HangNodeCap {
		return
	}
	nd := HangNode{Line: n, Num: num, Session: f[4], OSPid: f[5], State: f[6], Adj: []int{}}
	nd.CNode, _ = strconv.Atoi(f[1])
	nd.Sid, _ = strconv.Atoi(f[2])
	nd.Serial, _ = strconv.Atoi(f[3])
	nd.Key = strconv.Itoa(nd.Sid) + "." + strconv.Itoa(nd.Serial)
	if len(f) > 7 {
		adj := strings.Join(f[7:], "/")
		for _, part := range strings.Split(adj, "]") {
			part = strings.Trim(part, "[ ")
			if v, err := strconv.Atoi(part); err == nil {
				nd.Adj = append(nd.Adj, v)
			}
		}
	}
	hn.Rows = append(hn.Rows, nd)
}

// finish links the list and the chains and adds the notes.
func (p *hangParser) finish() {
	h := p.h
	for i := range h.Chains {
		c := &h.Chains[i]
		for _, l := range h.Listed {
			if l.Chain == c.N {
				c.Listed, c.Letter = true, l.Letter
				if c.Signature == "" {
					c.Signature, c.Events = l.Signature, l.Events
				}
				if c.Hash == "" {
					c.Hash = l.Hash
				}
				break
			}
		}
	}
	if h.HeaderLine == 0 {
		h.Notes = append(h.Notes, "no \"HANG ANALYSIS:\" line in this part")
	}
	if !h.Ended {
		h.Notes = append(h.Notes, "the analysis is cut short: its \"END OF HANG ANALYSIS\" line was not reached")
	}
	if h.ChainsTotal == 0 {
		h.Notes = append(h.Notes, "the dump prints no chain")
	}
	if h.ChainsTotal > len(h.Chains) {
		h.Notes = append(h.Notes, strconv.Itoa(h.ChainsTotal-len(h.Chains))+" chains are not listed (the bound is "+strconv.Itoa(HangChainCap)+")")
	}
	if h.Nodes != nil && h.Nodes.Total > len(h.Nodes.Rows) {
		h.Notes = append(h.Notes, "only the first "+strconv.Itoa(len(h.Nodes.Rows))+" of "+strconv.Itoa(h.Nodes.Total)+" nodes are listed")
	}
	for _, c := range h.Chains {
		if c.SessionsTotal > len(c.Sessions) {
			h.Notes = append(h.Notes, "chain "+strconv.Itoa(c.N)+": only the first "+strconv.Itoa(len(c.Sessions))+" of "+strconv.Itoa(c.SessionsTotal)+" sessions are listed")
		}
	}
	if h.InitiatedBy == "" {
		h.Notes = append(h.Notes, "the dump does not say what initiated the analysis (the oradebug form prints \"analysis initiated by oradebug\")")
	}
}

// sqlIDAlphabet is the base 32 alphabet of a sql_id (no e, i, l, o).
const sqlIDAlphabet = "0123456789abcdfghjkmnpqrstuvwxyz"

// SQLIDParts decodes a 13-character sql_id into the two 32-bit halves of the 64-bit number it spells: low is the
// statement's hash value (the last 4 bytes of its MD5: "Hash=" of a library handle, "Identifier=" of its
// FullHashValue line, `hv=` of a 10046 trace), high is what a hang analysis prints as "current sql_id" (bytes 9 to 12
// of the FullHashValue).
func SQLIDParts(sqlID string) (high, low uint32, ok bool) {
	if len(sqlID) != 13 {
		return 0, 0, false
	}
	var v uint64
	for i := 0; i < len(sqlID); i++ {
		k := strings.IndexByte(sqlIDAlphabet, sqlID[i])
		if k < 0 {
			return 0, 0, false
		}
		v = v<<5 | uint64(k)
	}
	return uint32(v >> 32), uint32(v), true
}
