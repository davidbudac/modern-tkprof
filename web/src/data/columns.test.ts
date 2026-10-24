import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { unpackTable } from './columns'
import type { RawTable } from './types'

/** Packs typed arrays into one gzip'd, base64 blob the way the Go writer does; returns the blob and each array's byte offset. */
function pack(parts: ArrayBufferView[]): { blob: string; offs: number[] } {
  const offs: number[] = []
  let size = 0
  for (const p of parts) { offs.push(size); size += p.byteLength }
  const buf = new Uint8Array(size)
  parts.forEach((p, i) => buf.set(new Uint8Array(p.buffer, p.byteOffset, p.byteLength), offs[i]))
  return { blob: gzipSync(buf).toString('base64'), offs }
}

describe('unpackTable', () => {
  it('integrates delta-coded (format 3) i32 and f64 columns, leaves plain ones alone', async () => {
    const { blob, offs } = pack([Int32Array.from([10, 3, -1, 0]), Float64Array.from([1.5, 1, 0.25]), Int32Array.from([7, 8, 9])])
    const raw: RawTable = {
      n: 4, blob,
      a: { t: 'i32', off: offs[0], n: 4, d: 1 },
      b: { t: 'f64', off: offs[1], n: 3, d: 1 },
      c: { t: 'i32', off: offs[2], n: 3 },
    }
    const out = await unpackTable(raw, ['a', 'b', 'c'] as const)
    expect(Array.from(out.a)).toEqual([10, 13, 12, 12])
    expect(Array.from(out.b)).toEqual([1.5, 2.5, 2.75])
    expect(Array.from(out.c)).toEqual([7, 8, 9])
  })

  it('wraps delta sums like int32 arithmetic', async () => {
    const { blob, offs } = pack([Int32Array.from([0x7fffffff, 1])])
    const out = await unpackTable({ n: 2, blob, a: { t: 'i32', off: offs[0], n: 2, d: 1 } }, ['a'] as const)
    expect(Array.from(out.a)).toEqual([0x7fffffff, -0x80000000])
  })

  it('does not integrate u8 columns even when flagged', async () => {
    const { blob, offs } = pack([Uint8Array.from([1, 2, 3])])
    const out = await unpackTable({ n: 3, blob, a: { t: 'u8', off: offs[0], n: 3, d: 1 } }, ['a'] as const)
    expect(Array.from(out.a)).toEqual([1, 2, 3])
  })

  it('reads a base64 string as a u8 column (older unpacked json)', async () => {
    const out = await unpackTable({ n: 3, a: Buffer.from([0, 5, 255]).toString('base64') }, ['a'] as const)
    expect(out.a).toBeInstanceOf(Uint8Array)
    expect(Array.from(out.a)).toEqual([0, 5, 255])
  })

  it('picks a type for plain JSON arrays and tolerates a missing column', async () => {
    const out = await unpackTable({ n: 3, u: [0, 1, 255], i: [-1, 5, 300], f: [0.5, 1, 2] }, ['u', 'i', 'f', 'gone'] as const)
    expect(out.u).toBeInstanceOf(Uint8Array)
    expect(out.i).toBeInstanceOf(Int32Array)
    expect(out.f).toBeInstanceOf(Float64Array)
    expect(out.gone).toHaveLength(0)
  })

  it('rejects a packed column without a blob', async () => {
    await expect(unpackTable({ n: 1, a: { t: 'i32', off: 0, n: 1 } }, ['a'] as const)).rejects.toThrow(/no blob/)
  })
})
