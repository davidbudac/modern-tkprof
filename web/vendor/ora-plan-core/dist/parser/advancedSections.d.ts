/**
 * Parsers for the sections DBMS_XPLAN adds with the ADVANCED format: Outline Data, Peeked
 * Binds, Column Projection Information, Remote SQL Information and the Hint Report.
 * Each parser reads only its own section: it starts at its header and stops at the next
 * known section header (or earlier, at the section's natural end), so one section never
 * swallows another.
 */
import type { HintSummary, PlanHint } from '../types.js';
import type { BindVariable } from './types.js';
/**
 * Parse the "Outline Data" block into one hint per entry, verbatim. The comment wrapper
 * and the BEGIN/END_OUTLINE_DATA markers are dropped; a hint that wraps across lines
 * (unbalanced parentheses) is joined with one space.
 */
export declare function parseOutlineSection(lines: string[]): string[] | undefined;
/**
 * Parse "Peeked Binds (identified by position)": `1 - :1 (NUMBER): 20` and
 * `2 - :2 (VARCHAR2(30), CSID=873): 'SYS'`. String values lose their surrounding quotes so
 * they agree with the SQL Monitor XML parser (which stores the element text); an unquoted
 * `NULL` becomes `null`.
 */
export declare function parsePeekedBinds(lines: string[]): BindVariable[];
/** Per-operation `Column Projection Information` text. */
export declare function parseProjectionSection(lines: string[]): Map<number, string>;
/** Per-operation `Remote SQL Information` statement text. */
export declare function parseRemoteSqlSection(lines: string[]): Map<number, string>;
export interface HintReport {
    hints: Map<number, PlanHint[]>;
    summary?: HintSummary;
}
/**
 * Parse the 19c+ "Hint Report" into per-operation hints and the statement summary.
 *
 * Hints are grouped under `<id> -  QB [/ alias]` lines. A status letter marks a problem
 * (`U` unused, `E` syntax error, anything else `other`); no letter means the hint was used.
 * Text after ` / ` in an entry is the reason.
 */
export declare function parseHintReport(lines: string[]): HintReport;
