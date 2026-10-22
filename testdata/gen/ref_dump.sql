-- Run as SYSDBA. Dumps reference CSVs into out/ref/. Usage: sqlplus / as sysdba @ref_dump.sql
set echo off feedback off termout off trimspool on linesize 32767 pagesize 50000 verify off
set markup csv on quote on
spool out/ref/event_name_19c.csv
select event#, name, wait_class, wait_class_id, parameter1, parameter2, parameter3 from v$event_name order by event#;
spool off
spool out/ref/sqlcommand_19c.csv
select command_type, command_name from v$sqlcommand order by command_type;
spool off
alter session set container = PDB1;
spool out/ref/mtk_objects.csv
select object_id, data_object_id, owner, object_name, subobject_name, object_type from dba_objects where owner = 'MTK' order by object_id;
spool off
spool out/ref/datafiles_pdb1.csv
select d.file# as file#, d.name, t.name as tablespace_name, 'DATAFILE' as file_type, d.file# as abs_file#
  from v$datafile d join v$tablespace t on t.ts# = d.ts#
union all
select f.file#, f.name, t.name, 'TEMPFILE', f.file# + (select to_number(value) from v$parameter where name = 'db_files')
  from v$tempfile f join v$tablespace t on t.ts# = f.ts#
order by 4, 1;
spool off
set markup csv off
set heading on pagesize 100 linesize 200
col banner_full for a120
col name for a30
col value for a30
spool out/ref/db_version.txt
select banner_full from v$version;
select name, open_mode, con_id from v$pdbs;
select name, value from v$parameter where name in ('db_files', 'db_block_size', 'compatible', 'max_dump_file_size', 'session_cached_cursors');
select host_name, instance_name, version_full from v$instance;
spool off
exit
