package opt

import "bytes"

// classifyLandmark says whether a line is a landmark and of which kind and tone. The rules are those of
// parse.mjs, in its order.
func classifyLandmark(b []byte) (kind, tone string) {
	n := len(b)
	if n == 0 {
		return
	}
	s := b
	ws := false
	if b[0] == ' ' || b[0] == '\t' {
		s = skipSpace(b)
		ws = true
		if len(s) == 0 {
			return
		}
	}
	switch s[0] {
	case 'B':
		if hp(s, "Best:: AccessPath:") {
			return LMBestAP, ToneKept
		}
		if hp(s, "Best:: JoinMethod:") {
			return LMBestJM, ToneKept
		}
	case 'a':
		if hp(s, "atom_hint=") && atomErr(s) {
			return LMHintError, ToneProblem
		}
	case 'S':
		if hp(s, "Syntax Error:") {
			return LMHintError, ToneProblem
		}
	}
	if !ws {
		switch b[0] {
		case 'F':
			if hp(b, "Final cost for query block") {
				return LMFinalCost, ToneKept
			}
		case 'J':
			if hp(b, "Join order aborted") {
				return LMAborted, ToneRejected
			}
		}
		if wc := leadWord(b); wc > 0 {
			rest := b[wc:]
			switch {
			case hp(rest, ": Updated best state"):
				return LMVerdict, ToneKept
			case hp(rest, ": Not update best state"):
				return LMVerdict, ToneRejected
			case hp(rest, ": Will not use") && wordEnd(rest, len(": Will not use")):
				return LMVerdict, ToneRejected
			case hp(rest, ": Will not merge") && wordEnd(rest, len(": Will not merge")):
				return LMVerdict, ToneRejected
			}
		}
	}
	if n >= 31 && b[0] == '*' && bytes.Contains(b, []byte("WARNING: SOME HINTS HAVE ERRORS")) {
		return LMHintError, ToneProblem
	}
	if refused(b) {
		return LMRefused, ToneRejected
	}
	return
}

// wordEnd: position k of b is the end of a word (\b after the last letter of the phrase).
func wordEnd(b []byte, k int) bool { return k >= len(b) || !isWord(b[k]) }

// atomErr: "...\berr=[1-9]" in an atom_hint line.
func atomErr(b []byte) bool {
	for i := 0; i+5 <= len(b); i++ {
		if b[i] == 'e' && b[i+1] == 'r' && b[i+2] == 'r' && b[i+3] == '=' && (i == 0 || !isWord(b[i-1])) {
			if c := b[i+4]; c >= '1' && c <= '9' {
				return true
			}
		}
	}
	return false
}

var refusedStart [256]bool

func init() {
	for _, c := range []byte("bBnCiv") {
		refusedStart[c] = true
	}
}

func lower(c byte) byte {
	if c >= 'A' && c <= 'Z' {
		return c + 32
	}
	return c
}

func eqFold(b []byte, s string) bool {
	if len(b) < len(s) {
		return false
	}
	for i := 0; i < len(s); i++ {
		if lower(b[i]) != s[i] {
			return false
		}
	}
	return true
}

// refused: \bbypassed\b (any case), not valid since, \bCannot\b, invalid because, validity checks failed,
// \bnot performed\b anywhere in the line.
func refused(b []byte) bool {
	for i := 0; i < len(b); i++ {
		c := b[i]
		if !refusedStart[c] {
			continue
		}
		switch c {
		case 'b', 'B':
			if (i == 0 || !isWord(b[i-1])) && eqFold(b[i:], "bypassed") && wordEnd(b, i+8) {
				return true
			}
		case 'n':
			if hp(b[i:], "not valid since") {
				return true
			}
			if hp(b[i:], "not performed") && (i == 0 || !isWord(b[i-1])) && wordEnd(b, i+13) {
				return true
			}
		case 'C':
			if hp(b[i:], "Cannot") && (i == 0 || !isWord(b[i-1])) && wordEnd(b, i+6) {
				return true
			}
		case 'i':
			if hp(b[i:], "invalid because") {
				return true
			}
		case 'v':
			if hp(b[i:], "validity checks failed") {
				return true
			}
		}
	}
	return false
}

// landmark records the line when it is one and keeps it, with the lines indented deeper that follow it (the
// Cost line after Best::, the four lines after Final cost), in the digest.
func (ds *dstate) landmark(e *lineEnt) {
	b := e.b
	kind, tone := classifyLandmark(b)
	if kind != "" {
		ds.d.Landmarks = append(ds.d.Landmarks, Landmark{Line: e.n, Kind: kind, Tone: tone, Text: string(trimB(b))})
		ds.keep(e.n, e.n)
		ds.cont.indent, ds.cont.left, ds.cont.toCost = indentOf(b), 6, kind == LMBestAP
		return
	}
	if ds.cont.left > 0 {
		ind := indentOf(b)
		// an index path prints "Index: X" at the indent of Best:: before its Cost line: those lines are kept
		// up to the Cost line
		if !e.blank && (ind > ds.cont.indent || ds.cont.toCost && ind == ds.cont.indent) {
			ds.keep(e.n, e.n)
			ds.cont.left--
			if ds.cont.toCost && hp(skipSpace(b), "Cost:") {
				ds.cont.left = 0
			}
		} else {
			ds.cont.left = 0
		}
	}
}
