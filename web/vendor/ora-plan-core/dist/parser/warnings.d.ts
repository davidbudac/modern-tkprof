/**
 * Partial-parse diagnostics. The parsers read what they can and keep going; the helpers here
 * work out what was lost (an unknown column, a row that would not parse, a cut-off paste, a
 * SQL*Plus wrapper around the XML ...) and phrase it so the user knows what to do about it.
 *
 * Every warning has a stable `code` (tests and dismissal key on it) and a one-sentence message
 * that says what is missing and how to fix the capture.
 */
import type { PlanWarning } from '../types.js';
/** What to tell someone whose CLOB output stops mid-document. */
export declare const TRUNCATION_ADVICE = "In SQL*Plus run SET LONG 100000000 LONGCHUNKSIZE 100000000 before spooling, then capture it again.";
/** Message used when XML (or an ACTIVE report) ends before its closing tag. */
export declare const TRUNCATED_REPORT_MESSAGE = "The report looks cut off. In SQL*Plus run SET LONG 100000000 LONGCHUNKSIZE 100000000 before spooling, then capture it again.";
/** True for a plan-table header that is known and deliberately not read. */
export declare function isIgnoredHeader(label: string): boolean;
/** A line inside the plan table that begins a data row but could not be turned into one. */
export declare function isRejectedRow(line: string, idCell: string): boolean;
export interface TableShape {
    /** Rows split across lines (SQL*Plus LINESIZE smaller than the table). */
    wrapped: boolean;
    /** The text ends in the middle of a row. */
    truncated: boolean;
    /** Index of the last line of the table region. */
    endIndex: number;
}
/** Inspect the lines of the plan table that starts at `headerIndex`. */
export declare function scanTableShape(lines: string[], headerIndex: number): TableShape;
/** True when the input has a plan table whose lines were wrapped (see `scanTableShape`). */
export declare function looksWrappedTable(input: string): boolean;
export declare const WRAPPED_TABLE_MESSAGE = "The plan table looks wrapped \u2014 its lines were split, probably because the SQL*Plus LINESIZE was too small, so rows are missing or garbled. Run SET LINESIZE 300 (or wider) and SET TRIMSPOOL ON, then capture the plan again.";
export interface TextTableDiagnostics {
    lines: string[];
    headerIndex: number;
    /** Header cells no column rule matched (and not on the ignore list). */
    unknownColumns: string[];
    /** Lines that begin a data row but were rejected by the row parser. */
    rejectedLines: string[];
    /** Ids of the operations that were read. */
    nodeIds: number[];
    /** Ids the Predicate Information section refers to. */
    predicateIds: number[];
}
/** Warnings for a DBMS_XPLAN / SQL Monitor text plan table. */
export declare function textTableWarnings(d: TextTableDiagnostics): PlanWarning[];
/** Titles of report sections after the plan table that no parser reads. */
export declare function findUnreadSections(lines: string[], fromIndex: number): string[];
export declare function unreadSectionsWarning(titles: string[]): PlanWarning | null;
export interface XmlWrapper {
    /** The XML document alone. */
    xml: string;
    /** Text found before it (SQL*Plus prompt, command echo, column headings ...). */
    leading: string;
    /** Text found after its closing tag ("1 row selected."). */
    trailing: string;
}
/** Cut SQL*Plus noise off both ends of an XML document. Text without recognisable XML is returned untouched. */
export declare function stripXmlWrapper(input: string): XmlWrapper;
/** True when the document opens but never closes its root element — a cut-off CLOB. */
export declare function looksTruncatedXml(input: string): boolean;
export declare function truncatedXmlWarning(): PlanWarning;
/** Info-level notice that SQL*Plus output around the XML was dropped so it could be parsed. */
export declare function xmlWrapperWarning(wrapper: XmlWrapper): PlanWarning | null;
