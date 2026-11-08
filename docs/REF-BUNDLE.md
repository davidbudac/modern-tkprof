# Reference bundle

A trace file holds numbers, not names: `obj#`, `file#` (wait p1) and `uid`,
and no execution plan text. The reference bundle adds names and DBMS_XPLAN
output. mtkprof writes a script, a DBA runs it, and mtkprof reads what the
script spooled. With a database login, `mtkprof ref -db user@host:port/service
trace.trc` runs the same queries itself and writes the same files
(docs/REMOTE.md).

The quickest way needs no directories and no connection: the **names
script** (§ Paste below) prints everything as text that is pasted into the
app (*Import names*) or saved to a file for `-ref`.

## 1. Make the script

```
mtkprof refscript trace.trc -o ref.sql          # DBA views + V$ (SELECT_CATALOG_ROLE)
mtkprof refscript trace.trc -lite -o ref.sql    # ALL_ views only, any schema can run it
```

The script is tailored to the trace: only the obj#, file#, user ids and
sql_ids that occur in it (IN-lists are chunked at 1000). It is read-only
(SELECTs and DBMS_XPLAN calls) and starts with a comment that says so.

`-lite` differs: `ALL_OBJECTS` / `ALL_USERS` instead of `DBA_OBJECTS` /
`DBA_USERS`, and no datafile section (it needs V$ views). Objects the connected
user cannot see stay unnamed; plans need access to `V$SQL_PLAN`.

## 2. Run it where the database is

```
mkdir -p ref/plans                      # Windows: mkdir ref ref\plans
sqlplus user/password@service @ref.sql
```

SPOOL does not create directories, so `ref/` and `ref/plans/` must exist
before the run. For a PDB trace connect to the PDB. `whenever sqlerror
continue` is set: one failing query or plan does not stop the others.

## 3. What it produces

```
ref/
  objects.csv      object_id, data_object_id, owner, object_name, subobject_name, object_type
  datafiles.csv    file#, name, tablespace_name, file_type, abs_file#     (not with -lite)
  users.csv        user_id, username
  plans/<sql_id>.txt   DBMS_XPLAN.DISPLAY_CURSOR(sql_id, null, 'ALLSTATS LAST +PREDICATE +ALIAS'),
                       or DISPLAY_AWR when the cursor has aged out
```

Written with `set markup csv on quote on`. `abs_file#` is the number waits
report: datafile `file#`, or `file# + db_files` for a tempfile (the loader
keys files by it). Every file is optional; the loader ignores plan files that
only say the cursor "cannot be found". Raw exports named `*_objects.csv` or
`datafiles_*.csv` are accepted too.

## 4. Apply it

```
mtkprof report trace.trc -ref ref
mtkprof html   trace.trc -ref ref
```

`-ref dir` works on `report`, `html`, `serve`, `json`, `export`, `pivot` and
`plan`. It only adds names; no number changes.

| Output | What changes |
|---|---|
| text report | "Wait detail by object" prints `owner.name` after the obj#; `uid 165 (MTK)`; the DBMS_XPLAN text under the statement's plan |
| JSON / HTML / serve | `objects`, `files`, `users` tables (only entries the trace uses), `refPlan` on statements; the UI shows names for obj# / file# / user ids and a collapsible "DBMS_XPLAN from ref bundle" |
| CSV export | `waits.csv`: `object_name`, `file_name`; `plan_lines.csv`: `owner`, `access_predicates`, `filter_predicates`, `e_rows`, and `object_name` filled when the trace left it empty |
| pivot, plan | object and datafile names in group labels; plan JSON `object_name` filled, plus `access_predicates`, `filter_predicates`, `object_alias`, `qblock_name` (see below) |

### Predicates and estimates on the trace plan

A `plans/<sql_id>.txt` whose `Plan hash value` equals the plan hash of a STAT
plan of that statement is parsed and overlaid on the STAT lines by operation
id: access / filter predicates, query block, object alias, and the optimizer
estimate (`E-Rows` / `Rows`) on lines where the STAT line has no `card=`.
The trace's own numbers (rows, starts, time, cost, card) are never replaced.
With a different hash (the cursor was re-optimised since the trace) nothing
is overlaid and the diagnostics say so; the DBMS_XPLAN text is still shown.

| Output | What appears |
|---|---|
| text report | `Predicates (from ref bundle DBMS_XPLAN):` with `id: access(...)` / `id: filter(...)` lines under the plan table |
| JSON / HTML / serve | plan lines `access`, `filter`, `alias`, `qblock`, `eRows`; plans `xPlanMatched`; the UI plan table gets a flag per operation with predicates (click for the text), `~n` for an overlaid estimate, and a header hint |
| plan JSON / "Open in plan viz" | `access_predicates`, `filter_predicates`, `object_alias`, `qblock_name`; `cardinality` from the estimate where STAT has none |

## Paste: the names script

```
mtkprof refscript trace.trc -paste -o names.sql          # names of obj#, file#, user ids
mtkprof refscript trace.trc -paste -plans -o names.sql   # and DBMS_XPLAN plans (a much longer output)
```

One read-only PL/SQL block (SELECTs and DBMS_XPLAN calls) that prints
through DBMS_OUTPUT instead of spooling files, so it runs anywhere a script
runs: `sqlplus user/pw@db @names.sql`, pasted at the `SQL>` prompt, SQLcl,
or SQL Developer's Run Script (F5). The trace's ids go in as
`sys.odcinumberlist` literals (1000 per call) bound to dynamic SQL, so a
part the user may not read fails alone: objects and users are read from the
DBA_ views, else from the ALL_ views, and a `note` line says which; the
datafiles need the V$ views and are a note without them. No `-lite`: the
same script serves every user.

Its output, between a first and a last line:

```
mtkprof-ref 1
obj,108609,108609,"MTK","MTK_CUST","","TABLE"        objects.csv columns
file,3,"/u01/oradata/CDB1/pdb1/temp01.dbf","TEMP","TEMPFILE",203   datafiles.csv columns
user,165,"MTK"                                       users.csv columns
plan,"10gywwmwk6xfy","Plan hash value: 1426583507"   one DBMS_XPLAN line
note,"objects: ORA-00942: table or view does not exist; read ALL_OBJECTS: only the objects this user can see"
mtkprof-ref end
```

The fields after the tag are CSV. A reader (`ref.ParsePaste`) ignores every
other line (the client's echo, prompts, "PL/SQL procedure successfully
completed."), so the whole Script Output can be copied as it is; a missing
last line means the copy was cut off. Without any tagged line the text is
read as CSV or tab-separated tables under header rows (`OBJECT_ID`, `OWNER`,
`OBJECT_NAME` …; `FILE#`/`ABS_FILE#` with `NAME`; `USER_ID` with
`USERNAME`): an `objects.csv` of the spooling script, or a result grid
copied with its headers.

Where it goes:

- **The app** (desktop): *Import names* (the I/O map's Objects and Display
  tabs, the statement inspector's waits, or Connections › Reference data ›
  *Paste script output…*) shows the script (Copy, Save) and takes the
  output (paste, or *Open saved output…*). The engine reads it at once
  (`POST /s/{id}/api/ref/paste`), merges it into the bundle kept for the
  trace (a pasted entry replaces the kept one with its key, the rest stays:
  names pasted after a database fetch keep its plans) and applies it; the
  dialog shows, per kind, how many of the trace's ids are named. The CLI's
  `serve` and the standalone HTML have no such route; their views point to
  the CLI instead.
- **The CLI**: save the output (`sqlplus -s user/pw@db @names.sql > names.txt`)
  and pass the file: `-ref names.txt` (a file instead of a directory).

## Privacy

The bundle holds object, owner, user and datafile names and execution plans
(plan predicates can contain literals from the SQL). It holds no table data
and no bind values. Review `ref/` before sharing it, like the trace itself.
