// Package ref holds Oracle reference data needed to interpret a trace:
// wait event classes, bind datatype codes, SQL command types.
package ref

import (
	"bufio"
	"bytes"
	_ "embed"
	"encoding/csv"
	"io"
	"strconv"
	"strings"
	"sync"
)

//go:embed data/idle_events.txt
var idleEventsTxt []byte

//go:embed data/event_name_19c.csv
var eventNameCSV []byte

//go:embed data/sqlcommand_19c.csv
var sqlCommandCSV []byte

// EventInfo describes a wait event.
type EventInfo struct {
	Name   string
	Class  string // wait class, "" when unknown
	P1, P2 string
	P3     string
	Idle   bool
}

var (
	once     sync.Once
	events   map[string]EventInfo
	commands map[int]string
)

func load() {
	events = make(map[string]EventInfo, 2048)
	sc := bufio.NewScanner(bytes.NewReader(idleEventsTxt))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		events[line] = EventInfo{Name: line, Class: "Idle", Idle: true}
	}
	if rows := readCSV(eventNameCSV); len(rows) > 1 {
		h := index(rows[0])
		for _, r := range rows[1:] {
			name := get(r, h, "NAME")
			if name == "" {
				continue
			}
			class := get(r, h, "WAIT_CLASS")
			events[name] = EventInfo{
				Name:  name,
				Class: class,
				P1:    get(r, h, "PARAMETER1"),
				P2:    get(r, h, "PARAMETER2"),
				P3:    get(r, h, "PARAMETER3"),
				Idle:  class == "Idle",
			}
		}
	}
	commands = make(map[int]string, 256)
	if rows := readCSV(sqlCommandCSV); len(rows) > 1 {
		h := index(rows[0])
		for _, r := range rows[1:] {
			n, err := strconv.Atoi(get(r, h, "COMMAND_TYPE"))
			if err == nil {
				commands[n] = get(r, h, "COMMAND_NAME")
			}
		}
	}
	for k, v := range builtinCommands {
		if _, ok := commands[k]; !ok {
			commands[k] = v
		}
	}
}

func readCSV(b []byte) [][]string {
	if len(bytes.TrimSpace(b)) == 0 {
		return nil
	}
	r := csv.NewReader(bytes.NewReader(b))
	r.FieldsPerRecord = -1
	r.LazyQuotes = true
	var rows [][]string
	for {
		rec, err := r.Read()
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		rows = append(rows, rec)
	}
	return rows
}

func index(header []string) map[string]int {
	m := make(map[string]int, len(header))
	for i, h := range header {
		m[strings.ToUpper(strings.TrimSpace(h))] = i
	}
	return m
}

func get(row []string, h map[string]int, col string) string {
	i, ok := h[col]
	if !ok || i >= len(row) {
		return ""
	}
	return strings.TrimSpace(row[i])
}

// Event returns what is known about a wait event name.
func Event(name string) EventInfo {
	once.Do(load)
	if e, ok := events[name]; ok {
		return e
	}
	return EventInfo{Name: name}
}

// IsIdle reports whether the event is an idle (client / background sleep) event.
func IsIdle(name string) bool { return Event(name).Idle }

// CommandName returns the v$sqlcommand name for an oct (Oracle command type).
func CommandName(oct int) string {
	once.Do(load)
	if s, ok := commands[oct]; ok {
		return s
	}
	return "COMMAND " + strconv.Itoa(oct)
}

var builtinCommands = map[int]string{
	0: "UNKNOWN", 1: "CREATE TABLE", 2: "INSERT", 3: "SELECT", 4: "CREATE CLUSTER", 5: "ALTER CLUSTER",
	6: "UPDATE", 7: "DELETE", 8: "DROP CLUSTER", 9: "CREATE INDEX", 10: "DROP INDEX", 11: "ALTER INDEX",
	12: "DROP TABLE", 13: "CREATE SEQUENCE", 14: "ALTER SEQUENCE", 15: "ALTER TABLE", 16: "DROP SEQUENCE",
	17: "GRANT OBJECT", 18: "REVOKE OBJECT", 19: "CREATE SYNONYM", 20: "DROP SYNONYM", 21: "CREATE VIEW",
	22: "DROP VIEW", 23: "VALIDATE INDEX", 24: "CREATE PROCEDURE", 25: "ALTER PROCEDURE", 26: "LOCK TABLE",
	27: "NO-OP", 28: "RENAME", 29: "COMMENT", 30: "AUDIT OBJECT", 31: "NOAUDIT OBJECT", 32: "CREATE DATABASE LINK",
	33: "DROP DATABASE LINK", 34: "CREATE DATABASE", 35: "ALTER DATABASE", 36: "CREATE ROLLBACK SEG",
	37: "ALTER ROLLBACK SEG", 38: "DROP ROLLBACK SEG", 39: "CREATE TABLESPACE", 40: "ALTER TABLESPACE",
	41: "DROP TABLESPACE", 42: "ALTER SESSION", 43: "ALTER USER", 44: "COMMIT", 45: "ROLLBACK", 46: "SAVEPOINT",
	47: "PL/SQL EXECUTE", 48: "SET TRANSACTION", 49: "ALTER SYSTEM", 50: "EXPLAIN", 51: "CREATE USER",
	52: "CREATE ROLE", 53: "DROP USER", 54: "DROP ROLE", 55: "SET ROLE", 56: "CREATE SCHEMA", 57: "CREATE CONTROL FILE",
	59: "CREATE TRIGGER", 60: "ALTER TRIGGER", 61: "DROP TRIGGER", 62: "ANALYZE TABLE", 63: "ANALYZE INDEX",
	64: "ANALYZE CLUSTER", 65: "CREATE PROFILE", 66: "DROP PROFILE", 67: "ALTER PROFILE", 68: "DROP PROCEDURE",
	70: "ALTER RESOURCE COST", 71: "CREATE MATERIALIZED VIEW LOG", 72: "ALTER MATERIALIZED VIEW LOG",
	73: "DROP MATERIALIZED VIEW LOG", 74: "CREATE MATERIALIZED VIEW", 75: "ALTER MATERIALIZED VIEW",
	76: "DROP MATERIALIZED VIEW", 77: "CREATE TYPE", 78: "DROP TYPE", 79: "ALTER ROLE", 80: "ALTER TYPE",
	81: "CREATE TYPE BODY", 82: "ALTER TYPE BODY", 83: "DROP TYPE BODY", 84: "DROP LIBRARY", 85: "TRUNCATE TABLE",
	86: "TRUNCATE CLUSTER", 88: "ALTER VIEW", 91: "CREATE FUNCTION", 92: "ALTER FUNCTION", 93: "DROP FUNCTION",
	94: "CREATE PACKAGE", 95: "ALTER PACKAGE", 96: "DROP PACKAGE", 97: "CREATE PACKAGE BODY",
	98: "ALTER PACKAGE BODY", 99: "DROP PACKAGE BODY", 100: "LOGON", 101: "LOGOFF", 102: "LOGOFF BY CLEANUP",
	103: "SESSION REC", 104: "SYSTEM AUDIT", 105: "SYSTEM NOAUDIT", 106: "AUDIT DEFAULT", 107: "NOAUDIT DEFAULT",
	108: "SYSTEM GRANT", 109: "SYSTEM REVOKE", 110: "CREATE PUBLIC SYNONYM", 111: "DROP PUBLIC SYNONYM",
	112: "CREATE PUBLIC DATABASE LINK", 113: "DROP PUBLIC DATABASE LINK", 114: "GRANT ROLE", 115: "REVOKE ROLE",
	116: "EXECUTE PROCEDURE", 117: "USER COMMENT", 118: "ENABLE TRIGGER", 119: "DISABLE TRIGGER",
	120: "ENABLE ALL TRIGGERS", 121: "DISABLE ALL TRIGGERS", 122: "NETWORK ERROR", 123: "EXECUTE TYPE",
	128: "FLASHBACK", 129: "CREATE SESSION", 130: "ALTER MINING MODEL", 131: "SELECT MINING MODEL",
	152: "CREATE DIRECTORY", 153: "DROP DIRECTORY", 154: "CREATE LIBRARY", 155: "CREATE JAVA", 156: "ALTER JAVA",
	157: "DROP JAVA", 158: "CREATE OPERATOR", 159: "CREATE INDEXTYPE", 160: "DROP INDEXTYPE", 161: "ALTER INDEXTYPE",
	162: "DROP OPERATOR", 163: "ASSOCIATE STATISTICS", 164: "DISASSOCIATE STATISTICS", 165: "CALL METHOD",
	166: "CREATE SUMMARY", 167: "ALTER SUMMARY", 168: "DROP SUMMARY", 169: "CREATE DIMENSION",
	170: "ALTER DIMENSION", 171: "DROP DIMENSION", 172: "CREATE CONTEXT", 173: "DROP CONTEXT",
	174: "ALTER OUTLINE", 175: "CREATE OUTLINE", 176: "DROP OUTLINE", 177: "UPDATE INDEXES", 178: "ALTER OPERATOR",
	189: "MERGE", 190: "ANALYZE", 191: "UPSERT", 192: "ALTER DISK GROUP", 193: "CREATE DISK GROUP", 194: "DROP DISK GROUP",
	197: "PURGE USER_RECYCLEBIN", 198: "PURGE DBA_RECYCLEBIN", 199: "PURGE TABLESPACE", 200: "PURGE TABLE",
	201: "PURGE INDEX", 202: "UNDROP OBJECT", 204: "FLASHBACK DATABASE", 205: "FLASHBACK TABLE",
	206: "CREATE RESTORE POINT", 207: "DROP RESTORE POINT", 208: "PROXY AUTHENTICATION ONLY",
	209: "DECLARE REWRITE EQUIVALENCE", 210: "ALTER REWRITE EQUIVALENCE", 211: "DROP REWRITE EQUIVALENCE",
	212: "CREATE EDITION", 213: "ALTER EDITION", 214: "DROP EDITION", 215: "DROP ASSEMBLY", 216: "CREATE ASSEMBLY",
	217: "ALTER ASSEMBLY", 218: "CREATE FLASHBACK ARCHIVE", 219: "ALTER FLASHBACK ARCHIVE",
	220: "DROP FLASHBACK ARCHIVE", 225: "ALTER DATABASE LINK", 226: "CREATE PLUGGABLE DATABASE",
	227: "ALTER PLUGGABLE DATABASE", 228: "DROP PLUGGABLE DATABASE", 229: "CREATE AUDIT POLICY",
	230: "ALTER AUDIT POLICY", 231: "DROP AUDIT POLICY", 232: "CODE-BASED GRANT", 233: "CODE-BASED REVOKE",
	238: "ADMINISTER KEY MANAGEMENT", 239: "CREATE MATERIALIZED ZONEMAP", 240: "ALTER MATERIALIZED ZONEMAP",
	241: "DROP MATERIALIZED ZONEMAP", 242: "DROP MINING MODEL", 243: "CREATE ATTRIBUTE DIMENSION",
	244: "ALTER ATTRIBUTE DIMENSION", 245: "DROP ATTRIBUTE DIMENSION", 246: "CREATE HIERARCHY",
	247: "ALTER HIERARCHY", 248: "DROP HIERARCHY", 249: "CREATE ANALYTIC VIEW", 250: "ALTER ANALYTIC VIEW",
	251: "DROP ANALYTIC VIEW", 252: "CREATE LANGUAGE", 253: "DROP LANGUAGE", 254: "ALTER PUBLIC DATABASE LINK",
	255: "ALTER DOMAIN",
}

// BindTypeName maps an oacdty (Oracle internal datatype code) to a name.
func BindTypeName(dty int) string {
	if s, ok := bindTypes[dty]; ok {
		return s
	}
	return "DTY" + strconv.Itoa(dty)
}

var bindTypes = map[int]string{
	1: "VARCHAR2", 2: "NUMBER", 3: "NATIVE INTEGER", 4: "FLOAT", 5: "STRING", 6: "VARNUM", 7: "LONG DECIMAL",
	8: "LONG", 9: "VARCHAR", 11: "ROWID", 12: "DATE", 15: "VARRAW", 23: "RAW", 24: "LONG RAW", 25: "UNSIGNED INT",
	29: "LONG VARRAW", 68: "UNSIGNED INT (OCI)", 96: "CHAR", 97: "CHARZ", 100: "BINARY_FLOAT", 101: "BINARY_DOUBLE",
	102: "REF CURSOR", 104: "UROWID", 105: "MLSLABEL", 106: "MLSLABEL", 108: "OBJECT", 109: "ADT", 110: "REF",
	111: "REF", 112: "CLOB", 113: "BLOB", 114: "BFILE", 115: "CFILE", 119: "JSON", 121: "NAMED OBJECT",
	122: "NESTED TABLE", 123: "VARRAY", 178: "TIME", 179: "TIME WITH TIME ZONE", 180: "TIMESTAMP",
	181: "TIMESTAMP WITH TIME ZONE", 182: "INTERVAL YEAR TO MONTH", 183: "INTERVAL DAY TO SECOND",
	208: "UROWID", 231: "TIMESTAMP WITH LOCAL TIME ZONE", 252: "BOOLEAN", 286: "VECTOR",
}

// OptimizerGoal names the og= value of call lines.
func OptimizerGoal(og int) string {
	switch og {
	case 1:
		return "ALL_ROWS"
	case 2:
		return "FIRST_ROWS"
	case 3:
		return "RULE"
	case 4:
		return "CHOOSE"
	}
	return "OG" + strconv.Itoa(og)
}

// CloseType names the type= value of CLOSE lines.
func CloseType(t int) string {
	switch t {
	case 0:
		return "hard close"
	case 1:
		return "cached (new in session cursor cache)"
	case 2:
		return "cached (replaced)"
	case 3:
		return "cached (already in session cursor cache)"
	}
	return "type " + strconv.Itoa(t)
}
