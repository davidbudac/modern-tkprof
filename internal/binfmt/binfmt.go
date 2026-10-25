// Package binfmt is the small explicit binary encoding of the persistent index
// cache (model.Encode, analyze's accumulator, trace.LineIndex.Save, the spill
// index): a header of a magic string and a format version, then values in an
// order fixed by the code that writes them. Integers are varints (signed ones
// zig-zag), strings and slices are length-prefixed, little endian where a
// fixed width is used. The encoding is not self-describing: adding or moving a
// field means bumping the version of the file, and a reader of another
// version fails with ErrFormat so the caller rebuilds instead of misreading.
//
// Writer and Reader keep the first error and turn every later call into a
// no-op, so encoders and decoders are straight-line code that checks Err once.
package binfmt

import (
	"bufio"
	"cmp"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math"
	"slices"
	"time"
)

// ErrFormat is the error (wrapped) of a file that is not of the expected
// format or version, or is truncated or corrupt.
var ErrFormat = errors.New("unsupported or corrupt index file")

// maxLen bounds a decoded length so a corrupt file cannot ask for a huge allocation.
const maxLen = 1 << 31

// Writer encodes values to a buffered writer.
type Writer struct {
	w   *bufio.Writer
	err error
	buf [binary.MaxVarintLen64]byte
}

// NewWriter returns a Writer over w; call Flush at the end.
func NewWriter(w io.Writer) *Writer { return &Writer{w: bufio.NewWriterSize(w, 256<<10)} }

func (w *Writer) write(b []byte) {
	if w.err == nil {
		_, w.err = w.w.Write(b)
	}
}

// Header writes the magic string and the format version.
func (w *Writer) Header(magic string, version int) {
	w.write([]byte(magic))
	w.Uint(uint64(version))
}

// Uint writes an unsigned varint.
func (w *Writer) Uint(v uint64) { w.write(w.buf[:binary.PutUvarint(w.buf[:], v)]) }

// Int writes a signed (zig-zag) varint.
func (w *Writer) Int(v int64) { w.write(w.buf[:binary.PutVarint(w.buf[:], v)]) }

// Bool writes one byte.
func (w *Writer) Bool(v bool) {
	b := byte(0)
	if v {
		b = 1
	}
	w.write([]byte{b})
}

// Float writes the IEEE 754 bits, little endian.
func (w *Writer) Float(v float64) {
	binary.LittleEndian.PutUint64(w.buf[:8], math.Float64bits(v))
	w.write(w.buf[:8])
}

// String writes a length-prefixed string.
func (w *Writer) String(s string) {
	w.Uint(uint64(len(s)))
	if w.err == nil {
		_, w.err = w.w.WriteString(s)
	}
}

// Bytes writes a length-prefixed byte slice.
func (w *Writer) Bytes(b []byte) {
	w.Uint(uint64(len(b)))
	w.write(b)
}

// Len writes the length of a slice or map, keeping nil apart from empty (the
// JSON of the two differs): 0 is nil, n+1 is length n.
func (w *Writer) Len(n int, isNil bool) {
	if isNil {
		w.Uint(0)
		return
	}
	w.Uint(uint64(n) + 1)
}

// Time writes a time.Time with its zone offset (time.MarshalBinary).
func (w *Writer) Time(t time.Time) {
	b, err := t.MarshalBinary()
	if err != nil && w.err == nil {
		w.err = err
	}
	w.Bytes(b)
}

// Strings writes a string slice (nil kept apart from empty).
func (w *Writer) Strings(s []string) {
	w.Len(len(s), s == nil)
	for _, v := range s {
		w.String(v)
	}
}

// Fail records an error of the encoder itself.
func (w *Writer) Fail(err error) {
	if w.err == nil {
		w.err = err
	}
}

// Err is the first error.
func (w *Writer) Err() error { return w.err }

// Flush writes the buffer out and returns the first error.
func (w *Writer) Flush() error {
	if w.err == nil {
		w.err = w.w.Flush()
	}
	return w.err
}

// Reader decodes what a Writer wrote.
type Reader struct {
	r   *bufio.Reader
	err error
}

// NewReader returns a Reader over r.
func NewReader(r io.Reader) *Reader {
	if br, ok := r.(*bufio.Reader); ok {
		return &Reader{r: br}
	}
	return &Reader{r: bufio.NewReaderSize(r, 256<<10)}
}

func (r *Reader) fail(err error) {
	if r.err == nil {
		if errors.Is(err, io.EOF) {
			err = io.ErrUnexpectedEOF
		}
		r.err = fmt.Errorf("%w: %v", ErrFormat, err)
	}
}

// Failf records a decoding error (wrapped in ErrFormat).
func (r *Reader) Failf(format string, args ...any) {
	r.fail(fmt.Errorf(format, args...))
}

// Header checks the magic string and the version.
func (r *Reader) Header(magic string, version int) {
	b := make([]byte, len(magic))
	if r.err != nil {
		return
	}
	if _, err := io.ReadFull(r.r, b); err != nil {
		r.fail(err)
		return
	}
	if string(b) != magic {
		r.Failf("not a %q file", magic)
		return
	}
	if v := r.Uint(); r.err == nil && v != uint64(version) {
		r.Failf("%s version %d, want %d", magic, v, version)
	}
}

// Uint reads an unsigned varint.
func (r *Reader) Uint() uint64 {
	if r.err != nil {
		return 0
	}
	v, err := binary.ReadUvarint(r.r)
	if err != nil {
		r.fail(err)
	}
	return v
}

// Int reads a signed varint.
func (r *Reader) Int() int64 {
	if r.err != nil {
		return 0
	}
	v, err := binary.ReadVarint(r.r)
	if err != nil {
		r.fail(err)
	}
	return v
}

// Int32 reads a signed varint that must fit in 32 bits.
func (r *Reader) Int32() int32 {
	v := r.Int()
	if v < math.MinInt32 || v > math.MaxInt32 {
		r.Failf("value %d out of int32 range", v)
		return 0
	}
	return int32(v)
}

// Uint32 reads an unsigned varint that must fit in 32 bits.
func (r *Reader) Uint32() uint32 {
	v := r.Uint()
	if v > math.MaxUint32 {
		r.Failf("value %d out of uint32 range", v)
		return 0
	}
	return uint32(v)
}

// Uint8 reads an unsigned varint that must fit in a byte.
func (r *Reader) Uint8() uint8 {
	v := r.Uint()
	if v > math.MaxUint8 {
		r.Failf("value %d out of byte range", v)
		return 0
	}
	return uint8(v)
}

// IntN reads a signed varint as an int.
func (r *Reader) IntN() int { return int(r.Int()) }

// Bool reads one byte.
func (r *Reader) Bool() bool {
	if r.err != nil {
		return false
	}
	b, err := r.r.ReadByte()
	if err != nil {
		r.fail(err)
		return false
	}
	if b > 1 {
		r.Failf("bad bool %d", b)
	}
	return b == 1
}

// Float reads 8 bytes of IEEE 754 bits.
func (r *Reader) Float() float64 {
	var b [8]byte
	if r.err != nil {
		return 0
	}
	if _, err := io.ReadFull(r.r, b[:]); err != nil {
		r.fail(err)
		return 0
	}
	return math.Float64frombits(binary.LittleEndian.Uint64(b[:]))
}

func (r *Reader) n() int {
	v := r.Uint()
	if v > maxLen {
		r.Failf("length %d too large", v)
		return 0
	}
	return int(v)
}

// Bytes reads a length-prefixed byte slice.
func (r *Reader) Bytes() []byte {
	n := r.n()
	if r.err != nil {
		return nil
	}
	b := make([]byte, n)
	if _, err := io.ReadFull(r.r, b); err != nil {
		r.fail(err)
		return nil
	}
	return b
}

// String reads a length-prefixed string.
func (r *Reader) String() string { return string(r.Bytes()) }

// Len reads what Writer.Len wrote: the length and whether the slice was nil.
func (r *Reader) Len() (n int, isNil bool) {
	v := r.n()
	if r.err != nil || v == 0 {
		return 0, true
	}
	return v - 1, false
}

// Time reads a time.Time.
func (r *Reader) Time() time.Time {
	var t time.Time
	b := r.Bytes()
	if r.err == nil {
		if err := t.UnmarshalBinary(b); err != nil {
			r.fail(err)
		}
	}
	return t
}

// Strings reads a string slice.
func (r *Reader) Strings() []string {
	n, isNil := r.Len()
	if isNil {
		return nil
	}
	out := make([]string, 0, min(n, 1<<16))
	for i := 0; i < n && r.err == nil; i++ {
		out = append(out, r.String())
	}
	return out
}

// Err is the first error (wrapped in ErrFormat).
func (r *Reader) Err() error { return r.err }

// End checks that the input is exhausted (trailing bytes mean a different
// layout under the same version).
func (r *Reader) End() error {
	if r.err == nil {
		if _, err := r.r.ReadByte(); err == nil {
			r.Failf("trailing data")
		} else if err != io.EOF {
			r.fail(err)
		}
	}
	return r.err
}

// WriteSlice writes a slice element by element with f (nil kept apart from empty).
func WriteSlice[T any](w *Writer, s []T, f func(*T)) {
	w.Len(len(s), s == nil)
	for i := range s {
		f(&s[i])
	}
}

// ReadSlice reads what WriteSlice wrote, decoding each element with f.
func ReadSlice[T any](r *Reader, f func(*T)) []T {
	n, isNil := r.Len()
	if isNil {
		return nil
	}
	out := make([]T, 0, min(n, 1<<16))
	for i := 0; i < n && r.err == nil; i++ {
		var v T
		f(&v)
		out = append(out, v)
	}
	return out
}

// Codec runs one field list in either direction: with W set it writes the
// fields, with R set it reads them into the same pointers. Each struct of a
// format then has a single function that names its fields in order, used by
// both the encoder and the decoder, so the two cannot drift apart.
type Codec struct {
	W *Writer
	R *Reader
}

// Encoder returns a writing Codec.
func Encoder(w *Writer) *Codec { return &Codec{W: w} }

// Decoder returns a reading Codec.
func Decoder(r *Reader) *Codec { return &Codec{R: r} }

// Reading reports whether the codec decodes.
func (c *Codec) Reading() bool { return c.R != nil }

// Err is the first error of either direction.
func (c *Codec) Err() error {
	if c.R != nil {
		return c.R.Err()
	}
	return c.W.Err()
}

func (c *Codec) I64(p *int64) {
	if c.R != nil {
		*p = c.R.Int()
	} else {
		c.W.Int(*p)
	}
}

func (c *Codec) I32(p *int32) {
	if c.R != nil {
		*p = c.R.Int32()
	} else {
		c.W.Int(int64(*p))
	}
}

func (c *Codec) Int(p *int) {
	if c.R != nil {
		*p = c.R.IntN()
	} else {
		c.W.Int(int64(*p))
	}
}

func (c *Codec) U64(p *uint64) {
	if c.R != nil {
		*p = c.R.Uint()
	} else {
		c.W.Uint(*p)
	}
}

func (c *Codec) U32(p *uint32) {
	if c.R != nil {
		*p = c.R.Uint32()
	} else {
		c.W.Uint(uint64(*p))
	}
}

func (c *Codec) U8(p *uint8) {
	if c.R != nil {
		*p = c.R.Uint8()
	} else {
		c.W.Uint(uint64(*p))
	}
}

func (c *Codec) Bool(p *bool) {
	if c.R != nil {
		*p = c.R.Bool()
	} else {
		c.W.Bool(*p)
	}
}

func (c *Codec) F64(p *float64) {
	if c.R != nil {
		*p = c.R.Float()
	} else {
		c.W.Float(*p)
	}
}

func (c *Codec) Str(p *string) {
	if c.R != nil {
		*p = c.R.String()
	} else {
		c.W.String(*p)
	}
}

func (c *Codec) Time(p *time.Time) {
	if c.R != nil {
		*p = c.R.Time()
	} else {
		c.W.Time(*p)
	}
}

func (c *Codec) Strings(p *[]string) {
	if c.R != nil {
		*p = c.R.Strings()
	} else {
		c.W.Strings(*p)
	}
}

// Slice runs f over the elements of *p (nil kept apart from empty).
func Slice[T any](c *Codec, p *[]T, f func(*T)) {
	if c.R != nil {
		*p = ReadSlice(c.R, f)
	} else {
		WriteSlice(c.W, *p, f)
	}
}

// Ptr codes a pointer that may be nil: a presence byte, then f on the value.
func Ptr[T any](c *Codec, p **T, f func(*T)) {
	present := *p != nil
	c.Bool(&present)
	if !present {
		if c.R != nil {
			*p = nil
		}
		return
	}
	if c.R != nil {
		*p = new(T)
	}
	f(*p)
}

// Map codes a map in ascending key order (so equal maps encode to equal
// bytes); nil is kept apart from empty.
func Map[K cmp.Ordered, V any](c *Codec, p *map[K]V, key func(*K), val func(*V)) {
	MapFunc(c, p, cmp.Compare[K], key, val)
}

// MapFunc is Map with an explicit key order.
func MapFunc[K comparable, V any](c *Codec, p *map[K]V, compare func(a, b K) int, key func(*K), val func(*V)) {
	if c.R != nil {
		n, isNil := c.R.Len()
		if isNil {
			*p = nil
			return
		}
		m := make(map[K]V, min(n, 1<<16))
		for i := 0; i < n && c.R.err == nil; i++ {
			var k K
			var v V
			key(&k)
			val(&v)
			m[k] = v
		}
		*p = m
		return
	}
	m := *p
	c.W.Len(len(m), m == nil)
	keys := make([]K, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, compare)
	for _, k := range keys {
		v := m[k]
		key(&k)
		val(&v)
	}
}
