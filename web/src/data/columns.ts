import type { ColumnDesc, RawTable } from './types'

export type NumCol = Float64Array | Int32Array | Uint8Array

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function gunzip(bytes: Uint8Array): Promise<ArrayBuffer> {
  const ds = new DecompressionStream('gzip')
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds)
  return new Response(stream).arrayBuffer()
}

function isDesc(v: unknown): v is ColumnDesc {
  return typeof v === 'object' && v !== null && 't' in v && 'off' in v
}

/** Turns a raw table (plain arrays or packed descriptors + blob) into typed arrays. */
export async function unpackTable<K extends string>(raw: RawTable, cols: readonly K[]): Promise<Record<K, NumCol>> {
  const out = {} as Record<K, NumCol>
  let buf: ArrayBuffer | null = null
  if (raw.blob) buf = await gunzip(b64ToBytes(raw.blob))
  for (const name of cols) {
    const v = raw[name]
    if (isDesc(v)) {
      if (!buf) throw new Error(`column ${name} is packed but the table has no blob`)
      out[name] = v.t === 'f64' ? new Float64Array(buf, v.off, v.n)
        : v.t === 'i32' ? new Int32Array(buf, v.off, v.n)
        : new Uint8Array(buf, v.off, v.n)
    } else if (Array.isArray(v)) {
      // plain JSON arrays: pick a type that holds the values
      let f64 = false, u8 = true
      for (const x of v as number[]) {
        if (!Number.isInteger(x) || Math.abs(x) > 0x7fffffff) { f64 = true; break }
        if (x < 0 || x > 255) u8 = false
      }
      out[name] = f64 ? Float64Array.from(v as number[]) : u8 ? Uint8Array.from(v as number[]) : Int32Array.from(v as number[])
    } else if (v === undefined || v === null) {
      out[name] = new Int32Array(0)
    } else {
      throw new Error(`column ${name}: unexpected value`)
    }
  }
  return out
}
