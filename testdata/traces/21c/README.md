# Oracle 21c SQL trace (event 10046) fixtures

Real traces from `gvenzl/oracle-xe:21-slim` in docker: Oracle Database 21c **Express Edition**
Release 21.0.0.0.0, version **21.3.0.0.0** (build label `RDBMS_21.3.0.0.0_LINUX.X64_210727.XE`,
which is XE's 21.3 base release, no RU), CDB `XE` with PDB `XEPDB1` (con_id 3, service
`xepdb1`), trace directory `/opt/oracle/diag/rdbms/xe/XE/trace`, host kernel 7.0.0-34.

Generator: `testdata/gen/run_gen_docker.sh <container> 21c` (copies `testdata/gen/*.sql` into the
container, runs them as schema `MTK` in the PDB, runs the container's own `tkprof`; the dbmint
generator `run_gen.sh` is not used here). Scenarios, prologue and identifiers are the same as for
19c (see `../19c/README.md` for what each scenario contains); the `.trc` files are byte-exact
copies and each has `<name>.tkprof.txt` / `<name>.tkprof-noagg.txt` (`sys=yes waits=yes
aggregate=yes|no sort=prsela,exeela,fchela`). Sessions connect through the listener
(`*** CLIENT DRIVER:(SQL*PLUS)`), `NLS_LANG=AMERICAN_AMERICA.AL32UTF8`.

Not generated: `big_loop` (too big to commit), `parallel` / `parallel_slave` (this edition runs the
hinted statements serially: `v$pq_sesstat` shows `Queries Parallelized = 0`, no PX slave trace
and no `PX Deq` waits, so the trace would only repeat a plain serial trace). The merged
`multisession.trc` was produced with `trcsess` from the full `database/free` image's
`trcsess.jar` run on the host (the slim images ship no JDK and no `trcsess.jar`).

The traces come from freshly started databases, so the first scenarios include more recursive
dictionary SQL (cold dictionary cache); sizes and statement counts differ from the 19c set.

## Differences from 19c seen in these files
Only the ones that touch the parser; the full list is in `docs/trace-format-19c.md`
("21c / 23ai differences").
- Pid header line: `Unix process pid: 759, NID: 4026532333, image: oracle@89f544161580`.
- Two more markers after `*** CONTAINER ID`: `*** CLIENT IP:(127.0.0.1)` and
  `*** CONNECTION ID:(XpTCBiyDAvXgYwIAEazlbg==)`.
- `SQL*Net vector data to client` replaces `SQL*Net more data to client` for large result sets.
- STAT lines are the same as 19c (no `dr=`/`dw=`).
- XE has no parallel execution (see above) and its header has no `Database name`/`Database id` lines.
