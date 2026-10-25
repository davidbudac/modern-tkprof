// Package deepcopy copies a graph of Go values, unexported fields included,
// for the snapshots of a live session (internal/model.(*Builder).Snapshot):
// the builder, its model and the accumulator are copied at a line boundary
// and the copy is finished while the original goes on parsing.
//
// Rules:
//   - Pointers are followed; two pointers to the same object (same address
//     and type) point to the same copy, so shared objects stay shared.
//     A pointer into the middle of another copied object (a field of a
//     struct, an element of a slice) gets a copy of its own: code that
//     relies on such an alias staying an alias must not be copied.
//   - Slices get a new backing array of their length (the capacity is not
//     kept); maps are rebuilt; interfaces hold a copy of their value.
//   - Strings, funcs, channels and unsafe pointers are shared: strings are
//     immutable, the others are not data.
//   - Values whose type holds no pointers but strings are copied as a block.
package deepcopy

import (
	"reflect"
	"sync"
	"unsafe"
)

// Of returns a deep copy of *p.
func Of[T any](p *T) *T {
	c := copier{memo: map[ptrKey]reflect.Value{}}
	return c.ptr(reflect.ValueOf(p)).Interface().(*T)
}

type ptrKey struct {
	p uintptr
	t reflect.Type
}

type copier struct {
	memo map[ptrKey]reflect.Value
}

// flat caches whether a type holds no pointers but strings.
var flat sync.Map // reflect.Type -> bool

func isFlat(t reflect.Type) bool {
	if v, ok := flat.Load(t); ok {
		return v.(bool)
	}
	var f bool
	switch t.Kind() {
	case reflect.Bool, reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64, reflect.Uintptr,
		reflect.Float32, reflect.Float64, reflect.Complex64, reflect.Complex128, reflect.String:
		f = true
	case reflect.Array:
		f = t.Len() == 0 || isFlat(t.Elem())
	case reflect.Struct:
		f = true
		for i := 0; i < t.NumField(); i++ {
			if !isFlat(t.Field(i).Type) {
				f = false
				break
			}
		}
	}
	flat.Store(t, f)
	return f
}

// open makes an addressable value settable even when it was reached through
// an unexported field.
func open(v reflect.Value) reflect.Value {
	return reflect.NewAt(v.Type(), unsafe.Pointer(v.UnsafeAddr())).Elem()
}

// ptr copies the object a pointer points to (once per object).
func (c *copier) ptr(p reflect.Value) reflect.Value {
	if p.IsNil() {
		return reflect.Zero(p.Type())
	}
	k := ptrKey{p.Pointer(), p.Type()}
	if v, ok := c.memo[k]; ok {
		return v
	}
	n := reflect.New(p.Type().Elem())
	c.memo[k] = n
	c.into(n.Elem(), open(p.Elem()))
	return n
}

// into copies src into dst; both addressable and settable.
func (c *copier) into(dst, src reflect.Value) {
	t := src.Type()
	if isFlat(t) {
		dst.Set(src)
		return
	}
	switch t.Kind() {
	case reflect.Pointer:
		dst.Set(c.ptr(src))
	case reflect.Struct:
		for i := 0; i < t.NumField(); i++ {
			c.into(open(dst.Field(i)), open(src.Field(i)))
		}
	case reflect.Array:
		for i := 0; i < t.Len(); i++ {
			c.into(dst.Index(i), src.Index(i))
		}
	case reflect.Slice:
		if src.IsNil() {
			dst.Set(reflect.Zero(t))
			return
		}
		n := src.Len()
		s := reflect.MakeSlice(t, n, n)
		if isFlat(t.Elem()) {
			reflect.Copy(s, src)
		} else {
			for i := 0; i < n; i++ {
				c.into(s.Index(i), src.Index(i))
			}
		}
		dst.Set(s)
	case reflect.Map:
		if src.IsNil() {
			dst.Set(reflect.Zero(t))
			return
		}
		m := reflect.MakeMapWithSize(t, src.Len())
		kf, vf := isFlat(t.Key()), isFlat(t.Elem())
		it := src.MapRange()
		for it.Next() {
			k, v := it.Key(), it.Value()
			if !kf {
				k = c.value(k)
			}
			if !vf {
				v = c.value(v)
			}
			m.SetMapIndex(k, v)
		}
		dst.Set(m)
	case reflect.Interface:
		if src.IsNil() {
			dst.Set(reflect.Zero(t))
			return
		}
		dst.Set(c.value(src.Elem()))
	default: // func, chan, unsafe.Pointer: shared
		dst.Set(src)
	}
}

// value copies a value that is not addressable (a map entry, the content of
// an interface) and returns the copy.
func (c *copier) value(v reflect.Value) reflect.Value {
	if v.Kind() == reflect.Pointer {
		return c.ptr(v)
	}
	src := reflect.New(v.Type()).Elem()
	src.Set(v)
	dst := reflect.New(v.Type()).Elem()
	c.into(dst, src)
	return dst
}
