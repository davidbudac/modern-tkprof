#!/usr/bin/env bash
# Generates the 10046 trace fixtures for modern-tkprof inside the dbmint VM (oracle OS user).
#
#   ./run_gen.sh                 -> setup user, schema, every scenario, reference CSVs, big loop
#   ./run_gen.sh errors lobs     -> only those scenarios (schema setup still runs; it is idempotent)
#   ./run_gen.sh workload        -> four concurrent sessions into out/workload/ (a directory test set)
#   ./run_gen.sh big             -> only the big loop  (BIG_ITER=120000 by default, ~990 bytes of trace per iteration)
#   ./run_gen.sh opt             -> the 10053 (optimizer trace) scenarios: ten 10053-only traces (out/opt_*.trc, no
#                                   tkprof) and opt_interleaved (10046 + 10053, with tkprof); also in the default run.
#                                   Any of them by name too: ./run_gen.sh opt_two opt_part
#   ./run_gen.sh diag            -> the diagnostic-dump scenarios (diag_*: heap dumps, error stack, process state, a dump inside
#                                   a 10046 trace, deadlock, hang analysis, system state, an out-of-memory error in a local SYSDBA session under a memory limit) into out/diag_*.trc.
#                                   NOT in the default run: diag_oom writes an incident to the ADR and a line to the alert log,
#                                   diag_hang / diag_sysstate use SYSDBA and wait on row locks for about 20 s. By name too:
#                                   ./run_gen.sh diag_errorstack diag_heap_pga. diag_heap_shared (the shared pool, about 31 MB) is
#                                   not in the group; it writes out/big/diag_heap_shared.trc.
#
# Env: MTK_PASSWORD (default mtk), MTK_SERVICE (default //localhost:1521/pdb1.world),
#      ORACLE_SID (default cdb1), BIG_ITER (default 120000), OUT (default ./out)
# Safety: session-level parameters only; never drops/truncates/removes; only touches schema MTK. (The diag_* scenarios also run
# a SYSDBA session for dumps, and diag_oom runs a local SYSDBA session into a memory limit: one incident in the ADR.)
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

ALL_SCENARIOS="basic_binds plsql_recursive errors io_waits lobs plan_stat_all level_4 level_8 level_1 truncated cursor_cache nasty_sql multisession parallel midtrace_start plan_change exec_loom stats_basic px_io opt"
# 10053-only scenarios: the file is an optimizer trace without 10046 records, so tkprof is not run on it
OPT_SCENARIOS="opt_subq_binds opt_two opt_join8 opt_nostats_ds opt_part opt_parallel opt_dml opt_setop opt_altered opt_unified"
# diagnostic dumps (see the header); heap_large, hang, sysstate and ora4030 have special handling below
DIAG_SCENARIOS="diag_heap_pga diag_heap_uga diag_heap_sub diag_heap_contents diag_heap_large diag_heap_large_pdb diag_errorstack diag_errorstack_l2 diag_errorstack_l1 diag_procstate diag_in_10046 diag_in_10046_l3 diag_deadlock diag_hang diag_sysstate diag_pga_summary diag_pga_detail diag_oom"
if [ $# -eq 0 ]; then
  TARGETS="$ALL_SCENARIOS ref big"
else
  TARGETS="$*"
fi

# the group word "opt" stands for all the 10053 scenarios (opt_interleaved, the only one with 10046 records, goes through tkprof)
TARGETS=$(printf '%s\n' $TARGETS | sed "s/^opt\$/$OPT_SCENARIOS opt_interleaved/; s/^diag\$/$DIAG_SCENARIOS/" | tr '\n' ' ')

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
# run_scenario_sys <name> [sqlplus args...] : the same as SYSDBA in CDB$ROOT (dumps that need it)
run_scenario_sys() {
  local scn=$1; shift
  : > "$OUT/$scn.tracefile"
  sqlplus -S -L / as sysdba "@sc_$scn.sql" "$@" > "$OUT/log/$scn.log" 2>&1
  collect "$scn"
}
# collect <name> [destination directory] : copies the trace file named in out/<name>.tracefile to <dir>/<name>.trc
collect() {
  local scn=$1
  local dest=${2:-$OUT}
  local tf
  tf=$(tr -d '[:space:]' < "$OUT/$scn.tracefile" 2>/dev/null)
  if [ -z "$tf" ] || [ ! -f "$tf" ]; then
    log "ERROR: no trace file recorded for $scn (see $OUT/log/$scn.log)"; return 1
  fi
  cp -p "$tf" "$dest/$scn.trc"
  log "$scn -> $(basename "$tf") ($(stat -c %s "$dest/$scn.trc") bytes, $(wc -l < "$dest/$scn.trc") lines)"
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
    px_io)
      # every slave trace of this run (one file per slave process: px_io_slave_p000.trc ...)
      log "scenario px_io"
      touch "$OUT/.px_io_marker"; sleep 1
      run_scenario px_io
      found=0
      for slave in $(find "$TRACE_DIR" -maxdepth 1 -name "${ORACLE_SID}_p0*_mtk_px_io.trc" -newer "$OUT/.px_io_marker" | sort); do
        p=$(basename "$slave" | cut -d_ -f2)
        cp -p "$slave" "$OUT/px_io_slave_$p.trc"
        log "px_io slave trace: $(basename "$slave") -> px_io_slave_$p.trc ($(stat -c %s "$slave") bytes)"
        tkprof_both "px_io_slave_$p"; found=1
      done
      [ $found = 1 ] || log "WARN: no PX slave trace found"
      tkprof_both px_io
      ;;
    opt_parallel)
      # 10053 only, no tkprof. The query coordinator's trace is the fixture; PX slave trace files of the run
      # (if any) are copied to out/opt_parallel_slave_pNNN.trc for inspection, not meant for testdata
      log "scenario opt_parallel"
      touch "$OUT/.opt_px_marker"; sleep 1
      run_scenario opt_parallel
      for slave in $(find "$TRACE_DIR" -maxdepth 1 -name "${ORACLE_SID}_p0*.trc" -newer "$OUT/.opt_px_marker" | sort); do
        p=$(basename "$slave" | cut -d_ -f2)
        cp -p "$slave" "$OUT/opt_parallel_slave_$p.trc"
        log "opt_parallel slave trace: $(basename "$slave") ($(stat -c %s "$slave") bytes, $(grep -c 'Registered qb' "$slave") optimizer dumps)"
      done
      ;;
    opt_subq_binds|opt_two|opt_join8|opt_nostats_ds|opt_part|opt_dml|opt_setop|opt_altered|opt_unified)
      log "scenario $t (10053 only)"
      run_scenario "$t"
      ;;
    diag_heap_pga|diag_heap_uga|diag_heap_sub|diag_heap_contents|diag_heap_large_pdb|diag_errorstack|diag_errorstack_l2|diag_errorstack_l1|diag_procstate|diag_pga_summary)
      log "scenario $t (dump, no tkprof)"
      run_scenario "$t"
      ;;
    diag_heap_large)
      log "scenario $t (SYSDBA, no tkprof)"
      run_scenario_sys "$t"
      ;;
    diag_heap_shared)
      # about 31 MB: not a fixture, kept in out/big/
      log "scenario $t (SYSDBA, shared pool, to out/big/)"
      mkdir -p "$OUT/big"
      : > "$OUT/$t.tracefile"
      sqlplus -S -L / as sysdba "@sc_$t.sql" > "$OUT/log/$t.log" 2>&1
      collect "$t" "$OUT/big"
      ;;
    diag_deadlock)
      # two sessions deadlock on two rows (ORA-00060 in one of them); the deadlock graph is in the trace of the one
      # that detected it: that file is copied to out/diag_deadlock.trc, both to out/diag_deadlock_a.trc / _b.trc
      log "scenario diag_deadlock (two concurrent sessions)"
      : > "$OUT/diag_deadlock_a.tracefile"; : > "$OUT/diag_deadlock_b.tracefile"
      sqlplus -S -L "$CONN" @_diag_deadlock_a.sql > "$OUT/log/diag_deadlock_a.log" 2>&1 &
      sqlplus -S -L "$CONN" @_diag_deadlock_b.sql > "$OUT/log/diag_deadlock_b.log" 2>&1 &
      wait
      for x in a b; do
        # only the session that detected the deadlock writes a trace file; the other one may have none
        tf=$(tr -d '[:space:]' < "$OUT/diag_deadlock_$x.tracefile" 2>/dev/null)
        if [ -n "$tf" ] && [ -f "$tf" ]; then collect "diag_deadlock_$x"; else log "diag_deadlock: session $x wrote no trace file"; fi
        if grep -q 'DEADLOCK DETECTED' "$OUT/diag_deadlock_$x.trc" 2>/dev/null; then
          cp -p "$OUT/diag_deadlock_$x.trc" "$OUT/diag_deadlock.trc"
          log "diag_deadlock: the deadlock graph is in session $x's trace -> diag_deadlock.trc ($(stat -c %s "$OUT/diag_deadlock.trc") bytes)"
        fi
      done
      [ -f "$OUT/diag_deadlock.trc" ] || log "WARN: no DEADLOCK DETECTED in either trace"
      ;;
    diag_hang|diag_hang_event|diag_sysstate)
      # three MTK sessions wait in a chain on row locks (_diag_chain_1/2/3.sql); the SYSDBA session sc_<t>.sql takes the
      # dump while they wait; the dumping session's own trace goes to out/<t>.trc (the system state levels to out/diag_sysstate_l<n>.trc)
      log "scenario $t (lock chain of three sessions + a SYSDBA dumper)"
      touch "$OUT/.diag_marker"; sleep 1
      hold=16; [ "$t" = diag_sysstate ] && hold=30
      sqlplus -S -L "$CONN" @_diag_chain_1.sql $hold > "$OUT/log/${t}_chain1.log" 2>&1 &
      sqlplus -S -L "$CONN" @_diag_chain_2.sql > "$OUT/log/${t}_chain2.log" 2>&1 &
      sqlplus -S -L "$CONN" @_diag_chain_3.sql > "$OUT/log/${t}_chain3.log" 2>&1 &
      : > "$OUT/$t.tracefile"
      if [ "$t" = diag_sysstate ]; then for lvl in 1 2 258 266; do : > "$OUT/diag_sysstate_l$lvl.tracefile"; done; fi
      sqlplus -S -L / as sysdba "@sc_$t.sql" > "$OUT/log/$t.log" 2>&1
      wait
      collect "$t"
      if [ "$t" = diag_sysstate ]; then
        for lvl in 1 2 258 266; do collect "diag_sysstate_l$lvl"; done
      else
        # the hang analysis is written by the dumping session itself; say so if another process (DIA0) wrote one too
        mine=$(tr -d '[:space:]' < "$OUT/$t.tracefile")
        for f in $(find "$TRACE_DIR" -maxdepth 1 -name "*.trc" -newer "$OUT/.diag_marker" | sort); do
          [ "$f" = "$mine" ] && continue
          if grep -q '^HANG ANALYSIS' "$f"; then cp -p "$f" "$OUT/${t}_$(basename "$f")"; log "$t: another trace file holds a hang analysis: $(basename "$f")"; fi
        done
      fi
      ;;
    diag_pga_detail)
      # SYSDBA asks another process (an MTK session that holds about 7 MB) for its PGA memory detail
      log "scenario $t (one MTK session holding memory + a SYSDBA dumper)"
      sqlplus -S -L "$CONN" @_diag_pgadetail_s1.sql > "$OUT/log/${t}_target.log" 2>&1 &
      : > "$OUT/$t.tracefile"
      sqlplus -S -L / as sysdba "@sc_$t.sql" > "$OUT/log/$t.log" 2>&1
      wait
      collect "$t"
      ;;
    diag_oom)
      # a local bequeath SYSDBA session under 'ulimit -d' grows a PL/SQL collection until the process gets no memory (see the
      # header of sc_diag_oom.sql: on the lab this gives ORA-27102 / an ORA-06544 incident, not ORA-04030). Writes one incident
      # to the ADR. The incident trace files written during the run are copied to out/diag_oom_incident*.trc
      log "scenario $t (SYSDBA under ulimit -d ${OOM_LIMIT_KB:-300000})"
      touch "$OUT/.diag_oom_marker"; sleep 1
      : > "$OUT/$t.tracefile"
      ( ulimit -d "${OOM_LIMIT_KB:-300000}"; timeout 300 sqlplus -S -L / as sysdba "@sc_$t.sql" > "$OUT/log/$t.log" 2>&1 )
      collect "$t"
      n=0
      for f in $(find "$TRACE_DIR/../incident" -name "*_i*.trc" -newer "$OUT/.diag_oom_marker" | sort); do
        n=$((n + 1)); dst="$OUT/diag_oom_incident.trc"; [ $n -gt 1 ] && dst="$OUT/diag_oom_incident$n.trc"
        cp -p "$f" "$dst"
        log "$t: incident trace $f -> $(basename "$dst") ($(stat -c %s "$f") bytes, $(wc -l < "$f") lines)"
      done
      [ $n -gt 0 ] || log "WARN: no incident trace file written"
      ;;
    midtrace_start)
      log "scenario midtrace_start (two files: part1 + continuation)"
      : > "$OUT/midtrace_start_part1.tracefile"
      run_scenario midtrace_start && tkprof_both midtrace_start
      collect midtrace_start_part1 && tkprof_both midtrace_start_part1
      ;;
    workload)
      # A directory of traces from one run: four concurrent sessions (orders, report with PX slaves,
      # batch whose trace continues in a second file, admin), kept under their original ADR names.
      log "scenario workload (four concurrent sessions -> $OUT/workload/)"
      mkdir -p "$OUT/workload"; touch "$OUT/.wl_marker"; sleep 1
      for s in wl_orders wl_report wl_batch wl_admin; do
        : > "$OUT/$s.tracefile"
        sqlplus -S -L "$CONN" "@sc_$s.sql" > "$OUT/log/$s.log" 2>&1 &
      done
      wait
      find "$TRACE_DIR" -maxdepth 1 -name "*.trc" -newer "$OUT/.wl_marker" \
        \( -name "*_mtk_wl_*" -o -name "${ORACLE_SID}_p0*" \) | sort | while read -r tf; do
        cp -p "$tf" "$OUT/workload/"
        log "workload: $(basename "$tf") ($(stat -c %s "$tf") bytes)"
      done
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
