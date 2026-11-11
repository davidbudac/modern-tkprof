# 10053 fixtures

| Directory | Source | Oracle | Licence |
|---|---|---|---|
| `19c/` | generated on the dbmint lab by `testdata/gen/sc_opt_*.sql` | 19.27 | this repository |
| `11g/antognini_*`, `12c/antognini_*` (**not in git**, see below) | [Apress/troubleshooting-oracle-perf-14](https://github.com/Apress/troubleshooting-oracle-perf-14) `chapter06/` @ `e539ba1` (Christian Antognini, *Troubleshooting Oracle Performance*, 2nd ed.): one query transformation per file | 11.2.0.3; `join_predicate_push_down` 12.1.0.1 | freeware, no commercial use or redistribution |
| `11g/oraex_direct_path_*` | [oracle-samples/oracle-db-examples](https://github.com/oracle-samples/oracle-db-examples) `optimizer/direct_path/11g/` @ `f1b90ba`: `LOAD AS SELECT` | 11.2.0.4 | Apache 2.0: `LICENSES/oracle-db-examples.txt` |
| `12c/denglt_*` | [denglt/oracleMonitor](https://github.com/denglt/oracleMonitor) `scriptlog/` @ `6e64201` (CRLF line ends) | 12.1.0.2 | none stated |
| `interleaved/19c/ggordham_*` | [ggordham/ora-presentations](https://github.com/ggordham/ora-presentations) `indepth-sql-MOUG/`, `sql-profiles-SLC/` @ `b3cae86`: 10046 and 10053 in one file; stats, no stats, dynamic sampling, histogram, SQL profile | 19.6 | GPL-3.0: `LICENSES/ggordham-GPL-3.0.txt` |

Files are unchanged apart from the source prefix in the name.

The Antognini traces are gitignored: their licence forbids commercial use and redistribution, so they stay on the
machine that fetched them. To get them (the tests pick them up when present):

```sh
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/Apress/troubleshooting-oracle-perf-14 /tmp/ap
git -C /tmp/ap sparse-checkout set --no-cone '/chapter06/*.trc' '/LICENSE.txt'
for f in /tmp/ap/chapter06/*.trc; do
  d=11g; grep -q 'Release 12\.' "$f" && d=12c
  cp "$f" "testdata/opt/$d/antognini_$(basename "$f")"
done
cp /tmp/ap/LICENSE.txt testdata/opt/LICENSES/antognini.txt
```

`internal/trace` tests glob `opt/*/*.trc` and require a pure 10053 file with no unknown line, so the interleaved
files sit one level deeper and are not in those tests. `ggordham_t1db_ora_29360_no_profile.trc` has 43 unknown lines
after the trace events are switched off: `status=(pst=…)` lines and `Execution Statistics` blocks.
