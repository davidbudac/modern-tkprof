import { describe, expect, it } from 'vitest'
import { reduceMinimap } from './minimap'
import type { Minimap } from './types'

const mm = (cpu: number[], waits: Record<string, number[]> = {}, bucketUs = 100): Minimap => ({ bucketUs, cpu, waits })

describe('reduceMinimap', () => {
  it('maps one bucket to one column when widths match', () => {
    const [cpu] = reduceMinimap(mm([100, 50, 0, 25]), 4)
    expect(cpu.role).toBe('cpu')
    expect([...cpu.values]).toEqual([1, 0.5, 0, 0.25])
  })

  it('averages the buckets of a column when narrower than the data', () => {
    const [cpu] = reduceMinimap(mm([100, 0, 50, 50]), 2)
    expect([...cpu.values]).toEqual([0.5, 0.5])
  })

  it('repeats a bucket across columns when wider than the data', () => {
    const [cpu] = reduceMinimap(mm([100, 0]), 4)
    expect([...cpu.values]).toEqual([1, 1, 0, 0])
  })

  it('stacks CPU first, then wait roles in role order, folding unknown classes into other', () => {
    const out = reduceMinimap(mm([10, 10], { Commit: [20, 0], 'User I/O': [30, 30], Cluster: [5, 5], Application: [5, 5] }), 2)
    expect(out.map((s) => s.role)).toEqual(['cpu', 'userio', 'commit', 'other'])
    expect([...out[3].values]).toEqual([0.1, 0.1]) // Cluster + Application
  })

  it('leaves out the Idle class on request and caps a column at 1', () => {
    const m = mm([100], { Idle: [500] })
    expect(reduceMinimap(m, 1).map((s) => s.role)).toEqual(['cpu', 'idle'])
    expect(reduceMinimap(m, 1)[1].values[0]).toBe(1)
    expect(reduceMinimap(m, 1, false).map((s) => s.role)).toEqual(['cpu'])
  })

  it('answers nothing for an empty strip or zero width', () => {
    expect(reduceMinimap(mm([]), 10)).toEqual([])
    expect(reduceMinimap(mm([1]), 0)).toEqual([])
  })
})
