package diag

import "bytes"

// Marks for the jump to a 10046 tab (docs/PLAN-DIAG.md § The reader, "A jump to the primary formats"): the
// statements and the sessions a diag file names, so that a client can mark them when another open tab holds
// the same sql_id or session. They are collected in the scan pass, line by line, with prefix tests only (no
// second read of the file), and they are what the scan sees, nothing more:
//
//	sql_id    "----- Current SQL Statement for this session (sql_id=8fdx3ffur0ddr) -----"
//	          "----- Dump Cursor sql_id=9zg9qd9bm4spu xsc=0x7f89b1895f58 cur=0x7f89b20c2538 -----"
//	          "... FullHashValue=ddcd... Namespace=SQL AREA(00) SqlId=f3j90cdzgg7d2 Type=CURSOR(00) ..." (a library
//	          handle of a process state or a cursor dump)
//	session   "*** SESSION ID:(61.29861) 2026-11-17T21:34:27.092531+00:00" (the file header)
//	          "(session) sid: 61 ser: 21652 trans: ..." (a session state object, process state and system state)
//	          "6: USER ospid 13945 sid 52 ser 41898, waiting for ..." (the process summary of a system state)
//	          "inst: 1, sid: 52, ser: 41898" (the blockers and waiters a process state names)
//	          "session id: 255" and "session serial #: 22508" (a hang analysis: the pair of lines of a session)
//	          "sid: 255 ser: 52110 audsid: 4273372 user: 165/MTK" (a deadlock's information for waiting sessions)
//
// The lists are in first-seen order, without repeats, at most MarkCap each. sid 0 ser 0 (a process without a
// session in a process summary) is not a session.

// MarkCap bounds each list of marks.
const MarkCap = 300

type marker struct {
	sqlIDs   []string
	sqlSeen  map[string]struct{}
	sessions []string
	sessSeen map[string]struct{}
	hangSid  int // "session id: N" waiting for its "session serial #:"
}

func (m *marker) addSQL(id []byte) {
	if len(id) != 13 || len(m.sqlIDs) >= MarkCap {
		return
	}
	for _, c := range id {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'z') {
			return
		}
	}
	if m.sqlSeen == nil {
		m.sqlSeen = map[string]struct{}{}
	}
	if _, ok := m.sqlSeen[string(id)]; ok {
		return
	}
	s := string(id)
	m.sqlSeen[s] = struct{}{}
	m.sqlIDs = append(m.sqlIDs, s)
}

func (m *marker) addSession(sid, ser int) {
	if (sid == 0 && ser == 0) || len(m.sessions) >= MarkCap {
		return
	}
	key := itoa(sid) + "." + itoa(ser)
	if m.sessSeen == nil {
		m.sessSeen = map[string]struct{}{}
	}
	if _, ok := m.sessSeen[key]; ok {
		return
	}
	m.sessSeen[key] = struct{}{}
	m.sessions = append(m.sessions, key)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

// word reads the token of lower-case letters and digits at the start of b.
func word(b []byte) []byte {
	i := 0
	for i < len(b) && (b[i] >= '0' && b[i] <= '9' || b[i] >= 'a' && b[i] <= 'z') {
		i++
	}
	return b[:i]
}

// num reads a decimal number at the start of b (at most 9 digits); k is 0 when there is none.
func num(b []byte) (n, k int) {
	for k < len(b) && k < 9 && b[k] >= '0' && b[k] <= '9' {
		n = n*10 + int(b[k]-'0')
		k++
	}
	return
}

// line looks at one line of the file.
func (m *marker) line(b []byte) {
	if len(b) < 8 {
		return
	}
	i := 0
	for i < len(b) && i < 24 && b[i] == ' ' {
		i++
	}
	if i >= len(b)-6 {
		return
	}
	t := b[i:]
	switch t[0] {
	case '-':
		if i == 0 && t[1] == '-' {
			if hasPrefix(t, "----- Dump Cursor sql_id=") {
				m.addSQL(word(t[len("----- Dump Cursor sql_id="):]))
			} else if hasPrefix(t, "----- Current SQL Statement") {
				if j := bytes.Index(t, []byte("(sql_id=")); j > 0 {
					m.addSQL(word(t[j+len("(sql_id="):]))
				}
			}
		}
	case '*':
		if hasPrefix(t, "*** SESSION ID:(") {
			if sid, k := num(t[len("*** SESSION ID:("):]); k > 0 {
				rest := t[len("*** SESSION ID:(")+k:]
				if len(rest) > 1 && rest[0] == '.' {
					if ser, k2 := num(rest[1:]); k2 > 0 {
						m.addSession(sid, ser)
					}
				}
			}
		}
	case '(':
		if hasPrefix(t, "(session) sid: ") {
			if sid, k := num(t[len("(session) sid: "):]); k > 0 {
				rest := t[len("(session) sid: ")+k:]
				if hasPrefix(rest, " ser: ") {
					if ser, k2 := num(rest[len(" ser: "):]); k2 > 0 {
						m.addSession(sid, ser)
					}
				}
			}
		}
	case 'i':
		if hasPrefix(t, "inst: ") {
			if j := bytes.Index(t, []byte(", sid: ")); j > 0 {
				if sid, k := num(t[j+len(", sid: "):]); k > 0 {
					rest := t[j+len(", sid: ")+k:]
					if hasPrefix(rest, ", ser: ") {
						if ser, k2 := num(rest[len(", ser: "):]); k2 > 0 {
							m.addSession(sid, ser)
						}
					}
				}
			}
		}
	case 's':
		switch {
		case hasPrefix(t, "sid: "):
			if sid, k := num(t[len("sid: "):]); k > 0 {
				rest := t[len("sid: ")+k:]
				if hasPrefix(rest, " ser: ") {
					if ser, k2 := num(rest[len(" ser: "):]); k2 > 0 {
						m.addSession(sid, ser)
					}
				}
			}
		case hasPrefix(t, "session id: "):
			if sid, k := num(t[len("session id: "):]); k > 0 {
				m.hangSid = sid
			}
		case hasPrefix(t, "session serial #: "):
			if ser, k := num(t[len("session serial #: "):]); k > 0 && m.hangSid > 0 {
				m.addSession(m.hangSid, ser)
				m.hangSid = 0
			}
		}
	case 'F':
		if i > 0 && hasPrefix(t, "FullHashValue=") {
			if j := bytes.Index(t, []byte(" SqlId=")); j > 0 {
				m.addSQL(word(t[j+len(" SqlId="):]))
			}
		}
	default:
		// the process summary of a system state: "6: USER ospid 13945 sid 52 ser 41898, waiting for ..."
		if t[0] >= '0' && t[0] <= '9' {
			if _, k := num(t); k > 0 && k < len(t) && t[k] == ':' {
				if j := bytes.Index(t, []byte(" ospid ")); j > 0 {
					if jj := bytes.Index(t[j:], []byte(" sid ")); jj > 0 {
						rest := t[j+jj+len(" sid "):]
						if sid, k2 := num(rest); k2 > 0 && hasPrefix(rest[k2:], " ser ") {
							if ser, k3 := num(rest[k2+len(" ser "):]); k3 > 0 {
								m.addSession(sid, ser)
							}
						}
					}
				}
			}
		}
	}
}
