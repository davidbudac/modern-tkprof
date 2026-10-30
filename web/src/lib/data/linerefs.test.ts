import { describe, expect, it } from 'vitest'
import { matchSpans } from './lines'
import { mergeHits, refRuns, type RefRun } from './linerefs'

// real lines (testdata/traces/19c/basic_binds.trc, io_waits.trc)
const EXEC = 'EXEC #140124363561040:c=51,e=51,p=0,cr=0,cu=0,mis=0,r=1,dep=0,og=1,plh=0,tim=10778819462'
const FETCH = 'FETCH #140124363549808:c=29,e=29,p=0,cr=2,cu=0,mis=0,r=0,dep=1,og=4,plh=1426583507,tim=10778823348'
const WAIT = "WAIT #139745604251096: nam='asynch descriptor resize' ela= 6 outstanding #aio=0 current aio limit=0 new aio limit=128 obj#=108611 tim=10805135046"
const WAIT_NONE = "WAIT #139745605258360: nam='SQL*Net message from client' ela= 122 driver id=1952673792 #bytes=1 p3=0 obj#=-1 tim=10804499849"
const STAT = "STAT #139745604251096 id=2 cnt=100001 pid=1 pos=1 obj=108611 op='TABLE ACCESS FULL MTK_ORDERS (cr=498 pr=496 pw=0 str=1 time=634138 us cost=137 size=1300000 card=100000)'"
const PARSING = "PARSING IN CURSOR #139745605242584 len=48 dep=0 uid=165 oct=42 lid=165 tim=10804500013 hv=251293041 ad='0' sqlid='1h7h96h7gnvbj'"
const BINDS = 'BINDS #139745604248120:'
const ERR = 'ERROR #140396176538616:err=1 tim=10804229719'
const LOB = 'LOBREAD: type=PERSISTENT LOB,bytes=8191,c=661,e=1153,p=4,cr=1,cu=0,tim=11043951189'

const refs = (runs: RefRun[]) => runs.filter((r) => r.ref).map((r) => `${r.ref!.kind}:${r.ref!.value}=${r.text}`)
const join = (runs: RefRun[]) => runs.map((r) => r.text).join('')

describe('refRuns', () => {
  it('links the cursor number of a call line, but not plh=0', () => {
    const runs = refRuns(EXEC, 'call')
    expect(refs(runs)).toEqual(['cursor:140124363561040=#140124363561040'])
    expect(join(runs)).toBe(EXEC)
    expect(runs[0]).toEqual({ text: 'EXEC ' })
  })
  it('links the cursor and the plan hash of a call line', () => {
    expect(refs(refRuns(FETCH, 'call'))).toEqual(['cursor:140124363549808=#140124363549808', 'plh:1426583507=plh=1426583507'])
  })
  it('links the cursor and obj# of a wait line, not #aio or obj#=-1', () => {
    expect(refs(refRuns(WAIT, 'wait'))).toEqual(['cursor:139745604251096=#139745604251096', 'obj:108611=obj#=108611'])
    expect(refs(refRuns(WAIT_NONE, 'wait'))).toEqual(['cursor:139745605258360=#139745605258360'])
    expect(join(refRuns(WAIT, 'wait'))).toBe(WAIT)
  })
  it('links the cursor and obj of a STAT line', () => {
    const runs = refRuns(STAT, 'stat')
    expect(refs(runs)).toEqual(['cursor:139745604251096=#139745604251096', 'obj:108611=obj=108611'])
    expect(join(runs)).toBe(STAT)
  })
  it('links the cursor and the 13 characters of the sqlid of a PARSING IN CURSOR line', () => {
    const runs = refRuns(PARSING, 'parsing-in-cursor')
    expect(refs(runs)).toEqual(['cursor:139745605242584=#139745605242584', 'sqlid:1h7h96h7gnvbj=1h7h96h7gnvbj'])
    expect(join(runs)).toBe(PARSING)
    expect(runs[runs.length - 1]).toEqual({ text: "'" })
  })
  it('links the cursor of BINDS and ERROR lines', () => {
    expect(refs(refRuns(BINDS, 'binds'))).toEqual(['cursor:139745604248120=#139745604248120'])
    expect(refs(refRuns(ERR, 'error'))).toEqual(['cursor:140396176538616=#140396176538616'])
  })
  it('finds nothing on a line without references', () => {
    expect(refRuns(LOB, 'lob')).toEqual([{ text: LOB }])
    expect(refRuns('select 1 from #1 dual', 'sql-text')).toEqual([{ text: 'select 1 from #1 dual' }])
    expect(refRuns('', 'blank')).toEqual([])
  })
})

describe('mergeHits', () => {
  it('returns the runs when there are no matches', () => {
    const runs = refRuns(EXEC, 'call')
    expect(mergeHits(runs, [])).toBe(runs)
  })
  it('marks a hit inside a plain run', () => {
    const runs = mergeHits(refRuns(EXEC, 'call'), matchSpans(EXEC, 'EXEC', false, true))
    expect(runs[0]).toEqual({ text: 'EXEC', hit: true })
    expect(runs[1]).toEqual({ text: ' ' })
    expect(refs(runs)).toEqual(['cursor:140124363561040=#140124363561040'])
    expect(join(runs)).toBe(EXEC)
  })
  it('splits a reference run around a hit inside it and keeps its ref on every piece', () => {
    const runs = mergeHits(refRuns(EXEC, 'call'), matchSpans(EXEC, '4012436', false, true))
    const pieces = runs.filter((r) => r.ref)
    expect(pieces).toEqual([
      { text: '#1', ref: { kind: 'cursor', value: '140124363561040' } },
      { text: '4012436', ref: { kind: 'cursor', value: '140124363561040' }, hit: true },
      { text: '3561040', ref: { kind: 'cursor', value: '140124363561040' } },
    ])
    expect(join(runs)).toBe(EXEC)
  })
  it('splits a hit that straddles a plain run and a reference', () => {
    const runs = mergeHits(refRuns(EXEC, 'call'), matchSpans(EXEC, 'EXEC #1401', false, true))
    expect(runs[0]).toEqual({ text: 'EXEC ', hit: true })
    expect(runs[1]).toEqual({ text: '#1401', ref: { kind: 'cursor', value: '140124363561040' }, hit: true })
    expect(runs[2]).toEqual({ text: '24363561040', ref: { kind: 'cursor', value: '140124363561040' } })
    expect(join(runs)).toBe(EXEC)
  })
  it('handles several matches over several runs', () => {
    const spans = matchSpans(FETCH, 'plh=', false, true).concat(matchSpans(FETCH, 'c=', false, true))
    spans.sort((a, b) => a[0] - b[0])
    const runs = mergeHits(refRuns(FETCH, 'call'), spans)
    expect(join(runs)).toBe(FETCH)
    expect(runs.filter((r) => r.hit).map((r) => r.text)).toEqual(['c=', 'plh='])
  })
})
