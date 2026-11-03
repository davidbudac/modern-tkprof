#!/usr/bin/env python3 -I
"""Builds data.json for template.html from an `mtkprof export` of testdata/traces/19c/io_waits.trc.

    mtkprof export -o /tmp/io_waits.csv testdata/traces/19c/io_waits.trc
    python3 -I docs/viz-concepts/extract.py /tmp/io_waits.csv docs/viz-concepts/data.json
    node docs/viz-concepts/build.mjs        # expects data.json and template.html next to it

The statement labels and file names are specific to that fixture.
"""
import collections, csv, json, os, sys

src, out = sys.argv[1], sys.argv[2]
rd = lambda name: list(csv.DictReader(open(os.path.join(src, name))))
ws, cs, pl, ctx = rd('waits.csv'), rd('calls.csv'), rd('plan_lines.csv'), rd('contexts.csv')
st = {r['statement_id']: r for r in rd('statements.csv')}
t0 = min(int(r['tim']) for r in cs + ws)
ms = lambda tim: round((int(tim) - t0) / 1000, 3)

labels = {'6': 'full scan ORDERS (count/sum)', '9': 'full scan CUST', '10': 'full scan ORDERS status=PAID',
          '13': 'index range ORDERS cust_id=:cid', '15': 'index range ORDERS cust_id 100..400', '17': 'PL/SQL block: 2 × 300 lookups',
          '18': 'SELECT amount FROM CUST WHERE id=:B1', '19': 'SELECT amount FROM ORDERS WHERE id=:B1',
          '21': 'ORDER BY over ORDERS (sort spill)', '22': 'HASH JOIN CUST⋈ORDERS (hash spill)',
          '7': 'recursive: exp_head$ lookup (QOSD)', '8': 'recursive: insert exp_head$ (QOSD)',
          '1': 'alter session _serial_direct_read', '2': 'alter session workarea_size_policy', '3': 'alter session sort_area_size',
          '4': 'alter session hash_area_size', '5': 'set_action full_scan', '11': 'set_action index_range', '12': ':cid := 17',
          '14': ':cid := 4242', '16': 'set_action single_row', '20': 'set_action sort_spill', '23': 'trace off',
          '0': '(cursor opened before trace)'}
statements = {k: {'sql_id': r['sql_id'], 'label': labels.get(k, r['sql_text'][:40]), 'text': r['sql_text'], 'depth': int(r['min_depth'])}
              for k, r in st.items()}

phases = []
for c in ctx:
    first = [r for r in cs if r['context_id'] == c['context_id']]
    if first:
        phases.append({'action': c['action'], 't_ms': ms(first[0]['tim']), 'call_index': None})

# block map: every physical I/O wait with a block address, in trace order
evcode = {'direct path read': 0, 'db file sequential read': 1, 'direct path write temp': 2, 'direct path read temp': 3}
pts, ext = [], collections.defaultdict(set)
for r in ws:
    if r['event'] in evcode:
        pts.append([ms(r['tim']), evcode[r['event']], int(r['p1']), int(r['p2']), int(r['p3']), int(r['statement_id']), int(r['ela_us']), int(r['obj'])])
        if r['event'] == 'direct path read':
            ext[int(r['obj'])].add((int(r['p2']), int(r['p3'])))
files = collections.defaultdict(lambda: [10 ** 12, 0, 0])
for p in pts:
    f = files[p[2]]; f[0] = min(f[0], p[3]); f[1] = max(f[1], p[3] + p[4]); f[2] += 1
file_names = {12: 'datafile 12 (USERS): MTK_ORDERS, MTK_CUST', 203: 'tempfile 203 (TEMP)', 10: 'datafile 10 (SYSAUX/SYSTEM): exp_head$'}
names = {108609: 'MTK_CUST', 108611: 'MTK_ORDERS', 721: 'exp_head$ (SYS)'}
per = collections.defaultdict(collections.Counter)
for p in pts:
    per[p[5]][{v: k for k, v in evcode.items()}[p[1]]] += 1
blockmap = {'events': {v: k for k, v in evcode.items()},
            'files': [{'file': k, 'lo': v[0], 'hi': v[1], 'n': v[2], 'name': file_names.get(k, 'file %d' % k)} for k, v in sorted(files.items())],
            'points': pts,
            'objects': [{'obj': o, 'name': names.get(o, str(o)), 'file': 12, 'extents': sorted(s)} for o, s in ext.items()],
            'point_fields': ['t_ms', 'event_code', 'file', 'first_block', 'block_count', 'statement_id', 'ela_us', 'obj'],
            'object_names': names,
            'per_statement': {k: dict(v) for k, v in per.items()}}

def plan(sid):
    seen, outl = set(), []
    for r in pl:
        if r['statement_id'] == sid and r['id'] not in seen:
            seen.add(r['id'])
            outl.append({k: (int(r[k]) if k in ('id', 'parent_id', 'depth', 'rows', 'starts', 'cr', 'pr', 'pw', 'time_us', 'cost', 'card') else r[k])
                         for k in ('id', 'parent_id', 'depth', 'operation', 'object_name', 'rows', 'starts', 'cr', 'pr', 'pw', 'time_us', 'cost', 'card')})
    return outl
sankey = {'22': plan('22'), '21': plan('21'), '15': plan('15'), '6': plan('6')}

seq, kinds = [], {'EXEC': 0, 'FETCH': 1}
for r in cs:
    if r['kind'] in kinds:
        seq.append([int(r['statement_id']), kinds[r['kind']], ms(r['tim']), int(r['depth']), int(r['rows'])])
for p in phases:
    p['seq_index'] = next((i for i, s in enumerate(seq) if s[2] >= p['t_ms']), len(seq))

wbycall = collections.defaultdict(lambda: collections.defaultdict(lambda: [0, 0]))
for r in ws:
    e = wbycall[r['call_id']][r['event']]; e[0] += 1; e[1] += int(r['ela_us'])
def calls_of(sid):
    return [{'kind': r['kind'], 'rows': int(r['rows']), 'ela_us': int(r['ela_us']), 'cpu_us': int(r['cpu_us']), 't_ms': ms(r['tim']),
             'waits': {k: v for k, v in wbycall[r['call_id']].items()}} for r in cs if r['statement_id'] == sid]
seqdiag = {'21': calls_of('21'), '15': calls_of('15'), '13': calls_of('13')}

fp = {}
for r in cs:
    d = fp.setdefault(r['statement_id'], collections.Counter())
    d['calls'] += 1; d[r['kind'].lower() + 's'] += 1; d['rows'] += int(r['rows']); d['cpu_us'] += int(r['self_cpu_us'])
    d['ela_us'] += int(r['self_ela_us']); d['disk'] += int(r['self_disk']); d['query'] += int(r['self_query']); d['misses'] += int(r['misses'])
for r in ws:
    d = fp.setdefault(r['statement_id'], collections.Counter())
    if r['between_calls'] == '1':
        d['between_us'] += int(r['ela_us']); continue
    d[{'User I/O': 'io_us', 'Network': 'net_us', 'Application': 'app_us', 'Other': 'other_us', 'Idle': 'idle_in_call_us'}.get(r['wait_class'], 'other_us')] += int(r['ela_us'])
fingerprints = []
for s, d in fp.items():
    if d['execs'] == 0:
        continue
    acc = d['cpu_us'] + d['io_us'] + d['net_us'] + d['app_us'] + d['other_us'] + d['idle_in_call_us']
    fingerprints.append({'id': int(s), 'label': statements[s]['label'], 'sql_id': statements[s]['sql_id'], 'depth': statements[s]['depth'],
                         'execs': d['execs'], 'fetches': d['fetchs'], 'parses': d['parses'], 'misses': d['misses'], 'rows': d['rows'], 'ela_us': d['ela_us'],
                         'cpu_us': d['cpu_us'], 'io_us': d['io_us'], 'net_us': d['net_us'], 'app_us': d['app_us'], 'other_us': d['other_us'],
                         'unaccounted_us': max(0, d['ela_us'] - acc), 'between_calls_idle_us': d['between_us'], 'disk': d['disk'], 'query': d['query']})
fingerprints.sort(key=lambda f: -f['ela_us'])

data = {'meta': {'trace': 'testdata/traces/19c/io_waits.trc',
                 'db': 'Oracle 19c, event 10046 level 12, serial direct reads forced, 64 KB sort area, 128 KB hash area',
                 'span_ms': ms(max(int(r['tim']) for r in cs + ws))},
        'statements': statements, 'phases': phases, 'blockmap': blockmap, 'sankey': sankey,
        'dotplot': {'seq': seq, 'kinds': ['EXEC', 'FETCH']}, 'seqdiag': seqdiag, 'fingerprints': fingerprints}
json.dump(data, open(out, 'w'), separators=(',', ':'))
print('wrote', out, os.path.getsize(out), 'bytes;', len(pts), 'block I/O waits;', len(seq), 'calls')
