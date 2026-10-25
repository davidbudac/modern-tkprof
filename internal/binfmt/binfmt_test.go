package binfmt

import (
	"bytes"
	"errors"
	"reflect"
	"testing"
	"time"
)

type sample struct {
	I   int64
	U   uint64
	S   string
	B   bool
	F   float64
	T   time.Time
	Nil []string
	Emp []string
	M   map[string]int
	P   *int64
}

func code(c *Codec, s *sample) {
	c.I64(&s.I)
	c.U64(&s.U)
	c.Str(&s.S)
	c.Bool(&s.B)
	c.F64(&s.F)
	c.Time(&s.T)
	c.Strings(&s.Nil)
	c.Strings(&s.Emp)
	Map(c, &s.M, c.Str, c.Int)
	Ptr(c, &s.P, c.I64)
}

func TestCodecRoundTrip(t *testing.T) {
	v := int64(-7)
	in := sample{I: -1 << 40, U: 1 << 63, S: "héllo\x00", B: true, F: 0.1, T: time.Date(2024, 2, 29, 13, 14, 15, 123, time.FixedZone("", 7200)),
		Emp: []string{}, M: map[string]int{"b": 2, "a": -1}, P: &v}
	var buf bytes.Buffer
	w := NewWriter(&buf)
	w.Header("TESTMAGC", 3)
	code(Encoder(w), &in)
	if err := w.Flush(); err != nil {
		t.Fatal(err)
	}
	var out sample
	r := NewReader(bytes.NewReader(buf.Bytes()))
	r.Header("TESTMAGC", 3)
	code(Decoder(r), &out)
	if err := r.End(); err != nil {
		t.Fatal(err)
	}
	if !in.T.Equal(out.T) {
		t.Errorf("time %v, want %v", out.T, in.T)
	}
	in.T, out.T = time.Time{}, time.Time{}
	if !reflect.DeepEqual(in, out) || out.Nil != nil || out.Emp == nil {
		t.Errorf("got %+v\nwant %+v", out, in)
	}
	for name, b := range map[string][]byte{
		"version":   append([]byte("TESTMAGC\x04"), buf.Bytes()[9:]...),
		"magic":     append([]byte("XESTMAGC"), buf.Bytes()[8:]...),
		"truncated": buf.Bytes()[:buf.Len()-3],
		"trailing":  append(append([]byte(nil), buf.Bytes()...), 0),
		"length":    append([]byte("TESTMAGC\x03\x00\x00\xff\xff\xff\xff\x0f"), buf.Bytes()[9:]...),
	} {
		r := NewReader(bytes.NewReader(b))
		r.Header("TESTMAGC", 3)
		var s sample
		code(Decoder(r), &s)
		if err := r.End(); !errors.Is(err, ErrFormat) {
			t.Errorf("%s: %v, want ErrFormat", name, err)
		}
	}
}
