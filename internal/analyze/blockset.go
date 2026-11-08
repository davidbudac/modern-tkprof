package analyze

import (
	"math/bits"
	"slices"
	"sort"
)

// blockSet is the set of (owner, file, block) keys the I/O routes have seen,
// in chunks of 65,536 blocks of one owner and file, as a roaring bitmap does:
// a chunk is a sorted array of block offsets until a range would take it past
// chunkArrayMax, then a bitmap of 8 KB. A full scan costs about a bit per
// block, scattered single-block reads 2 bytes. Owners keep apart the sets of
// one query (0: every read; then one per object group or statement and
// file). Its size is modelled in bytes (chunkCost), and the TypeScript twin
// (web/src/lib/data/iohot.ts) models it the same way, so a cap on it stops the
// same waits on both sides.
type blockSet struct {
	chunks map[chunkKey]*chunk
	bytes  int64
}

type chunkKey struct {
	owner uint32
	hi    uint32 // block >> chunkShift
	file  int64
}

type chunk struct {
	arr  []uint16 // sorted offsets, while bits is nil
	bits []uint64 // chunkWords words, once the chunk is a bitmap
	n    int
}

const (
	chunkShift    = 16
	chunkSize     = 1 << chunkShift
	chunkWords    = chunkSize / 64
	chunkArrayMax = 1024
	// chunkCost: chunkOverhead per chunk, plus 2 bytes per key in an array or chunkBitmapBytes for a bitmap.
	chunkOverhead    = 64
	chunkBitmapBytes = chunkSize / 8
)

func newBlockSet() *blockSet { return &blockSet{chunks: map[chunkKey]*chunk{}} }

func (c *chunk) cost() int64 {
	if c.bits != nil {
		return chunkOverhead + chunkBitmapBytes
	}
	return chunkOverhead + 2*int64(c.n)
}

// addRange adds the blocks [lo, hi) of file to owner's set (blocks below 0
// are left out). seen is called for each block that was already there, in
// ascending order; the result is the number of blocks that were not.
func (s *blockSet) addRange(owner uint32, file, lo, hi int64, seen func(b int64)) int64 {
	lo = max(lo, 0)
	var added int64
	for lo < hi {
		h := lo >> chunkShift
		end := min(hi, (h+1)<<chunkShift)
		k := chunkKey{owner: owner, hi: uint32(h), file: file}
		c := s.chunks[k]
		if c == nil {
			c = &chunk{}
			s.chunks[k] = c
			s.bytes += chunkOverhead
		}
		before := c.cost()
		base := h << chunkShift
		var fn func(off int)
		if seen != nil {
			fn = func(off int) { seen(base + int64(off)) }
		}
		added += int64(c.addRange(int(lo-base), int(end-base), fn))
		s.bytes += c.cost() - before
		lo = end
	}
	return added
}

// addRange adds the offsets [a, b) (0 ≤ a < b ≤ chunkSize); seen gets those already there.
func (c *chunk) addRange(a, b int, seen func(off int)) int {
	if c.bits == nil && c.n+(b-a) > chunkArrayMax {
		c.bits = make([]uint64, chunkWords)
		for _, v := range c.arr {
			c.bits[v>>6] |= 1 << (v & 63)
		}
		c.arr = nil
	}
	added := 0
	if c.bits != nil {
		for w := a >> 6; w <= (b-1)>>6; w++ {
			from, to := max(a, w<<6), min(b, (w+1)<<6) // the offsets of [a, b) in word w
			mask := ^uint64(0) >> (64 - (to - from)) << (from & 63)
			old := c.bits[w] & mask
			added += bits.OnesCount64(mask &^ c.bits[w])
			for seen != nil && old != 0 {
				seen(w<<6 + bits.TrailingZeros64(old))
				old &= old - 1
			}
			c.bits[w] |= mask
		}
		c.n += added
		return added
	}
	i := sort.Search(len(c.arr), func(k int) bool { return int(c.arr[k]) >= a })
	j := i
	for j < len(c.arr) && int(c.arr[j]) < b {
		if seen != nil {
			seen(int(c.arr[j]))
		}
		j++
	}
	added = (b - a) - (j - i)
	if added > 0 {
		old := len(c.arr)
		c.arr = slices.Grow(c.arr, added)[:old+added]
		copy(c.arr[i+(b-a):], c.arr[j:old])
		for v := a; v < b; v++ {
			c.arr[i+v-a] = uint16(v)
		}
	}
	c.n += added
	return added
}

// has reports whether owner's set holds the block.
func (s *blockSet) has(owner uint32, file, b int64) bool {
	if b < 0 {
		return false
	}
	c := s.chunks[chunkKey{owner: owner, hi: uint32(b >> chunkShift), file: file}]
	if c == nil {
		return false
	}
	off := int(b & (chunkSize - 1))
	if c.bits != nil {
		return c.bits[off>>6]&(1<<(off&63)) != 0
	}
	_, ok := slices.BinarySearch(c.arr, uint16(off))
	return ok
}

// ---- block read counts ---------------------------------------------------------------

// Caps of the block counting (IOHotOpts, IOMapOpts); the TypeScript twin has the same defaults.
const (
	// DefaultSeenBytes caps the set of blocks read (blockSet bytes): past it no block is added, and a block first read after
	// that starts at 1 in the counter map (which then fills with blocks read once, and prunes).
	DefaultSeenBytes = 64 << 20
	// DefaultOwnerBytes caps the sets behind the objects' and statements' distinct counts: past it every block counts as new
	// for them (IOHot.DistinctExact false); the counting of the hot blocks does not depend on it.
	DefaultOwnerBytes = 32 << 20
	// DefaultCountCap is the most blocks the counter map holds before a Misra-Gries prune halves it.
	DefaultCountCap = 1_000_000
)

// blockCounter counts the reads of every block of a scan: the first read of a
// block only marks it in a blockSet (owner 0), so a full scan costs bits; a
// block read again gets an entry in the counter map (2 on its second read).
// Above countCap entries the map is pruned the Misra-Gries way: c = the
// (countCap/2 + 1)-th largest count is taken from every entry, the entries
// at or below it go, and dec grows by c. A count is then an underestimate by
// at most dec, and a block with no entry was read at most 1 + dec times. While
// dec is 0 every count is exact. Past the set's cap (seenBytes) blocks are
// only looked up in it, and a block it does not hold starts at 1 in the map.
// The set is the counter's own (owner 0).
type blockCounter struct {
	set       *blockSet
	count     map[uint64]int32
	seenBytes int64
	countCap  int
	capped    bool  // the set reached seenBytes: no block is added to it any more
	dec       int64 // the Misra-Gries decrement so far
	distinct  int64 // distinct blocks read (an estimate once capped and pruned)
}

func newBlockCounter(seenBytes int64, countCap int) *blockCounter {
	if seenBytes <= 0 {
		seenBytes = DefaultSeenBytes
	}
	if countCap < 2 {
		countCap = DefaultCountCap
	}
	return &blockCounter{set: newBlockSet(), count: map[uint64]int32{}, seenBytes: seenBytes, countCap: countCap}
}

func blockKey(file, b int64) uint64 { return uint64(file)<<32 | uint64(uint32(b)) }

// countable: the counter map's keys hold files in [0, 2^31) and blocks in [0, 2^32) (the TypeScript twin's keys are exact
// numbers below 2^53); blocks outside it are not counted.
const maxCountFile, maxCountBlock = 1 << 31, 1 << 32

// startWait is called once before each wait's reads: it decides whether the set still grows.
func (bc *blockCounter) startWait() {
	if !bc.capped && bc.set.bytes >= bc.seenBytes {
		bc.capped = true
	}
}

// read counts one read of the blocks [lo, hi) of file (those a key holds: maxCountFile, maxCountBlock).
func (bc *blockCounter) read(file, lo, hi int64) {
	lo, hi = max(lo, 0), min(hi, maxCountBlock)
	if lo >= hi || file < 0 || file >= maxCountFile {
		return
	}
	again := func(b int64) {
		k := blockKey(file, b)
		if v, ok := bc.count[k]; ok {
			bc.count[k] = v + 1
		} else {
			bc.count[k] = 2
		}
	}
	if !bc.capped {
		bc.distinct += bc.set.addRange(0, file, lo, hi, again)
		return
	}
	for b := lo; b < hi; b++ {
		if bc.set.has(0, file, b) {
			again(b)
			continue
		}
		k := blockKey(file, b)
		if v, ok := bc.count[k]; ok {
			bc.count[k] = v + 1
		} else {
			bc.count[k] = 1
			bc.distinct++
		}
	}
}

// endWait prunes the counter map when it holds more than countCap blocks.
func (bc *blockCounter) endWait() {
	if len(bc.count) <= bc.countCap {
		return
	}
	m := bc.countCap / 2
	vals := make([]int32, 0, len(bc.count))
	for _, v := range bc.count {
		vals = append(vals, v)
	}
	slices.SortFunc(vals, func(a, b int32) int { return int(b) - int(a) })
	c := vals[m] // the (m+1)-th largest
	for k, v := range bc.count {
		if v <= c {
			delete(bc.count, k)
		} else {
			bc.count[k] = v - c
		}
	}
	bc.dec += int64(c)
}

// reads is the counted reads of one block (exact while dec is 0; 0 for a block the counting leaves out).
func (bc *blockCounter) reads(file, b int64) int64 {
	if file < 0 || file >= maxCountFile || b < 0 || b >= maxCountBlock {
		return 0
	}
	if v, ok := bc.count[blockKey(file, b)]; ok {
		return int64(v)
	}
	if bc.set.has(0, file, b) {
		return 1
	}
	return 0
}
