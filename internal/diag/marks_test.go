package diag

import (
	"bytes"
	"fmt"
	"os"
	"regexp"
	"strings"
	"testing"
)

// The marks are checked against an oracle that reads the same file with regular expressions, line by line,
// independently of the scan.
var (
	markSQL = []*regexp.Regexp{
		regexp.MustCompile(`^----- Current SQL Statement for this session \(sql_id=([0-9a-z]{13})\)`),
		regexp.MustCompile(`^----- Dump Cursor sql_id=([0-9a-z]{13}) `),
		regexp.MustCompile(`^ +FullHashValue=\S+ .*?SqlId=([0-9a-z]{13}) `),
	}
	markSess = []*regexp.Regexp{
		regexp.MustCompile(`^\*\*\* SESSION ID:\((\d+)\.(\d+)\)`),
		regexp.MustCompile(`^ *\(session\) sid: (\d+) ser: (\d+)`),
		regexp.MustCompile(`^ *inst: \d+, sid: (\d+), ser: (\d+)`),
		regexp.MustCompile(`^ *sid: (\d+) ser: (\d+)`),
		regexp.MustCompile(`^ *\d+: \S+ ospid \S+ sid (\d+) ser (\d+),`),
	}
	hangSid = regexp.MustCompile(`^ *session id: (\d+)`)
	hangSer = regexp.MustCompile(`^ *session serial #: (\d+)`)
)

func oracleMarks(data []byte) (sqlIDs, sessions []string) {
	seenS, seenN := map[string]bool{}, map[string]bool{}
	addS := func(s string) {
		if !seenS[s] && len(sqlIDs) < MarkCap {
			seenS[s] = true
			sqlIDs = append(sqlIDs, s)
		}
	}
	addN := func(sid, ser string) {
		k := sid + "." + ser
		if (sid == "0" && ser == "0") || seenN[k] || len(sessions) >= MarkCap {
			return
		}
		seenN[k] = true
		sessions = append(sessions, k)
	}
	pending := ""
	for _, l := range strings.Split(string(data), "\n") {
		l = strings.TrimRight(l, "\r")
		for _, re := range markSQL {
			if m := re.FindStringSubmatch(l); m != nil {
				addS(m[1])
			}
		}
		for _, re := range markSess {
			if m := re.FindStringSubmatch(l); m != nil {
				addN(m[1], m[2])
			}
		}
		if m := hangSid.FindStringSubmatch(l); m != nil {
			pending = m[1]
		} else if m := hangSer.FindStringSubmatch(l); m != nil && pending != "" {
			addN(pending, m[1])
			pending = ""
		}
	}
	return
}

// TestMarks: the scan's marks equal the oracle's on every fixture, and say what they should on a few.
func TestMarks(t *testing.T) {
	files := append(fixtures(t), bigFixtures()...)
	for _, fx := range files {
		data, err := os.ReadFile(fx)
		if err != nil {
			t.Fatal(err)
		}
		r := readerOf(t, fx)
		wantS, wantN := oracleMarks(data)
		if fmt.Sprint(r.Scan.MarkSQLIDs) != fmt.Sprint(wantS) {
			t.Errorf("%s: sql ids %v, the oracle %v", fixtureName(fx), r.Scan.MarkSQLIDs, wantS)
		}
		if fmt.Sprint(r.Scan.MarkSessions) != fmt.Sprint(wantN) {
			t.Errorf("%s: sessions %v, the oracle %v", fixtureName(fx), r.Scan.MarkSessions, wantN)
		}
	}
	has := func(l []string, s string) bool {
		for _, x := range l {
			if x == s {
				return true
			}
		}
		return false
	}
	l2 := readerOf(t, diagDir+"/diag_errorstack_l2.trc").Scan
	if len(l2.MarkSQLIDs) < 15 || l2.MarkSQLIDs[0] != "86trfcf9m9n9f" || !has(l2.MarkSQLIDs, "f3j90cdzgg7d2") || !has(l2.MarkSQLIDs, "9zg9qd9bm4spu") {
		t.Errorf("errorstack sql ids %v", l2.MarkSQLIDs)
	}
	if len(l2.MarkSessions) == 0 || l2.MarkSessions[0] != "22.14058" {
		t.Errorf("errorstack sessions %v", l2.MarkSessions)
	}
	sys := readerOf(t, diagDir+"/diag_sysstate_l1.trc").Scan
	for _, k := range []string{"52.41898", "45.12004", "255.62769", "1.13443"} {
		if !has(sys.MarkSessions, k) {
			t.Errorf("system state: no %s in %v", k, sys.MarkSessions)
		}
	}
	if has(sys.MarkSessions, "0.0") {
		t.Errorf("sid 0 ser 0 is a mark")
	}
	hang := readerOf(t, diagDir+"/diag_hang.trc").Scan
	if len(hang.MarkSessions) < 3 || !has(hang.MarkSessions, "255.22508") {
		t.Errorf("hang analysis sessions %v", hang.MarkSessions)
	}
	dl := readerOf(t, diagDir+"/diag_deadlock.trc").Scan
	if !has(dl.MarkSessions, "255.52110") {
		t.Errorf("deadlock sessions %v", dl.MarkSessions)
	}
	// a heap dump names none
	if h := readerOf(t, diagDir+"/diag_heap_pga.trc").Scan; len(h.MarkSQLIDs) != 0 {
		t.Errorf("heap dump sql ids %v", h.MarkSQLIDs)
	}
}

// TestMarksBound: at most MarkCap of each, first-seen order, no repeats.
func TestMarksBound(t *testing.T) {
	var b bytes.Buffer
	b.WriteString("Trace file x.trc\nOracle Database 19c Enterprise Edition Release 19.0.0.0.0 - Production\nVersion 19.27.0.0.0\n\n")
	const alpha = "0123456789abcdefghijklmnopqrstuvwxyz"
	for i := 0; i < MarkCap+120; i++ {
		id := fmt.Sprintf("%c%c%c%c%c%c%c%c%c%c%c%c%c", alpha[i%36], alpha[(i/36)%36], 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k')
		fmt.Fprintf(&b, "----- Dump Cursor sql_id=%s xsc=0x1 cur=0x2 -----\n", id)
		fmt.Fprintf(&b, "----- Dump Cursor sql_id=%s xsc=0x1 cur=0x2 -----\n", id) // a repeat
		fmt.Fprintf(&b, "(session) sid: %d ser: %d trans: (nil)\n", i+1, 7)
		fmt.Fprintf(&b, "    inst: 1, sid: %d, ser: %d\n", i+1, 7)
	}
	sc, err := ScanReader(&b, "x.trc")
	if err != nil {
		t.Fatal(err)
	}
	if len(sc.MarkSQLIDs) != MarkCap || len(sc.MarkSessions) != MarkCap {
		t.Fatalf("%d sql ids, %d sessions", len(sc.MarkSQLIDs), len(sc.MarkSessions))
	}
	if sc.MarkSQLIDs[0] != "00abcdefghijk" || sc.MarkSQLIDs[1] != "10abcdefghijk" || sc.MarkSessions[0] != "1.7" || sc.MarkSessions[MarkCap-1] != fmt.Sprintf("%d.7", MarkCap) {
		t.Errorf("first and last: %v ... %v", sc.MarkSQLIDs[:2], sc.MarkSessions[MarkCap-1])
	}
	seen := map[string]bool{}
	for _, s := range sc.MarkSQLIDs {
		if seen[s] {
			t.Fatalf("%s twice", s)
		}
		seen[s] = true
	}
}
