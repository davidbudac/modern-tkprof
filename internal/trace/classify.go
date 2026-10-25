package trace

import "bytes"

// rec is what recordKind decides about a line that is not SQL text.
type rec struct {
	kind Kind
	call CallKind // KindCall: which call
	n    int      // length of the prefix up to the cursor "#" / the payload
	// hdr: the line matched no record prefix at all, so it is a prologue line
	// when the parser is still in the header. (A line that matched a prefix
	// but failed its validity check is KindUnknown with hdr false.)
	hdr bool
}

// withCursor accepts a record whose prefix of n bytes is followed by
// "#<digits>" (what the handlers parse with cursorNumber); anything else that
// matched the prefix is KindUnknown.
func withCursor(line []byte, k Kind, ck CallKind, n int) rec {
	if n < len(line) && line[n] == '#' && n+1 < len(line) && line[n+1] >= '0' && line[n+1] <= '9' {
		return rec{kind: k, call: ck, n: n}
	}
	return rec{kind: KindUnknown}
}

// recordKind is the one place that decides what kind of record a line starts.
// The parser dispatches on its answer (Parser.classify) and counts exactly
// that kind, so Stats.Kinds and Classify cannot drift apart.
//
// It is stateless: a record line is recognised by its prefix and by the cheap
// validity checks that used to live in the handlers (a cursor number after
// '#', the nam=' ... ' ela= of a WAIT, the op=' of a STAT).
func recordKind(line []byte) rec {
	if len(bytes.TrimSpace(line)) == 0 {
		return rec{kind: KindBlank}
	}
	switch line[0] {
	case '*':
		if hasPrefix(line, "*** ") {
			return rec{kind: KindMarker, n: 4}
		}
	case '=':
		if hasPrefix(line, "=====") {
			return rec{kind: KindSeparator}
		}
	case 'P':
		switch {
		case hasPrefix(line, "PARSING IN CURSOR #"):
			return withCursor(line, KindParsingInCursor, 0, 18)
		case hasPrefix(line, "PARSE ERROR #"):
			return withCursor(line, KindParseError, 0, 12)
		case hasPrefix(line, "PARSE #"):
			return withCursor(line, KindCall, CallParse, 6)
		}
	case 'E':
		switch {
		case hasPrefix(line, "EXEC #"):
			return withCursor(line, KindCall, CallExec, 5)
		case hasPrefix(line, "ERROR #"):
			return withCursor(line, KindError, 0, 6)
		}
	case 'F':
		if hasPrefix(line, "FETCH #") {
			return withCursor(line, KindCall, CallFetch, 6)
		}
	case 'C':
		if hasPrefix(line, "CLOSE #") {
			return withCursor(line, KindCall, CallClose, 6)
		}
	case 'W':
		if hasPrefix(line, "WAIT #") {
			r := withCursor(line, KindWait, 0, 5)
			if r.kind != KindWait {
				return r
			}
			_, rest, _ := cursorNumber(line[5:])
			i := bytes.Index(rest, []byte("nam='"))
			if i < 0 || bytes.Index(rest[i+5:], []byte("' ela=")) < 0 {
				return rec{kind: KindUnknown}
			}
			return r
		}
	case 'S':
		if hasPrefix(line, "STAT #") {
			r := withCursor(line, KindStat, 0, 5)
			if r.kind != KindStat {
				return r
			}
			_, rest, _ := cursorNumber(line[5:])
			if bytes.Index(rest, []byte(" op='")) < 0 {
				return rec{kind: KindUnknown}
			}
			return r
		}
		if hasPrefix(line, "SORT UNMAP #") {
			return withCursor(line, KindCall, CallUnmap, 11)
		}
	case 'B':
		if hasPrefix(line, "BINDS #") {
			return withCursor(line, KindBinds, 0, 6)
		}
	case 'X':
		if hasPrefix(line, "XCTEND ") {
			return rec{kind: KindXctend, n: 7}
		}
	case 'L':
		if isLobLine(line) {
			return rec{kind: KindLob}
		}
	case 'R':
		switch {
		case hasPrefix(line, "RPC CALL:"), hasPrefix(line, "RPC BINDS:"), hasPrefix(line, "RPC EXEC:"):
			return rec{kind: KindRPC, n: 9}
		}
	case 'U':
		if hasPrefix(line, "UNMAP #") {
			return withCursor(line, KindCall, CallUnmap, 6)
		}
	}
	return rec{kind: KindUnknown, hdr: true}
}

// isBindLineShape reports whether the line looks like a line of a BINDS block
// by its prefix alone (the shapes Parser.bindLine accepts without looking at
// the block's state). Value continuation lines (a quoted value or a memory
// dump that runs over several lines) have no shape and are not recognised.
func isBindLineShape(line []byte) bool {
	switch {
	case hasPrefix(line, " Bind#"), hasPrefix(line, " bind "),
		hasPrefix(line, "  oacdty="), hasPrefix(line, "  oacflg="), hasPrefix(line, "  kxsbbbfp="),
		hasPrefix(line, "  value="), hasPrefix(line, " value=Unhandled datatype"),
		hasPrefix(line, "  No oacdef for this bind."),
		string(line) == "kkscoacd",
		hasPrefix(line, "Dump of memory from "), hasPrefix(line, "Dumping "), hasPrefix(line, "toid ptr value="):
		return true
	}
	return false
}

// Classify says what kind of line a physical line (without its terminator) is,
// and whether the line after it is inside SQL text. The only state is that
// flag: SQL text is every line between PARSING IN CURSOR and END OF STMT, and
// inside it nothing else is recognised.
//
// It is the classification the parser itself counts (Parser.classify) for
// record lines and SQL text, plus two approximations the parser does by state
// that a stateless caller does not have:
//
//   - the parser ends SQL text at "END OF STMT" only once len= bytes were
//     collected (a literal END OF STMT line inside a statement is text); Classify
//     ends it at the first one;
//   - bind-block lines are recognised by their shape (" Bind#0", "  oacdty=",
//     "  value=", ...); a continuation line of a multi-line value, PARSE ERROR
//     statement text and the prologue lines (KindHeader) are not recognised
//     (they come out as KindUnknown).
//
// A caller that starts in the middle of a file does not know whether line 1 of
// its page is inside SQL text; it can seed inSQL by classifying a few lines
// before (see slice.LinesHandler), and is wrong only until the next END OF STMT.
func Classify(line []byte, inSQL bool) (kind Kind, nextInSQL bool) {
	if inSQL {
		if string(line) == "END OF STMT" {
			return KindEndOfStmt, false
		}
		return KindSQLText, true
	}
	r := recordKind(line)
	switch {
	case r.kind == KindParsingInCursor:
		return KindParsingInCursor, true
	case r.kind == KindUnknown && r.hdr && isBindLineShape(line):
		return KindBindLine, false
	}
	return r.kind, false
}

// Classifier classifies consecutive lines of a file: Classify plus the one
// other state the parser keeps for kinds, the prologue (lines before the first
// "*** " marker or "=====" separator that match no record are KindHeader).
type Classifier struct {
	InSQL  bool // the next line is SQL text
	Header bool // still in the prologue
}

// NewClassifier starts at the first line of a file (atFileStart: the prologue
// is still to come) or somewhere inside it.
func NewClassifier(atFileStart bool) *Classifier { return &Classifier{Header: atFileStart} }

// Next classifies the following line.
func (c *Classifier) Next(line []byte) Kind {
	var k Kind
	k, c.InSQL = Classify(line, c.InSQL)
	if c.Header {
		switch {
		case k == KindMarker || k == KindSeparator:
			c.Header = false
		case k == KindUnknown && recordKind(line).hdr:
			return KindHeader
		}
	}
	return k
}
