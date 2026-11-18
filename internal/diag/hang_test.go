package diag

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

func hangOf(t testing.TB, r *Reader) (Node, *HangReading) {
	t.Helper()
	for _, n := range r.Scan.Top {
		if n.Kind == "hang" {
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatal(err)
			}
			return n, rd.(*HangReading)
		}
	}
	t.Fatal("no hang analysis in the file")
	return Node{}, nil
}

// TestHangFixtures: the hang analysis of diag_hang (oradebug hanganalyze 3, scenario sc_diag_hang.sql: three sessions in
// a chain, session 3 waits for a row that session 2 holds, session 2 for a row that session 1 holds, session 1 sleeps)
// and of diag_hang_event (the same by event: no "analysis initiated by" line).
func TestHangFixtures(t *testing.T) {
	for _, tc := range []struct {
		file                string
		initiated           string
		listed              int
		chains              int
		nodes               int
		extraChains         []string
		text                bool // the form prints the statements' text and the short stacks (the event form does not)
		firstWait, lastWait string
	}{
		{"diag_hang.trc", "oradebug", 2, 2, 4, []string{"Streams AQ: waiting for messages in the queue"}, true, "enq: TX - row lock contention", "PL/SQL lock timer"},
		{"diag_hang_event.trc", "", 3, 3, 5, []string{"Streams AQ: waiting for messages in the queue", "Redo Transport Attach"}, false, "enq: TX - row lock contention", "PL/SQL lock timer"},
	} {
		tc := tc
		t.Run(strings.TrimSuffix(tc.file, ".trc"), func(t *testing.T) {
			r := readerOf(t, filepath.Join(diagDir, tc.file))
			n, h := hangOf(t, r)
			if h.From != n.From || h.To != n.To || n.Reading != "hang" || !h.Ended {
				t.Errorf("node %+v, reading %d-%d ended %v", n, h.From, h.To, h.Ended)
			}
			if len(h.Instances) != 1 || h.Instances[0] != "cdb1.cdb1" || h.Level == nil || *h.Level != 3 || h.InitiatedBy != tc.initiated {
				t.Errorf("header: %v level %v initiated %q", h.Instances, h.Level, h.InitiatedBy)
			}
			if len(h.Delays) < 5 || !strings.HasPrefix(h.Delays[0], "os thread scheduling delay history") {
				t.Errorf("delays %v", h.Delays)
			}
			if len(h.Listed) != tc.listed || len(h.Chains) != tc.chains || h.ChainsTotal != tc.chains {
				t.Fatalf("%d listed, %d chains", len(h.Listed), len(h.Chains))
			}
			// the list
			l0 := h.Listed[0]
			wantSig := "'PL/SQL lock timer'<='enq: TX - row lock contention'<='enq: TX - row lock contention'"
			if l0.Letter != "a" || l0.Chain != 1 || l0.Signature != wantSig || l0.Hash != "0x5e4fa8d6" || len(l0.Events) != 3 || l0.Events[0] != "PL/SQL lock timer" {
				t.Errorf("listed[0] %+v", l0)
			}
			// the chain: three sessions in blocked-by order, the same shape in both files
			c := h.Chains[0]
			if c.N != 1 || c.Group != "Non-intersecting chains" || !c.Listed || c.Letter != "a" || c.Signature != wantSig || c.Hash != "0x5e4fa8d6" || c.SessionsTotal != 3 || len(c.Sessions) != 3 {
				t.Fatalf("chain 1 %+v", c)
			}
			s := c.Sessions
			for i, ss := range s {
				if ss.Position != i+1 || ss.Key != fmt.Sprintf("%d.%d", ss.Sid, ss.Serial) || !ss.Waiting || ss.Instance != "1 (cdb1.cdb1)" || ss.PDB != "PDB1" || ss.PDBID == nil || *ss.PDBID != 3 ||
					ss.ProcessID == nil || ss.OSId == "" || ss.TimeInWaitSec == nil || *ss.TimeInWaitSec <= 0 || ss.Blocking == nil || ss.WaitID == nil || ss.SqlIdHigh == nil || *ss.SqlIdHigh == 0 ||
					(ss.SqlText != "") != tc.text || ss.ModuleNum == nil || *ss.ModuleNum != 3 || !strings.HasPrefix(ss.Module, "mtk_diag_chain") ||
					(ss.ShortStack != "") != tc.text || (tc.text && (ss.ShortStackOwn != 5 || !strings.HasPrefix(ss.ShortStackNoOwn, "semtimedop<-"))) {
					t.Errorf("session %d: %+v", i+1, ss)
				}
				if ss.From > ss.Line || ss.To < ss.Line || ss.From < h.From || ss.To > h.To || ss.To >= s[min(i+1, 2)].From && i < 2 {
					t.Errorf("session %d lines %d-%d (line %d)", i+1, ss.From, ss.To, ss.Line)
				}
				if len(ss.History) != 3 || ss.HistoryTotal != 3 || ss.History[0].Event != "SQL*Net message from client" || ss.History[0].GapSec == nil || ss.History[0].WaitedS == nil || ss.History[0].WaitID == nil || len(ss.History[0].Params) != 2 {
					t.Errorf("session %d history %+v", i+1, ss.History)
				}
			}
			// the order is the order of "is blocked by": the waiters' wait events, the number of sessions each blocks
			if s[0].Event != tc.firstWait || s[1].Event != tc.firstWait || s[2].Event != tc.lastWait {
				t.Errorf("events %q %q %q", s[0].Event, s[1].Event, s[2].Event)
			}
			if *s[0].Blocking != 0 || *s[1].Blocking != 1 || *s[2].Blocking != 2 {
				t.Errorf("blocking %d %d %d", *s[0].Blocking, *s[1].Blocking, *s[2].Blocking)
			}
			if tc.text && (!strings.Contains(s[0].SqlText, "id = 302") || !strings.Contains(s[1].SqlText, "id = 301") || s[2].SqlText != "BEGIN dbms_session.sleep(16); END;") {
				t.Errorf("statements %q %q %q", s[0].SqlText, s[1].SqlText, s[2].SqlText)
			}
			// the same statements have the same number in both files (the statement of the third session is the
			// same block in both; the other two in the event file are the same select with other ids)
			if tc.text {
				if *s[0].SqlIdHigh != 3373088609 || *s[1].SqlIdHigh != 3824709289 || *s[2].SqlIdHigh != 325942433 {
					t.Errorf("current sql_id numbers %d %d %d", *s[0].SqlIdHigh, *s[1].SqlIdHigh, *s[2].SqlIdHigh)
				}
			}
			if len(s[0].Params) != 3 || s[0].Params[0] != "p1: 'name|mode'=0x54580006" || len(s[2].Params) != 1 || s[2].Params[0] != "p1: 'duration'=0x0" {
				t.Errorf("parameters %v %v", s[0].Params, s[2].Params)
			}
			// the signature is the events the other way round
			var ev []string
			for i := len(s) - 1; i >= 0; i-- {
				ev = append(ev, s[i].Event)
			}
			if strings.Join(ev, "|") != strings.Join(c.Events, "|") {
				t.Errorf("signature %v, events of the sessions from the head %v", c.Events, ev)
			}
			// the node table says the same: each session is adjacent to the one that blocks it
			if h.Nodes == nil || h.Nodes.Total != tc.nodes || len(h.Nodes.Rows) != tc.nodes || !strings.HasPrefix(h.Nodes.Header, "([nodenum]/cnode/sid/sess_srno/session/ospid/state/[adjlist]):") {
				t.Fatalf("nodes %+v", h.Nodes)
			}
			byKey := map[string]HangNode{}
			byNum := map[int]HangNode{}
			for _, nd := range h.Nodes.Rows {
				byKey[nd.Key] = nd
				byNum[nd.Num] = nd
				inNode(t, "node row", nd.Line, h.From, h.To)
			}
			for i := 0; i < 2; i++ {
				nd, ok := byKey[s[i].Key]
				if !ok || len(nd.Adj) != 1 || byNum[nd.Adj[0]].Key != s[i+1].Key || nd.OSPid != s[i].OSId || nd.State != "NLEAF" {
					t.Errorf("node of session %d: %+v (the next is %s)", i+1, nd, s[i+1].Key)
				}
			}
			if nd := byKey[s[2].Key]; len(nd.Adj) != 0 || nd.State != "LEAF" {
				t.Errorf("the head's node %+v", nd)
			}
			// the other chains and the dumps block
			for i, want := range tc.extraChains {
				ch := h.Chains[i+1]
				if ch.N != i+2 || len(ch.Sessions) != 1 || ch.Sessions[0].Event != want || ch.Group != "Sessions in an involuntary wait or not in a wait" || ch.Hash == "" {
					t.Errorf("chain %d: %+v", i+2, ch)
				}
			}
			if h.Dumps == nil || !h.Dumps.Ended || h.Dumps.Level == nil || *h.Dumps.Level != 3 || h.Dumps.Local == nil || h.Dumps.Local.Total != tc.nodes || len(h.Dumps.Lines) != 1 || h.Dumps.Lines[0] != "No processes qualify for dumping." {
				t.Errorf("dumps %+v", h.Dumps)
			}
			if len(h.Extra) < 2 || !strings.HasPrefix(h.Extra[0], "[level  4]") {
				t.Errorf("extra %v", h.Extra)
			}
			// chains tile no further than the section and keep their order
			prev := h.From
			for _, ch := range h.Chains {
				if ch.From < prev || ch.To > h.To || ch.To < ch.From {
					t.Errorf("chain %d lines %d-%d", ch.N, ch.From, ch.To)
				}
				prev = ch.To
			}
			raw, _ := json.Marshal(h)
			if jsonNull.Match(raw) {
				i := jsonNull.FindIndex(raw)
				t.Errorf("a null in the reading: ...%s", raw[max(0, i[0]-60):i[1]])
			}
		})
	}
}

// TestHangSqlIDHigh finds out what the numeric "current sql_id" of a hang analysis is. The format reference listed as
// unverified that it is the hash value (`hv=` of a 10046 trace). It is not: it is the high 32 bits of the 64-bit number
// the sql_id spells, which is bytes 9 to 12 of the FullHashValue of the statement's library handle; the hash value is the
// low 32 bits (the last four bytes, "Hash=" of the handle and "Identifier=" of its FullHashValue line). The statements
// are in the system state fixtures (not in git: the lines are given here, with their place) and in the hang analyses.
func TestHangSqlIDHigh(t *testing.T) {
	// each: sql_id, FullHashValue, Identifier (the hash value) as the library handle prints them, the statement, the numbers
	// a hang analysis of diag_hang prints for it, and where the handle's lines are
	cases := []struct {
		sqlID, fullHash string
		identifier      uint32
		text            string
		hang            int64 // "current sql_id:" in diag_hang.trc
		at              string
	}{
		{"ck39zc6g6ufn3", "ee9e4662e14b3f2ec90d3f619e6d3a83", 2657958531, "select id from mtk_cust where id = 302 for update wait 60", 3373088609, "big/diag_sysstate_l266.trc:42802 (Hash=9e6d3a83 on :42800)"},
		{"f7y3fp7r3u84f", "397184b5a5b27134e3f86ea9ee3d208e", 3996983438, "select id from mtk_cust where id = 301 for update wait 60", 3824709289, "big/diag_sysstate_l266.trc:50680 (Hash=ee3d208e on :50678)"},
		{"8gqhcqqam4cth", "ee4c5ff77583903b87da0cb595323330", 2503095088, "DECLARE job BINARY_INTEGER := :job; ...", 2279214261, "big/diag_sysstate_l266.trc:32332 (Hash=95323330 on :32330)"},
	}
	r := readerOf(t, filepath.Join(diagDir, "diag_hang.trc"))
	_, h := hangOf(t, r)
	printed := map[string]int64{} // statement start -> the number the hang analysis prints
	for _, c := range h.Chains {
		for _, s := range c.Sessions {
			printed[s.SqlText] = *s.SqlIdHigh
		}
	}
	for _, c := range cases {
		hi, lo, ok := SQLIDParts(c.sqlID)
		if !ok {
			t.Fatalf("%s does not decode", c.sqlID)
		}
		fh := c.fullHash
		if want := fmt.Sprintf("%08x%08x", hi, lo); fh[16:] != want {
			t.Errorf("%s: the sql_id spells %s, the FullHashValue ends with %s (%s)", c.sqlID, want, fh[16:], c.at)
		}
		// the hash value is the low half, the last four bytes; the number of the hang analysis is the half before it
		if lo != c.identifier || fmt.Sprintf("%08x", lo) != fh[24:] {
			t.Errorf("%s: the low half %d is not the hash value %d", c.sqlID, lo, c.identifier)
		}
		if int64(hi) != c.hang || fmt.Sprintf("%08x", hi) != fh[16:24] {
			t.Errorf("%s: the high half %d, the hang analysis prints %d", c.sqlID, hi, c.hang)
		}
		if int64(lo) == c.hang {
			t.Errorf("%s: the number of the hang analysis is the hash value", c.sqlID)
		}
		// diag_hang.trc prints that number for that statement (the scheduler job's text is cut in the fixture: compare its start)
		found := false
		for text, n := range printed {
			if strings.HasPrefix(text, strings.TrimSuffix(c.text, " ...")) {
				found = true
				if n != c.hang {
					t.Errorf("diag_hang prints %d for %q, want %d", n, text, c.hang)
				}
			}
		}
		if !found {
			t.Errorf("diag_hang has no session with the statement %q", c.text)
		}
	}
	// and in the lines of the system state dumps themselves, when they are here
	big := filepath.Join(bigDir, "diag_sysstate_l266.trc")
	f, err := os.Open(big)
	if err != nil {
		t.Logf("%s is not here: the library handle lines of the cases are not read again", big)
		return
	}
	defer f.Close()
	re := regexp.MustCompile(`FullHashValue=([0-9a-f]{32}) .* SqlId=([0-9a-z]{13}) .* Identifier=(\d+) `)
	hashLine := regexp.MustCompile(`LibraryHandle:  Address=0x[0-9a-f]+ Hash=([0-9a-f]+) `)
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<20)
	found, lastHash := 0, ""
	for sc.Scan() {
		line := sc.Text()
		if m := hashLine.FindStringSubmatch(line); m != nil {
			lastHash = m[1]
		}
		m := re.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		hi, lo, _ := SQLIDParts(m[2])
		id, _ := strconv.ParseUint(m[3], 10, 32)
		// every statement handle of the dump: the sql_id spells the last 8 bytes of the full hash, the hash value is the Identifier and the Hash= of the handle
		if hv, _ := strconv.ParseUint(lastHash, 16, 32); m[1][16:] != fmt.Sprintf("%08x%08x", hi, lo) || uint32(id) != lo || uint32(hv) != lo {
			t.Errorf("handle %s: FullHashValue %s, identifier %d, Hash=%s, sql_id halves %08x %08x", m[2], m[1], id, lastHash, hi, lo)
		}
		found++
	}
	if found < 20 {
		t.Errorf("only %d statement handles in the dump", found)
	}
	t.Logf("%d statement handles of %s: the sql_id is the last 8 bytes of FullHashValue, the hash value its last 4", found, filepath.Base(big))
}

// TestHangSynthetic: the forms the lab does not show but the reader reads: a session that is not waiting, two
// instances, a statement over several lines, a cut analysis.
func TestHangSynthetic(t *testing.T) {
	text := `===============================================================================
HANG ANALYSIS:
  instances (db_name.oracle_sid): orcl1.orcl1, orcl2.orcl2
  oradebug_node_dump_level: 4
  analysis initiated by oradebug
===============================================================================

Chains most likely to have caused the hang:
 [a] Chain 1 Signature: 'log file sync'<='enq: TX - row lock contention'
     Chain 1 Signature Hash: 0x1234abcd

===============================================================================
Non-intersecting chains:

-------------------------------------------------------------------------------
Chain 1:
-------------------------------------------------------------------------------
    Oracle session identified by:
    {
                instance: 2 (orcl2.orcl2)
                   os id: 100
              process id: 7, oracle@h
              session id: 9
        session serial #: 3
    }
    is waiting for 'enq: TX - row lock contention' with wait info:
    {
                      p1: 'name|mode'=0x1
            time in wait: 12.5 sec
           timeout after: never
                 wait id: 5
                blocking: 0 sessions
          current sql_id: 0
    }
    and is blocked by
 => Oracle session identified by:
    {
                instance: 1 (orcl1.orcl1)
                   os id: 101
              process id: 8, oracle@h
              session id: 11
        session serial #: 4
    }
    which is not in a wait:
    {
                last wait: 3.25 sec ago
                blocking: 1 session
          current sql_id: 42
             current sql: select a,
 b from t
 where x: 1
             short stack: ksedsts<-ksdxfstk<-ksdxcb<-sspuser<-__sighandler()<-foo<-bar
    }

Chain 1 Signature: 'log file sync'<='enq: TX - row lock contention'
Chain 1 Signature Hash: 0x1234abcd
-------------------------------------------------------------------------------
`
	r := readerOfBytes(t, []byte(text))
	_, h := hangOf(t, r)
	if len(h.Instances) != 2 || h.Instances[1] != "orcl2.orcl2" || h.Ended || len(h.Chains) != 1 {
		t.Fatalf("%+v", h)
	}
	said := false
	for _, n := range h.Notes {
		said = said || strings.Contains(n, "cut short")
	}
	if !said {
		t.Errorf("a cut analysis does not say so: %v", h.Notes)
	}
	s := h.Chains[0].Sessions
	if len(s) != 2 || s[0].Instance != "2 (orcl2.orcl2)" || s[0].TimeoutText != "never" || s[0].TimeoutSec != nil || s[0].SqlIdHigh == nil || *s[0].SqlIdHigh != 0 || s[0].SqlText != "" {
		t.Fatalf("sessions %+v", s)
	}
	if s[1].Waiting || s[1].Event != "" || !strings.Contains(s[1].State, "not in a wait") || s[1].LastWaitText != "3.25 sec ago" || *s[1].Blocking != 1 || *s[1].SqlIdHigh != 42 {
		t.Errorf("the session that is not waiting: %+v", s[1])
	}
	if s[1].SqlText != "select a,\nb from t\nwhere x: 1" {
		t.Errorf("a statement over several lines: %q", s[1].SqlText)
	}
	if s[1].ShortStackOwn != 5 || s[1].ShortStackNoOwn != "foo<-bar" {
		t.Errorf("short stack %+v", s[1])
	}
	if h.Chains[0].Signature != "'log file sync'<='enq: TX - row lock contention'" || h.Chains[0].Hash != "0x1234abcd" {
		t.Errorf("chain %+v", h.Chains[0])
	}
}

// TestHangBounds: more chains, sessions and history entries than the bounds are counted, not listed.
func TestHangBounds(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("===============================================================================\nHANG ANALYSIS:\n  instances (db_name.oracle_sid): x.x\n===============================================================================\n \nNon-intersecting chains:\n \n")
	for c := 1; c <= HangChainCap+30; c++ {
		fmt.Fprintf(&b, "-------------------------------------------------------------------------------\nChain %d:\n-------------------------------------------------------------------------------\n", c)
		n := 1
		if c == 1 {
			n = HangSessionCap + 20
		}
		for i := 0; i < n; i++ {
			if i > 0 {
				b.WriteString("    and is blocked by\n => ")
			}
			fmt.Fprintf(&b, "    Oracle session identified by:\n    {\n              session id: %d\n        session serial #: %d\n    }\n    is waiting for 'x' with wait info:\n    {\n            time in wait: 1 sec\n            wait history:\n", i+1, c)
			for k := 1; k <= HangHistoryCap+5; k++ {
				fmt.Fprintf(&b, "              * time between wait #%d and #%d: 0.1 sec\n              %d.       event: 'e%d'\n                 time waited: 0.5 sec\n                     wait id: %d\n", k-1, k, k, k, k)
			}
			b.WriteString("    }\n")
		}
		fmt.Fprintf(&b, "\nChain %d Signature: 'x'\nChain %d Signature Hash: 0x1\n", c, c)
	}
	b.WriteString("===============================================================================\nEND OF HANG ANALYSIS\n===============================================================================\n")
	r := readerOfBytes(t, b.Bytes())
	_, h := hangOf(t, r)
	if h.ChainsTotal != HangChainCap+30 || len(h.Chains) != HangChainCap {
		t.Errorf("%d chains of %d", len(h.Chains), h.ChainsTotal)
	}
	c := h.Chains[0]
	if c.SessionsTotal != HangSessionCap+20 || len(c.Sessions) != HangSessionCap {
		t.Errorf("%d sessions of %d", len(c.Sessions), c.SessionsTotal)
	}
	if s := c.Sessions[0]; s.HistoryTotal != HangHistoryCap+5 || len(s.History) != HangHistoryCap {
		t.Errorf("%d history of %d", len(s.History), s.HistoryTotal)
	}
	if len(h.Notes) < 3 {
		t.Errorf("notes %v", h.Notes)
	}
	var tb bytes.Buffer
	writeHangText(&tb, "", h)
	if strings.Count(tb.String(), "\n") > 400 {
		t.Errorf("the text is %d lines", strings.Count(tb.String(), "\n"))
	}
}

// TestHangPrefixesAndMutations: every prefix of both fixtures, and damaged ones, read without a panic; a cut analysis says so.
func TestHangPrefixesAndMutations(t *testing.T) {
	for _, name := range []string{"diag_hang.trc", "diag_hang_event.trc"} {
		data, err := os.ReadFile(filepath.Join(diagDir, name))
		if err != nil {
			t.Fatal(err)
		}
		step := max(1, len(data)/150)
		for cut := 0; cut <= len(data); cut += step {
			r := readerOfBytes(t, data[:cut])
			for _, n := range r.Scan.Top {
				if n.Kind != "hang" {
					continue
				}
				rd, err := r.Reading(n.ID)
				if err != nil {
					t.Fatalf("%s[:%d]: %v", name, cut, err)
				}
				h := rd.(*HangReading)
				if !h.Ended {
					said := false
					for _, nn := range h.Notes {
						said = said || strings.Contains(nn, "cut short")
					}
					if !said {
						t.Errorf("%s[:%d]: a cut analysis does not say so: %v", name, cut, h.Notes)
					}
				}
				for _, c := range h.Chains {
					for _, s := range c.Sessions {
						if s.Key == "" || s.To < s.From {
							t.Errorf("%s[:%d]: session %+v", name, cut, s)
						}
					}
				}
				var b bytes.Buffer
				writeHangText(&b, "", h)
			}
		}
	}
	data, _ := os.ReadFile(filepath.Join(diagDir, "diag_hang_event.trc"))
	all := strings.Split(string(data), "\n")
	junk := []string{"Chain 1:", "Chain 9 Signature: 'a'<='b'", "Chain 1 Signature Hash: 0x1", "    Oracle session identified by:", "    {", "    }", "    which is waiting for 'x' with wait info:",
		"current sql: select 1", "wait history:", "              1.       event: 'x'", "                 time waited: 1 sec", "[1]/2/3", "[1]/1/3/4/0x1/5/LEAF/[9][8", "State of ALL nodes", "HANG ANALYSIS DUMPS: END", "END OF HANG ANALYSIS",
		"=====", " [a] Chain 1 Signature: 'x'", "Non-intersecting chains:", "", "Extra information that will be dumped at higher levels:", "[level  4] :   1 node dumps"}
	rng := rand.New(rand.NewSource(3))
	for it := 0; it < 300; it++ {
		m := append([]string(nil), all...)
		for k := rng.Intn(30) + 1; k > 0; k-- {
			i := rng.Intn(len(m))
			switch rng.Intn(5) {
			case 0:
				m = append(m[:i], m[i+1:]...)
			case 1:
				m = append(m[:i], append([]string{m[i]}, m[i:]...)...)
			case 2:
				j := rng.Intn(len(m))
				m[i], m[j] = m[j], m[i]
			case 3:
				m[i] = junk[rng.Intn(len(junk))]
			case 4:
				m = append(m[:i], append([]string{junk[rng.Intn(len(junk))]}, m[i:]...)...)
			}
		}
		r := readerOfBytes(t, []byte(strings.Join(m, "\n")))
		for _, n := range r.Scan.Top {
			if n.Kind != "hang" {
				continue
			}
			rd, err := r.Reading(n.ID)
			if err != nil {
				t.Fatalf("mutation %d: %v", it, err)
			}
			h := rd.(*HangReading)
			if len(h.Chains) > h.ChainsTotal {
				t.Fatalf("mutation %d: %d chains of %d", it, len(h.Chains), h.ChainsTotal)
			}
			var b bytes.Buffer
			writeHangText(&b, "", h)
			if _, err := json.Marshal(h); err != nil {
				t.Fatal(err)
			}
		}
	}
}

// TestHangDigest: the document's digest holds the reading, and the text has its numbers.
func TestHangDigest(t *testing.T) {
	r := readerOf(t, filepath.Join(diagDir, "diag_hang.trc"))
	n, h := hangOf(t, r)
	d, err := r.Digest()
	if err != nil {
		t.Fatal(err)
	}
	raw, ok := d.Readings[n.ID]
	if !ok || !strings.HasPrefix(string(raw), `{"kind":"hang","node":`) {
		t.Fatalf("the digest's readings: %v", d.Readings)
	}
	var b bytes.Buffer
	if err := WriteDigest(&b, r); err != nil {
		t.Fatal(err)
	}
	text := b.String()
	for _, c := range h.Chains {
		for _, s := range c.Sessions {
			for _, want := range []string{s.Key, fmt.Sprint(*s.SqlIdHigh), s.OSId, *tsec(s.TimeInWaitSec)} {
				if !strings.Contains(text, want) {
					t.Errorf("the text has no %q", want)
				}
			}
		}
	}
	for _, l := range h.Listed {
		if !strings.Contains(text, l.Hash) {
			t.Errorf("the text has no hash %s", l.Hash)
		}
	}
}

func tsec(f *float64) *string {
	s := strconv.FormatFloat(*f, 'f', -1, 64)
	return &s
}
