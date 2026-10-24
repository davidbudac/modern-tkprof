package report

import (
	"bytes"
	"compress/gzip"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"math"
)

// Column is a typed fact column. In plain mode it marshals as a JSON array.
// In packed mode every column of a table is written into one little-endian
// buffer, gzip-compressed and base64-encoded ("blob"), and the column only
// marshals its descriptor {t, off, n}; the browser decompresses the blob with
// DecompressionStream and creates typed-array views. Packed tables are 5-10x
// smaller than JSON numbers and decode instantly.
type Column struct {
	Type string // "f64" | "i32" | "u8"
	F64  []float64
	I32  []int32
	U8   []uint8

	packed bool
	off    int
}

func (c Column) len() int {
	switch c.Type {
	case "f64":
		return len(c.F64)
	case "i32":
		return len(c.I32)
	}
	return len(c.U8)
}

func (c Column) width() int {
	switch c.Type {
	case "f64":
		return 8
	case "i32":
		return 4
	}
	return 1
}

func (c Column) MarshalJSON() ([]byte, error) {
	if !c.packed {
		switch c.Type {
		case "f64":
			return json.Marshal(c.F64)
		case "i32":
			return json.Marshal(c.I32)
		default:
			// []uint8 would marshal as a base64 string; emit numbers.
			a := make([]int, len(c.U8))
			for i, v := range c.U8 {
				a[i] = int(v)
			}
			return json.Marshal(a)
		}
	}
	return json.Marshal(struct {
		T   string `json:"t"`
		Off int    `json:"off"`
		N   int    `json:"n"`
	}{c.Type, c.off, c.len()})
}

func (c Column) write(buf []byte) {
	switch c.Type {
	case "f64":
		for i, v := range c.F64 {
			binary.LittleEndian.PutUint64(buf[8*i:], math.Float64bits(v))
		}
	case "i32":
		for i, v := range c.I32 {
			binary.LittleEndian.PutUint32(buf[4*i:], uint32(v))
		}
	default:
		copy(buf, c.U8)
	}
}

// pack lays the columns out in one buffer (each aligned to its width), sets
// their offsets and returns the gzip+base64 blob.
func pack(cols []*Column) (string, error) {
	size := 0
	for _, c := range cols {
		w := c.width()
		if r := size % w; r != 0 {
			size += w - r
		}
		c.off = size
		c.packed = true
		size += c.len() * w
	}
	buf := make([]byte, size)
	for _, c := range cols {
		c.write(buf[c.off:])
	}
	var out bytes.Buffer
	gz, err := gzip.NewWriterLevel(&out, gzip.BestSpeed)
	if err != nil {
		return "", err
	}
	if _, err := gz.Write(buf); err != nil {
		return "", err
	}
	if err := gz.Close(); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(out.Bytes()), nil
}

const maxI32 = math.MaxInt32

func clamp32(v int64) int32 {
	if v > maxI32 {
		return maxI32
	}
	if v < -maxI32 {
		return -maxI32
	}
	return int32(v)
}

func f64col(n int, get func(i int) int64) Column {
	c := Column{Type: "f64", F64: make([]float64, n)}
	for i := 0; i < n; i++ {
		c.F64[i] = float64(get(i))
	}
	return c
}

func i32col(n int, get func(i int) int64) Column {
	c := Column{Type: "i32", I32: make([]int32, n)}
	for i := 0; i < n; i++ {
		c.I32[i] = clamp32(get(i))
	}
	return c
}

func u8col(n int, get func(i int) uint8) Column {
	c := Column{Type: "u8", U8: make([]uint8, n)}
	for i := 0; i < n; i++ {
		c.U8[i] = get(i)
	}
	return c
}
