#!/usr/bin/env bash
# Generates the 10046 trace fixtures for modern-tkprof inside a gvenzl Oracle docker container
# (21c XE or 23ai Free) and copies them to testdata/traces/<version-dir>/.
#
#   ./run_gen_docker.sh mtk23 23ai            -> setup user, schema, every scenario
#   ./run_gen_docker.sh mtk21 21c errors lobs -> only those scenarios
#
# Container: docker run -d --name mtk23 -p 1523:1521 -e ORACLE_PASSWORD=mtk -e APP_USER=mtk \
#              -e APP_USER_PASSWORD=mtk gvenzl/oracle-free:23-slim      (wait for "DATABASE IS READY")
#            docker run -d --name mtk21 -p 1522:1521 ... gvenzl/oracle-xe:21-slim
# trcsess: the -slim images ship no JDK and no trcsess.jar, so the merge runs on the host:
#   TRCSESS_JAR=/path/trcsess.jar (from rdbms/jlib/ of the full container-registry.oracle.com/database/free
#   image; java must be on the host PATH). Without it the multisession merge is skipped.
# Env: MTK_PASSWORD (default mtk), PDB (default: autodetected, FREEPDB1 / XEPDB1),
#      OUT (default testdata/traces/<version-dir>), LOG (default /tmp/mtk-gen-<version-dir>). The dbmint variant is run_gen.sh (untouched).
# big_loop is not generated (too big to commit). Scenarios the edition cannot run (parallel on
# XE/Free) are skipped with a WARN; note them in the README of the version directory.
set -u
[ $# -ge 2 ] || { echo "usage: $0 <container> <version-dir> [scenario...]" >&2; exit 2; }
C=$1; VER=$2; shift 2
HERE=$(cd "$(dirname "$0")" && pwd)
OUT=${OUT:-$(cd "$HERE/.." && pwd)/traces/$VER}
MTK_PASSWORD=${MTK_PASSWORD:-mtk}
W=/tmp/gen
LOG=${LOG:-${TMPDIR:-/tmp}/mtk-gen-$VER}   # sqlplus logs, not committed
mkdir -p "$OUT" "$LOG"

ALL_SCENARIOS="basic_binds bind_types plsql_recursive errors io_waits lobs plan_stat_all level_4 level_8 level_1 truncated cursor_cache nasty_sql multisession parallel midtrace_start plan_change"
if [ $# -eq 0 ]; then TARGETS="$ALL_SCENARIOS"; else TARGETS="$*"; fi

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }
cx() { docker exec -i -w "$W" -e NLS_LANG=AMERICAN_AMERICA.AL32UTF8 "$C" "$@"; }

# copy the gen scripts in (docker cp creates root-owned files; the oracle user must write out/)
docker exec -u 0 "$C" rm -rf "$W"
docker cp "$HERE" "$C:$W" || exit 1
docker exec -u 0 "$C" bash -c "mkdir -p $W/out/log && chmod -R a+rwX $W"

SID=$(cx bash -c 'echo $ORACLE_SID')
PDB=${PDB:-$(cx sqlplus -S -L / as sysdba <<'SQL' | tr -d '[:space:]'
set heading off feedback off pagesize 0
select name from v$pdbs where name <> 'PDB$SEED' and rownum = 1;
exit
SQL
)}
SERVICE=//localhost:1521/$PDB
CONN="mtk/${MTK_PASSWORD}@${SERVICE}"
TRACE_DIR=$(cx sqlplus -S -L / as sysdba <<'SQL' | tr -d '[:space:]'
set heading off feedback off pagesize 0
select value from v$diag_info where name = 'Diag Trace';
exit
SQL
)
log "container $C sid=$SID pdb=$PDB trace dir: $TRACE_DIR"
cx sqlplus -S -L / as sysdba <<'SQL' > "$LOG/banner.txt" 2>&1
set heading off feedback off pagesize 0
select banner_full from v$version;
exit
SQL
cat "$LOG/banner.txt"

log "setup user MTK"
cx sqlplus -S -L / as sysdba @00_setup_user.sql "$MTK_PASSWORD" "$PDB" < /dev/null > "$LOG/00_setup_user.log" 2>&1 || log "WARN: setup user rc=$?"
grep -E '^ORA-|^SP2-' "$LOG/00_setup_user.log" | grep -v 'ORA-01920' && log "WARN: errors in setup user log"
log "schema MTK"
cx sqlplus -S -L "$CONN" @01_schema.sql < /dev/null > "$LOG/01_schema.log" 2>&1 || log "WARN: schema rc=$?"
grep -E '^ORA-|^SP2-' "$LOG/01_schema.log" && log "WARN: errors in schema log"

# collect <scn> [container-side trace path override]: copies out/<scn>.tracefile's trace and tkprofs it
collect() {
  local scn=$1 tf
  tf=$(cx bash -c "tr -d '[:space:]' < out/$scn.tracefile" 2>/dev/null)
  if [ -z "$tf" ] || ! docker exec "$C" test -f "$tf"; then
    log "ERROR: no trace file recorded for $scn"; return 1
  fi
  docker cp "$C:$tf" "$OUT/$scn.trc"
  log "$scn -> $(basename "$tf") ($(stat -c %s "$OUT/$scn.trc") bytes, $(wc -l < "$OUT/$scn.trc") lines)"
}
run_scenario() {
  local scn=$1; shift
  cx bash -c ": > out/$scn.tracefile; sqlplus -S -L '$CONN' @sc_$scn.sql $* < /dev/null" > "$LOG/$scn.log" 2>&1
  collect "$scn"
}
tkprof_both() {
  local scn=$1
  docker cp "$OUT/$scn.trc" "$C:$W/out/$scn.trc"
  docker exec -u 0 "$C" chmod a+rw "$W/out/$scn.trc"
  cx tkprof "out/$scn.trc" "out/$scn.tkprof.txt" sys=yes waits=yes aggregate=yes sort=prsela,exeela,fchela > /dev/null 2>&1 || log "WARN: tkprof $scn rc=$?"
  cx tkprof "out/$scn.trc" "out/$scn.tkprof-noagg.txt" sys=yes waits=yes aggregate=no sort=prsela,exeela,fchela > /dev/null 2>&1 || log "WARN: tkprof noagg $scn rc=$?"
  docker cp "$C:$W/out/$scn.tkprof.txt" "$OUT/$scn.tkprof.txt"
  docker cp "$C:$W/out/$scn.tkprof-noagg.txt" "$OUT/$scn.tkprof-noagg.txt"
}

for t in $TARGETS; do
  case "$t" in
    multisession)
      log "scenario multisession (two concurrent sessions)"
      cx bash -c ": > out/multisession_a.tracefile; : > out/multisession_b.tracefile"
      cx sqlplus -S -L "$CONN" @sc_multisession_a.sql < /dev/null > "$LOG/multisession_a.log" 2>&1 &
      cx sqlplus -S -L "$CONN" @sc_multisession_b.sql < /dev/null > "$LOG/multisession_b.log" 2>&1 &
      wait
      collect multisession_a; collect multisession_b
      if [ -n "${TRCSESS_JAR:-}" ]; then
        java -cp "$TRCSESS_JAR" oracle.ss.tools.trcsess.TrcSess output="$OUT/multisession.trc" service="$(echo "$PDB" | tr A-Z a-z)" \
          "$OUT/multisession_a.trc" "$OUT/multisession_b.trc" > "$LOG/trcsess.log" 2>&1 || log "WARN: trcsess rc=$?"
      else
        log "WARN: TRCSESS_JAR not set, no merged multisession.trc"
      fi
      [ -f "$OUT/multisession.trc" ] || { tkprof_both multisession_a; tkprof_both multisession_b; continue; }
      log "multisession.trc merged ($(wc -l < "$OUT/multisession.trc") lines)"
      tkprof_both multisession; tkprof_both multisession_a; tkprof_both multisession_b
      ;;
    parallel)
      log "scenario parallel"
      cx touch out/.px_marker; sleep 1
      run_scenario parallel
      # (no find in the XE image) first PX slave trace newer than the marker
      slave=$(cx bash -c "for f in $TRACE_DIR/${SID}_p0*.trc; do [ \"\$f\" -nt out/.px_marker ] && echo \"\$f\"; done" 2>/dev/null | sort | head -1)
      if [ -n "$slave" ]; then
        docker cp "$C:$slave" "$OUT/parallel_slave.trc"
        log "parallel slave trace: $(basename "$slave")"
        tkprof_both parallel_slave
        tkprof_both parallel
      else
        # XE and Free run the hinted statements serially (v$pq_sesstat: Queries Parallelized = 0):
        # the trace has no PX waits and no slave file, so it adds nothing over level_* / basic_binds
        log "WARN: no PX slave trace (edition without parallel execution): parallel scenario skipped"
        rm -f "$OUT"/parallel.trc
      fi
      ;;
    midtrace_start)
      log "scenario midtrace_start (two files: part1 + continuation)"
      cx bash -c ": > out/midtrace_start_part1.tracefile"
      run_scenario midtrace_start && tkprof_both midtrace_start
      collect midtrace_start_part1 && tkprof_both midtrace_start_part1
      ;;
    *)
      log "scenario $t"
      run_scenario "$t" && tkprof_both "$t"
      ;;
  esac
done
log "done; outputs in $OUT (logs in $LOG)"
