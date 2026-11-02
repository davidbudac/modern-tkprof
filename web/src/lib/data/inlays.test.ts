import { describe, expect, it } from 'vitest'
import type { BindAt } from './bindat'
import type { BindRow } from './derive'
import { inlaysOf } from './inlays'
import type { DecodeContext } from './linefields'

const EXEC = 'EXEC #140646291810920:c=832,e=825,p=0,cr=0,cu=0,mis=1,r=0,dep=1,og=1,plh=3937172027,tim=54958079261'
const EXEC_BIG = 'EXEC #1:c=832,e=12345,p=0,cr=0,cu=0,mis=1,r=0,dep=1,og=1,plh=3937172027,tim=54958079261'
const WAIT = "WAIT #140124363549808: nam='db file sequential read' ela= 2500 file#=10 block#=66151 blocks=1 obj#=721 tim=10778995443"
const STAT = "STAT #140124363549808 id=1 cnt=0 pid=0 pos=1 obj=720 op='TABLE ACCESS BY INDEX ROWID EXP_HEAD$ (cr=2 pr=0 pw=0 str=1 time=29 us cost=2 size=68 card=1)'"
const XCTEND = 'XCTEND rlbk=0, rd_only=1, tim=10817777368'

const row = (o: Partial<BindRow>): BindRow => ({ pos: 0, type: 'NUMBER', value: '', isNull: false, noDef: false, dump: false, mal: 0, ...o })
const at = (bind: BindRow | undefined, dty?: number): BindAt => ({ set: 0, header: false, pos: 0, bind, dty, binds: bind ? [bind] : [], cursor: 0, stmt: 0 })
const ctx: DecodeContext = {
  objectName: (o) => (o === 721 ? 'SYS.I_OBJ1' : o === 720 ? 'SYS.OBJ$' : undefined),
  clock: (t) => `12:00:${t % 100}`,
}
const cut = (text: string, i: { at: number; text: string }) => text.slice(0, i.at) + '|' + i.text + '|' + text.slice(i.at)

describe('inlaysOf', () => {
  it('annotates a call with its duration and clock, each over the raw number it reads', () => {
    expect(inlaysOf(EXEC, 'call', 1, ctx).map((x) => [x.kind, x.text, EXEC.slice(x.from, x.at)])).toEqual([['dur', '825 µs', '825'], ['clock', '12:00:61', '54958079261']])
    const r = inlaysOf(EXEC_BIG, 'call', 1, ctx)
    expect(r.map((x) => [x.kind, x.text])).toEqual([['dur', '12.3 ms'], ['clock', '12:00:61']])
    expect(cut(EXEC_BIG, r[0])).toContain('e=12345|12.3 ms|,p=0')
  })
  it('annotates a wait with duration, object and clock in text order', () => {
    const r = inlaysOf(WAIT, 'wait', 1, ctx)
    expect(r.map((x) => [x.kind, x.text])).toEqual([['dur', '2.50 ms'], ['obj', 'SYS.I_OBJ1'], ['clock', '12:00:43']])
    expect(cut(WAIT, r[0])).toContain("ela= 2500|2.50 ms| file#=10")
    expect(cut(WAIT, r[1])).toContain('obj#=721|SYS.I_OBJ1| tim=')
    expect(r.map((x) => WAIT.slice(x.from, x.at))).toEqual(['2500', '721', '10778995443'])
  })
  it('skips unknown objects, obj#=-1 and missing context', () => {
    expect(inlaysOf(WAIT.replace('obj#=721', 'obj#=-1'), 'wait', 1, ctx).map((x) => x.kind)).toEqual(['dur', 'clock'])
    expect(inlaysOf(WAIT.replace('obj#=721', 'obj#=5'), 'wait', 1, ctx).map((x) => x.kind)).toEqual(['dur', 'clock'])
    expect(inlaysOf(WAIT, 'wait', 1, {}).map((x) => x.kind)).toEqual(['dur'])
    expect(inlaysOf(EXEC, 'call', 1, {}).map((x) => x.kind)).toEqual(['dur'])
  })
  it('annotates the object of a STAT line', () => {
    const r = inlaysOf(STAT, 'stat', 1, ctx)
    expect(r).toHaveLength(1)
    expect(cut(STAT, r[0])).toContain('obj=720|SYS.OBJ$| op=')
    expect(inlaysOf(STAT.replace('obj=720', 'obj=0'), 'stat', 1, ctx)).toEqual([])
  })
  it('annotates the clock of XCTEND', () => {
    expect(inlaysOf(XCTEND, 'xctend', 1, ctx)).toEqual([{ from: XCTEND.length - 11, at: XCTEND.length, text: '12:00:68', kind: 'clock' }])
  })
  it('appends the value and type of a Bind# line', () => {
    const t = ' Bind#0'
    const c = (b: BindRow | undefined, dty?: number): DecodeContext => ({ bindAt: () => at(b, dty) })
    expect(inlaysOf(t, 'bind-line', 4, c(row({ value: '42' })))).toEqual([{ at: t.length, text: '= 42 NUMBER', kind: 'bind' }])
    expect(inlaysOf(t, 'bind-line', 4, c(row({ type: 'TIMESTAMP', value: '2024-02-29 13:14:15', typed: '2024-02-29T13:14:15' })))[0].text).toBe('= 2024-02-29T13:14:15 TIMESTAMP')
    expect(inlaysOf(t, 'bind-line', 4, c(row({ isNull: true, value: 'x' })))[0].text).toBe('= NULL NUMBER')
    expect(inlaysOf(t, 'bind-line', 4, c(row({ noDef: true })))[0].text).toBe('= (no value) NUMBER')
    expect(inlaysOf(t, 'bind-line', 4, c(row({ dump: true, value: 'junk' })))[0].text).toBe('= (no value) NUMBER')
    expect(inlaysOf(t, 'bind-line', 4, c(row({ type: '', value: '7' }), 2))[0].text).toBe('= 7 NUMBER')
    expect(inlaysOf(t, 'bind-line', 4, c(row({ type: '', value: '7' })))[0].text).toBe('= 7')
  })
  it('has no bind hint without a bind or on other bind lines', () => {
    expect(inlaysOf(' Bind#0', 'bind-line', 4, {})).toEqual([])
    expect(inlaysOf(' Bind#0', 'bind-line', 4, { bindAt: () => at(undefined) })).toEqual([])
    expect(inlaysOf('  value=1', 'bind-line', 4, { bindAt: () => at(row({ value: '1' })) })).toEqual([])
  })
  it('names the oacdty of a bind attribute line', () => {
    const t = '  oacdty=180 mxl=11(11) mxlc=00 mal=00 scl=00 pre=00'
    const r = inlaysOf(t, 'bind-line', 5, {})
    expect(r).toEqual([{ from: '  oacdty='.length, at: '  oacdty=180'.length, text: 'TIMESTAMP', kind: 'type' }])
    expect(inlaysOf('  oacdty=02 mxl=22(22)', 'bind-line', 5, {})[0].text).toBe('NUMBER')
    expect(inlaysOf('  oacdty=999 mxl=22(22)', 'bind-line', 5, {})).toEqual([])
  })
  it('puts the gap first, only when positive', () => {
    const r = inlaysOf(EXEC, 'call', 1, ctx, 2_500_000)
    expect(r[0]).toEqual({ at: 0, text: 'gap 2.500 s', kind: 'gap' })
    expect(r.map((x) => x.kind)).toEqual(['gap', 'dur', 'clock'])
    expect(inlaysOf(EXEC, 'call', 1, ctx, 0).map((x) => x.kind)).toEqual(['dur', 'clock'])
    expect(inlaysOf(EXEC, 'call', 1, ctx, -5).map((x) => x.kind)).toEqual(['dur', 'clock'])
  })
  it('returns nothing for kinds without hints', () => {
    for (const k of ['blank', 'header', 'separator', 'sql-text', 'unknown', 'marker', 'binds'] as const) {
      expect(inlaysOf('select tim=1 obj#=2 ela= 5000 e=5000', k, 1, ctx, 100)).toEqual([])
    }
  })
  it('returns the inlays sorted by position', () => {
    for (const [t, k] of [[EXEC_BIG, 'call'], [WAIT, 'wait'], [STAT, 'stat']] as const) {
      const r = inlaysOf(t, k, 1, ctx, 9)
      expect(r.map((x) => x.at)).toEqual([...r.map((x) => x.at)].sort((a, b) => a - b))
    }
  })
})
