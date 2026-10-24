import type { PlanParser } from './types.js';
/**
 * Parser for Tanel Poder's xbi.sql (eXplain Better) output.
 *
 * xbi.sql produces SQL*Plus formatted output (space-padded columns, no pipe delimiters)
 * with two-line headers, explicit parent IDs, and self-elapsed runtime statistics.
 * See: https://github.com/tanelpoder/tpt-oracle/blob/master/xbi.sql
 */
export declare const xbiParser: PlanParser;
