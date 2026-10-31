package assist

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"

	"github.com/davidbudac/modern-tkprof/internal/analyze"
	"github.com/davidbudac/modern-tkprof/internal/model"
	"github.com/davidbudac/modern-tkprof/internal/slice"
)

// bindValues are the lines of the BINDS blocks of a trace that hold a bind
// value, by line number: the text after value=, or the whole line for the rows
// that go on from it (a memory dump).
func bindValues(t *testing.T, path string) map[int]string {
	t.Helper()
	f, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	out := map[int]string{}
	sc := bufio.NewScanner(f)
	n, inValue := 0, false
	for sc.Scan() {
		n++
		l := sc.Text()
		switch {
		case isValueLine(l):
			_, v, _ := strings.Cut(l, "value=")
			out[n], inValue = v, true
		case strings.HasPrefix(l, " Bind#"), strings.HasPrefix(l, "  oacdty="), strings.HasPrefix(l, "BINDS #"), strings.HasPrefix(l, "EXEC #"):
			inValue = false
		case inValue && l != "":
			out[n] = l
		}
	}
	return out
}

// TestRedact: no bind value of bind_types.trc survives executions, lines or
// search_lines with masking on, and they do without. (The same text in the SQL,
// as a literal, stays: the SQL is not masked.)
func TestRedact(t *testing.T) {
	values := bindValues(t, traces+"bind_types.trc")
	if len(values) < 20 {
		t.Fatalf("only %d bind value lines in the fixture", len(values))
	}
	masked, open := loadEnv(t, "bind_types", true), loadEnv(t, "bind_types", false)
	ctx := context.Background()

	// every execution of every statement: the values are tokens or nothing
	binds := func(env Env) (vals []string) {
		for i := range env.Model.Statements {
			res, err := Call(ctx, env, "executions", []byte(`{"sql_id":"@`+strconv.Itoa(i)+`","limit":10000}`))
			if err != nil {
				t.Fatal(err)
			}
			var v struct {
				Executions []struct {
					Binds []struct{ Value string }
				}
			}
			mustUnmarshal(t, res.JSON, &v)
			for _, e := range v.Executions {
				for _, b := range e.Binds {
					vals = append(vals, b.Value)
				}
			}
		}
		return
	}
	mv, ov := binds(masked), binds(open)
	if len(mv) < 10 || len(mv) != len(ov) {
		t.Fatalf("%d masked bind values, %d unmasked", len(mv), len(ov))
	}
	seen := 0
	for i := range mv {
		if ov[i] == "" {
			continue
		}
		seen++
		if !reToken.MatchString(mv[i]) {
			t.Errorf("executions: bind value %q is not a token (traced: %q)", mv[i], ov[i])
		}
	}
	if seen < 8 {
		t.Errorf("only %d values in %d binds", seen, len(mv))
	}

	// the whole file, 500 lines at a time, by line number
	lines := func(env Env) map[int]string {
		out := map[int]string{}
		for from := 1; from > 0; {
			res, err := Call(ctx, env, "lines", []byte(`{"from":`+strconv.Itoa(from)+`,"n":500}`))
			if err != nil {
				t.Fatal(err)
			}
			var v struct {
				Text string
				Next int
			}
			mustUnmarshal(t, res.JSON, &v)
			for _, l := range strings.Split(strings.TrimSuffix(v.Text, "\n"), "\n") {
				n, text, _ := strings.Cut(l, "\t")
				ln, _ := strconv.Atoi(n)
				out[ln] = text
			}
			from = v.Next
		}
		return out
	}
	ml, ol := lines(masked), lines(open)
	if len(ml) != len(ol) || len(ol) < 100 {
		t.Fatalf("%d masked lines, %d unmasked", len(ml), len(ol))
	}
	for ln, raw := range values {
		got := ml[ln]
		if _, v, ok := strings.Cut(ol[ln], "value="); ok && isValueLine(ol[ln]) {
			if !strings.HasPrefix(got, "  value=<") && !strings.HasPrefix(got, " value=<") && v != "" {
				t.Errorf("line %d: %q", ln, got)
			}
		} else if got != maskedLine {
			t.Errorf("line %d went on from a value: %q", ln, got)
		}
		if len(raw) >= 8 && strings.Contains(got, raw) {
			t.Errorf("line %d: the bind value %q is in %q", ln, raw, got)
		}
	}
	for ln, text := range ol { // nothing else changed
		if _, isValue := values[ln]; !isValue && ml[ln] != text {
			t.Errorf("line %d changed: %q -> %q", ln, text, ml[ln])
		}
	}

	// searching for each value: the hits on its line are masked
	for ln, raw := range values {
		if len(raw) < 8 || strings.HasPrefix(raw, "Unhandled datatype") {
			continue
		}
		for _, env := range []Env{masked, open} {
			res, err := Call(ctx, env, "search_lines", []byte(`{"q":`+strconv.Quote(raw)+`,"limit":200}`))
			if err != nil {
				t.Fatal(err)
			}
			var v struct {
				Hits []struct {
					Line int
					Text string
				}
			}
			mustUnmarshal(t, res.JSON, &v)
			found := false
			for _, h := range v.Hits {
				if h.Line != ln {
					continue
				}
				found = true
				if shows := strings.Contains(h.Text, raw); shows == (env.Redact != nil) {
					t.Errorf("line %d, masking %v: hit %q", ln, env.Redact != nil, h.Text)
				}
			}
			if !found {
				t.Errorf("line %d: no hit for %q", ln, raw)
			}
		}
	}
}

func mustUnmarshal(t *testing.T, b []byte, v any) {
	t.Helper()
	if err := json.Unmarshal(b, v); err != nil {
		t.Fatal(err)
	}
}

func TestBindRows(t *testing.T) {
	env := loadEnv(t, "basic_binds", false)
	r := &Redactor{Salt: "s1", ModelRaw: true}
	var id int
	for i := range env.Model.Statements {
		if env.Model.Statements[i].SQLID == "f6jyzt7462kx2" {
			id = i
		}
	}
	resp := route[slice.ExecResponse](t, env, "/api/executions", map[string][]string{"stmt": {strconv.Itoa(id)}, "limit": {"1"}})
	row := resp.Rows[0]
	raw := env.Source.Binds(row.BindSet)
	r.BindRows(env.Source, row.BindSet, row.Binds)
	for i, b := range row.Binds {
		switch {
		case b.IsNull || b.NoDef:
			if b.Value != "" && b.Value != raw[i].Value {
				t.Errorf("bind %d: %q", i, b.Value)
			}
		case b.Value != model.RedactedValueSalt(&raw[i], "s1"):
			t.Errorf("bind %d: %q, the brief's token is %q", i, b.Value, model.RedactedValueSalt(&raw[i], "s1"))
		case b.Typed != "":
			t.Errorf("bind %d: typed value %q", i, b.Typed)
		}
	}
	// another salt, another hash; a model that is not raw is left alone
	again := route[slice.ExecResponse](t, env, "/api/executions", map[string][]string{"stmt": {strconv.Itoa(id)}, "limit": {"1"}}).Rows[0]
	(&Redactor{Salt: "s2", ModelRaw: true}).BindRows(env.Source, again.BindSet, again.Binds)
	if again.Binds[0].Value == row.Binds[0].Value {
		t.Errorf("the hash does not depend on the salt: %s", again.Binds[0].Value)
	}
	keep := route[slice.ExecResponse](t, env, "/api/executions", map[string][]string{"stmt": {strconv.Itoa(id)}, "limit": {"1"}}).Rows[0]
	(&Redactor{Salt: "s1"}).BindRows(env.Source, keep.BindSet, keep.Binds)
	if keep.Binds[0].Value != "1" {
		t.Errorf("a redacted session's values were touched: %q", keep.Binds[0].Value)
	}
	var none *Redactor
	none.BindRows(env.Source, keep.BindSet, keep.Binds)
}

var reToken = regexp.MustCompile(`^<[A-Z0-9_ ]+ (dump )?len=\d+( h=[0-9a-f]{8})?>$`)

func TestMaskBlock(t *testing.T) {
	r := &Redactor{Salt: "x"}
	block := []string{
		"BINDS #140646291810920:",
		"",
		" Bind#0",
		"  oacdty=01 mxl=32(12) mxlc=00 mal=00 scl=00 pre=00",
		"  oacflg=03 fl2=1000010 frm=01 csi=873 siz=32 off=0",
		"  kxsbbbfp=7f  bln=32  avl=12  flg=05",
		`  value="a secret`,
		"spread over",
		"",
		`three lines"`,
		" Bind#1",
		"  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00",
		"  kxsbbbfp=7f  bln=22  avl=02  flg=01",
		"  value=42",
		" Bind#2",
		"  oacdty=01 mxl=32(00) mxlc=00 mal=00 scl=00 pre=00",
		"  kxsbbbfp=7f  bln=32  avl=00  flg=05",
		" Bind#3",
		"  oacdty=02 mxl=22(22) mxlc=00 mal=00 scl=00 pre=00",
		"  No oacdef for this bind.",
		" Bind#4",
		"  oacdty=180 mxl=11(11) mxlc=00 mal=00 scl=06 pre=00",
		"  kxsbbbfp=7f  bln=11  avl=11  flg=01",
		"  value=Unhandled datatype (-25) found in kxsbndinf",
		"Dumping '' addr=0x7f size=11 bytes",
		"Dump of memory from 0x7f to 0x84",
		"7FEAC4432070                   01077C78 1D3C3C17          [x|...<<.]",
	}
	got := r.MaskBlock(block)
	if len(got) != len(block) {
		t.Fatalf("%d lines, was %d", len(got), len(block))
	}
	for i := range block {
		switch i {
		case 6, 7, 8, 9, 13, 23, 24, 25, 26: // the value lines and what runs on from them
			if got[i] == block[i] {
				t.Errorf("line %d kept its text: %q", i, got[i])
			}
		default:
			if got[i] != block[i] {
				t.Errorf("line %d changed: %q -> %q", i, block[i], got[i])
			}
		}
	}
	if !strings.HasPrefix(got[6], "  value=<VARCHAR2 len=12 h=") || !strings.HasPrefix(got[13], "  value=<NUMBER len=2 h=") || got[23] != "  value=<TIMESTAMP dump len=11>" {
		t.Errorf("tokens: %q %q %q", got[6], got[13], got[23])
	}
	for _, i := range []int{7, 8, 9, 24, 25, 26} {
		if got[i] != maskedLine {
			t.Errorf("line %d: %q", i, got[i])
		}
	}
	for _, i := range []int{6, 13, 23} {
		if _, tok, _ := strings.Cut(got[i], "value="); !reToken.MatchString(tok) {
			t.Errorf("line %d: %q is not a token", i, tok)
		}
	}
	// the token is the one the brief shows, for the value as the parser keeps it
	b := model.Bind{Dty: 2, Avl: 2, Value: "42"}
	if got[13] != "  value="+model.RedactedValueSalt(&b, "x") {
		t.Errorf("%q, the brief's token is %q", got[13], model.RedactedValueSalt(&b, "x"))
	}
}

func TestLineMaskerPages(t *testing.T) {
	// a page that starts inside a block masks what the block masks, and only that
	block := []string{"BINDS #1:", "", " Bind#0", "  oacdty=02 mxl=22(22)", "  kxsbbbfp=7f  bln=22  avl=02  flg=01", "  value=7", " Bind#1", "  oacdty=02 mxl=22(22)", "  kxsbbbfp=7f  bln=22  avl=02  flg=01", "  value=8"}
	file := append([]string{"PARSE #1:c=0"}, append(block, "EXEC #1:c=0")...)
	m := &LineMasker{R: &Redactor{Salt: "x"}, Blocks: [][2]int{{2, 11}}, Read: func(from, to int) ([]string, error) { return append([]string(nil), file[from-1:to]...), nil }}
	page := append([]string(nil), file[9:12]...) // lines 10-12: the bind's last field, its value, the next record
	page[1] = "  value=8 and a hit cut here"
	if err := m.Mask(10, page); err != nil {
		t.Fatal(err)
	}
	if page[0] != file[9] || page[2] != "EXEC #1:c=0" {
		t.Errorf("lines 10 and 12 changed: %q %q", page[0], page[2])
	}
	if !strings.HasPrefix(page[1], "  value=<NUMBER len=2 h=") {
		t.Errorf("line 11: %q", page[1])
	}
	// a line of the block that did not change is the caller's own text
	one := []string{"  oacdty=02 and cut"}
	if err := m.Mask(9, one); err != nil || one[0] != "  oacdty=02 and cut" {
		t.Errorf("%q %v", one, err)
	}
	if err := (*LineMasker)(nil).Mask(1, one); err != nil {
		t.Error(err)
	}
}

func TestEvidenceValue(t *testing.T) {
	e := analyze.EvidenceRow{Value: "e=3.2 ms" + analyze.EvidenceBindsMarker + ":1 NUMBER=42"}
	r := &Redactor{ModelRaw: true}
	if got := r.EvidenceValue(analyze.RuleOutlierExecs, e); got != "e=3.2 ms" {
		t.Errorf("%q", got)
	}
	if got := r.EvidenceValue(analyze.RuleThinkTime, e); got != e.Value {
		t.Errorf("another rule: %q", got)
	}
	if got := (&Redactor{}).EvidenceValue(analyze.RuleOutlierExecs, e); got != e.Value {
		t.Errorf("a redacted model: %q", got)
	}
	var none *Redactor
	if got := none.EvidenceValue(analyze.RuleOutlierExecs, e); got != e.Value {
		t.Errorf("no redactor: %q", got)
	}
}
