package diag

// Bind redaction (docs/PLAN-DIAG.md § Correctness and privacy): -redact-binds and -binds none act on the bind
// values the cursor dumps of a diagnostic dump print, in the text digest and in the readings of a document, as
// internal/opt does for a 10053 dump (opt.TextOptions). The live routes (api/diag/reading, api/lines) serve
// the file as it is.
//
// Covered: the values of DumpCursor.Binds (the "value=" lines under "Bind Info (kkscoacd)"), in the text of the
// call stack reading and in the JSON of every reading of a digest. Not covered, as for 10053: the text of SQL
// statements (the current statement, the cursors' statements), which can hold literals; what a wait's parameters
// print; and the memory contents of a dump taken with contents (a digest never holds them).

// TextOptions shape the text digest and the readings of a document.
type TextOptions struct {
	// DropBinds leaves the bind values out (-binds none): a cursor keeps its bind count and lists no binds.
	DropBinds bool
	// RedactBind, when set, replaces every bind value by its result (-redact-binds). typ is the name of the bind's
	// type (VARCHAR2, NUMBER, DTY<n>), value the text after "value=" as printed (a string keeps its quotes) and avl
	// the "avl=" length (0 when not printed); nil keeps the values.
	RedactBind func(typ, value string, avl int) string
}

// active: the options change anything.
func (o TextOptions) active() bool { return o.DropBinds || o.RedactBind != nil }

// redactReading returns the reading with its binds handled as asked: a copy when there is anything to change,
// the reading itself otherwise.
func redactReading(rd Reading, o TextOptions) Reading {
	cs, ok := rd.(*CallStack)
	if !ok || !o.active() {
		return rd
	}
	c := *cs
	c.Cursors = make([]DumpCursor, len(cs.Cursors))
	for i, cur := range cs.Cursors {
		cc := cur
		if o.DropBinds {
			cc.Binds = []DumpBind{}
		} else {
			cc.Binds = make([]DumpBind, len(cur.Binds))
			for j, b := range cur.Binds {
				if b.Line != 0 {
					avl := 0
					if b.Avl != nil {
						avl = *b.Avl
					}
					typ := b.Type
					if typ == "" {
						typ = "bind"
					}
					b.Value = o.RedactBind(typ, b.Value, avl)
				}
				cc.Binds[j] = b
			}
		}
		c.Cursors[i] = cc
	}
	c.Notes = append(append([]string{}, cs.Notes...), map[bool]string{true: "bind values dropped", false: "bind values redacted"}[o.DropBinds])
	return &c
}
