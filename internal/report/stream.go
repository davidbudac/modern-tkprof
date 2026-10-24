package report

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"strconv"

	"github.com/davidbudac/modern-tkprof/internal/model"
)

// Streaming the packed fact tables. Building the document in memory copies
// every column three times (typed column, packed buffer, base64 text) and
// holds the whole document before a byte is written; for a 10 GB trace that is
// more than the model itself. The writer here reads the model column by column
// through small getters, feeds gzip in chunks and base64-encodes straight into
// the output, so what it adds to the model is a few buffers. A few monotonic
// columns (line, tim, ids that grow with the file) are stored as deltas
// (descriptor "d":1; document format 3), which gzip squeezes to a fraction.

// colSpec is one numeric column of a packed table.
type colSpec struct {
	name string
	typ  string // "f64" | "i32" | "u8"
	f64  func(i int) float64
	i32  func(i int) int32
	u8   func(i int) uint8
	// delta stores differences to the previous row (modular for i32) instead of
	// the values; the loader (web/src/data/columns.ts) integrates them back.
	// Only for columns that are (nearly) monotonic: line numbers, tim, ids that
	// grow with the file. gzip then sees a few distinct small numbers instead of
	// an ever-growing one.
	delta bool
}

func (c *colSpec) width() int {
	switch c.typ {
	case "f64":
		return 8
	case "i32":
		return 4
	}
	return 1
}

func cF64(name string, get func(i int) int64) colSpec {
	return colSpec{name: name, typ: "f64", f64: func(i int) float64 { return float64(get(i)) }}
}

func cI32(name string, get func(i int) int64) colSpec {
	return colSpec{name: name, typ: "i32", i32: func(i int) int32 { return clamp32(get(i)) }}
}

func cU8(name string, get func(i int) uint8) colSpec {
	return colSpec{name: name, typ: "u8", u8: get}
}

// d marks a column as delta-coded.
func (c colSpec) d() colSpec {
	c.delta = true
	return c
}

// member is one JSON member of a table after "n" and "blob": a numeric column
// (written into the blob, its descriptor into the JSON) or raw JSON.
type member struct {
	name string
	col  *colSpec
	raw  func(w io.Writer) error
}

const streamChunk = 16 << 10 // rows per write

// writePackedTable writes {"n":N,"blob":"...",members...}.
func writePackedTable(w io.Writer, n int, members []member) error {
	// layout: every column aligned to its width, as pack() does
	offs := make([]int, len(members))
	size := 0
	for k, mb := range members {
		if mb.col == nil {
			continue
		}
		wd := mb.col.width()
		if r := size % wd; r != 0 {
			size += wd - r
		}
		offs[k] = size
		size += n * wd
	}
	if _, err := io.WriteString(w, `{"n":`+strconv.Itoa(n)+`,"blob":"`); err != nil {
		return err
	}
	b64 := base64.NewEncoder(base64.StdEncoding, w)
	gz, err := gzip.NewWriterLevel(b64, gzip.BestSpeed)
	if err != nil {
		return err
	}
	buf := make([]byte, streamChunk*8)
	pos := 0
	pad := func(to int) error {
		for pos < to {
			k := min(to-pos, len(buf))
			clear(buf[:k])
			if _, err := gz.Write(buf[:k]); err != nil {
				return err
			}
			pos += k
		}
		return nil
	}
	for k, mb := range members {
		c := mb.col
		if c == nil {
			continue
		}
		if err := pad(offs[k]); err != nil {
			return err
		}
		wd := c.width()
		var prevF float64
		var prevI int32
		for i := 0; i < n; i += streamChunk {
			end := min(i+streamChunk, n)
			out := buf[:(end-i)*wd]
			switch c.typ {
			case "f64":
				for j := i; j < end; j++ {
					v := c.f64(j)
					if c.delta {
						v, prevF = v-prevF, v
					}
					binary.LittleEndian.PutUint64(out[8*(j-i):], math.Float64bits(v))
				}
			case "i32":
				for j := i; j < end; j++ {
					v := c.i32(j)
					if c.delta {
						v, prevI = v-prevI, v
					}
					binary.LittleEndian.PutUint32(out[4*(j-i):], uint32(v))
				}
			default:
				for j := i; j < end; j++ {
					out[j-i] = c.u8(j)
				}
			}
			if _, err := gz.Write(out); err != nil {
				return err
			}
			pos += len(out)
		}
	}
	if err := pad(size); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	if err := b64.Close(); err != nil {
		return err
	}
	if _, err := io.WriteString(w, `"`); err != nil {
		return err
	}
	for k, mb := range members {
		if _, err := io.WriteString(w, `,"`+mb.name+`":`); err != nil {
			return err
		}
		if mb.col == nil {
			if err := mb.raw(w); err != nil {
				return err
			}
			continue
		}
		desc := `{"t":"` + mb.col.typ + `","off":` + strconv.Itoa(offs[k]) + `,"n":` + strconv.Itoa(n)
		if mb.col.delta {
			desc += `,"d":1`
		}
		if _, err := io.WriteString(w, desc+`}`); err != nil {
			return err
		}
	}
	_, err = io.WriteString(w, "}")
	return err
}

// rawStrings writes a JSON array of n strings, marshalled in chunks.
func rawStrings(n int, get func(i int) string) func(w io.Writer) error {
	return func(w io.Writer) error {
		if _, err := io.WriteString(w, "["); err != nil {
			return err
		}
		chunk := make([]string, 0, 2048)
		for i := 0; i < n; i += cap(chunk) {
			chunk = chunk[:0]
			for j := i; j < min(i+cap(chunk), n); j++ {
				chunk = append(chunk, get(j))
			}
			b, err := json.Marshal(chunk)
			if err != nil {
				return err
			}
			if i > 0 {
				if _, err := io.WriteString(w, ","); err != nil {
					return err
				}
			}
			if _, err := w.Write(b[1 : len(b)-1]); err != nil {
				return err
			}
		}
		_, err := io.WriteString(w, "]")
		return err
	}
}

// tableSpec is one fact table of the document: its JSON name, row count and
// members in JSON order.
type tableSpec struct {
	name    string
	n       int
	members []member
}

// writeFactsPacked writes the "facts" object of a packed document.
func writeFactsPacked(w io.Writer, m *model.Model) error {
	if _, err := io.WriteString(w, `{"packed":true`); err != nil {
		return err
	}
	for _, t := range factTables(m) {
		if _, err := io.WriteString(w, `,"`+t.name+`":`); err != nil {
			return err
		}
		if err := writePackedTable(w, t.n, t.members); err != nil {
			return err
		}
	}
	_, err := io.WriteString(w, "}")
	return err
}

// factTables describes the fact tables of the model in document order.
func factTables(m *model.Model) []tableSpec {
	calls := m.Calls
	flags := func(orphan, synth bool) uint8 {
		var f uint8
		if orphan {
			f |= 1
		}
		if synth {
			f |= 2
		}
		return f
	}
	cols := []colSpec{
		cI32("line", func(i int) int64 { return int64(calls[i].Line) }).d(),
		cU8("kind", func(i int) uint8 { return uint8(calls[i].Kind) }),
		cI32("cursor", func(i int) int64 { return int64(calls[i].Cursor) }),
		cI32("stmt", func(i int) int64 { return int64(calls[i].Statement) }),
		cI32("c", func(i int) int64 { return calls[i].C }),
		cI32("e", func(i int) int64 { return calls[i].E }),
		cI32("p", func(i int) int64 { return calls[i].P }),
		cI32("cr", func(i int) int64 { return calls[i].CR }),
		cI32("cu", func(i int) int64 { return calls[i].CU }),
		cI32("mis", func(i int) int64 { return int64(calls[i].Mis) }),
		cI32("r", func(i int) int64 { return calls[i].R }),
		cU8("dep", func(i int) uint8 { return calls[i].Dep }),
		cU8("og", func(i int) uint8 { return calls[i].OG }),
		cF64("plh", func(i int) int64 { return int64(calls[i].PLH) }),
		cF64("tim", func(i int) int64 { return calls[i].Tim }).d(),
		cU8("type", func(i int) uint8 { return calls[i].Type }),
		cI32("parent", func(i int) int64 { return int64(calls[i].Parent) }),
		cI32("selfE", func(i int) int64 { return calls[i].SelfE }),
		cI32("selfC", func(i int) int64 { return calls[i].SelfC }),
		cI32("selfP", func(i int) int64 { return calls[i].SelfP }),
		cI32("selfCR", func(i int) int64 { return calls[i].SelfCR }),
		cI32("selfCU", func(i int) int64 { return calls[i].SelfCU }),
		cI32("ctx", func(i int) int64 { return int64(calls[i].Context) }),
		cI32("execNo", func(i int) int64 { return int64(calls[i].ExecNo) }),
		cI32("bindSet", func(i int) int64 { return int64(calls[i].BindSet) }),
		cI32("waitEla", func(i int) int64 { return calls[i].WaitEla }),
		cI32("idleEla", func(i int) int64 { return calls[i].IdleEla }),
		cI32("nWaits", func(i int) int64 { return int64(calls[i].NWaits) }),
		cU8("flags", func(i int) uint8 { return flags(calls[i].Orphan, calls[i].Synthetic) }),
	}
	out := []tableSpec{{"calls", len(calls), members(cols)}}
	waits := m.Waits
	cols = []colSpec{
		cI32("line", func(i int) int64 { return int64(waits[i].Line) }).d(),
		cI32("cursor", func(i int) int64 { return int64(waits[i].Cursor) }),
		cI32("stmt", func(i int) int64 { return int64(waits[i].Statement) }),
		cI32("call", func(i int) int64 { return int64(waits[i].Call) }),
		cI32("event", func(i int) int64 { return int64(waits[i].Event) }),
		cI32("ela", func(i int) int64 { return waits[i].Ela }),
		cF64("p1", func(i int) int64 { return waits[i].P1 }),
		cF64("p2", func(i int) int64 { return waits[i].P2 }),
		cF64("p3", func(i int) int64 { return waits[i].P3 }),
		cI32("obj", func(i int) int64 { return waits[i].ObjID }),
		cF64("tim", func(i int) int64 { return waits[i].Tim }).d(),
		cI32("ctx", func(i int) int64 { return int64(waits[i].Context) }),
		cU8("dep", func(i int) uint8 { return waits[i].Dep }),
		cU8("flags", func(i int) uint8 {
			var f uint8
			if waits[i].Between {
				f |= 1
			}
			if waits[i].Idle {
				f |= 2
			}
			return f
		}),
	}
	out = append(out, tableSpec{"waits", len(waits), members(cols)})
	sets := m.BindSets
	cols = []colSpec{
		cI32("line", func(i int) int64 { return int64(sets[i].Line) }).d(),
		cI32("cursor", func(i int) int64 { return int64(sets[i].Cursor) }),
		cI32("stmt", func(i int) int64 { return int64(sets[i].Statement) }),
		cI32("call", func(i int) int64 { return int64(sets[i].Call) }).d(),
		cI32("first", func(i int) int64 { return int64(sets[i].First) }).d(),
		cI32("count", func(i int) int64 { return int64(sets[i].N) }),
		cU8("flags", func(i int) uint8 {
			if sets[i].IsRPC {
				return 1
			}
			return 0
		}),
	}
	out = append(out, tableSpec{"bindSets", len(sets), members(cols)})
	binds := m.Binds
	bcols := []colSpec{
		cI32("set", func(i int) int64 { return int64(binds[i].Set) }).d(),
		cI32("pos", func(i int) int64 { return int64(binds[i].Pos) }),
		cI32("dty", func(i int) int64 { return int64(binds[i].Dty) }),
		cU8("flags", func(i int) uint8 {
			var f uint8
			if binds[i].IsNull {
				f |= 1
			}
			if binds[i].NoDef {
				f |= 2
			}
			if binds[i].IsDump {
				f |= 4
			}
			return f
		}),
		cI32("mal", func(i int) int64 { return int64(binds[i].Mal) }),
		cI32("avl", func(i int) int64 { return int64(binds[i].Avl) }),
		cU8("kind", func(i int) uint8 { return uint8(binds[i].Kind()) }),
	}
	// JSON order: set, pos, dty, type, value, flags, mal, avl, kind, typed
	mb := members(bcols)
	byName := map[string]member{}
	for _, x := range mb {
		byName[x.name] = x
	}
	bm := []member{byName["set"], byName["pos"], byName["dty"],
		{name: "type", raw: rawStrings(len(binds), func(i int) string { return binds[i].TypeName() })},
		{name: "value", raw: rawStrings(len(binds), func(i int) string { return binds[i].Value })},
		byName["flags"], byName["mal"], byName["avl"], byName["kind"]}
	if hasTypedBinds(binds) {
		bm = append(bm, member{name: "typed", raw: rawStrings(len(binds), func(i int) string { return binds[i].Typed() })})
	}
	return append(out, tableSpec{"binds", len(binds), bm})
}

func members(cols []colSpec) []member {
	out := make([]member, len(cols))
	for i := range cols {
		out[i] = member{name: cols[i].name, col: &cols[i]}
	}
	return out
}

// factsPlaceholder stands in for the facts object while the rest of the
// document is marshalled; writeDocument splits the output at it and streams
// the facts in between.
const factsPlaceholder = "@mtkprof-facts-stream@"

// writeDocument streams the document (no trailing newline) to w.
func writeDocument(w io.Writer, m *model.Model, o DocOptions) error {
	if !o.Facts || !o.Packed {
		b, err := json.Marshal(BuildDocument(m, o))
		if err != nil {
			return err
		}
		_, err = w.Write(b)
		return err
	}
	d := buildDocument(m, o, false)
	d.Facts = &Facts{Packed: true, stream: true}
	b, err := json.Marshal(d)
	if err != nil {
		return err
	}
	mark := []byte(`"` + factsPlaceholder + `"`)
	i := bytes.Index(b, mark)
	if i < 0 {
		panic("report: facts placeholder missing from the marshalled document")
	}
	if _, err := w.Write(b[:i]); err != nil {
		return err
	}
	if err := writeFactsPacked(w, m); err != nil {
		return err
	}
	_, err = w.Write(b[i+len(mark):])
	return err
}

// WriteDocument writes the document the UI loads (JSON, HTML-safe so it can be
// inlined in a <script> tag) to w without building it in memory. With
// Packed and Facts the fact tables are streamed straight from the model.
func WriteDocument(w io.Writer, m *model.Model, o DocOptions) error {
	return writeDocument(w, m, o)
}
