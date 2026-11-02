# Fact-check: "How to create an Oracle 10046 SQL trace" cheatsheet

Scope: Oracle 11.2 through 23ai/26ai, with 19c as the main case. Researched 2026-11-01.
Verdicts: **correct** / **partly** / **wrong** / **unverified** (no primary or expert source found, so test it on 19c).

Naming note: Oracle renamed 23ai to **"Oracle AI Database 26ai"** (the 23.26 RU line). The docs.oracle.com `/23/` URLs now serve 26ai text. Where this matters below, "23ai/26ai" means current docs.

Key sources (cited by short name below):
- [DBMS_MONITOR 19c] https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_MONITOR.html
- [DBMS_MONITOR 23] https://docs.oracle.com/en/database/oracle/oracle-database/23/arpls/DBMS_MONITOR.html
- [DBMS_SESSION 19c] https://docs.oracle.com/en/database/oracle/oracle-database/19/arpls/DBMS_SESSION.html
- [TGSQL 19c] SQL Tuning Guide, Performing Application Tracing: https://docs.oracle.com/en/database/oracle/oracle-database/19/tgsql/performing-application-tracing.html
- [Antognini levels] https://antognini.ch/2012/08/event-10046-full-list-of-levels/
- [JL sql_trace 23] https://jonathanlewis.wordpress.com/2023/10/27/sql_trace-23/
- [JL sql_trace 2014] https://jonathanlewis.wordpress.com/2014/05/22/sql_trace/
- [Tanel ALTER SYSTEM] https://tanelpoder.com/2013/10/07/why-doesnt-alter-system-set-events-set-the-events-or-tracing-immediately/
- [ORADEBUG DOC sql_trace] https://orasql.org/files/events/doc/event/oradebug-doc-event-name-sql_trace.php (Sayan Malakshinov's mirror of `oradebug doc` output)
- [oracle-base] https://oracle-base.com/articles/misc/sql-trace-10046-trcsess-and-tkprof

---

## 1. TRACEFILE_IDENTIFIER — **correct** (one caveat)

- Form: `ALTER SESSION SET tracefile_identifier = 'x';` gives `<sid>_ora_<pid>_x.trc`. The Reference states the format `sid_ora_pid_traceid.trc`, where `pid` is the OS process ID (V$PROCESS.SPID).
- Caveats from the Reference:
  - "Each time this parameter is dynamically modified, the **next trace dump** will be written to a trace file which has the new parameter value embedded in its name. Trace file continuity information is automatically added to both the old and new trace files." So set it **before** enabling trace. If you change it mid-trace, the trace is split across two files.
  - It renames **foreground** process trace files only. Background processes (including PX slaves `pNNN` and shared servers `sNNN`) keep the standard naming.
  - `V$PROCESS.TRACEID` shows the current value.
  - Modifiable via `ALTER SESSION` only. "Modifiable in a PDB: No" applies to the system-level setting.
- Version: long-standing (8i+). Available in all target versions.
- Source: https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/TRACEFILE_IDENTIFIER.html

## 2. Event 10046 syntax and levels — **partly** (level 64 rule was wrong)

- Syntax: `ALTER SESSION SET EVENTS '10046 trace name context forever, level 12'` and `'10046 trace name context off'`. **Correct.**
- Levels, from Antognini's full list:
  - 0: off.
  - 1: standard SQL trace (equals `sql_trace=true`). From 11.1, STAT (plan) lines are written **after the first execution** with that execution's statistics. Before 11.1 they were written when the cursor closed, aggregated.
  - 4: binds.
  - 8: waits.
  - 12: binds and waits.
  - 16 (11.1+): STAT lines for **every** execution.
  - 32 (11.1+): **never** write STAT lines.
  - 64: "generally available as of 11.2.0.2 only" (Antognini). JL cites patch 8328200 for earlier releases.
- **Correct rule for level 64 (adaptive):** STAT lines are written for the first execution, as in level 1. They are written again for a later execution only if, "since the last write of execution plans information, a particular cursor consumed at least one additional minute of DB time" (Antognini).
  - The threshold is **cumulative DB time of the (child) cursor across executions**, not the elapsed time of a single execution. It is shared by every session using that child cursor. JL measured about 65–69 s intervals, and about 33 s when two sessions shared the cursor.
  - STAT lines are written as the cursor closes (JL). MOS 8328200 wording, quoted by JL: "for every minute of dbtime per shared cursor".
  - Your draft wording ("elapsed time > ~1 minute more") is wrong. Use: "STAT lines on first execution, then again each time the cursor has used another ~60 s of DB time in total."
- Combining: levels 4 and 8 add to any level above 1, e.g. 12, 28 (4+8+16), 68 (4+64). **Correct.** Combine only one of 16/32/64; they are alternative plan_stat modes.
- Mapping to the unified syntax: 16 = `plan_stat=all_executions`, 32 = `never`, 64 = `adaptive`.
- Sources: [Antognini levels], [JL sql_trace 23], https://timurakhmadeev.wordpress.com/2012/07/31/adaptive-stat-lines-in-sql-trace/

## 3. Unified `sql_trace` event (11.1+) — **correct**; `adaptive` exists

- `oradebug doc event name sql_trace` output:
  ```
  sql_trace: event for sql trace
  Usage
  -------
  sql_trace
     wait       < false | true >,
     bind       < false | true >,
     plan_stat  < never | first_execution | all_executions | adaptive >,
     level      <ub4>
  ```
  Sources: [ORADEBUG DOC sql_trace]; the same text appears in [JL sql_trace 23].
- So the keywords are `wait`, `bind`, `plan_stat` and `level`. `level` also works: `alter session set events 'sql_trace level 12'` is shown in ORADEBUG DOC examples (https://www.cnblogs.com/zengkefu/p/6957185.html).
- Defaults: wait=false, bind=false, plan_stat=first_execution (JL: "The default value for plan_stat is first_execution"). Plain `'sql_trace'` is therefore equivalent to level 1. ORADEBUG DOC does not print the defaults, so this is expert-reported. Confirm with V$SESSION.SQL_TRACE_* columns after enabling.
- Off: `ALTER SESSION SET EVENTS 'sql_trace off'`. The scoped form is shown by JL as `'sql_trace[SQL: id] off'`.
- Version: 11.1+ (Julian Dyke, http://juliandyke.com/Diagnostics/Trace/EnablingTrace.php; Tanel 2010). `adaptive` needs 11.2.0.2+.
- Caveat: this syntax is documented only by `oradebug doc` (the built-in help), not in the SQL Language Reference.

## 4. DBMS_SESSION.SESSION_TRACE_ENABLE / DISABLE — **partly** (privilege claim is likely wrong)

- Syntax and defaults are **correct**: `SESSION_TRACE_ENABLE(waits IN BOOLEAN DEFAULT TRUE, binds IN BOOLEAN DEFAULT FALSE, plan_stat IN VARCHAR2 DEFAULT NULL)`. plan_stat is "'NEVER', 'FIRST_EXECUTION' (equivalent to NULL) or 'ALL_EXECUTIONS'" [DBMS_SESSION 19c].
- `SESSION_TRACE_DISABLE` takes no arguments. It "resets the session-level SQL trace for the session from which it was called. **Client ID and service/module/action traces are not affected.**"
- `'ADAPTIVE'` with the packages:
  - Not documented in 19c or 23/26ai.
  - JL tested it: ORA-30449 on 19.11–19.21 (both packages) and on 21.3 (DBMS_SESSION). It worked on 23.2.
  - For 19c, use the event syntax for adaptive. Bug 14483308 was rejected; enhancement 14499199 (Antognini).
- Privileges:
  - DBMS_SESSION "runs with the privileges of the calling user" (Security Model). EXECUTE is effectively PUBLIC; the docs state "executable by PUBLIC" for SET_IDENTIFIER.
  - **However, enabling SQL trace needs the ALTER SESSION system privilege.** SQL Reference, ALTER SESSION prerequisites: "To enable and disable the SQL trace facility, you must have ALTER SESSION system privilege." Antognini observed `DBMS_SESSION.SESSION_TRACE_ENABLE` failing with ORA-01031 for a user without it; Laurent Leturgez called this "a documented limitation" (https://antognini.ch/2016/09/sql-trace-in-oracle-database-exadata-express-cloud-service/). That was a locked-down cloud service, so test with a CREATE SESSION-only user on 19c.
  - Since 10.2 the CONNECT role is only CREATE SESSION, so ordinary app users usually **lack** ALTER SESSION.
- `ALTER SESSION SET EVENTS` needs ALTER SESSION. **Yes.** Oracle docs say so explicitly for events: "the ALTER SESSION privilege to enable session-level tracing" / "ALTER SYSTEM privilege to enable system-level tracing" (https://docs.oracle.com/en/database/oracle/oracle-database/26/ddscg/enable-diagnostic-tracing.html). The Database Vault guide says the same. Tested ORA-01031 for `alter session set events` on 10.2: https://coskan.wordpress.com/2007/03/14/connect-role-without-alter-session-privilege-ora-01031-insufficient-privileges/
- Version: SESSION_TRACE_ENABLE in DBMS_SESSION since 10.1. `plan_stat` parameter since 11.1.

## 5. `ALTER SESSION SET sql_trace = TRUE` — **correct**

- Equals level 1 (no waits, no binds). Julian Dyke states this for `set_sql_trace_in_session`. `DBMS_SESSION.SET_SQL_TRACE` "is equivalent to the SQL statement ALTER SESSION SET SQL_TRACE".
- Deprecated, quoting the Reference: "The SQL_TRACE parameter is deprecated. Oracle recommends that you use the DBMS_MONITOR and DBMS_SESSION packages instead. SQL_TRACE is retained for backward compatibility only."
- Also needs ALTER SESSION privilege (see 4).
- Source: https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/SQL_TRACE.html

## 6. Finding your own trace file — **correct** (11.1+)

- `SELECT value FROM v$diag_info WHERE name = 'Default Trace File';` returns "the current default trace file for the current process".
- `SELECT value FROM v$diag_info WHERE name = 'Diag Trace';` returns "the path to the ADR trace directory for the current instance".
- Both queries are verbatim in the 11.2 Administrator's Guide: https://docs.oracle.com/html/E25494_01/diag006.htm. 19c V$DIAG_INFO: https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/V-DIAG_INFO.html
- Caveats:
  - The value is for the **current process**. With shared server, or after the session moves, it is not "your session's file".
  - The file may not exist until something has been written.
  - In a CDB, V$DIAG_INFO has a CON_ID column, and PDB sessions write into the instance's (CDB's) single ADR trace dir.

## 7. TIMED_STATISTICS / MAX_DUMP_FILE_SIZE — **partly** (23ai/26ai default changed, which is important)

- TIMED_STATISTICS defaults to true when STATISTICS_LEVEL is TYPICAL or ALL, and false when BASIC. **Correct.** Extra fact: "Starting with release 11.1.0.7.0, the value of TIMED_STATISTICS cannot be set to false if STATISTICS_LEVEL is TYPICAL or ALL." https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/TIMED_STATISTICS.html
- MAX_DUMP_FILE_SIZE:
  - Default `UNLIMITED` in 9i, 12.1, 19c and 21c:
    - https://docs.oracle.com/cd/B10501_01/server.920/a96536/ch1109.htm
    - https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/MAX_DUMP_FILE_SIZE.html
    - https://docs.oracle.com/en/database/oracle/oracle-database/21/refrn/MAX_DUMP_FILE_SIZE.html
  - Your "since 10g" guess is too late. It was already UNLIMITED in 9i (8i defaulted to a block count).
  - **In 23ai/26ai the default is `1G`:**
    - Foreground trace files max 1 GB (5 segments of 200 MB).
    - Background/incident files max 10 GB.
    - Free edition: 32M.
    - When the total exceeds the limit, "the oldest segment is deleted… The first segment is never deleted".
  - So **a long 10046 trace on 23ai/26ai silently loses its middle**, and the file is split into segment files ("same file name as the active trace file, but with an extra segment number appended"). The 26ai Admin Guide: "trace files created by the database will no longer default to unlimited size. Segmentation and rotation of the files has been enabled."
    - https://docs.oracle.com/en/database/oracle/oracle-database/26/refrn/MAX_DUMP_FILE_SIZE.html
    - https://docs.oracle.com/en/database/oracle/oracle-database/26/admin/diagnosing-and-resolving-problems.html
  - Segmentation also applies in 12.2–21c when you set a finite limit of at least 25 MB.
  - Recommendation for the cheatsheet: always run `ALTER SESSION SET max_dump_file_size = UNLIMITED;` (or `oradebug unlimit` for another process) before tracing, and say why.
  - Syntax `MAX_DUMP_FILE_SIZE = { integer [K|M|G] | UNLIMITED }`, modifiable by ALTER SESSION/SYSTEM and in a PDB. `ALTER SESSION SET max_dump_file_size = UNLIMITED` is **correct**.
  - For mtkprof itself: you may want to detect and handle segmented trace files.

## 8. DBMS_MONITOR.SESSION_TRACE_ENABLE / DISABLE — **correct**, with caveats

- Syntax: `SESSION_TRACE_ENABLE(session_id BINARY_INTEGER DEFAULT NULL, serial_num BINARY_INTEGER DEFAULT NULL, waits BOOLEAN DEFAULT TRUE, binds BOOLEAN DEFAULT FALSE, plan_stat VARCHAR2 DEFAULT NULL)` and `SESSION_TRACE_DISABLE(session_id DEFAULT NULL, serial_num DEFAULT NULL)` [DBMS_MONITOR 19c].
- NULL semantics, verbatim: "If serial_num is NULL but session_id is specified, a session with a given session_id is traced **irrespective of its serial number**. If both session_id and serial_num are NULL, the current user session is traced. It is illegal to specify NULL session_id and non-NULL serial_num."
  - So always pass serial#. Otherwise a *new* session reusing the SID could be the one traced.
- The doc parameter table mislabels session_id as "Client Identifier". It is the SID.
- RAC: **yes.** "The trace is enabled only on the instance to which the caller is connected, since database sessions do not span instances. This tracing is strictly local to an instance." Connect to the session's instance (GV$SESSION.INST_ID). The trace file lands in that instance's ADR.
- plan_stat values are as in item 4. ADAPTIVE is not available in 19c (JL).
- Privileges:
  - The package page has **no** Security Model section (checked 19c and 23).
  - oracle-base: "Make sure the user has access to DBMS_MONITOR… `GRANT EXECUTE ON dbms_monitor TO hr;`"
  - TGSQL says DATABASE_TRACE_ENABLE needs "administrative privileges".
  - Whether DBA has EXECUTE by default is **unverified** from public sources. Check on 19c with `SELECT grantee FROM dba_tab_privs WHERE table_name='DBMS_MONITOR';`.
  - Forum reports say EXECUTE on DBMS_MONITOR alone is enough to trace other sessions; ALTER SESSION is not needed. Test this.
- Version: 10.1+. `plan_stat` added in 11.1.

## 9. Trace file of another session / V$SESSION trace columns — **correct**

- `SELECT p.tracefile FROM v$session s JOIN v$process p ON p.addr = s.paddr WHERE s.sid = :sid;` is **correct**; oracle-base uses the same query.
- V$PROCESS.TRACEFILE is "Trace file name of the process" (19c). The 11.2 Admin Guide uses `SELECT PID, PROGRAM, TRACEFILE FROM V$PROCESS`, so it exists in 11.x (https://docs.oracle.com/html/E25494_01/diag006.htm). I could not open the 11.1 Reference to confirm the exact introduction version; it is widely given as 11.1.
- V$SESSION columns:
  - SQL_TRACE: ENABLED/DISABLED.
  - SQL_TRACE_WAITS: TRUE/FALSE.
  - SQL_TRACE_BINDS: TRUE/FALSE.
  - SQL_TRACE_PLAN_STATS: never/first_execution/all_executions.
  - Source: https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/V-SESSION.html (10.2+)
- Caveat (unverified): these columns reflect DBMS_MONITOR/DBMS_SESSION-style trace. Whether they reflect raw `10046`/`sql_trace` events set via ALTER SESSION or oradebug is not documented. Test on 19c.
- Caveat for RAC/multitenant: use GV$ and join on INST_ID.

## 10. ORADEBUG — **correct**, add notes

- From `oradebug help`:
  - `SETMYPID`: Debug current process.
  - `SETOSPID <ospid>`: Set OS pid of process to debug (= V$PROCESS.SPID).
  - `SETORAPID <orapid> ['force']`: Set Oracle pid of process to debug (= V$PROCESS.PID).
  - `EVENT <text>`: Set trace event in **process**.
  - `SESSION_EVENT <text>`: Set trace event in **session**.
  - `UNLIMIT`: Unlimit the size of the trace file.
  - `TRACEFILE_NAME`: Get name of trace file.
  - `FLUSH` and `CLOSE_TRACE` also exist.
  - Source: https://quark.tistory.com/m/74
- Your sequence (setospid, unlimit, `event 10046 trace name context forever, level 12`, tracefile_name, `event 10046 trace name context off`) matches oracle-base (`ORADEBUG SETOSPID 1234; ORADEBUG EVENT 10046 TRACE NAME CONTEXT FOREVER, LEVEL 12; ORADEBUG TRACEFILE_NAME;`). It needs SYSDBA (oracle-base).
- `event` vs `session_event`:
  - `EVENT` attaches to the *process*. Everything that process does is traced, whichever session it serves (relevant for shared servers and pooled processes).
  - `SESSION_EVENT` attaches to the session currently on that process.
  - For a dedicated server the two are effectively the same.
- Multithreaded model (THREADED_EXECUTION=TRUE, 12c+): "SPID identifier is not unique for RDBMS processes", so use `SETORAPID` (V$PROCESS doc).
- Unified syntax via oradebug (`oradebug event sql_trace wait=true, bind=true`): Tanel says ORADEBUG EVENT/SESSION_EVENT take event specifications, but I found **no source showing this exact command**. Test it on 19c.
- Supportability:
  - ORADEBUG is not documented in the Oracle Database manuals.
  - Expert references call it undocumented, "use only on the recommendation of Oracle Support" (O'Reilly *Oracle Utilities Pocket Reference*). Tanel: undocumented, "at your own risk".
  - Oracle's own EVENT parameter doc says: "Do not alter the value of this parameter except under the supervision of Oracle Support Services staff."
  - Phrase it as "unsupported/undocumented; Oracle recommends DBMS_MONITOR".

## 11. DBMS_SYSTEM.SET_EV / SET_SQL_TRACE_IN_SESSION — **correct** (undocumented)

- `DBMS_SYSTEM.SET_EV(si, se, 10046, 12, '')` to enable and `SET_EV(si, se, 10046, 0, '')` to disable (Julian Dyke). `DBMS_SYSTEM.SET_SQL_TRACE_IN_SESSION(sid, serial#, TRUE/FALSE)` gives level 1 only.
- DBMS_SYSTEM has no chapter in the PL/SQL Packages and Types Reference, so it is undocumented. oracle-base says "you should avoid them now and use the DBMS_MONITOR package instead." EXECUTE is not granted to PUBLIC; it is SYS-owned and normally needs SYSDBA or an explicit grant.
- Tanel still suggests SET_EV for non-SQL-trace events in *existing* sessions, but DBMS_MONITOR for SQL trace.

## 12. End-to-end: CLIENT_ID / SERV_MOD_ACT — **partly**

- `CLIENT_ID_TRACE_ENABLE(client_id IN VARCHAR2, waits DEFAULT TRUE, binds DEFAULT FALSE, plan_stat DEFAULT NULL)` and `CLIENT_ID_TRACE_DISABLE(client_id)`. **Correct.**
  - `DBMS_SESSION.SET_IDENTIFIER(client_id)` sets the ID. It is case-sensitive, max 64 bytes, longer input truncated, executable by PUBLIC.
  - **Persistence, documented and correct:** "The tracing is enabled for all instances and persistent across restarts." Also: "The trace will be written to multiple trace files because more than one Oracle shadow process can work on behalf of a given client identifier."
- `SERV_MOD_ACT_TRACE_ENABLE(service_name, module_name DEFAULT ANY_MODULE, action_name DEFAULT ANY_ACTION, waits DEFAULT TRUE, binds DEFAULT FALSE, instance_name DEFAULT NULL, plan_stat DEFAULT NULL)`:
  - The doc syntax says `ANY_MODULE`/`ANY_ACTION` in the defaults, but the examples use the constants `DBMS_MONITOR.ALL_MODULES` and `DBMS_MONITOR.ALL_ACTIONS` (`ALL_ACTIONS = '###ALL_ACTIONS'`). In the cheatsheet, use the constants `DBMS_MONITOR.ALL_MODULES` and `DBMS_MONITOR.ALL_ACTIONS`, or omit the arguments.
  - **Gotcha:** "Specifying NULL for the module_name parameter means that statistics will be accumulated for the sessions which **do not set** the MODULE attribute." Likewise, for actions, NULL or empty string means "an action whose name is an empty string". So NULL is **not** a wildcard.
  - Hierarchy: service, service+module, or service+module+action.
  - "By default, tracing is enabled globally for the database"; `instance_name` restricts it.
  - The disable call is `SERV_MOD_ACT_TRACE_DISABLE(service_name, module_name, action_name DEFAULT ALL_ACTIONS, instance_name DEFAULT NULL)`, and the arguments must match those used at enable.
  - "Tracing information is present in multiple trace files and you must use the trcsess tool to collect it into a single file."
- Persistence for SERV_MOD_ACT and DATABASE: the package doc does not state it as explicitly as for client ID. All of them are recorded in **DBA_ENABLED_TRACES** (TRACE_TYPE = CLIENT_ID / SERVICE / SERVICE_MODULE / SERVICE_MODULE_ACTION / DATABASE). The base table is SYS.WRI$_TRACING_ENABLED (Julian Dyke). That is consistent with persistence, but say "persist until disabled (documented for client ID)" and test the rest across a bounce.
  - DBA_ENABLED_TRACES.PLAN_STATS shows `ALL_EXEC` / `NEVER` / `FIRST_EXEC` ("FIRST_EXEC… This is the default behavior").
  - https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/DBA_ENABLED_TRACES.html
- Already-connected sessions: not documented for client-ID or SMA traces.
  - TGSQL says module/action changes made through DBMS_APPLICATION_INFO "take effect when the next user call is executed in the session".
  - The analogous expectation is that existing matching sessions start tracing at their next call. **Unverified; test.** Tracing starts or stops as a session's client_id/module/action changes, which suits connection pools.

## 13. trcsess — **correct**

- Syntax (TGSQL 19c): `trcsess [output=output_file_name] [session=session_id] [clientid=client_id] [service=service_name] [action=action_name] [module=module_name] [trace_files]`.
  - `session` is "a combination of session index and session serial number, such as 21.2371".
  - With no `output=`, it writes to stdout.
  - Wildcards are allowed in trace_files. With none given, trcsess uses all files in the current directory.
- Purpose: TGSQL states that after TRCSESS merges trace information into a single output file, TKPROF can process it. "Meant for tkprof" is a fair summary.
- Caveat (unverified): how multiple criteria combine (AND vs OR) is not documented in what I read. Test whether mtkprof parses trcsess output; its headers differ from a raw trace file.

## 14. DATABASE_TRACE_ENABLE / DISABLE — **partly**

- Syntax: `DATABASE_TRACE_ENABLE(waits DEFAULT TRUE, binds DEFAULT FALSE, instance_name DEFAULT NULL, plan_stat DEFAULT NULL)` and `DATABASE_TRACE_DISABLE(instance_name DEFAULT NULL)`. **Correct.**
- TGSQL 19c:
  - "overrides all other session-level traces, but is complementary to the client identifier, service, module, and action traces. **Tracing is enabled for all current and future sessions.**"
  - "When you invoke this procedure with the instance_name parameter, the procedure resets the session-level SQL trace for the named instance."
  - "Prerequisites: You must have administrative privileges."
- Persistence: listed in DBA_ENABLED_TRACES (TRACE_TYPE=DATABASE). A blog notes the "settings are stored in the data dictionary therefore stay after restart" (https://intheboxdba.wordpress.com/2019/08/27/how-to-enable-sql-trace/). Not explicitly documented by Oracle; test with a bounce.
- Background processes: **not documented.** Docs say "all current and future sessions". Test whether `dbw0` and similar get files. Timur Akhmadeev found database-wide trace "can't be overridden on the session level" (https://hoopercharles.wordpress.com/2010/02/12/tracing-enabled-for-sessions-after-instance-restart/).
- Historical bug (10.2.0.1 RAC): could not be disabled (Julian Dyke). Not relevant for 19c, but it shows why the cheatsheet should say "always disable, and check DBA_ENABLED_TRACES".

## 15. ALTER SYSTEM SET EVENTS — **correct** (version boundary confirmed)

- Up to 10.2: only your own session and *new* sessions pick it up. Also, "off" via ALTER SYSTEM didn't stop tracing in sessions that already had it.
- 11g+: the hidden parameter `_evt_system_event_propagation` (default TRUE) propagates system events into **existing** sessions [Tanel ALTER SYSTEM].
- **Bug:** in 12.2 some events, at least `ALTER SYSTEM SET EVENTS 'sql_trace[SQL: …]'`, didn't propagate correctly to other sessions. Fixed in 18.3 (Tanel, updates 2 and 3).
- Exact timing of pickup in existing sessions (next call?) is not documented.
- Not persisted: ALTER SYSTEM SET EVENTS is memory-only. The `EVENT` init parameter is static ("Modifiable: No"), so it needs `scope=spfile` and a restart. Oracle: "Do not alter the value of this parameter except under the supervision of Oracle Support Services staff." https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/EVENT.html
- Needs the ALTER SYSTEM privilege.
- Tanel's own recommendation: use DBMS_MONITOR for SQL trace.
- Multitenant caveat: see 21.

## 16. Tracing one SQL_ID — **correct**, with caveats

- Syntax:
  - `ALTER SYSTEM SET EVENTS 'sql_trace [sql: 7c2fp8kz0fp4u] wait=true, bind=true, plan_stat=all_executions';`
  - Off: `ALTER SYSTEM SET EVENTS 'sql_trace [sql: 7c2fp8kz0fp4u] off';`
  - Both forms are used by JL (2014, tested to 19.11), oracle-base and Julian Dyke.
- Multiple IDs: ORADEBUG DOC shows `[sql: sql_id=g3yc1js3g2689 | sql_id=7ujay4u33g337]` and the positional `[sql: g3yc1js3g2689 | 7ujay4u33g337]`. Your `[sql: id1|id2]` is **correct**.
- Session-level variant: `ALTER SESSION SET EVENTS 'sql_trace[SQL: g2y0pjcy1hnqr] plan_stat=all_executions, wait=false, bind=true';` (JL).
- `oradebug doc event scope sql` documents `[SQL: sql_id <string>[20]]`. `oradebug doc event name sql_trace` lists the event. **Yes.**
- Version: 11.1+ (Julian Dyke: "In Oracle 11.1 and above"; JL: "the new 11g syntax").
- What gets traced:
  - The matching cursor's calls and waits.
  - **Plus everything executed under it.** JL: "if the SQL_ID is for a pl/sql block, all the SQL executing inside the block is traced as part of the trace on the block". Recursive dictionary SQL issued by the statement was also traced.
  - Tanel shows `{pgadep: exactdepth 0}` and `{callstack: fname opiexe}` filters to restrict to depth 0 (https://tanelpoder.com/2010/06/23/the-full-power-of-oracles-diagnostic-events-part-2-oradebug-doc-and-11g-improvements).
  - Tracing a recursive SQL_ID directly: not covered by sources. Test it.
- Already-running sessions: yes from 11g, via propagation (item 15). Not in 12.2 (bug fixed in 18.3).
- Output: written to **each executing process's own trace file**. JL got "trace files from 9 separate sessions".
- Also: this whole syntax is documented only by ORADEBUG DOC.

## 17. Process filter — **partly**; exact syntax below

- `oradebug doc event filter process`:
  ```
  process: filter to set events only for a specific process
  Usage
  -------
  {process:  ospid  <string>[20],
             orapid <ub4>,
             pname  <string>[20],
             con_id <ub8> }
  ```
  Source: https://orasql.org/files/events/doc/event/filter/oradebug-doc-event-filter-process.php
- Forms:
  - `ALTER SYSTEM SET EVENTS 'sql_trace {process: ospid=12345} level=12';`
  - `{process: orapid=42}`
  - `{process: pname=p000}`
- **Multiple processes must repeat the filter name.** JL on 19c: `alter system set events 'sql_trace {process:pname = dw | process:pname=dm | process:pname=p00} level=8';` works. `{process:pname = dw | dm | p0}` raises **ORA-49601** on 19c. A commenter reports `{process: pname = dw | pname = dm}` also fails on 19.14. Source: https://jonathanlewis.wordpress.com/2022/10/11/tracing-tip-joelkallmanday/
- JL's `pname=p00` matched p000-p00N, which looks like prefix matching. That is inferred from his results, not documented.
- ORADEBUG DOC example: `{process: pname = p000 | process: pname=p005}` (https://www.cnblogs.com/zengkefu/p/6957185.html).
- `con_id` exists in the 12.1+ process filter. Its effect on PDB scoping is untested.
- JL calls this "quick, dirty, and brutal… a dedicated test system".

## 18. Logon trigger pattern — **correct**, with gotchas

- Triggers are always definer's-rights units (PL/SQL Ref, AUTHID table: "Trigger | DR unit"). In a DR unit the database "enables only the role PUBLIC". So the trigger **owner needs ALTER SESSION granted directly**, not via the DBA role, whether you use `EXECUTE IMMEDIATE 'ALTER SESSION SET EVENTS …'` or `DBMS_SESSION.SESSION_TRACE_ENABLE` (which also needs ALTER SESSION, see item 4). https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/invokers-rights-and-definers-rights-authid-property.html
- ALTER SESSION must go through `EXECUTE IMMEDIATE` (not static PL/SQL). DBMS_SESSION/DBMS_MONITOR calls are static and give compile-time checking, so prefer `DBMS_SESSION.SESSION_TRACE_ENABLE(waits=>TRUE, binds=>TRUE)`. Also set `tracefile_identifier` and `max_dump_file_size` there.
- Failure behaviour (PL/SQL Ref, Exception Handling in Triggers): for `AFTER LOGON ON DATABASE`, the error only rolls back the trigger's own work (and is logged to trace and alert log) when "the user has the ADMINISTER DATABASE TRIGGER privilege". For **everyone else an unhandled exception blocks the logon.** So always wrap the body in `EXCEPTION WHEN OTHERS THEN NULL;`. Your note that ADMINISTER DATABASE TRIGGER holders bypass failures is **correct**. https://docs.oracle.com/en/database/oracle/oracle-database/19/lnpls/exception-handling-triggers.html
- A trigger that *hangs* (rather than errors) still blocks new logons (https://www.pythian.com/blog/after-logon-trigger-in-user-schema-and-fra-full-situation-hang-the-database).
- Alternative without a trigger: `DBMS_MONITOR.CLIENT_ID_TRACE_ENABLE` or `SERV_MOD_ACT_TRACE_ENABLE`, if the app sets client id, module or service.
- Remind readers to drop the trigger afterwards. Hooper's post is about forgotten logon triggers making trace "survive restarts".

## 19. V$DIAG_TRACE_FILE / V$DIAG_TRACE_FILE_CONTENTS (12.2+) — **partly**; important gotchas

- 12.2+: "Starting in Oracle Database 12c Release 2 (12.2), when you are connected to a container in a CDB, new V$ views enable read access to trace files that are specific to the container" [TGSQL 19c].
- V$DIAG_TRACE_FILE: ADR_HOME, TRACE_FILENAME, CHANGE_TIME, MODIFY_TIME, CON_ID. "All trace files present in the ADR for the current container (PDB)". Has GV$. https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/V-DIAG_TRACE_FILE.html
- V$DIAG_TRACE_FILE_CONTENTS: ADR_HOME, TRACE_FILENAME (VARCHAR2(68)), RECORD_LEVEL, PARENT_LEVEL, RECORD_TYPE (1 regular … 8), TIMESTAMP, **PAYLOAD VARCHAR2(4000)**, SECTION_ID, SECTION_NAME, COMPONENT_NAME, OPERATION_NAME, FILE_NAME, FUNCTION_NAME, **LINE_NUMBER**, THREAD_ID, SESSION_ID, SERIAL#, CON_UID, CONTAINER_NAME, CON_ID. Has GV$. https://docs.oracle.com/en/database/oracle/oracle-database/19/refrn/V-DIAG_TRACE_FILE_CONTENTS.html
- Query (oracle-base):
  ```sql
  SELECT payload FROM v$diag_trace_file_contents
  WHERE  trace_filename = 'cdb1_ora_12345.trc'
  ORDER  BY line_number;
  ```
  Add `AND adr_home = …` and `AND con_id = …` (or `inst_id` with GV$) to disambiguate in RAC/CDB.
- **Gotcha 1:** the Reference describes LINE_NUMBER as "the line number in the code file which produced this trace record". In practice it is the trace-file line number. oracle-base and berx order by it, and the bug report treats it that way. Ordering by it is community practice, not a documented guarantee.
- **Gotcha 2:** lines longer than 4000 bytes are split into several rows. As of 19.7, "all except the last are shown as line [N-1]" (the *previous* line's number), and "there is no way to order these lines". Long `PARSING IN CURSOR` SQL text and long bind values are affected. Observed by Jeff Holt (Method R), filed by berx: https://forums.oracle.com/ords/apexds/post/extend-v-diag-trace-file-contents-so-multiple-chunks-of-a-l-0490 (formerly https://community.oracle.com/ideas/27659). Not known to be fixed. Test on current 19c.
- **Gotcha 3:** whether PAYLOAD includes the trailing newline is **unverified**. berx's CLOB-builder appends payloads with no separator, which suggests the newline is included (https://berxblog.blogspot.com/2019/09). Test before writing the spool recipe. For SQL*Plus, use `set long/linesize/trimspool/pagesize 0/feedback off` or build a CLOB.
- Gotcha 4: you see only files and records for the current container when connected to a PDB.
- Gotcha 5: needs SELECT on `V_$DIAG_TRACE_FILE_CONTENTS` (e.g. via SELECT_CATALOG_ROLE or a direct grant; berx: "grant select on sys.V_$DIAG_TRACE_FILE_CONTENTS to xxx").
- Also: V$DIAG_SQL_TRACE_RECORDS and V$DIAG_SESS_SQL_TRACE_RECORDS hold only SQL_TRACE records, the latter for the current session. V$DIAG_APP_TRACE_FILE lists files containing SQL/optimizer trace data [TGSQL 19c].

## 20. PX slaves / shared servers — **correct**

- Shared server, from TGSQL: "in a shared server configuration, a user session is serviced by different processes over time. The trace for the user session is scattered across different trace files belonging to different processes". trcsess is the documented fix.
- PX slaves (`<sid>_p000_<spid>.trc`) and shared servers (`<sid>_s000_<spid>.trc`) are named like background processes ("SID, process name, OS pid", 11.2 Admin Guide). TRACEFILE_IDENTIFIER does **not** apply to them (item 1).
- Caveat (unverified): `trcsess session=<qc sid.serial>` may not pick up slave files, because slaves have their own session IDs. Merging by `clientid=` / `module=` / `action=` (which slaves normally inherit from the QC) is the usual approach. Test.
- In RAC, slaves can run on other instances, so their files land in those instances' ADR.

## 21. Multitenant — **partly**

- Location: one ADR home per instance. PDB session traces go to the **same CDB instance trace directory**. "PDB annotations exist in trace files… The PDB information is part of the structured metadata that is stored in the .trm file for each trace file" (CON_ID, CON_UID, NAME) [TGSQL 19c]. V$DIAG_TRACE_FILE in a PDB lists only files containing that PDB's data.
- ALTER SYSTEM SET EVENTS inside a PDB:
  - It is accepted. The 26ai doc example connects to the PDB and runs `ALTER SYSTEM SET events …`, and SQL Ref says ALTER SYSTEM in a PDB needs ALTER SYSTEM granted commonly or locally.
  - **But Oracle's Database Vault guide says the scope is CDB-wide:** "Running the ALTER SYSTEM SET EVENTS statement from either the root or a specific PDB enables tracing for **all PDBs** in the container database." For ALTER SESSION: "You cannot enable tracing for a single PDB; the tracing applies to all PDBs and the root". This means session tracing follows the session across `ALTER SESSION SET CONTAINER`.
  - https://docs.oracle.com/en/database/oracle/oracle-database/21/dvadm/troubleshooting-oracle-database-vault.html (same text in 12.2 DV guide)
  - For the cheatsheet: warn that ALTER SYSTEM SET EVENTS from a PDB traces matching sessions in **every** PDB. Test on 19c.
- DBMS_MONITOR.DATABASE_TRACE_ENABLE in a PDB: no doc statement on scope (none in 19c or 23 package docs). **Unverified; test.**
- Cleanest PDB-scoped option: `DBMS_MONITOR.SERV_MOD_ACT_TRACE_ENABLE(service_name => '<pdb service>')`. Each PDB has its own service. Or use `{process: con_id=N}`, which is untested.
- 12.2+ also added `_diag_cdb_logging`, which controls how container switches appear in SQL trace files (https://www.dbi-services.com/blog/oracle-12cr2-multitenant-containers-in-sql_trace/). mtkprof may see container-switch lines.

---

### Items to test on dbmint (19c), because public sources don't settle them

1. Does `DBMS_SESSION.SESSION_TRACE_ENABLE` raise ORA-01031 for a CREATE SESSION-only user? Does EXECUTE on DBMS_MONITOR alone let a user trace other sessions?
2. `SELECT grantee FROM dba_tab_privs WHERE table_name IN ('DBMS_MONITOR','DBMS_SYSTEM');`
3. Do V$SESSION.SQL_TRACE* columns reflect `10046`/`sql_trace` events, or only DBMS_MONITOR/DBMS_SESSION traces?
4. Does `oradebug event sql_trace wait=true, bind=true` work?
5. Do SERV_MOD_ACT and DATABASE traces survive a restart (DBA_ENABLED_TRACES after bounce)? Does DATABASE_TRACE_ENABLE trace background processes?
6. Does PAYLOAD in V$DIAG_TRACE_FILE_CONTENTS include the newline? Is the >4000-byte split still present?
7. ALTER SYSTEM SET EVENTS from a PDB: does it trace sessions in other PDBs?
8. Is a plain `'sql_trace'` equivalent to level 1 (check the V$SESSION columns)?
