package assist

import (
	"crypto/rand"
	"encoding/hex"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/slice"
)

// Redactor masks bind values in what the tools return, the way a brief shows
// them: type, length and a hash salted per conversation (model.RedactedValueSalt),
// so equal values match inside one conversation and nowhere else. Session
// redaction is fixed when the trace is loaded; this layer covers the rest.
//
// A nil *Redactor leaves every value as traced.
type Redactor struct {
	Salt string
	// ModelRaw says the model's bind values are as traced (the session was
	// opened with binds=keep), so the rows built from them need masking. A
	// session opened with redact or none holds tokens or nothing already.
	// The trace text always holds the raw values, whatever the session mode.
	ModelRaw bool
}

// NewSalt is a random salt for the masked hashes of one conversation.
func NewSalt() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		panic(err)
	}
	return hex.EncodeToString(raw[:])
}

// maskedValue stands for a value the redactor cannot hash (the row does not
// line up with the model's bind set).
const maskedValue = "<masked>"

// binder is where bind values come from (slice.FactSource).
type binder interface {
	Binds(set model.ID) []model.Bind
}

// BindRows masks the rows of an execution in place. rows are the answer of
// /api/executions for bind set `set`, in the order of src.Binds(set).
func (r *Redactor) BindRows(src binder, set model.ID, rows []slice.BindRow) {
	if r == nil || !r.ModelRaw {
		return
	}
	raw := src.Binds(set)
	for i := range rows {
		b := &rows[i]
		b.Typed = ""
		if b.IsNull || b.NoDef {
			continue
		}
		if i < len(raw) {
			b.Value = model.RedactedValueSalt(&raw[i], r.Salt)
		} else {
			b.Value = maskedValue
		}
	}
}

// EvidenceValue is the value of an evidence row without bind values: the
// outlier-executions rule appends them as traced.
func (r *Redactor) EvidenceValue(rule string, e analyze.EvidenceRow) string {
	if r == nil || !r.ModelRaw || rule != analyze.RuleOutlierExecs {
		return e.Value
	}
	v, _, _ := strings.Cut(e.Value, analyze.EvidenceBindsMarker)
	return v
}

var (
	reDty = regexp.MustCompile(`\b(?:oac)?dty=(\d+)`)
	reAvl = regexp.MustCompile(`\bavl=(\d+)`)
)

const maskedLine = "  [masked]"

func isDumpLine(l string) bool {
	return strings.HasPrefix(l, "Dump of memory from ") || strings.HasPrefix(l, "Dumping ") || strings.HasPrefix(l, "toid ptr value=")
}

func isValueLine(l string) bool {
	return strings.HasPrefix(l, "  value=") || strings.HasPrefix(l, " value=Unhandled datatype")
}

// MaskBlock returns the lines of one BINDS block, header first, with every
// bind value replaced by its token. The lines of a value that runs on (a
// quoted value over several lines, the rows of a memory dump) become
// "  [masked]", so the number of lines, and with it every line number, stays
// the same. It follows the parser's reading of a block (Parser.bindLine).
func (r *Redactor) MaskBlock(lines []string) []string {
	out := append([]string(nil), lines...)
	var dty, avl int
	valueAt, last := -1, -1 // the value= line of the current bind and the last line of its value
	var value []string
	dump := false
	flush := func() {
		defer func() { valueAt, last, value, dump = -1, -1, nil, false }()
		if valueAt < 0 || (strings.TrimSpace(value[0]) == "" && !dump) {
			return
		}
		b := model.Bind{Dty: int32(dty), Avl: int32(avl), Value: strings.Join(value, "\n"), IsDump: dump}
		tok := model.RedactedValueSalt(&b, r.Salt)
		if l := out[valueAt]; strings.Contains(l, "value=") {
			out[valueAt] = l[:strings.Index(l, "value=")+len("value=")] + tok
		} else {
			out[valueAt] = "  value=" + tok
		}
		for j := valueAt + 1; j <= last; j++ {
			out[j] = maskedLine
		}
	}
	structural := func(l string) {
		flush()
		if m := reDty.FindStringSubmatch(l); m != nil {
			dty, _ = strconv.Atoi(m[1])
		}
		if m := reAvl.FindStringSubmatch(l); m != nil {
			avl, _ = strconv.Atoi(m[1])
		}
	}
	for i, l := range lines {
		switch {
		case strings.HasPrefix(l, " Bind#"):
			flush()
			dty, avl = 0, 0
		case strings.HasPrefix(l, " bind "):
			flush()
			dty, avl = 0, 0
			structural(l)
		case strings.HasPrefix(l, "  oacdty="), strings.HasPrefix(l, "  oacflg="), strings.HasPrefix(l, "  kxsbbbfp="):
			structural(l)
		case strings.HasPrefix(l, "  No oacdef for this bind."), l == "kkscoacd":
			flush()
		case isValueLine(l):
			flush()
			valueAt, last = i, i
			_, v, _ := strings.Cut(l, "value=")
			value = []string{v}
		case isDumpLine(l):
			if valueAt < 0 {
				valueAt, last, value = i, i, []string{l}
			} else {
				value = append(value, l)
				last = i
			}
			dump = true
		default:
			if valueAt >= 0 {
				value = append(value, l)
				last = i
			}
		}
	}
	flush()
	return out
}

// LineMasker masks the bind values of the lines of one trace file.
type LineMasker struct {
	R *Redactor
	// Blocks are the BINDS blocks of the file as sorted, inclusive line
	// ranges (/api/lines/blocks?what=binds).
	Blocks [][2]int
	// Read returns lines from..to of the file, without terminators.
	Read func(from, to int) ([]string, error)

	memo map[int]maskedBlock // by block header
}

type maskedBlock struct{ orig, masked []string }

// Mask masks lines in place; lines[i] is line from+i of the file. Only lines
// that a block masks change, so a line the caller has cut stays cut.
func (m *LineMasker) Mask(from int, lines []string) error {
	if m == nil || m.R == nil || len(lines) == 0 {
		return nil
	}
	end := from + len(lines) - 1
	for i := sort.Search(len(m.Blocks), func(i int) bool { return m.Blocks[i][1] >= from }); i < len(m.Blocks) && m.Blocks[i][0] <= end; i++ {
		lo, hi := m.Blocks[i][0], m.Blocks[i][1]
		b, ok := m.memo[lo]
		if !ok {
			orig, err := m.Read(lo, hi)
			if err != nil {
				return err
			}
			b = maskedBlock{orig, m.R.MaskBlock(orig)}
			if m.memo == nil {
				m.memo = map[int]maskedBlock{}
			}
			m.memo[lo] = b
		}
		for l := max(lo, from); l <= min(hi, end) && l-lo < len(b.masked); l++ {
			if b.masked[l-lo] != b.orig[l-lo] {
				lines[l-from] = b.masked[l-lo]
			}
		}
	}
	return nil
}
