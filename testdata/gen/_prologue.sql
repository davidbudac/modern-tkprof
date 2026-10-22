-- Common prologue for every scenario. Usage: @@_prologue.sql <scenario>
-- Sets the trace file identifier and the module/action/client-id markers
-- so the "*** MODULE NAME", "*** ACTION NAME", "*** CLIENT ID" lines appear.
define SCN=&1
set echo off feedback on heading on pagesize 50 linesize 200 trimspool on trimout on verify off
set serveroutput off
whenever sqlerror continue
alter session set tracefile_identifier = 'mtk_&SCN';
exec dbms_application_info.set_module('mtk_&SCN', 'start')
exec dbms_session.set_identifier('mtk_client_&SCN')
