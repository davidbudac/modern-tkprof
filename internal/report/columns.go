package report

import (
	"encoding/json"
	"math"
)

// Column is a typed fact column of an unpacked document: a JSON array. (The
// packed layout the UI normally loads is written by the streaming writer in
// stream.go, which never materialises columns.)
type Column struct {
	Type string // "f64" | "i32" | "u8"
	F64  []float64
	I32  []int32
	U8   []uint8
}

func (c Column) MarshalJSON() ([]byte, error) {
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
