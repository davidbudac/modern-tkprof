import type { ReactNode } from 'react'

/**
 * The 10046 cheatsheet's content: ways to switch SQL trace on, from the everyday to the rare. Each command was run on
 * Oracle 19.27 (CDB, in a PDB) and the trace it wrote was read back; the notes say what that showed. Version marks
 * name the release a feature appeared in; everything here works on 19c.
 */
export interface Recipe {
  id: string
  title: string
  /** one line: whose work it traces, when to reach for it */
  when: string
  /** the release it needs, when older ones lack it */
  since?: string
  code: string
  notes: ReactNode[]
}

export interface RecipeGroup {
  id: string
  title: string
  lead: ReactNode
  recipes: Recipe[]
}

const C = ({ children }: { children: ReactNode }) => <code className="mono">{children}</code>

export const groups: RecipeGroup[] = [
  {
    id: 'common',
    title: 'Common',
    lead: 'You can run the workload yourself, or you know the session.',
    recipes: [
      {
        id: 'own-event',
        title: 'Your own session: event 10046',
        when: 'You run the statements yourself, in SQL*Plus, SQLcl or SQL Developer. Works on every release.',
        code: `alter session set tracefile_identifier = 'mytest';   -- the file ends in _mytest.trc
alter session set max_dump_file_size = unlimited;     -- 23ai and later cap it at 1G
alter session set events '10046 trace name context forever, level 12';

-- run the statements to trace

alter session set events '10046 trace name context off';
select value from v$diag_info where name = 'Default Trace File';`,
        notes: [
          <>Level 12 is binds and waits; the levels table below has the rest. Level 28 adds plan statistics (STAT lines) after every execution, not only the first.</>,
          <>Needs the <C>ALTER SESSION</C> privilege (ORA-01031 without it). <C>tracefile_identifier</C> and <C>v$diag_info</C> work without it.</>,
          <>Set <C>tracefile_identifier</C> before switching trace on: it names the file from the next write on.</>,
        ],
      },
      {
        id: 'own-sqltrace',
        title: 'Your own session: sql_trace or DBMS_SESSION',
        when: 'The same as level 12, written as named options.',
        since: '11g',
        code: `alter session set events 'sql_trace wait=true, bind=true, plan_stat=all_executions';
-- run the statements to trace
alter session set events 'sql_trace off';

-- or, through the package:
begin
  dbms_session.session_trace_enable(waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS');
end;
/
-- run the statements to trace
exec dbms_session.session_trace_disable`,
        notes: [
          <>Both need <C>ALTER SESSION</C> too: <C>DBMS_SESSION</C> raises ORA-01031 without it.</>,
          <>Only the package sets <C>V$SESSION.SQL_TRACE</C> to ENABLED. The event syntax and <C>sql_trace = true</C> trace just the same but leave it at DISABLED.</>,
          <><C>alter session set sql_trace = true</C>, like a bare <C>'sql_trace'</C> event, is level 1: no waits, no binds. Prefer the forms above.</>,
        ],
      },
      {
        id: 'other-session',
        title: 'Another session, by SID and serial#',
        when: 'Someone else’s session is running now: an application server connection, a batch job, a report.',
        code: `-- find it, and the file it will write
select s.sid, s.serial#, s.username, s.program, s.module, s.sql_id,
       p.spid, p.tracefile
  from v$session s join v$process p on p.addr = s.paddr
 where s.username = 'SCOTT';

begin
  dbms_monitor.session_trace_enable(session_id => 123, serial_num => 4567,
    waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS');
end;
/
-- let it run
exec dbms_monitor.session_trace_disable(session_id => 123, serial_num => 4567)`,
        notes: [
          <>Needs <C>EXECUTE</C> on <C>DBMS_MONITOR</C> (the DBA role has it). The trace starts at once, even in the middle of a running call.</>,
          <>Always pass the serial#: with the SID alone, a later session that gets the same SID is traced too. On RAC, run it on the session's instance.</>,
          <><C>V$SESSION</C> shows it in <C>SQL_TRACE</C>, <C>SQL_TRACE_WAITS</C>, <C>SQL_TRACE_BINDS</C> and <C>SQL_TRACE_PLAN_STATS</C>.</>,
          <>This app does the same from <b>Connections</b> → a database → <b>Sessions</b> → <i>Trace on</i>.</>,
        ],
      },
    ],
  },
  {
    id: 'less-common',
    title: 'Less common',
    lead: 'The session is not there yet, comes and goes, or you only want one statement. Check what is still on (below) when you are done.',
    recipes: [
      {
        id: 'sql-id',
        title: 'One SQL_ID, in whichever session runs it',
        when: 'One statement is slow, it runs from many sessions or a connection pool, and you know its SQL_ID.',
        since: '11g',
        code: `alter system set events
  'sql_trace [sql: 7c2fp8kz0fp4u] wait=true, bind=true, plan_stat=all_executions';
-- wait until it has run
alter system set events 'sql_trace [sql: 7c2fp8kz0fp4u] off';

-- several at once:  [sql: 7c2fp8kz0fp4u|g0rm3hdpk6z9p]
-- in your own session only: alter session set events '...' (same text)`,
        notes: [
          <>Traces that cursor and the SQL it runs (the statements inside a PL/SQL call, recursive SQL), not the rest of the session. Sessions already running it are picked up (12.2 missed them; fixed in 18c).</>,
          <>Each session writes its own file. Find them by the SQL_ID: <C>grep -l "sqlid='7c2fp8kz0fp4u'" *.trc</C>.</>,
          <>In a CDB, run it in the PDB. On 19c it did not reach CDB$ROOT sessions, but Oracle documents that an event set in one PDB can reach sessions in the others. Not kept over a restart.</>,
        ],
      },
      {
        id: 'client-id',
        title: 'By client identifier',
        when: 'The application tags its sessions (end-to-end tracing) and a pool hands the work to different connections.',
        code: `-- the application sets it per user or request:
--   exec dbms_session.set_identifier('order-batch')

begin
  dbms_monitor.client_id_trace_enable(client_id => 'order-batch',
    waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS');
end;
/
-- let it run
exec dbms_monitor.client_id_trace_disable(client_id => 'order-batch')`,
        notes: [
          <>Sessions with that identifier are traced at once, the connected ones included. <C>V$SESSION.SQL_TRACE</C> stays DISABLED: look in <C>DBA_ENABLED_TRACES</C>.</>,
          <>Stored in the database: it stays on, over restarts too, until you disable it.</>,
          <>The work lands in many files. Open them together as one trace set, or merge them with <C>trcsess</C> (see Afterwards).</>,
        ],
      },
      {
        id: 'serv-mod-act',
        title: 'By service, module and action',
        when: 'The application names its modules (DBMS_APPLICATION_INFO) and you want one module or action wherever it runs.',
        code: `begin
  dbms_monitor.serv_mod_act_trace_enable(
    service_name => 'pdb1', module_name => 'BILLING', action_name => dbms_monitor.all_actions,
    waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS');
end;
/
-- let it run
begin
  dbms_monitor.serv_mod_act_trace_disable(
    service_name => 'pdb1', module_name => 'BILLING', action_name => dbms_monitor.all_actions);
end;
/`,
        notes: [
          <>The names must match <C>V$SESSION.SERVICE_NAME</C>, <C>MODULE</C> and <C>ACTION</C> exactly. Leave out <C>module_name</C> to trace the whole service; <C>module_name =&gt; null</C> means sessions without a module, not all of them.</>,
          <>Connected sessions are picked up. It is kept in <C>DBA_ENABLED_TRACES</C> until disabled, and the disable call has to repeat the same names.</>,
          <>In a CDB, naming the PDB's service is the way to trace one PDB only.</>,
        ],
      },
      {
        id: 'logon-trigger',
        title: 'Every new session of one user: a logon trigger',
        when: 'The session connects, works and disconnects before you could trace it by SID.',
        code: `create or replace trigger trace_scott_logon
  after logon on database
begin
  if user = 'SCOTT' then
    execute immediate q'[alter session set tracefile_identifier = 'scott']';
    execute immediate
      q'[alter session set events '10046 trace name context forever, level 12']';
  end if;
exception
  when others then null;   -- never block the logon
end;
/

-- when done:
drop trigger trace_scott_logon;`,
        notes: [
          <>Its owner needs <C>ALTER SESSION</C> granted directly. A grant through a role does not count in a trigger: with a role only, SCOTT could not log in at all (ORA-04088, ORA-01031) until the handler was added, and then nothing was traced.</>,
          <>Creating it needs <C>ADMINISTER DATABASE TRIGGER</C>. In a CDB, create it in the PDB that SCOTT logs on to.</>,
        ],
      },
      {
        id: 'oradebug',
        title: 'A process, by OS pid: oradebug',
        when: 'As SYSDBA on the server, for any process: one you know from top or ps, a job slave, or a session you cannot reach otherwise.',
        code: `sqlplus / as sysdba
oradebug setospid 12345         -- V$PROCESS.SPID (or: oradebug setorapid <V$PROCESS.PID>)
oradebug unlimit                -- no max_dump_file_size for this process
oradebug event 10046 trace name context forever, level 12
oradebug tracefile_name         -- the file it writes
-- let it run
oradebug event 10046 trace name context off`,
        notes: [
          <>Also takes the named syntax: <C>oradebug event sql_trace wait=true, bind=true, plan_stat=all_executions</C>, and <C>oradebug event sql_trace off</C>.</>,
          <>Not in the documentation: a support tool that attaches to the process. <C>V$SESSION.SQL_TRACE</C> stays DISABLED.</>,
          <>With threaded execution (<C>threaded_execution = true</C>) several processes share an OS pid: use <C>setorapid</C>.</>,
        ],
      },
      {
        id: 'instance',
        title: 'Every session',
        when: 'Last resort: you cannot say which session or statement. Every session writes a file, so keep it short and watch the disk.',
        code: `begin
  dbms_monitor.database_trace_enable(waits => true, binds => true, plan_stat => 'ALL_EXECUTIONS');
end;
/
-- a minute or two
exec dbms_monitor.database_trace_disable

-- or, kept only until the instance restarts:
alter system set events '10046 trace name context forever, level 12';
alter system set events '10046 trace name context off';`,
        notes: [
          <>Both reach the connected sessions at once (since 11g; on 10g <C>alter system</C> reached new sessions only). Run in a PDB on 19c, neither reached CDB$ROOT sessions.</>,
          <><C>ALTER SYSTEM SET EVENTS</C> needs the <C>ALTER SYSTEM</C> privilege. <C>DATABASE_TRACE_ENABLE</C> is kept in <C>DBA_ENABLED_TRACES</C> until disabled.</>,
        ],
      },
    ],
  },
]

/** Where the trace lands, how to get it off the server, and how to check that nothing is left on. */
export const after: RecipeGroup = {
  id: 'after',
  title: 'Afterwards',
  lead: 'Trace files are written on the database server, in the ADR trace folder of the instance.',
  recipes: [
    {
      id: 'find-file',
      title: 'Find the file',
      when: 'Named <instance>_ora_<spid>[_<tracefile_identifier>].trc.',
      code: `select value from v$diag_info where name = 'Default Trace File';   -- your own session's file
select value from v$diag_info where name = 'Diag Trace';           -- the folder

-- another session's file:
select p.tracefile
  from v$session s join v$process p on p.addr = s.paddr
 where s.sid = 123;`,
      notes: [
        <>Open the <C>.trc</C>; the <C>.trm</C> next to it is the index the database keeps for itself.</>,
        <>A parallel query writes a file per PX server (<C>…_p000_….trc</C>), shared server sessions spread over <C>…_s000_…</C> files; <C>tracefile_identifier</C> does not name these. Open them together as one trace set.</>,
        <><C>max_dump_file_size</C> is unlimited by default up to 21c. From 23ai it is 1G: the trace is written in 200 MB segments and the oldest but the first are deleted, so a long trace loses its middle. Set it to unlimited before tracing (<C>oradebug unlimit</C> for another process).</>,
      ],
    },
    {
      id: 'spool-file',
      title: 'No access to the server: read it over SQL',
      when: 'You have a database login but no shell on the server.',
      since: '12.2',
      code: `-- save as get_trace.sql and run it with @get_trace (termout off works in scripts only)
set pages 0 lines 32767 trimspool on heading off feedback off termout off tab off
spool ORCL_ora_12345_mytest.trc
select payload from v$diag_trace_file_contents
 where trace_filename = 'ORCL_ora_12345_mytest.trc'
 order by line_number;
spool off`,
      notes: [
        <>Needs <C>SELECT</C> on <C>V_$DIAG_TRACE_FILE_CONTENTS</C> (or <C>SELECT_CATALOG_ROLE</C>). <C>V$DIAG_TRACE_FILE</C> lists the files. On 19c the spooled copy gave the same report as the original.</>,
        <>A line longer than 4000 bytes (long SQL text, big binds) comes back in pieces that cannot be put in order reliably. Copy such traces off the server as files.</>,
        <>This app does it for you: <b>Connections</b> → a database → <b>Trace files</b> → <i>Fetch</i>. Large files are faster over SSH.</>,
      ],
    },
    {
      id: 'trcsess',
      title: 'Merge files: trcsess',
      when: 'A client identifier, service or module traced many sessions and you want one file for one of them.',
      code: `# on the server, in the trace folder
trcsess output=order-batch.trc clientid=order-batch *.trc
trcsess output=billing.trc service=pdb1 module=BILLING *.trc
trcsess output=one.trc session=123.4567 *.trc`,
      notes: [
        <>Ships with the database (<C>$ORACLE_HOME/bin</C>). Not needed for this app, which opens several files as one trace set, but it keeps a copy small.</>,
      ],
    },
    {
      id: 'still-on',
      title: 'Check that nothing is left on',
      when: 'After any of the less common ways, before you walk away.',
      code: `-- DBMS_MONITOR by client id, service/module/action and database: kept until disabled
select trace_type, primary_id, qualifier_id1, qualifier_id2, waits, binds, plan_stats
  from dba_enabled_traces;

-- DBMS_MONITOR / DBMS_SESSION on single sessions
select sid, serial#, username, sql_trace_waits, sql_trace_binds
  from v$session where sql_trace = 'ENABLED';

-- ALTER SYSTEM SET EVENTS: as SYSDBA, in the container where it was set
oradebug setmypid
oradebug eventdump system`,
      notes: [
        <><C>V$SESSION.SQL_TRACE</C> shows only the single-session ways. A session traced by client id, module, a logon trigger, an event or oradebug reads DISABLED there.</>,
        <>A logon trigger is visible as an object: <C>select owner, trigger_name from dba_triggers where triggering_event like 'LOGON%'</C>.</>,
      ],
    },
  ],
}

/** The 10046 levels and what each one adds; levels add up (28 = 4 + 8 + 16). */
export const levels: { level: string; option: string; adds: ReactNode }[] = [
  { level: '1', option: 'sql_trace', adds: <>statements, parse / exec / fetch calls, STAT lines after the first execution (<C>sql_trace = true</C>)</> },
  { level: '4', option: 'bind=true', adds: <>BINDS: the bind values</> },
  { level: '8', option: 'wait=true', adds: <>WAIT: every wait event, with its time</> },
  { level: '12', option: 'wait=true, bind=true', adds: <>both: the usual choice</> },
  { level: '16', option: 'plan_stat=all_executions', adds: <>STAT lines after every execution (11g)</> },
  { level: '32', option: 'plan_stat=never', adds: <>no STAT lines (11g)</> },
  { level: '64', option: 'plan_stat=adaptive', adds: <>STAT after the first execution, then again each time the cursor has used about another minute of DB time, over all its executions (11.2.0.2)</> },
]
