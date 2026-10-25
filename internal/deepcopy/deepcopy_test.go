package deepcopy

import (
	"reflect"
	"testing"
)

type leaf struct {
	n    int
	name string
}

type sinkI interface{ get() int }

func (l *leaf) get() int { return l.n }

type node struct {
	a, b   *leaf // the same object
	m      map[int]*leaf
	ms     map[string][]int
	s      [][]int
	flat   []leaf
	i      sinkI // holds a
	arr    [2]*leaf
	nilMap map[int]int
	fn     func() int
	self   *node
}

func TestOf(t *testing.T) {
	l := &leaf{1, "x"}
	n := &node{a: l, b: l, m: map[int]*leaf{7: l}, ms: map[string][]int{"k": {1, 2}}, s: [][]int{{1}, {2, 3}},
		flat: []leaf{{2, "y"}}, i: l, arr: [2]*leaf{l, {3, "z"}}, fn: func() int { return 9 }}
	n.self = n
	c := Of(n)
	if c == n || c.a == l || c.a != c.b || c.m[7] != c.a || c.i.(*leaf) != c.a || c.arr[0] != c.a || c.self != c {
		t.Fatalf("sharing not kept: %+v", c)
	}
	if !reflect.DeepEqual(*c.a, *l) || c.arr[1].name != "z" || c.fn() != 9 || c.nilMap != nil {
		t.Fatalf("values differ: %+v", c)
	}
	c.a.n = 5
	c.ms["k"][0] = 100
	c.s[1][0] = 100
	c.flat[0].n = 100
	if l.n != 1 || n.ms["k"][0] != 1 || n.s[1][0] != 2 || n.flat[0].n != 2 {
		t.Fatalf("the copy shares memory with the original")
	}
}
