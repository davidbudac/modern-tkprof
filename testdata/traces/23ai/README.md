# Oracle 23ai SQL trace (event 10046) fixtures

Real traces from `gvenzl/oracle-free:23-slim` in docker, pulled 2026-10-24: **Oracle AI Database
26ai Free** Release 23.0 (the 23ai line, now marketed as 26ai), version **23.26.3.0.0** (build label
`RDBMS_23.26.3.0.0DBRU_LINUX.X64_260704`), CDB `FREE` with PDB `FREEPDB1` (con_id 3, service
`freepdb1`), trace directory `/opt/oracle/diag/rdbms/free/FREE/trace`, host kernel 7.0.0-34.
`tkprof` prints `TKPROF: Release 23.0.0.0.0`.

Generator: `testdata/gen/run_gen_docker.sh <container> 23ai` (copies `testdata/gen/*.sql` into the
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
- Banner `Oracle AI Database 26ai Free Release 23.26.3.0.0 - Develop, Learn, and Run for Free`
  (19c/21c: `Oracle Database ...`).
- The pid line became a block: `Unix process pid:       1756`, `NID:`, `created:   2026-10-24T10:35:56.9600-7358+00:00`
  (the zone offset is garbage), `image:     oracle@7fba242c68f1`; plus `Oracle binary inode:` and `CLID:`.
- `*** CLIENT IP:` and `*** CONNECTION ID:` markers (as in 21c).
- STAT lines carry `dr=0 dw=0` (direct reads / writes) between `time=... ` and `us`.
- Bind lines for datatypes kxsbndinf cannot print (TIMESTAMP, TSTZ, INTERVAL ...) are
  ` value=Unhandled datatype (-73) found in kxsbndinf` with **one** leading space (19c/21c: two).
- New `WAIT` events for memory growth: `Allocate UGA|PGA|CGA|DGA memory from OS` (`Bytes=65536 where=1`),
  `Free private memory to OS`, `sequence cache replenishment`, `SQL*Net vector data to client`.
- `trcsess` copies the block-form header, so the process switch marker is
  `*** Unix process pid:       2013` (no brackets).
- `multisession_a.trc` is large (388 KB) because the first run after startup hard-parsed a lot of
  recursive SQL; it is kept as is.
- `midtrace_start.trc`: the cursor text of `BEGIN mtk_p_cached(:c, :n); END;` is re-dumped in the
  continuation file (`PARSING IN CURSOR` present), unlike 19c, yet tkprof still disagrees with
  the arithmetic of the trace (2 query for 3 executes); see the note in `internal/golden`.
