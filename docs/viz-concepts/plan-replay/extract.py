# Pull the first execution of a statement out of a 10046 trace, with its plan (STAT), calls and waits.
# PX: pass the slave traces after the coordinator's; their cursor for the same sql_id is read on the
# coordinator's clock (same host, same tim base).
#   python3 extract2.py LABEL SQLID QC_TRACE [SLAVE_TRACE ...]
import json, re, sys

label, sqlid, main, slaves = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
num = lambda k, s: int(re.search(k + r'=(-?\d+)', s).group(1))


def stat_line(l):
    m = re.match(r"STAT \S+ id=(\d+) cnt=(\d+) pid=(\d+) pos=\d+ obj=(\d+) op='(.*)'", l)
    op = m.group(5)
    inner = re.search(r'\((cr=.*)\)$', op).group(1)
    name = op[:op.rfind('(')].strip()
    g = lambda k: (int(x.group(1)) if (x := re.search(k + r'=(\d+)', inner)) else None)
    return dict(id=int(m.group(1)), pid=int(m.group(3)), cnt=int(m.group(2)), obj=int(m.group(4)), op=name,
                cr=g('cr'), pr=g('pr'), pw=g('pw'), str=g('str'), time=g('time'), card=g('card'), cost=g('cost'))


def read_proc(path, t0=None):
    L = open(path, errors='replace').read().split('\n')
    start = next(i for i, l in enumerate(L) if l.startswith('PARSING IN CURSOR') and f"sqlid='{sqlid}'" in l)
    cur = re.match(r'PARSING IN CURSOR (#\d+)', L[start]).group(1)
    i = start + 1
    sql = []
    while L[i] != 'END OF STMT':
        sql.append(L[i]); i += 1
    calls, waits, stats, events, pending = [], [], [], [], []
    execs = 0
    for l in L[i:]:
        if l.startswith('PARSING IN CURSOR ' + cur + ' '):
            break
        if l.startswith('STAT ' + cur + ' '):
            s = stat_line(l)
            if s['id'] == 1 and stats:
                break
            stats.append(s)
            continue
        if stats and not l.startswith('STAT'):
            if l.startswith(('EXEC ' + cur, 'FETCH ' + cur, 'PARSE ' + cur, 'WAIT ' + cur)):
                break
        if execs > 1:
            continue
        if l.startswith('WAIT ' + cur + ':'):
            nam = re.search(r"nam='([^']*)'", l).group(1)
            if nam not in events: events.append(nam)
            ela, tim = int(re.search(r'ela= (\d+)', l).group(1)), num('tim', l)
            f = re.search(r'(?:file number|file#)=(\d+) (?:first dba|block#)=(\d+) (?:block cnt|blocks)=(\d+)', l)
            fl, dba, cnt = (int(f.group(1)), int(f.group(2)), int(f.group(3))) if f else (0, 0, 0)
            if not f and (pb := re.search(r' blocks=(\d+)', l)):   # db file parallel read: blocks, no address
                cnt = int(pb.group(1))
            obj = num('obj#', l)
            pending.append([events.index(nam), tim, ela, obj, fl, dba, cnt])
            continue
        for kind in ('EXEC', 'FETCH', 'CLOSE'):
            if l.startswith(kind + ' ' + cur + ':'):
                tim, e = num('tim', l), num('e', l)
                if kind == 'EXEC':
                    execs += 1
                    if execs > 1:
                        break
                    if t0 is None:
                        t0 = tim - e
                    # waits written before the EXEC that fall inside it belong to it
                    pending = [w for w in pending if w[1] > tim - e - 1]
                if execs == 0:
                    break
                calls.append([kind[0], tim - t0, e, num('c', l), num(',r', l) if kind != 'CLOSE' else 0,
                              num('cr', l) if kind != 'CLOSE' else 0, num(',p', l) if kind != 'CLOSE' else 0])
        if execs == 1:
            for w in pending:
                waits += [w[0], w[1] - t0] + w[2:]
            pending = []
    return dict(sql=' '.join(x.strip() for x in sql), calls=calls, events=events, waits=waits, plan=stats), t0


qc, t0 = read_proc(main)
procs = [dict(name='QC' if slaves else 'server', calls=qc['calls'], events=qc['events'], waits=qc['waits'])]
objs = {}
for s in qc['plan']:
    if s['obj']: objs[s['obj']] = s['op'].split()[-1]
for path in slaves:
    p, _ = read_proc(path, t0)
    name = re.search(r'_(p\d{3})', path)
    procs.append(dict(name=name.group(1) if name else path.split('/')[-1], calls=p['calls'], events=p['events'],
                      waits=p['waits'], plan=p['plan']))
    for s in p['plan']:
        if s['obj']: objs[s['obj']] = s['op'].split()[-1]
json.dump(dict(label=label, sqlid=sqlid, sql=qc['sql'], plan=qc['plan'], objs=objs, procs=procs),
          sys.stdout, separators=(',', ':'))
