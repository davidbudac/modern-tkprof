# Reference bundle

A trace file holds numbers, not names: `obj#`, `file#` (wait p1) and `uid`,
and no execution plan text. The reference bundle adds names and DBMS_XPLAN
output. mtkprof never connects to a database: it writes a script, a DBA runs
it, and mtkprof reads what the script spooled.

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
| CSV export | `waits.csv`: `object_name`, `file_name`; `plan_lines.csv`: `owner`, and `object_name` filled when the trace left it empty |
| pivot, plan | object and datafile names in group labels; plan JSON `object_name` filled |

## Privacy

The bundle holds object, owner, user and datafile names and execution plans
(plan predicates can contain literals from the SQL). It holds no table data
and no bind values. Review `ref/` before sharing it, like the trace itself.
