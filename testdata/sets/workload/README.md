# workload: a directory test set

One run of `testdata/gen/run_gen.sh workload` on the dbmint lab (Oracle 19.27,
2026-10-25): four concurrent SQL*Plus sessions traced at level 12, copied out
of the ADR trace directory under their original names (21 files, 540 KB).
Open the directory as one trace set (`mtkprof serve testdata/sets/workload`,
or "Open folder…" in the desktop app) to exercise the Files panel, per-file
selection, chains and PX attachment.

| session (`tracefile_identifier`) | what it does | files |
|---|---|---|
| `mtk_wl_orders` | OLTP loop: 25 × lookup by bind, insert/update/commit, 0.15 s think time; small-array fetch of a join; cleanup delete | `cdb1_ora_22604_mtk_wl_orders.trc` |
| `mtk_wl_report` | three `parallel(4)` queries and one serial top-N | `cdb1_ora_22610_mtk_wl_report.trc` (coordinator) + 8 PX slaves `cdb1_p00N_<pid>_mtk_wl_report.trc`, each continued from a stub `cdb1_p00N_<pid>.trc` written before the slave picked up the identifier (`TRACE CONTINUES IN FILE`) |
| `mtk_wl_batch` | PL/SQL with recursive SQL (`mtk_p_cached`, `mtk_f`), `dbms_session.sleep` inside the call, an audit insert that fails with ORA-00904; the identifier is switched half way, so the trace continues in `_2` | `cdb1_ora_22608_mtk_wl_batch.trc` → `cdb1_ora_22608_mtk_wl_batch_2.trc` |
| `mtk_wl_admin` | ORA-00942 and a divide-by-zero fetch error, 20 literal statements (hard parses), the same query before and after `optimizer_index_cost_adj` (plan change) | `cdb1_ora_22606_mtk_wl_admin.trc` |

Notes: the PX slave processes were started hours before the run, so their
stub files make the set's "files disagree on the tim clock" note appear; the
slaves still attach to the coordinator (26 of 28 PX contexts). The scripts are
`testdata/gen/sc_wl_*.sql`.
