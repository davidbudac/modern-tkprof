package report

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"math"
	"testing"
)

type colDesc struct {
	T   string `json:"t"`
	Off int    `json:"off"`
	N   int    `json:"n"`
	D   int    `json:"d"`
}

// decodePacked is what web/src/data/columns.ts does: inflate the blob, read
// the typed views and integrate the delta-coded columns.
func decodePacked(t *testing.T, table map[string]json.RawMessage) map[string][]float64 {
	t.Helper()
	var blob string
	if err := json.Unmarshal(table["blob"], &blob); err != nil {
		t.Fatal(err)
	}
	raw, err := base64.StdEncoding.DecodeString(blob)
	if err != nil {
		t.Fatal(err)
	}
	zr, err := gzip.NewReader(bytes.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	buf, err := io.ReadAll(zr)
	if err != nil {
		t.Fatal(err)
	}
	out := map[string][]float64{}
	for name, rm := range table {
		var d colDesc
		if name == "n" || name == "blob" || json.Unmarshal(rm, &d) != nil || d.T == "" {
			continue
		}
		v := make([]float64, d.N)
		var acc int32
		var accF float64
		for i := range v {
			switch d.T {
			case "f64":
				x := math.Float64frombits(binary.LittleEndian.Uint64(buf[d.Off+8*i:]))
				if d.D == 1 {
					accF += x
					x = accF
				}
				v[i] = x
			case "i32":
				x := int32(binary.LittleEndian.Uint32(buf[d.Off+4*i:]))
				if d.D == 1 {
					acc += x
					x = acc
				}
				v[i] = float64(x)
			default:
				v[i] = float64(buf[d.Off+i])
			}
		}
		out[name] = v
	}
	return out
}

// The packed document, decoded the way the UI does it, must carry exactly the
// columns of the unpacked one.
func TestPackedDocumentRoundTrip(t *testing.T) {
	for _, fx := range []string{"basic_binds.trc", "io_waits.trc", "lobs.trc", "plsql_recursive.trc", "multisession_a.trc", "cursor_cache.trc", "bind_types.trc"} {
		m := buildFixture(t, fx)
		var pk, up bytes.Buffer
		if err := WriteDocument(&pk, m, DocOptions{Facts: true, Packed: true}); err != nil {
			t.Fatal(err)
		}
		if err := WriteDocument(&up, m, DocOptions{Facts: true}); err != nil {
			t.Fatal(err)
		}
		type docT struct {
			Format int                        `json:"format"`
			Facts  map[string]json.RawMessage `json:"facts"`
		}
		table := func(d docT, name string) map[string]json.RawMessage {
			var tb map[string]json.RawMessage
			if err := json.Unmarshal(d.Facts[name], &tb); err != nil {
				t.Fatal(err)
			}
			return tb
		}
		var pd, ud docT
		if err := json.Unmarshal(pk.Bytes(), &pd); err != nil {
			t.Fatalf("%s: packed document does not parse: %v", fx, err)
		}
		if err := json.Unmarshal(up.Bytes(), &ud); err != nil {
			t.Fatal(err)
		}
		if pd.Format != 3 {
			t.Errorf("%s: format %d", fx, pd.Format)
		}
		for _, tbl := range []string{"calls", "waits", "bindSets", "binds"} {
			ptb := table(pd, tbl)
			got := decodePacked(t, ptb)
			for col, rm := range table(ud, tbl) {
				if col == "n" {
					continue
				}
				if tbl == "binds" && (col == "type" || col == "value" || col == "typed") {
					if !bytes.Equal(rm, ptb[col]) {
						t.Errorf("%s %s.%s: strings differ", fx, tbl, col)
					}
					continue
				}
				var want []float64
				if err := json.Unmarshal(rm, &want); err != nil {
					t.Fatalf("%s %s.%s: %v", fx, tbl, col, err)
				}
				g := got[col]
				if len(g) != len(want) {
					t.Errorf("%s %s.%s: %d values, want %d", fx, tbl, col, len(g), len(want))
					continue
				}
				for i := range want {
					if g[i] != want[i] {
						t.Errorf("%s %s.%s[%d] = %v, want %v", fx, tbl, col, i, g[i], want[i])
						break
					}
				}
			}
		}
	}
}
