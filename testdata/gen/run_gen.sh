#!/usr/bin/env bash
# Generates the 10046 trace fixtures for modern-tkprof inside the dbmint VM (oracle OS user).
#
#   ./run_gen.sh                 -> setup user, schema, every scenario, reference CSVs, big loop
#   ./run_gen.sh errors lobs     -> only those scenarios (schema setup still runs; it is idempotent)
#   ./run_gen.sh big             -> only the big loop  (BIG_ITER=120000 by default, ~990 bytes of trace per iteration)
#
# Env: MTK_PASSWORD (default mtk), MTK_SERVICE (default //localhost:1521/pdb1.world),
#      ORACLE_SID (default cdb1), BIG_ITER (default 120000), OUT (default ./out)
# Safety: session-level parameters only; never drops/truncates/removes; only touches schema MTK.
set -u
cd "$(dirname "$0")" || exit 1
export ORACLE_SID=${ORACLE_SID:-cdb1}
export ORAENV_ASK=NO
. oraenv >/dev/null 2>&1
export NLS_LANG=AMERICAN_AMERICA.AL32UTF8
MTK_PASSWORD=${MTK_PASSWORD:-mtk}
MTK_SERVICE=${MTK_SERVICE:-//localhost:1521/pdb1.world}
BIG_ITER=${BIG_ITER:-120000}
OUT=${OUT:-$PWD/out}
CONN="mtk/${MTK_PASSWORD}@${MTK_SERVICE}"
mkdir -p "$OUT/log" "$OUT/ref"

ALL_SCENARIOS="basic_binds plsql_recursive errors io_waits lobs plan_stat_all level_4 level_8 level_1 truncated cursor_cache nasty_sql multisession parallel midtrace_start"
if [ $# -eq 0 ]; then
  TARGETS="$ALL_SCENARIOS ref big"
else
  TARGETS="$*"
fi

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

TRACE_DIR=$(sqlplus -S -L / as sysdba <<'SQL' | tr -d '[:space:]'
set heading off feedback off pagesize 0
select value from v$diag_info where name = 'Diag Trace';
exit
SQL
)
log "trace dir: $TRACE_DIR"

log "setup user MTK"
sqlplus -S -L / as sysdba @00_setup_user.sql "$MTK_PASSWORD" > "$OUT/log/00_setup_user.log" 2>&1 || log "WARN: setup user rc=$?"
grep -E '^ORA-|^SP2-' "$OUT/log/00_setup_user.log" | grep -v 'ORA-01920' && log "WARN: errors in setup user log"
log "schema MTK"
sqlplus -S -L "$CONN" @01_schema.sql > "$OUT/log/01_schema.log" 2>&1 || log "WARN: schema rc=$?"
grep -E '^ORA-|^SP2-' "$OUT/log/01_schema.log" && log "WARN: errors in schema log"

# run_scenario <name> [sqlplus args...] : runs sc_<name>.sql as MTK, then copies the trace
run_scenario() {
  local scn=$1; shift
  : > "$OUT/$scn.tracefile"      # truncate stale marker (no rm anywhere in this script)
  sqlplus -S -L "$CONN" "@sc_$scn.sql" "$@" > "$OUT/log/$scn.log" 2>&1
  collect "$scn"
}
collect() {
  local scn=$1
  local tf
  tf=$(tr -d '[:space:]' < "$OUT/$scn.tracefile" 2>/dev/null)
  if [ -z "$tf" ] || [ ! -f "$tf" ]; then
    log "ERROR: no trace file recorded for $scn (see $OUT/log/$scn.log)"; return 1
  fi
  cp -p "$tf" "$OUT/$scn.trc"
  log "$scn -> $(basename "$tf") ($(stat -c %s "$OUT/$scn.trc") bytes, $(wc -l < "$OUT/$scn.trc") lines)"
}
tkprof_both() {
  local scn=$1
  tkprof "$OUT/$scn.trc" "$OUT/$scn.tkprof.txt" sys=yes waits=yes aggregate=yes sort=prsela,exeela,fchela > /dev/null 2>&1 || log "WARN: tkprof $scn rc=$?"
  tkprof "$OUT/$scn.trc" "$OUT/$scn.tkprof-noagg.txt" sys=yes waits=yes aggregate=no sort=prsela,exeela,fchela > /dev/null 2>&1 || log "WARN: tkprof noagg $scn rc=$?"
}

for t in $TARGETS; do
  case "$t" in
    multisession)
      log "scenario multisession (two concurrent sessions)"
      : > "$OUT/multisession_a.tracefile"; : > "$OUT/multisession_b.tracefile"
      sqlplus -S -L "$CONN" @sc_multisession_a.sql > "$OUT/log/multisession_a.log" 2>&1 &
      sqlplus -S -L "$CONN" @sc_multisession_b.sql > "$OUT/log/multisession_b.log" 2>&1 &
      wait
      collect multisession_a; collect multisession_b
      trcsess output="$OUT/multisession.trc" service=pdb1 "$OUT/multisession_a.trc" "$OUT/multisession_b.trc" > "$OUT/log/trcsess.log" 2>&1 || log "WARN: trcsess rc=$?"
      log "multisession.trc merged ($(wc -l < "$OUT/multisession.trc") lines)"
      tkprof_both multisession; tkprof_both multisession_a; tkprof_both multisession_b
      ;;
    parallel)
      log "scenario parallel"
      touch "$OUT/.px_marker"; sleep 1
      run_scenario parallel
      slave=$(find "$TRACE_DIR" -maxdepth 1 -name "${ORACLE_SID}_p0*.trc" -newer "$OUT/.px_marker" | sort | head -1)
      if [ -n "$slave" ]; then
        cp -p "$slave" "$OUT/parallel_slave.trc"
        log "parallel slave trace: $(basename "$slave")"
        tkprof_both parallel_slave
      else
        log "WARN: no PX slave trace found"
      fi
      tkprof_both parallel
      ;;
    midtrace_start)
      log "scenario midtrace_start (two files: part1 + continuation)"
      : > "$OUT/midtrace_start_part1.tracefile"
      run_scenario midtrace_start && tkprof_both midtrace_start
      collect midtrace_start_part1 && tkprof_both midtrace_start_part1
      ;;
    big)
      log "big loop ($BIG_ITER iterations)"
      run_scenario big_loop "$BIG_ITER"
      ;;
    ref)
      log "reference dumps"
      sqlplus -S -L / as sysdba @ref_dump.sql > "$OUT/log/ref_dump.log" 2>&1 || log "WARN: ref dump rc=$?"
      ls -la "$OUT/ref"
      ;;
    *)
      log "scenario $t"
      run_scenario "$t" && tkprof_both "$t"
      ;;
  esac
done
log "done; outputs in $OUT"
